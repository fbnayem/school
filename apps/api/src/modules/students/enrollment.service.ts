/**
 * Enrolment lifecycle (Phase 3 completion): standalone enrolment, withdrawal, readmission,
 * bulk promotion and bulk status change.
 *
 * Design rules this service holds to:
 *
 *  1. **One transaction per action.** A promotion that half-commits leaves a class register
 *     that never existed in reality; everything from the old enrolment's closure to the
 *     status-history row commits or rolls back together.
 *  2. **Visibility is checked inside the same transaction as the mutation**, through
 *     `StudentsService.loadVisible`, so the scope rule applied here is byte-for-byte the one
 *     `GET /students/:id` applies.
 *  3. **Nothing is deleted.** A closed enrolment keeps its row with a terminal status; a
 *     withdrawal sets a status; history is append-only.
 *  4. **Promotion is a report, not a boolean.** Every student in the source section appears
 *     in the result exactly once with what happened to them and why — retained is a choice,
 *     skipped has a reason, and re-running the same promotion is a no-op per student.
 */

import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { classLevels, enrollments, sections, students, studentStatusHistory } from '@shikkha/db';
import { NotFoundError, ValidationError, WorkflowStateError } from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import type {
  BulkStatusChangeInput,
  EnrollStudentInput,
  PromoteSectionInput,
  ReadmitStudentInput,
  WithdrawStudentInput,
} from '@shikkha/validation';
import { DatabaseService } from '../database/database.service';
import { StudentsService, type EnrollmentRow, type StudentRow, type Tx } from './students.service';

export type PromotionOutcome = 'promoted' | 'retained' | 'skipped';

export interface PromotionResult {
  studentId: string;
  outcome: PromotionOutcome;
  /** Present when `outcome` is `skipped`. */
  reason?:
    'already_enrolled_in_target_year' | 'unpaid_dues' | 'section_full' | 'not_in_source_section';
  enrollmentId?: string;
}

export interface PromotionReport {
  targetAcademicYearId: string;
  results: PromotionResult[];
  summary: { promoted: number; retained: number; skipped: number };
}

export type BulkStatusOutcome = 'changed' | 'unchanged' | 'not_found';

export interface BulkStatusResult {
  studentId: string;
  outcome: BulkStatusOutcome;
  fromStatus?: StudentRow['status'];
}

@Injectable()
export class EnrollmentService {
  constructor(
    private readonly db: DatabaseService,
    private readonly students: StudentsService,
  ) {}

  /**
   * Enrol an existing student into a section for an academic year.
   *
   * Capacity, double-enrolment, year membership and institution membership are all enforced
   * by `StudentsService.insertEnrollment`; this method adds the lifecycle rules — the student
   * must be enrollable at all — and the status-history row.
   */
  async enroll(
    principal: Principal,
    institutionId: string,
    studentId: string,
    input: EnrollStudentInput,
  ): Promise<EnrollmentRow> {
    const scope = this.students.requireScope(principal);

    return this.db.runInTenant(async (tx) => {
      const student = await this.students.loadVisible(tx, principal, scope, studentId);
      if (student.institutionId !== institutionId) {
        // The student exists in this tenant but not in the institution the caller is acting
        // in. 404, not 403: confirming where the record lives is itself a leak.
        throw new NotFoundError('Student', studentId);
      }

      if (student.status !== 'active' && student.status !== 'on_leave') {
        // A withdrawn or transferred student re-enters through readmission, which restores
        // their status alongside the enrolment. Enrolling them directly would leave the
        // person marked withdrawn while occupying a seat.
        throw new WorkflowStateError(student.status, 'enrolled', 'student');
      }

      const enrollment = await this.students.insertEnrollment(tx, {
        tenantId: student.tenantId,
        institutionId,
        studentId,
        academicYearId: input.academicYearId,
        sectionId: input.sectionId,
        rollNumber: input.rollNumber,
        groupId: input.groupId ?? null,
        enrolledOn: input.enrolledOn,
        isRepeating: input.isRepeating,
        actorUserId: principal.userId,
      });

      await tx.insert(studentStatusHistory).values({
        tenantId: student.tenantId,
        institutionId,
        studentId,
        enrollmentId: enrollment.id,
        event: 'enrolled',
        fromStatus: student.status,
        toStatus: student.status,
        effectiveDate: input.enrolledOn,
        createdBy: principal.userId,
      });

      return enrollment;
    });
  }

  /**
   * Withdraw a student: every live enrolment closes (which frees the section seats), the
   * person's status becomes `withdrawn`, and the history records when and why. No row is
   * deleted; the enrolments keep their terminal status forever.
   */
  async withdraw(
    principal: Principal,
    institutionId: string,
    studentId: string,
    input: WithdrawStudentInput,
  ): Promise<{ student: StudentRow; closedEnrollmentIds: string[] }> {
    const scope = this.students.requireScope(principal);

    return this.db.runInTenant(async (tx) => {
      const student = await this.students.loadVisible(tx, principal, scope, studentId);
      if (student.institutionId !== institutionId) {
        throw new NotFoundError('Student', studentId);
      }
      if (student.status === 'withdrawn') {
        throw new WorkflowStateError('withdrawn', 'withdrawn', 'student');
      }

      const liveEnrollments = await tx
        .select({ id: enrollments.id, version: enrollments.version })
        .from(enrollments)
        .where(
          and(
            eq(enrollments.studentId, studentId),
            eq(enrollments.status, 'active'),
            isNull(enrollments.archivedAt),
          ),
        );

      const closedEnrollmentIds: string[] = [];
      for (const row of liveEnrollments) {
        await tx
          .update(enrollments)
          .set({
            status: 'withdrawn',
            endedOn: input.effectiveDate,
            endReason: input.reason.slice(0, 255),
            // Archived — soft, reversible, still queryable — so the (student, year) slot in
            // `enrollments_student_year_key` frees up: a readmission later in the same
            // academic year opens a new enrolment rather than colliding with this one.
            archivedAt: new Date(),
            archivedBy: principal.userId,
            archiveReason: input.reason.slice(0, 500),
            version: row.version + 1,
            updatedBy: principal.userId,
          })
          .where(eq(enrollments.id, row.id));
        closedEnrollmentIds.push(row.id);
      }

      const [updated] = await tx
        .update(students)
        .set({
          status: 'withdrawn',
          statusChangedAt: new Date(),
          statusReason: input.reason.slice(0, 500),
          version: student.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(students.id, studentId))
        .returning();

      await tx.insert(studentStatusHistory).values({
        tenantId: student.tenantId,
        institutionId,
        studentId,
        enrollmentId: closedEnrollmentIds[0] ?? null,
        event: 'withdrawn',
        fromStatus: student.status,
        toStatus: 'withdrawn',
        effectiveDate: input.effectiveDate,
        reason: input.reason,
        createdBy: principal.userId,
      });

      return { student: updated!, closedEnrollmentIds };
    });
  }

  /**
   * Readmission: a withdrawn (or transferred-away) student returns with a brand-new
   * enrolment. The old rows are untouched — a transfer certificate printed next year must
   * still show the withdrawal and the return.
   */
  async readmit(
    principal: Principal,
    institutionId: string,
    studentId: string,
    input: ReadmitStudentInput,
  ): Promise<{ student: StudentRow; enrollment: EnrollmentRow }> {
    const scope = this.students.requireScope(principal);

    return this.db.runInTenant(async (tx) => {
      const student = await this.students.loadVisible(tx, principal, scope, studentId);
      if (student.institutionId !== institutionId) {
        throw new NotFoundError('Student', studentId);
      }
      if (student.status !== 'withdrawn' && student.status !== 'transferred') {
        throw new WorkflowStateError(student.status, 'active', 'student');
      }

      const enrollment = await this.students.insertEnrollment(tx, {
        tenantId: student.tenantId,
        institutionId,
        studentId,
        academicYearId: input.academicYearId,
        sectionId: input.sectionId,
        rollNumber: input.rollNumber ?? null,
        enrolledOn: input.effectiveDate,
        actorUserId: principal.userId,
      });

      const [updated] = await tx
        .update(students)
        .set({
          status: 'active',
          statusChangedAt: new Date(),
          statusReason: input.reason?.slice(0, 500) ?? null,
          version: student.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(students.id, studentId))
        .returning();

      await tx.insert(studentStatusHistory).values({
        tenantId: student.tenantId,
        institutionId,
        studentId,
        enrollmentId: enrollment.id,
        event: 'readmitted',
        fromStatus: student.status,
        toStatus: 'active',
        effectiveDate: input.effectiveDate,
        reason: input.reason ?? null,
        createdBy: principal.userId,
      });

      return { student: updated!, enrollment };
    });
  }

  /**
   * Bulk promotion of a section into the next academic year, one transaction, idempotent
   * per (student, target academic year).
   *
   * Idempotency comes from the year itself: a student already holding a live enrolment in
   * the target year — from a previous run, or from a manual enrolment — is reported as
   * skipped, not double-enrolled, and the partial unique index `enrollments_student_year_key`
   * is the backstop if two runs race.
   *
   * Students with unpaid dues in the source year are skipped: an invoice with an outstanding
   * balance (`issued`, `partially_paid` or `overdue`) is this product's unpaid-dues hold.
   * Skipping, not blocking the run — the rest of the class must not wait on one family.
   */
  async promote(
    principal: Principal,
    institutionId: string,
    input: PromoteSectionInput,
  ): Promise<PromotionReport> {
    return this.db.runInTenant(async (tx) => {
      const tenantId = principal.tenantId!;
      const source = await this.loadSection(tx, institutionId, input.sourceSectionId);
      const target = await this.loadSection(tx, institutionId, input.targetSectionId);

      if (target.academicYearId === source.academicYearId) {
        throw new ValidationError('Promotion moves students into a different academic year', [
          { path: 'targetSectionId', message: 'The target section is in the same academic year' },
        ]);
      }

      const [sourceLevel] = await tx
        .select({ ordinal: classLevels.ordinal })
        .from(classLevels)
        .where(eq(classLevels.id, source.classLevelId))
        .limit(1);
      const [targetLevel] = await tx
        .select({ ordinal: classLevels.ordinal })
        .from(classLevels)
        .where(eq(classLevels.id, target.classLevelId))
        .limit(1);
      if (!sourceLevel || !targetLevel || targetLevel.ordinal <= sourceLevel.ordinal) {
        throw new ValidationError('Promotion must move students to a higher class', [
          {
            path: 'targetSectionId',
            message: 'The target section is not in a higher class than the source section',
          },
        ]);
      }

      let repeat: SectionSummary | null = null;
      if (input.repeatSectionId) {
        repeat = await this.loadSection(tx, institutionId, input.repeatSectionId);
        if (repeat.academicYearId !== target.academicYearId) {
          throw new ValidationError('Retained students repeat in the target academic year', [
            {
              path: 'repeatSectionId',
              message: 'Repeat section is not in the target academic year',
            },
          ]);
        }
        if (repeat.classLevelId !== source.classLevelId) {
          throw new ValidationError('Retained students repeat the same class', [
            { path: 'repeatSectionId', message: 'Repeat section is not in the source class level' },
          ]);
        }
      }

      // The source register: every live occupant of the source section, in roll order so the
      // target section's new rolls follow the old ordering.
      const sourceEnrollments = await tx
        .select({
          id: enrollments.id,
          studentId: enrollments.studentId,
          rollNumber: enrollments.rollNumber,
          version: enrollments.version,
        })
        .from(enrollments)
        .where(
          and(
            eq(enrollments.sectionId, input.sourceSectionId),
            eq(enrollments.status, 'active'),
            isNull(enrollments.archivedAt),
          ),
        )
        .orderBy(sql`length(${enrollments.rollNumber})`, enrollments.rollNumber);

      const sourceStudentIds = sourceEnrollments.map((row) => row.studentId);
      const retained = new Set(input.retainedStudentIds);

      // Idempotency read: who already holds a live enrolment in the target year?
      const alreadyEnrolled = new Set<string>();
      if (sourceStudentIds.length > 0) {
        const rows = await tx
          .select({ studentId: enrollments.studentId })
          .from(enrollments)
          .where(
            and(
              inArray(enrollments.studentId, sourceStudentIds),
              eq(enrollments.academicYearId, target.academicYearId),
              sql`${enrollments.status} <> 'cancelled'`,
              isNull(enrollments.archivedAt),
            ),
          );
        for (const row of rows) alreadyEnrolled.add(row.studentId);
      }

      // The unpaid-dues hold, derived from the fee module's invoices (migration 0009): an
      // invoice for the source year with an outstanding balance. Raw SQL because the fee
      // schema belongs to another module; RLS still applies inside this tenant transaction.
      const duesHeld = new Set<string>();
      if (sourceStudentIds.length > 0) {
        const result = (await tx.execute(sql`
          select distinct student_id
          from public.invoices
          where academic_year_id = ${source.academicYearId}
            and status in ('issued', 'partially_paid', 'overdue')
            and balance > 0
            and archived_at is null
        `)) as unknown as { rows?: Array<{ student_id: string }> };
        for (const row of result.rows ?? []) duesHeld.add(row.student_id);
      }

      // Seat budgets, decremented locally as we insert. `insertEnrollment` re-checks, but by
      // budgeting here a full section becomes a per-student "skipped" rather than a failed run.
      let targetSeats =
        target.capacity === null
          ? Number.POSITIVE_INFINITY
          : target.capacity - (await this.students.activeSeatCount(tx, target.id));
      let repeatSeats = repeat
        ? repeat.capacity === null
          ? Number.POSITIVE_INFINITY
          : repeat.capacity - (await this.students.activeSeatCount(tx, repeat.id))
        : 0;

      const results: PromotionResult[] = [];

      for (const row of sourceEnrollments) {
        const isRetained = retained.has(row.studentId);
        retained.delete(row.studentId);

        if (alreadyEnrolled.has(row.studentId)) {
          results.push({
            studentId: row.studentId,
            outcome: 'skipped',
            reason: 'already_enrolled_in_target_year',
          });
          continue;
        }
        if (duesHeld.has(row.studentId)) {
          results.push({ studentId: row.studentId, outcome: 'skipped', reason: 'unpaid_dues' });
          continue;
        }

        const destination = isRetained ? repeat! : target;
        const seatsLeft = isRetained ? repeatSeats : targetSeats;
        if (seatsLeft <= 0) {
          results.push({ studentId: row.studentId, outcome: 'skipped', reason: 'section_full' });
          continue;
        }

        const enrollment = await this.students.insertEnrollment(tx, {
          tenantId,
          institutionId,
          studentId: row.studentId,
          academicYearId: destination.academicYearId,
          sectionId: destination.id,
          rollNumber: null,
          enrolledOn: input.effectiveDate,
          isRepeating: isRetained,
          promotedFromEnrollmentId: row.id,
          actorUserId: principal.userId,
        });
        if (isRetained) repeatSeats -= 1;
        else targetSeats -= 1;

        await tx
          .update(enrollments)
          .set({
            status: isRetained ? 'repeated' : 'promoted',
            endedOn: input.effectiveDate,
            endReason: isRetained
              ? 'Retained for the next academic year'
              : 'Promoted to the next class',
            version: row.version + 1,
            updatedBy: principal.userId,
          })
          .where(eq(enrollments.id, row.id));

        await tx.insert(studentStatusHistory).values({
          tenantId,
          institutionId,
          studentId: row.studentId,
          enrollmentId: enrollment.id,
          event: isRetained ? 'repeated' : 'promoted',
          fromStatus: 'active',
          toStatus: 'active',
          effectiveDate: input.effectiveDate,
          createdBy: principal.userId,
        });

        results.push({
          studentId: row.studentId,
          outcome: isRetained ? 'retained' : 'promoted',
          enrollmentId: enrollment.id,
        });
      }

      // Ids named as retained but not present in the source section. Reported rather than
      // silently ignored — a typo in a student id must be visible in the run's report.
      for (const strayId of retained) {
        results.push({ studentId: strayId, outcome: 'skipped', reason: 'not_in_source_section' });
      }

      const summary = {
        promoted: results.filter((r) => r.outcome === 'promoted').length,
        retained: results.filter((r) => r.outcome === 'retained').length,
        skipped: results.filter((r) => r.outcome === 'skipped').length,
      };

      return { targetAcademicYearId: target.academicYearId, results, summary };
    });
  }

  /**
   * Bulk status change, preview or commit. The preview computes exactly what the commit
   * would do, using the same code path, and writes nothing.
   *
   * Only `active` and `on_leave` are reachable here (enforced by the schema): withdrawal,
   * transfer and readmission each carry consequences — closed enrolments, freed seats — that
   * a flat status write would skip, so they have their own endpoints.
   */
  async bulkStatusChange(
    principal: Principal,
    institutionId: string,
    input: BulkStatusChangeInput,
    mode: 'preview' | 'commit',
  ): Promise<{ results: BulkStatusResult[]; changedStudentIds: string[] }> {
    const scope = this.students.requireScope(principal);

    return this.db.runInTenant(async (tx) => {
      const visible = await tx
        .select()
        .from(students)
        .where(
          and(
            inArray(students.id, input.studentIds),
            eq(students.institutionId, institutionId),
            isNull(students.archivedAt),
            // The same scope filter as every other read; a student outside the caller's
            // scope is reported as not found, never revealed.
            this.scopeFilterFor(principal, scope),
          ),
        );
      const byId = new Map(visible.map((row) => [row.id, row]));

      const results: BulkStatusResult[] = [];
      const changedStudentIds: string[] = [];

      for (const studentId of input.studentIds) {
        const student = byId.get(studentId);
        if (!student) {
          results.push({ studentId, outcome: 'not_found' });
          continue;
        }
        if (student.status === input.status) {
          results.push({ studentId, outcome: 'unchanged', fromStatus: student.status });
          continue;
        }
        // Only the two schema-allowed statuses are settable, and only from one another or
        // from `active`/`on_leave` — a withdrawn student is not silently reactivated here.
        if (student.status !== 'active' && student.status !== 'on_leave') {
          throw new WorkflowStateError(student.status, input.status, 'student');
        }

        results.push({ studentId, outcome: 'changed', fromStatus: student.status });
        changedStudentIds.push(studentId);

        if (mode === 'commit') {
          await tx
            .update(students)
            .set({
              status: input.status,
              statusChangedAt: new Date(),
              statusReason: input.reason.slice(0, 500),
              version: student.version + 1,
              updatedBy: principal.userId,
            })
            .where(eq(students.id, studentId));

          await tx.insert(studentStatusHistory).values({
            tenantId: student.tenantId,
            institutionId,
            studentId,
            event: 'status_changed',
            fromStatus: student.status,
            toStatus: input.status,
            effectiveDate: input.effectiveDate,
            reason: input.reason,
            createdBy: principal.userId,
          });
        }
      }

      return { results, changedStudentIds };
    });
  }

  // ────────────────────────────────────────────────────────────────────────────────────

  /**
   * The students scope filter, reachable from this service for set-based queries. Delegates
   * to the single implementation in `StudentsService` via a one-row probe being impossible
   * here — so this simply re-exposes the same SQL builder.
   */
  private scopeFilterFor(principal: Principal, scope: ReturnType<StudentsService['requireScope']>) {
    return this.students.scopeFilterSql(principal, scope);
  }

  private async loadSection(
    tx: Tx,
    institutionId: string,
    sectionId: string,
  ): Promise<SectionSummary> {
    const [section] = await tx
      .select({
        id: sections.id,
        institutionId: sections.institutionId,
        academicYearId: sections.academicYearId,
        classLevelId: sections.classLevelId,
        capacity: sections.capacity,
      })
      .from(sections)
      .where(and(eq(sections.id, sectionId), isNull(sections.archivedAt)))
      .limit(1);

    if (!section || section.institutionId !== institutionId) {
      // Cross-institution references inside the same tenant are the case RLS cannot catch;
      // a 404 keyed to the offending field is the whole response.
      throw new NotFoundError('Section', sectionId);
    }
    return section;
  }
}

interface SectionSummary {
  id: string;
  institutionId: string;
  academicYearId: string;
  classLevelId: string;
  capacity: number | null;
}
