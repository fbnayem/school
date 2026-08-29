/**
 * Row visibility for the AI tools.
 *
 * Every rule here is a *reuse* of an existing one, not a new one. `StudentsService` already
 * owns "which students may this principal see" — the `assigned` join against section and
 * subject assignments, the `own` join against guardian links with `can_access_portal`, and
 * the decision that an invisible id is a 404 rather than a 403. Re-deriving any of that here
 * would create a second implementation whose first divergence is a leak: the students
 * endpoint says 404 and the tool says 200.
 *
 * So this file adds exactly two things the students service does not have, and derives both
 * from its filter:
 *
 *   - `assertSectionVisible`, because a section is a container of students and the tools take
 *     section ids as arguments;
 *   - `assertEmployeeVisible`, because `timetable.lookup` takes a teacher id.
 *
 * Both fail closed, and both answer `NotFoundError` rather than `ForbiddenError` for the same
 * reason `StudentsService.findOne` does: confirming that a section or a colleague exists is
 * itself a small leak, and within a multi-institution tenant it is not that small.
 */

import { Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { employees, enrollments, sections, students } from '@shikkha/db';
import { ForbiddenError, NotFoundError } from '@shikkha/shared';
import {
  can,
  resolveDataScope,
  SCOPED_RESOURCES,
  type DataScope,
  type Principal,
  type ScopedResourcePermissions,
} from '@shikkha/permissions';
import { DatabaseService } from '../database/database.service';
import { StudentsService } from '../students/students.service';
import { currentContext } from '../../common/context/request-context';

export interface SectionRef {
  id: string;
  nameEn: string;
  campusId: string;
  academicYearId: string;
  classLevelId: string;
}

export interface EmployeeRef {
  id: string;
  fullNameEn: string;
}

@Injectable()
export class ToolScopeService {
  constructor(
    private readonly db: DatabaseService,
    private readonly students: StudentsService,
  ) {}

  /**
   * The caller's scope for a resource, in the institution the request is scoped to.
   *
   * Thrown as `ForbiddenError` when it resolves to `none`: the route-level guard has already
   * established that the caller may use *some* tool, so reaching here without any scope for
   * the resource means the tool's own permission disjunction was satisfied by a permission
   * that does not imply a data scope — which is a configuration mistake worth surfacing
   * plainly rather than an empty result worth misreading as "no data".
   */
  scopeFor(principal: Principal, resource: ScopedResourcePermissions): DataScope {
    const context = currentContext();
    const scope = resolveDataScope(principal, resource, {
      institutionId: context?.institutionId ?? null,
      campusId: context?.campusId ?? null,
    });
    if (scope === 'none') {
      throw new ForbiddenError(resource.all, 'You cannot view these records');
    }
    return scope;
  }

  /** The students scope, resolved through the students service so the rule has one owner. */
  studentScope(principal: Principal): DataScope {
    return this.students.requireScope(principal);
  }

  /**
   * Assert a student is visible, by delegation.
   *
   * A one-line wrapper on purpose: every tool that keys off a student id goes through the
   * students module's own `assertVisible`, which is the method the guardians, attendance and
   * results endpoints already use. A tool that queried `students` directly would be the second
   * implementation of the rule, and the first thing it would forget is `can_access_portal`.
   */
  async assertVisibleStudent(principal: Principal, studentId: string): Promise<void> {
    await this.students.assertVisible(principal, studentId);
  }

  /**
   * The more restrictive of two scopes.
   *
   * Tools consult two scopes at once — "may you see attendance" and "may you see this student"
   * — and the safe combination is always the narrower. Written as a function rather than as a
   * comparison at each call site because the ordering (`all` < `assigned` < `own`) is the sort
   * of thing that gets inverted once and then holds for years.
   */
  static narrower(first: DataScope, second: DataScope): DataScope {
    const rank: Record<DataScope, number> = { all: 0, assigned: 1, own: 2, none: 3 };
    return rank[first] >= rank[second] ? first : second;
  }

  /**
   * A section the caller may ask about.
   *
   * The test for a narrowed caller is deliberately indirect: a section is visible when at
   * least one *currently enrolled student the caller may see* is in it. That reuses
   * `StudentsService.scopeFilterSql` verbatim, so a class teacher sees the sections they
   * teach, a guardian sees the sections their children sit in, and neither rule is written
   * down twice.
   *
   * `all` skips the enrolment test on purpose: an administrator asking about a newly created,
   * still-empty section should get an empty summary, not a 404 that reads like the section
   * does not exist.
   */
  async assertSectionVisible(
    principal: Principal,
    institutionId: string,
    sectionId: string,
    scope: DataScope,
  ): Promise<SectionRef> {
    return this.db.runInTenant(async (tx) => {
      const [section] = await tx
        .select({
          id: sections.id,
          nameEn: sections.nameEn,
          campusId: sections.campusId,
          academicYearId: sections.academicYearId,
          classLevelId: sections.classLevelId,
        })
        .from(sections)
        .where(
          and(
            eq(sections.id, sectionId),
            // RLS confines this to the tenant; the institution predicate is what stops one
            // institution of a school group reading another's section by id.
            eq(sections.institutionId, institutionId),
            isNull(sections.archivedAt),
          ),
        )
        .limit(1);

      if (!section) throw new NotFoundError('Section', sectionId);
      if (scope === 'all') return section;

      const [visible] = await tx
        .select({ one: sql<number>`1` })
        .from(enrollments)
        .innerJoin(students, eq(students.id, enrollments.studentId))
        .where(
          and(
            eq(enrollments.sectionId, sectionId),
            eq(enrollments.status, 'active'),
            isNull(enrollments.archivedAt),
            isNull(students.archivedAt),
            this.students.scopeFilterSql(principal, scope),
          ),
        )
        .limit(1);

      if (!visible) throw new NotFoundError('Section', sectionId);
      return section;
    });
  }

  /**
   * An employee the caller may ask about.
   *
   * Three ways in, and nothing else: it is you, or you administer people
   * (`hr.employees.view`), or you administer the routine (`timetable.manage`).
   *
   * **Permission gap, recorded here so it is not silently reintroduced.** The catalogue has a
   * flat `timetable.view` with no `.own` variant, so on the permission string alone a guardian
   * with `timetable.view` could ask for any teacher's day — which is a staff movement pattern,
   * not a routine. The catalogue is frozen for this batch, so the tool fails closed on the
   * data instead: without one of the three grounds above the answer is 404, whatever
   * `timetable.view` says. When `timetable.view.own` exists, this becomes a scope resolution
   * like every other and this method loses its special case.
   */
  async assertEmployeeVisible(
    principal: Principal,
    institutionId: string,
    employeeId: string,
  ): Promise<EmployeeRef> {
    const isSelf = principal.employeeId === employeeId;
    const isAdministrator =
      can(principal, 'hr.employees.view') || can(principal, 'timetable.manage');

    return this.db.runInTenant(async (tx) => {
      const [employee] = await tx
        .select({ id: employees.id, fullNameEn: employees.fullNameEn })
        .from(employees)
        .where(
          and(
            eq(employees.id, employeeId),
            eq(employees.institutionId, institutionId),
            isNull(employees.archivedAt),
          ),
        )
        .limit(1);

      // The existence check and the authorization check produce the same answer, so a caller
      // cannot use the difference between them to test whether an employee id is real.
      if (!employee || !(isSelf || isAdministrator)) {
        throw new NotFoundError('Employee', employeeId);
      }
      return employee;
    });
  }

  /**
   * The students the caller may see, as ids, for the tools that aggregate over a set.
   *
   * Goes through `queryScoped` rather than a hand-rolled query so the scope filter, the
   * archived-record rule and the medical redaction are the same ones the human endpoint
   * applies. The cap is deliberate and the caller is told when it bit: a guardian has a
   * handful of children and a teacher a few hundred students, so a truncated set means the
   * question was the wrong shape, and an aggregate silently computed over the first 500 of
   * 3,000 students is a wrong number presented as a right one.
   */
  async visibleStudentIds(
    principal: Principal,
    query: { sectionId?: string; classLevelId?: string; academicYearId?: string },
    limit: number,
  ): Promise<{ ids: string[]; truncated: boolean }> {
    const rows = await this.students.queryScoped(
      principal,
      {
        page: 1,
        pageSize: limit,
        includeArchived: false,
        ...(query.sectionId ? { sectionId: query.sectionId } : {}),
        ...(query.classLevelId ? { classLevelId: query.classLevelId } : {}),
        ...(query.academicYearId ? { academicYearId: query.academicYearId } : {}),
      },
      limit + 1,
    );
    const truncated = rows.length > limit;
    return { ids: rows.slice(0, limit).map((row) => row.id), truncated };
  }

  /** Shorthand for the resource triples, so tools do not import two modules to name a scope. */
  static readonly RESOURCES = SCOPED_RESOURCES;
}
