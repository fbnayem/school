/**
 * Homework service (Phase 9).
 *
 * The rules this file exists to keep, in the order a school would state them:
 *
 *  1. **A teacher sets work only for a section+subject they are assigned to.** The check is
 *     the same one `StudentsService.scopeFilter` and the attendance register use — class
 *     teacher of the section, or teacher of a subject in it — anchored here on the
 *     assignment's own section, mirrored rather than imported so there is no module cycle
 *     (the exams module documents the same choice). A section outside that set is a 404,
 *     never a 403: a teacher probing ids must not learn which of them exist.
 *  2. **Drafts are invisible outside the owning teacher and `all`-scope staff.** A student
 *     or guardian sees only published (and closed) assignments for sections the student is
 *     actually enrolled in, and that is a SQL predicate applied to the list, the single
 *     fetch, the report and the attachment paths alike — never a client-side filter.
 *  3. **Lateness is the server clock's opinion.** `is_late` is derived from `now()` against
 *     the assignment's `due_at` at the moment the submission row is written. A late
 *     submission against `allow_late = false` is refused with 422.
 *  4. **Marks are exact.** `numeric(6,2)` arrives from the driver as a string and is
 *     compared in integer hundredths (the exams module's discipline); nothing in this file
 *     converts a marks column to a JavaScript float. Marks above `max_marks` are refused.
 *  5. **A settled grade changes only with a reason.** Re-grading after `is_final` demotes
 *     the old row, inserts a new one, and writes the before/after audit record **inside the
 *     business transaction** so the trail rolls back with the change.
 *  6. **Nothing is hard-deleted.** Withdrawing an assignment is a status change plus the
 *     archive marker; attempts and superseded grades stay put.
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
  assignmentAttachments,
  assignments,
  assignmentSubmissions,
  employeeSectionAssignments,
  employeeSubjectAssignments,
  enrollments,
  files,
  sections,
  students,
  studentGuardians,
  subjects,
  submissionAttachments,
  submissionGrades,
} from '@shikkha/db';
import {
  calendarDate,
  buildOffsetPage,
  compareCalendarDates,
  ConflictError,
  ForbiddenError,
  ImmutableRecordError,
  instantToDhakaDate,
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
  HOMEWORK_ASSIGNMENT_SORT_FIELDS,
  HOMEWORK_SUBMISSION_SORT_FIELDS,
  type BulkGradeInput,
  type CreateAssignmentInput,
  type GradeSubmissionInput,
  type ListAssignmentsQuery,
  type ListHomeworkSubmissionsQuery,
  type StudentSubmissionHistoryQuery,
  type SubmitHomeworkInput,
  type UpdateAssignmentInput,
} from '@shikkha/validation';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';
import { currentContext } from '../../common/context/request-context';

/** The transaction handle services pass around; identical to `runInTenant`'s callback arg. */
export type Tx = Parameters<Parameters<DatabaseService['runInTenant']>[0]>[0];

export type AssignmentRow = typeof assignments.$inferSelect;
export type AssignmentAttachmentRow = typeof assignmentAttachments.$inferSelect;
export type SubmissionRow = typeof assignmentSubmissions.$inferSelect;
export type SubmissionAttachmentRow = typeof submissionAttachments.$inferSelect;
export type SubmissionGradeRow = typeof submissionGrades.$inferSelect;

/** The slice of a multipart upload this service needs; matches Multer's file object. */
export interface UploadedFileLike {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

const DOWNLOAD_TTL_SECONDS = 300;

@Injectable()
export class HomeworkService {
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
   * Homework has no scoped-view permission triple of its own yet (`homework.view` is a
   * single permission every audience holds), so the scope rides on the student triple:
   * who may see all students may see all homework, who may see assigned students sees
   * their sections' homework, and a student or guardian sees their own. This is the same
   * visibility question — homework about a section is data about its students — and it
   * keeps one rule rather than two. When `homework.view.{all,assigned,own}` are added to
   * the catalogue, only this method changes.
   */
  requireScope(principal: Principal): DataScope {
    const context = currentContext();
    const scope = resolveDataScope(principal, SCOPED_RESOURCES.students, {
      institutionId: context?.institutionId ?? null,
      campusId: context?.campusId ?? null,
    });
    if (scope === 'none') {
      throw new ForbiddenError('homework.view', 'You cannot view homework records');
    }
    return scope;
  }

  /**
   * The same rule `StudentsService` uses for `assigned`, anchored on the assignment's
   * section: an employee is assigned to a section when they are its class teacher or teach
   * a subject in it.
   */
  private sectionAssignmentFilter(employeeId: string): SQL {
    return or(
      exists(
        this.db.raw
          .select({ one: sql`1` })
          .from(employeeSectionAssignments)
          .where(
            and(
              eq(employeeSectionAssignments.sectionId, assignments.sectionId),
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
              eq(employeeSubjectAssignments.sectionId, assignments.sectionId),
              eq(employeeSubjectAssignments.employeeId, employeeId),
              isNull(employeeSubjectAssignments.archivedAt),
            ),
          ),
      ),
    )!;
  }

  /**
   * Assignments this principal may see, as a SQL predicate.
   *
   * `all` returns a tautology rather than `undefined`, so callers can always `and(...)` the
   * result without a conditional — and so it is impossible to accidentally build a query
   * that omits the scope filter entirely.
   */
  private assignmentScopeFilter(principal: Principal, scope: DataScope): SQL {
    if (scope === 'all') return sql`true`;

    if (scope === 'assigned') {
      if (!principal.employeeId) {
        // A user with the "assigned" permission but no employee record can be assigned
        // nothing, so they see nothing. Failing closed is the only safe reading.
        return sql`false`;
      }
      const employeeId = principal.employeeId;
      // A teacher sees their own work in every state, and other teachers' work in their
      // sections only once it leaves draft — a draft is the owning teacher's desk drawer.
      return or(
        eq(assignments.createdByEmployeeId, employeeId),
        and(this.sectionAssignmentFilter(employeeId), ne(assignments.status, 'draft')),
      )!;
    }

    // `own`: a student sees assignments for sections they are enrolled in; a guardian sees
    // their linked children's. Only published (and closed) work exists for them at all.
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
      inArray(assignments.status, ['published', 'closed']),
      exists(
        this.db.raw
          .select({ one: sql`1` })
          .from(enrollments)
          .where(
            and(
              eq(enrollments.sectionId, assignments.sectionId),
              eq(enrollments.status, 'active'),
              isNull(enrollments.archivedAt),
              studentMatch.length === 1 ? studentMatch[0]! : or(...studentMatch)!,
            ),
          ),
      ),
    )!;
  }

  /**
   * Load one assignment inside the caller's transaction with the scope filter applied.
   * An assignment outside the caller's scope — the wrong tenant, the wrong institution, a
   * section they are not assigned to, someone else's draft — is a `NotFoundError`, never a
   * 403: confirming the record exists is itself a leak.
   */
  private async loadVisible(
    tx: Tx,
    principal: Principal,
    scope: DataScope,
    institutionId: string,
    id: string,
  ): Promise<AssignmentRow> {
    const [row] = await tx
      .select()
      .from(assignments)
      .where(
        and(
          eq(assignments.id, id),
          eq(assignments.institutionId, institutionId),
          isNull(assignments.archivedAt),
          this.assignmentScopeFilter(principal, scope),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError('Assignment', id);
    return row;
  }

  /**
   * May this principal *change* the assignment (edit, publish, close, attach, grade)?
   *
   * `all` scope may; otherwise the caller must be the creator, the section's class teacher,
   * or the teacher of this assignment's subject in this section. Failure is a 404 for the
   * same reason as everywhere else.
   */
  private async assertCanManage(
    tx: Tx,
    principal: Principal,
    scope: DataScope,
    assignment: AssignmentRow,
  ): Promise<void> {
    if (scope === 'all') return;
    if (scope !== 'assigned' || !principal.employeeId) {
      throw new NotFoundError('Assignment', assignment.id);
    }
    if (assignment.createdByEmployeeId === principal.employeeId) return;
    const allowed = await this.isAssignedToSectionSubject(
      tx,
      principal.employeeId,
      assignment.sectionId,
      assignment.subjectId,
    );
    if (!allowed) throw new NotFoundError('Assignment', assignment.id);
  }

  /**
   * The creation rule, stated once: the section's class teacher may set work in any subject
   * of their section; a subject teacher may set work only for the (section, subject) pair
   * they actually teach.
   */
  private async isAssignedToSectionSubject(
    tx: Tx,
    employeeId: string,
    sectionId: string,
    subjectId: string,
  ): Promise<boolean> {
    const [sectionRow] = await tx
      .select({ one: sql<number>`1` })
      .from(employeeSectionAssignments)
      .where(
        and(
          eq(employeeSectionAssignments.sectionId, sectionId),
          eq(employeeSectionAssignments.employeeId, employeeId),
          isNull(employeeSectionAssignments.archivedAt),
        ),
      )
      .limit(1);
    if (sectionRow) return true;

    const [subjectRow] = await tx
      .select({ one: sql<number>`1` })
      .from(employeeSubjectAssignments)
      .where(
        and(
          eq(employeeSubjectAssignments.sectionId, sectionId),
          eq(employeeSubjectAssignments.subjectId, subjectId),
          eq(employeeSubjectAssignments.employeeId, employeeId),
          isNull(employeeSubjectAssignments.archivedAt),
        ),
      )
      .limit(1);
    return Boolean(subjectRow);
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Assignments
  // ────────────────────────────────────────────────────────────────────────────────────

  async list(
    principal: Principal,
    institutionId: string,
    query: ListAssignmentsQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<AssignmentRow>> {
    const scope = this.requireScope(principal);

    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [
        eq(assignments.institutionId, institutionId),
        this.assignmentScopeFilter(principal, scope),
      ];
      if (!query.includeArchived) filters.push(isNull(assignments.archivedAt));
      if (query.sectionId) filters.push(eq(assignments.sectionId, query.sectionId));
      if (query.subjectId) filters.push(eq(assignments.subjectId, query.subjectId));
      if (query.academicYearId) {
        filters.push(eq(assignments.academicYearId, query.academicYearId));
      }
      if (query.type) filters.push(eq(assignments.type, query.type));
      if (query.status) filters.push(eq(assignments.status, query.status));
      if (query.q) filters.push(ilike(assignments.title, `%${query.q}%`));

      const where = and(...filters);
      const orderBy = parseSort(query.sort, HOMEWORK_ASSIGNMENT_SORT_FIELDS, {
        field: 'dueAt',
        direction: 'desc',
      }).map((spec) => {
        const column = {
          title: assignments.title,
          type: assignments.type,
          status: assignments.status,
          assignedOn: assignments.assignedOn,
          dueAt: assignments.dueAt,
          createdAt: assignments.createdAt,
        }[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(assignments)
        .where(where)
        .orderBy(...orderBy, asc(assignments.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(assignments)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async findOne(
    principal: Principal,
    institutionId: string,
    id: string,
  ): Promise<AssignmentRow & { attachments: AssignmentAttachmentRow[] }> {
    const scope = this.requireScope(principal);

    return this.db.runInTenant(async (tx) => {
      const assignment = await this.loadVisible(tx, principal, scope, institutionId, id);
      const attachments = await tx
        .select()
        .from(assignmentAttachments)
        .where(
          and(eq(assignmentAttachments.assignmentId, id), isNull(assignmentAttachments.archivedAt)),
        )
        .orderBy(asc(assignmentAttachments.createdAt));
      return { ...assignment, attachments };
    });
  }

  async create(
    principal: Principal,
    institutionId: string,
    input: CreateAssignmentInput,
  ): Promise<AssignmentRow> {
    const scope = this.requireScope(principal);
    if (scope === 'own') {
      throw new ForbiddenError('homework.create', 'Only teaching staff can create assignments');
    }

    const dueAt = new Date(input.dueAt);
    if (compareCalendarDates(instantToDhakaDate(dueAt), calendarDate(input.assignedOn)) < 0) {
      throw new ValidationError('The deadline is before the day the work is assigned', [
        { path: 'dueAt', message: 'Choose a deadline on or after the assigned date' },
      ]);
    }

    return this.db.runInTenant(async (tx) => {
      const [section] = await tx
        .select({
          id: sections.id,
          campusId: sections.campusId,
          academicYearId: sections.academicYearId,
        })
        .from(sections)
        .where(
          and(
            eq(sections.id, input.sectionId),
            eq(sections.institutionId, institutionId),
            isNull(sections.archivedAt),
          ),
        )
        .limit(1);
      if (!section) throw new NotFoundError('Section', input.sectionId);

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
          throw new NotFoundError('Section', input.sectionId);
        }
        const allowed = await this.isAssignedToSectionSubject(
          tx,
          principal.employeeId,
          input.sectionId,
          input.subjectId,
        );
        if (!allowed) {
          // 404, not 403: a teacher probing section ids must not learn which of them exist.
          throw new NotFoundError('Section', input.sectionId);
        }
      }

      const [created] = await tx
        .insert(assignments)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          campusId: section.campusId,
          academicYearId: section.academicYearId,
          sectionId: input.sectionId,
          subjectId: input.subjectId,
          createdByEmployeeId: principal.employeeId ?? null,
          title: input.title,
          titleBn: input.titleBn ?? null,
          instructions: input.instructions ?? null,
          type: input.type,
          assignedOn: input.assignedOn,
          dueAt,
          maxMarks: input.maxMarks ?? null,
          isGraded: input.isGraded,
          allowLate: input.allowLate,
          latePenaltyPercent: input.latePenaltyPercent ?? '0.00',
          status: 'draft',
          createdBy: principal.userId,
        })
        .returning();

      return created!;
    });
  }

  async update(
    principal: Principal,
    institutionId: string,
    id: string,
    input: UpdateAssignmentInput,
  ): Promise<{ assignment: AssignmentRow; previous: Record<string, unknown> }> {
    const scope = this.requireScope(principal);
    const { version, ...changes } = input;

    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadVisible(tx, principal, scope, institutionId, id);
      await this.assertCanManage(tx, principal, scope, existing);

      if (existing.status === 'closed' || existing.status === 'archived') {
        throw new ImmutableRecordError('Assignment', `it is ${existing.status}`);
      }

      const values: Partial<AssignmentRow> = {};
      if (changes.title !== undefined) values.title = changes.title;
      if (changes.titleBn !== undefined) values.titleBn = changes.titleBn;
      if (changes.instructions !== undefined) values.instructions = changes.instructions;
      if (changes.type !== undefined) values.type = changes.type;
      if (changes.assignedOn !== undefined) values.assignedOn = changes.assignedOn;
      if (changes.dueAt !== undefined) values.dueAt = new Date(changes.dueAt);
      if (changes.maxMarks !== undefined) values.maxMarks = changes.maxMarks;
      if (changes.isGraded !== undefined) values.isGraded = changes.isGraded;
      if (changes.allowLate !== undefined) values.allowLate = changes.allowLate;
      if (changes.latePenaltyPercent !== undefined) {
        values.latePenaltyPercent = changes.latePenaltyPercent ?? '0.00';
      }

      // The resulting row must still make sense as a whole, not just field by field.
      const nextIsGraded = values.isGraded ?? existing.isGraded;
      const nextMaxMarks = 'maxMarks' in values ? values.maxMarks : existing.maxMarks;
      if (nextIsGraded && nextMaxMarks == null) {
        throw new ValidationError('A graded assignment needs its maximum marks', [
          { path: 'maxMarks', message: 'Provide maxMarks or set isGraded to false' },
        ]);
      }
      const nextDueAt = values.dueAt ?? existing.dueAt;
      const nextAssignedOn = values.assignedOn ?? existing.assignedOn;
      if (compareCalendarDates(instantToDhakaDate(nextDueAt), calendarDate(nextAssignedOn)) < 0) {
        throw new ValidationError('The deadline is before the day the work is assigned', [
          { path: 'dueAt', message: 'Choose a deadline on or after the assigned date' },
        ]);
      }

      const [updated] = await tx
        .update(assignments)
        .set({
          ...values,
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(assignments.id, id), eq(assignments.version, version)))
        .returning();

      if (!updated) {
        // The row exists but the version did not match, so someone else saved first.
        throw new ConflictError(
          'This assignment was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      const previous: Record<string, unknown> = {};
      for (const key of Object.keys(values) as (keyof AssignmentRow)[]) {
        previous[key] = existing[key];
      }
      return { assignment: updated, previous };
    });
  }

  async publish(
    principal: Principal,
    institutionId: string,
    id: string,
    version: number,
  ): Promise<AssignmentRow> {
    return this.transition(principal, institutionId, id, version, 'draft', (now) => ({
      status: 'published',
      publishedAt: now,
    }));
  }

  async close(
    principal: Principal,
    institutionId: string,
    id: string,
    version: number,
  ): Promise<AssignmentRow> {
    return this.transition(principal, institutionId, id, version, 'published', (now) => ({
      status: 'closed',
      closedAt: now,
    }));
  }

  private async transition(
    principal: Principal,
    institutionId: string,
    id: string,
    version: number,
    fromStatus: 'draft' | 'published',
    changes: (now: Date) => Partial<AssignmentRow>,
  ): Promise<AssignmentRow> {
    const scope = this.requireScope(principal);
    if (scope === 'own') {
      throw new ForbiddenError('homework.update', 'Only teaching staff can manage assignments');
    }

    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadVisible(tx, principal, scope, institutionId, id);
      await this.assertCanManage(tx, principal, scope, existing);

      const applied = changes(new Date());
      if (existing.status !== fromStatus) {
        throw new WorkflowStateError(existing.status, applied.status as string, 'assignment');
      }

      const [updated] = await tx
        .update(assignments)
        .set({ ...applied, version: existing.version + 1, updatedBy: principal.userId })
        .where(and(eq(assignments.id, id), eq(assignments.version, version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This assignment was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }
      return updated;
    });
  }

  /** Withdrawing an assignment: a status change plus the archive marker. Never a DELETE. */
  async archive(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
    version: number,
  ): Promise<AssignmentRow> {
    const scope = this.requireScope(principal);
    if (scope === 'own') {
      throw new ForbiddenError('homework.delete', 'Only teaching staff can withdraw assignments');
    }

    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadVisible(tx, principal, scope, institutionId, id);
      await this.assertCanManage(tx, principal, scope, existing);

      const [updated] = await tx
        .update(assignments)
        .set({
          status: 'archived',
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason.slice(0, 500),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(assignments.id, id), eq(assignments.version, version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This assignment was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }
      return updated;
    });
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Assignment attachments
  // ────────────────────────────────────────────────────────────────────────────────────

  async addAssignmentAttachment(
    principal: Principal,
    institutionId: string,
    assignmentId: string,
    file: UploadedFileLike,
  ): Promise<AssignmentAttachmentRow> {
    const scope = this.requireScope(principal);
    if (scope === 'own') {
      throw new ForbiddenError('homework.update', 'Only teaching staff can attach files');
    }
    const mimeType = this.checkUpload(file);

    // The bytes are written before the transaction: if the transaction fails, the orphaned
    // object is invisible (no `files` row) and swept by the incomplete-upload cleanup job.
    const tenantId = principal.tenantId!;
    const stored = await this.storage.put({
      tenantId,
      category: 'assignment',
      filename: file.originalname,
      contentType: mimeType,
      body: file.buffer,
    });

    return this.db.runInTenant(async (tx) => {
      const assignment = await this.loadVisible(tx, principal, scope, institutionId, assignmentId);
      await this.assertCanManage(tx, principal, scope, assignment);

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
          category: 'assignment',
          ownerType: 'assignment',
          ownerId: assignmentId,
          uploadedAt: new Date(),
          createdBy: principal.userId,
        })
        .returning();

      const [attachment] = await tx
        .insert(assignmentAttachments)
        .values({
          id: uuidv7(),
          tenantId,
          institutionId,
          assignmentId,
          fileId: fileRow!.id,
          storageKey: stored.key,
          filename: file.originalname.slice(0, 255),
          mimeType,
          sizeBytes: stored.sizeBytes,
          createdBy: principal.userId,
        })
        .returning();

      return attachment!;
    });
  }

  /**
   * Issue a signed, expiring download URL for an assignment attachment. The permission and
   * scope checks happen at issuance; the URL is then bearer-valid for five minutes, exactly
   * like an S3 pre-signed URL — never a static path.
   */
  async assignmentAttachmentDownloadUrl(
    principal: Principal,
    institutionId: string,
    assignmentId: string,
    attachmentId: string,
  ): Promise<{ attachmentId: string; url: string; expiresInSeconds: number }> {
    const scope = this.requireScope(principal);

    return this.db.runInTenant(async (tx) => {
      // Visibility carries the whole rule: a student can only reach attachments of
      // published assignments for their own section, a teacher those of their sections.
      await this.loadVisible(tx, principal, scope, institutionId, assignmentId);

      const [attachment] = await tx
        .select()
        .from(assignmentAttachments)
        .where(
          and(
            eq(assignmentAttachments.id, attachmentId),
            eq(assignmentAttachments.assignmentId, assignmentId),
            isNull(assignmentAttachments.archivedAt),
          ),
        )
        .limit(1);
      if (!attachment) throw new NotFoundError('Attachment', attachmentId);

      return {
        attachmentId,
        url: this.storage.signUrl(attachment.storageKey, DOWNLOAD_TTL_SECONDS),
        expiresInSeconds: DOWNLOAD_TTL_SECONDS,
      };
    });
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Submissions
  // ────────────────────────────────────────────────────────────────────────────────────

  async submit(
    principal: Principal,
    institutionId: string,
    assignmentId: string,
    input: SubmitHomeworkInput,
  ): Promise<SubmissionRow> {
    return this.writeSubmission(principal, institutionId, assignmentId, input, {
      resubmission: false,
    });
  }

  async resubmit(
    principal: Principal,
    institutionId: string,
    assignmentId: string,
    input: SubmitHomeworkInput,
  ): Promise<SubmissionRow> {
    return this.writeSubmission(principal, institutionId, assignmentId, input, {
      resubmission: true,
    });
  }

  private async writeSubmission(
    principal: Principal,
    institutionId: string,
    assignmentId: string,
    input: SubmitHomeworkInput,
    options: { resubmission: boolean },
  ): Promise<SubmissionRow> {
    const studentId = principal.studentId;
    if (!studentId) {
      throw new ForbiddenError('homework.submit', 'Only students can submit homework');
    }

    return this.db.runInTenant(async (tx) => {
      const [assignment] = await tx
        .select()
        .from(assignments)
        .where(
          and(
            eq(assignments.id, assignmentId),
            eq(assignments.institutionId, institutionId),
            isNull(assignments.archivedAt),
          ),
        )
        .limit(1);
      if (!assignment) throw new NotFoundError('Assignment', assignmentId);

      // The student must actually be enrolled in the section — otherwise, and for a draft
      // they were never meant to see, the assignment simply does not exist for them.
      const [enrolled] = await tx
        .select({ one: sql<number>`1` })
        .from(enrollments)
        .where(
          and(
            eq(enrollments.sectionId, assignment.sectionId),
            eq(enrollments.studentId, studentId),
            eq(enrollments.status, 'active'),
            isNull(enrollments.archivedAt),
          ),
        )
        .limit(1);
      if (!enrolled || assignment.status === 'draft') {
        throw new NotFoundError('Assignment', assignmentId);
      }
      if (assignment.status !== 'published') {
        throw new ConflictError('This assignment is no longer accepting submissions');
      }

      // The server clock decides lateness — never client input.
      const now = new Date();
      const isLate = now.getTime() > assignment.dueAt.getTime();
      if (isLate && !assignment.allowLate) {
        throw new ValidationError('The deadline for this assignment has passed', [
          { path: 'assignmentId', message: 'Late submissions are not accepted for this work' },
        ]);
      }

      const [latest] = await tx
        .select({
          maxAttempt: sql<number>`coalesce(max(${assignmentSubmissions.attemptNumber}), 0)::int`,
        })
        .from(assignmentSubmissions)
        .where(
          and(
            eq(assignmentSubmissions.assignmentId, assignmentId),
            eq(assignmentSubmissions.studentId, studentId),
            isNull(assignmentSubmissions.archivedAt),
          ),
        );
      const previousAttempts = latest?.maxAttempt ?? 0;

      if (!options.resubmission && previousAttempts > 0) {
        throw new ConflictError(
          'You have already submitted this assignment. Use resubmit to hand in a new attempt.',
        );
      }
      if (options.resubmission && previousAttempts === 0) {
        throw new ConflictError('There is no submission to replace yet. Submit first.');
      }

      const [created] = await tx
        .insert(assignmentSubmissions)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          assignmentId,
          studentId,
          submittedAt: now,
          status: options.resubmission ? 'resubmitted' : isLate ? 'late' : 'submitted',
          textResponse: input.textResponse ?? null,
          isLate,
          attemptNumber: previousAttempts + 1,
          createdBy: principal.userId,
        })
        .returning();

      return created!;
    });
  }

  async addSubmissionAttachment(
    principal: Principal,
    institutionId: string,
    submissionId: string,
    file: UploadedFileLike,
  ): Promise<SubmissionAttachmentRow> {
    const studentId = principal.studentId;
    if (!studentId) {
      throw new ForbiddenError('homework.submit', 'Only students can attach submission files');
    }
    const mimeType = this.checkUpload(file);

    const tenantId = principal.tenantId!;
    const stored = await this.storage.put({
      tenantId,
      category: 'assignment_submission',
      filename: file.originalname,
      contentType: mimeType,
      body: file.buffer,
    });

    return this.db.runInTenant(async (tx) => {
      // Only the owning student, and only while the assignment is still open.
      const [row] = await tx
        .select({ submission: assignmentSubmissions, assignment: assignments })
        .from(assignmentSubmissions)
        .innerJoin(assignments, eq(assignments.id, assignmentSubmissions.assignmentId))
        .where(
          and(
            eq(assignmentSubmissions.id, submissionId),
            eq(assignmentSubmissions.studentId, studentId),
            eq(assignmentSubmissions.institutionId, institutionId),
            isNull(assignmentSubmissions.archivedAt),
          ),
        )
        .limit(1);
      if (!row) throw new NotFoundError('Submission', submissionId);
      if (row.assignment.status !== 'published') {
        throw new ConflictError('This assignment is no longer accepting files');
      }

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
          category: 'assignment_submission',
          ownerType: 'assignment_submission',
          ownerId: submissionId,
          uploadedAt: new Date(),
          createdBy: principal.userId,
        })
        .returning();

      const [attachment] = await tx
        .insert(submissionAttachments)
        .values({
          id: uuidv7(),
          tenantId,
          institutionId,
          submissionId,
          fileId: fileRow!.id,
          storageKey: stored.key,
          filename: file.originalname.slice(0, 255),
          mimeType,
          sizeBytes: stored.sizeBytes,
          createdBy: principal.userId,
        })
        .returning();

      return attachment!;
    });
  }

  /**
   * A signed download URL for a submission attachment.
   *
   * The rule, enforced server-side: staff who may manage the assignment may read every
   * submission; a student may read only their **own**; a guardian only their linked
   * children's. Anyone else gets a 404 — another student must not even learn the
   * attachment exists.
   */
  async submissionAttachmentDownloadUrl(
    principal: Principal,
    institutionId: string,
    submissionId: string,
    attachmentId: string,
  ): Promise<{ attachmentId: string; url: string; expiresInSeconds: number }> {
    const scope = this.requireScope(principal);

    return this.db.runInTenant(async (tx) => {
      const [row] = await tx
        .select({ submission: assignmentSubmissions, assignment: assignments })
        .from(assignmentSubmissions)
        .innerJoin(assignments, eq(assignments.id, assignmentSubmissions.assignmentId))
        .where(
          and(
            eq(assignmentSubmissions.id, submissionId),
            eq(assignmentSubmissions.institutionId, institutionId),
            isNull(assignmentSubmissions.archivedAt),
          ),
        )
        .limit(1);
      if (!row) throw new NotFoundError('Submission', submissionId);

      const allowed = await this.maySeeSubmission(
        tx,
        principal,
        scope,
        row.submission,
        row.assignment,
      );
      if (!allowed) throw new NotFoundError('Submission', submissionId);

      const [attachment] = await tx
        .select()
        .from(submissionAttachments)
        .where(
          and(
            eq(submissionAttachments.id, attachmentId),
            eq(submissionAttachments.submissionId, submissionId),
            isNull(submissionAttachments.archivedAt),
          ),
        )
        .limit(1);
      if (!attachment) throw new NotFoundError('Attachment', attachmentId);

      return {
        attachmentId,
        url: this.storage.signUrl(attachment.storageKey, DOWNLOAD_TTL_SECONDS),
        expiresInSeconds: DOWNLOAD_TTL_SECONDS,
      };
    });
  }

  private async maySeeSubmission(
    tx: Tx,
    principal: Principal,
    scope: DataScope,
    submission: SubmissionRow,
    assignment: AssignmentRow,
  ): Promise<boolean> {
    if (scope === 'all') return true;

    if (scope === 'assigned') {
      if (!principal.employeeId) return false;
      if (assignment.createdByEmployeeId === principal.employeeId) return true;
      return this.isAssignedToSectionSubject(
        tx,
        principal.employeeId,
        assignment.sectionId,
        assignment.subjectId,
      );
    }

    // `own`
    if (principal.studentId && submission.studentId === principal.studentId) return true;
    if (principal.guardianId) {
      const [link] = await tx
        .select({ one: sql<number>`1` })
        .from(studentGuardians)
        .where(
          and(
            eq(studentGuardians.studentId, submission.studentId),
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

  async listSubmissions(
    principal: Principal,
    institutionId: string,
    assignmentId: string,
    query: ListHomeworkSubmissionsQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<Record<string, unknown>>> {
    const scope = this.requireScope(principal);

    return this.db.runInTenant(async (tx) => {
      await this.loadVisible(tx, principal, scope, institutionId, assignmentId);

      const filters: SQL[] = [
        eq(assignmentSubmissions.assignmentId, assignmentId),
        isNull(assignmentSubmissions.archivedAt),
      ];
      if (query.status) filters.push(eq(assignmentSubmissions.status, query.status));
      if (query.studentId) filters.push(eq(assignmentSubmissions.studentId, query.studentId));

      // A student or guardian reaching a published assignment's submission list still sees
      // only their own family's rows — the class's work is not theirs to browse.
      if (scope === 'own') {
        const own: SQL[] = [];
        if (principal.studentId) {
          own.push(eq(assignmentSubmissions.studentId, principal.studentId));
        }
        if (principal.guardianId) {
          const guardianId = principal.guardianId;
          own.push(
            exists(
              this.db.raw
                .select({ one: sql`1` })
                .from(studentGuardians)
                .where(
                  and(
                    eq(studentGuardians.studentId, assignmentSubmissions.studentId),
                    eq(studentGuardians.guardianId, guardianId),
                    eq(studentGuardians.canAccessPortal, true),
                    isNull(studentGuardians.archivedAt),
                  ),
                ),
            ),
          );
        }
        filters.push(own.length === 0 ? sql`false` : own.length === 1 ? own[0]! : or(...own)!);
      }

      const where = and(...filters);
      const orderBy = parseSort(query.sort, HOMEWORK_SUBMISSION_SORT_FIELDS, {
        field: 'submittedAt',
        direction: 'desc',
      }).map((spec) => {
        const column = {
          submittedAt: assignmentSubmissions.submittedAt,
          status: assignmentSubmissions.status,
          attemptNumber: assignmentSubmissions.attemptNumber,
        }[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select({
          submission: assignmentSubmissions,
          studentName: students.fullNameEn,
          studentCode: students.studentCode,
          marks: submissionGrades.marks,
          feedback: submissionGrades.feedback,
          gradedAt: submissionGrades.gradedAt,
        })
        .from(assignmentSubmissions)
        .innerJoin(students, eq(students.id, assignmentSubmissions.studentId))
        .leftJoin(
          submissionGrades,
          and(
            eq(submissionGrades.submissionId, assignmentSubmissions.id),
            eq(submissionGrades.isFinal, true),
            isNull(submissionGrades.archivedAt),
          ),
        )
        .where(where)
        .orderBy(...orderBy, asc(assignmentSubmissions.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(assignmentSubmissions)
        .where(where);

      const data = rows.map((row) => ({
        ...row.submission,
        studentName: row.studentName,
        studentCode: row.studentCode,
        marks: row.marks,
        feedback: row.feedback,
        gradedAt: row.gradedAt,
      }));

      return buildOffsetPage(data, counted?.total ?? 0, page);
    });
  }

  /** One student's submission history across assignments, newest first. */
  async studentHistory(
    principal: Principal,
    institutionId: string,
    studentId: string,
    query: StudentSubmissionHistoryQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<Record<string, unknown>>> {
    const scope = this.requireScope(principal);

    return this.db.runInTenant(async (tx) => {
      await this.assertStudentVisible(tx, principal, scope, institutionId, studentId);

      const filters: SQL[] = [
        eq(assignmentSubmissions.studentId, studentId),
        eq(assignmentSubmissions.institutionId, institutionId),
        isNull(assignmentSubmissions.archivedAt),
      ];
      if (query.assignmentId) {
        filters.push(eq(assignmentSubmissions.assignmentId, query.assignmentId));
      }
      if (query.academicYearId) {
        filters.push(eq(assignments.academicYearId, query.academicYearId));
      }

      const where = and(...filters);

      const rows = await tx
        .select({
          submission: assignmentSubmissions,
          assignmentTitle: assignments.title,
          assignmentType: assignments.type,
          dueAt: assignments.dueAt,
          maxMarks: assignments.maxMarks,
          marks: submissionGrades.marks,
          feedback: submissionGrades.feedback,
          gradedAt: submissionGrades.gradedAt,
        })
        .from(assignmentSubmissions)
        .innerJoin(assignments, eq(assignments.id, assignmentSubmissions.assignmentId))
        .leftJoin(
          submissionGrades,
          and(
            eq(submissionGrades.submissionId, assignmentSubmissions.id),
            eq(submissionGrades.isFinal, true),
            isNull(submissionGrades.archivedAt),
          ),
        )
        .where(where)
        .orderBy(desc(assignmentSubmissions.submittedAt), asc(assignmentSubmissions.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(assignmentSubmissions)
        .innerJoin(assignments, eq(assignments.id, assignmentSubmissions.assignmentId))
        .where(where);

      const data = rows.map((row) => ({
        ...row.submission,
        assignmentTitle: row.assignmentTitle,
        assignmentType: row.assignmentType,
        dueAt: row.dueAt,
        maxMarks: row.maxMarks,
        marks: row.marks,
        feedback: row.feedback,
        gradedAt: row.gradedAt,
      }));

      return buildOffsetPage(data, counted?.total ?? 0, page);
    });
  }

  /**
   * Is this student one the caller may read? The same rule `StudentsService.scopeFilter`
   * applies, anchored on the student — mirrored rather than imported to avoid a module
   * cycle, exactly as the attendance and exams modules do.
   */
  private async assertStudentVisible(
    tx: Tx,
    principal: Principal,
    scope: DataScope,
    institutionId: string,
    studentId: string,
  ): Promise<void> {
    const conditions: SQL[] = [
      eq(students.id, studentId),
      eq(students.institutionId, institutionId),
      isNull(students.archivedAt),
    ];

    if (scope === 'assigned') {
      if (!principal.employeeId) throw new NotFoundError('Student', studentId);
      const employeeId = principal.employeeId;
      conditions.push(
        exists(
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
        ),
      );
    } else if (scope === 'own') {
      const own: SQL[] = [];
      if (principal.studentId) own.push(eq(students.id, principal.studentId));
      if (principal.guardianId) {
        const guardianId = principal.guardianId;
        own.push(
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
      if (own.length === 0) throw new NotFoundError('Student', studentId);
      conditions.push(own.length === 1 ? own[0]! : or(...own)!);
    }

    const [found] = await tx
      .select({ one: sql<number>`1` })
      .from(students)
      .where(and(...conditions))
      .limit(1);
    if (!found) throw new NotFoundError('Student', studentId);
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Grading
  // ────────────────────────────────────────────────────────────────────────────────────

  async grade(
    principal: Principal,
    institutionId: string,
    submissionId: string,
    input: GradeSubmissionInput,
  ): Promise<{
    grade: SubmissionGradeRow;
    previous: Record<string, unknown> | null;
  }> {
    const scope = this.requireScope(principal);
    const gradedBy = this.requireGrader(principal, scope);

    return this.db.runInTenant(async (tx) => {
      const [row] = await tx
        .select({ submission: assignmentSubmissions, assignment: assignments })
        .from(assignmentSubmissions)
        .innerJoin(assignments, eq(assignments.id, assignmentSubmissions.assignmentId))
        .where(
          and(
            eq(assignmentSubmissions.id, submissionId),
            eq(assignmentSubmissions.institutionId, institutionId),
            isNull(assignmentSubmissions.archivedAt),
          ),
        )
        .limit(1);
      if (!row) throw new NotFoundError('Submission', submissionId);

      await this.assertCanManage(tx, principal, scope, row.assignment);
      this.assertMarksWithinBounds(row.assignment, input.marks);

      const [existingFinal] = await tx
        .select()
        .from(submissionGrades)
        .where(
          and(
            eq(submissionGrades.submissionId, submissionId),
            eq(submissionGrades.isFinal, true),
            isNull(submissionGrades.archivedAt),
          ),
        )
        .limit(1);

      let previous: Record<string, unknown> | null = null;

      if (existingFinal) {
        // Changing a settled mark is a correction, and a correction carries its reason.
        if (!input.reason) {
          throw new ValidationError('A reason is required to change a final grade', [
            {
              path: 'reason',
              message:
                'Give a reason of at least 10 characters — this is recorded in the audit log',
            },
          ]);
        }

        await tx
          .update(submissionGrades)
          .set({
            isFinal: false,
            version: existingFinal.version + 1,
            updatedBy: principal.userId,
          })
          .where(eq(submissionGrades.id, existingFinal.id));

        previous = {
          gradeId: existingFinal.id,
          marks: existingFinal.marks,
          feedback: existingFinal.feedback,
          gradedBy: existingFinal.gradedBy,
          gradedAt: existingFinal.gradedAt,
        };
      }

      const [grade] = await tx
        .insert(submissionGrades)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          submissionId,
          marks: input.marks,
          feedback: input.feedback ?? null,
          gradedBy,
          gradedAt: new Date(),
          isFinal: input.isFinal,
          createdBy: principal.userId,
        })
        .returning();

      await tx
        .update(assignmentSubmissions)
        .set({
          status: 'graded',
          version: row.submission.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(assignmentSubmissions.id, submissionId));

      if (existingFinal) {
        // The correction's trail is part of the business transaction: if the re-grade rolls
        // back, so does its record. The route-level @Audited interceptor also records the
        // HTTP action, but that record is written after the response.
        const context = currentContext();
        await this.audit.recordInTransaction(tx, {
          tenantId: principal.tenantId,
          institutionId,
          actorUserId: principal.userId,
          actorRoles: principal.roles.map((role) => role.roleKey),
          action: 'update',
          module: 'homework',
          resourceType: 'submission_grade',
          resourceId: grade!.id,
          resourceLabel: row.assignment.title,
          previousValue: previous,
          newValue: {
            gradeId: grade!.id,
            marks: grade!.marks,
            feedback: grade!.feedback,
            gradedBy: grade!.gradedBy,
            isFinal: grade!.isFinal,
          },
          reason: input.reason ?? null,
          requestId: context?.requestId ?? null,
          ipAddress: context?.ipAddress ?? null,
          userAgent: context?.userAgent ?? null,
        });
      }

      return { grade: grade!, previous };
    });
  }

  /**
   * Grade many submissions of one assignment in one transaction.
   *
   * Deliberately refuses any submission that already has a final grade: overwriting a
   * settled mark requires the single-grade endpoint, where the mandatory reason and the
   * before/after audit record live.
   */
  async bulkGrade(
    principal: Principal,
    institutionId: string,
    assignmentId: string,
    input: BulkGradeInput,
  ): Promise<{ graded: number }> {
    const scope = this.requireScope(principal);
    const gradedBy = this.requireGrader(principal, scope);

    return this.db.runInTenant(async (tx) => {
      const assignment = await this.loadVisible(tx, principal, scope, institutionId, assignmentId);
      await this.assertCanManage(tx, principal, scope, assignment);

      const ids = input.items.map((item) => item.submissionId);
      const uniqueIds = new Set(ids);
      if (uniqueIds.size !== ids.length) {
        throw new ValidationError('The same submission appears more than once', [
          { path: 'items', message: 'Each submission may be graded once per request' },
        ]);
      }

      const rows = await tx
        .select()
        .from(assignmentSubmissions)
        .where(
          and(
            inArray(assignmentSubmissions.id, ids),
            eq(assignmentSubmissions.assignmentId, assignmentId),
            isNull(assignmentSubmissions.archivedAt),
          ),
        );
      if (rows.length !== uniqueIds.size) {
        const found = new Set(rows.map((row) => row.id));
        const missing = ids.filter((id) => !found.has(id));
        throw new NotFoundError('Submission', missing[0]);
      }

      const alreadyFinal = await tx
        .select({ submissionId: submissionGrades.submissionId })
        .from(submissionGrades)
        .where(
          and(
            inArray(submissionGrades.submissionId, ids),
            eq(submissionGrades.isFinal, true),
            isNull(submissionGrades.archivedAt),
          ),
        );
      if (alreadyFinal.length > 0) {
        throw new ConflictError(
          'One or more submissions already carry a final grade. Re-grade them individually, with a reason.',
          { submissionIds: alreadyFinal.map((row) => row.submissionId) },
        );
      }

      for (const item of input.items) {
        this.assertMarksWithinBounds(assignment, item.marks);
      }

      const now = new Date();
      await tx.insert(submissionGrades).values(
        input.items.map((item) => ({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          submissionId: item.submissionId,
          marks: item.marks,
          feedback: item.feedback ?? null,
          gradedBy,
          gradedAt: now,
          isFinal: true,
          createdBy: principal.userId,
        })),
      );

      await tx
        .update(assignmentSubmissions)
        .set({
          status: 'graded',
          version: sql`${assignmentSubmissions.version} + 1`,
          updatedBy: principal.userId,
        })
        .where(inArray(assignmentSubmissions.id, ids));

      return { graded: input.items.length };
    });
  }

  private requireGrader(principal: Principal, scope: DataScope): string {
    if (scope === 'own') {
      throw new ForbiddenError('homework.grade', 'Only teaching staff can grade homework');
    }
    if (!principal.employeeId) {
      // graded_by is an accountability column pointing at an employee; an account with no
      // employee record cannot own a mark.
      throw new ForbiddenError(
        'homework.grade',
        'Only staff with an employee record can grade homework',
      );
    }
    return principal.employeeId;
  }

  private assertMarksWithinBounds(assignment: AssignmentRow, marks: string): void {
    if (!assignment.isGraded || assignment.maxMarks == null) {
      throw new ValidationError('This assignment is not graded', [
        { path: 'marks', message: 'The assignment has no maximum marks to grade against' },
      ]);
    }
    const given = toHundredths(marks);
    const maximum = toHundredths(assignment.maxMarks);
    if (given === null || maximum === null || given > maximum) {
      throw new ValidationError('Marks are above the maximum for this assignment', [
        { path: 'marks', message: `Marks may not exceed ${assignment.maxMarks}` },
      ]);
    }
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Reports
  // ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Completion rate per assignment for one section, computed in SQL: how many of the
   * section's active students handed each published assignment in, how many of those were
   * late, and how many are graded.
   */
  async completionReport(
    principal: Principal,
    institutionId: string,
    sectionId: string,
  ): Promise<{
    sectionId: string;
    enrolled: number;
    assignments: Record<string, unknown>[];
  }> {
    const scope = this.requireScope(principal);
    if (scope === 'own') {
      // A section's completion table names every student's compliance; that is staff data.
      throw new ForbiddenError('homework.view', 'You cannot view section homework reports');
    }

    return this.db.runInTenant(async (tx) => {
      const [section] = await tx
        .select({ id: sections.id })
        .from(sections)
        .where(
          and(
            eq(sections.id, sectionId),
            eq(sections.institutionId, institutionId),
            isNull(sections.archivedAt),
          ),
        )
        .limit(1);
      if (!section) throw new NotFoundError('Section', sectionId);

      if (scope === 'assigned') {
        if (!principal.employeeId) throw new NotFoundError('Section', sectionId);
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
          // 404, not 403: which sections exist is not this teacher's to enumerate.
          throw new NotFoundError('Section', sectionId);
        }
      }

      const enrolledExpr = sql<number>`(
        select count(*)::int from ${enrollments}
        where ${enrollments.sectionId} = ${assignments.sectionId}
          and ${enrollments.status} = 'active'
          and ${enrollments.archivedAt} is null
      )`;
      const submittedExpr = sql<number>`count(distinct case
        when ${assignmentSubmissions.archivedAt} is null
        then ${assignmentSubmissions.studentId} end)::int`;
      const lateExpr = sql<number>`count(distinct case
        when ${assignmentSubmissions.archivedAt} is null and ${assignmentSubmissions.isLate}
        then ${assignmentSubmissions.studentId} end)::int`;
      const gradedExpr = sql<number>`count(distinct case
        when ${assignmentSubmissions.archivedAt} is null and exists (
          select 1 from ${submissionGrades}
          where ${submissionGrades.submissionId} = ${assignmentSubmissions.id}
            and ${submissionGrades.isFinal}
            and ${submissionGrades.archivedAt} is null
        )
        then ${assignmentSubmissions.studentId} end)::int`;

      const rows = await tx
        .select({
          assignmentId: assignments.id,
          title: assignments.title,
          type: assignments.type,
          status: assignments.status,
          dueAt: assignments.dueAt,
          enrolled: enrolledExpr,
          submitted: submittedExpr,
          late: lateExpr,
          graded: gradedExpr,
          // Percent as text: it comes off a numeric round(), and this codebase does not put
          // numeric values through JavaScript floats.
          completionPercent: sql<string>`coalesce(
            round(100.0 * ${submittedExpr} / nullif(${enrolledExpr}, 0), 2), 0
          )::text`,
        })
        .from(assignments)
        .leftJoin(assignmentSubmissions, eq(assignmentSubmissions.assignmentId, assignments.id))
        .where(
          and(
            eq(assignments.sectionId, sectionId),
            eq(assignments.institutionId, institutionId),
            inArray(assignments.status, ['published', 'closed']),
            isNull(assignments.archivedAt),
          ),
        )
        .groupBy(assignments.id)
        .orderBy(desc(assignments.dueAt), asc(assignments.id));

      const [enrolledRow] = await tx
        .select({ enrolled: sql<number>`count(*)::int` })
        .from(enrollments)
        .where(
          and(
            eq(enrollments.sectionId, sectionId),
            eq(enrollments.status, 'active'),
            isNull(enrollments.archivedAt),
          ),
        );

      return {
        sectionId,
        enrolled: enrolledRow?.enrolled ?? 0,
        assignments: rows,
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
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw new ValidationError('The file is too large', [
        { path: 'file', message: 'Attachments may be at most 10 MB' },
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
// Exact decimal helper (the exams module's discipline)
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

/**
 * Determine the MIME type from the first bytes. Covers exactly the allow-listed types; an
 * unrecognised signature returns null and the client's claim is then tested against the
 * same allow-list, so nothing outside it is ever stored. Kept local (rather than imported
 * from the students module) so this module has no dependency on another module's file.
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
