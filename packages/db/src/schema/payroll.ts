/**
 * Payroll (Phase 16): salary runs computed from the HR module's salary structures.
 *
 * This module turns (assignment.basic, structure components in sequence order, attendance,
 * one-off adjustments, loan instalments) into payslips, and posts the paid run to the
 * accounting ledger. The invariants that matter are enforced in the **database**:
 *
 *  1. **A payslip's lines and its totals agree.** `sum(earning lines) = gross` and
 *     `sum(deduction lines) = total_deductions` are a DEFERRABLE INITIALLY DEFERRED
 *     constraint trigger; `net = gross - total_deductions` and
 *     `gross = basic + total_earnings` are check constraints. The database refuses an
 *     inconsistent payslip even from raw SQL that bypasses the service.
 *  2. **One run per (institution, year, month)** unless cancelled — a partial unique index.
 *  3. **An approved run is immutable.** A trigger permits exactly two transitions out of
 *     `approved` — to `paid` and to `cancelled` — with every substantive column untouched.
 *     Payslips and lines of an approved or paid run are frozen too (the single exception:
 *     the payment fields on a payslip, which is how marking the run paid works). Nothing in
 *     this module is ever hard-deleted.
 *  4. **The approver differs from the calculator** — a check constraint, not only a
 *     service refusal.
 *  5. **Money is `numeric(14, 2)`**, parsed only by `Money.fromDecimalString`, written only
 *     by `Money.toDecimalString`. Percentage components go through `Money.percentage`
 *     (basis points) and pro-rata splits through `Money.allocate`, so every payslip is
 *     exact to the poisa.
 *
 * `payroll_journal_links` records the one balanced journal entry a paid run produced; the
 * entry itself belongs to the accounting module and is written only through `LedgerService`
 * inside the same transaction that marks the run paid.
 *
 * Enum note: the `pgEnum` declarations live here rather than in `_shared.ts` (same
 * reasoning as `fees.ts`): every value set below is genuinely closed — adding a run status
 * or a line kind changes the money code as well as the schema. The things a school invents
 * (adjustment names, loan purposes) are varchars, not enums.
 */

import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  smallint,
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
import { employees } from './people';
import { employeeSalaryAssignments, salaryComponents, salaryStructures } from './hr';
import { journalEntries } from './accounting';

// ─────────────────────────────────────────────────────────────────────────────────────
// Enumerations
// ─────────────────────────────────────────────────────────────────────────────────────

export const payrollRunStatusEnum = pgEnum('payroll_run_status', [
  'draft',
  'calculated',
  'under_review',
  'approved',
  'paid',
  'cancelled',
]);

export const payslipPaymentStatusEnum = pgEnum('payslip_payment_status', [
  'pending',
  'paid',
  'failed',
]);

/** One kind for payslip lines and adjustments alike: money either comes in or goes out. */
export const payrollLineKindEnum = pgEnum('payroll_line_kind', ['earning', 'deduction']);

export const loanAdvanceStatusEnum = pgEnum('loan_advance_status', [
  'active',
  'settled',
  'cancelled',
]);

// ─────────────────────────────────────────────────────────────────────────────────────
// Payroll runs
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * One month's payroll for one institution.
 *
 * draft → calculated → (under_review →) approved → paid, or → cancelled with a reason from
 * any non-terminal state. Calculation, approval and payment are three separate acts by (at
 * least) two separate people: `approved_by <> calculated_by` is a check constraint.
 * Totals are recomputed as fresh sums over the payslips at every calculation — a fact,
 * never an incremental adjustment.
 */
export const payrollRuns = pgTable(
  'payroll_runs',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    periodYear: smallint('period_year').notNull(),
    /** 1–12, checked in SQL as well as Zod. */
    periodMonth: smallint('period_month').notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    status: payrollRunStatusEnum('status').notNull().default('draft'),

    calculatedBy: uuid('calculated_by'),
    calculatedAt: timestamp('calculated_at', { withTimezone: true, mode: 'date' }),
    approvedBy: uuid('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true, mode: 'date' }),
    paidBy: uuid('paid_by'),
    paidAt: timestamp('paid_at', { withTimezone: true, mode: 'date' }),
    cancelledBy: uuid('cancelled_by'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
    cancelReason: varchar('cancel_reason', { length: 1000 }),

    totalGross: numeric('total_gross', { precision: 14, scale: 2 }).notNull().default('0.00'),
    totalDeductions: numeric('total_deductions', { precision: 14, scale: 2 })
      .notNull()
      .default('0.00'),
    totalNet: numeric('total_net', { precision: 14, scale: 2 }).notNull().default('0.00'),
    employeeCount: integer('employee_count').notNull().default(0),

    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    // One live run per month; a cancelled run frees the month for a fresh one.
    uniqueIndex('payroll_runs_institution_period_key')
      .on(table.institutionId, table.periodYear, table.periodMonth)
      .where(sql`${table.status} <> 'cancelled' AND ${table.archivedAt} IS NULL`),
    index('payroll_runs_tenant_idx').on(table.tenantId),
    index('payroll_runs_institution_status_idx').on(table.institutionId, table.status),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Payslips and their lines
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * One employee's slip in one run.
 *
 * `gross = basic + total_earnings` and `net = gross - total_deductions` are check
 * constraints; the agreement between the totals and the lines is a deferred constraint
 * trigger. Recalculation archives the previous slips rather than deleting them (ADR-008),
 * so the unique (run, employee) index is partial on `archived_at IS NULL`.
 */
export const payslips = pgTable(
  'payslips',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => payrollRuns.id, { onDelete: 'restrict' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),
    /** Provenance: which structure and which assignment produced this slip. */
    salaryStructureId: uuid('salary_structure_id').references(() => salaryStructures.id, {
      onDelete: 'restrict',
    }),
    salaryAssignmentId: uuid('salary_assignment_id').references(
      () => employeeSalaryAssignments.id,
      { onDelete: 'restrict' },
    ),

    basic: numeric('basic', { precision: 14, scale: 2 }).notNull().default('0.00'),
    /** Allowance earnings excluding basic; `gross = basic + total_earnings` by constraint. */
    totalEarnings: numeric('total_earnings', { precision: 14, scale: 2 })
      .notNull()
      .default('0.00'),
    gross: numeric('gross', { precision: 14, scale: 2 }).notNull().default('0.00'),
    totalDeductions: numeric('total_deductions', { precision: 14, scale: 2 })
      .notNull()
      .default('0.00'),
    net: numeric('net', { precision: 14, scale: 2 }).notNull().default('0.00'),

    /** Days of unpaid leave that produced the pro-rata deduction line, kept for the slip. */
    unpaidLeaveDays: smallint('unpaid_leave_days').notNull().default(0),

    paymentStatus: payslipPaymentStatusEnum('payment_status').notNull().default('pending'),
    paidAt: timestamp('paid_at', { withTimezone: true, mode: 'date' }),

    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('payslips_run_employee_key')
      .on(table.runId, table.employeeId)
      .where(sql`${table.archivedAt} IS NULL`),
    index('payslips_tenant_idx').on(table.tenantId),
    index('payslips_run_idx').on(table.runId),
    index('payslips_employee_idx').on(table.employeeId),
  ],
);

/**
 * One line of one payslip: an earning or a deduction. A pure child row (no `version`):
 * lines are written as a set at calculation and archived as a set at recalculation.
 *
 * `component_id` links back to the salary component that produced the line; null for the
 * basic line, the unpaid-leave pro-rata, loan instalments and one-off adjustments.
 * `loan_advance_id` links an instalment line to its loan so marking the run paid can
 * decrement exactly what was withheld.
 */
export const payslipLines = pgTable(
  'payslip_lines',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    payslipId: uuid('payslip_id')
      .notNull()
      .references(() => payslips.id, { onDelete: 'cascade' }),
    componentId: uuid('component_id').references(() => salaryComponents.id, {
      onDelete: 'restrict',
    }),
    loanAdvanceId: uuid('loan_advance_id').references(() => loanAdvances.id, {
      onDelete: 'restrict',
    }),
    name: varchar('name', { length: 128 }).notNull(),
    kind: payrollLineKindEnum('kind').notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    sequence: smallint('sequence').notNull().default(0),
    /** Structure-defined recurring deductions (PF, tax) feed the statutory summary. */
    isStatutory: boolean('is_statutory').notNull().default(false),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('payslip_lines_payslip_idx').on(table.payslipId, table.sequence),
    index('payslip_lines_tenant_idx').on(table.tenantId),
    index('payslip_lines_loan_idx').on(table.loanAdvanceId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// One-off adjustments
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A one-off bonus or fine for one employee in one run, with a mandatory reason. Editable
 * only while the run has not been approved — a trigger refuses any write against an
 * approved or paid run, and the service additionally refuses an approval while an
 * adjustment is newer than the last calculation.
 */
export const payrollAdjustments = pgTable(
  'payroll_adjustments',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => payrollRuns.id, { onDelete: 'restrict' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),
    kind: payrollLineKindEnum('kind').notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    reason: varchar('reason', { length: 1000 }).notNull(),
    /** The user who signed off the adjustment, when a school separates entry from sign-off. */
    approvedBy: uuid('approved_by'),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('payroll_adjustments_run_idx').on(table.runId, table.employeeId),
    index('payroll_adjustments_tenant_idx').on(table.tenantId),
    index('payroll_adjustments_employee_idx').on(table.employeeId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Loans and advances
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A staff loan or salary advance recovered through payroll.
 *
 * Calculation deducts `min(instalment, remaining)` from every run whose period is at or
 * after (start_year, start_month); marking the run paid decrements `remaining` in the same
 * transaction and settles the loan when it reaches zero. Cancellation requires a reason;
 * nothing is deleted.
 */
export const loanAdvances = pgTable(
  'loan_advances',
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
    principal: numeric('principal', { precision: 14, scale: 2 }).notNull(),
    instalment: numeric('instalment', { precision: 14, scale: 2 }).notNull(),
    remaining: numeric('remaining', { precision: 14, scale: 2 }).notNull(),
    startYear: smallint('start_year').notNull(),
    startMonth: smallint('start_month').notNull(),
    status: loanAdvanceStatusEnum('status').notNull().default('active'),
    notes: varchar('notes', { length: 500 }),
    cancelReason: varchar('cancel_reason', { length: 1000 }),
    settledAt: timestamp('settled_at', { withTimezone: true, mode: 'date' }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('loan_advances_tenant_idx').on(table.tenantId),
    index('loan_advances_employee_idx').on(table.employeeId, table.status),
    index('loan_advances_institution_status_idx').on(table.institutionId, table.status),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Ledger link
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The one journal entry a paid run posted: debit salary expense for the gross, credit
 * payable for the withheld deductions, credit cash/bank for the net. Written in the same
 * transaction as the status flip to `paid`, so the run and its ledger effect commit
 * together or not at all. Unique on `run_id` and never partial: a run pays out once.
 */
export const payrollJournalLinks = pgTable(
  'payroll_journal_links',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => payrollRuns.id, { onDelete: 'restrict' }),
    journalEntryId: uuid('journal_entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'restrict' }),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('payroll_journal_links_run_key').on(table.runId),
    index('payroll_journal_links_tenant_idx').on(table.tenantId),
    index('payroll_journal_links_entry_idx').on(table.journalEntryId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────

export const payrollRunsRelations = relations(payrollRuns, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [payrollRuns.institutionId],
    references: [institutions.id],
  }),
  payslips: many(payslips),
  adjustments: many(payrollAdjustments),
  journalLinks: many(payrollJournalLinks),
}));

export const payslipsRelations = relations(payslips, ({ one, many }) => ({
  run: one(payrollRuns, { fields: [payslips.runId], references: [payrollRuns.id] }),
  employee: one(employees, { fields: [payslips.employeeId], references: [employees.id] }),
  structure: one(salaryStructures, {
    fields: [payslips.salaryStructureId],
    references: [salaryStructures.id],
  }),
  assignment: one(employeeSalaryAssignments, {
    fields: [payslips.salaryAssignmentId],
    references: [employeeSalaryAssignments.id],
  }),
  lines: many(payslipLines),
}));

export const payslipLinesRelations = relations(payslipLines, ({ one }) => ({
  payslip: one(payslips, { fields: [payslipLines.payslipId], references: [payslips.id] }),
  component: one(salaryComponents, {
    fields: [payslipLines.componentId],
    references: [salaryComponents.id],
  }),
  loan: one(loanAdvances, {
    fields: [payslipLines.loanAdvanceId],
    references: [loanAdvances.id],
  }),
}));

export const payrollAdjustmentsRelations = relations(payrollAdjustments, ({ one }) => ({
  run: one(payrollRuns, { fields: [payrollAdjustments.runId], references: [payrollRuns.id] }),
  employee: one(employees, {
    fields: [payrollAdjustments.employeeId],
    references: [employees.id],
  }),
}));

export const loanAdvancesRelations = relations(loanAdvances, ({ one, many }) => ({
  employee: one(employees, { fields: [loanAdvances.employeeId], references: [employees.id] }),
  instalmentLines: many(payslipLines),
}));

export const payrollJournalLinksRelations = relations(payrollJournalLinks, ({ one }) => ({
  run: one(payrollRuns, {
    fields: [payrollJournalLinks.runId],
    references: [payrollRuns.id],
  }),
  journalEntry: one(journalEntries, {
    fields: [payrollJournalLinks.journalEntryId],
    references: [journalEntries.id],
  }),
}));
