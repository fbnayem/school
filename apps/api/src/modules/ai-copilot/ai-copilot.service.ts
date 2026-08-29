/**
 * The copilot turn: a question in, a grounded answer plus citations plus zero or more
 * suggestions out.
 *
 * Four properties hold on every path through this file, and each is the reason for a specific
 * shape below rather than a general aspiration:
 *
 *  1. **The copilot cannot exceed its user.** The tools offered are
 *     `surface allow-list ∩ ToolRegistryService.manifest(principal)`, and every invocation goes
 *     back through `ToolRegistryService.invoke`, which re-checks the tool's own permission
 *     against the principal regardless of what the manifest said. A teacher who asks a finance
 *     question is not offered a finance tool, and if the model names one anyway it gets the
 *     same 404 a stranger would (docs/06 §1–2).
 *  2. **The model never sees an instruction it was not given.** The surface's instructions are
 *     a `system` message; the user's question is a `user` message; tool results are `tool`
 *     messages wrapped in the untrusted-data envelope from `modules/ai-tools`. There is no
 *     line in this file that interpolates one into another, which is what makes docs/06 §3
 *     defence 2 structural rather than remembered.
 *  3. **The loop terminates.** A bounded number of tool rounds, a wall-clock ceiling, and a
 *     final completion with **no tools offered** so the last word is always an answer. An
 *     injected prompt that induces an endless tool loop is a denial-of-service attack against
 *     the school's own inference budget, and a school on a fixed subscription cannot absorb
 *     one.
 *  4. **The suggestions are not the model's.** They are derived by `suggestion-rules.ts` from
 *     the tool results this turn actually produced. The model writes the prose the user reads;
 *     it does not decide that a child should be referred, and it never supplies a number that
 *     lands in `evidence` or a band that lands in `confidence`.
 */

import { Injectable } from '@nestjs/common';
import { ConflictError, ForbiddenError, todayInDhaka } from '@shikkha/shared';
import { and, eq, isNull, asc } from 'drizzle-orm';
import { academicYears, behaviourCategories } from '@shikkha/db';
import { canAll, type Permission, type Principal } from '@shikkha/permissions';
import type { AiCopilotSurface, AskAiCopilotInput, AiSuggestionKind } from '@shikkha/validation';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { AiConversationService } from '../ai/ai-conversation.service';
import { AiUsageService } from '../ai/ai-usage.service';
import { AiProviderRegistry } from '../ai/providers/registry';
import { loadAiConfig } from '../ai/ai.config';
import type {
  AiTask,
  CompletionMessage,
  CompletionToolSpec,
} from '../ai/providers/provider.interface';
import { ToolRegistryService } from '../ai-tools/tool-registry.service';
import { untrusted } from '../ai-tools/untrusted-text';
import type { AiToolCitation } from '../ai-tools/tools/tool.types';
import { currentContext } from '../../common/context/request-context';
import { getLogger } from '../../common/logger';
import { COPILOT_SURFACES, COPILOT_SURFACE_LIST } from './copilot-surfaces';
import { SUGGESTION_ACTION_CONTRACTS } from './suggestion-contracts';
import { AiSuggestionService, type SuggestionDraft } from './ai-suggestion.service';
import { deriveFindings, type SuggestionFinding, type ToolObservation } from './suggestion-rules';

/**
 * How many times the model may ask for tools before it has to answer.
 *
 * Two, not "until it stops". The tools here answer one question each and none of them takes
 * another's output as input, so a second round exists only to let a model correct an argument
 * it got wrong the first time. Beyond that, more rounds buy nothing and cost a school money.
 */
const MAX_TOOL_ROUNDS = 2;

/** The ceiling on one turn, whatever the model is doing. See property 3 in the header. */
const COPILOT_WALL_CLOCK_MS = 45_000;

export interface CopilotAnswer {
  conversationId: string;
  surface: AiCopilotSurface;
  answer: string;
  citations: AiToolCitation[];
  /** Which tools ran, with the arguments they ran with. The user's own receipt. */
  toolCalls: { tool: string; arguments: Record<string, unknown> }[];
  suggestions: {
    id: string;
    kind: AiSuggestionKind;
    titleEn: string;
    titleBn: string | null;
    confidence: string;
    status: string;
    expiresAt: Date;
    evidence: unknown;
    version: number;
  }[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cost: string;
    model: string;
    providerKey: string;
  };
  budgetWarning?: string;
}

@Injectable()
export class AiCopilotService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly conversations: AiConversationService,
    private readonly usage: AiUsageService,
    private readonly providers: AiProviderRegistry,
    private readonly tools: ToolRegistryService,
    private readonly suggestions: AiSuggestionService,
  ) {}

  // ── Capabilities ────────────────────────────────────────────────────────────────────

  /**
   * What this caller's copilot can actually do, derived from their permissions.
   *
   * Every field is computed, none is a constant list dressed up as an answer. The point of the
   * endpoint is honesty: a user whose account cannot reach the finance tool should be told that
   * before they ask a question about money and get a polite non-answer, and an administrator
   * debugging "why can't Ms Akter see fees" should get the permission name rather than a
   * shrug. `missingPermissions` names what is absent, which is the only actionable half.
   */
  capabilities(principal: Principal) {
    const context = currentContext();
    const accessContext = {
      institutionId: context?.institutionId ?? null,
      campusId: context?.campusId ?? null,
    };
    const permittedTools = new Set(this.tools.manifest(principal).map((entry) => entry.name));

    return {
      surfaces: COPILOT_SURFACE_LIST.map((surface) => {
        const missing = surface.permissions.filter(
          (permission) => !canAll(principal, [permission], accessContext),
        );
        return {
          key: surface.key,
          available: missing.length === 0,
          requiredPermissions: surface.permissions,
          missingPermissions: missing,
          // The intersection, not the allow-list: what would actually be offered to a model
          // in this caller's session.
          tools: surface.tools.filter((tool) => permittedTools.has(tool)),
          purpose: surface.purpose,
        };
      }),
      /**
       * Which suggestions this caller could act on if the copilot raised one.
       *
       * Deliberately reported separately from the surfaces. Seeing a suggestion and being able
       * to carry it out are different grants, and a UI that hides the accept button without
       * saying why teaches people that the system is broken.
       */
      suggestionKinds: Object.values(SUGGESTION_ACTION_CONTRACTS).map((contract) => ({
        kind: contract.kind,
        describes: contract.describes,
        actionPermission: contract.actionPermission,
        canAccept: canAll(principal, [contract.actionPermission], accessContext),
      })),
    };
  }

  // ── The turn ────────────────────────────────────────────────────────────────────────

  async ask(
    principal: Principal,
    institutionId: string,
    input: AskAiCopilotInput,
  ): Promise<CopilotAnswer> {
    const surface = COPILOT_SURFACES[input.surface];
    this.assertSurfacePermitted(principal, surface.permissions, surface.key);

    // Before the provider is consulted, never after (docs/06 §8). A refused turn writes no
    // message, no usage event and no suggestion.
    const budget = await this.usage.assertWithinBudget(principal, institutionId, surface.task);

    const conversation = await this.resolveConversation(principal, institutionId, input, surface);

    // The intersection. A surface can subtract a capability and can never add one.
    const permitted = this.tools.manifest(principal);
    const offered = permitted.filter((entry) =>
      (surface.tools as readonly string[]).includes(entry.name),
    );
    const toolSpecs: CompletionToolSpec[] = offered.map((entry) => ({
      name: entry.name,
      description: entry.description,
      parameters: entry.parameters as unknown as Record<string, unknown>,
    }));

    const history = await this.conversationHistory(principal, institutionId, conversation.id);

    const messages: CompletionMessage[] = [
      { role: 'system', content: surface.instructions },
      ...history,
      { role: 'user', content: input.question },
    ];

    const provider = this.providers.forTask(surface.task);
    const config = loadAiConfig();
    const startedAt = Date.now();

    const observations: ToolObservation[] = [];
    const citations: AiToolCitation[] = [];
    const toolTurns: { content: string; toolCallId: string }[] = [];
    const invoked = new Set<string>();

    let inputTokens = 0;
    let outputTokens = 0;

    let response = await provider.complete({
      task: surface.task,
      messages,
      tools: toolSpecs,
      maxOutputTokens: config.AI_MAX_OUTPUT_TOKENS,
    });
    inputTokens += response.usage.inputTokens;
    outputTokens += response.usage.outputTokens;

    for (let round = 0; round < MAX_TOOL_ROUNDS && response.toolCalls.length > 0; round += 1) {
      if (Date.now() - startedAt > COPILOT_WALL_CLOCK_MS) break;

      let ranSomething = false;
      // The assistant's own turn has to be in the transcript before its tool results, or the
      // replayed conversation reads as answers to questions nobody asked.
      messages.push({ role: 'assistant', content: response.text });

      for (const call of response.toolCalls) {
        const signature = `${call.name}:${JSON.stringify(call.arguments)}`;
        // A model that asks the same question twice gets one answer. Without this, a prompt
        // that repeats a tool marker turns one turn into an unbounded bill.
        if (invoked.has(signature)) continue;
        invoked.add(signature);

        const outcome = await this.invokeTool(
          principal,
          institutionId,
          call.name,
          call.arguments,
        );
        if (!outcome) continue;
        ranSomething = true;

        observations.push({
          tool: outcome.tool as ToolObservation['tool'],
          arguments: outcome.arguments,
          result: outcome.result,
        });
        if (outcome.citations) citations.push(...outcome.citations);

        // Provenance is not authorship: a knowledge-base excerpt is a document somebody
        // uploaded and a student remark is text somebody typed, so a tool result reaches the
        // model inside the same envelope a user's own message would.
        const enveloped =
          untrusted(`tool.${outcome.tool.replace(/\./g, '_')}`, JSON.stringify(outcome.result)) ??
          '(the tool returned nothing)';
        messages.push({ role: 'tool', content: enveloped, toolCallId: call.id });
        toolTurns.push({ content: enveloped, toolCallId: call.id });
      }

      if (!ranSomething) break;

      response = await provider.complete({
        task: surface.task,
        messages,
        tools: toolSpecs,
        maxOutputTokens: config.AI_MAX_OUTPUT_TOKENS,
      });
      inputTokens += response.usage.inputTokens;
      outputTokens += response.usage.outputTokens;
    }

    if (response.toolCalls.length > 0) {
      // The model still wants a tool and its budget of rounds is spent. Offering none forces
      // an answer, which is a better outcome than a 200 whose body is an apology for a loop.
      response = await provider.complete({
        task: surface.task,
        messages,
        maxOutputTokens: config.AI_MAX_OUTPUT_TOKENS,
      });
      inputTokens += response.usage.inputTokens;
      outputTokens += response.usage.outputTokens;
    }

    const persisted = await this.persistTurn(principal, institutionId, conversation.id, {
      question: input.question,
      toolTurns,
      answer: response.text,
      providerKey: provider.key,
      model: response.model,
      inputTokens,
      outputTokens,
      finishReason: response.finishReason,
      task: surface.task,
      purpose: surface.purpose,
      currency: budget.currency,
      toolNames: observations.map((observation) => observation.tool),
    });

    // Only now, and only from what the tools actually returned.
    const drafts = await this.buildDrafts(
      institutionId,
      surface.key,
      conversation.id,
      provider.key,
      response.model,
      deriveFindings(observations),
    );
    const stored = await this.suggestions.createFromFindings(principal, institutionId, drafts);

    const answer: CopilotAnswer = {
      conversationId: conversation.id,
      surface: surface.key,
      answer: response.text,
      citations: dedupeCitations(citations),
      toolCalls: observations.map((observation) => ({
        tool: observation.tool,
        arguments: observation.arguments,
      })),
      suggestions: stored.map((row) => ({
        id: row.id,
        kind: row.kind,
        titleEn: row.titleEn,
        titleBn: row.titleBn,
        confidence: row.confidence,
        status: row.status,
        expiresAt: row.expiresAt,
        evidence: row.evidence,
        version: row.version,
      })),
      usage: {
        inputTokens,
        outputTokens,
        cost: persisted.cost,
        model: response.model,
        providerKey: provider.key,
      },
    };
    if (budget.warning) answer.budgetWarning = budget.warning;
    return answer;
  }

  // ── Pieces of the turn ──────────────────────────────────────────────────────────────

  private assertSurfacePermitted(
    principal: Principal,
    permissions: readonly Permission[],
    surface: AiCopilotSurface,
  ): void {
    const context = currentContext();
    const accessContext = {
      institutionId: context?.institutionId ?? null,
      campusId: context?.campusId ?? null,
    };
    // A conjunction: the accounts copilot needs permission to use AI *and* permission to read
    // the school's finances, and holding one without the other is exactly the state that must
    // not open it. The route's own guard carries the weakest common permission; this is the
    // per-surface half, and it names the first missing permission so an administrator can fix
    // it rather than guess.
    const missing = permissions.find((permission) => !canAll(principal, [permission], accessContext));
    if (missing) {
      throw new ForbiddenError(missing, `The ${surface} copilot needs ${missing}`);
    }
  }

  /**
   * The conversation this turn belongs to.
   *
   * A continued conversation must match the surface, because the purpose decides the model
   * routing and the instruction block: continuing an `insights` transcript inside the teacher
   * surface would replay a principal's questions under a teacher's instructions, and the
   * teacher would see the answers.
   */
  private async resolveConversation(
    principal: Principal,
    institutionId: string,
    input: AskAiCopilotInput,
    surface: (typeof COPILOT_SURFACES)[AiCopilotSurface],
  ): Promise<{ id: string }> {
    if (input.conversationId) {
      const { conversation } = await this.conversations.findOne(
        principal,
        institutionId,
        input.conversationId,
      );
      if (conversation.purpose !== surface.purpose) {
        throw new ConflictError(
          'That conversation belongs to a different copilot. Start a new one for this surface.',
          { conversationId: conversation.id, purpose: conversation.purpose },
        );
      }
      if (conversation.archivedAt) {
        throw new ConflictError('This conversation is archived. Start a new one to continue.', {
          conversationId: conversation.id,
        });
      }
      return { id: conversation.id };
    }

    // Through the conversation service, so ownership, the archive rule and the audit row for
    // opening a transcript all have exactly one implementation.
    const { conversation } = await this.conversations.create(principal, institutionId, {
      title: surface.conversationTitle,
      purpose: surface.purpose,
      ...(input.subjectType && input.subjectId
        ? { subjectType: input.subjectType, subjectId: input.subjectId }
        : {}),
    });
    return { id: conversation.id };
  }

  private async conversationHistory(
    principal: Principal,
    institutionId: string,
    conversationId: string,
  ): Promise<CompletionMessage[]> {
    const { messages } = await this.conversations.findOne(principal, institutionId, conversationId);
    return messages
      .filter((message) => message.role !== 'system')
      .map((message) => {
        const replayed: CompletionMessage = { role: message.role, content: message.content };
        if (message.role === 'tool' && message.toolCallId) {
          replayed.toolCallId = message.toolCallId;
        }
        return replayed;
      });
  }

  /**
   * One tool call, through the registry.
   *
   * A refusal is swallowed and logged rather than failing the turn. The registry answers 404
   * for both "no such tool" and "not yours", and a model that hallucinated a tool name has not
   * broken the user's question — the right behaviour is to answer without it, which is exactly
   * what the empty return produces. The refusal is already a security event in the registry,
   * so nothing is lost by not repeating it here.
   */
  private async invokeTool(
    principal: Principal,
    institutionId: string,
    name: string,
    args: Record<string, unknown>,
  ) {
    try {
      return await this.tools.invoke({ principal, institutionId }, name, args);
    } catch (error) {
      getLogger().info(
        { tool: name, err: error instanceof Error ? error.message : String(error) },
        'copilot tool call refused; answering without it',
      );
      return null;
    }
  }

  /**
   * The transcript, the usage event and the audit row, in one transaction.
   *
   * Everything the answer implies commits or rolls back together, exactly as
   * `AiConversationService.complete` does it — and through `appendRaw`, so `seq` allocation and
   * the append-only discipline have one implementation rather than two that disagree under
   * concurrency.
   */
  private async persistTurn(
    principal: Principal,
    institutionId: string,
    conversationId: string,
    turn: {
      question: string;
      toolTurns: { content: string; toolCallId: string }[];
      answer: string;
      providerKey: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter';
      task: AiTask;
      purpose: 'copilot' | 'tutor' | 'teacher_tools' | 'insights' | 'knowledge_search';
      currency: string;
      toolNames: string[];
    },
  ): Promise<{ cost: string }> {
    const context = currentContext();

    return this.db.runInTenant(async (tx) => {
      await this.conversations.appendRaw(tx, principal, institutionId, conversationId, {
        role: 'user',
        content: turn.question,
      });

      for (const toolTurn of turn.toolTurns) {
        await this.conversations.appendRaw(tx, principal, institutionId, conversationId, {
          role: 'tool',
          content: toolTurn.content,
          toolCallId: toolTurn.toolCallId,
        });
      }

      const assistant = await this.conversations.appendRaw(
        tx,
        principal,
        institutionId,
        conversationId,
        {
          role: 'assistant',
          content: turn.answer,
          providerKey: turn.providerKey,
          model: turn.model,
          inputTokens: turn.inputTokens,
          outputTokens: turn.outputTokens,
          finishReason: turn.finishReason,
        },
      );

      const recorded = await this.usage.record(tx, {
        tenantId: principal.tenantId!,
        institutionId,
        conversationId,
        task: turn.task,
        providerKey: turn.providerKey,
        model: turn.model,
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        userId: principal.userId,
        purpose: turn.purpose,
        currency: turn.currency,
      });

      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        campusId: context?.campusId ?? null,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'create',
        module: 'ai-copilot',
        resourceType: 'ai_message',
        resourceId: assistant.id,
        resourceLabel: turn.purpose,
        newValue: {
          conversationId,
          task: turn.task,
          providerKey: turn.providerKey,
          model: turn.model,
          inputTokens: turn.inputTokens,
          outputTokens: turn.outputTokens,
          finishReason: turn.finishReason,
          toolsUsed: turn.toolNames,
          cost: recorded.cost,
          currency: turn.currency,
        },
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
        isAiInitiated: true,
      });

      return { cost: recorded.cost };
    });
  }

  // ── Findings → drafts ───────────────────────────────────────────────────────────────

  /**
   * Complete each finding with the payload the owning module's endpoint would receive.
   *
   * Every lookup below can fail to find what it needs, and every failure drops the suggestion
   * rather than filling in a plausible substitute. A fee reminder with no billing contact, a
   * referral with no behaviour category to file it under, or a referral in an institution with
   * no current academic year are all situations where the honest output is nothing at all — a
   * suggestion whose payload was guessed is a suggestion whose accept button does something
   * the reviewer did not read.
   */
  private async buildDrafts(
    institutionId: string,
    surface: AiCopilotSurface,
    conversationId: string,
    providerKey: string,
    model: string,
    findings: readonly SuggestionFinding[],
  ): Promise<SuggestionDraft[]> {
    if (findings.length === 0) return [];

    const drafts: SuggestionDraft[] = [];

    for (const finding of findings) {
      const studentName = await this.suggestions.studentName(finding.studentId);
      if (!studentName) continue;

      if (finding.kind === 'attendance_follow_up' || finding.kind === 'fee_reminder_draft') {
        const draft = await this.messageDraft(finding, studentName);
        if (draft) {
          drafts.push({
            ...draft,
            surface,
            conversationId,
            providerKey,
            model,
          });
        }
        continue;
      }

      const referral = await this.referralDraft(institutionId, finding, studentName);
      if (referral) {
        drafts.push({ ...referral, surface, conversationId, providerKey, model });
      }
    }

    return drafts;
  }

  private async messageDraft(
    finding: SuggestionFinding,
    studentName: string,
  ): Promise<Omit<SuggestionDraft, 'surface' | 'conversationId' | 'providerKey' | 'model'> | null> {
    const isFees = finding.kind === 'fee_reminder_draft';
    const guardian = await this.suggestions.primaryGuardianUserId(
      finding.studentId,
      isFees ? 'billing' : 'primary',
    );
    if (!guardian) return null;

    const subject = isFees
      ? `Fees outstanding for ${studentName}`
      : `Attendance for ${studentName}`;

    const body = isFees
      ? `Dear ${guardian.name}, our records show BDT ${finding.facts['outstanding']} outstanding ` +
        `for ${studentName} as at ${finding.facts['asOfDate']}. If this has already been paid, ` +
        `please let us know so we can correct it; otherwise please contact the accounts office.`
      : `Dear ${guardian.name}, ${studentName}'s attendance is ` +
        `${finding.facts['attendancePercentage']}% between ${finding.facts['from']} and ` +
        `${finding.facts['to']} (${finding.facts['absent']} absences). We would like to ` +
        `understand whether anything is making it hard to attend, and how the school can help.`;

    // Bangla for the two message kinds a guardian actually reads. Written from the same
    // figures, not translated by the model — a model-translated number is a number that can
    // change in translation, and this one is going to a parent with the school's name on it.
    const bodyBn = isFees
      ? `প্রিয় ${guardian.name}, আমাদের হিসাব অনুযায়ী ${finding.facts['asOfDate']} তারিখ পর্যন্ত ` +
        `${studentName}-এর ${finding.facts['outstanding']} টাকা বকেয়া রয়েছে। ইতিমধ্যে পরিশোধ করে ` +
        `থাকলে আমাদের জানাবেন; অন্যথায় হিসাব শাখায় যোগাযোগ করুন।`
      : `প্রিয় ${guardian.name}, ${finding.facts['from']} থেকে ${finding.facts['to']} পর্যন্ত ` +
        `${studentName}-এর উপস্থিতি ${finding.facts['attendancePercentage']}%। আমরা জানতে চাই ` +
        `উপস্থিতিতে কোনো অসুবিধা হচ্ছে কি না এবং বিদ্যালয় কীভাবে সহায়তা করতে পারে।`;

    return {
      kind: finding.kind,
      subjectType: 'student',
      subjectId: finding.studentId,
      // The guardian is the recipient, not the subject: the suggestion is about the child.
      // Recorded so that a guardian who somehow held the send permission could not accept a
      // message addressed to themselves about their own child.
      aboutUserId: guardian.userId,
      titleEn: subject,
      titleBn: isFees ? `${studentName}-এর বকেয়া ফি` : `${studentName}-এর উপস্থিতি`,
      bodyEn: body,
      bodyBn,
      evidence: finding.evidence,
      confidence: finding.confidence,
      proposedAction: {
        module: 'communication',
        action: 'thread.create',
        payload: {
          subject,
          kind: 'direct',
          participantUserIds: [guardian.userId],
          body,
        },
      },
    };
  }

  private async referralDraft(
    institutionId: string,
    finding: SuggestionFinding,
    studentName: string,
  ): Promise<Omit<SuggestionDraft, 'surface' | 'conversationId' | 'providerKey' | 'model'> | null> {
    const context = await this.referralContext(institutionId);
    if (!context) return null;

    const reasons = finding.evidence.map((entry) => entry.statement).join(' ');
    const description =
      `Pastoral referral raised from a copilot review of ${studentName}'s records. ${reasons} ` +
      `A member of staff should speak to the family and decide what support is needed.`;

    return {
      kind: 'intervention_referral',
      subjectType: 'student',
      subjectId: finding.studentId,
      aboutUserId: null,
      titleEn: `Pastoral referral for ${studentName}`,
      titleBn: `${studentName}-এর জন্য সহায়তা রেফারেল`,
      bodyEn: description,
      bodyBn: null,
      evidence: finding.evidence,
      confidence: finding.confidence,
      proposedAction: {
        module: 'discipline',
        action: 'record.create',
        payload: {
          studentId: finding.studentId,
          categoryId: context.categoryId,
          academicYearId: context.academicYearId,
          occurredOn: todayInDhaka(),
          description,
          severity: 'minor',
          // Explicitly zero. A welfare referral is not misconduct, and letting the category's
          // default points apply would dock a child's merit score for being absent.
          points: 0,
          // The module's own default. The copilot does not choose a confidentiality level the
          // reviewer never saw; a referral that needs restricting is restricted in the
          // discipline module, where that decision belongs and is audited as its own act.
          confidentiality: 'normal',
          submit: true,
        },
      },
    };
  }

  /**
   * The two ids a referral cannot be filed without.
   *
   * Both are looked up rather than assumed, and a missing either means no suggestion. An
   * institution that has not defined a behaviour category has not yet decided how it records
   * concerns about children, and a copilot inventing a category for it would be answering a
   * question the school has not asked itself.
   */
  private async referralContext(
    institutionId: string,
  ): Promise<{ categoryId: string; academicYearId: string } | null> {
    return this.db.runInTenant(async (tx) => {
      const [year] = await tx
        .select({ id: academicYears.id })
        .from(academicYears)
        .where(
          and(
            eq(academicYears.institutionId, institutionId),
            eq(academicYears.isCurrent, true),
            isNull(academicYears.archivedAt),
          ),
        )
        .limit(1);
      if (!year) return null;

      const [category] = await tx
        .select({ id: behaviourCategories.id })
        .from(behaviourCategories)
        .where(
          and(
            eq(behaviourCategories.institutionId, institutionId),
            eq(behaviourCategories.kind, 'negative'),
            isNull(behaviourCategories.archivedAt),
          ),
        )
        // The gentlest category the school has defined, and among equals the one it put first.
        // A referral must never land under "severe misconduct" because that happened to sort
        // first alphabetically.
        .orderBy(asc(behaviourCategories.defaultSeverity), asc(behaviourCategories.sortOrder))
        .limit(1);
      if (!category) return null;

      return { categoryId: category.id, academicYearId: year.id };
    });
  }
}

/** Same document, same chunk, once. A model given a citation twice will cite it twice. */
function dedupeCitations(citations: readonly AiToolCitation[]): AiToolCitation[] {
  const seen = new Set<string>();
  const out: AiToolCitation[] = [];
  for (const citation of citations) {
    const key = `${citation.documentId}:${citation.chunkId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(citation);
  }
  return out;
}
