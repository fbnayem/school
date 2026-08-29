/**
 * Transfers (Phase 3 completion): section-to-section within an institution, and
 * institution-to-institution within a tenant, plus the bulk section reassignment.
 *
 * The one non-obvious mechanic: **a same-year section move archives the old enrolment row.**
 * `enrollments_student_year_key` allows one live enrolment per (student, academic year) among
 * non-cancelled, non-archived rows — the invariant that makes promotion idempotent — so the
 * closed row steps out of the index by being archived (soft, reversible, still queryable),
 * not by being deleted. An inter-institution transfer does not need this: the target
 * institution has its own academic-year rows, so the key never collides.
 */

import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { enrollments, institutions, sections, students, studentStatusHistory } from '@shikkha/db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@shikkha/shared';
import { can, type Principal } from '@shikkha/permissions';
import type {
  BulkSectionChangeInput,
  TransferInstitutionInput,
  TransferSectionInput,
} from '@shikkha/validation';
import { DatabaseService } from '../database/database.service';
import { StudentsService, type EnrollmentRow, type StudentRow, type Tx } from './students.service';

export type SectionChangeOutcome =
  | 'moved'
  | 'not_found'
  | 'no_active_enrollment'
  | 'already_in_target_section'
  | 'different_academic_year'
  | 'different_class_level'
  | 'section_full';

export interface SectionChangeResult {
  studentId: string;
  outcome: SectionChangeOutcome;
  enrollmentId?: string;
}

interface ActiveEnrollment {
  id: string;
  sectionId: string;
  academicYearId: string;
  classLevelId: string;
  rollNumber: string;
  version: number;
}

@Injectable()
export class TransfersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly students: StudentsService,
  ) {}

  /** Move a student to another section of the same class, year and institution. */
  async transferSection(
    principal: Principal,
    institutionId: string,
    studentId: string,
    input: TransferSectionInput,
  ): Promise<{ student: StudentRow; enrollment: EnrollmentRow; closedEnrollmentId: string }> {
    const scope = this.students.requireScope(principal);

    return this.db.runInTenant(async (tx) => {
      const student = await this.students.loadVisible(tx, principal, scope, studentId);
      if (student.institutionId !== institutionId) {
        throw new NotFoundError('Student', studentId);
      }

      const current = await this.activeEnrollmentOf(tx, studentId);
      if (!current) {
        throw new ConflictError('This student has no active enrolment to transfer.');
      }
      if (current.sectionId === input.targetSectionId) {
        throw new ConflictError('The student is already in that section.');
      }

      const target = await this.loadSection(tx, institutionId, input.targetSectionId);
      if (target.academicYearId !== current.academicYearId) {
        throw new ValidationError('A section transfer stays within the academic year', [
          {
            path: 'targetSectionId',
            message: 'The target section is in a different academic year — use promotion instead',
          },
        ]);
      }
      if (target.classLevelId !== current.classLevelId) {
        throw new ValidationError('A section transfer stays within the class', [
          { path: 'targetSectionId', message: 'The target section is in a different class' },
        ]);
      }

      const closed = await this.closeAndArchiveEnrollment(
        tx,
        principal,
        current,
        input.effectiveDate,
        input.reason,
      );

      const enrollment = await this.students.insertEnrollment(tx, {
        tenantId: student.tenantId,
        institutionId,
        studentId,
        academicYearId: target.academicYearId,
        sectionId: target.id,
        rollNumber: input.rollNumber ?? null,
        enrolledOn: input.effectiveDate,
        actorUserId: principal.userId,
      });

      await tx.insert(studentStatusHistory).values({
        tenantId: student.tenantId,
        institutionId,
        studentId,
        enrollmentId: enrollment.id,
        event: 'section_changed',
        fromStatus: student.status,
        toStatus: student.status,
        effectiveDate: input.effectiveDate,
        reason: input.reason,
        createdBy: principal.userId,
      });

      return { student, enrollment, closedEnrollmentId: closed };
    });
  }

  /**
   * Transfer a student to another institution of the same tenant.
   *
   * One transaction: the old enrolment closes, the student row moves (keeping its id, so
   * every historical enrolment, document and history row still points at the same person),
   * a new enrolment opens in the target institution, and **both** institutions get a
   * status-history row — the source records `transferred_out`, the target `transferred_in`.
   */
  async transferInstitution(
    principal: Principal,
    institutionId: string,
    studentId: string,
    input: TransferInstitutionInput,
  ): Promise<{
    student: StudentRow;
    enrollment: EnrollmentRow;
    closedEnrollmentIds: string[];
  }> {
    const scope = this.students.requireScope(principal);

    if (input.targetInstitutionId === institutionId) {
      throw new ValidationError('The target institution is the current one', [
        {
          path: 'targetInstitutionId',
          message: 'Use a section transfer to move a student within the institution',
        },
      ]);
    }

    // The caller needs transfer authority in the *target* institution too — moving a student
    // into a school you do not administer is exactly what institution-scoped grants exist to
    // prevent. Checked against the grant context, not the header.
    if (!can(principal, 'students.transfer', { institutionId: input.targetInstitutionId })) {
      throw new ForbiddenError(
        'students.transfer',
        'You cannot transfer students into that institution',
      );
    }

    return this.db.runInTenant(async (tx) => {
      const student = await this.students.loadVisible(tx, principal, scope, studentId);
      if (student.institutionId !== institutionId) {
        throw new NotFoundError('Student', studentId);
      }

      // RLS scopes this read to the tenant, so an id from another tenant is simply absent —
      // the cross-tenant 404 falls out of the query rather than being a special case.
      const [targetInstitution] = await tx
        .select({ id: institutions.id })
        .from(institutions)
        .where(and(eq(institutions.id, input.targetInstitutionId), isNull(institutions.archivedAt)))
        .limit(1);
      if (!targetInstitution) {
        throw new NotFoundError('Institution', input.targetInstitutionId);
      }

      // The receiving institution must not already hold this child as a separate record —
      // the same duplicate logic admission uses, pointed at the target.
      const duplicate = await this.students.findLikelyDuplicate(tx, input.targetInstitutionId, {
        fullNameEn: student.fullNameEn,
        dateOfBirth: student.dateOfBirth,
        birthRegistrationNumber: student.birthRegistrationNumber ?? undefined,
      });
      if (duplicate) {
        throw new ConflictError(
          `The target institution already has a student record matching this child (${duplicate.studentCode}). ` +
            'Resolve the duplicate before transferring.',
          { existingStudentId: duplicate.id },
        );
      }

      // Close every live enrolment on the source side. No archiving needed: the target
      // institution's academic years are different rows, so the per-year unique key cannot
      // collide.
      const live = await tx
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
      for (const row of live) {
        await tx
          .update(enrollments)
          .set({
            status: 'transferred_out',
            endedOn: input.effectiveDate,
            endReason: input.reason.slice(0, 255),
            version: row.version + 1,
            updatedBy: principal.userId,
          })
          .where(eq(enrollments.id, row.id));
        closedEnrollmentIds.push(row.id);
      }

      // The student's code and admission number are unique per institution among live rows;
      // if the target already uses them, issue fresh ones there. The old identifiers survive
      // in the audit trail and in the closed enrolments.
      let studentCode = student.studentCode;
      const [codeTaken] = await tx
        .select({ id: students.id })
        .from(students)
        .where(
          and(
            eq(students.institutionId, input.targetInstitutionId),
            eq(students.studentCode, studentCode),
            isNull(students.archivedAt),
          ),
        )
        .limit(1);
      if (codeTaken) {
        studentCode = await this.students.nextStudentCode(tx, input.targetInstitutionId);
      }

      let admissionNumber = student.admissionNumber;
      const [admissionTaken] = await tx
        .select({ id: students.id })
        .from(students)
        .where(
          and(
            eq(students.institutionId, input.targetInstitutionId),
            eq(students.admissionNumber, admissionNumber),
            isNull(students.archivedAt),
          ),
        )
        .limit(1);
      if (admissionTaken) {
        admissionNumber = await this.students.nextAdmissionNumber(tx, input.targetInstitutionId);
      }

      const [moved] = await tx
        .update(students)
        .set({
          institutionId: input.targetInstitutionId,
          studentCode,
          admissionNumber,
          version: student.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(students.id, studentId))
        .returning();

      const target = await this.loadSection(tx, input.targetInstitutionId, input.targetSectionId);
      const enrollment = await this.students.insertEnrollment(tx, {
        tenantId: student.tenantId,
        institutionId: input.targetInstitutionId,
        studentId,
        academicYearId: target.academicYearId,
        sectionId: target.id,
        rollNumber: input.rollNumber ?? null,
        enrolledOn: input.effectiveDate,
        actorUserId: principal.userId,
      });

      // History on both sides, in the same transaction: the source's register shows the
      // departure, the target's shows the arrival, and neither can exist without the other.
      await tx.insert(studentStatusHistory).values([
        {
          tenantId: student.tenantId,
          institutionId,
          studentId,
          enrollmentId: closedEnrollmentIds[0] ?? null,
          event: 'transferred_out',
          fromStatus: student.status,
          toStatus: student.status,
          effectiveDate: input.effectiveDate,
          reason: input.reason,
          createdBy: principal.userId,
        },
        {
          tenantId: student.tenantId,
          institutionId: input.targetInstitutionId,
          studentId,
          enrollmentId: enrollment.id,
          event: 'transferred_in',
          fromStatus: student.status,
          toStatus: student.status,
          effectiveDate: input.effectiveDate,
          reason: input.reason,
          createdBy: principal.userId,
        },
      ]);

      return { student: moved!, enrollment, closedEnrollmentIds };
    });
  }

  /**
   * Bulk section reassignment, preview or commit — the same code path computes both, so the
   * preview is exactly what the commit will do and can never drift from it.
   */
  async bulkSectionChange(
    principal: Principal,
    institutionId: string,
    input: BulkSectionChangeInput,
    mode: 'preview' | 'commit',
  ): Promise<{ results: SectionChangeResult[]; movedStudentIds: string[] }> {
    const scope = this.students.requireScope(principal);

    return this.db.runInTenant(async (tx) => {
      const target = await this.loadSection(tx, institutionId, input.targetSectionId);

      const visible = await tx
        .select({ id: students.id, tenantId: students.tenantId, status: students.status })
        .from(students)
        .where(
          and(
            inArray(students.id, input.studentIds),
            eq(students.institutionId, institutionId),
            isNull(students.archivedAt),
            this.students.scopeFilterSql(principal, scope),
          ),
        );
      const byId = new Map(visible.map((row) => [row.id, row]));

      let seatsLeft =
        target.capacity === null
          ? Number.POSITIVE_INFINITY
          : target.capacity - (await this.students.activeSeatCount(tx, target.id));

      const results: SectionChangeResult[] = [];
      const movedStudentIds: string[] = [];

      for (const studentId of input.studentIds) {
        const student = byId.get(studentId);
        if (!student) {
          results.push({ studentId, outcome: 'not_found' });
          continue;
        }
        const current = await this.activeEnrollmentOf(tx, studentId);
        if (!current) {
          results.push({ studentId, outcome: 'no_active_enrollment' });
          continue;
        }
        if (current.sectionId === target.id) {
          results.push({ studentId, outcome: 'already_in_target_section' });
          continue;
        }
        if (current.academicYearId !== target.academicYearId) {
          results.push({ studentId, outcome: 'different_academic_year' });
          continue;
        }
        if (current.classLevelId !== target.classLevelId) {
          results.push({ studentId, outcome: 'different_class_level' });
          continue;
        }
        if (seatsLeft <= 0) {
          results.push({ studentId, outcome: 'section_full' });
          continue;
        }
        seatsLeft -= 1;
        movedStudentIds.push(studentId);

        if (mode === 'preview') {
          results.push({ studentId, outcome: 'moved' });
          continue;
        }

        await this.closeAndArchiveEnrollment(
          tx,
          principal,
          current,
          input.effectiveDate,
          input.reason,
        );
        const enrollment = await this.students.insertEnrollment(tx, {
          tenantId: student.tenantId,
          institutionId,
          studentId,
          academicYearId: target.academicYearId,
          sectionId: target.id,
          rollNumber: null,
          enrolledOn: input.effectiveDate,
          actorUserId: principal.userId,
        });
        await tx.insert(studentStatusHistory).values({
          tenantId: student.tenantId,
          institutionId,
          studentId,
          enrollmentId: enrollment.id,
          event: 'section_changed',
          fromStatus: student.status,
          toStatus: student.status,
          effectiveDate: input.effectiveDate,
          reason: input.reason,
          createdBy: principal.userId,
        });
        results.push({ studentId, outcome: 'moved', enrollmentId: enrollment.id });
      }

      return { results, movedStudentIds };
    });
  }

  // ────────────────────────────────────────────────────────────────────────────────────

  private async activeEnrollmentOf(tx: Tx, studentId: string): Promise<ActiveEnrollment | null> {
    const [row] = await tx
      .select({
        id: enrollments.id,
        sectionId: enrollments.sectionId,
        academicYearId: enrollments.academicYearId,
        classLevelId: enrollments.classLevelId,
        rollNumber: enrollments.rollNumber,
        version: enrollments.version,
      })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.studentId, studentId),
          eq(enrollments.status, 'active'),
          isNull(enrollments.archivedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Close a same-year enrolment and archive the row so the (student, year) unique key frees
   * up for the replacement. Archive, not delete: the row, its roll number and its dates stay
   * readable for attendance history and reporting.
   */
  private async closeAndArchiveEnrollment(
    tx: Tx,
    principal: Principal,
    current: ActiveEnrollment,
    effectiveDate: string,
    reason: string,
  ): Promise<string> {
    await tx
      .update(enrollments)
      .set({
        status: 'transferred_out',
        endedOn: effectiveDate,
        endReason: reason.slice(0, 255),
        archivedAt: new Date(),
        archivedBy: principal.userId,
        archiveReason: reason.slice(0, 500),
        version: current.version + 1,
        updatedBy: principal.userId,
      })
      .where(eq(enrollments.id, current.id));
    return current.id;
  }

  private async loadSection(
    tx: Tx,
    institutionId: string,
    sectionId: string,
  ): Promise<{
    id: string;
    academicYearId: string;
    classLevelId: string;
    capacity: number | null;
  }> {
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
      // A section in another institution of the same tenant: the case RLS cannot catch.
      // 404, never 403.
      throw new NotFoundError('Section', sectionId);
    }
    return section;
  }
}
