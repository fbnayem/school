/**
 * Examinations and results (Phase 8).
 *
 * The shape here is dictated by how Bangladeshi schools actually grade, and every deviation
 * from a naive "marks table" exists for a rule that would otherwise be unrepresentable:
 *
 *  - **`grading_scales` / `grade_bands` are rows, not code.** The NCTB GPA 5.0 scale is the
 *    common case, not the only one: English-medium schools run their own letters, madrasahs
 *    differ again, and a school changing its scale mid-year must not invalidate last term's
 *    results. Bands carry `grade_point` and `is_passing`, so "what is an A-?" and "is a D a
 *    pass?" are answered by data.
 *  - **`exam_subjects` carries the component distribution.** A Bangladeshi subject is
 *    routinely written 70 + MCQ 30, or theory 75 + practical 25, and the board rule is that a
 *    candidate must pass *each* component that defines a pass mark — not merely the total.
 *    Components therefore need their own full and pass marks, per exam, per class level.
 *  - **`exam_marks` is per component**, so that rule is checkable, and it carries its own
 *    workflow status: marks are entered, submitted, then approved by someone else. That
 *    separation is the point; collapsing it into a boolean loses the audit question "who
 *    signed this off?".
 *  - **`results` is a computed snapshot, not a view.** Positions, GPA and grade are frozen at
 *    publication. A view would silently rewrite a published result the moment a mark changed,
 *    and a printed transcript would stop matching the system.
 *
 * GPA arithmetic itself lives in the service, over integer hundredths — never floating point.
 * `subjects.is_fourth_subject` and `subjects.exclude_from_gpa` (Phase 2) are the flags that
 * drive it; this module reads them rather than duplicating them.
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
  smallint,
  text,
  time,
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
import {
  academicGroups,
  academicYears,
  classLevels,
  classSubjects,
  rooms,
  sections,
  subjects,
  terms,
} from './academic';
import { employees } from './people';
import { enrollments, students } from './students';

// ─────────────────────────────────────────────────────────────────────────────────────
// Enumerations
//
// These three live in this file rather than in `_shared.ts` because nothing outside this
// module references them. Each value set is genuinely closed, which is the test `_shared.ts`
// states for choosing an enum over a lookup table: adding an exam workflow state changes the
// separation-of-duties model and must be reviewed as a migration. Exam *type* is the
// borderline case, and it is an enum anyway because the type determines how a result is
// weighted and reported — an unrecognised value would have no defined behaviour.
// ─────────────────────────────────────────────────────────────────────────────────────

export const examTypeEnum = pgEnum('exam_type', [
  'class_test',
  'midterm',
  'half_yearly',
  'annual',
  'model_test',
  'board_practice',
]);

/**
 * The exam lifecycle, and with it the separation of duties.
 *
 * Marks may be entered **only** in `marks_entry`. `under_review` is entered by whoever holds
 * `results.review`, and is the state in which marks are approved; `published` is reachable
 * only from `under_review`, and only by `results.publish`. The states are not decoration —
 * the service refuses every transition that is not in its table.
 */
export const examStatusEnum = pgEnum('exam_status', [
  'draft',
  'scheduled',
  'ongoing',
  'marks_entry',
  'under_review',
  'published',
  'archived',
]);

/** Per-mark workflow: the teacher enters, the teacher submits, someone else approves. */
export const markEntryStatusEnum = pgEnum('mark_entry_status', ['draft', 'submitted', 'approved']);

// ─────────────────────────────────────────────────────────────────────────────────────
// Grading scales
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A named grading scale, e.g. "NCTB GPA 5.0".
 *
 * Institution-scoped rather than tenant-scoped: a group running a Bangla-medium school and an
 * English-medium one grades them differently, and forcing a single scale on both would make
 * one of the two wrong.
 */
export const gradingScales = pgTable(
  'grading_scales',
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
    description: text('description'),
    /**
     * The scale new exams default to. At most one per institution, enforced by a partial
     * unique index rather than by application discipline.
     */
    isDefault: boolean('is_default').notNull().default(false),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('grading_scales_institution_code_key')
      .on(table.institutionId, table.code)
      .where(sql`${table.archivedAt} IS NULL`),
    uniqueIndex('grading_scales_default_key')
      .on(table.institutionId)
      .where(sql`${table.isDefault} AND ${table.archivedAt} IS NULL`),
    index('grading_scales_tenant_idx').on(table.tenantId),
    index('grading_scales_institution_idx').on(table.institutionId),
  ],
);

/**
 * One band of a grading scale: "A+ is 80 and above, 5.00, a pass".
 *
 * **Ranges are half-open — `[min_percentage, max_percentage)` — except the topmost band,
 * which includes 100.** That is what turns "cover 0 to 100 with no overlap" into a checkable
 * property rather than an argument about whether 79.5 is an A or an A-: the bands of a valid
 * scale satisfy `first.min = 0`, `last.max = 100`, and `next.min = previous.max`. Bands are
 * replaced as a set for the same reason terms are — coverage is a property of the whole scale.
 *
 * A deferred constraint trigger (`grade_bands_no_overlap`, migration 0008) rejects an
 * overlapping set at commit, so the invariant survives a caller that bypasses the service.
 */
export const gradeBands = pgTable(
  'grade_bands',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    gradingScaleId: uuid('grading_scale_id')
      .notNull()
      .references(() => gradingScales.id, { onDelete: 'cascade' }),
    /** The letter as it is printed: 'A+', 'A', 'A-', 'B', 'C', 'D', 'F'. */
    grade: varchar('grade', { length: 8 }).notNull(),
    /** The letter in Bangla, where the school prints one. */
    gradeBn: varchar('grade_bn', { length: 16 }),
    /** Inclusive lower bound of the band, as a percentage. */
    minPercentage: numeric('min_percentage', { precision: 5, scale: 2 }).notNull(),
    /** Exclusive upper bound, except on the top band where 100 is included. */
    maxPercentage: numeric('max_percentage', { precision: 5, scale: 2 }).notNull(),
    /** 5.00 for A+ on the NCTB scale. Never a float — the driver hands this over as a string. */
    gradePoint: numeric('grade_point', { precision: 3, scale: 2 }).notNull(),
    /** F is `false`. A scale with no failing band cannot express a failed subject. */
    isPassing: boolean('is_passing').notNull().default(true),
    sortOrder: smallint('sort_order').notNull().default(0),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('grade_bands_scale_grade_key')
      .on(table.gradingScaleId, table.grade)
      .where(sql`${table.archivedAt} IS NULL`),
    index('grade_bands_tenant_idx').on(table.tenantId),
    index('grade_bands_scale_idx').on(table.gradingScaleId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Exams
// ─────────────────────────────────────────────────────────────────────────────────────

export const exams = pgTable(
  'exams',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    /** Null means every campus sits this exam, which is the common case for a half-yearly. */
    campusId: uuid('campus_id').references(() => campuses.id, { onDelete: 'restrict' }),
    academicYearId: uuid('academic_year_id')
      .notNull()
      .references(() => academicYears.id, { onDelete: 'restrict' }),
    /** Null for exams that sit outside the term structure, such as a model test. */
    termId: uuid('term_id').references(() => terms.id, { onDelete: 'restrict' }),
    code: varchar('code', { length: 32 }).notNull(),
    nameEn: varchar('name_en', { length: 128 }).notNull(),
    nameBn: varchar('name_bn', { length: 128 }),
    type: examTypeEnum('type').notNull().default('class_test'),
    gradingScaleId: uuid('grading_scale_id')
      .notNull()
      .references(() => gradingScales.id, { onDelete: 'restrict' }),
    /**
     * How much this exam contributes to the term or annual result, in basis points.
     * 10000 = 100%. Basis points rather than a float, for the same reason money is not a
     * float — see `terms.weight_basis_points`.
     */
    weightageBasisPoints: integer('weightage_basis_points').notNull().default(10_000),
    status: examStatusEnum('status').notNull().default('draft'),
    startDate: date('start_date'),
    endDate: date('end_date'),
    instructions: text('instructions'),
    /** Stamped by `results.publish`, cleared by `results.unpublish`. */
    resultsPublishedAt: timestamp('results_published_at', { withTimezone: true, mode: 'date' }),
    resultsPublishedBy: uuid('results_published_by'),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('exams_institution_code_key')
      .on(table.institutionId, table.code)
      .where(sql`${table.archivedAt} IS NULL`),
    index('exams_tenant_idx').on(table.tenantId),
    index('exams_year_status_idx').on(table.academicYearId, table.status),
    index('exams_institution_idx').on(table.institutionId),
    index('exams_term_idx').on(table.termId),
    index('exams_grading_scale_idx').on(table.gradingScaleId),
    index('exams_campus_idx').on(table.campusId),
  ],
);

/**
 * What a class level sits in an exam, and how it is marked.
 *
 * The component columns are the Bangladeshi part. A subject may define any subset of them; a
 * component with a null full mark is simply not assessed. Where a component *does* define a
 * pass mark, a candidate must reach it — passing on the total alone is not a pass. The
 * service enforces that; this table is where the thresholds live.
 *
 * Configured as a set per exam and class level, because the components must add up to the
 * subject's full marks, which is not checkable one row at a time.
 */
export const examSubjects = pgTable(
  'exam_subjects',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    examId: uuid('exam_id')
      .notNull()
      .references(() => exams.id, { onDelete: 'cascade' }),
    classLevelId: uuid('class_level_id')
      .notNull()
      .references(() => classLevels.id, { onDelete: 'restrict' }),
    subjectId: uuid('subject_id')
      .notNull()
      .references(() => subjects.id, { onDelete: 'restrict' }),
    /** Null means the row applies to every group in the class level. */
    groupId: uuid('group_id').references(() => academicGroups.id, { onDelete: 'restrict' }),
    /** The curriculum row this exam paper assesses, where one exists. */
    classSubjectId: uuid('class_subject_id').references(() => classSubjects.id, {
      onDelete: 'set null',
    }),

    fullMarks: numeric('full_marks', { precision: 6, scale: 2 }).notNull(),
    passMarks: numeric('pass_marks', { precision: 6, scale: 2 }).notNull(),

    /** Written / theory paper. Null when the subject has no written component. */
    writtenFullMarks: numeric('written_full_marks', { precision: 6, scale: 2 }),
    writtenPassMarks: numeric('written_pass_marks', { precision: 6, scale: 2 }),
    /** Multiple choice, near-universal in the Bangladeshi board papers. */
    mcqFullMarks: numeric('mcq_full_marks', { precision: 6, scale: 2 }),
    mcqPassMarks: numeric('mcq_pass_marks', { precision: 6, scale: 2 }),
    practicalFullMarks: numeric('practical_full_marks', { precision: 6, scale: 2 }),
    practicalPassMarks: numeric('practical_pass_marks', { precision: 6, scale: 2 }),
    /** Continuous assessment / classwork, where the school carries one forward. */
    continuousFullMarks: numeric('continuous_full_marks', { precision: 6, scale: 2 }),
    continuousPassMarks: numeric('continuous_pass_marks', { precision: 6, scale: 2 }),

    /** An optional paper does not make a student fail when it is not sat. */
    isOptional: boolean('is_optional').notNull().default(false),
    sortOrder: smallint('sort_order').notNull().default(0),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('exam_subjects_unique_key')
      .on(table.examId, table.classLevelId, table.subjectId, table.groupId)
      .where(sql`${table.groupId} IS NOT NULL AND ${table.archivedAt} IS NULL`),
    uniqueIndex('exam_subjects_unique_nogroup_key')
      .on(table.examId, table.classLevelId, table.subjectId)
      .where(sql`${table.groupId} IS NULL AND ${table.archivedAt} IS NULL`),
    index('exam_subjects_tenant_idx').on(table.tenantId),
    index('exam_subjects_exam_class_idx').on(table.examId, table.classLevelId),
    index('exam_subjects_subject_idx').on(table.subjectId),
    index('exam_subjects_class_subject_idx').on(table.classSubjectId),
  ],
);

/**
 * When and where a paper is sat, and who invigilates it.
 *
 * Room and invigilator are nullable because a schedule is usually drafted before either is
 * decided, and forcing a placeholder produces a timetable full of fictional rooms. Both are
 * clash-checked on write: one room, one exam; one invigilator, one hall.
 */
export const examSchedules = pgTable(
  'exam_schedules',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    examSubjectId: uuid('exam_subject_id')
      .notNull()
      .references(() => examSubjects.id, { onDelete: 'cascade' }),
    /** Null means the whole class level sits the paper together. */
    sectionId: uuid('section_id').references(() => sections.id, { onDelete: 'restrict' }),
    roomId: uuid('room_id').references(() => rooms.id, { onDelete: 'restrict' }),
    invigilatorEmployeeId: uuid('invigilator_employee_id').references(() => employees.id, {
      onDelete: 'restrict',
    }),
    examDate: date('exam_date').notNull(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    notes: varchar('notes', { length: 500 }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('exam_schedules_subject_section_key')
      .on(table.examSubjectId, table.sectionId)
      .where(sql`${table.sectionId} IS NOT NULL AND ${table.archivedAt} IS NULL`),
    uniqueIndex('exam_schedules_subject_key')
      .on(table.examSubjectId)
      .where(sql`${table.sectionId} IS NULL AND ${table.archivedAt} IS NULL`),
    index('exam_schedules_tenant_idx').on(table.tenantId),
    index('exam_schedules_exam_subject_idx').on(table.examSubjectId),
    index('exam_schedules_room_idx').on(table.roomId, table.examDate),
    index('exam_schedules_invigilator_idx').on(table.invigilatorEmployeeId, table.examDate),
    index('exam_schedules_section_idx').on(table.sectionId),
  ],
);

/**
 * One student's marks for one exam paper.
 *
 * Components are stored separately rather than pre-summed, because the pass rule needs them
 * individually and because correcting an MCQ score should not require re-deriving the written
 * one. `obtained_marks` is the stored sum, recomputed on every write, so tabulation and
 * ranking do not have to add four nullable columns in SQL.
 *
 * `is_absent` is not "zero". A zero is a mark a student earned; an absence is the absence of
 * one, and the two produce different marksheets even though both fail the paper. A check
 * constraint in migration 0008 refuses an absent row that also carries marks.
 */
export const examMarks = pgTable(
  'exam_marks',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    /** Denormalised from `exam_subjects` so an exam-wide read is one index scan. */
    examId: uuid('exam_id')
      .notNull()
      .references(() => exams.id, { onDelete: 'restrict' }),
    examSubjectId: uuid('exam_subject_id')
      .notNull()
      .references(() => examSubjects.id, { onDelete: 'restrict' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'restrict' }),
    /** The placement the mark was earned under; a later transfer must not rewrite history. */
    enrollmentId: uuid('enrollment_id').references(() => enrollments.id, { onDelete: 'restrict' }),
    sectionId: uuid('section_id')
      .notNull()
      .references(() => sections.id, { onDelete: 'restrict' }),

    writtenMarks: numeric('written_marks', { precision: 6, scale: 2 }),
    mcqMarks: numeric('mcq_marks', { precision: 6, scale: 2 }),
    practicalMarks: numeric('practical_marks', { precision: 6, scale: 2 }),
    continuousMarks: numeric('continuous_marks', { precision: 6, scale: 2 }),
    /** The sum of whichever components are present. Null only for an absent candidate. */
    obtainedMarks: numeric('obtained_marks', { precision: 6, scale: 2 }),

    isAbsent: boolean('is_absent').notNull().default(false),
    status: markEntryStatusEnum('status').notNull().default('draft'),
    remarks: varchar('remarks', { length: 500 }),

    enteredBy: uuid('entered_by'),
    enteredAt: timestamp('entered_at', { withTimezone: true, mode: 'date' }),
    submittedBy: uuid('submitted_by'),
    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' }),
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'date' }),
    approvedBy: uuid('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true, mode: 'date' }),
    /** Incremented by every correction after approval; each one is separately audited. */
    correctionCount: smallint('correction_count').notNull().default(0),

    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('exam_marks_subject_student_key')
      .on(table.examSubjectId, table.studentId)
      .where(sql`${table.archivedAt} IS NULL`),
    index('exam_marks_tenant_idx').on(table.tenantId),
    index('exam_marks_exam_status_idx').on(table.examId, table.status),
    index('exam_marks_exam_student_idx').on(table.examId, table.studentId),
    index('exam_marks_exam_subject_idx').on(table.examSubjectId, table.sectionId),
    index('exam_marks_student_idx').on(table.studentId),
    index('exam_marks_section_idx').on(table.sectionId),
    index('exam_marks_enrollment_idx').on(table.enrollmentId),
  ],
);

/**
 * A computed result for one student in one exam.
 *
 * Frozen rather than derived. `gpa`, `grade` and both positions are the numbers that were true
 * when the result was computed, and `subject_breakdown` carries the per-subject snapshot the
 * marksheet is printed from — so a later correction produces a *new*, audited computation
 * rather than silently rewriting a transcript a parent already received.
 */
export const results = pgTable(
  'results',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    examId: uuid('exam_id')
      .notNull()
      .references(() => exams.id, { onDelete: 'restrict' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'restrict' }),
    enrollmentId: uuid('enrollment_id').references(() => enrollments.id, { onDelete: 'restrict' }),
    academicYearId: uuid('academic_year_id')
      .notNull()
      .references(() => academicYears.id, { onDelete: 'restrict' }),
    classLevelId: uuid('class_level_id')
      .notNull()
      .references(() => classLevels.id, { onDelete: 'restrict' }),
    sectionId: uuid('section_id')
      .notNull()
      .references(() => sections.id, { onDelete: 'restrict' }),

    totalMarks: numeric('total_marks', { precision: 8, scale: 2 }).notNull().default('0.00'),
    obtainedMarks: numeric('obtained_marks', { precision: 8, scale: 2 }).notNull().default('0.00'),
    percentage: numeric('percentage', { precision: 5, scale: 2 }).notNull().default('0.00'),
    /** 0.00 whenever a compulsory subject was failed, whatever the average would have been. */
    gpa: numeric('gpa', { precision: 3, scale: 2 }).notNull().default('0.00'),
    grade: varchar('grade', { length: 8 }).notNull().default('F'),
    /** Subjects that counted towards the GPA divisor — the fourth subject is not one of them. */
    gpaSubjectCount: smallint('gpa_subject_count').notNull().default(0),
    failedSubjectCount: smallint('failed_subject_count').notNull().default(0),
    isPassed: boolean('is_passed').notNull().default(false),

    /** `rank()` within the section and the class level: ties share a position. */
    positionInSection: integer('position_in_section'),
    positionInClass: integer('position_in_class'),

    /** Per-subject marks, grade and grade point, as they stood when this was computed. */
    subjectBreakdown: jsonb('subject_breakdown')
      .notNull()
      .default(sql`'[]'::jsonb`),

    computedAt: timestamp('computed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    /** Null until published. Students and guardians may only ever read a non-null one. */
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
    publishedBy: uuid('published_by'),

    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('results_exam_student_key')
      .on(table.examId, table.studentId)
      .where(sql`${table.archivedAt} IS NULL`),
    index('results_tenant_idx').on(table.tenantId),
    index('results_exam_section_idx').on(table.examId, table.sectionId),
    index('results_exam_class_idx').on(table.examId, table.classLevelId),
    index('results_student_idx').on(table.studentId),
    index('results_published_idx').on(table.examId, table.publishedAt),
    index('results_enrollment_idx').on(table.enrollmentId),
    index('results_year_idx').on(table.academicYearId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────

export const gradingScalesRelations = relations(gradingScales, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [gradingScales.institutionId],
    references: [institutions.id],
  }),
  bands: many(gradeBands),
  exams: many(exams),
}));

export const gradeBandsRelations = relations(gradeBands, ({ one }) => ({
  gradingScale: one(gradingScales, {
    fields: [gradeBands.gradingScaleId],
    references: [gradingScales.id],
  }),
}));

export const examsRelations = relations(exams, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [exams.institutionId],
    references: [institutions.id],
  }),
  academicYear: one(academicYears, {
    fields: [exams.academicYearId],
    references: [academicYears.id],
  }),
  term: one(terms, { fields: [exams.termId], references: [terms.id] }),
  gradingScale: one(gradingScales, {
    fields: [exams.gradingScaleId],
    references: [gradingScales.id],
  }),
  examSubjects: many(examSubjects),
  results: many(results),
}));

export const examSubjectsRelations = relations(examSubjects, ({ one, many }) => ({
  exam: one(exams, { fields: [examSubjects.examId], references: [exams.id] }),
  subject: one(subjects, { fields: [examSubjects.subjectId], references: [subjects.id] }),
  classLevel: one(classLevels, {
    fields: [examSubjects.classLevelId],
    references: [classLevels.id],
  }),
  schedules: many(examSchedules),
  marks: many(examMarks),
}));

export const examSchedulesRelations = relations(examSchedules, ({ one }) => ({
  examSubject: one(examSubjects, {
    fields: [examSchedules.examSubjectId],
    references: [examSubjects.id],
  }),
  section: one(sections, { fields: [examSchedules.sectionId], references: [sections.id] }),
  room: one(rooms, { fields: [examSchedules.roomId], references: [rooms.id] }),
  invigilator: one(employees, {
    fields: [examSchedules.invigilatorEmployeeId],
    references: [employees.id],
  }),
}));

export const examMarksRelations = relations(examMarks, ({ one }) => ({
  exam: one(exams, { fields: [examMarks.examId], references: [exams.id] }),
  examSubject: one(examSubjects, {
    fields: [examMarks.examSubjectId],
    references: [examSubjects.id],
  }),
  student: one(students, { fields: [examMarks.studentId], references: [students.id] }),
  section: one(sections, { fields: [examMarks.sectionId], references: [sections.id] }),
}));

export const resultsRelations = relations(results, ({ one }) => ({
  exam: one(exams, { fields: [results.examId], references: [exams.id] }),
  student: one(students, { fields: [results.studentId], references: [students.id] }),
  section: one(sections, { fields: [results.sectionId], references: [sections.id] }),
  classLevel: one(classLevels, {
    fields: [results.classLevelId],
    references: [classLevels.id],
  }),
}));
