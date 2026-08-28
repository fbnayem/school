/**
 * Student schemas (Phase 3).
 *
 * These are the schemas that decide what a school can record about a child, so the choices
 * here are policy as much as validation:
 *
 *  - Only `fullNameEn`, `dateOfBirth`, `gender` and the admission details are required.
 *    Bangladeshi schools routinely admit students whose paperwork arrives later; forcing a
 *    birth registration number at creation time means clerks type placeholder values, which
 *    is worse than an honest null.
 *  - Medical fields exist in a separate schema, because writing them requires a permission
 *    that most staff do not have.
 */

import { z } from 'zod';
import { ageInYears, calendarDate, GENDERS, BLOOD_GROUPS, RELIGIONS } from '@shikkha/shared';
import {
  birthRegistrationSchema,
  calendarDateSchema,
  nidSchema,
  optionalBdPhoneSchema,
  paginationSchema,
  reasonSchema,
  searchSchema,
  sortSchema,
  uuidSchema,
} from './common';

const nameEn = z.string().trim().min(2, 'Enter at least 2 characters').max(255);
const nameBn = z.string().trim().max(255).optional();

export const createStudentSchema = z
  .object({
    studentCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]+$/, 'Use letters, numbers and hyphens only')
      .max(32)
      .optional(),
    admissionNumber: z.string().trim().min(1).max(32).optional(),
    admissionDate: calendarDateSchema,

    fullNameEn: nameEn,
    fullNameBn: nameBn,
    nickname: z.string().trim().max(64).optional(),

    dateOfBirth: calendarDateSchema,
    gender: z.enum(GENDERS),
    bloodGroup: z.enum(BLOOD_GROUPS).optional(),
    religion: z.enum(RELIGIONS).optional(),
    nationality: z.string().trim().max(64).default('Bangladeshi'),

    birthRegistrationNumber: birthRegistrationSchema.optional(),
    nationalId: nidSchema.optional(),

    fatherNameEn: z.string().trim().max(255).optional(),
    fatherNameBn: nameBn,
    motherNameEn: z.string().trim().max(255).optional(),
    motherNameBn: nameBn,

    phone: optionalBdPhoneSchema,
    email: z.string().trim().toLowerCase().email().max(320).optional().or(z.literal('')),
    presentAddress: z.string().trim().max(1000).optional(),
    permanentAddress: z.string().trim().max(1000).optional(),
    district: z.string().trim().max(64).optional(),
    division: z.string().trim().max(32).optional(),

    previousInstitutionName: z.string().trim().max(255).optional(),
    previousClassCompleted: z.string().trim().max(64).optional(),
    transferCertificateNumber: z.string().trim().max(64).optional(),

    /** Optional enrolment applied in the same transaction as the student is created. */
    enrollment: z
      .object({
        academicYearId: uuidSchema,
        sectionId: uuidSchema,
        rollNumber: z.string().trim().min(1).max(16),
        groupId: uuidSchema.optional(),
        enrolledOn: calendarDateSchema.optional(),
      })
      .optional(),
  })
  .superRefine((data, ctx) => {
    // Cross-field rules the database check constraints also enforce, restated here so the
    // user sees them attached to the right field instead of as a generic 409.
    if (data.admissionDate < data.dateOfBirth) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['admissionDate'],
        message: 'Admission date cannot be before the date of birth',
      });
    }

    try {
      const age = ageInYears(calendarDate(data.dateOfBirth), calendarDate(data.admissionDate));
      // A wide band on purpose: it catches a mistyped year without refusing a genuine
      // late-entry or adult learner at a training institute.
      if (age < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['dateOfBirth'],
          message: 'The student would be under 2 years old at admission — check the date of birth',
        });
      }
      if (age > 60) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['dateOfBirth'],
          message: 'The student would be over 60 at admission — check the date of birth',
        });
      }
    } catch {
      // The date format was already rejected by calendarDateSchema; nothing to add.
    }
  });

export type CreateStudentInput = z.infer<typeof createStudentSchema>;

/**
 * Updates are a partial of the creatable identity fields only.
 *
 * Status, enrolment and archival are deliberately excluded: each has its own endpoint with its
 * own permission and its own audit record, because "the clerk edited a field" and "the student
 * was withdrawn from the school" are not the same event and must not look the same in the log.
 */
export const updateStudentSchema = z
  .object({
    fullNameEn: nameEn.optional(),
    fullNameBn: nameBn,
    nickname: z.string().trim().max(64).nullable().optional(),
    dateOfBirth: calendarDateSchema.optional(),
    gender: z.enum(GENDERS).optional(),
    bloodGroup: z.enum(BLOOD_GROUPS).nullable().optional(),
    religion: z.enum(RELIGIONS).nullable().optional(),
    nationality: z.string().trim().max(64).optional(),
    birthRegistrationNumber: birthRegistrationSchema.nullable().optional(),
    nationalId: nidSchema.nullable().optional(),
    fatherNameEn: z.string().trim().max(255).nullable().optional(),
    fatherNameBn: z.string().trim().max(255).nullable().optional(),
    motherNameEn: z.string().trim().max(255).nullable().optional(),
    motherNameBn: z.string().trim().max(255).nullable().optional(),
    phone: optionalBdPhoneSchema,
    email: z.string().trim().toLowerCase().email().max(320).nullable().optional(),
    presentAddress: z.string().trim().max(1000).nullable().optional(),
    permanentAddress: z.string().trim().max(1000).nullable().optional(),
    district: z.string().trim().max(64).nullable().optional(),
    division: z.string().trim().max(32).nullable().optional(),
    previousInstitutionName: z.string().trim().max(255).nullable().optional(),
    /** Optimistic lock. Rejecting a stale write beats silently overwriting a colleague. */
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, {
    message: 'No changes were submitted',
  });

export type UpdateStudentInput = z.infer<typeof updateStudentSchema>;

/** Medical data is written through its own endpoint, gated on `students.medical.view`. */
export const updateStudentMedicalSchema = z.object({
  medicalConditions: z.string().trim().max(2000).nullable().optional(),
  allergies: z.string().trim().max(2000).nullable().optional(),
  specialNeeds: z.string().trim().max(2000).nullable().optional(),
  emergencyMedicalNote: z.string().trim().max(2000).nullable().optional(),
  version: z.number().int().min(1),
});

export const listStudentsSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    academicYearId: uuidSchema.optional(),
    classLevelId: uuidSchema.optional(),
    sectionId: uuidSchema.optional(),
    campusId: uuidSchema.optional(),
    status: z
      .enum(['active', 'on_leave', 'transferred', 'withdrawn', 'graduated', 'alumni', 'archived'])
      .optional(),
    gender: z.enum(GENDERS).optional(),
    /** Include archived rows. Requires the archive permission; refused otherwise. */
    includeArchived: z.coerce.boolean().default(false),
  });

export const STUDENT_SORT_FIELDS = [
  'fullNameEn',
  'studentCode',
  'admissionNumber',
  'admissionDate',
  'dateOfBirth',
  'createdAt',
] as const;

export const archiveStudentSchema = z.object({
  reason: reasonSchema,
});

/**
 * Status transitions.
 *
 * `effectiveDate` is separate from "now" because a withdrawal is usually recorded days after
 * it took effect, and attendance and fee calculations must use the real date, not the day the
 * clerk got around to it.
 */
export const changeStudentStatusSchema = z.object({
  status: z.enum(['active', 'on_leave', 'transferred', 'withdrawn', 'graduated', 'alumni']),
  effectiveDate: calendarDateSchema,
  reason: reasonSchema,
  transferredToInstitution: z.string().trim().max(255).optional(),
});

export const enrollStudentSchema = z.object({
  academicYearId: uuidSchema,
  sectionId: uuidSchema,
  rollNumber: z.string().trim().min(1).max(16),
  groupId: uuidSchema.optional(),
  enrolledOn: calendarDateSchema,
  isRepeating: z.boolean().default(false),
});
