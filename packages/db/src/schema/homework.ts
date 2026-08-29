/**
 * Homework and assignments (Phase 9).
 *
 * The shape mirrors the exams module's split between the *task* and the *responses to it*:
 *
 *  - `assignments` is the task a teacher sets for one section+subject: what to do, when it
 *    was set, when it is due (an instant, because "23:59 Dhaka time" is a deadline, not a
 *    calendar fact), and whether it is marked.
 *  - `assignment_submissions` is one student's attempt. A resubmission is a **new row** with
 *    the next `attempt_number`, never an edit of the old one — a submitted piece of work is
 *    an academic record, and the history of attempts is part of it.
 *  - `submission_grades` is append-mostly: re-grading writes a new row and demotes the old
 *    final, so a disputed mark can always be traced through its predecessors.
 *
 * Attachment bytes live in object storage behind `StorageService`; the attachment tables
 * carry the storage key and the display metadata, and each also points at the central
 * `files` row that authorises signed-URL redemption. Nothing here is ever hard-deleted:
 * withdrawing an assignment is a status change plus the archive marker (ADR-008).
 */

import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
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
  primaryKeyColumn,
  timestampColumns,
  versionColumn,
} from './_shared';
import { campuses, institutions, organizations } from './tenancy';
import { academicYears, sections, subjects } from './academic';
import { employees } from './people';
import { students } from './students';
import { files } from './files';

// ─────────────────────────────────────────────────────────────────────────────────────
// Enumerations. Closed value sets: adding a new assignment type or lifecycle state changes
// how the product filters, reports and refuses submissions, which is a code change (see the
// rule in `_shared.ts`). Anything a school could invent for itself would be a lookup table.
// ─────────────────────────────────────────────────────────────────────────────────────

export const assignmentTypeEnum = pgEnum('assignment_type', [
  'homework',
  'project',
  'classwork',
  'practical',
  'reading',
]);

export const assignmentStatusEnum = pgEnum('assignment_status', [
  'draft',
  'published',
  'closed',
  'archived',
]);

export const assignmentSubmissionStatusEnum = pgEnum('assignment_submission_status', [
  'not_submitted',
  'submitted',
  'late',
  'resubmitted',
  'graded',
  'returned',
]);

// ─────────────────────────────────────────────────────────────────────────────────────
// Assignments
// ─────────────────────────────────────────────────────────────────────────────────────

export const assignments = pgTable(
  'assignments',
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
    academicYearId: uuid('academic_year_id')
      .notNull()
      .references(() => academicYears.id, { onDelete: 'restrict' }),
    sectionId: uuid('section_id')
      .notNull()
      .references(() => sections.id, { onDelete: 'restrict' }),
    subjectId: uuid('subject_id')
      .notNull()
      .references(() => subjects.id, { onDelete: 'restrict' }),
    /**
     * The teacher who set the work. Nullable because an administrator whose account has no
     * employee record may create on a teacher's behalf; the acting *user* is always in
     * `created_by`. Drafts are visible only to this employee and to `all`-scope staff.
     */
    createdByEmployeeId: uuid('created_by_employee_id').references(() => employees.id, {
      onDelete: 'restrict',
    }),

    title: varchar('title', { length: 255 }).notNull(),
    titleBn: varchar('title_bn', { length: 255 }),
    instructions: text('instructions'),
    type: assignmentTypeEnum('type').notNull().default('homework'),

    /** The day the work was set — a calendar fact (ADR-009). */
    assignedOn: date('assigned_on').notNull(),
    /** The deadline — an instant, because lateness is decided by the server clock. */
    dueAt: timestamp('due_at', { withTimezone: true, mode: 'date' }).notNull(),

    /** Null for ungraded work. `numeric`, never a float; arrives from the driver as a string. */
    maxMarks: numeric('max_marks', { precision: 6, scale: 2 }),
    isGraded: boolean('is_graded').notNull().default(false),
    allowLate: boolean('allow_late').notNull().default(false),
    /** Percent with two decimals, read as basis points ("10.00" = 1000bp). Advisory to graders. */
    latePenaltyPercent: numeric('late_penalty_percent', { precision: 5, scale: 2 })
      .notNull()
      .default('0.00'),

    status: assignmentStatusEnum('status').notNull().default('draft'),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),

    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('assignments_tenant_idx').on(table.tenantId),
    index('assignments_section_status_idx').on(table.sectionId, table.status),
    index('assignments_institution_year_idx').on(table.institutionId, table.academicYearId),
    index('assignments_subject_idx').on(table.subjectId),
    index('assignments_creator_idx').on(table.createdByEmployeeId),
    index('assignments_due_idx').on(table.dueAt),
  ],
);

/** A file the teacher attached to the task: the worksheet, the reading, the rubric. */
export const assignmentAttachments = pgTable(
  'assignment_attachments',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    assignmentId: uuid('assignment_id')
      .notNull()
      .references(() => assignments.id, { onDelete: 'cascade' }),
    /** The central authorization record for the bytes; signed-URL redemption reads it. */
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'restrict' }),
    /** `tenants/{tenantId}/assignment/{uuid}.{ext}` — built by StorageService, never by hand. */
    storageKey: varchar('storage_key', { length: 512 }).notNull(),
    filename: varchar('filename', { length: 255 }).notNull(),
    mimeType: varchar('mime_type', { length: 128 }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('assignment_attachments_tenant_idx').on(table.tenantId),
    index('assignment_attachments_assignment_idx').on(table.assignmentId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Submissions
// ─────────────────────────────────────────────────────────────────────────────────────

export const assignmentSubmissions = pgTable(
  'assignment_submissions',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    assignmentId: uuid('assignment_id')
      .notNull()
      .references(() => assignments.id, { onDelete: 'restrict' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'restrict' }),

    /** Stamped by the server clock at insert. Never client-supplied. */
    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    status: assignmentSubmissionStatusEnum('status').notNull().default('submitted'),
    textResponse: text('text_response'),
    /** Derived by the server from `submitted_at` versus the assignment's `due_at`. */
    isLate: boolean('is_late').notNull().default(false),
    attemptNumber: smallint('attempt_number').notNull().default(1),

    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('assignment_submissions_attempt_key')
      .on(table.assignmentId, table.studentId, table.attemptNumber)
      .where(sql`${table.archivedAt} IS NULL`),
    index('assignment_submissions_tenant_idx').on(table.tenantId),
    index('assignment_submissions_assignment_idx').on(table.assignmentId, table.studentId),
    index('assignment_submissions_student_idx').on(table.studentId),
  ],
);

/** A file the student handed in with their attempt. */
export const submissionAttachments = pgTable(
  'submission_attachments',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => assignmentSubmissions.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'restrict' }),
    storageKey: varchar('storage_key', { length: 512 }).notNull(),
    filename: varchar('filename', { length: 255 }).notNull(),
    mimeType: varchar('mime_type', { length: 128 }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('submission_attachments_tenant_idx').on(table.tenantId),
    index('submission_attachments_submission_idx').on(table.submissionId),
  ],
);

/**
 * One grading of one submission. Re-grading demotes the previous final row
 * (`is_final = false`) and inserts a new one, so the partial unique index below guarantees
 * a single current grade while the full history stays queryable.
 */
export const submissionGrades = pgTable(
  'submission_grades',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => assignmentSubmissions.id, { onDelete: 'restrict' }),

    /** Bounded by the assignment's `max_marks` in the service; `numeric`, never a float. */
    marks: numeric('marks', { precision: 6, scale: 2 }).notNull(),
    feedback: text('feedback'),
    gradedBy: uuid('graded_by')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),
    gradedAt: timestamp('graded_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    isFinal: boolean('is_final').notNull().default(true),

    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('submission_grades_final_key')
      .on(table.submissionId)
      .where(sql`${table.isFinal} AND ${table.archivedAt} IS NULL`),
    index('submission_grades_tenant_idx').on(table.tenantId),
    index('submission_grades_submission_idx').on(table.submissionId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Relations
// ─────────────────────────────────────────────────────────────────────────────────────

export const assignmentsRelations = relations(assignments, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [assignments.institutionId],
    references: [institutions.id],
  }),
  section: one(sections, { fields: [assignments.sectionId], references: [sections.id] }),
  subject: one(subjects, { fields: [assignments.subjectId], references: [subjects.id] }),
  creator: one(employees, {
    fields: [assignments.createdByEmployeeId],
    references: [employees.id],
  }),
  attachments: many(assignmentAttachments),
  submissions: many(assignmentSubmissions),
}));

export const assignmentAttachmentsRelations = relations(assignmentAttachments, ({ one }) => ({
  assignment: one(assignments, {
    fields: [assignmentAttachments.assignmentId],
    references: [assignments.id],
  }),
  file: one(files, { fields: [assignmentAttachments.fileId], references: [files.id] }),
}));

export const assignmentSubmissionsRelations = relations(assignmentSubmissions, ({ one, many }) => ({
  assignment: one(assignments, {
    fields: [assignmentSubmissions.assignmentId],
    references: [assignments.id],
  }),
  student: one(students, {
    fields: [assignmentSubmissions.studentId],
    references: [students.id],
  }),
  attachments: many(submissionAttachments),
  grades: many(submissionGrades),
}));

export const submissionAttachmentsRelations = relations(submissionAttachments, ({ one }) => ({
  submission: one(assignmentSubmissions, {
    fields: [submissionAttachments.submissionId],
    references: [assignmentSubmissions.id],
  }),
  file: one(files, { fields: [submissionAttachments.fileId], references: [files.id] }),
}));

export const submissionGradesRelations = relations(submissionGrades, ({ one }) => ({
  submission: one(assignmentSubmissions, {
    fields: [submissionGrades.submissionId],
    references: [assignmentSubmissions.id],
  }),
  grader: one(employees, { fields: [submissionGrades.gradedBy], references: [employees.id] }),
}));
