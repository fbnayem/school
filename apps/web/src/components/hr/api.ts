/**
 * Typed API surface for the HR screens (Phase 15).
 *
 * Every route on `HrController` is `@InstitutionScoped()` — staff belong to an institution and a
 * group administrator running three schools has no safe default — so every function here takes
 * the institution id explicitly. A missing id is a bug at the call site, not something to paper
 * over with a fallback.
 *
 * **Redaction happens on the server.** `HrService.redactSensitive` nulls `nationalId`, the bank
 * columns and the mobile-banking columns for a caller without `payroll.payslips.view.all`, and
 * returns the same row shape either way. Screens therefore render what they were given and
 * never re-implement the rule; the fields below are typed nullable because that is the truth of
 * the wire, not because the data is optional.
 */

import type { z } from 'zod';
import type {
  archiveEmployeeSchema,
  archiveHrRecordSchema,
  changeEmployeeStatusSchema,
  createDepartmentSchema,
  createDesignationSchema,
  createEmployeeDependentSchema,
  createEmployeeExperienceSchema,
  createEmployeeQualificationSchema,
  createEmployeeSchema,
  createEmploymentContractSchema,
  terminateEmploymentContractSchema,
} from '@shikkha/validation';
import { apiRequest, type Paged } from '@/lib/api';

// ── Row shapes ───────────────────────────────────────────────────────────────────────

export type EmploymentStatus =
  | 'active'
  | 'probation'
  | 'on_leave'
  | 'suspended'
  | 'resigned'
  | 'terminated'
  | 'retired';

export interface Department {
  id: string;
  institutionId: string;
  code: string;
  nameEn: string;
  nameBn: string | null;
  headEmployeeId: string | null;
  /** Added by migration 0013 and selected through an explicit SQL fragment by the service. */
  parentDepartmentId: string | null;
  archivedAt: string | null;
}

export interface Designation {
  id: string;
  institutionId: string;
  code: string;
  nameEn: string;
  nameBn: string | null;
  /** Seniority ordering, used for reports and approval routing. */
  rank: number;
  isTeaching: boolean;
  archivedAt: string | null;
}

export interface Employee {
  id: string;
  institutionId: string;
  campusId: string | null;
  userId: string | null;
  employeeCode: string;
  fullNameEn: string;
  fullNameBn: string | null;
  fatherNameEn: string | null;
  motherNameEn: string | null;
  dateOfBirth: string | null;
  gender: string | null;
  bloodGroup: string | null;
  religion: string | null;
  maritalStatus: string | null;
  /** Null both when unrecorded and when redacted — the server decides which. */
  nationalId: string | null;
  email: string | null;
  phone: string;
  alternatePhone: string | null;
  presentAddress: string | null;
  permanentAddress: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  departmentId: string | null;
  designationId: string | null;
  employmentType: string;
  employmentStatus: EmploymentStatus;
  joiningDate: string;
  confirmationDate: string | null;
  resignationDate: string | null;
  lastWorkingDate: string | null;
  qualificationSummary: string | null;
  specialization: string | null;
  bankName: string | null;
  bankAccountNumber: string | null;
  bankBranch: string | null;
  mobileBankingProvider: string | null;
  mobileBankingNumber: string | null;
  version: number;
  archivedAt: string | null;
}

export interface EmploymentContract {
  id: string;
  employeeId: string;
  contractType: 'permanent' | 'contract' | 'part_time' | 'probation' | 'guest';
  status: 'active' | 'ended' | 'terminated';
  startDate: string;
  /** Null for an open-ended (permanent) contract. */
  endDate: string | null;
  probationEndDate: string | null;
  noticePeriodDays: number;
  terms: string | null;
  version: number;
  archivedAt: string | null;
}

export interface EmployeeDocument {
  id: string;
  employeeId: string;
  fileId: string;
  storageKey: string;
  documentType: string;
  title: string;
  /** Calendar date, for the documents that lapse — work permits, medicals, clearances. */
  expiresAt: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  createdAt: string;
  archivedAt: string | null;
}

/** The expiry feed joins the employee's name and code onto the document row. */
export interface ExpiringDocument extends EmployeeDocument {
  employeeName: string | null;
  employeeCode: string | null;
}

export interface EmployeeQualification {
  id: string;
  employeeId: string;
  degree: string;
  institutionName: string;
  fieldOfStudy: string | null;
  yearCompleted: number | null;
  /** As the certificate states it — free text, never used in arithmetic. */
  grade: string | null;
  archivedAt: string | null;
}

export interface EmployeeExperience {
  id: string;
  employeeId: string;
  organisationName: string;
  designation: string;
  fromDate: string;
  toDate: string | null;
  responsibilities: string | null;
  archivedAt: string | null;
}

export interface EmployeeDependent {
  id: string;
  employeeId: string;
  nameEn: string;
  nameBn: string | null;
  relation: string;
  dateOfBirth: string | null;
  archivedAt: string | null;
}

/** Every amount here is a decimal string computed by `Money` on the server (ADR-004). */
export interface SalaryBreakdownLine {
  componentId: string | null;
  nameEn: string;
  type: 'earning' | 'deduction';
  calculation: 'fixed' | 'percentage_of_basic' | 'percentage_of_gross';
  /** The percentage applied, as a decimal string, when the line is percentage-based. */
  rate: string | null;
  amount: string;
}

export interface EmployeeSalary {
  employeeId: string;
  assignment: {
    id: string;
    employeeId: string;
    salaryStructureId: string;
    basic: string;
    effectiveFrom: string;
    effectiveTo: string | null;
  };
  structure: { id: string; nameEn: string; nameBn: string | null; effectiveFrom: string };
  breakdown: {
    basic: string;
    gross: string;
    totalDeductions: string;
    net: string;
    lines: SalaryBreakdownLine[];
  };
}

export interface HeadcountReport {
  window: { from: string; to: string };
  current: {
    total: number;
    byStatus: Array<{ status: string; total: number }>;
    byEmploymentType: Array<{ employmentType: string; total: number }>;
    byDepartment: Array<{ departmentId: string | null; nameEn: string | null; total: number }>;
    byDesignation: Array<{ designationId: string | null; nameEn: string | null; total: number }>;
    byCampus: Array<{ campusId: string | null; nameEn: string | null; total: number }>;
  };
  movement: {
    headcountAtStart: number;
    headcountAtEnd: number;
    joiners: number;
    separations: number;
    /** A percentage with two decimals, as a decimal string. Displayed, never recomputed. */
    attritionRatePercent: string;
  };
}

export interface ListEmployeesQuery {
  page: number;
  pageSize: number;
  q?: string;
  departmentId?: string;
  designationId?: string;
  employmentStatus?: string;
  employmentType?: string;
  sort?: string;
}

// ── Client ───────────────────────────────────────────────────────────────────────────

export const hrApi = {
  // Departments ──────────────────────────────────────────────────────────────────────
  departments: (
    institutionId: string,
    query: { page: number; pageSize: number; q?: string; sort?: string } = {
      page: 1,
      pageSize: 100,
    },
  ) => apiRequest<Paged<Department>>('/hr/departments', { institutionId, query }),

  createDepartment: (institutionId: string, body: z.input<typeof createDepartmentSchema>) =>
    apiRequest<Department>('/hr/departments', { method: 'POST', body, institutionId }),

  archiveDepartment: (
    institutionId: string,
    id: string,
    body: z.input<typeof archiveHrRecordSchema>,
  ) =>
    apiRequest<Department>(`/hr/departments/${id}/archive`, {
      method: 'POST',
      body,
      institutionId,
    }),

  // Designations ─────────────────────────────────────────────────────────────────────
  designations: (
    institutionId: string,
    query: { page: number; pageSize: number; q?: string; sort?: string } = {
      page: 1,
      pageSize: 100,
    },
  ) => apiRequest<Paged<Designation>>('/hr/designations', { institutionId, query }),

  createDesignation: (institutionId: string, body: z.input<typeof createDesignationSchema>) =>
    apiRequest<Designation>('/hr/designations', { method: 'POST', body, institutionId }),

  archiveDesignation: (
    institutionId: string,
    id: string,
    body: z.input<typeof archiveHrRecordSchema>,
  ) =>
    apiRequest<Designation>(`/hr/designations/${id}/archive`, {
      method: 'POST',
      body,
      institutionId,
    }),

  // Employees ────────────────────────────────────────────────────────────────────────
  employees: (institutionId: string, query: ListEmployeesQuery) =>
    apiRequest<Paged<Employee>>('/hr/employees', {
      institutionId,
      query: {
        page: query.page,
        pageSize: query.pageSize,
        q: query.q,
        departmentId: query.departmentId,
        designationId: query.designationId,
        employmentStatus: query.employmentStatus,
        employmentType: query.employmentType,
        sort: query.sort,
      },
    }),

  employee: (institutionId: string, id: string) =>
    apiRequest<Employee>(`/hr/employees/${id}`, { institutionId }),

  createEmployee: (institutionId: string, body: z.input<typeof createEmployeeSchema>) =>
    apiRequest<Employee>('/hr/employees', { method: 'POST', body, institutionId }),

  changeStatus: (
    institutionId: string,
    id: string,
    body: z.input<typeof changeEmployeeStatusSchema>,
  ) =>
    apiRequest<Employee>(`/hr/employees/${id}/status`, { method: 'POST', body, institutionId }),

  archiveEmployee: (
    institutionId: string,
    id: string,
    body: z.input<typeof archiveEmployeeSchema>,
  ) =>
    apiRequest<Employee>(`/hr/employees/${id}/archive`, { method: 'POST', body, institutionId }),

  /** Requires `payroll.payslips.view.all`, or `…view.own` for the caller's own record. */
  salary: (institutionId: string, id: string) =>
    apiRequest<EmployeeSalary>(`/hr/employees/${id}/salary`, { institutionId }),

  // Documents ────────────────────────────────────────────────────────────────────────
  documents: (
    institutionId: string,
    employeeId: string,
    query: { page: number; pageSize: number; documentType?: string } = { page: 1, pageSize: 50 },
  ) =>
    apiRequest<Paged<EmployeeDocument>>(`/hr/employees/${employeeId}/documents`, {
      institutionId,
      query,
    }),

  expiringDocuments: (
    institutionId: string,
    query: { page: number; pageSize: number; withinDays?: number },
  ) => apiRequest<Paged<ExpiringDocument>>('/hr/documents/expiring', { institutionId, query }),

  verifyDocument: (institutionId: string, id: string) =>
    apiRequest<EmployeeDocument>(`/hr/documents/${id}/verify`, {
      method: 'POST',
      body: {},
      institutionId,
    }),

  // Contracts ────────────────────────────────────────────────────────────────────────
  contracts: (
    institutionId: string,
    query: {
      page: number;
      pageSize: number;
      employeeId?: string;
      status?: string;
      sort?: string;
    },
  ) => apiRequest<Paged<EmploymentContract>>('/hr/contracts', { institutionId, query }),

  createContract: (
    institutionId: string,
    body: z.input<typeof createEmploymentContractSchema>,
  ) => apiRequest<EmploymentContract>('/hr/contracts', { method: 'POST', body, institutionId }),

  terminateContract: (
    institutionId: string,
    id: string,
    body: z.input<typeof terminateEmploymentContractSchema>,
  ) =>
    apiRequest<EmploymentContract>(`/hr/contracts/${id}/terminate`, {
      method: 'POST',
      body,
      institutionId,
    }),

  // Profile side-tables ──────────────────────────────────────────────────────────────
  qualifications: (institutionId: string, employeeId: string) =>
    apiRequest<EmployeeQualification[]>(`/hr/employees/${employeeId}/qualifications`, {
      institutionId,
    }),

  createQualification: (
    institutionId: string,
    employeeId: string,
    body: z.input<typeof createEmployeeQualificationSchema>,
  ) =>
    apiRequest<EmployeeQualification>(`/hr/employees/${employeeId}/qualifications`, {
      method: 'POST',
      body,
      institutionId,
    }),

  archiveQualification: (
    institutionId: string,
    id: string,
    body: z.input<typeof archiveHrRecordSchema>,
  ) =>
    apiRequest<EmployeeQualification>(`/hr/qualifications/${id}/archive`, {
      method: 'POST',
      body,
      institutionId,
    }),

  experience: (institutionId: string, employeeId: string) =>
    apiRequest<EmployeeExperience[]>(`/hr/employees/${employeeId}/experience`, { institutionId }),

  createExperience: (
    institutionId: string,
    employeeId: string,
    body: z.input<typeof createEmployeeExperienceSchema>,
  ) =>
    apiRequest<EmployeeExperience>(`/hr/employees/${employeeId}/experience`, {
      method: 'POST',
      body,
      institutionId,
    }),

  archiveExperience: (
    institutionId: string,
    id: string,
    body: z.input<typeof archiveHrRecordSchema>,
  ) =>
    apiRequest<EmployeeExperience>(`/hr/experience/${id}/archive`, {
      method: 'POST',
      body,
      institutionId,
    }),

  dependents: (institutionId: string, employeeId: string) =>
    apiRequest<EmployeeDependent[]>(`/hr/employees/${employeeId}/dependents`, { institutionId }),

  createDependent: (
    institutionId: string,
    employeeId: string,
    body: z.input<typeof createEmployeeDependentSchema>,
  ) =>
    apiRequest<EmployeeDependent>(`/hr/employees/${employeeId}/dependents`, {
      method: 'POST',
      body,
      institutionId,
    }),

  archiveDependent: (
    institutionId: string,
    id: string,
    body: z.input<typeof archiveHrRecordSchema>,
  ) =>
    apiRequest<EmployeeDependent>(`/hr/dependents/${id}/archive`, {
      method: 'POST',
      body,
      institutionId,
    }),

  // Reports ──────────────────────────────────────────────────────────────────────────
  headcount: (institutionId: string, query: { from?: string; to?: string } = {}) =>
    apiRequest<HeadcountReport>('/hr/reports/headcount', { institutionId, query }),
};

/**
 * Statuses that mean the person has left. Reaching one needs `hr.exit.manage`, and archiving
 * is refused until the record is in one of them — the separation is the audited lifecycle
 * event, archiving is only the tidy-up afterwards.
 */
export const SEPARATION_STATUSES: readonly EmploymentStatus[] = [
  'resigned',
  'terminated',
  'retired',
];
