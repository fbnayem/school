/**
 * Leave management (Phase 21).
 *
 * The rules this file keeps absolutely, each of them restated in migration 0027 so a bug
 * here fails the write instead of corrupting an entitlement:
 *
 *  1. **An applicant never approves their own leave.** Approvals travel through the workflow
 *     engine, whose `assertMayDecide` refuses the initiator before any permission is
 *     consulted (docs/08, KI-002). This service adds the second half the engine cannot know
 *     about: when HR files an application *for* an employee, that employee is still the
 *     applicant, and `assertNotOwnLeave` refuses them. The database refuses both cases as
 *     well, via the `leave_applications_no_self_approval` trigger.
 *  2. **Days are exact decimal in tenths, never floats.** Every arithmetic step happens in
 *     integer tenths of a day and is formatted back to a `numeric(5, 1)` string exactly
 *     once, at the edge.
 *  3. **A working day is computed, not assumed.** Weekends come from
 *     `academic_years.weekend_days`, holidays from `calendar_events`, and
 *     `holiday_overrides` beats both — a make-up Saturday is a working day even though it is
 *     a weekend and even if a holiday event covers it.
 *  4. **The balance moves only inside the approving or reversing transaction**, and it never
 *     goes below zero unless `leave_types.allow_negative_balance` says it may.
 *  5. **Approved leave reflects into the existing attendance tables in the same transaction
 *     as the approval**, so the register and payroll cannot disagree. Nothing is duplicated:
 *     the reflection writes `employee_attendance` / `student_attendance` rows, supersedes
 *     any row it replaces by archiving it (never deleting), and restores them on reversal.
 *  6. **Nothing is hard-deleted.** Withdrawal and cancellation are statuses; leave types and
 *     holiday overrides are archived.
 *
 * Two boundaries are worth stating because they shape the code:
 *
 *  - **The approval chain is the workflow engine's, not this module's.** This service starts
 *    a request, registers an outcome handler, and calls `approve` / `reject` / `cancel`. It
 *    contains no notion of steps, approvers or four-eyes.
 *  - **Student visibility is `StudentsService`'s.** Guardians see their own children because
 *    `StudentsService.assertVisible` and `scopeFilterSql` say so — there is deliberately no
 *    second scoping rule in this file.
 */

import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  academicYears,
  attendanceSessions,
  calendarEvents,
  employeeAttendance,
  employees,
  enrollments,
  holidayOverrides,
  leaveApplicationDocuments,
  leaveApplications,
  leaveBalances,
  leaveEncashments,
  leaveTypes,
  studentAttendance,
  students,
} from '@shikkha/db';
import {
  buildOffsetPage,
  calendarDate,
  ConflictError,
  daysBetween,
  eachDay,
  dhakaWeekday,
  ForbiddenError,
  InternalError,
  Money,
  NotFoundError,
  offsetOf,
  parseSort,
  uuidv7,
  ValidationError,
  WorkflowStateError,
  type CalendarDate,
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
  LEAVE_APPLICATION_SORT_FIELDS,
  LEAVE_BALANCE_SORT_FIELDS,
  LEAVE_ENCASHMENT_SORT_FIELDS,
  LEAVE_TYPE_SORT_FIELDS,
  type AdjustLeaveBalanceInput,
  type ApplyForLeaveInput,
  type CreateHolidayOverrideInput,
  type CreateLeaveEncashmentInput,
  type CreateLeaveTypeInput,
  type LeaveCalendarQuery,
  type LeaveLiabilityQuery,
  type ListHolidayOverridesQuery,
  type ListLeaveApplicationsQuery,
  type ListLeaveBalancesQuery,
  type ListLeaveEncashmentsQuery,
  type ListLeaveTypesQuery,
  type UpdateHolidayOverrideInput,
  type UpdateLeaveTypeInput,
} from '@shikkha/validation';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';
import { StudentsService } from '../students/students.service';
import { WorkflowService, type WorkflowOutcome } from '../workflow/workflow.service';
import { currentContext, currentPrincipal } from '../../common/context/request-context';

/** The transaction handle `runInTenant` hands to its callback. */
type Tx = Parameters<Parameters<DatabaseService['runInTenant']>[0]>[0];

type LeaveTypeRow = typeof leaveTypes.$inferSelect;
type LeaveBalanceRow = typeof leaveBalances.$inferSelect;
type LeaveApplicationRow = typeof leaveApplications.$inferSelect;
type LeaveDocumentRow = typeof leaveApplicationDocuments.$inferSelect;
type LeaveEncashmentRow = typeof leaveEncashments.$inferSelect;
type HolidayOverrideRow = typeof holidayOverrides.$inferSelect;

/**
 * The workflow definition this module drives. A school creates it once through the workflow
 * module's own endpoints (`POST /workflows/definitions`) with this key and this entity type;
 * `assertWorkflowConfigured` refuses an application with a message naming both, rather than
 * letting a request start that nothing could ever decide.
 */
export const LEAVE_WORKFLOW_KEY = 'leave_approval';
export const LEAVE_WORKFLOW_ENTITY_TYPE = 'leave_application';

/** Uploaded file, as multer presents it. Mirrors `StudentDocumentsService.UploadedFileLike`. */
export interface UploadedLeaveDocument {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const ALLOWED_DOCUMENT_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);

/** A leave longer than this is a sabbatical handled as a contract change, not a leave form. */
const MAX_LEAVE_SPAN_DAYS = 366;

// ─────────────────────────────────────────────────────────────────────────────────────
// Exact decimal days
//
// Every day count in this module is carried as an integer number of tenths and formatted to
// a `numeric(5, 1)` string exactly once. `0.1 + 0.2` is 3 tenths here, and 0.30000000000000004
// nowhere.
// ─────────────────────────────────────────────────────────────────────────────────────

const TENTHS_PATTERN = /^(-?)(\d+)(?:\.(\d))?$/;

function parseTenths(value: string, field: string): number {
  const match = TENTHS_PATTERN.exec(value.trim());
  if (!match) {
    throw new ValidationError('That is not a valid number of days', [
      { path: field, message: 'Use a number with at most one decimal place, for example 2.5' },
    ]);
  }
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 10 + Number(match[3] ?? '0'));
}

function formatTenths(tenths: number): string {
  const sign = tenths < 0 ? '-' : '';
  const magnitude = Math.abs(tenths);
  return `${sign}${Math.trunc(magnitude / 10)}.${magnitude % 10}`;
}

@Injectable()
export class LeaveService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly workflow: WorkflowService,
    private readonly studentsService: StudentsService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Register the outcome callback once at startup. The engine invokes it **inside the
   * deciding transaction**, which is what makes "approved, balance charged, attendance
   * written" a single atomic fact — and what lets this handler veto a decision by throwing.
   */
  onModuleInit(): void {
    this.workflow.registerOutcomeHandler({
      entityType: LEAVE_WORKFLOW_ENTITY_TYPE,
      onOutcome: (tx, outcome) => this.onWorkflowOutcome(tx, outcome),
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  // Leave types
  // ═══════════════════════════════════════════════════════════════════════════════════

  async listTypes(
    institutionId: string,
    query: ListLeaveTypesQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<LeaveTypeRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(leaveTypes.institutionId, institutionId)];
      if (!query.includeArchived) filters.push(isNull(leaveTypes.archivedAt));
      if (query.appliesTo) filters.push(eq(leaveTypes.appliesTo, query.appliesTo));
      if (query.status) filters.push(eq(leaveTypes.status, query.status));
      if (query.q) filters.push(sql`${leaveTypes.nameEn} ilike ${`%${query.q}%`}`);

      const where = and(...filters);
      const orderBy = parseSort(query.sort, LEAVE_TYPE_SORT_FIELDS, {
        field: 'code',
        direction: 'asc',
      }).map((spec) => {
        const column = LEAVE_TYPE_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(leaveTypes)
        .where(where)
        .orderBy(...orderBy, asc(leaveTypes.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(leaveTypes)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async getType(institutionId: string, id: string): Promise<LeaveTypeRow> {
    return this.db.runInTenant((tx) => this.loadType(tx, institutionId, id, { active: false }));
  }

  async createType(
    principal: Principal,
    institutionId: string,
    input: CreateLeaveTypeInput,
  ): Promise<LeaveTypeRow> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select({ id: leaveTypes.id })
        .from(leaveTypes)
        .where(
          and(
            eq(leaveTypes.institutionId, institutionId),
            eq(leaveTypes.code, input.code),
            isNull(leaveTypes.archivedAt),
          ),
        )
        .limit(1);
      if (existing) {
        throw new ConflictError(`A leave type with the code "${input.code}" already exists.`, {
          existingLeaveTypeId: existing.id,
        });
      }

      const [created] = await tx
        .insert(leaveTypes)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          code: input.code,
          nameEn: input.name,
          nameBn: input.nameBn ?? null,
          appliesTo: input.appliesTo,
          isPaid: input.isPaid,
          requiresDocument: input.requiresDocument,
          maxConsecutiveDays: input.maxConsecutiveDays ?? null,
          annualQuotaDays: formatTenths(parseTenths(input.annualQuotaDays, 'annualQuotaDays')),
          carryForwardDays: formatTenths(parseTenths(input.carryForwardDays, 'carryForwardDays')),
          accrual: input.accrual,
          genderRestriction: input.genderRestriction,
          allowNegativeBalance: input.allowNegativeBalance,
          status: input.status,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      if (!created) throw new ConflictError('The leave type could not be created');
      return created;
    });
  }

  async updateType(
    principal: Principal,
    institutionId: string,
    id: string,
    input: UpdateLeaveTypeInput,
  ): Promise<{ leaveType: LeaveTypeRow; previous: Record<string, unknown> }> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadType(tx, institutionId, id, { active: false });
      if (existing.version !== input.version) {
        throw new ConflictError(
          'This leave type was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: input.version, currentVersion: existing.version },
        );
      }

      const changes: Partial<typeof leaveTypes.$inferInsert> = {};
      const previous: Record<string, unknown> = {};

      if (input.name !== undefined) {
        previous['nameEn'] = existing.nameEn;
        changes.nameEn = input.name;
      }
      if (input.nameBn !== undefined) {
        previous['nameBn'] = existing.nameBn;
        changes.nameBn = input.nameBn;
      }
      if (input.appliesTo !== undefined) {
        previous['appliesTo'] = existing.appliesTo;
        changes.appliesTo = input.appliesTo;
      }
      if (input.isPaid !== undefined) {
        previous['isPaid'] = existing.isPaid;
        changes.isPaid = input.isPaid;
      }
      if (input.requiresDocument !== undefined) {
        previous['requiresDocument'] = existing.requiresDocument;
        changes.requiresDocument = input.requiresDocument;
      }
      if (input.maxConsecutiveDays !== undefined) {
        previous['maxConsecutiveDays'] = existing.maxConsecutiveDays;
        changes.maxConsecutiveDays = input.maxConsecutiveDays;
      }
      if (input.annualQuotaDays !== undefined) {
        previous['annualQuotaDays'] = existing.annualQuotaDays;
        changes.annualQuotaDays = formatTenths(
          parseTenths(input.annualQuotaDays, 'annualQuotaDays'),
        );
      }
      if (input.carryForwardDays !== undefined) {
        previous['carryForwardDays'] = existing.carryForwardDays;
        changes.carryForwardDays = formatTenths(
          parseTenths(input.carryForwardDays, 'carryForwardDays'),
        );
      }
      if (input.accrual !== undefined) {
        previous['accrual'] = existing.accrual;
        changes.accrual = input.accrual;
      }
      if (input.genderRestriction !== undefined) {
        previous['genderRestriction'] = existing.genderRestriction;
        changes.genderRestriction = input.genderRestriction;
      }
      if (input.allowNegativeBalance !== undefined) {
        previous['allowNegativeBalance'] = existing.allowNegativeBalance;
        changes.allowNegativeBalance = input.allowNegativeBalance;
      }
      if (input.status !== undefined) {
        previous['status'] = existing.status;
        changes.status = input.status;
      }

      const [updated] = await tx
        .update(leaveTypes)
        .set({ ...changes, version: existing.version + 1, updatedBy: principal.userId })
        .where(and(eq(leaveTypes.id, id), eq(leaveTypes.version, existing.version)))
        .returning();
      if (!updated) {
        throw new ConflictError(
          'This leave type was changed by someone else while you were editing. Reload and try again.',
        );
      }
      return { leaveType: updated, previous };
    });
  }

  /** Archived, never deleted: applications and balances reference the policy that produced them. */
  async archiveType(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<LeaveTypeRow> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadType(tx, institutionId, id, { active: false });

      const [open] = await tx
        .select({ id: leaveApplications.id })
        .from(leaveApplications)
        .where(
          and(
            eq(leaveApplications.leaveTypeId, existing.id),
            inArray(leaveApplications.status, ['draft', 'submitted']),
            isNull(leaveApplications.archivedAt),
          ),
        )
        .limit(1);
      if (open) {
        throw new ConflictError(
          'This leave type still has applications awaiting a decision. Decide them first, ' +
            'or set the type inactive to stop new applications while the open ones finish.',
          { openApplicationId: open.id },
        );
      }

      const [archived] = await tx
        .update(leaveTypes)
        .set({
          status: 'inactive',
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(leaveTypes.id, id))
        .returning();
      if (!archived) throw new ConflictError('The leave type could not be archived');
      return archived;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  // Balances
  // ═══════════════════════════════════════════════════════════════════════════════════

  async listBalances(
    principal: Principal,
    institutionId: string,
    query: ListLeaveBalancesQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<LeaveBalanceRow>> {
    const scope = this.requireLeaveScope(principal, institutionId);

    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [
        eq(leaveBalances.institutionId, institutionId),
        this.balanceScopeFilter(principal, scope),
      ];
      if (!query.includeArchived) filters.push(isNull(leaveBalances.archivedAt));
      if (query.leaveTypeId) filters.push(eq(leaveBalances.leaveTypeId, query.leaveTypeId));
      if (query.employeeId) filters.push(eq(leaveBalances.employeeId, query.employeeId));
      if (query.studentId) filters.push(eq(leaveBalances.studentId, query.studentId));
      if (query.academicYearId) {
        filters.push(eq(leaveBalances.academicYearId, query.academicYearId));
      }

      const where = and(...filters);
      const orderBy = parseSort(query.sort, LEAVE_BALANCE_SORT_FIELDS, {
        field: 'createdAt',
        direction: 'desc',
      }).map((spec) =>
        spec.direction === 'desc' ? desc(leaveBalances.createdAt) : asc(leaveBalances.createdAt),
      );

      const rows = await tx
        .select()
        .from(leaveBalances)
        .where(where)
        .orderBy(...orderBy, asc(leaveBalances.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(leaveBalances)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async getBalance(
    principal: Principal,
    institutionId: string,
    id: string,
  ): Promise<LeaveBalanceRow & { availableDays: string }> {
    const scope = this.requireLeaveScope(principal, institutionId);

    const row = await this.db.runInTenant(async (tx) => {
      const [found] = await tx
        .select()
        .from(leaveBalances)
        .where(
          and(
            eq(leaveBalances.id, id),
            eq(leaveBalances.institutionId, institutionId),
            this.balanceScopeFilter(principal, scope),
          ),
        )
        .limit(1);
      return found ?? null;
    });
    // 404 rather than 403 for a balance in another tenant or outside the caller's scope:
    // confirming it exists is itself a leak.
    if (!row) throw new NotFoundError('Leave balance', id);
    return { ...row, availableDays: formatTenths(this.availableTenths(row)) };
  }

  /**
   * Grant or correct an entitlement.
   *
   * `used_days` is deliberately untouchable here: it moves only inside the approval and
   * reversal transactions. The audit record is written inside this transaction (the route
   * therefore carries `recordedBy: 'service'`), because "who changed whose entitlement, from
   * what, to what, and why" is the whole point of the endpoint.
   */
  async adjustBalance(
    principal: Principal,
    institutionId: string,
    input: AdjustLeaveBalanceInput,
  ): Promise<LeaveBalanceRow> {
    const context = currentContext();

    return this.db.runInTenant(async (tx) => {
      const type = await this.loadType(tx, institutionId, input.leaveTypeId, { active: false });
      const holder = await this.resolveHolder(tx, institutionId, {
        employeeId: input.employeeId,
        studentId: input.studentId,
      });
      await this.assertAcademicYear(tx, institutionId, input.academicYearId);

      const existing = await this.findBalance(tx, {
        leaveTypeId: type.id,
        employeeId: holder.employeeId,
        studentId: holder.studentId,
        academicYearId: input.academicYearId,
      });

      const entitled =
        input.entitledDays !== undefined
          ? parseTenths(input.entitledDays, 'entitledDays')
          : existing
            ? parseTenths(existing.entitledDays, 'entitledDays')
            : 0;
      const carried =
        input.carriedDays !== undefined
          ? parseTenths(input.carriedDays, 'carriedDays')
          : existing
            ? parseTenths(existing.carriedDays, 'carriedDays')
            : 0;

      const previous = existing
        ? { entitledDays: existing.entitledDays, carriedDays: existing.carriedDays }
        : null;

      let saved: LeaveBalanceRow;
      if (existing) {
        const [row] = await tx
          .update(leaveBalances)
          .set({
            entitledDays: formatTenths(entitled),
            carriedDays: formatTenths(carried),
            version: existing.version + 1,
            updatedBy: principal.userId,
          })
          .where(
            and(eq(leaveBalances.id, existing.id), eq(leaveBalances.version, existing.version)),
          )
          .returning();
        if (!row) {
          throw new ConflictError(
            'This balance was changed by someone else while you were editing. Reload and try again.',
          );
        }
        saved = row;
      } else {
        const [row] = await tx
          .insert(leaveBalances)
          .values({
            id: uuidv7(),
            tenantId: principal.tenantId!,
            institutionId,
            leaveTypeId: type.id,
            employeeId: holder.employeeId,
            studentId: holder.studentId,
            academicYearId: input.academicYearId,
            entitledDays: formatTenths(entitled),
            usedDays: '0.0',
            carriedDays: formatTenths(carried),
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning();
        if (!row) throw new ConflictError('The leave balance could not be created');
        saved = row;
      }

      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'update',
        module: 'leave',
        resourceType: 'leave_balance',
        resourceId: saved.id,
        resourceLabel: `${type.code} — ${holder.label}`,
        previousValue: previous,
        newValue: { entitledDays: saved.entitledDays, carriedDays: saved.carriedDays },
        reason: input.reason,
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      return saved;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  // Applications
  // ═══════════════════════════════════════════════════════════════════════════════════

  /**
   * File an application. It is created as a **draft**: documents attach to a draft, and
   * `submit` is the act that reserves the dates and starts the approval chain. That split is
   * what makes `requires_document` enforceable — there is no moment at which a type that
   * demands a medical certificate can be submitted without one.
   */
  async apply(
    principal: Principal,
    institutionId: string,
    input: ApplyForLeaveInput,
  ): Promise<LeaveApplicationRow & { workingDays: string[] }> {
    const from = calendarDate(input.fromDate);
    const to = calendarDate(input.toDate);

    if (daysBetween(from, to) + 1 > MAX_LEAVE_SPAN_DAYS) {
      throw new ValidationError('That leave range is too long', [
        {
          path: 'toDate',
          message: `Leave may span at most ${MAX_LEAVE_SPAN_DAYS} days. A longer absence is a contract change.`,
        },
      ]);
    }

    // Student visibility is resolved before the transaction, through StudentsService, so a
    // guardian applying for a child who is not theirs gets the same 404 the student
    // endpoints give — and there is only one rule deciding it.
    if (input.studentId) await this.studentsService.assertVisible(principal, input.studentId);

    return this.db.runInTenant(async (tx) => {
      const type = await this.loadType(tx, institutionId, input.leaveTypeId, { active: true });
      const holder = await this.resolveApplicant(principal, tx, institutionId, input);

      if (holder.kind === 'employee' && type.appliesTo === 'student') {
        throw new ValidationError('This leave type is for students', [
          { path: 'leaveTypeId', message: `"${type.nameEn}" cannot be taken by staff` },
        ]);
      }
      if (holder.kind === 'student' && type.appliesTo === 'employee') {
        throw new ValidationError('This leave type is for staff', [
          { path: 'leaveTypeId', message: `"${type.nameEn}" cannot be taken by students` },
        ]);
      }

      this.assertGenderEligible(type, holder.gender);

      const year = await this.academicYearFor(tx, institutionId, from);
      const workingDays = await this.workingDays(tx, institutionId, from, to);

      const tenths = input.isHalfDay ? (workingDays.length > 0 ? 5 : 0) : workingDays.length * 10;
      if (tenths <= 0) {
        throw new ValidationError('That range contains no working days', [
          {
            path: 'fromDate',
            message:
              'Every day in the range is a weekend, a holiday or closed by an override, ' +
              'so there is nothing to apply for.',
          },
        ]);
      }
      if (type.maxConsecutiveDays !== null && tenths > type.maxConsecutiveDays * 10) {
        throw new ValidationError('That is longer than this leave type allows', [
          {
            path: 'toDate',
            message: `"${type.nameEn}" allows at most ${type.maxConsecutiveDays} working days at a time; this is ${formatTenths(tenths)}.`,
          },
        ]);
      }

      const [created] = await tx
        .insert(leaveApplications)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          leaveTypeId: type.id,
          academicYearId: year.id,
          employeeId: holder.employeeId,
          studentId: holder.studentId,
          fromDate: from,
          toDate: to,
          days: formatTenths(tenths),
          isHalfDay: input.isHalfDay,
          halfDayPeriod: input.halfDayPeriod ?? null,
          reason: input.reason,
          contactDuringLeave: input.contactDuringLeave ?? null,
          status: 'draft',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      if (!created) throw new ConflictError('The leave application could not be created');

      return { ...created, workingDays: [...workingDays] };
    });
  }

  /**
   * Submit a draft: reserve the dates and hand the decision to the workflow engine.
   *
   * The engine owns its own transaction, so this cannot be one atomic write. The order is
   * chosen so that every partial failure is recoverable: the request is started first, and
   * if stamping it onto the application then fails, the request is cancelled again. A
   * request left pending against a draft is refused by the outcome handler anyway, because
   * it checks the application is still `submitted` before acting.
   */
  async submit(
    principal: Principal,
    institutionId: string,
    id: string,
  ): Promise<LeaveApplicationRow> {
    const prepared = await this.db.runInTenant(async (tx) => {
      const application = await this.loadApplication(tx, institutionId, id);
      this.assertMayActAsApplicant(principal, application);

      if (application.status !== 'draft') {
        throw new WorkflowStateError(application.status, 'submitted', 'leave application');
      }

      const type = await this.loadType(tx, institutionId, application.leaveTypeId, {
        active: true,
      });

      // The database refuses an overlap at COMMIT, through the deferred
      // `leave_applications_no_overlap` trigger. This is the same rule stated early, so the
      // applicant gets a 409 naming the clashing dates instead of a constraint violation.
      await this.assertNoOverlap(tx, application);

      if (type.requiresDocument) {
        const [document] = await tx
          .select({ id: leaveApplicationDocuments.id })
          .from(leaveApplicationDocuments)
          .where(
            and(
              eq(leaveApplicationDocuments.applicationId, application.id),
              isNull(leaveApplicationDocuments.archivedAt),
            ),
          )
          .limit(1);
        if (!document) {
          throw new ValidationError('This leave type requires supporting evidence', [
            {
              path: 'documents',
              message: `Attach at least one document before submitting "${type.nameEn}" leave.`,
            },
          ]);
        }
      }

      // Fail early on an overdraft the approval would refuse anyway. The authoritative check
      // is in `chargeBalance`, inside the approving transaction.
      if (!type.allowNegativeBalance) {
        const balance = await this.findBalance(tx, {
          leaveTypeId: type.id,
          employeeId: application.employeeId,
          studentId: application.studentId,
          academicYearId: application.academicYearId,
        });
        const available = balance
          ? this.availableTenths(balance)
          : parseTenths(type.annualQuotaDays, 'annualQuotaDays');
        const wanted = parseTenths(application.days, 'days');
        if (wanted > available) {
          throw new ConflictError(
            `This request is for ${formatTenths(wanted)} days but only ` +
              `${formatTenths(available)} remain on the "${type.nameEn}" balance, ` +
              `and this leave type does not allow a negative balance.`,
            { requestedDays: formatTenths(wanted), availableDays: formatTenths(available) },
          );
        }
      }

      return { application, type };
    });

    const summary = `${prepared.type.nameEn}: ${prepared.application.fromDate} to ${prepared.application.toDate}`;
    await this.assertWorkflowConfigured(principal);

    const request = await this.workflow.startWorkflow(principal, institutionId, {
      definitionKey: LEAVE_WORKFLOW_KEY,
      entityId: prepared.application.id,
      summary,
      payload: {
        leaveTypeCode: prepared.type.code,
        days: prepared.application.days,
        fromDate: prepared.application.fromDate,
        toDate: prepared.application.toDate,
        isHalfDay: prepared.application.isHalfDay,
      },
    });

    try {
      return await this.db.runInTenant(async (tx) => {
        const [updated] = await tx
          .update(leaveApplications)
          .set({
            status: 'submitted',
            workflowRequestId: request.id,
            version: prepared.application.version + 1,
            updatedBy: principal.userId,
          })
          .where(
            and(
              eq(leaveApplications.id, prepared.application.id),
              eq(leaveApplications.version, prepared.application.version),
            ),
          )
          .returning();
        if (!updated) {
          throw new ConflictError(
            'This application was changed by someone else while you were submitting it. Reload and try again.',
          );
        }
        return updated;
      });
    } catch (error) {
      // Compensate: an approval request pointing at an application that never left draft
      // would block every later submission of the same application.
      await this.cancelWorkflowQuietly(
        principal,
        request.id,
        'Submission failed; the approval request is cancelled automatically.',
      );
      throw error;
    }
  }

  async listApplications(
    principal: Principal,
    institutionId: string,
    query: ListLeaveApplicationsQuery,
    page: OffsetPageRequest,
    options: { view: 'scoped' | 'mine' | 'team' } = { view: 'scoped' },
  ): Promise<OffsetPage<LeaveApplicationRow>> {
    const scope = this.requireLeaveScope(principal, institutionId);

    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(leaveApplications.institutionId, institutionId)];
      if (!query.includeArchived) filters.push(isNull(leaveApplications.archivedAt));

      if (options.view === 'mine') {
        filters.push(this.ownApplicationFilter(principal));
      } else if (options.view === 'team') {
        // An approver's queue: everything awaiting a decision except their own, which they
        // could not decide anyway.
        filters.push(eq(leaveApplications.status, 'submitted'));
        filters.push(this.notOwnApplicationFilter(principal));
      } else {
        filters.push(this.applicationScopeFilter(principal, scope));
      }

      if (query.status) filters.push(eq(leaveApplications.status, query.status));
      if (query.leaveTypeId) filters.push(eq(leaveApplications.leaveTypeId, query.leaveTypeId));
      if (query.employeeId) filters.push(eq(leaveApplications.employeeId, query.employeeId));
      if (query.studentId) filters.push(eq(leaveApplications.studentId, query.studentId));
      if (query.from) filters.push(gte(leaveApplications.toDate, query.from));
      if (query.to) filters.push(lte(leaveApplications.fromDate, query.to));
      if (query.q) filters.push(sql`${leaveApplications.reason} ilike ${`%${query.q}%`}`);

      const where = and(...filters);
      const orderBy = parseSort(query.sort, LEAVE_APPLICATION_SORT_FIELDS, {
        field: 'fromDate',
        direction: 'desc',
      }).map((spec) => {
        const column = LEAVE_APPLICATION_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(leaveApplications)
        .where(where)
        .orderBy(...orderBy, asc(leaveApplications.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(leaveApplications)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async getApplication(
    principal: Principal,
    institutionId: string,
    id: string,
  ): Promise<LeaveApplicationRow & { documents: LeaveDocumentRow[] }> {
    const scope = this.requireLeaveScope(principal, institutionId);

    return this.db.runInTenant(async (tx) => {
      const application = await this.loadVisibleApplication(
        tx,
        principal,
        scope,
        institutionId,
        id,
      );
      const documents = await tx
        .select()
        .from(leaveApplicationDocuments)
        .where(
          and(
            eq(leaveApplicationDocuments.applicationId, application.id),
            isNull(leaveApplicationDocuments.archivedAt),
          ),
        )
        .orderBy(asc(leaveApplicationDocuments.createdAt));
      return { ...application, documents };
    });
  }

  /**
   * Approve, through the workflow engine.
   *
   * Three independent refusals stand between an applicant and their own approval, and all
   * three are needed:
   *   1. `assertNotOwnLeave` here — catches the employee whose leave HR filed for them.
   *   2. `WorkflowService.assertMayDecide` — catches the initiator, before any permission.
   *   3. the `leave_applications_no_self_approval` trigger — catches raw SQL.
   */
  async approve(
    principal: Principal,
    institutionId: string,
    id: string,
    comment: string | undefined,
  ): Promise<LeaveApplicationRow & { documents: LeaveDocumentRow[] }> {
    const application = await this.db.runInTenant((tx) =>
      this.loadApplication(tx, institutionId, id),
    );
    this.assertNotOwnLeave(principal, application);
    const requestId = this.requireWorkflowRequest(application);

    await this.workflow.approve(principal, requestId, { comment });
    // Read back unscoped: having just decided it, the approver is entitled to see it even if
    // their own data scope is narrower than `leave.requests.view.all`.
    return this.applicationWithDocuments(institutionId, id);
  }

  async reject(
    principal: Principal,
    institutionId: string,
    id: string,
    comment: string,
  ): Promise<LeaveApplicationRow & { documents: LeaveDocumentRow[] }> {
    const application = await this.db.runInTenant((tx) =>
      this.loadApplication(tx, institutionId, id),
    );
    this.assertNotOwnLeave(principal, application);
    const requestId = this.requireWorkflowRequest(application);

    await this.workflow.reject(principal, requestId, { comment });
    return this.applicationWithDocuments(institutionId, id);
  }

  private async applicationWithDocuments(
    institutionId: string,
    id: string,
  ): Promise<LeaveApplicationRow & { documents: LeaveDocumentRow[] }> {
    return this.db.runInTenant(async (tx) => {
      const application = await this.loadApplication(tx, institutionId, id);
      const documents = await tx
        .select()
        .from(leaveApplicationDocuments)
        .where(
          and(
            eq(leaveApplicationDocuments.applicationId, application.id),
            isNull(leaveApplicationDocuments.archivedAt),
          ),
        )
        .orderBy(asc(leaveApplicationDocuments.createdAt));
      return { ...application, documents };
    });
  }

  /** The applicant's own retraction. A withdrawn application is a status, never a deletion. */
  async withdraw(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<LeaveApplicationRow> {
    return this.terminate(principal, institutionId, id, reason, 'withdrawn');
  }

  /** An approver stopping leave that was already granted. Also never a deletion. */
  async cancel(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<LeaveApplicationRow> {
    return this.terminate(principal, institutionId, id, reason, 'cancelled');
  }

  private async terminate(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
    target: 'withdrawn' | 'cancelled',
  ): Promise<LeaveApplicationRow> {
    const context = currentContext();

    const application = await this.db.runInTenant((tx) =>
      this.loadApplication(tx, institutionId, id),
    );

    if (target === 'withdrawn') {
      this.assertMayActAsApplicant(principal, application);
    } else if (
      !can(principal, 'leave.requests.approve', { institutionId }) &&
      !this.isApplicant(principal, application)
    ) {
      throw new ForbiddenError(
        'leave.requests.approve',
        'Only an approver, or the person the leave is for, can cancel approved leave',
      );
    }

    if (!['draft', 'submitted', 'approved'].includes(application.status)) {
      throw new WorkflowStateError(application.status, target, 'leave application');
    }

    // The approval chain is stopped first: retrying after a failure here finds the request
    // already terminal, which `cancelWorkflowQuietly` tolerates.
    if (application.status === 'submitted' && application.workflowRequestId) {
      await this.cancelWorkflowQuietly(principal, application.workflowRequestId, reason);
    }

    return this.db.runInTenant(async (tx) => {
      const current = await this.loadApplication(tx, institutionId, id);
      if (current.version !== application.version) {
        throw new ConflictError(
          'This application changed while you were acting on it. Reload and try again.',
        );
      }

      if (current.status === 'approved') {
        const type = await this.loadType(tx, institutionId, current.leaveTypeId, {
          active: false,
        });
        await this.chargeBalance(
          tx,
          current,
          type,
          principal.userId,
          -parseTenths(current.days, 'days'),
        );
        await this.revertAttendance(tx, current, principal.userId);
      }

      const [updated] = await tx
        .update(leaveApplications)
        .set({
          status: target,
          decisionNote: reason,
          version: current.version + 1,
          updatedBy: principal.userId,
        })
        .where(
          and(eq(leaveApplications.id, current.id), eq(leaveApplications.version, current.version)),
        )
        .returning();
      if (!updated) {
        throw new ConflictError(
          'This application changed while you were acting on it. Reload and try again.',
        );
      }

      await this.audit.recordInTransaction(tx, {
        tenantId: current.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'update',
        module: 'leave',
        resourceType: 'leave_application',
        resourceId: current.id,
        resourceLabel: `${current.fromDate} to ${current.toDate}`,
        previousValue: { status: current.status, days: current.days },
        newValue: { status: target },
        reason,
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      return updated;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  // Workflow outcome — the atomic half
  // ═══════════════════════════════════════════════════════════════════════════════════

  /**
   * Runs **inside the engine's deciding transaction**. Everything an approval means happens
   * here, or none of it does: the status change, the balance charge, the attendance
   * reflection and the audit record commit together, and a throw vetoes the decision.
   */
  private async onWorkflowOutcome(tx: Tx, outcome: WorkflowOutcome): Promise<void> {
    const actor = currentPrincipal();
    if (!actor) {
      throw new InternalError('A leave decision arrived with no authenticated principal');
    }
    const context = currentContext();

    const [application] = await tx
      .select()
      .from(leaveApplications)
      .where(eq(leaveApplications.id, outcome.entityId))
      .limit(1);
    if (!application) {
      throw new InternalError(
        `Workflow request ${outcome.requestId} decided a leave application that no longer exists`,
        { applicationId: outcome.entityId },
      );
    }
    if (application.status !== 'submitted') {
      throw new WorkflowStateError(application.status, outcome.status, 'leave application');
    }

    // Belt and braces alongside the engine's own initiator check: HR may have filed this for
    // the employee, in which case the engine's initiator is HR and the applicant is not.
    this.assertNotOwnLeave(actor, application);

    const now = new Date();
    const decisionNote = outcome.status === 'approved' ? 'Approved' : 'Rejected';

    if (outcome.status === 'approved') {
      const type = await this.loadType(tx, application.institutionId, application.leaveTypeId, {
        active: false,
      });
      await this.chargeBalance(
        tx,
        application,
        type,
        actor.userId,
        parseTenths(application.days, 'days'),
      );
      await this.reflectAttendance(tx, application, actor.userId);
    }

    const [updated] = await tx
      .update(leaveApplications)
      .set({
        status: outcome.status,
        decidedBy: actor.userId,
        decidedAt: now,
        decisionNote,
        version: application.version + 1,
        updatedBy: actor.userId,
      })
      .where(
        and(
          eq(leaveApplications.id, application.id),
          eq(leaveApplications.version, application.version),
        ),
      )
      .returning();
    if (!updated) {
      throw new ConflictError(
        'This application changed while it was being decided. Reload and try again.',
      );
    }

    await this.audit.recordInTransaction(tx, {
      tenantId: application.tenantId,
      institutionId: application.institutionId,
      actorUserId: actor.userId,
      actorRoles: actor.roles.map((role) => role.roleKey),
      action: outcome.status === 'approved' ? 'approve' : 'reject',
      module: 'leave',
      resourceType: 'leave_application',
      resourceId: application.id,
      resourceLabel: `${application.fromDate} to ${application.toDate}`,
      previousValue: { status: application.status },
      newValue: { status: outcome.status, days: application.days },
      reason: null,
      requestId: context?.requestId ?? null,
      ipAddress: context?.ipAddress ?? null,
      userAgent: context?.userAgent ?? null,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  // Documents
  // ═══════════════════════════════════════════════════════════════════════════════════

  async uploadDocument(
    principal: Principal,
    institutionId: string,
    applicationId: string,
    file: UploadedLeaveDocument,
  ): Promise<LeaveDocumentRow> {
    if (!file || !file.buffer || file.size === 0) {
      throw new ValidationError('No file was uploaded', [
        { path: 'file', message: 'Attach the document as the "file" field' },
      ]);
    }
    if (file.size > MAX_DOCUMENT_BYTES) {
      throw new ValidationError('The file is too large', [
        { path: 'file', message: 'Documents may be at most 5 MB' },
      ]);
    }
    if (!ALLOWED_DOCUMENT_MIME_TYPES.has(file.mimetype)) {
      throw new ValidationError('That file type is not accepted', [
        { path: 'file', message: 'Attach a JPEG, PNG, WebP or PDF' },
      ]);
    }

    const application = await this.db.runInTenant((tx) =>
      this.loadApplication(tx, institutionId, applicationId),
    );
    this.assertMayActAsApplicant(principal, application);
    if (!['draft', 'submitted'].includes(application.status)) {
      throw new WorkflowStateError(application.status, 'draft', 'leave application');
    }

    const stored = await this.storage.put({
      tenantId: principal.tenantId!,
      category: 'leave-documents',
      filename: file.originalname,
      contentType: file.mimetype,
      body: file.buffer,
    });

    return this.db.runInTenant(async (tx) => {
      const [created] = await tx
        .insert(leaveApplicationDocuments)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          applicationId: application.id,
          storageKey: stored.key,
          fileName: file.originalname.slice(0, 255),
          mimeType: file.mimetype,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      if (!created) throw new ConflictError('The document could not be recorded');
      return created;
    });
  }

  async listDocuments(
    principal: Principal,
    institutionId: string,
    applicationId: string,
  ): Promise<LeaveDocumentRow[]> {
    const scope = this.requireLeaveScope(principal, institutionId);
    return this.db.runInTenant(async (tx) => {
      const application = await this.loadVisibleApplication(
        tx,
        principal,
        scope,
        institutionId,
        applicationId,
      );
      return tx
        .select()
        .from(leaveApplicationDocuments)
        .where(
          and(
            eq(leaveApplicationDocuments.applicationId, application.id),
            isNull(leaveApplicationDocuments.archivedAt),
          ),
        )
        .orderBy(asc(leaveApplicationDocuments.createdAt));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  // Encashment
  // ═══════════════════════════════════════════════════════════════════════════════════

  async listEncashments(
    principal: Principal,
    institutionId: string,
    query: ListLeaveEncashmentsQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<LeaveEncashmentRow>> {
    const scope = this.requireLeaveScope(principal, institutionId);

    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [
        eq(leaveEncashments.institutionId, institutionId),
        isNull(leaveEncashments.archivedAt),
      ];
      if (scope !== 'all') {
        filters.push(
          principal.employeeId
            ? eq(leaveEncashments.employeeId, principal.employeeId)
            : sql`false`,
        );
      }
      if (query.status) filters.push(eq(leaveEncashments.status, query.status));
      if (query.employeeId) filters.push(eq(leaveEncashments.employeeId, query.employeeId));
      if (query.academicYearId) {
        filters.push(eq(leaveEncashments.academicYearId, query.academicYearId));
      }

      const where = and(...filters);
      const orderBy = parseSort(query.sort, LEAVE_ENCASHMENT_SORT_FIELDS, {
        field: 'createdAt',
        direction: 'desc',
      }).map((spec) => {
        const column = LEAVE_ENCASHMENT_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(leaveEncashments)
        .where(where)
        .orderBy(...orderBy, asc(leaveEncashments.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(leaveEncashments)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async requestEncashment(
    principal: Principal,
    institutionId: string,
    input: CreateLeaveEncashmentInput,
  ): Promise<LeaveEncashmentRow> {
    const days = parseTenths(input.days, 'days');
    if (days <= 0) {
      throw new ValidationError('An encashment must be for at least a tenth of a day', [
        { path: 'days', message: 'Enter a positive number of days' },
      ]);
    }
    // `Money` is the only parser for the amount — it never becomes a JavaScript number.
    const amount = Money.fromDecimalString(input.amount);

    return this.db.runInTenant(async (tx) => {
      const type = await this.loadType(tx, institutionId, input.leaveTypeId, { active: true });
      const holder = await this.resolveHolder(tx, institutionId, {
        employeeId: input.employeeId,
      });
      await this.assertAcademicYear(tx, institutionId, input.academicYearId);

      if (
        holder.employeeId !== principal.employeeId &&
        !can(principal, 'leave.requests.view.all', { institutionId })
      ) {
        throw new ForbiddenError(
          'leave.requests.view.all',
          'You can only request encashment of your own leave',
        );
      }

      const balance = await this.findBalance(tx, {
        leaveTypeId: type.id,
        employeeId: holder.employeeId,
        studentId: null,
        academicYearId: input.academicYearId,
      });
      const available = balance ? this.availableTenths(balance) : 0;
      if (days > available) {
        throw new ConflictError(
          `Only ${formatTenths(available)} days of "${type.nameEn}" remain; ` +
            `${formatTenths(days)} cannot be encashed.`,
          { availableDays: formatTenths(available), requestedDays: formatTenths(days) },
        );
      }

      const [created] = await tx
        .insert(leaveEncashments)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          employeeId: holder.employeeId!,
          leaveTypeId: type.id,
          academicYearId: input.academicYearId,
          days: formatTenths(days),
          amount: amount.toDecimalString(),
          status: 'pending',
          requestedBy: principal.userId,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      if (!created) throw new ConflictError('The encashment request could not be created');
      return created;
    });
  }

  /**
   * Approve or reject an encashment. The requester can never be the decider — refused here
   * for a clear 403, and refused again by the `leave_encashments_no_self_approval` CHECK so
   * raw SQL cannot do it either.
   */
  async decideEncashment(
    principal: Principal,
    institutionId: string,
    id: string,
    decision: 'approve' | 'reject',
    reason: string,
    version: number,
  ): Promise<LeaveEncashmentRow> {
    const context = currentContext();

    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(leaveEncashments)
        .where(
          and(
            eq(leaveEncashments.id, id),
            eq(leaveEncashments.institutionId, institutionId),
            isNull(leaveEncashments.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Leave encashment', id);

      if (existing.status !== 'pending') {
        throw new WorkflowStateError(existing.status, decision, 'leave encashment');
      }
      if (existing.version !== version) {
        throw new ConflictError(
          'This encashment changed while you were deciding it. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }
      if (existing.requestedBy === principal.userId) {
        throw new ForbiddenError(
          undefined,
          'You may not decide an encashment you requested. It needs a second person, ' +
            'regardless of the permissions you hold.',
        );
      }

      const employeeUserId = await this.employeeUserId(tx, existing.employeeId);
      if (employeeUserId && employeeUserId === principal.userId) {
        throw new ForbiddenError(
          undefined,
          'You may not decide the encashment of your own leave balance.',
        );
      }

      if (decision === 'approve') {
        const type = await this.loadType(tx, institutionId, existing.leaveTypeId, {
          active: false,
        });
        const balance = await this.findBalance(tx, {
          leaveTypeId: existing.leaveTypeId,
          employeeId: existing.employeeId,
          studentId: null,
          academicYearId: existing.academicYearId,
        });
        if (!balance) {
          throw new ConflictError(
            'There is no balance to encash for this employee, leave type and year.',
          );
        }
        await this.writeBalanceUsage(
          tx,
          balance,
          type,
          principal.userId,
          parseTenths(existing.days, 'days'),
        );
      }

      const [updated] = await tx
        .update(leaveEncashments)
        .set({
          status: decision === 'approve' ? 'approved' : 'rejected',
          approvedBy: principal.userId,
          decidedAt: new Date(),
          decisionNote: reason,
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(
          and(eq(leaveEncashments.id, id), eq(leaveEncashments.version, existing.version)),
        )
        .returning();
      if (!updated) {
        throw new ConflictError(
          'This encashment changed while you were deciding it. Reload and try again.',
        );
      }

      await this.audit.recordInTransaction(tx, {
        tenantId: existing.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: decision === 'approve' ? 'approve' : 'reject',
        module: 'leave',
        resourceType: 'leave_encashment',
        resourceId: existing.id,
        resourceLabel: `${existing.days} days`,
        previousValue: { status: existing.status },
        newValue: { status: updated.status, amount: updated.amount },
        reason,
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      return updated;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  // Holiday overrides
  // ═══════════════════════════════════════════════════════════════════════════════════

  async listHolidayOverrides(
    institutionId: string,
    query: ListHolidayOverridesQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<HolidayOverrideRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(holidayOverrides.institutionId, institutionId)];
      if (!query.includeArchived) filters.push(isNull(holidayOverrides.archivedAt));
      if (query.from) filters.push(gte(holidayOverrides.date, query.from));
      if (query.to) filters.push(lte(holidayOverrides.date, query.to));

      const where = and(...filters);
      const rows = await tx
        .select()
        .from(holidayOverrides)
        .where(where)
        .orderBy(asc(holidayOverrides.date), asc(holidayOverrides.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(holidayOverrides)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async createHolidayOverride(
    principal: Principal,
    institutionId: string,
    input: CreateHolidayOverrideInput,
  ): Promise<HolidayOverrideRow> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select({ id: holidayOverrides.id })
        .from(holidayOverrides)
        .where(
          and(
            eq(holidayOverrides.institutionId, institutionId),
            eq(holidayOverrides.date, input.date),
            isNull(holidayOverrides.archivedAt),
          ),
        )
        .limit(1);
      if (existing) {
        throw new ConflictError(`${input.date} already has an override. Edit it instead.`, {
          existingOverrideId: existing.id,
        });
      }

      const [created] = await tx
        .insert(holidayOverrides)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          date: input.date,
          isWorkingDay: input.isWorkingDay,
          note: input.note ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      if (!created) throw new ConflictError('The holiday override could not be created');
      return created;
    });
  }

  async updateHolidayOverride(
    principal: Principal,
    institutionId: string,
    id: string,
    input: UpdateHolidayOverrideInput,
  ): Promise<{ override: HolidayOverrideRow; previous: Record<string, unknown> }> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(holidayOverrides)
        .where(
          and(
            eq(holidayOverrides.id, id),
            eq(holidayOverrides.institutionId, institutionId),
            isNull(holidayOverrides.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Holiday override', id);
      if (existing.version !== input.version) {
        throw new ConflictError(
          'This override was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: input.version, currentVersion: existing.version },
        );
      }

      const previous: Record<string, unknown> = {};
      const changes: Partial<typeof holidayOverrides.$inferInsert> = {};
      if (input.isWorkingDay !== undefined) {
        previous['isWorkingDay'] = existing.isWorkingDay;
        changes.isWorkingDay = input.isWorkingDay;
      }
      if (input.note !== undefined) {
        previous['note'] = existing.note;
        changes.note = input.note;
      }

      const [updated] = await tx
        .update(holidayOverrides)
        .set({ ...changes, version: existing.version + 1, updatedBy: principal.userId })
        .where(
          and(eq(holidayOverrides.id, id), eq(holidayOverrides.version, existing.version)),
        )
        .returning();
      if (!updated) {
        throw new ConflictError(
          'This override was changed by someone else while you were editing. Reload and try again.',
        );
      }
      return { override: updated, previous };
    });
  }

  async archiveHolidayOverride(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<HolidayOverrideRow> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(holidayOverrides)
        .where(
          and(
            eq(holidayOverrides.id, id),
            eq(holidayOverrides.institutionId, institutionId),
            isNull(holidayOverrides.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Holiday override', id);

      const [archived] = await tx
        .update(holidayOverrides)
        .set({
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(holidayOverrides.id, id))
        .returning();
      if (!archived) throw new ConflictError('The holiday override could not be archived');
      return archived;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  // Calendar and reports
  // ═══════════════════════════════════════════════════════════════════════════════════

  /**
   * Who is away between two dates, and which days are not working days anyway.
   *
   * Scoped exactly like the application list, so a guardian sees their children's leave and
   * an employee without `leave.requests.view.all` sees only their own.
   */
  async calendar(
    principal: Principal,
    institutionId: string,
    query: LeaveCalendarQuery,
  ): Promise<{
    from: string;
    to: string;
    nonWorkingDays: string[];
    entries: {
      applicationId: string;
      leaveTypeId: string;
      employeeId: string | null;
      studentId: string | null;
      fromDate: string;
      toDate: string;
      days: string;
      isHalfDay: boolean;
      halfDayPeriod: string | null;
      status: string;
    }[];
  }> {
    const scope = this.requireLeaveScope(principal, institutionId);
    const from = calendarDate(query.from);
    const to = calendarDate(query.to);
    if (daysBetween(from, to) + 1 > MAX_LEAVE_SPAN_DAYS) {
      throw new ValidationError('That range is too long', [
        { path: 'to', message: `Ask for at most ${MAX_LEAVE_SPAN_DAYS} days at a time` },
      ]);
    }

    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [
        eq(leaveApplications.institutionId, institutionId),
        isNull(leaveApplications.archivedAt),
        inArray(leaveApplications.status, ['submitted', 'approved']),
        gte(leaveApplications.toDate, from),
        lte(leaveApplications.fromDate, to),
        this.applicationScopeFilter(principal, scope),
      ];
      if (query.leaveTypeId) filters.push(eq(leaveApplications.leaveTypeId, query.leaveTypeId));
      if (query.employeeId) filters.push(eq(leaveApplications.employeeId, query.employeeId));
      if (query.studentId) filters.push(eq(leaveApplications.studentId, query.studentId));

      const rows = await tx
        .select({
          applicationId: leaveApplications.id,
          leaveTypeId: leaveApplications.leaveTypeId,
          employeeId: leaveApplications.employeeId,
          studentId: leaveApplications.studentId,
          fromDate: leaveApplications.fromDate,
          toDate: leaveApplications.toDate,
          days: leaveApplications.days,
          isHalfDay: leaveApplications.isHalfDay,
          halfDayPeriod: leaveApplications.halfDayPeriod,
          status: leaveApplications.status,
        })
        .from(leaveApplications)
        .where(and(...filters))
        .orderBy(asc(leaveApplications.fromDate), asc(leaveApplications.id));

      const working = new Set<string>(await this.workingDays(tx, institutionId, from, to));
      const nonWorkingDays = eachDay(from, to).filter((day) => !working.has(day));

      return { from, to, nonWorkingDays: [...nonWorkingDays], entries: rows };
    });
  }

  /**
   * Leave liability: what the institution would owe if every unused day were paid out.
   *
   * Computed in one SQL aggregate over `leave_balances` joined to the employee's open salary
   * assignment. The daily rate is `basic / daysPerMonth` in `numeric` arithmetic — no
   * floating point touches it at any point, and the rounding to two decimal places happens
   * once, per employee, before the sum.
   *
   * Employees with no open salary assignment contribute their outstanding *days* but no
   * amount; the count of them is returned rather than hidden, because a liability figure
   * that quietly excludes half the staff is worse than no figure.
   */
  async liabilityReport(
    institutionId: string,
    query: LeaveLiabilityQuery,
  ): Promise<{
    daysPerMonth: number;
    rows: {
      leaveTypeId: string;
      code: string;
      nameEn: string;
      holders: number;
      outstandingDays: string;
      liabilityAmount: string;
      holdersWithoutSalary: number;
    }[];
    totals: { outstandingDays: string; liabilityAmount: string };
  }> {
    return this.db.runInTenant(async (tx) => {
      const yearFilter = query.academicYearId
        ? sql`and ${leaveBalances.academicYearId} = ${query.academicYearId}`
        : sql``;
      const typeFilter = query.leaveTypeId
        ? sql`and ${leaveBalances.leaveTypeId} = ${query.leaveTypeId}`
        : sql``;

      const result = await tx.execute<{
        leave_type_id: string;
        code: string;
        name_en: string;
        holders: number;
        outstanding_days: string;
        liability_amount: string;
        holders_without_salary: number;
      }>(sql`
        with outstanding as (
          select
            ${leaveBalances.leaveTypeId} as leave_type_id,
            ${leaveBalances.employeeId} as employee_id,
            greatest(
              ${leaveBalances.entitledDays} + ${leaveBalances.carriedDays}
                - ${leaveBalances.usedDays},
              0
            ) as days,
            (
              select sa.basic
              from employee_salary_assignments sa
              where sa.employee_id = ${leaveBalances.employeeId}
                and sa.effective_to is null
                and sa.archived_at is null
              limit 1
            ) as basic
          from ${leaveBalances}
          where ${leaveBalances.institutionId} = ${institutionId}
            and ${leaveBalances.archivedAt} is null
            and ${leaveBalances.employeeId} is not null
            ${yearFilter}
            ${typeFilter}
        )
        select
          ${leaveTypes.id} as leave_type_id,
          ${leaveTypes.code} as code,
          ${leaveTypes.nameEn} as name_en,
          count(*)::int as holders,
          sum(outstanding.days)::text as outstanding_days,
          coalesce(
            sum(round(coalesce(outstanding.basic, 0) / ${query.daysPerMonth} * outstanding.days, 2)),
            0
          )::text as liability_amount,
          (count(*) filter (where outstanding.basic is null))::int as holders_without_salary
        from outstanding
        join ${leaveTypes} on ${leaveTypes.id} = outstanding.leave_type_id
        group by ${leaveTypes.id}, ${leaveTypes.code}, ${leaveTypes.nameEn}
        order by ${leaveTypes.code}
      `);

      const rows = result.rows.map((row) => ({
        leaveTypeId: row.leave_type_id,
        code: row.code,
        nameEn: row.name_en,
        holders: row.holders,
        outstandingDays: formatTenths(parseTenths(row.outstanding_days, 'outstandingDays')),
        liabilityAmount: Money.fromDecimalString(row.liability_amount).toDecimalString(),
        holdersWithoutSalary: row.holders_without_salary,
      }));

      const totalTenths = rows.reduce(
        (sum, row) => sum + parseTenths(row.outstandingDays, 'outstandingDays'),
        0,
      );
      const totalAmount = rows.reduce(
        (sum, row) => sum.plus(Money.fromDecimalString(row.liabilityAmount)),
        Money.zero(),
      );

      return {
        daysPerMonth: query.daysPerMonth,
        rows,
        totals: {
          outstandingDays: formatTenths(totalTenths),
          liabilityAmount: totalAmount.toDecimalString(),
        },
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  // Working-day arithmetic
  // ═══════════════════════════════════════════════════════════════════════════════════

  /**
   * The working days in an inclusive range, in precedence order:
   *
   *   1. a `holiday_overrides` row for the date decides outright — a make-up Saturday is a
   *      working day even though it is a weekend, and an ad-hoc closure is not a working day
   *      even though it is a Tuesday;
   *   2. otherwise a non-teaching `calendar_events` row covering the date closes it;
   *   3. otherwise an `overrides_weekend` event covering the date opens it;
   *   4. otherwise the academic year's configured weekend closes it;
   *   5. otherwise it is a working day.
   */
  private async workingDays(
    tx: Tx,
    institutionId: string,
    from: CalendarDate,
    to: CalendarDate,
  ): Promise<CalendarDate[]> {
    const [year] = await tx
      .select({ weekendDays: academicYears.weekendDays })
      .from(academicYears)
      .where(
        and(
          eq(academicYears.institutionId, institutionId),
          lte(academicYears.startDate, from),
          gte(academicYears.endDate, from),
          isNull(academicYears.archivedAt),
        ),
      )
      .limit(1);

    const configuredWeekend: unknown = year?.weekendDays;
    const weekend = new Set<number>(
      Array.isArray(configuredWeekend)
        ? configuredWeekend.filter((value): value is number => typeof value === 'number')
        : [5, 6],
    );

    const events = await tx
      .select({
        startDate: calendarEvents.startDate,
        endDate: calendarEvents.endDate,
        isNonTeaching: calendarEvents.isNonTeaching,
        overridesWeekend: calendarEvents.overridesWeekend,
      })
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.institutionId, institutionId),
          isNull(calendarEvents.archivedAt),
          lte(calendarEvents.startDate, to),
          gte(calendarEvents.endDate, from),
        ),
      );

    const overrideRows = await tx
      .select({ date: holidayOverrides.date, isWorkingDay: holidayOverrides.isWorkingDay })
      .from(holidayOverrides)
      .where(
        and(
          eq(holidayOverrides.institutionId, institutionId),
          isNull(holidayOverrides.archivedAt),
          gte(holidayOverrides.date, from),
          lte(holidayOverrides.date, to),
        ),
      );
    const overrides = new Map<string, boolean>(
      overrideRows.map((row) => [row.date, row.isWorkingDay] as [string, boolean]),
    );

    const closed = new Set<string>();
    const opened = new Set<string>();
    for (const event of events) {
      for (const day of eachDay(
        calendarDate(event.startDate < from ? from : event.startDate),
        calendarDate(event.endDate > to ? to : event.endDate),
      )) {
        if (event.isNonTeaching) closed.add(day);
        if (event.overridesWeekend) opened.add(day);
      }
    }

    return eachDay(from, to).filter((day) => {
      const override = overrides.get(day);
      if (override !== undefined) return override;
      if (closed.has(day)) return false;
      if (opened.has(day)) return true;
      return !weekend.has(dhakaWeekday(day));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  // Balance movement
  // ═══════════════════════════════════════════════════════════════════════════════════

  /**
   * Move `deltaTenths` onto (positive) or off (negative) a holder's used days, creating the
   * entitlement row from the leave type's annual quota the first time it is needed.
   *
   * Always called inside the caller's transaction, which is what makes the approval and its
   * balance effect one fact.
   */
  private async chargeBalance(
    tx: Tx,
    application: LeaveApplicationRow,
    type: LeaveTypeRow,
    actorUserId: string,
    deltaTenths: number,
  ): Promise<LeaveBalanceRow> {
    let balance = await this.findBalance(tx, {
      leaveTypeId: application.leaveTypeId,
      employeeId: application.employeeId,
      studentId: application.studentId,
      academicYearId: application.academicYearId,
    });

    if (!balance) {
      if (deltaTenths < 0) {
        throw new InternalError(
          'A leave reversal found no balance to credit back; the approval that charged it is missing.',
          { applicationId: application.id },
        );
      }
      const [created] = await tx
        .insert(leaveBalances)
        .values({
          id: uuidv7(),
          tenantId: application.tenantId,
          institutionId: application.institutionId,
          leaveTypeId: application.leaveTypeId,
          employeeId: application.employeeId,
          studentId: application.studentId,
          academicYearId: application.academicYearId,
          entitledDays: type.annualQuotaDays,
          usedDays: '0.0',
          carriedDays: '0.0',
          createdBy: actorUserId,
          updatedBy: actorUserId,
        })
        .returning();
      if (!created) throw new ConflictError('The leave balance could not be created');
      balance = created;
    }

    return this.writeBalanceUsage(tx, balance, type, actorUserId, deltaTenths);
  }

  /** The arithmetic itself, shared by leave approval and encashment approval. */
  private async writeBalanceUsage(
    tx: Tx,
    balance: LeaveBalanceRow,
    type: LeaveTypeRow,
    actorUserId: string,
    deltaTenths: number,
  ): Promise<LeaveBalanceRow> {
    const used = parseTenths(balance.usedDays, 'usedDays');
    const next = used + deltaTenths;

    if (next < 0) {
      throw new InternalError(
        'A leave reversal would drive used days below zero; the balance and the application disagree.',
        { balanceId: balance.id, usedDays: balance.usedDays, deltaTenths },
      );
    }

    const ceiling =
      parseTenths(balance.entitledDays, 'entitledDays') +
      parseTenths(balance.carriedDays, 'carriedDays');
    if (deltaTenths > 0 && !type.allowNegativeBalance && next > ceiling) {
      throw new ConflictError(
        `This would take the "${type.nameEn}" balance to ${formatTenths(ceiling - next)} days. ` +
          `Only ${formatTenths(Math.max(ceiling - used, 0))} remain, and this leave type does ` +
          `not allow a negative balance.`,
        {
          availableDays: formatTenths(Math.max(ceiling - used, 0)),
          requestedDays: formatTenths(deltaTenths),
        },
      );
    }

    const [updated] = await tx
      .update(leaveBalances)
      .set({
        usedDays: formatTenths(next),
        version: balance.version + 1,
        updatedBy: actorUserId,
      })
      .where(and(eq(leaveBalances.id, balance.id), eq(leaveBalances.version, balance.version)))
      .returning();
    if (!updated) {
      throw new ConflictError(
        'This balance changed while the decision was being applied. Reload and try again.',
      );
    }
    return updated;
  }

  private availableTenths(balance: LeaveBalanceRow): number {
    return (
      parseTenths(balance.entitledDays, 'entitledDays') +
      parseTenths(balance.carriedDays, 'carriedDays') -
      parseTenths(balance.usedDays, 'usedDays')
    );
  }

  private async findBalance(
    tx: Tx,
    key: {
      leaveTypeId: string;
      employeeId: string | null | undefined;
      studentId: string | null | undefined;
      academicYearId: string;
    },
  ): Promise<LeaveBalanceRow | null> {
    const holderFilter = key.employeeId
      ? eq(leaveBalances.employeeId, key.employeeId)
      : key.studentId
        ? eq(leaveBalances.studentId, key.studentId)
        : null;
    if (!holderFilter) return null;

    const [found] = await tx
      .select()
      .from(leaveBalances)
      .where(
        and(
          eq(leaveBalances.leaveTypeId, key.leaveTypeId),
          eq(leaveBalances.academicYearId, key.academicYearId),
          holderFilter,
          isNull(leaveBalances.archivedAt),
        ),
      )
      .limit(1);
    return found ?? null;
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  // Attendance reflection
  //
  // Approved leave is written into the *existing* attendance tables — there is no second
  // register here. A row the leave replaces is archived (never deleted) with the leave's
  // marker in `archive_reason`, and the row the leave writes carries the same marker in
  // `remarks`, so a cancellation can put things back exactly as they were.
  // ═══════════════════════════════════════════════════════════════════════════════════

  private marker(applicationId: string): string {
    return `leave:${applicationId}`;
  }

  private async reflectAttendance(
    tx: Tx,
    application: LeaveApplicationRow,
    actorUserId: string,
  ): Promise<void> {
    const days = await this.workingDays(
      tx,
      application.institutionId,
      calendarDate(application.fromDate),
      calendarDate(application.toDate),
    );
    if (days.length === 0) return;

    const marker = this.marker(application.id);
    const now = new Date();

    if (application.employeeId) {
      const [employee] = await tx
        .select({ campusId: employees.campusId })
        .from(employees)
        .where(eq(employees.id, application.employeeId))
        .limit(1);

      await tx
        .update(employeeAttendance)
        .set({
          archivedAt: now,
          archivedBy: actorUserId,
          archiveReason: marker,
          updatedBy: actorUserId,
        })
        .where(
          and(
            eq(employeeAttendance.employeeId, application.employeeId),
            inArray(employeeAttendance.attendanceDate, [...days]),
            isNull(employeeAttendance.archivedAt),
          ),
        );

      await tx.insert(employeeAttendance).values(
        days.map((day) => ({
          id: uuidv7(),
          tenantId: application.tenantId,
          institutionId: application.institutionId,
          campusId: employee?.campusId ?? null,
          employeeId: application.employeeId!,
          attendanceDate: day,
          status: application.isHalfDay ? ('half_day' as const) : ('on_leave' as const),
          source: 'manual' as const,
          remarks: marker,
          createdBy: actorUserId,
          updatedBy: actorUserId,
        })),
      );
      return;
    }

    if (!application.studentId) return;

    // A student's leave lands on the daily register of the section they are enrolled in.
    // Where the register for a date does not exist yet, there is nothing to write: the
    // teacher takes it later and marks the pupil themselves. Locked registers are left
    // alone — that is what locked means.
    const [enrollment] = await tx
      .select({ id: enrollments.id, sectionId: enrollments.sectionId })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.studentId, application.studentId),
          eq(enrollments.status, 'active'),
          isNull(enrollments.archivedAt),
        ),
      )
      .limit(1);
    if (!enrollment) return;

    const sessions = await tx
      .select({ id: attendanceSessions.id, attendanceDate: attendanceSessions.attendanceDate })
      .from(attendanceSessions)
      .where(
        and(
          eq(attendanceSessions.sectionId, enrollment.sectionId),
          isNull(attendanceSessions.periodId),
          isNull(attendanceSessions.archivedAt),
          ne(attendanceSessions.status, 'locked'),
          inArray(attendanceSessions.attendanceDate, [...days]),
        ),
      );
    if (sessions.length === 0) return;

    const sessionIds = sessions.map((session) => session.id);

    await tx
      .update(studentAttendance)
      .set({
        archivedAt: now,
        archivedBy: actorUserId,
        archiveReason: marker,
        updatedBy: actorUserId,
      })
      .where(
        and(
          eq(studentAttendance.studentId, application.studentId),
          inArray(studentAttendance.sessionId, sessionIds),
          isNull(studentAttendance.archivedAt),
        ),
      );

    await tx.insert(studentAttendance).values(
      sessions.map((session) => ({
        id: uuidv7(),
        tenantId: application.tenantId,
        institutionId: application.institutionId,
        sessionId: session.id,
        studentId: application.studentId!,
        enrollmentId: enrollment.id,
        status: application.isHalfDay ? ('half_day' as const) : ('excused' as const),
        remarks: marker,
        markedAt: now,
        markedBy: actorUserId,
        createdBy: actorUserId,
        updatedBy: actorUserId,
      })),
    );
  }

  /**
   * Undo a reflection: archive the rows the leave wrote, then un-archive the rows it
   * superseded. In that order, so the partial unique index on `(holder, date)` is free when
   * the original row comes back.
   */
  private async revertAttendance(
    tx: Tx,
    application: LeaveApplicationRow,
    actorUserId: string,
  ): Promise<void> {
    const marker = this.marker(application.id);
    const now = new Date();

    if (application.employeeId) {
      await tx
        .update(employeeAttendance)
        .set({
          archivedAt: now,
          archivedBy: actorUserId,
          archiveReason: `${marker}:reverted`,
          updatedBy: actorUserId,
        })
        .where(
          and(
            eq(employeeAttendance.employeeId, application.employeeId),
            eq(employeeAttendance.remarks, marker),
            isNull(employeeAttendance.archivedAt),
          ),
        );

      await tx
        .update(employeeAttendance)
        .set({
          archivedAt: null,
          archivedBy: null,
          archiveReason: null,
          updatedBy: actorUserId,
        })
        .where(
          and(
            eq(employeeAttendance.employeeId, application.employeeId),
            eq(employeeAttendance.archiveReason, marker),
          ),
        );
      return;
    }

    if (!application.studentId) return;

    await tx
      .update(studentAttendance)
      .set({
        archivedAt: now,
        archivedBy: actorUserId,
        archiveReason: `${marker}:reverted`,
        updatedBy: actorUserId,
      })
      .where(
        and(
          eq(studentAttendance.studentId, application.studentId),
          eq(studentAttendance.remarks, marker),
          isNull(studentAttendance.archivedAt),
        ),
      );

    await tx
      .update(studentAttendance)
      .set({
        archivedAt: null,
        archivedBy: null,
        archiveReason: null,
        updatedBy: actorUserId,
      })
      .where(
        and(
          eq(studentAttendance.studentId, application.studentId),
          eq(studentAttendance.archiveReason, marker),
        ),
      );
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  // Scoping, loading and small assertions
  // ═══════════════════════════════════════════════════════════════════════════════════

  private requireLeaveScope(principal: Principal, institutionId: string): DataScope {
    const scope = resolveDataScope(principal, SCOPED_RESOURCES.leaveRequests, { institutionId });
    if (scope === 'none') {
      throw new ForbiddenError('leave.requests.view.own', 'You cannot view leave records');
    }
    return scope;
  }

  /**
   * The scope predicate for `leave_applications`.
   *
   * Without `leave.requests.view.all`, "your leave" means exactly that: your own employee
   * record, your own children, and anything you filed. A class teacher's `students.view.assigned`
   * grant deliberately does **not** widen it — teaching a pupil is not a reason to read their
   * family's leave requests; `leave.requests.view.all` is.
   *
   * The children half is delegated to `StudentsService.scopeFilterSql` through an EXISTS, so
   * "a guardian sees their own children" is decided in exactly one place in the codebase.
   */
  private applicationScopeFilter(principal: Principal, scope: DataScope): SQL {
    if (scope === 'all') return sql`true`;

    const conditions: SQL[] = [];
    if (principal.employeeId) {
      conditions.push(eq(leaveApplications.employeeId, principal.employeeId));
    }
    const ownStudents = this.ownStudentPredicate(principal, sql`${leaveApplications.studentId}`);
    if (ownStudents) conditions.push(ownStudents);
    // Whoever filed it can always see it — a guardian who applied for a child keeps sight of
    // the application even if portal access is later narrowed.
    conditions.push(eq(leaveApplications.createdBy, principal.userId));

    return conditions.length === 1 ? conditions[0]! : or(...conditions)!;
  }

  private balanceScopeFilter(principal: Principal, scope: DataScope): SQL {
    if (scope === 'all') return sql`true`;

    const conditions: SQL[] = [];
    if (principal.employeeId) {
      conditions.push(eq(leaveBalances.employeeId, principal.employeeId));
    }
    const ownStudents = this.ownStudentPredicate(principal, sql`${leaveBalances.studentId}`);
    if (ownStudents) conditions.push(ownStudents);

    if (conditions.length === 0) return sql`false`;
    return conditions.length === 1 ? conditions[0]! : or(...conditions)!;
  }

  /**
   * `<column> references a student this principal is personally responsible for` — their own
   * children as a guardian, or themselves as a student. Expressed through the students
   * module's `own` scope filter rather than a second rule written here. Null when the
   * principal is neither a guardian nor a student.
   */
  private ownStudentPredicate(principal: Principal, column: SQL): SQL | null {
    if (!principal.guardianId && !principal.studentId) return null;
    return exists(
      this.db.raw
        .select({ one: sql`1` })
        .from(students)
        .where(
          and(
            sql`${students.id} = ${column}`,
            this.studentsService.scopeFilterSql(principal, 'own'),
          ),
        ),
    );
  }

  private ownApplicationFilter(principal: Principal): SQL {
    const conditions: SQL[] = [eq(leaveApplications.createdBy, principal.userId)];
    if (principal.employeeId) {
      conditions.push(eq(leaveApplications.employeeId, principal.employeeId));
    }
    const ownStudents = this.ownStudentPredicate(principal, sql`${leaveApplications.studentId}`);
    if (ownStudents) conditions.push(ownStudents);
    return or(...conditions)!;
  }

  private notOwnApplicationFilter(principal: Principal): SQL {
    // `ne` alone would drop rows whose `created_by` is null (a system-filed application),
    // because SQL comparison with NULL is NULL rather than true.
    const conditions: SQL[] = [
      or(
        isNull(leaveApplications.createdBy),
        ne(leaveApplications.createdBy, principal.userId),
      )!,
    ];
    if (principal.employeeId) {
      conditions.push(
        or(
          isNull(leaveApplications.employeeId),
          ne(leaveApplications.employeeId, principal.employeeId),
        )!,
      );
    }
    return and(...conditions)!;
  }

  private isApplicant(principal: Principal, application: LeaveApplicationRow): boolean {
    if (application.createdBy && application.createdBy === principal.userId) return true;
    if (!principal.employeeId || !application.employeeId) return false;
    return application.employeeId === principal.employeeId;
  }

  /** The rule this module exists for. No permission unlocks it — not even `*`. */
  private assertNotOwnLeave(principal: Principal, application: LeaveApplicationRow): void {
    if (this.isApplicant(principal, application)) {
      throw new ForbiddenError(
        undefined,
        'You may not decide your own leave. It needs a second person, regardless of the ' +
          'permissions you hold.',
      );
    }
  }

  private assertMayActAsApplicant(
    principal: Principal,
    application: LeaveApplicationRow,
  ): void {
    if (this.isApplicant(principal, application)) return;
    if (can(principal, 'leave.requests.view.all', { institutionId: application.institutionId })) {
      return;
    }
    // 404, not 403: an application that is not yours should not be confirmed to exist.
    throw new NotFoundError('Leave application', application.id);
  }

  /**
   * The service-side statement of the `leave_applications_no_overlap` trigger. Only
   * `submitted` and `approved` rows reserve a date range; a draft has not been asked for
   * yet, and a rejected, cancelled or withdrawn application is history.
   */
  private async assertNoOverlap(tx: Tx, application: LeaveApplicationRow): Promise<void> {
    const holderFilter = application.employeeId
      ? eq(leaveApplications.employeeId, application.employeeId)
      : application.studentId
        ? eq(leaveApplications.studentId, application.studentId)
        : null;
    if (!holderFilter) return;

    const [clash] = await tx
      .select({
        id: leaveApplications.id,
        fromDate: leaveApplications.fromDate,
        toDate: leaveApplications.toDate,
        status: leaveApplications.status,
      })
      .from(leaveApplications)
      .where(
        and(
          ne(leaveApplications.id, application.id),
          holderFilter,
          isNull(leaveApplications.archivedAt),
          inArray(leaveApplications.status, ['submitted', 'approved']),
          lte(leaveApplications.fromDate, application.toDate),
          gte(leaveApplications.toDate, application.fromDate),
        ),
      )
      .limit(1);

    if (clash) {
      throw new ConflictError(
        `This overlaps ${clash.status} leave from ${clash.fromDate} to ${clash.toDate}. ` +
          `Withdraw or cancel that one first.`,
        { conflictingApplicationId: clash.id },
      );
    }
  }

  private requireWorkflowRequest(application: LeaveApplicationRow): string {
    if (application.status !== 'submitted') {
      throw new WorkflowStateError(application.status, 'approved', 'leave application');
    }
    if (!application.workflowRequestId) {
      throw new ConflictError(
        'This application has no approval request attached. Submit it again to start one.',
        { applicationId: application.id },
      );
    }
    return application.workflowRequestId;
  }

  /**
   * Refuse a submission the engine could never decide, with a message that says exactly what
   * to configure. Resolved through the workflow module's own service, not by reading its
   * tables.
   */
  private async assertWorkflowConfigured(principal: Principal): Promise<void> {
    const definitions = await this.workflow.listDefinitions(
      principal,
      {
        page: 1,
        pageSize: 1,
        key: LEAVE_WORKFLOW_KEY,
        includeInactive: false,
        includeArchived: false,
      },
      { page: 1, pageSize: 1 },
    );
    const definition = definitions.data[0];
    if (!definition) {
      throw new ConflictError(
        `Leave approvals are not configured for this institution. Create an active workflow ` +
          `definition with the key "${LEAVE_WORKFLOW_KEY}" and the entity type ` +
          `"${LEAVE_WORKFLOW_ENTITY_TYPE}" before submitting leave.`,
        { definitionKey: LEAVE_WORKFLOW_KEY, entityType: LEAVE_WORKFLOW_ENTITY_TYPE },
      );
    }
    if (definition.entityType !== LEAVE_WORKFLOW_ENTITY_TYPE) {
      throw new ConflictError(
        `The "${LEAVE_WORKFLOW_KEY}" workflow is defined for entity type ` +
          `"${definition.entityType}", so leave decisions would never reach this module. ` +
          `Re-create it with the entity type "${LEAVE_WORKFLOW_ENTITY_TYPE}".`,
        { definitionKey: LEAVE_WORKFLOW_KEY, entityType: definition.entityType },
      );
    }
  }

  /** Cancel an approval request, tolerating one that is already terminal or already gone. */
  private async cancelWorkflowQuietly(
    principal: Principal,
    requestId: string,
    comment: string,
  ): Promise<void> {
    try {
      await this.workflow.cancel(principal, requestId, { comment });
    } catch (error) {
      if (error instanceof WorkflowStateError || error instanceof NotFoundError) return;
      throw error;
    }
  }

  private async loadType(
    tx: Tx,
    institutionId: string,
    id: string,
    options: { active: boolean },
  ): Promise<LeaveTypeRow> {
    const [found] = await tx
      .select()
      .from(leaveTypes)
      .where(
        and(
          eq(leaveTypes.id, id),
          eq(leaveTypes.institutionId, institutionId),
          isNull(leaveTypes.archivedAt),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundError('Leave type', id);
    if (options.active && found.status !== 'active') {
      throw new ValidationError('That leave type is no longer offered', [
        { path: 'leaveTypeId', message: `"${found.nameEn}" is inactive` },
      ]);
    }
    return found;
  }

  private async loadApplication(
    tx: Tx,
    institutionId: string,
    id: string,
  ): Promise<LeaveApplicationRow> {
    const [found] = await tx
      .select()
      .from(leaveApplications)
      .where(
        and(
          eq(leaveApplications.id, id),
          eq(leaveApplications.institutionId, institutionId),
          isNull(leaveApplications.archivedAt),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundError('Leave application', id);
    return found;
  }

  private async loadVisibleApplication(
    tx: Tx,
    principal: Principal,
    scope: DataScope,
    institutionId: string,
    id: string,
  ): Promise<LeaveApplicationRow> {
    const [found] = await tx
      .select()
      .from(leaveApplications)
      .where(
        and(
          eq(leaveApplications.id, id),
          eq(leaveApplications.institutionId, institutionId),
          isNull(leaveApplications.archivedAt),
          this.applicationScopeFilter(principal, scope),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundError('Leave application', id);
    return found;
  }

  /** Who the leave is for, and whether this principal may file it for them. */
  private async resolveApplicant(
    principal: Principal,
    tx: Tx,
    institutionId: string,
    input: ApplyForLeaveInput,
  ): Promise<{
    kind: 'employee' | 'student';
    employeeId: string | null;
    studentId: string | null;
    gender: string | null;
  }> {
    if (input.studentId) {
      const [student] = await tx
        .select({ id: students.id, gender: students.gender })
        .from(students)
        .where(
          and(
            eq(students.id, input.studentId),
            eq(students.institutionId, institutionId),
            isNull(students.archivedAt),
          ),
        )
        .limit(1);
      if (!student) throw new NotFoundError('Student', input.studentId);
      return { kind: 'student', employeeId: null, studentId: student.id, gender: student.gender };
    }

    const employeeId = input.employeeId ?? principal.employeeId ?? null;
    if (!employeeId) {
      throw new ValidationError('There is nobody to apply for', [
        {
          path: 'employeeId',
          message:
            'You have no employee record, so name the employee or the student the leave is for.',
        },
      ]);
    }
    if (
      employeeId !== principal.employeeId &&
      !can(principal, 'leave.requests.view.all', { institutionId })
    ) {
      throw new ForbiddenError(
        'leave.requests.view.all',
        'You can only apply for your own leave, or for a student you are responsible for',
      );
    }

    const [employee] = await tx
      .select({ id: employees.id, gender: employees.gender })
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
    return { kind: 'employee', employeeId: employee.id, studentId: null, gender: employee.gender };
  }

  /** For balance adjustment and encashment, where no application exists yet. */
  private async resolveHolder(
    tx: Tx,
    institutionId: string,
    input: { employeeId?: string | undefined; studentId?: string | undefined },
  ): Promise<{ employeeId: string | null; studentId: string | null; label: string }> {
    if (input.studentId) {
      const [student] = await tx
        .select({ id: students.id, name: students.fullNameEn })
        .from(students)
        .where(
          and(
            eq(students.id, input.studentId),
            eq(students.institutionId, institutionId),
            isNull(students.archivedAt),
          ),
        )
        .limit(1);
      if (!student) throw new NotFoundError('Student', input.studentId);
      return { employeeId: null, studentId: student.id, label: student.name };
    }
    if (!input.employeeId) {
      throw new ValidationError('Name the person this applies to', [
        { path: 'employeeId', message: 'Give employeeId or studentId' },
      ]);
    }
    const [employee] = await tx
      .select({ id: employees.id, name: employees.fullNameEn })
      .from(employees)
      .where(
        and(
          eq(employees.id, input.employeeId),
          eq(employees.institutionId, institutionId),
          isNull(employees.archivedAt),
        ),
      )
      .limit(1);
    if (!employee) throw new NotFoundError('Employee', input.employeeId);
    return { employeeId: employee.id, studentId: null, label: employee.name };
  }

  private async employeeUserId(tx: Tx, employeeId: string): Promise<string | null> {
    const [row] = await tx
      .select({ userId: employees.userId })
      .from(employees)
      .where(eq(employees.id, employeeId))
      .limit(1);
    return row?.userId ?? null;
  }

  private async assertAcademicYear(
    tx: Tx,
    institutionId: string,
    academicYearId: string,
  ): Promise<void> {
    const [found] = await tx
      .select({ id: academicYears.id })
      .from(academicYears)
      .where(
        and(
          eq(academicYears.id, academicYearId),
          eq(academicYears.institutionId, institutionId),
          isNull(academicYears.archivedAt),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundError('Academic year', academicYearId);
  }

  /**
   * The year a `from_date` belongs to, resolved once at creation so the approval transaction
   * never has to guess which year a December application charges.
   */
  private async academicYearFor(
    tx: Tx,
    institutionId: string,
    date: CalendarDate,
  ): Promise<{ id: string }> {
    const [found] = await tx
      .select({ id: academicYears.id })
      .from(academicYears)
      .where(
        and(
          eq(academicYears.institutionId, institutionId),
          lte(academicYears.startDate, date),
          gte(academicYears.endDate, date),
          isNull(academicYears.archivedAt),
        ),
      )
      .limit(1);
    if (!found) {
      throw new ValidationError('No academic year covers that date', [
        {
          path: 'fromDate',
          message: `${date} falls outside every academic year of this institution.`,
        },
      ]);
    }
    return found;
  }

  /** Maternity is `female`, and the refusal is a clear 422 rather than a silent skip. */
  private assertGenderEligible(type: LeaveTypeRow, gender: string | null): void {
    if (type.genderRestriction === 'any') return;
    if (gender === type.genderRestriction) return;
    throw new ValidationError(`"${type.nameEn}" is not available to this person`, [
      {
        path: 'leaveTypeId',
        message:
          `"${type.nameEn}" may only be taken by someone recorded as ` +
          `${type.genderRestriction}${gender ? `; this record says ${gender}` : ', and no gender is recorded on this record'}.`,
      },
    ]);
  }
}

const LEAVE_TYPE_COLUMNS = {
  code: leaveTypes.code,
  nameEn: leaveTypes.nameEn,
  status: leaveTypes.status,
  createdAt: leaveTypes.createdAt,
} as const;

const LEAVE_APPLICATION_COLUMNS = {
  fromDate: leaveApplications.fromDate,
  toDate: leaveApplications.toDate,
  status: leaveApplications.status,
  createdAt: leaveApplications.createdAt,
} as const;

const LEAVE_ENCASHMENT_COLUMNS = {
  status: leaveEncashments.status,
  createdAt: leaveEncashments.createdAt,
} as const;
