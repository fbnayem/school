/**
 * Academic structure schemas (Phase 2).
 *
 * Everything here is institution configuration, so the validation is mostly about internal
 * consistency — dates that make sense, weights that sum, marks that fit inside the total.
 */

import { z } from 'zod';
import { INSTITUTION_TYPES, INSTRUCTION_MEDIUMS, SHIFT_KINDS } from '@shikkha/shared';
import {
  calendarDateSchema,
  paginationSchema,
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

const nameEn = z.string().trim().min(1).max(255);
const nameBn = z.string().trim().max(255).optional();

/**
 * A time of day, normalised to `HH:mm:ss`.
 *
 * The normalisation is not cosmetic. Postgres `time` columns come back as `HH:mm:ss` while a
 * form posts `HH:mm`, and every overlap check in this file compares the two as strings. Left
 * unnormalised, `08:00` sorts before `08:00:00` — so a period ending at 08:00 and one starting
 * at 08:00 would be judged to overlap, or not, depending on which side the browser trimmed.
 */
const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Use the format HH:mm')
  .transform((value) => (value.length === 5 ? `${value}:00` : value));

/**
 * Closed value sets that live as `varchar` columns with a documented union rather than as a
 * Postgres enum, because the underlying columns were declared that way. They are named here
 * so a controller, a service and a form all spell them identically.
 */
export const ROOM_KINDS = ['classroom', 'lab', 'hall', 'library', 'office'] as const;
export const CALENDAR_EVENT_KINDS = [
  'holiday',
  'exam',
  'event',
  'working_day',
  'vacation',
] as const;
export const SECTION_ASSIGNMENT_ROLES = ['class_teacher', 'assistant_class_teacher'] as const;

// ── Institutions and campuses ────────────────────────────────────────────────────────

export const createInstitutionSchema = z.object({
  code: code(32),
  nameEn,
  nameBn,
  type: z.enum(INSTITUTION_TYPES).default('school'),
  medium: z.enum(INSTRUCTION_MEDIUMS).default('bangla'),
  /** EIIN — the Ministry's institution identifier. Six digits where present. */
  eiin: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'An EIIN is six digits')
    .optional(),
  educationBoard: z.string().trim().max(32).optional(),
  establishedYear: z.coerce.number().int().min(1800).max(new Date().getUTCFullYear()).optional(),
  addressLine1: z.string().trim().max(255).optional(),
  district: z.string().trim().max(64).optional(),
  division: z.string().trim().max(32).optional(),
  phone: z.string().trim().max(20).optional(),
  email: z.string().trim().toLowerCase().email().max(320).optional(),
  website: z.string().trim().url().max(255).optional(),
});

export const updateInstitutionSchema = createInstitutionSchema
  .partial()
  .extend({ version: z.number().int().min(1) });

export const createCampusSchema = z.object({
  institutionId: uuidSchema,
  code: code(32),
  nameEn,
  nameBn,
  isPrimary: z.boolean().default(false),
  addressLine1: z.string().trim().max(255).optional(),
  district: z.string().trim().max(64).optional(),
  division: z.string().trim().max(32).optional(),
  phone: z.string().trim().max(20).optional(),
});

// ── Academic years and terms ─────────────────────────────────────────────────────────

export const createAcademicYearSchema = z
  .object({
    name: z
      .string()
      .trim()
      .regex(/^[0-9]{4}(-[0-9]{2,4})?$/, 'Use a year such as 2026 or 2026-27')
      .max(32),
    startDate: calendarDateSchema,
    endDate: calendarDateSchema,
    isCurrent: z.boolean().default(false),
    /** ISO weekday numbers, 0 = Sunday. Bangladesh defaults to Friday and Saturday. */
    weekendDays: z.array(z.number().int().min(0).max(6)).max(7).default([5, 6]),
  })
  .refine((data) => data.endDate > data.startDate, {
    message: 'The end date must be after the start date',
    path: ['endDate'],
  })
  .refine(
    (data) => {
      // An academic year spanning more than two calendar years is almost certainly a typo.
      const years = Number(data.endDate.slice(0, 4)) - Number(data.startDate.slice(0, 4));
      return years <= 2;
    },
    { message: 'An academic year cannot span more than two calendar years', path: ['endDate'] },
  );

export const createTermSchema = z
  .object({
    academicYearId: uuidSchema,
    nameEn,
    nameBn,
    sequence: z.coerce.number().int().min(1).max(12),
    startDate: calendarDateSchema,
    endDate: calendarDateSchema,
    /** Contribution to the annual result, in basis points. 3333 = 33.33%. */
    weightBasisPoints: z.coerce.number().int().min(0).max(10_000).default(0),
  })
  .refine((data) => data.endDate >= data.startDate, {
    message: 'The end date cannot be before the start date',
    path: ['endDate'],
  });

/**
 * Terms are validated as a set, because the invariant that matters is about the whole year:
 * the weights must sum to 100%, and the terms must not overlap. Neither is checkable one term
 * at a time, which is why the API exposes a "replace all terms for this year" endpoint
 * alongside the per-term one.
 */
export const replaceTermsSchema = z
  .object({
    academicYearId: uuidSchema,
    terms: z
      .array(
        z.object({
          id: uuidSchema.optional(),
          nameEn,
          nameBn,
          sequence: z.coerce.number().int().min(1).max(12),
          startDate: calendarDateSchema,
          endDate: calendarDateSchema,
          weightBasisPoints: z.coerce.number().int().min(0).max(10_000),
        }),
      )
      .min(1, 'An academic year needs at least one term')
      .max(12),
  })
  .superRefine((data, ctx) => {
    const total = data.terms.reduce((sum, term) => sum + term.weightBasisPoints, 0);
    if (total !== 10_000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['terms'],
        message: `Term weights must add up to 100%. They currently add up to ${(total / 100).toFixed(2)}%.`,
      });
    }

    const sequences = data.terms.map((term) => term.sequence);
    if (new Set(sequences).size !== sequences.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['terms'],
        message: 'Each term needs a distinct sequence number',
      });
    }

    // Overlapping terms would make "which term is this exam in?" ambiguous, and every mark
    // entered afterwards inherits that ambiguity.
    const ordered = [...data.terms].sort((a, b) => a.startDate.localeCompare(b.startDate));
    for (let i = 1; i < ordered.length; i += 1) {
      const previous = ordered[i - 1]!;
      const current = ordered[i]!;
      if (current.startDate <= previous.endDate) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['terms'],
          message: `"${current.nameEn}" starts before "${previous.nameEn}" ends`,
        });
      }
    }
  });

// ── Classes, sections, subjects ──────────────────────────────────────────────────────

export const createClassLevelSchema = z.object({
  code: code(16),
  nameEn,
  nameBn,
  /** Drives promotion and sorting; independent of the display name. */
  ordinal: z.coerce.number().int().min(0).max(30),
  hasGroups: z.boolean().default(false),
});

export const createSectionSchema = z.object({
  academicYearId: uuidSchema,
  classLevelId: uuidSchema,
  campusId: uuidSchema,
  shiftId: uuidSchema.optional(),
  groupId: uuidSchema.optional(),
  nameEn: z.string().trim().min(1).max(64),
  nameBn,
  capacity: z.coerce.number().int().min(1).max(500).optional(),
  roomId: uuidSchema.optional(),
});

export const createSubjectSchema = z.object({
  code: code(16),
  nameEn,
  nameBn,
  shortName: z.string().trim().max(16).optional(),
  kind: z.enum(['compulsory', 'optional', 'additional', 'co_curricular']).default('compulsory'),
  /** The Bangladeshi 4th subject: adds to GPA above the pass mark, never causes a fail. */
  isFourthSubject: z.boolean().default(false),
  excludeFromGpa: z.boolean().default(false),
  hasPractical: z.boolean().default(false),
  sortOrder: z.coerce.number().int().min(0).max(999).default(0),
});

export const createClassSubjectSchema = z
  .object({
    academicYearId: uuidSchema,
    classLevelId: uuidSchema,
    subjectId: uuidSchema,
    groupId: uuidSchema.optional(),
    periodsPerWeek: z.coerce.number().int().min(0).max(40).default(0),
    fullMarks: z.coerce.number().int().min(1).max(1000).default(100),
    passMarks: z.coerce.number().int().min(0).max(1000).default(33),
    /** e.g. `{ "theory": 70, "mcq": 25, "practical": 25 }`. Must sum to `fullMarks`. */
    markDistribution: z.record(z.string(), z.coerce.number().int().min(0)).default({}),
    isOptional: z.boolean().default(false),
  })
  .superRefine((data, ctx) => {
    if (data.passMarks > data.fullMarks) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['passMarks'],
        message: 'Pass marks cannot exceed full marks',
      });
    }
    const components = Object.values(data.markDistribution);
    if (components.length > 0) {
      const total = components.reduce((sum, value) => sum + value, 0);
      if (total !== data.fullMarks) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['markDistribution'],
          message: `The components add up to ${total}, but full marks are ${data.fullMarks}`,
        });
      }
    }
  });

/** `shifts.name_bn` is `varchar(64)`; the shared 255-character helper would overflow it. */
const shortNameBn = z.string().trim().max(64).optional();

export const createShiftSchema = z
  .object({
    campusId: uuidSchema.optional(),
    kind: z.enum(SHIFT_KINDS).default('single'),
    nameEn: z.string().trim().min(1).max(64),
    nameBn: shortNameBn,
    startTime: time,
    endTime: time,
    sortOrder: z.coerce.number().int().min(0).max(99).default(0),
  })
  .refine((data) => data.endTime > data.startTime, {
    message: 'The shift must end after it starts',
    path: ['endTime'],
  });

/**
 * Shift updates carry the optimistic-lock version. `shifts` is one of the few academic
 * configuration tables that has a `version` column, and a bell schedule edited by two
 * coordinators at once is exactly the lost-write the column exists to prevent.
 *
 * Only one of `startTime`/`endTime` may be sent, so the ordering rule cannot be checked here
 * against the stored value — `AcademicService.updateShift` merges the change over the existing
 * row and re-checks it there.
 */
export const updateShiftSchema = z
  .object({
    campusId: uuidSchema.nullable().optional(),
    kind: z.enum(SHIFT_KINDS).optional(),
    nameEn: z.string().trim().min(1).max(64).optional(),
    nameBn: z.string().trim().max(64).nullable().optional(),
    startTime: time.optional(),
    endTime: time.optional(),
    sortOrder: z.coerce.number().int().min(0).max(99).optional(),
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, { message: 'No changes were submitted' })
  .refine(
    (data) => !(data.startTime && data.endTime) || data.endTime > data.startTime,
    { message: 'The shift must end after it starts', path: ['endTime'] },
  );

export const listShiftsSchema = z.object({
  campusId: uuidSchema.optional(),
  includeArchived: z.coerce.boolean().default(false),
});

export const createCalendarEventSchema = z
  .object({
    academicYearId: uuidSchema,
    campusId: uuidSchema.optional(),
    titleEn: nameEn,
    titleBn: nameBn,
    description: z.string().trim().max(2000).optional(),
    kind: z.enum(CALENDAR_EVENT_KINDS).default('event'),
    startDate: calendarDateSchema,
    endDate: calendarDateSchema,
    isNonTeaching: z.boolean().default(false),
    /** Opens the school on a normal weekend day, e.g. a make-up day after Eid. */
    overridesWeekend: z.boolean().default(false),
  })
  .refine((data) => data.endDate >= data.startDate, {
    message: 'The end date cannot be before the start date',
    path: ['endDate'],
  });

export const listAcademicSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    academicYearId: uuidSchema.optional(),
    classLevelId: uuidSchema.optional(),
    campusId: uuidSchema.optional(),
    includeArchived: z.coerce.boolean().default(false),
  });

// ── Rooms ────────────────────────────────────────────────────────────────────────────
//
// Physical rooms belong to a campus, not to an institution directly: "Room 204" means
// nothing without knowing which campus, and two campuses of one school routinely reuse the
// same numbering. The uniqueness constraint follows the same line.

const roomNameEn = z.string().trim().min(1).max(128);
const roomNameBn = z.string().trim().max(128);

export const createRoomSchema = z.object({
  campusId: uuidSchema,
  code: code(32),
  nameEn: roomNameEn,
  nameBn: roomNameBn.optional(),
  kind: z.enum(ROOM_KINDS).default('classroom'),
  /** A room with zero seats is a data-entry slip, not a configuration. */
  capacity: z.coerce.number().int().min(1).max(2000).optional(),
  floor: z.string().trim().max(16).optional(),
  building: z.string().trim().max(64).optional(),
});

/**
 * `rooms` has no `version` column, so there is no optimistic lock to carry. Clearable fields
 * are `.nullable().optional()` — sending `null` erases the value, omitting the key leaves it
 * alone, and the two are genuinely different intentions.
 */
export const updateRoomSchema = z
  .object({
    campusId: uuidSchema.optional(),
    code: code(32).optional(),
    nameEn: roomNameEn.optional(),
    nameBn: roomNameBn.nullable().optional(),
    kind: z.enum(ROOM_KINDS).optional(),
    capacity: z.coerce.number().int().min(1).max(2000).nullable().optional(),
    floor: z.string().trim().max(16).nullable().optional(),
    building: z.string().trim().max(64).nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'No changes were submitted' });

export const listRoomsSchema = z.object({
  campusId: uuidSchema.optional(),
  kind: z.enum(ROOM_KINDS).optional(),
  includeArchived: z.coerce.boolean().default(false),
});

export const archiveRoomSchema = z.object({ reason: reasonSchema });

export type CreateRoomInput = z.infer<typeof createRoomSchema>;
export type UpdateRoomInput = z.infer<typeof updateRoomSchema>;

// ── Periods (the daily bell schedule) ────────────────────────────────────────────────

/**
 * Periods are replaced as a whole set, for the same reason terms are.
 *
 * Every invariant that matters is a property of the set rather than of one row: the sequence
 * numbers must run 1..n with no gaps, and no two periods may overlap in time. Neither is
 * checkable one period at a time, and editing them individually means passing through states
 * where the bell schedule has two 3rd periods or a hole where lunch used to be.
 */
export const replacePeriodsSchema = z
  .object({
    shiftId: uuidSchema,
    periods: z
      .array(
        z.object({
          id: uuidSchema.optional(),
          nameEn: z.string().trim().min(1).max(64),
          nameBn: z.string().trim().max(64).optional(),
          sequence: z.coerce.number().int().min(1).max(20),
          startTime: time,
          endTime: time,
          /** Tiffin and assembly occupy a slot but hold no class. */
          isBreak: z.boolean().default(false),
        }),
      )
      .min(1, 'A shift needs at least one period')
      .max(20),
  })
  .superRefine((data, ctx) => {
    data.periods.forEach((period, index) => {
      if (period.endTime <= period.startTime) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['periods', index, 'endTime'],
          message: `"${period.nameEn}" must end after it starts`,
        });
      }
    });

    // Contiguous from 1. A gap means the timetable grid has a column nothing can be placed
    // in, and a duplicate means two lessons claim the same bell.
    const sequences = data.periods.map((period) => period.sequence).sort((a, b) => a - b);
    const contiguous = sequences.every((value, index) => value === index + 1);
    if (!contiguous) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['periods'],
        message: `Period numbers must run from 1 to ${data.periods.length} with no gaps or repeats. They are currently ${sequences.join(', ')}.`,
      });
    }

    const ordered = [...data.periods].sort((a, b) => a.startTime.localeCompare(b.startTime));
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1]!;
      const current = ordered[index]!;
      if (current.startTime < previous.endTime) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['periods'],
          message: `"${current.nameEn}" starts at ${current.startTime}, before "${previous.nameEn}" ends at ${previous.endTime}`,
        });
      }
    }
  });

export type ReplacePeriodsInput = z.infer<typeof replacePeriodsSchema>;

// ── Academic calendar ────────────────────────────────────────────────────────────────

export const updateCalendarEventSchema = z
  .object({
    campusId: uuidSchema.nullable().optional(),
    titleEn: nameEn.optional(),
    titleBn: z.string().trim().max(255).nullable().optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    kind: z.enum(CALENDAR_EVENT_KINDS).optional(),
    startDate: calendarDateSchema.optional(),
    endDate: calendarDateSchema.optional(),
    isNonTeaching: z.boolean().optional(),
    overridesWeekend: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'No changes were submitted' })
  .refine((data) => !(data.startDate && data.endDate) || data.endDate >= data.startDate, {
    message: 'The end date cannot be before the start date',
    path: ['endDate'],
  });

export const listCalendarEventsSchema = z
  .object({
    academicYearId: uuidSchema.optional(),
    campusId: uuidSchema.optional(),
    kind: z.enum(CALENDAR_EVENT_KINDS).optional(),
    /** Inclusive window. An event is returned when it overlaps the window at all. */
    from: calendarDateSchema.optional(),
    to: calendarDateSchema.optional(),
    includeArchived: z.coerce.boolean().default(false),
  })
  .refine((data) => !(data.from && data.to) || data.to >= data.from, {
    message: 'The end of the range cannot be before its start',
    path: ['to'],
  });

/**
 * Removing a calendar entry is a soft archive with a recorded reason (ADR-008: academic
 * records are never hard-deleted). The endpoint is still `DELETE`, because that is what it
 * means to the person clicking it.
 */
export const deleteCalendarEventSchema = z.object({ reason: reasonSchema });

export type CreateCalendarEventInput = z.infer<typeof createCalendarEventSchema>;
export type UpdateCalendarEventInput = z.infer<typeof updateCalendarEventSchema>;

// ── Curriculum (class_subjects) ──────────────────────────────────────────────────────

const markDistributionSchema = z.record(
  z.string().trim().min(1).max(32),
  z.coerce.number().int().min(0).max(1000),
);

/**
 * The curriculum for one (class level, academic year) pair, replaced as a set.
 *
 * The set-level invariant is that a subject appears at most once per group. The row-level one
 * — components summing to full marks — is restated in `AcademicService` and, since migration
 * 0006, in a database CHECK constraint, because a distribution that does not sum is a result
 * sheet that silently reports the wrong total (KI-009).
 */
export const replaceClassSubjectsSchema = z
  .object({
    academicYearId: uuidSchema,
    classLevelId: uuidSchema,
    subjects: z
      .array(
        z.object({
          id: uuidSchema.optional(),
          subjectId: uuidSchema,
          /** Absent means the subject applies to every group in the class level. */
          groupId: uuidSchema.optional(),
          periodsPerWeek: z.coerce.number().int().min(0).max(40).default(0),
          fullMarks: z.coerce.number().int().min(1).max(1000).default(100),
          passMarks: z.coerce.number().int().min(0).max(1000).default(33),
          /** e.g. `{ "theory": 70, "mcq": 30 }`. Must sum to `fullMarks` when present. */
          markDistribution: markDistributionSchema.default({}),
          isOptional: z.boolean().default(false),
        }),
      )
      .min(1, 'A class studies at least one subject')
      .max(40),
  })
  .superRefine((data, ctx) => {
    const seen = new Set<string>();
    data.subjects.forEach((entry, index) => {
      if (entry.passMarks > entry.fullMarks) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['subjects', index, 'passMarks'],
          message: 'Pass marks cannot exceed full marks',
        });
      }

      const components = Object.values(entry.markDistribution);
      if (components.length > 0) {
        const total = components.reduce((sum, value) => sum + value, 0);
        if (total !== entry.fullMarks) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['subjects', index, 'markDistribution'],
            message: `The components add up to ${total}, but full marks are ${entry.fullMarks}`,
          });
        }
      }

      const key = `${entry.subjectId}:${entry.groupId ?? 'all'}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['subjects', index, 'subjectId'],
          message: 'This subject is listed twice for the same group',
        });
      }
      seen.add(key);
    });
  });

export const listClassSubjectsSchema = z.object({
  academicYearId: uuidSchema,
  classLevelId: uuidSchema.optional(),
  includeArchived: z.coerce.boolean().default(false),
});

export type ReplaceClassSubjectsInput = z.infer<typeof replaceClassSubjectsSchema>;

// ── Teacher assignments ──────────────────────────────────────────────────────────────
//
// These rows are not bookkeeping. They are the join behind `students.view.assigned` and
// `results.view.assigned`, so creating one widens what a teacher can see and removing one
// narrows it. Both directions are audited, and unassignment requires a written reason.

const effectiveWindow = {
  effectiveFrom: calendarDateSchema.optional(),
  effectiveTo: calendarDateSchema.optional(),
};

function windowIsOrdered(data: { effectiveFrom?: string; effectiveTo?: string }): boolean {
  return !(data.effectiveFrom && data.effectiveTo) || data.effectiveTo >= data.effectiveFrom;
}

export const assignSectionTeacherSchema = z
  .object({
    academicYearId: uuidSchema,
    sectionId: uuidSchema,
    employeeId: uuidSchema,
    role: z.enum(SECTION_ASSIGNMENT_ROLES).default('class_teacher'),
    ...effectiveWindow,
  })
  .refine(windowIsOrdered, {
    message: 'The assignment cannot end before it starts',
    path: ['effectiveTo'],
  });

export const assignSubjectTeacherSchema = z
  .object({
    academicYearId: uuidSchema,
    sectionId: uuidSchema,
    subjectId: uuidSchema,
    employeeId: uuidSchema,
    /** The teacher who signs off marks when several share a subject. One per section+subject. */
    isPrimary: z.boolean().default(true),
    ...effectiveWindow,
  })
  .refine(windowIsOrdered, {
    message: 'The assignment cannot end before it starts',
    path: ['effectiveTo'],
  });

export const unassignTeacherSchema = z.object({ reason: reasonSchema });

export const listTeacherAssignmentsSchema = z.object({
  academicYearId: uuidSchema.optional(),
  sectionId: uuidSchema.optional(),
  subjectId: uuidSchema.optional(),
  employeeId: uuidSchema.optional(),
  includeArchived: z.coerce.boolean().default(false),
});

export type AssignSectionTeacherInput = z.infer<typeof assignSectionTeacherSchema>;
export type AssignSubjectTeacherInput = z.infer<typeof assignSubjectTeacherSchema>;
