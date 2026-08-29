/**
 * Admission schemas (Phase 5).
 *
 * The interesting one is `publicAdmissionApplicationSchema`: it validates the only
 * unauthenticated write in the platform, so it is strict about everything — the institution
 * is addressed by public slug and code (never an id), the phone number is normalised to
 * E.164 on parse, and unknown keys are stripped by the pipe, so a forged `tenantId` or
 * `status` in the body never reaches an insert.
 */

import { z } from 'zod';
import {
  ageInYears,
  calendarDate,
  GENDERS,
  GUARDIAN_RELATIONS,
  todayInDhaka,
} from '@shikkha/shared';
import {
  birthRegistrationSchema,
  bdPhoneSchema,
  calendarDateSchema,
  nidSchema,
  paginationSchema,
  positiveMoneySchema,
  reasonSchema,
  searchSchema,
  sortSchema,
  uuidSchema,
} from './common';

// ─────────────────────────────────────────────────────────────────────────────────────
// Shared primitives
// ─────────────────────────────────────────────────────────────────────────────────────

const nameEn = z.string().trim().min(2, 'Enter at least 2 characters').max(255);
const nameBn = z.string().trim().max(255).optional();
const shortName = z.string().trim().min(2, 'Enter at least 2 characters').max(128);

/** A mark or a marks total: a decimal string with at most two places, never a number. */
const marks = z
  .string()
  .trim()
  .regex(/^\d{1,4}(\.\d{1,2})?$/, 'Enter marks with at most two decimal places');

/** 0 to 100 inclusive, as a decimal string. */
const percentScore = z
  .string()
  .trim()
  .regex(/^(100(\.0{1,2})?|\d{1,2}(\.\d{1,2})?)$/, 'Enter a score between 0 and 100');

/** GPA on the Bangladeshi 5.00 scale, as a decimal string. */
const gpa = z
  .string()
  .trim()
  .regex(/^[0-5](\.\d{1,2})?$/, 'Enter a GPA between 0.00 and 5.00')
  .refine((value) => Number(value) <= 5, 'A GPA cannot exceed 5.00');

const optionalEmail = z.string().trim().toLowerCase().email().max(320).optional().or(z.literal(''));

const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Use the format HH:mm')
  .optional();

// ─────────────────────────────────────────────────────────────────────────────────────
// Status vocabulary. The full set mirrors the `admission_application_status` enum; the
// manual-transition subset excludes the states owned by dedicated endpoints (offers and
// enrolment), so a clerk cannot bypass the seat check by "just changing the status".
// ─────────────────────────────────────────────────────────────────────────────────────

export const ADMISSION_APPLICATION_STATUSES = [
  'submitted',
  'under_review',
  'shortlisted',
  'test_scheduled',
  'tested',
  'interviewed',
  'selected',
  'waitlisted',
  'rejected',
  'offered',
  'accepted',
  'declined',
  'enrolled',
  'withdrawn',
] as const;

export type AdmissionApplicationStatus = (typeof ADMISSION_APPLICATION_STATUSES)[number];

/** Targets reachable through the generic transition endpoint. */
export const ADMISSION_MANUAL_TRANSITION_TARGETS = [
  'under_review',
  'shortlisted',
  'test_scheduled',
  'tested',
  'interviewed',
  'selected',
  'waitlisted',
  'rejected',
  'withdrawn',
] as const;

export const ADMISSION_SESSION_STATUSES = ['draft', 'open', 'closed', 'completed'] as const;

// ─────────────────────────────────────────────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────────────────────────────────────────────

/** Which class levels the cycle is open for, and how many seats each has. */
const classCapacitySchema = z
  .array(
    z.object({
      classLevelId: uuidSchema,
      seats: z.number().int().min(1, 'A class level needs at least one seat').max(10000),
    }),
  )
  .min(1, 'Open the session for at least one class level')
  .max(50)
  .refine(
    (rows) => new Set(rows.map((row) => row.classLevelId)).size === rows.length,
    'Each class level may appear only once',
  );

export const createAdmissionSessionSchema = z
  .object({
    campusId: uuidSchema.optional(),
    academicYearId: uuidSchema,
    nameEn: shortName,
    nameBn: z.string().trim().max(128).optional(),
    applicationStartDate: calendarDateSchema,
    applicationEndDate: calendarDateSchema,
    applicationFee: positiveMoneySchema.default('0.00'),
    classCapacity: classCapacitySchema,
  })
  .superRefine((data, ctx) => {
    if (data.applicationEndDate < data.applicationStartDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['applicationEndDate'],
        message: 'The application window cannot end before it starts',
      });
    }
  });

export type CreateAdmissionSessionInput = z.infer<typeof createAdmissionSessionSchema>;

export const updateAdmissionSessionSchema = z
  .object({
    campusId: uuidSchema.nullable().optional(),
    nameEn: shortName.optional(),
    nameBn: z.string().trim().max(128).nullable().optional(),
    applicationStartDate: calendarDateSchema.optional(),
    applicationEndDate: calendarDateSchema.optional(),
    applicationFee: positiveMoneySchema.optional(),
    classCapacity: classCapacitySchema.optional(),
    /** Optimistic lock. Rejecting a stale write beats silently overwriting a colleague. */
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, { message: 'No changes were submitted' });

export type UpdateAdmissionSessionInput = z.infer<typeof updateAdmissionSessionSchema>;

export const changeAdmissionSessionStatusSchema = z.object({
  status: z.enum(['open', 'closed', 'completed']),
  reason: reasonSchema,
});

export const listAdmissionSessionsSchema = paginationSchema.merge(sortSchema).extend({
  status: z.enum(ADMISSION_SESSION_STATUSES).optional(),
  academicYearId: uuidSchema.optional(),
  includeArchived: z.coerce.boolean().default(false),
});

// ─────────────────────────────────────────────────────────────────────────────────────
// Applications
// ─────────────────────────────────────────────────────────────────────────────────────

const applicantFields = z.object({
  applicantNameEn: nameEn,
  applicantNameBn: nameBn,
  dateOfBirth: calendarDateSchema,
  gender: z.enum(GENDERS),
  birthRegistrationNumber: birthRegistrationSchema.optional(),

  previousSchoolName: z.string().trim().max(255).optional(),
  previousClassCompleted: z.string().trim().max(64).optional(),
  previousResultGpa: gpa.optional(),

  guardianNameEn: nameEn,
  guardianNameBn: nameBn,
  guardianRelation: z.enum(GUARDIAN_RELATIONS),
  guardianPhone: bdPhoneSchema,
  guardianEmail: optionalEmail,
  guardianNid: nidSchema.optional(),
  presentAddress: z.string().trim().max(1000).optional(),

  /** 'general' | 'freedom_fighter' | 'sibling' | 'staff_child' | … — school-defined. */
  quota: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_]{2,32}$/, 'Use lowercase letters, digits and underscores')
    .optional(),
});

const applicantAgeRule = (data: { dateOfBirth: string }, ctx: z.RefinementCtx): void => {
  try {
    const dob = calendarDate(data.dateOfBirth);
    const today = todayInDhaka();
    if (data.dateOfBirth >= today) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dateOfBirth'],
        message: 'The date of birth must be in the past',
      });
      return;
    }
    const age = ageInYears(dob, today);
    if (age < 2 || age > 30) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dateOfBirth'],
        message:
          'Check the date of birth — the applicant would be outside the admissible age range',
      });
    }
  } catch {
    // Already rejected by calendarDateSchema; nothing to add.
  }
};

/**
 * The public form. The institution is addressed by the organization's public slug and the
 * institution's code — never by an internal id, so the form cannot be used to probe uuids.
 * The class is addressed by its code (e.g. "C6") as printed on the admission circular.
 */
export const publicAdmissionApplicationSchema = applicantFields
  .extend({
    organizationSlug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'Not a valid school identifier'),
    institutionCode: z.string().trim().min(1).max(32),
    classLevelCode: z.string().trim().min(1).max(32),
  })
  .superRefine(applicantAgeRule);

export type PublicAdmissionApplicationInput = z.infer<typeof publicAdmissionApplicationSchema>;

/** Counter entry by staff: same applicant shape, addressed by internal ids. */
export const createAdmissionApplicationSchema = applicantFields
  .extend({
    sessionId: uuidSchema,
    classLevelId: uuidSchema,
  })
  .superRefine(applicantAgeRule);

export type CreateAdmissionApplicationInput = z.infer<typeof createAdmissionApplicationSchema>;

export const listAdmissionApplicationsSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    sessionId: uuidSchema.optional(),
    classLevelId: uuidSchema.optional(),
    status: z.enum(ADMISSION_APPLICATION_STATUSES).optional(),
    source: z.enum(['online', 'counter']).optional(),
    quota: z.string().trim().max(32).optional(),
    includeArchived: z.coerce.boolean().default(false),
  });

export const ADMISSION_APPLICATION_SORT_FIELDS = [
  'applicantNameEn',
  'applicationNumber',
  'submittedAt',
  'status',
  'dateOfBirth',
  'createdAt',
] as const;

/**
 * The generic transition. Reason is mandatory: every movement of a child's application is a
 * decision someone made, and the audit trail records why.
 */
export const transitionAdmissionApplicationSchema = z.object({
  status: z.enum(ADMISSION_MANUAL_TRANSITION_TARGETS),
  reason: reasonSchema,
});

export type TransitionAdmissionApplicationInput = z.infer<
  typeof transitionAdmissionApplicationSchema
>;

// ─────────────────────────────────────────────────────────────────────────────────────
// Documents
// ─────────────────────────────────────────────────────────────────────────────────────

export const addAdmissionDocumentSchema = z.object({
  /** A storage key produced by the storage service — validated, never trusted as a path. */
  storageKey: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .regex(/^[A-Za-z0-9/_.-]+$/, 'Not a valid storage key')
    .refine((value) => !value.includes('..'), 'Not a valid storage key'),
  documentType: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_]{2,48}$/, 'Use lowercase letters, digits and underscores'),
  title: z.string().trim().min(1).max(255),
});

// ─────────────────────────────────────────────────────────────────────────────────────
// Tests and results
// ─────────────────────────────────────────────────────────────────────────────────────

export const createAdmissionTestSchema = z
  .object({
    classLevelId: uuidSchema.optional(),
    nameEn: shortName,
    nameBn: z.string().trim().max(128).optional(),
    testDate: calendarDateSchema,
    startTime: time,
    totalMarks: marks,
    passMarks: marks,
    venue: z.string().trim().max(255).optional(),
  })
  .superRefine((data, ctx) => {
    if (Number(data.totalMarks) <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['totalMarks'],
        message: 'Total marks must be greater than zero',
      });
    }
    if (Number(data.passMarks) > Number(data.totalMarks)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['passMarks'],
        message: 'Pass marks cannot exceed total marks',
      });
    }
  });

export type CreateAdmissionTestInput = z.infer<typeof createAdmissionTestSchema>;

export const updateAdmissionTestSchema = z
  .object({
    classLevelId: uuidSchema.nullable().optional(),
    nameEn: shortName.optional(),
    nameBn: z.string().trim().max(128).nullable().optional(),
    testDate: calendarDateSchema.optional(),
    startTime: time,
    totalMarks: marks.optional(),
    passMarks: marks.optional(),
    venue: z.string().trim().max(255).nullable().optional(),
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, { message: 'No changes were submitted' });

export const enterAdmissionTestResultsSchema = z.object({
  results: z
    .array(
      z
        .object({
          applicationId: uuidSchema,
          marksObtained: marks.optional(),
          isAbsent: z.boolean().default(false),
        })
        .superRefine((row, ctx) => {
          if (row.isAbsent && row.marksObtained !== undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['isAbsent'],
              message:
                'An absent candidate cannot also have marks. A zero is a mark that was earned; an absence is not.',
            });
          }
          if (!row.isAbsent && row.marksObtained === undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['marksObtained'],
              message: 'Enter the marks, or mark the candidate absent',
            });
          }
        }),
    )
    .min(1, 'Send at least one result')
    .max(500),
});

export type EnterAdmissionTestResultsInput = z.infer<typeof enterAdmissionTestResultsSchema>;

// ─────────────────────────────────────────────────────────────────────────────────────
// Interviews
// ─────────────────────────────────────────────────────────────────────────────────────

export const scheduleAdmissionInterviewSchema = z.object({
  scheduledAt: z.coerce.date(),
  panelName: z.string().trim().max(128).optional(),
  interviewerEmployeeId: uuidSchema.optional(),
});

export const scoreAdmissionInterviewSchema = z.object({
  /** 0–100 as a decimal string, matching how the merit formula consumes it. */
  score: percentScore,
  remarks: z.string().trim().max(1000).optional(),
  version: z.number().int().min(1),
});

// ─────────────────────────────────────────────────────────────────────────────────────
// Merit lists
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The ranking criteria. Weights are basis points and must sum to exactly 10000, so a list
 * whose criteria say 60/30/10 is verifiably 60/30/10. Quota bonuses are flat points added
 * to the 0–100 aggregate for applicants carrying that quota tag.
 */
export const meritCriteriaSchema = z
  .object({
    testWeightBp: z.number().int().min(0).max(10000),
    interviewWeightBp: z.number().int().min(0).max(10000),
    previousResultWeightBp: z.number().int().min(0).max(10000),
    quotaBonuses: z
      .record(z.string().regex(/^[a-z0-9_]{2,32}$/), z.number().int().min(0).max(100))
      .default({}),
  })
  .refine(
    (criteria) =>
      criteria.testWeightBp + criteria.interviewWeightBp + criteria.previousResultWeightBp ===
      10000,
    { message: 'The three weights must sum to exactly 10000 basis points (100%)' },
  );

export type MeritCriteria = z.infer<typeof meritCriteriaSchema>;

export const generateMeritListSchema = z.object({
  classLevelId: uuidSchema,
  name: shortName,
  nameBn: z.string().trim().max(128).optional(),
  criteria: meritCriteriaSchema,
});

export type GenerateMeritListInput = z.infer<typeof generateMeritListSchema>;

// ─────────────────────────────────────────────────────────────────────────────────────
// Offers
// ─────────────────────────────────────────────────────────────────────────────────────

export const issueAdmissionOfferSchema = z.object({
  /** How long the family has to accept. The clock starts when the offer is issued. */
  expiresInDays: z.coerce.number().int().min(1).max(90).default(7),
  /** Admission fee due on acceptance. Defaults to the session's configured fee. */
  feeDue: positiveMoneySchema.optional(),
  notes: z.string().trim().max(1000).optional(),
});

export type IssueAdmissionOfferInput = z.infer<typeof issueAdmissionOfferSchema>;

export const acceptAdmissionOfferSchema = z.object({
  /** Where the new student will be enrolled. Must belong to the session's academic year. */
  sectionId: uuidSchema,
  rollNumber: z.string().trim().min(1).max(16),
  admissionDate: calendarDateSchema.optional(),
});

export type AcceptAdmissionOfferInput = z.infer<typeof acceptAdmissionOfferSchema>;

export const declineAdmissionOfferSchema = z.object({ reason: reasonSchema });
