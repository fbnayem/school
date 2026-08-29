/**
 * Admissions service (Phase 5): the funnel that produces students and guardians.
 *
 * The properties this file exists to hold:
 *
 *  1. **The public form writes an application and nothing else.** It resolves the school by
 *     public slug and code — never by an internal id — and its response carries no tenant
 *     data. The single `runAsPlatform` call reads exactly one row (the organization id for a
 *     slug) because an anonymous applicant has no tenant context yet.
 *  2. **Status is an explicit state machine.** Every move is validated against
 *     `APPLICATION_TRANSITIONS`; an invalid move is a 409 naming the from and to states.
 *     The offer-chain states (`offered`, `accepted`, `declined`, `enrolled`) are reachable
 *     only through the offer endpoints, so nobody can bypass the seat check by "just
 *     changing the status".
 *  3. **Seats cannot be oversold.** Acceptance locks the session row (`FOR UPDATE`) and
 *     counts acceptances under that lock, so two concurrent acceptances serialize and the
 *     second sees the first.
 *  4. **Merit is deterministic and reproducible.** The ranking runs in SQL with a window
 *     function; the criteria (weights in basis points, quota bonuses) and the tie-break rule
 *     are recorded in the list's `criteria` jsonb. Ties break by: higher test percentage,
 *     then earlier submission, then lower application number — never arbitrarily.
 *  5. **AI never decides admission.** There is no auto-select path anywhere in this module:
 *     every selection, offer and acceptance is an authenticated human action with an audit
 *     record. Merit generation is arithmetic over recorded marks, not a decision.
 */

import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  admissionApplicationDocuments,
  admissionApplications,
  admissionInterviews,
  admissionMeritEntries,
  admissionMeritLists,
  admissionOffers,
  admissionSessions,
  admissionTestResults,
  admissionTests,
  academicYears,
  classLevels,
  guardians,
  institutions,
  organizations,
  students,
} from '@shikkha/db';
import {
  buildOffsetPage,
  ConflictError,
  ForbiddenError,
  Money,
  NotFoundError,
  offsetOf,
  parseSort,
  todayInDhaka,
  uuidv7,
  ValidationError,
  WorkflowStateError,
  type OffsetPage,
  type OffsetPageRequest,
} from '@shikkha/shared';
import { can, type Principal } from '@shikkha/permissions';
import {
  ADMISSION_APPLICATION_SORT_FIELDS,
  type AcceptAdmissionOfferInput,
  type AdmissionApplicationStatus,
  type CreateAdmissionApplicationInput,
  type CreateAdmissionSessionInput,
  type CreateAdmissionTestInput,
  type EnterAdmissionTestResultsInput,
  type GenerateMeritListInput,
  type IssueAdmissionOfferInput,
  type PublicAdmissionApplicationInput,
} from '@shikkha/validation';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { StudentsService } from '../students/students.service';
import { GuardiansService } from '../guardians/guardians.service';
import { currentContext } from '../../common/context/request-context';

type Tx = Parameters<Parameters<DatabaseService['runInTenant']>[0]>[0];
type SessionRow = typeof admissionSessions.$inferSelect;
type ApplicationRow = typeof admissionApplications.$inferSelect;
type OfferRow = typeof admissionOffers.$inferSelect;
type TestRow = typeof admissionTests.$inferSelect;

/** One entry of a session's `classCapacity` jsonb. Shape enforced by Zod on write. */
interface ClassCapacityEntry {
  classLevelId: string;
  seats: number;
}

/**
 * The application state machine. A transition not listed here does not exist; attempting it
 * is a 409 naming both states. Terminal states (`rejected`, `enrolled`) have no exits;
 * `withdrawn` is terminal too but reachable from almost anywhere, because a family may walk
 * away at any point before enrolment.
 */
const APPLICATION_TRANSITIONS: Record<AdmissionApplicationStatus, AdmissionApplicationStatus[]> = {
  submitted: ['under_review', 'shortlisted', 'rejected', 'withdrawn'],
  under_review: ['shortlisted', 'rejected', 'withdrawn'],
  shortlisted: ['test_scheduled', 'interviewed', 'selected', 'waitlisted', 'rejected', 'withdrawn'],
  test_scheduled: ['tested', 'rejected', 'withdrawn'],
  tested: ['interviewed', 'selected', 'waitlisted', 'rejected', 'withdrawn'],
  interviewed: ['selected', 'waitlisted', 'rejected', 'withdrawn'],
  selected: ['offered', 'waitlisted', 'rejected', 'withdrawn'],
  waitlisted: ['selected', 'offered', 'rejected', 'withdrawn'],
  offered: ['accepted', 'declined', 'waitlisted', 'withdrawn'],
  accepted: ['enrolled', 'withdrawn'],
  declined: ['offered', 'withdrawn'],
  rejected: [],
  enrolled: [],
  withdrawn: [],
};

/** Manual targets that are *decisions* and therefore need the decide permission. */
const DECISION_TARGETS: ReadonlySet<string> = new Set(['selected', 'waitlisted', 'rejected']);

const SESSION_TRANSITIONS: Record<SessionRow['status'], SessionRow['status'][]> = {
  draft: ['open'],
  open: ['closed'],
  closed: ['open', 'completed'],
  completed: [],
};

/**
 * The documented tie-break rule, recorded verbatim into every merit list's criteria so the
 * printed list explains its own ordering.
 */
const MERIT_TIE_BREAKER = [
  'aggregateScore desc',
  'testPercent desc',
  'submittedAt asc',
  'applicationNumber asc',
] as const;

export interface ListApplicationsQuery {
  page: number;
  pageSize: number;
  sort?: string;
  q?: string;
  sessionId?: string;
  classLevelId?: string;
  status?: string;
  source?: string;
  quota?: string;
  includeArchived: boolean;
}

export interface ListSessionsQuery {
  page: number;
  pageSize: number;
  status?: string;
  academicYearId?: string;
  includeArchived: boolean;
}

@Injectable()
export class AdmissionsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    // Acceptance creates the *real* records through the owning services, so duplicate
    // detection, code generation and guardian deduplication have exactly one definition.
    private readonly studentsService: StudentsService,
    private readonly guardiansService: GuardiansService,
  ) {}

  // ──────────────────────────────────────────────────────────────────────────────────
  // Sessions
  // ──────────────────────────────────────────────────────────────────────────────────

  async listSessions(
    principal: Principal,
    query: ListSessionsQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<SessionRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [];
      if (!query.includeArchived) filters.push(isNull(admissionSessions.archivedAt));
      const institutionId = currentContext()?.institutionId;
      if (institutionId) filters.push(eq(admissionSessions.institutionId, institutionId));
      if (query.status) {
        filters.push(eq(admissionSessions.status, query.status as SessionRow['status']));
      }
      if (query.academicYearId) {
        filters.push(eq(admissionSessions.academicYearId, query.academicYearId));
      }

      const where = filters.length > 0 ? and(...filters) : undefined;
      const rows = await tx
        .select()
        .from(admissionSessions)
        .where(where)
        .orderBy(desc(admissionSessions.applicationStartDate), asc(admissionSessions.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(admissionSessions)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async createSession(
    principal: Principal,
    institutionId: string,
    input: CreateAdmissionSessionInput,
  ): Promise<SessionRow> {
    return this.db.runInTenant(async (tx) => {
      const [year] = await tx
        .select({ id: academicYears.id })
        .from(academicYears)
        .where(
          and(
            eq(academicYears.id, input.academicYearId),
            eq(academicYears.institutionId, institutionId),
            isNull(academicYears.archivedAt),
          ),
        )
        .limit(1);
      if (!year) throw new NotFoundError('Academic year', input.academicYearId);

      await this.assertClassLevelsBelong(
        tx,
        institutionId,
        input.classCapacity.map((entry) => entry.classLevelId),
      );

      const [created] = await tx
        .insert(admissionSessions)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          campusId: input.campusId ?? null,
          academicYearId: input.academicYearId,
          nameEn: input.nameEn,
          nameBn: input.nameBn ?? null,
          applicationStartDate: input.applicationStartDate,
          applicationEndDate: input.applicationEndDate,
          // Normalised through Money so the stored string always carries two decimals.
          applicationFee: Money.fromDecimalString(input.applicationFee).toDecimalString(),
          classCapacity: input.classCapacity,
          status: 'draft',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      if (!created) throw new ConflictError('The admission session could not be created');
      return created;
    });
  }

  async getSession(principal: Principal, id: string): Promise<SessionRow> {
    const row = await this.db.runInTenant(async (tx) => {
      const [found] = await tx
        .select()
        .from(admissionSessions)
        .where(eq(admissionSessions.id, id))
        .limit(1);
      return found ?? null;
    });
    // Cross-tenant ids vanish under RLS, so this is a 404 — never a 403.
    if (!row) throw new NotFoundError('Admission session', id);
    return row;
  }

  async updateSession(
    principal: Principal,
    id: string,
    input: Record<string, unknown>,
  ): Promise<{ session: SessionRow; previous: Partial<SessionRow> }> {
    const version = input['version'] as number;
    const { version: _ignored, ...changes } = input;

    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(admissionSessions)
        .where(and(eq(admissionSessions.id, id), isNull(admissionSessions.archivedAt)))
        .limit(1);
      if (!existing) throw new NotFoundError('Admission session', id);

      if (existing.status === 'completed') {
        throw new ConflictError('A completed admission session can no longer be edited.');
      }

      if (changes['classCapacity']) {
        await this.assertClassLevelsBelong(
          tx,
          existing.institutionId,
          (changes['classCapacity'] as ClassCapacityEntry[]).map((entry) => entry.classLevelId),
        );
      }
      if (changes['applicationFee']) {
        changes['applicationFee'] = Money.fromDecimalString(
          changes['applicationFee'] as string,
        ).toDecimalString();
      }

      const [updated] = await tx
        .update(admissionSessions)
        .set({
          ...(changes as Partial<SessionRow>),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(admissionSessions.id, id), eq(admissionSessions.version, version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This session was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      const previous: Partial<SessionRow> = {};
      for (const key of Object.keys(changes)) {
        const typedKey = key as keyof SessionRow;
        if (existing[typedKey] !== updated[typedKey]) {
          (previous as Record<string, unknown>)[key] = existing[typedKey];
        }
      }
      return { session: updated, previous };
    });
  }

  async changeSessionStatus(
    principal: Principal,
    id: string,
    status: SessionRow['status'],
  ): Promise<{ session: SessionRow; previousStatus: SessionRow['status'] }> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(admissionSessions)
        .where(and(eq(admissionSessions.id, id), isNull(admissionSessions.archivedAt)))
        .limit(1);
      if (!existing) throw new NotFoundError('Admission session', id);

      if (!SESSION_TRANSITIONS[existing.status].includes(status)) {
        throw new WorkflowStateError(existing.status, status, 'admission session');
      }

      const [updated] = await tx
        .update(admissionSessions)
        .set({ status, version: existing.version + 1, updatedBy: principal.userId })
        .where(eq(admissionSessions.id, id))
        .returning();

      return { session: updated!, previousStatus: existing.status };
    });
  }

  // ──────────────────────────────────────────────────────────────────────────────────
  // Public application submission — the only unauthenticated write in the platform
  // ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Submit an application from the public form.
   *
   * Writes one application in `submitted` status and nothing else. The response carries the
   * application number and a human-readable confirmation — no ids, no tenant data.
   */
  async submitPublicApplication(input: PublicAdmissionApplicationInput): Promise<{
    applicationNumber: string;
    applicantNameEn: string;
    sessionName: string;
    classLevelCode: string;
    submittedAt: Date;
  }> {
    // runAsPlatform is justified here the same way it is for login: the caller is anonymous
    // and the tenant is not yet known. This transaction reads exactly one row — the
    // organization id behind a public slug — and everything after it runs inside that
    // tenant's RLS context.
    const org = await this.db.runAsPlatform(async (tx) => {
      const [row] = await tx
        .select({
          id: organizations.id,
          isActive: organizations.isActive,
          suspendedAt: organizations.suspendedAt,
        })
        .from(organizations)
        .where(
          and(eq(organizations.slug, input.organizationSlug), isNull(organizations.archivedAt)),
        )
        .limit(1);
      return row ?? null;
    });

    // Every failure below is the same 404: the form must not become a probe for which
    // schools, codes or sessions exist.
    if (!org || !org.isActive || org.suspendedAt) {
      throw new NotFoundError('Open admission session');
    }

    const result = await this.db.runInTenantId(org.id, async (tx) => {
      const institution = await this.resolveInstitutionByCode(tx, input.institutionCode);
      if (!institution) throw new NotFoundError('Open admission session');

      const [classLevel] = await tx
        .select({ id: classLevels.id, code: classLevels.code })
        .from(classLevels)
        .where(
          and(
            eq(classLevels.institutionId, institution.id),
            ilike(classLevels.code, input.classLevelCode),
            isNull(classLevels.archivedAt),
          ),
        )
        .limit(1);
      if (!classLevel) throw new NotFoundError('Open admission session');

      const today = todayInDhaka();
      const [session] = await tx
        .select()
        .from(admissionSessions)
        .where(
          and(
            eq(admissionSessions.institutionId, institution.id),
            eq(admissionSessions.status, 'open'),
            isNull(admissionSessions.archivedAt),
            sql`${admissionSessions.applicationStartDate} <= ${today}`,
            sql`${admissionSessions.applicationEndDate} >= ${today}`,
            // The session must be open for the requested class level.
            sql`${admissionSessions.classCapacity} @> ${JSON.stringify([
              { classLevelId: classLevel.id },
            ])}::jsonb`,
          ),
        )
        .orderBy(desc(admissionSessions.applicationStartDate))
        .limit(1);
      if (!session) throw new NotFoundError('Open admission session');

      // One live application per child per cycle; the partial unique index is the backstop.
      const [duplicate] = await tx
        .select({ id: admissionApplications.id })
        .from(admissionApplications)
        .where(
          and(
            eq(admissionApplications.sessionId, session.id),
            ilike(admissionApplications.applicantNameEn, input.applicantNameEn),
            eq(admissionApplications.dateOfBirth, input.dateOfBirth),
            sql`${admissionApplications.status} <> 'withdrawn'`,
            isNull(admissionApplications.archivedAt),
          ),
        )
        .limit(1);
      if (duplicate) {
        throw new ConflictError(
          'An application for this applicant has already been submitted to this admission session.',
        );
      }

      const applicationNumber = await this.nextApplicationNumber(tx, institution.id);
      const [created] = await tx
        .insert(admissionApplications)
        .values({
          id: uuidv7(),
          tenantId: org.id,
          institutionId: institution.id,
          sessionId: session.id,
          classLevelId: classLevel.id,
          applicationNumber,
          ...this.applicantColumns(input),
          status: 'submitted',
          source: 'online',
          createdBy: null,
        })
        .returning();

      return {
        applicationId: created!.id,
        applicationNumber: created!.applicationNumber,
        applicantNameEn: created!.applicantNameEn,
        sessionName: session.nameEn,
        classLevelCode: classLevel.code,
        submittedAt: created!.submittedAt,
      };
    });

    // Written by the service rather than the interceptor because the route is public: the
    // interceptor has no tenant context to stamp, but the record must still exist — a
    // mutation without an audit record is incomplete.
    await this.audit.record({
      tenantId: org.id,
      actorUserId: null,
      action: 'create',
      module: 'admissions',
      resourceType: 'admission_application',
      resourceId: result.applicationId,
      resourceLabel: result.applicationNumber,
      newValue: { source: 'online', applicationNumber: result.applicationNumber },
    });

    const { applicationId: _hidden, ...publicView } = result;
    return publicView;
  }

  // ──────────────────────────────────────────────────────────────────────────────────
  // Applications (staff)
  // ──────────────────────────────────────────────────────────────────────────────────

  async createApplication(
    principal: Principal,
    institutionId: string,
    input: CreateAdmissionApplicationInput,
  ): Promise<ApplicationRow> {
    return this.db.runInTenant(async (tx) => {
      const [session] = await tx
        .select()
        .from(admissionSessions)
        .where(
          and(
            eq(admissionSessions.id, input.sessionId),
            eq(admissionSessions.institutionId, institutionId),
            isNull(admissionSessions.archivedAt),
          ),
        )
        .limit(1);
      if (!session) throw new NotFoundError('Admission session', input.sessionId);
      if (session.status !== 'open') {
        throw new ConflictError('This admission session is not open for applications.');
      }
      if (!this.capacityFor(session, input.classLevelId)) {
        throw new ValidationError('That class level is not open in this admission session', [
          { path: 'classLevelId', message: 'Class level is not open in this session' },
        ]);
      }

      const [duplicate] = await tx
        .select({ id: admissionApplications.id })
        .from(admissionApplications)
        .where(
          and(
            eq(admissionApplications.sessionId, session.id),
            ilike(admissionApplications.applicantNameEn, input.applicantNameEn),
            eq(admissionApplications.dateOfBirth, input.dateOfBirth),
            sql`${admissionApplications.status} <> 'withdrawn'`,
            isNull(admissionApplications.archivedAt),
          ),
        )
        .limit(1);
      if (duplicate) {
        throw new ConflictError(
          'An application for this applicant has already been submitted to this admission session.',
          { existingApplicationId: duplicate.id },
        );
      }

      const applicationNumber = await this.nextApplicationNumber(tx, institutionId);
      const [created] = await tx
        .insert(admissionApplications)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          sessionId: session.id,
          classLevelId: input.classLevelId,
          applicationNumber,
          ...this.applicantColumns(input),
          status: 'submitted',
          source: 'counter',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      return created!;
    });
  }

  async listApplications(
    principal: Principal,
    query: ListApplicationsQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<ApplicationRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [];
      if (!query.includeArchived) filters.push(isNull(admissionApplications.archivedAt));
      const institutionId = currentContext()?.institutionId;
      if (institutionId) filters.push(eq(admissionApplications.institutionId, institutionId));
      if (query.sessionId) filters.push(eq(admissionApplications.sessionId, query.sessionId));
      if (query.classLevelId) {
        filters.push(eq(admissionApplications.classLevelId, query.classLevelId));
      }
      if (query.status) {
        filters.push(eq(admissionApplications.status, query.status as ApplicationRow['status']));
      }
      if (query.source) {
        filters.push(eq(admissionApplications.source, query.source as ApplicationRow['source']));
      }
      if (query.quota) filters.push(eq(admissionApplications.quota, query.quota));
      if (query.q) {
        const trimmed = query.q.trim();
        filters.push(
          or(
            sql`${admissionApplications}.search_vector @@ websearch_to_tsquery('simple', ${trimmed})`,
            ilike(admissionApplications.applicationNumber, `${trimmed}%`),
          )!,
        );
      }

      const where = filters.length > 0 ? and(...filters) : undefined;
      const orderBy = parseSort(query.sort, ADMISSION_APPLICATION_SORT_FIELDS, {
        field: 'submittedAt',
        direction: 'desc',
      }).map((spec) => {
        const column = APPLICATION_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(admissionApplications)
        .where(where)
        .orderBy(...orderBy, asc(admissionApplications.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(admissionApplications)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  /** One application with everything attached to it: documents, results, interview, offers. */
  async getApplication(principal: Principal, id: string) {
    return this.db.runInTenant(async (tx) => {
      const [application] = await tx
        .select()
        .from(admissionApplications)
        .where(eq(admissionApplications.id, id))
        .limit(1);
      if (!application) throw new NotFoundError('Admission application', id);

      const documents = await tx
        .select()
        .from(admissionApplicationDocuments)
        .where(
          and(
            eq(admissionApplicationDocuments.applicationId, id),
            isNull(admissionApplicationDocuments.archivedAt),
          ),
        )
        .orderBy(asc(admissionApplicationDocuments.createdAt));

      const testResults = await tx
        .select({
          id: admissionTestResults.id,
          testId: admissionTestResults.testId,
          testName: admissionTests.nameEn,
          totalMarks: admissionTests.totalMarks,
          passMarks: admissionTests.passMarks,
          marksObtained: admissionTestResults.marksObtained,
          isAbsent: admissionTestResults.isAbsent,
        })
        .from(admissionTestResults)
        .innerJoin(admissionTests, eq(admissionTests.id, admissionTestResults.testId))
        .where(
          and(eq(admissionTestResults.applicationId, id), isNull(admissionTestResults.archivedAt)),
        )
        .orderBy(asc(admissionTests.testDate));

      const [interview] = await tx
        .select()
        .from(admissionInterviews)
        .where(
          and(eq(admissionInterviews.applicationId, id), isNull(admissionInterviews.archivedAt)),
        )
        .limit(1);

      const offers = await tx
        .select()
        .from(admissionOffers)
        .where(and(eq(admissionOffers.applicationId, id), isNull(admissionOffers.archivedAt)))
        .orderBy(desc(admissionOffers.offeredAt));

      return { ...application, documents, testResults, interview: interview ?? null, offers };
    });
  }

  /**
   * The generic, human-driven transition. Offer-chain states are refused here — they belong
   * to the offer endpoints, which carry the seat check.
   */
  async transition(
    principal: Principal,
    id: string,
    status: AdmissionApplicationStatus,
    reason: string,
  ): Promise<{ application: ApplicationRow; previousStatus: string }> {
    if (DECISION_TARGETS.has(status) && !can(principal, 'admissions.applications.decide')) {
      throw new ForbiddenError(
        'admissions.applications.decide',
        'Deciding an application requires the decide permission',
      );
    }

    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(admissionApplications)
        .where(and(eq(admissionApplications.id, id), isNull(admissionApplications.archivedAt)))
        .limit(1);
      if (!existing) throw new NotFoundError('Admission application', id);

      this.assertTransition(existing.status, status);

      const [updated] = await tx
        .update(admissionApplications)
        .set({
          status,
          statusChangedAt: new Date(),
          statusReason: reason,
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(admissionApplications.id, id))
        .returning();

      return { application: updated!, previousStatus: existing.status };
    });
  }

  // ──────────────────────────────────────────────────────────────────────────────────
  // Documents
  // ──────────────────────────────────────────────────────────────────────────────────

  async addDocument(
    principal: Principal,
    applicationId: string,
    input: { storageKey: string; documentType: string; title: string },
  ) {
    return this.db.runInTenant(async (tx) => {
      const application = await this.requireApplication(tx, applicationId);

      const [created] = await tx
        .insert(admissionApplicationDocuments)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId: application.institutionId,
          applicationId,
          storageKey: input.storageKey,
          documentType: input.documentType,
          title: input.title,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      return created!;
    });
  }

  async verifyDocument(principal: Principal, documentId: string) {
    return this.db.runInTenant(async (tx) => {
      const [document] = await tx
        .select()
        .from(admissionApplicationDocuments)
        .where(
          and(
            eq(admissionApplicationDocuments.id, documentId),
            isNull(admissionApplicationDocuments.archivedAt),
          ),
        )
        .limit(1);
      if (!document) throw new NotFoundError('Admission document', documentId);
      if (document.verifiedAt) {
        throw new ConflictError('This document has already been verified.');
      }

      const [updated] = await tx
        .update(admissionApplicationDocuments)
        .set({
          verifiedAt: new Date(),
          verifiedBy: principal.userId,
          updatedBy: principal.userId,
        })
        .where(eq(admissionApplicationDocuments.id, documentId))
        .returning();

      return updated!;
    });
  }

  // ──────────────────────────────────────────────────────────────────────────────────
  // Tests and results
  // ──────────────────────────────────────────────────────────────────────────────────

  async listTests(principal: Principal, sessionId: string): Promise<TestRow[]> {
    return this.db.runInTenant(async (tx) => {
      await this.requireSession(tx, sessionId);
      return tx
        .select()
        .from(admissionTests)
        .where(and(eq(admissionTests.sessionId, sessionId), isNull(admissionTests.archivedAt)))
        .orderBy(asc(admissionTests.testDate), asc(admissionTests.nameEn));
    });
  }

  async createTest(
    principal: Principal,
    sessionId: string,
    input: CreateAdmissionTestInput,
  ): Promise<TestRow> {
    return this.db.runInTenant(async (tx) => {
      const session = await this.requireSession(tx, sessionId);
      if (session.status === 'completed') {
        throw new ConflictError('This admission session is already completed.');
      }
      if (input.classLevelId && !this.capacityFor(session, input.classLevelId)) {
        throw new ValidationError('That class level is not open in this admission session', [
          { path: 'classLevelId', message: 'Class level is not open in this session' },
        ]);
      }

      const [created] = await tx
        .insert(admissionTests)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId: session.institutionId,
          sessionId,
          classLevelId: input.classLevelId ?? null,
          nameEn: input.nameEn,
          nameBn: input.nameBn ?? null,
          testDate: input.testDate,
          startTime: input.startTime ?? null,
          totalMarks: input.totalMarks,
          passMarks: input.passMarks,
          venue: input.venue ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      return created!;
    });
  }

  async updateTest(
    principal: Principal,
    testId: string,
    input: Record<string, unknown>,
  ): Promise<{ test: TestRow; previous: Partial<TestRow> }> {
    const version = input['version'] as number;
    const { version: _ignored, ...changes } = input;

    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(admissionTests)
        .where(and(eq(admissionTests.id, testId), isNull(admissionTests.archivedAt)))
        .limit(1);
      if (!existing) throw new NotFoundError('Admission test', testId);

      const totalMarks = (changes['totalMarks'] as string | undefined) ?? existing.totalMarks;
      const passMarks = (changes['passMarks'] as string | undefined) ?? existing.passMarks;
      if (Number(passMarks) > Number(totalMarks)) {
        throw new ValidationError('Pass marks cannot exceed total marks', [
          { path: 'passMarks', message: 'Pass marks cannot exceed total marks' },
        ]);
      }

      const [updated] = await tx
        .update(admissionTests)
        .set({
          ...(changes as Partial<TestRow>),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(admissionTests.id, testId), eq(admissionTests.version, version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This test was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      const previous: Partial<TestRow> = {};
      for (const key of Object.keys(changes)) {
        const typedKey = key as keyof TestRow;
        if (existing[typedKey] !== updated[typedKey]) {
          (previous as Record<string, unknown>)[key] = existing[typedKey];
        }
      }
      return { test: updated, previous };
    });
  }

  /**
   * Enter or correct marks for a test. Upserts per candidate, records who keyed the marks,
   * and refuses marks above the test's total. Entering results never moves an application's
   * status — that is a separate, reasoned, audited transition.
   */
  async enterTestResults(
    principal: Principal,
    testId: string,
    input: EnterAdmissionTestResultsInput,
  ) {
    return this.db.runInTenant(async (tx) => {
      const [test] = await tx
        .select()
        .from(admissionTests)
        .where(and(eq(admissionTests.id, testId), isNull(admissionTests.archivedAt)))
        .limit(1);
      if (!test) throw new NotFoundError('Admission test', testId);

      const applicationIds = input.results.map((row) => row.applicationId);
      const validApplications = await tx
        .select({ id: admissionApplications.id })
        .from(admissionApplications)
        .where(
          and(
            inArray(admissionApplications.id, applicationIds),
            eq(admissionApplications.sessionId, test.sessionId),
            isNull(admissionApplications.archivedAt),
          ),
        );
      const validIds = new Set(validApplications.map((row) => row.id));
      for (const row of input.results) {
        if (!validIds.has(row.applicationId)) {
          throw new NotFoundError('Admission application', row.applicationId);
        }
        if (
          row.marksObtained !== undefined &&
          Number(row.marksObtained) > Number(test.totalMarks)
        ) {
          throw new ValidationError(`Marks cannot exceed the test total of ${test.totalMarks}`, [
            { path: 'results', message: `Marks above the total for ${row.applicationId}` },
          ]);
        }
      }

      const saved = [];
      for (const row of input.results) {
        const [existing] = await tx
          .select({ id: admissionTestResults.id })
          .from(admissionTestResults)
          .where(
            and(
              eq(admissionTestResults.testId, testId),
              eq(admissionTestResults.applicationId, row.applicationId),
              isNull(admissionTestResults.archivedAt),
            ),
          )
          .limit(1);

        if (existing) {
          const [updated] = await tx
            .update(admissionTestResults)
            .set({
              marksObtained: row.isAbsent ? null : (row.marksObtained ?? null),
              isAbsent: row.isAbsent,
              enteredBy: principal.userId,
              updatedBy: principal.userId,
            })
            .where(eq(admissionTestResults.id, existing.id))
            .returning();
          saved.push(updated!);
        } else {
          const [created] = await tx
            .insert(admissionTestResults)
            .values({
              id: uuidv7(),
              tenantId: principal.tenantId!,
              institutionId: test.institutionId,
              testId,
              applicationId: row.applicationId,
              marksObtained: row.isAbsent ? null : (row.marksObtained ?? null),
              isAbsent: row.isAbsent,
              enteredBy: principal.userId,
              createdBy: principal.userId,
              updatedBy: principal.userId,
            })
            .returning();
          saved.push(created!);
        }
      }

      return { testId, saved: saved.length, results: saved };
    });
  }

  // ──────────────────────────────────────────────────────────────────────────────────
  // Interviews
  // ──────────────────────────────────────────────────────────────────────────────────

  async scheduleInterview(
    principal: Principal,
    applicationId: string,
    input: { scheduledAt: Date; panelName?: string; interviewerEmployeeId?: string },
  ) {
    return this.db.runInTenant(async (tx) => {
      const application = await this.requireApplication(tx, applicationId);
      if (['rejected', 'withdrawn', 'declined', 'enrolled'].includes(application.status)) {
        throw new ConflictError(
          `An interview cannot be scheduled for a ${application.status} application.`,
        );
      }

      const [existing] = await tx
        .select({ id: admissionInterviews.id })
        .from(admissionInterviews)
        .where(
          and(
            eq(admissionInterviews.applicationId, applicationId),
            isNull(admissionInterviews.archivedAt),
          ),
        )
        .limit(1);
      if (existing) {
        throw new ConflictError('An interview is already scheduled for this application.');
      }

      const [created] = await tx
        .insert(admissionInterviews)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId: application.institutionId,
          applicationId,
          panelName: input.panelName ?? null,
          scheduledAt: input.scheduledAt,
          interviewerEmployeeId: input.interviewerEmployeeId ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      return created!;
    });
  }

  async scoreInterview(
    principal: Principal,
    interviewId: string,
    input: { score: string; remarks?: string; version: number },
  ) {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(admissionInterviews)
        .where(and(eq(admissionInterviews.id, interviewId), isNull(admissionInterviews.archivedAt)))
        .limit(1);
      if (!existing) throw new NotFoundError('Admission interview', interviewId);

      const [updated] = await tx
        .update(admissionInterviews)
        .set({
          score: input.score,
          remarks: input.remarks ?? null,
          scoredAt: new Date(),
          scoredBy: principal.userId,
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(
          and(
            eq(admissionInterviews.id, interviewId),
            eq(admissionInterviews.version, input.version),
          ),
        )
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This interview was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: input.version, currentVersion: existing.version },
        );
      }

      return { interview: updated, previousScore: existing.score };
    });
  }

  // ──────────────────────────────────────────────────────────────────────────────────
  // Merit lists
  // ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Generate a merit list — a preview, not a publication.
   *
   * The whole ranking happens in one SQL statement so it is deterministic and reproducible:
   * `row_number()` over a total order whose final key (application number) is unique, so two
   * runs over the same data produce identical ranks. The formula, on a 0–100 scale:
   *
   *   aggregate = testPercent    × testWeightBp/10000
   *             + interviewScore × interviewWeightBp/10000
   *             + gpa/5 × 100    × previousResultWeightBp/10000
   *             + quotaBonus(quota)
   *
   * Absent candidates score 0 on that test; a missing interview or GPA scores 0 for that
   * component. Ties break by higher test percentage, then earlier submission, then lower
   * application number — the rule is recorded in the criteria jsonb.
   */
  async generateMeritList(principal: Principal, sessionId: string, input: GenerateMeritListInput) {
    return this.db.runInTenant(async (tx) => {
      const session = await this.requireSession(tx, sessionId);
      const capacity = this.capacityFor(session, input.classLevelId);
      if (!capacity) {
        throw new ValidationError('That class level is not open in this admission session', [
          { path: 'classLevelId', message: 'Class level is not open in this session' },
        ]);
      }

      const listId = uuidv7();
      const criteria = {
        ...input.criteria,
        tieBreaker: [...MERIT_TIE_BREAKER],
        seats: capacity.seats,
      };

      const [list] = await tx
        .insert(admissionMeritLists)
        .values({
          id: listId,
          tenantId: principal.tenantId!,
          institutionId: session.institutionId,
          sessionId,
          classLevelId: input.classLevelId,
          nameEn: input.name,
          nameBn: input.nameBn ?? null,
          criteria,
          generatedBy: principal.userId,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      const quotaBonuses = JSON.stringify(input.criteria.quotaBonuses ?? {});

      // Deterministic ranking in SQL. `row_number()` (not `rank()`): the ORDER BY ends on
      // the unique application number, so the order is total and every run agrees.
      await tx.execute(sql`
        with candidates as (
          select
            a.id,
            a.tenant_id,
            a.institution_id,
            a.quota,
            a.submitted_at,
            a.application_number,
            coalesce(a.previous_result_gpa / 5.0 * 100.0, 0) as prev_pct
          from admission_applications a
          where a.session_id = ${sessionId}
            and a.class_level_id = ${input.classLevelId}
            and a.archived_at is null
            and a.status in
              ('shortlisted', 'test_scheduled', 'tested', 'interviewed', 'selected', 'waitlisted')
        ),
        test_scores as (
          select
            r.application_id,
            avg(
              case when r.is_absent then 0
                   else coalesce(r.marks_obtained, 0) / t.total_marks * 100.0
              end
            ) as test_pct
          from admission_test_results r
          join admission_tests t on t.id = r.test_id
          where t.session_id = ${sessionId}
            and (t.class_level_id is null or t.class_level_id = ${input.classLevelId})
            and r.archived_at is null
            and t.archived_at is null
          group by r.application_id
        ),
        interview_scores as (
          select i.application_id, max(i.score) as interview_score
          from admission_interviews i
          where i.archived_at is null and i.score is not null
          group by i.application_id
        ),
        scored as (
          select
            c.id as application_id,
            c.tenant_id,
            c.institution_id,
            c.submitted_at,
            c.application_number,
            round(coalesce(ts.test_pct, 0)::numeric, 4) as test_pct,
            round(coalesce(isc.interview_score, 0)::numeric, 4) as interview_score,
            round(c.prev_pct::numeric, 4) as prev_pct,
            round(
              (
                coalesce(ts.test_pct, 0) * ${input.criteria.testWeightBp} / 10000.0
                + coalesce(isc.interview_score, 0) * ${input.criteria.interviewWeightBp} / 10000.0
                + c.prev_pct * ${input.criteria.previousResultWeightBp} / 10000.0
                + coalesce((${quotaBonuses}::jsonb ->> c.quota)::numeric, 0)
              )::numeric,
              4
            ) as aggregate
          from candidates c
          left join test_scores ts on ts.application_id = c.id
          left join interview_scores isc on isc.application_id = c.id
        )
        insert into admission_merit_entries
          (tenant_id, institution_id, merit_list_id, application_id,
           rank, aggregate_score, components, is_waitlisted, created_by, updated_by)
        select
          tenant_id,
          institution_id,
          ${listId},
          application_id,
          row_number() over w,
          aggregate,
          jsonb_build_object(
            'testPercent', test_pct,
            'interviewScore', interview_score,
            'previousResultPercent', prev_pct
          ),
          (row_number() over w) > ${capacity.seats},
          ${principal.userId},
          ${principal.userId}
        from scored
        window w as (
          order by aggregate desc, test_pct desc, submitted_at asc, application_number asc
        )
      `);

      const entries = await this.meritEntriesFor(tx, listId);
      return { ...list!, entries };
    });
  }

  async getMeritList(principal: Principal, id: string) {
    return this.db.runInTenant(async (tx) => {
      const [list] = await tx
        .select()
        .from(admissionMeritLists)
        .where(and(eq(admissionMeritLists.id, id), isNull(admissionMeritLists.archivedAt)))
        .limit(1);
      if (!list) throw new NotFoundError('Merit list', id);
      const entries = await this.meritEntriesFor(tx, id);
      return { ...list, entries };
    });
  }

  /** Publishing is the separate, audited act that makes a generated list official. */
  async publishMeritList(principal: Principal, id: string) {
    return this.db.runInTenant(async (tx) => {
      const [list] = await tx
        .select()
        .from(admissionMeritLists)
        .where(and(eq(admissionMeritLists.id, id), isNull(admissionMeritLists.archivedAt)))
        .limit(1);
      if (!list) throw new NotFoundError('Merit list', id);
      if (list.publishedAt) {
        throw new ConflictError('This merit list has already been published.');
      }

      const [updated] = await tx
        .update(admissionMeritLists)
        .set({
          publishedAt: new Date(),
          publishedBy: principal.userId,
          version: list.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(admissionMeritLists.id, id))
        .returning();

      return updated!;
    });
  }

  // ──────────────────────────────────────────────────────────────────────────────────
  // Offers
  // ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Issue an offer. Locks the session row and refuses to offer beyond the class level's
   * seat count — candidates beyond it stay on the waitlist until a seat frees up.
   */
  async issueOffer(
    principal: Principal,
    applicationId: string,
    input: IssueAdmissionOfferInput,
  ): Promise<{ offer: OfferRow; application: ApplicationRow }> {
    return this.db.runInTenant(async (tx) => {
      const application = await this.requireApplication(tx, applicationId);
      this.assertTransition(application.status, 'offered');

      const session = await this.lockSession(tx, application.sessionId);
      const capacity = this.capacityFor(session, application.classLevelId);
      if (!capacity) {
        throw new ConflictError('That class level is not open in this admission session.');
      }

      const committed = await this.countSeatsTaken(tx, session.id, application.classLevelId, [
        'offered',
        'accepted',
        'enrolled',
      ]);
      if (committed >= capacity.seats) {
        throw new ConflictError(
          `All ${capacity.seats} seats for this class level already have a live offer or ` +
            `acceptance. Keep the applicant on the waitlist until a seat frees up.`,
        );
      }

      const feeDue = Money.fromDecimalString(input.feeDue ?? '0.00').toDecimalString();
      const expiresAt = new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);

      const [offer] = await tx
        .insert(admissionOffers)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId: application.institutionId,
          applicationId,
          expiresAt,
          feeDue,
          status: 'pending',
          notes: input.notes ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      const [updatedApplication] = await tx
        .update(admissionApplications)
        .set({
          status: 'offered',
          statusChangedAt: new Date(),
          statusReason: `Offer issued, expires ${expiresAt.toISOString()}`,
          version: application.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(admissionApplications.id, applicationId))
        .returning();

      return { offer: offer!, application: updatedApplication! };
    });
  }

  /**
   * Accept an offer: the moment an applicant becomes a student.
   *
   * The flow, and why it is ordered this way:
   *
   *  1. A read-only pass validates everything that can be validated — offer pending and not
   *     expired, application `offered`, no likely-duplicate student — so the common failures
   *     happen before anything is written at all.
   *  2. The guardian record is created (or reused — deduplication by phone through the
   *     guardian service). A guardian row alone is benign and idempotent on retry.
   *  3. Under a `FOR UPDATE` lock on the session row, the seat count is re-checked and the
   *     offer and application are marked accepted. Two concurrent acceptances serialize
   *     here; the second sees the first's acceptance and gets a 409.
   *  4. The student (with the enrolment) is created through `StudentsService.create`, which
   *     is itself one transaction including its own duplicate detection. If it fails, the
   *     acceptance from step 3 is reverted in a compensating transaction and the error is
   *     rethrown — nothing observable remains.
   *  5. The student id is stamped, the guardian is linked, and the application moves to
   *     `enrolled`.
   */
  async acceptOffer(principal: Principal, offerId: string, input: AcceptAdmissionOfferInput) {
    // Phase 1 — read-only validation, so the common failures write nothing.
    const context = await this.db.runInTenant(async (tx) => {
      const offer = await this.requireOffer(tx, offerId);
      const application = await this.requireApplication(tx, offer.applicationId);
      const session = await this.requireSession(tx, application.sessionId);
      this.assertOfferAcceptable(offer, application);

      await this.assertNoDuplicateStudent(tx, application);
      return { offer, application, session };
    });

    const { application, session } = context;

    // Phase 2 — guardian record, deduplicated by phone through the guardian service.
    const guardianId = await this.resolveGuardian(principal, application);

    // Phase 3 — the seat gate. Everything in one transaction under the session row lock.
    await this.db.runInTenant(async (tx) => {
      const lockedSession = await this.lockSession(tx, session.id);
      const offer = await this.requireOffer(tx, offerId);
      const freshApplication = await this.requireApplication(tx, application.id);
      this.assertOfferAcceptable(offer, freshApplication);

      const capacity = this.capacityFor(lockedSession, freshApplication.classLevelId);
      if (!capacity) {
        throw new ConflictError('That class level is not open in this admission session.');
      }
      const taken = await this.countSeatsTaken(tx, session.id, freshApplication.classLevelId, [
        'accepted',
        'enrolled',
      ]);
      if (taken >= capacity.seats) {
        throw new ConflictError(
          `All ${capacity.seats} seats for this class level are already taken. ` +
            `The applicant stays on the waitlist until a seat frees up.`,
        );
      }

      await tx
        .update(admissionOffers)
        .set({
          status: 'accepted',
          acceptedAt: new Date(),
          version: offer.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(admissionOffers.id, offerId));

      await tx
        .update(admissionApplications)
        .set({
          status: 'accepted',
          statusChangedAt: new Date(),
          statusReason: 'Offer accepted',
          version: freshApplication.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(admissionApplications.id, application.id));
    });

    // Phase 4 — the student, through the owning service (one transaction, including the
    // enrolment and the canonical duplicate detection). On failure the acceptance above is
    // reverted, so a failed acceptance leaves no trace.
    let student: { id: string };
    try {
      student = await this.studentsService.create(principal, application.institutionId, {
        admissionDate: input.admissionDate ?? todayInDhaka(),
        fullNameEn: application.applicantNameEn,
        fullNameBn: application.applicantNameBn ?? undefined,
        dateOfBirth: application.dateOfBirth,
        gender: application.gender,
        birthRegistrationNumber: application.birthRegistrationNumber ?? undefined,
        fatherNameEn:
          application.guardianRelation === 'father' ? application.guardianNameEn : undefined,
        motherNameEn:
          application.guardianRelation === 'mother' ? application.guardianNameEn : undefined,
        presentAddress: application.presentAddress ?? undefined,
        previousInstitutionName: application.previousSchoolName ?? undefined,
        previousClassCompleted: application.previousClassCompleted ?? undefined,
        enrollment: {
          academicYearId: session.academicYearId,
          sectionId: input.sectionId,
          rollNumber: input.rollNumber,
        },
      });
    } catch (error) {
      await this.revertAcceptance(principal, offerId, application.id);
      throw error;
    }

    // Phase 5 — stamp the back-reference first so the remaining steps are retry-safe, then
    // link the guardian and finish the state machine.
    await this.db.runInTenant(async (tx) => {
      await tx
        .update(admissionApplications)
        .set({ studentId: student.id, updatedBy: principal.userId })
        .where(eq(admissionApplications.id, application.id));
    });

    await this.guardiansService.link(principal, student.id, {
      guardianId,
      relation: application.guardianRelation,
      isPrimary: true,
      isBillingContact: true,
      isEmergencyContact: true,
      canAccessPortal: true,
      hasCustody: true,
    });

    const enrolled = await this.db.runInTenant(async (tx) => {
      const [fresh] = await tx
        .select()
        .from(admissionApplications)
        .where(eq(admissionApplications.id, application.id))
        .limit(1);
      const [updated] = await tx
        .update(admissionApplications)
        .set({
          status: 'enrolled',
          statusChangedAt: new Date(),
          statusReason: 'Offer accepted; student record created and enrolled',
          version: (fresh?.version ?? 1) + 1,
          updatedBy: principal.userId,
        })
        .where(eq(admissionApplications.id, application.id))
        .returning();
      return updated!;
    });

    return {
      application: enrolled,
      studentId: student.id,
      guardianId,
      offerId,
      __audit: {
        previousValue: { status: 'offered' },
        newValue: { status: 'enrolled', studentId: student.id, guardianId },
      },
    };
  }

  async declineOffer(principal: Principal, offerId: string, reason: string) {
    return this.db.runInTenant(async (tx) => {
      const offer = await this.requireOffer(tx, offerId);
      if (offer.status !== 'pending') {
        throw new WorkflowStateError(offer.status, 'declined', 'admission offer');
      }
      const application = await this.requireApplication(tx, offer.applicationId);
      this.assertTransition(application.status, 'declined');

      const [updatedOffer] = await tx
        .update(admissionOffers)
        .set({
          status: 'declined',
          declinedAt: new Date(),
          notes: reason,
          version: offer.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(admissionOffers.id, offerId))
        .returning();

      const [updatedApplication] = await tx
        .update(admissionApplications)
        .set({
          status: 'declined',
          statusChangedAt: new Date(),
          statusReason: reason,
          version: application.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(admissionApplications.id, application.id))
        .returning();

      return { offer: updatedOffer!, application: updatedApplication! };
    });
  }

  /**
   * Mark a lapsed offer expired and return the applicant to the waitlist, freeing the seat
   * for the next candidate. Refuses an offer whose deadline has not passed — expiry is a
   * fact about the clock, not a decision.
   */
  async expireOffer(principal: Principal, offerId: string) {
    return this.db.runInTenant(async (tx) => {
      const offer = await this.requireOffer(tx, offerId);
      if (offer.status !== 'pending') {
        throw new WorkflowStateError(offer.status, 'expired', 'admission offer');
      }
      if (offer.expiresAt.getTime() > Date.now()) {
        throw new ConflictError(
          `This offer does not expire until ${offer.expiresAt.toISOString()}.`,
        );
      }
      const application = await this.requireApplication(tx, offer.applicationId);
      this.assertTransition(application.status, 'waitlisted');

      const [updatedOffer] = await tx
        .update(admissionOffers)
        .set({ status: 'expired', version: offer.version + 1, updatedBy: principal.userId })
        .where(eq(admissionOffers.id, offerId))
        .returning();

      const [updatedApplication] = await tx
        .update(admissionApplications)
        .set({
          status: 'waitlisted',
          statusChangedAt: new Date(),
          statusReason: 'Offer expired without acceptance',
          version: application.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(admissionApplications.id, application.id))
        .returning();

      return { offer: updatedOffer!, application: updatedApplication! };
    });
  }

  // ──────────────────────────────────────────────────────────────────────────────────
  // Funnel report — computed in SQL, shaped in TS
  // ──────────────────────────────────────────────────────────────────────────────────

  async funnelReport(principal: Principal, sessionId: string) {
    return this.db.runInTenant(async (tx) => {
      const session = await this.requireSession(tx, sessionId);

      const rows = await tx
        .select({
          classLevelId: admissionApplications.classLevelId,
          status: admissionApplications.status,
          total: sql<number>`count(*)::int`,
        })
        .from(admissionApplications)
        .where(
          and(
            eq(admissionApplications.sessionId, sessionId),
            isNull(admissionApplications.archivedAt),
          ),
        )
        .groupBy(admissionApplications.classLevelId, admissionApplications.status);

      const statusCounts: Record<string, number> = {};
      const byClassLevel = new Map<string, Record<string, number>>();
      let total = 0;

      for (const row of rows) {
        statusCounts[row.status] = (statusCounts[row.status] ?? 0) + row.total;
        total += row.total;
        const bucket = byClassLevel.get(row.classLevelId) ?? {};
        bucket[row.status] = row.total;
        byClassLevel.set(row.classLevelId, bucket);
      }

      const capacity = (session.classCapacity as ClassCapacityEntry[]) ?? [];
      const classLevelBreakdown = capacity.map((entry) => {
        const bucket = byClassLevel.get(entry.classLevelId) ?? {};
        const applications = Object.values(bucket).reduce((sum, n) => sum + n, 0);
        return {
          classLevelId: entry.classLevelId,
          seats: entry.seats,
          applications,
          offered: bucket['offered'] ?? 0,
          accepted: bucket['accepted'] ?? 0,
          enrolled: bucket['enrolled'] ?? 0,
          waitlisted: bucket['waitlisted'] ?? 0,
          rejected: bucket['rejected'] ?? 0,
          seatsRemaining: Math.max(
            0,
            entry.seats - (bucket['accepted'] ?? 0) - (bucket['enrolled'] ?? 0),
          ),
        };
      });

      return {
        sessionId,
        sessionName: session.nameEn,
        sessionStatus: session.status,
        totalApplications: total,
        statusCounts,
        classLevels: classLevelBreakdown,
        conversion: {
          applications: total,
          offered:
            (statusCounts['offered'] ?? 0) +
            (statusCounts['accepted'] ?? 0) +
            (statusCounts['enrolled'] ?? 0) +
            (statusCounts['declined'] ?? 0),
          accepted: (statusCounts['accepted'] ?? 0) + (statusCounts['enrolled'] ?? 0),
          enrolled: statusCounts['enrolled'] ?? 0,
        },
      };
    });
  }

  // ──────────────────────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────────────────────

  private assertTransition(from: string, to: AdmissionApplicationStatus): void {
    const allowed = APPLICATION_TRANSITIONS[from as AdmissionApplicationStatus] ?? [];
    if (!allowed.includes(to)) {
      // 409 naming the from and to states, per the module contract.
      throw new WorkflowStateError(from, to, 'admission application');
    }
  }

  private assertOfferAcceptable(offer: OfferRow, application: ApplicationRow): void {
    if (offer.status !== 'pending') {
      throw new WorkflowStateError(offer.status, 'accepted', 'admission offer');
    }
    if (offer.expiresAt.getTime() <= Date.now()) {
      throw new ConflictError(
        `This offer expired on ${offer.expiresAt.toISOString()} and can no longer be ` +
          `accepted. Issue a new offer instead.`,
      );
    }
    this.assertTransition(application.status, 'accepted');
  }

  /**
   * The same signal the student service's duplicate detection uses, checked read-only and
   * up-front so a duplicate acceptance fails before anything at all is written. The student
   * service's own check (and the partial unique indexes) remain the enforcement.
   */
  /**
   * Every class level named in a session's capacity map must belong to that institution.
   *
   * RLS cannot catch this: an id from a sibling institution is in the same tenant, so the row
   * is legitimately visible. Only an explicit institution filter rejects it, and it has to be
   * rejected here rather than at the foreign key, or a session could allocate seats in a class
   * that belongs to another school in the same group.
   */
  private async assertClassLevelsBelong(
    tx: Tx,
    institutionId: string,
    classLevelIds: readonly string[],
  ): Promise<void> {
    const unique = [...new Set(classLevelIds)];
    if (unique.length === 0) return;

    const found = await tx
      .select({ id: classLevels.id })
      .from(classLevels)
      .where(
        and(
          eq(classLevels.institutionId, institutionId),
          isNull(classLevels.archivedAt),
          inArray(classLevels.id, unique),
        ),
      );

    const known = new Set(found.map((row) => row.id));
    const missing = unique.find((id) => !known.has(id));
    // 404 rather than 403: naming which ids exist elsewhere would confirm their existence.
    if (missing) throw new NotFoundError('Class level', missing);
  }

  private async assertNoDuplicateStudent(tx: Tx, application: ApplicationRow): Promise<void> {
    const conditions: SQL[] = [
      and(
        ilike(students.fullNameEn, application.applicantNameEn),
        eq(students.dateOfBirth, application.dateOfBirth),
      )!,
    ];
    if (application.birthRegistrationNumber) {
      conditions.push(eq(students.birthRegistrationNumber, application.birthRegistrationNumber));
    }
    const [duplicate] = await tx
      .select({ id: students.id, studentCode: students.studentCode })
      .from(students)
      .where(
        and(
          eq(students.institutionId, application.institutionId),
          isNull(students.archivedAt),
          or(...conditions),
        ),
      )
      .limit(1);
    if (duplicate) {
      throw new ConflictError(
        `A student with the same identity already exists (${duplicate.studentCode}). ` +
          `This applicant appears to already be admitted; do not enrol them twice.`,
        { existingStudentId: duplicate.id },
      );
    }
  }

  /** Guardian record for the application, deduplicated by phone. */
  private async resolveGuardian(
    principal: Principal,
    application: ApplicationRow,
  ): Promise<string> {
    const existing = await this.db.runInTenant(async (tx) => {
      const [row] = await tx
        .select({ id: guardians.id })
        .from(guardians)
        .where(
          and(
            eq(guardians.institutionId, application.institutionId),
            eq(guardians.phone, application.guardianPhone),
            isNull(guardians.archivedAt),
          ),
        )
        .limit(1);
      return row ?? null;
    });
    if (existing) return existing.id;

    try {
      const created = await this.guardiansService.create(principal, application.institutionId, {
        fullNameEn: application.guardianNameEn,
        fullNameBn: application.guardianNameBn ?? undefined,
        phone: application.guardianPhone,
        email: application.guardianEmail ?? undefined,
        nationalId: application.guardianNid ?? undefined,
        address: application.presentAddress ?? undefined,
      });
      return created.id;
    } catch (error) {
      // A concurrent acceptance for a sibling can create the guardian between our read and
      // our insert; the guardian service reports the existing record in that case.
      if (error instanceof ConflictError) {
        const raced = await this.db.runInTenant(async (tx) => {
          const [row] = await tx
            .select({ id: guardians.id })
            .from(guardians)
            .where(
              and(
                eq(guardians.institutionId, application.institutionId),
                eq(guardians.phone, application.guardianPhone),
                isNull(guardians.archivedAt),
              ),
            )
            .limit(1);
          return row ?? null;
        });
        if (raced) return raced.id;
      }
      throw error;
    }
  }

  /** Compensating write for a failed acceptance: put the offer and application back. */
  private async revertAcceptance(
    principal: Principal,
    offerId: string,
    applicationId: string,
  ): Promise<void> {
    await this.db.runInTenant(async (tx) => {
      const [offer] = await tx
        .select()
        .from(admissionOffers)
        .where(eq(admissionOffers.id, offerId))
        .limit(1);
      if (offer?.status === 'accepted') {
        await tx
          .update(admissionOffers)
          .set({
            status: 'pending',
            acceptedAt: null,
            version: offer.version + 1,
            updatedBy: principal.userId,
          })
          .where(eq(admissionOffers.id, offerId));
      }
      const [application] = await tx
        .select()
        .from(admissionApplications)
        .where(eq(admissionApplications.id, applicationId))
        .limit(1);
      if (application?.status === 'accepted') {
        await tx
          .update(admissionApplications)
          .set({
            status: 'offered',
            statusChangedAt: new Date(),
            statusReason: 'Acceptance reverted: the student record could not be created',
            version: application.version + 1,
            updatedBy: principal.userId,
          })
          .where(eq(admissionApplications.id, applicationId));
      }
    });
  }

  /** Load and lock the session row. Seat arithmetic happens only under this lock. */
  private async lockSession(tx: Tx, sessionId: string): Promise<SessionRow> {
    const [session] = await tx
      .select()
      .from(admissionSessions)
      .where(and(eq(admissionSessions.id, sessionId), isNull(admissionSessions.archivedAt)))
      .limit(1)
      .for('update');
    if (!session) throw new NotFoundError('Admission session', sessionId);
    return session;
  }

  private capacityFor(session: SessionRow, classLevelId: string): ClassCapacityEntry | null {
    const capacity = (session.classCapacity as ClassCapacityEntry[]) ?? [];
    return capacity.find((entry) => entry.classLevelId === classLevelId) ?? null;
  }

  private async countSeatsTaken(
    tx: Tx,
    sessionId: string,
    classLevelId: string,
    statuses: AdmissionApplicationStatus[],
  ): Promise<number> {
    const [counted] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(admissionApplications)
      .where(
        and(
          eq(admissionApplications.sessionId, sessionId),
          eq(admissionApplications.classLevelId, classLevelId),
          inArray(admissionApplications.status, statuses),
          isNull(admissionApplications.archivedAt),
        ),
      );
    return counted?.total ?? 0;
  }

  private async requireSession(tx: Tx, sessionId: string): Promise<SessionRow> {
    const [session] = await tx
      .select()
      .from(admissionSessions)
      .where(and(eq(admissionSessions.id, sessionId), isNull(admissionSessions.archivedAt)))
      .limit(1);
    if (!session) throw new NotFoundError('Admission session', sessionId);
    return session;
  }

  private async requireApplication(tx: Tx, applicationId: string): Promise<ApplicationRow> {
    const [application] = await tx
      .select()
      .from(admissionApplications)
      .where(
        and(eq(admissionApplications.id, applicationId), isNull(admissionApplications.archivedAt)),
      )
      .limit(1);
    if (!application) throw new NotFoundError('Admission application', applicationId);
    return application;
  }

  private async requireOffer(tx: Tx, offerId: string): Promise<OfferRow> {
    const [offer] = await tx
      .select()
      .from(admissionOffers)
      .where(and(eq(admissionOffers.id, offerId), isNull(admissionOffers.archivedAt)))
      .limit(1);
    if (!offer) throw new NotFoundError('Admission offer', offerId);
    return offer;
  }

  private async meritEntriesFor(tx: Tx, listId: string) {
    return tx
      .select({
        id: admissionMeritEntries.id,
        applicationId: admissionMeritEntries.applicationId,
        rank: admissionMeritEntries.rank,
        aggregateScore: admissionMeritEntries.aggregateScore,
        components: admissionMeritEntries.components,
        isWaitlisted: admissionMeritEntries.isWaitlisted,
        applicantNameEn: admissionApplications.applicantNameEn,
        applicationNumber: admissionApplications.applicationNumber,
        quota: admissionApplications.quota,
      })
      .from(admissionMeritEntries)
      .innerJoin(
        admissionApplications,
        eq(admissionApplications.id, admissionMeritEntries.applicationId),
      )
      .where(
        and(
          eq(admissionMeritEntries.meritListId, listId),
          isNull(admissionMeritEntries.archivedAt),
        ),
      )
      .orderBy(asc(admissionMeritEntries.rank));
  }

  private async resolveInstitutionByCode(tx: Tx, code: string) {
    const [row] = await tx
      .select({ id: institutions.id, isActive: institutions.isActive })
      .from(institutions)
      .where(and(ilike(institutions.code, code), isNull(institutions.archivedAt)))
      .limit(1);
    if (!row || !row.isActive) return null;
    return row;
  }

  /**
   * Next sequential application number for the institution, e.g. ADM2026-00042. Uses `max`
   * under the transaction snapshot; the partial unique index is the backstop if two
   * submissions still collide.
   */
  private async nextApplicationNumber(tx: Tx, institutionId: string): Promise<string> {
    const year = new Date().getUTCFullYear();
    const prefix = `ADM${year}-`;
    const [row] = await tx
      .select({ maxNumber: sql<string | null>`max(${admissionApplications.applicationNumber})` })
      .from(admissionApplications)
      .where(
        and(
          eq(admissionApplications.institutionId, institutionId),
          ilike(admissionApplications.applicationNumber, `${prefix}%`),
        ),
      );
    const previous = row?.maxNumber ? Number(row.maxNumber.slice(prefix.length)) : 0;
    return `${prefix}${String((Number.isFinite(previous) ? previous : 0) + 1).padStart(5, '0')}`;
  }

  /** Map validated applicant input onto application columns. Shared by public and counter. */
  private applicantColumns(
    input: PublicAdmissionApplicationInput | CreateAdmissionApplicationInput,
  ) {
    return {
      applicantNameEn: input.applicantNameEn,
      applicantNameBn: input.applicantNameBn ?? null,
      dateOfBirth: input.dateOfBirth,
      gender: input.gender,
      birthRegistrationNumber: input.birthRegistrationNumber ?? null,
      previousSchoolName: input.previousSchoolName ?? null,
      previousClassCompleted: input.previousClassCompleted ?? null,
      previousResultGpa: input.previousResultGpa ?? null,
      guardianNameEn: input.guardianNameEn,
      guardianNameBn: input.guardianNameBn ?? null,
      guardianRelation: input.guardianRelation,
      guardianPhone: input.guardianPhone,
      guardianEmail: input.guardianEmail || null,
      guardianNid: input.guardianNid ?? null,
      presentAddress: input.presentAddress ?? null,
      quota: input.quota ?? null,
    };
  }
}

const APPLICATION_COLUMNS = {
  applicantNameEn: admissionApplications.applicantNameEn,
  applicationNumber: admissionApplications.applicationNumber,
  submittedAt: admissionApplications.submittedAt,
  status: admissionApplications.status,
  dateOfBirth: admissionApplications.dateOfBirth,
  createdAt: admissionApplications.createdAt,
} as const;
