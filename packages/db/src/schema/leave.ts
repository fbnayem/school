/**
 * Leave management (Phase 21).
 *
 * Six tables around one rule set:
 *
 *  - `leave_types` is the institution's policy catalogue — casual, sick, maternity — with
 *    the quota, accrual and restriction facts the service computes against. Types are
 *    archived, never deleted, and `status` lets a policy be retired without archiving the
 *    history that references it.
 *  - `leave_balances` is one holder's entitlement for one type in one academic year.
 *    Exactly one of `employee_id` / `student_id` is set (a database CHECK, restated from
 *    Zod, because the pair being both null or both set is a data corruption either way).
 *    `used_days` moves only inside the approval/cancellation transaction; the arithmetic is
 *    exact decimal in tenths of a day, never floating point.
 *  - `leave_applications` is the request record. Status is the whole lifecycle —
 *    withdrawal and cancellation are statuses, not deletions — and approval travels through
 *    the workflow engine (`workflow_request_id` is a bare uuid, following the accounting
 *    precedent: the id is recorded for traceability, the engine is never dereferenced by
 *    join). Overlapping leave for the same holder is refused by a deferred constraint
 *    trigger in the migration (`leave_applications_no_overlap`), so even a raw SQL insert
 *    cannot create two simultaneous approved leaves.
 *  - `leave_application_documents` — medical certificates and the like. A pure child row:
 *    it cascades with its application and carries no version column.
 *  - `leave_encashments` — paying out unused days. Money is `numeric(14, 2)` and is read
 *    and written only through the `Money` value object.
 *  - `holiday_overrides` — a working Saturday or an extra holiday, consulted (together with
 *    `calendar_events` and `academic_years.weekend_days`) when computing how many working
 *    days an application actually spans.
 *
 * Dates here are school-calendar facts and therefore `date` columns (ADR-009); the decision
 * timestamps are instants and therefore `timestamptz`.
 */

import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
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
import { academicYears } from './academic';
import { employees } from './people';
import { students } from './students';

// ─────────────────────────────────────────────────────────────────────────────────────
// Enumerations
//
// All of these are genuinely closed sets: adding a value changes how the service computes
// balances or reflects attendance, so it should be a migration and a code change. Types a
// school invents are rows in `leave_types`, not enum members.
// ─────────────────────────────────────────────────────────────────────────────────────

export const leaveAppliesToEnum = pgEnum('leave_applies_to', ['employee', 'student', 'both']);

export const leaveAccrualEnum = pgEnum('leave_accrual', [
  'annual_grant',
  'monthly_accrual',
  'none',
]);

/** Maternity leave is `female`; the check on application is a clear 422, not a silent skip. */
export const leaveGenderRestrictionEnum = pgEnum('leave_gender_restriction', [
  'any',
  'female',
  'male',
]);

export const leaveTypeStatusEnum = pgEnum('leave_type_status', ['active', 'inactive']);

export const leaveApplicationStatusEnum = pgEnum('leave_application_status', [
  'draft',
  'submitted',
  'approved',
  'rejected',
  'cancelled',
  'withdrawn',
]);

export const leaveHalfDayPeriodEnum = pgEnum('leave_half_day_period', ['first', 'second']);

export const leaveEncashmentStatusEnum = pgEnum('leave_encashment_status', [
  'pending',
  'approved',
  'rejected',
]);

// ─────────────────────────────────────────────────────────────────────────────────────
// Leave types
// ─────────────────────────────────────────────────────────────────────────────────────

export const leaveTypes = pgTable(
  'leave_types',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    code: varchar('code', { length: 32 }).notNull(),
    nameEn: varchar('name_en', { length: 255 }).notNull(),
    nameBn: varchar('name_bn', { length: 255 }),
    appliesTo: leaveAppliesToEnum('applies_to').notNull().default('employee'),
    isPaid: boolean('is_paid').notNull().default(true),
    /** When true, an application cannot be submitted without at least one document. */
    requiresDocument: boolean('requires_document').notNull().default(false),
    /** Null means no limit. Compared against the computed *working-day* count. */
    maxConsecutiveDays: integer('max_consecutive_days'),
    /**
     * Days per year, in tenths (`numeric(5, 1)`), so a half-day entitlement is exact.
     * Also the entitlement auto-created on first approval when no balance row exists yet.
     */
    annualQuotaDays: numeric('annual_quota_days', { precision: 5, scale: 1 })
      .notNull()
      .default('0.0'),
    carryForwardDays: numeric('carry_forward_days', { precision: 5, scale: 1 })
      .notNull()
      .default('0.0'),
    accrual: leaveAccrualEnum('accrual').notNull().default('annual_grant'),
    genderRestriction: leaveGenderRestrictionEnum('gender_restriction').notNull().default('any'),
    /**
     * The single sanctioned way a balance may go below zero. Default off: an approval that
     * would overdraw the balance is refused unless the policy explicitly says otherwise.
     */
    allowNegativeBalance: boolean('allow_negative_balance').notNull().default(false),
    status: leaveTypeStatusEnum('status').notNull().default('active'),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('leave_types_institution_code_key')
      .on(table.institutionId, table.code)
      .where(sql`${table.archivedAt} IS NULL`),
    index('leave_types_tenant_idx').on(table.tenantId),
    index('leave_types_institution_status_idx').on(table.institutionId, table.status),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Balances
// ─────────────────────────────────────────────────────────────────────────────────────

export const leaveBalances = pgTable(
  'leave_balances',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    leaveTypeId: uuid('leave_type_id')
      .notNull()
      .references(() => leaveTypes.id, { onDelete: 'restrict' }),
    /** Exactly one of these two is set — `leave_balances_exactly_one_holder` in SQL. */
    employeeId: uuid('employee_id').references(() => employees.id, { onDelete: 'restrict' }),
    studentId: uuid('student_id').references(() => students.id, { onDelete: 'restrict' }),
    academicYearId: uuid('academic_year_id')
      .notNull()
      .references(() => academicYears.id, { onDelete: 'restrict' }),
    entitledDays: numeric('entitled_days', { precision: 5, scale: 1 }).notNull().default('0.0'),
    usedDays: numeric('used_days', { precision: 5, scale: 1 }).notNull().default('0.0'),
    carriedDays: numeric('carried_days', { precision: 5, scale: 1 }).notNull().default('0.0'),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    // One balance per (type, holder, year). Postgres treats NULLs as distinct, so the
    // nullable holder pair needs a partial-index pair rather than one composite index.
    uniqueIndex('leave_balances_type_employee_year_key')
      .on(table.leaveTypeId, table.employeeId, table.academicYearId)
      .where(sql`${table.employeeId} IS NOT NULL AND ${table.archivedAt} IS NULL`),
    uniqueIndex('leave_balances_type_student_year_key')
      .on(table.leaveTypeId, table.studentId, table.academicYearId)
      .where(sql`${table.studentId} IS NOT NULL AND ${table.archivedAt} IS NULL`),
    index('leave_balances_tenant_idx').on(table.tenantId),
    index('leave_balances_employee_idx').on(table.employeeId),
    index('leave_balances_student_idx').on(table.studentId),
    index('leave_balances_year_idx').on(table.academicYearId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Applications
// ─────────────────────────────────────────────────────────────────────────────────────

export const leaveApplications = pgTable(
  'leave_applications',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    leaveTypeId: uuid('leave_type_id')
      .notNull()
      .references(() => leaveTypes.id, { onDelete: 'restrict' }),
    /**
     * The year the balance is charged to, resolved from `from_date` at creation so the
     * approval transaction never has to guess which year a December application belongs to.
     */
    academicYearId: uuid('academic_year_id')
      .notNull()
      .references(() => academicYears.id, { onDelete: 'restrict' }),
    /** Exactly one of these two is set — `leave_applications_exactly_one_holder` in SQL. */
    employeeId: uuid('employee_id').references(() => employees.id, { onDelete: 'restrict' }),
    studentId: uuid('student_id').references(() => students.id, { onDelete: 'restrict' }),
    fromDate: date('from_date').notNull(),
    toDate: date('to_date').notNull(),
    /**
     * Working days the application spans — weekends, calendar holidays and holiday
     * overrides excluded, half days counting 0.5. Computed by the service in exact tenths
     * and frozen here, so a later calendar change does not silently reprice an approval.
     */
    days: numeric('days', { precision: 5, scale: 1 }).notNull(),
    isHalfDay: boolean('is_half_day').notNull().default(false),
    halfDayPeriod: leaveHalfDayPeriodEnum('half_day_period'),
    reason: text('reason').notNull(),
    contactDuringLeave: varchar('contact_during_leave', { length: 120 }),
    status: leaveApplicationStatusEnum('status').notNull().default('draft'),
    /**
     * Bare uuid, no FK (accounting precedent): recorded for traceability, and the outcome
     * handler — not a join — is the integration surface with the workflow engine.
     */
    workflowRequestId: uuid('workflow_request_id'),
    /** Deliberately not an FK: the decision record must outlive any user row. */
    decidedBy: uuid('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    decisionNote: varchar('decision_note', { length: 1000 }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('leave_applications_tenant_idx').on(table.tenantId),
    // The approver's queue and the HR dashboard.
    index('leave_applications_institution_status_idx').on(table.institutionId, table.status),
    index('leave_applications_employee_idx').on(table.employeeId),
    index('leave_applications_student_idx').on(table.studentId),
    // Serves the leave calendar and the overlap trigger's probe.
    index('leave_applications_range_idx').on(table.institutionId, table.fromDate, table.toDate),
    index('leave_applications_workflow_idx').on(table.workflowRequestId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Application documents
// ─────────────────────────────────────────────────────────────────────────────────────

export const leaveApplicationDocuments = pgTable(
  'leave_application_documents',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    /** `cascade`: a document is a genuinely owned child of its application. */
    applicationId: uuid('application_id')
      .notNull()
      .references(() => leaveApplications.id, { onDelete: 'cascade' }),
    storageKey: varchar('storage_key', { length: 512 }).notNull(),
    fileName: varchar('file_name', { length: 255 }).notNull(),
    mimeType: varchar('mime_type', { length: 128 }).notNull(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('leave_application_documents_tenant_idx').on(table.tenantId),
    index('leave_application_documents_application_idx').on(table.applicationId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Encashments
// ─────────────────────────────────────────────────────────────────────────────────────

export const leaveEncashments = pgTable(
  'leave_encashments',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),
    /** The balance the encashed days are deducted from on approval. */
    leaveTypeId: uuid('leave_type_id')
      .notNull()
      .references(() => leaveTypes.id, { onDelete: 'restrict' }),
    academicYearId: uuid('academic_year_id')
      .notNull()
      .references(() => academicYears.id, { onDelete: 'restrict' }),
    days: numeric('days', { precision: 5, scale: 1 }).notNull(),
    /** Taka. `numeric(14, 2)`; `Money` is the only parser. */
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    status: leaveEncashmentStatusEnum('status').notNull().default('pending'),
    /** The user who raised the request — the self-approval check compares against this. */
    requestedBy: uuid('requested_by').notNull(),
    /** The decider, for approvals and rejections alike. Not an FK: outlives the user. */
    approvedBy: uuid('approved_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    decisionNote: varchar('decision_note', { length: 1000 }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('leave_encashments_tenant_idx').on(table.tenantId),
    index('leave_encashments_employee_idx').on(table.employeeId),
    index('leave_encashments_institution_status_idx').on(table.institutionId, table.status),
    index('leave_encashments_year_idx').on(table.academicYearId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Holiday overrides
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * One date's exception to the computed calendar: `is_working_day = true` opens a weekend
 * or holiday (the make-up Saturday), `false` closes a working day (an ad-hoc holiday).
 * Overrides win over both `calendar_events` and the configured weekend.
 */
export const holidayOverrides = pgTable(
  'holiday_overrides',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    date: date('date').notNull(),
    isWorkingDay: boolean('is_working_day').notNull(),
    note: varchar('note', { length: 255 }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('holiday_overrides_institution_date_key')
      .on(table.institutionId, table.date)
      .where(sql`${table.archivedAt} IS NULL`),
    index('holiday_overrides_tenant_idx').on(table.tenantId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Relations
// ─────────────────────────────────────────────────────────────────────────────────────

export const leaveTypesRelations = relations(leaveTypes, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [leaveTypes.institutionId],
    references: [institutions.id],
  }),
  balances: many(leaveBalances),
  applications: many(leaveApplications),
  encashments: many(leaveEncashments),
}));

export const leaveBalancesRelations = relations(leaveBalances, ({ one }) => ({
  leaveType: one(leaveTypes, {
    fields: [leaveBalances.leaveTypeId],
    references: [leaveTypes.id],
  }),
  employee: one(employees, { fields: [leaveBalances.employeeId], references: [employees.id] }),
  student: one(students, { fields: [leaveBalances.studentId], references: [students.id] }),
  academicYear: one(academicYears, {
    fields: [leaveBalances.academicYearId],
    references: [academicYears.id],
  }),
}));

export const leaveApplicationsRelations = relations(leaveApplications, ({ one, many }) => ({
  leaveType: one(leaveTypes, {
    fields: [leaveApplications.leaveTypeId],
    references: [leaveTypes.id],
  }),
  academicYear: one(academicYears, {
    fields: [leaveApplications.academicYearId],
    references: [academicYears.id],
  }),
  employee: one(employees, { fields: [leaveApplications.employeeId], references: [employees.id] }),
  student: one(students, { fields: [leaveApplications.studentId], references: [students.id] }),
  documents: many(leaveApplicationDocuments),
}));

export const leaveApplicationDocumentsRelations = relations(
  leaveApplicationDocuments,
  ({ one }) => ({
    application: one(leaveApplications, {
      fields: [leaveApplicationDocuments.applicationId],
      references: [leaveApplications.id],
    }),
  }),
);

export const leaveEncashmentsRelations = relations(leaveEncashments, ({ one }) => ({
  employee: one(employees, { fields: [leaveEncashments.employeeId], references: [employees.id] }),
  leaveType: one(leaveTypes, {
    fields: [leaveEncashments.leaveTypeId],
    references: [leaveTypes.id],
  }),
  academicYear: one(academicYears, {
    fields: [leaveEncashments.academicYearId],
    references: [academicYears.id],
  }),
}));

export const holidayOverridesRelations = relations(holidayOverrides, ({ one }) => ({
  institution: one(institutions, {
    fields: [holidayOverrides.institutionId],
    references: [institutions.id],
  }),
}));
