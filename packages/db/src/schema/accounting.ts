/**
 * Accounting — the double-entry ledger (Phase 13).
 *
 * This is the module where a mistake is a financial misstatement, so the invariants that
 * matter are enforced in the **database**, not only in the service:
 *
 *  1. **A journal line is a debit or a credit, never both and never neither.** A check
 *     constraint (`journal_lines_debit_xor_credit`) refuses a line with both sides non-zero
 *     or both sides zero, and both amounts are non-negative by constraint.
 *  2. **An entry balances.** `sum(debit) = sum(credit)` is enforced by a `DEFERRABLE
 *     INITIALLY DEFERRED` constraint trigger, so a multi-line insert inside one transaction
 *     is legal but an unbalanced commit is refused — even by raw SQL that bypasses the
 *     service entirely.
 *  3. **A posted entry is immutable.** Its lines cannot be inserted, updated or deleted, and
 *     the entry itself accepts exactly one further change: being marked `reversed` with a
 *     link to the reversing entry. Correction is a mirrored reversing entry, never an edit —
 *     the same philosophy that makes `audit_logs` append-only (migration 0005).
 *  4. **Nothing posts to a closed period.** A trigger checks the period and its fiscal year
 *     on insert and on the draft → posted transition.
 *  5. **Only leaf accounts are postable.** A header account (`is_postable = false`) exists
 *     to structure reports; a trigger refuses any journal line that names one.
 *  6. **Money is `numeric(14, 2)`**, parsed only by `Money.fromDecimalString` and written
 *     only by `Money.toDecimalString` (ADR-004). No float exists on any code path.
 *
 * Nothing here is ever hard-deleted. Entries are reversed; configuration rows are archived.
 *
 * `expense_claims.workflow_request_id` is a bare uuid, deliberately without a foreign key:
 * the workflow engine is an optional integration owned by another module, and accounting must
 * keep working when it is absent. The accounting service exposes a callback method the
 * workflow module can invoke; it never imports the workflow module.
 */

import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
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

// ─────────────────────────────────────────────────────────────────────────────────────
// Enumerations. Every set below is genuinely closed: adding an account type or a journal
// status changes the reporting and posting code as well as the schema, so it should require
// a migration. The things a school invents for itself — account names, cost centres,
// expense categories — are rows, not enum values.
// ─────────────────────────────────────────────────────────────────────────────────────

/** The five fundamental account types. Everything in every report derives from these. */
export const accountTypeEnum = pgEnum('account_type', [
  'asset',
  'liability',
  'equity',
  'income',
  'expense',
]);

/**
 * Which side increases the account. Assets and expenses normally carry a debit balance;
 * liabilities, equity and income a credit balance. Stored rather than derived from `type`
 * because contra accounts (accumulated depreciation, sales returns) legitimately invert it.
 */
export const accountNormalBalanceEnum = pgEnum('account_normal_balance', ['debit', 'credit']);

export const accountStatusEnum = pgEnum('account_status', ['active', 'archived']);

export const fiscalYearStatusEnum = pgEnum('fiscal_year_status', ['open', 'closed']);

export const accountingPeriodStatusEnum = pgEnum('accounting_period_status', ['open', 'closed']);

/**
 * `draft` may be edited; `posted` is immutable; `reversed` is a posted entry whose effect
 * has been cancelled by a linked mirror entry. There is no `deleted`.
 */
export const journalEntryStatusEnum = pgEnum('journal_entry_status', [
  'draft',
  'posted',
  'reversed',
]);

export const expenseClaimStatusEnum = pgEnum('expense_claim_status', [
  'draft',
  'submitted',
  'approved',
  'rejected',
  'paid',
]);

// ─────────────────────────────────────────────────────────────────────────────────────
// Chart of accounts
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * One account in the institution's chart.
 *
 * The chart is a tree: header accounts (`is_postable = false`) group and subtotal, leaf
 * accounts take postings. `is_system` marks accounts other modules post to automatically
 * (the fees cash account, the payroll salary expense); they cannot be archived or retyped by
 * hand while anything depends on them. `is_cash_equivalent` marks cash and bank accounts, and
 * is what makes the indirect cash-flow statement computable rather than guessed.
 */
export const chartOfAccounts = pgTable(
  'chart_of_accounts',
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
    type: accountTypeEnum('type').notNull(),
    parentAccountId: uuid('parent_account_id').references((): AnyPgColumn => chartOfAccounts.id, {
      onDelete: 'restrict',
    }),
    normalBalance: accountNormalBalanceEnum('normal_balance').notNull(),
    /** Only leaf accounts take journal lines; the database refuses a line on a header. */
    isPostable: boolean('is_postable').notNull().default(true),
    /** Managed by a module (fees, payroll); protected from casual archive or retype. */
    isSystem: boolean('is_system').notNull().default(false),
    /** Cash or bank. Drives the cash-flow statement's definition of "cash". */
    isCashEquivalent: boolean('is_cash_equivalent').notNull().default(false),
    status: accountStatusEnum('status').notNull().default('active'),
    description: varchar('description', { length: 500 }),
    sortOrder: smallint('sort_order').notNull().default(0),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('chart_of_accounts_institution_code_key')
      .on(table.institutionId, table.code)
      .where(sql`${table.archivedAt} IS NULL`),
    index('chart_of_accounts_tenant_idx').on(table.tenantId),
    index('chart_of_accounts_institution_type_idx').on(table.institutionId, table.type),
    index('chart_of_accounts_parent_idx').on(table.parentAccountId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Fiscal years and periods
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * One financial year. Kept separate from `academic_years` because in Bangladesh they
 * genuinely differ: the academic year is January–December while a school's financial year is
 * commonly July–June, and neither should have to lie to accommodate the other.
 */
export const fiscalYears = pgTable(
  'fiscal_years',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    name: varchar('name', { length: 64 }).notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    status: fiscalYearStatusEnum('status').notNull().default('open'),
    closedBy: uuid('closed_by'),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
    /** A reopen is a documented, higher-permission act; who and why are part of the record. */
    reopenedBy: uuid('reopened_by'),
    reopenedAt: timestamp('reopened_at', { withTimezone: true, mode: 'date' }),
    reopenReason: varchar('reopen_reason', { length: 1000 }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('fiscal_years_institution_name_key')
      .on(table.institutionId, table.name)
      .where(sql`${table.archivedAt} IS NULL`),
    index('fiscal_years_tenant_idx').on(table.tenantId),
    index('fiscal_years_institution_status_idx').on(table.institutionId, table.status),
  ],
);

/**
 * One posting period inside a fiscal year — usually a month.
 *
 * Every journal entry belongs to exactly one period, and a closed period accepts nothing:
 * the refusal is a database trigger, not a service convention. Closing is audited;
 * reopening exists but requires a documented reason and a higher permission.
 */
export const accountingPeriods = pgTable(
  'accounting_periods',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    fiscalYearId: uuid('fiscal_year_id')
      .notNull()
      .references(() => fiscalYears.id, { onDelete: 'restrict' }),
    name: varchar('name', { length: 64 }).notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    status: accountingPeriodStatusEnum('status').notNull().default('open'),
    closedBy: uuid('closed_by'),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
    reopenedBy: uuid('reopened_by'),
    reopenedAt: timestamp('reopened_at', { withTimezone: true, mode: 'date' }),
    reopenReason: varchar('reopen_reason', { length: 1000 }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('accounting_periods_year_name_key')
      .on(table.fiscalYearId, table.name)
      .where(sql`${table.archivedAt} IS NULL`),
    index('accounting_periods_tenant_idx').on(table.tenantId),
    index('accounting_periods_year_idx').on(table.fiscalYearId),
    index('accounting_periods_institution_dates_idx').on(table.institutionId, table.startDate),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Journal
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * One journal entry — the atomic unit of the ledger.
 *
 * `entry_number` is sequential per institution (`JE-2026-000042`), with the unique index as
 * the real guarantee. `reference_type`/`reference_id` point back at whatever caused the
 * entry (a fee payment, an expense claim) without a foreign key, because the ledger outlives
 * and predates every module that posts to it. `is_system_generated` entries are created and
 * posted by module code through `LedgerService.post` and are never editable by hand.
 */
export const journalEntries = pgTable(
  'journal_entries',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    entryNumber: varchar('entry_number', { length: 32 }).notNull(),
    periodId: uuid('period_id')
      .notNull()
      .references(() => accountingPeriods.id, { onDelete: 'restrict' }),
    entryDate: date('entry_date').notNull(),
    description: varchar('description', { length: 500 }).notNull(),
    /** What caused this entry: 'fee_payment', 'expense_claim', 'manual', … */
    referenceType: varchar('reference_type', { length: 64 }),
    referenceId: uuid('reference_id'),
    status: journalEntryStatusEnum('status').notNull().default('draft'),
    postedBy: uuid('posted_by'),
    postedAt: timestamp('posted_at', { withTimezone: true, mode: 'date' }),
    /** The mirror entry that cancelled this one. Set exactly when status is `reversed`. */
    reversedByEntryId: uuid('reversed_by_entry_id').references(
      (): AnyPgColumn => journalEntries.id,
      { onDelete: 'restrict' },
    ),
    isSystemGenerated: boolean('is_system_generated').notNull().default(false),
    /** Which module produced the entry: 'accounting' for manual work, 'fees', 'payroll', … */
    sourceModule: varchar('source_module', { length: 32 }).notNull().default('accounting'),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    // Not partial: an entry number is never reused, archived or not.
    uniqueIndex('journal_entries_institution_number_key').on(
      table.institutionId,
      table.entryNumber,
    ),
    index('journal_entries_tenant_idx').on(table.tenantId),
    index('journal_entries_period_idx').on(table.periodId),
    index('journal_entries_institution_status_idx').on(
      table.institutionId,
      table.status,
      table.entryDate,
    ),
    index('journal_entries_reference_idx').on(table.referenceType, table.referenceId),
    index('journal_entries_date_idx').on(table.institutionId, table.entryDate),
  ],
);

/**
 * One side of one entry: a debit **or** a credit against one postable account.
 *
 * The XOR is a check constraint; the balance across an entry's lines is a deferred
 * constraint trigger; the immutability of a posted entry's lines is a trigger. A pure child
 * row: no `version` (lines of a draft are replaced as a set; lines of a posted entry never
 * change at all).
 */
export const journalLines = pgTable(
  'journal_lines',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => chartOfAccounts.id, { onDelete: 'restrict' }),
    debit: numeric('debit', { precision: 14, scale: 2 }).notNull().default('0.00'),
    credit: numeric('credit', { precision: 14, scale: 2 }).notNull().default('0.00'),
    description: varchar('description', { length: 255 }),
    costCentreId: uuid('cost_centre_id').references((): AnyPgColumn => costCentres.id, {
      onDelete: 'restrict',
    }),
    sortOrder: smallint('sort_order').notNull().default(0),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('journal_lines_tenant_idx').on(table.tenantId),
    index('journal_lines_entry_idx').on(table.entryId),
    index('journal_lines_account_idx').on(table.accountId),
    index('journal_lines_cost_centre_idx').on(table.costCentreId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Cost centres and budgets
// ─────────────────────────────────────────────────────────────────────────────────────

/** A dimension for slicing spend: a campus, a department, a project. A tree, like the CoA. */
export const costCentres = pgTable(
  'cost_centres',
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
    parentId: uuid('parent_id').references((): AnyPgColumn => costCentres.id, {
      onDelete: 'restrict',
    }),
    description: varchar('description', { length: 500 }),
    sortOrder: smallint('sort_order').notNull().default(0),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('cost_centres_institution_code_key')
      .on(table.institutionId, table.code)
      .where(sql`${table.archivedAt} IS NULL`),
    index('cost_centres_tenant_idx').on(table.tenantId),
    index('cost_centres_parent_idx').on(table.parentId),
  ],
);

/**
 * A planned amount for one account (optionally one cost centre) in one fiscal year.
 *
 * Postgres treats NULLs as distinct in the unique index, so two "whole institution" budgets
 * for the same account could coexist; the service refuses that case explicitly, the same way
 * `fee_concessions` handles its all-heads rows.
 */
export const budgets = pgTable(
  'budgets',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    fiscalYearId: uuid('fiscal_year_id')
      .notNull()
      .references(() => fiscalYears.id, { onDelete: 'restrict' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => chartOfAccounts.id, { onDelete: 'restrict' }),
    costCentreId: uuid('cost_centre_id').references(() => costCentres.id, {
      onDelete: 'restrict',
    }),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    note: varchar('note', { length: 500 }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('budgets_year_account_key')
      .on(table.fiscalYearId, table.accountId, table.costCentreId)
      .where(sql`${table.archivedAt} IS NULL`),
    index('budgets_tenant_idx').on(table.tenantId),
    index('budgets_year_idx').on(table.fiscalYearId),
    index('budgets_account_idx').on(table.accountId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Expense claims
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * An employee's claim for money spent on the school's behalf.
 *
 * draft → submitted → approved | rejected, then approved → paid. Approval is a separate
 * permission from creation and the service refuses a self-approval. Paying a claim posts a
 * journal entry (expense against cash) in the same transaction and links it, so the claim
 * and its ledger effect commit together or not at all.
 *
 * `workflow_request_id` is a bare uuid — see the module comment at the top of this file.
 */
export const expenseClaims = pgTable(
  'expense_claims',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    claimNumber: varchar('claim_number', { length: 32 }).notNull(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    /** Free text a school chooses ('travel', 'stationery'), not an enum — schools invent these. */
    category: varchar('category', { length: 64 }).notNull(),
    description: varchar('description', { length: 1000 }).notNull(),
    expenseDate: date('expense_date').notNull(),
    status: expenseClaimStatusEnum('status').notNull().default('draft'),

    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' }),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    decisionNote: varchar('decision_note', { length: 1000 }),
    paidBy: uuid('paid_by'),
    paidAt: timestamp('paid_at', { withTimezone: true, mode: 'date' }),
    /** The ledger entry that recorded the payout. Set exactly when the claim is `paid`. */
    paymentJournalEntryId: uuid('payment_journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    /** Set when the workflow engine picks the claim up. No FK — see the module comment. */
    workflowRequestId: uuid('workflow_request_id'),

    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('expense_claims_institution_number_key').on(table.institutionId, table.claimNumber),
    index('expense_claims_tenant_idx').on(table.tenantId),
    index('expense_claims_employee_idx').on(table.employeeId, table.status),
    index('expense_claims_institution_status_idx').on(table.institutionId, table.status),
    index('expense_claims_workflow_idx').on(table.workflowRequestId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────

export const chartOfAccountsRelations = relations(chartOfAccounts, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [chartOfAccounts.institutionId],
    references: [institutions.id],
  }),
  parent: one(chartOfAccounts, {
    fields: [chartOfAccounts.parentAccountId],
    references: [chartOfAccounts.id],
    relationName: 'account_parent',
  }),
  children: many(chartOfAccounts, { relationName: 'account_parent' }),
  lines: many(journalLines),
  budgets: many(budgets),
}));

export const fiscalYearsRelations = relations(fiscalYears, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [fiscalYears.institutionId],
    references: [institutions.id],
  }),
  periods: many(accountingPeriods),
  budgets: many(budgets),
}));

export const accountingPeriodsRelations = relations(accountingPeriods, ({ one, many }) => ({
  fiscalYear: one(fiscalYears, {
    fields: [accountingPeriods.fiscalYearId],
    references: [fiscalYears.id],
  }),
  entries: many(journalEntries),
}));

export const journalEntriesRelations = relations(journalEntries, ({ one, many }) => ({
  period: one(accountingPeriods, {
    fields: [journalEntries.periodId],
    references: [accountingPeriods.id],
  }),
  reversedByEntry: one(journalEntries, {
    fields: [journalEntries.reversedByEntryId],
    references: [journalEntries.id],
    relationName: 'entry_reversal',
  }),
  lines: many(journalLines),
}));

export const journalLinesRelations = relations(journalLines, ({ one }) => ({
  entry: one(journalEntries, {
    fields: [journalLines.entryId],
    references: [journalEntries.id],
  }),
  account: one(chartOfAccounts, {
    fields: [journalLines.accountId],
    references: [chartOfAccounts.id],
  }),
  costCentre: one(costCentres, {
    fields: [journalLines.costCentreId],
    references: [costCentres.id],
  }),
}));

export const costCentresRelations = relations(costCentres, ({ one, many }) => ({
  parent: one(costCentres, {
    fields: [costCentres.parentId],
    references: [costCentres.id],
    relationName: 'cost_centre_parent',
  }),
  children: many(costCentres, { relationName: 'cost_centre_parent' }),
  lines: many(journalLines),
}));

export const budgetsRelations = relations(budgets, ({ one }) => ({
  fiscalYear: one(fiscalYears, {
    fields: [budgets.fiscalYearId],
    references: [fiscalYears.id],
  }),
  account: one(chartOfAccounts, {
    fields: [budgets.accountId],
    references: [chartOfAccounts.id],
  }),
  costCentre: one(costCentres, {
    fields: [budgets.costCentreId],
    references: [costCentres.id],
  }),
}));

export const expenseClaimsRelations = relations(expenseClaims, ({ one }) => ({
  employee: one(employees, {
    fields: [expenseClaims.employeeId],
    references: [employees.id],
  }),
  paymentJournalEntry: one(journalEntries, {
    fields: [expenseClaims.paymentJournalEntryId],
    references: [journalEntries.id],
  }),
}));
