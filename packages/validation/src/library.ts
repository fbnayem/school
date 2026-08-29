/**
 * Library schemas (Phase 17).
 *
 * The rules that shape everything here, inherited from the fees module:
 *
 *  - **Money crosses the wire as a decimal string, never a number** (ADR-004). A copy's cost,
 *    a replacement amount and the per-day fine rate all use `positiveMoneySchema`.
 *  - **A client never states a derived fact.** There is no `status` on a copy or loan input,
 *    no `totalCopies` on a title, no `fineAmount` anywhere, and no `queuePosition` on a
 *    reservation. Those are computed by the service and restated as database constraints.
 *  - **A fine is never computed on read.** The assessment schema exists precisely so that
 *    charging a family is an explicit, reasoned, audited request.
 *
 * Every exported constant carries the `LIBRARY_` prefix because `@shikkha/validation`
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
import { FEE_PAYMENT_METHODS } from './fees';

const code = (max: number) =>
  z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]+$/, 'Use letters, numbers, hyphens and underscores only')
    .min(1)
    .max(max);

// ── Value sets, mirrored from the database enums ─────────────────────────────────────

export const LIBRARY_LANGUAGES = ['bangla', 'english', 'arabic', 'other'] as const;

export const LIBRARY_COPY_CONDITIONS = ['new', 'good', 'fair', 'damaged', 'lost'] as const;

export const LIBRARY_COPY_STATUSES = [
  'available',
  'issued',
  'reserved',
  'lost',
  'withdrawn',
] as const;

export const LIBRARY_MEMBER_TYPES = ['student', 'employee'] as const;

export const LIBRARY_MEMBER_STATUSES = ['active', 'suspended', 'expired'] as const;

export const LIBRARY_LOAN_STATUSES = ['issued', 'returned', 'overdue', 'lost'] as const;

export const LIBRARY_RESERVATION_STATUSES = [
  'active',
  'fulfilled',
  'cancelled',
  'expired',
] as const;

export const LIBRARY_FINE_STATUSES = ['pending', 'paid', 'waived'] as const;

/** `'active' | 'inactive'` — a varchar union in the schema, not a pgEnum. */
export const LIBRARY_TITLE_STATUSES = ['active', 'inactive'] as const;

// ── Sort-field allow-lists ───────────────────────────────────────────────────────────

export const LIBRARY_CATEGORY_SORT_FIELDS = ['nameEn', 'createdAt'] as const;

export const LIBRARY_TITLE_SORT_FIELDS = [
  'title',
  'author',
  'publisher',
  'language',
  'totalCopies',
  'createdAt',
] as const;

export const LIBRARY_COPY_SORT_FIELDS = [
  'accessionNumber',
  'status',
  'condition',
  'acquiredOn',
  'createdAt',
] as const;

export const LIBRARY_MEMBER_SORT_FIELDS = ['cardNumber', 'status', 'createdAt'] as const;

export const LIBRARY_LOAN_SORT_FIELDS = ['issuedAt', 'dueOn', 'status', 'createdAt'] as const;

export const LIBRARY_FINE_SORT_FIELDS = ['assessedOn', 'amount', 'status', 'createdAt'] as const;

// ── Settings ─────────────────────────────────────────────────────────────────────────

/**
 * The circulation policy, replaced whole (a PUT). Every field has the same default as the
 * database column, so a partial form still produces a complete, explainable policy.
 */
export const putLibrarySettingsSchema = z.object({
  /** Fine accrued per whole overdue day. A decimal string — money, never a float. */
  finePerDay: positiveMoneySchema.default('2.00'),
  maxRenewals: z.coerce.number().int().min(0).max(20).default(1),
  reservationHoldDays: z.coerce.number().int().min(1).max(60).default(3),
  defaultLoanDays: z.coerce.number().int().min(1).max(365).default(14),
  defaultMaxBooks: z.coerce.number().int().min(1).max(50).default(3),
});

export type PutLibrarySettingsInput = z.infer<typeof putLibrarySettingsSchema>;

// ── Categories ───────────────────────────────────────────────────────────────────────

export const createLibraryCategorySchema = z.object({
  nameEn: z.string().trim().min(1).max(128),
  nameBn: z.string().trim().max(128).optional(),
  parentId: uuidSchema.optional(),
});

export type CreateLibraryCategoryInput = z.infer<typeof createLibraryCategorySchema>;

export const updateLibraryCategorySchema = z
  .object({
    nameEn: z.string().trim().min(1).max(128).optional(),
    nameBn: z.string().trim().max(128).nullable().optional(),
    parentId: uuidSchema.nullable().optional(),
    /** Optimistic lock. Rejecting a stale write beats silently overwriting a colleague. */
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, {
    message: 'No changes were submitted',
  });

export type UpdateLibraryCategoryInput = z.infer<typeof updateLibraryCategorySchema>;

export const listLibraryCategoriesSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    parentId: uuidSchema.optional(),
    includeArchived: z.coerce.boolean().default(false),
  });

export const libraryArchiveSchema = z.object({ reason: reasonSchema });

// ── Titles ───────────────────────────────────────────────────────────────────────────

/** ISBN-10 or ISBN-13, hyphens tolerated. Optional: donated and old stock often has none. */
const isbnSchema = z
  .string()
  .trim()
  .regex(/^[0-9Xx-]{10,17}$/, 'Not a valid ISBN')
  .optional();

export const createLibraryTitleSchema = z.object({
  title: z.string().trim().min(1).max(255),
  titleBn: z.string().trim().max(255).optional(),
  isbn: isbnSchema,
  author: z.string().trim().max(255).optional(),
  publisher: z.string().trim().max(255).optional(),
  edition: z.string().trim().max(64).optional(),
  language: z.enum(LIBRARY_LANGUAGES).default('bangla'),
  categoryId: uuidSchema.optional(),
  deweyCode: z.string().trim().max(32).optional(),
});

export type CreateLibraryTitleInput = z.infer<typeof createLibraryTitleSchema>;

export const updateLibraryTitleSchema = z
  .object({
    title: z.string().trim().min(1).max(255).optional(),
    titleBn: z.string().trim().max(255).nullable().optional(),
    isbn: z
      .string()
      .trim()
      .regex(/^[0-9Xx-]{10,17}$/, 'Not a valid ISBN')
      .nullable()
      .optional(),
    author: z.string().trim().max(255).nullable().optional(),
    publisher: z.string().trim().max(255).nullable().optional(),
    edition: z.string().trim().max(64).nullable().optional(),
    language: z.enum(LIBRARY_LANGUAGES).optional(),
    categoryId: uuidSchema.nullable().optional(),
    deweyCode: z.string().trim().max(32).nullable().optional(),
    /** `inactive` stops new copies and reservations; existing loans run their course. */
    status: z.enum(LIBRARY_TITLE_STATUSES).optional(),
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, {
    message: 'No changes were submitted',
  });

export type UpdateLibraryTitleInput = z.infer<typeof updateLibraryTitleSchema>;

export const listLibraryTitlesSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    language: z.enum(LIBRARY_LANGUAGES).optional(),
    categoryId: uuidSchema.optional(),
    status: z.enum(LIBRARY_TITLE_STATUSES).optional(),
    includeArchived: z.coerce.boolean().default(false),
  });

// ── Copies ───────────────────────────────────────────────────────────────────────────

export const createLibraryCopiesSchema = z
  .object({
    titleId: uuidSchema,
    /**
     * Omit to have the service generate the next accession number under the institution's
     * `ACC-` register. Supplying one only makes sense for a single copy.
     */
    accessionNumber: code(32).optional(),
    barcode: z.string().trim().max(64).optional(),
    acquiredOn: calendarDateSchema.optional(),
    /** Purchase cost — the default replacement fine if the copy is later lost. */
    cost: positiveMoneySchema.optional(),
    condition: z.enum(LIBRARY_COPY_CONDITIONS).default('good'),
    shelfLocation: z.string().trim().max(64).optional(),
    /** How many identical copies to accession in one request. */
    count: z.coerce.number().int().min(1).max(100).default(1),
  })
  .refine((data) => data.count === 1 || data.accessionNumber === undefined, {
    message: 'An explicit accession number can only be given for a single copy',
    path: ['accessionNumber'],
  });

export type CreateLibraryCopiesInput = z.infer<typeof createLibraryCopiesSchema>;

export const updateLibraryCopySchema = z
  .object({
    barcode: z.string().trim().max(64).nullable().optional(),
    acquiredOn: calendarDateSchema.nullable().optional(),
    cost: positiveMoneySchema.nullable().optional(),
    condition: z.enum(LIBRARY_COPY_CONDITIONS).optional(),
    shelfLocation: z.string().trim().max(64).nullable().optional(),
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, {
    message: 'No changes were submitted',
  });

export type UpdateLibraryCopyInput = z.infer<typeof updateLibraryCopySchema>;

export const listLibraryCopiesSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    titleId: uuidSchema.optional(),
    status: z.enum(LIBRARY_COPY_STATUSES).optional(),
    condition: z.enum(LIBRARY_COPY_CONDITIONS).optional(),
    includeArchived: z.coerce.boolean().default(false),
  });

// ── Members ──────────────────────────────────────────────────────────────────────────

/**
 * Auto-create a borrowing account from a student or an employee. Exactly one of
 * `studentId`/`employeeId`, matching `memberType` — the same rule the database states as
 * `library_members_exactly_one_person`.
 */
export const createLibraryMemberSchema = z
  .object({
    memberType: z.enum(LIBRARY_MEMBER_TYPES),
    studentId: uuidSchema.optional(),
    employeeId: uuidSchema.optional(),
    /** Omit to have the service issue the next card number under the `LM-` register. */
    cardNumber: code(32).optional(),
    /** Omitted values fall back to the institution's circulation policy. */
    maxBooks: z.coerce.number().int().min(1).max(50).optional(),
    loanDays: z.coerce.number().int().min(1).max(365).optional(),
    validUntil: calendarDateSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.memberType === 'student') {
      if (!data.studentId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['studentId'],
          message: 'A student membership must name the student',
        });
      }
      if (data.employeeId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['employeeId'],
          message: 'A student membership cannot also name an employee',
        });
      }
    } else {
      if (!data.employeeId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['employeeId'],
          message: 'An employee membership must name the employee',
        });
      }
      if (data.studentId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['studentId'],
          message: 'An employee membership cannot also name a student',
        });
      }
    }
  });

export type CreateLibraryMemberInput = z.infer<typeof createLibraryMemberSchema>;

export const updateLibraryMemberSchema = z
  .object({
    maxBooks: z.coerce.number().int().min(1).max(50).optional(),
    loanDays: z.coerce.number().int().min(1).max(365).optional(),
    /** Suspending or expiring a member blocks new borrowing immediately, server-side. */
    status: z.enum(LIBRARY_MEMBER_STATUSES).optional(),
    validUntil: calendarDateSchema.nullable().optional(),
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, {
    message: 'No changes were submitted',
  });

export type UpdateLibraryMemberInput = z.infer<typeof updateLibraryMemberSchema>;

export const listLibraryMembersSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    memberType: z.enum(LIBRARY_MEMBER_TYPES).optional(),
    status: z.enum(LIBRARY_MEMBER_STATUSES).optional(),
    includeArchived: z.coerce.boolean().default(false),
  });

// ── Circulation ──────────────────────────────────────────────────────────────────────

/** Issue by copy id or by scanning the accession number — exactly one of the two. */
export const issueLibraryLoanSchema = z
  .object({
    copyId: uuidSchema.optional(),
    accessionNumber: code(32).optional(),
    memberId: uuidSchema,
    /** Omit to fall back to the member's `loanDays` from today. */
    dueOn: calendarDateSchema.optional(),
  })
  .refine((data) => Boolean(data.copyId) !== Boolean(data.accessionNumber), {
    message: 'Identify the copy by exactly one of copyId or accessionNumber',
    path: ['copyId'],
  });

export type IssueLibraryLoanInput = z.infer<typeof issueLibraryLoanSchema>;

export const returnLibraryLoanSchema = z.object({
  /** The condition the book came back in, when it changed. */
  condition: z.enum(LIBRARY_COPY_CONDITIONS).optional(),
});

export type ReturnLibraryLoanInput = z.infer<typeof returnLibraryLoanSchema>;

export const renewLibraryLoanSchema = z.object({
  /** Omit to extend by the member's `loanDays`. */
  days: z.coerce.number().int().min(1).max(90).optional(),
});

export type RenewLibraryLoanInput = z.infer<typeof renewLibraryLoanSchema>;

/**
 * Mark a copy lost. Assesses the replacement cost as a fine in the same transaction; the
 * amount defaults to the copy's recorded cost, and must be given explicitly when the copy
 * has none — a lost book with no accountable charge is a silent write-off.
 */
export const markLibraryLoanLostSchema = z.object({
  reason: reasonSchema,
  replacementAmount: positiveMoneySchema.optional(),
});

export type MarkLibraryLoanLostInput = z.infer<typeof markLibraryLoanLostSchema>;

export const listLibraryLoansSchema = paginationSchema.merge(sortSchema).extend({
  memberId: uuidSchema.optional(),
  copyId: uuidSchema.optional(),
  titleId: uuidSchema.optional(),
  status: z.enum(LIBRARY_LOAN_STATUSES).optional(),
  /** Only loans still out past their due date. */
  overdueOnly: z.coerce.boolean().default(false),
  includeArchived: z.coerce.boolean().default(false),
});

// ── Reservations ─────────────────────────────────────────────────────────────────────

export const createLibraryReservationSchema = z.object({
  titleId: uuidSchema,
  memberId: uuidSchema,
});

export type CreateLibraryReservationInput = z.infer<typeof createLibraryReservationSchema>;

export const cancelLibraryReservationSchema = z.object({ reason: reasonSchema });

export const listLibraryReservationsSchema = paginationSchema.merge(sortSchema).extend({
  titleId: uuidSchema.optional(),
  memberId: uuidSchema.optional(),
  status: z.enum(LIBRARY_RESERVATION_STATUSES).optional(),
  includeArchived: z.coerce.boolean().default(false),
});

// ── Fines ────────────────────────────────────────────────────────────────────────────

/**
 * The batch assessment run. Explicit and audited by design — a fine accrues per overdue day
 * at the institution's configured rate, but it becomes a fact only when somebody with
 * `library.fines.manage` runs this with a reason. Re-running for the same date is a no-op,
 * backed by the partial unique index on `(loan_id, assessed_on)`.
 */
export const assessLibraryFinesSchema = z.object({
  /** The date the fines are assessed against. Defaults to today in the service. */
  asOfDate: calendarDateSchema.optional(),
  /** Narrow the run to one member, or to an explicit list of loans. */
  memberId: uuidSchema.optional(),
  loanIds: z.array(uuidSchema).max(500).optional(),
  reason: reasonSchema,
});

export type AssessLibraryFinesInput = z.infer<typeof assessLibraryFinesSchema>;

export const payLibraryFineSchema = z.object({
  method: z.enum(FEE_PAYMENT_METHODS).default('cash'),
  /** bKash transaction id, receipt book number, and so on. */
  reference: z.string().trim().max(128).optional(),
});

export type PayLibraryFineInput = z.infer<typeof payLibraryFineSchema>;

/** Waiving needs its own permission and a mandatory, audited reason. */
export const waiveLibraryFineSchema = z.object({ reason: reasonSchema });

export const listLibraryFinesSchema = paginationSchema.merge(sortSchema).extend({
  memberId: uuidSchema.optional(),
  loanId: uuidSchema.optional(),
  status: z.enum(LIBRARY_FINE_STATUSES).optional(),
  includeArchived: z.coerce.boolean().default(false),
});

// ── Reports and stock-take ───────────────────────────────────────────────────────────

export const libraryOverdueReportQuerySchema = z.object({
  asOfDate: calendarDateSchema.optional(),
});

export const libraryMostBorrowedQuerySchema = z
  .object({
    from: calendarDateSchema.optional(),
    to: calendarDateSchema.optional(),
    categoryId: uuidSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine((data) => !data.from || !data.to || data.to >= data.from, {
    message: 'The end of the range cannot be before its start',
    path: ['to'],
  });

/**
 * A physical stock-take: the accession numbers actually seen on the shelves. The service
 * reconciles them against the register in SQL — what should be on the shelf but was not
 * scanned, what was scanned but is recorded as issued, lost or withdrawn, and what was
 * scanned but is not in the register at all.
 */
export const libraryStockTakeSchema = z.object({
  accessionNumbers: z
    .array(z.string().trim().min(1).max(64))
    .min(1, 'Scan at least one accession number')
    .max(10000),
});

export type LibraryStockTakeInput = z.infer<typeof libraryStockTakeSchema>;
