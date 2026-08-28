/**
 * Academic structure (Phase 2).
 *
 * Everything here is configuration, not code. The brief is explicit that one Bangladesh
 * curriculum structure must not be hard-coded, and the shape below is what makes that true:
 *
 *  - `class_levels` are rows, so "Class 6" and "Play Group" and "HSC 1st Year" are all just
 *    data with an ordinal.
 *  - `terms` are rows with dates and weights, so a school running three terms and one running
 *    two semesters use the same tables.
 *  - `subjects` carry a `kind` (compulsory / optional / additional / co-curricular) because
 *    the fourth-subject rule in the Bangladeshi system materially changes GPA calculation.
 *  - `class_subjects` is the curriculum: which subjects a class studies, with how many
 *    periods and what marks distribution. Two institutions in one tenant can differ freely.
 */

import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  time,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  academicYearStatusEnum,
  actorColumns,
  archiveColumns,
  primaryKeyColumn,
  shiftKindEnum,
  timestampColumns,
  versionColumn,
} from './_shared';
import { campuses, institutions, organizations } from './tenancy';

export const academicYears = pgTable(
  'academic_years',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    /** Display name: "2026" for most Bangladeshi schools, "2026-27" where sessions straddle. */
    name: varchar('name', { length: 32 }).notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    status: academicYearStatusEnum('status').notNull().default('planning'),
    /**
     * The year new enrolments and daily operations default to. Exactly one per institution,
     * enforced by a partial unique index rather than by application discipline.
     */
    isCurrent: boolean('is_current').notNull().default(false),
    /**
     * Non-teaching days as ISO weekday numbers (0 = Sunday). Defaults to Friday+Saturday but
     * is configuration — English-medium schools and coaching centres differ.
     */
    weekendDays: jsonb('weekend_days')
      .notNull()
      .default(sql`'[5, 6]'::jsonb`),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('academic_years_institution_name_key')
      .on(table.institutionId, table.name)
      .where(sql`${table.archivedAt} IS NULL`),
    uniqueIndex('academic_years_current_key')
      .on(table.institutionId)
      .where(sql`${table.isCurrent} AND ${table.archivedAt} IS NULL`),
    index('academic_years_tenant_idx').on(table.tenantId),
    index('academic_years_institution_idx').on(table.institutionId),
  ],
);

/**
 * A term, semester or marking period.
 *
 * `weightBasisPoints` is how much this term contributes to the final annual result —
 * 3333/3333/3334 for equal thirds, or 4000/6000 for a school that weights the final term more
 * heavily. Basis points rather than a float, for the same reason money is not a float.
 */
export const terms = pgTable(
  'terms',
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
      .references(() => academicYears.id, { onDelete: 'restrict' }),
    nameEn: varchar('name_en', { length: 64 }).notNull(),
    nameBn: varchar('name_bn', { length: 64 }),
    sequence: smallint('sequence').notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    weightBasisPoints: integer('weight_basis_points').notNull().default(0),
    /** Blocks mark entry once the term is closed; reopening is an audited action. */
    isClosed: boolean('is_closed').notNull().default(false),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('terms_year_sequence_key')
      .on(table.academicYearId, table.sequence)
      .where(sql`${table.archivedAt} IS NULL`),
    index('terms_tenant_idx').on(table.tenantId),
    index('terms_year_idx').on(table.academicYearId),
  ],
);

/** Morning/day shifts, near-universal in Bangladeshi schools operating at capacity. */
export const shifts = pgTable(
  'shifts',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    campusId: uuid('campus_id').references(() => campuses.id, { onDelete: 'restrict' }),
    kind: shiftKindEnum('kind').notNull().default('single'),
    nameEn: varchar('name_en', { length: 64 }).notNull(),
    nameBn: varchar('name_bn', { length: 64 }),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    sortOrder: smallint('sort_order').notNull().default(0),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('shifts_institution_name_key')
      .on(table.institutionId, table.nameEn)
      .where(sql`${table.archivedAt} IS NULL`),
    index('shifts_tenant_idx').on(table.tenantId),
  ],
);

/**
 * A grade level: "Play", "Class 1" … "Class 10", "HSC 1st Year".
 *
 * `ordinal` drives promotion (a student in ordinal 6 promotes to ordinal 7) and sorting.
 * It is separate from the display name so a school can call ordinal 11 "First Year" without
 * breaking promotion logic.
 */
export const classLevels = pgTable(
  'class_levels',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    code: varchar('code', { length: 16 }).notNull(),
    nameEn: varchar('name_en', { length: 64 }).notNull(),
    nameBn: varchar('name_bn', { length: 64 }),
    ordinal: smallint('ordinal').notNull(),
    /**
     * From Class 9 onward Bangladeshi students choose Science / Commerce / Humanities, which
     * changes their subject set. Null for classes with no streams.
     */
    hasGroups: boolean('has_groups').notNull().default(false),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('class_levels_institution_code_key')
      .on(table.institutionId, table.code)
      .where(sql`${table.archivedAt} IS NULL`),
    uniqueIndex('class_levels_institution_ordinal_key')
      .on(table.institutionId, table.ordinal)
      .where(sql`${table.archivedAt} IS NULL`),
    index('class_levels_tenant_idx').on(table.tenantId),
  ],
);

/** Science / Commerce / Humanities, or a school's own streams. */
export const academicGroups = pgTable(
  'academic_groups',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    code: varchar('code', { length: 16 }).notNull(),
    nameEn: varchar('name_en', { length: 64 }).notNull(),
    nameBn: varchar('name_bn', { length: 64 }),
    sortOrder: smallint('sort_order').notNull().default(0),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('academic_groups_institution_code_key')
      .on(table.institutionId, table.code)
      .where(sql`${table.archivedAt} IS NULL`),
    index('academic_groups_tenant_idx').on(table.tenantId),
  ],
);

/**
 * A section — the actual group of students who sit together.
 *
 * This is the unit attendance is taken for, timetables are built against, and class teachers
 * are assigned to. It is scoped to an academic year because "Class 6 Section A" in 2026 is a
 * different set of students from the same label in 2027.
 */
export const sections = pgTable(
  'sections',
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
    shiftId: uuid('shift_id').references(() => shifts.id, { onDelete: 'restrict' }),
    groupId: uuid('group_id').references(() => academicGroups.id, { onDelete: 'restrict' }),
    nameEn: varchar('name_en', { length: 64 }).notNull(),
    nameBn: varchar('name_bn', { length: 64 }),
    /** Enforced on enrolment; a section at capacity rejects new students with a clear error. */
    capacity: smallint('capacity'),
    roomId: uuid('room_id'),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('sections_unique_key')
      .on(table.academicYearId, table.classLevelId, table.shiftId, table.nameEn)
      .where(sql`${table.archivedAt} IS NULL AND ${table.shiftId} IS NOT NULL`),
    uniqueIndex('sections_unique_no_shift_key')
      .on(table.academicYearId, table.classLevelId, table.nameEn)
      .where(sql`${table.archivedAt} IS NULL AND ${table.shiftId} IS NULL`),
    index('sections_tenant_idx').on(table.tenantId),
    index('sections_year_class_idx').on(table.academicYearId, table.classLevelId),
    index('sections_campus_idx').on(table.campusId),
  ],
);

export const subjects = pgTable(
  'subjects',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    /** The board's subject code where one exists (e.g. 101 for Bangla 1st Paper). */
    code: varchar('code', { length: 16 }).notNull(),
    nameEn: varchar('name_en', { length: 128 }).notNull(),
    nameBn: varchar('name_bn', { length: 128 }),
    shortName: varchar('short_name', { length: 16 }),
    /** 'compulsory' | 'optional' | 'additional' | 'co_curricular' */
    kind: varchar('kind', { length: 16 }).notNull().default('compulsory'),
    /**
     * The Bangladeshi "4th subject": its marks above the pass threshold are added to the GPA
     * and it cannot cause a fail. Flagged here because it changes GPA arithmetic, not display.
     */
    isFourthSubject: boolean('is_fourth_subject').notNull().default(false),
    /** Excluded from GPA entirely — religion in some configurations, PE, arts. */
    excludeFromGpa: boolean('exclude_from_gpa').notNull().default(false),
    hasPractical: boolean('has_practical').notNull().default(false),
    sortOrder: smallint('sort_order').notNull().default(0),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('subjects_institution_code_key')
      .on(table.institutionId, table.code)
      .where(sql`${table.archivedAt} IS NULL`),
    index('subjects_tenant_idx').on(table.tenantId),
  ],
);

/**
 * The curriculum: which subjects a class level studies in a given year, and how they are
 * assessed. This is the join that lets two institutions in one tenant run different curricula.
 */
export const classSubjects = pgTable(
  'class_subjects',
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
    classLevelId: uuid('class_level_id')
      .notNull()
      .references(() => classLevels.id, { onDelete: 'cascade' }),
    subjectId: uuid('subject_id')
      .notNull()
      .references(() => subjects.id, { onDelete: 'restrict' }),
    /** Null means the subject applies to every group in the class level. */
    groupId: uuid('group_id').references(() => academicGroups.id, { onDelete: 'cascade' }),
    /** Drives timetable generation. */
    periodsPerWeek: smallint('periods_per_week').notNull().default(0),
    fullMarks: smallint('full_marks').notNull().default(100),
    passMarks: smallint('pass_marks').notNull().default(33),
    /**
     * Component breakdown, e.g. `{"theory": 70, "mcq": 25, "practical": 25}`. Validated in the
     * application to sum to `fullMarks`; kept as JSON because component sets vary by subject.
     */
    markDistribution: jsonb('mark_distribution')
      .notNull()
      .default(sql`'{}'::jsonb`),
    isOptional: boolean('is_optional').notNull().default(false),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('class_subjects_unique_key')
      .on(table.academicYearId, table.classLevelId, table.subjectId, table.groupId)
      .where(sql`${table.groupId} IS NOT NULL AND ${table.archivedAt} IS NULL`),
    uniqueIndex('class_subjects_unique_nogroup_key')
      .on(table.academicYearId, table.classLevelId, table.subjectId)
      .where(sql`${table.groupId} IS NULL AND ${table.archivedAt} IS NULL`),
    index('class_subjects_tenant_idx').on(table.tenantId),
    index('class_subjects_lookup_idx').on(table.academicYearId, table.classLevelId),
  ],
);

export const rooms = pgTable(
  'rooms',
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
    code: varchar('code', { length: 32 }).notNull(),
    nameEn: varchar('name_en', { length: 128 }).notNull(),
    nameBn: varchar('name_bn', { length: 128 }),
    /** 'classroom' | 'lab' | 'hall' | 'library' | 'office' */
    kind: varchar('kind', { length: 24 }).notNull().default('classroom'),
    capacity: smallint('capacity'),
    floor: varchar('floor', { length: 16 }),
    building: varchar('building', { length: 64 }),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('rooms_campus_code_key')
      .on(table.campusId, table.code)
      .where(sql`${table.archivedAt} IS NULL`),
    index('rooms_tenant_idx').on(table.tenantId),
  ],
);

/** Named time slots within a shift — "1st Period", "Tiffin", "Assembly". */
export const periods = pgTable(
  'periods',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    shiftId: uuid('shift_id')
      .notNull()
      .references(() => shifts.id, { onDelete: 'cascade' }),
    nameEn: varchar('name_en', { length: 64 }).notNull(),
    nameBn: varchar('name_bn', { length: 64 }),
    sequence: smallint('sequence').notNull(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    /** Breaks occupy a slot but hold no class, so the timetable solver must skip them. */
    isBreak: boolean('is_break').notNull().default(false),
    ...timestampColumns(),
    ...archiveColumns(),
  },
  (table) => [
    uniqueIndex('periods_shift_sequence_key')
      .on(table.shiftId, table.sequence)
      .where(sql`${table.archivedAt} IS NULL`),
    index('periods_tenant_idx').on(table.tenantId),
  ],
);

/**
 * The academic calendar: holidays, exam windows, events, and explicit working days.
 *
 * Attendance consults this before allowing a register to be taken — marking a school closed
 * day is almost always a data-entry error, and silently accepting it corrupts the attendance
 * percentage that drives the early-warning system.
 */
export const calendarEvents = pgTable(
  'calendar_events',
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
    /** Null means the event applies to every campus. */
    campusId: uuid('campus_id').references(() => campuses.id, { onDelete: 'cascade' }),
    titleEn: varchar('title_en', { length: 255 }).notNull(),
    titleBn: varchar('title_bn', { length: 255 }),
    description: text('description'),
    /** 'holiday' | 'exam' | 'event' | 'working_day' | 'vacation' */
    kind: varchar('kind', { length: 24 }).notNull().default('event'),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    /** A holiday closes the school; an event does not. */
    isNonTeaching: boolean('is_non_teaching').notNull().default(false),
    /**
     * Overrides the configured weekend — used when a school opens on a Saturday to make up
     * for a lost day, which is common around Ramadan and national holidays.
     */
    overridesWeekend: boolean('overrides_weekend').notNull().default(false),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('calendar_events_lookup_idx').on(table.academicYearId, table.startDate, table.endDate),
    index('calendar_events_tenant_idx').on(table.tenantId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────

export const academicYearsRelations = relations(academicYears, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [academicYears.institutionId],
    references: [institutions.id],
  }),
  terms: many(terms),
  sections: many(sections),
}));

export const termsRelations = relations(terms, ({ one }) => ({
  academicYear: one(academicYears, {
    fields: [terms.academicYearId],
    references: [academicYears.id],
  }),
}));

export const sectionsRelations = relations(sections, ({ one }) => ({
  institution: one(institutions, {
    fields: [sections.institutionId],
    references: [institutions.id],
  }),
  campus: one(campuses, { fields: [sections.campusId], references: [campuses.id] }),
  academicYear: one(academicYears, {
    fields: [sections.academicYearId],
    references: [academicYears.id],
  }),
  classLevel: one(classLevels, {
    fields: [sections.classLevelId],
    references: [classLevels.id],
  }),
  shift: one(shifts, { fields: [sections.shiftId], references: [shifts.id] }),
  group: one(academicGroups, { fields: [sections.groupId], references: [academicGroups.id] }),
}));

export const classSubjectsRelations = relations(classSubjects, ({ one }) => ({
  subject: one(subjects, { fields: [classSubjects.subjectId], references: [subjects.id] }),
  classLevel: one(classLevels, {
    fields: [classSubjects.classLevelId],
    references: [classLevels.id],
  }),
  academicYear: one(academicYears, {
    fields: [classSubjects.academicYearId],
    references: [academicYears.id],
  }),
}));
