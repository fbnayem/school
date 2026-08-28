/**
 * Examination and result service (Phase 8).
 *
 * Three things in here are not ordinary CRUD, and they are the reason this file is long.
 *
 * **1. The Bangladeshi GPA rules are implemented, not approximated.**
 *   - A subject's grade comes from the exam's grading scale bands. Nothing is hard-coded; the
 *     letters and their grade points are rows, so an institution on a 4.0 scale works without
 *     a code change.
 *   - The **fourth subject** contributes only what it earns *above 2.00* grade points, and it
 *     never enters the divisor. A student with five main subjects at 5.00 and a fourth subject
 *     at 4.00 scores (25.00 + 2.00) / 5 = 5.40, capped to the scale maximum of 5.00.
 *   - Subjects flagged `exclude_from_gpa` are left out entirely, divisor included.
 *   - **Failing any compulsory subject is GPA 0.00 and grade F**, whatever the average would
 *     otherwise have been. This is checked after the average, not folded into it, because the
 *     two rules answer different questions and merging them makes neither auditable.
 *   - A subject with components is passed only by reaching **every** component pass mark that
 *     is defined, not merely the total. A 70/30 paper with a 23-mark written threshold is
 *     failed on 20 written + 30 MCQ, even though 50/100 clears the overall 33.
 *
 * **2. All of that arithmetic runs over integer hundredths.** Marks, percentages and grade
 * points arrive from the driver as decimal strings and stay exact. A marksheet is a legal
 * document; `0.1 + 0.2` has no place in one, and the ban on floating-point money is really a
 * ban on floating-point arithmetic wherever the number is later printed and disputed.
 *
 * **3. The workflow is a separation-of-duties surface.** Marks are enterable only while the
 * exam is in `marks_entry`; a teacher may only enter them for a subject they are assigned to;
 * approval is refused to whoever entered the marks; publication is a distinct permission from
 * approval. Every transition checks the exam's current status against a table of permitted
 * moves rather than trusting the caller's intent.
 *
 * Auditing follows the house pattern: the *domain* record of who did what and when lives in
 * the business columns (`entered_by`, `submitted_by`, `reviewed_by`, `approved_by`,
 * `correction_count`, `results.published_by`), written inside the same transaction as the
 * change — exactly as `student_status_history` does for students. The security trail is
 * written by `AuditInterceptor` from the `@Audited(...)` metadata on each route, with the
 * before/after values these methods return in `__audit`.
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
  isNotNull,
  isNull,
  ne,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import {
  academicYears,
  classLevels,
  employeeSectionAssignments,
  employeeSubjectAssignments,
  employees,
  enrollments,
  examMarks,
  examSchedules,
  examSubjects,
  exams,
  gradeBands,
  gradingScales,
  results,
  rooms,
  sections,
  studentGuardians,
  students,
  subjects,
  terms,
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
import { EXAM_SORT_FIELDS } from '@shikkha/validation';
import { DatabaseService } from '../database/database.service';
import { currentContext } from '../../common/context/request-context';

/** The transaction handle `runInTenant` hands to its callback. */
type Tx = Parameters<Parameters<DatabaseService['runInTenant']>[0]>[0];

type ExamRow = typeof exams.$inferSelect;
type ExamStatus = ExamRow['status'];
type GradingScaleRow = typeof gradingScales.$inferSelect;
type ExamSubjectRow = typeof examSubjects.$inferSelect;
type ExamMarkRow = typeof examMarks.$inferSelect;
type ExamScheduleRow = typeof examSchedules.$inferSelect;
type ResultRow = typeof results.$inferSelect;

/** 100.00 in hundredths — the top of the percentage range, and the ceiling of a band set. */
const FULL_PERCENTAGE = 10_000;

/**
 * The fourth subject contributes only its grade points **above 2.00**.
 *
 * 2.00 is the pass threshold on the NCTB scale (a D). Expressed in hundredths and read from
 * the scale where possible — see `fourthSubjectThreshold` — so a school on a different scale
 * gets the equivalent rule rather than a hard-coded Bangladeshi constant.
 */
const NCTB_FOURTH_SUBJECT_THRESHOLD = 200;

/**
 * Permitted exam status moves.
 *
 * `under_review` is reached only by `review`, `published` only by `publish`, and the way back
 * from `published` only by `unpublish` — each its own permission, so none of them is
 * reachable through the generic status endpoint. That is the separation of duties expressed
 * as data rather than as a chain of `if`s nobody can audit.
 */
const EXAM_STATUS_TRANSITIONS: Record<ExamStatus, readonly ExamStatus[]> = {
  draft: ['scheduled', 'archived'],
  scheduled: ['draft', 'ongoing', 'archived'],
  ongoing: ['scheduled', 'marks_entry', 'archived'],
  marks_entry: ['ongoing', 'under_review', 'archived'],
  under_review: ['marks_entry', 'published'],
  published: ['under_review'],
  archived: [],
};

export interface ListExamsQuery {
  page: number;
  pageSize: number;
  sort?: string;
  q?: string;
  academicYearId?: string;
  termId?: string;
  campusId?: string;
  classLevelId?: string;
  type?: string;
  status?: string;
  includeArchived: boolean;
}

/** One subject's outcome for one student, before the GPA rules are applied across them. */
interface SubjectOutcome {
  examSubjectId: string;
  subjectId: string;
  subjectCode: string;
  subjectNameEn: string;
  subjectNameBn: string | null;
  kind: string;
  isFourthSubject: boolean;
  excludeFromGpa: boolean;
  isOptional: boolean;
  fullMarks: number;
  obtainedMarks: number;
  percentage: number;
  gradePoint: number;
  grade: string;
  isAbsent: boolean;
  isPassed: boolean;
  /** Which component thresholds were missed. Empty when the subject was passed. */
  failedComponents: string[];
}

interface Band {
  grade: string;
  min: number;
  max: number;
  point: number;
  isPassing: boolean;
}

@Injectable()
export class ExamsService {
  constructor(private readonly db: DatabaseService) {}

  // ────────────────────────────────────────────────────────────────────────────────────
  // Grading scales
  // ────────────────────────────────────────────────────────────────────────────────────

  async listGradingScales(
    institutionId: string,
    query: { includeArchived: boolean; q?: string },
  ): Promise<Array<GradingScaleRow & { bandCount: number }>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(gradingScales.institutionId, institutionId)];
      if (!query.includeArchived) filters.push(isNull(gradingScales.archivedAt));
      if (query.q) filters.push(ilike(gradingScales.nameEn, `%${query.q.trim()}%`));

      const rows = await tx
        .select({
          scale: gradingScales,
          bandCount: sql<number>`(
            select count(*)::int from ${gradeBands}
            where ${gradeBands.gradingScaleId} = ${gradingScales.id}
              and ${gradeBands.archivedAt} is null
          )`,
        })
        .from(gradingScales)
        .where(and(...filters))
        .orderBy(asc(gradingScales.nameEn));

      return rows.map((row) => ({ ...row.scale, bandCount: row.bandCount }));
    });
  }

  async findGradingScale(institutionId: string, id: string) {
    return this.db.runInTenant(async (tx) => {
      const scale = await this.loadGradingScale(tx, institutionId, id);
      const bands = await tx
        .select()
        .from(gradeBands)
        .where(and(eq(gradeBands.gradingScaleId, id), isNull(gradeBands.archivedAt)))
        .orderBy(desc(gradeBands.minPercentage));
      return { ...scale, bands };
    });
  }

  async createGradingScale(
    principal: Principal,
    institutionId: string,
    input: {
      code: string;
      nameEn: string;
      nameBn?: string;
      description?: string;
      isDefault: boolean;
    },
  ): Promise<GradingScaleRow> {
    return this.db.runInTenant(async (tx) => {
      if (input.isDefault) {
        // Cleared inside the same transaction as the insert. Two statements outside one would
        // leave a window with two default scales, which the partial unique index refuses —
        // the user would see a constraint error instead of the operation working.
        await tx
          .update(gradingScales)
          .set({ isDefault: false, updatedBy: principal.userId })
          .where(
            and(
              eq(gradingScales.institutionId, institutionId),
              eq(gradingScales.isDefault, true),
              isNull(gradingScales.archivedAt),
            ),
          );
      }

      const [created] = await tx
        .insert(gradingScales)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          code: input.code,
          nameEn: input.nameEn,
          nameBn: input.nameBn ?? null,
          description: input.description ?? null,
          isDefault: input.isDefault,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      return created!;
    });
  }

  async updateGradingScale(
    principal: Principal,
    institutionId: string,
    id: string,
    input: Record<string, unknown>,
  ): Promise<{ scale: GradingScaleRow; previous: Partial<GradingScaleRow> }> {
    const version = input['version'] as number;
    const { version: _ignored, ...changes } = input;

    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadGradingScale(tx, institutionId, id);

      if (changes['isDefault'] === true) {
        await tx
          .update(gradingScales)
          .set({ isDefault: false, updatedBy: principal.userId })
          .where(
            and(
              eq(gradingScales.institutionId, institutionId),
              eq(gradingScales.isDefault, true),
              ne(gradingScales.id, id),
              isNull(gradingScales.archivedAt),
            ),
          );
      }

      const [updated] = await tx
        .update(gradingScales)
        .set({
          ...(changes as Partial<GradingScaleRow>),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(gradingScales.id, id), eq(gradingScales.version, version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This grading scale was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      return { scale: updated, previous: diff(existing, updated, Object.keys(changes)) };
    });
  }

  async archiveGradingScale(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<GradingScaleRow> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadGradingScale(tx, institutionId, id);

      // An exam already graded on this scale must keep resolving its letters, so a scale in
      // use is not archivable. Archiving it would make a published result unprintable.
      const [inUse] = await tx
        .select({ id: exams.id, nameEn: exams.nameEn })
        .from(exams)
        .where(and(eq(exams.gradingScaleId, id), isNull(exams.archivedAt)))
        .limit(1);

      if (inUse) {
        throw new ConflictError(
          `"${inUse.nameEn}" still uses this grading scale. Move those exams to another scale first.`,
          { examId: inUse.id },
        );
      }

      const [archived] = await tx
        .update(gradingScales)
        .set({
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          isDefault: false,
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(eq(gradingScales.id, id))
        .returning();

      return archived!;
    });
  }

  /**
   * Replace a scale's bands wholesale.
   *
   * The set-level invariants — cover 0 to 100, no overlap, no gap — are validated by
   * `replaceGradeBandsSchema` before this runs, and again by the deferred
   * `grade_bands_no_overlap` trigger at commit. This method's own job is the one thing
   * neither can see: refusing to re-grade an exam whose results are already published.
   */
  async replaceGradeBands(
    principal: Principal,
    institutionId: string,
    scaleId: string,
    incoming: Array<{
      id?: string;
      grade: string;
      gradeBn?: string;
      minPercentage: string;
      maxPercentage: string;
      gradePoint: string;
      isPassing: boolean;
      sortOrder: number;
    }>,
  ) {
    return this.db.runInTenant(async (tx) => {
      await this.loadGradingScale(tx, institutionId, scaleId);

      const [published] = await tx
        .select({ id: exams.id, nameEn: exams.nameEn })
        .from(exams)
        .where(
          and(
            eq(exams.gradingScaleId, scaleId),
            eq(exams.status, 'published'),
            isNull(exams.archivedAt),
          ),
        )
        .limit(1);

      if (published) {
        throw new ConflictError(
          `"${published.nameEn}" has been published against this scale. Changing the bands now would rewrite a result families have already seen — unpublish it first.`,
          { examId: published.id },
        );
      }

      const existing = await tx
        .select({ id: gradeBands.id })
        .from(gradeBands)
        .where(and(eq(gradeBands.gradingScaleId, scaleId), isNull(gradeBands.archivedAt)));

      const incomingIds = new Set(incoming.map((band) => band.id).filter(Boolean));
      const removed = existing.filter((band) => !incomingIds.has(band.id));

      for (const band of removed) {
        await tx
          .update(gradeBands)
          .set({
            archivedAt: new Date(),
            archivedBy: principal.userId,
            archiveReason: 'Replaced when the grading scale was reconfigured',
            updatedBy: principal.userId,
          })
          .where(eq(gradeBands.id, band.id));
      }

      const saved: Array<typeof gradeBands.$inferSelect> = [];
      for (const band of incoming) {
        const values = {
          grade: band.grade,
          gradeBn: band.gradeBn ?? null,
          minPercentage: band.minPercentage,
          maxPercentage: band.maxPercentage,
          gradePoint: band.gradePoint,
          isPassing: band.isPassing,
          sortOrder: band.sortOrder,
          updatedBy: principal.userId,
        };

        if (band.id) {
          const [updated] = await tx
            .update(gradeBands)
            .set(values)
            .where(and(eq(gradeBands.id, band.id), eq(gradeBands.gradingScaleId, scaleId)))
            .returning();
          if (updated) saved.push(updated);
        } else {
          const [created] = await tx
            .insert(gradeBands)
            .values({
              id: uuidv7(),
              tenantId: principal.tenantId!,
              institutionId,
              gradingScaleId: scaleId,
              createdBy: principal.userId,
              ...values,
            })
            .returning();
          if (created) saved.push(created);
        }
      }

      // Highest band first, which is how a scale is read and printed. Ordered through the
      // exact integer conversion rather than `Number(...)`, so this file contains no path
      // from a `numeric` column to a JavaScript float at all.
      return saved.sort(
        (a, b) => (toHundredths(b.minPercentage) ?? 0) - (toHundredths(a.minPercentage) ?? 0),
      );
    });
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Exams
  // ────────────────────────────────────────────────────────────────────────────────────

  async listExams(
    principal: Principal,
    institutionId: string,
    query: ListExamsQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<ExamRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(exams.institutionId, institutionId)];

      if (!query.includeArchived) {
        filters.push(isNull(exams.archivedAt));
      } else if (!can(principal, 'exams.manage')) {
        // An archived exam is often one that was cancelled for a reason the school does not
        // broadcast. Asking to see them is itself a privileged read.
        throw new ForbiddenError('exams.manage', 'You cannot view archived exams');
      }

      if (query.academicYearId) filters.push(eq(exams.academicYearId, query.academicYearId));
      if (query.termId) filters.push(eq(exams.termId, query.termId));
      if (query.campusId) filters.push(eq(exams.campusId, query.campusId));
      if (query.type) filters.push(eq(exams.type, query.type as ExamRow['type']));
      if (query.status) filters.push(eq(exams.status, query.status as ExamStatus));
      if (query.q) {
        const trimmed = query.q.trim();
        filters.push(or(ilike(exams.nameEn, `%${trimmed}%`), ilike(exams.code, `${trimmed}%`))!);
      }
      if (query.classLevelId) {
        const classLevelId = query.classLevelId;
        filters.push(
          exists(
            this.db.raw
              .select({ one: sql`1` })
              .from(examSubjects)
              .where(
                and(
                  eq(examSubjects.examId, exams.id),
                  eq(examSubjects.classLevelId, classLevelId),
                  isNull(examSubjects.archivedAt),
                ),
              ),
          ),
        );
      }

      const where = and(...filters);
      const orderBy = parseSort(query.sort, EXAM_SORT_FIELDS, {
        field: 'startDate',
        direction: 'desc',
      }).map((spec) => {
        const column = EXAM_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(exams)
        .where(where)
        // The trailing id tiebreaker is not decoration: without it a deep page can repeat or
        // skip a row whenever the sort column has duplicates.
        .orderBy(...orderBy, asc(exams.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(exams)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async findExam(institutionId: string, id: string) {
    return this.db.runInTenant(async (tx) => {
      const exam = await this.loadExam(tx, institutionId, id);
      const [scale] = await tx
        .select()
        .from(gradingScales)
        .where(eq(gradingScales.id, exam.gradingScaleId))
        .limit(1);

      const [subjectCount] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(examSubjects)
        .where(and(eq(examSubjects.examId, id), isNull(examSubjects.archivedAt)));

      return { ...exam, gradingScale: scale ?? null, subjectCount: subjectCount?.total ?? 0 };
    });
  }

  async createExam(
    principal: Principal,
    institutionId: string,
    input: {
      academicYearId: string;
      termId?: string;
      campusId?: string;
      gradingScaleId: string;
      code: string;
      nameEn: string;
      nameBn?: string;
      type: string;
      weightageBasisPoints: number;
      startDate?: string;
      endDate?: string;
      instructions?: string;
    },
  ): Promise<ExamRow> {
    return this.db.runInTenant(async (tx) => {
      // Foreign keys guarantee these rows exist somewhere in the tenant; only these checks
      // guarantee they belong to *this* institution.
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

      if (input.termId) {
        const [term] = await tx
          .select({ id: terms.id })
          .from(terms)
          .where(
            and(
              eq(terms.id, input.termId),
              eq(terms.academicYearId, input.academicYearId),
              isNull(terms.archivedAt),
            ),
          )
          .limit(1);
        if (!term) {
          throw new ValidationError('That term belongs to a different academic year', [
            { path: 'termId', message: 'Choose a term inside the selected academic year' },
          ]);
        }
      }

      const scale = await this.loadGradingScale(tx, institutionId, input.gradingScaleId);
      const bands = await this.loadBands(tx, scale.id);
      if (bands.length === 0) {
        throw new ValidationError('That grading scale has no bands yet', [
          {
            path: 'gradingScaleId',
            message: 'Configure the scale’s grade bands before using it for an exam',
          },
        ]);
      }

      const [created] = await tx
        .insert(exams)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          campusId: input.campusId ?? null,
          academicYearId: input.academicYearId,
          termId: input.termId ?? null,
          gradingScaleId: input.gradingScaleId,
          code: input.code,
          nameEn: input.nameEn,
          nameBn: input.nameBn ?? null,
          type: input.type as ExamRow['type'],
          weightageBasisPoints: input.weightageBasisPoints,
          status: 'draft',
          startDate: input.startDate ?? null,
          endDate: input.endDate ?? null,
          instructions: input.instructions ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      return created!;
    });
  }

  async updateExam(
    principal: Principal,
    institutionId: string,
    id: string,
    input: Record<string, unknown>,
  ): Promise<{ exam: ExamRow; previous: Partial<ExamRow> }> {
    const version = input['version'] as number;
    const { version: _ignored, ...changes } = input;

    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadExam(tx, institutionId, id);

      if (existing.status === 'published') {
        throw new ConflictError(
          'A published exam cannot be edited. Unpublish the results first, then make the change.',
        );
      }

      if (changes['gradingScaleId']) {
        await this.loadGradingScale(tx, institutionId, changes['gradingScaleId'] as string);
      }

      const [updated] = await tx
        .update(exams)
        .set({
          ...(changes as Partial<ExamRow>),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(exams.id, id), eq(exams.version, version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This exam was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      return { exam: updated, previous: diff(existing, updated, Object.keys(changes)) };
    });
  }

  /**
   * Move an exam through the states `exams.manage` owns.
   *
   * `under_review`, `published` and the return from `published` are refused here even when
   * they appear in the transition table: each has its own endpoint and its own permission.
   */
  async changeExamStatus(
    principal: Principal,
    institutionId: string,
    id: string,
    status: ExamStatus,
  ): Promise<{ exam: ExamRow; previous: Partial<ExamRow> }> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadExam(tx, institutionId, id);
      this.assertTransition(existing.status, status);

      if (status === 'marks_entry') {
        const [configured] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(examSubjects)
          .where(and(eq(examSubjects.examId, id), isNull(examSubjects.archivedAt)));
        if ((configured?.total ?? 0) === 0) {
          throw new ConflictError(
            'Configure the exam’s subjects before opening it for mark entry — there is nothing to enter marks against.',
          );
        }
      }

      const [updated] = await tx
        .update(exams)
        .set({ status, updatedBy: principal.userId, version: existing.version + 1 })
        .where(eq(exams.id, id))
        .returning();

      return { exam: updated!, previous: { status: existing.status } };
    });
  }

  async archiveExam(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<ExamRow> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadExam(tx, institutionId, id);

      if (existing.status === 'published') {
        throw new ConflictError(
          'A published exam cannot be archived. Unpublish the results first — archiving would hide a result families can currently see.',
        );
      }

      const [archived] = await tx
        .update(exams)
        .set({
          status: 'archived',
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(eq(exams.id, id))
        .returning();

      return archived!;
    });
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Exam subjects
  // ────────────────────────────────────────────────────────────────────────────────────

  async listExamSubjects(institutionId: string, examId: string, classLevelId?: string) {
    return this.db.runInTenant(async (tx) => {
      await this.loadExam(tx, institutionId, examId);

      const filters: SQL[] = [eq(examSubjects.examId, examId), isNull(examSubjects.archivedAt)];
      if (classLevelId) filters.push(eq(examSubjects.classLevelId, classLevelId));

      return tx
        .select({
          examSubject: examSubjects,
          subjectCode: subjects.code,
          subjectNameEn: subjects.nameEn,
          subjectNameBn: subjects.nameBn,
          subjectKind: subjects.kind,
          isFourthSubject: subjects.isFourthSubject,
          excludeFromGpa: subjects.excludeFromGpa,
          classLevelNameEn: classLevels.nameEn,
          classLevelOrdinal: classLevels.ordinal,
        })
        .from(examSubjects)
        .innerJoin(subjects, eq(subjects.id, examSubjects.subjectId))
        .innerJoin(classLevels, eq(classLevels.id, examSubjects.classLevelId))
        .where(and(...filters))
        .orderBy(asc(classLevels.ordinal), asc(examSubjects.sortOrder), asc(subjects.nameEn));
    });
  }

  /**
   * Replace the subject configuration of one class level within one exam.
   *
   * Per class level and as a set, because the component distribution is a property of the
   * paper and the paper set is a property of the class. Editing one row at a time would allow
   * a written-70 + MCQ-40 paper out of 100 to exist, briefly, with nothing able to reject it.
   *
   * Refused once marks exist for a paper being removed: dropping the configuration would
   * orphan the marks entered against it.
   */
  async replaceExamSubjects(
    principal: Principal,
    institutionId: string,
    examId: string,
    classLevelId: string,
    incoming: Array<{
      id?: string;
      subjectId: string;
      groupId?: string;
      classSubjectId?: string;
      fullMarks: string;
      passMarks: string;
      writtenFullMarks?: string;
      writtenPassMarks?: string;
      mcqFullMarks?: string;
      mcqPassMarks?: string;
      practicalFullMarks?: string;
      practicalPassMarks?: string;
      continuousFullMarks?: string;
      continuousPassMarks?: string;
      isOptional: boolean;
      sortOrder: number;
    }>,
  ) {
    return this.db.runInTenant(async (tx) => {
      const exam = await this.loadExam(tx, institutionId, examId);

      if (exam.status === 'published' || exam.status === 'under_review') {
        throw new ConflictError(
          'The subject configuration cannot change once marks are under review. Move the exam back to mark entry first.',
        );
      }

      const [classLevel] = await tx
        .select({ id: classLevels.id })
        .from(classLevels)
        .where(
          and(
            eq(classLevels.id, classLevelId),
            eq(classLevels.institutionId, institutionId),
            isNull(classLevels.archivedAt),
          ),
        )
        .limit(1);
      if (!classLevel) throw new NotFoundError('Class', classLevelId);

      const subjectIds = [...new Set(incoming.map((row) => row.subjectId))];
      const known = await tx
        .select({ id: subjects.id })
        .from(subjects)
        .where(
          and(
            inArray(subjects.id, subjectIds),
            eq(subjects.institutionId, institutionId),
            isNull(subjects.archivedAt),
          ),
        );
      if (known.length !== subjectIds.length) {
        const found = new Set(known.map((row) => row.id));
        const missing = subjectIds.find((id) => !found.has(id))!;
        throw new NotFoundError('Subject', missing);
      }

      const existing = await tx
        .select({ id: examSubjects.id })
        .from(examSubjects)
        .where(
          and(
            eq(examSubjects.examId, examId),
            eq(examSubjects.classLevelId, classLevelId),
            isNull(examSubjects.archivedAt),
          ),
        );

      const incomingIds = new Set(incoming.map((row) => row.id).filter(Boolean));
      const removed = existing.filter((row) => !incomingIds.has(row.id));

      if (removed.length > 0) {
        const [withMarks] = await tx
          .select({ id: examMarks.id })
          .from(examMarks)
          .where(
            and(
              inArray(
                examMarks.examSubjectId,
                removed.map((row) => row.id),
              ),
              isNull(examMarks.archivedAt),
            ),
          )
          .limit(1);
        if (withMarks) {
          throw new ConflictError(
            'One of the papers being removed already has marks entered against it. Remove the marks first, or keep the paper.',
          );
        }
      }

      for (const row of removed) {
        await tx
          .update(examSubjects)
          .set({
            archivedAt: new Date(),
            archivedBy: principal.userId,
            archiveReason: 'Removed when the exam’s subject set was reconfigured',
            updatedBy: principal.userId,
          })
          .where(eq(examSubjects.id, row.id));
      }

      const saved: ExamSubjectRow[] = [];
      for (const row of incoming) {
        const values = {
          subjectId: row.subjectId,
          groupId: row.groupId ?? null,
          classSubjectId: row.classSubjectId ?? null,
          fullMarks: row.fullMarks,
          passMarks: row.passMarks,
          writtenFullMarks: row.writtenFullMarks ?? null,
          writtenPassMarks: row.writtenPassMarks ?? null,
          mcqFullMarks: row.mcqFullMarks ?? null,
          mcqPassMarks: row.mcqPassMarks ?? null,
          practicalFullMarks: row.practicalFullMarks ?? null,
          practicalPassMarks: row.practicalPassMarks ?? null,
          continuousFullMarks: row.continuousFullMarks ?? null,
          continuousPassMarks: row.continuousPassMarks ?? null,
          isOptional: row.isOptional,
          sortOrder: row.sortOrder,
          updatedBy: principal.userId,
        };

        if (row.id) {
          const [updated] = await tx
            .update(examSubjects)
            .set(values)
            .where(and(eq(examSubjects.id, row.id), eq(examSubjects.examId, examId)))
            .returning();
          if (updated) saved.push(updated);
        } else {
          const [created] = await tx
            .insert(examSubjects)
            .values({
              id: uuidv7(),
              tenantId: principal.tenantId!,
              institutionId,
              examId,
              classLevelId,
              createdBy: principal.userId,
              ...values,
            })
            .returning();
          if (created) saved.push(created);
        }
      }

      return saved.sort((a, b) => a.sortOrder - b.sortOrder);
    });
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Schedules
  // ────────────────────────────────────────────────────────────────────────────────────

  async listSchedules(
    institutionId: string,
    examId: string,
    query: { examSubjectId?: string; classLevelId?: string; sectionId?: string; roomId?: string },
  ) {
    return this.db.runInTenant(async (tx) => {
      await this.loadExam(tx, institutionId, examId);

      const filters: SQL[] = [
        eq(examSubjects.examId, examId),
        isNull(examSchedules.archivedAt),
        isNull(examSubjects.archivedAt),
      ];
      if (query.examSubjectId) filters.push(eq(examSchedules.examSubjectId, query.examSubjectId));
      if (query.classLevelId) filters.push(eq(examSubjects.classLevelId, query.classLevelId));
      if (query.sectionId) filters.push(eq(examSchedules.sectionId, query.sectionId));
      if (query.roomId) filters.push(eq(examSchedules.roomId, query.roomId));

      return tx
        .select({
          schedule: examSchedules,
          subjectCode: subjects.code,
          subjectNameEn: subjects.nameEn,
          classLevelId: examSubjects.classLevelId,
          roomCode: rooms.code,
          roomNameEn: rooms.nameEn,
          invigilatorNameEn: employees.fullNameEn,
        })
        .from(examSchedules)
        .innerJoin(examSubjects, eq(examSubjects.id, examSchedules.examSubjectId))
        .innerJoin(subjects, eq(subjects.id, examSubjects.subjectId))
        .leftJoin(rooms, eq(rooms.id, examSchedules.roomId))
        .leftJoin(employees, eq(employees.id, examSchedules.invigilatorEmployeeId))
        .where(and(...filters))
        .orderBy(asc(examSchedules.examDate), asc(examSchedules.startTime));
    });
  }

  async createSchedule(
    principal: Principal,
    institutionId: string,
    examId: string,
    input: {
      examSubjectId: string;
      sectionId?: string;
      roomId?: string;
      invigilatorEmployeeId?: string;
      examDate: string;
      startTime: string;
      endTime: string;
      notes?: string;
    },
  ): Promise<ExamScheduleRow> {
    return this.db.runInTenant(async (tx) => {
      await this.loadExam(tx, institutionId, examId);
      const examSubject = await this.loadExamSubject(tx, examId, input.examSubjectId);

      await this.assertNoScheduleClash(tx, {
        examDate: input.examDate,
        startTime: input.startTime,
        endTime: input.endTime,
        roomId: input.roomId ?? null,
        invigilatorEmployeeId: input.invigilatorEmployeeId ?? null,
        excludeScheduleId: null,
      });

      const [created] = await tx
        .insert(examSchedules)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          examSubjectId: examSubject.id,
          sectionId: input.sectionId ?? null,
          roomId: input.roomId ?? null,
          invigilatorEmployeeId: input.invigilatorEmployeeId ?? null,
          examDate: input.examDate,
          startTime: input.startTime,
          endTime: input.endTime,
          notes: input.notes ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      return created!;
    });
  }

  async updateSchedule(
    principal: Principal,
    institutionId: string,
    id: string,
    input: Record<string, unknown>,
  ): Promise<{ schedule: ExamScheduleRow; previous: Partial<ExamScheduleRow> }> {
    const version = input['version'] as number;
    const { version: _ignored, ...changes } = input;

    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(examSchedules)
        .where(
          and(
            eq(examSchedules.id, id),
            eq(examSchedules.institutionId, institutionId),
            isNull(examSchedules.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Exam schedule', id);

      const merged = { ...existing, ...(changes as Partial<ExamScheduleRow>) };
      await this.assertNoScheduleClash(tx, {
        examDate: merged.examDate,
        startTime: merged.startTime,
        endTime: merged.endTime,
        roomId: merged.roomId,
        invigilatorEmployeeId: merged.invigilatorEmployeeId,
        excludeScheduleId: id,
      });

      const [updated] = await tx
        .update(examSchedules)
        .set({
          ...(changes as Partial<ExamScheduleRow>),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(examSchedules.id, id), eq(examSchedules.version, version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This schedule was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      return { schedule: updated, previous: diff(existing, updated, Object.keys(changes)) };
    });
  }

  async archiveSchedule(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<ExamScheduleRow> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(examSchedules)
        .where(
          and(
            eq(examSchedules.id, id),
            eq(examSchedules.institutionId, institutionId),
            isNull(examSchedules.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Exam schedule', id);

      const [archived] = await tx
        .update(examSchedules)
        .set({
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(eq(examSchedules.id, id))
        .returning();

      return archived!;
    });
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Marks
  // ────────────────────────────────────────────────────────────────────────────────────

  async listMarks(
    principal: Principal,
    institutionId: string,
    examId: string,
    query: { examSubjectId?: string; sectionId?: string; studentId?: string; status?: string },
  ) {
    const scope = this.requireResultScope(principal);

    return this.db.runInTenant(async (tx) => {
      await this.loadExam(tx, institutionId, examId);

      const filters: SQL[] = [
        eq(examMarks.examId, examId),
        isNull(examMarks.archivedAt),
        this.markScopeFilter(principal, scope),
      ];
      if (query.examSubjectId) filters.push(eq(examMarks.examSubjectId, query.examSubjectId));
      if (query.sectionId) filters.push(eq(examMarks.sectionId, query.sectionId));
      if (query.studentId) filters.push(eq(examMarks.studentId, query.studentId));
      if (query.status) filters.push(eq(examMarks.status, query.status as ExamMarkRow['status']));

      return tx
        .select({
          mark: examMarks,
          studentCode: students.studentCode,
          studentNameEn: students.fullNameEn,
          studentNameBn: students.fullNameBn,
          rollNumber: enrollments.rollNumber,
          subjectCode: subjects.code,
          subjectNameEn: subjects.nameEn,
          fullMarks: examSubjects.fullMarks,
          passMarks: examSubjects.passMarks,
        })
        .from(examMarks)
        .innerJoin(examSubjects, eq(examSubjects.id, examMarks.examSubjectId))
        .innerJoin(subjects, eq(subjects.id, examSubjects.subjectId))
        .innerJoin(students, eq(students.id, examMarks.studentId))
        .leftJoin(enrollments, eq(enrollments.id, examMarks.enrollmentId))
        .where(and(...filters))
        .orderBy(asc(subjects.sortOrder), asc(enrollments.rollNumber), asc(students.fullNameEn));
    });
  }

  /**
   * Bulk mark entry — one paper, many students, one transaction.
   *
   * One transaction because a half-saved register is worse than a failed save: the teacher
   * cannot tell where entry stopped, and the completeness check at submission would pass on a
   * partial set if the missing rows happened to be for withdrawn students.
   */
  async enterMarks(
    principal: Principal,
    institutionId: string,
    examId: string,
    input: {
      examSubjectId: string;
      marks: Array<{
        studentId: string;
        writtenMarks?: string;
        mcqMarks?: string;
        practicalMarks?: string;
        continuousMarks?: string;
        isAbsent: boolean;
        remarks?: string;
      }>;
    },
  ): Promise<{ saved: number; examSubjectId: string; marks: ExamMarkRow[] }> {
    return this.db.runInTenant(async (tx) => {
      const exam = await this.loadExam(tx, institutionId, examId);

      // Mark entry is gated on the exam's state, not on the caller's intent. Entering marks
      // for an exam that has not been sat, or that has already been approved, is not a
      // permission question — it is a workflow one, and the answer is the same for everyone.
      if (exam.status !== 'marks_entry') {
        throw new WorkflowStateError(exam.status, 'marks_entry', 'exam');
      }

      const examSubject = await this.loadExamSubject(tx, examId, input.examSubjectId);
      const placements = await this.loadPlacements(
        tx,
        exam,
        examSubject,
        input.marks.map((row) => row.studentId),
      );

      // Authorisation is per section, resolved once per distinct section rather than per row.
      for (const sectionId of new Set([...placements.values()].map((p) => p.sectionId))) {
        await this.assertMayEnterMarksFor(tx, principal, examSubject.subjectId, sectionId);
      }

      const saved: ExamMarkRow[] = [];
      for (const row of input.marks) {
        const placement = placements.get(row.studentId)!;
        const components = this.validateComponents(examSubject, row);

        const [existing] = await tx
          .select()
          .from(examMarks)
          .where(
            and(
              eq(examMarks.examSubjectId, examSubject.id),
              eq(examMarks.studentId, row.studentId),
              isNull(examMarks.archivedAt),
            ),
          )
          .limit(1);

        if (existing?.status === 'approved') {
          // Changing an approved mark is a different act with a different permission, a
          // mandatory reason, and its own audit record. It is not a re-entry.
          throw new ConflictError(
            'These marks have already been approved. Use the correction endpoint, which records a reason.',
            { examMarkId: existing.id, studentId: row.studentId },
          );
        }

        const values = {
          writtenMarks: row.isAbsent ? null : (row.writtenMarks ?? null),
          mcqMarks: row.isAbsent ? null : (row.mcqMarks ?? null),
          practicalMarks: row.isAbsent ? null : (row.practicalMarks ?? null),
          continuousMarks: row.isAbsent ? null : (row.continuousMarks ?? null),
          obtainedMarks: row.isAbsent ? null : toDecimal(components.total),
          isAbsent: row.isAbsent,
          remarks: row.remarks ?? null,
          // Re-entering marks that were already submitted pulls them back to draft: they have
          // changed, so the earlier submission no longer describes them.
          status: 'draft' as const,
          submittedBy: null,
          submittedAt: null,
          enteredBy: principal.userId,
          enteredAt: new Date(),
          updatedBy: principal.userId,
        };

        if (existing) {
          const [updated] = await tx
            .update(examMarks)
            .set({ ...values, version: existing.version + 1 })
            .where(eq(examMarks.id, existing.id))
            .returning();
          if (updated) saved.push(updated);
        } else {
          const [created] = await tx
            .insert(examMarks)
            .values({
              id: uuidv7(),
              tenantId: principal.tenantId!,
              institutionId,
              examId,
              examSubjectId: examSubject.id,
              studentId: row.studentId,
              enrollmentId: placement.enrollmentId,
              sectionId: placement.sectionId,
              createdBy: principal.userId,
              ...values,
            })
            .returning();
          if (created) saved.push(created);
        }
      }

      return { saved: saved.length, examSubjectId: examSubject.id, marks: saved };
    });
  }

  /**
   * Submit one paper's marks for review.
   *
   * Completeness is checked here rather than at approval, because the person who can fix an
   * omission is the person submitting. Every actively enrolled student in the class level (or
   * in the named section) must have a row — including the absentees, who need an explicit
   * `is_absent` rather than a silent gap.
   */
  async submitMarks(
    principal: Principal,
    institutionId: string,
    examId: string,
    input: { examSubjectId: string; sectionId?: string },
  ): Promise<{ examSubjectId: string; submitted: number }> {
    return this.db.runInTenant(async (tx) => {
      const exam = await this.loadExam(tx, institutionId, examId);
      if (exam.status !== 'marks_entry') {
        throw new WorkflowStateError(exam.status, 'marks_entry', 'exam');
      }

      const examSubject = await this.loadExamSubject(tx, examId, input.examSubjectId);

      const expected = await this.enrolledStudentIds(tx, exam, examSubject, input.sectionId);
      if (expected.length === 0) {
        throw new ConflictError(
          'No students are enrolled for this paper, so there is nothing to submit.',
        );
      }

      for (const sectionId of new Set(expected.map((row) => row.sectionId))) {
        await this.assertMayEnterMarksFor(tx, principal, examSubject.subjectId, sectionId);
      }

      const entered = await tx
        .select({ studentId: examMarks.studentId })
        .from(examMarks)
        .where(
          and(
            eq(examMarks.examSubjectId, examSubject.id),
            inArray(
              examMarks.studentId,
              expected.map((row) => row.studentId),
            ),
            isNull(examMarks.archivedAt),
          ),
        );

      const have = new Set(entered.map((row) => row.studentId));
      const missing = expected.filter((row) => !have.has(row.studentId));
      if (missing.length > 0) {
        throw new ConflictError(
          `${missing.length} student(s) have no marks for this paper. Enter a mark or mark them absent before submitting.`,
          { missingStudentIds: missing.slice(0, 20).map((row) => row.studentId) },
        );
      }

      const filters: SQL[] = [
        eq(examMarks.examSubjectId, examSubject.id),
        eq(examMarks.status, 'draft'),
        isNull(examMarks.archivedAt),
      ];
      if (input.sectionId) filters.push(eq(examMarks.sectionId, input.sectionId));

      const submitted = await tx
        .update(examMarks)
        .set({
          status: 'submitted',
          submittedBy: principal.userId,
          submittedAt: new Date(),
          updatedBy: principal.userId,
          version: sql`${examMarks.version} + 1`,
        })
        .where(and(...filters))
        .returning({ id: examMarks.id });

      return { examSubjectId: examSubject.id, submitted: submitted.length };
    });
  }

  /**
   * Move the exam into review.
   *
   * Refused while any paper still holds draft marks: reviewing half a set and approving it
   * would leave the unreviewed half indistinguishable from the reviewed half afterwards.
   */
  async reviewExam(
    principal: Principal,
    institutionId: string,
    examId: string,
  ): Promise<{ exam: ExamRow; previous: Partial<ExamRow>; reviewed: number }> {
    return this.db.runInTenant(async (tx) => {
      const exam = await this.loadExam(tx, institutionId, examId);
      if (exam.status !== 'marks_entry') {
        throw new WorkflowStateError(exam.status, 'under_review', 'exam');
      }

      const [draft] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(examMarks)
        .where(
          and(
            eq(examMarks.examId, examId),
            eq(examMarks.status, 'draft'),
            isNull(examMarks.archivedAt),
          ),
        );
      if ((draft?.total ?? 0) > 0) {
        throw new ConflictError(
          `${draft!.total} mark(s) have not been submitted yet. Every paper must be submitted before the exam goes to review.`,
        );
      }

      const [anyMark] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(examMarks)
        .where(and(eq(examMarks.examId, examId), isNull(examMarks.archivedAt)));
      if ((anyMark?.total ?? 0) === 0) {
        throw new ConflictError('No marks have been entered for this exam yet.');
      }

      const reviewed = await tx
        .update(examMarks)
        .set({
          reviewedBy: principal.userId,
          reviewedAt: new Date(),
          updatedBy: principal.userId,
          version: sql`${examMarks.version} + 1`,
        })
        .where(
          and(
            eq(examMarks.examId, examId),
            eq(examMarks.status, 'submitted'),
            isNull(examMarks.archivedAt),
          ),
        )
        .returning({ id: examMarks.id });

      const [updated] = await tx
        .update(exams)
        .set({ status: 'under_review', updatedBy: principal.userId, version: exam.version + 1 })
        .where(eq(exams.id, examId))
        .returning();

      return {
        exam: updated!,
        previous: { status: exam.status },
        reviewed: reviewed.length,
      };
    });
  }

  /**
   * Approve submitted marks.
   *
   * **The approver may not be the person who entered them.** The role presets already keep the
   * two apart — a teacher holds `results.enter_marks` and not `results.approve` — but a
   * preset is configuration, and a school that grants one person both would otherwise have a
   * one-person path from "I wrote this number" to "this number is final". The check is on the
   * data, so it holds whatever the roles say.
   */
  async approveMarks(
    principal: Principal,
    institutionId: string,
    examId: string,
    input: { examSubjectId?: string },
  ): Promise<{ examId: string; approved: number }> {
    return this.db.runInTenant(async (tx) => {
      const exam = await this.loadExam(tx, institutionId, examId);
      if (exam.status !== 'under_review') {
        throw new WorkflowStateError(exam.status, 'approved marks', 'exam');
      }

      const filters: SQL[] = [
        eq(examMarks.examId, examId),
        eq(examMarks.status, 'submitted'),
        isNull(examMarks.archivedAt),
      ];
      if (input.examSubjectId) {
        await this.loadExamSubject(tx, examId, input.examSubjectId);
        filters.push(eq(examMarks.examSubjectId, input.examSubjectId));
      }

      const [selfEntered] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(examMarks)
        .where(and(...filters, eq(examMarks.enteredBy, principal.userId)));

      if ((selfEntered?.total ?? 0) > 0) {
        throw new ConflictError(
          'Marks must be approved by someone other than the person who entered them. Ask a colleague with the approval permission to sign these off.',
          { selfEnteredCount: selfEntered!.total },
        );
      }

      const approved = await tx
        .update(examMarks)
        .set({
          status: 'approved',
          approvedBy: principal.userId,
          approvedAt: new Date(),
          updatedBy: principal.userId,
          version: sql`${examMarks.version} + 1`,
        })
        .where(and(...filters))
        .returning({ id: examMarks.id });

      if (approved.length === 0) {
        throw new ConflictError('There are no submitted marks waiting for approval.');
      }

      return { examId, approved: approved.length };
    });
  }

  /**
   * Correct a mark after approval.
   *
   * Everything about this method is deliberate friction: a separate permission
   * (`results.correct`), a mandatory reason, an optimistic-lock version, a correction counter
   * on the row, and a before/after pair handed to the audit interceptor. Changing an approved
   * mark is the most disputed action a school system performs, and the record of it has to be
   * good enough to settle an argument months later.
   *
   * The published result is **not** silently recomputed. It is a snapshot of what was
   * published; re-publishing is the audited act that replaces it.
   */
  async correctMark(
    principal: Principal,
    institutionId: string,
    markId: string,
    input: Record<string, unknown>,
  ): Promise<{ mark: ExamMarkRow; previous: Partial<ExamMarkRow>; reason: string }> {
    const version = input['version'] as number;
    const reason = input['reason'] as string;
    const { version: _v, reason: _r, ...changes } = input;

    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(examMarks)
        .where(
          and(
            eq(examMarks.id, markId),
            eq(examMarks.institutionId, institutionId),
            isNull(examMarks.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Exam mark', markId);

      if (existing.status !== 'approved') {
        throw new ConflictError(
          'These marks have not been approved yet, so they are still editable through ordinary mark entry. The correction endpoint is for approved marks only.',
          { status: existing.status },
        );
      }

      const examSubject = await this.loadExamSubject(tx, existing.examId, existing.examSubjectId);

      const merged = {
        writtenMarks: pick(changes, 'writtenMarks', existing.writtenMarks),
        mcqMarks: pick(changes, 'mcqMarks', existing.mcqMarks),
        practicalMarks: pick(changes, 'practicalMarks', existing.practicalMarks),
        continuousMarks: pick(changes, 'continuousMarks', existing.continuousMarks),
        isAbsent: (changes['isAbsent'] as boolean | undefined) ?? existing.isAbsent,
      };

      const components = this.validateComponents(examSubject, {
        writtenMarks: merged.writtenMarks ?? undefined,
        mcqMarks: merged.mcqMarks ?? undefined,
        practicalMarks: merged.practicalMarks ?? undefined,
        continuousMarks: merged.continuousMarks ?? undefined,
        isAbsent: merged.isAbsent,
      });

      const [updated] = await tx
        .update(examMarks)
        .set({
          writtenMarks: merged.isAbsent ? null : merged.writtenMarks,
          mcqMarks: merged.isAbsent ? null : merged.mcqMarks,
          practicalMarks: merged.isAbsent ? null : merged.practicalMarks,
          continuousMarks: merged.isAbsent ? null : merged.continuousMarks,
          obtainedMarks: merged.isAbsent ? null : toDecimal(components.total),
          isAbsent: merged.isAbsent,
          remarks: pick(changes, 'remarks', existing.remarks),
          correctionCount: existing.correctionCount + 1,
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(and(eq(examMarks.id, markId), eq(examMarks.version, version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This mark was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      const previous: Partial<ExamMarkRow> = {
        writtenMarks: existing.writtenMarks,
        mcqMarks: existing.mcqMarks,
        practicalMarks: existing.practicalMarks,
        continuousMarks: existing.continuousMarks,
        obtainedMarks: existing.obtainedMarks,
        isAbsent: existing.isAbsent,
      };

      return { mark: updated, previous, reason };
    });
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Publication
  // ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Compute and publish every student's result for an exam, in one transaction.
   *
   * The whole exam at once, because positions are relative: publishing one section at a time
   * would produce ranks against a partial cohort that silently change as the rest arrive.
   *
   * Positions are computed in SQL with `rank()` rather than in JavaScript, so tied totals
   * genuinely share a position (two firsts, then a third) and the database — not the caller's
   * sort stability — decides.
   */
  async publishResults(
    principal: Principal,
    institutionId: string,
    examId: string,
  ): Promise<{ exam: ExamRow; previous: Partial<ExamRow>; published: number }> {
    return this.db.runInTenant(async (tx) => {
      const exam = await this.loadExam(tx, institutionId, examId);
      if (exam.status !== 'under_review') {
        throw new WorkflowStateError(exam.status, 'published', 'exam');
      }

      const [unapproved] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(examMarks)
        .where(
          and(
            eq(examMarks.examId, examId),
            ne(examMarks.status, 'approved'),
            isNull(examMarks.archivedAt),
          ),
        );
      if ((unapproved?.total ?? 0) > 0) {
        throw new ConflictError(
          `${unapproved!.total} mark(s) have not been approved. Every mark must be approved before results are published.`,
        );
      }

      const bands = await this.loadBands(tx, exam.gradingScaleId);
      if (bands.length === 0) {
        throw new ConflictError(
          'The exam’s grading scale has no bands, so no grade can be derived. Configure the scale first.',
        );
      }

      const configured = await tx
        .select({
          examSubject: examSubjects,
          subject: {
            id: subjects.id,
            code: subjects.code,
            nameEn: subjects.nameEn,
            nameBn: subjects.nameBn,
            kind: subjects.kind,
            isFourthSubject: subjects.isFourthSubject,
            excludeFromGpa: subjects.excludeFromGpa,
          },
        })
        .from(examSubjects)
        .innerJoin(subjects, eq(subjects.id, examSubjects.subjectId))
        .where(and(eq(examSubjects.examId, examId), isNull(examSubjects.archivedAt)));

      if (configured.length === 0) {
        throw new ConflictError(
          'This exam has no subjects configured, so there is nothing to publish.',
        );
      }

      const marks = await tx
        .select()
        .from(examMarks)
        .where(and(eq(examMarks.examId, examId), isNull(examMarks.archivedAt)));

      if (marks.length === 0) {
        throw new ConflictError('No marks have been entered for this exam.');
      }

      const placements = await tx
        .select({
          studentId: enrollments.studentId,
          enrollmentId: enrollments.id,
          sectionId: enrollments.sectionId,
          classLevelId: enrollments.classLevelId,
        })
        .from(enrollments)
        .where(
          and(
            eq(enrollments.academicYearId, exam.academicYearId),
            eq(enrollments.status, 'active'),
            isNull(enrollments.archivedAt),
            inArray(enrollments.studentId, [...new Set(marks.map((mark) => mark.studentId))]),
          ),
        );

      const placementByStudent = new Map(placements.map((row) => [row.studentId, row]));
      const configByExamSubject = new Map(
        configured.map((row) => [row.examSubject.id, row] as const),
      );

      const marksByStudent = new Map<string, ExamMarkRow[]>();
      for (const mark of marks) {
        const list = marksByStudent.get(mark.studentId) ?? [];
        list.push(mark);
        marksByStudent.set(mark.studentId, list);
      }

      const publishedAt = new Date();
      let published = 0;

      for (const [studentId, studentMarks] of marksByStudent) {
        const placement = placementByStudent.get(studentId);
        if (!placement) {
          // A student with marks but no live enrolment for the exam's year was withdrawn
          // mid-exam. Their marks are kept; a result is not computed, because there is no
          // cohort to rank them within.
          continue;
        }

        const outcomes: SubjectOutcome[] = [];
        for (const mark of studentMarks) {
          const config = configByExamSubject.get(mark.examSubjectId);
          if (!config) continue;
          if (config.examSubject.classLevelId !== placement.classLevelId) continue;
          outcomes.push(this.gradeSubject(config.examSubject, config.subject, mark, bands));
        }

        if (outcomes.length === 0) continue;

        const computed = this.computeResult(outcomes, bands);

        const values = {
          totalMarks: toDecimal(computed.totalMarks),
          obtainedMarks: toDecimal(computed.obtainedMarks),
          percentage: toDecimal(computed.percentage),
          gpa: toDecimal(computed.gpa),
          grade: computed.grade,
          gpaSubjectCount: computed.gpaSubjectCount,
          failedSubjectCount: computed.failedSubjectCount,
          isPassed: computed.isPassed,
          subjectBreakdown: computed.breakdown,
          computedAt: publishedAt,
          publishedAt,
          publishedBy: principal.userId,
          updatedBy: principal.userId,
        };

        const [existing] = await tx
          .select({ id: results.id, version: results.version })
          .from(results)
          .where(
            and(
              eq(results.examId, examId),
              eq(results.studentId, studentId),
              isNull(results.archivedAt),
            ),
          )
          .limit(1);

        if (existing) {
          await tx
            .update(results)
            .set({ ...values, version: existing.version + 1 })
            .where(eq(results.id, existing.id));
        } else {
          await tx.insert(results).values({
            id: uuidv7(),
            tenantId: principal.tenantId!,
            institutionId,
            examId,
            studentId,
            enrollmentId: placement.enrollmentId,
            academicYearId: exam.academicYearId,
            classLevelId: placement.classLevelId,
            sectionId: placement.sectionId,
            createdBy: principal.userId,
            ...values,
          });
        }
        published += 1;
      }

      if (published === 0) {
        throw new ConflictError(
          'No results could be computed. Every student with marks has been withdrawn from this academic year.',
        );
      }

      await this.rankResults(tx, examId);

      const [updated] = await tx
        .update(exams)
        .set({
          status: 'published',
          resultsPublishedAt: publishedAt,
          resultsPublishedBy: principal.userId,
          updatedBy: principal.userId,
          version: exam.version + 1,
        })
        .where(eq(exams.id, examId))
        .returning();

      return { exam: updated!, previous: { status: exam.status }, published };
    });
  }

  /**
   * Retract a published result set.
   *
   * The `results` rows are kept and only their `published_at` is cleared: deleting them would
   * destroy the evidence of what was published, which is the one thing a dispute needs.
   */
  async unpublishResults(
    principal: Principal,
    institutionId: string,
    examId: string,
    reason: string,
  ): Promise<{
    exam: ExamRow;
    previous: Partial<ExamRow>;
    retracted: number;
    reason: string;
  }> {
    return this.db.runInTenant(async (tx) => {
      const exam = await this.loadExam(tx, institutionId, examId);
      if (exam.status !== 'published') {
        throw new WorkflowStateError(exam.status, 'under_review', 'exam');
      }

      const retracted = await tx
        .update(results)
        .set({
          publishedAt: null,
          updatedBy: principal.userId,
          version: sql`${results.version} + 1`,
        })
        .where(
          and(
            eq(results.examId, examId),
            isNotNull(results.publishedAt),
            isNull(results.archivedAt),
          ),
        )
        .returning({ id: results.id });

      const [updated] = await tx
        .update(exams)
        .set({
          status: 'under_review',
          resultsPublishedAt: null,
          resultsPublishedBy: null,
          updatedBy: principal.userId,
          version: exam.version + 1,
        })
        .where(eq(exams.id, examId))
        .returning();

      return {
        exam: updated!,
        previous: { status: exam.status, resultsPublishedAt: exam.resultsPublishedAt },
        retracted: retracted.length,
        // Returned so the caller puts it in the audit record's `newValue` alongside the
        // interceptor's own copy of it. Withdrawing something families have already read is
        // the kind of act whose "why" must be legible without cross-referencing two fields.
        reason,
      };
    });
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Reading results
  // ────────────────────────────────────────────────────────────────────────────────────

  /**
   * The tabulation sheet: one row per student, one column per paper.
   *
   * Staff-facing and available before publication — that is the point of it, since it is what
   * the tabulation committee reads while checking the marks. It is *not* reachable with
   * `results.view.own`, which is why a guardian cannot use it to see an unpublished mark.
   */
  async tabulation(principal: Principal, institutionId: string, examId: string, sectionId: string) {
    const scope = this.requireResultScope(principal);
    if (scope === 'own') {
      // A tabulation sheet is a whole section's marks. There is no "own" version of it.
      throw new ForbiddenError('results.view.assigned', 'You cannot view a tabulation sheet');
    }

    return this.db.runInTenant(async (tx) => {
      const exam = await this.loadExam(tx, institutionId, examId);

      const [section] = await tx
        .select({ id: sections.id, nameEn: sections.nameEn, classLevelId: sections.classLevelId })
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

      const rows = await tx
        .select({
          studentId: students.id,
          studentCode: students.studentCode,
          studentNameEn: students.fullNameEn,
          studentNameBn: students.fullNameBn,
          rollNumber: enrollments.rollNumber,
          examSubjectId: examMarks.examSubjectId,
          subjectId: subjects.id,
          subjectCode: subjects.code,
          subjectNameEn: subjects.nameEn,
          sortOrder: examSubjects.sortOrder,
          fullMarks: examSubjects.fullMarks,
          passMarks: examSubjects.passMarks,
          writtenMarks: examMarks.writtenMarks,
          mcqMarks: examMarks.mcqMarks,
          practicalMarks: examMarks.practicalMarks,
          continuousMarks: examMarks.continuousMarks,
          obtainedMarks: examMarks.obtainedMarks,
          isAbsent: examMarks.isAbsent,
          status: examMarks.status,
        })
        .from(examMarks)
        .innerJoin(examSubjects, eq(examSubjects.id, examMarks.examSubjectId))
        .innerJoin(subjects, eq(subjects.id, examSubjects.subjectId))
        .innerJoin(students, eq(students.id, examMarks.studentId))
        .leftJoin(enrollments, eq(enrollments.id, examMarks.enrollmentId))
        .where(
          and(
            eq(examMarks.examId, examId),
            eq(examMarks.sectionId, sectionId),
            isNull(examMarks.archivedAt),
            this.markScopeFilter(principal, scope),
          ),
        )
        .orderBy(asc(enrollments.rollNumber), asc(examSubjects.sortOrder), asc(subjects.nameEn));

      // Grouped here rather than with one query per student: a section of 60 with 10 papers is
      // 600 rows in one round trip, or 60 round trips if this is written the obvious way.
      const byStudent = new Map<string, Record<string, unknown>>();
      for (const row of rows) {
        let entry = byStudent.get(row.studentId);
        if (!entry) {
          entry = {
            studentId: row.studentId,
            studentCode: row.studentCode,
            studentNameEn: row.studentNameEn,
            studentNameBn: row.studentNameBn,
            rollNumber: row.rollNumber,
            papers: [] as unknown[],
          };
          byStudent.set(row.studentId, entry);
        }
        (entry['papers'] as unknown[]).push({
          examSubjectId: row.examSubjectId,
          subjectId: row.subjectId,
          subjectCode: row.subjectCode,
          subjectNameEn: row.subjectNameEn,
          fullMarks: row.fullMarks,
          passMarks: row.passMarks,
          writtenMarks: row.writtenMarks,
          mcqMarks: row.mcqMarks,
          practicalMarks: row.practicalMarks,
          continuousMarks: row.continuousMarks,
          obtainedMarks: row.obtainedMarks,
          isAbsent: row.isAbsent,
          status: row.status,
        });
      }

      const resultRows = await tx
        .select({
          studentId: results.studentId,
          obtainedMarks: results.obtainedMarks,
          totalMarks: results.totalMarks,
          percentage: results.percentage,
          gpa: results.gpa,
          grade: results.grade,
          isPassed: results.isPassed,
          positionInSection: results.positionInSection,
          positionInClass: results.positionInClass,
          publishedAt: results.publishedAt,
        })
        .from(results)
        .where(
          and(
            eq(results.examId, examId),
            eq(results.sectionId, sectionId),
            isNull(results.archivedAt),
          ),
        );

      const resultByStudent = new Map(resultRows.map((row) => [row.studentId, row]));

      return {
        exam: { id: exam.id, nameEn: exam.nameEn, status: exam.status },
        section: { id: section.id, nameEn: section.nameEn },
        students: [...byStudent.values()].map((entry) => ({
          ...entry,
          result: resultByStudent.get(entry['studentId'] as string) ?? null,
        })),
      };
    });
  }

  /**
   * One student's marksheet.
   *
   * The scope filter is the same one the result list uses, and for `results.view.own` it
   * includes "published only". That is what stops a parent reading an unpublished grade by
   * guessing an id: there is no second code path here that could forget the rule.
   */
  async marksheet(principal: Principal, institutionId: string, examId: string, studentId: string) {
    const scope = this.requireResultScope(principal);

    const row = await this.db.runInTenant(async (tx) => {
      const [found] = await tx
        .select({
          result: results,
          examNameEn: exams.nameEn,
          examNameBn: exams.nameBn,
          examType: exams.type,
          studentCode: students.studentCode,
          studentNameEn: students.fullNameEn,
          studentNameBn: students.fullNameBn,
          sectionNameEn: sections.nameEn,
          classLevelNameEn: classLevels.nameEn,
          rollNumber: enrollments.rollNumber,
        })
        .from(results)
        .innerJoin(exams, eq(exams.id, results.examId))
        .innerJoin(students, eq(students.id, results.studentId))
        .innerJoin(sections, eq(sections.id, results.sectionId))
        .innerJoin(classLevels, eq(classLevels.id, results.classLevelId))
        .leftJoin(enrollments, eq(enrollments.id, results.enrollmentId))
        .where(
          and(
            eq(results.examId, examId),
            eq(results.studentId, studentId),
            eq(results.institutionId, institutionId),
            isNull(results.archivedAt),
            this.resultScopeFilter(principal, scope),
          ),
        )
        .limit(1);
      return found ?? null;
    });

    // A 404 rather than a 403, and the same 404 whether the result is another tenant's,
    // another section's, or simply not published yet. Distinguishing them would confirm the
    // record exists, which is the leak.
    if (!row) throw new NotFoundError('Result', studentId);
    return row;
  }

  async listResults(
    principal: Principal,
    institutionId: string,
    examId: string,
    query: { sectionId?: string; classLevelId?: string; studentId?: string; onlyPassed?: boolean },
    page: OffsetPageRequest,
  ): Promise<OffsetPage<ResultRow>> {
    const scope = this.requireResultScope(principal);

    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [
        eq(results.examId, examId),
        eq(results.institutionId, institutionId),
        isNull(results.archivedAt),
        this.resultScopeFilter(principal, scope),
      ];
      if (query.sectionId) filters.push(eq(results.sectionId, query.sectionId));
      if (query.classLevelId) filters.push(eq(results.classLevelId, query.classLevelId));
      if (query.studentId) filters.push(eq(results.studentId, query.studentId));
      if (query.onlyPassed) filters.push(eq(results.isPassed, true));

      const where = and(...filters);

      const rows = await tx
        .select()
        .from(results)
        .where(where)
        .orderBy(asc(results.positionInSection), desc(results.obtainedMarks), asc(results.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(results)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  /**
   * Pass rate and grade distribution, aggregated in SQL.
   *
   * In SQL rather than in JavaScript because the alternative is fetching every result row to
   * count them, which is the query that stops working the year the school grows. The pass
   * rate is `round(numeric, 2)` — Postgres numeric arithmetic — so it never acquires a
   * floating-point tail on the way to a printed report.
   */
  async summary(
    principal: Principal,
    institutionId: string,
    examId: string,
    query: { classLevelId?: string; sectionId?: string },
  ) {
    const scope = this.requireResultScope(principal);
    if (scope === 'own') {
      throw new ForbiddenError('results.reports.view', 'You cannot view result reports');
    }

    return this.db.runInTenant(async (tx) => {
      const exam = await this.loadExam(tx, institutionId, examId);

      const filters: SQL[] = [
        eq(results.examId, examId),
        eq(results.institutionId, institutionId),
        isNull(results.archivedAt),
        this.resultScopeFilter(principal, scope),
      ];
      if (query.classLevelId) filters.push(eq(results.classLevelId, query.classLevelId));
      if (query.sectionId) filters.push(eq(results.sectionId, query.sectionId));
      const where = and(...filters);

      const [totals] = await tx
        .select({
          students: sql<number>`count(*)::int`,
          passed: sql<number>`(count(*) filter (where ${results.isPassed}))::int`,
          failed: sql<number>`(count(*) filter (where not ${results.isPassed}))::int`,
          // Numeric arithmetic end to end: `100.0` is a numeric literal, so the rate never
          // acquires a floating-point tail on its way onto a printed report.
          passRate: sql<string>`coalesce(round(100.0 * (count(*) filter (where ${results.isPassed})) / nullif(count(*), 0), 2), 0.00)`,
          averageGpa: sql<string>`coalesce(round(avg(${results.gpa}), 2), 0.00)`,
          highestGpa: sql<string>`coalesce(max(${results.gpa}), 0.00)`,
          averagePercentage: sql<string>`coalesce(round(avg(${results.percentage}), 2), 0.00)`,
          highestMarks: sql<string>`coalesce(max(${results.obtainedMarks}), 0.00)`,
          lowestMarks: sql<string>`coalesce(min(${results.obtainedMarks}), 0.00)`,
        })
        .from(results)
        .where(where);

      const distribution = await tx
        .select({
          grade: results.grade,
          students: sql<number>`count(*)::int`,
          highestGpa: sql<string>`max(${results.gpa})`,
        })
        .from(results)
        .where(where)
        .groupBy(results.grade)
        .orderBy(desc(sql`max(${results.gpa})`));

      return {
        exam: { id: exam.id, nameEn: exam.nameEn, status: exam.status },
        totals: totals ?? {
          students: 0,
          passed: 0,
          failed: 0,
          passRate: '0.00',
          averageGpa: '0.00',
          highestGpa: '0.00',
          averagePercentage: '0.00',
          highestMarks: '0.00',
          lowestMarks: '0.00',
        },
        gradeDistribution: distribution,
      };
    });
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Grading — the Bangladeshi rules
  // ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Grade one subject for one student.
   *
   * The component rule lives here: a paper with a written pass mark of 23 out of 70 is failed
   * on 20 written, even when the total clears the overall pass mark. This is a real board
   * rule and the single most common thing a school management system gets wrong, because the
   * naive implementation compares only the total.
   */
  private gradeSubject(
    examSubject: ExamSubjectRow,
    subject: {
      id: string;
      code: string;
      nameEn: string;
      nameBn: string | null;
      kind: string;
      isFourthSubject: boolean;
      excludeFromGpa: boolean;
    },
    mark: ExamMarkRow,
    bands: Band[],
  ): SubjectOutcome {
    const fullMarks = toHundredths(examSubject.fullMarks) ?? 0;
    const passMarks = toHundredths(examSubject.passMarks) ?? 0;
    const failing = failingBand(bands);

    const base = {
      examSubjectId: examSubject.id,
      subjectId: subject.id,
      subjectCode: subject.code,
      subjectNameEn: subject.nameEn,
      subjectNameBn: subject.nameBn,
      kind: subject.kind,
      isFourthSubject: subject.isFourthSubject,
      excludeFromGpa: subject.excludeFromGpa,
      isOptional: examSubject.isOptional,
      fullMarks,
    };

    if (mark.isAbsent) {
      return {
        ...base,
        obtainedMarks: 0,
        percentage: 0,
        gradePoint: failing?.point ?? 0,
        grade: failing?.grade ?? 'F',
        isAbsent: true,
        isPassed: false,
        failedComponents: [],
      };
    }

    const obtained = toHundredths(mark.obtainedMarks) ?? 0;
    const percentage = fullMarks > 0 ? divideRoundHalfUp(obtained * FULL_PERCENTAGE, fullMarks) : 0;

    // Each component that declares a pass mark must be reached on its own.
    const failedComponents: string[] = [];
    const componentChecks: Array<[string, string | null, string | null]> = [
      ['written', examSubject.writtenPassMarks, mark.writtenMarks],
      ['mcq', examSubject.mcqPassMarks, mark.mcqMarks],
      ['practical', examSubject.practicalPassMarks, mark.practicalMarks],
      ['continuous', examSubject.continuousPassMarks, mark.continuousMarks],
    ];
    for (const [name, componentPass, scored] of componentChecks) {
      const threshold = toHundredths(componentPass);
      if (threshold === null) continue;
      if ((toHundredths(scored) ?? 0) < threshold) failedComponents.push(name);
    }

    const isPassed = obtained >= passMarks && failedComponents.length === 0;
    const band = bandForPercentage(bands, percentage);

    return {
      ...base,
      obtainedMarks: obtained,
      percentage,
      // A failed subject takes the failing band's grade point regardless of where its
      // percentage landed. Without this, missing a component threshold on 85% would still
      // score an A+, and the fail would be invisible on the marksheet.
      gradePoint: isPassed ? (band?.point ?? 0) : (failing?.point ?? 0),
      grade: isPassed ? (band?.grade ?? 'F') : (failing?.grade ?? 'F'),
      isAbsent: false,
      isPassed,
      failedComponents,
    };
  }

  /**
   * Roll a student's subject outcomes up into a GPA, a grade and a pass/fail.
   *
   * The order of the rules is the specification, not an implementation detail:
   *
   *   1. Drop subjects flagged `exclude_from_gpa`, divisor included.
   *   2. Average the grade points of the remaining non-fourth subjects.
   *   3. Add the fourth subject's points **above the pass threshold**, without adding to the
   *      divisor. A fourth subject can raise a GPA; it can never lower it, and it can never
   *      cause a fail.
   *   4. Cap at the scale's highest passing grade point (5.00 on the NCTB scale).
   *   5. If any compulsory subject was failed, the GPA is 0.00 and the grade is F —
   *      overriding everything above.
   */
  private computeResult(
    outcomes: SubjectOutcome[],
    bands: Band[],
  ): {
    totalMarks: number;
    obtainedMarks: number;
    percentage: number;
    gpa: number;
    grade: string;
    gpaSubjectCount: number;
    failedSubjectCount: number;
    isPassed: boolean;
    breakdown: unknown;
  } {
    const failing = failingBand(bands);
    const ceiling = Math.max(
      ...bands.filter((band) => band.isPassing).map((band) => band.point),
      0,
    );
    const threshold = fourthSubjectThreshold(bands);

    const totalMarks = outcomes.reduce((sum, outcome) => sum + outcome.fullMarks, 0);
    const obtainedMarks = outcomes.reduce((sum, outcome) => sum + outcome.obtainedMarks, 0);
    const percentage =
      totalMarks > 0 ? divideRoundHalfUp(obtainedMarks * FULL_PERCENTAGE, totalMarks) : 0;

    const counted = outcomes.filter((outcome) => !outcome.excludeFromGpa);
    const main = counted.filter((outcome) => !outcome.isFourthSubject);
    const fourth = counted.filter((outcome) => outcome.isFourthSubject);

    // "Failing any compulsory subject" — the fourth subject is excluded by definition, since
    // its whole purpose is that it cannot cause a fail.
    const compulsoryFailure = main.some(
      (outcome) => outcome.kind === 'compulsory' && !outcome.isPassed,
    );

    let gpa = 0;
    if (main.length > 0) {
      let points = main.reduce((sum, outcome) => sum + outcome.gradePoint, 0);
      for (const outcome of fourth) {
        points += Math.max(0, outcome.gradePoint - threshold);
      }
      gpa = Math.min(divideRoundHalfUp(points, main.length), ceiling);
    }

    if (compulsoryFailure) gpa = 0;

    const lowestPassing = Math.min(
      ...bands.filter((band) => band.isPassing).map((band) => band.point),
      ceiling,
    );
    const isPassed = !compulsoryFailure && main.length > 0 && gpa >= lowestPassing;

    const grade = isPassed
      ? (bandForGradePoint(bands, gpa)?.grade ?? failing?.grade ?? 'F')
      : (failing?.grade ?? 'F');

    return {
      totalMarks,
      obtainedMarks,
      percentage,
      gpa,
      grade,
      gpaSubjectCount: main.length,
      failedSubjectCount: counted.filter((outcome) => !outcome.isPassed).length,
      isPassed,
      breakdown: outcomes.map((outcome) => ({
        examSubjectId: outcome.examSubjectId,
        subjectId: outcome.subjectId,
        subjectCode: outcome.subjectCode,
        subjectNameEn: outcome.subjectNameEn,
        subjectNameBn: outcome.subjectNameBn,
        kind: outcome.kind,
        isFourthSubject: outcome.isFourthSubject,
        excludeFromGpa: outcome.excludeFromGpa,
        fullMarks: toDecimal(outcome.fullMarks),
        obtainedMarks: toDecimal(outcome.obtainedMarks),
        percentage: toDecimal(outcome.percentage),
        gradePoint: toDecimal(outcome.gradePoint),
        grade: outcome.grade,
        isAbsent: outcome.isAbsent,
        isPassed: outcome.isPassed,
        failedComponents: outcome.failedComponents,
      })),
    };
  }

  /**
   * Assign positions with a window function.
   *
   * `rank()` rather than `row_number()` is the whole point: two students on identical totals
   * are both first, and the next student is third. `row_number()` would break the tie
   * arbitrarily and hand one of them a second place they did not lose.
   */
  private async rankResults(tx: Tx, examId: string): Promise<void> {
    await tx.execute(sql`
      with ranked as (
        select
          id,
          rank() over (partition by section_id order by obtained_marks desc) as section_rank,
          rank() over (partition by class_level_id order by obtained_marks desc) as class_rank
        from results
        where exam_id = ${examId}
          and archived_at is null
      )
      update results
         set position_in_section = ranked.section_rank,
             position_in_class = ranked.class_rank
        from ranked
       where ranked.id = results.id
    `);
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Scoping and authorisation
  // ────────────────────────────────────────────────────────────────────────────────────

  private requireResultScope(principal: Principal): DataScope {
    const context = currentContext();
    const scope = resolveDataScope(principal, SCOPED_RESOURCES.results, {
      institutionId: context?.institutionId ?? null,
      campusId: context?.campusId ?? null,
    });
    if (scope === 'none') {
      throw new ForbiddenError('results.view.all', 'You cannot view results');
    }
    return scope;
  }

  /**
   * Translate a data scope into a predicate over `results`.
   *
   * `all` is a tautology rather than `undefined`, so a caller can always `and(...)` it in and
   * cannot accidentally build a query with no scope filter at all.
   *
   * The `own` branch carries the publication rule: a student or guardian sees a result only
   * once it has been published. Putting it here rather than at each call site means there is
   * exactly one place it could be forgotten, and it is not forgotten.
   */
  private resultScopeFilter(principal: Principal, scope: DataScope): SQL {
    if (scope === 'all') return sql`true`;

    if (scope === 'assigned') {
      if (!principal.employeeId) return sql`false`;
      return this.assignedSectionPredicate(principal.employeeId, results.sectionId);
    }

    const conditions: SQL[] = [];
    if (principal.guardianId) {
      conditions.push(
        exists(
          this.db.raw
            .select({ one: sql`1` })
            .from(studentGuardians)
            .where(
              and(
                eq(studentGuardians.studentId, results.studentId),
                eq(studentGuardians.guardianId, principal.guardianId),
                eq(studentGuardians.canAccessPortal, true),
                isNull(studentGuardians.archivedAt),
              ),
            ),
        ),
      );
    }
    if (principal.studentId) {
      conditions.push(eq(results.studentId, principal.studentId));
    }
    if (conditions.length === 0) return sql`false`;

    const own = conditions.length === 1 ? conditions[0]! : or(...conditions)!;
    // Unpublished results are invisible to families, full stop. A result that has been
    // computed but not published is a working draft, and a parent reading one would be
    // reading a number the school has not stood behind.
    return and(own, isNotNull(results.publishedAt))!;
  }

  /** The same scope logic, over `exam_marks`. Raw marks are never visible to `own`. */
  private markScopeFilter(principal: Principal, scope: DataScope): SQL {
    if (scope === 'all') return sql`true`;
    if (scope === 'assigned') {
      if (!principal.employeeId) return sql`false`;
      return this.assignedSectionPredicate(principal.employeeId, examMarks.sectionId);
    }
    // `own` never reaches raw marks: a family sees a published result, not the mark sheet.
    return sql`false`;
  }

  /**
   * "This employee is assigned to that section."
   *
   * Copied in structure from `StudentsService.scopeFilter`'s `assigned` branch rather than
   * re-derived: a teacher is assigned to a section if they are its class teacher **or** they
   * teach a subject in it. Two modules answering the same question differently is how a
   * teacher ends up able to read a section for one purpose and not another.
   */
  private assignedSectionPredicate(employeeId: string, sectionColumn: SQLWrapper): SQL {
    return or(
      exists(
        this.db.raw
          .select({ one: sql`1` })
          .from(employeeSectionAssignments)
          .where(
            and(
              eq(employeeSectionAssignments.sectionId, sectionColumn),
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
              eq(employeeSubjectAssignments.sectionId, sectionColumn),
              eq(employeeSubjectAssignments.employeeId, employeeId),
              isNull(employeeSubjectAssignments.archivedAt),
            ),
          ),
      ),
    )!;
  }

  /**
   * May this principal enter marks for this subject, in this section?
   *
   * Reading, for a teacher, is "assigned to the section". **Writing is narrower**, and
   * deliberately so: `packages/db/src/schema/people.ts` states of
   * `employee_subject_assignments` that it "is the row that authorises a teacher to enter
   * marks for a section… Without a matching row, mark entry is refused regardless of the
   * teacher's permissions." Being the class teacher of a section does not make someone the
   * mathematics examiner for it.
   *
   * A principal with `results.view.all` resolves to the `all` scope and is not narrowed —
   * that is what the permission means.
   */
  private async assertMayEnterMarksFor(
    tx: Tx,
    principal: Principal,
    subjectId: string,
    sectionId: string,
  ): Promise<void> {
    const context = currentContext();
    const scope = resolveDataScope(principal, SCOPED_RESOURCES.results, {
      institutionId: context?.institutionId ?? null,
      campusId: context?.campusId ?? null,
    });

    if (scope === 'all') return;

    if (scope !== 'assigned' || !principal.employeeId) {
      throw new ForbiddenError(
        'results.enter_marks',
        'You are not assigned to this subject and section',
      );
    }

    const [assignment] = await tx
      .select({ id: employeeSubjectAssignments.id })
      .from(employeeSubjectAssignments)
      .where(
        and(
          eq(employeeSubjectAssignments.employeeId, principal.employeeId),
          eq(employeeSubjectAssignments.sectionId, sectionId),
          eq(employeeSubjectAssignments.subjectId, subjectId),
          isNull(employeeSubjectAssignments.archivedAt),
        ),
      )
      .limit(1);

    if (!assignment) {
      throw new ForbiddenError(
        'results.enter_marks',
        'You are not assigned to this subject and section',
      );
    }
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Loaders and small helpers
  // ────────────────────────────────────────────────────────────────────────────────────

  private async loadExam(tx: Tx, institutionId: string, id: string): Promise<ExamRow> {
    const [found] = await tx
      .select()
      .from(exams)
      .where(
        and(eq(exams.id, id), eq(exams.institutionId, institutionId), isNull(exams.archivedAt)),
      )
      .limit(1);
    // Another tenant's exam, another institution's exam and a non-existent exam are all the
    // same 404. Anything else confirms what exists elsewhere.
    if (!found) throw new NotFoundError('Exam', id);
    return found;
  }

  private async loadGradingScale(
    tx: Tx,
    institutionId: string,
    id: string,
  ): Promise<GradingScaleRow> {
    const [found] = await tx
      .select()
      .from(gradingScales)
      .where(
        and(
          eq(gradingScales.id, id),
          eq(gradingScales.institutionId, institutionId),
          isNull(gradingScales.archivedAt),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundError('Grading scale', id);
    return found;
  }

  private async loadExamSubject(tx: Tx, examId: string, id: string): Promise<ExamSubjectRow> {
    const [found] = await tx
      .select()
      .from(examSubjects)
      .where(
        and(
          eq(examSubjects.id, id),
          eq(examSubjects.examId, examId),
          isNull(examSubjects.archivedAt),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundError('Exam subject', id);
    return found;
  }

  private async loadBands(tx: Tx, gradingScaleId: string): Promise<Band[]> {
    const rows = await tx
      .select()
      .from(gradeBands)
      .where(and(eq(gradeBands.gradingScaleId, gradingScaleId), isNull(gradeBands.archivedAt)));

    return rows.map((row) => ({
      grade: row.grade,
      min: toHundredths(row.minPercentage) ?? 0,
      max: toHundredths(row.maxPercentage) ?? 0,
      point: toHundredths(row.gradePoint) ?? 0,
      isPassing: row.isPassing,
    }));
  }

  /**
   * Where each of these students currently sits, for the exam's academic year.
   *
   * Refuses a student who is not actively enrolled, or who is enrolled in a different class
   * level from the one the paper belongs to: a mark against the wrong class level would be
   * silently dropped at publication, which looks like data loss.
   */
  private async loadPlacements(
    tx: Tx,
    exam: ExamRow,
    examSubject: ExamSubjectRow,
    studentIds: string[],
  ): Promise<Map<string, { enrollmentId: string; sectionId: string; classLevelId: string }>> {
    const unique = [...new Set(studentIds)];
    const rows = await tx
      .select({
        studentId: enrollments.studentId,
        enrollmentId: enrollments.id,
        sectionId: enrollments.sectionId,
        classLevelId: enrollments.classLevelId,
      })
      .from(enrollments)
      .where(
        and(
          inArray(enrollments.studentId, unique),
          eq(enrollments.academicYearId, exam.academicYearId),
          eq(enrollments.status, 'active'),
          isNull(enrollments.archivedAt),
        ),
      );

    const byStudent = new Map(rows.map((row) => [row.studentId, row]));

    for (const studentId of unique) {
      const placement = byStudent.get(studentId);
      if (!placement) {
        throw new ValidationError('One of these students is not enrolled for this exam’s year', [
          {
            path: 'marks',
            message: `Student ${studentId} has no active enrolment in the exam’s academic year`,
          },
        ]);
      }
      if (placement.classLevelId !== examSubject.classLevelId) {
        throw new ValidationError('One of these students is in a different class', [
          {
            path: 'marks',
            message: `Student ${studentId} is not in the class this paper belongs to`,
          },
        ]);
      }
    }

    return new Map(
      [...byStudent.entries()].map(([studentId, row]) => [
        studentId,
        {
          enrollmentId: row.enrollmentId,
          sectionId: row.sectionId,
          classLevelId: row.classLevelId,
        },
      ]),
    );
  }

  private async enrolledStudentIds(
    tx: Tx,
    exam: ExamRow,
    examSubject: ExamSubjectRow,
    sectionId?: string,
  ): Promise<Array<{ studentId: string; sectionId: string }>> {
    const filters: SQL[] = [
      eq(enrollments.academicYearId, exam.academicYearId),
      eq(enrollments.classLevelId, examSubject.classLevelId),
      eq(enrollments.status, 'active'),
      isNull(enrollments.archivedAt),
    ];
    if (sectionId) filters.push(eq(enrollments.sectionId, sectionId));
    if (examSubject.groupId) filters.push(eq(enrollments.groupId, examSubject.groupId));

    return tx
      .select({ studentId: enrollments.studentId, sectionId: enrollments.sectionId })
      .from(enrollments)
      .where(and(...filters));
  }

  /**
   * Bounds-check a submitted set of component marks against the paper's configuration.
   *
   * Three separate failures, each with its own message, because "invalid marks" tells a
   * teacher entering 60 papers nothing about which cell is wrong:
   *   - a component the paper does not assess,
   *   - a component mark above that component's full marks,
   *   - a total above the paper's full marks.
   */
  private validateComponents(
    examSubject: ExamSubjectRow,
    row: {
      writtenMarks?: string | null;
      mcqMarks?: string | null;
      practicalMarks?: string | null;
      continuousMarks?: string | null;
      isAbsent: boolean;
    },
  ): { total: number } {
    if (row.isAbsent) return { total: 0 };

    const fullMarks = toHundredths(examSubject.fullMarks) ?? 0;
    const configured: Array<[string, string | null, string | null | undefined]> = [
      ['written', examSubject.writtenFullMarks, row.writtenMarks],
      ['mcq', examSubject.mcqFullMarks, row.mcqMarks],
      ['practical', examSubject.practicalFullMarks, row.practicalMarks],
      ['continuous', examSubject.continuousFullMarks, row.continuousMarks],
    ];

    const hasBreakdown = configured.some(([, componentFull]) => componentFull !== null);
    let total = 0;

    for (const [name, componentFull, scored] of configured) {
      const value = toHundredths(scored ?? null);
      if (value === null) continue;

      if (value < 0) {
        throw new ValidationError('Marks cannot be negative', [
          { path: `${name}Marks`, message: 'Enter zero or more' },
        ]);
      }

      if (componentFull === null) {
        // With no breakdown at all the paper is marked out of its total, and by convention
        // that total is entered in the written column. Any other column would be a mark
        // against a component this paper does not have.
        if (hasBreakdown || name !== 'written') {
          throw new ValidationError(
            `This paper has no ${name} component, so it cannot take a ${name} mark`,
            [{ path: `${name}Marks`, message: `The ${name} component is not assessed here` }],
          );
        }
        total += value;
        continue;
      }

      const componentCeiling = toHundredths(componentFull) ?? 0;
      if (value > componentCeiling) {
        throw new ValidationError(
          `The ${name} mark is above the ${name} full marks (${componentFull})`,
          [{ path: `${name}Marks`, message: `Enter at most ${componentFull}` }],
        );
      }
      total += value;
    }

    if (total > fullMarks) {
      throw new ValidationError(
        `The total (${toDecimal(total)}) is above the paper's full marks (${examSubject.fullMarks})`,
        [
          {
            path: 'writtenMarks',
            message: `The components must total at most ${examSubject.fullMarks}`,
          },
        ],
      );
    }

    return { total };
  }

  private assertTransition(from: ExamStatus, to: ExamStatus): void {
    if (from === to) {
      throw new ConflictError(`This exam is already ${to.replace('_', ' ')}.`);
    }
    if (to === 'under_review' || to === 'published') {
      // Reachable only through `review` and `publish`, which carry their own permissions.
      throw new ForbiddenError('results.review', 'This status is set by reviewing or publishing');
    }
    if (!EXAM_STATUS_TRANSITIONS[from].includes(to)) {
      throw new WorkflowStateError(from, to, 'exam');
    }
  }

  /**
   * Refuse a room or an invigilator that is already committed to an overlapping paper.
   *
   * Two exams in one hall, or one teacher invigilating two rooms at once, is the failure that
   * is discovered on the morning of the exam. It is cheap to refuse here and expensive to
   * discover there.
   */
  private async assertNoScheduleClash(
    tx: Tx,
    input: {
      examDate: string;
      startTime: string;
      endTime: string;
      roomId: string | null;
      invigilatorEmployeeId: string | null;
      excludeScheduleId: string | null;
    },
  ): Promise<void> {
    if (!input.roomId && !input.invigilatorEmployeeId) return;

    const overlaps = and(
      eq(examSchedules.examDate, input.examDate),
      isNull(examSchedules.archivedAt),
      // Half-open intervals: a paper ending at 11:00 and one starting at 11:00 do not clash.
      sql`${examSchedules.startTime} < ${input.endTime}::time and ${examSchedules.endTime} > ${input.startTime}::time`,
      input.excludeScheduleId ? ne(examSchedules.id, input.excludeScheduleId) : sql`true`,
    )!;

    if (input.roomId) {
      const [clash] = await tx
        .select({ id: examSchedules.id, startTime: examSchedules.startTime })
        .from(examSchedules)
        .where(and(overlaps, eq(examSchedules.roomId, input.roomId)))
        .limit(1);
      if (clash) {
        throw new ConflictError(
          `That room is already booked for another paper at ${clash.startTime} on ${input.examDate}.`,
          { conflictingScheduleId: clash.id },
        );
      }
    }

    if (input.invigilatorEmployeeId) {
      const [clash] = await tx
        .select({ id: examSchedules.id, startTime: examSchedules.startTime })
        .from(examSchedules)
        .where(and(overlaps, eq(examSchedules.invigilatorEmployeeId, input.invigilatorEmployeeId)))
        .limit(1);
      if (clash) {
        throw new ConflictError(
          `That invigilator is already assigned to another paper at ${clash.startTime} on ${input.examDate}.`,
          { conflictingScheduleId: clash.id },
        );
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Exact decimal helpers
//
// `numeric` columns arrive as strings, and they leave as strings. Nothing in this module ever
// converts one to a JavaScript number for arithmetic: `Number('33.33') * 100` is
// 3332.9999999999995, and rounding that is a coin flip on the boundary. Splitting on the
// decimal point is exact for every value the validation schemas admit.
// ─────────────────────────────────────────────────────────────────────────────────────

function toHundredths(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const magnitude = Number(whole) * 100 + Number(fraction.padEnd(2, '0').slice(0, 2));
  return negative ? -magnitude : magnitude;
}

function toDecimal(hundredths: number): string {
  const negative = hundredths < 0;
  const magnitude = Math.abs(Math.trunc(hundredths));
  const whole = Math.floor(magnitude / 100);
  const fraction = magnitude % 100;
  return `${negative ? '-' : ''}${whole}.${String(fraction).padStart(2, '0')}`;
}

/** Integer division rounding half away from zero — the convention a marksheet uses. */
function divideRoundHalfUp(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  const sign = numerator < 0 ? -1 : 1;
  return sign * Math.floor((Math.abs(numerator) * 2 + denominator) / (denominator * 2));
}

function bandForPercentage(bands: Band[], percentage: number): Band | null {
  for (const band of bands) {
    if (percentage >= band.min && percentage < band.max) return band;
    // The top band is closed at 100, so a perfect score belongs to it rather than to nothing.
    if (percentage === band.max && band.max === FULL_PERCENTAGE) return band;
  }
  return null;
}

/**
 * The letter a GPA earns.
 *
 * The greatest band whose grade point the GPA reaches: 4.50 is an A because A is worth 4.00
 * and A- is worth 3.50. This is the standard Bangladeshi reading, and it is derived from the
 * same bands as the subject grades rather than from a second hard-coded table.
 */
function bandForGradePoint(bands: Band[], gradePoint: number): Band | null {
  let best: Band | null = null;
  for (const band of bands) {
    if (band.point <= gradePoint && (best === null || band.point > best.point)) best = band;
  }
  return best;
}

function failingBand(bands: Band[]): Band | null {
  let worst: Band | null = null;
  for (const band of bands) {
    if (band.isPassing) continue;
    if (worst === null || band.point < worst.point) worst = band;
  }
  return worst;
}

/**
 * The grade-point threshold above which a fourth subject contributes.
 *
 * The Bangladeshi rule is "above 2.00", which is the lowest *passing* grade point on the NCTB
 * scale plus one step — in practice, the grade point of the lowest passing band above the
 * bottom one. Reading it from the scale keeps the rule right for an institution whose scale is
 * not the NCTB one, and falls back to the literal 2.00 when the scale offers nothing better.
 */
function fourthSubjectThreshold(bands: Band[]): number {
  const passing = bands
    .filter((band) => band.isPassing)
    .map((band) => band.point)
    .sort((a, b) => a - b);
  if (passing.length === 0) return NCTB_FOURTH_SUBJECT_THRESHOLD;
  const lowest = passing[0]!;
  // On the NCTB scale the lowest passing band is D at 1.00, and the threshold is 2.00 — the
  // next step up. Where a scale has only one passing band, the lowest one is the threshold.
  return passing.find((point) => point > lowest) ?? lowest;
}

/**
 * Only the fields that actually changed, so an audit diff is readable.
 *
 * A trail showing forty unchanged columns beside the one that moved is a trail nobody reads,
 * which makes it no trail at all.
 */
function diff<T>(before: T, after: T, keys: string[]): Partial<T> {
  const previous: Partial<T> = {};
  const from = before as Record<string, unknown>;
  const to = after as Record<string, unknown>;
  for (const key of keys) {
    if (from[key] !== to[key]) {
      (previous as Record<string, unknown>)[key] = from[key];
    }
  }
  return previous;
}

/** A patch value, distinguishing "not sent" from "explicitly cleared". */
function pick<T>(changes: Record<string, unknown>, key: string, fallback: T): T {
  if (!(key in changes)) return fallback;
  return changes[key] as T | null as T;
}

const EXAM_COLUMNS = {
  nameEn: exams.nameEn,
  code: exams.code,
  startDate: exams.startDate,
  status: exams.status,
  createdAt: exams.createdAt,
} as const;
