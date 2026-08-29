/**
 * Typed API surface for the admissions screens (Phase 5).
 *
 * Field names here were read off `apps/api/src/modules/admissions/admissions.service.ts` and
 * `packages/db/src/schema/admissions.ts`, not guessed — the services return the Drizzle rows
 * directly, so the wire shape *is* the table shape.
 *
 * Two shapes worth knowing before writing a screen against this:
 *
 *  - **Money is a decimal string.** `applicationFee` and `feeDue` are `numeric(14,2)` and
 *    arrive as `"1500.00"`. Format with `formatMoney`, send back as a string, never do
 *    arithmetic on them in the browser (ADR-004).
 *  - **The offer chain is not reachable through the status endpoint.** `offered`, `accepted`,
 *    `declined` and `enrolled` belong to the offer routes, because those carry the seat check
 *    under a row lock. So the transition form only ever offers the manual targets.
 */

import type { z } from 'zod';
import type {
  acceptAdmissionOfferSchema,
  changeAdmissionSessionStatusSchema,
  createAdmissionApplicationSchema,
  createAdmissionSessionSchema,
  declineAdmissionOfferSchema,
  issueAdmissionOfferSchema,
  transitionAdmissionApplicationSchema,
} from '@shikkha/validation';
import { apiRequest, type Paged } from '@/lib/api';

// ── Row shapes ───────────────────────────────────────────────────────────────────────

export type AdmissionSessionStatus = 'draft' | 'open' | 'closed' | 'completed';

export type AdmissionApplicationStatus =
  | 'submitted'
  | 'under_review'
  | 'shortlisted'
  | 'test_scheduled'
  | 'tested'
  | 'interviewed'
  | 'selected'
  | 'waitlisted'
  | 'rejected'
  | 'offered'
  | 'accepted'
  | 'declined'
  | 'enrolled'
  | 'withdrawn';

export type AdmissionOfferStatus = 'pending' | 'accepted' | 'declined' | 'expired' | 'withdrawn';

/** One entry of a session's `classCapacity` jsonb: which class, and how many seats. */
export interface ClassCapacityEntry {
  classLevelId: string;
  seats: number;
}

export interface AdmissionSession {
  id: string;
  institutionId: string;
  campusId: string | null;
  academicYearId: string;
  nameEn: string;
  nameBn: string | null;
  applicationStartDate: string;
  applicationEndDate: string;
  /** Decimal string. */
  applicationFee: string;
  classCapacity: ClassCapacityEntry[];
  status: AdmissionSessionStatus;
  version: number;
  archivedAt: string | null;
}

export interface AdmissionApplication {
  id: string;
  institutionId: string;
  sessionId: string;
  classLevelId: string;
  applicationNumber: string;
  applicantNameEn: string;
  applicantNameBn: string | null;
  dateOfBirth: string;
  gender: string;
  birthRegistrationNumber: string | null;
  previousSchoolName: string | null;
  previousClassCompleted: string | null;
  /** GPA on the 5.00 scale, as a decimal string. */
  previousResultGpa: string | null;
  guardianNameEn: string;
  guardianNameBn: string | null;
  guardianRelation: string;
  guardianPhone: string;
  guardianEmail: string | null;
  guardianNid: string | null;
  presentAddress: string | null;
  quota: string | null;
  status: AdmissionApplicationStatus;
  statusChangedAt: string | null;
  statusReason: string | null;
  submittedAt: string;
  source: 'online' | 'counter';
  /** Set exactly once, when acceptance creates the real student record. */
  studentId: string | null;
  version: number;
  archivedAt: string | null;
}

export interface AdmissionDocument {
  id: string;
  applicationId: string;
  storageKey: string;
  documentType: string;
  title: string;
  verifiedBy: string | null;
  verifiedAt: string | null;
  createdAt: string;
}

/** The joined projection `getApplication` returns for test results. */
export interface AdmissionTestResult {
  id: string;
  testId: string;
  testName: string;
  /** Decimal strings — marks are `numeric(6,2)`, like the examinations module. */
  totalMarks: string;
  passMarks: string;
  marksObtained: string | null;
  isAbsent: boolean;
}

export interface AdmissionInterview {
  id: string;
  applicationId: string;
  panelName: string | null;
  scheduledAt: string;
  interviewerEmployeeId: string | null;
  /** 0–100 with two decimals, as a string. Null until the panel scores. */
  score: string | null;
  remarks: string | null;
  scoredAt: string | null;
  version: number;
}

export interface AdmissionOffer {
  id: string;
  applicationId: string;
  offeredAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  declinedAt: string | null;
  /** Decimal string. */
  feeDue: string;
  status: AdmissionOfferStatus;
  notes: string | null;
  version: number;
}

export interface AdmissionApplicationDetail extends AdmissionApplication {
  documents: AdmissionDocument[];
  testResults: AdmissionTestResult[];
  interview: AdmissionInterview | null;
  /** Newest offer first. A re-offer after a decline or expiry is a new row, not an edit. */
  offers: AdmissionOffer[];
}

/** The funnel report, computed in SQL. This is where seats-taken-versus-available comes from. */
export interface AdmissionFunnel {
  sessionId: string;
  sessionName: string;
  sessionStatus: AdmissionSessionStatus;
  totalApplications: number;
  /** Keyed by application status. A status with no applications is absent, not zero. */
  statusCounts: Record<string, number>;
  classLevels: Array<{
    classLevelId: string;
    seats: number;
    applications: number;
    offered: number;
    accepted: number;
    enrolled: number;
    waitlisted: number;
    rejected: number;
    /** seats − accepted − enrolled, floored at zero. Computed by the API, not here. */
    seatsRemaining: number;
  }>;
  conversion: {
    applications: number;
    offered: number;
    accepted: number;
    enrolled: number;
  };
}

export interface ListApplicationsQuery {
  page: number;
  pageSize: number;
  q?: string;
  sessionId?: string;
  classLevelId?: string;
  status?: string;
  source?: string;
  quota?: string;
  sort?: string;
}

// ── Client ───────────────────────────────────────────────────────────────────────────

export const admissionsApi = {
  sessions: (
    institutionId: string,
    query: { page: number; pageSize: number; status?: string; academicYearId?: string } = {
      page: 1,
      pageSize: 50,
    },
  ) => apiRequest<Paged<AdmissionSession>>('/admissions/sessions', { institutionId, query }),

  session: (institutionId: string, id: string) =>
    apiRequest<AdmissionSession>(`/admissions/sessions/${id}`, { institutionId }),

  createSession: (institutionId: string, body: z.input<typeof createAdmissionSessionSchema>) =>
    apiRequest<AdmissionSession>('/admissions/sessions', { method: 'POST', body, institutionId }),

  changeSessionStatus: (
    institutionId: string,
    id: string,
    body: z.input<typeof changeAdmissionSessionStatusSchema>,
  ) =>
    apiRequest<AdmissionSession>(`/admissions/sessions/${id}/status`, {
      method: 'POST',
      body,
      institutionId,
    }),

  funnel: (institutionId: string, sessionId: string) =>
    apiRequest<AdmissionFunnel>(`/admissions/sessions/${sessionId}/funnel`, { institutionId }),

  applications: (institutionId: string, query: ListApplicationsQuery) =>
    apiRequest<Paged<AdmissionApplication>>('/admissions/applications', {
      institutionId,
      query: {
        page: query.page,
        pageSize: query.pageSize,
        q: query.q,
        sessionId: query.sessionId,
        classLevelId: query.classLevelId,
        status: query.status,
        source: query.source,
        quota: query.quota,
        sort: query.sort,
      },
    }),

  createApplication: (
    institutionId: string,
    body: z.input<typeof createAdmissionApplicationSchema>,
  ) =>
    apiRequest<AdmissionApplication>('/admissions/applications', {
      method: 'POST',
      body,
      institutionId,
    }),

  application: (institutionId: string, id: string) =>
    apiRequest<AdmissionApplicationDetail>(`/admissions/applications/${id}`, { institutionId }),

  transition: (
    institutionId: string,
    id: string,
    body: z.input<typeof transitionAdmissionApplicationSchema>,
  ) =>
    apiRequest<AdmissionApplication>(`/admissions/applications/${id}/status`, {
      method: 'POST',
      body,
      institutionId,
    }),

  /** Marks a document checked against the original. There is no un-verify — it is a fact. */
  verifyDocument: (institutionId: string, documentId: string) =>
    apiRequest<AdmissionDocument>(`/admissions/documents/${documentId}/verify`, {
      method: 'POST',
      body: {},
      institutionId,
    }),

  issueOffer: (
    institutionId: string,
    applicationId: string,
    body: z.input<typeof issueAdmissionOfferSchema>,
  ) =>
    apiRequest<{ offer: AdmissionOffer; application: AdmissionApplication }>(
      `/admissions/applications/${applicationId}/offers`,
      { method: 'POST', body, institutionId },
    ),

  /**
   * Accepting an offer creates the student, the guardian and the enrolment, seat-checked
   * under a row lock. It is irreversible; every caller confirms first.
   */
  acceptOffer: (
    institutionId: string,
    offerId: string,
    body: z.input<typeof acceptAdmissionOfferSchema>,
  ) =>
    apiRequest<{
      application: AdmissionApplication;
      studentId: string;
      guardianId: string;
      offerId: string;
    }>(`/admissions/offers/${offerId}/accept`, { method: 'POST', body, institutionId }),

  declineOffer: (
    institutionId: string,
    offerId: string,
    body: z.input<typeof declineAdmissionOfferSchema>,
  ) =>
    apiRequest<{ offer: AdmissionOffer; application: AdmissionApplication }>(
      `/admissions/offers/${offerId}/decline`,
      { method: 'POST', body, institutionId },
    ),

  /** Records that a lapsed offer expired and frees the seat. Refused before the deadline. */
  expireOffer: (institutionId: string, offerId: string) =>
    apiRequest<{ offer: AdmissionOffer; application: AdmissionApplication }>(
      `/admissions/offers/${offerId}/expire`,
      { method: 'POST', body: {}, institutionId },
    ),
};

/**
 * The application state machine, mirrored from `APPLICATION_TRANSITIONS` in the service so the
 * transition dialog offers only moves the API will accept.
 *
 * The offer-chain targets are deliberately absent from every list: they are reachable only
 * through the offer endpoints, which is what makes the seat check unbypassable. A copy of a
 * server-side rule is a liability, so this one is narrow — the API still validates, and an
 * invalid move comes back as a 409 naming both states.
 */
export const MANUAL_TRANSITIONS: Record<AdmissionApplicationStatus, AdmissionApplicationStatus[]> =
  {
    submitted: ['under_review', 'shortlisted', 'rejected', 'withdrawn'],
    under_review: ['shortlisted', 'rejected', 'withdrawn'],
    shortlisted: ['test_scheduled', 'interviewed', 'selected', 'waitlisted', 'rejected', 'withdrawn'],
    test_scheduled: ['tested', 'rejected', 'withdrawn'],
    tested: ['interviewed', 'selected', 'waitlisted', 'rejected', 'withdrawn'],
    interviewed: ['selected', 'waitlisted', 'rejected', 'withdrawn'],
    selected: ['waitlisted', 'rejected', 'withdrawn'],
    waitlisted: ['selected', 'rejected', 'withdrawn'],
    offered: ['withdrawn'],
    accepted: ['withdrawn'],
    declined: ['withdrawn'],
    rejected: [],
    enrolled: [],
    withdrawn: [],
  };

/** Targets that are decisions rather than administration, and need `applications.decide`. */
export const DECISION_TARGETS: ReadonlySet<string> = new Set([
  'selected',
  'waitlisted',
  'rejected',
]);
