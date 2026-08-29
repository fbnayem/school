/**
 * Typed API surface for the examination and result screens (phase 8).
 *
 * Every shape below was read off `apps/api/src/modules/exams/exams.controller.ts` and
 * `exams.service.ts` — the `select({ ... })` projections, not a guess. A field name that was
 * invented here would typecheck perfectly and render `undefined` on a marksheet, which is the
 * one class of bug this file exists to prevent.
 *
 * Two conventions carried straight through from the API:
 *
 *  1. **Marks, percentages and grade points are decimal strings**, exactly like money
 *     (ADR-004). They are formatted for display and posted back verbatim. The browser does no
 *     arithmetic on them: `0.1 + 0.2` on a legal document is a defect, and a marksheet is a
 *     legal document.
 *  2. **Every exam route is `@InstitutionScoped()`**, so every function here takes the
 *     institution id explicitly. A missing id is a bug at the call site, not something to
 *     paper over with a default.
 */

import type { z } from 'zod';
import type {
  approveExamMarksSchema,
  changeExamStatusSchema,
  correctExamMarkSchema,
  createExamScheduleSchema,
  createExamSchema,
  enterExamMarksSchema,
  publishExamResultsSchema,
  reviewExamSchema,
  submitExamMarksSchema,
} from '@shikkha/validation';
import { apiRequest, type Paged, type StudentSummary } from '@/lib/api';

// ── Row shapes ───────────────────────────────────────────────────────────────────────

export type ExamStatus =
  'draft' | 'scheduled' | 'ongoing' | 'marks_entry' | 'under_review' | 'published' | 'archived';

export type MarkEntryStatus = 'draft' | 'submitted' | 'approved';

/** `exams` as the service selects it (`select().from(exams)` — the whole row). */
export interface Exam {
  id: string;
  institutionId: string;
  campusId: string | null;
  academicYearId: string;
  termId: string | null;
  code: string;
  nameEn: string;
  nameBn: string | null;
  type: string;
  gradingScaleId: string;
  /** 10000 = 100%. Basis points, never a float — the same reason money is not a float. */
  weightageBasisPoints: number;
  status: ExamStatus;
  startDate: string | null;
  endDate: string | null;
  instructions: string | null;
  resultsPublishedAt: string | null;
  resultsPublishedBy: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface GradingScale {
  id: string;
  code: string;
  nameEn: string;
  nameBn: string | null;
  description: string | null;
  isDefault: boolean;
  version: number;
  archivedAt: string | null;
}

export interface GradingScaleListRow extends GradingScale {
  bandCount: number;
}

/** `findExam` adds the resolved scale and the configured paper count. */
export interface ExamDetail extends Exam {
  gradingScale: GradingScale | null;
  subjectCount: number;
}

/** One configured paper. Marks are decimal strings; a null component is not assessed. */
export interface ExamSubject {
  id: string;
  examId: string;
  classLevelId: string;
  subjectId: string;
  groupId: string | null;
  classSubjectId: string | null;
  fullMarks: string;
  passMarks: string;
  writtenFullMarks: string | null;
  writtenPassMarks: string | null;
  mcqFullMarks: string | null;
  mcqPassMarks: string | null;
  practicalFullMarks: string | null;
  practicalPassMarks: string | null;
  continuousFullMarks: string | null;
  continuousPassMarks: string | null;
  isOptional: boolean;
  sortOrder: number;
}

/** The row `listExamSubjects` projects: the paper plus its subject and class-level labels. */
export interface ExamSubjectRow {
  examSubject: ExamSubject;
  subjectCode: string;
  subjectNameEn: string;
  subjectNameBn: string | null;
  subjectKind: string;
  isFourthSubject: boolean;
  excludeFromGpa: boolean;
  classLevelNameEn: string;
  classLevelOrdinal: number;
}

export interface ExamSchedule {
  id: string;
  examSubjectId: string;
  sectionId: string | null;
  roomId: string | null;
  invigilatorEmployeeId: string | null;
  examDate: string;
  startTime: string;
  endTime: string;
  notes: string | null;
  version: number;
}

export interface ExamScheduleRow {
  schedule: ExamSchedule;
  subjectCode: string;
  subjectNameEn: string;
  classLevelId: string;
  roomCode: string | null;
  roomNameEn: string | null;
  invigilatorNameEn: string | null;
}

export interface ExamMark {
  id: string;
  examId: string;
  examSubjectId: string;
  studentId: string;
  enrollmentId: string | null;
  sectionId: string;
  writtenMarks: string | null;
  mcqMarks: string | null;
  practicalMarks: string | null;
  continuousMarks: string | null;
  /** The stored sum of whichever components are present. Null only for an absentee. */
  obtainedMarks: string | null;
  isAbsent: boolean;
  status: MarkEntryStatus;
  remarks: string | null;
  enteredBy: string | null;
  enteredAt: string | null;
  submittedBy: string | null;
  submittedAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  correctionCount: number;
  version: number;
}

/** The row `listMarks` projects: the mark plus the student and paper it belongs to. */
export interface ExamMarkRow {
  mark: ExamMark;
  studentCode: string;
  studentNameEn: string;
  studentNameBn: string | null;
  rollNumber: string | null;
  subjectCode: string;
  subjectNameEn: string;
  fullMarks: string;
  passMarks: string;
}

/** One student's frozen result. Every figure here was computed by the API at publication. */
export interface ResultRow {
  id: string;
  examId: string;
  studentId: string;
  enrollmentId: string | null;
  academicYearId: string;
  classLevelId: string;
  sectionId: string;
  totalMarks: string;
  obtainedMarks: string;
  percentage: string;
  gpa: string;
  grade: string;
  gpaSubjectCount: number;
  failedSubjectCount: number;
  isPassed: boolean;
  positionInSection: number | null;
  positionInClass: number | null;
  subjectBreakdown: ResultSubject[];
  computedAt: string;
  /** Null means computed but not published. Families never see one of these. */
  publishedAt: string | null;
  publishedBy: string | null;
  version: number;
}

/** One line of `results.subject_breakdown`, as `ExamsService.computeResult` writes it. */
export interface ResultSubject {
  examSubjectId: string;
  subjectId: string;
  subjectCode: string;
  subjectNameEn: string;
  subjectNameBn: string | null;
  kind: string;
  isFourthSubject: boolean;
  excludeFromGpa: boolean;
  fullMarks: string;
  obtainedMarks: string;
  percentage: string;
  gradePoint: string;
  grade: string;
  isAbsent: boolean;
  isPassed: boolean;
  /** Which component thresholds were missed. Empty when the subject was passed. */
  failedComponents: string[];
}

/** The tabulation sheet: one entry per student, one `papers` row per paper they sat. */
export interface TabulationSheet {
  exam: { id: string; nameEn: string; status: ExamStatus };
  section: { id: string; nameEn: string };
  students: TabulationStudent[];
}

export interface TabulationStudent {
  studentId: string;
  studentCode: string;
  studentNameEn: string;
  studentNameBn: string | null;
  rollNumber: string | null;
  papers: TabulationPaper[];
  /** Null until a result has been computed for this student. */
  result: TabulationResult | null;
}

export interface TabulationPaper {
  examSubjectId: string;
  subjectId: string;
  subjectCode: string;
  subjectNameEn: string;
  fullMarks: string;
  passMarks: string;
  writtenMarks: string | null;
  mcqMarks: string | null;
  practicalMarks: string | null;
  continuousMarks: string | null;
  obtainedMarks: string | null;
  isAbsent: boolean;
  status: MarkEntryStatus;
}

export interface TabulationResult {
  studentId: string;
  obtainedMarks: string;
  totalMarks: string;
  percentage: string;
  gpa: string;
  grade: string;
  isPassed: boolean;
  positionInSection: number | null;
  positionInClass: number | null;
  publishedAt: string | null;
}

/** `GET /exams/:id/marksheet/:studentId`. */
export interface Marksheet {
  result: ResultRow;
  examNameEn: string;
  examNameBn: string | null;
  examType: string;
  studentCode: string;
  studentNameEn: string;
  studentNameBn: string | null;
  sectionNameEn: string;
  classLevelNameEn: string;
  rollNumber: string | null;
}

/** `GET /exams/:id/summary`. Every figure is aggregated in SQL; none is computed here. */
export interface ExamSummary {
  exam: { id: string; nameEn: string; status: ExamStatus };
  totals: {
    students: number;
    passed: number;
    failed: number;
    /** A percentage as a two-decimal string, for example `87.50`. */
    passRate: string;
    averageGpa: string;
    highestGpa: string;
    averagePercentage: string;
    highestMarks: string;
    lowestMarks: string;
  };
  gradeDistribution: Array<{ grade: string; students: number; highestGpa: string | null }>;
}

// ── Client ───────────────────────────────────────────────────────────────────────────

export interface ListExamsQuery {
  page?: number;
  pageSize?: number;
  q?: string;
  sort?: string;
  academicYearId?: string;
  termId?: string;
  classLevelId?: string;
  type?: string;
  status?: string;
}

export const examsApi = {
  // Spread field by field rather than passing the interface straight through: `RequestOptions`
  // takes an index-signature record, and an interface without one is not assignable to it.
  list: (institutionId: string, query: ListExamsQuery) =>
    apiRequest<Paged<Exam>>('/exams', {
      institutionId,
      query: {
        page: query.page,
        pageSize: query.pageSize,
        q: query.q,
        sort: query.sort,
        academicYearId: query.academicYearId,
        termId: query.termId,
        classLevelId: query.classLevelId,
        type: query.type,
        status: query.status,
      },
    }),

  get: (institutionId: string, id: string) =>
    apiRequest<ExamDetail>(`/exams/${id}`, { institutionId }),

  create: (institutionId: string, body: z.infer<typeof createExamSchema>) =>
    apiRequest<Exam>('/exams', { method: 'POST', body, institutionId }),

  /**
   * Only the statuses `exams.manage` owns. The API refuses `under_review` and `published`
   * here on purpose — each is reached through its own permissioned endpoint below, which is
   * the separation of duties this module exists to enforce.
   */
  changeStatus: (institutionId: string, id: string, body: z.infer<typeof changeExamStatusSchema>) =>
    apiRequest<Exam>(`/exams/${id}/status`, { method: 'POST', body, institutionId }),

  archive: (institutionId: string, id: string, reason: string) =>
    apiRequest<Exam>(`/exams/${id}/archive`, { method: 'POST', body: { reason }, institutionId }),

  gradingScales: (institutionId: string) =>
    apiRequest<GradingScaleListRow[]>('/exams/grading-scales', {
      institutionId,
      query: { pageSize: 100 },
    }),

  subjects: (institutionId: string, examId: string, classLevelId?: string) =>
    apiRequest<ExamSubjectRow[]>(`/exams/${examId}/subjects`, {
      institutionId,
      query: { classLevelId },
    }),

  schedules: (
    institutionId: string,
    examId: string,
    query: { examSubjectId?: string; classLevelId?: string; sectionId?: string } = {},
  ) => apiRequest<ExamScheduleRow[]>(`/exams/${examId}/schedules`, { institutionId, query }),

  createSchedule: (
    institutionId: string,
    examId: string,
    body: z.infer<typeof createExamScheduleSchema>,
  ) =>
    apiRequest<ExamSchedule>(`/exams/${examId}/schedules`, { method: 'POST', body, institutionId }),

  marks: (
    institutionId: string,
    examId: string,
    query: {
      examSubjectId?: string;
      sectionId?: string;
      studentId?: string;
      status?: MarkEntryStatus;
    } = {},
  ) => apiRequest<ExamMarkRow[]>(`/exams/${examId}/marks`, { institutionId, query }),

  /** Bulk entry for one paper. One transaction on the API; a partial save is not possible. */
  enterMarks: (institutionId: string, examId: string, body: z.infer<typeof enterExamMarksSchema>) =>
    apiRequest<{ examSubjectId: string; saved: number; marks: ExamMark[] }>(
      `/exams/${examId}/marks`,
      { method: 'PUT', body, institutionId },
    ),

  submitMarks: (
    institutionId: string,
    examId: string,
    body: z.infer<typeof submitExamMarksSchema>,
  ) =>
    apiRequest<{ examSubjectId: string; submitted: number }>(`/exams/${examId}/marks/submit`, {
      method: 'POST',
      body,
      institutionId,
    }),

  /**
   * Change one approved mark.
   *
   * Its own permission (`results.correct`), its own endpoint, a mandatory reason and an
   * optimistic-lock `version`. This is not re-entry: ordinary mark entry refuses an approved
   * row outright, because after approval a mark has been signed off by someone other than the
   * person who entered it.
   */
  correctMark: (
    institutionId: string,
    markId: string,
    body: z.infer<typeof correctExamMarkSchema>,
  ) => apiRequest<ExamMark>(`/exams/marks/${markId}`, { method: 'PATCH', body, institutionId }),

  review: (institutionId: string, examId: string, body: z.infer<typeof reviewExamSchema>) =>
    apiRequest<Exam & { reviewed: number }>(`/exams/${examId}/review`, {
      method: 'POST',
      body,
      institutionId,
    }),

  approve: (institutionId: string, examId: string, body: z.infer<typeof approveExamMarksSchema>) =>
    apiRequest<{ examId: string; approved: number }>(`/exams/${examId}/approve`, {
      method: 'POST',
      body,
      institutionId,
    }),

  publish: (
    institutionId: string,
    examId: string,
    body: z.infer<typeof publishExamResultsSchema>,
  ) =>
    apiRequest<Exam & { published: number }>(`/exams/${examId}/publish`, {
      method: 'POST',
      body,
      institutionId,
    }),

  unpublish: (institutionId: string, examId: string, reason: string) =>
    apiRequest<Exam & { retracted: number }>(`/exams/${examId}/unpublish`, {
      method: 'POST',
      body: { reason },
      institutionId,
    }),

  tabulation: (institutionId: string, examId: string, sectionId: string) =>
    apiRequest<TabulationSheet>(`/exams/${examId}/tabulation`, {
      institutionId,
      query: { sectionId },
    }),

  summary: (
    institutionId: string,
    examId: string,
    query: { classLevelId?: string; sectionId?: string } = {},
  ) => apiRequest<ExamSummary>(`/exams/${examId}/summary`, { institutionId, query }),

  results: (
    institutionId: string,
    examId: string,
    query: {
      page?: number;
      pageSize?: number;
      sectionId?: string;
      classLevelId?: string;
      studentId?: string;
      onlyPassed?: boolean;
    },
  ) => apiRequest<Paged<ResultRow>>(`/exams/${examId}/results`, { institutionId, query }),

  marksheet: (institutionId: string, examId: string, studentId: string) =>
    apiRequest<Marksheet>(`/exams/${examId}/marksheet/${studentId}`, { institutionId }),

  /**
   * The register the mark grid is entered against.
   *
   * `GET /students` with a section filter, which the students module already scopes to the
   * caller — a subject teacher gets their own sections and nothing else. The exam module has
   * no roster endpoint of its own, and inventing a client-side one from the marks that happen
   * to exist would silently omit every student who has not been marked yet, which is exactly
   * the set the teacher is looking for.
   *
   * `pageSize` is the API's maximum. The caller compares `meta.total` against the rows it got
   * and says so on screen if a section somehow exceeds it, rather than quietly marking part
   * of a class.
   */
  sectionRoster: (institutionId: string, sectionId: string) =>
    apiRequest<Paged<StudentSummary>>('/students', {
      institutionId,
      query: { sectionId, status: 'active', pageSize: 200, sort: 'fullNameEn' },
    }),
};
