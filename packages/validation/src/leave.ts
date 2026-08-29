/**
 * Leave management schemas (Phase 21).
 *
 * Three conventions here are policy rather than validation:
 *
 *  - **A client never states a derived fact.** There is no `days` on an application and no
 *    `status` anywhere: the working-day count is computed by the service from the academic
 *    year's weekend, the institution's calendar events and its holiday overrides, and the
 *    status is moved by the workflow engine. The only figures a client sends are the ones a
 *    human genuinely decides — the dates, the reason, the encashment amount.
 *  - **Days are exact decimals in tenths**, on the wire as strings, mirroring the
 *    `numeric(5, 1)` columns. A half day is `"0.5"`, never `0.5` the IEEE double.
 *  - **Money crosses the wire as a decimal string** (ADR-004); `Money` is the only parser.
 *
 * The "exactly one holder" rule — an application or a balance is for an employee **or** a
 * student, never both and never neither — is restated here from the database CHECK, because
 * a 422 naming the field is a better answer than a 500 carrying a constraint name.
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

// ── Value sets, mirrored from the database enums ─────────────────────────────────────

export const LEAVE_APPLIES_TO = ['employee', 'student', 'both'] as const;

export const LEAVE_ACCRUALS = ['annual_grant', 'monthly_accrual', 'none'] as const;

export const LEAVE_GENDER_RESTRICTIONS = ['any', 'female', 'male'] as const;

export const LEAVE_TYPE_STATUSES = ['active', 'inactive'] as const;

export const LEAVE_APPLICATION_STATUSES = [
  'draft',
  'submitted',
  'approved',
  'rejected',
  'cancelled',
  'withdrawn',
] as const;

export const LEAVE_HALF_DAY_PERIODS = ['first', 'second'] as const;

export const LEAVE_ENCASHMENT_STATUSES = ['pending', 'approved', 'rejected'] as const;

export const LEAVE_TYPE_SORT_FIELDS = ['code', 'nameEn', 'status', 'createdAt'] as const;

export const LEAVE_APPLICATION_SORT_FIELDS = [
  'fromDate',
  'toDate',
  'status',
  'createdAt',
] as const;

export const LEAVE_BALANCE_SORT_FIELDS = ['createdAt'] as const;

export const LEAVE_ENCASHMENT_SORT_FIELDS = ['status', 'createdAt'] as const;

// ── Primitives ───────────────────────────────────────────────────────────────────────

/**
 * A day count with at most one decimal place, matching `numeric(5, 1)`.
 *
 * A string rather than a number for the same reason money is: "0.1" + "0.2" must be "0.3"
 * on a payslip, and binary floating point cannot promise that.
 */
export const leaveDaysSchema = z
  .string()
  .trim()
  .regex(/^\d{1,4}(\.\d)?$/, 'Enter a number of days with at most one decimal place, e.g. 2.5');

const codeSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9_-]+$/, 'Use letters, digits, hyphens and underscores only');

const nameField = z.string().trim().min(1).max(255);
const versionSchema = z.number().int().min(1);

/** An approval comment. Optional on approve, mandatory and substantial on reject. */
const decisionCommentSchema = z
  .string()
  .trim()
  .min(10, 'Give a reason of at least 10 characters — it is recorded against the decision')
  .max(1000);

const optionalCommentSchema = z.string().trim().max(1000).optional();

// ── Leave types ──────────────────────────────────────────────────────────────────────

export const createLeaveTypeSchema = z.object({
  code: codeSchema,
  name: nameField,
  nameBn: nameField.optional(),
  appliesTo: z.enum(LEAVE_APPLIES_TO).default('employee'),
  isPaid: z.boolean().default(true),
  requiresDocument: z.boolean().default(false),
  /** Null (omitted) means no cap. Compared against the computed *working-day* count. */
  maxConsecutiveDays: z.number().int().min(1).max(3650).optional(),
  annualQuotaDays: leaveDaysSchema.default('0.0'),
  carryForwardDays: leaveDaysSchema.default('0.0'),
  accrual: z.enum(LEAVE_ACCRUALS).default('annual_grant'),
  genderRestriction: z.enum(LEAVE_GENDER_RESTRICTIONS).default('any'),
  /** The single sanctioned way a balance may go below zero. Off unless policy says so. */
  allowNegativeBalance: z.boolean().default(false),
  status: z.enum(LEAVE_TYPE_STATUSES).default('active'),
});
export type CreateLeaveTypeInput = z.infer<typeof createLeaveTypeSchema>;

export const updateLeaveTypeSchema = z
  .object({
    name: nameField.optional(),
    nameBn: nameField.optional(),
    appliesTo: z.enum(LEAVE_APPLIES_TO).optional(),
    isPaid: z.boolean().optional(),
    requiresDocument: z.boolean().optional(),
    maxConsecutiveDays: z.number().int().min(1).max(3650).nullable().optional(),
    annualQuotaDays: leaveDaysSchema.optional(),
    carryForwardDays: leaveDaysSchema.optional(),
    accrual: z.enum(LEAVE_ACCRUALS).optional(),
    genderRestriction: z.enum(LEAVE_GENDER_RESTRICTIONS).optional(),
    allowNegativeBalance: z.boolean().optional(),
    status: z.enum(LEAVE_TYPE_STATUSES).optional(),
    version: versionSchema,
  })
  .strict();
export type UpdateLeaveTypeInput = z.infer<typeof updateLeaveTypeSchema>;

export const archiveLeaveTypeSchema = z.object({ reason: reasonSchema });

export const listLeaveTypesSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    appliesTo: z.enum(LEAVE_APPLIES_TO).optional(),
    status: z.enum(LEAVE_TYPE_STATUSES).optional(),
    includeArchived: z.coerce.boolean().default(false),
  });
export type ListLeaveTypesQuery = z.infer<typeof listLeaveTypesSchema>;

// ── Balances ─────────────────────────────────────────────────────────────────────────

export const listLeaveBalancesSchema = paginationSchema.merge(sortSchema).extend({
  leaveTypeId: uuidSchema.optional(),
  employeeId: uuidSchema.optional(),
  studentId: uuidSchema.optional(),
  academicYearId: uuidSchema.optional(),
  includeArchived: z.coerce.boolean().default(false),
});
export type ListLeaveBalancesQuery = z.infer<typeof listLeaveBalancesSchema>;

/**
 * Adjust an entitlement.
 *
 * `usedDays` is deliberately absent: used days move only inside the approval and
 * cancellation transactions, never by hand. An administrator grants entitlement and carries
 * days forward; they do not retro-spend a balance.
 */
export const adjustLeaveBalanceSchema = z
  .object({
    leaveTypeId: uuidSchema,
    academicYearId: uuidSchema,
    employeeId: uuidSchema.optional(),
    studentId: uuidSchema.optional(),
    entitledDays: leaveDaysSchema.optional(),
    carriedDays: leaveDaysSchema.optional(),
    reason: reasonSchema,
  })
  .superRefine((value, ctx) => {
    if (Boolean(value.employeeId) === Boolean(value.studentId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['employeeId'],
        message: 'A balance belongs to exactly one holder: give employeeId or studentId',
      });
    }
    if (value.entitledDays === undefined && value.carriedDays === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['entitledDays'],
        message: 'Give entitledDays or carriedDays — an adjustment that changes nothing is not one',
      });
    }
  });
export type AdjustLeaveBalanceInput = z.infer<typeof adjustLeaveBalanceSchema>;

// ── Applications ─────────────────────────────────────────────────────────────────────

export const applyForLeaveSchema = z
  .object({
    leaveTypeId: uuidSchema,
    /** Exactly one of these. Omit both and the service assumes the caller's own employee record. */
    employeeId: uuidSchema.optional(),
    studentId: uuidSchema.optional(),
    fromDate: calendarDateSchema,
    toDate: calendarDateSchema,
    isHalfDay: z.boolean().default(false),
    halfDayPeriod: z.enum(LEAVE_HALF_DAY_PERIODS).optional(),
    reason: reasonSchema,
    contactDuringLeave: z.string().trim().max(120).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.employeeId && value.studentId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['studentId'],
        message: 'Leave is for exactly one person: give employeeId or studentId, not both',
      });
    }
    if (value.toDate < value.fromDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toDate'],
        message: 'The last day of leave cannot be before the first',
      });
    }
    if (value.isHalfDay) {
      if (value.fromDate !== value.toDate) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['toDate'],
          message: 'A half day covers a single date',
        });
      }
      if (!value.halfDayPeriod) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['halfDayPeriod'],
          message: 'Say which half of the day: "first" or "second"',
        });
      }
    } else if (value.halfDayPeriod) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['halfDayPeriod'],
        message: 'halfDayPeriod applies only when isHalfDay is true',
      });
    }
  });
export type ApplyForLeaveInput = z.infer<typeof applyForLeaveSchema>;

export const listLeaveApplicationsSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    status: z.enum(LEAVE_APPLICATION_STATUSES).optional(),
    leaveTypeId: uuidSchema.optional(),
    employeeId: uuidSchema.optional(),
    studentId: uuidSchema.optional(),
    /** Overlap window: applications touching [from, to] at any point. */
    from: calendarDateSchema.optional(),
    to: calendarDateSchema.optional(),
    includeArchived: z.coerce.boolean().default(false),
  });
export type ListLeaveApplicationsQuery = z.infer<typeof listLeaveApplicationsSchema>;

/** Withdrawal is the applicant's own act; cancellation is an approver's. Both need a reason. */
export const withdrawLeaveSchema = z.object({ reason: reasonSchema });
export const cancelLeaveSchema = z.object({ reason: reasonSchema });

export const approveLeaveSchema = z.object({ comment: optionalCommentSchema });
export type ApproveLeaveInput = z.infer<typeof approveLeaveSchema>;

export const rejectLeaveSchema = z.object({ comment: decisionCommentSchema });
export type RejectLeaveInput = z.infer<typeof rejectLeaveSchema>;

export const leaveCalendarQuerySchema = z
  .object({
    from: calendarDateSchema,
    to: calendarDateSchema,
    leaveTypeId: uuidSchema.optional(),
    employeeId: uuidSchema.optional(),
    studentId: uuidSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.to < value.from) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: '`to` precedes `from`' });
    }
  });
export type LeaveCalendarQuery = z.infer<typeof leaveCalendarQuerySchema>;

// ── Encashment ───────────────────────────────────────────────────────────────────────

/**
 * `amount` is stated, not derived: encashment rates are negotiated policy (basic ÷ 30 in
 * most schools, but by no means all), and there is no column that makes the rate a fact of
 * the system. `days` is checked against the balance, and both are approved by a second
 * person — the database refuses `approved_by = requested_by` outright.
 */
export const createLeaveEncashmentSchema = z.object({
  employeeId: uuidSchema,
  leaveTypeId: uuidSchema,
  academicYearId: uuidSchema,
  days: leaveDaysSchema,
  amount: positiveMoneySchema,
});
export type CreateLeaveEncashmentInput = z.infer<typeof createLeaveEncashmentSchema>;

export const listLeaveEncashmentsSchema = paginationSchema.merge(sortSchema).extend({
  status: z.enum(LEAVE_ENCASHMENT_STATUSES).optional(),
  employeeId: uuidSchema.optional(),
  academicYearId: uuidSchema.optional(),
});
export type ListLeaveEncashmentsQuery = z.infer<typeof listLeaveEncashmentsSchema>;

export const decideLeaveEncashmentSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: reasonSchema,
  version: versionSchema,
});
export type DecideLeaveEncashmentInput = z.infer<typeof decideLeaveEncashmentSchema>;

// ── Holiday overrides ────────────────────────────────────────────────────────────────

/**
 * One date's exception to the computed calendar: `isWorkingDay: true` opens a weekend or a
 * holiday (the make-up Saturday), `false` closes an ordinary working day.
 */
export const createHolidayOverrideSchema = z.object({
  date: calendarDateSchema,
  isWorkingDay: z.boolean(),
  note: z.string().trim().max(255).optional(),
});
export type CreateHolidayOverrideInput = z.infer<typeof createHolidayOverrideSchema>;

export const updateHolidayOverrideSchema = z
  .object({
    isWorkingDay: z.boolean().optional(),
    note: z.string().trim().max(255).optional(),
    version: versionSchema,
  })
  .strict();
export type UpdateHolidayOverrideInput = z.infer<typeof updateHolidayOverrideSchema>;

export const archiveHolidayOverrideSchema = z.object({ reason: reasonSchema });

export const listHolidayOverridesSchema = paginationSchema.extend({
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
  includeArchived: z.coerce.boolean().default(false),
});
export type ListHolidayOverridesQuery = z.infer<typeof listHolidayOverridesSchema>;

// ── Reports ──────────────────────────────────────────────────────────────────────────

/**
 * Leave liability: unused entitlement an institution would have to pay out.
 *
 * `daysPerMonth` is the divisor that turns a monthly basic into a daily rate. It is a
 * parameter rather than a constant because schools differ (30 is the common Bangladeshi
 * convention; 26 working days is also used), and burying the choice would make the number
 * unexplainable to the auditor reading it.
 */
export const leaveLiabilityQuerySchema = z.object({
  academicYearId: uuidSchema.optional(),
  leaveTypeId: uuidSchema.optional(),
  daysPerMonth: z.coerce.number().int().min(1).max(31).default(30),
});
export type LeaveLiabilityQuery = z.infer<typeof leaveLiabilityQuerySchema>;
