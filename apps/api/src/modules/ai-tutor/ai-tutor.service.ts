/**
 * The AI tutor (Phase 35) — the student-facing surface.
 *
 * The staff copilot in `modules/ai` and this module share a transcript store and nothing
 * else. That is deliberate: the `student` system role holds `ai.tutor.use` and NOT
 * `ai.copilot.use`, so a student cannot reach a single route in that module, and none of
 * those routes was widened to let them. A copilot conversation is a staff surface — it is
 * where a teacher pastes a paragraph about a child — and the way to keep it one is to build
 * the student's surface separately rather than to add a condition to it.
 *
 * What is reused, and what is not:
 *
 *   reused   `AiUsageService`        — budget before the call, usage event inside the same
 *                                      transaction as the turn. A student cannot spend a
 *                                      school's inference budget uncounted.
 *   reused   `AiConversationService.appendRaw` — seq allocation and the append-only
 *                                      discipline have exactly one implementation.
 *   reused   `KnowledgeSearchPort`   — retrieval, with citations. There is no second
 *                                      retriever in this module and there must never be.
 *   reused   `untrusted()`           — the one prompt-injection envelope in the codebase.
 *   own      the session, the turn record, the safeguarding queue, and the rules below.
 *
 * ── The rules, in the order a turn applies them ───────────────────────────────────────
 *
 *  1. **Tutoring is off until a school switches it on.** `AiUsageService.isTutoringEnabled`
 *     fails closed. A student at an institution that has never saved AI settings gets a
 *     clean 403 that says the school has not enabled it — not an empty list, not a 500.
 *  2. **A safeguarding disclosure stops the turn before anything else happens.** No model is
 *     consulted, the student gets a fixed supportive message, and a row lands in a queue a
 *     named adult has to read. Crucially this runs *before* the budget check: a child
 *     disclosing harm must not be turned away because the school's token budget ran out
 *     this month.
 *  3. **The budget is checked before anything is spent** — including the embedding call
 *     retrieval makes, which is why the check sits above retrieval rather than immediately
 *     above the completion.
 *  4. **Retrieval comes from the school's own material or the tutor says it has none.**
 *     docs/06 §5. An empty result is not a prompt to generate; it is the answer.
 *  5. **On assessed work the tutor teaches and does not answer.** Decided in code from the
 *     student's words, and then checked again against the item's stored answer key after the
 *     model has spoken. See `tutor-guardrails.ts` for why the second check is the one that
 *     matters.
 *  6. **Every answer carries its evidence.** The turn stores a grounding level *and* the
 *     reasons behind it; the database refuses a level with no reasons (docs/06 §7).
 *
 * ── What this service never does ──────────────────────────────────────────────────────
 *
 * It changes nothing outside its own three tables and the transcript. It does not mark work,
 * does not open a discipline record, does not message a guardian, does not make a referral.
 * A safeguarding flag is a row with a status, and the only thing that moves it is a person
 * with a permission calling a route.
 */

import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import {
  aiConversations,
  aiMessages,
  assignments,
  courseEnrolments,
  courseModules,
  courses,
  enrollments,
  lessons,
  quizOptions,
  quizQuestions,
  quizzes,
  students,
  tutorSafeguardingFlags,
  tutorSessions,
  tutorTurns,
} from '@shikkha/db';
import {
  buildOffsetPage,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  offsetOf,
  parseSort,
  uuidv7,
  type OffsetPage,
  type OffsetPageRequest,
} from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import {
  TUTOR_FLAG_SORT_FIELDS,
  TUTOR_SESSION_SORT_FIELDS,
  type CreateTutorSessionInput,
  type CreateTutorTurnInput,
  type EndTutorSessionInput,
  type ListTutorFlagsInput,
  type ListTutorSessionsInput,
  type ReviewTutorFlagInput,
  type TutorAnchorKind,
  type TutorGroundingLevel,
  type TutorTurnOutcome,
} from '@shikkha/validation';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { AiUsageService, type Tx } from '../ai/ai-usage.service';
import { AiConversationService } from '../ai/ai-conversation.service';
import { AiProviderRegistry } from '../ai/providers/registry';
import { loadAiConfig } from '../ai/ai.config';
import { KNOWLEDGE_SEARCH, type KnowledgeSearchPort } from '../ai-tools/ports';
import {
  asksForTheAnswer,
  buildTutorMessages,
  findLeakedAnswerKey,
  guidanceInsteadOfAnswer,
  noCitationMessage,
  type TutorMode,
  type TutorPassage,
} from './tutor-guardrails';
import {
  SAFEGUARDING_HOLDING_MESSAGE,
  safeguardingExcerpt,
  safeguardingReasons,
  scanForSafeguarding,
} from './tutor-safeguarding';

type SessionRow = typeof tutorSessions.$inferSelect;
type TurnRow = typeof tutorTurns.$inferSelect;
type FlagRow = typeof tutorSafeguardingFlags.$inferSelect;

/**
 * How many passages one turn retrieves.
 *
 * Small on purpose. A student's question is narrow, the context window is the school's
 * money, and five loosely-related paragraphs make a worse answer than two good ones — the
 * model has no way to tell which of them the child actually needs.
 */
const RETRIEVAL_LIMIT = 4;

/**
 * How much of the session is replayed to the model.
 *
 * Twelve messages, roughly six exchanges — a fraction of the copilot's forty turns, because
 * a tutoring session is short by design and an unbounded history quietly turns the last
 * question of a long evening into the most expensive request in the system.
 */
const MAX_REPLAYED_MESSAGES = 12;

/**
 * The similarity above which an answer is called `grounded` rather than `partial`.
 *
 * The retrieval floor (`KNOWLEDGE_SEARCH_MIN_SCORE`, 0.3) is the point below which a passage
 * is not returned at all. Between that floor and this threshold the material is related but
 * not clearly about the question, and a student is told so in words rather than left to
 * infer it from a number. Above it, the passage is on topic.
 */
const GROUNDED_SCORE = 0.5;

/** What one turn produced, for the HTTP response. */
export interface TutorTurnOutcomeResult {
  session: SessionRow;
  turn: TurnRow;
  answer: string;
  /** The evidence behind the answer. Never a bare score — docs/06 §7. */
  grounding: {
    level: TutorGroundingLevel;
    reasons: string[];
    citations: { documentId: string; documentTitle: string; chunkId: string; score: number }[];
  };
  /** Present when the school's budget was exceeded and the hard stop is off. */
  budgetWarning?: string;
  /**
   * Set when the message raised a safeguarding flag. The student is not told a flag id, but
   * the response says a person has been asked to help, because pretending otherwise to a
   * child who has just disclosed something would be the wrong kind of discretion.
   */
  safeguarding?: { raised: true; signal: FlagRow['signal'] };
}

@Injectable()
export class AiTutorService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly usage: AiUsageService,
    private readonly conversations: AiConversationService,
    private readonly providers: AiProviderRegistry,
    @Inject(KNOWLEDGE_SEARCH) private readonly knowledge: KnowledgeSearchPort,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════════════
  // Availability
  // ══════════════════════════════════════════════════════════════════════════════════

  /**
   * Whether this institution has switched tutoring on, and whether this caller could use it
   * if it had.
   *
   * Returns a fact rather than throwing, because this is the route a client calls to decide
   * whether to show the tutor at all — a 403 here would make "the school has not turned this
   * on" indistinguishable from "you are not allowed to ask".
   */
  async availability(principal: Principal, institutionId: string) {
    const enabled = await this.usage.isTutoringEnabled(institutionId);
    const hasStudentRecord = Boolean(principal.studentId);
    return {
      enabled,
      /** A staff account holding `ai.tutor.use` still has no student record to anchor to. */
      hasStudentRecord,
      usable: enabled && hasStudentRecord,
      message: enabled
        ? hasStudentRecord
          ? 'The AI tutor is available for your courses.'
          : 'The AI tutor answers questions about a student\'s own courses, and this account is not linked to a student record.'
        : 'Your school has not enabled the AI tutor. A school administrator can turn it on in AI settings.',
    };
  }

  /**
   * Refuse if the school has not enabled tutoring.
   *
   * Fails closed by construction: `isTutoringEnabled` returns false for an institution that
   * has never saved AI settings, so a school acquires an AI tutor for its children by
   * deciding to, never by upgrading.
   *
   * The pastoral flag routes deliberately do NOT call this. A school that switches tutoring
   * off must not thereby hide a disclosure a child already made from the person whose job it
   * is to read it.
   */
  private async assertTutoringEnabled(institutionId: string): Promise<void> {
    if (await this.usage.isTutoringEnabled(institutionId)) return;
    throw new ForbiddenError(
      'ai.tutor.use',
      'Your school has not enabled the AI tutor. A school administrator can turn it on in AI settings.',
    );
  }

  /**
   * The student record behind the caller, or a refusal.
   *
   * `ai.tutor.use` says "may use the tutor"; it does not conjure a student to be tutored.
   * A staff account granted the permission by mistake gets a 403 here rather than a session
   * anchored to nothing.
   */
  private requireStudent(principal: Principal): string {
    if (!principal.studentId) {
      throw new ForbiddenError(
        'ai.tutor.use',
        'The AI tutor answers questions about a student\'s own courses, and this account is not linked to a student record.',
      );
    }
    return principal.studentId;
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Sessions
  // ══════════════════════════════════════════════════════════════════════════════════

  /**
   * Start a session against one piece of the school's own material.
   *
   * The anchor is validated against the student's own enrolments, so a student cannot open a
   * tutor on another class's quiz by guessing a uuid — and, because retrieval is filtered to
   * collections visible to the `student` audience, the corpus a session can reach is the
   * intersection of "material for students" and "material this student is enrolled in".
   */
  async create(
    principal: Principal,
    institutionId: string,
    input: CreateTutorSessionInput,
  ): Promise<SessionRow> {
    await this.assertTutoringEnabled(institutionId);
    const studentId = this.requireStudent(principal);

    return this.db.runInTenant(async (tx) => {
      const anchor = await this.resolveAnchor(
        tx,
        institutionId,
        studentId,
        input.anchorKind,
        input.anchorId,
      );

      const conversationId = uuidv7();
      await tx.insert(aiConversations).values({
        id: conversationId,
        tenantId: principal.tenantId!,
        institutionId,
        // Derived from the anchor rather than supplied: a session is always findable by what
        // it was about, rather than by what a student called it at nine o'clock at night.
        title: anchor.label.slice(0, 200),
        purpose: 'tutor',
        startedByUserId: principal.userId,
        subjectType: input.anchorKind,
        subjectId: input.anchorId,
        createdBy: principal.userId,
        updatedBy: principal.userId,
      });

      const id = uuidv7();
      const [session] = await tx
        .insert(tutorSessions)
        .values({
          id,
          tenantId: principal.tenantId!,
          institutionId,
          studentId,
          conversationId,
          anchorKind: input.anchorKind,
          anchorId: input.anchorId,
          anchorLabel: anchor.label,
          anchorIsAssessed: anchor.isAssessed,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'create',
        module: 'ai_tutor',
        resourceType: 'tutor_session',
        resourceId: id,
        resourceLabel: anchor.label,
        newValue: {
          studentId,
          conversationId,
          anchorKind: input.anchorKind,
          anchorId: input.anchorId,
          anchorIsAssessed: anchor.isAssessed,
        },
        // Opening a session is a human act; no model has been consulted yet. The turns below
        // write their own records with `isAiInitiated: true`.
        isAiInitiated: false,
        ...this.usage.auditContext(),
      });

      return session!;
    });
  }

  /**
   * The caller's own sessions.
   *
   * The route carries `ai.tutor.use`, but the scope is enforced on the DATA: the same
   * `tutor_session_visible_to()` expression that governs a single read filters the list, so
   * a student holding the permission still sees only sessions they are entitled to. A
   * permission that widened a list by itself would be a permission nobody could reason about.
   */
  async list(
    principal: Principal,
    institutionId: string,
    query: ListTutorSessionsInput,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<SessionRow>> {
    await this.assertTutoringEnabled(institutionId);

    const sorts = parseSort(query.sort, TUTOR_SESSION_SORT_FIELDS, {
      field: 'startedAt',
      direction: 'desc',
    });

    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [
        eq(tutorSessions.institutionId, institutionId),
        this.visibilityFilter(principal),
      ];
      if (!query.includeArchived) filters.push(isNull(tutorSessions.archivedAt));
      if (query.status) filters.push(eq(tutorSessions.status, query.status));
      const where = and(...filters);

      const rows = await tx
        .select()
        .from(tutorSessions)
        .where(where)
        .orderBy(
          ...sorts.map((spec) => {
            const column =
              spec.field === 'status'
                ? tutorSessions.status
                : spec.field === 'anchorLabel'
                  ? tutorSessions.anchorLabel
                  : tutorSessions.startedAt;
            return spec.direction === 'asc' ? asc(column) : desc(column);
          }),
        )
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(tutorSessions)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  /**
   * One session, its turns and its transcript.
   *
   * Readable by the student, by a guardian with a live portal-enabled link, and by a teacher
   * of one of the student's sections. Nobody else — and "nobody else" gets the same 404 a
   * caller from another tenant gets, because a 403 would confirm that this child has a tutor
   * session, which is exactly the fact an outsider must not learn.
   */
  async findOne(principal: Principal, institutionId: string, id: string) {
    await this.assertTutoringEnabled(institutionId);

    return this.db.runInTenant(async (tx) => {
      const session = await this.loadVisible(tx, principal, institutionId, id);

      const turns = await tx
        .select()
        .from(tutorTurns)
        .where(eq(tutorTurns.sessionId, id))
        .orderBy(asc(tutorTurns.seq));

      const messages = await tx
        .select({
          id: aiMessages.id,
          seq: aiMessages.seq,
          role: aiMessages.role,
          content: aiMessages.content,
          createdAt: aiMessages.createdAt,
        })
        .from(aiMessages)
        .where(eq(aiMessages.conversationId, session.conversationId))
        .orderBy(asc(aiMessages.seq));

      return { session, turns, messages };
    });
  }

  /**
   * End a session, with a reason.
   *
   * Only the student whose session it is may end it. A guardian or a teacher may read the
   * session; closing somebody's conversation is not a reading right, and there is no product
   * question that needs it.
   */
  async end(
    principal: Principal,
    institutionId: string,
    id: string,
    input: EndTutorSessionInput,
  ) {
    await this.assertTutoringEnabled(institutionId);

    return this.db.runInTenant(async (tx) => {
      const session = await this.loadVisible(tx, principal, institutionId, id);
      this.assertOwnedByCaller(principal, session);

      if (session.status === 'ended') {
        throw new ConflictError('This tutoring session has already ended.', { sessionId: id });
      }

      const [row] = await tx
        .update(tutorSessions)
        .set({
          status: 'ended',
          endedAt: new Date(),
          endReason: input.reason,
          version: session.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(tutorSessions.id, id))
        .returning();

      return {
        session: row!,
        previous: { status: session.status, endedAt: session.endedAt },
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // The turn — where every rule in the file header is applied
  // ══════════════════════════════════════════════════════════════════════════════════

  async addTurn(
    principal: Principal,
    institutionId: string,
    sessionId: string,
    input: CreateTutorTurnInput,
  ): Promise<TutorTurnOutcomeResult> {
    await this.assertTutoringEnabled(institutionId);

    const session = await this.db.runInTenant(async (tx) => {
      const row = await this.loadVisible(tx, principal, institutionId, sessionId);
      // A guardian and a teacher may READ a session. Neither may type into it: a transcript
      // in which the child's own turns were not all the child's would be worse than useless
      // to the adult who eventually reads it.
      this.assertOwnedByCaller(principal, row);
      return row;
    });

    if (session.status === 'ended') {
      throw new ConflictError(
        'This tutoring session has ended. Start a new one to keep going.',
        { sessionId },
      );
    }

    // ── Rule 2. Before the budget check, before retrieval, before any model. ──────────
    const hit = scanForSafeguarding(input.question);
    if (hit) {
      return this.writeSafeguardingHold(principal, institutionId, session, input.question, hit);
    }

    // ── Rule 3. Before anything is spent, including retrieval's embedding call. ───────
    const budget = await this.usage.assertWithinBudget(principal, institutionId, 'tutoring');

    // ── Rule 4. The school's own material, through the one retriever. ────────────────
    //
    // The query carries the anchor's label as well as the question so that "explain step
    // three" retrieves against the topic rather than against three words of pronouns. The
    // corpus is filtered by `KnowledgeService` to collections visible to the caller's
    // audience — for a student, the collections a school marked student-visible — and the
    // session's anchor has already been checked against this student's own enrolments.
    const retrieval = await this.knowledge.search(
      principal,
      institutionId,
      `${session.anchorLabel}. ${input.question}`,
      RETRIEVAL_LIMIT,
    );
    const chunks = retrieval.chunks;

    // ── Rule 5, first half: the framing is chosen in code, not by the model. ─────────
    const wantsTheAnswer = asksForTheAnswer(input.question);
    const mode: TutorMode =
      session.anchorIsAssessed && wantsTheAnswer ? 'guidance' : 'explain';

    // Nothing matched. docs/06 §5: say so rather than generate. No provider is consulted, so
    // this path costs the school nothing beyond the embedding retrieval already made — and
    // the message can honestly promise that nothing was invented.
    if (chunks.length === 0) {
      const answer =
        mode === 'guidance'
          ? guidanceInsteadOfAnswer(session.anchorLabel)
          : noCitationMessage(session.anchorLabel);
      const reasons = [
        `Nothing in the material your school has uploaded matched this question closely enough to use (searched the collections visible to students, ${RETRIEVAL_LIMIT} best matches requested).`,
        'No AI model was consulted, so nothing in this reply was generated: an answer with no source is worse than no answer.',
      ];
      if (mode === 'guidance') {
        reasons.push(
          `"${session.anchorLabel}" is work your teacher is marking, so the tutor would have explained the method rather than giving the answer in any case.`,
        );
      }

      return this.writeTurn(principal, institutionId, session, {
        question: input.question,
        answer,
        outcome: mode === 'guidance' ? 'guidance_only' : 'no_citation',
        groundingLevel: 'ungrounded',
        reasons,
        citations: [],
        withheldAnswer: false,
        provider: null,
        budgetWarning: budget.warning,
      });
    }

    // ── The provider call. No transaction is open here: a slow model must not hold a
    // connection, let alone a row lock, for thirty seconds. ──────────────────────────
    const history = await this.db.runInTenant(async (tx) =>
      tx
        .select({ role: aiMessages.role, content: aiMessages.content, seq: aiMessages.seq })
        .from(aiMessages)
        .where(eq(aiMessages.conversationId, session.conversationId))
        .orderBy(desc(aiMessages.seq))
        .limit(MAX_REPLAYED_MESSAGES),
    );

    const passages: TutorPassage[] = chunks.map((chunk) => ({
      documentTitle: chunk.documentTitle,
      excerpt: chunk.excerpt,
    }));

    const messages = buildTutorMessages({
      mode,
      anchorLabel: session.anchorLabel,
      anchorIsAssessed: session.anchorIsAssessed,
      passages,
      history: history
        .slice()
        .reverse()
        .filter(
          (message): message is { role: 'user' | 'assistant'; content: string; seq: number } =>
            message.role === 'user' || message.role === 'assistant',
        )
        .map((message) => ({ role: message.role, content: message.content })),
      question: input.question,
    });

    const provider = this.providers.forTask('tutoring');
    const config = loadAiConfig();
    const response = await provider.complete({
      task: 'tutoring',
      messages,
      maxOutputTokens: config.AI_MAX_OUTPUT_TOKENS,
    });

    // ── Rule 5, second half: the post-check. This is the one that survives a model
    // nobody in this repository has seen — it does not care HOW the answer got into the
    // output (the model knew it, the student pasted it and the model echoed it, a retrieved
    // passage contained it), only that it is there. ─────────────────────────────────
    let withheldAnswer = false;
    let outcome: TutorTurnOutcome = mode === 'guidance' ? 'guidance_only' : 'guided';

    if (session.anchorIsAssessed) {
      const answerKeys = await this.db.runInTenant(async (tx) =>
        this.answerKeysFor(tx, session),
      );
      if (findLeakedAnswerKey(response.text, answerKeys) !== null) {
        withheldAnswer = true;
        outcome = 'guidance_only';
      }
    }

    // The whole model reply is dropped when the post-check fires, not edited around the
    // match: redacting the phrase and shipping the rest would leave the working that leads
    // to it, which is the same leak with an extra step.
    //
    // When the student asked outright for the answer, the refusal comes FIRST and the
    // model's guidance-mode explanation follows it. A student who asked a direct question
    // deserves a direct "no, and here is why" rather than a paragraph that quietly does
    // something else — and the help underneath it is what stops the refusal from teaching
    // them that the tutor is broken.
    const answer = withheldAnswer
      ? guidanceInsteadOfAnswer(session.anchorLabel)
      : mode === 'guidance'
        ? `${guidanceInsteadOfAnswer(session.anchorLabel)}\n\n---\n\n${response.text}`
        : response.text;

    const bestScore = chunks.reduce((best, chunk) => Math.max(best, chunk.score), 0);
    const groundingLevel: TutorGroundingLevel =
      withheldAnswer || bestScore < GROUNDED_SCORE ? 'partial' : 'grounded';

    // ── Rule 6. The evidence, in sentences a fourteen-year-old can disagree with. ────
    const titles = [...new Set(chunks.map((chunk) => chunk.documentTitle))];
    const reasons = [
      `Answered from ${chunks.length} passage${chunks.length === 1 ? '' : 's'} of your school's own material: ${titles.join('; ')}.`,
      `The closest passage scored ${bestScore.toFixed(2)} out of 1.00 for similarity to your question${
        bestScore < GROUNDED_SCORE
          ? ' — related, but not clearly about it, so check this against your notes'
          : ''
      }.`,
    ];
    if (session.anchorIsAssessed) {
      reasons.push(
        `"${session.anchorLabel}" is work your teacher is marking, so the tutor explains the method and does not give the answer.`,
      );
    }
    if (withheldAnswer) {
      reasons.push(
        'The draft reply contained this item\'s stored correct answer, so it was withheld and replaced with guidance.',
      );
    }

    return this.writeTurn(principal, institutionId, session, {
      question: input.question,
      answer,
      outcome,
      groundingLevel,
      reasons,
      citations: chunks.map((chunk) => ({
        documentId: chunk.documentId,
        documentTitle: chunk.documentTitle,
        chunkId: chunk.chunkId,
        score: chunk.score,
      })),
      withheldAnswer,
      provider: {
        key: provider.key,
        model: response.model,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        finishReason: response.finishReason,
        currency: budget.currency,
      },
      budgetWarning: budget.warning,
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Safeguarding
  // ══════════════════════════════════════════════════════════════════════════════════

  /**
   * The pastoral queue.
   *
   * Deliberately not gated on the tutoring toggle: switching the feature off must not hide a
   * disclosure a child already made from the person whose job it is to read it.
   */
  async listFlags(
    institutionId: string,
    query: ListTutorFlagsInput,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<FlagRow & { studentName: string; anchorLabel: string }>> {
    const sorts = parseSort(query.sort, TUTOR_FLAG_SORT_FIELDS, {
      field: 'raisedAt',
      // Oldest first, because the oldest unread disclosure is the one that matters most.
      direction: 'asc',
    });

    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [
        eq(tutorSafeguardingFlags.institutionId, institutionId),
        isNull(tutorSafeguardingFlags.archivedAt),
      ];
      if (query.status) filters.push(eq(tutorSafeguardingFlags.status, query.status));
      if (query.signal) filters.push(eq(tutorSafeguardingFlags.signal, query.signal));
      if (query.studentId) filters.push(eq(tutorSafeguardingFlags.studentId, query.studentId));
      const where = and(...filters);

      const rows = await tx
        .select({
          flag: tutorSafeguardingFlags,
          studentName: students.fullNameEn,
          anchorLabel: tutorSessions.anchorLabel,
        })
        .from(tutorSafeguardingFlags)
        .innerJoin(students, eq(students.id, tutorSafeguardingFlags.studentId))
        .innerJoin(tutorSessions, eq(tutorSessions.id, tutorSafeguardingFlags.sessionId))
        .where(where)
        .orderBy(
          ...sorts.map((spec) => {
            const column =
              spec.field === 'status'
                ? tutorSafeguardingFlags.status
                : spec.field === 'signal'
                  ? tutorSafeguardingFlags.signal
                  : tutorSafeguardingFlags.raisedAt;
            return spec.direction === 'asc' ? asc(column) : desc(column);
          }),
        )
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(tutorSafeguardingFlags)
        .where(where);

      return buildOffsetPage(
        rows.map((row) => ({
          ...row.flag,
          studentName: row.studentName,
          anchorLabel: row.anchorLabel,
        })),
        counted?.total ?? 0,
        page,
      );
    });
  }

  /**
   * Record that a person has read a flag and what they decided.
   *
   * This endpoint does exactly one thing. It does not message a guardian, open a discipline
   * record, or make a referral — each of those is a separate, permission-checked, audited
   * action in the module that owns it, taken by a person who chose to take it. A "review and
   * escalate" button here would be the software making the decision and the human clicking
   * a confirmation, which is the failure mode this whole batch exists to prevent.
   *
   * `reviewedBy` is the acting principal and the database checks it against the connection's
   * own `app.user_id`, so a background job cannot close a child's disclosure even with the
   * application's credentials.
   */
  async reviewFlag(
    principal: Principal,
    institutionId: string,
    id: string,
    input: ReviewTutorFlagInput,
  ) {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(tutorSafeguardingFlags)
        .where(
          and(
            eq(tutorSafeguardingFlags.id, id),
            eq(tutorSafeguardingFlags.institutionId, institutionId),
            isNull(tutorSafeguardingFlags.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Safeguarding flag', id);

      if (existing.status === 'reviewed') {
        throw new ConflictError(
          'This flag has already been reviewed. Raise a pastoral record if there is more to add — a review is not edited.',
          { flagId: id, reviewedAt: existing.reviewedAt },
        );
      }

      const [row] = await tx
        .update(tutorSafeguardingFlags)
        .set({
          status: 'reviewed',
          reviewedBy: principal.userId,
          reviewedAt: new Date(),
          reviewNote: input.reason,
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(tutorSafeguardingFlags.id, id))
        .returning();

      return {
        flag: row!,
        previous: { status: existing.status, reviewedBy: existing.reviewedBy },
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Writing a turn
  // ══════════════════════════════════════════════════════════════════════════════════

  /**
   * The safeguarding path: a fixed supportive message, a turn, a flag, and nothing else.
   *
   * No provider is consulted and no usage event is written, because no inference happened —
   * and `tutor_turns_hold_calls_no_provider` in the schema will refuse this row if a future
   * change quietly starts sending a distressed child's words to a vendor.
   */
  private async writeSafeguardingHold(
    principal: Principal,
    institutionId: string,
    session: SessionRow,
    question: string,
    hit: { signal: FlagRow['signal']; matched: string },
  ): Promise<TutorTurnOutcomeResult> {
    const written = await this.writeTurn(principal, institutionId, session, {
      question,
      answer: SAFEGUARDING_HOLDING_MESSAGE,
      outcome: 'safeguarding_hold',
      groundingLevel: 'ungrounded',
      reasons: safeguardingReasons(hit),
      citations: [],
      withheldAnswer: false,
      provider: null,
      flag: { signal: hit.signal, matched: hit.matched, excerpt: safeguardingExcerpt(question) },
    });
    return { ...written, safeguarding: { raised: true, signal: hit.signal } };
  }

  /**
   * One transaction for everything a turn implies: both messages, the turn record, the usage
   * event when a provider was called, the flag when one was raised, and the audit rows.
   *
   * All of it commits or none of it does. A transcript with no turn record, or a turn with
   * no charge on the ledger, would each be a quiet way for the record to stop meaning what
   * it says.
   */
  private async writeTurn(
    principal: Principal,
    institutionId: string,
    session: SessionRow,
    input: {
      question: string;
      answer: string;
      outcome: TutorTurnOutcome;
      groundingLevel: TutorGroundingLevel;
      reasons: string[];
      citations: { documentId: string; documentTitle: string; chunkId: string; score: number }[];
      withheldAnswer: boolean;
      provider: {
        key: string;
        model: string;
        inputTokens: number;
        outputTokens: number;
        finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter';
        currency: string;
      } | null;
      budgetWarning?: string;
      flag?: { signal: FlagRow['signal']; matched: string; excerpt: string };
    },
  ): Promise<TutorTurnOutcomeResult> {
    const written = await this.db.runInTenant(async (tx) => {
      // Serialise concurrent turns in one session so two clients cannot compute the same
      // `seq`. The unique index on (session_id, seq) is the real guarantee; this makes the
      // common case a wait rather than a 409.
      const [locked] = await tx
        .select({ id: tutorSessions.id, version: tutorSessions.version })
        .from(tutorSessions)
        .where(eq(tutorSessions.id, session.id))
        .for('update')
        .limit(1);
      if (!locked) throw new NotFoundError('Tutoring session', session.id);

      // `appendRaw` owns seq allocation and the append-only discipline for the transcript.
      // Duplicating it here is how two implementations end up disagreeing about ordering
      // under concurrency.
      const studentMessage = await this.conversations.appendRaw(
        tx,
        principal,
        institutionId,
        session.conversationId,
        { role: 'user', content: input.question },
      );

      const tutorMessage = await this.conversations.appendRaw(
        tx,
        principal,
        institutionId,
        session.conversationId,
        {
          role: 'assistant',
          content: input.answer,
          providerKey: input.provider?.key ?? null,
          model: input.provider?.model ?? null,
          inputTokens: input.provider?.inputTokens ?? 0,
          outputTokens: input.provider?.outputTokens ?? 0,
          finishReason: input.provider?.finishReason ?? null,
        },
      );

      const [highest] = await tx
        .select({ seq: sql<number>`coalesce(max(${tutorTurns.seq}), 0)::int` })
        .from(tutorTurns)
        .where(eq(tutorTurns.sessionId, session.id));

      const turnId = uuidv7();
      const [turn] = await tx
        .insert(tutorTurns)
        .values({
          id: turnId,
          tenantId: principal.tenantId!,
          institutionId,
          sessionId: session.id,
          seq: (highest?.seq ?? 0) + 1,
          studentMessageId: studentMessage.id,
          tutorMessageId: tutorMessage.id,
          outcome: input.outcome,
          groundingLevel: input.groundingLevel,
          groundingReasons: input.reasons,
          citations: input.citations,
          withheldAnswer: input.withheldAnswer,
          providerKey: input.provider?.key ?? null,
          model: input.provider?.model ?? null,
          inputTokens: input.provider?.inputTokens ?? 0,
          outputTokens: input.provider?.outputTokens ?? 0,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      let cost: string | null = null;
      if (input.provider) {
        const recorded = await this.usage.record(tx, {
          tenantId: principal.tenantId!,
          institutionId,
          conversationId: session.conversationId,
          task: 'tutoring',
          providerKey: input.provider.key,
          model: input.provider.model,
          inputTokens: input.provider.inputTokens,
          outputTokens: input.provider.outputTokens,
          userId: principal.userId,
          purpose: 'tutor',
          currency: input.provider.currency,
        });
        cost = recorded.cost;
      }

      if (input.flag) {
        // Declared here rather than as a `let … = null` above the block: the row is only ever
        // read inside this branch, by the audit record below, and a nullable outer binding
        // invited the reader to think the flag escapes the block. It does not — the turn
        // response deliberately carries no flag id, because a child is told a person has been
        // asked to help, not given a reference number.
        const [flag] = await tx
          .insert(tutorSafeguardingFlags)
          .values({
            id: uuidv7(),
            tenantId: principal.tenantId!,
            institutionId,
            sessionId: session.id,
            turnId,
            studentId: session.studentId,
            signal: input.flag.signal,
            excerpt: input.flag.excerpt,
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning();

        // A flag is its own event in the trail. Raising one is the system asking for a human,
        // and "when was it raised, and how long did it sit there" is the question an
        // investigation asks first.
        await this.audit.recordInTransaction(tx, {
          tenantId: principal.tenantId,
          institutionId,
          actorUserId: principal.userId,
          actorRoles: principal.roles.map((role) => role.roleKey),
          action: 'create',
          module: 'ai_tutor',
          resourceType: 'tutor_safeguarding_flag',
          resourceId: flag!.id,
          resourceLabel: session.anchorLabel,
          newValue: {
            sessionId: session.id,
            turnId,
            studentId: session.studentId,
            signal: input.flag.signal,
            // The pattern that matched, not the child's words. The words are on the flag,
            // where a safeguarding lead reads them; the audit log has a longer retention and
            // a wider readership than that queue does.
            matchedPattern: input.flag.matched,
            automatedFollowUp: 'none',
          },
          isAiInitiated: true,
          ...this.usage.auditContext(),
        });
      }

      await tx
        .update(tutorSessions)
        .set({ version: locked.version + 1, updatedBy: principal.userId })
        .where(eq(tutorSessions.id, session.id));

      await tx
        .update(aiConversations)
        .set({ lastMessageAt: new Date(), updatedBy: principal.userId })
        .where(eq(aiConversations.id, session.conversationId));

      // docs/06 §6: an AI-assisted action stays distinguishable in the trail forever. In the
      // same transaction as the turn, so a rolled-back turn leaves no trail and a committed
      // one always has one.
      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'create',
        module: 'ai_tutor',
        resourceType: 'tutor_turn',
        resourceId: turnId,
        resourceLabel: session.anchorLabel,
        newValue: {
          sessionId: session.id,
          outcome: input.outcome,
          groundingLevel: input.groundingLevel,
          citationCount: input.citations.length,
          withheldAnswer: input.withheldAnswer,
          anchorIsAssessed: session.anchorIsAssessed,
          providerKey: input.provider?.key ?? null,
          model: input.provider?.model ?? null,
          inputTokens: input.provider?.inputTokens ?? 0,
          outputTokens: input.provider?.outputTokens ?? 0,
          // Cost as a string, never a number, in the audit trail too.
          cost,
        },
        isAiInitiated: true,
        ...this.usage.auditContext(),
      });

      const [refreshed] = await tx
        .select()
        .from(tutorSessions)
        .where(eq(tutorSessions.id, session.id))
        .limit(1);

      return { session: refreshed!, turn: turn! };
    });

    const result: TutorTurnOutcomeResult = {
      session: written.session,
      turn: written.turn,
      answer: input.answer,
      grounding: {
        level: input.groundingLevel,
        reasons: input.reasons,
        citations: input.citations,
      },
    };
    if (input.budgetWarning) result.budgetWarning = input.budgetWarning;
    return result;
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Anchors, answer keys and visibility
  // ══════════════════════════════════════════════════════════════════════════════════

  /**
   * Resolve an anchor to its label and its assessed-ness, refusing anything the student is
   * not enrolled in.
   *
   * `NotFoundError` for every failure — wrong institution, wrong tenant, not enrolled,
   * unpublished, archived. A 403 that distinguished "this exists but is not yours" from
   * "this does not exist" would let a student enumerate another class's quiz questions with
   * nothing but a loop.
   */
  private async resolveAnchor(
    tx: Tx,
    institutionId: string,
    studentId: string,
    kind: TutorAnchorKind,
    anchorId: string,
  ): Promise<{ label: string; isAssessed: boolean }> {
    switch (kind) {
      case 'course': {
        const [row] = await tx
          .select({ title: courses.title })
          .from(courses)
          .innerJoin(
            courseEnrolments,
            and(
              eq(courseEnrolments.courseId, courses.id),
              eq(courseEnrolments.studentId, studentId),
              isNull(courseEnrolments.archivedAt),
            ),
          )
          .where(
            and(
              eq(courses.id, anchorId),
              eq(courses.institutionId, institutionId),
              eq(courses.status, 'published'),
              isNull(courses.archivedAt),
            ),
          )
          .limit(1);
        if (!row) throw new NotFoundError('Course', anchorId);
        // A course is material, not an assessment. Its quizzes are anchored separately.
        return { label: row.title, isAssessed: false };
      }

      case 'lesson': {
        const [row] = await tx
          .select({ lessonTitle: lessons.title, courseTitle: courses.title })
          .from(lessons)
          .innerJoin(courseModules, eq(courseModules.id, lessons.moduleId))
          .innerJoin(courses, eq(courses.id, courseModules.courseId))
          .innerJoin(
            courseEnrolments,
            and(
              eq(courseEnrolments.courseId, courses.id),
              eq(courseEnrolments.studentId, studentId),
              isNull(courseEnrolments.archivedAt),
            ),
          )
          .where(
            and(
              eq(lessons.id, anchorId),
              eq(lessons.institutionId, institutionId),
              eq(lessons.isPublished, true),
              isNull(lessons.archivedAt),
              isNull(courseModules.archivedAt),
              eq(courses.status, 'published'),
              isNull(courses.archivedAt),
            ),
          )
          .limit(1);
        if (!row) throw new NotFoundError('Lesson', anchorId);
        return {
          label: `${row.courseTitle} — ${row.lessonTitle}`.slice(0, 255),
          isAssessed: false,
        };
      }

      case 'assignment': {
        // Homework belongs to a section, so the enrolment check is on the section rather
        // than on a course membership.
        const sections = tx
          .select({ sectionId: enrollments.sectionId })
          .from(enrollments)
          .where(
            and(
              eq(enrollments.studentId, studentId),
              eq(enrollments.status, 'active'),
              isNull(enrollments.archivedAt),
            ),
          );

        const [row] = await tx
          .select({ title: assignments.title, isGraded: assignments.isGraded })
          .from(assignments)
          .where(
            and(
              eq(assignments.id, anchorId),
              eq(assignments.institutionId, institutionId),
              eq(assignments.status, 'published'),
              isNull(assignments.archivedAt),
              inArray(assignments.sectionId, sections),
            ),
          )
          .limit(1);
        if (!row) throw new NotFoundError('Assignment', anchorId);
        // THE assessed-ness rule for homework: the teacher's own `isGraded` flag. Read once,
        // here, and stored on the session — see the schema comment for why it is not
        // re-derived per turn.
        return { label: row.title, isAssessed: row.isGraded };
      }

      case 'quiz_question': {
        const [question] = await tx
          .select({
            sequence: quizQuestions.sequence,
            quizId: quizzes.id,
            quizTitle: quizzes.title,
            quizCourseId: quizzes.courseId,
            quizLessonId: quizzes.lessonId,
          })
          .from(quizQuestions)
          .innerJoin(quizzes, eq(quizzes.id, quizQuestions.quizId))
          .where(
            and(
              eq(quizQuestions.id, anchorId),
              eq(quizQuestions.institutionId, institutionId),
              isNull(quizQuestions.archivedAt),
              eq(quizzes.status, 'published'),
              isNull(quizzes.archivedAt),
            ),
          )
          .limit(1);
        if (!question) throw new NotFoundError('Quiz question', anchorId);

        // A quiz hangs off a course directly, or off a lesson within one. Both shapes are
        // legal in the LMS schema, so both are resolved rather than one being assumed.
        let courseId = question.quizCourseId;
        if (!courseId && question.quizLessonId) {
          const [viaLesson] = await tx
            .select({ courseId: courseModules.courseId })
            .from(lessons)
            .innerJoin(courseModules, eq(courseModules.id, lessons.moduleId))
            .where(eq(lessons.id, question.quizLessonId))
            .limit(1);
          courseId = viaLesson?.courseId ?? null;
        }
        if (!courseId) throw new NotFoundError('Quiz question', anchorId);

        const [enrolled] = await tx
          .select({ id: courseEnrolments.id })
          .from(courseEnrolments)
          .where(
            and(
              eq(courseEnrolments.courseId, courseId),
              eq(courseEnrolments.studentId, studentId),
              isNull(courseEnrolments.archivedAt),
            ),
          )
          .limit(1);
        if (!enrolled) throw new NotFoundError('Quiz question', anchorId);

        // A quiz question is assessed by definition. There is no ungraded quiz question in
        // this product, and treating one as unassessed would hand out the answer key.
        return {
          label: `${question.quizTitle} — question ${question.sequence}`.slice(0, 255),
          isAssessed: true,
        };
      }
    }
  }

  /**
   * The stored correct answers for an assessed anchor, for the post-check.
   *
   * Only a quiz question has one. A homework assignment records the task and the marks, not
   * the solution, so there is nothing to compare against and the enforcement for that anchor
   * is the guidance framing alone. Stated here rather than hidden behind a check that only
   * appears to run.
   */
  private async answerKeysFor(tx: Tx, session: SessionRow): Promise<string[]> {
    if (session.anchorKind !== 'quiz_question') return [];
    const rows = await tx
      .select({ text: quizOptions.text })
      .from(quizOptions)
      .where(
        and(
          eq(quizOptions.questionId, session.anchorId),
          eq(quizOptions.isCorrect, true),
          isNull(quizOptions.archivedAt),
        ),
      );
    return rows.map((row) => row.text);
  }

  /**
   * The visibility rule, as a filter.
   *
   * One call into `tutor_session_visible_to()` — the SQL function defined in 0036 — so the
   * list, the single read and the integration suite all evaluate literally the same
   * expression. Three hand-written `where` clauses that were equivalent on the day they were
   * written is how a rule about children's records drifts.
   */
  private visibilityFilter(principal: Principal): SQL {
    return sql`tutor_session_visible_to(${tutorSessions.id}, ${principal.userId}::uuid)`;
  }

  private async loadVisible(
    tx: Tx,
    principal: Principal,
    institutionId: string,
    id: string,
  ): Promise<SessionRow> {
    const [row] = await tx
      .select()
      .from(tutorSessions)
      .where(
        and(
          eq(tutorSessions.id, id),
          eq(tutorSessions.institutionId, institutionId),
          this.visibilityFilter(principal),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError('Tutoring session', id);
    return row;
  }

  /**
   * Only the student whose session it is may write to it or end it.
   *
   * A 404, not a 403, for the same reason `loadVisible` returns one: a guardian or teacher
   * who reached this point can already see the session, so the distinction is not a leak —
   * but keeping one error shape across the module means no caller can learn anything from
   * which one they got.
   */
  private assertOwnedByCaller(principal: Principal, session: SessionRow): void {
    if (principal.studentId && principal.studentId === session.studentId) return;
    throw new ForbiddenError(
      'ai.tutor.use',
      'Only the student whose session this is can continue or end it.',
    );
  }
}
