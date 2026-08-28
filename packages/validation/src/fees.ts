/**
 * Fee management schemas (Phase 11).
 *
 * Two rules shape everything here:
 *
 *  - **Money crosses the wire as a decimal string, never a number** (ADR-004). `moneySchema`
 *    and `positiveMoneySchema` are regexes over strings precisely so a client cannot send
 *    `1234.5600000001` and cannot lose a poisa to JSON's binary floats on the way in.
 *  - **A client never states a derived fact.** There is no `status` on an invoice schema, no
 *    `total`, no `balance`, and no `paidTotal`. Those are computed by the service from the
 *    lines and the allocations; accepting them would make the arithmetic advisory.
 *
 * Percentages that are not money — a 12.5% sibling concession, a 2% late fine — are also
 * decimal strings with two places, and are read as basis points (`"12.50"` is 1250bp). That
 * keeps every proportional calculation in integer arithmetic from the wire to the database.
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

export const FEE_HEAD_TYPES = [
  'tuition',
  'admission',
  'exam',
  'transport',
  'library',
  'lab',
  'development',
  'hostel',
  'fine',
  'other',
] as const;

export const FEE_FREQUENCIES = [
  'one_time',
  'monthly',
  'quarterly',
  'half_yearly',
  'annual',
] as const;

export const FEE_STRUCTURE_STATUSES = ['draft', 'active', 'archived'] as const;

export const FEE_CONCESSION_TYPES = ['percentage', 'fixed'] as const;

export const FEE_CONCESSION_STATUSES = ['pending', 'approved', 'rejected'] as const;

export const INVOICE_STATUSES = [
  'draft',
  'issued',
  'partially_paid',
  'paid',
  'overdue',
  'void',
] as const;

/** Named with the `FEE_` prefix because `@shikkha/validation` re-exports flat. */
export const FEE_PAYMENT_METHODS = [
  'cash',
  'bank_transfer',
  'cheque',
  'bkash',
  'nagad',
  'rocket',
  'card',
  'online',
] as const;

export const FEE_PAYMENT_STATUSES = ['pending', 'completed', 'failed', 'reversed'] as const;

/** Late-fine rules a structure can carry. `none` is the default and charges nobody. */
export const LATE_FINE_KINDS = ['none', 'fixed', 'percentage'] as const;

export const FEE_HEAD_SORT_FIELDS = ['code', 'nameEn', 'type', 'sortOrder', 'createdAt'] as const;

export const FEE_STRUCTURE_SORT_FIELDS = [
  'nameEn',
  'status',
  'effectiveFrom',
  'createdAt',
] as const;

export const INVOICE_SORT_FIELDS = [
  'invoiceNumber',
  'issueDate',
  'dueDate',
  'total',
  'balance',
  'status',
  'createdAt',
] as const;

export const PAYMENT_SORT_FIELDS = [
  'receiptNumber',
  'receivedAt',
  'amount',
  'method',
  'createdAt',
] as const;

export const FEE_CONCESSION_SORT_FIELDS = ['status', 'validFrom', 'createdAt'] as const;

// ── Fee heads ────────────────────────────────────────────────────────────────────────

export const createFeeHeadSchema = z.object({
  code: code(32),
  nameEn,
  nameBn,
  type: z.enum(FEE_HEAD_TYPES).default('other'),
  isRecurring: z.boolean().default(false),
  isRefundable: z.boolean().default(true),
  /** Reserved for Phase 13. Free-form so a school's existing chart of accounts fits. */
  ledgerAccountCode: z.string().trim().max(32).optional(),
  description: z.string().trim().max(500).optional(),
  sortOrder: z.coerce.number().int().min(0).max(999).default(0),
});

export type CreateFeeHeadInput = z.infer<typeof createFeeHeadSchema>;

export const updateFeeHeadSchema = z
  .object({
    nameEn: nameEn.optional(),
    nameBn: z.string().trim().max(128).nullable().optional(),
    type: z.enum(FEE_HEAD_TYPES).optional(),
    isRecurring: z.boolean().optional(),
    isRefundable: z.boolean().optional(),
    ledgerAccountCode: z.string().trim().max(32).nullable().optional(),
    description: z.string().trim().max(500).nullable().optional(),
    sortOrder: z.coerce.number().int().min(0).max(999).optional(),
    /** Optimistic lock. Rejecting a stale write beats silently overwriting a colleague. */
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, {
    message: 'No changes were submitted',
  });

export type UpdateFeeHeadInput = z.infer<typeof updateFeeHeadSchema>;

export const listFeeHeadsSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    type: z.enum(FEE_HEAD_TYPES).optional(),
    includeArchived: z.coerce.boolean().default(false),
  });

export const archiveFeeHeadSchema = z.object({ reason: reasonSchema });

// ── Fee structures and their items ───────────────────────────────────────────────────

export const createFeeStructureSchema = z.object({
  campusId: uuidSchema,
  academicYearId: uuidSchema,
  /** Null or omitted means the structure applies to every class in the year. */
  classLevelId: uuidSchema.optional(),
  academicGroupId: uuidSchema.optional(),
  nameEn,
  nameBn,
  effectiveFrom: calendarDateSchema,
  lateFineKind: z.enum(LATE_FINE_KINDS).default('none'),
  /** An amount for `fixed`, a percentage for `percentage`. Ignored when the kind is `none`. */
  lateFineValue: positiveMoneySchema.default('0.00'),
  lateFineGraceDays: z.coerce.number().int().min(0).max(365).default(0),
  lateFineMaxAmount: positiveMoneySchema.optional(),
});

export type CreateFeeStructureInput = z.infer<typeof createFeeStructureSchema>;

export const updateFeeStructureSchema = z
  .object({
    nameEn: nameEn.optional(),
    nameBn: z.string().trim().max(128).nullable().optional(),
    /** `draft` → `active` publishes the price list; `archived` retires it. */
    status: z.enum(FEE_STRUCTURE_STATUSES).optional(),
    effectiveFrom: calendarDateSchema.optional(),
    classLevelId: uuidSchema.nullable().optional(),
    academicGroupId: uuidSchema.nullable().optional(),
    lateFineKind: z.enum(LATE_FINE_KINDS).optional(),
    lateFineValue: positiveMoneySchema.optional(),
    lateFineGraceDays: z.coerce.number().int().min(0).max(365).optional(),
    lateFineMaxAmount: positiveMoneySchema.nullable().optional(),
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, {
    message: 'No changes were submitted',
  })
  .refine(
    (data) =>
      data.lateFineKind !== 'percentage' ||
      data.lateFineValue === undefined ||
      Number.parseFloat(data.lateFineValue) <= 100,
    { message: 'A percentage fine cannot exceed 100', path: ['lateFineValue'] },
  );

export const listFeeStructuresSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    academicYearId: uuidSchema.optional(),
    classLevelId: uuidSchema.optional(),
    campusId: uuidSchema.optional(),
    status: z.enum(FEE_STRUCTURE_STATUSES).optional(),
    includeArchived: z.coerce.boolean().default(false),
  });

export const archiveFeeStructureSchema = z.object({ reason: reasonSchema });

/**
 * Items are submitted as a complete set, the way academic terms are.
 *
 * A partial patch would leave "did they mean to remove the transport fee, or did the client
 * simply not send it?" unanswerable, and the answer is the difference between a family being
 * billed and not being billed.
 */
export const replaceFeeStructureItemsSchema = z
  .object({
    items: z
      .array(
        z.object({
          /** Present for an item that already exists, so it is updated rather than replaced. */
          id: uuidSchema.optional(),
          feeHeadId: uuidSchema,
          amount: positiveMoneySchema,
          frequency: z.enum(FEE_FREQUENCIES).default('monthly'),
          dueDayOfMonth: z.coerce.number().int().min(1).max(31).optional(),
          isOptional: z.boolean().default(false),
          sortOrder: z.coerce.number().int().min(0).max(999).default(0),
        }),
      )
      .max(200),
  })
  .superRefine((data, ctx) => {
    const seen = new Set<string>();
    for (const item of data.items) {
      const key = `${item.feeHeadId}:${item.frequency}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items'],
          message:
            'The same fee head appears twice at the same frequency. Combine them into one line.',
        });
      }
      seen.add(key);
    }
  });

export type ReplaceFeeStructureItemsInput = z.infer<typeof replaceFeeStructureItemsSchema>;

/** Assign one structure to many students at once — the start-of-year bulk action. */
export const assignFeeStructureSchema = z
  .object({
    feeStructureId: uuidSchema,
    academicYearId: uuidSchema,
    studentIds: z.array(uuidSchema).min(1, 'Select at least one student').max(1000),
    effectiveFrom: calendarDateSchema,
    effectiveTo: calendarDateSchema.optional(),
    note: z.string().trim().max(500).optional(),
  })
  .refine((data) => !data.effectiveTo || data.effectiveTo >= data.effectiveFrom, {
    message: 'The end date cannot be before the start date',
    path: ['effectiveTo'],
  });

export type AssignFeeStructureInput = z.infer<typeof assignFeeStructureSchema>;

// ── Concessions ──────────────────────────────────────────────────────────────────────

/**
 * Requesting a concession. Note there is no `status` field: a request is always created
 * `pending`, and only `finance.discounts.approve` can move it.
 */
export const createFeeConcessionSchema = z
  .object({
    studentId: uuidSchema,
    /** Omit to apply the concession to every head on the invoice. */
    feeHeadId: uuidSchema.optional(),
    type: z.enum(FEE_CONCESSION_TYPES),
    /** A percentage for `percentage`, an amount for `fixed`. Both two-decimal strings. */
    value: positiveMoneySchema,
    reason: reasonSchema,
    validFrom: calendarDateSchema,
    validTo: calendarDateSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.type === 'percentage' && Number.parseFloat(data.value) > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'A percentage concession cannot exceed 100',
      });
    }
    if (data.validTo && data.validTo < data.validFrom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['validTo'],
        message: 'The end date cannot be before the start date',
      });
    }
  });

export type CreateFeeConcessionInput = z.infer<typeof createFeeConcessionSchema>;

/**
 * The approve/reject decision. `reason` is mandatory and carries into the audit record —
 * `requiresReason` on the route refuses the request before the handler runs.
 */
export const decideFeeConcessionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reason: reasonSchema,
});

export type DecideFeeConcessionInput = z.infer<typeof decideFeeConcessionSchema>;

export const listFeeConcessionsSchema = paginationSchema.merge(sortSchema).extend({
  studentId: uuidSchema.optional(),
  feeHeadId: uuidSchema.optional(),
  status: z.enum(FEE_CONCESSION_STATUSES).optional(),
  includeArchived: z.coerce.boolean().default(false),
});

// ── Invoice generation ───────────────────────────────────────────────────────────────

/**
 * One generation run.
 *
 * The same schema serves the preview and the commit, so what an accountant approves on screen
 * is byte-for-byte the request that is then executed. The run is idempotent: a student who
 * already has a live invoice for this academic year and billing period is reported as skipped
 * rather than billed twice, and the database's partial unique index on `generation_key`
 * enforces that even against two concurrent runs.
 */
export const generateInvoicesSchema = z
  .object({
    academicYearId: uuidSchema,
    /** Narrow the run. At least one of these must be present. */
    sectionId: uuidSchema.optional(),
    classLevelId: uuidSchema.optional(),
    studentIds: z.array(uuidSchema).max(1000).optional(),

    billingPeriodStart: calendarDateSchema,
    billingPeriodEnd: calendarDateSchema,
    issueDate: calendarDateSchema,
    dueDate: calendarDateSchema,

    /** Which structure items to bill. A monthly run picks up monthly items. */
    frequencies: z.array(z.enum(FEE_FREQUENCIES)).min(1).default(['monthly']),
    /** Opt-in charges — transport, hostel — are excluded unless explicitly asked for. */
    includeOptional: z.boolean().default(false),
    notes: z.string().trim().max(1000).optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.sectionId && !data.classLevelId && !(data.studentIds && data.studentIds.length)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sectionId'],
        message: 'Choose a section, a class or an explicit list of students to bill',
      });
    }
    if (data.billingPeriodEnd < data.billingPeriodStart) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['billingPeriodEnd'],
        message: 'The billing period cannot end before it starts',
      });
    }
    if (data.dueDate < data.issueDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dueDate'],
        message: 'The due date cannot be before the issue date',
      });
    }
  });

export type GenerateInvoicesInput = z.infer<typeof generateInvoicesSchema>;

// ── Invoices ─────────────────────────────────────────────────────────────────────────

export const listInvoicesSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    studentId: uuidSchema.optional(),
    academicYearId: uuidSchema.optional(),
    sectionId: uuidSchema.optional(),
    classLevelId: uuidSchema.optional(),
    status: z.enum(INVOICE_STATUSES).optional(),
    /** Only invoices with money still owed. Cheap in SQL, and the common case. */
    outstandingOnly: z.coerce.boolean().default(false),
    dueFrom: calendarDateSchema.optional(),
    dueTo: calendarDateSchema.optional(),
    includeArchived: z.coerce.boolean().default(false),
  });

export const voidInvoiceSchema = z.object({ reason: reasonSchema });

/**
 * Applying late fines.
 *
 * Explicit and audited by design: a fine is a financial fact somebody has to be accountable
 * for, so it is never computed on read. `fineFeeHeadId` must name a head of type `fine`, so
 * the charge lands somewhere a report can find it and the ledger can post it.
 */
export const applyLateFinesSchema = z.object({
  academicYearId: uuidSchema,
  fineFeeHeadId: uuidSchema,
  /** The date the fine is assessed against. Defaults to today in the service. */
  asOfDate: calendarDateSchema.optional(),
  sectionId: uuidSchema.optional(),
  classLevelId: uuidSchema.optional(),
  invoiceIds: z.array(uuidSchema).max(1000).optional(),
  reason: reasonSchema,
});

export type ApplyLateFinesInput = z.infer<typeof applyLateFinesSchema>;

// ── Payments ─────────────────────────────────────────────────────────────────────────

/**
 * Recording money received.
 *
 * `allocations` is optional. Left out, the service settles the student's outstanding invoices
 * oldest-due-first, which is what a clerk taking cash at a counter means. Supplied, the
 * allocations must sum **exactly** to the payment amount — a partially-explained receipt is a
 * reconciliation problem later, so it is refused now.
 *
 * `strategy: 'proportional'` splits the payment across outstanding invoices in proportion to
 * their balances using `Money.allocate`, so the parts always sum back to the whole.
 */
export const recordPaymentSchema = z
  .object({
    studentId: uuidSchema,
    amount: positiveMoneySchema,
    method: z.enum(FEE_PAYMENT_METHODS),
    /** bKash transaction id, cheque number, bank slip reference. */
    reference: z.string().trim().max(128).optional(),
    receivedAt: z.string().datetime({ offset: true }).optional(),
    notes: z.string().trim().max(1000).optional(),
    strategy: z.enum(['oldest_due_first', 'proportional']).default('oldest_due_first'),
    allocations: z
      .array(
        z.object({
          invoiceId: uuidSchema,
          amount: positiveMoneySchema,
        }),
      )
      .max(200)
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.allocations || data.allocations.length === 0) return;

    const seen = new Set<string>();
    for (const allocation of data.allocations) {
      if (seen.has(allocation.invoiceId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['allocations'],
          message: 'The same invoice appears twice. Combine the amounts into one allocation.',
        });
      }
      seen.add(allocation.invoiceId);
    }

    // The exact-sum rule is restated in the service against `Money`, which is the
    // authoritative check. Doing it here as well attaches the failure to the right field
    // instead of surfacing as a generic 409.
    const toMinor = (value: string) => {
      const [whole = '0', fraction = ''] = value.split('.');
      return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2) || '0');
    };
    const allocated = data.allocations.reduce((sum, one) => sum + toMinor(one.amount), 0n);
    if (allocated !== toMinor(data.amount)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allocations'],
        message: 'The allocations must add up to exactly the payment amount',
      });
    }
  });

export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

export const reversePaymentSchema = z.object({
  reason: reasonSchema,
  /** Optimistic lock, so two clerks cannot both reverse the same receipt. */
  version: z.number().int().min(1),
});

export const listPaymentsSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    studentId: uuidSchema.optional(),
    method: z.enum(FEE_PAYMENT_METHODS).optional(),
    status: z.enum(FEE_PAYMENT_STATUSES).optional(),
    receivedFrom: calendarDateSchema.optional(),
    receivedTo: calendarDateSchema.optional(),
    includeArchived: z.coerce.boolean().default(false),
  });

// ── Reports ──────────────────────────────────────────────────────────────────────────

export const studentLedgerQuerySchema = z.object({
  academicYearId: uuidSchema.optional(),
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
});

export const outstandingDuesQuerySchema = z.object({
  academicYearId: uuidSchema,
  classLevelId: uuidSchema.optional(),
  sectionId: uuidSchema.optional(),
  /** `class` rolls up to the class level; `section` gives one row per section. */
  groupBy: z.enum(['class', 'section']).default('section'),
  asOfDate: calendarDateSchema.optional(),
});

export const collectionSummaryQuerySchema = z
  .object({
    from: calendarDateSchema,
    to: calendarDateSchema,
    method: z.enum(FEE_PAYMENT_METHODS).optional(),
  })
  .refine((data) => data.to >= data.from, {
    message: 'The end of the range cannot be before its start',
    path: ['to'],
  });
