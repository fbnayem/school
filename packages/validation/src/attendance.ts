/**
 * Attendance schemas (Phase 7).
 *
 * Two things here are policy rather than validation, and both exist because the register is an
 * institutional record rather than a form:
 *
 *  - Every schema that changes a *submitted* mark carries `reasonSchema`. The reason is not
 *    decoration; it is written to `attendance_corrections` and to the audit log, and the
 *    database has a matching `check` so it cannot be bypassed by a non-HTTP caller.
 *  - Report date ranges are bounded. An unbounded `from`/`to` on the highest-volume table in
 *    the product is a denial-of-service endpoint wearing a report's clothing, and the bound
 *    belongs in the schema so no service has to remember it.
 *
 * `minutesLate` is deliberately only accepted alongside `late` or `half_day`. A punctuality
 * report that sums minutes over rows marked `present` is wrong in a way nobody notices.
 */

import { z } from 'zod';
import { calendarDate, daysBetween } from '@shikkha/shared';
import {
  calendarDateSchema,
  paginationSchema,
  reasonSchema,
  sortSchema,
  uuidSchema,
} from './common';

/**
 * The mark a student can receive.
 *
 * Note this is **not** `ATTENDANCE_STATUSES` from `@shikkha/shared`, which predates this
 * module and carries `leave` where the register needs `half_day`. Reconciling the two is a
 * change to a shared constant and to whatever reads it, so it is deliberately not made here.
 */
export const ATTENDANCE_MARK_STATUSES = [
  'present',
  'absent',
  'late',
  'excused',
  'half_day',
] as const;

export const ATTENDANCE_SESSION_STATUSES = ['open', 'submitted', 'locked'] as const;

export const ATTENDANCE_CORRECTION_STATUSES = ['pending', 'approved', 'rejected'] as const;

export const EMPLOYEE_ATTENDANCE_STATUSES = [
  'present',
  'absent',
  'late',
  'on_leave',
  'half_day',
] as const;

export const EMPLOYEE_ATTENDANCE_SOURCES = ['manual', 'device'] as const;

export const ATTENDANCE_SESSION_SORT_FIELDS = ['attendanceDate', 'status', 'createdAt'] as const;

export const ATTENDANCE_CORRECTION_SORT_FIELDS = ['requestedAt', 'status', 'createdAt'] as const;

export const EMPLOYEE_ATTENDANCE_SORT_FIELDS = ['attendanceDate', 'createdAt'] as const;

/**
 * The widest window a single report may span.
 *
 * A full academic year plus a little, which is every legitimate request — a school asking for
 * five years at once wants an export, which is a different endpoint with a different cost.
 */
export const MAX_ATTENDANCE_REPORT_DAYS = 400;

const minutesLateSchema = z.coerce
  .number()
  .int()
  .min(0, 'Minutes late cannot be negative')
  .max(600, 'Enter the minutes late as a number up to 600');

const remarksSchema = z.string().trim().max(500).optional();

/**
 * `from`/`to` with both ends inclusive, ordered, and bounded.
 *
 * Applied with `.superRefine` on each report schema rather than composed with
 * `z.intersection`, because an intersection is not a `ZodObject` and every later
 * `.extend`/`.merge` on it would stop working.
 */
const dateRangeFields = { from: calendarDateSchema, to: calendarDateSchema } as const;

function checkDateRange(data: { from: string; to: string }, ctx: z.RefinementCtx): void {
  const span = daysBetween(calendarDate(data.from), calendarDate(data.to));
  if (span < 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['to'],
      message: 'The end of the range must not be before the start',
    });
    return;
  }
  if (span + 1 > MAX_ATTENDANCE_REPORT_DAYS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['to'],
      message: `Ask for at most ${MAX_ATTENDANCE_REPORT_DAYS} days at a time`,
    });
  }
}

// ── Sessions ─────────────────────────────────────────────────────────────────────────

/**
 * Open (or re-open the reference to) the register for a section on a date.
 *
 * `periodId` absent means the daily register. A subject without a period is refused rather
 * than silently treated as daily: "Maths attendance for the whole day" is not a thing the
 * timetable can express, and accepting it would produce a register nobody can reconcile.
 */
export const openAttendanceSessionSchema = z
  .object({
    sectionId: uuidSchema,
    attendanceDate: calendarDateSchema,
    periodId: uuidSchema.optional(),
    subjectId: uuidSchema.optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .refine((data) => !data.subjectId || Boolean(data.periodId), {
    message: 'Choose the period this subject register belongs to',
    path: ['periodId'],
  });

export const listAttendanceSessionsSchema = paginationSchema.merge(sortSchema).extend({
  sectionId: uuidSchema.optional(),
  academicYearId: uuidSchema.optional(),
  periodId: uuidSchema.optional(),
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
  status: z.enum(ATTENDANCE_SESSION_STATUSES).optional(),
  /** Requires the correction-approval permission; refused otherwise. */
  includeArchived: z.coerce.boolean().default(false),
});

const attendanceMarkSchema = z
  .object({
    studentId: uuidSchema,
    status: z.enum(ATTENDANCE_MARK_STATUSES),
    minutesLate: minutesLateSchema.nullable().optional(),
    remarks: remarksSchema,
  })
  .superRefine((data, ctx) => {
    if (
      data.minutesLate !== null &&
      data.minutesLate !== undefined &&
      data.status !== 'late' &&
      data.status !== 'half_day'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['minutesLate'],
        message: 'Minutes late only applies to a student marked late or half day',
      });
    }
  });

/**
 * The bulk write. One request, one transaction, one register.
 *
 * `finalize: false` saves progress without submitting — a teacher interrupted halfway through
 * a class of sixty should not have to choose between losing the work and signing off a
 * half-finished register.
 */
export const submitAttendanceSchema = z
  .object({
    marks: z.array(attendanceMarkSchema).min(1, 'Mark at least one student').max(500),
    finalize: z.coerce.boolean().default(true),
    /** Optimistic lock on the session, so two teachers cannot both submit it. */
    version: z.coerce.number().int().min(1),
  })
  .superRefine((data, ctx) => {
    const seen = new Set<string>();
    data.marks.forEach((mark, position) => {
      if (seen.has(mark.studentId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['marks', position, 'studentId'],
          message: 'This student appears twice in the same register',
        });
      }
      seen.add(mark.studentId);
    });
  });

export const lockAttendanceSessionSchema = z.object({
  reason: reasonSchema,
  version: z.coerce.number().int().min(1),
});

// ── Corrections ──────────────────────────────────────────────────────────────────────

/**
 * Ask to change a mark on a submitted register.
 *
 * This never writes the new value. It writes a `pending` correction; applying it is the
 * approver's separate, separately-permissioned act.
 */
export const requestAttendanceCorrectionSchema = z
  .object({
    status: z.enum(ATTENDANCE_MARK_STATUSES),
    minutesLate: minutesLateSchema.nullable().optional(),
    reason: reasonSchema,
  })
  .superRefine((data, ctx) => {
    if (
      data.minutesLate !== null &&
      data.minutesLate !== undefined &&
      data.status !== 'late' &&
      data.status !== 'half_day'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['minutesLate'],
        message: 'Minutes late only applies to a student marked late or half day',
      });
    }
  });

/** Used by both approve and reject: a refusal is as much a decision as an approval. */
export const decideAttendanceCorrectionSchema = z.object({
  reason: reasonSchema,
  version: z.coerce.number().int().min(1),
});

export const listAttendanceCorrectionsSchema = paginationSchema.merge(sortSchema).extend({
  status: z.enum(ATTENDANCE_CORRECTION_STATUSES).optional(),
  sectionId: uuidSchema.optional(),
  studentId: uuidSchema.optional(),
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
});

// ── Employee attendance ──────────────────────────────────────────────────────────────

export const employeeCheckInSchema = z.object({
  employeeId: uuidSchema,
  /** Defaults to today in Dhaka, resolved server-side. */
  attendanceDate: calendarDateSchema.optional(),
  /** Supplied when importing from a biometric terminal; otherwise the server clock is used. */
  checkInAt: z.coerce.date().optional(),
  status: z.enum(EMPLOYEE_ATTENDANCE_STATUSES).default('present'),
  source: z.enum(EMPLOYEE_ATTENDANCE_SOURCES).default('manual'),
  deviceReference: z.string().trim().max(64).optional(),
  minutesLate: z.coerce.number().int().min(0).max(1440).nullable().optional(),
  remarks: remarksSchema,
});

export const employeeCheckOutSchema = z.object({
  employeeId: uuidSchema,
  attendanceDate: calendarDateSchema.optional(),
  checkOutAt: z.coerce.date().optional(),
  remarks: remarksSchema,
});

export const listEmployeeAttendanceSchema = paginationSchema.merge(sortSchema).extend({
  employeeId: uuidSchema.optional(),
  status: z.enum(EMPLOYEE_ATTENDANCE_STATUSES).optional(),
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
});

// ── Reports ──────────────────────────────────────────────────────────────────────────

/**
 * Per-student totals over a range.
 *
 * `studentId` optional: a guardian omits it and gets their children, a class teacher omits it
 * and gets their sections. The scope filter decides, never the caller.
 */
export const studentAttendanceSummarySchema = paginationSchema
  .extend({
    ...dateRangeFields,
    studentId: uuidSchema.optional(),
    sectionId: uuidSchema.optional(),
    academicYearId: uuidSchema.optional(),
  })
  .superRefine(checkDateRange);

export const sectionAttendanceSummarySchema = z
  .object({
    ...dateRangeFields,
    sectionId: uuidSchema.optional(),
    academicYearId: uuidSchema.optional(),
  })
  .superRefine(checkDateRange);

/**
 * Runs of consecutive absences.
 *
 * Built now so the Phase 12 automation engine has a query to call rather than a reason to
 * invent its own; nothing here notifies anybody.
 */
export const consecutiveAbsenceSchema = z
  .object({
    ...dateRangeFields,
    sectionId: uuidSchema.optional(),
    academicYearId: uuidSchema.optional(),
    /** Two consecutive absences is noise; three is the threshold most schools act on. */
    minDays: z.coerce.number().int().min(2).max(60).default(3),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .superRefine(checkDateRange);

export type OpenAttendanceSessionInput = z.infer<typeof openAttendanceSessionSchema>;
export type SubmitAttendanceInput = z.infer<typeof submitAttendanceSchema>;
export type RequestAttendanceCorrectionInput = z.infer<typeof requestAttendanceCorrectionSchema>;
export type DecideAttendanceCorrectionInput = z.infer<typeof decideAttendanceCorrectionSchema>;
export type EmployeeCheckInInput = z.infer<typeof employeeCheckInSchema>;
export type EmployeeCheckOutInput = z.infer<typeof employeeCheckOutSchema>;
export type StudentAttendanceSummaryQuery = z.infer<typeof studentAttendanceSummarySchema>;
export type SectionAttendanceSummaryQuery = z.infer<typeof sectionAttendanceSummarySchema>;
export type ConsecutiveAbsenceQuery = z.infer<typeof consecutiveAbsenceSchema>;
export type ListAttendanceSessionsQuery = z.infer<typeof listAttendanceSessionsSchema>;
export type ListAttendanceCorrectionsQuery = z.infer<typeof listAttendanceCorrectionsSchema>;
export type ListEmployeeAttendanceQuery = z.infer<typeof listEmployeeAttendanceSchema>;
export type AttendanceMarkStatus = (typeof ATTENDANCE_MARK_STATUSES)[number];
export type EmployeeAttendanceStatus = (typeof EMPLOYEE_ATTENDANCE_STATUSES)[number];
