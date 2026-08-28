/**
 * Employees and their academic assignments.
 *
 * An employee is a person the institution employs. A user is a login. They are separate rows
 * with an optional link, because:
 *  - A support employee may have no system access at all.
 *  - A guardian who is also a teacher at the same school is one user with two role grants,
 *    one employee record, and one guardian record — not three copies of a person.
 *
 * `employee_section_assignments` and `employee_subject_assignments` are what make
 * `students.view.assigned` mean something concrete: they are the joins the repository uses to
 * narrow a teacher's view to their own students.
 */

import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  actorColumns,
  archiveColumns,
  bloodGroupEnum,
  employmentStatusEnum,
  genderEnum,
  primaryKeyColumn,
  religionEnum,
  timestampColumns,
  versionColumn,
} from './_shared';
import { campuses, institutions, organizations } from './tenancy';
import { academicYears, classSubjects, sections, subjects } from './academic';
import { users } from './identity';

export const departments = pgTable(
  'departments',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    code: varchar('code', { length: 32 }).notNull(),
    nameEn: varchar('name_en', { length: 128 }).notNull(),
    nameBn: varchar('name_bn', { length: 128 }),
    headEmployeeId: uuid('head_employee_id'),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('departments_institution_code_key')
      .on(table.institutionId, table.code)
      .where(sql`${table.archivedAt} IS NULL`),
    index('departments_tenant_idx').on(table.tenantId),
  ],
);

export const designations = pgTable(
  'designations',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    code: varchar('code', { length: 32 }).notNull(),
    nameEn: varchar('name_en', { length: 128 }).notNull(),
    nameBn: varchar('name_bn', { length: 128 }),
    /** Seniority ordering for reports and approval routing. */
    rank: smallint('rank').notNull().default(0),
    isTeaching: boolean('is_teaching').notNull().default(true),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('designations_institution_code_key')
      .on(table.institutionId, table.code)
      .where(sql`${table.archivedAt} IS NULL`),
    index('designations_tenant_idx').on(table.tenantId),
  ],
);

export const employees = pgTable(
  'employees',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    campusId: uuid('campus_id').references(() => campuses.id, { onDelete: 'restrict' }),
    /** Null when the employee has no system login. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    employeeCode: varchar('employee_code', { length: 32 }).notNull(),

    fullNameEn: varchar('full_name_en', { length: 255 }).notNull(),
    fullNameBn: varchar('full_name_bn', { length: 255 }),
    fatherNameEn: varchar('father_name_en', { length: 255 }),
    motherNameEn: varchar('mother_name_en', { length: 255 }),
    dateOfBirth: date('date_of_birth'),
    gender: genderEnum('gender'),
    bloodGroup: bloodGroupEnum('blood_group'),
    religion: religionEnum('religion'),
    maritalStatus: varchar('marital_status', { length: 16 }),
    nationalId: varchar('national_id', { length: 20 }),

    email: varchar('email', { length: 320 }),
    phone: varchar('phone', { length: 20 }).notNull(),
    alternatePhone: varchar('alternate_phone', { length: 20 }),
    presentAddress: text('present_address'),
    permanentAddress: text('permanent_address'),
    emergencyContactName: varchar('emergency_contact_name', { length: 255 }),
    emergencyContactPhone: varchar('emergency_contact_phone', { length: 20 }),

    departmentId: uuid('department_id').references(() => departments.id, {
      onDelete: 'set null',
    }),
    designationId: uuid('designation_id').references(() => designations.id, {
      onDelete: 'set null',
    }),
    /** 'permanent' | 'contract' | 'part_time' | 'guest' */
    employmentType: varchar('employment_type', { length: 24 }).notNull().default('permanent'),
    employmentStatus: employmentStatusEnum('employment_status').notNull().default('active'),
    joiningDate: date('joining_date').notNull(),
    confirmationDate: date('confirmation_date'),
    resignationDate: date('resignation_date'),
    lastWorkingDate: date('last_working_date'),

    photoFileId: uuid('photo_file_id'),
    /** Highest qualification summary; the full history lives in a Phase 15 table. */
    qualificationSummary: varchar('qualification_summary', { length: 255 }),
    specialization: varchar('specialization', { length: 255 }),

    /** Bank details for payroll. Account numbers are treated as sensitive on read. */
    bankName: varchar('bank_name', { length: 128 }),
    bankAccountNumber: varchar('bank_account_number', { length: 34 }),
    bankBranch: varchar('bank_branch', { length: 128 }),
    mobileBankingProvider: varchar('mobile_banking_provider', { length: 24 }),
    mobileBankingNumber: varchar('mobile_banking_number', { length: 20 }),

    metadata: jsonb('metadata')
      .notNull()
      .default(sql`'{}'::jsonb`),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('employees_institution_code_key')
      .on(table.institutionId, table.employeeCode)
      .where(sql`${table.archivedAt} IS NULL`),
    uniqueIndex('employees_user_key')
      .on(table.userId)
      .where(sql`${table.userId} IS NOT NULL AND ${table.archivedAt} IS NULL`),
    uniqueIndex('employees_nid_key')
      .on(table.institutionId, table.nationalId)
      .where(sql`${table.nationalId} IS NOT NULL AND ${table.archivedAt} IS NULL`),
    index('employees_tenant_idx').on(table.tenantId),
    index('employees_institution_status_idx').on(table.institutionId, table.employmentStatus),
    index('employees_department_idx').on(table.departmentId),
    index('employees_phone_idx').on(table.tenantId, table.phone),
  ],
);

/**
 * Class-teacher assignment. One primary class teacher per section per year, enforced by a
 * partial unique index — "who is responsible for this section" must have exactly one answer.
 */
export const employeeSectionAssignments = pgTable(
  'employee_section_assignments',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    academicYearId: uuid('academic_year_id')
      .notNull()
      .references(() => academicYears.id, { onDelete: 'cascade' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    sectionId: uuid('section_id')
      .notNull()
      .references(() => sections.id, { onDelete: 'cascade' }),
    /** 'class_teacher' | 'assistant_class_teacher' */
    role: varchar('role', { length: 32 }).notNull().default('class_teacher'),
    effectiveFrom: date('effective_from'),
    effectiveTo: date('effective_to'),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('employee_section_primary_key')
      .on(table.sectionId, table.academicYearId)
      .where(sql`${table.role} = 'class_teacher' AND ${table.archivedAt} IS NULL`),
    uniqueIndex('employee_section_unique_key')
      .on(table.employeeId, table.sectionId, table.role)
      .where(sql`${table.archivedAt} IS NULL`),
    index('employee_section_employee_idx').on(table.employeeId, table.academicYearId),
    index('employee_section_section_idx').on(table.sectionId),
    index('employee_section_tenant_idx').on(table.tenantId),
  ],
);

/**
 * Subject-teacher assignment: this employee teaches this subject to this section.
 *
 * This is the row that authorises a teacher to enter marks for a section, and it is the join
 * behind `results.view.assigned`. Without a matching row, mark entry is refused regardless of
 * the teacher's permissions.
 */
export const employeeSubjectAssignments = pgTable(
  'employee_subject_assignments',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    academicYearId: uuid('academic_year_id')
      .notNull()
      .references(() => academicYears.id, { onDelete: 'cascade' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    sectionId: uuid('section_id')
      .notNull()
      .references(() => sections.id, { onDelete: 'cascade' }),
    subjectId: uuid('subject_id')
      .notNull()
      .references(() => subjects.id, { onDelete: 'restrict' }),
    classSubjectId: uuid('class_subject_id').references(() => classSubjects.id, {
      onDelete: 'set null',
    }),
    /** The teacher who signs off marks when several share a subject. */
    isPrimary: boolean('is_primary').notNull().default(true),
    effectiveFrom: date('effective_from'),
    effectiveTo: date('effective_to'),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('employee_subject_unique_key')
      .on(table.employeeId, table.sectionId, table.subjectId)
      .where(sql`${table.archivedAt} IS NULL`),
    uniqueIndex('employee_subject_primary_key')
      .on(table.sectionId, table.subjectId)
      .where(sql`${table.isPrimary} AND ${table.archivedAt} IS NULL`),
    index('employee_subject_employee_idx').on(table.employeeId, table.academicYearId),
    index('employee_subject_section_idx').on(table.sectionId, table.subjectId),
    index('employee_subject_tenant_idx').on(table.tenantId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────

export const employeesRelations = relations(employees, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [employees.tenantId],
    references: [organizations.id],
  }),
  institution: one(institutions, {
    fields: [employees.institutionId],
    references: [institutions.id],
  }),
  user: one(users, { fields: [employees.userId], references: [users.id] }),
  department: one(departments, {
    fields: [employees.departmentId],
    references: [departments.id],
  }),
  designation: one(designations, {
    fields: [employees.designationId],
    references: [designations.id],
  }),
  sectionAssignments: many(employeeSectionAssignments),
  subjectAssignments: many(employeeSubjectAssignments),
}));

export const employeeSectionAssignmentsRelations = relations(
  employeeSectionAssignments,
  ({ one }) => ({
    employee: one(employees, {
      fields: [employeeSectionAssignments.employeeId],
      references: [employees.id],
    }),
    section: one(sections, {
      fields: [employeeSectionAssignments.sectionId],
      references: [sections.id],
    }),
  }),
);

export const employeeSubjectAssignmentsRelations = relations(
  employeeSubjectAssignments,
  ({ one }) => ({
    employee: one(employees, {
      fields: [employeeSubjectAssignments.employeeId],
      references: [employees.id],
    }),
    section: one(sections, {
      fields: [employeeSubjectAssignments.sectionId],
      references: [sections.id],
    }),
    subject: one(subjects, {
      fields: [employeeSubjectAssignments.subjectId],
      references: [subjects.id],
    }),
  }),
);
