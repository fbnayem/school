/**
 * Learning Management System (Phase 10).
 *
 * The shape follows the homework module's split between *content* and *responses to it*:
 *
 *  - `courses` is the container a teacher builds for one class level + subject in one
 *    academic year. Draft content is the owner's desk drawer; students see a course only
 *    once it is published, and then only the published modules and lessons inside it.
 *  - `course_modules` and `lessons` are the ordered structure. Sequencing is written as a
 *    set (the timetable module's discipline), so two lessons can never silently claim the
 *    same position among live rows.
 *  - `lesson_resources` carries a file (object storage, behind `StorageService` and the
 *    central `files` authorization row) **or** a link — exactly one, and the database says
 *    so, not just the service.
 *  - `quizzes` → `quiz_questions` → `quiz_options` describe the assessment;
 *    `quiz_attempts` → `quiz_answers` describe one student's sitting of it. A submitted
 *    attempt is immutable; re-grading a short-text answer changes `marks_awarded` with a
 *    reason and an in-transaction audit record, never the answer itself.
 *  - `quiz_options.is_correct` is the answer key. It must never reach a student; every
 *    student-facing service path strips it the way HR strips salary fields.
 *
 * Marks are `numeric(6,2)` — exact, arriving from the driver as strings, never floats.
 * Nothing here is ever hard-deleted (ADR-008): removing content is a soft archive.
 */

import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
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
import { academicYears, classLevels, subjects } from './academic';
import { employees } from './people';
import { students } from './students';
import { files } from './files';

// ─────────────────────────────────────────────────────────────────────────────────────
// Enumerations. Closed value sets: a new lifecycle state or question kind changes the
// grading and visibility code, which is a migration (see the rule in `_shared.ts`).
// Prefixed `lms_` so they can never collide with another module's types.
// ─────────────────────────────────────────────────────────────────────────────────────

export const lmsCourseStatusEnum = pgEnum('lms_course_status', ['draft', 'published', 'archived']);

export const lmsResourceKindEnum = pgEnum('lms_resource_kind', ['file', 'link', 'video']);

export const lmsProgressStatusEnum = pgEnum('lms_progress_status', [
  'not_started',
  'in_progress',
  'completed',
]);

export const lmsQuizStatusEnum = pgEnum('lms_quiz_status', ['draft', 'published', 'archived']);

export const lmsQuestionKindEnum = pgEnum('lms_question_kind', [
  'mcq_single',
  'mcq_multi',
  'true_false',
  'short_text',
]);

// ─────────────────────────────────────────────────────────────────────────────────────
// Courses
// ─────────────────────────────────────────────────────────────────────────────────────

export const courses = pgTable(
  'courses',
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
    classLevelId: uuid('class_level_id')
      .notNull()
      .references(() => classLevels.id, { onDelete: 'restrict' }),
    subjectId: uuid('subject_id')
      .notNull()
      .references(() => subjects.id, { onDelete: 'restrict' }),
    /**
     * The teacher who owns the course. Nullable because an administrator whose account has
     * no employee record may create on a teacher's behalf; the acting *user* is always in
     * `created_by`. Drafts are visible only to this employee and to `all`-scope staff.
     */
    ownerEmployeeId: uuid('owner_employee_id').references(() => employees.id, {
      onDelete: 'restrict',
    }),

    title: varchar('title', { length: 255 }).notNull(),
    titleBn: varchar('title_bn', { length: 255 }),
    description: text('description'),

    status: lmsCourseStatusEnum('status').notNull().default('draft'),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),

    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('courses_tenant_idx').on(table.tenantId),
    index('courses_institution_status_idx').on(table.institutionId, table.status),
    index('courses_year_class_idx').on(table.academicYearId, table.classLevelId),
    index('courses_subject_idx').on(table.subjectId),
    index('courses_owner_idx').on(table.ownerEmployeeId),
  ],
);

/**
 * A student's membership of a course — the cohort the completion report and gradebook are
 * computed over, and the gate on quiz attempts. Unique per (course, student) among live rows.
 */
export const courseEnrolments = pgTable(
  'course_enrolments',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'restrict' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'restrict' }),

    /** Stamped by the server clock at insert. Never client-supplied. */
    enrolledAt: timestamp('enrolled_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),

    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('course_enrolments_course_student_key')
      .on(table.courseId, table.studentId)
      .where(sql`${table.archivedAt} IS NULL`),
    index('course_enrolments_tenant_idx').on(table.tenantId),
    index('course_enrolments_student_idx').on(table.studentId),
    index('course_enrolments_course_idx').on(table.courseId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Modules and lessons
// ─────────────────────────────────────────────────────────────────────────────────────

export const courseModules = pgTable(
  'course_modules',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'restrict' }),

    title: varchar('title', { length: 255 }).notNull(),
    /** Position within the course, 1-based. Written as a set, never edited one row at a time. */
    sequence: smallint('sequence').notNull(),
    isPublished: boolean('is_published').notNull().default(false),

    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('course_modules_course_sequence_key')
      .on(table.courseId, table.sequence)
      .where(sql`${table.archivedAt} IS NULL`),
    index('course_modules_tenant_idx').on(table.tenantId),
    index('course_modules_course_idx').on(table.courseId),
  ],
);

export const lessons = pgTable(
  'lessons',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    moduleId: uuid('module_id')
      .notNull()
      .references(() => courseModules.id, { onDelete: 'restrict' }),

    title: varchar('title', { length: 255 }).notNull(),
    /** Rich text stored as text; the client renders it. Never interpreted server-side. */
    content: text('content'),
    sequence: smallint('sequence').notNull(),
    estimatedMinutes: smallint('estimated_minutes'),
    isPublished: boolean('is_published').notNull().default(false),

    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('lessons_module_sequence_key')
      .on(table.moduleId, table.sequence)
      .where(sql`${table.archivedAt} IS NULL`),
    index('lessons_tenant_idx').on(table.tenantId),
    index('lessons_module_idx').on(table.moduleId),
  ],
);

/**
 * A file, link or video attached to a lesson. Exactly one of `storage_key` / `url` is set —
 * a CHECK constraint, so a hand-written SQL fix cannot produce a resource that is both or
 * neither. File bytes live behind `StorageService`; `file_id` points at the central `files`
 * row that authorises signed-URL redemption.
 */
export const lessonResources = pgTable(
  'lesson_resources',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    lessonId: uuid('lesson_id')
      .notNull()
      .references(() => lessons.id, { onDelete: 'restrict' }),

    kind: lmsResourceKindEnum('kind').notNull(),
    /** Set for `kind = 'file'`; the central authorization record for the bytes. */
    fileId: uuid('file_id').references(() => files.id, { onDelete: 'restrict' }),
    /** `tenants/{tenantId}/lms_resource/{uuid}.{ext}` — built by StorageService, never by hand. */
    storageKey: varchar('storage_key', { length: 512 }),
    url: varchar('url', { length: 2048 }),
    title: varchar('title', { length: 255 }).notNull(),
    mimeType: varchar('mime_type', { length: 128 }),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),

    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('lesson_resources_tenant_idx').on(table.tenantId),
    index('lesson_resources_lesson_idx').on(table.lessonId),
  ],
);

/**
 * One student's progress through one lesson. Unique per (lesson, student) among live rows;
 * `seconds_spent` accumulates and `completed_at` is stamped by the server clock.
 */
export const lessonProgress = pgTable(
  'lesson_progress',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    lessonId: uuid('lesson_id')
      .notNull()
      .references(() => lessons.id, { onDelete: 'restrict' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'restrict' }),

    status: lmsProgressStatusEnum('status').notNull().default('not_started'),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    secondsSpent: integer('seconds_spent').notNull().default(0),

    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('lesson_progress_lesson_student_key')
      .on(table.lessonId, table.studentId)
      .where(sql`${table.archivedAt} IS NULL`),
    index('lesson_progress_tenant_idx').on(table.tenantId),
    index('lesson_progress_student_idx').on(table.studentId),
    index('lesson_progress_lesson_idx').on(table.lessonId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Quizzes
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * An assessment anchored on exactly one of a course or a lesson (a CHECK constraint).
 * `total_marks` must equal the sum of its questions' marks at publish time — the service
 * verifies in exact hundredths before the status changes.
 */
export const quizzes = pgTable(
  'quizzes',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    courseId: uuid('course_id').references(() => courses.id, { onDelete: 'restrict' }),
    lessonId: uuid('lesson_id').references(() => lessons.id, { onDelete: 'restrict' }),

    title: varchar('title', { length: 255 }).notNull(),
    totalMarks: numeric('total_marks', { precision: 6, scale: 2 }).notNull(),
    passMarks: numeric('pass_marks', { precision: 6, scale: 2 }).notNull(),
    /** Null means untimed. Enforced against the SERVER clock from `started_at`, never client input. */
    timeLimitMinutes: smallint('time_limit_minutes'),
    attemptsAllowed: smallint('attempts_allowed').notNull().default(1),
    shuffleQuestions: boolean('shuffle_questions').notNull().default(false),

    status: lmsQuizStatusEnum('status').notNull().default('draft'),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),

    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('quizzes_tenant_idx').on(table.tenantId),
    index('quizzes_institution_status_idx').on(table.institutionId, table.status),
    index('quizzes_course_idx').on(table.courseId),
    index('quizzes_lesson_idx').on(table.lessonId),
  ],
);

export const quizQuestions = pgTable(
  'quiz_questions',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    quizId: uuid('quiz_id')
      .notNull()
      .references(() => quizzes.id, { onDelete: 'restrict' }),

    sequence: smallint('sequence').notNull(),
    kind: lmsQuestionKindEnum('kind').notNull(),
    prompt: text('prompt').notNull(),
    marks: numeric('marks', { precision: 6, scale: 2 }).notNull(),
    /** mcq_multi only: proportional credit instead of all-or-nothing. */
    allowPartialCredit: boolean('allow_partial_credit').notNull().default(false),

    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('quiz_questions_quiz_sequence_key')
      .on(table.quizId, table.sequence)
      .where(sql`${table.archivedAt} IS NULL`),
    index('quiz_questions_tenant_idx').on(table.tenantId),
    index('quiz_questions_quiz_idx').on(table.quizId),
  ],
);

/**
 * One choice of one question. `is_correct` is the answer key: it must NEVER appear in a
 * student-facing response. Every student path in the service maps options through an
 * explicit projection that omits it (the HR salary-redaction discipline).
 */
export const quizOptions = pgTable(
  'quiz_options',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    questionId: uuid('question_id')
      .notNull()
      .references(() => quizQuestions.id, { onDelete: 'restrict' }),

    sequence: smallint('sequence').notNull(),
    text: text('text').notNull(),
    isCorrect: boolean('is_correct').notNull().default(false),

    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('quiz_options_question_sequence_key')
      .on(table.questionId, table.sequence)
      .where(sql`${table.archivedAt} IS NULL`),
    index('quiz_options_tenant_idx').on(table.tenantId),
    index('quiz_options_question_idx').on(table.questionId),
  ],
);

/**
 * One sitting of one quiz by one student. `started_at` is stamped by the server at start
 * and is the sole anchor for the time limit; `submitted_at` set means the attempt is
 * immutable — only `marks_awarded` on its short-text answers can still change, via the
 * audited manual-grading path.
 */
export const quizAttempts = pgTable(
  'quiz_attempts',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    quizId: uuid('quiz_id')
      .notNull()
      .references(() => quizzes.id, { onDelete: 'restrict' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'restrict' }),

    attemptNumber: smallint('attempt_number').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' }),
    /** Set only once every question carries a mark; a fresh SQL sum, never an increment. */
    score: numeric('score', { precision: 6, scale: 2 }),
    isGraded: boolean('is_graded').notNull().default(false),

    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('quiz_attempts_attempt_key')
      .on(table.quizId, table.studentId, table.attemptNumber)
      .where(sql`${table.archivedAt} IS NULL`),
    index('quiz_attempts_tenant_idx').on(table.tenantId),
    index('quiz_attempts_quiz_student_idx').on(table.quizId, table.studentId),
    index('quiz_attempts_student_idx').on(table.studentId),
  ],
);

export const quizAnswers = pgTable(
  'quiz_answers',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    attemptId: uuid('attempt_id')
      .notNull()
      .references(() => quizAttempts.id, { onDelete: 'restrict' }),
    questionId: uuid('question_id')
      .notNull()
      .references(() => quizQuestions.id, { onDelete: 'restrict' }),

    selectedOptionIds: jsonb('selected_option_ids')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    textAnswer: text('text_answer'),
    /** Null while a short-text answer waits for manual grading. */
    marksAwarded: numeric('marks_awarded', { precision: 6, scale: 2 }),
    /** The employee who graded by hand. Null for auto-graded answers. */
    gradedBy: uuid('graded_by').references(() => employees.id, { onDelete: 'restrict' }),
    gradedAt: timestamp('graded_at', { withTimezone: true, mode: 'date' }),

    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('quiz_answers_attempt_question_key')
      .on(table.attemptId, table.questionId)
      .where(sql`${table.archivedAt} IS NULL`),
    index('quiz_answers_tenant_idx').on(table.tenantId),
    index('quiz_answers_attempt_idx').on(table.attemptId),
    index('quiz_answers_question_idx').on(table.questionId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Relations
// ─────────────────────────────────────────────────────────────────────────────────────

export const coursesRelations = relations(courses, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [courses.institutionId],
    references: [institutions.id],
  }),
  campus: one(campuses, { fields: [courses.campusId], references: [campuses.id] }),
  academicYear: one(academicYears, {
    fields: [courses.academicYearId],
    references: [academicYears.id],
  }),
  classLevel: one(classLevels, {
    fields: [courses.classLevelId],
    references: [classLevels.id],
  }),
  subject: one(subjects, { fields: [courses.subjectId], references: [subjects.id] }),
  owner: one(employees, { fields: [courses.ownerEmployeeId], references: [employees.id] }),
  modules: many(courseModules),
  enrolments: many(courseEnrolments),
  quizzes: many(quizzes),
}));

export const courseEnrolmentsRelations = relations(courseEnrolments, ({ one }) => ({
  course: one(courses, { fields: [courseEnrolments.courseId], references: [courses.id] }),
  student: one(students, { fields: [courseEnrolments.studentId], references: [students.id] }),
}));

export const courseModulesRelations = relations(courseModules, ({ one, many }) => ({
  course: one(courses, { fields: [courseModules.courseId], references: [courses.id] }),
  lessons: many(lessons),
}));

export const lessonsRelations = relations(lessons, ({ one, many }) => ({
  module: one(courseModules, { fields: [lessons.moduleId], references: [courseModules.id] }),
  resources: many(lessonResources),
  progress: many(lessonProgress),
}));

export const lessonResourcesRelations = relations(lessonResources, ({ one }) => ({
  lesson: one(lessons, { fields: [lessonResources.lessonId], references: [lessons.id] }),
  file: one(files, { fields: [lessonResources.fileId], references: [files.id] }),
}));

export const lessonProgressRelations = relations(lessonProgress, ({ one }) => ({
  lesson: one(lessons, { fields: [lessonProgress.lessonId], references: [lessons.id] }),
  student: one(students, { fields: [lessonProgress.studentId], references: [students.id] }),
}));

export const quizzesRelations = relations(quizzes, ({ one, many }) => ({
  course: one(courses, { fields: [quizzes.courseId], references: [courses.id] }),
  lesson: one(lessons, { fields: [quizzes.lessonId], references: [lessons.id] }),
  questions: many(quizQuestions),
  attempts: many(quizAttempts),
}));

export const quizQuestionsRelations = relations(quizQuestions, ({ one, many }) => ({
  quiz: one(quizzes, { fields: [quizQuestions.quizId], references: [quizzes.id] }),
  options: many(quizOptions),
  answers: many(quizAnswers),
}));

export const quizOptionsRelations = relations(quizOptions, ({ one }) => ({
  question: one(quizQuestions, {
    fields: [quizOptions.questionId],
    references: [quizQuestions.id],
  }),
}));

export const quizAttemptsRelations = relations(quizAttempts, ({ one, many }) => ({
  quiz: one(quizzes, { fields: [quizAttempts.quizId], references: [quizzes.id] }),
  student: one(students, { fields: [quizAttempts.studentId], references: [students.id] }),
  answers: many(quizAnswers),
}));

export const quizAnswersRelations = relations(quizAnswers, ({ one }) => ({
  attempt: one(quizAttempts, {
    fields: [quizAnswers.attemptId],
    references: [quizAttempts.id],
  }),
  question: one(quizQuestions, {
    fields: [quizAnswers.questionId],
    references: [quizQuestions.id],
  }),
  grader: one(employees, { fields: [quizAnswers.gradedBy], references: [employees.id] }),
}));
