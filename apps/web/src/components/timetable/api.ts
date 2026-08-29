/**
 * The timetable screens' API surface.
 *
 * Almost all of it already exists: `@/components/academic/api` exports a `timetableApi` written
 * alongside the academic-structure screens, and the honest thing to do is use it rather than
 * ship a second client that will drift from it. Everything below is either a re-export or a
 * correction to a shape that does not match what the controller actually returns.
 *
 * ## The one correction
 *
 * `PUT /timetables/:id/entries` responds with `{ sectionId, entries }` where `entries` are the
 * **raw `timetable_entries` rows** the insert returned — `id`, `sectionId`, `periodId`,
 * `subjectId` and friends, with no `subjectName`, `teacherName`, `periodName` or `sectionLabel`.
 * The labelled shape only comes from `loadEntries`, which the read routes use. `academicApi`
 * types the response as the labelled `TimetableEntry[]`, which typechecks and is wrong: reading
 * `entry.subjectName` off it renders `undefined`.
 *
 * `saveSectionEntries` below types it as what it is. The editor does not use the response at
 * all — it invalidates and refetches through the read route, which is the only place the labels
 * exist — but a caller that reaches for a label now gets a compile error instead of a blank
 * cell.
 */

import type { z } from 'zod';
import type { replaceTimetableEntriesSchema } from '@shikkha/validation';
import { apiRequest } from '@/lib/api';

export {
  timetableApi,
  academicApi,
  type Timetable,
  type TimetableDetail,
  type TimetableEntry,
  type TimetableConflict,
  type ValidationReport,
  type SectionTimetableView,
  type TeacherTimetableView,
  type Substitution,
  type Period,
  type Room,
  type Subject,
  type SectionRow,
  type ClassSubjectRow,
  type EmployeeOption,
  type TeacherAssignments,
} from '@/components/academic/api';

/**
 * A `timetable_entries` row exactly as the write routes return it. No joined labels — see the
 * file header.
 */
export interface TimetableEntryRecord {
  id: string;
  timetableId: string;
  sectionId: string;
  dayOfWeek: number;
  periodId: string;
  subjectId: string;
  employeeId: string | null;
  roomId: string | null;
  isDoublePeriod: boolean;
  note: string | null;
  archivedAt: string | null;
}

/**
 * Replace one section's whole week in a **draft** timetable.
 *
 * Set-at-a-time, because that is the shape of the invariant: whether this section's Sunday is
 * legal depends on the rest of the routine. The API refuses the whole payload with a 409
 * listing every clash rather than applying part of it, and refuses it outright on a published
 * or archived timetable.
 */
export function saveSectionEntries(
  institutionId: string,
  timetableId: string,
  body: z.infer<typeof replaceTimetableEntriesSchema>,
) {
  return apiRequest<{ sectionId: string; entries: TimetableEntryRecord[] }>(
    `/timetables/${timetableId}/entries`,
    { method: 'PUT', body, institutionId },
  );
}
