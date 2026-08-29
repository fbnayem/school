/**
 * Typed API surface for the academic-structure and timetable screens.
 *
 * Thin wrappers over `apiRequest` so every page spells paths, methods and the
 * `x-institution-id` header the same way. Both controllers are `@InstitutionScoped()`, so
 * every function here takes the institution id explicitly — a missing id is a bug at the call
 * site, not something to paper over with a default.
 */

import type { z } from 'zod';
import type {
  assignSectionTeacherSchema,
  assignSubjectTeacherSchema,
  cloneTimetableSchema,
  createAcademicYearSchema,
  createCalendarEventSchema,
  createClassLevelSchema,
  createRoomSchema,
  createSectionSchema,
  createShiftSchema,
  createSubjectSchema,
  createTimetableSchema,
  createTimetableSubstitutionSchema,
  replaceClassSubjectsSchema,
  replacePeriodsSchema,
  replaceTermsSchema,
  replaceTimetableEntriesSchema,
  updateCalendarEventSchema,
  updateRoomSchema,
  updateShiftSchema,
} from '@shikkha/validation';
import { apiRequest, type Paged } from '@/lib/api';

// ── Row shapes (as the services select them) ─────────────────────────────────────────

export interface AcademicYear {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: string;
  isCurrent: boolean;
  /** ISO weekday numbers, 0 = Sunday. */
  weekendDays: number[];
  version: number;
}

export interface Term {
  id: string;
  academicYearId: string;
  nameEn: string;
  nameBn: string | null;
  sequence: number;
  startDate: string;
  endDate: string;
  weightBasisPoints: number;
  isClosed: boolean;
}

export interface ClassLevel {
  id: string;
  code: string;
  nameEn: string;
  nameBn: string | null;
  ordinal: number;
  hasGroups: boolean;
}

export interface SectionRow {
  id: string;
  nameEn: string;
  nameBn: string | null;
  capacity: number | null;
  classLevelId: string;
  classLevelName: string;
  classLevelOrdinal: number;
  academicYearId: string;
  campusId: string;
  shiftId: string | null;
  groupId: string | null;
  enrolledCount: number;
}

export interface Subject {
  id: string;
  code: string;
  nameEn: string;
  nameBn: string | null;
  shortName: string | null;
  kind: string;
  isFourthSubject: boolean;
  excludeFromGpa: boolean;
  hasPractical: boolean;
  sortOrder: number;
}

export interface Room {
  id: string;
  campusId: string;
  code: string;
  nameEn: string;
  nameBn: string | null;
  kind: string;
  capacity: number | null;
  floor: string | null;
  building: string | null;
  archivedAt: string | null;
}

export interface Shift {
  id: string;
  campusId: string | null;
  kind: string;
  nameEn: string;
  nameBn: string | null;
  startTime: string;
  endTime: string;
  sortOrder: number;
  version: number;
  archivedAt: string | null;
}

export interface Period {
  id: string;
  shiftId: string;
  nameEn: string;
  nameBn: string | null;
  sequence: number;
  startTime: string;
  endTime: string;
  isBreak: boolean;
}

export interface CalendarEvent {
  id: string;
  academicYearId: string;
  campusId: string | null;
  titleEn: string;
  titleBn: string | null;
  description: string | null;
  kind: string;
  startDate: string;
  endDate: string;
  isNonTeaching: boolean;
  overridesWeekend: boolean;
}

export interface ClassSubjectRow {
  id: string;
  academicYearId: string;
  classLevelId: string;
  classLevelNameEn: string;
  classLevelOrdinal: number;
  subjectId: string;
  subjectCode: string;
  subjectNameEn: string;
  subjectNameBn: string | null;
  subjectKind: string;
  groupId: string | null;
  periodsPerWeek: number;
  fullMarks: number;
  passMarks: number;
  markDistribution: Record<string, number>;
  isOptional: boolean;
  archivedAt: string | null;
}

export interface SectionAssignment {
  id: string;
  academicYearId: string;
  sectionId: string;
  sectionNameEn: string;
  classLevelId: string;
  employeeId: string;
  employeeCode: string | null;
  employeeNameEn: string;
  employeeNameBn: string | null;
  role: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  archivedAt: string | null;
}

export interface SubjectAssignment {
  id: string;
  academicYearId: string;
  sectionId: string;
  sectionNameEn: string;
  subjectId: string;
  subjectNameEn: string;
  subjectNameBn: string | null;
  classSubjectId: string | null;
  employeeId: string;
  employeeCode: string | null;
  employeeNameEn: string;
  isPrimary: boolean;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  archivedAt: string | null;
}

export interface TeacherAssignments {
  sectionAssignments: SectionAssignment[];
  subjectAssignments: SubjectAssignment[];
}

/** The subset of the (redacted) employee row the pickers need. */
export interface EmployeeOption {
  id: string;
  employeeCode: string | null;
  fullNameEn: string;
}

export interface Timetable {
  id: string;
  campusId: string;
  academicYearId: string;
  termId: string | null;
  nameEn: string;
  nameBn: string | null;
  status: 'draft' | 'published' | 'archived';
  effectiveFrom: string;
  publishedAt: string | null;
  note: string | null;
  version: number;
  archivedAt: string | null;
}

export interface TimetableEntry {
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
  sectionName: string;
  classLevelName: string;
  classLevelOrdinal: number;
  periodName: string;
  periodSequence: number;
  startTime: string;
  endTime: string;
  subjectName: string;
  subjectNameBn: string | null;
  subjectCode: string;
  teacherName: string | null;
  roomName: string | null;
  roomCode: string | null;
  sectionLabel: string;
  roomLabel: string | null;
}

export interface Substitution {
  id: string;
  entryId: string;
  substitutionDate: string;
  periodId: string;
  substituteEmployeeId: string;
  originalEmployeeId: string | null;
  reason: string;
  substituteName: string;
}

export interface TimetableDetail extends Timetable {
  entries: TimetableEntry[];
  substitutions: Substitution[];
}

export interface TimetableConflict {
  kind: 'section' | 'teacher' | 'room';
  dayOfWeek: number;
  periodId: string;
  periodLabel: string;
  resourceId: string;
  resourceLabel: string;
  entryIds: string[];
  message: string;
}

export interface ValidationReport {
  timetableId: string;
  status: string;
  entryCount: number;
  isValid: boolean;
  conflicts: TimetableConflict[];
  warnings: Array<{ entryIds: string[]; message: string }>;
}

export interface SectionTimetableView {
  section: {
    id: string;
    nameEn: string;
    nameBn: string | null;
    campusId: string;
    academicYearId: string;
    classLevelId: string;
    classLevelName: string;
  };
  timetable: Timetable;
  onDate: string;
  entries: TimetableEntry[];
  substitutions: Substitution[];
}

export interface TeacherTimetableView {
  employee: { id: string; fullNameEn: string };
  timetables: Timetable[];
  onDate: string;
  entries: TimetableEntry[];
  substitutions: Array<{
    id: string;
    entryId: string;
    substitutionDate: string;
    periodId: string;
    substituteEmployeeId: string;
    originalEmployeeId: string | null;
    reason: string;
    sectionId: string;
    subjectId: string;
    dayOfWeek: number;
    role: 'covering' | 'covered';
  }>;
}

// ── Academic structure ───────────────────────────────────────────────────────────────

export const academicApi = {
  years: (institutionId: string) =>
    apiRequest<AcademicYear[]>('/academic/years', { institutionId }),

  createYear: (institutionId: string, body: z.infer<typeof createAcademicYearSchema>) =>
    apiRequest<AcademicYear>('/academic/years', { method: 'POST', body, institutionId }),

  setCurrentYear: (institutionId: string, id: string) =>
    apiRequest<AcademicYear>(`/academic/years/${id}/set-current`, {
      method: 'POST',
      institutionId,
    }),

  terms: (institutionId: string, academicYearId: string) =>
    apiRequest<Term[]>(`/academic/years/${academicYearId}/terms`, { institutionId }),

  replaceTerms: (institutionId: string, body: z.infer<typeof replaceTermsSchema>) =>
    apiRequest<Term[]>('/academic/terms', { method: 'PUT', body, institutionId }),

  classLevels: (institutionId: string) =>
    apiRequest<ClassLevel[]>('/academic/class-levels', { institutionId }),

  createClassLevel: (institutionId: string, body: z.infer<typeof createClassLevelSchema>) =>
    apiRequest<ClassLevel>('/academic/class-levels', { method: 'POST', body, institutionId }),

  sections: (institutionId: string, academicYearId?: string) =>
    apiRequest<SectionRow[]>('/academic/sections', { institutionId, query: { academicYearId } }),

  createSection: (institutionId: string, body: z.infer<typeof createSectionSchema>) =>
    apiRequest<SectionRow>('/academic/sections', { method: 'POST', body, institutionId }),

  subjects: (institutionId: string) =>
    apiRequest<Subject[]>('/academic/subjects', { institutionId }),

  createSubject: (institutionId: string, body: z.infer<typeof createSubjectSchema>) =>
    apiRequest<Subject>('/academic/subjects', { method: 'POST', body, institutionId }),

  rooms: (institutionId: string, query: { campusId?: string; kind?: string } = {}) =>
    apiRequest<Room[]>('/academic/rooms', { institutionId, query }),

  createRoom: (institutionId: string, body: z.infer<typeof createRoomSchema>) =>
    apiRequest<Room>('/academic/rooms', { method: 'POST', body, institutionId }),

  updateRoom: (institutionId: string, id: string, body: z.infer<typeof updateRoomSchema>) =>
    apiRequest<Room>(`/academic/rooms/${id}`, { method: 'PATCH', body, institutionId }),

  archiveRoom: (institutionId: string, id: string, reason: string) =>
    apiRequest<Room>(`/academic/rooms/${id}/archive`, {
      method: 'POST',
      body: { reason },
      institutionId,
    }),

  shifts: (institutionId: string, query: { campusId?: string } = {}) =>
    apiRequest<Shift[]>('/academic/shifts', { institutionId, query }),

  createShift: (institutionId: string, body: z.infer<typeof createShiftSchema>) =>
    apiRequest<Shift>('/academic/shifts', { method: 'POST', body, institutionId }),

  updateShift: (institutionId: string, id: string, body: z.infer<typeof updateShiftSchema>) =>
    apiRequest<Shift>(`/academic/shifts/${id}`, { method: 'PATCH', body, institutionId }),

  periods: (institutionId: string, shiftId: string) =>
    apiRequest<Period[]>(`/academic/shifts/${shiftId}/periods`, { institutionId }),

  replacePeriods: (institutionId: string, body: z.infer<typeof replacePeriodsSchema>) =>
    apiRequest<Period[]>('/academic/periods', { method: 'PUT', body, institutionId }),

  calendar: (
    institutionId: string,
    query: { academicYearId?: string; kind?: string; from?: string; to?: string } = {},
  ) => apiRequest<CalendarEvent[]>('/academic/calendar', { institutionId, query }),

  createCalendarEvent: (
    institutionId: string,
    body: z.infer<typeof createCalendarEventSchema>,
  ) => apiRequest<CalendarEvent>('/academic/calendar', { method: 'POST', body, institutionId }),

  updateCalendarEvent: (
    institutionId: string,
    id: string,
    body: z.infer<typeof updateCalendarEventSchema>,
  ) =>
    apiRequest<CalendarEvent>(`/academic/calendar/${id}`, { method: 'PATCH', body, institutionId }),

  deleteCalendarEvent: (institutionId: string, id: string, reason: string) =>
    apiRequest<CalendarEvent>(`/academic/calendar/${id}`, {
      method: 'DELETE',
      body: { reason },
      institutionId,
    }),

  curriculum: (institutionId: string, query: { academicYearId: string; classLevelId?: string }) =>
    apiRequest<ClassSubjectRow[]>('/academic/curriculum', { institutionId, query }),

  replaceCurriculum: (institutionId: string, body: z.infer<typeof replaceClassSubjectsSchema>) =>
    apiRequest<ClassSubjectRow[]>('/academic/curriculum', { method: 'PUT', body, institutionId }),

  assignments: (
    institutionId: string,
    query: { academicYearId?: string; sectionId?: string; employeeId?: string } = {},
  ) => apiRequest<TeacherAssignments>('/academic/assignments', { institutionId, query }),

  assignSectionTeacher: (
    institutionId: string,
    body: z.infer<typeof assignSectionTeacherSchema>,
  ) =>
    apiRequest<SectionAssignment>('/academic/assignments/sections', {
      method: 'POST',
      body,
      institutionId,
    }),

  unassignSectionTeacher: (institutionId: string, id: string, reason: string) =>
    apiRequest<SectionAssignment>(`/academic/assignments/sections/${id}/unassign`, {
      method: 'POST',
      body: { reason },
      institutionId,
    }),

  assignSubjectTeacher: (
    institutionId: string,
    body: z.infer<typeof assignSubjectTeacherSchema>,
  ) =>
    apiRequest<SubjectAssignment>('/academic/assignments/subjects', {
      method: 'POST',
      body,
      institutionId,
    }),

  unassignSubjectTeacher: (institutionId: string, id: string, reason: string) =>
    apiRequest<SubjectAssignment>(`/academic/assignments/subjects/${id}/unassign`, {
      method: 'POST',
      body: { reason },
      institutionId,
    }),

  /** Employee picker source. Requires `hr.employees.view`; the API refuses otherwise. */
  employees: (institutionId: string, q?: string) =>
    apiRequest<Paged<EmployeeOption>>('/hr/employees', {
      institutionId,
      query: { page: 1, pageSize: 50, q: q || undefined, sort: 'fullNameEn' },
    }),
};

// ── Timetables ───────────────────────────────────────────────────────────────────────

export const timetableApi = {
  list: (
    institutionId: string,
    query: { page: number; pageSize: number; academicYearId?: string; status?: string },
  ) => apiRequest<Paged<Timetable & { entryCount: number }>>('/timetables', {
    institutionId,
    query,
  }),

  create: (institutionId: string, body: z.infer<typeof createTimetableSchema>) =>
    apiRequest<Timetable>('/timetables', { method: 'POST', body, institutionId }),

  detail: (institutionId: string, id: string) =>
    apiRequest<TimetableDetail>(`/timetables/${id}`, { institutionId }),

  validate: (institutionId: string, id: string) =>
    apiRequest<ValidationReport>(`/timetables/${id}/validate`, { institutionId }),

  clone: (institutionId: string, id: string, body: z.infer<typeof cloneTimetableSchema>) =>
    apiRequest<Timetable & { entriesCopied: number }>(`/timetables/${id}/clone`, {
      method: 'POST',
      body,
      institutionId,
    }),

  replaceEntries: (
    institutionId: string,
    id: string,
    body: z.infer<typeof replaceTimetableEntriesSchema>,
  ) =>
    apiRequest<{ sectionId: string; entries: TimetableEntry[] }>(`/timetables/${id}/entries`, {
      method: 'PUT',
      body,
      institutionId,
    }),

  publish: (institutionId: string, id: string, effectiveFrom?: string) =>
    apiRequest<Timetable & { supersededTimetableId: string | null }>(
      `/timetables/${id}/publish`,
      {
        method: 'POST',
        body: effectiveFrom ? { effectiveFrom } : {},
        institutionId,
      },
    ),

  archive: (institutionId: string, id: string, reason: string) =>
    apiRequest<Timetable>(`/timetables/${id}/archive`, {
      method: 'POST',
      body: { reason },
      institutionId,
    }),

  createSubstitution: (
    institutionId: string,
    id: string,
    body: z.infer<typeof createTimetableSubstitutionSchema>,
  ) =>
    apiRequest<Substitution>(`/timetables/${id}/substitutions`, {
      method: 'POST',
      body,
      institutionId,
    }),

  cancelSubstitution: (institutionId: string, id: string, reason: string) =>
    apiRequest<Substitution>(`/timetables/substitutions/${id}/cancel`, {
      method: 'POST',
      body: { reason },
      institutionId,
    }),

  sectionView: (
    institutionId: string,
    sectionId: string,
    query: { timetableId?: string; date?: string } = {},
  ) => apiRequest<SectionTimetableView>(`/timetable/section/${sectionId}`, {
    institutionId,
    query,
  }),

  teacherView: (
    institutionId: string,
    employeeId: string,
    query: { timetableId?: string; date?: string } = {},
  ) => apiRequest<TeacherTimetableView>(`/timetable/teacher/${employeeId}`, {
    institutionId,
    query,
  }),
};
