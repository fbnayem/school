/**
 * Human resources (Phase 15): the employee lifecycle around the `employees` table.
 *
 * The `employees` row itself, `departments`, `designations` and the two academic assignment
 * tables were created in Phase 2 (`people.ts`) because the `*.view.assigned` data scopes need
 * them. This file adds everything else a school's HR office keeps about a person:
 *
 *  - **Contracts** (`employment_contracts`) — the legal terms of employment. A contract is a
 *    record, not a mutable state bag: it ends or is terminated, it is never deleted, and two
 *    live contracts for one person may not overlap in time (enforced in the service inside
 *    the same transaction as the write; see the Phase 15 migration for the SQL restatements
 *    of the date invariants).
 *  - **Salary structures and components** (`salary_structures`, `salary_components`,
 *    `employee_salary_assignments`) — designed so Phase 16 (payroll) can compute a payslip
 *    with no further migration: a payslip is (assignment.basic, structure's components in
 *    `sequence` order). Every monetary column is `numeric(14, 2)`; percentage components
 *    store the percentage in the same shape (`"12.50"` = 1250 basis points), so every
 *    proportional calculation stays in integer arithmetic via `Money.percentage`.
 *    `percentage_of_gross` components must be deductions — a gross-relative *earning* would
 *    make gross self-referential — and that is a database check, not a convention.
 *  - **Documents, qualifications, experience, dependents** — profile side-tables, one row per
 *    fact, soft-archived like everything else.
 *  - **Status history and transfers** (`employee_status_history`, `employee_transfers`) —
 *    the domain record of separations and campus moves. Separation is a status change with an
 *    effective date and a mandatory reason; the `employees` row survives it.
 *
 * Enum note: the `pgEnum` declarations live here rather than in `_shared.ts` (same reasoning
 * as `fees.ts`): each value set is genuinely closed — adding a calculation kind changes the
 * payroll arithmetic as well as the schema. Document *types* a school invents are not an
 * enum; `employee_documents.document_type` is a documented varchar.
 */

import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  actorColumns,
  archiveColumns,
  employmentStatusEnum,
  primaryKeyColumn,
  timestampColumns,
  versionColumn,
} from './_shared';
import { campuses, institutions, organizations } from './tenancy';
import { designations, employees } from './people';
import { files } from './files';

// ─────────────────────────────────────────────────────────────────────────────────────
// Enumerations
// ─────────────────────────────────────────────────────────────────────────────────────

export const employmentContractTypeEnum = pgEnum('employment_contract_type', [
  'permanent',
  'contract',
  'part_time',
  'probation',
  'guest',
]);

export const employmentContractStatusEnum = pgEnum('employment_contract_status', [
  'active',
  'ended',
  'terminated',
]);

export const salaryStructureStatusEnum = pgEnum('salary_structure_status', [
  'draft',
  'active',
  'archived',
]);

export const salaryComponentTypeEnum = pgEnum('salary_component_type', ['earning', 'deduction']);

/**
 * How a component's amount is computed:
 *  - `fixed`               — `amount` is taka.
 *  - `percentage_of_basic` — `amount` is a percentage of the assignment's basic ("50.00" = 50%).
 *  - `percentage_of_gross` — a percentage of (basic + all earnings). Deductions only, and the
 *    service evaluates these after every earning regardless of sequence, so the answer cannot
 *    depend on insertion order.
 */
export const salaryCalculationEnum = pgEnum('salary_calculation', [
  'fixed',
  'percentage_of_basic',
  'percentage_of_gross',
]);

// ─────────────────────────────────────────────────────────────────────────────────────
// Contracts
// ─────────────────────────────────────────────────────────────────────────────────────

export const employmentContracts = pgTable(
  'employment_contracts',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),
    contractType: employmentContractTypeEnum('contract_type').notNull().default('permanent'),
    status: employmentContractStatusEnum('status').notNull().default('active'),
    startDate: date('start_date').notNull(),
    /** Null for an open-ended (permanent) contract. */
    endDate: date('end_date'),
    /** Must fall inside the contract when present; checked in SQL as well as Zod. */
    probationEndDate: date('probation_end_date'),
    noticePeriodDays: integer('notice_period_days').notNull().default(30),
    /** Free-text terms that do not fit a column — allowances in kind, special conditions. */
    terms: text('terms'),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('employment_contracts_employee_idx').on(table.employeeId, table.status),
    index('employment_contracts_institution_idx').on(table.institutionId, table.status),
    index('employment_contracts_tenant_idx').on(table.tenantId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Salary structures — the price list Phase 16 payroll computes payslips from
// ─────────────────────────────────────────────────────────────────────────────────────

export const salaryStructures = pgTable(
  'salary_structures',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    nameEn: varchar('name_en', { length: 128 }).notNull(),
    nameBn: varchar('name_bn', { length: 128 }),
    description: varchar('description', { length: 500 }),
    status: salaryStructureStatusEnum('status').notNull().default('draft'),
    effectiveFrom: date('effective_from').notNull(),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('salary_structures_institution_name_key')
      .on(table.institutionId, table.nameEn)
      .where(sql`${table.archivedAt} IS NULL`),
    index('salary_structures_institution_status_idx').on(table.institutionId, table.status),
    index('salary_structures_tenant_idx').on(table.tenantId),
  ],
);

export const salaryComponents = pgTable(
  'salary_components',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    salaryStructureId: uuid('salary_structure_id')
      .notNull()
      .references(() => salaryStructures.id, { onDelete: 'cascade' }),
    nameEn: varchar('name_en', { length: 128 }).notNull(),
    nameBn: varchar('name_bn', { length: 128 }),
    type: salaryComponentTypeEnum('type').notNull(),
    calculation: salaryCalculationEnum('calculation').notNull().default('fixed'),
    /**
     * `numeric(14, 2)`, read and written only through `Money`. For `fixed` this is taka; for
     * the percentage calculations it is the percentage with two decimals, whose minor units
     * *are* basis points ("12.50" → 1250bp), fed straight to `Money.percentage`.
     */
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    isTaxable: boolean('is_taxable').notNull().default(false),
    /** Evaluation and payslip display order. */
    sequence: smallint('sequence').notNull().default(0),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('salary_components_structure_name_key')
      .on(table.salaryStructureId, table.nameEn)
      .where(sql`${table.archivedAt} IS NULL`),
    index('salary_components_structure_idx').on(table.salaryStructureId, table.sequence),
    index('salary_components_tenant_idx').on(table.tenantId),
  ],
);

/**
 * Which structure an employee is paid on, and their basic.
 *
 * A payslip for a month is computable from this row alone plus the structure's components:
 * `basic` is the input to every percentage, the effective range says which month it applies
 * to, and at most one assignment per employee is open-ended (partial unique index). History
 * is preserved — assigning a new structure closes the previous row rather than editing it.
 */
export const employeeSalaryAssignments = pgTable(
  'employee_salary_assignments',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),
    salaryStructureId: uuid('salary_structure_id')
      .notNull()
      .references(() => salaryStructures.id, { onDelete: 'restrict' }),
    /** Monthly basic in taka. `numeric(14, 2)`; `Money` is the only parser. */
    basic: numeric('basic', { precision: 14, scale: 2 }).notNull(),
    effectiveFrom: date('effective_from').notNull(),
    /** Null while this is the employee's current assignment. */
    effectiveTo: date('effective_to'),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('employee_salary_assignments_open_key')
      .on(table.employeeId)
      .where(sql`${table.effectiveTo} IS NULL AND ${table.archivedAt} IS NULL`),
    index('employee_salary_assignments_employee_idx').on(table.employeeId, table.effectiveFrom),
    index('employee_salary_assignments_structure_idx').on(table.salaryStructureId),
    index('employee_salary_assignments_tenant_idx').on(table.tenantId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Profile side-tables
// ─────────────────────────────────────────────────────────────────────────────────────

export const employeeDocuments = pgTable(
  'employee_documents',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),
    /** The stored object's metadata row; the bytes live behind `StorageService`. */
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'restrict' }),
    /** Denormalised from `files` so an expiry sweep needs no join to authorise. */
    storageKey: varchar('storage_key', { length: 512 }).notNull(),
    /**
     * 'nid' | 'birth_certificate' | 'academic_certificate' | 'experience_certificate' |
     * 'contract' | 'photo' | 'medical' | 'police_clearance' | 'work_permit' | 'other'
     * — a documented set, not an enum: schools add their own kinds.
     */
    documentType: varchar('document_type', { length: 48 }).notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    /** For documents that lapse — work permits, police clearances, medical certificates. */
    expiresAt: date('expires_at'),
    verifiedBy: uuid('verified_by'),
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('employee_documents_employee_idx').on(table.employeeId, table.documentType),
    index('employee_documents_expiry_idx')
      .on(table.expiresAt)
      .where(sql`${table.expiresAt} IS NOT NULL AND ${table.archivedAt} IS NULL`),
    index('employee_documents_tenant_idx').on(table.tenantId),
  ],
);

export const employeeQualifications = pgTable(
  'employee_qualifications',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),
    /** 'SSC' | 'HSC' | 'BA' | 'BSc' | 'MSc' | 'B.Ed' | 'M.Ed' | 'Kamil' | free text. */
    degree: varchar('degree', { length: 128 }).notNull(),
    institutionName: varchar('institution_name', { length: 255 }).notNull(),
    fieldOfStudy: varchar('field_of_study', { length: 128 }),
    yearCompleted: smallint('year_completed'),
    /** GPA/class/division as the certificate states it — free text, never arithmetic. */
    grade: varchar('grade', { length: 32 }),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('employee_qualifications_employee_idx').on(table.employeeId),
    index('employee_qualifications_tenant_idx').on(table.tenantId),
  ],
);

export const employeeExperience = pgTable(
  'employee_experience',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),
    organisationName: varchar('organisation_name', { length: 255 }).notNull(),
    designation: varchar('designation', { length: 128 }).notNull(),
    fromDate: date('from_date').notNull(),
    /** Null while it was their job when they joined here. */
    toDate: date('to_date'),
    responsibilities: varchar('responsibilities', { length: 500 }),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('employee_experience_employee_idx').on(table.employeeId),
    index('employee_experience_tenant_idx').on(table.tenantId),
  ],
);

export const employeeDependents = pgTable(
  'employee_dependents',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),
    nameEn: varchar('name_en', { length: 255 }).notNull(),
    nameBn: varchar('name_bn', { length: 255 }),
    /** 'spouse' | 'son' | 'daughter' | 'father' | 'mother' | 'other' */
    relation: varchar('relation', { length: 24 }).notNull(),
    dateOfBirth: date('date_of_birth'),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('employee_dependents_employee_idx').on(table.employeeId),
    index('employee_dependents_tenant_idx').on(table.tenantId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Lifecycle records
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Domain history of employment status changes, distinct from the audit log: this is what a
 * service certificate is printed from, and the school reads it, not a security reviewer.
 * Append-only in practice; no endpoint archives or edits a row.
 */
export const employeeStatusHistory = pgTable(
  'employee_status_history',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),
    fromStatus: employmentStatusEnum('from_status'),
    toStatus: employmentStatusEnum('to_status').notNull(),
    effectiveDate: date('effective_date').notNull(),
    reason: varchar('reason', { length: 1000 }),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('employee_status_history_employee_idx').on(table.employeeId, table.effectiveDate),
    index('employee_status_history_tenant_idx').on(table.tenantId),
  ],
);

/**
 * Campus (and optionally designation) transfers within one institution. Both campuses must
 * belong to the employee's institution — the service validates it and the record keeps both
 * sides so the movement is reconstructible.
 */
export const employeeTransfers = pgTable(
  'employee_transfers',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),
    /** Null when the employee had no campus recorded before the transfer. */
    fromCampusId: uuid('from_campus_id').references(() => campuses.id, { onDelete: 'restrict' }),
    toCampusId: uuid('to_campus_id')
      .notNull()
      .references(() => campuses.id, { onDelete: 'restrict' }),
    fromDesignationId: uuid('from_designation_id').references(() => designations.id, {
      onDelete: 'set null',
    }),
    toDesignationId: uuid('to_designation_id').references(() => designations.id, {
      onDelete: 'set null',
    }),
    effectiveDate: date('effective_date').notNull(),
    reason: varchar('reason', { length: 1000 }).notNull(),
    /** The user who executed (and thereby approved) the transfer. */
    approvedBy: uuid('approved_by'),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('employee_transfers_employee_idx').on(table.employeeId, table.effectiveDate),
    index('employee_transfers_tenant_idx').on(table.tenantId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────

export const employmentContractsRelations = relations(employmentContracts, ({ one }) => ({
  employee: one(employees, {
    fields: [employmentContracts.employeeId],
    references: [employees.id],
  }),
  institution: one(institutions, {
    fields: [employmentContracts.institutionId],
    references: [institutions.id],
  }),
}));

export const salaryStructuresRelations = relations(salaryStructures, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [salaryStructures.institutionId],
    references: [institutions.id],
  }),
  components: many(salaryComponents),
  assignments: many(employeeSalaryAssignments),
}));

export const salaryComponentsRelations = relations(salaryComponents, ({ one }) => ({
  structure: one(salaryStructures, {
    fields: [salaryComponents.salaryStructureId],
    references: [salaryStructures.id],
  }),
}));

export const employeeSalaryAssignmentsRelations = relations(
  employeeSalaryAssignments,
  ({ one }) => ({
    employee: one(employees, {
      fields: [employeeSalaryAssignments.employeeId],
      references: [employees.id],
    }),
    structure: one(salaryStructures, {
      fields: [employeeSalaryAssignments.salaryStructureId],
      references: [salaryStructures.id],
    }),
  }),
);

export const employeeDocumentsRelations = relations(employeeDocuments, ({ one }) => ({
  employee: one(employees, {
    fields: [employeeDocuments.employeeId],
    references: [employees.id],
  }),
  file: one(files, { fields: [employeeDocuments.fileId], references: [files.id] }),
}));

export const employeeQualificationsRelations = relations(employeeQualifications, ({ one }) => ({
  employee: one(employees, {
    fields: [employeeQualifications.employeeId],
    references: [employees.id],
  }),
}));

export const employeeExperienceRelations = relations(employeeExperience, ({ one }) => ({
  employee: one(employees, {
    fields: [employeeExperience.employeeId],
    references: [employees.id],
  }),
}));

export const employeeDependentsRelations = relations(employeeDependents, ({ one }) => ({
  employee: one(employees, {
    fields: [employeeDependents.employeeId],
    references: [employees.id],
  }),
}));

export const employeeStatusHistoryRelations = relations(employeeStatusHistory, ({ one }) => ({
  employee: one(employees, {
    fields: [employeeStatusHistory.employeeId],
    references: [employees.id],
  }),
}));

export const employeeTransfersRelations = relations(employeeTransfers, ({ one }) => ({
  employee: one(employees, {
    fields: [employeeTransfers.employeeId],
    references: [employees.id],
  }),
  fromCampus: one(campuses, {
    fields: [employeeTransfers.fromCampusId],
    references: [campuses.id],
  }),
  toCampus: one(campuses, {
    fields: [employeeTransfers.toCampusId],
    references: [campuses.id],
  }),
}));
