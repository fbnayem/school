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
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Use the format HH:mm');

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

export const createShiftSchema = z
  .object({
    campusId: uuidSchema.optional(),
    kind: z.enum(SHIFT_KINDS).default('single'),
    nameEn: z.string().trim().min(1).max(64),
    nameBn,
    startTime: time,
    endTime: time,
    sortOrder: z.coerce.number().int().min(0).max(99).default(0),
  })
  .refine((data) => data.endTime > data.startTime, {
    message: 'The shift must end after it starts',
    path: ['endTime'],
  });

export const createCalendarEventSchema = z
  .object({
    academicYearId: uuidSchema,
    campusId: uuidSchema.optional(),
    titleEn: nameEn,
    titleBn: nameBn,
    description: z.string().trim().max(2000).optional(),
    kind: z.enum(['holiday', 'exam', 'event', 'working_day', 'vacation']).default('event'),
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
