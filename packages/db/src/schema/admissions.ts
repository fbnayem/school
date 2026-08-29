/**
 * Admissions (Phase 5): the funnel that produces students and guardians.
 *
 * The central design decision: **an application is not a student.** An applicant exists only
 * inside the admissions module until an offer is accepted, at which point the admissions
 * service calls the students and guardians services to create the real records and stamps
 * `admission_applications.student_id` with the result. Nothing else in the platform ever
 * reads applicant rows, so a rejected nine-year-old's data never leaks into rosters,
 * attendance or fees.
 *
 * Status is an explicit machine (validated in the service layer), seats are enforced per
 * class level against the session's recorded capacity under a row lock, and merit lists are
 * generated deterministically in SQL with the criteria recorded on the list row — so the same
 * inputs always produce the same ranking, and an auditor can re-run it.
 */

import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  time,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  actorColumns,
  archiveColumns,
  genderEnum,
  guardianRelationEnum,
  primaryKeyColumn,
  timestampColumns,
  versionColumn,
} from './_shared';
import { campuses, institutions, organizations } from './tenancy';
import { academicYears, classLevels } from './academic';
import { employees } from './people';
import { students } from './students';

// ─────────────────────────────────────────────────────────────────────────────────────
// Enumerations. Declared here rather than in `_shared.ts` (following the fees module):
// they are consumed by admissions alone, and the value sets are genuinely closed — adding
// a status changes the state machine in the service as well as the schema.
// ─────────────────────────────────────────────────────────────────────────────────────

export const admissionSessionStatusEnum = pgEnum('admission_session_status', [
  'draft',
  'open',
  'closed',
  'completed',
]);

export const admissionApplicationStatusEnum = pgEnum('admission_application_status', [
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
]);

export const admissionApplicationSourceEnum = pgEnum('admission_application_source', [
  'online',
  'counter',
]);

export const admissionOfferStatusEnum = pgEnum('admission_offer_status', [
  'pending',
  'accepted',
  'declined',
  'expired',
  'withdrawn',
]);

// ─────────────────────────────────────────────────────────────────────────────────────
// Tables
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * One intake cycle: "Admission 2027", with its application window, its fee, and the class
 * levels it is open for.
 *
 * `classCapacity` is a jsonb array of `{ classLevelId, seats }` rather than a child table:
 * the set is small (a school opens a handful of classes per cycle), it is always read as a
 * whole, and seat enforcement happens under a `SELECT … FOR UPDATE` of this one row — which
 * is precisely what makes two concurrent acceptances serialize instead of overselling.
 */
export const admissionSessions = pgTable(
  'admission_sessions',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    campusId: uuid('campus_id').references(() => campuses.id, { onDelete: 'restrict' }),
    /** The year applicants will be enrolled into on acceptance. */
    academicYearId: uuid('academic_year_id')
      .notNull()
      .references(() => academicYears.id, { onDelete: 'restrict' }),

    nameEn: varchar('name_en', { length: 128 }).notNull(),
    nameBn: varchar('name_bn', { length: 128 }),

    applicationStartDate: date('application_start_date').notNull(),
    applicationEndDate: date('application_end_date').notNull(),

    /** The application (form) fee. `numeric(14,2)`; parsed only by `Money` (ADR-004). */
    applicationFee: numeric('application_fee', { precision: 14, scale: 2 })
      .notNull()
      .default('0.00'),

    /**
     * Which class levels are open and how many seats each has:
     * `[{ "classLevelId": "<uuid>", "seats": 120 }, …]`. Validated by Zod on write.
     */
    classCapacity: jsonb('class_capacity')
      .notNull()
      .default(sql`'[]'::jsonb`),

    status: admissionSessionStatusEnum('status').notNull().default('draft'),

    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('admission_sessions_institution_name_key')
      .on(table.institutionId, table.nameEn)
      .where(sql`${table.archivedAt} IS NULL`),
    index('admission_sessions_tenant_idx').on(table.tenantId),
    index('admission_sessions_institution_status_idx').on(table.institutionId, table.status),
    index('admission_sessions_year_idx').on(table.academicYearId),
    index('admission_sessions_campus_idx').on(table.campusId),
  ],
);

/**
 * One application from one child to one session, for one class level.
 *
 * Guardian details are recorded inline rather than as a `guardians` row on purpose: most
 * applicants are rejected, and their families must not accumulate in the operational
 * guardian table. The real guardian record is created only on offer acceptance, deduplicated
 * by phone through the existing guardian service.
 */
export const admissionApplications = pgTable(
  'admission_applications',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => admissionSessions.id, { onDelete: 'restrict' }),
    classLevelId: uuid('class_level_id')
      .notNull()
      .references(() => classLevels.id, { onDelete: 'restrict' }),

    /** Human-facing number, e.g. ADM2026-00042. Unique per institution among live rows. */
    applicationNumber: varchar('application_number', { length: 32 }).notNull(),

    applicantNameEn: varchar('applicant_name_en', { length: 255 }).notNull(),
    applicantNameBn: varchar('applicant_name_bn', { length: 255 }),
    dateOfBirth: date('date_of_birth').notNull(),
    gender: genderEnum('gender').notNull(),
    birthRegistrationNumber: varchar('birth_registration_number', { length: 20 }),
    photoFileId: uuid('photo_file_id'),

    previousSchoolName: varchar('previous_school_name', { length: 255 }),
    previousClassCompleted: varchar('previous_class_completed', { length: 64 }),
    /** GPA on the 5.00 scale from the previous school, when supplied. Feeds merit criteria. */
    previousResultGpa: numeric('previous_result_gpa', { precision: 4, scale: 2 }),

    guardianNameEn: varchar('guardian_name_en', { length: 255 }).notNull(),
    guardianNameBn: varchar('guardian_name_bn', { length: 255 }),
    guardianRelation: guardianRelationEnum('guardian_relation').notNull(),
    /** E.164, normalised on write. The dedupe key when a guardian record is created later. */
    guardianPhone: varchar('guardian_phone', { length: 20 }).notNull(),
    guardianEmail: varchar('guardian_email', { length: 320 }),
    guardianNid: varchar('guardian_nid', { length: 20 }),
    presentAddress: varchar('present_address', { length: 1000 }),

    /** 'general' | 'freedom_fighter' | 'sibling' | 'staff_child' | … — semi-open set. */
    quota: varchar('quota', { length: 32 }),

    status: admissionApplicationStatusEnum('status').notNull().default('submitted'),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true, mode: 'date' }),
    statusReason: varchar('status_reason', { length: 1000 }),

    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    source: admissionApplicationSourceEnum('source').notNull().default('online'),

    /** Set exactly once, when acceptance creates the real student record. */
    studentId: uuid('student_id').references(() => students.id, { onDelete: 'set null' }),

    metadata: jsonb('metadata')
      .notNull()
      .default(sql`'{}'::jsonb`),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('admission_applications_number_key')
      .on(table.institutionId, table.applicationNumber)
      .where(sql`${table.archivedAt} IS NULL`),
    // One live application per child per session: same name + date of birth resubmitted to
    // the same cycle is a duplicate, not a sibling.
    uniqueIndex('admission_applications_dedupe_key')
      .on(table.sessionId, table.applicantNameEn, table.dateOfBirth)
      .where(sql`${table.status} <> 'withdrawn' AND ${table.archivedAt} IS NULL`),
    index('admission_applications_tenant_idx').on(table.tenantId),
    index('admission_applications_session_status_idx').on(table.sessionId, table.status),
    index('admission_applications_session_class_idx').on(table.sessionId, table.classLevelId),
    index('admission_applications_guardian_phone_idx').on(table.tenantId, table.guardianPhone),
    index('admission_applications_student_idx').on(table.studentId),
  ],
);

/** A document attached to an application: birth certificate, previous report card, photo. */
export const admissionApplicationDocuments = pgTable(
  'admission_application_documents',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => admissionApplications.id, { onDelete: 'cascade' }),

    /** Key into object storage, produced by the storage service — never a client-made path. */
    storageKey: varchar('storage_key', { length: 512 }).notNull(),
    /** 'birth_certificate' | 'photo' | 'previous_report_card' | 'transfer_certificate' | … */
    documentType: varchar('document_type', { length: 48 }).notNull(),
    title: varchar('title', { length: 255 }).notNull(),

    /** Set when an administrator has checked the document against the original. */
    verifiedBy: uuid('verified_by'),
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }),

    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('admission_application_documents_application_idx').on(
      table.applicationId,
      table.documentType,
    ),
    index('admission_application_documents_tenant_idx').on(table.tenantId),
  ],
);

/** An admission test: one sitting with a total, a pass mark and a venue. */
export const admissionTests = pgTable(
  'admission_tests',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => admissionSessions.id, { onDelete: 'cascade' }),
    /** Null when the test covers every class level open in the session. */
    classLevelId: uuid('class_level_id').references(() => classLevels.id, {
      onDelete: 'restrict',
    }),

    nameEn: varchar('name_en', { length: 128 }).notNull(),
    nameBn: varchar('name_bn', { length: 128 }),
    testDate: date('test_date').notNull(),
    startTime: time('start_time'),
    /** Marks are decimal strings in `numeric(6,2)`, matching the examinations module. */
    totalMarks: numeric('total_marks', { precision: 6, scale: 2 }).notNull(),
    passMarks: numeric('pass_marks', { precision: 6, scale: 2 }).notNull(),
    venue: varchar('venue', { length: 255 }),

    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('admission_tests_session_name_key')
      .on(table.sessionId, table.nameEn)
      .where(sql`${table.archivedAt} IS NULL`),
    index('admission_tests_tenant_idx').on(table.tenantId),
    index('admission_tests_session_idx').on(table.sessionId, table.testDate),
    index('admission_tests_class_idx').on(table.classLevelId),
  ],
);

/** One applicant's result in one test. `marksObtained` is null exactly when absent. */
export const admissionTestResults = pgTable(
  'admission_test_results',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    testId: uuid('test_id')
      .notNull()
      .references(() => admissionTests.id, { onDelete: 'cascade' }),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => admissionApplications.id, { onDelete: 'restrict' }),

    marksObtained: numeric('marks_obtained', { precision: 6, scale: 2 }),
    isAbsent: boolean('is_absent').notNull().default(false),
    /** The user who keyed the marks in. Marks entry is an audited act. */
    enteredBy: uuid('entered_by'),

    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('admission_test_results_unique_key')
      .on(table.testId, table.applicationId)
      .where(sql`${table.archivedAt} IS NULL`),
    index('admission_test_results_application_idx').on(table.applicationId),
    index('admission_test_results_tenant_idx').on(table.tenantId),
  ],
);

/**
 * An interview for one application. One live interview per application, because the merit
 * formula reads "the interview score" — a school that runs interview rounds records the
 * final panel's score here.
 */
export const admissionInterviews = pgTable(
  'admission_interviews',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => admissionApplications.id, { onDelete: 'restrict' }),

    panelName: varchar('panel_name', { length: 128 }),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true, mode: 'date' }).notNull(),
    interviewerEmployeeId: uuid('interviewer_employee_id').references(() => employees.id, {
      onDelete: 'set null',
    }),

    /** 0–100 with two decimals; null until the panel scores. */
    score: numeric('score', { precision: 5, scale: 2 }),
    remarks: varchar('remarks', { length: 1000 }),
    scoredAt: timestamp('scored_at', { withTimezone: true, mode: 'date' }),
    scoredBy: uuid('scored_by'),

    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('admission_interviews_application_key')
      .on(table.applicationId)
      .where(sql`${table.archivedAt} IS NULL`),
    index('admission_interviews_tenant_idx').on(table.tenantId),
    index('admission_interviews_schedule_idx').on(table.scheduledAt),
    index('admission_interviews_interviewer_idx').on(table.interviewerEmployeeId),
  ],
);

/**
 * A merit list: one deterministic ranking of one session's applicants for one class level.
 *
 * `criteria` records the exact weights (basis points for test, interview and previous
 * results, plus any quota bonus points) and the tie-break rule the ranking used, so the list
 * is reproducible from its own row. Generation does not publish; `publishedAt` is set by a
 * separate, separately-audited action.
 */
export const admissionMeritLists = pgTable(
  'admission_merit_lists',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => admissionSessions.id, { onDelete: 'restrict' }),
    classLevelId: uuid('class_level_id')
      .notNull()
      .references(() => classLevels.id, { onDelete: 'restrict' }),

    nameEn: varchar('name_en', { length: 128 }).notNull(),
    nameBn: varchar('name_bn', { length: 128 }),
    criteria: jsonb('criteria')
      .notNull()
      .default(sql`'{}'::jsonb`),

    generatedAt: timestamp('generated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    generatedBy: uuid('generated_by'),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
    publishedBy: uuid('published_by'),

    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('admission_merit_lists_name_key')
      .on(table.sessionId, table.classLevelId, table.nameEn)
      .where(sql`${table.archivedAt} IS NULL`),
    index('admission_merit_lists_tenant_idx').on(table.tenantId),
    index('admission_merit_lists_session_idx').on(table.sessionId, table.classLevelId),
  ],
);

/** One row of a merit list. Rank is dense within the list; ties were already broken. */
export const admissionMeritEntries = pgTable(
  'admission_merit_entries',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    meritListId: uuid('merit_list_id')
      .notNull()
      .references(() => admissionMeritLists.id, { onDelete: 'cascade' }),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => admissionApplications.id, { onDelete: 'restrict' }),

    rank: integer('rank').notNull(),
    /** Weighted 0–100 aggregate, four decimals so tie-breaking is visible in the data. */
    aggregateScore: numeric('aggregate_score', { precision: 9, scale: 4 }).notNull(),
    /** The component scores the aggregate was computed from, for the printed list. */
    components: jsonb('components')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** True when the rank fell beyond the seats configured for the class level. */
    isWaitlisted: boolean('is_waitlisted').notNull().default(false),

    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('admission_merit_entries_application_key')
      .on(table.meritListId, table.applicationId)
      .where(sql`${table.archivedAt} IS NULL`),
    uniqueIndex('admission_merit_entries_rank_key')
      .on(table.meritListId, table.rank)
      .where(sql`${table.archivedAt} IS NULL`),
    index('admission_merit_entries_tenant_idx').on(table.tenantId),
    index('admission_merit_entries_application_idx').on(table.applicationId),
  ],
);

/**
 * An offer of a seat. It expires, and an expired offer cannot be accepted.
 *
 * `feeDue` is the admission fee the family must pay to take the seat — `numeric(14,2)`,
 * parsed only by `Money`.
 */
export const admissionOffers = pgTable(
  'admission_offers',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => admissionApplications.id, { onDelete: 'restrict' }),

    offeredAt: timestamp('offered_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'date' }),
    declinedAt: timestamp('declined_at', { withTimezone: true, mode: 'date' }),

    feeDue: numeric('fee_due', { precision: 14, scale: 2 }).notNull().default('0.00'),
    status: admissionOfferStatusEnum('status').notNull().default('pending'),
    notes: varchar('notes', { length: 1000 }),

    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    // At most one live (pending or accepted) offer per application: a re-offer after a
    // decline or expiry is a new row, preserving the history of what was offered when.
    uniqueIndex('admission_offers_live_key')
      .on(table.applicationId)
      .where(sql`${table.status} IN ('pending', 'accepted') AND ${table.archivedAt} IS NULL`),
    index('admission_offers_tenant_idx').on(table.tenantId),
    index('admission_offers_application_idx').on(table.applicationId),
    index('admission_offers_expiry_idx')
      .on(table.expiresAt)
      .where(sql`${table.status} = 'pending'`),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Relations
// ─────────────────────────────────────────────────────────────────────────────────────

export const admissionSessionsRelations = relations(admissionSessions, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [admissionSessions.institutionId],
    references: [institutions.id],
  }),
  academicYear: one(academicYears, {
    fields: [admissionSessions.academicYearId],
    references: [academicYears.id],
  }),
  applications: many(admissionApplications),
  tests: many(admissionTests),
  meritLists: many(admissionMeritLists),
}));

export const admissionApplicationsRelations = relations(admissionApplications, ({ one, many }) => ({
  session: one(admissionSessions, {
    fields: [admissionApplications.sessionId],
    references: [admissionSessions.id],
  }),
  classLevel: one(classLevels, {
    fields: [admissionApplications.classLevelId],
    references: [classLevels.id],
  }),
  student: one(students, {
    fields: [admissionApplications.studentId],
    references: [students.id],
  }),
  documents: many(admissionApplicationDocuments),
  testResults: many(admissionTestResults),
  interviews: many(admissionInterviews),
  offers: many(admissionOffers),
}));

export const admissionApplicationDocumentsRelations = relations(
  admissionApplicationDocuments,
  ({ one }) => ({
    application: one(admissionApplications, {
      fields: [admissionApplicationDocuments.applicationId],
      references: [admissionApplications.id],
    }),
  }),
);

export const admissionTestsRelations = relations(admissionTests, ({ one, many }) => ({
  session: one(admissionSessions, {
    fields: [admissionTests.sessionId],
    references: [admissionSessions.id],
  }),
  results: many(admissionTestResults),
}));

export const admissionTestResultsRelations = relations(admissionTestResults, ({ one }) => ({
  test: one(admissionTests, {
    fields: [admissionTestResults.testId],
    references: [admissionTests.id],
  }),
  application: one(admissionApplications, {
    fields: [admissionTestResults.applicationId],
    references: [admissionApplications.id],
  }),
}));

export const admissionInterviewsRelations = relations(admissionInterviews, ({ one }) => ({
  application: one(admissionApplications, {
    fields: [admissionInterviews.applicationId],
    references: [admissionApplications.id],
  }),
  interviewer: one(employees, {
    fields: [admissionInterviews.interviewerEmployeeId],
    references: [employees.id],
  }),
}));

export const admissionMeritListsRelations = relations(admissionMeritLists, ({ one, many }) => ({
  session: one(admissionSessions, {
    fields: [admissionMeritLists.sessionId],
    references: [admissionSessions.id],
  }),
  classLevel: one(classLevels, {
    fields: [admissionMeritLists.classLevelId],
    references: [classLevels.id],
  }),
  entries: many(admissionMeritEntries),
}));

export const admissionMeritEntriesRelations = relations(admissionMeritEntries, ({ one }) => ({
  meritList: one(admissionMeritLists, {
    fields: [admissionMeritEntries.meritListId],
    references: [admissionMeritLists.id],
  }),
  application: one(admissionApplications, {
    fields: [admissionMeritEntries.applicationId],
    references: [admissionApplications.id],
  }),
}));

export const admissionOffersRelations = relations(admissionOffers, ({ one }) => ({
  application: one(admissionApplications, {
    fields: [admissionOffers.applicationId],
    references: [admissionApplications.id],
  }),
}));
