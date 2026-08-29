/**
 * Homework and assignment schemas (Phase 9).
 *
 * Two rules shape everything here, both inherited from the fees module:
 *
 *  - **Marks cross the wire as decimal strings, never numbers.** `numeric(6,2)` columns
 *    arrive from the driver as strings and stay exact; a JSON float would round a 33.33
 *    before the service ever saw it. The bound against `max_marks` is enforced by the
 *    service in exact integer (hundredths) arithmetic.
 *  - **A client never states a derived fact.** There is no `isLate`, no `submittedAt`, no
 *    `status`, no `attemptNumber` in any input schema. Lateness is decided by the server
 *    clock against the assignment's deadline; the lifecycle state is decided by the
 *    publish/close/archive endpoints.
 *
 * Constants are prefixed `HOMEWORK_` because `@shikkha/validation` re-exports flat.
 */

import { z } from 'zod';
import {
  calendarDateSchema,
  paginationSchema,
  reasonSchema,
  searchSchema,
  sortSchema,
  uuidSchema,
} from './common';

// ── Value sets, mirrored from the database enums ─────────────────────────────────────

export const HOMEWORK_ASSIGNMENT_TYPES = [
  'homework',
  'project',
  'classwork',
  'practical',
  'reading',
] as const;

export const HOMEWORK_ASSIGNMENT_STATUSES = ['draft', 'published', 'closed', 'archived'] as const;

export const HOMEWORK_SUBMISSION_STATUSES = [
  'not_submitted',
  'submitted',
  'late',
  'resubmitted',
  'graded',
  'returned',
] as const;

export const HOMEWORK_ASSIGNMENT_SORT_FIELDS = [
  'title',
  'type',
  'status',
  'assignedOn',
  'dueAt',
  'createdAt',
] as const;

export const HOMEWORK_SUBMISSION_SORT_FIELDS = ['submittedAt', 'status', 'attemptNumber'] as const;

// ── Local primitives ─────────────────────────────────────────────────────────────────

/** Marks for a `numeric(6,2)` column: a non-negative decimal string, at most 9999.99. */
const homeworkMarksSchema = z
  .string()
  .trim()
  .regex(/^\d{1,4}(\.\d{1,2})?$/, 'Marks must be a decimal string like "17.50"');

/** A percentage 0–100 with at most two decimals, e.g. "10", "12.5", "100.00". */
const latePenaltySchema = z
  .string()
  .trim()
  .regex(
    /^(100(\.0{1,2})?|\d{1,2}(\.\d{1,2})?)$/,
    'The late penalty must be a percentage between 0 and 100, like "10.00"',
  );

/** An instant with an explicit offset, e.g. "2026-09-15T17:59:00+06:00". */
const instantSchema = z
  .string()
  .datetime({ offset: true, message: 'Use an ISO-8601 timestamp with a timezone offset' });

const titleSchema = z.string().trim().min(2).max(255);

// ── Assignments ──────────────────────────────────────────────────────────────────────

export const createAssignmentSchema = z
  .object({
    sectionId: uuidSchema,
    subjectId: uuidSchema,
    title: titleSchema,
    titleBn: z.string().trim().max(255).optional(),
    instructions: z.string().trim().max(20_000).optional(),
    type: z.enum(HOMEWORK_ASSIGNMENT_TYPES).default('homework'),
    assignedOn: calendarDateSchema,
    dueAt: instantSchema,
    maxMarks: homeworkMarksSchema.optional(),
    isGraded: z.boolean().default(false),
    allowLate: z.boolean().default(false),
    latePenaltyPercent: latePenaltySchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.isGraded && data.maxMarks === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxMarks'],
        message: 'A graded assignment needs its maximum marks',
      });
    }
    if (data.latePenaltyPercent !== undefined && !data.allowLate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['latePenaltyPercent'],
        message: 'A late penalty only makes sense when late submissions are allowed',
      });
    }
  });

export const updateAssignmentSchema = z
  .object({
    title: titleSchema.optional(),
    titleBn: z.string().trim().max(255).nullable().optional(),
    instructions: z.string().trim().max(20_000).nullable().optional(),
    type: z.enum(HOMEWORK_ASSIGNMENT_TYPES).optional(),
    assignedOn: calendarDateSchema.optional(),
    dueAt: instantSchema.optional(),
    maxMarks: homeworkMarksSchema.nullable().optional(),
    isGraded: z.boolean().optional(),
    allowLate: z.boolean().optional(),
    latePenaltyPercent: latePenaltySchema.nullable().optional(),
    /** The optimistic lock. Every write bumps it; a stale one is a 409. */
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, { message: 'No changes were submitted' });

export const listAssignmentsSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    sectionId: uuidSchema.optional(),
    subjectId: uuidSchema.optional(),
    academicYearId: uuidSchema.optional(),
    type: z.enum(HOMEWORK_ASSIGNMENT_TYPES).optional(),
    status: z.enum(HOMEWORK_ASSIGNMENT_STATUSES).optional(),
    includeArchived: z.coerce.boolean().default(false),
  });

/** Publish and close carry the optimistic lock and nothing else. */
export const assignmentTransitionSchema = z.object({
  version: z.number().int().min(1),
});

export const archiveAssignmentSchema = z.object({
  reason: reasonSchema,
  version: z.number().int().min(1),
});

// ── Submissions ──────────────────────────────────────────────────────────────────────

/**
 * Deliberately tiny: `submittedAt`, `isLate`, `status` and `attemptNumber` are all derived
 * by the server. Files travel separately as multipart uploads.
 */
export const submitHomeworkSchema = z.object({
  textResponse: z.string().trim().min(1).max(50_000).optional(),
});

export const listSubmissionsSchema = paginationSchema.merge(sortSchema).extend({
  status: z.enum(HOMEWORK_SUBMISSION_STATUSES).optional(),
  studentId: uuidSchema.optional(),
});

export const studentSubmissionHistorySchema = paginationSchema.extend({
  assignmentId: uuidSchema.optional(),
  academicYearId: uuidSchema.optional(),
});

// ── Grading ──────────────────────────────────────────────────────────────────────────

export const gradeSubmissionSchema = z.object({
  marks: homeworkMarksSchema,
  feedback: z.string().trim().max(5_000).optional(),
  /** A provisional grade may be saved with `false`; the default is a final mark. */
  isFinal: z.boolean().default(true),
  /**
   * Required by the service when a final grade already exists — changing a settled mark is
   * recorded with its justification. Optional here so first-time grading needs no ceremony.
   */
  reason: reasonSchema.optional(),
});

export const bulkGradeSchema = z.object({
  items: z
    .array(
      z.object({
        submissionId: uuidSchema,
        marks: homeworkMarksSchema,
        feedback: z.string().trim().max(5_000).optional(),
      }),
    )
    .min(1, 'Provide at least one grade')
    .max(200, 'Grade at most 200 submissions per request'),
});

// ── Reports and params ───────────────────────────────────────────────────────────────

export const homeworkCompletionQuerySchema = z.object({
  sectionId: uuidSchema,
});

export const homeworkAttachmentParamsSchema = z.object({
  id: uuidSchema,
  attachmentId: uuidSchema,
});

// ── Inferred types ───────────────────────────────────────────────────────────────────

export type CreateAssignmentInput = z.infer<typeof createAssignmentSchema>;
export type UpdateAssignmentInput = z.infer<typeof updateAssignmentSchema>;
export type ListAssignmentsQuery = z.infer<typeof listAssignmentsSchema>;
export type SubmitHomeworkInput = z.infer<typeof submitHomeworkSchema>;
export type ListHomeworkSubmissionsQuery = z.infer<typeof listSubmissionsSchema>;
export type StudentSubmissionHistoryQuery = z.infer<typeof studentSubmissionHistorySchema>;
export type GradeSubmissionInput = z.infer<typeof gradeSubmissionSchema>;
export type BulkGradeInput = z.infer<typeof bulkGradeSchema>;
export type HomeworkCompletionQuery = z.infer<typeof homeworkCompletionQuerySchema>;
