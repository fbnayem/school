/**
 * AI suggestions (Phase 33) — the row that makes docs/06 §6 structural.
 *
 * §6 lists what an AI must never do on its own: change grades or attendance, approve
 * admissions, determine punishment, issue refunds, change salary, run payroll, create
 * accounting entries, delete records, send sensitive mass communications. For all of them the
 * rule is one sentence — *AI suggests → human reviews → human confirms → system executes* —
 * and this table is what turns that sentence into a mechanism.
 *
 * A copilot's output is a ROW WITH A STATUS. It is not a mutation, and it is not a queued job
 * that some later process replays. Nothing happens until a person with the permission of the
 * **action** (not of the copilot) accepts it, and the accept path then runs the owning
 * module's own service, so that module's validation, its permissions and its audit row all
 * still apply.
 *
 * Four properties live in migration 0034 rather than in a service, because each is one the
 * application can get wrong exactly once and never notice:
 *
 *  1. **The content is frozen at insert.** `ai_suggestions_content_immutable` refuses any
 *     UPDATE touching the title, body, evidence, proposed action, confidence, subject or
 *     required permission. A person who accepts is accepting what they *read*; a body that
 *     could change between the render and the click makes the audit trail confidently wrong.
 *  2. **Evidence is a non-empty array whose entries name their source.** docs/06 §7: a bare
 *     score cannot be argued with, and a teacher who cannot argue with it will either follow
 *     it blindly or ignore it. A suggestion carrying no checkable reason is unrepresentable.
 *  3. **Confidence is a band, never a percentage.** A model cannot calibrate a probability;
 *     `84%` out of one has the shape of evidence and none of the substance, and it survives
 *     every retelling as if it had been measured.
 *  4. **A decided suggestion never returns to pending**, and `accepted` / `dismissed` are
 *     terminal — a transition rule, so it is a trigger rather than a CHECK.
 *
 * `subjectType` / `subjectId` are a soft reference for the same reason
 * `aiConversations.subjectType` is: a suggestion can be about a student, an invoice, an
 * application, a section or an expense claim, and a real foreign key would need one nullable
 * column per module and would stop the subject from ever being archived.
 */

import { relations } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  actorColumns,
  archiveColumns,
  primaryKeyColumn,
  timestampColumns,
  versionColumn,
} from './_shared';
import { institutions, organizations } from './tenancy';
import { users } from './identity';
import { aiConversations } from './ai';

// ─────────────────────────────────────────────────────────────────────────────────────
// Enumerations
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * What is being suggested.
 *
 * Every value names an action that already has an owner elsewhere in the system, because the
 * accept path executes through that owner's service. There is deliberately no `grade_change`,
 * no `attendance_correction`, no `refund` and no `payroll_run`: docs/06 §6 forbids the AI from
 * proposing those as an executable payload at all, and a kind with no executable action is a
 * kind that should not exist.
 */
export const aiSuggestionKindEnum = pgEnum('ai_suggestion_kind', [
  'attendance_follow_up',
  'fee_reminder_draft',
  'admission_shortlist_note',
  'timetable_gap_fill',
  'communication_draft',
  'expense_flag',
  'intervention_referral',
]);

/**
 * Where a suggestion is in its life.
 *
 * `expired` is reached by the passage of time and `superseded` by a fresher suggestion about
 * the same subject. Neither names a decider — nobody decided, time did — which is why the
 * decision CHECK treats them differently from `accepted` and `dismissed`.
 */
export const aiSuggestionStatusEnum = pgEnum('ai_suggestion_status', [
  'pending',
  'accepted',
  'dismissed',
  'expired',
  'superseded',
]);

/**
 * How sure the suggestion is — a band, never a number.
 *
 * Computed by the application from how much evidence there is and how far the observation sits
 * from the threshold, never asked of the model. A model asked for its own confidence reports
 * its fluency, and fluency is uncorrelated with whether the attendance register says what the
 * model thinks it says.
 */
export const aiConfidenceBandEnum = pgEnum('ai_confidence_band', ['low', 'medium', 'high']);

/** Which copilot produced it. Each surface has its own permission and its own tool set. */
export const aiCopilotSurfaceEnum = pgEnum('ai_copilot_surface', [
  'principal_insights',
  'teacher_tools',
  'accounts',
  'admissions',
]);

/**
 * Whether the accepted action actually happened.
 *
 * Separate from `status` because "a human agreed" and "the owning module carried it out" are
 * different facts. Collapsing them would hide the case that matters most: a suggestion a
 * person accepted whose action the owning module then refused — the student had transferred
 * out, the claim had already been paid — which somebody now has to finish by hand.
 */
export const aiSuggestionExecutionEnum = pgEnum('ai_suggestion_execution', [
  'not_started',
  'executed',
  'failed',
]);

// ─────────────────────────────────────────────────────────────────────────────────────
// The table
// ─────────────────────────────────────────────────────────────────────────────────────

export const aiSuggestions = pgTable(
  'ai_suggestions',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),

    kind: aiSuggestionKindEnum('kind').notNull(),
    status: aiSuggestionStatusEnum('status').notNull().default('pending'),
    surface: aiCopilotSurfaceEnum('surface').notNull(),

    /** Soft reference to whatever the suggestion is about. See the file header. */
    subjectType: varchar('subject_type', { length: 64 }).notNull(),
    subjectId: uuid('subject_id').notNull(),

    /**
     * The person the suggestion is about, when it is about a person at all.
     *
     * Recorded so the accept path can refuse a self-decision *before* the action is attempted:
     * the member of staff whose expense claim was flagged must not be the one who accepts the
     * flag. The owning modules enforce their own versions of this rule too — accounting's
     * `decideExpenseClaim` already refuses the filer — but this column makes the refusal
     * uniform across every kind rather than dependent on whether a given module thought of it.
     */
    aboutUserId: uuid('about_user_id').references(() => users.id, { onDelete: 'restrict' }),

    /**
     * The suggestion itself, in English and — where the copilot could produce it — Bangla.
     *
     * A null Bangla field is an honest "no Bangla version"; the CHECK refuses an empty string,
     * because a blank card in front of a Bangla reader on a row that claims to be bilingual is
     * worse than a row that admits it is not.
     */
    titleEn: varchar('title_en', { length: 200 }).notNull(),
    titleBn: varchar('title_bn', { length: 200 }),
    bodyEn: text('body_en').notNull(),
    bodyBn: text('body_bn'),

    /**
     * The FACTS the suggestion rests on, each with the tool call that produced it:
     * `[{ source, statement, arguments?, observed?, recordedAt? }]`.
     *
     * Structured rather than prose so the UI can render "because …" as a list and a human can
     * check each line independently — `source` names the tool, so verifying a line is one
     * click rather than an act of faith. The database refuses an empty array and refuses an
     * entry that does not name its source (0034,
     * `ai_suggestion_evidence_is_wellformed`).
     */
    evidence: jsonb('evidence').notNull(),

    confidence: aiConfidenceBandEnum('confidence').notNull(),

    /**
     * The exact, validated payload the owning module's endpoint would receive if a human
     * accepts, and nothing else:
     * `{ module, action, resourceId?, payload: { … } }`.
     *
     * No prose, no second copy of the reasoning. The accept path re-validates `payload`
     * against that module's own Zod schema and hands it to that module's own service.
     */
    proposedAction: jsonb('proposed_action').notNull(),

    /**
     * The permission accepting requires — the permission of the ACTION, not of the copilot.
     *
     * Stored at generation time and re-derived from the kind at accept time; the two must
     * agree or the accept is refused. Two independent statements of one rule, because the
     * failure mode of a single statement is a suggestion generated under an old mapping being
     * accepted under a new one with nobody noticing the permission moved.
     */
    actionPermission: varchar('action_permission', { length: 120 }).notNull(),

    /** Provenance. Nullable conversation: the suggestion outlives the transcript. */
    generatedByConversationId: uuid('generated_by_conversation_id').references(
      () => aiConversations.id,
      { onDelete: 'set null' },
    ),
    model: varchar('model', { length: 128 }),
    providerKey: varchar('provider_key', { length: 32 }),

    /**
     * The instant past which this must not be acted on. NOT NULL, with no sentinel meaning
     * "never".
     *
     * A suggestion rests on facts that were true when it was generated — an outstanding
     * balance, an attendance percentage, a vacant period next Tuesday — and those move.
     * Accepting a two-month-old fee reminder sends a parent a figure the ledger stopped
     * agreeing with in April, and in that argument the parent is right.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),

    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    decisionReason: varchar('decision_reason', { length: 500 }),

    executionState: aiSuggestionExecutionEnum('execution_state').notNull().default('not_started'),
    executedAt: timestamp('executed_at', { withTimezone: true, mode: 'date' }),
    /** What the owning module created, so the trail leads from the suggestion to the record. */
    executedResourceType: varchar('executed_resource_type', { length: 64 }),
    executedResourceId: uuid('executed_resource_id'),
    executionError: varchar('execution_error', { length: 1000 }),

    supersededById: uuid('superseded_by_id').references((): AnyPgColumn => aiSuggestions.id, {
      onDelete: 'set null',
    }),

    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('ai_suggestions_tenant_idx').on(table.tenantId),
    index('ai_suggestions_institution_status_idx').on(
      table.institutionId,
      table.status,
      table.createdAt,
    ),
    index('ai_suggestions_subject_idx').on(table.institutionId, table.subjectType, table.subjectId),
    index('ai_suggestions_kind_idx').on(table.institutionId, table.kind, table.status),
    index('ai_suggestions_conversation_idx').on(table.generatedByConversationId),
    index('ai_suggestions_pending_expiry_idx')
      .on(table.institutionId, table.expiresAt)
      .where(sql`status = 'pending'`),
    /**
     * At most one PENDING suggestion per (kind, subject).
     *
     * Partial rather than total, because the history matters: a fee reminder dismissed in
     * March and a fresh one in April are two events and both belong in the record. What must
     * not happen is a copilot asked the same question three times leaving three identical
     * undecided rows about one child for a teacher to decide three times.
     */
    uniqueIndex('ai_suggestions_pending_subject_key')
      .on(table.institutionId, table.kind, table.subjectType, table.subjectId)
      .where(sql`status = 'pending'`),
  ],
);

export const aiSuggestionsRelations = relations(aiSuggestions, ({ one }) => ({
  tenant: one(organizations, {
    fields: [aiSuggestions.tenantId],
    references: [organizations.id],
  }),
  institution: one(institutions, {
    fields: [aiSuggestions.institutionId],
    references: [institutions.id],
  }),
  conversation: one(aiConversations, {
    fields: [aiSuggestions.generatedByConversationId],
    references: [aiConversations.id],
  }),
  decidedBy: one(users, {
    fields: [aiSuggestions.decidedByUserId],
    references: [users.id],
  }),
}));
