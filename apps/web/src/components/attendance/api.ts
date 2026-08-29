/**
 * Attendance API surface and response types.
 *
 * Every interface here mirrors a `select` in `apps/api/src/modules/attendance/
 * attendance.service.ts` verbatim — nothing is invented, and a field that the service does not
 * project is deliberately absent rather than optional. (The corrections queue, for example,
 * joins `students.fullNameEn` but *not* `fullNameBn`, so there is no Bangla name to render on
 * that screen; pretending there might be one would produce a permanently blank column.)
 *
 * Every `/attendance` route is `@InstitutionScoped()`, so each helper takes the institution id
 * explicitly and threads it into the `x-institution-id` header. A missing id is a bug at the
 * call site, not something to paper over with a default.
 *
 * The query parameter types are declared as **type aliases rather than interfaces** on purpose:
 * TypeScript grants an implicit index signature to the former, which is what lets them be
 * handed straight to `RequestOptions['query']`. Spelling each endpoint's parameters out is the
 * cheap way to make a typo in a query key a compile error instead of a silently ignored filter.
 *
 * The academic lookups the attendance screens need (sections, years, assignments) are
 * **re-exported from `@/components/academic/api`** rather than re-declared. Two copies of
 * `SectionRow` is how one of them ends up missing `nameBn` and the Bangla name quietly stops
 * rendering on half the product.
 */

import { apiRequest, type Paged } from '@/lib/api';
import type {
  AttendanceMarkStatus,
  OpenAttendanceSessionInput,
  RequestAttendanceCorrectionInput,
  SubmitAttendanceInput,
} from '@shikkha/validation';
import { academicApi, type AcademicYear, type SectionRow } from '@/components/academic/api';

export type AttendanceSessionStatus = 'open' | 'submitted' | 'locked';
export type AttendanceCorrectionStatus = 'pending' | 'approved' | 'rejected';

/** One register: a section, on a date, optionally for one period and subject. */
export interface AttendanceSession {
  id: string;
  institutionId: string;
  campusId: string;
  academicYearId: string;
  sectionId: string;
  /** Null for the daily register; set for period-wise registers. */
  periodId: string | null;
  subjectId: string | null;
  attendanceDate: string;
  takenByEmployeeId: string | null;
  takenByUserId: string | null;
  takenAt: string | null;
  status: AttendanceSessionStatus;
  submittedAt: string | null;
  lockedAt: string | null;
  lockedBy: string | null;
  notes: string | null;
  /** Optimistic lock. Every write against a register carries the version it was read at. */
  version: number;
  archivedAt: string | null;
}

/** One row of the register: an enrolled student, with the mark they already have if any. */
export interface RosterRow {
  studentId: string;
  fullNameEn: string;
  fullNameBn: string | null;
  studentCode: string;
  photoFileId: string | null;
  rollNumber: string | null;
  enrollmentId: string;
  /** Null until the register has been saved at least once. */
  markId: string | null;
  status: AttendanceMarkStatus | null;
  minutesLate: number | null;
  remarks: string | null;
  markVersion: number | null;
  lastCorrectedAt: string | null;
}

export interface RosterResponse {
  session: AttendanceSession;
  roster: RosterRow[];
}

/**
 * A correction row as the table stores it — what `POST /marks/:id/corrections` and the two
 * decision routes return. The queue endpoint returns a *joined* shape; see
 * `AttendanceCorrection` below.
 */
export interface AttendanceCorrectionRow {
  id: string;
  studentAttendanceId: string;
  sessionId: string;
  studentId: string;
  previousStatus: AttendanceMarkStatus;
  newStatus: AttendanceMarkStatus;
  previousMinutesLate: number | null;
  newMinutesLate: number | null;
  reason: string;
  status: AttendanceCorrectionStatus;
  requestedBy: string;
  requestedByEmployeeId: string | null;
  requestedAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  decisionNote: string | null;
  version: number;
}

/**
 * A correction as returned by `GET /attendance/corrections`, joined with the student and the
 * register. Note there is no `studentNameBn`: the service does not select it.
 */
export interface AttendanceCorrection {
  id: string;
  studentAttendanceId: string;
  sessionId: string;
  studentId: string;
  studentNameEn: string;
  studentCode: string;
  sectionId: string;
  attendanceDate: string;
  previousStatus: AttendanceMarkStatus;
  newStatus: AttendanceMarkStatus;
  previousMinutesLate: number | null;
  newMinutesLate: number | null;
  reason: string;
  status: AttendanceCorrectionStatus;
  requestedBy: string;
  requestedAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  decisionNote: string | null;
  version: number;
}

/** One mark row, as returned alongside an applied correction. */
export interface StudentAttendanceMark {
  id: string;
  sessionId: string;
  studentId: string;
  status: AttendanceMarkStatus;
  minutesLate: number | null;
  remarks: string | null;
  markedAt: string | null;
  lastCorrectedAt: string | null;
  version: number;
}

export interface StudentSummaryRow {
  studentId: string;
  fullNameEn: string;
  fullNameBn: string | null;
  studentCode: string;
  totalSessions: number;
  present: number;
  absent: number;
  late: number;
  excused: number;
  halfDay: number;
  /** An integer, so it can be compared and sorted without touching a float. */
  attendanceBasisPoints: number;
  /**
   * A two-decimal string rendered by Postgres, e.g. `"95.00"`. Displayed as-is. Percentages are
   * computed by the database — `late` counts as attended, `half_day` as half, `excused` not at
   * all — and re-deriving that rule in the browser would produce a second, disagreeing number.
   */
  attendancePercentage: string;
}

export interface SectionDailyRow {
  sessionId: string;
  sectionId: string;
  sectionNameEn: string;
  sectionNameBn: string | null;
  attendanceDate: string;
  periodId: string | null;
  status: AttendanceSessionStatus;
  /** How many students have a mark on this register at all. */
  marked: number;
  present: number;
  absent: number;
  late: number;
  excused: number;
  halfDay: number;
}

export interface ConsecutiveAbsenceRow {
  studentId: string;
  fullNameEn: string;
  studentCode: string;
  sectionId: string;
  sectionNameEn: string;
  startedOn: string;
  endedOn: string;
  consecutiveDays: number;
}

// ── Query parameter shapes ────────────────────────────────────────────────────────────

export type ListSessionsQuery = {
  page?: number;
  pageSize?: number;
  sort?: string;
  sectionId?: string;
  academicYearId?: string;
  periodId?: string;
  from?: string;
  to?: string;
  status?: AttendanceSessionStatus;
  /** Refused unless the caller holds `attendance.correct.approve`. */
  includeArchived?: boolean;
};

export type ListCorrectionsQuery = {
  page?: number;
  pageSize?: number;
  sort?: string;
  status?: AttendanceCorrectionStatus;
  sectionId?: string;
  studentId?: string;
  from?: string;
  to?: string;
};

export type StudentSummaryQuery = {
  page?: number;
  pageSize?: number;
  from: string;
  to: string;
  studentId?: string;
  sectionId?: string;
  academicYearId?: string;
};

export type SectionDailyQuery = {
  from: string;
  to: string;
  sectionId?: string;
  academicYearId?: string;
};

export type ConsecutiveAbsenceQuery = {
  from: string;
  to: string;
  sectionId?: string;
  academicYearId?: string;
  minDays?: number;
  limit?: number;
};

// ── The client ────────────────────────────────────────────────────────────────────────

export const attendanceApi = {
  /** `GET /attendance/sessions` — registers within the caller's data scope. */
  sessions: (institutionId: string, query: ListSessionsQuery) =>
    apiRequest<Paged<AttendanceSession>>('/attendance/sessions', { institutionId, query }),

  /**
   * `POST /attendance/sessions` — idempotent: opening a register that already exists returns
   * the existing one rather than failing, so two devices in one classroom converge.
   */
  openSession: (institutionId: string, body: OpenAttendanceSessionInput) =>
    apiRequest<AttendanceSession>('/attendance/sessions', {
      method: 'POST',
      body,
      institutionId,
    }),

  /** `GET /attendance/sessions/:id/roster` — the register, pre-filled with existing marks. */
  roster: (institutionId: string, sessionId: string) =>
    apiRequest<RosterResponse>(`/attendance/sessions/${sessionId}/roster`, { institutionId }),

  /** `POST /attendance/sessions/:id/marks` — the whole register in one transaction. */
  submitMarks: (institutionId: string, sessionId: string, body: SubmitAttendanceInput) =>
    apiRequest<{ session: AttendanceSession; markedCount: number }>(
      `/attendance/sessions/${sessionId}/marks`,
      { method: 'POST', body, institutionId },
    ),

  /** `POST /attendance/sessions/:id/lock` — closes the register for the reporting period. */
  lockSession: (
    institutionId: string,
    sessionId: string,
    body: { reason: string; version: number },
  ) =>
    apiRequest<{ session: AttendanceSession }>(`/attendance/sessions/${sessionId}/lock`, {
      method: 'POST',
      body,
      institutionId,
    }),

  /**
   * `POST /attendance/marks/:markId/corrections`.
   *
   * `applied` is `true` only when the requester also holds `attendance.correct.approve`, in
   * which case the API applied the change in the same transaction. For everyone else the mark
   * is untouched and the correction is `pending` — which is exactly what the UI must say.
   */
  requestCorrection: (
    institutionId: string,
    markId: string,
    body: RequestAttendanceCorrectionInput,
  ) =>
    apiRequest<{
      correction: AttendanceCorrectionRow;
      applied: boolean;
      mark: StudentAttendanceMark;
    }>(`/attendance/marks/${markId}/corrections`, { method: 'POST', body, institutionId }),

  corrections: (institutionId: string, query: ListCorrectionsQuery) =>
    apiRequest<Paged<AttendanceCorrection>>('/attendance/corrections', { institutionId, query }),

  /**
   * `POST /attendance/corrections/:id/{approve|reject}`.
   *
   * Both take a reason and the correction's version. The API refuses a decision by the person
   * who raised it, so the UI must not offer one either — see the queue screen.
   */
  decideCorrection: (
    institutionId: string,
    correctionId: string,
    decision: 'approve' | 'reject',
    body: { reason: string; version: number },
  ) =>
    apiRequest<{ correction: AttendanceCorrectionRow; mark: StudentAttendanceMark | null }>(
      `/attendance/corrections/${correctionId}/${decision}`,
      { method: 'POST', body, institutionId },
    ),

  /** `GET /attendance/reports/student-summary` — paged; percentages come from Postgres. */
  studentSummary: (institutionId: string, query: StudentSummaryQuery) =>
    apiRequest<Paged<StudentSummaryRow>>('/attendance/reports/student-summary', {
      institutionId,
      query,
    }),

  /** `GET /attendance/reports/section-daily` — one row per register, not paged. */
  sectionDaily: (institutionId: string, query: SectionDailyQuery) =>
    apiRequest<SectionDailyRow[]>('/attendance/reports/section-daily', { institutionId, query }),

  /** `GET /attendance/reports/consecutive-absences` — runs of absence, not paged. */
  consecutiveAbsences: (institutionId: string, query: ConsecutiveAbsenceQuery) =>
    apiRequest<ConsecutiveAbsenceRow[]>('/attendance/reports/consecutive-absences', {
      institutionId,
      query,
    }),
};

// ── Academic lookups the attendance screens depend on ─────────────────────────────────

/**
 * Re-exported, not re-declared. These are `academicApi`'s own row shapes; aliasing them here
 * only saves the screens a second import path.
 */
export type SectionOption = SectionRow;
export type AcademicYearOption = AcademicYear;

export const attendanceLookups = {
  years: (institutionId: string) => academicApi.years(institutionId),

  sections: (institutionId: string, academicYearId?: string) =>
    academicApi.sections(institutionId, academicYearId),

  /**
   * The sections one employee is responsible for.
   *
   * `GET /academic/assignments` needs only `academic.sections.view`, which every teaching role
   * holds — unlike `/hr/employees`. It is how the attendance screen answers "which registers
   * are mine" without listing every section in the school, most of which the API would refuse
   * to open a register for anyway.
   */
  myAssignments: (institutionId: string, employeeId: string, academicYearId?: string) =>
    academicApi.assignments(institutionId, { employeeId, academicYearId }),
};
