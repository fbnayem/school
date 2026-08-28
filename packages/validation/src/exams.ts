/**
 * Examination and result schemas (Phase 8).
 *
 * Two kinds of validation live here, and the second is the interesting one:
 *
 *  1. Shape and range — a mark is a decimal string with at most two places, a percentage is
 *     between 0 and 100, a grade point fits in `numeric(3,2)`.
 *  2. **Set-level invariants that no single row can express.** A grading scale's bands must
 *     cover 0 to 100 with no overlap and no gap; an exam subject's components must add up to
 *     its full marks. Neither is checkable one item at a time, which is why both are edited as
 *     a set and validated with `superRefine` here rather than field by field.
 *
 * Everything numeric that reaches the database as `numeric` is carried as a **decimal string**
 * on the wire and compared as integer hundredths in these refinements. `0.1 + 0.2` is the
 * reason: a marksheet that says a student scored 89.99999999999999 is a defect, and the only
 * reliable way to not produce one is to never introduce a binary float in the first place.
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

// ─────────────────────────────────────────────────────────────────────────────────────
// Local primitives
// ─────────────────────────────────────────────────────────────────────────────────────

const code = (max: number) =>
  z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]+$/, 'Use letters, numbers, hyphens and underscores only')
    .min(1)
    .max(max);

const nameEn = z.string().trim().min(1).max(128);
const nameBn = z.string().trim().max(128).optional();
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Use the format HH:mm');

/** A mark or a marks total: a decimal string with at most two places, never a number. */
const marks = z
  .string()
  .trim()
  .regex(/^\d{1,4}(\.\d{1,2})?$/, 'Enter marks with at most two decimal places');

/** 0 to 100 inclusive, as a decimal string. */
const percentage = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, 'Enter a percentage with at most two decimal places')
  .refine((value) => hundredths(value) <= 10_000, 'A percentage cannot be more than 100');

/** A grade point such as "5.00". Bounded by `numeric(3,2)` and by the check constraint. */
const gradePoint = z
  .string()
  .trim()
  .regex(/^\d(\.\d{1,2})?$/, 'Enter a grade point such as 5.00')
  .refine((value) => hundredths(value) <= 1_000, 'A grade point cannot be more than 10');

/**
 * Exact decimal-string to integer-hundredths conversion.
 *
 * `Number(value) * 100` would be wrong for the same reason floating-point money is wrong:
 * `33.33 * 100` is `3332.9999999999995`, and a rounding of that is a coin flip on the
 * boundary. Splitting on the decimal point and padding is exact for every value the regexes
 * above admit.
 */
function hundredths(value: string): number {
  const [whole, fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0').slice(0, 2));
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Shared value sets
//
// Declared here rather than in `@shikkha/shared`'s constants because they are meaningful only
// to this module; the Postgres enums in `packages/db/src/schema/exams.ts` are the other half
// of the same contract and the two must be edited together.
// ─────────────────────────────────────────────────────────────────────────────────────

export const EXAM_TYPES = [
  'class_test',
  'midterm',
  'half_yearly',
  'annual',
  'model_test',
  'board_practice',
] as const;

export const EXAM_STATUSES = [
  'draft',
  'scheduled',
  'ongoing',
  'marks_entry',
  'under_review',
  'published',
  'archived',
] as const;

/**
 * The statuses an exam manager may set directly.
 *
 * `under_review`, `published` and the return from `published` are deliberately absent: each is
 * a distinct, separately permissioned act (`results.review`, `results.publish`,
 * `results.unpublish`) with its own audit record. Allowing them through a generic status
 * endpoint would let `exams.manage` publish results, which is the exact separation of duties
 * this module exists to enforce.
 */
export const EXAM_MANAGEABLE_STATUSES = [
  'draft',
  'scheduled',
  'ongoing',
  'marks_entry',
  'archived',
] as const;

export const MARK_ENTRY_STATUSES = ['draft', 'submitted', 'approved'] as const;

/** The four assessable components of a Bangladeshi exam paper. */
export const EXAM_MARK_COMPONENTS = ['written', 'mcq', 'practical', 'continuous'] as const;

export const EXAM_SORT_FIELDS = ['nameEn', 'code', 'startDate', 'status', 'createdAt'] as const;

export const RESULT_SORT_FIELDS = [
  'obtainedMarks',
  'gpa',
  'percentage',
  'positionInSection',
  'createdAt',
] as const;

// ─────────────────────────────────────────────────────────────────────────────────────
// Grading scales and bands
// ─────────────────────────────────────────────────────────────────────────────────────

export const createGradingScaleSchema = z.object({
  code: code(32),
  nameEn,
  nameBn,
  description: z.string().trim().max(2000).optional(),
  isDefault: z.boolean().default(false),
});

export const updateGradingScaleSchema = z
  .object({
    nameEn: nameEn.optional(),
    nameBn: z.string().trim().max(128).nullable().optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    isDefault: z.boolean().optional(),
    /** Optimistic lock. Rejecting a stale write beats silently overwriting a colleague. */
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, {
    message: 'No changes were submitted',
  });

export const archiveGradingScaleSchema = z.object({ reason: reasonSchema });

export const listGradingScalesSchema = paginationSchema.merge(searchSchema).extend({
  includeArchived: z.coerce.boolean().default(false),
});

/**
 * Replace the whole band set of a grading scale.
 *
 * Wholesale, because coverage is a property of the set. The rules, restated from the schema
 * so a caller reading only this file still gets them right:
 *
 *   * Bands are half-open: `[minPercentage, maxPercentage)`. The topmost band includes 100.
 *   * The lowest band starts at 0, the highest ends at 100, and each band starts exactly where
 *     the previous one ends. That makes overlap and gap the same check with two messages.
 *   * At least one passing and one failing band. A scale with no failing band cannot express
 *     a failed subject, and a subject that cannot be failed breaks the compulsory-fail rule.
 */
export const replaceGradeBandsSchema = z
  .object({
    bands: z
      .array(
        z.object({
          id: uuidSchema.optional(),
          grade: z.string().trim().min(1).max(8),
          gradeBn: z.string().trim().max(16).optional(),
          minPercentage: percentage,
          maxPercentage: percentage,
          gradePoint,
          isPassing: z.boolean().default(true),
          sortOrder: z.coerce.number().int().min(0).max(99).default(0),
        }),
      )
      .min(2, 'A grading scale needs at least a passing and a failing band')
      .max(20),
  })
  .superRefine((data, ctx) => {
    const bands = data.bands.map((band) => ({
      grade: band.grade,
      min: hundredths(band.minPercentage),
      max: hundredths(band.maxPercentage),
      point: hundredths(band.gradePoint),
      isPassing: band.isPassing,
    }));

    const grades = bands.map((band) => band.grade);
    if (new Set(grades).size !== grades.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bands'],
        message: 'Each grade letter may appear only once in a scale',
      });
    }

    for (const band of bands) {
      if (band.max <= band.min) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['bands'],
          message: `"${band.grade}" ends at or before it starts`,
        });
      }
    }

    if (!bands.some((band) => band.isPassing)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bands'],
        message: 'A grading scale needs at least one passing band',
      });
    }
    if (!bands.some((band) => !band.isPassing)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bands'],
        message:
          'A grading scale needs at least one failing band, or no subject could ever be failed',
      });
    }

    const ordered = [...bands].sort((a, b) => a.min - b.min);

    if (ordered[0]!.min !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bands'],
        message: `The lowest band must start at 0, not ${(ordered[0]!.min / 100).toFixed(2)}`,
      });
    }
    if (ordered[ordered.length - 1]!.max !== 10_000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bands'],
        message: 'The highest band must end at 100',
      });
    }

    for (let i = 1; i < ordered.length; i += 1) {
      const previous = ordered[i - 1]!;
      const current = ordered[i]!;
      if (current.min < previous.max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['bands'],
          message: `Grade bands overlap: "${previous.grade}" and "${current.grade}" both contain ${(current.min / 100).toFixed(2)}%`,
        });
      } else if (current.min > previous.max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['bands'],
          message: `Grade bands leave a gap between "${previous.grade}" and "${current.grade}": nothing covers ${(previous.max / 100).toFixed(2)}%`,
        });
      }
    }

    // A higher band must be worth at least as much as a lower one, or the marksheet says a
    // student improved their marks and lost grade points.
    for (let i = 1; i < ordered.length; i += 1) {
      if (ordered[i]!.point < ordered[i - 1]!.point) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['bands'],
          message: `"${ordered[i]!.grade}" covers higher marks than "${ordered[i - 1]!.grade}" but is worth fewer grade points`,
        });
      }
    }
  });

// ─────────────────────────────────────────────────────────────────────────────────────
// Exams
// ─────────────────────────────────────────────────────────────────────────────────────

export const createExamSchema = z
  .object({
    academicYearId: uuidSchema,
    termId: uuidSchema.optional(),
    campusId: uuidSchema.optional(),
    gradingScaleId: uuidSchema,
    code: code(32),
    nameEn,
    nameBn,
    type: z.enum(EXAM_TYPES).default('class_test'),
    /** Contribution to the term or annual result, in basis points. 10000 = 100%. */
    weightageBasisPoints: z.coerce.number().int().min(0).max(10_000).default(10_000),
    startDate: calendarDateSchema.optional(),
    endDate: calendarDateSchema.optional(),
    instructions: z.string().trim().max(4000).optional(),
  })
  .refine((data) => !data.startDate || !data.endDate || data.endDate >= data.startDate, {
    message: 'The exam cannot end before it starts',
    path: ['endDate'],
  });

export const updateExamSchema = z
  .object({
    termId: uuidSchema.nullable().optional(),
    campusId: uuidSchema.nullable().optional(),
    gradingScaleId: uuidSchema.optional(),
    nameEn: nameEn.optional(),
    nameBn: z.string().trim().max(128).nullable().optional(),
    type: z.enum(EXAM_TYPES).optional(),
    weightageBasisPoints: z.coerce.number().int().min(0).max(10_000).optional(),
    startDate: calendarDateSchema.nullable().optional(),
    endDate: calendarDateSchema.nullable().optional(),
    instructions: z.string().trim().max(4000).nullable().optional(),
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, { message: 'No changes were submitted' });

export const listExamsSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    academicYearId: uuidSchema.optional(),
    termId: uuidSchema.optional(),
    campusId: uuidSchema.optional(),
    classLevelId: uuidSchema.optional(),
    type: z.enum(EXAM_TYPES).optional(),
    status: z.enum(EXAM_STATUSES).optional(),
    includeArchived: z.coerce.boolean().default(false),
  });

export const changeExamStatusSchema = z.object({
  status: z.enum(EXAM_MANAGEABLE_STATUSES),
  reason: z.string().trim().max(1000).optional(),
});

export const archiveExamSchema = z.object({ reason: reasonSchema });

// ─────────────────────────────────────────────────────────────────────────────────────
// Exam subjects
// ─────────────────────────────────────────────────────────────────────────────────────

const examSubjectComponents = z.object({
  writtenFullMarks: marks.optional(),
  writtenPassMarks: marks.optional(),
  mcqFullMarks: marks.optional(),
  mcqPassMarks: marks.optional(),
  practicalFullMarks: marks.optional(),
  practicalPassMarks: marks.optional(),
  continuousFullMarks: marks.optional(),
  continuousPassMarks: marks.optional(),
});

/**
 * Replace the subject configuration of one class level within one exam.
 *
 * Per class level, because that is the unit a curriculum is defined for, and as a set because
 * the component distribution has to add up. A per-row endpoint would let someone save a paper
 * whose written 70 and MCQ 40 total 110 out of 100, and there would be no moment at which the
 * server could reject it.
 */
export const replaceExamSubjectsSchema = z
  .object({
    classLevelId: uuidSchema,
    subjects: z
      .array(
        examSubjectComponents.extend({
          id: uuidSchema.optional(),
          subjectId: uuidSchema,
          groupId: uuidSchema.optional(),
          classSubjectId: uuidSchema.optional(),
          fullMarks: marks,
          passMarks: marks,
          isOptional: z.boolean().default(false),
          sortOrder: z.coerce.number().int().min(0).max(999).default(0),
        }),
      )
      .min(1, 'An exam needs at least one subject')
      .max(30),
  })
  .superRefine((data, ctx) => {
    const seen = new Set<string>();

    data.subjects.forEach((subject, index) => {
      const key = `${subject.subjectId}:${subject.groupId ?? ''}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['subjects', index, 'subjectId'],
          message: 'This subject is already configured for this class level in this exam',
        });
      }
      seen.add(key);

      const full = hundredths(subject.fullMarks);
      const pass = hundredths(subject.passMarks);
      if (full === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['subjects', index, 'fullMarks'],
          message: 'Full marks must be greater than zero',
        });
      }
      if (pass > full) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['subjects', index, 'passMarks'],
          message: 'Pass marks cannot exceed full marks',
        });
      }

      const components = [
        ['written', subject.writtenFullMarks, subject.writtenPassMarks],
        ['mcq', subject.mcqFullMarks, subject.mcqPassMarks],
        ['practical', subject.practicalFullMarks, subject.practicalPassMarks],
        ['continuous', subject.continuousFullMarks, subject.continuousPassMarks],
      ] as const;

      let componentTotal = 0;
      for (const [name, componentFull, componentPass] of components) {
        if (componentFull === undefined) {
          if (componentPass !== undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['subjects', index, `${name}PassMarks`],
              message: `Set full marks for the ${name} component before setting its pass marks`,
            });
          }
          continue;
        }
        const componentFullValue = hundredths(componentFull);
        componentTotal += componentFullValue;
        if (componentFullValue === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['subjects', index, `${name}FullMarks`],
            message: `The ${name} component must be worth more than zero, or leave it out`,
          });
        }
        if (componentPass !== undefined && hundredths(componentPass) > componentFullValue) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['subjects', index, `${name}PassMarks`],
            message: `The ${name} pass mark cannot exceed its full marks`,
          });
        }
      }

      // Either no breakdown at all, or one that accounts for exactly the full marks.
      if (componentTotal !== 0 && componentTotal !== full) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['subjects', index, 'fullMarks'],
          message: `The components add up to ${(componentTotal / 100).toFixed(2)}, but full marks are ${subject.fullMarks}`,
        });
      }
    });
  });

// ─────────────────────────────────────────────────────────────────────────────────────
// Schedules
// ─────────────────────────────────────────────────────────────────────────────────────

export const createExamScheduleSchema = z
  .object({
    examSubjectId: uuidSchema,
    sectionId: uuidSchema.optional(),
    roomId: uuidSchema.optional(),
    invigilatorEmployeeId: uuidSchema.optional(),
    examDate: calendarDateSchema,
    startTime: time,
    endTime: time,
    notes: z.string().trim().max(500).optional(),
  })
  .refine((data) => data.endTime > data.startTime, {
    message: 'The paper must end after it starts',
    path: ['endTime'],
  });

export const updateExamScheduleSchema = z
  .object({
    sectionId: uuidSchema.nullable().optional(),
    roomId: uuidSchema.nullable().optional(),
    invigilatorEmployeeId: uuidSchema.nullable().optional(),
    examDate: calendarDateSchema.optional(),
    startTime: time.optional(),
    endTime: time.optional(),
    notes: z.string().trim().max(500).nullable().optional(),
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, { message: 'No changes were submitted' })
  .refine((data) => !data.startTime || !data.endTime || data.endTime > data.startTime, {
    message: 'The paper must end after it starts',
    path: ['endTime'],
  });

export const archiveExamScheduleSchema = z.object({ reason: reasonSchema });

export const listExamSchedulesSchema = z.object({
  examSubjectId: uuidSchema.optional(),
  classLevelId: uuidSchema.optional(),
  sectionId: uuidSchema.optional(),
  roomId: uuidSchema.optional(),
});

// ─────────────────────────────────────────────────────────────────────────────────────
// Marks
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Bulk mark entry for one exam paper.
 *
 * Bulk because that is how marks are actually entered — a teacher works down a section's
 * register in one sitting — and because the whole batch has to be one transaction: a partial
 * save leaves a paper half-marked with no indication of where the entry stopped.
 *
 * An absent candidate carries no marks. The refinement below refuses a row that claims both,
 * matching the `exam_marks_absent_carries_no_marks` check constraint; the two exist together
 * so the API can explain the problem and the database can guarantee it.
 */
export const enterExamMarksSchema = z.object({
  examSubjectId: uuidSchema,
  marks: z
    .array(
      z
        .object({
          studentId: uuidSchema,
          writtenMarks: marks.optional(),
          mcqMarks: marks.optional(),
          practicalMarks: marks.optional(),
          continuousMarks: marks.optional(),
          isAbsent: z.boolean().default(false),
          remarks: z.string().trim().max(500).optional(),
        })
        .superRefine((row, ctx) => {
          const entered = [
            row.writtenMarks,
            row.mcqMarks,
            row.practicalMarks,
            row.continuousMarks,
          ].filter((value) => value !== undefined);

          if (row.isAbsent && entered.length > 0) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['isAbsent'],
              message:
                'An absent student cannot also have marks. A zero is a mark that was earned; an absence is not.',
            });
          }
          if (!row.isAbsent && entered.length === 0) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['writtenMarks'],
              message: 'Enter at least one component mark, or mark the student absent',
            });
          }
        }),
    )
    .min(1, 'Send at least one mark')
    .max(500),
});

export const submitExamMarksSchema = z.object({
  examSubjectId: uuidSchema,
  sectionId: uuidSchema.optional(),
});

export const reviewExamSchema = z.object({
  note: z.string().trim().max(1000).optional(),
});

export const approveExamMarksSchema = z.object({
  /** Approve one paper, or the whole exam when omitted. */
  examSubjectId: uuidSchema.optional(),
  note: z.string().trim().max(1000).optional(),
});

/**
 * Correct an approved mark.
 *
 * A reason is mandatory and is not a formality: after approval a mark has been signed off by
 * someone other than the person who entered it, and changing it is the single most disputed
 * action in a school. The audit record carries the before and after values alongside this
 * reason, which is what makes the change defensible three months later.
 */
export const correctExamMarkSchema = z
  .object({
    writtenMarks: marks.nullable().optional(),
    mcqMarks: marks.nullable().optional(),
    practicalMarks: marks.nullable().optional(),
    continuousMarks: marks.nullable().optional(),
    isAbsent: z.boolean().optional(),
    remarks: z.string().trim().max(500).nullable().optional(),
    reason: reasonSchema,
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 2, {
    message: 'No changes were submitted',
  })
  .superRefine((data, ctx) => {
    if (
      data.isAbsent === true &&
      [data.writtenMarks, data.mcqMarks, data.practicalMarks, data.continuousMarks].some(
        (value) => value !== undefined && value !== null,
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['isAbsent'],
        message: 'An absent student cannot also have marks',
      });
    }
  });

export const listExamMarksSchema = z.object({
  examSubjectId: uuidSchema.optional(),
  sectionId: uuidSchema.optional(),
  studentId: uuidSchema.optional(),
  status: z.enum(MARK_ENTRY_STATUSES).optional(),
});

// ─────────────────────────────────────────────────────────────────────────────────────
// Results
// ─────────────────────────────────────────────────────────────────────────────────────

export const publishExamResultsSchema = z.object({
  /** Publishing is announced to parents; a note explains an unusual timing in the trail. */
  note: z.string().trim().max(1000).optional(),
});

/**
 * Unpublishing retracts something families have already seen, so it carries the same
 * justification requirement as an archive.
 */
export const unpublishExamResultsSchema = z.object({ reason: reasonSchema });

export const examTabulationQuerySchema = z.object({
  sectionId: uuidSchema,
});

export const examSummaryQuerySchema = z.object({
  classLevelId: uuidSchema.optional(),
  sectionId: uuidSchema.optional(),
});

export const listResultsSchema = paginationSchema.merge(sortSchema).extend({
  sectionId: uuidSchema.optional(),
  classLevelId: uuidSchema.optional(),
  studentId: uuidSchema.optional(),
  onlyPassed: z.coerce.boolean().optional(),
});

// ─────────────────────────────────────────────────────────────────────────────────────

export type CreateGradingScaleInput = z.infer<typeof createGradingScaleSchema>;
export type UpdateGradingScaleInput = z.infer<typeof updateGradingScaleSchema>;
export type ReplaceGradeBandsInput = z.infer<typeof replaceGradeBandsSchema>;
export type CreateExamInput = z.infer<typeof createExamSchema>;
export type UpdateExamInput = z.infer<typeof updateExamSchema>;
export type ListExamsInput = z.infer<typeof listExamsSchema>;
export type ReplaceExamSubjectsInput = z.infer<typeof replaceExamSubjectsSchema>;
export type CreateExamScheduleInput = z.infer<typeof createExamScheduleSchema>;
export type UpdateExamScheduleInput = z.infer<typeof updateExamScheduleSchema>;
export type EnterExamMarksInput = z.infer<typeof enterExamMarksSchema>;
export type CorrectExamMarkInput = z.infer<typeof correctExamMarkSchema>;
export type ListExamMarksInput = z.infer<typeof listExamMarksSchema>;
export type ExamStatus = (typeof EXAM_STATUSES)[number];
export type ExamType = (typeof EXAM_TYPES)[number];
export type MarkEntryStatus = (typeof MARK_ENTRY_STATUSES)[number];
