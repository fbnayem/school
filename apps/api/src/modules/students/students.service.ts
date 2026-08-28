/**
 * Student service (Phase 3).
 *
 * This is the reference implementation every other feature module should look like. The
 * things worth copying:
 *
 *  1. **Every query runs inside `runInTenant`.** Tenant isolation is not this service's
 *     responsibility to remember — it is the transaction's.
 *  2. **Data scope is resolved from permissions and applied as a SQL filter.** A teacher with
 *     `students.view.assigned` gets a join against their section assignments; a guardian with
 *     `students.view.own` gets a join against their student links. The permission decides
 *     *which filter*, never *whether to filter*.
 *  3. **Reads of a single record go through the same scope filter as the list.** This is what
 *     prevents IDOR: fetching by id is a list query with a `where id = ?` added, not a
 *     separate code path that forgot the scope.
 *  4. **Writes carry the optimistic-lock version.** A stale update is a 409, not a lost write.
 */

import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, exists, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  employeeSectionAssignments,
  employeeSubjectAssignments,
  enrollments,
  sections,
  studentGuardians,
  students,
  studentStatusHistory,
} from '@shikkha/db';
import {
  buildOffsetPage,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  offsetOf,
  parseSort,
  uuidv7,
  ValidationError,
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
import { STUDENT_SORT_FIELDS } from '@shikkha/validation';
import { DatabaseService } from '../database/database.service';
import { currentContext } from '../../common/context/request-context';

export interface ListStudentsQuery {
  page: number;
  pageSize: number;
  sort?: string;
  q?: string;
  academicYearId?: string;
  classLevelId?: string;
  sectionId?: string;
  campusId?: string;
  status?: string;
  gender?: string;
  includeArchived: boolean;
}

type StudentRow = typeof students.$inferSelect;

@Injectable()
export class StudentsService {
  constructor(private readonly db: DatabaseService) {}

  async list(
    principal: Principal,
    query: ListStudentsQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<StudentRow>> {
    const scope = this.requireScope(principal);

    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [this.scopeFilter(principal, scope)];

      if (!query.includeArchived) {
        filters.push(isNull(students.archivedAt));
      } else if (!can(principal, 'students.archive')) {
        // Asking for archived records is itself a privileged read: an archived student is
        // often one who was withdrawn under circumstances the school does not broadcast.
        throw new ForbiddenError('students.archive', 'You cannot view archived students');
      }

      const institutionId = currentContext()?.institutionId;
      if (institutionId) filters.push(eq(students.institutionId, institutionId));
      if (query.status) filters.push(eq(students.status, query.status as StudentRow['status']));
      if (query.gender) filters.push(eq(students.gender, query.gender as StudentRow['gender']));

      if (query.q) {
        filters.push(this.searchFilter(query.q));
      }

      // Enrolment-based filters need a subquery rather than a join, so a student with several
      // historical enrolments is not returned once per enrolment.
      const enrollmentFilter = this.enrollmentFilter(query);
      if (enrollmentFilter) filters.push(enrollmentFilter);

      const where = and(...filters);
      const orderBy = parseSort(query.sort, STUDENT_SORT_FIELDS, {
        field: 'fullNameEn',
        direction: 'asc',
      }).map((spec) => {
        const column = STUDENT_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(students)
        .where(where)
        .orderBy(...orderBy, asc(students.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(students)
        .where(where);

      return buildOffsetPage(
        rows.map((row) => this.redactSensitive(principal, row)),
        counted?.total ?? 0,
        page,
      );
    });
  }

  /**
   * Fetch one student.
   *
   * The scope filter is applied here exactly as it is in `list`. A teacher requesting the id
   * of a student in another section gets `NOT_FOUND`, not `FORBIDDEN` — confirming the record
   * exists is itself a small leak, and a 404 is indistinguishable from a wrong id.
   */
  async findOne(principal: Principal, id: string): Promise<StudentRow> {
    const scope = this.requireScope(principal);

    const row = await this.db.runInTenant(async (tx) => {
      const [found] = await tx
        .select()
        .from(students)
        .where(and(eq(students.id, id), this.scopeFilter(principal, scope)))
        .limit(1);
      return found ?? null;
    });

    if (!row) throw new NotFoundError('Student', id);
    return this.redactSensitive(principal, row);
  }

  /**
   * Assert that a student is visible to this principal, or throw `NotFoundError`.
   *
   * Exists so other modules that key off a student id — guardians, attendance, results — apply
   * the *same* scope rule rather than re-deriving it. The first version of the guardian
   * endpoint skipped this and returned an empty list for a student the caller could not see,
   * which was both inconsistent (the student endpoint 404s) and, within a tenant, a real leak:
   * a class teacher could read the guardians of a student in another section.
   */
  async assertVisible(principal: Principal, studentId: string): Promise<void> {
    const scope = this.requireScope(principal);
    const visible = await this.db.runInTenant(async (tx) => {
      const [found] = await tx
        .select({ id: students.id })
        .from(students)
        .where(and(eq(students.id, studentId), this.scopeFilter(principal, scope)))
        .limit(1);
      return Boolean(found);
    });
    if (!visible) throw new NotFoundError('Student', studentId);
  }

  async create(
    principal: Principal,
    institutionId: string,
    input: Record<string, unknown>,
  ): Promise<StudentRow> {
    return this.db.runInTenant(async (tx) => {
      const tenantId = principal.tenantId!;

      // Generated inside the transaction so two concurrent admissions cannot receive the same
      // number: the count is taken under the same snapshot as the insert, and the partial
      // unique index is the backstop if they still collide.
      const studentCode =
        (input['studentCode'] as string | undefined) ??
        (await this.nextStudentCode(tx, institutionId));
      const admissionNumber =
        (input['admissionNumber'] as string | undefined) ??
        (await this.nextAdmissionNumber(tx, institutionId));

      const duplicate = await this.findLikelyDuplicate(tx, institutionId, {
        fullNameEn: input['fullNameEn'] as string,
        dateOfBirth: input['dateOfBirth'] as string,
        birthRegistrationNumber: input['birthRegistrationNumber'] as string | undefined,
      });
      if (duplicate) {
        throw new ConflictError(
          `A student with the same name and date of birth already exists (${duplicate.studentCode}). ` +
            `If this is a different child, add a distinguishing detail such as the birth registration number.`,
          { existingStudentId: duplicate.id },
        );
      }

      const id = uuidv7();
      const [created] = await tx
        .insert(students)
        .values({
          id,
          tenantId,
          institutionId,
          studentCode,
          admissionNumber,
          admissionDate: input['admissionDate'] as string,
          fullNameEn: input['fullNameEn'] as string,
          fullNameBn: (input['fullNameBn'] as string) ?? null,
          nickname: (input['nickname'] as string) ?? null,
          dateOfBirth: input['dateOfBirth'] as string,
          gender: input['gender'] as StudentRow['gender'],
          bloodGroup: (input['bloodGroup'] as StudentRow['bloodGroup']) ?? null,
          religion: (input['religion'] as StudentRow['religion']) ?? null,
          nationality: (input['nationality'] as string) ?? 'Bangladeshi',
          birthRegistrationNumber: (input['birthRegistrationNumber'] as string) ?? null,
          nationalId: (input['nationalId'] as string) ?? null,
          fatherNameEn: (input['fatherNameEn'] as string) ?? null,
          fatherNameBn: (input['fatherNameBn'] as string) ?? null,
          motherNameEn: (input['motherNameEn'] as string) ?? null,
          motherNameBn: (input['motherNameBn'] as string) ?? null,
          phone: (input['phone'] as string) ?? null,
          email: (input['email'] as string) || null,
          presentAddress: (input['presentAddress'] as string) ?? null,
          permanentAddress: (input['permanentAddress'] as string) ?? null,
          district: (input['district'] as string) ?? null,
          division: (input['division'] as string) ?? null,
          previousInstitutionName: (input['previousInstitutionName'] as string) ?? null,
          previousClassCompleted: (input['previousClassCompleted'] as string) ?? null,
          transferCertificateNumber: (input['transferCertificateNumber'] as string) ?? null,
          status: 'active',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      if (!created) throw new ConflictError('The student could not be created');

      // Domain history, distinct from the audit log: this is what a transfer certificate is
      // printed from, and it is read by the school rather than by a security reviewer.
      await tx.insert(studentStatusHistory).values({
        tenantId,
        institutionId,
        studentId: created.id,
        event: 'admitted',
        fromStatus: null,
        toStatus: 'active',
        effectiveDate: created.admissionDate,
        createdBy: principal.userId,
      });

      const enrollment = input['enrollment'] as Record<string, unknown> | undefined;
      if (enrollment) {
        await this.insertEnrollment(tx, {
          tenantId,
          institutionId,
          studentId: created.id,
          academicYearId: enrollment['academicYearId'] as string,
          sectionId: enrollment['sectionId'] as string,
          rollNumber: enrollment['rollNumber'] as string,
          groupId: (enrollment['groupId'] as string) ?? null,
          enrolledOn: (enrollment['enrolledOn'] as string) ?? created.admissionDate,
          actorUserId: principal.userId,
        });
      }

      return created;
    });
  }

  async update(
    principal: Principal,
    id: string,
    input: Record<string, unknown>,
  ): Promise<{ student: StudentRow; previous: Partial<StudentRow> }> {
    const version = input['version'] as number;
    const { version: _ignored, ...changes } = input;

    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(students)
        .where(and(eq(students.id, id), isNull(students.archivedAt)))
        .limit(1);

      if (!existing) throw new NotFoundError('Student', id);

      const [updated] = await tx
        .update(students)
        .set({
          ...(changes as Partial<StudentRow>),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(students.id, id), eq(students.version, version)))
        .returning();

      if (!updated) {
        // The row exists but the version did not match, so someone else saved first.
        throw new ConflictError(
          'This student was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      // Only the fields that actually changed go into the audit record; a diff of 40
      // unchanged columns makes the trail unreadable.
      const previous: Partial<StudentRow> = {};
      for (const key of Object.keys(changes)) {
        const typedKey = key as keyof StudentRow;
        if (existing[typedKey] !== updated[typedKey]) {
          (previous as Record<string, unknown>)[key] = existing[typedKey];
        }
      }

      return { student: updated, previous };
    });
  }

  async archive(principal: Principal, id: string, reason: string): Promise<StudentRow> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(students)
        .where(and(eq(students.id, id), isNull(students.archivedAt)))
        .limit(1);
      if (!existing) throw new NotFoundError('Student', id);

      // Archiving a student with a live enrolment would leave a section register pointing at
      // a hidden record. The enrolment must be ended first, which is a separate, audited act.
      const [liveEnrollment] = await tx
        .select({ id: enrollments.id })
        .from(enrollments)
        .where(
          and(
            eq(enrollments.studentId, id),
            eq(enrollments.status, 'active'),
            isNull(enrollments.archivedAt),
          ),
        )
        .limit(1);

      if (liveEnrollment) {
        throw new ConflictError(
          'This student is still enrolled. Withdraw or transfer them first, then archive the record.',
        );
      }

      const [archived] = await tx
        .update(students)
        .set({
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          status: 'archived',
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(eq(students.id, id))
        .returning();

      return archived!;
    });
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Scoping
  // ────────────────────────────────────────────────────────────────────────────────────

  private requireScope(principal: Principal): DataScope {
    const context = currentContext();
    const scope = resolveDataScope(principal, SCOPED_RESOURCES.students, {
      institutionId: context?.institutionId ?? null,
      campusId: context?.campusId ?? null,
    });
    if (scope === 'none') {
      throw new ForbiddenError('students.view.all', 'You cannot view student records');
    }
    return scope;
  }

  /**
   * Translate a data scope into a SQL predicate.
   *
   * `all` returns a tautology rather than `undefined`, so callers can always `and(...)` the
   * result without a conditional — and so it is impossible to accidentally build a query that
   * omits the scope filter entirely.
   */
  private scopeFilter(principal: Principal, scope: DataScope): SQL {
    if (scope === 'all') return sql`true`;

    if (scope === 'assigned') {
      if (!principal.employeeId) {
        // A user with the "assigned" permission but no employee record can be assigned
        // nothing, so they see nothing. Failing closed is the only safe reading.
        return sql`false`;
      }
      const employeeId = principal.employeeId;

      // A student is "assigned" to a teacher if the teacher is the class teacher of, or
      // teaches a subject in, the section the student is currently enrolled in.
      return exists(
        this.db.raw
          .select({ one: sql`1` })
          .from(enrollments)
          .where(
            and(
              eq(enrollments.studentId, students.id),
              eq(enrollments.status, 'active'),
              isNull(enrollments.archivedAt),
              or(
                exists(
                  this.db.raw
                    .select({ one: sql`1` })
                    .from(employeeSectionAssignments)
                    .where(
                      and(
                        eq(employeeSectionAssignments.sectionId, enrollments.sectionId),
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
                        eq(employeeSubjectAssignments.sectionId, enrollments.sectionId),
                        eq(employeeSubjectAssignments.employeeId, employeeId),
                        isNull(employeeSubjectAssignments.archivedAt),
                      ),
                    ),
                ),
              ),
            ),
          ),
      );
    }

    // scope === 'own': a guardian sees their linked children; a student sees themselves.
    const conditions: SQL[] = [];
    if (principal.guardianId) {
      conditions.push(
        exists(
          this.db.raw
            .select({ one: sql`1` })
            .from(studentGuardians)
            .where(
              and(
                eq(studentGuardians.studentId, students.id),
                eq(studentGuardians.guardianId, principal.guardianId),
                // Revoking portal access takes effect immediately, without a role change.
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

  private searchFilter(term: string): SQL {
    const trimmed = term.trim();
    // Postgres full-text for names, plus a prefix match on the identifiers people actually
    // paste in. `websearch_to_tsquery` tolerates the punctuation a user types; a raw
    // `to_tsquery` would throw on it.
    // `search_vector` is a generated tsvector column created in migration 0002; it is not
    // part of the Drizzle schema because a generated column has no insertable form.
    return or(
      sql`${students}.search_vector @@ websearch_to_tsquery('simple', ${trimmed})`,
      ilike(students.studentCode, `${trimmed}%`),
      ilike(students.admissionNumber, `${trimmed}%`),
    )!;
  }

  private enrollmentFilter(query: ListStudentsQuery): SQL | null {
    const conditions: SQL[] = [];
    if (query.academicYearId) {
      conditions.push(eq(enrollments.academicYearId, query.academicYearId));
    }
    if (query.classLevelId) conditions.push(eq(enrollments.classLevelId, query.classLevelId));
    if (query.sectionId) conditions.push(eq(enrollments.sectionId, query.sectionId));
    if (query.campusId) conditions.push(eq(enrollments.campusId, query.campusId));
    if (conditions.length === 0) return null;

    return exists(
      this.db.raw
        .select({ one: sql`1` })
        .from(enrollments)
        .where(
          and(
            eq(enrollments.studentId, students.id),
            isNull(enrollments.archivedAt),
            ...conditions,
          ),
        ),
    );
  }

  /**
   * Remove medical fields for callers without `students.medical.view`.
   *
   * Done here rather than by omitting the columns from the SELECT because the same row shape
   * is used by callers who *do* have the permission, and two divergent query paths is how one
   * of them ends up forgetting.
   */
  private redactSensitive(principal: Principal, row: StudentRow): StudentRow {
    if (can(principal, 'students.medical.view')) return row;
    return {
      ...row,
      medicalConditions: null,
      allergies: null,
      specialNeeds: null,
      emergencyMedicalNote: null,
    };
  }

  // ────────────────────────────────────────────────────────────────────────────────────

  private async findLikelyDuplicate(
    tx: Parameters<Parameters<DatabaseService['runInTenant']>[0]>[0],
    institutionId: string,
    candidate: { fullNameEn: string; dateOfBirth: string; birthRegistrationNumber?: string },
  ): Promise<{ id: string; studentCode: string } | null> {
    // The birth registration number is authoritative when present; the unique index would
    // catch it anyway, but a clear message beats a constraint-violation translation.
    if (candidate.birthRegistrationNumber) {
      const [byBrn] = await tx
        .select({ id: students.id, studentCode: students.studentCode })
        .from(students)
        .where(
          and(
            eq(students.institutionId, institutionId),
            eq(students.birthRegistrationNumber, candidate.birthRegistrationNumber),
            isNull(students.archivedAt),
          ),
        )
        .limit(1);
      if (byBrn) return byBrn;
    }

    // Same name and same date of birth in the same institution. Not conclusive — twins exist,
    // and so do common names — which is why this is a warning the user can override by
    // supplying a distinguishing identifier, not a hard constraint.
    const [byNameAndDob] = await tx
      .select({ id: students.id, studentCode: students.studentCode })
      .from(students)
      .where(
        and(
          eq(students.institutionId, institutionId),
          ilike(students.fullNameEn, candidate.fullNameEn),
          eq(students.dateOfBirth, candidate.dateOfBirth),
          isNull(students.archivedAt),
        ),
      )
      .limit(1);

    return byNameAndDob ?? null;
  }

  private async insertEnrollment(
    tx: Parameters<Parameters<DatabaseService['runInTenant']>[0]>[0],
    input: {
      tenantId: string;
      institutionId: string;
      studentId: string;
      academicYearId: string;
      sectionId: string;
      rollNumber: string;
      groupId: string | null;
      enrolledOn: string;
      actorUserId: string;
    },
  ): Promise<void> {
    const [section] = await tx
      .select({
        id: sections.id,
        campusId: sections.campusId,
        classLevelId: sections.classLevelId,
        shiftId: sections.shiftId,
        capacity: sections.capacity,
        academicYearId: sections.academicYearId,
      })
      .from(sections)
      .where(and(eq(sections.id, input.sectionId), isNull(sections.archivedAt)))
      .limit(1);

    if (!section) throw new NotFoundError('Section', input.sectionId);
    if (section.academicYearId !== input.academicYearId) {
      throw new ValidationError('That section belongs to a different academic year', [
        { path: 'enrollment.sectionId', message: 'Section is not in the selected academic year' },
      ]);
    }

    if (section.capacity !== null) {
      const [occupancy] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(enrollments)
        .where(
          and(
            eq(enrollments.sectionId, input.sectionId),
            eq(enrollments.status, 'active'),
            isNull(enrollments.archivedAt),
          ),
        );
      if ((occupancy?.total ?? 0) >= section.capacity) {
        throw new ConflictError(
          `That section is full (${section.capacity} students). Choose another section or raise the capacity.`,
        );
      }
    }

    await tx.insert(enrollments).values({
      tenantId: input.tenantId,
      institutionId: input.institutionId,
      campusId: section.campusId,
      studentId: input.studentId,
      academicYearId: input.academicYearId,
      classLevelId: section.classLevelId,
      sectionId: input.sectionId,
      shiftId: section.shiftId,
      groupId: input.groupId,
      rollNumber: input.rollNumber,
      status: 'active',
      enrolledOn: input.enrolledOn,
      createdBy: input.actorUserId,
    });
  }

  /**
   * Next sequential code for the institution.
   *
   * Uses `max` rather than `count` because archived students still hold their codes and a
   * count would start reissuing them. The partial unique index is the real guarantee; this
   * only needs to be right almost always.
   */
  private async nextStudentCode(
    tx: Parameters<Parameters<DatabaseService['runInTenant']>[0]>[0],
    institutionId: string,
  ): Promise<string> {
    const year = new Date().getUTCFullYear();
    const prefix = `S${year}`;
    const [row] = await tx
      .select({ maxCode: sql<string | null>`max(${students.studentCode})` })
      .from(students)
      .where(
        and(eq(students.institutionId, institutionId), ilike(students.studentCode, `${prefix}%`)),
      );
    const previous = row?.maxCode ? Number(row.maxCode.slice(prefix.length)) : 0;
    return `${prefix}${String((Number.isFinite(previous) ? previous : 0) + 1).padStart(5, '0')}`;
  }

  private async nextAdmissionNumber(
    tx: Parameters<Parameters<DatabaseService['runInTenant']>[0]>[0],
    institutionId: string,
  ): Promise<string> {
    const year = new Date().getUTCFullYear();
    const prefix = `A${year}`;
    const [row] = await tx
      .select({ maxNumber: sql<string | null>`max(${students.admissionNumber})` })
      .from(students)
      .where(
        and(
          eq(students.institutionId, institutionId),
          ilike(students.admissionNumber, `${prefix}%`),
        ),
      );
    const previous = row?.maxNumber ? Number(row.maxNumber.slice(prefix.length)) : 0;
    return `${prefix}${String((Number.isFinite(previous) ? previous : 0) + 1).padStart(5, '0')}`;
  }
}

const STUDENT_COLUMNS = {
  fullNameEn: students.fullNameEn,
  studentCode: students.studentCode,
  admissionNumber: students.admissionNumber,
  admissionDate: students.admissionDate,
  dateOfBirth: students.dateOfBirth,
  createdAt: students.createdAt,
} as const;
