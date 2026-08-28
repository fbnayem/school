/**
 * Attendance (Phase 7).
 *
 * Four tables, and the split between them is the whole design:
 *
 *  - `attendance_sessions` is the *register*: one row per section per day, or per section per
 *    period where a school marks subject-wise. It carries the workflow state, so "has 6A been
 *    taken today" is one indexed lookup rather than a count over the marks.
 *  - `student_attendance` is one mark per student per session. It is the row a report card,
 *    a fee fine and the guardian notification all read.
 *  - `attendance_corrections` is an append-only record of every request to change a mark on a
 *    session that has already been submitted. A submitted register is an institutional record
 *    (ADR-008): it is never edited silently, and never deleted. The correction row carries the
 *    before value, the after value, the mandatory reason and the approver.
 *  - `employee_attendance` is staff presence, kept separate because it is payroll input rather
 *    than an academic record, and because its permissions are different — a class teacher who
 *    marks thirty students must not thereby be able to mark their colleagues.
 *
 * `attendance_date` is a `date`, never a `timestamptz`. "2026-03-15" is the same school day in
 * every timezone; storing it as an instant creates the off-by-one-day bug at the Dhaka/UTC
 * boundary that ADR-009 exists to prevent. The punch times on `employee_attendance` *are*
 * instants and are stored as such.
 */

import { relations, sql } from 'drizzle-orm';
import {
  date,
  index,
  integer,
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
import { academicYears, periods, sections, subjects } from './academic';
import { employees } from './people';
import { enrollments, students } from './students';

// ─────────────────────────────────────────────────────────────────────────────────────
// Enumerations
//
// All four value sets are genuinely closed: adding "half day" or "device" is a change to how
// the product computes attendance percentages and payroll, not a tenant configuration choice,
// so it should require a migration and a code change rather than a row in a lookup table.
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The register's workflow state.
 *
 *  - `open`      — being taken; marks may be written and rewritten freely.
 *  - `submitted` — the teacher has signed it off. Marks change only through a correction.
 *  - `locked`    — closed for the reporting period. Not even a correction may be applied.
 */
export const attendanceSessionStatusEnum = pgEnum('attendance_session_status', [
  'open',
  'submitted',
  'locked',
]);

export const studentAttendanceStatusEnum = pgEnum('student_attendance_status', [
  'present',
  'absent',
  'late',
  'excused',
  'half_day',
]);

export const attendanceCorrectionStatusEnum = pgEnum('attendance_correction_status', [
  'pending',
  'approved',
  'rejected',
]);

export const employeeAttendanceStatusEnum = pgEnum('employee_attendance_status', [
  'present',
  'absent',
  'late',
  'on_leave',
  'half_day',
]);

/** Where the record came from. A biometric device's rows are not hand-editable in the same way. */
export const employeeAttendanceSourceEnum = pgEnum('employee_attendance_source', [
  'manual',
  'device',
]);

// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * One register: a section, on a date, optionally for one period and subject.
 *
 * `periodId` null means daily attendance — the single register a primary school takes at
 * assembly. Non-null means period-wise, which secondary schools use to catch the student who
 * signs in and then leaves. The two uniqueness rules are therefore separate partial indexes:
 * a section may have one daily register *and* one register per period on the same date.
 */
export const attendanceSessions = pgTable(
  'attendance_sessions',
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
    /** Null for daily attendance. */
    periodId: uuid('period_id').references(() => periods.id, { onDelete: 'restrict' }),
    /** Null for daily attendance; set for subject-wise registers. */
    subjectId: uuid('subject_id').references(() => subjects.id, { onDelete: 'restrict' }),

    /** A calendar fact, not an instant. See the file header. */
    attendanceDate: date('attendance_date').notNull(),

    /** The staff member who took it. Null while the register is still open and untouched. */
    takenByEmployeeId: uuid('taken_by_employee_id').references(() => employees.id, {
      onDelete: 'set null',
    }),
    takenByUserId: uuid('taken_by_user_id'),
    takenAt: timestamp('taken_at', { withTimezone: true, mode: 'date' }),

    status: attendanceSessionStatusEnum('status').notNull().default('open'),
    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' }),
    lockedAt: timestamp('locked_at', { withTimezone: true, mode: 'date' }),
    lockedBy: uuid('locked_by'),

    notes: varchar('notes', { length: 500 }),

    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('attendance_sessions_period_key')
      .on(table.sectionId, table.attendanceDate, table.periodId)
      .where(sql`${table.periodId} IS NOT NULL AND ${table.archivedAt} IS NULL`),
    uniqueIndex('attendance_sessions_daily_key')
      .on(table.sectionId, table.attendanceDate)
      .where(sql`${table.periodId} IS NULL AND ${table.archivedAt} IS NULL`),
    index('attendance_sessions_tenant_idx').on(table.tenantId),
    // The hot path: "what registers exist for this section this month".
    index('attendance_sessions_section_date_idx').on(table.sectionId, table.attendanceDate),
    index('attendance_sessions_institution_date_idx').on(table.institutionId, table.attendanceDate),
    index('attendance_sessions_year_idx').on(table.academicYearId),
    index('attendance_sessions_campus_idx').on(table.campusId),
    index('attendance_sessions_period_idx').on(table.periodId),
    index('attendance_sessions_subject_idx').on(table.subjectId),
    index('attendance_sessions_taken_by_idx').on(table.takenByEmployeeId),
  ],
);

/**
 * One student's mark in one register.
 *
 * `enrollmentId` is stored rather than recomputed: a student who transfers section mid-year
 * must keep the marks they earned in the section they were actually in, and resolving the
 * enrolment at read time would reattribute them to the new section.
 */
export const studentAttendance = pgTable(
  'student_attendance',
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
      .references(() => attendanceSessions.id, { onDelete: 'restrict' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'restrict' }),
    enrollmentId: uuid('enrollment_id').references(() => enrollments.id, {
      onDelete: 'set null',
    }),

    status: studentAttendanceStatusEnum('status').notNull(),
    /** Only meaningful with `late`; kept nullable so "late, duration unknown" is expressible. */
    minutesLate: smallint('minutes_late'),
    remarks: varchar('remarks', { length: 500 }),

    markedAt: timestamp('marked_at', { withTimezone: true, mode: 'date' }),
    markedBy: uuid('marked_by'),
    /** Set when an approved correction changed this row, so a report can flag it. */
    lastCorrectedAt: timestamp('last_corrected_at', { withTimezone: true, mode: 'date' }),

    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('student_attendance_session_student_key')
      .on(table.sessionId, table.studentId)
      .where(sql`${table.archivedAt} IS NULL`),
    index('student_attendance_tenant_idx').on(table.tenantId),
    index('student_attendance_session_idx').on(table.sessionId),
    // Drives every per-student report and the consecutive-absence scan.
    index('student_attendance_student_status_idx').on(table.studentId, table.status),
    index('student_attendance_enrollment_idx').on(table.enrollmentId),
  ],
);

/**
 * Every requested change to a submitted mark.
 *
 * Append-only in practice: a row is inserted `pending` and moves once to `approved` or
 * `rejected`. Nothing here is ever deleted, because "the register said absent on the 3rd and
 * someone changed it to present on the 20th" is exactly the question an audit of a scholarship
 * or an attendance-linked stipend has to answer.
 *
 * `reason` is `not null` at the database level rather than only in Zod: an unexplained change
 * to an academic record is the thing this table exists to make impossible.
 */
export const attendanceCorrections = pgTable(
  'attendance_corrections',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    studentAttendanceId: uuid('student_attendance_id')
      .notNull()
      .references(() => studentAttendance.id, { onDelete: 'restrict' }),
    /** Denormalised so the correction queue can filter by section/date without a three-way join. */
    sessionId: uuid('session_id')
      .notNull()
      .references(() => attendanceSessions.id, { onDelete: 'restrict' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'restrict' }),

    previousStatus: studentAttendanceStatusEnum('previous_status').notNull(),
    newStatus: studentAttendanceStatusEnum('new_status').notNull(),
    previousMinutesLate: smallint('previous_minutes_late'),
    newMinutesLate: smallint('new_minutes_late'),

    reason: text('reason').notNull(),

    requestedBy: uuid('requested_by').notNull(),
    requestedByEmployeeId: uuid('requested_by_employee_id').references(() => employees.id, {
      onDelete: 'set null',
    }),
    requestedAt: timestamp('requested_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),

    status: attendanceCorrectionStatusEnum('status').notNull().default('pending'),
    approvedBy: uuid('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true, mode: 'date' }),
    decisionNote: varchar('decision_note', { length: 1000 }),

    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('attendance_corrections_tenant_idx').on(table.tenantId),
    // The approver's queue.
    index('attendance_corrections_status_idx').on(table.institutionId, table.status),
    index('attendance_corrections_mark_idx').on(table.studentAttendanceId),
    index('attendance_corrections_session_idx').on(table.sessionId),
    index('attendance_corrections_student_idx').on(table.studentId),
    index('attendance_corrections_requested_by_idx').on(table.requestedByEmployeeId),
  ],
);

/**
 * Staff presence for one employee on one day.
 *
 * Separate from student attendance because it feeds payroll rather than a report card, and
 * because the permissions differ: `attendance.employee.mark` is held by HR, not by the class
 * teacher who marks the register.
 */
export const employeeAttendance = pgTable(
  'employee_attendance',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    campusId: uuid('campus_id').references(() => campuses.id, { onDelete: 'set null' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),

    attendanceDate: date('attendance_date').notNull(),

    /** Punch times are instants, unlike the date they belong to. */
    checkInAt: timestamp('check_in_at', { withTimezone: true, mode: 'date' }),
    checkOutAt: timestamp('check_out_at', { withTimezone: true, mode: 'date' }),

    status: employeeAttendanceStatusEnum('status').notNull().default('present'),
    source: employeeAttendanceSourceEnum('source').notNull().default('manual'),
    /** Identifier reported by the biometric terminal, for reconciliation. */
    deviceReference: varchar('device_reference', { length: 64 }),

    minutesLate: smallint('minutes_late'),
    /** Derived on check-out and stored, so payroll does not recompute it from two instants. */
    workedMinutes: integer('worked_minutes'),
    remarks: varchar('remarks', { length: 500 }),

    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('employee_attendance_employee_date_key')
      .on(table.employeeId, table.attendanceDate)
      .where(sql`${table.archivedAt} IS NULL`),
    index('employee_attendance_tenant_idx').on(table.tenantId),
    index('employee_attendance_institution_date_idx').on(table.institutionId, table.attendanceDate),
    index('employee_attendance_employee_idx').on(table.employeeId),
    index('employee_attendance_campus_idx').on(table.campusId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────

export const attendanceSessionsRelations = relations(attendanceSessions, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [attendanceSessions.institutionId],
    references: [institutions.id],
  }),
  campus: one(campuses, { fields: [attendanceSessions.campusId], references: [campuses.id] }),
  academicYear: one(academicYears, {
    fields: [attendanceSessions.academicYearId],
    references: [academicYears.id],
  }),
  section: one(sections, { fields: [attendanceSessions.sectionId], references: [sections.id] }),
  period: one(periods, { fields: [attendanceSessions.periodId], references: [periods.id] }),
  subject: one(subjects, { fields: [attendanceSessions.subjectId], references: [subjects.id] }),
  takenBy: one(employees, {
    fields: [attendanceSessions.takenByEmployeeId],
    references: [employees.id],
  }),
  marks: many(studentAttendance),
}));

export const studentAttendanceRelations = relations(studentAttendance, ({ one, many }) => ({
  session: one(attendanceSessions, {
    fields: [studentAttendance.sessionId],
    references: [attendanceSessions.id],
  }),
  student: one(students, { fields: [studentAttendance.studentId], references: [students.id] }),
  enrollment: one(enrollments, {
    fields: [studentAttendance.enrollmentId],
    references: [enrollments.id],
  }),
  corrections: many(attendanceCorrections),
}));

export const attendanceCorrectionsRelations = relations(attendanceCorrections, ({ one }) => ({
  mark: one(studentAttendance, {
    fields: [attendanceCorrections.studentAttendanceId],
    references: [studentAttendance.id],
  }),
  session: one(attendanceSessions, {
    fields: [attendanceCorrections.sessionId],
    references: [attendanceSessions.id],
  }),
  student: one(students, { fields: [attendanceCorrections.studentId], references: [students.id] }),
}));

export const employeeAttendanceRelations = relations(employeeAttendance, ({ one }) => ({
  employee: one(employees, {
    fields: [employeeAttendance.employeeId],
    references: [employees.id],
  }),
  institution: one(institutions, {
    fields: [employeeAttendance.institutionId],
    references: [institutions.id],
  }),
  campus: one(campuses, { fields: [employeeAttendance.campusId], references: [campuses.id] }),
}));
