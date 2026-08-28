/**
 * Timetable (Phase 6).
 *
 * Three tables, and the shape of each is decided by one question: *what must the database
 * refuse, even if the application forgets?*
 *
 *  - `timetables` is the versioned document. A timetable is drafted, published, and later
 *    superseded; it is never edited in place once published, because a printed routine
 *    handed to 900 students is a fact about the past as much as a plan for the future.
 *    A partial unique index allows exactly one *published* timetable per
 *    (institution, campus, academic year, term) — the invariant behind "publishing archives
 *    the previous one".
 *  - `timetable_entries` is one lesson in one slot. The three clash rules — a section, a
 *    teacher and a room can each be in only one place at a time — are partial unique indexes
 *    rather than application checks alone. The service checks them first so the user gets a
 *    sentence instead of a constraint name; the indexes are what make the rule true when two
 *    coordinators save at the same instant.
 *  - `timetable_substitutions` is a one-day swap. It carries a denormalised `period_id`
 *    copied from the entry so that "this substitute is already busy in this period on this
 *    date" is a unique index too, not only a query the service remembers to run. The copy is
 *    safe because an entry's period cannot change once its timetable is published, and a
 *    substitution may only be attached to a published timetable.
 *
 * `status` is a `varchar` with a documented union rather than a `pgEnum`: the value set is
 * small and closed *today*, but a school-visible workflow state is exactly the kind of thing
 * that grows (`pending_approval`), and an enum makes that a type migration coordinated across
 * every deployment. The database check constraint in migration 0006 is what keeps it closed.
 */

import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  pgTable,
  smallint,
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
import { academicYears, periods, rooms, sections, subjects, terms } from './academic';
import { employees } from './people';

export const timetables = pgTable(
  'timetables',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    /**
     * A timetable belongs to one campus. Two campuses of the same school run different
     * routines and share neither rooms nor most teachers, so a single document covering both
     * would make every clash check wrong in one direction or the other.
     */
    campusId: uuid('campus_id')
      .notNull()
      .references(() => campuses.id, { onDelete: 'restrict' }),
    academicYearId: uuid('academic_year_id')
      .notNull()
      .references(() => academicYears.id, { onDelete: 'restrict' }),
    /** Null when the routine runs for the whole year rather than changing each term. */
    termId: uuid('term_id').references(() => terms.id, { onDelete: 'restrict' }),
    nameEn: varchar('name_en', { length: 128 }).notNull(),
    nameBn: varchar('name_bn', { length: 128 }),
    /** 'draft' | 'published' | 'archived' */
    status: varchar('status', { length: 16 }).notNull().default('draft'),
    /** The first school day this routine applies to. */
    effectiveFrom: date('effective_from').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
    publishedBy: uuid('published_by'),
    /** Free-text note shown to staff, e.g. "Ramadan schedule — shortened periods". */
    note: varchar('note', { length: 500 }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    // One published routine per scope. Two partial indexes because Postgres treats NULLs as
    // distinct, so a single index over a nullable `term_id` would permit any number of
    // published year-long timetables for the same campus.
    uniqueIndex('timetables_published_scope_key')
      .on(table.institutionId, table.campusId, table.academicYearId, table.termId)
      .where(
        sql`${table.status} = 'published' AND ${table.termId} IS NOT NULL AND ${table.archivedAt} IS NULL`,
      ),
    uniqueIndex('timetables_published_scope_noterm_key')
      .on(table.institutionId, table.campusId, table.academicYearId)
      .where(
        sql`${table.status} = 'published' AND ${table.termId} IS NULL AND ${table.archivedAt} IS NULL`,
      ),
    uniqueIndex('timetables_institution_name_key')
      .on(table.institutionId, table.academicYearId, table.nameEn)
      .where(sql`${table.archivedAt} IS NULL`),
    index('timetables_tenant_idx').on(table.tenantId),
    index('timetables_scope_idx').on(table.institutionId, table.academicYearId, table.status),
    index('timetables_campus_idx').on(table.campusId),
    index('timetables_term_idx').on(table.termId),
  ],
);

/**
 * One lesson: this section, on this weekday, in this period, taught by this teacher in this
 * room.
 *
 * `day_of_week` follows the same convention as `dhakaWeekday` in `@shikkha/shared` and
 * `academic_years.weekend_days`: 0 = Sunday. Nothing here assumes Friday and Saturday are
 * non-teaching days — that is institution configuration, and a madrasah or an English-medium
 * school will disagree.
 */
export const timetableEntries = pgTable(
  'timetable_entries',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    timetableId: uuid('timetable_id')
      .notNull()
      .references(() => timetables.id, { onDelete: 'cascade' }),
    sectionId: uuid('section_id')
      .notNull()
      .references(() => sections.id, { onDelete: 'restrict' }),
    /** 0 = Sunday … 6 = Saturday. */
    dayOfWeek: smallint('day_of_week').notNull(),
    periodId: uuid('period_id')
      .notNull()
      .references(() => periods.id, { onDelete: 'restrict' }),
    subjectId: uuid('subject_id')
      .notNull()
      .references(() => subjects.id, { onDelete: 'restrict' }),
    /** Null while the routine is being drafted and the teacher is not yet decided. */
    employeeId: uuid('employee_id').references(() => employees.id, { onDelete: 'restrict' }),
    /** Null for a lesson with no fixed room — games, assembly, a floating class. */
    roomId: uuid('room_id').references(() => rooms.id, { onDelete: 'restrict' }),
    /**
     * The lesson continues into the next period of the same shift. Practicals and art
     * lessons are routinely double; recording it as a flag rather than two rows keeps the
     * printed routine readable, and the clash checks expand it back into two occupied slots.
     */
    isDoublePeriod: boolean('is_double_period').notNull().default(false),
    note: varchar('note', { length: 255 }),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    // The three clash rules. Partial on `archived_at` so a slot freed by an archived entry
    // becomes reusable while the archived row is preserved (ADR-008).
    uniqueIndex('timetable_entries_section_slot_key')
      .on(table.timetableId, table.sectionId, table.dayOfWeek, table.periodId)
      .where(sql`${table.archivedAt} IS NULL`),
    uniqueIndex('timetable_entries_teacher_slot_key')
      .on(table.timetableId, table.employeeId, table.dayOfWeek, table.periodId)
      .where(sql`${table.employeeId} IS NOT NULL AND ${table.archivedAt} IS NULL`),
    uniqueIndex('timetable_entries_room_slot_key')
      .on(table.timetableId, table.roomId, table.dayOfWeek, table.periodId)
      .where(sql`${table.roomId} IS NOT NULL AND ${table.archivedAt} IS NULL`),
    index('timetable_entries_tenant_idx').on(table.tenantId),
    index('timetable_entries_timetable_idx').on(table.timetableId, table.dayOfWeek),
    index('timetable_entries_section_idx').on(table.sectionId),
    index('timetable_entries_employee_idx').on(table.employeeId),
    index('timetable_entries_room_idx').on(table.roomId),
    index('timetable_entries_period_idx').on(table.periodId),
    index('timetable_entries_subject_idx').on(table.subjectId),
  ],
);

/**
 * A one-day teacher swap against a published timetable.
 *
 * Cancelling a substitution archives it rather than deleting it: "who actually took Class 7
 * on the 14th" is the question asked after an incident, and it must still be answerable.
 */
export const timetableSubstitutions = pgTable(
  'timetable_substitutions',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => timetableEntries.id, { onDelete: 'cascade' }),
    /** The single day this swap applies to. */
    substitutionDate: date('substitution_date').notNull(),
    /**
     * Copied from the entry at creation time so that "one substitute, one period, one day"
     * can be a unique index. Safe because entries of a published timetable are immutable.
     */
    periodId: uuid('period_id')
      .notNull()
      .references(() => periods.id, { onDelete: 'restrict' }),
    substituteEmployeeId: uuid('substitute_employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),
    /** Who is being covered for. Null when the entry had no teacher assigned. */
    originalEmployeeId: uuid('original_employee_id').references(() => employees.id, {
      onDelete: 'restrict',
    }),
    reason: varchar('reason', { length: 500 }).notNull(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('timetable_substitutions_entry_date_key')
      .on(table.entryId, table.substitutionDate)
      .where(sql`${table.archivedAt} IS NULL`),
    // The substitute cannot be in two rooms at once either. This is the database half of the
    // clash rule the service reports as a 409.
    uniqueIndex('timetable_substitutions_teacher_slot_key')
      .on(table.substituteEmployeeId, table.substitutionDate, table.periodId)
      .where(sql`${table.archivedAt} IS NULL`),
    index('timetable_substitutions_tenant_idx').on(table.tenantId),
    index('timetable_substitutions_date_idx').on(table.institutionId, table.substitutionDate),
    index('timetable_substitutions_entry_idx').on(table.entryId),
    index('timetable_substitutions_employee_idx').on(
      table.substituteEmployeeId,
      table.substitutionDate,
    ),
    index('timetable_substitutions_period_idx').on(table.periodId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────

export const timetablesRelations = relations(timetables, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [timetables.institutionId],
    references: [institutions.id],
  }),
  campus: one(campuses, { fields: [timetables.campusId], references: [campuses.id] }),
  academicYear: one(academicYears, {
    fields: [timetables.academicYearId],
    references: [academicYears.id],
  }),
  term: one(terms, { fields: [timetables.termId], references: [terms.id] }),
  entries: many(timetableEntries),
}));

export const timetableEntriesRelations = relations(timetableEntries, ({ one, many }) => ({
  timetable: one(timetables, {
    fields: [timetableEntries.timetableId],
    references: [timetables.id],
  }),
  section: one(sections, { fields: [timetableEntries.sectionId], references: [sections.id] }),
  period: one(periods, { fields: [timetableEntries.periodId], references: [periods.id] }),
  subject: one(subjects, { fields: [timetableEntries.subjectId], references: [subjects.id] }),
  teacher: one(employees, { fields: [timetableEntries.employeeId], references: [employees.id] }),
  room: one(rooms, { fields: [timetableEntries.roomId], references: [rooms.id] }),
  substitutions: many(timetableSubstitutions),
}));

export const timetableSubstitutionsRelations = relations(timetableSubstitutions, ({ one }) => ({
  entry: one(timetableEntries, {
    fields: [timetableSubstitutions.entryId],
    references: [timetableEntries.id],
  }),
  period: one(periods, {
    fields: [timetableSubstitutions.periodId],
    references: [periods.id],
  }),
  substitute: one(employees, {
    fields: [timetableSubstitutions.substituteEmployeeId],
    references: [employees.id],
  }),
}));
