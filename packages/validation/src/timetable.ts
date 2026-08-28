/**
 * Timetable schemas (Phase 6).
 *
 * Two things are deliberately *not* validated here, and both belong in the service:
 *
 *  - **Clashes.** Whether a teacher is already booked at Sunday period 2 depends on rows in
 *    other sections, and a schema that cannot see the database must not pretend to answer it.
 *    Validating the easy half here would produce a 422 for some clashes and a 409 for others,
 *    which is worse than one consistent answer from one place.
 *  - **Institution membership.** That a room belongs to the same institution as the timetable
 *    is a database question too. It is checked inside the tenant transaction, where the answer
 *    cannot go stale between check and write.
 *
 * What is validated here is everything answerable from the payload alone: shapes, ranges, and
 * the one cross-field rule that a set of entries for one section carries a section id.
 */

import { z } from 'zod';
import {
  calendarDateSchema,
  paginationSchema,
  reasonSchema,
  sortSchema,
  uuidSchema,
} from './common';

/**
 * The timetable lifecycle, as a closed set.
 *
 * Named here rather than re-typed at each use so a controller, a service and a form spell the
 * states identically; the database restates it as a check constraint in migration 0006. It is
 * not a Postgres enum, because a workflow state is exactly the kind of value set that grows.
 */
export const TIMETABLE_STATUSES = ['draft', 'published', 'archived'] as const;

/** Sortable columns for the timetable list. Anything else is dropped by `parseSort`. */
export const TIMETABLE_SORT_FIELDS = ['nameEn', 'effectiveFrom', 'status', 'createdAt'] as const;

const timetableName = z.string().trim().min(1).max(128);
const timetableNameBn = z.string().trim().max(128).optional();

/** 0 = Sunday … 6 = Saturday, matching `dhakaWeekday` and `academic_years.weekend_days`. */
const dayOfWeek = z.coerce.number().int().min(0).max(6);

// ── Timetables ───────────────────────────────────────────────────────────────────────

export const createTimetableSchema = z.object({
  campusId: uuidSchema,
  academicYearId: uuidSchema,
  /** Omitted when the routine runs unchanged for the whole year. */
  termId: uuidSchema.optional(),
  nameEn: timetableName,
  nameBn: timetableNameBn,
  effectiveFrom: calendarDateSchema,
  note: z.string().trim().max(500).optional(),
});

export type CreateTimetableInput = z.infer<typeof createTimetableSchema>;

/**
 * Clone an existing routine into a new draft.
 *
 * This is how next term's timetable actually gets made: 95% of it is last term's. The clone
 * copies entries, never status — the copy always starts as a draft, so cloning can never
 * publish anything by accident.
 *
 * There is no `campusId`: a clone always stays on the source's campus, because sections belong
 * to a campus and a cross-campus copy would carry references to classes and rooms that do not
 * exist there. Accepting the field and quietly ignoring it would be worse than not having it.
 */
export const cloneTimetableSchema = z.object({
  nameEn: timetableName,
  nameBn: timetableNameBn,
  effectiveFrom: calendarDateSchema,
  /** Defaults to the source timetable's term when omitted. */
  termId: uuidSchema.optional(),
  note: z.string().trim().max(500).optional(),
});

export type CloneTimetableInput = z.infer<typeof cloneTimetableSchema>;

export const listTimetablesSchema = paginationSchema.merge(sortSchema).extend({
  academicYearId: uuidSchema.optional(),
  campusId: uuidSchema.optional(),
  termId: uuidSchema.optional(),
  status: z.enum(TIMETABLE_STATUSES).optional(),
  /** Archived routines are the school's history of what it used to run. */
  includeArchived: z.coerce.boolean().default(false),
});

export const publishTimetableSchema = z.object({
  /** Correct the start date at the moment of publication; the drafted date is kept otherwise. */
  effectiveFrom: calendarDateSchema.optional(),
});

export const archiveTimetableSchema = z.object({ reason: reasonSchema });

// ── Entries ──────────────────────────────────────────────────────────────────────────

const timetableEntryInputSchema = z.object({
  dayOfWeek,
  periodId: uuidSchema,
  subjectId: uuidSchema,
  /** Null while drafting, when the subject is decided but the teacher is not. */
  employeeId: uuidSchema.optional(),
  /** Null for a lesson with no fixed room — games, assembly, a floating class. */
  roomId: uuidSchema.optional(),
  /** The lesson continues into the next period of the same shift. */
  isDoublePeriod: z.boolean().default(false),
  note: z.string().trim().max(255).optional(),
});

/**
 * Replace one section's whole week in one request.
 *
 * Set-at-a-time rather than entry-at-a-time for the same reason terms are: a routine is
 * edited by dragging six lessons around a grid, and sending six independent mutations means
 * six chances to leave the section half-scheduled if the fourth one fails. One payload, one
 * transaction, one clash check against the rest of the timetable.
 *
 * An empty array is allowed and means "this section has no lessons in this routine" — a real
 * state while a coordinator is still building the week.
 */
export const replaceTimetableEntriesSchema = z.object({
  sectionId: uuidSchema,
  entries: z.array(timetableEntryInputSchema).max(100),
});

export type ReplaceTimetableEntriesInput = z.infer<typeof replaceTimetableEntriesSchema>;

/** Removing one lesson is a soft archive, and the reason is part of the record. */
export const archiveTimetableEntrySchema = z.object({ reason: reasonSchema });

export const timetableEntryParamSchema = z.object({
  id: uuidSchema,
  entryId: uuidSchema,
});

// ── Substitutions ────────────────────────────────────────────────────────────────────

/**
 * A one-day cover.
 *
 * `entryId` rather than (section, day, period) because the entry is the thing being covered:
 * naming the slot instead would silently attach the substitution to whatever lesson later
 * occupied it.
 */
export const createTimetableSubstitutionSchema = z.object({
  entryId: uuidSchema,
  substitutionDate: calendarDateSchema,
  substituteEmployeeId: uuidSchema,
  reason: reasonSchema,
});

export type CreateTimetableSubstitutionInput = z.infer<typeof createTimetableSubstitutionSchema>;

export const cancelTimetableSubstitutionSchema = z.object({ reason: reasonSchema });

// ── Read views ───────────────────────────────────────────────────────────────────────

export const timetableSectionParamSchema = z.object({ sectionId: uuidSchema });

export const timetableTeacherParamSchema = z.object({ employeeId: uuidSchema });

/**
 * Which routine to show.
 *
 * With nothing supplied the service resolves the published routine in force today, which is
 * what a teacher opening the app on a Tuesday morning wants. `date` moves that resolution to
 * another day — for "what is my cover next Sunday" — and also selects which substitutions are
 * relevant.
 */
export const timetableViewQuerySchema = z.object({
  timetableId: uuidSchema.optional(),
  academicYearId: uuidSchema.optional(),
  date: calendarDateSchema.optional(),
});
