/**
 * AI foundation schemas (Phases 27–28).
 *
 * Four rules shape every schema in this file:
 *
 *  - **Cost crosses the wire as a four-decimal string**, mirroring the `numeric(14, 4)`
 *    columns. Inference is priced in fractions of a cent; two decimals would round almost
 *    every call to zero, and a float would be wrong in a different way (ADR-004).
 *  - **A client never states a derived fact.** There is no `tokensUsed` or `costUsed` on a
 *    budget, no `seq`, `inputTokens`, `outputTokens`, `model` or `providerKey` on a message,
 *    and no `cost` anywhere on an input. The tally is derived by the database from the usage
 *    ledger; the token counts come from the provider's own response.
 *  - **A client never supplies a credential.** `putAiSettingsSchema` accepts provider *keys*
 *    only. There is no field anywhere in this file through which an API key could be sent,
 *    which is what makes "keys live in the environment" true rather than aspirational.
 *  - **Decisions carry reasons.** Archiving a conversation requires one, because the
 *    transcript it removes from view is evidence.
 *
 * Constants carry an `AI_` prefix because `@shikkha/validation` re-exports flat.
 */

import { z } from 'zod';
import { paginationSchema, reasonSchema, searchSchema, sortSchema, uuidSchema } from './common';

// ── Value sets, mirrored from the database enums ─────────────────────────────────────

export const AI_CONVERSATION_PURPOSES = [
  'copilot',
  'tutor',
  'teacher_tools',
  'insights',
  'knowledge_search',
] as const;

export const AI_MESSAGE_ROLES = ['system', 'user', 'assistant', 'tool'] as const;

export const AI_TASKS = [
  'classification',
  'summarisation',
  'analytics_reasoning',
  'tutoring',
  'document_understanding',
  'embedding',
] as const;

export const AI_FINISH_REASONS = ['stop', 'length', 'tool_calls', 'content_filter'] as const;

/**
 * The adapters that exist. `mock` is a real, credential-free adapter — deterministic output
 * for development, demos and tests — not a stub that pretends to have called something.
 */
export const AI_PROVIDER_KEYS = ['mock', 'openai', 'anthropic', 'gemini'] as const;

// ── Sort allow-lists, consumed by parseSort ──────────────────────────────────────────

export const AI_CONVERSATION_SORT_FIELDS = [
  'title',
  'purpose',
  'lastMessageAt',
  'createdAt',
] as const;

// ── Primitives ───────────────────────────────────────────────────────────────────────

/** A budget period: `YYYY-MM`, in the Asia/Dhaka calendar the database derives. */
export const aiYearMonthSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use the format YYYY-MM, for example 2026-08');

/**
 * A non-negative cost with at most four decimal places, e.g. "12.5000".
 *
 * Four, not two: see the file header. `positiveMoneySchema` in `common` is the two-decimal
 * schema for settlement currency and is deliberately not reused here — a budget ceiling of
 * "0.0345" is a legitimate figure that it would reject.
 */
export const aiCostSchema = z
  .string()
  .trim()
  .regex(/^\d{1,10}(\.\d{1,4})?$/, 'Enter an amount with at most four decimal places');

/** A three-letter ISO 4217 code. Uppercased on parse so nothing downstream has to. */
export const aiCurrencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'Use a three-letter currency code, for example USD');

const aiTokenLimitSchema = z.coerce
  .number()
  .int('A token limit is a whole number of tokens')
  .min(0)
  // Well below Number.MAX_SAFE_INTEGER so the derived tally can never be read imprecisely.
  .max(1_000_000_000_000);

// ── Conversations ────────────────────────────────────────────────────────────────────

/**
 * `subjectType` and `subjectId` are all-or-nothing: half a soft reference is a conversation
 * nobody can attribute later, and the database restates the same rule.
 */
const subjectRefinement = <T extends { subjectType?: string; subjectId?: string }>(
  value: T,
  ctx: z.RefinementCtx,
): void => {
  const hasType = value.subjectType !== undefined;
  const hasId = value.subjectId !== undefined;
  if (hasType !== hasId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [hasType ? 'subjectId' : 'subjectType'],
      message: 'Give both the subject type and the subject id, or neither',
    });
  }
};

export const createAiConversationSchema = z
  .object({
    title: z.string().trim().min(1, 'Give the conversation a title').max(200),
    purpose: z.enum(AI_CONVERSATION_PURPOSES),
    /** What the conversation is about — 'student', 'invoice', 'section', … */
    subjectType: z.string().trim().min(1).max(64).optional(),
    subjectId: uuidSchema.optional(),
    /**
     * An optional opening message, so the common case is one round trip. It is a *user*
     * message: a client cannot seed an assistant turn, which would put words the model never
     * produced into a transcript that is evidence.
     */
    firstMessage: z.string().trim().min(1).max(20_000).optional(),
  })
  .superRefine(subjectRefinement);

export const listAiConversationsSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    purpose: z.enum(AI_CONVERSATION_PURPOSES).optional(),
    subjectType: z.string().trim().min(1).max(64).optional(),
    subjectId: uuidSchema.optional(),
    /**
     * Only honoured for a caller who holds `ai.settings.manage`; for anyone else the service
     * pins the owner to the caller regardless of what is sent here. Fail closed on the data,
     * never on the parameter.
     */
    startedByUserId: uuidSchema.optional(),
    includeArchived: z.coerce.boolean().default(false),
  });

/**
 * Append a user turn and get the assistant's answer.
 *
 * `content` only. There is no field for the model, the provider, a system prompt or a token
 * ceiling above the deployment's: a client that could choose its own system prompt could
 * choose to disable the safety framing, and one that could raise the token ceiling could
 * spend the school's budget a hundred times faster than the budget expects.
 */
export const appendAiMessageSchema = z.object({
  content: z.string().trim().min(1, 'Write a message').max(20_000),
});

export const archiveAiConversationSchema = z.object({ reason: reasonSchema });

// ── Usage and budgets ────────────────────────────────────────────────────────────────

export const AI_USAGE_GROUPINGS = ['month', 'user', 'task'] as const;

export const listAiUsageSchema = z.object({
  /** Inclusive bounds on the budget period, so a year is `from=2026-01&to=2026-12`. */
  from: aiYearMonthSchema.optional(),
  to: aiYearMonthSchema.optional(),
  groupBy: z.enum(AI_USAGE_GROUPINGS).default('month'),
  task: z.enum(AI_TASKS).optional(),
  userId: uuidSchema.optional(),
});

export const listAiBudgetsSchema = z.object({
  from: aiYearMonthSchema.optional(),
  to: aiYearMonthSchema.optional(),
});

export const aiYearMonthParamSchema = z.object({ yearMonth: aiYearMonthSchema });

/**
 * Set one month's budget. Limits only — the tally is the database's business.
 *
 * `null` clears a limit ("no ceiling of this kind"), which is a different state from a limit
 * of zero ("no spend allowed"), and the two must stay distinguishable.
 */
export const putAiBudgetSchema = z.object({
  tokenLimit: aiTokenLimitSchema.nullable().optional(),
  costLimit: aiCostSchema.nullable().optional(),
  /**
   * True refuses the call before it is made; false records the overage and warns. Defaults
   * to true, because a school on a fixed subscription cannot be exposed to an unbounded
   * inference bill (docs/06 §8).
   */
  hardStop: z.coerce.boolean().default(true),
  currency: aiCurrencySchema.optional(),
});

// ── Provider settings ────────────────────────────────────────────────────────────────

/**
 * Per-task routing overrides, e.g. `{ "classification": "openai", "tutoring": "anthropic" }`.
 *
 * Only known task names and only known provider keys — a typo would otherwise fall through
 * to the deployment default and be invisible until someone audited the bill.
 */
export const aiTaskRoutingSchema = z
  .record(z.enum(AI_TASKS), z.enum(AI_PROVIDER_KEYS))
  .default({});

export const putAiSettingsSchema = z.object({
  defaultProvider: z.enum(AI_PROVIDER_KEYS),
  taskRouting: aiTaskRoutingSchema,
  defaultMonthlyTokenLimit: aiTokenLimitSchema.nullable().optional(),
  defaultMonthlyCostLimit: aiCostSchema.nullable().optional(),
  defaultHardStop: z.coerce.boolean().default(true),
  /**
   * Whether students may use the AI tutor at all. Defaults to false: turning an AI loose on
   * children is a decision a school makes deliberately, not one it discovers has already
   * been made for it.
   */
  tutoringEnabledForStudents: z.coerce.boolean().default(false),
  currency: aiCurrencySchema.optional(),
});

// ── Inferred types, for services and controllers ─────────────────────────────────────

export type AiConversationPurpose = (typeof AI_CONVERSATION_PURPOSES)[number];
export type AiMessageRole = (typeof AI_MESSAGE_ROLES)[number];
export type AiTaskName = (typeof AI_TASKS)[number];
export type AiFinishReasonName = (typeof AI_FINISH_REASONS)[number];
export type AiProviderKey = (typeof AI_PROVIDER_KEYS)[number];
export type AiUsageGrouping = (typeof AI_USAGE_GROUPINGS)[number];

export type CreateAiConversationInput = z.infer<typeof createAiConversationSchema>;
export type ListAiConversationsInput = z.infer<typeof listAiConversationsSchema>;
export type AppendAiMessageInput = z.infer<typeof appendAiMessageSchema>;
export type ArchiveAiConversationInput = z.infer<typeof archiveAiConversationSchema>;
export type ListAiUsageInput = z.infer<typeof listAiUsageSchema>;
export type ListAiBudgetsInput = z.infer<typeof listAiBudgetsSchema>;
export type PutAiBudgetInput = z.infer<typeof putAiBudgetSchema>;
export type PutAiSettingsInput = z.infer<typeof putAiSettingsSchema>;
export type AiTaskRouting = z.infer<typeof aiTaskRoutingSchema>;
