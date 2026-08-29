/**
 * Payroll schemas (Phase 16).
 *
 * The two rules that shape everything here, inherited from the fees and HR modules:
 *
 *  - **Money crosses the wire as a decimal string, never a number** (ADR-004). Adjustment
 *    amounts, loan principals and instalments use `positiveMoneySchema`; the service parses
 *    them with `Money.fromDecimalString` and nothing else.
 *  - **A client never states a derived fact.** There is no `status`, no `gross`, no `net`,
 *    no totals anywhere in these schemas — a payslip is computed by the service from the
 *    salary assignment, the structure's components in sequence order, attendance,
 *    adjustments and loan instalments. The only figures a client may send are the inputs
 *    a human genuinely decides: an adjustment amount, a loan principal, an instalment.
 */

import { z } from 'zod';
import {
  calendarDateSchema,
  paginationSchema,
  positiveMoneySchema,
  reasonSchema,
  searchSchema,
  sortSchema,
  uuidSchema,
} from './common';

const nameField = z.string().trim().min(1).max(128);

// ── Value sets, mirrored from the database enums ─────────────────────────────────────

export const PAYROLL_RUN_STATUSES = [
  'draft',
  'calculated',
  'under_review',
  'approved',
  'paid',
  'cancelled',
] as const;

export const PAYSLIP_PAYMENT_STATUSES = ['pending', 'paid', 'failed'] as const;

export const PAYROLL_LINE_KINDS = ['earning', 'deduction'] as const;

export const LOAN_ADVANCE_STATUSES = ['active', 'settled', 'cancelled'] as const;

export const PAYROLL_RUN_SORT_FIELDS = [
  'periodYear',
  'periodMonth',
  'status',
  'createdAt',
] as const;

export const LOAN_ADVANCE_SORT_FIELDS = ['startYear', 'startMonth', 'status', 'createdAt'] as const;

const periodYearSchema = z.coerce.number().int().min(2000).max(2100);
const periodMonthSchema = z.coerce.number().int().min(1).max(12);
const versionSchema = z.number().int().min(1);

// ── Payroll runs ─────────────────────────────────────────────────────────────────────

export const createPayrollRunSchema = z.object({
  periodYear: periodYearSchema,
  periodMonth: periodMonthSchema,
  /** Left blank, the service names the run "Payroll YYYY-MM". */
  name: nameField.optional(),
});
export type CreatePayrollRunInput = z.infer<typeof createPayrollRunSchema>;

export const listPayrollRunsSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    status: z.enum(PAYROLL_RUN_STATUSES).optional(),
    periodYear: periodYearSchema.optional(),
  });
export type ListPayrollRunsQuery = z.infer<typeof listPayrollRunsSchema>;

/** Calculate, recalculate and submit carry only the optimistic-locking version. */
export const payrollRunVersionSchema = z.object({ version: versionSchema });
export type PayrollRunVersionInput = z.infer<typeof payrollRunVersionSchema>;

export const approvePayrollRunSchema = z.object({ version: versionSchema });
export type ApprovePayrollRunInput = z.infer<typeof approvePayrollRunSchema>;

export const cancelPayrollRunSchema = z.object({
  reason: reasonSchema,
  version: versionSchema,
});
export type CancelPayrollRunInput = z.infer<typeof cancelPayrollRunSchema>;

/**
 * Marking a run paid posts one balanced entry to the ledger, so the caller names the
 * accounts: debit salary expense for the gross, credit the deductions payable for the
 * withheld total (required whenever the run has deductions), credit cash/bank for the net.
 */
export const markPayrollRunPaidSchema = z.object({
  version: versionSchema,
  /** Date of the journal entry; must fall inside an open accounting period. */
  entryDate: calendarDateSchema.optional(),
  expenseAccountId: uuidSchema,
  paymentAccountId: uuidSchema,
  deductionsPayableAccountId: uuidSchema.optional(),
});
export type MarkPayrollRunPaidInput = z.infer<typeof markPayrollRunPaidSchema>;

// ── Adjustments ──────────────────────────────────────────────────────────────────────

export const createPayrollAdjustmentSchema = z.object({
  employeeId: uuidSchema,
  kind: z.enum(PAYROLL_LINE_KINDS),
  name: nameField,
  amount: positiveMoneySchema,
  reason: reasonSchema,
});
export type CreatePayrollAdjustmentInput = z.infer<typeof createPayrollAdjustmentSchema>;

export const updatePayrollAdjustmentSchema = z
  .object({
    kind: z.enum(PAYROLL_LINE_KINDS).optional(),
    name: nameField.optional(),
    amount: positiveMoneySchema.optional(),
    reason: reasonSchema.optional(),
    version: versionSchema,
  })
  .refine((data) => Object.keys(data).length > 1, { message: 'No changes were submitted' });
export type UpdatePayrollAdjustmentInput = z.infer<typeof updatePayrollAdjustmentSchema>;

export const archivePayrollAdjustmentSchema = z.object({ reason: reasonSchema });

// ── Loans and advances ───────────────────────────────────────────────────────────────

export const createLoanAdvanceSchema = z.object({
  employeeId: uuidSchema,
  principal: positiveMoneySchema,
  instalment: positiveMoneySchema,
  startYear: periodYearSchema,
  startMonth: periodMonthSchema,
  notes: z.string().trim().max(500).optional(),
});
export type CreateLoanAdvanceInput = z.infer<typeof createLoanAdvanceSchema>;

export const updateLoanAdvanceSchema = z
  .object({
    instalment: positiveMoneySchema.optional(),
    notes: z.string().trim().max(500).nullable().optional(),
    version: versionSchema,
  })
  .refine((data) => Object.keys(data).length > 1, { message: 'No changes were submitted' });
export type UpdateLoanAdvanceInput = z.infer<typeof updateLoanAdvanceSchema>;

export const cancelLoanAdvanceSchema = z.object({
  reason: reasonSchema,
  version: versionSchema,
});
export type CancelLoanAdvanceInput = z.infer<typeof cancelLoanAdvanceSchema>;

export const listLoanAdvancesSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    employeeId: uuidSchema.optional(),
    status: z.enum(LOAN_ADVANCE_STATUSES).optional(),
  });
export type ListLoanAdvancesQuery = z.infer<typeof listLoanAdvancesSchema>;

// ── Payslips ─────────────────────────────────────────────────────────────────────────

export const listMyPayslipsSchema = paginationSchema.extend({
  periodYear: periodYearSchema.optional(),
});
export type ListMyPayslipsQuery = z.infer<typeof listMyPayslipsSchema>;
