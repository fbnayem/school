/**
 * AI foundation (Phases 27–28) — conversations, the message log, usage metering and budgets.
 *
 * The shape here is the same one the accounting journal (0018) and the stock ledger (0025)
 * use, for the same reasons:
 *
 *  1. **`ai_messages` is append-only.** A transcript is the evidence of what an AI was asked
 *     and what it answered. A trigger refuses UPDATE and DELETE for every role except the
 *     migrator, so the record of an AI-influenced decision survives the argument about it.
 *  2. **`ai_usage_events` is append-only** and is the cost ledger. A mis-metered call is
 *     corrected by a compensating event carrying negative tokens and a negative cost — never
 *     by an edit — which is why those columns are signed.
 *  3. **`ai_budgets.tokensUsed` / `costUsed` are derived**, maintained by a trigger on
 *     `ai_usage_events` and refused to every other writer. The *limits* on the same row are
 *     ordinary settings: the administrator sets the budget, the database keeps the tally.
 *     `ai_budgets_usage_non_negative` means a credit can never take the tally below zero.
 *  4. **Cost is `numeric(14, 4)` — four decimals.** Inference is priced in fractions of a
 *     cent, and a single copilot turn frequently costs less than one minor currency unit.
 *     Rounding per call would round the month's bill to nothing. The exact figure lives at
 *     four decimals; `Money` is used only where a number is *presented* as currency
 *     (ADR-004: no floating point on either side of that line).
 *
 * `ai_conversations.subjectType` / `subjectId` and `ai_usage_events.userId` are deliberately
 * soft references with no foreign key: a conversation can be about a row in any module, and
 * the cost ledger outlives the user it attributes spend to.
 *
 * Nothing in this file stores a credential. Provider API keys live in the deployment
 * environment and have no column anywhere in this database; `ai_provider_settings` records
 * only which provider *key* answers which task.
 */

import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  actorColumns,
  archiveColumns,
  primaryKeyColumn,
  timestampColumns,
  versionColumn,
} from './_shared';
import { institutions, organizations } from './tenancy';
import { users } from './identity';

// ─────────────────────────────────────────────────────────────────────────────────────
// Enumerations. Every set is genuinely closed: adding a purpose, a task or a finish reason
// changes routing and permission code as well as the schema. What a school configures for
// itself — provider, budget, whether tutoring is on — is a column, not an enum value.
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * What a conversation is for. This is an audience boundary, not a label: `tutor` is
 * student-facing and `insights` is principal-facing, and they carry different permissions.
 */
export const aiConversationPurposeEnum = pgEnum('ai_conversation_purpose', [
  'copilot',
  'tutor',
  'teacher_tools',
  'insights',
  'knowledge_search',
]);

/** Mirrors the provider wire format. `tool` is a tool result being fed back to the model. */
export const aiMessageRoleEnum = pgEnum('ai_message_role', [
  'system',
  'user',
  'assistant',
  'tool',
]);

/**
 * The routing dimension (docs/06 §4): cheap classification to a small model, document
 * understanding to a vision model, analytics reasoning to a capable one, tutoring to an
 * education-safe configuration. `embedding` is a task so retrieval's provider calls land in
 * the same usage ledger as everything else.
 */
export const aiTaskEnum = pgEnum('ai_task', [
  'classification',
  'summarisation',
  'analytics_reasoning',
  'tutoring',
  'document_understanding',
  'embedding',
]);

/**
 * Why generation stopped. Recorded rather than discarded: an answer truncated at the token
 * ceiling and an answer refused by a safety filter look identical in a transcript and mean
 * entirely different things.
 */
export const aiFinishReasonEnum = pgEnum('ai_finish_reason', [
  'stop',
  'length',
  'tool_calls',
  'content_filter',
]);

// ─────────────────────────────────────────────────────────────────────────────────────
// Conversations and their messages
// ─────────────────────────────────────────────────────────────────────────────────────

export const aiConversations = pgTable(
  'ai_conversations',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    title: varchar('title', { length: 200 }).notNull(),
    purpose: aiConversationPurposeEnum('purpose').notNull(),
    /**
     * The owner. Read access defaults to this user alone; only `ai.settings.manage` widens
     * it, and the service enforces that on the data rather than trusting the route.
     */
    startedByUserId: uuid('started_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Soft reference — 'student', 'invoice', 'section', … See the file header. */
    subjectType: varchar('subject_type', { length: 64 }),
    subjectId: uuid('subject_id'),
    /**
     * A cache of `max(ai_messages.created_at)` for the list view's ordering, written in the
     * same transaction as the message it describes. Nothing reads it as an authority.
     */
    lastMessageAt: timestamp('last_message_at', { withTimezone: true, mode: 'date' }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('ai_conversations_tenant_idx').on(table.tenantId),
    index('ai_conversations_institution_activity_idx').on(
      table.institutionId,
      table.lastMessageAt,
    ),
    index('ai_conversations_owner_idx').on(table.institutionId, table.startedByUserId),
    index('ai_conversations_purpose_idx').on(table.institutionId, table.purpose),
    index('ai_conversations_subject_idx').on(table.subjectType, table.subjectId),
  ],
);

/**
 * One turn. APPEND-ONLY — `ai_messages_no_mutation` refuses UPDATE and DELETE. The archive
 * columns exist to satisfy the schema convention and are unusable by construction, which is
 * the point: a message is a historical fact.
 *
 * `seq` exists because ordering by `createdAt` alone is not enough — a prompt and its answer
 * are written microseconds apart inside one transaction and can share a timestamp, and a
 * transcript whose order depends on a tie-break is not a transcript.
 */
export const aiMessages = pgTable(
  'ai_messages',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => aiConversations.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    role: aiMessageRoleEnum('role').notNull(),
    content: text('content').notNull(),
    /** Present only on a `tool` message: which invocation it answers. */
    toolCallId: varchar('tool_call_id', { length: 128 }),
    /** Null on a user message — no provider was involved in producing it. */
    providerKey: varchar('provider_key', { length: 32 }),
    model: varchar('model', { length: 128 }),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    finishReason: aiFinishReasonEnum('finish_reason'),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('ai_messages_conversation_seq_key').on(table.conversationId, table.seq),
    index('ai_messages_tenant_idx').on(table.tenantId),
    index('ai_messages_conversation_idx').on(table.conversationId, table.seq),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Metering: the append-only usage ledger and the derived monthly budget
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Every provider call, whatever made it. APPEND-ONLY, and the source of truth for cost.
 *
 * `conversationId` is nullable because retrieval ingestion embeds documents with no
 * conversation behind it, and that spend must still be metered.
 *
 * Token counts and cost are SIGNED: because this table admits no UPDATE, the only honest
 * correction for a double-counted retry or a vendor credit is a compensating event, exactly
 * as a wrong journal entry is corrected by a reversing one.
 */
export const aiUsageEvents = pgTable(
  'ai_usage_events',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    /**
     * `set null` on delete, not `cascade`: a purged conversation loses its link to the spend
     * it caused, but the spend itself stays on the ledger.
     */
    conversationId: uuid('conversation_id').references(() => aiConversations.id, {
      onDelete: 'set null',
    }),
    task: aiTaskEnum('task').notNull(),
    providerKey: varchar('provider_key', { length: 32 }).notNull(),
    model: varchar('model', { length: 128 }).notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    /** Four decimals. Two would round almost every individual call to zero. */
    cost: numeric('cost', { precision: 14, scale: 4 }).notNull().default('0.0000'),
    currency: char('currency', { length: 3 }).notNull().default('USD'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    /** Soft reference: the ledger outlives the user row it attributes spend to. */
    userId: uuid('user_id'),
    purpose: aiConversationPurposeEnum('purpose'),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('ai_usage_events_tenant_idx').on(table.tenantId),
    index('ai_usage_events_institution_occurred_idx').on(table.institutionId, table.occurredAt),
    index('ai_usage_events_user_idx').on(table.institutionId, table.userId, table.occurredAt),
    index('ai_usage_events_task_idx').on(table.institutionId, table.task),
    index('ai_usage_events_conversation_idx').on(table.conversationId),
  ],
);

/**
 * One institution's budget for one calendar month (`yearMonth` is `YYYY-MM` in Asia/Dhaka —
 * the calendar a Bangladeshi school budgets against, and the one the trigger derives).
 *
 * `tokenLimit` / `costLimit` are the administrator's settings; null means "no limit of this
 * kind". `tokensUsed` / `costUsed` are DERIVED and refused to every writer but the trigger.
 * `hardStop` decides what happens at the ceiling: true refuses the call before it is made
 * (docs/06 §8 — "the budget is enforced before the call rather than reported after it"),
 * false records the overage and warns.
 *
 * The unique index is TOTAL rather than partial-on-archive because it is the ON CONFLICT
 * arbiter of the derived trigger: a second archived row for the same month would silently
 * split the tally in two.
 *
 * `tokensUsed` is read as a `number`. A month would need ~9 × 10^15 tokens to reach the safe
 * integer ceiling, which is several orders of magnitude beyond any school's entire history.
 */
export const aiBudgets = pgTable(
  'ai_budgets',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    yearMonth: char('year_month', { length: 7 }).notNull(),
    tokenLimit: bigint('token_limit', { mode: 'number' }),
    costLimit: numeric('cost_limit', { precision: 14, scale: 4 }),
    tokensUsed: bigint('tokens_used', { mode: 'number' }).notNull().default(0),
    costUsed: numeric('cost_used', { precision: 14, scale: 4 }).notNull().default('0.0000'),
    hardStop: boolean('hard_stop').notNull().default(true),
    currency: char('currency', { length: 3 }).notNull().default('USD'),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('ai_budgets_institution_month_key').on(table.institutionId, table.yearMonth),
    index('ai_budgets_tenant_idx').on(table.tenantId),
  ],
);

/**
 * One row per institution: which provider answers which task, and the defaults applied to a
 * month nobody has explicitly budgeted.
 *
 * `taskRouting` is jsonb rather than a column per task so that adding a task to `ai_task`
 * does not also require a migration here; the application validates its shape against the
 * same Zod schema the HTTP API uses.
 *
 * `defaultProvider` is a provider *key*. There is no credential column, here or anywhere.
 */
export const aiProviderSettings = pgTable(
  'ai_provider_settings',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    defaultProvider: varchar('default_provider', { length: 32 }).notNull().default('mock'),
    taskRouting: jsonb('task_routing')
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    defaultMonthlyTokenLimit: bigint('default_monthly_token_limit', { mode: 'number' }),
    defaultMonthlyCostLimit: numeric('default_monthly_cost_limit', { precision: 14, scale: 4 }),
    defaultHardStop: boolean('default_hard_stop').notNull().default(true),
    /**
     * Off by default. Turning AI tutoring on for children is a decision a school makes
     * deliberately, not one it discovers has already been made for it.
     */
    tutoringEnabledForStudents: boolean('tutoring_enabled_for_students').notNull().default(false),
    currency: char('currency', { length: 3 }).notNull().default('USD'),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('ai_provider_settings_institution_key').on(table.institutionId),
    index('ai_provider_settings_tenant_idx').on(table.tenantId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Relations
// ─────────────────────────────────────────────────────────────────────────────────────

export const aiConversationsRelations = relations(aiConversations, ({ one, many }) => ({
  tenant: one(organizations, {
    fields: [aiConversations.tenantId],
    references: [organizations.id],
  }),
  institution: one(institutions, {
    fields: [aiConversations.institutionId],
    references: [institutions.id],
  }),
  startedBy: one(users, {
    fields: [aiConversations.startedByUserId],
    references: [users.id],
  }),
  messages: many(aiMessages),
  usageEvents: many(aiUsageEvents),
}));

export const aiMessagesRelations = relations(aiMessages, ({ one }) => ({
  conversation: one(aiConversations, {
    fields: [aiMessages.conversationId],
    references: [aiConversations.id],
  }),
}));

export const aiUsageEventsRelations = relations(aiUsageEvents, ({ one }) => ({
  conversation: one(aiConversations, {
    fields: [aiUsageEvents.conversationId],
    references: [aiConversations.id],
  }),
  institution: one(institutions, {
    fields: [aiUsageEvents.institutionId],
    references: [institutions.id],
  }),
}));

export const aiBudgetsRelations = relations(aiBudgets, ({ one }) => ({
  institution: one(institutions, {
    fields: [aiBudgets.institutionId],
    references: [institutions.id],
  }),
}));

export const aiProviderSettingsRelations = relations(aiProviderSettings, ({ one }) => ({
  institution: one(institutions, {
    fields: [aiProviderSettings.institutionId],
    references: [institutions.id],
  }),
}));
