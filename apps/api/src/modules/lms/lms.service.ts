/**
 * Learning Management System service (Phase 10).
 *
 * The rules this file exists to keep, in the order a school would state them:
 *
 *  1. **A teacher manages a course only for a subject+class they are assigned to.** The
 *     check is the same one `StudentsService.scopeFilter` and the homework module use —
 *     class teacher of a section, or teacher of a subject in it — anchored here on the
 *     course's class level and subject, mirrored rather than imported so there is no
 *     module cycle. A class outside that set is a 404, never a 403: a teacher probing ids
 *     must not learn which of them exist.
 *  2. **Draft content is invisible outside the owner and administrators.** A student or
 *     guardian sees only published courses for classes the student is actually enrolled
 *     in, and only the published modules and lessons within them — a SQL predicate applied
 *     to the list, the single fetch, the reports and the resource paths alike, never a
 *     client-side filter.
 *  3. **`quiz_options.is_correct` never reaches a student.** Every student-facing path
 *     maps options through `redactOptionForStudent`, which does not carry the field at
 *     all — the HR salary-redaction discipline, applied structurally.
 *  4. **Attempts are counted and timed by the server.** Attempt numbers come from the
 *     database, the limit is enforced before a new attempt row exists, and the time limit
 *     is judged from `started_at` against the server clock — never a client-supplied
 *     elapsed time. A submitted attempt is immutable.
 *  5. **Marks are exact.** `numeric(6,2)` arrives from the driver as a string and all
 *     grading arithmetic runs in integer hundredths (the exams module's discipline);
 *     nothing in this file converts a marks column to a JavaScript float.
 *  6. **A settled mark changes only with a reason.** Re-grading a short-text answer
 *     requires one, and the before/after audit record is written **inside the business
 *     transaction** so the trail rolls back with the change.
 *  7. **Nothing is hard-deleted.** Replacing a module set archives what fell out of it;
 *     withdrawing a course or quiz is a status change plus the archive marker (ADR-008).
 */

import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  courseEnrolments,
  courseModules,
  courses,
  employeeSectionAssignments,
  employeeSubjectAssignments,
  enrollments,
  files,
  lessonProgress,
  lessonResources,
  lessons,
  quizAnswers,
  quizAttempts,
  quizOptions,
  quizQuestions,
  quizzes,
  sections,
  students,
  studentGuardians,
  subjects,
  academicYears,
  campuses,
  classLevels,
} from '@shikkha/db';
import {
  buildOffsetPage,
  ConflictError,
  ForbiddenError,
  ImmutableRecordError,
  NotFoundError,
  offsetOf,
  parseSort,
  uuidv7,
  ValidationError,
  WorkflowStateError,
  type OffsetPage,
  type OffsetPageRequest,
} from '@shikkha/shared';
import {
  resolveDataScope,
  SCOPED_RESOURCES,
  type DataScope,
  type Principal,
} from '@shikkha/permissions';
import {
  LMS_COURSE_SORT_FIELDS,
  type AddLessonLinkResourceInput,
  type CreateCourseInput,
  type CreateQuizInput,
  type EnrolCourseStudentsInput,
  type GradeQuizAnswerInput,
  type ListCoursesQuery,
  type ListQuizAttemptsQuery,
  type RecordLessonProgressInput,
  type ReplaceCourseModulesInput,
  type ReplaceModuleLessonsInput,
  type SubmitQuizAttemptInput,
  type UpdateCourseInput,
  type UpdateQuizInput,
  type ReplaceQuizQuestionsInput,
} from '@shikkha/validation';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';
import { currentContext } from '../../common/context/request-context';

/** The transaction handle services pass around; identical to `runInTenant`'s callback arg. */
export type Tx = Parameters<Parameters<DatabaseService['runInTenant']>[0]>[0];

export type CourseRow = typeof courses.$inferSelect;
export type CourseEnrolmentRow = typeof courseEnrolments.$inferSelect;
export type CourseModuleRow = typeof courseModules.$inferSelect;
export type LessonRow = typeof lessons.$inferSelect;
export type LessonResourceRow = typeof lessonResources.$inferSelect;
export type LessonProgressRow = typeof lessonProgress.$inferSelect;
export type QuizRow = typeof quizzes.$inferSelect;
export type QuizQuestionRow = typeof quizQuestions.$inferSelect;
export type QuizOptionRow = typeof quizOptions.$inferSelect;
export type QuizAttemptRow = typeof quizAttempts.$inferSelect;
export type QuizAnswerRow = typeof quizAnswers.$inferSelect;

/** The slice of a multipart upload this service needs; matches Multer's file object. */
export interface UploadedFileLike {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/**
 * An option as a student is allowed to see it. `isCorrect` is not redacted to null — the
 * projection simply does not carry the field, so no serialisation path can leak it.
 */
export interface StudentQuizOption {
  id: string;
  sequence: number;
  text: string;
}

export interface StudentQuizQuestion {
  id: string;
  sequence: number;
  kind: QuizQuestionRow['kind'];
  prompt: string;
  marks: string;
  options: StudentQuizOption[];
}

const MAX_RESOURCE_BYTES = 10 * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

const DOWNLOAD_TTL_SECONDS = 300;

/**
 * Offset applied in phase one of a replace-as-a-set write, moving live rows clear of the
 * 1..200 range so the partial unique index on (parent, sequence) can never collide while
 * positions are being shuffled. The index is partial, so it cannot be deferrable.
 */
const SEQUENCE_SHUFFLE_OFFSET = 1000;

@Injectable()
export class LmsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  // ────────────────────────────────────────────────────────────────────────────────────
  // Scope
  // ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Resolve the caller's row scope once per request.
   *
   * The LMS has no scoped-view permission triple of its own (`lms.view` is a single
   * permission every audience holds), so the scope rides on the student triple exactly as
   * the homework module's does: who may see all students may see all courses, who may see
   * assigned students sees their classes' courses, and a student or guardian sees their
   * own. When `lms.view.{all,assigned,own}` are added to the catalogue, only this method
   * changes.
   */
  requireScope(principal: Principal): DataScope {
    const context = currentContext();
    const scope = resolveDataScope(principal, SCOPED_RESOURCES.students, {
      institutionId: context?.institutionId ?? null,
      campusId: context?.campusId ?? null,
    });
    if (scope === 'none') {
      throw new ForbiddenError('lms.view', 'You cannot view learning content');
    }
    return scope;
  }

  /**
   * The same rule `StudentsService.scopeFilter` uses for `assigned`, anchored on the
   * course's class level and subject: an employee is assigned to a course's class when
   * they are the class teacher of one of its sections in the course's academic year, or
   * teach the course's subject in one of those sections.
   */
  private classAssignmentFilter(employeeId: string): SQL {
    return exists(
      this.db.raw
        .select({ one: sql`1` })
        .from(sections)
        .where(
          and(
            eq(sections.institutionId, courses.institutionId),
            eq(sections.academicYearId, courses.academicYearId),
            eq(sections.classLevelId, courses.classLevelId),
            isNull(sections.archivedAt),
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
                      eq(employeeSubjectAssignments.subjectId, courses.subjectId),
                      eq(employeeSubjectAssignments.employeeId, employeeId),
                      isNull(employeeSubjectAssignments.archivedAt),
                    ),
                  ),
              ),
            )!,
          ),
        ),
    );
  }

  /**
   * Courses this principal may see, as a SQL predicate.
   *
   * `all` returns a tautology rather than `undefined`, so callers can always `and(...)`
   * the result without a conditional — and so it is impossible to accidentally build a
   * query that omits the scope filter entirely.
   */
  private courseScopeFilter(principal: Principal, scope: DataScope): SQL {
    if (scope === 'all') return sql`true`;

    if (scope === 'assigned') {
      if (!principal.employeeId) {
        // A user with the "assigned" permission but no employee record can be assigned
        // nothing, so they see nothing. Failing closed is the only safe reading.
        return sql`false`;
      }
      const employeeId = principal.employeeId;
      // A teacher sees their own course in every state, and other teachers' courses for
      // their classes only once they leave draft — a draft is the owner's desk drawer.
      return or(
        eq(courses.ownerEmployeeId, employeeId),
        and(this.classAssignmentFilter(employeeId), ne(courses.status, 'draft')),
      )!;
    }

    // `own`: a student sees published courses for the class they are enrolled in; a
    // guardian sees their linked children's. Draft and archived courses do not exist for
    // them at all.
    const studentMatch: SQL[] = [];
    if (principal.studentId) {
      studentMatch.push(eq(enrollments.studentId, principal.studentId));
    }
    if (principal.guardianId) {
      const guardianId = principal.guardianId;
      studentMatch.push(
        exists(
          this.db.raw
            .select({ one: sql`1` })
            .from(studentGuardians)
            .where(
              and(
                eq(studentGuardians.studentId, enrollments.studentId),
                eq(studentGuardians.guardianId, guardianId),
                // Revoking portal access takes effect immediately, without a role change.
                eq(studentGuardians.canAccessPortal, true),
                isNull(studentGuardians.archivedAt),
              ),
            ),
        ),
      );
    }
    if (studentMatch.length === 0) return sql`false`;

    return and(
      eq(courses.status, 'published'),
      exists(
        this.db.raw
          .select({ one: sql`1` })
          .from(enrollments)
          .where(
            and(
              eq(enrollments.institutionId, courses.institutionId),
              eq(enrollments.academicYearId, courses.academicYearId),
              eq(enrollments.classLevelId, courses.classLevelId),
              eq(enrollments.status, 'active'),
              isNull(enrollments.archivedAt),
              studentMatch.length === 1 ? studentMatch[0]! : or(...studentMatch)!,
            ),
          ),
      ),
    )!;
  }

  /**
   * Load one course inside the caller's transaction with the scope filter applied. A
   * course outside the caller's scope — the wrong tenant, the wrong institution, a class
   * they are not assigned to, someone else's draft — is a `NotFoundError`, never a 403:
   * confirming the record exists is itself a leak.
   */
  private async loadVisibleCourse(
    tx: Tx,
    principal: Principal,
    scope: DataScope,
    institutionId: string,
    id: string,
  ): Promise<CourseRow> {
    const [row] = await tx
      .select()
      .from(courses)
      .where(
        and(
          eq(courses.id, id),
          eq(courses.institutionId, institutionId),
          isNull(courses.archivedAt),
          this.courseScopeFilter(principal, scope),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError('Course', id);
    return row;
  }

  /**
   * May this principal *change* the course (edit, structure, publish, quizzes, grading)?
   *
   * `all` scope may; otherwise the caller must be the owner, or assigned to the course's
   * class+subject. Failure is a 404 for the same reason as everywhere else.
   */
  private async assertCanManage(
    tx: Tx,
    principal: Principal,
    scope: DataScope,
    course: CourseRow,
  ): Promise<void> {
    if (scope === 'all') return;
    if (scope !== 'assigned' || !principal.employeeId) {
      throw new NotFoundError('Course', course.id);
    }
    if (course.ownerEmployeeId === principal.employeeId) return;
    const allowed = await this.isAssignedToClassSubject(
      tx,
      principal.employeeId,
      course.institutionId,
      course.academicYearId,
      course.classLevelId,
      course.subjectId,
    );
    if (!allowed) throw new NotFoundError('Course', course.id);
  }

  /**
   * The management rule, stated once: the class teacher of any section of the class may
   * manage courses in every subject of that class; a subject teacher only for the
   * (class, subject) pair they actually teach a section of.
   */
  private async isAssignedToClassSubject(
    tx: Tx,
    employeeId: string,
    institutionId: string,
    academicYearId: string,
    classLevelId: string,
    subjectId: string,
  ): Promise<boolean> {
    const [row] = await tx
      .select({ one: sql<number>`1` })
      .from(sections)
      .where(
        and(
          eq(sections.institutionId, institutionId),
          eq(sections.academicYearId, academicYearId),
          eq(sections.classLevelId, classLevelId),
          isNull(sections.archivedAt),
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
                    eq(employeeSubjectAssignments.subjectId, subjectId),
                    eq(employeeSubjectAssignments.employeeId, employeeId),
                    isNull(employeeSubjectAssignments.archivedAt),
                  ),
                ),
            ),
          )!,
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Courses
  // ────────────────────────────────────────────────────────────────────────────────────

  async listCourses(
    principal: Principal,
    institutionId: string,
    query: ListCoursesQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<CourseRow>> {
    const scope = this.requireScope(principal);

    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [
        eq(courses.institutionId, institutionId),
        this.courseScopeFilter(principal, scope),
      ];
      if (!query.includeArchived) filters.push(isNull(courses.archivedAt));
      if (query.academicYearId) filters.push(eq(courses.academicYearId, query.academicYearId));
      if (query.classLevelId) filters.push(eq(courses.classLevelId, query.classLevelId));
      if (query.subjectId) filters.push(eq(courses.subjectId, query.subjectId));
      if (query.status) filters.push(eq(courses.status, query.status));
      if (query.q) filters.push(ilike(courses.title, `%${query.q}%`));

      const where = and(...filters);
      const orderBy = parseSort(query.sort, LMS_COURSE_SORT_FIELDS, {
        field: 'createdAt',
        direction: 'desc',
      }).map((spec) => {
        const column = {
          title: courses.title,
          status: courses.status,
          createdAt: courses.createdAt,
        }[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(courses)
        .where(where)
        .orderBy(...orderBy, asc(courses.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(courses)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async createCourse(
    principal: Principal,
    institutionId: string,
    input: CreateCourseInput,
  ): Promise<CourseRow> {
    const scope = this.requireScope(principal);
    if (scope === 'own') {
      throw new ForbiddenError('lms.manage', 'Only teaching staff can create courses');
    }

    return this.db.runInTenant(async (tx) => {
      const [campus] = await tx
        .select({ id: campuses.id })
        .from(campuses)
        .where(
          and(
            eq(campuses.id, input.campusId),
            eq(campuses.institutionId, institutionId),
            isNull(campuses.archivedAt),
          ),
        )
        .limit(1);
      if (!campus) throw new NotFoundError('Campus', input.campusId);

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

      const [classLevel] = await tx
        .select({ id: classLevels.id })
        .from(classLevels)
        .where(
          and(
            eq(classLevels.id, input.classLevelId),
            eq(classLevels.institutionId, institutionId),
            isNull(classLevels.archivedAt),
          ),
        )
        .limit(1);
      if (!classLevel) throw new NotFoundError('Class level', input.classLevelId);

      const [subject] = await tx
        .select({ id: subjects.id })
        .from(subjects)
        .where(
          and(
            eq(subjects.id, input.subjectId),
            eq(subjects.institutionId, institutionId),
            isNull(subjects.archivedAt),
          ),
        )
        .limit(1);
      if (!subject) throw new NotFoundError('Subject', input.subjectId);

      if (scope !== 'all') {
        if (!principal.employeeId) {
          // "Assigned" scope with no employee record can be assigned nothing.
          throw new NotFoundError('Class level', input.classLevelId);
        }
        const allowed = await this.isAssignedToClassSubject(
          tx,
          principal.employeeId,
          institutionId,
          input.academicYearId,
          input.classLevelId,
          input.subjectId,
        );
        if (!allowed) {
          // 404, not 403: a teacher probing class ids must not learn which of them exist.
          throw new NotFoundError('Class level', input.classLevelId);
        }
      }

      const [created] = await tx
        .insert(courses)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          campusId: input.campusId,
          academicYearId: input.academicYearId,
          classLevelId: input.classLevelId,
          subjectId: input.subjectId,
          ownerEmployeeId: principal.employeeId ?? null,
          title: input.title,
          titleBn: input.titleBn ?? null,
          description: input.description ?? null,
          status: 'draft',
          createdBy: principal.userId,
        })
        .returning();

      return created!;
    });
  }

  /**
   * One course with its ordered modules and lesson summaries (no lesson content — that is
   * the lesson view's payload). A student receives only published modules and lessons.
   */
  async findCourse(
    principal: Principal,
    institutionId: string,
    id: string,
  ): Promise<CourseRow & { modules: (CourseModuleRow & { lessons: Record<string, unknown>[] })[] }> {
    const scope = this.requireScope(principal);

    return this.db.runInTenant(async (tx) => {
      const course = await this.loadVisibleCourse(tx, principal, scope, institutionId, id);

      const moduleFilters: SQL[] = [
        eq(courseModules.courseId, id),
        isNull(courseModules.archivedAt),
      ];
      if (scope === 'own') moduleFilters.push(eq(courseModules.isPublished, true));

      const moduleRows = await tx
        .select()
        .from(courseModules)
        .where(and(...moduleFilters))
        .orderBy(asc(courseModules.sequence), asc(courseModules.id));

      const moduleIds = moduleRows.map((row) => row.id);
      let lessonRows: {
        id: string;
        moduleId: string;
        title: string;
        sequence: number;
        estimatedMinutes: number | null;
        isPublished: boolean;
      }[] = [];
      if (moduleIds.length > 0) {
        const lessonFilters: SQL[] = [
          inArray(lessons.moduleId, moduleIds),
          isNull(lessons.archivedAt),
        ];
        if (scope === 'own') lessonFilters.push(eq(lessons.isPublished, true));
        lessonRows = await tx
          .select({
            id: lessons.id,
            moduleId: lessons.moduleId,
            title: lessons.title,
            sequence: lessons.sequence,
            estimatedMinutes: lessons.estimatedMinutes,
            isPublished: lessons.isPublished,
          })
          .from(lessons)
          .where(and(...lessonFilters))
          .orderBy(asc(lessons.sequence), asc(lessons.id));
      }

      const byModule = new Map<string, Record<string, unknown>[]>();
      for (const lesson of lessonRows) {
        const bucket = byModule.get(lesson.moduleId) ?? [];
        bucket.push(lesson);
        byModule.set(lesson.moduleId, bucket);
      }

      return {
        ...course,
        modules: moduleRows.map((module) => ({
          ...module,
          lessons: byModule.get(module.id) ?? [],
        })),
      };
    });
  }

  async updateCourse(
    principal: Principal,
    institutionId: string,
    id: string,
    input: UpdateCourseInput,
  ): Promise<{ course: CourseRow; previous: Record<string, unknown> }> {
    const scope = this.requireScope(principal);
    const { version, ...changes } = input;

    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadVisibleCourse(tx, principal, scope, institutionId, id);
      await this.assertCanManage(tx, principal, scope, existing);

      if (existing.status === 'archived') {
        throw new ImmutableRecordError('Course', 'it is archived');
      }

      const values: Partial<CourseRow> = {};
      if (changes.title !== undefined) values.title = changes.title;
      if (changes.titleBn !== undefined) values.titleBn = changes.titleBn;
      if (changes.description !== undefined) values.description = changes.description;

      const [updated] = await tx
        .update(courses)
        .set({
          ...values,
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(courses.id, id), eq(courses.version, version)))
        .returning();

      if (!updated) {
        // The row exists but the version did not match, so someone else saved first.
        throw new ConflictError(
          'This course was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      const previous: Record<string, unknown> = {};
      for (const key of Object.keys(values) as (keyof CourseRow)[]) {
        previous[key] = existing[key];
      }
      return { course: updated, previous };
    });
  }

  async publishCourse(
    principal: Principal,
    institutionId: string,
    id: string,
    version: number,
  ): Promise<CourseRow> {
    const scope = this.requireScope(principal);
    if (scope === 'own') {
      throw new ForbiddenError('lms.publish', 'Only teaching staff can publish courses');
    }

    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadVisibleCourse(tx, principal, scope, institutionId, id);
      await this.assertCanManage(tx, principal, scope, existing);

      if (existing.status !== 'draft') {
        throw new WorkflowStateError(existing.status, 'published', 'course');
      }

      const [updated] = await tx
        .update(courses)
        .set({
          status: 'published',
          publishedAt: new Date(),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(courses.id, id), eq(courses.version, version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This course was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }
      return updated;
    });
  }

  /** Withdrawing a course: a status change plus the archive marker. Never a DELETE. */
  async archiveCourse(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
    version: number,
  ): Promise<CourseRow> {
    const scope = this.requireScope(principal);
    if (scope === 'own') {
      throw new ForbiddenError('lms.publish', 'Only teaching staff can withdraw courses');
    }

    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadVisibleCourse(tx, principal, scope, institutionId, id);
      await this.assertCanManage(tx, principal, scope, existing);

      const [updated] = await tx
        .update(courses)
        .set({
          status: 'archived',
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason.slice(0, 500),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(courses.id, id), eq(courses.version, version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This course was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }
      return updated;
    });
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Modules and lessons — replace-as-a-set (the timetable discipline)
  // ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Write the whole ordered module set of one course in one transaction. Position comes
   * from array order; a module absent from the set is archived — never deleted — and its
   * lessons stay put underneath it.
   */
  async replaceModules(
    principal: Principal,
    institutionId: string,
    courseId: string,
    input: ReplaceCourseModulesInput,
  ): Promise<CourseModuleRow[]> {
    const scope = this.requireScope(principal);
    if (scope === 'own') {
      throw new ForbiddenError('lms.manage', 'Only teaching staff can structure a course');
    }

    return this.db.runInTenant(async (tx) => {
      const course = await this.loadVisibleCourse(tx, principal, scope, institutionId, courseId);
      await this.assertCanManage(tx, principal, scope, course);
      if (course.status === 'archived') {
        throw new ImmutableRecordError('Course', 'it is archived');
      }

      // The course version is the optimistic lock over the whole set.
      const [locked] = await tx
        .update(courses)
        .set({ version: course.version + 1, updatedBy: principal.userId })
        .where(and(eq(courses.id, courseId), eq(courses.version, input.version)))
        .returning({ id: courses.id });
      if (!locked) {
        throw new ConflictError(
          'This course was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: input.version, currentVersion: course.version },
        );
      }

      const existing = await tx
        .select()
        .from(courseModules)
        .where(and(eq(courseModules.courseId, courseId), isNull(courseModules.archivedAt)));
      const byId = new Map(existing.map((row) => [row.id, row]));

      for (const item of input.modules) {
        if (item.id && !byId.has(item.id)) {
          // An id from another course (or another tenant) is simply not found here.
          throw new NotFoundError('Module', item.id);
        }
      }

      // Phase 1: move every live row clear of the target range so re-ordering can never
      // transiently collide on the partial unique (course_id, sequence) index.
      if (existing.length > 0) {
        await tx
          .update(courseModules)
          .set({ sequence: sql`${courseModules.sequence} + ${SEQUENCE_SHUFFLE_OFFSET}` })
          .where(and(eq(courseModules.courseId, courseId), isNull(courseModules.archivedAt)));
      }

      const keptIds = new Set(input.modules.filter((item) => item.id).map((item) => item.id!));
      const toArchive = existing.filter((row) => !keptIds.has(row.id));
      if (toArchive.length > 0) {
        await tx
          .update(courseModules)
          .set({
            archivedAt: new Date(),
            archivedBy: principal.userId,
            archiveReason: 'Removed when the module set was replaced',
            version: sql`${courseModules.version} + 1`,
            updatedBy: principal.userId,
          })
          .where(
            inArray(
              courseModules.id,
              toArchive.map((row) => row.id),
            ),
          );
      }

      // Phase 2: final titles, flags and positions.
      const result: CourseModuleRow[] = [];
      for (const [index, item] of input.modules.entries()) {
        if (item.id) {
          const current = byId.get(item.id)!;
          const [updated] = await tx
            .update(courseModules)
            .set({
              title: item.title,
              isPublished: item.isPublished,
              sequence: index + 1,
              version: current.version + 1,
              updatedBy: principal.userId,
            })
            .where(eq(courseModules.id, item.id))
            .returning();
          result.push(updated!);
        } else {
          const [created] = await tx
            .insert(courseModules)
            .values({
              id: uuidv7(),
              tenantId: principal.tenantId!,
              institutionId,
              courseId,
              title: item.title,
              isPublished: item.isPublished,
              sequence: index + 1,
              createdBy: principal.userId,
            })
            .returning();
          result.push(created!);
        }
      }

      return result;
    });
  }

  /** The lesson analogue of `replaceModules`, locked by the module's version. */
  async replaceLessons(
    principal: Principal,
    institutionId: string,
    moduleId: string,
    input: ReplaceModuleLessonsInput,
  ): Promise<LessonRow[]> {
    const scope = this.requireScope(principal);
    if (scope === 'own') {
      throw new ForbiddenError('lms.manage', 'Only teaching staff can structure a course');
    }

    return this.db.runInTenant(async (tx) => {
      const [moduleRow] = await tx
        .select({ module: courseModules, course: courses })
        .from(courseModules)
        .innerJoin(courses, eq(courses.id, courseModules.courseId))
        .where(
          and(
            eq(courseModules.id, moduleId),
            eq(courseModules.institutionId, institutionId),
            isNull(courseModules.archivedAt),
            isNull(courses.archivedAt),
            this.courseScopeFilter(principal, scope),
          ),
        )
        .limit(1);
      if (!moduleRow) throw new NotFoundError('Module', moduleId);
      await this.assertCanManage(tx, principal, scope, moduleRow.course);

      const [locked] = await tx
        .update(courseModules)
        .set({ version: moduleRow.module.version + 1, updatedBy: principal.userId })
        .where(and(eq(courseModules.id, moduleId), eq(courseModules.version, input.version)))
        .returning({ id: courseModules.id });
      if (!locked) {
        throw new ConflictError(
          'This module was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: input.version, currentVersion: moduleRow.module.version },
        );
      }

      const existing = await tx
        .select()
        .from(lessons)
        .where(and(eq(lessons.moduleId, moduleId), isNull(lessons.archivedAt)));
      const byId = new Map(existing.map((row) => [row.id, row]));

      for (const item of input.lessons) {
        if (item.id && !byId.has(item.id)) {
          throw new NotFoundError('Lesson', item.id);
        }
      }

      if (existing.length > 0) {
        await tx
          .update(lessons)
          .set({ sequence: sql`${lessons.sequence} + ${SEQUENCE_SHUFFLE_OFFSET}` })
          .where(and(eq(lessons.moduleId, moduleId), isNull(lessons.archivedAt)));
      }

      const keptIds = new Set(input.lessons.filter((item) => item.id).map((item) => item.id!));
      const toArchive = existing.filter((row) => !keptIds.has(row.id));
      if (toArchive.length > 0) {
        await tx
          .update(lessons)
          .set({
            archivedAt: new Date(),
            archivedBy: principal.userId,
            archiveReason: 'Removed when the lesson set was replaced',
            version: sql`${lessons.version} + 1`,
            updatedBy: principal.userId,
          })
          .where(
            inArray(
              lessons.id,
              toArchive.map((row) => row.id),
            ),
          );
      }

      const result: LessonRow[] = [];
      for (const [index, item] of input.lessons.entries()) {
        if (item.id) {
          const current = byId.get(item.id)!;
          const [updated] = await tx
            .update(lessons)
            .set({
              title: item.title,
              content: item.content ?? null,
              estimatedMinutes: item.estimatedMinutes ?? null,
              isPublished: item.isPublished,
              sequence: index + 1,
              version: current.version + 1,
              updatedBy: principal.userId,
            })
            .where(eq(lessons.id, item.id))
            .returning();
          result.push(updated!);
        } else {
          const [created] = await tx
            .insert(lessons)
            .values({
              id: uuidv7(),
              tenantId: principal.tenantId!,
              institutionId,
              moduleId,
              title: item.title,
              content: item.content ?? null,
              estimatedMinutes: item.estimatedMinutes ?? null,
              isPublished: item.isPublished,
              sequence: index + 1,
              createdBy: principal.userId,
            })
            .returning();
          result.push(created!);
        }
      }

      return result;
    });
  }

  /**
   * One lesson with its content and resources, behind the full visibility rule: staff
   * within their course scope; a student only a published lesson in a published module of
   * a published course for their class. Anything else is a 404.
   */
  async lessonView(
    principal: Principal,
    institutionId: string,
    lessonId: string,
  ): Promise<LessonRow & { courseId: string; moduleTitle: string; resources: LessonResourceRow[] }> {
    const scope = this.requireScope(principal);

    return this.db.runInTenant(async (tx) => {
      const row = await this.loadVisibleLesson(tx, principal, scope, institutionId, lessonId);

      const resources = await tx
        .select()
        .from(lessonResources)
        .where(and(eq(lessonResources.lessonId, lessonId), isNull(lessonResources.archivedAt)))
        .orderBy(asc(lessonResources.createdAt), asc(lessonResources.id));

      return {
        ...row.lesson,
        courseId: row.course.id,
        moduleTitle: row.module.title,
        resources,
      };
    });
  }

  private async loadVisibleLesson(
    tx: Tx,
    principal: Principal,
    scope: DataScope,
    institutionId: string,
    lessonId: string,
  ): Promise<{ lesson: LessonRow; module: CourseModuleRow; course: CourseRow }> {
    const filters: SQL[] = [
      eq(lessons.id, lessonId),
      eq(lessons.institutionId, institutionId),
      isNull(lessons.archivedAt),
      isNull(courseModules.archivedAt),
      isNull(courses.archivedAt),
      this.courseScopeFilter(principal, scope),
    ];
    if (scope === 'own') {
      filters.push(eq(lessons.isPublished, true), eq(courseModules.isPublished, true));
    }

    const [row] = await tx
      .select({ lesson: lessons, module: courseModules, course: courses })
      .from(lessons)
      .innerJoin(courseModules, eq(courseModules.id, lessons.moduleId))
      .innerJoin(courses, eq(courses.id, courseModules.courseId))
      .where(and(...filters))
      .limit(1);
    if (!row) throw new NotFoundError('Lesson', lessonId);
    return row;
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Lesson resources
  // ────────────────────────────────────────────────────────────────────────────────────

  async addFileResource(
    principal: Principal,
    institutionId: string,
    lessonId: string,
    file: UploadedFileLike,
  ): Promise<LessonResourceRow> {
    const scope = this.requireScope(principal);
    if (scope === 'own') {
      throw new ForbiddenError('lms.manage', 'Only teaching staff can attach lesson resources');
    }
    const mimeType = this.checkUpload(file);

    // The bytes are written before the transaction: if the transaction fails, the orphaned
    // object is invisible (no `files` row) and swept by the incomplete-upload cleanup job.
    const tenantId = principal.tenantId!;
    const stored = await this.storage.put({
      tenantId,
      category: 'lms_resource',
      filename: file.originalname,
      contentType: mimeType,
      body: file.buffer,
    });

    return this.db.runInTenant(async (tx) => {
      const row = await this.loadVisibleLesson(tx, principal, scope, institutionId, lessonId);
      await this.assertCanManage(tx, principal, scope, row.course);

      const [fileRow] = await tx
        .insert(files)
        .values({
          tenantId,
          institutionId,
          storageKey: stored.key,
          storageDriver: 'local',
          originalFilename: file.originalname.slice(0, 255),
          mimeType,
          sizeBytes: stored.sizeBytes,
          checksum: stored.checksum,
          category: 'lms_resource',
          ownerType: 'lesson_resource',
          ownerId: lessonId,
          uploadedAt: new Date(),
          createdBy: principal.userId,
        })
        .returning();

      const [resource] = await tx
        .insert(lessonResources)
        .values({
          id: uuidv7(),
          tenantId,
          institutionId,
          lessonId,
          kind: 'file',
          fileId: fileRow!.id,
          storageKey: stored.key,
          url: null,
          title: file.originalname.slice(0, 255),
          mimeType,
          sizeBytes: stored.sizeBytes,
          createdBy: principal.userId,
        })
        .returning();

      return resource!;
    });
  }

  async addLinkResource(
    principal: Principal,
    institutionId: string,
    lessonId: string,
    input: AddLessonLinkResourceInput,
  ): Promise<LessonResourceRow> {
    const scope = this.requireScope(principal);
    if (scope === 'own') {
      throw new ForbiddenError('lms.manage', 'Only teaching staff can attach lesson resources');
    }

    return this.db.runInTenant(async (tx) => {
      const row = await this.loadVisibleLesson(tx, principal, scope, institutionId, lessonId);
      await this.assertCanManage(tx, principal, scope, row.course);

      const [resource] = await tx
        .insert(lessonResources)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          lessonId,
          kind: input.kind,
          fileId: null,
          storageKey: null,
          url: input.url,
          title: input.title,
          mimeType: null,
          sizeBytes: null,
          createdBy: principal.userId,
        })
        .returning();

      return resource!;
    });
  }

  async listResources(
    principal: Principal,
    institutionId: string,
    lessonId: string,
  ): Promise<LessonResourceRow[]> {
    const scope = this.requireScope(principal);

    return this.db.runInTenant(async (tx) => {
      await this.loadVisibleLesson(tx, principal, scope, institutionId, lessonId);
      return tx
        .select()
        .from(lessonResources)
        .where(and(eq(lessonResources.lessonId, lessonId), isNull(lessonResources.archivedAt)))
        .orderBy(asc(lessonResources.createdAt), asc(lessonResources.id));
    });
  }

  /**
   * A download URL for a resource. Files get a signed, expiring URL — the permission and
   * scope checks happen at issuance, and the URL is then bearer-valid for five minutes,
   * exactly like an S3 pre-signed URL, never a static path. A link or video resource
   * returns its stored URL.
   */
  async resourceDownloadUrl(
    principal: Principal,
    institutionId: string,
    lessonId: string,
    resourceId: string,
  ): Promise<{ resourceId: string; kind: string; url: string; expiresInSeconds: number | null }> {
    const scope = this.requireScope(principal);

    return this.db.runInTenant(async (tx) => {
      // Visibility carries the whole rule: a student can only reach resources of published
      // lessons of published courses for their class, a teacher those of their classes.
      await this.loadVisibleLesson(tx, principal, scope, institutionId, lessonId);

      const [resource] = await tx
        .select()
        .from(lessonResources)
        .where(
          and(
            eq(lessonResources.id, resourceId),
            eq(lessonResources.lessonId, lessonId),
            isNull(lessonResources.archivedAt),
          ),
        )
        .limit(1);
      if (!resource) throw new NotFoundError('Resource', resourceId);

      if (resource.kind === 'file') {
        return {
          resourceId,
          kind: resource.kind,
          url: this.storage.signUrl(resource.storageKey!, DOWNLOAD_TTL_SECONDS),
          expiresInSeconds: DOWNLOAD_TTL_SECONDS,
        };
      }
      return { resourceId, kind: resource.kind, url: resource.url!, expiresInSeconds: null };
    });
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Course enrolment
  // ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Enrol students in bulk. Idempotent over repeats: a student already enrolled is counted
   * rather than refused, so re-running a roster import cannot fail halfway.
   */
  async enrolStudents(
    principal: Principal,
    institutionId: string,
    courseId: string,
    input: EnrolCourseStudentsInput,
  ): Promise<{ courseId: string; enrolled: number; alreadyEnrolled: number }> {
    const scope = this.requireScope(principal);
    if (scope === 'own') {
      throw new ForbiddenError('lms.manage', 'Only teaching staff can enrol students');
    }

    return this.db.runInTenant(async (tx) => {
      const course = await this.loadVisibleCourse(tx, principal, scope, institutionId, courseId);
      await this.assertCanManage(tx, principal, scope, course);
      if (course.status === 'archived') {
        throw new ImmutableRecordError('Course', 'it is archived');
      }

      const found = await tx
        .select({ id: students.id })
        .from(students)
        .where(
          and(
            inArray(students.id, input.studentIds),
            eq(students.institutionId, institutionId),
            isNull(students.archivedAt),
          ),
        );
      const foundIds = new Set(found.map((row) => row.id));
      const missing = input.studentIds.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        // 404, not 403 or a partial write: an id outside this institution must look absent.
        throw new NotFoundError('Student', missing[0]);
      }

      const existing = await tx
        .select({ studentId: courseEnrolments.studentId })
        .from(courseEnrolments)
        .where(
          and(
            eq(courseEnrolments.courseId, courseId),
            inArray(courseEnrolments.studentId, input.studentIds),
            isNull(courseEnrolments.archivedAt),
          ),
        );
      const existingIds = new Set(existing.map((row) => row.studentId));
      const newIds = input.studentIds.filter((id) => !existingIds.has(id));

      if (newIds.length > 0) {
        const now = new Date();
        await tx.insert(courseEnrolments).values(
          newIds.map((studentId) => ({
            id: uuidv7(),
            tenantId: principal.tenantId!,
            institutionId,
            courseId,
            studentId,
            enrolledAt: now,
            createdBy: principal.userId,
          })),
        );
      }

      return { courseId, enrolled: newIds.length, alreadyEnrolled: existingIds.size };
    });
  }

  async listEnrolments(
    principal: Principal,
    institutionId: string,
    courseId: string,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<Record<string, unknown>>> {
    const scope = this.requireScope(principal);
    if (scope === 'own') {
      // The roster names every enrolled student; that is staff data.
      throw new ForbiddenError('lms.progress.view', 'You cannot view a course roster');
    }

    return this.db.runInTenant(async (tx) => {
      await this.loadVisibleCourse(tx, principal, scope, institutionId, courseId);

      const where = and(
        eq(courseEnrolments.courseId, courseId),
        isNull(courseEnrolments.archivedAt),
      );

      const rows = await tx
        .select({
          enrolment: courseEnrolments,
          studentName: students.fullNameEn,
          studentCode: students.studentCode,
        })
        .from(courseEnrolments)
        .innerJoin(students, eq(students.id, courseEnrolments.studentId))
        .where(where)
        .orderBy(asc(students.fullNameEn), asc(courseEnrolments.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(courseEnrolments)
        .where(where);

      const data = rows.map((row) => ({
        ...row.enrolment,
        studentName: row.studentName,
        studentCode: row.studentCode,
      }));
      return buildOffsetPage(data, counted?.total ?? 0, page);
    });
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Lesson progress
  // ────────────────────────────────────────────────────────────────────────────────────

  /**
   * A student reporting their own progress. Status only moves forward — completion is not
   * un-done by a later report — `seconds_spent` accumulates, and `completed_at` is the
   * server clock's word, never the client's.
   */
  async recordProgress(
    principal: Principal,
    institutionId: string,
    lessonId: string,
    input: RecordLessonProgressInput,
  ): Promise<LessonProgressRow> {
    const studentId = principal.studentId;
    if (!studentId) {
      throw new ForbiddenError('lms.view', 'Only students can record lesson progress');
    }

    return this.db.runInTenant(async (tx) => {
      // The same visibility the lesson view applies: published lesson, published module,
      // published course, the student's own class. Anything else does not exist for them.
      await this.loadVisibleLesson(tx, principal, 'own', institutionId, lessonId);

      const now = new Date();
      const [existing] = await tx
        .select()
        .from(lessonProgress)
        .where(
          and(
            eq(lessonProgress.lessonId, lessonId),
            eq(lessonProgress.studentId, studentId),
            isNull(lessonProgress.archivedAt),
          ),
        )
        .limit(1);

      if (!existing) {
        const status = input.status ?? 'in_progress';
        const [created] = await tx
          .insert(lessonProgress)
          .values({
            id: uuidv7(),
            tenantId: principal.tenantId!,
            institutionId,
            lessonId,
            studentId,
            status,
            completedAt: status === 'completed' ? now : null,
            secondsSpent: input.secondsSpent ?? 0,
            createdBy: principal.userId,
          })
          .returning();
        return created!;
      }

      const nextStatus =
        existing.status === 'completed'
          ? 'completed'
          : (input.status ?? (existing.status === 'not_started' ? 'in_progress' : existing.status));

      const [updated] = await tx
        .update(lessonProgress)
        .set({
          status: nextStatus,
          completedAt:
            existing.completedAt ?? (nextStatus === 'completed' ? now : null),
          secondsSpent: existing.secondsSpent + (input.secondsSpent ?? 0),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(lessonProgress.id, existing.id))
        .returning();
      return updated!;
    });
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Quizzes
  // ────────────────────────────────────────────────────────────────────────────────────

  /** Resolve a quiz's anchor course (and, when lesson-anchored, its lesson and module). */
  private async loadQuizCourse(
    tx: Tx,
    quiz: QuizRow,
  ): Promise<{ course: CourseRow; module: CourseModuleRow | null; lesson: LessonRow | null }> {
    if (quiz.courseId) {
      const [course] = await tx
        .select()
        .from(courses)
        .where(and(eq(courses.id, quiz.courseId), isNull(courses.archivedAt)))
        .limit(1);
      if (!course) throw new NotFoundError('Quiz', quiz.id);
      return { course, module: null, lesson: null };
    }

    const [row] = await tx
      .select({ lesson: lessons, module: courseModules, course: courses })
      .from(lessons)
      .innerJoin(courseModules, eq(courseModules.id, lessons.moduleId))
      .innerJoin(courses, eq(courses.id, courseModules.courseId))
      .where(
        and(
          eq(lessons.id, quiz.lessonId!),
          isNull(lessons.archivedAt),
          isNull(courseModules.archivedAt),
          isNull(courses.archivedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError('Quiz', quiz.id);
    return { course: row.course, module: row.module, lesson: row.lesson };
  }

  /** May this principal manage the quiz's course? Boolean twin of `assertCanManage`. */
  private async mayManageCourse(
    tx: Tx,
    principal: Principal,
    scope: DataScope,
    course: CourseRow,
  ): Promise<boolean> {
    if (scope === 'all') return true;
    if (scope !== 'assigned' || !principal.employeeId) return false;
    if (course.ownerEmployeeId === principal.employeeId) return true;
    return this.isAssignedToClassSubject(
      tx,
      principal.employeeId,
      course.institutionId,
      course.academicYearId,
      course.classLevelId,
      course.subjectId,
    );
  }

  async createQuiz(
    principal: Principal,
    institutionId: string,
    input: CreateQuizInput,
  ): Promise<QuizRow & { questionCount: number }> {
    const scope = this.requireScope(principal);
    if (scope === 'own') {
      throw new ForbiddenError('lms.manage', 'Only teaching staff can create quizzes');
    }

    return this.db.runInTenant(async (tx) => {
      let course: CourseRow;
      if (input.courseId) {
        course = await this.loadVisibleCourse(tx, principal, scope, institutionId, input.courseId);
      } else {
        const row = await this.loadVisibleLesson(
          tx,
          principal,
          scope,
          institutionId,
          input.lessonId!,
        );
        course = row.course;
      }
      await this.assertCanManage(tx, principal, scope, course);

      const quizId = uuidv7();
      const [quiz] = await tx
        .insert(quizzes)
        .values({
          id: quizId,
          tenantId: principal.tenantId!,
          institutionId,
          courseId: input.courseId ?? null,
          lessonId: input.lessonId ?? null,
          title: input.title,
          totalMarks: input.totalMarks,
          passMarks: input.passMarks,
          timeLimitMinutes: input.timeLimitMinutes ?? null,
          attemptsAllowed: input.attemptsAllowed,
          shuffleQuestions: input.shuffleQuestions,
          status: 'draft',
          createdBy: principal.userId,
        })
        .returning();

      await this.insertQuestions(tx, principal, institutionId, quizId, input.questions);

      return { ...quiz!, questionCount: input.questions.length };
    });
  }

  private async insertQuestions(
    tx: Tx,
    principal: Principal,
    institutionId: string,
    quizId: string,
    questions: CreateQuizInput['questions'],
  ): Promise<void> {
    for (const [index, question] of questions.entries()) {
      const questionId = uuidv7();
      await tx.insert(quizQuestions).values({
        id: questionId,
        tenantId: principal.tenantId!,
        institutionId,
        quizId,
        sequence: index + 1,
        kind: question.kind,
        prompt: question.prompt,
        marks: question.marks,
        allowPartialCredit: question.allowPartialCredit,
        createdBy: principal.userId,
      });
      if (question.options.length > 0) {
        await tx.insert(quizOptions).values(
          question.options.map((option, optionIndex) => ({
            id: uuidv7(),
            tenantId: principal.tenantId!,
            institutionId,
            questionId,
            sequence: optionIndex + 1,
            text: option.text,
            isCorrect: option.isCorrect,
            createdBy: principal.userId,
          })),
        );
      }
    }
  }

  /**
   * One quiz. A caller who may manage the course receives the full definition including
   * the answer key; anyone else — students above all — receives metadata only, with no
   * questions and no options, and then only once the quiz and its course are published.
   */
  async quizView(
    principal: Principal,
    institutionId: string,
    id: string,
  ): Promise<Record<string, unknown>> {
    const scope = this.requireScope(principal);

    return this.db.runInTenant(async (tx) => {
      const quiz = await this.loadQuiz(tx, institutionId, id);
      const anchor = await this.loadQuizCourse(tx, quiz);

      const managing = await this.mayManageCourse(tx, principal, scope, anchor.course);
      if (managing) {
        const questions = await this.loadQuestionsWithOptions(tx, quiz.id);
        return { ...quiz, questions };
      }

      await this.assertQuizVisibleToNonManager(tx, principal, scope, institutionId, quiz, anchor);
      // Metadata only: no questions, no options, and therefore no is_correct to leak.
      return {
        id: quiz.id,
        courseId: quiz.courseId,
        lessonId: quiz.lessonId,
        title: quiz.title,
        totalMarks: quiz.totalMarks,
        passMarks: quiz.passMarks,
        timeLimitMinutes: quiz.timeLimitMinutes,
        attemptsAllowed: quiz.attemptsAllowed,
        shuffleQuestions: quiz.shuffleQuestions,
        status: quiz.status,
        publishedAt: quiz.publishedAt,
      };
    });
  }

  private async loadQuiz(tx: Tx, institutionId: string, id: string): Promise<QuizRow> {
    const [quiz] = await tx
      .select()
      .from(quizzes)
      .where(
        and(eq(quizzes.id, id), eq(quizzes.institutionId, institutionId), isNull(quizzes.archivedAt)),
      )
      .limit(1);
    if (!quiz) throw new NotFoundError('Quiz', id);
    return quiz;
  }

  /**
   * A non-managing caller sees a quiz only when it is published and its anchor is fully
   * published and within their course scope. Failure is a 404 — a draft quiz does not
   * exist for a student, and which quizzes exist is not theirs to enumerate.
   */
  private async assertQuizVisibleToNonManager(
    tx: Tx,
    principal: Principal,
    scope: DataScope,
    institutionId: string,
    quiz: QuizRow,
    anchor: { course: CourseRow; module: CourseModuleRow | null; lesson: LessonRow | null },
  ): Promise<void> {
    if (quiz.status !== 'published') throw new NotFoundError('Quiz', quiz.id);
    if (anchor.module && !(anchor.module.isPublished && anchor.lesson!.isPublished)) {
      throw new NotFoundError('Quiz', quiz.id);
    }
    // Re-load the course through the scope filter; an invisible course means an invisible quiz.
    try {
      await this.loadVisibleCourse(tx, principal, scope, institutionId, anchor.course.id);
    } catch {
      throw new NotFoundError('Quiz', quiz.id);
    }
  }

  private async loadQuestionsWithOptions(
    tx: Tx,
    quizId: string,
  ): Promise<(QuizQuestionRow & { options: QuizOptionRow[] })[]> {
    const questions = await tx
      .select()
      .from(quizQuestions)
      .where(and(eq(quizQuestions.quizId, quizId), isNull(quizQuestions.archivedAt)))
      .orderBy(asc(quizQuestions.sequence), asc(quizQuestions.id));

    if (questions.length === 0) return [];
    const options = await tx
      .select()
      .from(quizOptions)
      .where(
        and(
          inArray(
            quizOptions.questionId,
            questions.map((question) => question.id),
          ),
          isNull(quizOptions.archivedAt),
        ),
      )
      .orderBy(asc(quizOptions.sequence), asc(quizOptions.id));

    const byQuestion = new Map<string, QuizOptionRow[]>();
    for (const option of options) {
      const bucket = byQuestion.get(option.questionId) ?? [];
      bucket.push(option);
      byQuestion.set(option.questionId, bucket);
    }
    return questions.map((question) => ({
      ...question,
      options: byQuestion.get(question.id) ?? [],
    }));
  }

  /** Load quiz + verify the caller may manage it, in one step. */
  private async loadManagedQuiz(
    tx: Tx,
    principal: Principal,
    scope: DataScope,
    institutionId: string,
    id: string,
  ): Promise<{ quiz: QuizRow; course: CourseRow }> {
    const quiz = await this.loadQuiz(tx, institutionId, id);
    const anchor = await this.loadQuizCourse(tx, quiz);
    const managing = await this.mayManageCourse(tx, principal, scope, anchor.course);
    if (!managing) throw new NotFoundError('Quiz', id);
    return { quiz, course: anchor.course };
  }

  async updateQuiz(
    principal: Principal,
    institutionId: string,
    id: string,
    input: UpdateQuizInput,
  ): Promise<{ quiz: QuizRow; previous: Record<string, unknown> }> {
    const scope = this.requireScope(principal);
    if (scope === 'own') {
      throw new ForbiddenError('lms.manage', 'Only teaching staff can manage quizzes');
    }
    const { version, ...changes } = input;

    return this.db.runInTenant(async (tx) => {
      const { quiz } = await this.loadManagedQuiz(tx, principal, scope, institutionId, id);
      if (quiz.status !== 'draft') {
        // Students may already hold attempts against the published definition.
        throw new ImmutableRecordError('Quiz', 'its definition is fixed once published');
      }

      const values: Partial<QuizRow> = {};
      if (changes.title !== undefined) values.title = changes.title;
      if (changes.totalMarks !== undefined) values.totalMarks = changes.totalMarks;
      if (changes.passMarks !== undefined) values.passMarks = changes.passMarks;
      if (changes.timeLimitMinutes !== undefined) values.timeLimitMinutes = changes.timeLimitMinutes;
      if (changes.attemptsAllowed !== undefined) values.attemptsAllowed = changes.attemptsAllowed;
      if (changes.shuffleQuestions !== undefined) {
        values.shuffleQuestions = changes.shuffleQuestions;
      }

      const nextTotal = values.totalMarks ?? quiz.totalMarks;
      const nextPass = values.passMarks ?? quiz.passMarks;
      if (toHundredths(nextPass)! > toHundredths(nextTotal)!) {
        throw new ValidationError('Pass marks cannot exceed the total', [
          { path: 'passMarks', message: `Pass marks may not exceed ${nextTotal}` },
        ]);
      }

      const [updated] = await tx
        .update(quizzes)
        .set({ ...values, version: quiz.version + 1, updatedBy: principal.userId })
        .where(and(eq(quizzes.id, id), eq(quizzes.version, version)))
        .returning();
      if (!updated) {
        throw new ConflictError(
          'This quiz was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: quiz.version },
        );
      }

      const previous: Record<string, unknown> = {};
      for (const key of Object.keys(values) as (keyof QuizRow)[]) {
        previous[key] = quiz[key];
      }
      return { quiz: updated, previous };
    });
  }

  /** Replace the whole question set of a draft quiz. Old rows are archived, never deleted. */
  async replaceQuestions(
    principal: Principal,
    institutionId: string,
    id: string,
    input: ReplaceQuizQuestionsInput,
  ): Promise<{ quizId: string; questionCount: number }> {
    const scope = this.requireScope(principal);
    if (scope === 'own') {
      throw new ForbiddenError('lms.manage', 'Only teaching staff can manage quizzes');
    }

    return this.db.runInTenant(async (tx) => {
      const { quiz } = await this.loadManagedQuiz(tx, principal, scope, institutionId, id);
      if (quiz.status !== 'draft') {
        throw new ImmutableRecordError('Quiz', 'its questions are fixed once published');
      }

      const [locked] = await tx
        .update(quizzes)
        .set({ version: quiz.version + 1, updatedBy: principal.userId })
        .where(and(eq(quizzes.id, id), eq(quizzes.version, input.version)))
        .returning({ id: quizzes.id });
      if (!locked) {
        throw new ConflictError(
          'This quiz was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: input.version, currentVersion: quiz.version },
        );
      }

      const now = new Date();
      const existing = await tx
        .select({ id: quizQuestions.id })
        .from(quizQuestions)
        .where(and(eq(quizQuestions.quizId, id), isNull(quizQuestions.archivedAt)));
      if (existing.length > 0) {
        const questionIds = existing.map((row) => row.id);
        await tx
          .update(quizQuestions)
          .set({
            archivedAt: now,
            archivedBy: principal.userId,
            archiveReason: 'Replaced by a new question set',
            version: sql`${quizQuestions.version} + 1`,
            updatedBy: principal.userId,
          })
          .where(inArray(quizQuestions.id, questionIds));
        await tx
          .update(quizOptions)
          .set({
            archivedAt: now,
            archivedBy: principal.userId,
            archiveReason: 'Replaced by a new question set',
            version: sql`${quizOptions.version} + 1`,
            updatedBy: principal.userId,
          })
          .where(
            and(inArray(quizOptions.questionId, questionIds), isNull(quizOptions.archivedAt)),
          );
      }

      await this.insertQuestions(tx, principal, institutionId, id, input.questions);
      return { quizId: id, questionCount: input.questions.length };
    });
  }

  /**
   * Publishing verifies what the database alone cannot: at least one live question, every
   * choice question structurally sound, and the question marks summing exactly — in
   * integer hundredths — to `total_marks`.
   */
  async publishQuiz(
    principal: Principal,
    institutionId: string,
    id: string,
    version: number,
  ): Promise<QuizRow> {
    const scope = this.requireScope(principal);
    if (scope === 'own') {
      throw new ForbiddenError('lms.publish', 'Only teaching staff can publish quizzes');
    }

    return this.db.runInTenant(async (tx) => {
      const { quiz } = await this.loadManagedQuiz(tx, principal, scope, institutionId, id);
      if (quiz.status !== 'draft') {
        throw new WorkflowStateError(quiz.status, 'published', 'quiz');
      }

      const questions = await this.loadQuestionsWithOptions(tx, id);
      if (questions.length === 0) {
        throw new ValidationError('A quiz cannot be published without questions', [
          { path: 'questions', message: 'Add at least one question first' },
        ]);
      }

      let sum = 0;
      for (const question of questions) {
        sum += toHundredths(question.marks)!;
        const correct = question.options.filter((option) => option.isCorrect).length;
        if (question.kind === 'short_text') {
          if (question.options.length > 0) {
            throw new ValidationError('A short-text question has no options', [
              { path: 'questions', message: `Question ${question.sequence} carries options` },
            ]);
          }
          continue;
        }
        if (question.options.length < 2) {
          throw new ValidationError('A choice question needs at least two options', [
            { path: 'questions', message: `Question ${question.sequence} has too few options` },
          ]);
        }
        if ((question.kind === 'mcq_single' || question.kind === 'true_false') && correct !== 1) {
          throw new ValidationError('Mark exactly one option as correct', [
            { path: 'questions', message: `Question ${question.sequence} must have one correct option` },
          ]);
        }
        if (question.kind === 'mcq_multi' && correct === 0) {
          throw new ValidationError('Mark at least one option as correct', [
            { path: 'questions', message: `Question ${question.sequence} has no correct option` },
          ]);
        }
      }
      if (sum !== toHundredths(quiz.totalMarks)!) {
        throw new ValidationError('The question marks do not sum to the quiz total', [
          {
            path: 'totalMarks',
            message: `The questions add up to ${fromHundredths(sum)}, not ${quiz.totalMarks}`,
          },
        ]);
      }

      const [updated] = await tx
        .update(quizzes)
        .set({
          status: 'published',
          publishedAt: new Date(),
          version: quiz.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(quizzes.id, id), eq(quizzes.version, version)))
        .returning();
      if (!updated) {
        throw new ConflictError(
          'This quiz was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: quiz.version },
        );
      }
      return updated;
    });
  }

  async archiveQuiz(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
    version: number,
  ): Promise<QuizRow> {
    const scope = this.requireScope(principal);
    if (scope === 'own') {
      throw new ForbiddenError('lms.publish', 'Only teaching staff can withdraw quizzes');
    }

    return this.db.runInTenant(async (tx) => {
      const { quiz } = await this.loadManagedQuiz(tx, principal, scope, institutionId, id);

      const [updated] = await tx
        .update(quizzes)
        .set({
          status: 'archived',
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason.slice(0, 500),
          version: quiz.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(quizzes.id, id), eq(quizzes.version, version)))
        .returning();
      if (!updated) {
        throw new ConflictError(
          'This quiz was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: quiz.version },
        );
      }
      return updated;
    });
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Attempts
  // ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Start an attempt. The server assigns the attempt number, refuses a start beyond
   * `attempts_allowed`, refuses a second open attempt, and stamps `started_at` — the sole
   * anchor for the time limit. The questions returned are mapped through the student
   * projection: no `is_correct`, structurally.
   */
  async startAttempt(
    principal: Principal,
    institutionId: string,
    quizId: string,
  ): Promise<QuizAttemptRow & { timeLimitMinutes: number | null; questions: StudentQuizQuestion[] }> {
    const studentId = principal.studentId;
    if (!studentId) {
      throw new ForbiddenError('lms.view', 'Only students can attempt quizzes');
    }

    return this.db.runInTenant(async (tx) => {
      const quiz = await this.loadQuiz(tx, institutionId, quizId);
      const anchor = await this.loadQuizCourse(tx, quiz);

      // Everything below answers 404 rather than 403: a draft quiz, an unpublished lesson,
      // a course the student is not part of — none of them exist for this caller.
      if (
        quiz.status !== 'published' ||
        anchor.course.status !== 'published' ||
        (anchor.module !== null && !(anchor.module.isPublished && anchor.lesson!.isPublished))
      ) {
        throw new NotFoundError('Quiz', quizId);
      }
      const [enrolment] = await tx
        .select({ one: sql<number>`1` })
        .from(courseEnrolments)
        .where(
          and(
            eq(courseEnrolments.courseId, anchor.course.id),
            eq(courseEnrolments.studentId, studentId),
            isNull(courseEnrolments.archivedAt),
          ),
        )
        .limit(1);
      if (!enrolment) throw new NotFoundError('Quiz', quizId);

      const previous = await tx
        .select({
          id: quizAttempts.id,
          attemptNumber: quizAttempts.attemptNumber,
          submittedAt: quizAttempts.submittedAt,
        })
        .from(quizAttempts)
        .where(
          and(
            eq(quizAttempts.quizId, quizId),
            eq(quizAttempts.studentId, studentId),
            isNull(quizAttempts.archivedAt),
          ),
        );

      const open = previous.find((attempt) => attempt.submittedAt === null);
      if (open) {
        throw new ConflictError('You already have an attempt in progress for this quiz', {
          attemptId: open.id,
        });
      }
      if (previous.length >= quiz.attemptsAllowed) {
        throw new ConflictError(
          `You have used all ${quiz.attemptsAllowed} allowed attempt(s) for this quiz`,
        );
      }
      const nextNumber = previous.reduce((max, row) => Math.max(max, row.attemptNumber), 0) + 1;

      const [attempt] = await tx
        .insert(quizAttempts)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          quizId,
          studentId,
          attemptNumber: nextNumber,
          startedAt: new Date(),
          createdBy: principal.userId,
        })
        .returning();

      const questions = await this.loadQuestionsWithOptions(tx, quizId);
      const ordered = quiz.shuffleQuestions ? shuffle(questions) : questions;

      return {
        ...attempt!,
        timeLimitMinutes: quiz.timeLimitMinutes,
        questions: ordered.map((question) => this.redactQuestionForStudent(question)),
      };
    });
  }

  /**
   * The student projection of a question. `is_correct` (and the grading configuration) is
   * not set to null — the shape simply does not carry it, the way HR's redaction keeps one
   * query path and strips on the way out.
   */
  private redactQuestionForStudent(
    question: QuizQuestionRow & { options: QuizOptionRow[] },
  ): StudentQuizQuestion {
    return {
      id: question.id,
      sequence: question.sequence,
      kind: question.kind,
      prompt: question.prompt,
      marks: question.marks,
      options: question.options.map((option) => ({
        id: option.id,
        sequence: option.sequence,
        text: option.text,
      })),
    };
  }

  /**
   * Submit an attempt. The server clock is compared to `started_at` for the time limit —
   * a client-supplied elapsed time does not exist in the schema. Choice questions are
   * auto-graded in integer hundredths; short-text answers are queued for manual marking,
   * and the attempt is not `is_graded` until every question carries a mark. A submitted
   * attempt is immutable.
   */
  async submitAttempt(
    principal: Principal,
    institutionId: string,
    attemptId: string,
    input: SubmitQuizAttemptInput,
  ): Promise<QuizAttemptRow & { answers: Record<string, unknown>[] }> {
    const studentId = principal.studentId;
    if (!studentId) {
      throw new ForbiddenError('lms.view', 'Only students can submit quiz attempts');
    }

    return this.db.runInTenant(async (tx) => {
      const [row] = await tx
        .select({ attempt: quizAttempts, quiz: quizzes })
        .from(quizAttempts)
        .innerJoin(quizzes, eq(quizzes.id, quizAttempts.quizId))
        .where(
          and(
            eq(quizAttempts.id, attemptId),
            eq(quizAttempts.institutionId, institutionId),
            // Another student's attempt simply does not exist for this caller.
            eq(quizAttempts.studentId, studentId),
            isNull(quizAttempts.archivedAt),
          ),
        )
        .limit(1);
      if (!row) throw new NotFoundError('Attempt', attemptId);

      if (row.attempt.submittedAt !== null) {
        throw new ConflictError('This attempt has already been submitted and cannot be changed');
      }

      const now = new Date();
      if (row.quiz.timeLimitMinutes !== null) {
        const deadline = row.attempt.startedAt.getTime() + row.quiz.timeLimitMinutes * 60_000;
        if (now.getTime() > deadline) {
          throw new ValidationError('The time limit for this quiz has passed', [
            {
              path: 'answers',
              message: 'The attempt ran past its time limit and can no longer be submitted',
            },
          ]);
        }
      }

      const questions = await this.loadQuestionsWithOptions(tx, row.quiz.id);
      const questionIds = new Set(questions.map((question) => question.id));
      const byQuestion = new Map(input.answers.map((answer) => [answer.questionId, answer]));
      for (const answer of input.answers) {
        if (!questionIds.has(answer.questionId)) {
          throw new ValidationError('An answer refers to a question outside this quiz', [
            { path: 'answers', message: `Unknown question ${answer.questionId}` },
          ]);
        }
      }

      const inserted: Record<string, unknown>[] = [];
      let gradedHundredths = 0;
      let allGraded = true;
      for (const question of questions) {
        const graded = this.gradeQuestion(question, byQuestion.get(question.id));
        if (graded.marks === null) {
          allGraded = false;
        } else {
          gradedHundredths += toHundredths(graded.marks)!;
        }
        const [answerRow] = await tx
          .insert(quizAnswers)
          .values({
            id: uuidv7(),
            tenantId: principal.tenantId!,
            institutionId,
            attemptId,
            questionId: question.id,
            selectedOptionIds: graded.selected,
            textAnswer: graded.text,
            marksAwarded: graded.marks,
            createdBy: principal.userId,
          })
          .returning();
        inserted.push({
          id: answerRow!.id,
          questionId: question.id,
          selectedOptionIds: answerRow!.selectedOptionIds,
          textAnswer: answerRow!.textAnswer,
          marksAwarded: answerRow!.marksAwarded,
        });
      }

      const [updated] = await tx
        .update(quizAttempts)
        .set({
          submittedAt: now,
          isGraded: allGraded,
          score: allGraded ? fromHundredths(gradedHundredths) : null,
          version: row.attempt.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(quizAttempts.id, attemptId))
        .returning();

      return { ...updated!, answers: inserted };
    });
  }

  /**
   * Auto-grading for one question, in exact integer hundredths:
   *  - mcq_single / true_false: full marks for the single correct choice, otherwise zero.
   *  - mcq_multi: all-or-nothing on the exact correct set, unless partial credit is
   *    configured — then marks × (right − wrong) / |correct|, floored at zero.
   *  - short_text: zero when unanswered, otherwise queued (null) for manual grading.
   */
  private gradeQuestion(
    question: QuizQuestionRow & { options: QuizOptionRow[] },
    answer: { selectedOptionIds: string[]; textAnswer?: string } | undefined,
  ): { selected: string[]; text: string | null; marks: string | null } {
    const optionIds = new Set(question.options.map((option) => option.id));
    const correct = new Set(
      question.options.filter((option) => option.isCorrect).map((option) => option.id),
    );
    const selected = answer?.selectedOptionIds ?? [];
    for (const id of selected) {
      if (!optionIds.has(id)) {
        throw new ValidationError('An answer selects an option outside its question', [
          { path: 'answers', message: `Option ${id} does not belong to question ${question.id}` },
        ]);
      }
    }

    if (question.kind === 'short_text') {
      if (selected.length > 0) {
        throw new ValidationError('A short-text question takes no options', [
          { path: 'answers', message: `Question ${question.id} expects a text answer` },
        ]);
      }
      const text = answer?.textAnswer ?? null;
      // An unanswered question is a zero, not a pending mark — otherwise a blank paper
      // could hold the attempt "ungraded" forever.
      return { selected: [], text, marks: text === null ? '0.00' : null };
    }

    if (question.kind === 'mcq_single' || question.kind === 'true_false') {
      if (selected.length > 1) {
        throw new ValidationError('Choose a single option for this question', [
          { path: 'answers', message: `Question ${question.id} takes one option` },
        ]);
      }
      const right = selected.length === 1 && correct.has(selected[0]!);
      return { selected, text: null, marks: right ? question.marks : '0.00' };
    }

    // mcq_multi
    const chosen = new Set(selected);
    if (question.allowPartialCredit) {
      let right = 0;
      let wrong = 0;
      for (const id of chosen) {
        if (correct.has(id)) right += 1;
        else wrong += 1;
      }
      const marksHundredths = toHundredths(question.marks)!;
      // The ratio may be a number — it is a ratio, not an amount (the Money.allocate rule).
      const net = Math.max(0, Math.round((marksHundredths * (right - wrong)) / correct.size));
      return { selected, text: null, marks: fromHundredths(net) };
    }
    const exact = chosen.size === correct.size && [...correct].every((id) => chosen.has(id));
    return { selected, text: null, marks: exact ? question.marks : '0.00' };
  }

  /**
   * One attempt with its answers. The owning student (and their guardian) may read it;
   * staff may read within their manageable courses; everyone else gets a 404. Answers
   * carry the question prompt and the mark — never the option list, never `is_correct`.
   */
  async attemptView(
    principal: Principal,
    institutionId: string,
    attemptId: string,
  ): Promise<Record<string, unknown>> {
    const scope = this.requireScope(principal);

    return this.db.runInTenant(async (tx) => {
      const [row] = await tx
        .select({ attempt: quizAttempts, quiz: quizzes })
        .from(quizAttempts)
        .innerJoin(quizzes, eq(quizzes.id, quizAttempts.quizId))
        .where(
          and(
            eq(quizAttempts.id, attemptId),
            eq(quizAttempts.institutionId, institutionId),
            isNull(quizAttempts.archivedAt),
          ),
        )
        .limit(1);
      if (!row) throw new NotFoundError('Attempt', attemptId);

      const allowed = await this.maySeeAttempt(tx, principal, scope, row.attempt);
      if (!allowed) throw new NotFoundError('Attempt', attemptId);

      const answers = await tx
        .select({
          id: quizAnswers.id,
          questionId: quizAnswers.questionId,
          prompt: quizQuestions.prompt,
          kind: quizQuestions.kind,
          questionMarks: quizQuestions.marks,
          sequence: quizQuestions.sequence,
          selectedOptionIds: quizAnswers.selectedOptionIds,
          textAnswer: quizAnswers.textAnswer,
          marksAwarded: quizAnswers.marksAwarded,
          gradedAt: quizAnswers.gradedAt,
        })
        .from(quizAnswers)
        .innerJoin(quizQuestions, eq(quizQuestions.id, quizAnswers.questionId))
        .where(and(eq(quizAnswers.attemptId, attemptId), isNull(quizAnswers.archivedAt)))
        .orderBy(asc(quizQuestions.sequence), asc(quizAnswers.id));

      return {
        ...row.attempt,
        quizTitle: row.quiz.title,
        totalMarks: row.quiz.totalMarks,
        passMarks: row.quiz.passMarks,
        answers,
      };
    });
  }

  private async maySeeAttempt(
    tx: Tx,
    principal: Principal,
    scope: DataScope,
    attempt: QuizAttemptRow,
  ): Promise<boolean> {
    if (principal.studentId && attempt.studentId === principal.studentId) return true;
    if (scope === 'all') return true;

    if (scope === 'assigned') {
      const quiz = await this.loadQuiz(tx, attempt.institutionId, attempt.quizId);
      const anchor = await this.loadQuizCourse(tx, quiz);
      return this.mayManageCourse(tx, principal, scope, anchor.course);
    }

    // `own`: a guardian sees their linked children's attempts.
    if (principal.guardianId) {
      const [link] = await tx
        .select({ one: sql<number>`1` })
        .from(studentGuardians)
        .where(
          and(
            eq(studentGuardians.studentId, attempt.studentId),
            eq(studentGuardians.guardianId, principal.guardianId),
            eq(studentGuardians.canAccessPortal, true),
            isNull(studentGuardians.archivedAt),
          ),
        )
        .limit(1);
      if (link) return true;
    }
    return false;
  }

  async listAttempts(
    principal: Principal,
    institutionId: string,
    quizId: string,
    query: ListQuizAttemptsQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<Record<string, unknown>>> {
    const scope = this.requireScope(principal);
    if (scope === 'own') {
      throw new ForbiddenError('lms.progress.view', 'You cannot list quiz attempts');
    }

    return this.db.runInTenant(async (tx) => {
      await this.loadManagedQuiz(tx, principal, scope, institutionId, quizId);

      const filters: SQL[] = [
        eq(quizAttempts.quizId, quizId),
        isNull(quizAttempts.archivedAt),
      ];
      if (query.studentId) filters.push(eq(quizAttempts.studentId, query.studentId));
      if (query.pendingGrading) {
        filters.push(
          exists(
            this.db.raw
              .select({ one: sql`1` })
              .from(quizAnswers)
              .where(
                and(
                  eq(quizAnswers.attemptId, quizAttempts.id),
                  isNull(quizAnswers.marksAwarded),
                  isNull(quizAnswers.archivedAt),
                ),
              ),
          ),
        );
      }
      const where = and(...filters);

      const rows = await tx
        .select({
          attempt: quizAttempts,
          studentName: students.fullNameEn,
          studentCode: students.studentCode,
        })
        .from(quizAttempts)
        .innerJoin(students, eq(students.id, quizAttempts.studentId))
        .where(where)
        .orderBy(desc(quizAttempts.startedAt), asc(quizAttempts.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(quizAttempts)
        .where(where);

      const data = rows.map((row) => ({
        ...row.attempt,
        studentName: row.studentName,
        studentCode: row.studentCode,
      }));
      return buildOffsetPage(data, counted?.total ?? 0, page);
    });
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Manual grading
  // ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Grade (or re-grade) one short-text answer. Re-grading a mark that already exists
   * requires a reason, and the before/after audit record is written inside the business
   * transaction — if the re-grade rolls back, so does its trail. The attempt's score and
   * `is_graded` are recomputed as a fresh SQL-backed sum, never adjusted incrementally.
   */
  async gradeAnswer(
    principal: Principal,
    institutionId: string,
    answerId: string,
    input: GradeQuizAnswerInput,
  ): Promise<{
    answer: QuizAnswerRow;
    attempt: QuizAttemptRow;
    previous: Record<string, unknown> | null;
  }> {
    const scope = this.requireScope(principal);
    if (scope === 'own') {
      throw new ForbiddenError('lms.manage', 'Only teaching staff can grade quiz answers');
    }
    if (!principal.employeeId) {
      // graded_by is an accountability column pointing at an employee; an account with no
      // employee record cannot own a mark.
      throw new ForbiddenError(
        'lms.manage',
        'Only staff with an employee record can grade quiz answers',
      );
    }
    const gradedBy = principal.employeeId;

    return this.db.runInTenant(async (tx) => {
      const [row] = await tx
        .select({
          answer: quizAnswers,
          question: quizQuestions,
          attempt: quizAttempts,
          quiz: quizzes,
        })
        .from(quizAnswers)
        .innerJoin(quizQuestions, eq(quizQuestions.id, quizAnswers.questionId))
        .innerJoin(quizAttempts, eq(quizAttempts.id, quizAnswers.attemptId))
        .innerJoin(quizzes, eq(quizzes.id, quizAttempts.quizId))
        .where(
          and(
            eq(quizAnswers.id, answerId),
            eq(quizAnswers.institutionId, institutionId),
            isNull(quizAnswers.archivedAt),
          ),
        )
        .limit(1);
      if (!row) throw new NotFoundError('Answer', answerId);

      const anchor = await this.loadQuizCourse(tx, row.quiz);
      const managing = await this.mayManageCourse(tx, principal, scope, anchor.course);
      if (!managing) throw new NotFoundError('Answer', answerId);

      if (row.attempt.submittedAt === null) {
        throw new ConflictError('This attempt has not been submitted yet');
      }
      if (row.question.kind !== 'short_text') {
        throw new ValidationError('Only short-text answers are graded by hand', [
          { path: 'marks', message: 'Choice questions are graded automatically at submission' },
        ]);
      }
      if (toHundredths(input.marks)! > toHundredths(row.question.marks)!) {
        throw new ValidationError('Marks are above the maximum for this question', [
          { path: 'marks', message: `Marks may not exceed ${row.question.marks}` },
        ]);
      }

      const regrade = row.answer.marksAwarded !== null;
      if (regrade && !input.reason) {
        // Changing a settled mark is a correction, and a correction carries its reason.
        throw new ValidationError('A reason is required to change a recorded mark', [
          {
            path: 'reason',
            message: 'Give a reason of at least 10 characters — this is recorded in the audit log',
          },
        ]);
      }

      const now = new Date();
      const [answer] = await tx
        .update(quizAnswers)
        .set({
          marksAwarded: input.marks,
          gradedBy,
          gradedAt: now,
          version: row.answer.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(quizAnswers.id, answerId))
        .returning();

      // Recompute the attempt from all its answers — a fact, never a drifting increment.
      const answerRows = await tx
        .select({ marksAwarded: quizAnswers.marksAwarded })
        .from(quizAnswers)
        .where(and(eq(quizAnswers.attemptId, row.attempt.id), isNull(quizAnswers.archivedAt)));
      const allGraded = answerRows.every((item) => item.marksAwarded !== null);
      const score = allGraded
        ? fromHundredths(
            answerRows.reduce((sum, item) => sum + toHundredths(item.marksAwarded)!, 0),
          )
        : null;

      const [attempt] = await tx
        .update(quizAttempts)
        .set({
          isGraded: allGraded,
          score,
          version: row.attempt.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(quizAttempts.id, row.attempt.id))
        .returning();

      const previous = regrade
        ? {
            marksAwarded: row.answer.marksAwarded,
            gradedBy: row.answer.gradedBy,
            gradedAt: row.answer.gradedAt,
          }
        : null;

      // The mark's trail is part of the business transaction: if the grade rolls back, so
      // does its record. The route carries `recordedBy: 'service'`.
      const context = currentContext();
      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'update',
        module: 'lms',
        resourceType: 'quiz_answer',
        resourceId: answerId,
        resourceLabel: row.quiz.title,
        previousValue: previous,
        newValue: {
          marksAwarded: answer!.marksAwarded,
          gradedBy: answer!.gradedBy,
          attemptId: row.attempt.id,
          questionId: row.question.id,
        },
        reason: input.reason ?? null,
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      return { answer: answer!, attempt: attempt!, previous };
    });
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Reports
  // ────────────────────────────────────────────────────────────────────────────────────

  /**
   * The gradebook: every enrolled student × every non-draft quiz of the course, with the
   * best graded score per pair. Aggregation runs in SQL; this method only pivots the flat
   * rows into a grid.
   */
  async gradebook(
    principal: Principal,
    institutionId: string,
    courseId: string,
  ): Promise<{
    courseId: string;
    quizzes: Record<string, unknown>[];
    students: Record<string, unknown>[];
  }> {
    const scope = this.requireScope(principal);
    if (scope === 'own') {
      // The gradebook names every student's scores; that is staff data.
      throw new ForbiddenError('lms.progress.view', 'You cannot view the course gradebook');
    }

    return this.db.runInTenant(async (tx) => {
      await this.loadVisibleCourse(tx, principal, scope, institutionId, courseId);

      const quizRows = await tx
        .select({
          id: quizzes.id,
          title: quizzes.title,
          totalMarks: quizzes.totalMarks,
          passMarks: quizzes.passMarks,
          status: quizzes.status,
        })
        .from(quizzes)
        .where(
          and(
            eq(quizzes.institutionId, institutionId),
            isNull(quizzes.archivedAt),
            ne(quizzes.status, 'draft'),
            this.quizBelongsToCourse(courseId),
          ),
        )
        .orderBy(asc(quizzes.createdAt), asc(quizzes.id));

      const enrolled = await tx
        .select({
          studentId: courseEnrolments.studentId,
          studentName: students.fullNameEn,
          studentCode: students.studentCode,
        })
        .from(courseEnrolments)
        .innerJoin(students, eq(students.id, courseEnrolments.studentId))
        .where(and(eq(courseEnrolments.courseId, courseId), isNull(courseEnrolments.archivedAt)))
        .orderBy(asc(students.fullNameEn), asc(courseEnrolments.id));

      const quizIds = quizRows.map((quiz) => quiz.id);
      let scores: { quizId: string; studentId: string; bestScore: string | null }[] = [];
      if (quizIds.length > 0) {
        scores = await tx
          .select({
            quizId: quizAttempts.quizId,
            studentId: quizAttempts.studentId,
            // The best *graded* score. Numeric max stays in SQL and returns as text — this
            // codebase does not put numeric values through JavaScript floats.
            bestScore: sql<string | null>`max(
              case when ${quizAttempts.isGraded} then ${quizAttempts.score} end
            )::text`,
          })
          .from(quizAttempts)
          .where(and(inArray(quizAttempts.quizId, quizIds), isNull(quizAttempts.archivedAt)))
          .groupBy(quizAttempts.quizId, quizAttempts.studentId);
      }

      const byStudent = new Map<string, Record<string, string | null>>();
      for (const score of scores) {
        const bucket = byStudent.get(score.studentId) ?? {};
        bucket[score.quizId] = score.bestScore;
        byStudent.set(score.studentId, bucket);
      }

      return {
        courseId,
        quizzes: quizRows,
        students: enrolled.map((row) => ({
          studentId: row.studentId,
          studentName: row.studentName,
          studentCode: row.studentCode,
          scores: byStudent.get(row.studentId) ?? {},
        })),
      };
    });
  }

  /** SQL predicate: this quiz hangs off the course, directly or via one of its lessons. */
  private quizBelongsToCourse(courseId: string): SQL {
    return or(
      eq(quizzes.courseId, courseId),
      exists(
        this.db.raw
          .select({ one: sql`1` })
          .from(lessons)
          .where(
            and(
              eq(lessons.id, quizzes.lessonId),
              exists(
                this.db.raw
                  .select({ one: sql`1` })
                  .from(courseModules)
                  .where(
                    and(
                      eq(courseModules.id, lessons.moduleId),
                      eq(courseModules.courseId, courseId),
                    ),
                  ),
              ),
            ),
          ),
      ),
    )!;
  }

  /**
   * Completion rate for one course, computed in SQL: per published lesson, how many of the
   * enrolled students have completed it; plus the whole-course rate — students who have
   * completed every published lesson over students enrolled.
   */
  async completionReport(
    principal: Principal,
    institutionId: string,
    courseId: string,
  ): Promise<{
    courseId: string;
    enrolled: number;
    publishedLessons: number;
    studentsCompletedAll: number;
    completionPercent: string;
    lessons: Record<string, unknown>[];
  }> {
    const scope = this.requireScope(principal);
    if (scope === 'own') {
      // The completion table names every student's compliance; that is staff data.
      throw new ForbiddenError('lms.progress.view', 'You cannot view course completion reports');
    }

    return this.db.runInTenant(async (tx) => {
      await this.loadVisibleCourse(tx, principal, scope, institutionId, courseId);

      const enrolledExpr = sql<number>`(
        select count(*)::int from ${courseEnrolments}
        where ${courseEnrolments.courseId} = ${courseId}
          and ${courseEnrolments.archivedAt} is null
      )`;
      const completedExpr = sql<number>`count(distinct case
        when ${lessonProgress.studentId} is not null then ${lessonProgress.studentId} end)::int`;

      const lessonRows = await tx
        .select({
          lessonId: lessons.id,
          title: lessons.title,
          moduleTitle: courseModules.title,
          moduleSequence: courseModules.sequence,
          sequence: lessons.sequence,
          completed: completedExpr,
          // Percent as text: it comes off a numeric round(), and this codebase does not put
          // numeric values through JavaScript floats.
          completionPercent: sql<string>`coalesce(
            round(100.0 * ${completedExpr} / nullif(${enrolledExpr}, 0), 2), 0
          )::text`,
        })
        .from(lessons)
        .innerJoin(courseModules, eq(courseModules.id, lessons.moduleId))
        .leftJoin(
          lessonProgress,
          and(
            eq(lessonProgress.lessonId, lessons.id),
            eq(lessonProgress.status, 'completed'),
            isNull(lessonProgress.archivedAt),
            // Only enrolled students count towards the cohort's completion.
            exists(
              this.db.raw
                .select({ one: sql`1` })
                .from(courseEnrolments)
                .where(
                  and(
                    eq(courseEnrolments.courseId, courseId),
                    eq(courseEnrolments.studentId, lessonProgress.studentId),
                    isNull(courseEnrolments.archivedAt),
                  ),
                ),
            ),
          ),
        )
        .where(
          and(
            eq(courseModules.courseId, courseId),
            eq(courseModules.isPublished, true),
            eq(lessons.isPublished, true),
            isNull(courseModules.archivedAt),
            isNull(lessons.archivedAt),
          ),
        )
        .groupBy(lessons.id, courseModules.id)
        .orderBy(asc(courseModules.sequence), asc(lessons.sequence), asc(lessons.id));

      const [enrolledRow] = await tx
        .select({ enrolled: sql<number>`count(*)::int` })
        .from(courseEnrolments)
        .where(and(eq(courseEnrolments.courseId, courseId), isNull(courseEnrolments.archivedAt)));
      const enrolled = enrolledRow?.enrolled ?? 0;
      const publishedLessons = lessonRows.length;

      // Students who have completed every published lesson, and the whole-course percent —
      // both computed in SQL, the percent as numeric text so no float is ever involved.
      let studentsCompletedAll = 0;
      let completionPercent = '0.00';
      if (publishedLessons > 0 && enrolled > 0) {
        const result = await tx.execute(sql`
          with done as (
            select count(*)::int as total
            from course_enrolments ce
            where ce.course_id = ${courseId}::uuid
              and ce.archived_at is null
              and not exists (
                select 1
                from lessons l
                join course_modules m on m.id = l.module_id
                where m.course_id = ${courseId}::uuid
                  and m.is_published and m.archived_at is null
                  and l.is_published and l.archived_at is null
                  and not exists (
                    select 1 from lesson_progress lp
                    where lp.lesson_id = l.id
                      and lp.student_id = ce.student_id
                      and lp.status = 'completed'
                      and lp.archived_at is null
                  )
              )
          )
          select total,
                 coalesce(round(100.0 * total / nullif(${enrolled}::int, 0), 2), 0)::text as percent
          from done
        `);
        const rows =
          (result as unknown as { rows: Array<{ total: number; percent: string }> }).rows ?? [];
        studentsCompletedAll = rows[0]?.total ?? 0;
        completionPercent = rows[0]?.percent ?? '0.00';
      }

      return {
        courseId,
        enrolled,
        publishedLessons,
        studentsCompletedAll,
        completionPercent,
        lessons: lessonRows,
      };
    });
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Uploads
  // ────────────────────────────────────────────────────────────────────────────────────

  private checkUpload(file: UploadedFileLike): string {
    if (!file || !file.buffer || file.size === 0) {
      throw new ValidationError('No file was uploaded', [
        { path: 'file', message: 'Attach the file as the "file" field' },
      ]);
    }
    if (file.size > MAX_RESOURCE_BYTES) {
      throw new ValidationError('The file is too large', [
        { path: 'file', message: 'Resources may be at most 10 MB' },
      ]);
    }
    const mimeType = sniffMimeType(file.buffer) ?? file.mimetype;
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      throw new ValidationError('This file type is not accepted', [
        { path: 'file', message: 'Upload a JPEG, PNG, WebP or PDF file' },
      ]);
    }
    return mimeType;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Exact decimal helpers (the exams module's discipline)
//
// `numeric` columns arrive as strings and leave as strings. Nothing in this module converts
// one to a JavaScript float for arithmetic: `Number('33.33') * 100` is 3332.9999999999995,
// and rounding that is a coin flip on the boundary. Splitting on the decimal point is exact
// for every value the validation schemas admit.
// ─────────────────────────────────────────────────────────────────────────────────────

function toHundredths(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const magnitude = Number(whole) * 100 + Number(fraction.padEnd(2, '0').slice(0, 2));
  return negative ? -magnitude : magnitude;
}

/** Integer hundredths back to the canonical `numeric(6,2)` string, e.g. 650 → "6.50". */
function fromHundredths(total: number): string {
  const whole = Math.floor(total / 100);
  const fraction = String(total % 100).padStart(2, '0');
  return `${whole}.${fraction}`;
}

/** Fisher–Yates on a copy; used when a quiz shuffles its question order per attempt. */
function shuffle<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/**
 * Determine the MIME type from the first bytes. Covers exactly the allow-listed types; an
 * unrecognised signature returns null and the client's claim is then tested against the
 * same allow-list, so nothing outside it is ever stored. Kept local (rather than imported
 * from another module) so this module has no dependency on another module's file.
 */
function sniffMimeType(buffer: Buffer): string | null {
  if (buffer.length >= 4) {
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      return 'image/png';
    }
    if (buffer.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}
