/**
 * Human resources schemas (Phase 15).
 *
 * Two rules shape everything here:
 *
 *  - **Money crosses the wire as a decimal string, never a number** (ADR-004). Salary basics
 *    and fixed component amounts use `positiveMoneySchema`; percentage components carry the
 *    percentage in the same two-decimal string shape, which the service reads as basis
 *    points ("12.50" is 1250bp) so every proportional calculation stays in integer
 *    arithmetic through `Money.percentage`.
 *  - **A client never states a derived fact.** There is no `status` on a contract create
 *    (a new contract is active), no `gross` or `net` anywhere — those are computed by the
 *    service from the components in sequence order — and separation is its own endpoint
 *    with its own reason, never a field smuggled into a profile update.
 */

import { z } from 'zod';
import { EMPLOYMENT_STATUSES, GENDERS, BLOOD_GROUPS, RELIGIONS } from '@shikkha/shared';
import {
  calendarDateSchema,
  bdPhoneSchema,
  optionalBdPhoneSchema,
  nidSchema,
  paginationSchema,
  positiveMoneySchema,
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

const nameEn = z.string().trim().min(1).max(128);
const nameBn = z.string().trim().max(128).optional();
const personName = z.string().trim().min(2).max(255);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

// ── Value sets, mirrored from the database enums ─────────────────────────────────────

export const EMPLOYMENT_CONTRACT_TYPES = [
  'permanent',
  'contract',
  'part_time',
  'probation',
  'guest',
] as const;

export const EMPLOYMENT_CONTRACT_STATUSES = ['active', 'ended', 'terminated'] as const;

export const SALARY_STRUCTURE_STATUSES = ['draft', 'active', 'archived'] as const;

export const SALARY_COMPONENT_TYPES = ['earning', 'deduction'] as const;

export const SALARY_CALCULATIONS = ['fixed', 'percentage_of_basic', 'percentage_of_gross'] as const;

/** Statuses that mean the person has left. Reaching one requires `hr.exit.manage`. */
export const EMPLOYEE_SEPARATION_STATUSES = ['resigned', 'terminated', 'retired'] as const;

/** Semi-open set: mirrored as a documented varchar in the database, not an enum. */
export const EMPLOYEE_DOCUMENT_TYPES = [
  'nid',
  'birth_certificate',
  'academic_certificate',
  'experience_certificate',
  'contract',
  'photo',
  'medical',
  'police_clearance',
  'work_permit',
  'other',
] as const;

export const EMPLOYEE_DEPENDENT_RELATIONS = [
  'spouse',
  'son',
  'daughter',
  'father',
  'mother',
  'other',
] as const;

export const EMPLOYMENT_TYPES = ['permanent', 'contract', 'part_time', 'guest'] as const;

export const EMPLOYEE_SORT_FIELDS = [
  'fullNameEn',
  'employeeCode',
  'joiningDate',
  'employmentStatus',
  'createdAt',
] as const;

export const EMPLOYMENT_CONTRACT_SORT_FIELDS = ['startDate', 'endDate', 'createdAt'] as const;

export const SALARY_STRUCTURE_SORT_FIELDS = [
  'nameEn',
  'status',
  'effectiveFrom',
  'createdAt',
] as const;

export const DEPARTMENT_SORT_FIELDS = ['code', 'nameEn', 'createdAt'] as const;

export const DESIGNATION_SORT_FIELDS = ['code', 'nameEn', 'rank', 'createdAt'] as const;

// ── Departments ──────────────────────────────────────────────────────────────────────

export const createDepartmentSchema = z.object({
  code: code(32),
  nameEn,
  nameBn,
  headEmployeeId: uuidSchema.nullable().optional(),
  parentDepartmentId: uuidSchema.nullable().optional(),
});
export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;

export const updateDepartmentSchema = z
  .object({
    code: code(32).optional(),
    nameEn: nameEn.optional(),
    nameBn,
    headEmployeeId: uuidSchema.nullable().optional(),
    parentDepartmentId: uuidSchema.nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'No changes were submitted' });
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>;

export const listDepartmentsSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({ includeArchived: z.coerce.boolean().default(false) });

export const archiveDepartmentSchema = z.object({ reason: reasonSchema });

// ── Designations ─────────────────────────────────────────────────────────────────────

export const createDesignationSchema = z.object({
  code: code(32),
  nameEn,
  nameBn,
  /** Seniority ordering (the "grade"); smaller ranks report to larger ones by convention. */
  rank: z.coerce.number().int().min(0).max(1000).default(0),
  isTeaching: z.boolean().default(true),
});
export type CreateDesignationInput = z.infer<typeof createDesignationSchema>;

export const updateDesignationSchema = z
  .object({
    code: code(32).optional(),
    nameEn: nameEn.optional(),
    nameBn,
    rank: z.coerce.number().int().min(0).max(1000).optional(),
    isTeaching: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'No changes were submitted' });
export type UpdateDesignationInput = z.infer<typeof updateDesignationSchema>;

export const listDesignationsSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({ includeArchived: z.coerce.boolean().default(false) });

export const archiveDesignationSchema = z.object({ reason: reasonSchema });

// ── Employees ────────────────────────────────────────────────────────────────────────

export const createEmployeeSchema = z
  .object({
    /** Left blank, the service generates the next sequential code for the institution. */
    employeeCode: code(32).optional(),
    fullNameEn: personName,
    fullNameBn: z.string().trim().max(255).optional(),
    fatherNameEn: optionalText(255),
    motherNameEn: optionalText(255),
    dateOfBirth: calendarDateSchema.optional(),
    gender: z.enum(GENDERS).optional(),
    bloodGroup: z.enum(BLOOD_GROUPS).nullable().optional(),
    religion: z.enum(RELIGIONS).nullable().optional(),
    maritalStatus: z.enum(['single', 'married', 'widowed', 'divorced']).nullable().optional(),
    nationalId: nidSchema.nullable().optional(),

    email: z.string().trim().toLowerCase().email().max(320).optional().or(z.literal('')),
    phone: bdPhoneSchema,
    alternatePhone: optionalBdPhoneSchema,
    presentAddress: optionalText(1000),
    permanentAddress: optionalText(1000),
    emergencyContactName: optionalText(255),
    emergencyContactPhone: optionalBdPhoneSchema,

    campusId: uuidSchema.nullable().optional(),
    departmentId: uuidSchema.nullable().optional(),
    designationId: uuidSchema.nullable().optional(),
    employmentType: z.enum(EMPLOYMENT_TYPES).default('permanent'),
    joiningDate: calendarDateSchema,
    confirmationDate: calendarDateSchema.nullable().optional(),
    qualificationSummary: optionalText(255),
    specialization: optionalText(255),

    bankName: optionalText(128),
    bankAccountNumber: optionalText(34),
    bankBranch: optionalText(128),
    mobileBankingProvider: z.enum(['bkash', 'nagad', 'rocket', 'upay']).nullable().optional(),
    mobileBankingNumber: optionalBdPhoneSchema,
  })
  .superRefine((data, ctx) => {
    if (data.dateOfBirth && data.joiningDate <= data.dateOfBirth) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['joiningDate'],
        message: 'Joining date must be after the date of birth',
      });
    }
    if (data.confirmationDate && data.confirmationDate < data.joiningDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['confirmationDate'],
        message: 'Confirmation cannot precede joining',
      });
    }
  });
export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;

/**
 * The full HR update. Status, separation, transfer and archival are deliberately excluded:
 * each has its own endpoint with its own permission and its own audit record.
 */
export const updateEmployeeSchema = z
  .object({
    fullNameEn: personName.optional(),
    fullNameBn: z.string().trim().max(255).nullable().optional(),
    fatherNameEn: optionalText(255),
    motherNameEn: optionalText(255),
    dateOfBirth: calendarDateSchema.nullable().optional(),
    gender: z.enum(GENDERS).nullable().optional(),
    bloodGroup: z.enum(BLOOD_GROUPS).nullable().optional(),
    religion: z.enum(RELIGIONS).nullable().optional(),
    maritalStatus: z.enum(['single', 'married', 'widowed', 'divorced']).nullable().optional(),
    nationalId: nidSchema.nullable().optional(),
    email: z.string().trim().toLowerCase().email().max(320).nullable().optional(),
    phone: bdPhoneSchema.optional(),
    alternatePhone: optionalBdPhoneSchema,
    presentAddress: optionalText(1000),
    permanentAddress: optionalText(1000),
    emergencyContactName: optionalText(255),
    emergencyContactPhone: optionalBdPhoneSchema,
    departmentId: uuidSchema.nullable().optional(),
    designationId: uuidSchema.nullable().optional(),
    employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
    confirmationDate: calendarDateSchema.nullable().optional(),
    qualificationSummary: optionalText(255),
    specialization: optionalText(255),
    bankName: optionalText(128),
    bankAccountNumber: optionalText(34),
    bankBranch: optionalText(128),
    mobileBankingProvider: z.enum(['bkash', 'nagad', 'rocket', 'upay']).nullable().optional(),
    mobileBankingNumber: optionalBdPhoneSchema,
    /** Optimistic lock. Rejecting a stale write beats silently overwriting a colleague. */
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, { message: 'No changes were submitted' });
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;

/** The self-service subset: contact details only. Everything else is HR's to change. */
export const updateOwnEmployeeProfileSchema = z
  .object({
    phone: bdPhoneSchema.optional(),
    alternatePhone: optionalBdPhoneSchema,
    presentAddress: optionalText(1000),
    permanentAddress: optionalText(1000),
    emergencyContactName: optionalText(255),
    emergencyContactPhone: optionalBdPhoneSchema,
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, { message: 'No changes were submitted' });
export type UpdateOwnEmployeeProfileInput = z.infer<typeof updateOwnEmployeeProfileSchema>;

export const listEmployeesSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    campusId: uuidSchema.optional(),
    departmentId: uuidSchema.optional(),
    designationId: uuidSchema.optional(),
    employmentStatus: z.enum(EMPLOYMENT_STATUSES).optional(),
    employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
    /** Include archived rows. Requires `hr.employees.archive`; refused otherwise. */
    includeArchived: z.coerce.boolean().default(false),
  });

export const archiveEmployeeSchema = z.object({ reason: reasonSchema });

/**
 * Status transitions, separation included. `effectiveDate` is separate from "now" because a
 * resignation is usually recorded days after it took effect, and payroll and attendance must
 * use the real date, not the day HR got around to it.
 */
export const changeEmployeeStatusSchema = z.object({
  status: z.enum(EMPLOYMENT_STATUSES),
  effectiveDate: calendarDateSchema,
  reason: reasonSchema,
});
export type ChangeEmployeeStatusInput = z.infer<typeof changeEmployeeStatusSchema>;

export const transferEmployeeSchema = z.object({
  toCampusId: uuidSchema,
  toDesignationId: uuidSchema.nullable().optional(),
  effectiveDate: calendarDateSchema,
  reason: reasonSchema,
});
export type TransferEmployeeInput = z.infer<typeof transferEmployeeSchema>;

// ── Contracts ────────────────────────────────────────────────────────────────────────

const contractDates = (data: {
  contractType: string;
  startDate: string;
  endDate?: string | null;
  probationEndDate?: string | null;
}): { path: string; message: string }[] => {
  const issues: { path: string; message: string }[] = [];
  if (data.endDate && data.endDate <= data.startDate) {
    issues.push({ path: 'endDate', message: 'The contract must end after it starts' });
  }
  if (!data.endDate && data.contractType !== 'permanent') {
    issues.push({
      path: 'endDate',
      message: 'Only a permanent contract may be open-ended; give an end date',
    });
  }
  if (data.probationEndDate) {
    if (data.probationEndDate < data.startDate) {
      issues.push({
        path: 'probationEndDate',
        message: 'Probation cannot end before the contract starts',
      });
    }
    if (data.endDate && data.probationEndDate > data.endDate) {
      issues.push({
        path: 'probationEndDate',
        message: 'Probation must end within the contract',
      });
    }
  }
  return issues;
};

export const createEmploymentContractSchema = z
  .object({
    employeeId: uuidSchema,
    contractType: z.enum(EMPLOYMENT_CONTRACT_TYPES).default('permanent'),
    startDate: calendarDateSchema,
    endDate: calendarDateSchema.nullable().optional(),
    probationEndDate: calendarDateSchema.nullable().optional(),
    noticePeriodDays: z.coerce.number().int().min(0).max(365).default(30),
    terms: z.string().trim().max(5000).nullable().optional(),
  })
  .superRefine((data, ctx) => {
    for (const issue of contractDates(data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [issue.path], message: issue.message });
    }
  });
export type CreateEmploymentContractInput = z.infer<typeof createEmploymentContractSchema>;

export const updateEmploymentContractSchema = z
  .object({
    startDate: calendarDateSchema.optional(),
    endDate: calendarDateSchema.nullable().optional(),
    probationEndDate: calendarDateSchema.nullable().optional(),
    noticePeriodDays: z.coerce.number().int().min(0).max(365).optional(),
    terms: z.string().trim().max(5000).nullable().optional(),
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, { message: 'No changes were submitted' });
export type UpdateEmploymentContractInput = z.infer<typeof updateEmploymentContractSchema>;

export const listEmploymentContractsSchema = paginationSchema.merge(sortSchema).extend({
  employeeId: uuidSchema.optional(),
  status: z.enum(EMPLOYMENT_CONTRACT_STATUSES).optional(),
  includeArchived: z.coerce.boolean().default(false),
});

export const terminateEmploymentContractSchema = z.object({
  effectiveDate: calendarDateSchema,
  reason: reasonSchema,
});
export type TerminateEmploymentContractInput = z.infer<typeof terminateEmploymentContractSchema>;

// ── Salary structures ────────────────────────────────────────────────────────────────

export const createSalaryStructureSchema = z.object({
  nameEn,
  nameBn,
  description: z.string().trim().max(500).optional(),
  effectiveFrom: calendarDateSchema,
});
export type CreateSalaryStructureInput = z.infer<typeof createSalaryStructureSchema>;

export const updateSalaryStructureSchema = z
  .object({
    nameEn: nameEn.optional(),
    nameBn,
    description: z.string().trim().max(500).nullable().optional(),
    effectiveFrom: calendarDateSchema.optional(),
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, { message: 'No changes were submitted' });
export type UpdateSalaryStructureInput = z.infer<typeof updateSalaryStructureSchema>;

export const listSalaryStructuresSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    status: z.enum(SALARY_STRUCTURE_STATUSES).optional(),
    includeArchived: z.coerce.boolean().default(false),
  });

export const archiveSalaryStructureSchema = z.object({ reason: reasonSchema });

/**
 * A percentage carried as a two-decimal string, capped mirroring the DB check. Its minor
 * units are basis points, which is what `Money.percentage` takes.
 */
const percentageString = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, 'Enter a percentage with at most two decimal places')
  .refine((value) => Number.parseFloat(value) <= 500, 'A percentage above 500% is not accepted');

export const replaceSalaryComponentsSchema = z
  .object({
    components: z
      .array(
        z
          .object({
            /** Present when the row already exists; absent rows are archived, not deleted. */
            id: uuidSchema.optional(),
            nameEn,
            nameBn,
            type: z.enum(SALARY_COMPONENT_TYPES),
            calculation: z.enum(SALARY_CALCULATIONS).default('fixed'),
            /** Taka for `fixed`; a percentage string for the percentage calculations. */
            amount: z.string(),
            isTaxable: z.boolean().default(false),
            sequence: z.coerce.number().int().min(0).max(1000),
          })
          .superRefine((component, ctx) => {
            const isPercentage = component.calculation !== 'fixed';
            const schema = isPercentage ? percentageString : positiveMoneySchema;
            const parsed = schema.safeParse(component.amount);
            if (!parsed.success) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['amount'],
                message: parsed.error.issues[0]?.message ?? 'Invalid amount',
              });
            }
            // Mirrors the database check: gross = basic + earnings, so a gross-relative
            // earning would be self-referential.
            if (component.calculation === 'percentage_of_gross' && component.type !== 'deduction') {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['calculation'],
                message: 'A percentage-of-gross component must be a deduction',
              });
            }
          }),
      )
      .min(1, 'A salary structure needs at least one component')
      .max(50),
  })
  .superRefine((data, ctx) => {
    const names = data.components.map((component) => component.nameEn.toLowerCase());
    if (new Set(names).size !== names.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['components'],
        message: 'Component names must be unique within a structure',
      });
    }
  });
export type ReplaceSalaryComponentsInput = z.infer<typeof replaceSalaryComponentsSchema>;

export const assignSalarySchema = z
  .object({
    employeeId: uuidSchema,
    salaryStructureId: uuidSchema,
    /** Monthly basic in taka; the input to every percentage component. */
    basic: positiveMoneySchema.refine(
      (value) => Number.parseFloat(value) > 0,
      'Basic must be greater than zero',
    ),
    effectiveFrom: calendarDateSchema,
    effectiveTo: calendarDateSchema.nullable().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.effectiveTo && data.effectiveTo < data.effectiveFrom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['effectiveTo'],
        message: 'The assignment cannot end before it begins',
      });
    }
  });
export type AssignSalaryInput = z.infer<typeof assignSalarySchema>;

// ── Documents ────────────────────────────────────────────────────────────────────────

/**
 * The text fields of the multipart upload. The file itself arrives as a multipart part and
 * is validated (size, MIME type) in the service; multipart text fields are always strings.
 */
export const uploadEmployeeDocumentSchema = z.object({
  documentType: z.enum(EMPLOYEE_DOCUMENT_TYPES),
  title: z.string().trim().min(1).max(255),
  expiresAt: z
    .union([z.literal(''), calendarDateSchema])
    .optional()
    .transform((value) => (value ? value : undefined)),
});
export type UploadEmployeeDocumentInput = z.infer<typeof uploadEmployeeDocumentSchema>;

export const listEmployeeDocumentsSchema = paginationSchema.extend({
  documentType: z.enum(EMPLOYEE_DOCUMENT_TYPES).optional(),
  includeArchived: z.coerce.boolean().default(false),
});

/** Documents lapsing within the window — the expiry-alert feed for the HR dashboard. */
export const expiringDocumentsQuerySchema = paginationSchema.extend({
  withinDays: z.coerce.number().int().min(1).max(365).default(60),
});

// ── Qualifications, experience, dependents ───────────────────────────────────────────

export const createEmployeeQualificationSchema = z.object({
  degree: z.string().trim().min(1).max(128),
  institutionName: z.string().trim().min(1).max(255),
  fieldOfStudy: optionalText(128),
  // Plain z.number(), not z.coerce: coercion would turn an explicit null into 0.
  yearCompleted: z.number().int().min(1900).max(2100).nullable().optional(),
  grade: optionalText(32),
});
export type CreateEmployeeQualificationInput = z.infer<typeof createEmployeeQualificationSchema>;

export const updateEmployeeQualificationSchema = z
  .object({
    degree: z.string().trim().min(1).max(128).optional(),
    institutionName: z.string().trim().min(1).max(255).optional(),
    fieldOfStudy: optionalText(128),
    yearCompleted: z.number().int().min(1900).max(2100).nullable().optional(),
    grade: optionalText(32),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'No changes were submitted' });
export type UpdateEmployeeQualificationInput = z.infer<typeof updateEmployeeQualificationSchema>;

export const createEmployeeExperienceSchema = z
  .object({
    organisationName: z.string().trim().min(1).max(255),
    designation: z.string().trim().min(1).max(128),
    fromDate: calendarDateSchema,
    toDate: calendarDateSchema.nullable().optional(),
    responsibilities: optionalText(500),
  })
  .superRefine((data, ctx) => {
    if (data.toDate && data.toDate < data.fromDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toDate'],
        message: 'The engagement cannot end before it begins',
      });
    }
  });
export type CreateEmployeeExperienceInput = z.infer<typeof createEmployeeExperienceSchema>;

export const updateEmployeeExperienceSchema = z
  .object({
    organisationName: z.string().trim().min(1).max(255).optional(),
    designation: z.string().trim().min(1).max(128).optional(),
    fromDate: calendarDateSchema.optional(),
    toDate: calendarDateSchema.nullable().optional(),
    responsibilities: optionalText(500),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'No changes were submitted' });
export type UpdateEmployeeExperienceInput = z.infer<typeof updateEmployeeExperienceSchema>;

export const createEmployeeDependentSchema = z.object({
  nameEn: personName,
  nameBn: z.string().trim().max(255).optional(),
  relation: z.enum(EMPLOYEE_DEPENDENT_RELATIONS),
  dateOfBirth: calendarDateSchema.nullable().optional(),
});
export type CreateEmployeeDependentInput = z.infer<typeof createEmployeeDependentSchema>;

export const updateEmployeeDependentSchema = z
  .object({
    nameEn: personName.optional(),
    nameBn: z.string().trim().max(255).nullable().optional(),
    relation: z.enum(EMPLOYEE_DEPENDENT_RELATIONS).optional(),
    dateOfBirth: calendarDateSchema.nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'No changes were submitted' });
export type UpdateEmployeeDependentInput = z.infer<typeof updateEmployeeDependentSchema>;

/** Shared by qualification/experience/dependent/document archival. */
export const archiveHrRecordSchema = z.object({ reason: reasonSchema });

// ── Reports ──────────────────────────────────────────────────────────────────────────

export const headcountReportQuerySchema = z
  .object({
    from: calendarDateSchema.optional(),
    to: calendarDateSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.from && data.to && data.to < data.from) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: 'The window cannot end before it begins',
      });
    }
  });
export type HeadcountReportQuery = z.infer<typeof headcountReportQuerySchema>;
