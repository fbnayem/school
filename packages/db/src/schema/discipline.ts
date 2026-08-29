/**
 * Discipline and behaviour (Phase 22).
 *
 * This module records allegations and sanctions against children — the most sensitive data
 * the platform holds after medical records — so the schema is built around due process:
 *
 *  - **Nothing is deleted.** A withdrawn allegation and an unsubstantiated one are *statuses*
 *    (`behaviour_record_status`), never a missing row. Every table carries the standard soft
 *    archive columns and the service layer exposes no delete path.
 *  - **Notes are append-only.** `behaviour_record_notes` gets the same database-level
 *    treatment as `audit_logs`: a trigger refuses UPDATE and DELETE outright (see migration
 *    0020), so a record's narrative cannot be quietly rewritten after the fact.
 *  - **A severe sanction needs two people.** `disciplinary_actions` carries both `decided_by`
 *    and `approved_by`, and the database itself restates the rule that a suspension or an
 *    expulsion recommendation cannot be approved by the person who decided it
 *    (`disciplinary_actions_severe_distinct_approver`).
 *  - **Merit points are a ledger, not a counter.** `merit_points_ledger` appends one entry
 *    per substantiated record; the running total is recomputed from the sum of entries inside
 *    the posting transaction, never incremented in place.
 *
 * Behaviour *categories* are a lookup table rather than an enum, because every school invents
 * its own ("late for assembly", "helped a younger student") — see the enum rule in
 * `_shared.ts`. Severity, statuses and action types are genuinely closed sets and are enums.
 */

import { relations, sql } from 'drizzle-orm';
import {
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
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
import { campuses, institutions, organizations } from './tenancy';
import { academicYears, periods } from './academic';
import { employees } from './people';
import { guardians, students } from './students';

// ─────────────────────────────────────────────────────────────────────────────────────
// Enumerations — closed value sets only. What a school can invent for itself (the incident
// categories) lives in `behaviour_categories`, not here.
// ─────────────────────────────────────────────────────────────────────────────────────

export const behaviourKindEnum = pgEnum('behaviour_kind', ['positive', 'negative']);

export const behaviourSeverityEnum = pgEnum('behaviour_severity', [
  'minor',
  'moderate',
  'major',
  'severe',
]);

export const behaviourRecordStatusEnum = pgEnum('behaviour_record_status', [
  'draft',
  'reported',
  'under_investigation',
  'substantiated',
  'unsubstantiated',
  'withdrawn',
]);

export const behaviourConfidentialityEnum = pgEnum('behaviour_confidentiality', [
  'normal',
  'restricted',
]);

export const disciplinaryActionTypeEnum = pgEnum('disciplinary_action_type', [
  'verbal_warning',
  'written_warning',
  'detention',
  'parent_meeting',
  'community_service',
  'suspension',
  'expulsion_recommended',
]);

export const disciplinaryActionStatusEnum = pgEnum('disciplinary_action_status', [
  'proposed',
  'approved',
  'active',
  'completed',
  'revoked',
]);

export const behaviourNoteVisibilityEnum = pgEnum('behaviour_note_visibility', [
  'internal',
  'shared_with_guardian',
]);

// ─────────────────────────────────────────────────────────────────────────────────────
// Tables
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A school's own vocabulary of behaviours — positive and negative — with the default
 * severity and merit-point value a record of that category starts from.
 */
export const behaviourCategories = pgTable(
  'behaviour_categories',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    code: varchar('code', { length: 32 }).notNull(),
    nameEn: varchar('name_en', { length: 128 }).notNull(),
    nameBn: varchar('name_bn', { length: 128 }),
    kind: behaviourKindEnum('kind').notNull(),
    defaultSeverity: behaviourSeverityEnum('default_severity').notNull().default('minor'),
    /**
     * May be negative — a negative behaviour subtracts merit points. The database enforces
     * that the sign matches the kind (`behaviour_categories_kind_points_aligned`).
     */
    defaultPoints: integer('default_points').notNull().default(0),
    description: varchar('description', { length: 500 }),
    sortOrder: smallint('sort_order').notNull().default(0),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('behaviour_categories_institution_code_key')
      .on(table.institutionId, table.code)
      .where(sql`${table.archivedAt} IS NULL`),
    index('behaviour_categories_tenant_idx').on(table.tenantId),
    index('behaviour_categories_institution_kind_idx').on(table.institutionId, table.kind),
  ],
);

/**
 * One incident (or commendation) about one student.
 *
 * `status` moves through an explicit state machine enforced in the service; the terminal
 * statuses (`substantiated`, `unsubstantiated`, `withdrawn`) are where a record rests forever
 * — never a deletion. `confidentiality = 'restricted'` hides the record from everyone
 * without the restricted-view permission, including the guardian.
 */
export const behaviourRecords = pgTable(
  'behaviour_records',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    /** Derived from the student's active enrolment at reporting time; null if none. */
    campusId: uuid('campus_id').references(() => campuses.id, { onDelete: 'restrict' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'restrict' }),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => behaviourCategories.id, { onDelete: 'restrict' }),
    /** The year the incident belongs to — what the merit ledger is keyed by. */
    academicYearId: uuid('academic_year_id')
      .notNull()
      .references(() => academicYears.id, { onDelete: 'restrict' }),
    occurredOn: date('occurred_on').notNull(),
    occurredAtPeriodId: uuid('occurred_at_period_id').references(() => periods.id, {
      onDelete: 'set null',
    }),
    description: text('description').notNull(),
    severity: behaviourSeverityEnum('severity').notNull(),
    /** Merit points this record carries; sign must match the category's kind. */
    points: integer('points').notNull().default(0),
    reportedByEmployeeId: uuid('reported_by_employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),
    status: behaviourRecordStatusEnum('status').notNull().default('draft'),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true, mode: 'date' }),
    statusChangedBy: uuid('status_changed_by'),
    statusReason: varchar('status_reason', { length: 1000 }),
    confidentiality: behaviourConfidentialityEnum('confidentiality').notNull().default('normal'),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('behaviour_records_tenant_idx').on(table.tenantId),
    index('behaviour_records_student_idx').on(table.studentId, table.occurredOn),
    index('behaviour_records_institution_status_idx').on(table.institutionId, table.status),
    index('behaviour_records_institution_occurred_idx').on(table.institutionId, table.occurredOn),
    index('behaviour_records_category_idx').on(table.categoryId),
    index('behaviour_records_year_idx').on(table.academicYearId),
  ],
);

/**
 * A sanction (or intervention) attached to a behaviour record.
 *
 * `decided_by` is the user who proposed the action; `approved_by` the user who confirmed it.
 * For a severe action — suspension or a recommendation of expulsion — the two MUST be
 * different people. The service refuses a self-approval at runtime and the check constraint
 * `disciplinary_actions_severe_distinct_approver` restates it in the database, so not even a
 * hand-written SQL fix can put one person's suspension into effect on their own say-so.
 */
export const disciplinaryActions = pgTable(
  'disciplinary_actions',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    behaviourRecordId: uuid('behaviour_record_id')
      .notNull()
      .references(() => behaviourRecords.id, { onDelete: 'restrict' }),
    actionType: disciplinaryActionTypeEnum('action_type').notNull(),
    startsOn: date('starts_on'),
    endsOn: date('ends_on'),
    details: text('details').notNull(),
    /** The user who proposed (decided) the action. */
    decidedBy: uuid('decided_by').notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** The different person who confirmed it. Null while `proposed`. */
    approvedBy: uuid('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true, mode: 'date' }),
    /** Set when the approval was routed through the workflow engine (in-flight module). */
    workflowRequestId: uuid('workflow_request_id'),
    status: disciplinaryActionStatusEnum('status').notNull().default('proposed'),
    revokedReason: varchar('revoked_reason', { length: 500 }),
    revokedBy: uuid('revoked_by'),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('disciplinary_actions_tenant_idx').on(table.tenantId),
    index('disciplinary_actions_record_idx').on(table.behaviourRecordId),
    index('disciplinary_actions_institution_status_idx').on(table.institutionId, table.status),
  ],
);

/**
 * Append-only narrative on a record: what was said in the meeting, what the child said, what
 * was agreed. UPDATE and DELETE are refused by a database trigger (migration 0020), exactly
 * as they are on `audit_logs` — a disciplinary file that can be edited in place is not a
 * record. The archive/updated columns exist to satisfy the schema conventions but are
 * unreachable: the trigger fires first.
 */
export const behaviourRecordNotes = pgTable(
  'behaviour_record_notes',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    behaviourRecordId: uuid('behaviour_record_id')
      .notNull()
      .references(() => behaviourRecords.id, { onDelete: 'restrict' }),
    note: text('note').notNull(),
    authorUserId: uuid('author_user_id').notNull(),
    /** `internal` notes never reach the guardian portal. */
    visibility: behaviourNoteVisibilityEnum('visibility').notNull().default('internal'),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('behaviour_record_notes_tenant_idx').on(table.tenantId),
    index('behaviour_record_notes_record_idx').on(table.behaviourRecordId, table.createdAt),
  ],
);

/**
 * A guardian's acknowledgement that they have seen a (visible) record about their child.
 * One acknowledgement per guardian per record.
 */
export const behaviourGuardianAcknowledgements = pgTable(
  'behaviour_guardian_acknowledgements',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    behaviourRecordId: uuid('behaviour_record_id')
      .notNull()
      .references(() => behaviourRecords.id, { onDelete: 'restrict' }),
    guardianId: uuid('guardian_id')
      .notNull()
      .references(() => guardians.id, { onDelete: 'restrict' }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    comment: varchar('comment', { length: 1000 }),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('behaviour_guardian_acknowledgements_record_guardian_key')
      .on(table.behaviourRecordId, table.guardianId)
      .where(sql`${table.archivedAt} IS NULL`),
    index('behaviour_guardian_acknowledgements_tenant_idx').on(table.tenantId),
    index('behaviour_guardian_acknowledgements_guardian_idx').on(table.guardianId),
  ],
);

/**
 * The merit-point ledger: one entry per substantiated behaviour record, per student, per
 * academic year. `running_total` is computed inside the posting transaction as the sum of
 * the student's prior entries for the year plus this one — a sum is a fact, an increment is
 * a running total that can drift. One entry per source record, enforced by a partial unique
 * index, so a record can never post its points twice.
 */
export const meritPointsLedger = pgTable(
  'merit_points_ledger',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'restrict' }),
    academicYearId: uuid('academic_year_id')
      .notNull()
      .references(() => academicYears.id, { onDelete: 'restrict' }),
    sourceRecordId: uuid('source_record_id')
      .notNull()
      .references(() => behaviourRecords.id, { onDelete: 'restrict' }),
    /** Signed. Positive for commendations, negative for sanctions. Never zero. */
    points: integer('points').notNull(),
    runningTotal: integer('running_total').notNull(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('merit_points_ledger_source_key')
      .on(table.sourceRecordId)
      .where(sql`${table.archivedAt} IS NULL`),
    index('merit_points_ledger_tenant_idx').on(table.tenantId),
    index('merit_points_ledger_student_year_idx').on(table.studentId, table.academicYearId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Relations
// ─────────────────────────────────────────────────────────────────────────────────────

export const behaviourCategoriesRelations = relations(behaviourCategories, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [behaviourCategories.institutionId],
    references: [institutions.id],
  }),
  records: many(behaviourRecords),
}));

export const behaviourRecordsRelations = relations(behaviourRecords, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [behaviourRecords.institutionId],
    references: [institutions.id],
  }),
  student: one(students, {
    fields: [behaviourRecords.studentId],
    references: [students.id],
  }),
  category: one(behaviourCategories, {
    fields: [behaviourRecords.categoryId],
    references: [behaviourCategories.id],
  }),
  academicYear: one(academicYears, {
    fields: [behaviourRecords.academicYearId],
    references: [academicYears.id],
  }),
  reportedBy: one(employees, {
    fields: [behaviourRecords.reportedByEmployeeId],
    references: [employees.id],
  }),
  actions: many(disciplinaryActions),
  notes: many(behaviourRecordNotes),
  acknowledgements: many(behaviourGuardianAcknowledgements),
}));

export const disciplinaryActionsRelations = relations(disciplinaryActions, ({ one }) => ({
  behaviourRecord: one(behaviourRecords, {
    fields: [disciplinaryActions.behaviourRecordId],
    references: [behaviourRecords.id],
  }),
}));

export const behaviourRecordNotesRelations = relations(behaviourRecordNotes, ({ one }) => ({
  behaviourRecord: one(behaviourRecords, {
    fields: [behaviourRecordNotes.behaviourRecordId],
    references: [behaviourRecords.id],
  }),
}));

export const behaviourGuardianAcknowledgementsRelations = relations(
  behaviourGuardianAcknowledgements,
  ({ one }) => ({
    behaviourRecord: one(behaviourRecords, {
      fields: [behaviourGuardianAcknowledgements.behaviourRecordId],
      references: [behaviourRecords.id],
    }),
    guardian: one(guardians, {
      fields: [behaviourGuardianAcknowledgements.guardianId],
      references: [guardians.id],
    }),
  }),
);

export const meritPointsLedgerRelations = relations(meritPointsLedger, ({ one }) => ({
  student: one(students, {
    fields: [meritPointsLedger.studentId],
    references: [students.id],
  }),
  academicYear: one(academicYears, {
    fields: [meritPointsLedger.academicYearId],
    references: [academicYears.id],
  }),
  sourceRecord: one(behaviourRecords, {
    fields: [meritPointsLedger.sourceRecordId],
    references: [behaviourRecords.id],
  }),
}));
