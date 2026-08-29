/**
 * Discipline and behaviour service (Phase 22).
 *
 * This module records allegations and sanctions against children — the most sensitive data
 * in the product after medical records — so its rules are due-process rules first and
 * features second:
 *
 *  1. **Nothing is deleted.** Withdrawal and "unsubstantiated" are statuses; the record and
 *     its entire history stay. There is no delete path in this file.
 *  2. **Every status transition and every action decision is audited inside the business
 *     transaction**, with actor, timestamp and a mandatory reason — an outcome that rolled
 *     back must not leave a record saying it happened, and one that committed must never be
 *     missing its trail.
 *  3. **A severe sanction needs two people.** A suspension or an expulsion recommendation is
 *     refused when the approver is the person who decided it — even for a principal who
 *     holds every permission. The database restates the same rule as a check constraint.
 *  4. **Visibility is a SQL predicate, resolved from permissions.** Teachers see only their
 *     assigned students (the same rule as `students.service.ts`); guardians see only their
 *     own children, only once a record is substantiated or an action is approved, and never
 *     a record marked `restricted`. Single-record reads go through the same filter as lists,
 *     so an out-of-scope id is a 404, never a 403.
 *  5. **AI never creates, decides or escalates anything here.** There is no auto-classify
 *     path, no AI-facing method, and nothing in this module ever sets `isAiInitiated`.
 *
 * Permission mapping note: the catalogue currently offers only `discipline.records.view`,
 * `discipline.records.create` and `discipline.records.action`. Row scope is therefore
 * resolved by combining `discipline.records.view` with the `students.view.*` triple (which
 * expresses exactly the "all / assigned / own" shape this module needs), and
 * `discipline.records.action` doubles as the restricted-records gate until a dedicated
 * `discipline.records.view.restricted` permission exists.
 */

import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  gte,
  ilike,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm';
import {
  academicYears,
  behaviourCategories,
  behaviourGuardianAcknowledgements,
  behaviourRecordNotes,
  behaviourRecords,
  disciplinaryActions,
  employeeSectionAssignments,
  employeeSubjectAssignments,
  enrollments,
  meritPointsLedger,
  periods,
  sections,
  studentGuardians,
  students,
} from '@shikkha/db';
import {
  buildOffsetPage,
  ConflictError,
  ForbiddenError,
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
import { can, type DataScope, type Principal } from '@shikkha/permissions';
import {
  BEHAVIOUR_CATEGORY_SORT_FIELDS,
  BEHAVIOUR_RECORD_SORT_FIELDS,
  type AcknowledgeBehaviourRecordInput,
  type AddBehaviourNoteInput,
  type BehaviourTrendQuery,
  type CreateBehaviourCategoryInput,
  type CreateBehaviourRecordInput,
  type ProposeDisciplinaryActionInput,
  type TransitionBehaviourRecordInput,
  type UpdateBehaviourCategoryInput,
} from '@shikkha/validation';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { currentContext } from '../../common/context/request-context';

/** The transaction handle `runInTenant` hands to its callback. */

export type BehaviourCategoryRow = typeof behaviourCategories.$inferSelect;
export type BehaviourRecordRow = typeof behaviourRecords.$inferSelect;
export type DisciplinaryActionRow = typeof disciplinaryActions.$inferSelect;
export type BehaviourNoteRow = typeof behaviourRecordNotes.$inferSelect;
export type AcknowledgementRow = typeof behaviourGuardianAcknowledgements.$inferSelect;

type RecordStatus = BehaviourRecordRow['status'];

export interface ListBehaviourCategoriesQuery {
  page: number;
  pageSize: number;
  sort?: string;
  q?: string;
  kind?: 'positive' | 'negative';
  includeArchived: boolean;
}

export interface ListBehaviourRecordsQuery {
  page: number;
  pageSize: number;
  sort?: string;
  studentId?: string;
  categoryId?: string;
  academicYearId?: string;
  status?: RecordStatus;
  severity?: BehaviourRecordRow['severity'];
  kind?: 'positive' | 'negative';
  occurredFrom?: string;
  occurredTo?: string;
}

/**
 * The complete state machine for a behaviour record. Terminal statuses are terminal: a
 * substantiated allegation is corrected by adding to the record (notes, revoked actions),
 * never by moving it back — and a withdrawn one stays withdrawn, visibly.
 */
const RECORD_TRANSITIONS: Record<RecordStatus, readonly RecordStatus[]> = {
  draft: ['reported', 'withdrawn'],
  reported: ['under_investigation', 'substantiated', 'unsubstantiated', 'withdrawn'],
  under_investigation: ['substantiated', 'unsubstantiated', 'withdrawn'],
  substantiated: [],
  unsubstantiated: [],
  withdrawn: [],
};

/** Action types that must not take effect on one person's say-so. */
const SEVERE_ACTION_TYPES: ReadonlySet<string> = new Set(['suspension', 'expulsion_recommended']);

/** Action statuses that count as "in effect" for guardian visibility. */
const APPROVED_ACTION_STATUSES = ['approved', 'active', 'completed'] as const;

/** Record statuses an action may be proposed against — never a draft or a closed allegation. */
const ACTIONABLE_RECORD_STATUSES: readonly RecordStatus[] = [
  'reported',
  'under_investigation',
  'substantiated',
];

@Injectable()
export class DisciplineService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════════════
  // Scoping
  // ══════════════════════════════════════════════════════════════════════════════════

  private accessContext() {
    const context = currentContext();
    return {
      institutionId: context?.institutionId ?? null,
      campusId: context?.campusId ?? null,
    };
  }

  /**
   * Resolve how much of the discipline data this principal may read.
   *
   * The `students.view.*` triple carries the row shape ("all / assigned / own") and
   * `discipline.records.view` gates the staff scopes, so a receptionist who can look up a
   * student cannot read the student's disciplinary file, while a guardian needs no staff
   * permission to see (the visible subset of) their own child's records.
   */
  requireScope(principal: Principal): DataScope {
    const context = this.accessContext();
    if (can(principal, 'discipline.records.view', context)) {
      if (can(principal, 'students.view.all', context)) return 'all';
      if (can(principal, 'students.view.assigned', context)) return 'assigned';
    }
    if (can(principal, 'students.view.own', context)) return 'own';
    throw new ForbiddenError('discipline.records.view', 'You cannot view behaviour records');
  }

  /**
   * The restricted-records gate. Stand-in for a dedicated
   * `discipline.records.view.restricted` permission (reported as missing from the
   * catalogue): only holders of `discipline.records.action` — the people who decide
   * disciplinary outcomes — may see a record marked `restricted`.
   */
  private canViewRestricted(principal: Principal): boolean {
    return can(principal, 'discipline.records.action', this.accessContext());
  }

  /** "This student is assigned to this employee" — the same rule as students.service.ts. */
  private assignedStudentExists(employeeId: string, studentIdColumn: AnyColumn): SQL {
    return exists(
      this.db.raw
        .select({ one: sql`1` })
        .from(enrollments)
        .where(
          and(
            eq(enrollments.studentId, studentIdColumn),
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

  /** "This student is a live, portal-enabled child of this guardian." */
  private guardianLinkExists(guardianId: string, studentIdColumn: AnyColumn): SQL {
    return exists(
      this.db.raw
        .select({ one: sql`1` })
        .from(studentGuardians)
        .where(
          and(
            eq(studentGuardians.studentId, studentIdColumn),
            eq(studentGuardians.guardianId, guardianId),
            // Revoking portal access takes effect immediately, without a role change.
            eq(studentGuardians.canAccessPortal, true),
            isNull(studentGuardians.archivedAt),
          ),
        ),
    );
  }

  /** "Somebody with authority has put an action into effect on this record." */
  private approvedActionExists(): SQL {
    return exists(
      this.db.raw
        .select({ one: sql`1` })
        .from(disciplinaryActions)
        .where(
          and(
            eq(disciplinaryActions.behaviourRecordId, behaviourRecords.id),
            inArray(disciplinaryActions.status, [...APPROVED_ACTION_STATUSES]),
            isNull(disciplinaryActions.archivedAt),
          ),
        ),
    );
  }

  /**
   * Translate a data scope into a SQL predicate over `behaviour_records`.
   *
   * `all` returns a tautology rather than `undefined`, so callers can always `and(...)` the
   * result without a conditional — it is impossible to build a query that forgets the scope.
   *
   * The `own` branch carries the full due-process gate for families: their own children
   * only, never a restricted record, and nothing before the allegation is substantiated or
   * an action is actually in effect — an unproven accusation must not reach the portal.
   */
  private scopeFilter(principal: Principal, scope: DataScope): SQL {
    if (scope === 'all') return sql`true`;

    if (scope === 'assigned') {
      if (!principal.employeeId) {
        // "Assigned" with no employee record is assigned nothing. Fail closed.
        return sql`false`;
      }
      return this.assignedStudentExists(principal.employeeId, behaviourRecords.studentId);
    }

    // scope === 'own'
    const subject: SQL[] = [];
    if (principal.guardianId) {
      subject.push(this.guardianLinkExists(principal.guardianId, behaviourRecords.studentId));
    }
    if (principal.studentId) {
      subject.push(eq(behaviourRecords.studentId, principal.studentId));
    }
    if (subject.length === 0) return sql`false`;

    return and(
      subject.length === 1 ? subject[0]! : or(...subject)!,
      eq(behaviourRecords.confidentiality, 'normal'),
      or(eq(behaviourRecords.status, 'substantiated'), this.approvedActionExists())!,
    )!;
  }

  /**
   * The visibility filter shared verbatim by list, single-record fetch, summaries and the
   * trend report, so no path can leak a row another path would hide.
   */
  private visibilityFilters(principal: Principal, scope: DataScope, institutionId: string): SQL[] {
    const filters: SQL[] = [
      this.scopeFilter(principal, scope),
      eq(behaviourRecords.institutionId, institutionId),
      isNull(behaviourRecords.archivedAt),
    ];

    if (scope !== 'own') {
      // Restricted records are visible only to those who decide outcomes; the `own` branch
      // already excludes them for families unconditionally.
      if (!this.canViewRestricted(principal)) {
        filters.push(eq(behaviourRecords.confidentiality, 'normal'));
      }
      // A draft is a private working copy. It must not circulate before it is reported.
      filters.push(
        or(ne(behaviourRecords.status, 'draft'), eq(behaviourRecords.createdBy, principal.userId))!,
      );
    }

    return filters;
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Behaviour categories
  // ══════════════════════════════════════════════════════════════════════════════════

  async listCategories(
    principal: Principal,
    institutionId: string,
    query: ListBehaviourCategoriesQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<BehaviourCategoryRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(behaviourCategories.institutionId, institutionId)];
      if (!query.includeArchived) filters.push(isNull(behaviourCategories.archivedAt));
      if (query.kind) filters.push(eq(behaviourCategories.kind, query.kind));
      if (query.q) {
        filters.push(
          or(
            ilike(behaviourCategories.nameEn, `%${query.q}%`),
            ilike(behaviourCategories.code, `${query.q}%`),
          )!,
        );
      }
      const where = and(...filters);

      const orderBy = parseSort(query.sort, BEHAVIOUR_CATEGORY_SORT_FIELDS, {
        field: 'sortOrder',
        direction: 'asc',
      }).map((spec) => {
        const column = CATEGORY_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(behaviourCategories)
        .where(where)
        .orderBy(...orderBy, asc(behaviourCategories.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(behaviourCategories)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async createCategory(
    principal: Principal,
    institutionId: string,
    input: CreateBehaviourCategoryInput,
  ): Promise<BehaviourCategoryRow> {
    return this.db.runInTenant(async (tx) => {
      const [duplicate] = await tx
        .select({ id: behaviourCategories.id })
        .from(behaviourCategories)
        .where(
          and(
            eq(behaviourCategories.institutionId, institutionId),
            eq(behaviourCategories.code, input.code),
            isNull(behaviourCategories.archivedAt),
          ),
        )
        .limit(1);
      if (duplicate) {
        throw new ConflictError(`A behaviour category with the code ${input.code} already exists`, {
          existingCategoryId: duplicate.id,
        });
      }

      const [created] = await tx
        .insert(behaviourCategories)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          code: input.code,
          nameEn: input.nameEn,
          nameBn: input.nameBn ?? null,
          kind: input.kind,
          defaultSeverity: input.defaultSeverity,
          defaultPoints: input.defaultPoints,
          description: input.description ?? null,
          sortOrder: input.sortOrder,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  async updateCategory(
    principal: Principal,
    institutionId: string,
    id: string,
    input: UpdateBehaviourCategoryInput,
  ): Promise<{ category: BehaviourCategoryRow; previous: Partial<BehaviourCategoryRow> }> {
    const { version, ...changes } = input;

    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(behaviourCategories)
        .where(
          and(
            eq(behaviourCategories.id, id),
            eq(behaviourCategories.institutionId, institutionId),
            isNull(behaviourCategories.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Behaviour category', id);

      // The kind is immutable and the points must keep matching it: flipping "helped a
      // classmate" into a sanction by editing its points would silently repurpose every
      // historical record of the category.
      if (changes.defaultPoints !== undefined) {
        if (existing.kind === 'positive' && changes.defaultPoints < 0) {
          throw new ValidationError('A positive behaviour cannot carry negative points', [
            { path: 'defaultPoints', message: 'Must be zero or positive for this category' },
          ]);
        }
        if (existing.kind === 'negative' && changes.defaultPoints > 0) {
          throw new ValidationError('A negative behaviour cannot carry positive points', [
            { path: 'defaultPoints', message: 'Must be zero or negative for this category' },
          ]);
        }
      }

      const [updated] = await tx
        .update(behaviourCategories)
        .set({
          ...(changes as Partial<BehaviourCategoryRow>),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(behaviourCategories.id, id), eq(behaviourCategories.version, version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This category was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      const previous: Partial<BehaviourCategoryRow> = {};
      for (const key of Object.keys(changes)) {
        const typedKey = key as keyof BehaviourCategoryRow;
        if (existing[typedKey] !== updated[typedKey]) {
          (previous as Record<string, unknown>)[key] = existing[typedKey];
        }
      }

      return { category: updated, previous };
    });
  }

  async archiveCategory(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<BehaviourCategoryRow> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(behaviourCategories)
        .where(
          and(
            eq(behaviourCategories.id, id),
            eq(behaviourCategories.institutionId, institutionId),
            isNull(behaviourCategories.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Behaviour category', id);

      const [archived] = await tx
        .update(behaviourCategories)
        .set({
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(eq(behaviourCategories.id, id))
        .returning();
      return archived!;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Behaviour records
  // ══════════════════════════════════════════════════════════════════════════════════

  async createRecord(
    principal: Principal,
    institutionId: string,
    input: CreateBehaviourRecordInput,
  ): Promise<BehaviourRecordRow> {
    // A behaviour record names its reporter as an employee — an accountability requirement,
    // not a technicality. A user without an employee record cannot report.
    if (!principal.employeeId) {
      throw new ForbiddenError(
        'discipline.records.create',
        'Only a staff member with an employee record can report behaviour',
      );
    }
    const scope = this.requireScope(principal);
    if (scope === 'own') {
      throw new ForbiddenError('discipline.records.create', 'You cannot report behaviour records');
    }

    return this.db.runInTenant(async (tx) => {
      const tenantId = principal.tenantId!;

      // The student must exist in this institution AND be within the reporter's scope: a
      // subject teacher reports only on students they actually teach. Out of scope is a 404.
      const studentScope =
        scope === 'all'
          ? sql`true`
          : this.assignedStudentExists(principal.employeeId!, students.id);
      const [student] = await tx
        .select({ id: students.id })
        .from(students)
        .where(
          and(
            eq(students.id, input.studentId),
            eq(students.institutionId, institutionId),
            isNull(students.archivedAt),
            studentScope,
          ),
        )
        .limit(1);
      if (!student) throw new NotFoundError('Student', input.studentId);

      const [category] = await tx
        .select()
        .from(behaviourCategories)
        .where(
          and(
            eq(behaviourCategories.id, input.categoryId),
            eq(behaviourCategories.institutionId, institutionId),
            isNull(behaviourCategories.archivedAt),
          ),
        )
        .limit(1);
      if (!category) throw new NotFoundError('Behaviour category', input.categoryId);

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

      if (input.occurredAtPeriodId) {
        const [period] = await tx
          .select({ id: periods.id })
          .from(periods)
          .where(
            and(
              eq(periods.id, input.occurredAtPeriodId),
              eq(periods.institutionId, institutionId),
              isNull(periods.archivedAt),
            ),
          )
          .limit(1);
        if (!period) throw new NotFoundError('Period', input.occurredAtPeriodId);
      }

      if (input.occurredOn > todayInDhaka()) {
        throw new ValidationError('An incident cannot be reported before it happens', [
          { path: 'occurredOn', message: 'Cannot be in the future' },
        ]);
      }

      const severity = input.severity ?? category.defaultSeverity;
      const points = input.points ?? category.defaultPoints;
      if (category.kind === 'positive' && points < 0) {
        throw new ValidationError('A positive behaviour cannot carry negative points', [
          { path: 'points', message: 'Must be zero or positive for this category' },
        ]);
      }
      if (category.kind === 'negative' && points > 0) {
        throw new ValidationError('A negative behaviour cannot carry positive points', [
          { path: 'points', message: 'Must be zero or negative for this category' },
        ]);
      }

      // Campus is a convenience fact taken from the current enrolment, when there is one.
      const [enrollment] = await tx
        .select({ campusId: enrollments.campusId })
        .from(enrollments)
        .where(
          and(
            eq(enrollments.studentId, input.studentId),
            eq(enrollments.status, 'active'),
            isNull(enrollments.archivedAt),
          ),
        )
        .limit(1);

      const now = new Date();
      const submit = input.submit;
      const [created] = await tx
        .insert(behaviourRecords)
        .values({
          id: uuidv7(),
          tenantId,
          institutionId,
          campusId: enrollment?.campusId ?? null,
          studentId: input.studentId,
          categoryId: input.categoryId,
          academicYearId: input.academicYearId,
          occurredOn: input.occurredOn,
          occurredAtPeriodId: input.occurredAtPeriodId ?? null,
          description: input.description,
          severity,
          points,
          reportedByEmployeeId: principal.employeeId!,
          status: submit ? 'reported' : 'draft',
          statusChangedAt: submit ? now : null,
          statusChangedBy: submit ? principal.userId : null,
          confidentiality: input.confidentiality,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  async listRecords(
    principal: Principal,
    institutionId: string,
    query: ListBehaviourRecordsQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<BehaviourRecordRow>> {
    const scope = this.requireScope(principal);

    return this.db.runInTenant(async (tx) => {
      const where = and(...this.listFilters(principal, scope, institutionId, query));

      const orderBy = parseSort(query.sort, BEHAVIOUR_RECORD_SORT_FIELDS, {
        field: 'occurredOn',
        direction: 'desc',
      }).map((spec) => {
        const column = RECORD_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(behaviourRecords)
        .where(where)
        .orderBy(...orderBy, asc(behaviourRecords.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(behaviourRecords)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  /** The complete filter set, shared verbatim between `list` and the trend report. */
  private listFilters(
    principal: Principal,
    scope: DataScope,
    institutionId: string,
    query: Partial<ListBehaviourRecordsQuery>,
  ): SQL[] {
    const filters = this.visibilityFilters(principal, scope, institutionId);

    if (query.studentId) filters.push(eq(behaviourRecords.studentId, query.studentId));
    if (query.categoryId) filters.push(eq(behaviourRecords.categoryId, query.categoryId));
    if (query.academicYearId) {
      filters.push(eq(behaviourRecords.academicYearId, query.academicYearId));
    }
    if (query.status) filters.push(eq(behaviourRecords.status, query.status));
    if (query.severity) filters.push(eq(behaviourRecords.severity, query.severity));
    if (query.occurredFrom) filters.push(gte(behaviourRecords.occurredOn, query.occurredFrom));
    if (query.occurredTo) filters.push(lte(behaviourRecords.occurredOn, query.occurredTo));
    if (query.kind) {
      filters.push(
        exists(
          this.db.raw
            .select({ one: sql`1` })
            .from(behaviourCategories)
            .where(
              and(
                eq(behaviourCategories.id, behaviourRecords.categoryId),
                eq(behaviourCategories.kind, query.kind),
              ),
            ),
        ),
      );
    }
    return filters;
  }

  /**
   * Fetch one record with its actions, notes and acknowledgements — through exactly the
   * list's visibility filter, so an out-of-scope id is a 404 (never a 403), and a guardian
   * receives only what is theirs to see: no internal notes, no not-yet-approved proposals,
   * no other guardian's acknowledgement comments.
   */
  async getRecord(
    principal: Principal,
    institutionId: string,
    id: string,
  ): Promise<
    BehaviourRecordRow & {
      actions: DisciplinaryActionRow[];
      notes: BehaviourNoteRow[];
      acknowledgements: AcknowledgementRow[];
    }
  > {
    const scope = this.requireScope(principal);

    return this.db.runInTenant(async (tx) => {
      const [record] = await tx
        .select()
        .from(behaviourRecords)
        .where(
          and(
            eq(behaviourRecords.id, id),
            ...this.visibilityFilters(principal, scope, institutionId),
          ),
        )
        .limit(1);
      if (!record) throw new NotFoundError('Behaviour record', id);

      const actionFilters: SQL[] = [
        eq(disciplinaryActions.behaviourRecordId, id),
        isNull(disciplinaryActions.archivedAt),
      ];
      if (scope === 'own') {
        // Families see decisions, not deliberations: a proposal that was never approved is
        // internal until somebody with authority approves it.
        actionFilters.push(ne(disciplinaryActions.status, 'proposed'));
      }
      const actions = await tx
        .select()
        .from(disciplinaryActions)
        .where(and(...actionFilters))
        .orderBy(asc(disciplinaryActions.decidedAt), asc(disciplinaryActions.id));

      const noteFilters: SQL[] = [
        eq(behaviourRecordNotes.behaviourRecordId, id),
        isNull(behaviourRecordNotes.archivedAt),
      ];
      if (scope === 'own') {
        noteFilters.push(eq(behaviourRecordNotes.visibility, 'shared_with_guardian'));
      }
      const notes = await tx
        .select()
        .from(behaviourRecordNotes)
        .where(and(...noteFilters))
        .orderBy(asc(behaviourRecordNotes.createdAt), asc(behaviourRecordNotes.id));

      const ackFilters: SQL[] = [
        eq(behaviourGuardianAcknowledgements.behaviourRecordId, id),
        isNull(behaviourGuardianAcknowledgements.archivedAt),
      ];
      if (scope === 'own' && principal.guardianId) {
        ackFilters.push(eq(behaviourGuardianAcknowledgements.guardianId, principal.guardianId));
      }
      const acknowledgements = await tx
        .select()
        .from(behaviourGuardianAcknowledgements)
        .where(and(...ackFilters))
        .orderBy(asc(behaviourGuardianAcknowledgements.acknowledgedAt));

      return { ...record, actions, notes, acknowledgements };
    });
  }

  /**
   * Move a record through the state machine.
   *
   * Only holders of `discipline.records.action` decide outcomes; the single exception is a
   * reporter submitting their own draft (`draft` → `reported`). An invalid move is a 409
   * naming both states. Substantiation posts the record's merit points to the ledger inside
   * the same transaction, and the audit record is written inside it too.
   */
  async transitionRecord(
    principal: Principal,
    institutionId: string,
    id: string,
    input: TransitionBehaviourRecordInput,
  ): Promise<BehaviourRecordRow> {
    const scope = this.requireScope(principal);
    const context = currentContext();

    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(behaviourRecords)
        .where(
          and(
            eq(behaviourRecords.id, id),
            ...this.visibilityFilters(principal, scope, institutionId),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Behaviour record', id);

      const mayDecide = can(principal, 'discipline.records.action', this.accessContext());
      const isOwnSubmit =
        existing.status === 'draft' &&
        input.status === 'reported' &&
        existing.createdBy === principal.userId;
      if (!mayDecide && !isOwnSubmit) {
        throw new ForbiddenError(
          'discipline.records.action',
          'Only discipline staff can decide the outcome of a behaviour record',
        );
      }

      const allowed = RECORD_TRANSITIONS[existing.status];
      if (!allowed.includes(input.status)) {
        // 409 with both state names — WorkflowStateError renders
        // "Cannot move behaviour record from <from> to <to>".
        throw new WorkflowStateError(existing.status, input.status, 'behaviour record');
      }

      const now = new Date();
      const [updated] = await tx
        .update(behaviourRecords)
        .set({
          status: input.status,
          statusChangedAt: now,
          statusChangedBy: principal.userId,
          statusReason: input.reason,
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(and(eq(behaviourRecords.id, id), eq(behaviourRecords.version, input.version)))
        .returning();
      if (!updated) {
        throw new ConflictError(
          'This record was changed by someone else while you were working. Reload and try again.',
          { expectedVersion: input.version, currentVersion: existing.version },
        );
      }

      // Substantiation is the moment the points become fact. The running total is recomputed
      // from the sum of prior entries — a sum is a fact, an increment can drift — and the
      // partial unique index on source_record_id refuses a double posting outright.
      if (input.status === 'substantiated' && existing.points !== 0) {
        const [aggregate] = await tx
          .select({ total: sql<number>`coalesce(sum(${meritPointsLedger.points}), 0)::int` })
          .from(meritPointsLedger)
          .where(
            and(
              eq(meritPointsLedger.studentId, existing.studentId),
              eq(meritPointsLedger.academicYearId, existing.academicYearId),
              isNull(meritPointsLedger.archivedAt),
            ),
          );
        await tx.insert(meritPointsLedger).values({
          id: uuidv7(),
          tenantId: existing.tenantId,
          institutionId,
          studentId: existing.studentId,
          academicYearId: existing.academicYearId,
          sourceRecordId: id,
          points: existing.points,
          runningTotal: (aggregate?.total ?? 0) + existing.points,
          createdBy: principal.userId,
        });
      }

      // The trail is part of the transaction: a decision that rolled back must not leave a
      // record saying it happened.
      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'update',
        module: 'discipline',
        resourceType: 'behaviour_record',
        resourceId: id,
        previousValue: { status: existing.status },
        newValue: {
          status: input.status,
          studentId: existing.studentId,
          points: existing.points,
          severity: existing.severity,
        },
        reason: input.reason,
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      return updated;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Notes — append-only
  // ══════════════════════════════════════════════════════════════════════════════════

  async addNote(
    principal: Principal,
    institutionId: string,
    recordId: string,
    input: AddBehaviourNoteInput,
  ): Promise<BehaviourNoteRow> {
    const scope = this.requireScope(principal);
    if (scope === 'own') {
      throw new ForbiddenError(
        'discipline.records.create',
        'Only staff can add notes to a behaviour record',
      );
    }

    return this.db.runInTenant(async (tx) => {
      const [record] = await tx
        .select({ id: behaviourRecords.id, tenantId: behaviourRecords.tenantId })
        .from(behaviourRecords)
        .where(
          and(
            eq(behaviourRecords.id, recordId),
            ...this.visibilityFilters(principal, scope, institutionId),
          ),
        )
        .limit(1);
      if (!record) throw new NotFoundError('Behaviour record', recordId);

      const [created] = await tx
        .insert(behaviourRecordNotes)
        .values({
          id: uuidv7(),
          tenantId: record.tenantId,
          institutionId,
          behaviourRecordId: recordId,
          note: input.note,
          authorUserId: principal.userId,
          visibility: input.visibility,
          createdBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Disciplinary actions
  // ══════════════════════════════════════════════════════════════════════════════════

  async proposeAction(
    principal: Principal,
    institutionId: string,
    recordId: string,
    input: ProposeDisciplinaryActionInput,
  ): Promise<DisciplinaryActionRow> {
    const scope = this.requireScope(principal);
    const context = currentContext();

    return this.db.runInTenant(async (tx) => {
      const [record] = await tx
        .select()
        .from(behaviourRecords)
        .where(
          and(
            eq(behaviourRecords.id, recordId),
            ...this.visibilityFilters(principal, scope, institutionId),
          ),
        )
        .limit(1);
      if (!record) throw new NotFoundError('Behaviour record', recordId);

      if (!ACTIONABLE_RECORD_STATUSES.includes(record.status)) {
        throw new ConflictError(
          `A disciplinary action cannot be proposed while the record is ${record.status}`,
          { recordStatus: record.status },
        );
      }

      const now = new Date();
      const [created] = await tx
        .insert(disciplinaryActions)
        .values({
          id: uuidv7(),
          tenantId: record.tenantId,
          institutionId,
          behaviourRecordId: recordId,
          actionType: input.actionType,
          startsOn: input.startsOn ?? null,
          endsOn: input.endsOn ?? null,
          details: input.details,
          decidedBy: principal.userId,
          decidedAt: now,
          status: 'proposed',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'create',
        module: 'discipline',
        resourceType: 'disciplinary_action',
        resourceId: created!.id,
        newValue: {
          behaviourRecordId: recordId,
          actionType: input.actionType,
          startsOn: input.startsOn ?? null,
          endsOn: input.endsOn ?? null,
          status: 'proposed',
        },
        reason: input.reason,
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      return created!;
    });
  }

  /**
   * Approve a proposed action.
   *
   * THE due-process rule of this module: a severe action — suspension or a recommendation
   * of expulsion — must be approved by someone other than the person who decided it. The
   * check is on *identity*, not permission, so an owner holding every permission still
   * cannot put their own suspension into effect. The database restates the same rule as
   * `disciplinary_actions_severe_distinct_approver`.
   */
  async approveAction(
    principal: Principal,
    institutionId: string,
    actionId: string,
    reason: string,
    version: number,
  ): Promise<DisciplinaryActionRow> {
    const context = currentContext();

    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(disciplinaryActions)
        .where(
          and(
            eq(disciplinaryActions.id, actionId),
            eq(disciplinaryActions.institutionId, institutionId),
            isNull(disciplinaryActions.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Disciplinary action', actionId);

      if (existing.status !== 'proposed') {
        throw new WorkflowStateError(existing.status, 'approved', 'disciplinary action');
      }

      if (SEVERE_ACTION_TYPES.has(existing.actionType) && existing.decidedBy === principal.userId) {
        throw new ConflictError(
          'A suspension or an expulsion recommendation must be approved by someone other than the person who decided it.',
          { actionType: existing.actionType },
        );
      }

      // The status an approved action lands in follows the calendar: already over means
      // completed, started (or undated) means active, in the future means approved-waiting.
      const today = todayInDhaka();
      let nextStatus: DisciplinaryActionRow['status'];
      if (existing.endsOn && existing.endsOn < today) nextStatus = 'completed';
      else if (!existing.startsOn || existing.startsOn <= today) nextStatus = 'active';
      else nextStatus = 'approved';

      const now = new Date();
      const [updated] = await tx
        .update(disciplinaryActions)
        .set({
          status: nextStatus,
          approvedBy: principal.userId,
          approvedAt: now,
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(and(eq(disciplinaryActions.id, actionId), eq(disciplinaryActions.version, version)))
        .returning();
      if (!updated) {
        throw new ConflictError(
          'This action was changed by someone else while you were working. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'approve',
        module: 'discipline',
        resourceType: 'disciplinary_action',
        resourceId: actionId,
        previousValue: { status: 'proposed' },
        newValue: {
          status: nextStatus,
          actionType: existing.actionType,
          behaviourRecordId: existing.behaviourRecordId,
          decidedBy: existing.decidedBy,
          approvedBy: principal.userId,
        },
        reason,
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      return updated;
    });
  }

  /** Revoke a proposed, approved or active action. Never a deletion — the row stays. */
  async revokeAction(
    principal: Principal,
    institutionId: string,
    actionId: string,
    reason: string,
    version: number,
  ): Promise<DisciplinaryActionRow> {
    const context = currentContext();

    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(disciplinaryActions)
        .where(
          and(
            eq(disciplinaryActions.id, actionId),
            eq(disciplinaryActions.institutionId, institutionId),
            isNull(disciplinaryActions.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Disciplinary action', actionId);

      if (!['proposed', 'approved', 'active'].includes(existing.status)) {
        throw new WorkflowStateError(existing.status, 'revoked', 'disciplinary action');
      }

      const now = new Date();
      const [updated] = await tx
        .update(disciplinaryActions)
        .set({
          status: 'revoked',
          revokedReason: reason,
          revokedBy: principal.userId,
          revokedAt: now,
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(and(eq(disciplinaryActions.id, actionId), eq(disciplinaryActions.version, version)))
        .returning();
      if (!updated) {
        throw new ConflictError(
          'This action was changed by someone else while you were working. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'update',
        module: 'discipline',
        resourceType: 'disciplinary_action',
        resourceId: actionId,
        previousValue: { status: existing.status },
        newValue: {
          status: 'revoked',
          actionType: existing.actionType,
          behaviourRecordId: existing.behaviourRecordId,
        },
        reason,
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      return updated;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Guardian acknowledgement
  // ══════════════════════════════════════════════════════════════════════════════════

  async acknowledge(
    principal: Principal,
    institutionId: string,
    recordId: string,
    input: AcknowledgeBehaviourRecordInput,
  ): Promise<AcknowledgementRow> {
    const guardianId = principal.guardianId;
    if (!guardianId) {
      throw new ForbiddenError(
        'students.view.own',
        'Only a guardian can acknowledge a behaviour record',
      );
    }

    return this.db.runInTenant(async (tx) => {
      // Visible under exactly the guardian gates: own child, portal enabled, not restricted,
      // and substantiated or carrying an approved action. Anything else is a 404.
      const [record] = await tx
        .select({ id: behaviourRecords.id, tenantId: behaviourRecords.tenantId })
        .from(behaviourRecords)
        .where(
          and(
            eq(behaviourRecords.id, recordId),
            eq(behaviourRecords.institutionId, institutionId),
            isNull(behaviourRecords.archivedAt),
            this.guardianLinkExists(guardianId, behaviourRecords.studentId),
            eq(behaviourRecords.confidentiality, 'normal'),
            or(eq(behaviourRecords.status, 'substantiated'), this.approvedActionExists())!,
          ),
        )
        .limit(1);
      if (!record) throw new NotFoundError('Behaviour record', recordId);

      const [already] = await tx
        .select({ id: behaviourGuardianAcknowledgements.id })
        .from(behaviourGuardianAcknowledgements)
        .where(
          and(
            eq(behaviourGuardianAcknowledgements.behaviourRecordId, recordId),
            eq(behaviourGuardianAcknowledgements.guardianId, guardianId),
            isNull(behaviourGuardianAcknowledgements.archivedAt),
          ),
        )
        .limit(1);
      if (already) {
        throw new ConflictError('You have already acknowledged this record');
      }

      const [created] = await tx
        .insert(behaviourGuardianAcknowledgements)
        .values({
          id: uuidv7(),
          tenantId: record.tenantId,
          institutionId,
          behaviourRecordId: recordId,
          guardianId,
          acknowledgedAt: new Date(),
          comment: input.comment ?? null,
          createdBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Reports
  // ══════════════════════════════════════════════════════════════════════════════════

  /**
   * A guardian's summary of their own children's behaviour — counts and points over exactly
   * the records the guardian could open, so the summary can never disclose a record the
   * detail view would hide (restricted, unsubstantiated, another family's).
   */
  async myChildrenSummary(
    principal: Principal,
    institutionId: string,
    query: { academicYearId?: string },
  ): Promise<
    Array<{
      studentId: string;
      fullNameEn: string;
      fullNameBn: string | null;
      recordCount: number;
      positiveCount: number;
      negativeCount: number;
      meritPoints: number;
      lastOccurredOn: string | null;
    }>
  > {
    const guardianId = principal.guardianId;
    if (!guardianId) {
      throw new ForbiddenError('students.view.own', 'Only a guardian can view a children summary');
    }

    return this.db.runInTenant(async (tx) => {
      const children = await tx
        .select({
          studentId: students.id,
          fullNameEn: students.fullNameEn,
          fullNameBn: students.fullNameBn,
        })
        .from(students)
        .where(
          and(
            eq(students.institutionId, institutionId),
            isNull(students.archivedAt),
            this.guardianLinkExists(guardianId, students.id),
          ),
        )
        .orderBy(asc(students.fullNameEn));

      const visible: SQL[] = [
        eq(behaviourRecords.institutionId, institutionId),
        isNull(behaviourRecords.archivedAt),
        this.guardianLinkExists(guardianId, behaviourRecords.studentId),
        eq(behaviourRecords.confidentiality, 'normal'),
        or(eq(behaviourRecords.status, 'substantiated'), this.approvedActionExists())!,
      ];
      if (query.academicYearId) {
        visible.push(eq(behaviourRecords.academicYearId, query.academicYearId));
      }

      const aggregates = await tx
        .select({
          studentId: behaviourRecords.studentId,
          recordCount: sql<number>`count(*)::int`,
          positiveCount: sql<number>`coalesce(sum(case when ${behaviourRecords.points} > 0 then 1 else 0 end), 0)::int`,
          negativeCount: sql<number>`coalesce(sum(case when ${behaviourRecords.points} < 0 then 1 else 0 end), 0)::int`,
          meritPoints: sql<number>`coalesce(sum(${behaviourRecords.points}), 0)::int`,
          lastOccurredOn: sql<string | null>`max(${behaviourRecords.occurredOn})::text`,
        })
        .from(behaviourRecords)
        .where(and(...visible))
        .groupBy(behaviourRecords.studentId);

      const byStudent = new Map(aggregates.map((row) => [row.studentId, row]));
      return children.map((child) => {
        const found = byStudent.get(child.studentId);
        return {
          studentId: child.studentId,
          fullNameEn: child.fullNameEn,
          fullNameBn: child.fullNameBn,
          recordCount: found?.recordCount ?? 0,
          positiveCount: found?.positiveCount ?? 0,
          negativeCount: found?.negativeCount ?? 0,
          meritPoints: found?.meritPoints ?? 0,
          lastOccurredOn: found?.lastOccurredOn ?? null,
        };
      });
    });
  }

  /**
   * The merit leaderboard for one section: POSITIVE ledger entries only, computed in SQL.
   *
   * The product never publishes a negative ranking of children — the query aggregates only
   * entries with `points > 0`, so a student's sanctions cannot drag them into a public
   * bottom-of-the-table, and a student with no positive points simply does not appear.
   */
  async meritLeaderboard(
    principal: Principal,
    institutionId: string,
    query: { sectionId: string; academicYearId: string; limit: number },
  ): Promise<{
    sectionId: string;
    academicYearId: string;
    entries: Array<{
      rank: number;
      studentId: string;
      fullNameEn: string;
      rollNumber: string;
      points: number;
    }>;
  }> {
    return this.db.runInTenant(async (tx) => {
      const [section] = await tx
        .select({ id: sections.id })
        .from(sections)
        .where(
          and(
            eq(sections.id, query.sectionId),
            eq(sections.institutionId, institutionId),
            isNull(sections.archivedAt),
          ),
        )
        .limit(1);
      if (!section) throw new NotFoundError('Section', query.sectionId);

      const positivePoints = sql<number>`sum(${meritPointsLedger.points})::int`;
      const rows = await tx
        .select({
          studentId: meritPointsLedger.studentId,
          fullNameEn: students.fullNameEn,
          rollNumber: enrollments.rollNumber,
          points: positivePoints,
        })
        .from(meritPointsLedger)
        .innerJoin(students, eq(students.id, meritPointsLedger.studentId))
        .innerJoin(
          enrollments,
          and(
            eq(enrollments.studentId, meritPointsLedger.studentId),
            eq(enrollments.academicYearId, meritPointsLedger.academicYearId),
            eq(enrollments.sectionId, query.sectionId),
            eq(enrollments.status, 'active'),
            isNull(enrollments.archivedAt),
          ),
        )
        .where(
          and(
            eq(meritPointsLedger.institutionId, institutionId),
            eq(meritPointsLedger.academicYearId, query.academicYearId),
            gt(meritPointsLedger.points, 0),
            isNull(meritPointsLedger.archivedAt),
          ),
        )
        .groupBy(meritPointsLedger.studentId, students.fullNameEn, enrollments.rollNumber)
        .orderBy(desc(sql`sum(${meritPointsLedger.points})`), asc(students.fullNameEn))
        .limit(query.limit);

      return {
        sectionId: query.sectionId,
        academicYearId: query.academicYearId,
        entries: rows.map((row, index) => ({ rank: index + 1, ...row })),
      };
    });
  }

  /**
   * Incident trends, computed in SQL and filtered through the caller's own visibility — a
   * teacher's trend covers only their assigned students, exactly like their list. Drafts
   * (not yet reported) and withdrawn allegations are excluded: neither is an incident the
   * school stands behind.
   */
  async incidentTrends(
    principal: Principal,
    institutionId: string,
    query: BehaviourTrendQuery,
  ): Promise<{
    groupBy: 'month' | 'category' | 'severity';
    rows: Array<Record<string, unknown>>;
  }> {
    const scope = this.requireScope(principal);

    return this.db.runInTenant(async (tx) => {
      const filters = this.listFilters(principal, scope, institutionId, {
        academicYearId: query.academicYearId,
        occurredFrom: query.occurredFrom,
        occurredTo: query.occurredTo,
      });
      filters.push(ne(behaviourRecords.status, 'draft'), ne(behaviourRecords.status, 'withdrawn'));
      const where = and(...filters);

      const total = sql<number>`count(*)::int`;
      const positive = sql<number>`coalesce(sum(case when ${behaviourRecords.points} > 0 then 1 else 0 end), 0)::int`;
      const negative = sql<number>`coalesce(sum(case when ${behaviourRecords.points} < 0 then 1 else 0 end), 0)::int`;

      if (query.groupBy === 'severity') {
        const rows = await tx
          .select({ severity: behaviourRecords.severity, total, positive, negative })
          .from(behaviourRecords)
          .where(where)
          .groupBy(behaviourRecords.severity)
          .orderBy(asc(behaviourRecords.severity));
        return { groupBy: query.groupBy, rows };
      }

      if (query.groupBy === 'category') {
        const rows = await tx
          .select({
            categoryId: behaviourCategories.id,
            code: behaviourCategories.code,
            nameEn: behaviourCategories.nameEn,
            kind: behaviourCategories.kind,
            total,
            positive,
            negative,
          })
          .from(behaviourRecords)
          .innerJoin(behaviourCategories, eq(behaviourCategories.id, behaviourRecords.categoryId))
          .where(where)
          .groupBy(
            behaviourCategories.id,
            behaviourCategories.code,
            behaviourCategories.nameEn,
            behaviourCategories.kind,
          )
          .orderBy(desc(total), asc(behaviourCategories.code));
        return { groupBy: query.groupBy, rows };
      }

      const bucket = sql<string>`to_char(date_trunc('month', ${behaviourRecords.occurredOn}::timestamp), 'YYYY-MM')`;
      const rows = await tx
        .select({ month: bucket, total, positive, negative })
        .from(behaviourRecords)
        .where(where)
        .groupBy(bucket)
        .orderBy(bucket);
      return { groupBy: query.groupBy, rows };
    });
  }
}

const CATEGORY_COLUMNS = {
  code: behaviourCategories.code,
  nameEn: behaviourCategories.nameEn,
  kind: behaviourCategories.kind,
  defaultSeverity: behaviourCategories.defaultSeverity,
  sortOrder: behaviourCategories.sortOrder,
  createdAt: behaviourCategories.createdAt,
} as const;

const RECORD_COLUMNS = {
  occurredOn: behaviourRecords.occurredOn,
  severity: behaviourRecords.severity,
  status: behaviourRecords.status,
  createdAt: behaviourRecords.createdAt,
} as const;
