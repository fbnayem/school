/**
 * Accounting schemas (Phase 13).
 *
 * The two rules that shape every schema in this file:
 *
 *  - **Money crosses the wire as a decimal string, never a number** (ADR-004). A journal
 *    line's `debit` and `credit` are `positiveMoneySchema` strings; the exact-balance rule
 *    is restated here with `bigint` minor-unit arithmetic purely so the error lands on the
 *    right field — the authoritative checks are the service's `Money` arithmetic and the
 *    database's deferred balance trigger.
 *  - **A client never states a derived fact.** There is no `status` on a journal entry
 *    schema, no `entryNumber`, no `postedAt`, no `periodId` (the service resolves the
 *    period from the entry date), and no `claimNumber`. Posting, reversing, closing and
 *    reopening are explicit endpoints, not fields.
 *
 * Constants carry an `ACCOUNTING_`/`COA_`/`JOURNAL_` prefix because `@shikkha/validation`
 * re-exports flat.
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

const code = (max: number) =>
  z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]+$/, 'Use letters, numbers, hyphens and underscores only')
    .min(1)
    .max(max);

const nameEn = z.string().trim().min(1).max(128);
const nameBn = z.string().trim().max(128).optional();

// ── Value sets, mirrored from the database enums ─────────────────────────────────────

export const COA_ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;

export const COA_NORMAL_BALANCES = ['debit', 'credit'] as const;

export const COA_ACCOUNT_STATUSES = ['active', 'archived'] as const;

export const FISCAL_YEAR_STATUSES = ['open', 'closed'] as const;

export const ACCOUNTING_PERIOD_STATUSES = ['open', 'closed'] as const;

export const JOURNAL_ENTRY_STATUSES = ['draft', 'posted', 'reversed'] as const;

export const EXPENSE_CLAIM_STATUSES = [
  'draft',
  'submitted',
  'approved',
  'rejected',
  'paid',
] as const;

export const COA_SORT_FIELDS = ['code', 'nameEn', 'type', 'sortOrder', 'createdAt'] as const;

export const FISCAL_YEAR_SORT_FIELDS = ['name', 'startDate', 'status', 'createdAt'] as const;

export const JOURNAL_ENTRY_SORT_FIELDS = [
  'entryNumber',
  'entryDate',
  'status',
  'createdAt',
] as const;

export const COST_CENTRE_SORT_FIELDS = ['code', 'nameEn', 'sortOrder', 'createdAt'] as const;

export const BUDGET_SORT_FIELDS = ['amount', 'createdAt'] as const;

export const EXPENSE_CLAIM_SORT_FIELDS = [
  'claimNumber',
  'expenseDate',
  'amount',
  'status',
  'createdAt',
] as const;

// ── Chart of accounts ────────────────────────────────────────────────────────────────

export const createAccountSchema = z.object({
  code: code(32),
  nameEn,
  nameBn,
  type: z.enum(COA_ACCOUNT_TYPES),
  /** Omit for a top-level account. The parent must be a header of the same type. */
  parentAccountId: uuidSchema.optional(),
  normalBalance: z.enum(COA_NORMAL_BALANCES),
  /** Header accounts group and subtotal; only leaves take journal lines. */
  isPostable: z.boolean().default(true),
  /** Cash or bank. Drives what the cash-flow statement treats as cash. */
  isCashEquivalent: z.boolean().default(false),
  description: z.string().trim().max(500).optional(),
  sortOrder: z.coerce.number().int().min(0).max(999).default(0),
});

export type CreateAccountInput = z.infer<typeof createAccountSchema>;

export const updateAccountSchema = z
  .object({
    nameEn: nameEn.optional(),
    nameBn: z.string().trim().max(128).nullable().optional(),
    parentAccountId: uuidSchema.nullable().optional(),
    isCashEquivalent: z.boolean().optional(),
    description: z.string().trim().max(500).nullable().optional(),
    sortOrder: z.coerce.number().int().min(0).max(999).optional(),
    /** Optimistic lock. Rejecting a stale write beats silently overwriting a colleague. */
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, {
    message: 'No changes were submitted',
  });

export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;

export const listAccountsSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    type: z.enum(COA_ACCOUNT_TYPES).optional(),
    postableOnly: z.coerce.boolean().default(false),
    includeArchived: z.coerce.boolean().default(false),
  });

export const archiveAccountSchema = z.object({ reason: reasonSchema });

// ── Fiscal years and periods ─────────────────────────────────────────────────────────

/**
 * Creating a fiscal year also lays out its posting periods, so a school cannot end up with
 * a year whose middle months silently have nowhere to post.
 */
export const createFiscalYearSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    startDate: calendarDateSchema,
    endDate: calendarDateSchema,
    /** How to cut the year into periods. `single` makes the whole year one period. */
    periodLayout: z.enum(['monthly', 'quarterly', 'single']).default('monthly'),
  })
  .refine((data) => data.endDate >= data.startDate, {
    message: 'The fiscal year cannot end before it starts',
    path: ['endDate'],
  });

export type CreateFiscalYearInput = z.infer<typeof createFiscalYearSchema>;

export const listFiscalYearsSchema = paginationSchema.merge(sortSchema).extend({
  status: z.enum(FISCAL_YEAR_STATUSES).optional(),
  includeArchived: z.coerce.boolean().default(false),
});

/** Closing is audited and reason-carrying; reopening additionally needs a higher permission. */
export const closeFiscalYearSchema = z.object({ reason: reasonSchema });
export const reopenFiscalYearSchema = z.object({ reason: reasonSchema });
export const closePeriodSchema = z.object({ reason: reasonSchema });
export const reopenPeriodSchema = z.object({ reason: reasonSchema });

// ── Journal entries ──────────────────────────────────────────────────────────────────

/**
 * Sum a positive-money decimal string in minor units without ever touching a float.
 * Restates the service's authoritative `Money` check so the error attaches to the field.
 */
const toMinor = (value: string): bigint => {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2) || '0');
};

export const journalLineInputSchema = z
  .object({
    accountId: uuidSchema,
    /** Exactly one of `debit` and `credit` must be present and positive. */
    debit: positiveMoneySchema.optional(),
    credit: positiveMoneySchema.optional(),
    description: z.string().trim().max(255).optional(),
    costCentreId: uuidSchema.optional(),
  })
  .superRefine((line, ctx) => {
    const hasDebit = line.debit !== undefined && toMinor(line.debit) > 0n;
    const hasCredit = line.credit !== undefined && toMinor(line.credit) > 0n;
    if (hasDebit === hasCredit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['debit'],
        message: 'Each line must carry exactly one of a positive debit or a positive credit',
      });
    }
  });

export type JournalLineInput = z.infer<typeof journalLineInputSchema>;

const journalLinesBalanced = (lines: readonly JournalLineInput[], ctx: z.RefinementCtx): void => {
  let debits = 0n;
  let credits = 0n;
  for (const line of lines) {
    if (line.debit) debits += toMinor(line.debit);
    if (line.credit) credits += toMinor(line.credit);
  }
  if (debits !== credits) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['lines'],
      message: 'The entry does not balance: total debits must equal total credits',
    });
  }
};

/**
 * A manual journal entry, created as a draft. There is no `status`, `entryNumber` or
 * `periodId` here — the number is generated, the period is resolved from the date, and
 * posting is a separate, separately-permissioned endpoint.
 */
export const createJournalEntrySchema = z
  .object({
    entryDate: calendarDateSchema,
    description: z.string().trim().min(3).max(500),
    referenceType: z.string().trim().max(64).optional(),
    referenceId: uuidSchema.optional(),
    lines: z.array(journalLineInputSchema).min(2, 'An entry needs at least two lines').max(200),
  })
  .superRefine((data, ctx) => journalLinesBalanced(data.lines, ctx));

export type CreateJournalEntryInput = z.infer<typeof createJournalEntrySchema>;

/** Editing a draft replaces its lines as a complete set. Posted entries refuse this. */
export const updateJournalEntrySchema = z
  .object({
    entryDate: calendarDateSchema.optional(),
    description: z.string().trim().min(3).max(500).optional(),
    referenceType: z.string().trim().max(64).nullable().optional(),
    referenceId: uuidSchema.nullable().optional(),
    lines: z
      .array(journalLineInputSchema)
      .min(2, 'An entry needs at least two lines')
      .max(200)
      .optional(),
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, {
    message: 'No changes were submitted',
  })
  .superRefine((data, ctx) => {
    if (data.lines) journalLinesBalanced(data.lines, ctx);
  });

export type UpdateJournalEntryInput = z.infer<typeof updateJournalEntrySchema>;

export const postJournalEntrySchema = z.object({
  /** Optimistic lock: posting what someone else just edited must fail loudly. */
  version: z.number().int().min(1),
});

export const reverseJournalEntrySchema = z.object({
  reason: reasonSchema,
  /** The date of the reversing entry. Defaults to today; must fall in an open period. */
  entryDate: calendarDateSchema.optional(),
  version: z.number().int().min(1),
});

export const listJournalEntriesSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    status: z.enum(JOURNAL_ENTRY_STATUSES).optional(),
    periodId: uuidSchema.optional(),
    fiscalYearId: uuidSchema.optional(),
    accountId: uuidSchema.optional(),
    sourceModule: z.string().trim().max(32).optional(),
    referenceType: z.string().trim().max(64).optional(),
    referenceId: uuidSchema.optional(),
    dateFrom: calendarDateSchema.optional(),
    dateTo: calendarDateSchema.optional(),
    includeArchived: z.coerce.boolean().default(false),
  });

// ── Cost centres ─────────────────────────────────────────────────────────────────────

export const createCostCentreSchema = z.object({
  code: code(32),
  nameEn,
  nameBn,
  parentId: uuidSchema.optional(),
  description: z.string().trim().max(500).optional(),
  sortOrder: z.coerce.number().int().min(0).max(999).default(0),
});

export type CreateCostCentreInput = z.infer<typeof createCostCentreSchema>;

export const updateCostCentreSchema = z
  .object({
    nameEn: nameEn.optional(),
    nameBn: z.string().trim().max(128).nullable().optional(),
    parentId: uuidSchema.nullable().optional(),
    description: z.string().trim().max(500).nullable().optional(),
    sortOrder: z.coerce.number().int().min(0).max(999).optional(),
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, {
    message: 'No changes were submitted',
  });

export const listCostCentresSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    includeArchived: z.coerce.boolean().default(false),
  });

export const archiveCostCentreSchema = z.object({ reason: reasonSchema });

// ── Budgets ──────────────────────────────────────────────────────────────────────────

export const createBudgetSchema = z.object({
  fiscalYearId: uuidSchema,
  accountId: uuidSchema,
  /** Omit for an institution-wide budget on the account. */
  costCentreId: uuidSchema.optional(),
  amount: positiveMoneySchema,
  note: z.string().trim().max(500).optional(),
});

export type CreateBudgetInput = z.infer<typeof createBudgetSchema>;

export const updateBudgetSchema = z
  .object({
    amount: positiveMoneySchema.optional(),
    note: z.string().trim().max(500).nullable().optional(),
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, {
    message: 'No changes were submitted',
  });

export const listBudgetsSchema = paginationSchema.merge(sortSchema).extend({
  fiscalYearId: uuidSchema.optional(),
  accountId: uuidSchema.optional(),
  costCentreId: uuidSchema.optional(),
  includeArchived: z.coerce.boolean().default(false),
});

export const archiveBudgetSchema = z.object({ reason: reasonSchema });

// ── Expense claims ───────────────────────────────────────────────────────────────────

export const createExpenseClaimSchema = z.object({
  employeeId: uuidSchema,
  amount: positiveMoneySchema,
  category: z.string().trim().min(1).max(64),
  description: z.string().trim().min(3).max(1000),
  expenseDate: calendarDateSchema,
});

export type CreateExpenseClaimInput = z.infer<typeof createExpenseClaimSchema>;

export const updateExpenseClaimSchema = z
  .object({
    amount: positiveMoneySchema.optional(),
    category: z.string().trim().min(1).max(64).optional(),
    description: z.string().trim().min(3).max(1000).optional(),
    expenseDate: calendarDateSchema.optional(),
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, {
    message: 'No changes were submitted',
  });

export const submitExpenseClaimSchema = z.object({
  version: z.number().int().min(1),
});

/** Approve or reject. The reason carries into the audit record either way. */
export const decideExpenseClaimSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reason: reasonSchema,
});

export type DecideExpenseClaimInput = z.infer<typeof decideExpenseClaimSchema>;

/**
 * Paying an approved claim posts the ledger entry in the same transaction: debit the
 * expense account, credit the cash account. Both must be postable leaves.
 */
export const payExpenseClaimSchema = z.object({
  expenseAccountId: uuidSchema,
  cashAccountId: uuidSchema,
  version: z.number().int().min(1),
});

export type PayExpenseClaimInput = z.infer<typeof payExpenseClaimSchema>;

export const listExpenseClaimsSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    status: z.enum(EXPENSE_CLAIM_STATUSES).optional(),
    employeeId: uuidSchema.optional(),
    includeArchived: z.coerce.boolean().default(false),
  });

// ── Reports ──────────────────────────────────────────────────────────────────────────

export const trialBalanceQuerySchema = z.object({
  /** Include postings up to and including this date. Defaults to today in the service. */
  asOf: calendarDateSchema.optional(),
});

export const generalLedgerQuerySchema = z.object({
  accountId: uuidSchema,
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
});

export const accountStatementQuerySchema = z
  .object({
    from: calendarDateSchema,
    to: calendarDateSchema,
  })
  .refine((data) => data.to >= data.from, {
    message: 'The end of the range cannot be before its start',
    path: ['to'],
  });

export const incomeStatementQuerySchema = z
  .object({
    from: calendarDateSchema,
    to: calendarDateSchema,
    costCentreId: uuidSchema.optional(),
  })
  .refine((data) => data.to >= data.from, {
    message: 'The end of the range cannot be before its start',
    path: ['to'],
  });

export const balanceSheetQuerySchema = z.object({
  asOf: calendarDateSchema.optional(),
});

export const cashFlowQuerySchema = z
  .object({
    from: calendarDateSchema,
    to: calendarDateSchema,
  })
  .refine((data) => data.to >= data.from, {
    message: 'The end of the range cannot be before its start',
    path: ['to'],
  });

export const budgetVsActualQuerySchema = z.object({
  fiscalYearId: uuidSchema,
  costCentreId: uuidSchema.optional(),
});
