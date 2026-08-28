/**
 * Students, enrolments, guardians and their links (Phases 3 and 4).
 *
 * The central design decision: **`students` holds the person, `enrollments` holds the
 * year-by-year academic placement.** A student is one row for their whole time at the school;
 * their class, section, roll number and status in each academic year are separate rows.
 *
 * This is what makes promotion, transfer, repetition and readmission expressible without
 * destroying history, and it is why a report card for 2026 still resolves correctly after the
 * student moves to Class 8 in 2027. Storing the current section on `students` would have made
 * every historical query wrong.
 */

import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  actorColumns,
  archiveColumns,
  bloodGroupEnum,
  enrollmentStatusEnum,
  genderEnum,
  guardianRelationEnum,
  primaryKeyColumn,
  religionEnum,
  studentStatusEnum,
  timestampColumns,
  versionColumn,
} from './_shared';
import { campuses, institutions, organizations } from './tenancy';
import { academicGroups, academicYears, classLevels, sections, shifts } from './academic';
import { users } from './identity';
import { employees } from './people';

export const students = pgTable(
  'students',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    /** Null while the student has no login of their own — common in primary classes. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),

    /** Institution-facing identifier, stable for the student's whole career. */
    studentCode: varchar('student_code', { length: 32 }).notNull(),
    /** The number issued at admission. Distinct from studentCode by design. */
    admissionNumber: varchar('admission_number', { length: 32 }).notNull(),
    admissionDate: date('admission_date').notNull(),

    /**
     * Both names are official. The Bangla name appears on board registration and the
     * transfer certificate; the English name appears on English-medium documents. Neither is
     * a translation of the other, so neither can be derived.
     */
    fullNameEn: varchar('full_name_en', { length: 255 }).notNull(),
    fullNameBn: varchar('full_name_bn', { length: 255 }),
    nickname: varchar('nickname', { length: 64 }),

    dateOfBirth: date('date_of_birth').notNull(),
    gender: genderEnum('gender').notNull(),
    bloodGroup: bloodGroupEnum('blood_group'),
    religion: religionEnum('religion'),
    nationality: varchar('nationality', { length: 64 }).notNull().default('Bangladeshi'),

    /**
     * The primary identity document for a Bangladeshi school-age child. Most students have no
     * NID. Unique per institution among live records, because duplicate admission of the same
     * child is a real and costly data problem.
     */
    birthRegistrationNumber: varchar('birth_registration_number', { length: 20 }),
    nationalId: varchar('national_id', { length: 20 }),

    fatherNameEn: varchar('father_name_en', { length: 255 }),
    fatherNameBn: varchar('father_name_bn', { length: 255 }),
    motherNameEn: varchar('mother_name_en', { length: 255 }),
    motherNameBn: varchar('mother_name_bn', { length: 255 }),

    phone: varchar('phone', { length: 20 }),
    email: varchar('email', { length: 320 }),
    presentAddress: text('present_address'),
    permanentAddress: text('permanent_address'),
    district: varchar('district', { length: 64 }),
    division: varchar('division', { length: 32 }),

    photoFileId: uuid('photo_file_id'),

    previousInstitutionName: varchar('previous_institution_name', { length: 255 }),
    previousClassCompleted: varchar('previous_class_completed', { length: 64 }),
    transferCertificateNumber: varchar('transfer_certificate_number', { length: 64 }),

    /**
     * Medical information. Reading these requires `students.medical.view` in addition to the
     * usual student read permission, and every read is audited — this is the most sensitive
     * data the platform holds about a child.
     */
    medicalConditions: text('medical_conditions'),
    allergies: text('allergies'),
    specialNeeds: text('special_needs'),
    emergencyMedicalNote: text('emergency_medical_note'),

    /**
     * Lifecycle status of the *person*, not of a particular year's enrolment.
     * Transitions are validated in the service layer against an explicit state machine.
     */
    status: studentStatusEnum('status').notNull().default('active'),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true, mode: 'date' }),
    statusReason: varchar('status_reason', { length: 500 }),

    metadata: jsonb('metadata')
      .notNull()
      .default(sql`'{}'::jsonb`),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('students_institution_code_key')
      .on(table.institutionId, table.studentCode)
      .where(sql`${table.archivedAt} IS NULL`),
    uniqueIndex('students_institution_admission_key')
      .on(table.institutionId, table.admissionNumber)
      .where(sql`${table.archivedAt} IS NULL`),
    uniqueIndex('students_brn_key')
      .on(table.institutionId, table.birthRegistrationNumber)
      .where(sql`${table.birthRegistrationNumber} IS NOT NULL AND ${table.archivedAt} IS NULL`),
    uniqueIndex('students_user_key')
      .on(table.userId)
      .where(sql`${table.userId} IS NOT NULL AND ${table.archivedAt} IS NULL`),
    index('students_tenant_idx').on(table.tenantId),
    index('students_institution_status_idx').on(table.institutionId, table.status),
    // Duplicate detection on import: same name + same date of birth is the strong signal.
    index('students_dedupe_idx').on(table.institutionId, table.fullNameEn, table.dateOfBirth),
    index('students_phone_idx').on(table.tenantId, table.phone),
  ],
);

/**
 * A student's placement in one academic year.
 *
 * Roll number is unique within a section for a year, among non-cancelled enrolments — which
 * is why the partial index excludes `cancelled` rather than only excluding archived rows.
 */
export const enrollments = pgTable(
  'enrollments',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    campusId: uuid('campus_id')
      .notNull()
      .references(() => campuses.id, { onDelete: 'restrict' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'restrict' }),
    academicYearId: uuid('academic_year_id')
      .notNull()
      .references(() => academicYears.id, { onDelete: 'restrict' }),
    classLevelId: uuid('class_level_id')
      .notNull()
      .references(() => classLevels.id, { onDelete: 'restrict' }),
    sectionId: uuid('section_id')
      .notNull()
      .references(() => sections.id, { onDelete: 'restrict' }),
    shiftId: uuid('shift_id').references(() => shifts.id, { onDelete: 'restrict' }),
    groupId: uuid('group_id').references(() => academicGroups.id, { onDelete: 'restrict' }),

    rollNumber: varchar('roll_number', { length: 16 }).notNull(),
    /** Board registration number, issued in Class 9 for the SSC examination. */
    boardRegistrationNumber: varchar('board_registration_number', { length: 32 }),

    status: enrollmentStatusEnum('status').notNull().default('active'),
    enrolledOn: date('enrolled_on').notNull(),
    endedOn: date('ended_on'),
    endReason: varchar('end_reason', { length: 255 }),

    /** Where the student came from, when this enrolment resulted from a promotion. */
    promotedFromEnrollmentId: uuid('promoted_from_enrollment_id'),

    isRepeating: boolean('is_repeating').notNull().default(false),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    // One live enrolment per student per year. Repeating a year creates a new year's row.
    uniqueIndex('enrollments_student_year_key')
      .on(table.studentId, table.academicYearId)
      .where(sql`${table.status} <> 'cancelled' AND ${table.archivedAt} IS NULL`),
    uniqueIndex('enrollments_section_roll_key')
      .on(table.sectionId, table.rollNumber)
      .where(sql`${table.status} <> 'cancelled' AND ${table.archivedAt} IS NULL`),
    index('enrollments_tenant_idx').on(table.tenantId),
    index('enrollments_section_idx').on(table.sectionId, table.status),
    index('enrollments_student_idx').on(table.studentId),
    index('enrollments_year_class_idx').on(table.academicYearId, table.classLevelId),
  ],
);

/**
 * A guardian — a person, stored once.
 *
 * Deliberately **not** a copy of parent details on the student row. One guardian with four
 * children at the school is one row here and four links, so updating their phone number
 * updates it for all four, and SMS goes out once rather than four times.
 */
export const guardians = pgTable(
  'guardians',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    /** Null until the guardian is invited to the parent portal. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),

    fullNameEn: varchar('full_name_en', { length: 255 }).notNull(),
    fullNameBn: varchar('full_name_bn', { length: 255 }),
    /**
     * E.164, normalised on write. This is the deduplication key: a school entering the same
     * father twice for two siblings is the single most common data-quality problem in this
     * domain, and a normalised phone number catches it.
     */
    phone: varchar('phone', { length: 20 }).notNull(),
    alternatePhone: varchar('alternate_phone', { length: 20 }),
    email: varchar('email', { length: 320 }),
    nationalId: varchar('national_id', { length: 20 }),

    occupation: varchar('occupation', { length: 128 }),
    employer: varchar('employer', { length: 255 }),
    /** Monthly income band rather than an exact figure — used for scholarship assessment. */
    incomeBand: varchar('income_band', { length: 32 }),
    educationLevel: varchar('education_level', { length: 64 }),

    address: text('address'),
    photoFileId: uuid('photo_file_id'),
    /** 'sms' | 'email' | 'push' | 'app' — how this guardian prefers to be contacted. */
    preferredChannel: varchar('preferred_channel', { length: 16 }).notNull().default('sms'),
    preferredLocale: varchar('preferred_locale', { length: 5 }).notNull().default('bn'),

    metadata: jsonb('metadata')
      .notNull()
      .default(sql`'{}'::jsonb`),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('guardians_institution_phone_key')
      .on(table.institutionId, table.phone)
      .where(sql`${table.archivedAt} IS NULL`),
    uniqueIndex('guardians_user_key')
      .on(table.userId)
      .where(sql`${table.userId} IS NOT NULL AND ${table.archivedAt} IS NULL`),
    index('guardians_tenant_idx').on(table.tenantId),
    index('guardians_nid_idx').on(table.institutionId, table.nationalId),
  ],
);

/**
 * The student ↔ guardian link. Many-to-many in both directions, as the brief requires.
 *
 * The three "primary" flags are separate booleans because they are genuinely different
 * responsibilities that often sit with different people:
 *  - `isPrimary`      — first point of contact for academic matters.
 *  - `isBillingContact`— receives invoices and is chased for fees.
 *  - `isEmergencyContact` — called when the child is hurt.
 *
 * `canAccessPortal` is the authorization fact behind `students.view.own` for guardians: a
 * guardian sees exactly the students they have a live, portal-enabled link to. This is the row
 * the tenant-isolation suite attacks hardest.
 */
export const studentGuardians = pgTable(
  'student_guardians',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    guardianId: uuid('guardian_id')
      .notNull()
      .references(() => guardians.id, { onDelete: 'cascade' }),
    relation: guardianRelationEnum('relation').notNull(),
    relationOther: varchar('relation_other', { length: 64 }),

    isPrimary: boolean('is_primary').notNull().default(false),
    isBillingContact: boolean('is_billing_contact').notNull().default(false),
    isEmergencyContact: boolean('is_emergency_contact').notNull().default(false),
    /** Revoking this immediately removes the guardian's access to the child's records. */
    canAccessPortal: boolean('can_access_portal').notNull().default(true),
    /** Legal custody restrictions; consulted before releasing a child or sharing records. */
    hasCustody: boolean('has_custody').notNull().default(true),
    notes: varchar('notes', { length: 500 }),

    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('student_guardians_unique_key')
      .on(table.studentId, table.guardianId)
      .where(sql`${table.archivedAt} IS NULL`),
    uniqueIndex('student_guardians_primary_key')
      .on(table.studentId)
      .where(sql`${table.isPrimary} AND ${table.archivedAt} IS NULL`),
    uniqueIndex('student_guardians_billing_key')
      .on(table.studentId)
      .where(sql`${table.isBillingContact} AND ${table.archivedAt} IS NULL`),
    index('student_guardians_student_idx').on(table.studentId),
    // The hot path for the parent portal: "which children may this guardian see?"
    index('student_guardians_guardian_idx')
      .on(table.guardianId)
      .where(sql`${table.canAccessPortal} AND ${table.archivedAt} IS NULL`),
    index('student_guardians_tenant_idx').on(table.tenantId),
  ],
);

/** Documents attached to a student: birth certificate, TC, photos, medical reports. */
export const studentDocuments = pgTable(
  'student_documents',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id').notNull(),
    /** 'birth_certificate' | 'transfer_certificate' | 'photo' | 'medical' | 'other' */
    documentType: varchar('document_type', { length: 48 }).notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    documentNumber: varchar('document_number', { length: 64 }),
    issuedOn: date('issued_on'),
    expiresOn: date('expires_on'),
    /** Whether an administrator has checked the document against the original. */
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }),
    verifiedBy: uuid('verified_by'),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('student_documents_student_idx').on(table.studentId, table.documentType),
    index('student_documents_tenant_idx').on(table.tenantId),
  ],
);

/**
 * Append-only history of student status changes: admission, promotion, transfer, withdrawal,
 * readmission, graduation.
 *
 * Separate from `audit_logs` because this is *domain* history the school reads and prints on a
 * transfer certificate, not a security trail. The audit log records who changed the row; this
 * records what happened to the student.
 */
export const studentStatusHistory = pgTable(
  'student_status_history',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    enrollmentId: uuid('enrollment_id').references(() => enrollments.id, {
      onDelete: 'set null',
    }),
    /** 'admitted' | 'promoted' | 'repeated' | 'transferred' | 'withdrawn' | 'readmitted' | … */
    event: varchar('event', { length: 32 }).notNull(),
    fromStatus: studentStatusEnum('from_status'),
    toStatus: studentStatusEnum('to_status').notNull(),
    effectiveDate: date('effective_date').notNull(),
    reason: text('reason'),
    /** The employee who authorised it, where policy requires a named approver. */
    approvedByEmployeeId: uuid('approved_by_employee_id').references(() => employees.id, {
      onDelete: 'set null',
    }),
    metadata: jsonb('metadata')
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...timestampColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('student_status_history_student_idx').on(table.studentId, table.effectiveDate),
    index('student_status_history_tenant_idx').on(table.tenantId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────

export const studentsRelations = relations(students, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [students.tenantId],
    references: [organizations.id],
  }),
  institution: one(institutions, {
    fields: [students.institutionId],
    references: [institutions.id],
  }),
  user: one(users, { fields: [students.userId], references: [users.id] }),
  enrollments: many(enrollments),
  guardianLinks: many(studentGuardians),
  documents: many(studentDocuments),
  statusHistory: many(studentStatusHistory),
}));

export const enrollmentsRelations = relations(enrollments, ({ one }) => ({
  student: one(students, { fields: [enrollments.studentId], references: [students.id] }),
  section: one(sections, { fields: [enrollments.sectionId], references: [sections.id] }),
  classLevel: one(classLevels, {
    fields: [enrollments.classLevelId],
    references: [classLevels.id],
  }),
  academicYear: one(academicYears, {
    fields: [enrollments.academicYearId],
    references: [academicYears.id],
  }),
}));

export const guardiansRelations = relations(guardians, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [guardians.tenantId],
    references: [organizations.id],
  }),
  user: one(users, { fields: [guardians.userId], references: [users.id] }),
  studentLinks: many(studentGuardians),
}));

export const studentGuardiansRelations = relations(studentGuardians, ({ one }) => ({
  student: one(students, { fields: [studentGuardians.studentId], references: [students.id] }),
  guardian: one(guardians, {
    fields: [studentGuardians.guardianId],
    references: [guardians.id],
  }),
}));
