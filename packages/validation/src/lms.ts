/**
 * Learning Management System schemas (Phase 10).
 *
 * Two rules shape everything here, both inherited from the homework and fees modules:
 *
 *  - **Marks cross the wire as decimal strings, never numbers.** `numeric(6,2)` columns
 *    arrive from the driver as strings and stay exact; a JSON float would round a 33.33
 *    before the service ever saw it. Auto-grading arithmetic happens server-side in exact
 *    integer hundredths.
 *  - **A client never states a derived fact.** There is no `startedAt`, no `submittedAt`,
 *    no `score`, no `isGraded`, no `attemptNumber`, no elapsed time in any input schema.
 *    The server clock decides when an attempt started and whether the time limit passed;
 *    the lifecycle state is decided by the publish/archive endpoints.
 *
 * Constants are prefixed `LMS_` because `@shikkha/validation` re-exports flat.
 */

import { z } from 'zod';
import {
  paginationSchema,
  reasonSchema,
  searchSchema,
  sortSchema,
  uuidSchema,
} from './common';

// ── Value sets, mirrored from the database enums ─────────────────────────────────────

export const LMS_COURSE_STATUSES = ['draft', 'published', 'archived'] as const;

export const LMS_QUIZ_STATUSES = ['draft', 'published', 'archived'] as const;

export const LMS_RESOURCE_KINDS = ['file', 'link', 'video'] as const;

/** The kinds a client may create through the JSON endpoint; `file` travels as multipart. */
export const LMS_RESOURCE_LINK_KINDS = ['link', 'video'] as const;

export const LMS_PROGRESS_STATUSES = ['not_started', 'in_progress', 'completed'] as const;

export const LMS_QUESTION_KINDS = [
  'mcq_single',
  'mcq_multi',
  'true_false',
  'short_text',
] as const;

export const LMS_COURSE_SORT_FIELDS = ['title', 'status', 'createdAt'] as const;

// ── Local primitives ─────────────────────────────────────────────────────────────────

/**
 * Exact integer hundredths of a validated decimal string. Splitting on the decimal point
 * is exact for every value the regexes below admit; `Number(...)` on the whole string is
 * not (the homework module's discipline).
 */
function lmsHundredths(value: string): number {
  const [whole = '0', fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0').slice(0, 2));
}

/** Marks for a `numeric(6,2)` column: a non-negative decimal string, at most 9999.99. */
const lmsMarksValueSchema = z
  .string()
  .trim()
  .regex(/^\d{1,4}(\.\d{1,2})?$/, 'Marks must be a decimal string like "10.00"');

/** Marks that must be strictly positive — a question or quiz worth nothing is a mistake. */
const lmsPositiveMarksSchema = lmsMarksValueSchema.refine(
  (value) => lmsHundredths(value) > 0,
  'Marks must be greater than zero',
);

const titleSchema = z.string().trim().min(2).max(255);

// ── Courses ──────────────────────────────────────────────────────────────────────────

export const createCourseSchema = z.object({
  campusId: uuidSchema,
  academicYearId: uuidSchema,
  classLevelId: uuidSchema,
  subjectId: uuidSchema,
  title: titleSchema,
  titleBn: z.string().trim().max(255).optional(),
  description: z.string().trim().max(20_000).optional(),
});

export const updateCourseSchema = z
  .object({
    title: titleSchema.optional(),
    titleBn: z.string().trim().max(255).nullable().optional(),
    description: z.string().trim().max(20_000).nullable().optional(),
    /** The optimistic lock. Every write bumps it; a stale one is a 409. */
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, { message: 'No changes were submitted' });

export const listCoursesSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    academicYearId: uuidSchema.optional(),
    classLevelId: uuidSchema.optional(),
    subjectId: uuidSchema.optional(),
    status: z.enum(LMS_COURSE_STATUSES).optional(),
    includeArchived: z.coerce.boolean().default(false),
  });

/** Publish carries the optimistic lock and nothing else. */
export const courseTransitionSchema = z.object({
  version: z.number().int().min(1),
});

export const archiveCourseSchema = z.object({
  reason: reasonSchema,
  version: z.number().int().min(1),
});

// ── Modules and lessons (replace-as-a-set, the timetable discipline) ─────────────────

/**
 * The whole ordered module set of one course in one write. Position comes from array
 * order; an existing module keeps its id (and its lessons), a module absent from the set
 * is archived, a module without an id is created. An empty array means "this course has
 * no modules" — a real state, not an error.
 */
export const replaceCourseModulesSchema = z.object({
  version: z.number().int().min(1),
  modules: z
    .array(
      z.object({
        id: uuidSchema.optional(),
        title: titleSchema,
        isPublished: z.boolean().default(false),
      }),
    )
    .max(100, 'A course may have at most 100 modules'),
});

export const replaceModuleLessonsSchema = z.object({
  version: z.number().int().min(1),
  lessons: z
    .array(
      z.object({
        id: uuidSchema.optional(),
        title: titleSchema,
        /** Rich text stored as text; rendered by the client, never interpreted server-side. */
        content: z.string().max(200_000).optional(),
        estimatedMinutes: z.number().int().min(1).max(6000).optional(),
        isPublished: z.boolean().default(false),
      }),
    )
    .max(200, 'A module may have at most 200 lessons'),
});

// ── Lesson resources ─────────────────────────────────────────────────────────────────

/** A link or embedded video. Files travel separately as multipart uploads. */
export const addLessonLinkResourceSchema = z.object({
  kind: z.enum(LMS_RESOURCE_LINK_KINDS),
  url: z.string().trim().url('Provide a full URL, like "https://example.org/video"').max(2048),
  title: titleSchema,
});

export const lmsResourceParamsSchema = z.object({
  id: uuidSchema,
  resourceId: uuidSchema,
});

// ── Course enrolment ─────────────────────────────────────────────────────────────────

export const enrolCourseStudentsSchema = z.object({
  studentIds: z
    .array(uuidSchema)
    .min(1, 'Provide at least one student')
    .max(500, 'Enrol at most 500 students per request')
    .refine((ids) => new Set(ids).size === ids.length, {
      message: 'The same student appears more than once',
    }),
});

export const listCourseEnrolmentsSchema = paginationSchema;

// ── Lesson progress ──────────────────────────────────────────────────────────────────

/**
 * Deliberately tiny: `completedAt` is stamped by the server, status only moves forward,
 * and `secondsSpent` is an increment the server adds — a client cannot rewrite history.
 */
export const recordLessonProgressSchema = z
  .object({
    status: z.enum(['in_progress', 'completed']).optional(),
    /** Additional seconds spent since the last report. Added, never overwritten. */
    secondsSpent: z.number().int().min(0).max(86_400).optional(),
  })
  .refine((data) => data.status !== undefined || data.secondsSpent !== undefined, {
    message: 'Report a status, time spent, or both',
  });

// ── Quizzes ──────────────────────────────────────────────────────────────────────────

const quizOptionInputSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  isCorrect: z.boolean().default(false),
});

const quizQuestionInputSchema = z.object({
  kind: z.enum(LMS_QUESTION_KINDS),
  prompt: z.string().trim().min(1).max(5000),
  marks: lmsPositiveMarksSchema,
  /** mcq_multi only: proportional credit instead of all-or-nothing. */
  allowPartialCredit: z.boolean().default(false),
  options: z.array(quizOptionInputSchema).max(10).default([]),
});

/** Per-question structural rules, shared by create and replace. */
function checkQuestions(
  questions: z.infer<typeof quizQuestionInputSchema>[],
  ctx: z.RefinementCtx,
  pathPrefix: (string | number)[],
): void {
  questions.forEach((question, index) => {
    const correct = question.options.filter((option) => option.isCorrect).length;
    if (question.kind === 'short_text') {
      if (question.options.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...pathPrefix, index, 'options'],
          message: 'A short-text question has no options',
        });
      }
      return;
    }
    if (question.kind === 'true_false' && question.options.length !== 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...pathPrefix, index, 'options'],
        message: 'A true/false question has exactly two options',
      });
      return;
    }
    if (question.options.length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...pathPrefix, index, 'options'],
        message: 'A choice question needs at least two options',
      });
      return;
    }
    if ((question.kind === 'mcq_single' || question.kind === 'true_false') && correct !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...pathPrefix, index, 'options'],
        message: 'Mark exactly one option as correct',
      });
    }
    if (question.kind === 'mcq_multi' && correct === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...pathPrefix, index, 'options'],
        message: 'Mark at least one option as correct',
      });
    }
    if (question.allowPartialCredit && question.kind !== 'mcq_multi') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...pathPrefix, index, 'allowPartialCredit'],
        message: 'Partial credit applies only to multiple-answer questions',
      });
    }
  });
}

export const createQuizSchema = z
  .object({
    /** Exactly one of courseId / lessonId — the quiz's anchor. */
    courseId: uuidSchema.optional(),
    lessonId: uuidSchema.optional(),
    title: titleSchema,
    totalMarks: lmsPositiveMarksSchema,
    passMarks: lmsMarksValueSchema,
    timeLimitMinutes: z.number().int().min(1).max(600).optional(),
    attemptsAllowed: z.number().int().min(1).max(20).default(1),
    shuffleQuestions: z.boolean().default(false),
    questions: z
      .array(quizQuestionInputSchema)
      .min(1, 'A quiz needs at least one question')
      .max(100, 'A quiz may have at most 100 questions'),
  })
  .superRefine((data, ctx) => {
    if ((data.courseId === undefined) === (data.lessonId === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['courseId'],
        message: 'Anchor the quiz on exactly one of a course or a lesson',
      });
    }
    if (lmsHundredths(data.passMarks) > lmsHundredths(data.totalMarks)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['passMarks'],
        message: 'Pass marks cannot exceed the total',
      });
    }
    checkQuestions(data.questions, ctx, ['questions']);
  });

export const updateQuizSchema = z
  .object({
    title: titleSchema.optional(),
    totalMarks: lmsPositiveMarksSchema.optional(),
    passMarks: lmsMarksValueSchema.optional(),
    timeLimitMinutes: z.number().int().min(1).max(600).nullable().optional(),
    attemptsAllowed: z.number().int().min(1).max(20).optional(),
    shuffleQuestions: z.boolean().optional(),
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, { message: 'No changes were submitted' });

export const replaceQuizQuestionsSchema = z
  .object({
    version: z.number().int().min(1),
    questions: z
      .array(quizQuestionInputSchema)
      .min(1, 'A quiz needs at least one question')
      .max(100, 'A quiz may have at most 100 questions'),
  })
  .superRefine((data, ctx) => {
    checkQuestions(data.questions, ctx, ['questions']);
  });

export const quizTransitionSchema = z.object({
  version: z.number().int().min(1),
});

export const archiveQuizSchema = z.object({
  reason: reasonSchema,
  version: z.number().int().min(1),
});

// ── Attempts ─────────────────────────────────────────────────────────────────────────

/**
 * One answer per question. No derived facts: the server decides lateness against the time
 * limit, grades choice questions itself, and queues short-text answers for manual marking.
 */
export const submitQuizAttemptSchema = z.object({
  answers: z
    .array(
      z.object({
        questionId: uuidSchema,
        selectedOptionIds: z.array(uuidSchema).max(20).default([]),
        textAnswer: z.string().trim().min(1).max(10_000).optional(),
      }),
    )
    .max(200)
    .default([])
    .refine(
      (answers) => new Set(answers.map((answer) => answer.questionId)).size === answers.length,
      { message: 'The same question is answered more than once' },
    ),
});

export const listQuizAttemptsSchema = paginationSchema.extend({
  studentId: uuidSchema.optional(),
  /** Only attempts still waiting for a manual mark. */
  pendingGrading: z.coerce.boolean().default(false),
});

// ── Manual grading ───────────────────────────────────────────────────────────────────

export const gradeQuizAnswerSchema = z.object({
  /** May be zero — a wrong answer is a mark of 0, not an absence of grading. */
  marks: lmsMarksValueSchema,
  /**
   * Required by the service when the answer already carries a mark — changing a settled
   * mark is recorded with its justification. Optional here so first-time grading needs no
   * ceremony.
   */
  reason: reasonSchema.optional(),
});

// ── Reports ──────────────────────────────────────────────────────────────────────────

export const lmsCompletionQuerySchema = z.object({
  courseId: uuidSchema,
});

// ── Inferred types ───────────────────────────────────────────────────────────────────

export type CreateCourseInput = z.infer<typeof createCourseSchema>;
export type UpdateCourseInput = z.infer<typeof updateCourseSchema>;
export type ListCoursesQuery = z.infer<typeof listCoursesSchema>;
export type ReplaceCourseModulesInput = z.infer<typeof replaceCourseModulesSchema>;
export type ReplaceModuleLessonsInput = z.infer<typeof replaceModuleLessonsSchema>;
export type AddLessonLinkResourceInput = z.infer<typeof addLessonLinkResourceSchema>;
export type EnrolCourseStudentsInput = z.infer<typeof enrolCourseStudentsSchema>;
export type RecordLessonProgressInput = z.infer<typeof recordLessonProgressSchema>;
export type CreateQuizInput = z.infer<typeof createQuizSchema>;
export type UpdateQuizInput = z.infer<typeof updateQuizSchema>;
export type ReplaceQuizQuestionsInput = z.infer<typeof replaceQuizQuestionsSchema>;
export type SubmitQuizAttemptInput = z.infer<typeof submitQuizAttemptSchema>;
export type ListQuizAttemptsQuery = z.infer<typeof listQuizAttemptsSchema>;
export type GradeQuizAnswerInput = z.infer<typeof gradeQuizAnswerSchema>;
export type LmsCompletionQuery = z.infer<typeof lmsCompletionQuerySchema>;
