/**
 * Attendance service (Phase 7).
 *
 * Built on the same three rules as `StudentsService`, because attendance is read by the same
 * people under the same scopes and re-deriving them would create a second, subtly different
 * definition of "my students":
 *
 *  1. Every query runs inside `runInTenant`.
 *  2. The data scope decides *which* filter is applied, never *whether* one is. `assigned`
 *     resolves through `employee_section_assignments` / `employee_subject_assignments` — the
 *     exact tables `StudentsService.scopeFilter` uses — and `own` resolves through
 *     `student_guardians` with `can_access_portal`, exactly as `guardians/my-children` does.
 *  3. Reading one record goes through the same filter as the list, so a section id belonging
 *     to another teacher or another tenant returns 404 rather than 403.
 *
 * The rules specific to this module, all of which are refusals rather than corrections:
 *
 *  - No register for a future date, a holiday, a non-teaching day or a configured weekend.
 *  - No mark for a student who was not enrolled in that section on that date.
 *  - A submitted register is never edited in place. A change goes through
 *    `attendance_corrections`, carries a mandatory reason, and is applied — with its audit
 *    record — inside one transaction.
 *
 * Every aggregate below is computed by Postgres. Loading a term's marks into Node to count
 * them would be both slower and, once a school has three years of data, impossible.
 */

import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, exists, gte, isNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  academicYears,
  attendanceCorrections,
  attendanceSessions,
  calendarEvents,
  employeeAttendance,
  employees,
  employeeSectionAssignments,
  employeeSubjectAssignments,
  enrollments,
  periods,
  sections,
  studentAttendance,
  studentGuardians,
  students,
  subjects,
} from '@shikkha/db';
import {
  buildOffsetPage,
  calendarDate,
  compareCalendarDates,
  ConflictError,
  dhakaWeekday,
  ForbiddenError,
  ImmutableRecordError,
  isWithin,
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
import {
  can,
  resolveDataScope,
  SCOPED_RESOURCES,
  type DataScope,
  type Principal,
} from '@shikkha/permissions';
import {
  ATTENDANCE_CORRECTION_SORT_FIELDS,
  ATTENDANCE_SESSION_SORT_FIELDS,
  EMPLOYEE_ATTENDANCE_SORT_FIELDS,
  type ConsecutiveAbsenceQuery,
  type EmployeeCheckInInput,
  type EmployeeCheckOutInput,
  type ListAttendanceCorrectionsQuery,
  type ListAttendanceSessionsQuery,
  type ListEmployeeAttendanceQuery,
  type OpenAttendanceSessionInput,
  type RequestAttendanceCorrectionInput,
  type SectionAttendanceSummaryQuery,
  type StudentAttendanceSummaryQuery,
  type SubmitAttendanceInput,
} from '@shikkha/validation';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { currentContext } from '../../common/context/request-context';

type Tx = Parameters<Parameters<DatabaseService['runInTenant']>[0]>[0];

type SessionRow = typeof attendanceSessions.$inferSelect;
type MarkRow = typeof studentAttendance.$inferSelect;
type CorrectionRow = typeof attendanceCorrections.$inferSelect;
type EmployeeAttendanceRow = typeof employeeAttendance.$inferSelect;
type MarkStatus = MarkRow['status'];

/** A status that carries no arrival delay must not carry `minutesLate`. */
const LATE_STATUSES: ReadonlySet<MarkStatus> = new Set<MarkStatus>(['late', 'half_day']);

@Injectable()
export class AttendanceService {
  constructor(
    private readonly db: DatabaseService,
    // Applying a correction changes an academic record, so its audit row belongs in the same
    // transaction as the change rather than in the interceptor that runs after the response.
    private readonly audit: AuditService,
  ) {}

  // ──────────────────────────────────────────────────────────────────────────────────
  // Registers
  // ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Open the register for a section on a date, or return the one that already exists.
   *
   * Idempotent on purpose. A teacher who taps "take attendance" twice, or two devices in one
   * classroom, must land on the same register rather than race for a unique-index violation.
   */
  async openSession(
    principal: Principal,
    institutionId: string,
    input: OpenAttendanceSessionInput,
  ): Promise<SessionRow> {
    const scope = this.requireWriteScope(principal);

    return this.db.runInTenant(async (tx) => {
      const section = await this.loadSection(tx, institutionId, input.sectionId);
      await this.assertSectionAssigned(tx, principal, scope, section.id);
      await this.assertDateIsTeachingDay(tx, section, input.attendanceDate);

      if (input.periodId) await this.assertPeriodUsable(tx, institutionId, input.periodId, section);
      if (input.subjectId) await this.assertSubjectExists(tx, institutionId, input.subjectId);

      const slot = and(
        eq(attendanceSessions.sectionId, section.id),
        eq(attendanceSessions.attendanceDate, input.attendanceDate),
        input.periodId
          ? eq(attendanceSessions.periodId, input.periodId)
          : isNull(attendanceSessions.periodId),
        isNull(attendanceSessions.archivedAt),
      );

      const [existing] = await tx.select().from(attendanceSessions).where(slot).limit(1);
      if (existing) return existing;

      const [created] = await tx
        .insert(attendanceSessions)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          campusId: section.campusId,
          academicYearId: section.academicYearId,
          sectionId: section.id,
          periodId: input.periodId ?? null,
          subjectId: input.subjectId ?? null,
          attendanceDate: input.attendanceDate,
          takenByEmployeeId: principal.employeeId ?? null,
          takenByUserId: principal.userId,
          status: 'open',
          notes: input.notes ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      if (!created) throw new ConflictError('The attendance register could not be opened');
      return created;
    });
  }

  async listSessions(
    principal: Principal,
    query: ListAttendanceSessionsQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<SessionRow>> {
    const scope = this.requireReadScope(principal);

    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [this.sessionScopeFilter(principal, scope)];

      if (!query.includeArchived) {
        filters.push(isNull(attendanceSessions.archivedAt));
      } else if (!can(principal, 'attendance.correct.approve')) {
        // An archived register is one somebody decided should not count. Seeing it is a
        // supervisory read, not part of taking attendance.
        throw new ForbiddenError(
          'attendance.correct.approve',
          'You cannot view archived attendance registers',
        );
      }

      const institutionId = currentContext()?.institutionId;
      if (institutionId) filters.push(eq(attendanceSessions.institutionId, institutionId));
      if (query.sectionId) filters.push(eq(attendanceSessions.sectionId, query.sectionId));
      if (query.academicYearId) {
        filters.push(eq(attendanceSessions.academicYearId, query.academicYearId));
      }
      if (query.periodId) filters.push(eq(attendanceSessions.periodId, query.periodId));
      if (query.from) filters.push(gte(attendanceSessions.attendanceDate, query.from));
      if (query.to) filters.push(lte(attendanceSessions.attendanceDate, query.to));
      if (query.status) {
        filters.push(eq(attendanceSessions.status, query.status as SessionRow['status']));
      }

      const where = and(...filters);
      const orderBy = parseSort(query.sort, ATTENDANCE_SESSION_SORT_FIELDS, {
        field: 'attendanceDate',
        direction: 'desc',
      }).map((spec) => {
        const column = SESSION_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(attendanceSessions)
        .where(where)
        .orderBy(...orderBy, asc(attendanceSessions.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(attendanceSessions)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  /**
   * The register, pre-filled.
   *
   * One query returns every student enrolled in the section on the register's date, with the
   * mark they already have where one exists. The client never has to reconcile two lists, and
   * a student who joined the section yesterday appears without anyone re-opening the register.
   */
  async roster(principal: Principal, sessionId: string) {
    const scope = this.requireReadScope(principal);

    return this.db.runInTenant(async (tx) => {
      const session = await this.loadVisibleSession(tx, principal, scope, sessionId);

      const roster = await tx
        .select({
          studentId: students.id,
          fullNameEn: students.fullNameEn,
          fullNameBn: students.fullNameBn,
          studentCode: students.studentCode,
          photoFileId: students.photoFileId,
          rollNumber: enrollments.rollNumber,
          enrollmentId: enrollments.id,
          markId: studentAttendance.id,
          status: studentAttendance.status,
          minutesLate: studentAttendance.minutesLate,
          remarks: studentAttendance.remarks,
          markVersion: studentAttendance.version,
          lastCorrectedAt: studentAttendance.lastCorrectedAt,
        })
        .from(enrollments)
        .innerJoin(students, eq(students.id, enrollments.studentId))
        .leftJoin(
          studentAttendance,
          and(
            eq(studentAttendance.sessionId, session.id),
            eq(studentAttendance.studentId, enrollments.studentId),
            isNull(studentAttendance.archivedAt),
          ),
        )
        .where(this.enrolledOnDateFilter(session.sectionId, session.attendanceDate))
        // Roll numbers are stored as text, so plain ordering puts "10" before "2". Ordering by
        // length first restores the numeric order for the numeric roll numbers every
        // Bangladeshi school actually uses, without assuming they are numeric.
        .orderBy(sql`length(${enrollments.rollNumber})`, asc(enrollments.rollNumber));

      return { session, roster };
    });
  }

  /**
   * Write the whole register in one transaction.
   *
   * Refused once the register is submitted: at that point a change is a correction, which is a
   * different act with a different permission and a mandatory reason. Refused outright once it
   * is locked.
   */
  async submitMarks(principal: Principal, sessionId: string, input: SubmitAttendanceInput) {
    const scope = this.requireWriteScope(principal);

    return this.db.runInTenant(async (tx) => {
      const [session] = await tx
        .select()
        .from(attendanceSessions)
        .where(and(eq(attendanceSessions.id, sessionId), isNull(attendanceSessions.archivedAt)))
        .limit(1);
      if (!session) throw new NotFoundError('Attendance register', sessionId);

      await this.assertSectionAssigned(tx, principal, scope, session.sectionId);

      if (session.status === 'locked') {
        throw new ImmutableRecordError(
          'This attendance register',
          'it has been locked for the reporting period',
        );
      }
      if (session.status === 'submitted') {
        throw new ConflictError(
          'This register has already been submitted. Request a correction to change a mark.',
          { sessionId: session.id },
        );
      }

      // Who may legitimately appear on this register: enrolled in this section, on this date.
      const eligible = await tx
        .select({ studentId: enrollments.studentId, enrollmentId: enrollments.id })
        .from(enrollments)
        .innerJoin(students, eq(students.id, enrollments.studentId))
        .where(this.enrolledOnDateFilter(session.sectionId, session.attendanceDate));

      const enrollmentByStudent = new Map(eligible.map((row) => [row.studentId, row.enrollmentId]));

      const notEnrolled = input.marks
        .map((mark, index) => ({ mark, index }))
        .filter(({ mark }) => !enrollmentByStudent.has(mark.studentId));

      if (notEnrolled.length > 0) {
        // Marking a student who was not in the section on that date silently corrupts both
        // registers: theirs and the one they actually belonged to.
        throw new ValidationError(
          'Some of these students were not enrolled in this section on this date',
          notEnrolled.map(({ mark, index }) => ({
            path: `marks.${index}.studentId`,
            message: `${mark.studentId} was not enrolled in this section on ${session.attendanceDate}`,
          })),
        );
      }

      const now = new Date();
      const values = input.marks.map((mark) => ({
        id: uuidv7(),
        tenantId: principal.tenantId!,
        institutionId: session.institutionId,
        sessionId: session.id,
        studentId: mark.studentId,
        enrollmentId: enrollmentByStudent.get(mark.studentId) ?? null,
        status: mark.status as MarkStatus,
        minutesLate: normalizeMinutesLate(mark.status as MarkStatus, mark.minutesLate),
        remarks: mark.remarks ?? null,
        markedAt: now,
        markedBy: principal.userId,
        createdBy: principal.userId,
        updatedBy: principal.userId,
      }));

      // One statement for the whole class. The conflict target is the partial unique index, so
      // re-saving an open register updates in place instead of accumulating duplicate marks.
      await tx
        .insert(studentAttendance)
        .values(values)
        .onConflictDoUpdate({
          target: [studentAttendance.sessionId, studentAttendance.studentId],
          // Unqualified on purpose: this must match the partial unique index's predicate
          // exactly for Postgres to infer the index as the conflict target.
          targetWhere: sql`archived_at is null`,
          set: {
            status: sql`excluded.status`,
            minutesLate: sql`excluded.minutes_late`,
            remarks: sql`excluded.remarks`,
            enrollmentId: sql`excluded.enrollment_id`,
            markedAt: sql`excluded.marked_at`,
            markedBy: sql`excluded.marked_by`,
            updatedBy: sql`excluded.updated_by`,
            version: sql`${studentAttendance.version} + 1`,
          },
        });

      const [updated] = await tx
        .update(attendanceSessions)
        .set({
          status: input.finalize ? 'submitted' : 'open',
          submittedAt: input.finalize ? now : null,
          takenByEmployeeId: principal.employeeId ?? session.takenByEmployeeId,
          takenByUserId: principal.userId,
          takenAt: now,
          updatedBy: principal.userId,
          version: session.version + 1,
        })
        .where(
          and(eq(attendanceSessions.id, session.id), eq(attendanceSessions.version, input.version)),
        )
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This register was changed by someone else while you were taking it. Reload and try again.',
          { expectedVersion: input.version, currentVersion: session.version },
        );
      }

      return {
        session: updated,
        markedCount: values.length,
        __audit: {
          previousValue: { status: session.status, version: session.version },
          newValue: {
            status: updated.status,
            marks: input.marks.map((mark) => ({ studentId: mark.studentId, status: mark.status })),
          },
        },
      };
    });
  }

  /**
   * Close the register for the reporting period. Nothing — not even an approved correction —
   * changes a locked register; reopening it is a deliberate future act, not an accident.
   */
  async lockSession(principal: Principal, sessionId: string, reason: string, version: number) {
    const scope = this.requireReadScope(principal);

    return this.db.runInTenant(async (tx) => {
      const session = await this.loadVisibleSession(tx, principal, scope, sessionId);

      if (session.status === 'locked') {
        throw new ConflictError('This register is already locked');
      }
      if (session.status !== 'submitted') {
        throw new WorkflowStateError(session.status, 'locked', 'attendance register');
      }

      const pending = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(attendanceCorrections)
        .where(
          and(
            eq(attendanceCorrections.sessionId, session.id),
            eq(attendanceCorrections.status, 'pending'),
            isNull(attendanceCorrections.archivedAt),
          ),
        );

      if ((pending[0]?.total ?? 0) > 0) {
        // Locking with corrections outstanding silently discards them, and the teacher who
        // raised one would never learn why the mark never changed.
        throw new ConflictError(
          'There are attendance corrections still awaiting a decision on this register. Approve or reject them first.',
          { pendingCorrections: pending[0]?.total ?? 0 },
        );
      }

      const now = new Date();
      const [locked] = await tx
        .update(attendanceSessions)
        .set({
          status: 'locked',
          lockedAt: now,
          lockedBy: principal.userId,
          updatedBy: principal.userId,
          version: session.version + 1,
        })
        .where(and(eq(attendanceSessions.id, session.id), eq(attendanceSessions.version, version)))
        .returning();

      if (!locked) {
        throw new ConflictError(
          'This register was changed by someone else while you were reviewing it. Reload and try again.',
          { expectedVersion: version, currentVersion: session.version },
        );
      }

      return {
        session: locked,
        __audit: {
          previousValue: { status: session.status },
          newValue: { status: 'locked', reason },
        },
      };
    });
  }

  // ──────────────────────────────────────────────────────────────────────────────────
  // Corrections
  // ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Ask to change a mark on a submitted register.
   *
   * A requester who also holds `attendance.correct.approve` is approving their own request by
   * definition, so the correction is created already approved and applied in the same
   * transaction — the record is identical either way, and a school with one approver is not
   * left unable to fix a typo. A requester without that permission gets a `pending` row and
   * the mark is untouched until somebody else decides.
   */
  async requestCorrection(
    principal: Principal,
    markId: string,
    input: RequestAttendanceCorrectionInput,
  ) {
    const scope = this.requireWriteScope(principal);
    const context = currentContext();

    return this.db.runInTenant(async (tx) => {
      const [found] = await tx
        .select({ mark: studentAttendance, session: attendanceSessions })
        .from(studentAttendance)
        .innerJoin(attendanceSessions, eq(attendanceSessions.id, studentAttendance.sessionId))
        .where(and(eq(studentAttendance.id, markId), isNull(studentAttendance.archivedAt)))
        .limit(1);

      if (!found) throw new NotFoundError('Attendance mark', markId);
      const { mark, session } = found;

      await this.assertSectionAssigned(tx, principal, scope, session.sectionId);

      if (session.status === 'open') {
        throw new ValidationError(
          'This register is still open. Change the mark directly instead of raising a correction.',
          [{ path: 'status', message: 'The register has not been submitted yet' }],
        );
      }
      if (session.status === 'locked') {
        throw new ImmutableRecordError(
          'This attendance register',
          'it has been locked for the reporting period',
        );
      }

      const newStatus = input.status as MarkStatus;
      const newMinutesLate = normalizeMinutesLate(newStatus, input.minutesLate);

      if (mark.status === newStatus && mark.minutesLate === newMinutesLate) {
        throw new ValidationError('That is already the recorded mark', [
          { path: 'status', message: 'Choose a different status' },
        ]);
      }

      const [alreadyPending] = await tx
        .select({ id: attendanceCorrections.id })
        .from(attendanceCorrections)
        .where(
          and(
            eq(attendanceCorrections.studentAttendanceId, mark.id),
            eq(attendanceCorrections.status, 'pending'),
            isNull(attendanceCorrections.archivedAt),
          ),
        )
        .limit(1);

      if (alreadyPending) {
        throw new ConflictError('A correction for this mark is already awaiting a decision.', {
          correctionId: alreadyPending.id,
        });
      }

      const selfApproves = can(principal, 'attendance.correct.approve');
      const now = new Date();

      const [correction] = await tx
        .insert(attendanceCorrections)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId: session.institutionId,
          studentAttendanceId: mark.id,
          sessionId: session.id,
          studentId: mark.studentId,
          previousStatus: mark.status,
          newStatus,
          previousMinutesLate: mark.minutesLate,
          newMinutesLate,
          reason: input.reason,
          requestedBy: principal.userId,
          requestedByEmployeeId: principal.employeeId ?? null,
          requestedAt: now,
          status: selfApproves ? 'approved' : 'pending',
          approvedBy: selfApproves ? principal.userId : null,
          approvedAt: selfApproves ? now : null,
          decisionNote: selfApproves
            ? 'Applied by the requester, who holds approval authority'
            : null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      if (!correction) throw new ConflictError('The correction could not be recorded');

      if (!selfApproves) {
        return { correction, applied: false, mark };
      }

      const applied = await this.applyCorrection(tx, principal, correction, mark);

      // The audit row is written here, not by the interceptor, because the mark change and its
      // justification must commit or roll back together: an academic record that changed with
      // no surviving explanation is the failure this whole table exists to prevent.
      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId: session.institutionId,
        campusId: context?.campusId ?? null,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'update',
        module: 'attendance',
        resourceType: 'student_attendance',
        resourceId: mark.id,
        previousValue: { status: mark.status, minutesLate: mark.minutesLate },
        newValue: { status: applied.status, minutesLate: applied.minutesLate },
        reason: input.reason,
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      return { correction, applied: true, mark: applied };
    });
  }

  async listCorrections(
    principal: Principal,
    query: ListAttendanceCorrectionsQuery,
    page: OffsetPageRequest,
  ) {
    const scope = this.requireReadScope(principal);

    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [
        isNull(attendanceCorrections.archivedAt),
        this.sessionScopeFilter(principal, scope),
      ];

      const institutionId = currentContext()?.institutionId;
      if (institutionId) filters.push(eq(attendanceCorrections.institutionId, institutionId));
      if (query.status) {
        filters.push(eq(attendanceCorrections.status, query.status as CorrectionRow['status']));
      }
      if (query.studentId) filters.push(eq(attendanceCorrections.studentId, query.studentId));
      if (query.sectionId) filters.push(eq(attendanceSessions.sectionId, query.sectionId));
      if (query.from) filters.push(gte(attendanceSessions.attendanceDate, query.from));
      if (query.to) filters.push(lte(attendanceSessions.attendanceDate, query.to));

      const where = and(...filters);
      const orderBy = parseSort(query.sort, ATTENDANCE_CORRECTION_SORT_FIELDS, {
        field: 'requestedAt',
        direction: 'desc',
      }).map((spec) => {
        const column = CORRECTION_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select({
          id: attendanceCorrections.id,
          studentAttendanceId: attendanceCorrections.studentAttendanceId,
          sessionId: attendanceCorrections.sessionId,
          studentId: attendanceCorrections.studentId,
          studentNameEn: students.fullNameEn,
          studentCode: students.studentCode,
          sectionId: attendanceSessions.sectionId,
          attendanceDate: attendanceSessions.attendanceDate,
          previousStatus: attendanceCorrections.previousStatus,
          newStatus: attendanceCorrections.newStatus,
          previousMinutesLate: attendanceCorrections.previousMinutesLate,
          newMinutesLate: attendanceCorrections.newMinutesLate,
          reason: attendanceCorrections.reason,
          status: attendanceCorrections.status,
          requestedBy: attendanceCorrections.requestedBy,
          requestedAt: attendanceCorrections.requestedAt,
          approvedBy: attendanceCorrections.approvedBy,
          approvedAt: attendanceCorrections.approvedAt,
          decisionNote: attendanceCorrections.decisionNote,
          version: attendanceCorrections.version,
        })
        .from(attendanceCorrections)
        .innerJoin(attendanceSessions, eq(attendanceSessions.id, attendanceCorrections.sessionId))
        .innerJoin(students, eq(students.id, attendanceCorrections.studentId))
        .where(where)
        .orderBy(...orderBy, asc(attendanceCorrections.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(attendanceCorrections)
        .innerJoin(attendanceSessions, eq(attendanceSessions.id, attendanceCorrections.sessionId))
        .innerJoin(students, eq(students.id, attendanceCorrections.studentId))
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  /**
   * Approve or reject a pending correction.
   *
   * The approver may not be the requester. A correction raised by someone without approval
   * authority is precisely the case where a second pair of eyes is the control; letting the
   * requester approve it later would make the permission decorative.
   */
  async decideCorrection(
    principal: Principal,
    correctionId: string,
    decision: 'approved' | 'rejected',
    reason: string,
    version: number,
  ) {
    const scope = this.requireReadScope(principal);
    const context = currentContext();

    return this.db.runInTenant(async (tx) => {
      const [found] = await tx
        .select({ correction: attendanceCorrections, session: attendanceSessions })
        .from(attendanceCorrections)
        .innerJoin(attendanceSessions, eq(attendanceSessions.id, attendanceCorrections.sessionId))
        .where(
          and(
            eq(attendanceCorrections.id, correctionId),
            isNull(attendanceCorrections.archivedAt),
            this.sessionScopeFilter(principal, scope),
          ),
        )
        .limit(1);

      if (!found) throw new NotFoundError('Attendance correction', correctionId);
      const { correction, session } = found;

      if (correction.status !== 'pending') {
        throw new WorkflowStateError(correction.status, decision, 'attendance correction');
      }
      if (correction.requestedBy === principal.userId) {
        throw new ForbiddenError(
          'attendance.correct.approve',
          'You cannot decide a correction you raised yourself. Ask another approver.',
        );
      }
      if (session.status === 'locked') {
        throw new ImmutableRecordError(
          'This attendance register',
          'it has been locked for the reporting period',
        );
      }

      const now = new Date();
      const [decided] = await tx
        .update(attendanceCorrections)
        .set({
          status: decision,
          approvedBy: principal.userId,
          approvedAt: now,
          decisionNote: reason,
          updatedBy: principal.userId,
          version: correction.version + 1,
        })
        .where(
          and(
            eq(attendanceCorrections.id, correction.id),
            eq(attendanceCorrections.version, version),
            eq(attendanceCorrections.status, 'pending'),
          ),
        )
        .returning();

      if (!decided) {
        throw new ConflictError(
          'This correction was decided by someone else while you were reviewing it. Reload and try again.',
          { expectedVersion: version, currentVersion: correction.version },
        );
      }

      let mark: MarkRow | null = null;
      if (decision === 'approved') {
        const [current] = await tx
          .select()
          .from(studentAttendance)
          .where(
            and(
              eq(studentAttendance.id, correction.studentAttendanceId),
              isNull(studentAttendance.archivedAt),
            ),
          )
          .limit(1);
        if (!current) {
          throw new NotFoundError('Attendance mark', correction.studentAttendanceId);
        }
        mark = await this.applyCorrection(tx, principal, decided, current);

        await this.audit.recordInTransaction(tx, {
          tenantId: principal.tenantId,
          institutionId: session.institutionId,
          campusId: context?.campusId ?? null,
          actorUserId: principal.userId,
          actorRoles: principal.roles.map((role) => role.roleKey),
          action: 'update',
          module: 'attendance',
          resourceType: 'student_attendance',
          resourceId: current.id,
          previousValue: { status: current.status, minutesLate: current.minutesLate },
          newValue: { status: mark.status, minutesLate: mark.minutesLate },
          reason: correction.reason,
          requestId: context?.requestId ?? null,
          ipAddress: context?.ipAddress ?? null,
          userAgent: context?.userAgent ?? null,
        });
      }

      return {
        correction: decided,
        mark,
        __audit: {
          previousValue: { status: correction.status },
          newValue: { status: decision, reason },
        },
      };
    });
  }

  // ──────────────────────────────────────────────────────────────────────────────────
  // Employee attendance
  // ──────────────────────────────────────────────────────────────────────────────────

  async employeeCheckIn(
    principal: Principal,
    institutionId: string,
    input: EmployeeCheckInInput,
  ): Promise<EmployeeAttendanceRow> {
    return this.db.runInTenant(async (tx) => {
      const employee = await this.loadEmployee(tx, institutionId, input.employeeId);
      const day = this.resolveAttendanceDate(input.attendanceDate);
      const checkInAt = input.checkInAt ?? new Date();

      const [existing] = await tx
        .select()
        .from(employeeAttendance)
        .where(
          and(
            eq(employeeAttendance.employeeId, employee.id),
            eq(employeeAttendance.attendanceDate, day),
            isNull(employeeAttendance.archivedAt),
          ),
        )
        .limit(1);

      if (existing?.checkInAt) {
        throw new ConflictError(`${employee.fullNameEn} is already checked in for ${day}.`, {
          employeeAttendanceId: existing.id,
        });
      }

      if (existing) {
        const [updated] = await tx
          .update(employeeAttendance)
          .set({
            checkInAt,
            status: input.status,
            source: input.source,
            deviceReference: input.deviceReference ?? null,
            minutesLate: input.minutesLate ?? null,
            remarks: input.remarks ?? null,
            updatedBy: principal.userId,
            version: existing.version + 1,
          })
          .where(eq(employeeAttendance.id, existing.id))
          .returning();
        return updated!;
      }

      const [created] = await tx
        .insert(employeeAttendance)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          campusId: employee.campusId,
          employeeId: employee.id,
          attendanceDate: day,
          checkInAt,
          status: input.status,
          source: input.source,
          deviceReference: input.deviceReference ?? null,
          minutesLate: input.minutesLate ?? null,
          remarks: input.remarks ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      if (!created) throw new ConflictError('The check-in could not be recorded');
      return created;
    });
  }

  async employeeCheckOut(
    principal: Principal,
    institutionId: string,
    input: EmployeeCheckOutInput,
  ): Promise<EmployeeAttendanceRow> {
    return this.db.runInTenant(async (tx) => {
      const employee = await this.loadEmployee(tx, institutionId, input.employeeId);
      const day = this.resolveAttendanceDate(input.attendanceDate);
      const checkOutAt = input.checkOutAt ?? new Date();

      const [existing] = await tx
        .select()
        .from(employeeAttendance)
        .where(
          and(
            eq(employeeAttendance.employeeId, employee.id),
            eq(employeeAttendance.attendanceDate, day),
            isNull(employeeAttendance.archivedAt),
          ),
        )
        .limit(1);

      if (!existing?.checkInAt) {
        throw new ValidationError(`${employee.fullNameEn} has no check-in recorded for ${day}.`, [
          { path: 'employeeId', message: 'Record the check-in first' },
        ]);
      }
      if (existing.checkOutAt) {
        throw new ConflictError(`${employee.fullNameEn} is already checked out for ${day}.`, {
          employeeAttendanceId: existing.id,
        });
      }
      if (checkOutAt.getTime() < existing.checkInAt.getTime()) {
        throw new ValidationError('The check-out time is before the check-in time', [
          { path: 'checkOutAt', message: 'Check-out must not precede check-in' },
        ]);
      }

      // Integer minutes, floored. Payroll reads this column and must never see a fraction it
      // has to round differently from the report that produced it.
      const workedMinutes = Math.floor(
        (checkOutAt.getTime() - existing.checkInAt.getTime()) / 60_000,
      );

      const [updated] = await tx
        .update(employeeAttendance)
        .set({
          checkOutAt,
          workedMinutes: Math.min(workedMinutes, 1440),
          remarks: input.remarks ?? existing.remarks,
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(eq(employeeAttendance.id, existing.id))
        .returning();

      return updated!;
    });
  }

  async listEmployeeAttendance(
    principal: Principal,
    query: ListEmployeeAttendanceQuery,
    page: OffsetPageRequest,
  ) {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [isNull(employeeAttendance.archivedAt)];

      const institutionId = currentContext()?.institutionId;
      if (institutionId) filters.push(eq(employeeAttendance.institutionId, institutionId));
      if (query.employeeId) filters.push(eq(employeeAttendance.employeeId, query.employeeId));
      if (query.status) {
        filters.push(
          eq(employeeAttendance.status, query.status as EmployeeAttendanceRow['status']),
        );
      }
      if (query.from) filters.push(gte(employeeAttendance.attendanceDate, query.from));
      if (query.to) filters.push(lte(employeeAttendance.attendanceDate, query.to));

      const where = and(...filters);
      const orderBy = parseSort(query.sort, EMPLOYEE_ATTENDANCE_SORT_FIELDS, {
        field: 'attendanceDate',
        direction: 'desc',
      }).map((spec) => {
        const column = EMPLOYEE_ATTENDANCE_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select({
          id: employeeAttendance.id,
          employeeId: employeeAttendance.employeeId,
          employeeNameEn: employees.fullNameEn,
          employeeCode: employees.employeeCode,
          attendanceDate: employeeAttendance.attendanceDate,
          checkInAt: employeeAttendance.checkInAt,
          checkOutAt: employeeAttendance.checkOutAt,
          status: employeeAttendance.status,
          source: employeeAttendance.source,
          minutesLate: employeeAttendance.minutesLate,
          workedMinutes: employeeAttendance.workedMinutes,
          remarks: employeeAttendance.remarks,
          version: employeeAttendance.version,
        })
        .from(employeeAttendance)
        .innerJoin(employees, eq(employees.id, employeeAttendance.employeeId))
        .where(where)
        .orderBy(...orderBy, asc(employeeAttendance.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(employeeAttendance)
        .innerJoin(employees, eq(employees.id, employeeAttendance.employeeId))
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  // ──────────────────────────────────────────────────────────────────────────────────
  // Reports. Every aggregate below is computed by Postgres.
  // ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Per-student totals over a date range.
   *
   * The percentage counts `late` as attended and `half_day` as half, which is what a school
   * means by an attendance percentage; `excused` is authorised but absent and does not count
   * towards it. It is emitted as basis points (an integer) and as a two-decimal string
   * rendered by Postgres `numeric` — never as a float built in JavaScript.
   */
  async studentSummary(
    principal: Principal,
    query: StudentAttendanceSummaryQuery,
    page: OffsetPageRequest,
  ) {
    const scope = this.requireReadScope(principal);

    return this.db.runInTenant(async (tx) => {
      const where = and(...this.summaryFilters(principal, scope, query));

      // `present + late + half a half-day`, as an exact numeric expression evaluated by the
      // database. Kept in one place so the two projections below cannot drift apart.
      const attended = sql`(
        count(*) filter (where ${studentAttendance.status} = 'present')
        + count(*) filter (where ${studentAttendance.status} = 'late')
        + 0.5 * count(*) filter (where ${studentAttendance.status} = 'half_day')
      )`;

      const rows = await tx
        .select({
          studentId: students.id,
          fullNameEn: students.fullNameEn,
          fullNameBn: students.fullNameBn,
          studentCode: students.studentCode,
          totalSessions: sql<number>`count(*)::int`,
          present: sql<number>`count(*) filter (where ${studentAttendance.status} = 'present')::int`,
          absent: sql<number>`count(*) filter (where ${studentAttendance.status} = 'absent')::int`,
          late: sql<number>`count(*) filter (where ${studentAttendance.status} = 'late')::int`,
          excused: sql<number>`count(*) filter (where ${studentAttendance.status} = 'excused')::int`,
          halfDay: sql<number>`count(*) filter (where ${studentAttendance.status} = 'half_day')::int`,
          attendanceBasisPoints: sql<number>`coalesce(round(10000 * ${attended} / nullif(count(*), 0)), 0)::int`,
          attendancePercentage: sql<string>`to_char(coalesce(round(100 * ${attended} / nullif(count(*), 0), 2), 0), 'FM990.00')`,
        })
        .from(studentAttendance)
        .innerJoin(attendanceSessions, eq(attendanceSessions.id, studentAttendance.sessionId))
        .innerJoin(students, eq(students.id, studentAttendance.studentId))
        .where(where)
        .groupBy(students.id, students.fullNameEn, students.fullNameBn, students.studentCode)
        .orderBy(asc(students.fullNameEn), asc(students.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(distinct ${students.id})::int` })
        .from(studentAttendance)
        .innerJoin(attendanceSessions, eq(attendanceSessions.id, studentAttendance.sessionId))
        .innerJoin(students, eq(students.id, studentAttendance.studentId))
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  /** One row per register in the range: how many present, absent, late, and whether it is taken. */
  async sectionDailySummary(principal: Principal, query: SectionAttendanceSummaryQuery) {
    const scope = this.requireReadScope(principal);

    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [
        isNull(attendanceSessions.archivedAt),
        gte(attendanceSessions.attendanceDate, query.from),
        lte(attendanceSessions.attendanceDate, query.to),
        this.sessionScopeFilter(principal, scope),
      ];

      const institutionId = currentContext()?.institutionId;
      if (institutionId) filters.push(eq(attendanceSessions.institutionId, institutionId));
      if (query.sectionId) filters.push(eq(attendanceSessions.sectionId, query.sectionId));
      if (query.academicYearId) {
        filters.push(eq(attendanceSessions.academicYearId, query.academicYearId));
      }

      return tx
        .select({
          sessionId: attendanceSessions.id,
          sectionId: attendanceSessions.sectionId,
          sectionNameEn: sections.nameEn,
          sectionNameBn: sections.nameBn,
          attendanceDate: attendanceSessions.attendanceDate,
          periodId: attendanceSessions.periodId,
          status: attendanceSessions.status,
          marked: sql<number>`count(${studentAttendance.id})::int`,
          present: sql<number>`count(*) filter (where ${studentAttendance.status} = 'present')::int`,
          absent: sql<number>`count(*) filter (where ${studentAttendance.status} = 'absent')::int`,
          late: sql<number>`count(*) filter (where ${studentAttendance.status} = 'late')::int`,
          excused: sql<number>`count(*) filter (where ${studentAttendance.status} = 'excused')::int`,
          halfDay: sql<number>`count(*) filter (where ${studentAttendance.status} = 'half_day')::int`,
        })
        .from(attendanceSessions)
        .innerJoin(sections, eq(sections.id, attendanceSessions.sectionId))
        .leftJoin(
          studentAttendance,
          and(
            eq(studentAttendance.sessionId, attendanceSessions.id),
            isNull(studentAttendance.archivedAt),
          ),
        )
        .where(and(...filters))
        .groupBy(
          attendanceSessions.id,
          attendanceSessions.sectionId,
          sections.nameEn,
          sections.nameBn,
          attendanceSessions.attendanceDate,
          attendanceSessions.periodId,
          attendanceSessions.status,
        )
        .orderBy(desc(attendanceSessions.attendanceDate), asc(sections.nameEn));
    });
  }

  /**
   * Runs of consecutive absences.
   *
   * "Consecutive" means consecutive *registers*, not consecutive calendar days: a Thursday and
   * the following Sunday are consecutive school days in Bangladesh, and a run that resets over
   * every weekend would never reach a threshold worth acting on. The `day_index` CTE numbers
   * the days a register actually exists for the section, and the classic gaps-and-islands
   * subtraction finds the runs.
   *
   * Phase 12's automation engine will call this to notify guardians. Nothing here notifies
   * anybody; producing the list and acting on it are deliberately separate.
   */
  async consecutiveAbsences(principal: Principal, query: ConsecutiveAbsenceQuery) {
    const scope = this.requireReadScope(principal);
    const institutionId = currentContext()?.institutionId ?? null;

    return this.db.runInTenant(async (tx) => {
      const scopeFilter = this.reportScopeFilter(principal, scope);
      const institutionFilter = institutionId
        ? sql`and ${attendanceSessions.institutionId} = ${institutionId}`
        : sql``;
      const sectionFilter = query.sectionId
        ? sql`and ${attendanceSessions.sectionId} = ${query.sectionId}`
        : sql``;
      const yearFilter = query.academicYearId
        ? sql`and ${attendanceSessions.academicYearId} = ${query.academicYearId}`
        : sql``;

      const result = await tx.execute<{
        student_id: string;
        full_name_en: string;
        student_code: string;
        section_id: string;
        section_name_en: string;
        started_on: string;
        ended_on: string;
        days: number;
      }>(sql`
        with session_days as (
          select
            ${attendanceSessions.sectionId} as section_id,
            ${attendanceSessions.attendanceDate} as attendance_date,
            row_number() over (
              partition by ${attendanceSessions.sectionId}
              order by ${attendanceSessions.attendanceDate}
            ) as day_index
          from ${attendanceSessions}
          where ${attendanceSessions.periodId} is null
            and ${attendanceSessions.archivedAt} is null
            and ${attendanceSessions.status} <> 'open'
            and ${attendanceSessions.attendanceDate} between ${query.from} and ${query.to}
            ${institutionFilter}
            ${sectionFilter}
            ${yearFilter}
        ),
        absences as (
          select
            ${studentAttendance.studentId} as student_id,
            session_days.section_id,
            session_days.attendance_date,
            session_days.day_index
          from ${studentAttendance}
          join ${attendanceSessions}
            on ${attendanceSessions.id} = ${studentAttendance.sessionId}
          join session_days
            on session_days.section_id = ${attendanceSessions.sectionId}
           and session_days.attendance_date = ${attendanceSessions.attendanceDate}
          join ${students} on ${students.id} = ${studentAttendance.studentId}
          where ${studentAttendance.status} = 'absent'
            and ${studentAttendance.archivedAt} is null
            and ${students.archivedAt} is null
            and (${scopeFilter})
        ),
        islands as (
          select
            student_id,
            section_id,
            attendance_date,
            day_index - row_number() over (
              partition by student_id, section_id order by day_index
            ) as island
          from absences
        ),
        runs as (
          select
            student_id,
            section_id,
            min(attendance_date) as started_on,
            max(attendance_date) as ended_on,
            count(*)::int as days
          from islands
          group by student_id, section_id, island
        )
        select
          runs.student_id,
          ${students.fullNameEn} as full_name_en,
          ${students.studentCode} as student_code,
          runs.section_id,
          ${sections.nameEn} as section_name_en,
          runs.started_on,
          runs.ended_on,
          runs.days
        from runs
        join ${students} on ${students.id} = runs.student_id
        join ${sections} on ${sections.id} = runs.section_id
        where runs.days >= ${query.minDays}
        order by runs.days desc, runs.ended_on desc
        limit ${query.limit}
      `);

      return result.rows.map((row) => ({
        studentId: row.student_id,
        fullNameEn: row.full_name_en,
        studentCode: row.student_code,
        sectionId: row.section_id,
        sectionNameEn: row.section_name_en,
        startedOn: row.started_on,
        endedOn: row.ended_on,
        consecutiveDays: Number(row.days),
      }));
    });
  }

  // ──────────────────────────────────────────────────────────────────────────────────
  // Scoping
  // ──────────────────────────────────────────────────────────────────────────────────

  private requireReadScope(principal: Principal): DataScope {
    const context = currentContext();
    const scope = resolveDataScope(principal, SCOPED_RESOURCES.attendance, {
      institutionId: context?.institutionId ?? null,
      campusId: context?.campusId ?? null,
    });
    if (scope === 'none') {
      throw new ForbiddenError('attendance.view.all', 'You cannot view attendance records');
    }
    return scope;
  }

  /**
   * Writing needs a scope that names sections. A guardian's `own` scope names children, which
   * says nothing about which register they may write, so it is refused here rather than
   * quietly resolving to an empty filter.
   */
  private requireWriteScope(principal: Principal): DataScope {
    const scope = this.requireReadScope(principal);
    if (scope !== 'all' && scope !== 'assigned') {
      throw new ForbiddenError('attendance.mark', 'You cannot record attendance');
    }
    return scope;
  }

  /**
   * The same rule `StudentsService` uses for `assigned`, anchored on the register's section
   * instead of reached through the student's enrolment: an employee is assigned to a section
   * when they are its class teacher or teach a subject in it.
   */
  private sectionAssignmentFilter(employeeId: string): SQL {
    return or(
      exists(
        this.db.raw
          .select({ one: sql`1` })
          .from(employeeSectionAssignments)
          .where(
            and(
              eq(employeeSectionAssignments.sectionId, attendanceSessions.sectionId),
              eq(employeeSectionAssignments.employeeId, employeeId),
              isNull(employeeSectionAssignments.archivedAt),
            ),
          ),
      ),
      exists(
        this.db.raw
          .select({ one: sql`1` })
          .from(employeeSubjectAssignments)
          .where(
            and(
              eq(employeeSubjectAssignments.sectionId, attendanceSessions.sectionId),
              eq(employeeSubjectAssignments.employeeId, employeeId),
              isNull(employeeSubjectAssignments.archivedAt),
            ),
          ),
      ),
    )!;
  }

  /**
   * Registers this principal may see. `own` yields nothing: a register is the whole class, and
   * a guardian entitled to one child's marks is not entitled to the other fifty-nine. Guardians
   * read attendance through the per-student report, which filters by child.
   */
  private sessionScopeFilter(principal: Principal, scope: DataScope): SQL {
    if (scope === 'all') return sql`true`;
    if (scope === 'assigned') {
      if (!principal.employeeId) return sql`false`;
      return this.sectionAssignmentFilter(principal.employeeId);
    }
    return sql`false`;
  }

  /**
   * Rows a report may aggregate. Assumes both `attendance_sessions` and `students` are in the
   * query, which every report below joins.
   */
  private reportScopeFilter(principal: Principal, scope: DataScope): SQL {
    if (scope === 'all') return sql`true`;
    if (scope === 'assigned') {
      if (!principal.employeeId) return sql`false`;
      return this.sectionAssignmentFilter(principal.employeeId);
    }

    // `own`: a guardian's linked children, resolved exactly as `guardians/my-children` does —
    // a live link with portal access, checked at read time so revoking it takes effect now.
    const conditions: SQL[] = [];
    if (principal.guardianId) {
      const guardianId = principal.guardianId;
      conditions.push(
        exists(
          this.db.raw
            .select({ one: sql`1` })
            .from(studentGuardians)
            .where(
              and(
                eq(studentGuardians.studentId, students.id),
                eq(studentGuardians.guardianId, guardianId),
                eq(studentGuardians.canAccessPortal, true),
                isNull(studentGuardians.archivedAt),
              ),
            ),
        ),
      );
    }
    if (principal.studentId) {
      conditions.push(eq(students.id, principal.studentId));
    }
    if (conditions.length === 0) return sql`false`;
    return conditions.length === 1 ? conditions[0]! : or(...conditions)!;
  }

  private summaryFilters(
    principal: Principal,
    scope: DataScope,
    query: StudentAttendanceSummaryQuery,
  ): SQL[] {
    const filters: SQL[] = [
      isNull(studentAttendance.archivedAt),
      isNull(attendanceSessions.archivedAt),
      isNull(students.archivedAt),
      gte(attendanceSessions.attendanceDate, query.from),
      lte(attendanceSessions.attendanceDate, query.to),
      this.reportScopeFilter(principal, scope),
    ];

    const institutionId = currentContext()?.institutionId;
    if (institutionId) filters.push(eq(attendanceSessions.institutionId, institutionId));
    if (query.studentId) filters.push(eq(studentAttendance.studentId, query.studentId));
    if (query.sectionId) filters.push(eq(attendanceSessions.sectionId, query.sectionId));
    if (query.academicYearId) {
      filters.push(eq(attendanceSessions.academicYearId, query.academicYearId));
    }
    return filters;
  }

  // ──────────────────────────────────────────────────────────────────────────────────
  // Shared checks
  // ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Load a register the caller may see.
   *
   * The scope filter is applied here exactly as in `listSessions`, so a section belonging to
   * another teacher — or another tenant — is a 404 rather than a 403.
   */
  private async loadVisibleSession(
    tx: Tx,
    principal: Principal,
    scope: DataScope,
    sessionId: string,
  ): Promise<SessionRow> {
    const [session] = await tx
      .select()
      .from(attendanceSessions)
      .where(
        and(
          eq(attendanceSessions.id, sessionId),
          isNull(attendanceSessions.archivedAt),
          this.sessionScopeFilter(principal, scope),
        ),
      )
      .limit(1);
    if (!session) throw new NotFoundError('Attendance register', sessionId);
    return session;
  }

  private async loadSection(tx: Tx, institutionId: string, sectionId: string) {
    const [section] = await tx
      .select({
        id: sections.id,
        institutionId: sections.institutionId,
        campusId: sections.campusId,
        academicYearId: sections.academicYearId,
        shiftId: sections.shiftId,
      })
      .from(sections)
      .where(
        and(
          eq(sections.id, sectionId),
          eq(sections.institutionId, institutionId),
          isNull(sections.archivedAt),
        ),
      )
      .limit(1);
    // A section in another institution of the same tenant is a 404 for the same reason a
    // section in another tenant is: the caller has no business learning that it exists.
    if (!section) throw new NotFoundError('Section', sectionId);
    return section;
  }

  private async assertSectionAssigned(
    tx: Tx,
    principal: Principal,
    scope: DataScope,
    sectionId: string,
  ): Promise<void> {
    if (scope === 'all') return;
    if (scope !== 'assigned' || !principal.employeeId) {
      throw new NotFoundError('Section', sectionId);
    }
    const employeeId = principal.employeeId;

    const [assigned] = await tx
      .select({ one: sql<number>`1` })
      .from(sections)
      .where(
        and(
          eq(sections.id, sectionId),
          or(
            exists(
              this.db.raw
                .select({ one: sql`1` })
                .from(employeeSectionAssignments)
                .where(
                  and(
                    eq(employeeSectionAssignments.sectionId, sections.id),
                    eq(employeeSectionAssignments.employeeId, employeeId),
                    isNull(employeeSectionAssignments.archivedAt),
                  ),
                ),
            ),
            exists(
              this.db.raw
                .select({ one: sql`1` })
                .from(employeeSubjectAssignments)
                .where(
                  and(
                    eq(employeeSubjectAssignments.sectionId, sections.id),
                    eq(employeeSubjectAssignments.employeeId, employeeId),
                    isNull(employeeSubjectAssignments.archivedAt),
                  ),
                ),
            ),
          )!,
        ),
      )
      .limit(1);

    if (!assigned) {
      // 404, not 403: a teacher probing section ids must not be able to tell which of them
      // exist in the school.
      throw new NotFoundError('Section', sectionId);
    }
  }

  /**
   * The calendar rules, in the order a school would state them.
   *
   * The weekend is read from `academic_years.weekend_days` rather than assumed to be
   * Friday–Saturday: `isDefaultBdWeekend` is documented as a default, and English-medium
   * schools and coaching centres genuinely differ.
   */
  private async assertDateIsTeachingDay(
    tx: Tx,
    section: { academicYearId: string; campusId: string },
    value: string,
  ): Promise<void> {
    const day = calendarDate(value);

    if (compareCalendarDates(day, todayInDhaka()) > 0) {
      throw new ValidationError('You cannot record attendance for a date in the future', [
        { path: 'attendanceDate', message: 'Choose today or an earlier date' },
      ]);
    }

    const [year] = await tx
      .select({
        id: academicYears.id,
        startDate: academicYears.startDate,
        endDate: academicYears.endDate,
        weekendDays: academicYears.weekendDays,
      })
      .from(academicYears)
      .where(and(eq(academicYears.id, section.academicYearId), isNull(academicYears.archivedAt)))
      .limit(1);

    if (!year) throw new NotFoundError('Academic year', section.academicYearId);

    if (!isWithin(day, calendarDate(year.startDate), calendarDate(year.endDate))) {
      throw new ValidationError('That date is outside the academic year', [
        {
          path: 'attendanceDate',
          message: `The academic year runs from ${year.startDate} to ${year.endDate}`,
        },
      ]);
    }

    const events = await tx
      .select({
        titleEn: calendarEvents.titleEn,
        kind: calendarEvents.kind,
        isNonTeaching: calendarEvents.isNonTeaching,
        overridesWeekend: calendarEvents.overridesWeekend,
      })
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.academicYearId, year.id),
          isNull(calendarEvents.archivedAt),
          lte(calendarEvents.startDate, value),
          gte(calendarEvents.endDate, value),
          or(isNull(calendarEvents.campusId), eq(calendarEvents.campusId, section.campusId))!,
        ),
      );

    const closure = events.find((event) => event.isNonTeaching);
    if (closure) {
      throw new ValidationError(
        `The school is closed on ${value} (${closure.titleEn}). Attendance cannot be recorded.`,
        [{ path: 'attendanceDate', message: `${closure.titleEn} is a non-teaching day` }],
      );
    }

    const weekend = parseWeekendDays(year.weekendDays);
    if (weekend.includes(dhakaWeekday(day)) && !events.some((event) => event.overridesWeekend)) {
      throw new ValidationError(
        `${value} is a weekend for this institution. Attendance cannot be recorded.`,
        [{ path: 'attendanceDate', message: 'Choose a working day' }],
      );
    }
  }

  private async assertPeriodUsable(
    tx: Tx,
    institutionId: string,
    periodId: string,
    section: { shiftId: string | null },
  ): Promise<void> {
    const [period] = await tx
      .select({ id: periods.id, shiftId: periods.shiftId, isBreak: periods.isBreak })
      .from(periods)
      .where(
        and(
          eq(periods.id, periodId),
          eq(periods.institutionId, institutionId),
          isNull(periods.archivedAt),
        ),
      )
      .limit(1);

    if (!period) throw new NotFoundError('Period', periodId);

    if (period.isBreak) {
      throw new ValidationError('Attendance cannot be taken during a break', [
        { path: 'periodId', message: 'Choose a teaching period' },
      ]);
    }
    if (section.shiftId && period.shiftId !== section.shiftId) {
      throw new ValidationError('That period belongs to a different shift', [
        { path: 'periodId', message: 'Choose a period from this section’s shift' },
      ]);
    }
  }

  private async assertSubjectExists(
    tx: Tx,
    institutionId: string,
    subjectId: string,
  ): Promise<void> {
    const [subject] = await tx
      .select({ id: subjects.id })
      .from(subjects)
      .where(
        and(
          eq(subjects.id, subjectId),
          eq(subjects.institutionId, institutionId),
          isNull(subjects.archivedAt),
        ),
      )
      .limit(1);
    if (!subject) throw new NotFoundError('Subject', subjectId);
  }

  private async loadEmployee(tx: Tx, institutionId: string, employeeId: string) {
    const [employee] = await tx
      .select({
        id: employees.id,
        campusId: employees.campusId,
        fullNameEn: employees.fullNameEn,
      })
      .from(employees)
      .where(
        and(
          eq(employees.id, employeeId),
          eq(employees.institutionId, institutionId),
          isNull(employees.archivedAt),
        ),
      )
      .limit(1);
    if (!employee) throw new NotFoundError('Employee', employeeId);
    return employee;
  }

  /** Enrolled in this section, on this date. The single definition, used by roster and submit. */
  private enrolledOnDateFilter(sectionId: string, day: string): SQL {
    return and(
      eq(enrollments.sectionId, sectionId),
      ne(enrollments.status, 'cancelled'),
      isNull(enrollments.archivedAt),
      isNull(students.archivedAt),
      lte(enrollments.enrolledOn, day),
      or(isNull(enrollments.endedOn), gte(enrollments.endedOn, day))!,
    )!;
  }

  private resolveAttendanceDate(value: string | undefined): string {
    const day = value ? calendarDate(value) : todayInDhaka();
    if (compareCalendarDates(day, todayInDhaka()) > 0) {
      throw new ValidationError('You cannot record attendance for a date in the future', [
        { path: 'attendanceDate', message: 'Choose today or an earlier date' },
      ]);
    }
    return day;
  }

  /** Write the approved values onto the mark. Never called outside a correction transaction. */
  private async applyCorrection(
    tx: Tx,
    principal: Principal,
    correction: CorrectionRow,
    mark: MarkRow,
  ): Promise<MarkRow> {
    const [updated] = await tx
      .update(studentAttendance)
      .set({
        status: correction.newStatus,
        minutesLate: correction.newMinutesLate,
        lastCorrectedAt: new Date(),
        updatedBy: principal.userId,
        version: mark.version + 1,
      })
      .where(and(eq(studentAttendance.id, mark.id), eq(studentAttendance.version, mark.version)))
      .returning();

    if (!updated) {
      throw new ConflictError(
        'This mark was changed by someone else while the correction was being applied. Reload and try again.',
        { expectedVersion: mark.version },
      );
    }
    return updated;
  }
}

/** `minutesLate` is only meaningful on a late arrival; anything else is dropped. */
function normalizeMinutesLate(
  status: MarkStatus,
  minutes: number | null | undefined,
): number | null {
  if (!LATE_STATUSES.has(status)) return null;
  return minutes ?? null;
}

/**
 * `academic_years.weekend_days` is jsonb, so it arrives as `unknown`. A malformed value falls
 * back to "no weekend" rather than to Friday–Saturday: refusing attendance on a day the school
 * is actually open is a worse failure than allowing it on one it is not, and the holiday check
 * still runs either way.
 */
function parseWeekendDays(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((day) => Number(day))
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
}

const SESSION_COLUMNS = {
  attendanceDate: attendanceSessions.attendanceDate,
  status: attendanceSessions.status,
  createdAt: attendanceSessions.createdAt,
} as const;

const CORRECTION_COLUMNS = {
  requestedAt: attendanceCorrections.requestedAt,
  status: attendanceCorrections.status,
  createdAt: attendanceCorrections.createdAt,
} as const;

const EMPLOYEE_ATTENDANCE_COLUMNS = {
  attendanceDate: employeeAttendance.attendanceDate,
  createdAt: employeeAttendance.createdAt,
} as const;
