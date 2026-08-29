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

export type EnrollStudentInput = z.infer<typeof enrollStudentSchema>;

// ─────────────────────────────────────────────────────────────────────────────────────
// Lifecycle (Phase 3 completion): standalone enrolment, promotion, transfer, withdrawal,
// readmission, import/export, documents and bulk operations.
//
// Each mutation gets its own schema because each is its own endpoint with its own permission
// and audit action — the same reasoning that keeps status change out of `updateStudentSchema`.
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Withdrawal. The effective date is when the student actually left, which is routinely days
 * before the clerk records it; attendance and fee calculations key on the real date.
 */
export const withdrawStudentSchema = z.object({
  effectiveDate: calendarDateSchema,
  reason: reasonSchema,
});

export type WithdrawStudentInput = z.infer<typeof withdrawStudentSchema>;

/** Readmission reopens the record with a brand-new enrolment; nothing is reused or edited. */
export const readmitStudentSchema = z.object({
  academicYearId: uuidSchema,
  sectionId: uuidSchema,
  /** Omitted: the next free roll number in the section is assigned. */
  rollNumber: z.string().trim().min(1).max(16).optional(),
  effectiveDate: calendarDateSchema,
  reason: z.string().trim().max(1000).optional(),
});

export type ReadmitStudentInput = z.infer<typeof readmitStudentSchema>;

/** Section transfer within the same institution and the same academic year. */
export const transferSectionSchema = z.object({
  targetSectionId: uuidSchema,
  /** Omitted: the next free roll number in the target section is assigned. */
  rollNumber: z.string().trim().min(1).max(16).optional(),
  effectiveDate: calendarDateSchema,
  reason: reasonSchema,
});

export type TransferSectionInput = z.infer<typeof transferSectionSchema>;

/** Transfer between two institutions of the same tenant (a school group). */
export const transferInstitutionSchema = z.object({
  targetInstitutionId: uuidSchema,
  targetSectionId: uuidSchema,
  rollNumber: z.string().trim().min(1).max(16).optional(),
  effectiveDate: calendarDateSchema,
  reason: reasonSchema,
});

export type TransferInstitutionInput = z.infer<typeof transferInstitutionSchema>;

/**
 * Bulk promotion of one section into the next academic year.
 *
 * Retention is an explicit per-student decision carried in `retainedStudentIds` — a retained
 * student is re-enrolled in `repeatSectionId` (same class level, next year), which is
 * required whenever any student is retained.
 */
export const promoteSectionSchema = z
  .object({
    sourceSectionId: uuidSchema,
    targetSectionId: uuidSchema,
    /** Where retained students repeat the year. Required when `retainedStudentIds` is set. */
    repeatSectionId: uuidSchema.optional(),
    effectiveDate: calendarDateSchema,
    retainedStudentIds: z.array(uuidSchema).max(500).default([]),
  })
  .superRefine((data, ctx) => {
    if (data.targetSectionId === data.sourceSectionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetSectionId'],
        message: 'The target section must be different from the source section',
      });
    }
    if (data.retainedStudentIds.length > 0 && !data.repeatSectionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['repeatSectionId'],
        message: 'Choose the section retained students will repeat the year in',
      });
    }
  });

export type PromoteSectionInput = z.infer<typeof promoteSectionSchema>;

/** Statuses a bulk status change may set. Withdrawal and transfer have their own flows. */
export const BULK_STUDENT_STATUSES = ['active', 'on_leave'] as const;

export const bulkStatusChangeSchema = z.object({
  studentIds: z.array(uuidSchema).min(1).max(200),
  status: z.enum(BULK_STUDENT_STATUSES),
  effectiveDate: calendarDateSchema,
  reason: reasonSchema,
});

export type BulkStatusChangeInput = z.infer<typeof bulkStatusChangeSchema>;

export const bulkSectionChangeSchema = z.object({
  studentIds: z.array(uuidSchema).min(1).max(200),
  targetSectionId: uuidSchema,
  effectiveDate: calendarDateSchema,
  reason: reasonSchema,
});

export type BulkSectionChangeInput = z.infer<typeof bulkSectionChangeSchema>;

// ── Import / export ──────────────────────────────────────────────────────────────────

/** Hard cap on rows per import request. Bigger files are split by the client. */
export const STUDENT_IMPORT_MAX_ROWS = 500;

/**
 * The CSV travels inside a JSON body, whose global size limit is 100 kB — so this cap is
 * what turns "payload too large" into a message a person can act on rather than a raw 413.
 */
export const STUDENT_IMPORT_MAX_BYTES = 90_000;

/**
 * The importable columns, by header name. Deliberately the scalar subset of
 * `createStudentSchema` — enrolment, medical data and documents go through their own
 * endpoints with their own permissions.
 */
export const STUDENT_IMPORT_COLUMNS = [
  'studentCode',
  'admissionNumber',
  'admissionDate',
  'fullNameEn',
  'fullNameBn',
  'nickname',
  'dateOfBirth',
  'gender',
  'bloodGroup',
  'religion',
  'nationality',
  'birthRegistrationNumber',
  'nationalId',
  'fatherNameEn',
  'fatherNameBn',
  'motherNameEn',
  'motherNameBn',
  'phone',
  'email',
  'presentAddress',
  'permanentAddress',
  'district',
  'division',
  'previousInstitutionName',
  'previousClassCompleted',
  'transferCertificateNumber',
] as const;

export const importStudentsSchema = z.object({
  csv: z.string().min(1, 'The CSV content is empty').max(STUDENT_IMPORT_MAX_BYTES),
});

export type ImportStudentsInput = z.infer<typeof importStudentsSchema>;

/** Hard cap on exported rows; a full-school export fits, a runaway query does not. */
export const STUDENT_EXPORT_MAX_ROWS = 5000;

/**
 * Export takes the list endpoint's filters but no pagination — the caller's data scope is
 * applied identically, so a teacher exports exactly what they can list, and nothing more.
 */
export const exportStudentsSchema = searchSchema.extend({
  format: z.enum(['csv', 'json']).default('csv'),
  academicYearId: uuidSchema.optional(),
  classLevelId: uuidSchema.optional(),
  sectionId: uuidSchema.optional(),
  campusId: uuidSchema.optional(),
  status: z
    .enum(['active', 'on_leave', 'transferred', 'withdrawn', 'graduated', 'alumni', 'archived'])
    .optional(),
  gender: z.enum(GENDERS).optional(),
});

export type ExportStudentsInput = z.infer<typeof exportStudentsSchema>;

// ── Documents ────────────────────────────────────────────────────────────────────────

export const STUDENT_DOCUMENT_TYPES = [
  'birth_certificate',
  'transfer_certificate',
  'photo',
  'medical',
  'other',
] as const;

export const uploadStudentDocumentSchema = z
  .object({
    documentType: z.enum(STUDENT_DOCUMENT_TYPES),
    title: z.string().trim().min(1, 'Give the document a title').max(255),
    documentNumber: z.string().trim().max(64).optional(),
    issuedOn: calendarDateSchema.optional(),
    expiresOn: calendarDateSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.issuedOn && data.expiresOn && data.expiresOn < data.issuedOn) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresOn'],
        message: 'A document cannot expire before it was issued',
      });
    }
  });

export type UploadStudentDocumentInput = z.infer<typeof uploadStudentDocumentSchema>;

export const studentDocumentParamsSchema = z.object({
  id: uuidSchema,
  documentId: uuidSchema,
});

export const archiveStudentDocumentSchema = z.object({
  reason: reasonSchema,
});

/** Redemption of a signed download URL. The signature, not a session, is the credential. */
export const fileDownloadQuerySchema = z.object({
  key: z.string().min(1).max(512),
  expires: z.string().regex(/^\d{1,12}$/, 'Invalid expiry'),
  signature: z.string().regex(/^[0-9a-f]{64}$/, 'Invalid signature'),
});
