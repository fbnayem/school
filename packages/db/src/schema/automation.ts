/**
 * Automation engine (Phase 26).
 *
 * The workflow engine (0014) carries *human* approval chains. This module carries
 * *rule-triggered* reactions — three consecutive absences, a fee fifteen days overdue, a
 * document about to lapse — and the relationship between the two is stated once, in
 * `docs/08_WORKFLOW_ENGINE.md` §5 and again here: **where a rule needs a human decision, the
 * rule creates a workflow request or a suggestion rather than acting.**
 *
 * Four tables and the properties the schema itself is responsible for:
 *
 *  1. **`automation_rules` cannot express an autonomous sensitive action.** The
 *     `automation_action_kind` enum contains no value that changes a grade, an attendance
 *     mark, an approval, a payment or a salary. The four values it does contain either speak
 *     to a person (`notify`), hand the decision to the approval engine
 *     (`create_workflow_request`), raise a suggestion a human accepts or dismisses
 *     (`flag_for_review`), or create one allow-listed non-sensitive record (`create_record`).
 *     A rule whose `action_config.targetResource` names a sensitive resource is additionally
 *     refused by a check constraint unless it sets `requires_human_confirmation` and uses one
 *     of the two human-in-the-loop actions — so the rule cannot even be *stored* in an
 *     autonomous shape.
 *  2. **`automation_events` is APPEND-ONLY**, like `audit_logs` (0005), `workflow_actions`
 *     (0014) and `messages` (0022). A trigger refuses DELETE outright and refuses every
 *     UPDATE except the single legal transition — stamping `processed_at` once, from null,
 *     with every other column unchanged. The same "one permitted transition" shape the
 *     posted-journal-entry guard uses in 0018.
 *  3. **The same event never acts twice.** `dedupe_key` is unique per institution, so a
 *     redelivered upstream event is refused by Postgres, not by a service convention.
 *  4. **Every evaluation leaves a row.** `automation_executions` records the outcome whether
 *     the rule acted, was suppressed by cooldown or duplication, is awaiting a human
 *     confirmation, or failed. A rule that throws is recorded `failed` and the remaining
 *     rules still run — the execution log is the evidence for both halves.
 *
 * `automation_executions.workflow_request_id` is a bare uuid with no foreign key, exactly as
 * `expense_claims.workflow_request_id` is: the workflow engine is an optional peer, and this
 * migration must keep applying whether or not it is installed.
 *
 * Deliberately absent: a scheduler. `cron_expression`, `timezone` and `trigger_kind =
 * 'schedule'` are carried from the first migration so adding one later is a deployment
 * concern rather than a migration, and the API exposes an explicit "which scheduled rules are
 * due" read instead of a background worker.
 */

import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
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
} from './_shared';
import { institutions, organizations } from './tenancy';

// ─────────────────────────────────────────────────────────────────────────────────────
// Enumerations. Every set is genuinely closed: adding a trigger kind, an action kind or an
// execution status changes the evaluator as well as the schema. The things a school invents
// for itself — the rules themselves, their thresholds, their message text — are rows and
// jsonb, never enum values.
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * What starts an evaluation.
 *
 *  - `event`     — an emitted `automation_events` row whose `event_name` matches.
 *  - `schedule`  — a cron expression, listed by the "due rules" endpoint and run by whatever
 *                  the deployment uses for scheduling. Nothing in this phase runs it itself.
 *  - `threshold` — a rule evaluated against queryable facts about one subject, driven by an
 *                  event that names the subject rather than by the event's payload alone.
 */
export const automationTriggerKindEnum = pgEnum('automation_trigger_kind', [
  'event',
  'schedule',
  'threshold',
]);

/**
 * What a rule is permitted to do. **This enum is the structural half of the
 * never-autonomously-sensitive rule** — there is no value here that changes a grade, an
 * attendance mark, an approval, a payment, a salary or a record's existence, and adding one
 * would be a migration a reviewer could not miss.
 *
 *  - `notify`                  — an in-app direct message to resolved recipients, one thread
 *                                per person, through the communication module's own
 *                                append-only message path. Never a broadcast.
 *  - `create_workflow_request` — hand the decision to the human approval engine.
 *  - `create_record`           — create one record of an allow-listed, non-sensitive kind.
 *                                Today that allow-list holds exactly one entry: a derived
 *                                `automation_events` row, which is how one rule feeds
 *                                another. Derived events may not themselves derive.
 *  - `flag_for_review`         — raise an `automation_suggestions` row. Changes nothing.
 */
export const automationActionKindEnum = pgEnum('automation_action_kind', [
  'notify',
  'create_workflow_request',
  'create_record',
  'flag_for_review',
]);

/**
 * The outcome of one rule against one trigger. `matched` is the dry-run outcome — the
 * conditions held and nothing was done because nothing was asked for.
 */
export const automationExecutionStatusEnum = pgEnum('automation_execution_status', [
  'matched',
  'suppressed_cooldown',
  'suppressed_duplicate',
  'acted',
  'failed',
  'awaiting_confirmation',
]);

export const automationSuggestionStatusEnum = pgEnum('automation_suggestion_status', [
  'pending',
  'accepted',
  'dismissed',
]);

// ─────────────────────────────────────────────────────────────────────────────────────
// Rules
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * One rule, versioned exactly like a workflow definition: editing an active rule inserts
 * `version + 1` and deactivates the previous row, so an execution can always be read back
 * against the text of the rule that produced it. `version` is therefore the rule's version
 * number, not an optimistic lock.
 *
 * `conditions` and `action_config` are jsonb because a rule is configuration, not code — but
 * neither is ever interpreted freely. Conditions are parsed into an allow-listed clause list
 * (a known field, a known operator, a literal value) and `action_config` is parsed by a Zod
 * schema discriminated on `action_kind`. Nothing in either column reaches an evaluator that
 * could execute it.
 */
export const automationRules = pgTable(
  'automation_rules',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    /** Stable machine key, e.g. `absence_three_consecutive`. Unique per version. */
    key: varchar('key', { length: 64 }).notNull(),
    nameEn: varchar('name_en', { length: 255 }).notNull(),
    nameBn: varchar('name_bn', { length: 255 }),
    description: varchar('description', { length: 2000 }),

    triggerKind: automationTriggerKindEnum('trigger_kind').notNull(),
    /** Required for `event` and `threshold` rules; must be null for `schedule` rules. */
    eventName: varchar('event_name', { length: 64 }),
    /** Required for `schedule` rules; must be null otherwise. Never executed by this module. */
    cronExpression: varchar('cron_expression', { length: 120 }),
    /** The zone the cron expression is read in. Bangladesh unless a school says otherwise. */
    timezone: varchar('timezone', { length: 64 }).notNull().default('Asia/Dhaka'),

    conditions: jsonb('conditions')
      .notNull()
      .default(sql`'{"match":"all","clauses":[]}'::jsonb`),

    actionKind: automationActionKindEnum('action_kind').notNull(),
    actionConfig: jsonb('action_config')
      .notNull()
      .default(sql`'{}'::jsonb`),

    /** Rules ship inactive. Turning one on is a separate, audited act. */
    isActive: boolean('is_active').notNull().default(false),
    /**
     * The rule may not act on its own: it raises a suggestion and stops. Forced on by check
     * constraint for any rule whose action targets a sensitive resource.
     */
    requiresHumanConfirmation: boolean('requires_human_confirmation').notNull().default(false),
    /**
     * Minimum minutes between two acted executions of this rule **for the same subject**, so
     * a guardian is not messaged five times in an hour. Zero means no cooldown.
     */
    cooldownMinutes: integer('cooldown_minutes').notNull().default(0),
    /** Seeded by the platform as a starting point; a school may still version it. */
    isSystem: boolean('is_system').notNull().default(false),

    /** The rule's version, not an optimistic lock — see the table comment. */
    version: integer('version').notNull().default(1),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('automation_rules_institution_key_version_key').on(
      table.institutionId,
      table.key,
      table.version,
    ),
    // At most one active version of a key at a time — the same pin the workflow engine uses.
    uniqueIndex('automation_rules_active_key')
      .on(table.institutionId, table.key)
      .where(sql`${table.isActive} AND ${table.archivedAt} IS NULL`),
    index('automation_rules_tenant_idx').on(table.tenantId),
    index('automation_rules_event_idx').on(table.institutionId, table.eventName),
    index('automation_rules_trigger_idx').on(
      table.institutionId,
      table.triggerKind,
      table.isActive,
    ),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * One thing that happened, recorded for rules to react to. **Append-only** — see the module
 * comment. `processed_at` is the single field the guard trigger lets an UPDATE stamp, once.
 *
 * `dedupe_key` is supplied by the emitter and unique per institution. It is what makes the
 * whole engine idempotent: an upstream that delivers the same absence twice gets a refusal
 * from Postgres, and the service turns that refusal into a recorded
 * `suppressed_duplicate` rather than a second round of messages.
 */
export const automationEvents = pgTable(
  'automation_events',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    eventName: varchar('event_name', { length: 64 }).notNull(),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    /** Which module raised it: 'attendance', 'fees', 'hr', 'exams', 'automation'. */
    sourceModule: varchar('source_module', { length: 32 }).notNull(),
    /** Stamped once, by the processing endpoint. The only UPDATE the database permits. */
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
    dedupeKey: varchar('dedupe_key', { length: 200 }).notNull(),
    ...timestampColumns(),
    // Present to satisfy the schema-wide conventions only; the append-only trigger refuses
    // the UPDATE that would ever set them, exactly as it does on `workflow_actions`.
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('automation_events_institution_dedupe_key').on(
      table.institutionId,
      table.dedupeKey,
    ),
    index('automation_events_tenant_idx').on(table.tenantId),
    index('automation_events_pending_idx')
      .on(table.institutionId, table.occurredAt)
      .where(sql`${table.processedAt} IS NULL`),
    index('automation_events_name_idx').on(table.institutionId, table.eventName, table.occurredAt),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Executions
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * One rule, evaluated once. Written for every outcome, including the ones where nothing
 * happened — a suppressed message is exactly the thing an operator later asks about.
 *
 * `subject_kind`/`subject_id` carry what the rule was about (a student, an invoice, an
 * employee document). They are what makes the cooldown per-subject rather than per-rule,
 * which is the difference between "do not spam this guardian" and "do not run this rule".
 */
export const automationExecutions = pgTable(
  'automation_executions',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => automationRules.id, { onDelete: 'restrict' }),
    eventId: uuid('event_id').references(() => automationEvents.id, { onDelete: 'restrict' }),
    matchedAt: timestamp('matched_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    status: automationExecutionStatusEnum('status').notNull(),
    subjectKind: varchar('subject_kind', { length: 32 }),
    subjectId: uuid('subject_id'),
    /** What the action produced: message thread ids, a workflow request id, a suggestion id. */
    actionResult: jsonb('action_result')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Operator-facing failure detail. Never a stack trace, never a secret. */
    error: varchar('error', { length: 1000 }),
    /** No foreign key: the workflow engine is an optional peer. See the module comment. */
    workflowRequestId: uuid('workflow_request_id'),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('automation_executions_tenant_idx').on(table.tenantId),
    index('automation_executions_rule_idx').on(table.ruleId, table.matchedAt),
    index('automation_executions_event_idx').on(table.eventId),
    index('automation_executions_institution_status_idx').on(
      table.institutionId,
      table.status,
      table.matchedAt,
    ),
    // Drives the cooldown lookup, which is the hottest read on this table.
    index('automation_executions_cooldown_idx').on(
      table.ruleId,
      table.subjectKind,
      table.subjectId,
      table.matchedAt,
    ),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Suggestions
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Something a rule noticed and a human decides about. This is the whole of what an
 * automation rule is allowed to do about a sensitive resource: describe it, evidence it, and
 * wait.
 *
 * One suggestion per execution (`automation_suggestions_execution_key`), so reprocessing a
 * partially-failed batch cannot produce a second copy of the same advice.
 */
export const automationSuggestions = pgTable(
  'automation_suggestions',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => automationRules.id, { onDelete: 'restrict' }),
    executionId: uuid('execution_id')
      .notNull()
      .references(() => automationExecutions.id, { onDelete: 'restrict' }),
    /** 'student', 'invoice', 'employee_document', 'exam_mark', … */
    subjectKind: varchar('subject_kind', { length: 32 }).notNull(),
    subjectId: uuid('subject_id').notNull(),
    summary: varchar('summary', { length: 500 }).notNull(),
    /** The facts and payload fields the rule matched on, so the reviewer can check it. */
    evidence: jsonb('evidence')
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: automationSuggestionStatusEnum('status').notNull().default('pending'),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    decisionNote: varchar('decision_note', { length: 1000 }),
    version: integer('version').notNull().default(1),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('automation_suggestions_execution_key').on(table.executionId),
    index('automation_suggestions_tenant_idx').on(table.tenantId),
    index('automation_suggestions_institution_status_idx').on(
      table.institutionId,
      table.status,
      table.createdAt,
    ),
    index('automation_suggestions_rule_idx').on(table.ruleId),
    index('automation_suggestions_subject_idx').on(table.subjectKind, table.subjectId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────

export const automationRulesRelations = relations(automationRules, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [automationRules.institutionId],
    references: [institutions.id],
  }),
  executions: many(automationExecutions),
  suggestions: many(automationSuggestions),
}));

export const automationEventsRelations = relations(automationEvents, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [automationEvents.institutionId],
    references: [institutions.id],
  }),
  executions: many(automationExecutions),
}));

export const automationExecutionsRelations = relations(automationExecutions, ({ one, many }) => ({
  rule: one(automationRules, {
    fields: [automationExecutions.ruleId],
    references: [automationRules.id],
  }),
  event: one(automationEvents, {
    fields: [automationExecutions.eventId],
    references: [automationEvents.id],
  }),
  suggestions: many(automationSuggestions),
}));

export const automationSuggestionsRelations = relations(automationSuggestions, ({ one }) => ({
  rule: one(automationRules, {
    fields: [automationSuggestions.ruleId],
    references: [automationRules.id],
  }),
  execution: one(automationExecutions, {
    fields: [automationSuggestions.executionId],
    references: [automationExecutions.id],
  }),
}));
