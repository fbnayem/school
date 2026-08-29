/**
 * The suggestion store, and the accept path that is the point of this phase.
 *
 * docs/06 §6: *AI suggests → human reviews → human confirms → system executes*, and "the
 * confirmation is a normal permission-checked, audited API call made by the human". Three
 * things make that true here rather than aspirational, and each is worth stating where it is
 * implemented:
 *
 *  1. **Generating a suggestion writes one row and changes nothing else.** `createFromFindings`
 *     inserts into `ai_suggestions` and touches no other table in the system. There is no
 *     branch anywhere in this file that mutates a student, an invoice, an application or a
 *     register.
 *  2. **Accepting requires the permission of the ACTION.** Not `ai.copilot.use`. The mapping
 *     lives in `suggestion-contracts.ts`, is written onto the row at generation time, and the
 *     two are compared before anything happens — see `assertAcceptable`.
 *  3. **Accepting runs the owning module's own service.** `SuggestionExecutorService` calls
 *     `CommunicationService.createThread`, `DisciplineService.createRecord` and the rest, so
 *     those modules' validations, refusals and audit rows all still apply.
 *
 * ── Why accept is three steps and not one transaction ──────────────────────────────────
 *
 * The brief for this phase asks for the decision and the action in one transaction, and that
 * is the right instinct. It is not reachable from here without changing modules this phase
 * does not own: every owning service opens its own transaction through
 * `DatabaseService.runInTenant`, and `runInTenant` takes a **fresh connection from the pool**
 * rather than joining an ambient transaction. Calling one from inside a transaction of ours
 * would therefore not be one transaction — it would be two, on two connections, with ours
 * holding a row lock while the other ran, which is a connection-starvation deadlock waiting
 * for a busy afternoon.
 *
 * So the ordering below is chosen to make the property that actually matters unconditional:
 * **the action happens at most once, and never without a human decision.**
 *
 *   1. `claim` — one conditional statement: `update … set status = 'accepted' … where id = $1
 *      and status = 'pending' and version = $2`. Atomic, and the sole gate. Two reviewers
 *      clicking at the same instant produce exactly one claim and one 409.
 *   2. execute — the owning module's service, in the owning module's own transaction.
 *   3. `recordExecution` — the outcome onto the suggestion, and the audit row.
 *
 * The residual failure is a process that dies between 1 and 2: the suggestion is `accepted`
 * with `execution_state = 'not_started'`, which is *visible* rather than silent — it is a
 * status combination the API reports and an operator can query for. That is a better failure
 * than the alternative ordering (execute, then record), whose failure mode is an action that
 * happened with a pending suggestion still sitting in the queue inviting somebody to do it
 * again.
 */

import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, exists, gt, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import {
  aiSuggestions,
  enrollments,
  guardians,
  students,
  studentGuardians,
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
import {
  can,
  resolveDataScope,
  SCOPED_RESOURCES,
  type DataScope,
  type Principal,
} from '@shikkha/permissions';
import {
  AI_SUGGESTION_SORT_FIELDS,
  aiSuggestionProposedActionSchema,
  type AcceptAiSuggestionInput,
  type AiConfidenceBand,
  type AiCopilotSurface,
  type AiSuggestionEvidenceEntry,
  type AiSuggestionKind,
  type AiSuggestionSubjectType,
  type DismissAiSuggestionInput,
  type ListAiSuggestionsInput,
} from '@shikkha/validation';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { StudentsService } from '../students/students.service';
import { currentContext } from '../../common/context/request-context';
import { getLogger } from '../../common/logger';
import { contractFor, SUBJECT_VIEW_PERMISSIONS } from './suggestion-contracts';
import { SuggestionExecutorService } from './suggestion-executor.service';

type SuggestionRow = typeof aiSuggestions.$inferSelect;
type Tx = Parameters<Parameters<DatabaseService['runInTenant']>[0]>[0];

/**
 * How long a suggestion stays actionable.
 *
 * Fourteen days: long enough for a teacher to come back after a week's leave, short enough
 * that the attendance percentage it quotes has not been overtaken by another half-term. The
 * value is here rather than in configuration because a school that could set it to a year
 * would eventually set it to a year, and a year-old fee reminder is a wrong number sent to a
 * parent with the school's name on it.
 */
const SUGGESTION_LIFETIME_DAYS = 14;

/** What a caller hands `createFromFindings` — a finding, completed with its payload. */
export interface SuggestionDraft {
  kind: AiSuggestionKind;
  surface: AiCopilotSurface;
  subjectType: AiSuggestionSubjectType;
  subjectId: string;
  aboutUserId?: string | null;
  titleEn: string;
  titleBn?: string | null;
  bodyEn: string;
  bodyBn?: string | null;
  evidence: AiSuggestionEvidenceEntry[];
  confidence: AiConfidenceBand;
  proposedAction: { module: string; action: string; resourceId?: string; payload: unknown };
  conversationId?: string | null;
  model?: string | null;
  providerKey?: string | null;
}

@Injectable()
export class AiSuggestionService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly studentsService: StudentsService,
    private readonly executor: SuggestionExecutorService,
  ) {}

  // ── Generation ──────────────────────────────────────────────────────────────────────

  /**
   * Persist the drafts one copilot turn produced.
   *
   * Written to be safe to call twice with the same drafts, because a user who asks the same
   * question twice is not making a mistake. The partial unique index
   * `ai_suggestions_pending_subject_key` is the enforcement; this method is what makes the
   * enforcement produce a sensible outcome instead of a 500:
   *
   *   · a live pending suggestion for the same (kind, subject) is left exactly as it is, and
   *     returned, so the reviewer sees one card rather than five;
   *   · a pending suggestion whose `expiresAt` has passed is marked `expired`, the new one is
   *     inserted, and the old one is then pointed at the new one as `superseded` — the only
   *     transition out of `expired` the database allows, and the reason it allows it.
   *
   * Runs in one transaction per turn: either the whole set of suggestions from an answer is
   * there or none of it is, so a reviewer never sees half of a copilot's reasoning.
   */
  async createFromFindings(
    principal: Principal,
    institutionId: string,
    drafts: readonly SuggestionDraft[],
  ): Promise<SuggestionRow[]> {
    if (drafts.length === 0) return [];

    const now = new Date();
    const expiresAt = new Date(now.getTime() + SUGGESTION_LIFETIME_DAYS * 24 * 60 * 60 * 1000);

    return this.db.runInTenant(async (tx) => {
      const created: SuggestionRow[] = [];

      for (const draft of drafts) {
        const contract = contractFor(draft.kind);

        // The row states which service it expects to be handed to, and the generator is not
        // allowed to disagree with the contract table about it. A mismatch here would be a
        // programming error that only shows up at accept time, on somebody else's shift.
        const proposedAction = aiSuggestionProposedActionSchema.parse({
          module: contract.module,
          action: contract.action,
          ...(draft.proposedAction.resourceId
            ? { resourceId: draft.proposedAction.resourceId }
            : {}),
          payload: draft.proposedAction.payload,
        });

        const [existing] = await tx
          .select()
          .from(aiSuggestions)
          .where(
            and(
              eq(aiSuggestions.institutionId, institutionId),
              eq(aiSuggestions.kind, draft.kind),
              eq(aiSuggestions.subjectType, draft.subjectType),
              eq(aiSuggestions.subjectId, draft.subjectId),
              eq(aiSuggestions.status, 'pending'),
            ),
          )
          .for('update')
          .limit(1);

        if (existing && existing.expiresAt > now) {
          created.push(existing);
          continue;
        }

        if (existing) {
          await tx
            .update(aiSuggestions)
            .set({ status: 'expired', version: existing.version + 1 })
            .where(eq(aiSuggestions.id, existing.id));
        }

        const id = uuidv7();
        const [row] = await tx
          .insert(aiSuggestions)
          .values({
            id,
            tenantId: principal.tenantId!,
            institutionId,
            kind: draft.kind,
            status: 'pending',
            surface: draft.surface,
            subjectType: draft.subjectType,
            subjectId: draft.subjectId,
            aboutUserId: draft.aboutUserId ?? null,
            titleEn: draft.titleEn,
            titleBn: draft.titleBn ?? null,
            bodyEn: draft.bodyEn,
            bodyBn: draft.bodyBn ?? null,
            evidence: draft.evidence,
            confidence: draft.confidence,
            proposedAction,
            actionPermission: contract.actionPermission,
            generatedByConversationId: draft.conversationId ?? null,
            model: draft.model ?? null,
            providerKey: draft.providerKey ?? null,
            expiresAt,
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning();

        if (existing) {
          // `expired` → `superseded`, carrying the pointer. The trail then reads: this was
          // raised, nobody got to it, and here is what replaced it.
          await tx
            .update(aiSuggestions)
            .set({
              status: 'superseded',
              supersededById: id,
              version: existing.version + 2,
            })
            .where(eq(aiSuggestions.id, existing.id));
        }

        created.push(row!);
      }

      return created;
    });
  }

  // ── Reads ───────────────────────────────────────────────────────────────────────────

  async list(
    principal: Principal,
    institutionId: string,
    query: ListAiSuggestionsInput,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<SuggestionRow>> {
    const sorts = parseSort(query.sort, AI_SUGGESTION_SORT_FIELDS, {
      field: 'createdAt',
      direction: 'desc',
    });

    return this.db.runInTenant(async (tx) => {
      const where = and(...this.listFilters(principal, institutionId, query));

      const rows = await tx
        .select()
        .from(aiSuggestions)
        .where(where)
        .orderBy(
          ...sorts.map((spec) => {
            const column =
              spec.field === 'expiresAt'
                ? aiSuggestions.expiresAt
                : spec.field === 'kind'
                  ? aiSuggestions.kind
                  : spec.field === 'status'
                    ? aiSuggestions.status
                    : aiSuggestions.createdAt;
            return spec.direction === 'asc' ? asc(column) : desc(column);
          }),
        )
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(aiSuggestions)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async findOne(
    principal: Principal,
    institutionId: string,
    id: string,
  ): Promise<SuggestionRow> {
    return this.db.runInTenant(async (tx) => this.loadVisible(tx, principal, institutionId, id));
  }

  private listFilters(
    principal: Principal,
    institutionId: string,
    query: ListAiSuggestionsInput,
  ): SQL[] {
    const filters: SQL[] = [
      eq(aiSuggestions.institutionId, institutionId),
      isNull(aiSuggestions.archivedAt),
      this.visibilityFilter(principal),
    ];
    if (query.status) filters.push(eq(aiSuggestions.status, query.status));
    if (query.kind) filters.push(eq(aiSuggestions.kind, query.kind));
    if (query.surface) filters.push(eq(aiSuggestions.surface, query.surface));
    if (query.subjectType) filters.push(eq(aiSuggestions.subjectType, query.subjectType));
    if (query.subjectId) filters.push(eq(aiSuggestions.subjectId, query.subjectId));

    if (!query.includeExpired) {
      // A pending suggestion past its expiry is not actionable — accept refuses it — so it is
      // out of the default queue. It is still `pending` in the database until something
      // supersedes it, because rewriting rows on a GET is how a read endpoint acquires a
      // write path nobody remembers it has.
      filters.push(
        or(
          sql`${aiSuggestions.status} <> 'pending'`,
          gt(aiSuggestions.expiresAt, new Date()),
        )!,
      );
    }

    return filters;
  }

  /**
   * Load a suggestion the caller is entitled to see, or 404.
   *
   * `NotFoundError`, never `ForbiddenError`, for the same reason the conversations service
   * answers 404: a 403 confirms that a suggestion with this id exists in this institution, and
   * the existence of a card saying "refuse Mr Rahman's travel claim" is itself the disclosure.
   */
  private async loadVisible(
    tx: Tx,
    principal: Principal,
    institutionId: string,
    id: string,
  ): Promise<SuggestionRow> {
    const [row] = await tx
      .select()
      .from(aiSuggestions)
      .where(
        and(
          eq(aiSuggestions.id, id),
          eq(aiSuggestions.institutionId, institutionId),
          this.visibilityFilter(principal),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError('AI suggestion', id);
    return row;
  }

  /**
   * Who may see a suggestion, decided on the data.
   *
   * The route already establishes that the caller may use a copilot. That is not the same
   * question as whether they may read *this* suggestion, whose body quotes a child's
   * attendance, a family's balance or a colleague's expense claim. So visibility is decided
   * per subject:
   *
   *   student  — exactly the students the caller could open in the students module, reusing
   *              `StudentsService.scopeFilterSql` so the two answers cannot diverge. A class
   *              teacher therefore never sees a suggestion about a child outside their
   *              sections, and the rule is not written down twice.
   *   section  — a section holding at least one student the caller may see, which is the same
   *              test `ToolScopeService.assertSectionVisible` applies. A caller with the `all`
   *              scope sees every section, including an empty one.
   *   the rest — fail closed on a domain read permission (`SUBJECT_VIEW_PERMISSIONS`).
   *
   * A caller with no students scope at all sees no student or section suggestions. `sql\`false\``
   * when nothing matches, so an unrecognised subject type is invisible rather than universal —
   * a new subject type added without a rule here is a feature that appears not to work, which
   * is the failure that gets noticed, rather than a leak, which is the one that does not.
   */
  private visibilityFilter(principal: Principal): SQL {
    const context = currentContext();
    const studentScope: DataScope = resolveDataScope(principal, SCOPED_RESOURCES.students, {
      institutionId: context?.institutionId ?? null,
      campusId: context?.campusId ?? null,
    });

    const clauses: SQL[] = [];

    if (studentScope !== 'none') {
      const scopeFilter = this.studentsService.scopeFilterSql(principal, studentScope);

      clauses.push(
        and(
          eq(aiSuggestions.subjectType, 'student'),
          exists(
            this.db.raw
              .select({ one: sql`1` })
              .from(students)
              .where(
                and(
                  eq(students.id, aiSuggestions.subjectId),
                  isNull(students.archivedAt),
                  scopeFilter,
                ),
              ),
          ),
        )!,
      );

      clauses.push(
        and(
          eq(aiSuggestions.subjectType, 'section'),
          studentScope === 'all'
            ? sql`true`
            : exists(
                this.db.raw
                  .select({ one: sql`1` })
                  .from(enrollments)
                  .innerJoin(students, eq(students.id, enrollments.studentId))
                  .where(
                    and(
                      eq(enrollments.sectionId, aiSuggestions.subjectId),
                      eq(enrollments.status, 'active'),
                      isNull(enrollments.archivedAt),
                      isNull(students.archivedAt),
                      scopeFilter,
                    ),
                  ),
              ),
        )!,
      );
    }

    for (const [subjectType, permission] of Object.entries(SUBJECT_VIEW_PERMISSIONS)) {
      if (permission && can(principal, permission)) {
        clauses.push(eq(aiSuggestions.subjectType, subjectType));
      }
    }

    if (clauses.length === 0) return sql`false`;
    return or(...clauses)!;
  }

  // ── Deciding ────────────────────────────────────────────────────────────────────────

  /**
   * Accept: the human confirmation docs/06 §6 requires, and the only path in this module that
   * changes anything outside `ai_suggestions`.
   *
   * The refusals, in the order they run, each with the reason it is where it is:
   *
   *   404  not visible to this caller             (before anything else, so a probe learns nothing)
   *   409  the row's permission disagrees with the contract table  (a drifted mapping)
   *   403  the caller lacks the ACTION's permission               (before the claim, so the
   *                                                                suggestion stays pending for
   *                                                                somebody who can act)
   *   403  the caller is the person it is about   (nobody signs off on themselves)
   *   409  already decided, or expired            (a stale card must not send a stale message)
   *   409  version mismatch                       (two reviewers, one action)
   */
  async accept(
    principal: Principal,
    institutionId: string,
    id: string,
    input: AcceptAiSuggestionInput,
  ): Promise<{ suggestion: SuggestionRow; previous: { status: string } }> {
    const suggestion = await this.db.runInTenant(async (tx) =>
      this.loadVisible(tx, principal, institutionId, id),
    );

    this.assertAcceptable(principal, suggestion, input.version);

    const claimed = await this.claim(principal, suggestion, input);

    const proposedAction = aiSuggestionProposedActionSchema.parse(claimed.proposedAction);

    try {
      const outcome = await this.executor.execute(
        principal,
        institutionId,
        claimed.kind,
        proposedAction,
        claimed.id,
      );

      const recorded = await this.recordExecution(principal, institutionId, claimed, outcome);
      return { suggestion: recorded, previous: { status: 'pending' } };
    } catch (error) {
      // The decision stands and the action did not happen. Recorded as `failed` with the
      // reason, so the row says so plainly instead of looking like a completed one, and
      // re-thrown so the caller gets the owning module's own error rather than a success.
      await this.recordExecutionFailure(principal, claimed, error);
      throw error;
    }
  }

  private assertAcceptable(
    principal: Principal,
    suggestion: SuggestionRow,
    version: number,
  ): void {
    const contract = contractFor(suggestion.kind);

    if (suggestion.actionPermission !== contract.actionPermission) {
      // The row and the code disagree about what accepting costs. Refusing is the only safe
      // answer: executing under either reading would be executing under a rule nobody wrote.
      throw new ConflictError(
        'This suggestion was generated under a different permission rule and can no longer be accepted. Dismiss it and ask again.',
        {
          suggestionId: suggestion.id,
          recorded: suggestion.actionPermission,
          expected: contract.actionPermission,
        },
      );
    }

    if (!can(principal, contract.actionPermission)) {
      // The permission of the ACTION, not of the copilot. Seeing a suggestion and being able
      // to carry it out are different grants, and this is the line between them.
      throw new ForbiddenError(
        contract.actionPermission,
        `Accepting this suggestion performs the action itself, which needs ${contract.actionPermission}`,
      );
    }

    if (suggestion.aboutUserId && suggestion.aboutUserId === principal.userId) {
      throw new ForbiddenError(
        contract.actionPermission,
        'This suggestion is about you, so somebody else has to decide it',
      );
    }

    if (suggestion.status !== 'pending') {
      throw new ConflictError(
        `This suggestion was already ${suggestion.status} and cannot be accepted again`,
        { suggestionId: suggestion.id, status: suggestion.status },
      );
    }

    if (suggestion.expiresAt <= new Date()) {
      // The facts underneath have had two weeks to move. Sending the message anyway would put
      // the school's name on a number its own ledger no longer agrees with.
      throw new ConflictError(
        'This suggestion has expired. Ask the copilot again so the figures are current.',
        { suggestionId: suggestion.id, expiresAt: suggestion.expiresAt },
      );
    }

    if (suggestion.version !== version) {
      throw new ConflictError('This suggestion was changed by someone else. Reload and retry.', {
        suggestionId: suggestion.id,
        currentVersion: suggestion.version,
      });
    }
  }

  /**
   * The claim: one conditional statement, and the only thing standing between two reviewers
   * and two messages to the same parent.
   *
   * `where … and status = 'pending' and version = $n` means the decision is made by the
   * database's own concurrency control rather than by the read that preceded it. Zero rows
   * updated is a 409, not a retry.
   */
  private async claim(
    principal: Principal,
    suggestion: SuggestionRow,
    input: AcceptAiSuggestionInput,
  ): Promise<SuggestionRow> {
    const claimed = await this.db.runInTenant(async (tx) => {
      const [row] = await tx
        .update(aiSuggestions)
        .set({
          status: 'accepted',
          decidedByUserId: principal.userId,
          decidedAt: new Date(),
          decisionReason: input.note ?? null,
          version: suggestion.version + 1,
          updatedBy: principal.userId,
        })
        .where(
          and(
            eq(aiSuggestions.id, suggestion.id),
            eq(aiSuggestions.status, 'pending'),
            eq(aiSuggestions.version, input.version),
          ),
        )
        .returning();
      return row ?? null;
    });

    if (!claimed) {
      throw new ConflictError(
        'This suggestion was decided by someone else while you were reading it.',
        { suggestionId: suggestion.id },
      );
    }
    return claimed;
  }

  /** The outcome, and the AI-initiated audit row that ties the action back to the evidence. */
  private async recordExecution(
    principal: Principal,
    institutionId: string,
    claimed: SuggestionRow,
    outcome: { resourceType: string; resourceId: string; resourceLabel: string },
  ): Promise<SuggestionRow> {
    const context = currentContext();

    return this.db.runInTenant(async (tx) => {
      const [row] = await tx
        .update(aiSuggestions)
        .set({
          executionState: 'executed',
          executedAt: new Date(),
          executedResourceType: outcome.resourceType,
          executedResourceId: outcome.resourceId,
          version: claimed.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(aiSuggestions.id, claimed.id))
        .returning();

      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        campusId: context?.campusId ?? null,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'approve',
        module: 'ai-copilot',
        resourceType: 'ai_suggestion',
        resourceId: claimed.id,
        resourceLabel: claimed.titleEn,
        previousValue: { status: 'pending' },
        newValue: {
          status: 'accepted',
          kind: claimed.kind,
          surface: claimed.surface,
          confidence: claimed.confidence,
          actionPermission: claimed.actionPermission,
          // The trail leads both ways: from the suggestion to what it produced, and from the
          // produced record back to the evidence somebody accepted it on.
          executedResourceType: outcome.resourceType,
          executedResourceId: outcome.resourceId,
          executedResourceLabel: outcome.resourceLabel,
          evidenceCount: Array.isArray(claimed.evidence) ? claimed.evidence.length : 0,
        },
        reason: claimed.decisionReason,
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
        // docs/06 §6. A model drafted this and a person confirmed it; years from now that is
        // the difference somebody will need to know.
        isAiInitiated: true,
      });

      return row!;
    });
  }

  private async recordExecutionFailure(
    principal: Principal,
    claimed: SuggestionRow,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await this.db.runInTenant(async (tx) => {
        await tx
          .update(aiSuggestions)
          .set({
            executionState: 'failed',
            executedAt: new Date(),
            executionError: message.slice(0, 1000),
            version: claimed.version + 1,
            updatedBy: principal.userId,
          })
          .where(eq(aiSuggestions.id, claimed.id));
      });
    } catch (writeError) {
      // Never mask the owning module's error with a bookkeeping one: the caller needs to be
      // told why the action was refused, not why the note about the refusal could not be
      // written.
      getLogger().error(
        { err: writeError, suggestionId: claimed.id },
        'could not record an AI suggestion execution failure',
      );
    }
  }

  /**
   * Dismiss, with a reason.
   *
   * Everything here is one transaction, because nothing outside `ai_suggestions` happens: this
   * is the branch where the AI's proposal ends. The reason is mandatory because it is the only
   * signal anyone will ever have about whether the copilot is worth having — "the family
   * already paid", "wrong child", "we spoke to them yesterday" are three different verdicts on
   * the system, and without them the only available measure is an acceptance rate, which
   * measures how agreeable staff are.
   */
  async dismiss(
    principal: Principal,
    institutionId: string,
    id: string,
    input: DismissAiSuggestionInput,
  ): Promise<{ suggestion: SuggestionRow; previous: { status: string } }> {
    const context = currentContext();

    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadVisible(tx, principal, institutionId, id);

      if (existing.status !== 'pending') {
        throw new ConflictError(
          `This suggestion was already ${existing.status} and cannot be dismissed`,
          { suggestionId: id, status: existing.status },
        );
      }
      if (existing.version !== input.version) {
        throw new ConflictError('This suggestion was changed by someone else. Reload and retry.', {
          suggestionId: id,
          currentVersion: existing.version,
        });
      }

      const [row] = await tx
        .update(aiSuggestions)
        .set({
          status: 'dismissed',
          decidedByUserId: principal.userId,
          decidedAt: new Date(),
          decisionReason: input.reason,
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(
          and(
            eq(aiSuggestions.id, id),
            eq(aiSuggestions.status, 'pending'),
            eq(aiSuggestions.version, input.version),
          ),
        )
        .returning();

      if (!row) {
        throw new ConflictError(
          'This suggestion was decided by someone else while you were reading it.',
          { suggestionId: id },
        );
      }

      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        campusId: context?.campusId ?? null,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'reject',
        module: 'ai-copilot',
        resourceType: 'ai_suggestion',
        resourceId: id,
        resourceLabel: existing.titleEn,
        previousValue: { status: 'pending' },
        newValue: { status: 'dismissed', kind: existing.kind, confidence: existing.confidence },
        reason: input.reason,
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
        // True here too. A trail that flags every acceptance and no refusal cannot answer "how
        // often was the copilot wrong", which is the question that decides whether it stays.
        isAiInitiated: true,
      });

      return { suggestion: row, previous: { status: existing.status } };
    });
  }

  // ── Helpers the generator needs, kept here because they read this module's neighbours ──

  /**
   * The guardian user a message about this child should go to.
   *
   * Prefers the billing contact for anything about money and the primary contact otherwise,
   * and requires `can_access_portal` — a guardian whose portal access was revoked has been
   * deliberately cut off from the child's records, and opening a thread with them would route
   * around that decision. Returns null when there is nobody, and the caller then raises no
   * suggestion at all: a fee reminder addressed to nobody is not a smaller version of a fee
   * reminder.
   */
  async primaryGuardianUserId(
    studentId: string,
    prefer: 'billing' | 'primary',
  ): Promise<{ userId: string; name: string } | null> {
    return this.db.runInTenant(async (tx) => {
      const preferred =
        prefer === 'billing' ? studentGuardians.isBillingContact : studentGuardians.isPrimary;

      const rows = await tx
        .select({ userId: guardians.userId, name: guardians.fullNameEn, preferred })
        .from(studentGuardians)
        .innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
        .where(
          and(
            eq(studentGuardians.studentId, studentId),
            eq(studentGuardians.canAccessPortal, true),
            isNull(studentGuardians.archivedAt),
            isNull(guardians.archivedAt),
          ),
        )
        .orderBy(desc(preferred))
        .limit(1);

      const row = rows[0];
      if (!row?.userId) return null;
      return { userId: row.userId, name: row.name };
    });
  }

  /** The student's own display name, for a message subject a human will read. */
  async studentName(studentId: string): Promise<string | null> {
    return this.db.runInTenant(async (tx) => {
      const [row] = await tx
        .select({ name: students.fullNameEn })
        .from(students)
        .where(and(eq(students.id, studentId), isNull(students.archivedAt)))
        .limit(1);
      return row?.name ?? null;
    });
  }

  /** Suggestions whose decision was recorded but whose action never ran — the visible gap. */
  async listStalledExecutions(institutionId: string): Promise<SuggestionRow[]> {
    return this.db.runInTenant(async (tx) =>
      tx
        .select()
        .from(aiSuggestions)
        .where(
          and(
            eq(aiSuggestions.institutionId, institutionId),
            eq(aiSuggestions.status, 'accepted'),
            eq(aiSuggestions.executionState, 'not_started'),
            lte(aiSuggestions.decidedAt, new Date()),
          ),
        )
        .orderBy(asc(aiSuggestions.decidedAt))
        .limit(100),
    );
  }
}
