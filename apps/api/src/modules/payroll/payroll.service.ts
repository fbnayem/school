/**
 * Payroll service (Phase 16).
 *
 * The rules this file exists to hold, in one place:
 *
 *  1. **Every tenant query runs inside `runInTenant`**, and every read is additionally
 *     narrowed to the institution named by the `x-institution-id` header. A record in
 *     another institution — or another tenant — is a `NotFoundError`, never a 403.
 *  2. **Money is exact.** Every figure is `numeric(14, 2)` in the database, a decimal
 *     string on the wire, and a `Money` in between. Component percentages go through
 *     `Money.percentage` (the stored two-decimal percentage's minor units *are* basis
 *     points), the unpaid-leave pro-rata goes through `Money.allocate` so the parts sum
 *     exactly back to the whole, and run totals are recomputed as fresh sums over the
 *     payslips — a fact, never an incremental adjustment. There is no floating-point
 *     arithmetic on any monetary value anywhere in this file.
 *  3. **Component ordering is the HR module's.** `computeSalaryBreakdown` is imported from
 *     `hr.service` rather than reimplemented, so a payslip here and the salary preview
 *     there can never disagree: earnings in sequence order first (gross becomes known),
 *     then deductions, with `percentage_of_gross` mathematically after every earning.
 *  4. **Calculation, approval and payment are three separate acts.** The approver must be
 *     a different user than the calculator — refused here and by a database check
 *     constraint. An approved run is immutable (database trigger); corrections are an
 *     adjustment in the next run or a cancellation with a reason.
 *  5. **Marking a run paid posts one balanced journal entry** through the accounting
 *     module's `LedgerService`, inside the same transaction that flips the run to `paid`
 *     and decrements loan balances — so the run and its ledger effect commit together or
 *     not at all.
 *  6. **Salary figures are visible only with an explicit permission.** `payroll.payslips.
 *     view.all` reads anyone's slip; `payroll.payslips.view.own` reads exactly your own,
 *     and only once the run is approved. A slip outside the caller's scope is a 404.
 */

import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  designations,
  employeeAttendance,
  employees,
  employeeSalaryAssignments,
  institutions,
  loanAdvances,
  payrollAdjustments,
  payrollJournalLinks,
  payrollRuns,
  payslipLines,
  payslips,
  salaryComponents,
} from '@shikkha/db';
import {
  buildOffsetPage,
  ConflictError,
  Money,
  NotFoundError,
  offsetOf,
  parseSort,
  todayInDhaka,
  uuidv7,
  ValidationError,
  type OffsetPage,
  type OffsetPageRequest,
} from '@shikkha/shared';
import { can, type Principal } from '@shikkha/permissions';
import {
  LOAN_ADVANCE_SORT_FIELDS,
  PAYROLL_RUN_SORT_FIELDS,
  type CancelLoanAdvanceInput,
  type CreateLoanAdvanceInput,
  type CreatePayrollAdjustmentInput,
  type CreatePayrollRunInput,
  type ListLoanAdvancesQuery,
  type ListMyPayslipsQuery,
  type ListPayrollRunsQuery,
  type MarkPayrollRunPaidInput,
  type UpdateLoanAdvanceInput,
  type UpdatePayrollAdjustmentInput,
} from '@shikkha/validation';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { LedgerService, type LedgerLineInput } from '../accounting/accounting.service';
import { computeSalaryBreakdown } from '../hr/hr.service';
import { currentContext } from '../../common/context/request-context';

/** The transaction handle services pass around; identical to `runInTenant`'s callback arg. */
type Tx = Parameters<Parameters<DatabaseService['runInTenant']>[0]>[0];

type PayrollRunRow = typeof payrollRuns.$inferSelect;
type PayslipRow = typeof payslips.$inferSelect;
type PayslipLineRow = typeof payslipLines.$inferSelect;
type AdjustmentRow = typeof payrollAdjustments.$inferSelect;
type LoanRow = typeof loanAdvances.$inferSelect;

/** Payslip line about to be written, amounts still `Money` so the sums stay exact. */
interface DraftLine {
  componentId: string | null;
  loanAdvanceId: string | null;
  name: string;
  kind: 'earning' | 'deduction';
  amount: Money;
  isStatutory: boolean;
}

@Injectable()
export class PayrollService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
  ) {}

  // ── Runs ────────────────────────────────────────────────────────────────────────────

  async createRun(
    principal: Principal,
    institutionId: string,
    input: CreatePayrollRunInput,
  ): Promise<PayrollRunRow> {
    return this.db.runInTenant(async (tx) => {
      const [duplicate] = await tx
        .select({ id: payrollRuns.id, status: payrollRuns.status })
        .from(payrollRuns)
        .where(
          and(
            eq(payrollRuns.institutionId, institutionId),
            eq(payrollRuns.periodYear, input.periodYear),
            eq(payrollRuns.periodMonth, input.periodMonth),
            sql`${payrollRuns.status} <> 'cancelled'`,
            isNull(payrollRuns.archivedAt),
          ),
        )
        .limit(1);
      if (duplicate) {
        // The partial unique index is the real guarantee; this produces the friendly error.
        throw new ConflictError(
          `A payroll run for ${formatPeriod(input.periodYear, input.periodMonth)} already exists (status: ${duplicate.status}). Cancel it before starting another.`,
          { existingRunId: duplicate.id },
        );
      }

      const [run] = await tx
        .insert(payrollRuns)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          periodYear: input.periodYear,
          periodMonth: input.periodMonth,
          name: input.name ?? `Payroll ${formatPeriod(input.periodYear, input.periodMonth)}`,
          status: 'draft',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return run!;
    });
  }

  async listRuns(
    principal: Principal,
    institutionId: string,
    query: ListPayrollRunsQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<PayrollRunRow>> {
    return this.db.runInTenant(async (tx) => {
      const conditions: SQL[] = [
        eq(payrollRuns.institutionId, institutionId),
        isNull(payrollRuns.archivedAt),
      ];
      if (query.status) conditions.push(eq(payrollRuns.status, query.status));
      if (query.periodYear !== undefined) {
        conditions.push(eq(payrollRuns.periodYear, query.periodYear));
      }
      if (query.q) {
        conditions.push(sql`${payrollRuns.name} ilike ${`%${query.q}%`}`);
      }
      const where = and(...conditions);

      const orderBy = parseSort(query.sort, PAYROLL_RUN_SORT_FIELDS, {
        field: 'createdAt',
        direction: 'desc',
      }).map((spec) =>
        spec.direction === 'desc'
          ? desc(PAYROLL_RUN_COLUMNS[spec.field])
          : asc(PAYROLL_RUN_COLUMNS[spec.field]),
      );

      const rows = await tx
        .select()
        .from(payrollRuns)
        .where(where)
        .orderBy(...orderBy, asc(payrollRuns.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(payrollRuns)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async getRun(
    principal: Principal,
    institutionId: string,
    id: string,
  ): Promise<PayrollRunRow & { payslips?: Array<PayslipRow & { lines: PayslipLineRow[] }> }> {
    return this.db.runInTenant(async (tx) => {
      const run = await this.loadRun(tx, institutionId, id);

      // Salary figures per person are gated behind the explicit payslip permission; the
      // run's own totals are visible to anyone who may view runs.
      if (!can(principal, 'payroll.payslips.view.all')) {
        return run;
      }

      const slips = await tx
        .select()
        .from(payslips)
        .where(and(eq(payslips.runId, run.id), isNull(payslips.archivedAt)))
        .orderBy(asc(payslips.id));

      const slipIds = slips.map((slip) => slip.id);
      const lines =
        slipIds.length === 0
          ? []
          : await tx
              .select()
              .from(payslipLines)
              .where(
                and(inArray(payslipLines.payslipId, slipIds), isNull(payslipLines.archivedAt)),
              )
              .orderBy(asc(payslipLines.sequence), asc(payslipLines.id));

      const linesBySlip = new Map<string, PayslipLineRow[]>();
      for (const line of lines) {
        const bucket = linesBySlip.get(line.payslipId) ?? [];
        bucket.push(line);
        linesBySlip.set(line.payslipId, bucket);
      }

      return {
        ...run,
        payslips: slips.map((slip) => ({ ...slip, lines: linesBySlip.get(slip.id) ?? [] })),
      };
    });
  }

  /** First calculation: draft → calculated. Exactly once; recalculation is its own act. */
  async calculateRun(
    principal: Principal,
    institutionId: string,
    id: string,
    version: number,
  ): Promise<PayrollRunRow> {
    return this.db.runInTenant(async (tx) => {
      const run = await this.loadRun(tx, institutionId, id);
      if (run.status !== 'draft') {
        throw new ConflictError(
          `Only a draft run can be calculated; ${run.name} is ${run.status}. Use recalculate while it is not yet approved.`,
        );
      }
      return this.performCalculation(tx, principal, institutionId, run, version);
    });
  }

  /** Recompute a not-yet-approved run: the previous payslips are archived, never edited. */
  async recalculateRun(
    principal: Principal,
    institutionId: string,
    id: string,
    version: number,
  ): Promise<PayrollRunRow> {
    return this.db.runInTenant(async (tx) => {
      const run = await this.loadRun(tx, institutionId, id);
      if (run.status !== 'calculated' && run.status !== 'under_review') {
        throw new ConflictError(
          `Only a calculated or under-review run can be recalculated; ${run.name} is ${run.status}.`,
        );
      }

      const previousSlips = await tx
        .select({ id: payslips.id })
        .from(payslips)
        .where(and(eq(payslips.runId, run.id), isNull(payslips.archivedAt)));
      const previousIds = previousSlips.map((slip) => slip.id);

      if (previousIds.length > 0) {
        const archivedAt = new Date();
        await tx
          .update(payslipLines)
          .set({
            archivedAt,
            archivedBy: principal.userId,
            archiveReason: 'Superseded by recalculation',
            updatedBy: principal.userId,
          })
          .where(
            and(inArray(payslipLines.payslipId, previousIds), isNull(payslipLines.archivedAt)),
          );
        await tx
          .update(payslips)
          .set({
            archivedAt,
            archivedBy: principal.userId,
            archiveReason: 'Superseded by recalculation',
            updatedBy: principal.userId,
          })
          .where(and(inArray(payslips.id, previousIds), isNull(payslips.archivedAt)));
      }

      return this.performCalculation(tx, principal, institutionId, run, version);
    });
  }

  async submitRun(
    principal: Principal,
    institutionId: string,
    id: string,
    version: number,
  ): Promise<PayrollRunRow> {
    return this.db.runInTenant(async (tx) => {
      const run = await this.loadRun(tx, institutionId, id);
      if (run.status !== 'calculated') {
        throw new ConflictError(
          `Only a calculated run can be submitted for review; ${run.name} is ${run.status}.`,
        );
      }

      const updated = await this.transitionRun(tx, principal, run, version, {
        status: 'under_review',
      });
      await this.recordRunAudit(tx, principal, institutionId, updated, 'update', {
        previousValue: { status: run.status },
        newValue: { status: 'under_review' },
      });
      return updated;
    });
  }

  /**
   * Approval is a separate act by a separate person: the service refuses the calculator,
   * whatever permissions they hold, and the database restates the same rule as a check
   * constraint. A stale calculation — an adjustment newer than `calculated_at` — is also
   * refused, so what the approver read is what takes effect.
   */
  async approveRun(
    principal: Principal,
    institutionId: string,
    id: string,
    version: number,
  ): Promise<PayrollRunRow> {
    return this.db.runInTenant(async (tx) => {
      const run = await this.loadRun(tx, institutionId, id);
      if (run.status !== 'calculated' && run.status !== 'under_review') {
        throw new ConflictError(
          `Only a calculated or under-review run can be approved; ${run.name} is ${run.status}.`,
        );
      }
      if (run.calculatedBy === principal.userId) {
        throw new ConflictError(
          'A payroll run must be approved by someone other than the person who calculated it.',
        );
      }

      const [staleAdjustment] = await tx
        .select({ id: payrollAdjustments.id })
        .from(payrollAdjustments)
        .where(
          and(
            eq(payrollAdjustments.runId, run.id),
            sql`${payrollAdjustments.updatedAt} > ${run.calculatedAt}`,
          ),
        )
        .limit(1);
      if (staleAdjustment) {
        throw new ConflictError(
          'Adjustments changed after the last calculation; recalculate the run before approving it.',
        );
      }

      const updated = await this.transitionRun(tx, principal, run, version, {
        status: 'approved',
        approvedBy: principal.userId,
        approvedAt: new Date(),
      });
      await this.recordRunAudit(tx, principal, institutionId, updated, 'approve', {
        previousValue: { status: run.status },
        newValue: {
          status: 'approved',
          totalGross: updated.totalGross,
          totalDeductions: updated.totalDeductions,
          totalNet: updated.totalNet,
          employeeCount: updated.employeeCount,
        },
      });
      return updated;
    });
  }

  async cancelRun(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
    version: number,
  ): Promise<PayrollRunRow> {
    return this.db.runInTenant(async (tx) => {
      const run = await this.loadRun(tx, institutionId, id);
      if (run.status === 'paid' || run.status === 'cancelled') {
        throw new ConflictError(
          `A ${run.status} run cannot be cancelled${run.status === 'paid' ? '; reverse its journal entry through accounting instead' : ''}.`,
        );
      }

      const updated = await this.transitionRun(tx, principal, run, version, {
        status: 'cancelled',
        cancelledBy: principal.userId,
        cancelledAt: new Date(),
        cancelReason: reason,
      });
      await this.recordRunAudit(tx, principal, institutionId, updated, 'archive', {
        previousValue: { status: run.status },
        newValue: { status: 'cancelled' },
        reason,
      });
      return updated;
    });
  }

  /**
   * Mark an approved run paid.
   *
   * One balanced journal entry — debit salary expense for the gross, credit the payable
   * for the withheld deductions, credit cash/bank for the net — is posted through
   * `LedgerService` in this same transaction, the link row is written, every pending
   * payslip is stamped paid, loan balances are decremented by exactly what the payslip
   * lines withheld, and only then does the run become `paid`. If the ledger refuses the
   * posting (closed period, header account, imbalance) the whole transaction rolls back
   * and the run stays approved.
   */
  async markRunPaid(
    principal: Principal,
    institutionId: string,
    id: string,
    input: MarkPayrollRunPaidInput,
  ): Promise<{ run: PayrollRunRow; journalEntryId: string; journalEntryNumber: string }> {
    const context = currentContext();

    return this.db.runInTenant(async (tx) => {
      const run = await this.loadRun(tx, institutionId, id);
      if (run.status !== 'approved') {
        throw new ConflictError(`Only an approved run can be paid; ${run.name} is ${run.status}.`);
      }
      if (run.version !== input.version) {
        throw new ConflictError(
          'This run was changed by someone else while you were working. Reload and try again.',
          { expectedVersion: input.version, currentVersion: run.version },
        );
      }

      const gross = Money.fromDecimalString(run.totalGross);
      const deductions = Money.fromDecimalString(run.totalDeductions);
      const net = Money.fromDecimalString(run.totalNet);
      if (!gross.isPositive()) {
        throw new ConflictError(`${run.name} has nothing to pay out.`);
      }
      if (deductions.isPositive() && !input.deductionsPayableAccountId) {
        throw new ValidationError(
          'This run withholds deductions; name the deductions payable account they are credited to.',
        );
      }

      const period = formatPeriod(run.periodYear, run.periodMonth);
      const ledgerLines: LedgerLineInput[] = [
        {
          accountId: input.expenseAccountId,
          debit: gross.toDecimalString(),
          description: `Salaries for ${period}`,
        },
      ];
      if (deductions.isPositive()) {
        ledgerLines.push({
          accountId: input.deductionsPayableAccountId!,
          credit: deductions.toDecimalString(),
          description: `Withheld deductions for ${period}`,
        });
      }
      if (net.isPositive()) {
        ledgerLines.push({
          accountId: input.paymentAccountId,
          credit: net.toDecimalString(),
          description: `Net salaries for ${period}`,
        });
      }

      const { entry } = await this.ledger.post(tx, {
        tenantId: principal.tenantId!,
        institutionId,
        actorUserId: principal.userId,
        entryDate: input.entryDate ?? (todayInDhaka() as string),
        description: `${run.name} disbursement`,
        referenceType: 'payroll_run',
        referenceId: run.id,
        sourceModule: 'payroll',
        isSystemGenerated: true,
        lines: ledgerLines,
      });

      await tx.insert(payrollJournalLinks).values({
        id: uuidv7(),
        tenantId: principal.tenantId!,
        institutionId,
        runId: run.id,
        journalEntryId: entry.id,
        createdBy: principal.userId,
        updatedBy: principal.userId,
      });

      const paidAt = new Date();
      await tx
        .update(payslips)
        .set({
          paymentStatus: 'paid',
          paidAt,
          version: sql`${payslips.version} + 1`,
          updatedBy: principal.userId,
        })
        .where(
          and(
            eq(payslips.runId, run.id),
            isNull(payslips.archivedAt),
            eq(payslips.paymentStatus, 'pending'),
          ),
        );

      await this.settleLoanInstalments(tx, principal, run.id);

      const updated = await this.transitionRun(tx, principal, run, input.version, {
        status: 'paid',
        paidBy: principal.userId,
        paidAt,
      });

      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'payment',
        module: 'payroll',
        resourceType: 'payroll_run',
        resourceId: run.id,
        resourceLabel: run.name,
        newValue: {
          status: 'paid',
          journalEntryId: entry.id,
          journalEntryNumber: entry.entryNumber,
          totalGross: run.totalGross,
          totalDeductions: run.totalDeductions,
          totalNet: run.totalNet,
          employeeCount: run.employeeCount,
        },
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      return { run: updated, journalEntryId: entry.id, journalEntryNumber: entry.entryNumber };
    });
  }

  // ── Payslips ────────────────────────────────────────────────────────────────────────

  async getPayslip(
    principal: Principal,
    institutionId: string,
    id: string,
  ): Promise<PayslipRow & { lines: PayslipLineRow[] }> {
    return this.db.runInTenant(async (tx) => {
      const slip = await this.loadVisiblePayslip(tx, principal, institutionId, id);
      const lines = await tx
        .select()
        .from(payslipLines)
        .where(and(eq(payslipLines.payslipId, slip.id), isNull(payslipLines.archivedAt)))
        .orderBy(asc(payslipLines.sequence), asc(payslipLines.id));
      return { ...slip, lines };
    });
  }

  /** Everything a payslip PDF needs, in one shape, under the same visibility rule. */
  async getPayslipPrintData(principal: Principal, institutionId: string, id: string) {
    return this.db.runInTenant(async (tx) => {
      const slip = await this.loadVisiblePayslip(tx, principal, institutionId, id);

      const [header] = await tx
        .select({
          employeeCode: employees.employeeCode,
          employeeName: employees.fullNameEn,
          employeeNameBn: employees.fullNameBn,
          designation: designations.nameEn,
          institutionName: institutions.nameEn,
          institutionNameBn: institutions.nameBn,
          runName: payrollRuns.name,
          periodYear: payrollRuns.periodYear,
          periodMonth: payrollRuns.periodMonth,
          runStatus: payrollRuns.status,
        })
        .from(payslips)
        .innerJoin(employees, eq(employees.id, payslips.employeeId))
        .leftJoin(designations, eq(designations.id, employees.designationId))
        .innerJoin(payrollRuns, eq(payrollRuns.id, payslips.runId))
        .innerJoin(institutions, eq(institutions.id, payslips.institutionId))
        .where(eq(payslips.id, slip.id))
        .limit(1);

      const lines = await tx
        .select()
        .from(payslipLines)
        .where(and(eq(payslipLines.payslipId, slip.id), isNull(payslipLines.archivedAt)))
        .orderBy(asc(payslipLines.sequence), asc(payslipLines.id));

      return {
        payslip: slip,
        employee: {
          code: header!.employeeCode,
          nameEn: header!.employeeName,
          nameBn: header!.employeeNameBn,
          designation: header!.designation,
        },
        institution: { nameEn: header!.institutionName, nameBn: header!.institutionNameBn },
        run: {
          name: header!.runName,
          period: formatPeriod(header!.periodYear, header!.periodMonth),
          status: header!.runStatus,
        },
        earnings: lines.filter((line) => line.kind === 'earning'),
        deductions: lines.filter((line) => line.kind === 'deduction'),
      };
    });
  }

  /** Self-service: exactly the caller's own slips, and only from approved or paid runs. */
  async listMyPayslips(
    principal: Principal,
    institutionId: string,
    query: ListMyPayslipsQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<PayslipRow & { periodYear: number; periodMonth: number }>> {
    return this.db.runInTenant(async (tx) => {
      if (!principal.employeeId) {
        // A user with the permission but no employee record can own no payslip. Failing
        // closed — an empty page — is the only safe reading.
        return buildOffsetPage<PayslipRow & { periodYear: number; periodMonth: number }>(
          [],
          0,
          page,
        );
      }

      const conditions: SQL[] = [
        eq(payslips.institutionId, institutionId),
        eq(payslips.employeeId, principal.employeeId),
        isNull(payslips.archivedAt),
        inArray(payrollRuns.status, ['approved', 'paid']),
      ];
      if (query.periodYear !== undefined) {
        conditions.push(eq(payrollRuns.periodYear, query.periodYear));
      }
      const where = and(...conditions);

      const rows = await tx
        .select({
          slip: payslips,
          periodYear: payrollRuns.periodYear,
          periodMonth: payrollRuns.periodMonth,
        })
        .from(payslips)
        .innerJoin(payrollRuns, eq(payrollRuns.id, payslips.runId))
        .where(where)
        .orderBy(desc(payrollRuns.periodYear), desc(payrollRuns.periodMonth), asc(payslips.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(payslips)
        .innerJoin(payrollRuns, eq(payrollRuns.id, payslips.runId))
        .where(where);

      return buildOffsetPage(
        rows.map((row) => ({
          ...row.slip,
          periodYear: row.periodYear,
          periodMonth: row.periodMonth,
        })),
        counted?.total ?? 0,
        page,
      );
    });
  }

  // ── Adjustments ─────────────────────────────────────────────────────────────────────

  async listAdjustments(
    principal: Principal,
    institutionId: string,
    runId: string,
  ): Promise<AdjustmentRow[]> {
    return this.db.runInTenant(async (tx) => {
      await this.loadRun(tx, institutionId, runId);
      return tx
        .select()
        .from(payrollAdjustments)
        .where(and(eq(payrollAdjustments.runId, runId), isNull(payrollAdjustments.archivedAt)))
        .orderBy(asc(payrollAdjustments.createdAt), asc(payrollAdjustments.id));
    });
  }

  async createAdjustment(
    principal: Principal,
    institutionId: string,
    runId: string,
    input: CreatePayrollAdjustmentInput,
  ): Promise<AdjustmentRow> {
    return this.db.runInTenant(async (tx) => {
      const run = await this.loadRun(tx, institutionId, runId);
      this.assertRunAdjustable(run);
      await this.assertEmployeeInInstitution(tx, institutionId, input.employeeId);

      const amount = Money.fromDecimalString(input.amount);
      if (!amount.isPositive()) {
        throw new ValidationError('An adjustment amount must be greater than zero.');
      }

      const [adjustment] = await tx
        .insert(payrollAdjustments)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          runId,
          employeeId: input.employeeId,
          kind: input.kind,
          name: input.name,
          amount: amount.toDecimalString(),
          reason: input.reason,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return adjustment!;
    });
  }

  async updateAdjustment(
    principal: Principal,
    institutionId: string,
    id: string,
    input: UpdatePayrollAdjustmentInput,
  ): Promise<{ adjustment: AdjustmentRow; previous: Partial<AdjustmentRow> }> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadAdjustment(tx, institutionId, id);
      const run = await this.loadRun(tx, institutionId, existing.runId);
      this.assertRunAdjustable(run);

      const { version, ...changes } = input;
      const normalized: Partial<AdjustmentRow> = { ...changes };
      if (changes.amount !== undefined) {
        const amount = Money.fromDecimalString(changes.amount);
        if (!amount.isPositive()) {
          throw new ValidationError('An adjustment amount must be greater than zero.');
        }
        normalized.amount = amount.toDecimalString();
      }

      const [updated] = await tx
        .update(payrollAdjustments)
        .set({ ...normalized, version: existing.version + 1, updatedBy: principal.userId })
        .where(and(eq(payrollAdjustments.id, id), eq(payrollAdjustments.version, version)))
        .returning();
      if (!updated) {
        throw new ConflictError(
          'This adjustment was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      const previous: Partial<AdjustmentRow> = {};
      for (const key of Object.keys(normalized) as Array<keyof AdjustmentRow>) {
        if (existing[key] !== updated[key]) {
          (previous as Record<string, unknown>)[key] = existing[key];
        }
      }
      return { adjustment: updated, previous };
    });
  }

  async archiveAdjustment(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<AdjustmentRow> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadAdjustment(tx, institutionId, id);
      const run = await this.loadRun(tx, institutionId, existing.runId);
      this.assertRunAdjustable(run);

      const [archived] = await tx
        .update(payrollAdjustments)
        .set({
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(payrollAdjustments.id, id))
        .returning();
      return archived!;
    });
  }

  // ── Loans and advances ──────────────────────────────────────────────────────────────

  async createLoan(
    principal: Principal,
    institutionId: string,
    input: CreateLoanAdvanceInput,
  ): Promise<LoanRow> {
    return this.db.runInTenant(async (tx) => {
      await this.assertEmployeeInInstitution(tx, institutionId, input.employeeId);

      const principalAmount = Money.fromDecimalString(input.principal);
      const instalment = Money.fromDecimalString(input.instalment);
      if (!principalAmount.isPositive() || !instalment.isPositive()) {
        throw new ValidationError('Loan principal and instalment must both be greater than zero.');
      }
      if (instalment.greaterThan(principalAmount)) {
        throw new ValidationError('The instalment cannot exceed the loan principal.');
      }

      const [loan] = await tx
        .insert(loanAdvances)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          employeeId: input.employeeId,
          principal: principalAmount.toDecimalString(),
          instalment: instalment.toDecimalString(),
          remaining: principalAmount.toDecimalString(),
          startYear: input.startYear,
          startMonth: input.startMonth,
          status: 'active',
          notes: input.notes ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return loan!;
    });
  }

  async listLoans(
    principal: Principal,
    institutionId: string,
    query: ListLoanAdvancesQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<LoanRow>> {
    return this.db.runInTenant(async (tx) => {
      const conditions: SQL[] = [
        eq(loanAdvances.institutionId, institutionId),
        isNull(loanAdvances.archivedAt),
      ];
      if (query.employeeId) conditions.push(eq(loanAdvances.employeeId, query.employeeId));
      if (query.status) conditions.push(eq(loanAdvances.status, query.status));
      if (query.q) conditions.push(sql`${loanAdvances.notes} ilike ${`%${query.q}%`}`);
      const where = and(...conditions);

      const orderBy = parseSort(query.sort, LOAN_ADVANCE_SORT_FIELDS, {
        field: 'createdAt',
        direction: 'desc',
      }).map((spec) =>
        spec.direction === 'desc'
          ? desc(LOAN_ADVANCE_COLUMNS[spec.field])
          : asc(LOAN_ADVANCE_COLUMNS[spec.field]),
      );

      const rows = await tx
        .select()
        .from(loanAdvances)
        .where(where)
        .orderBy(...orderBy, asc(loanAdvances.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(loanAdvances)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async getLoan(principal: Principal, institutionId: string, id: string): Promise<LoanRow> {
    return this.db.runInTenant(async (tx) => this.loadLoan(tx, institutionId, id));
  }

  async updateLoan(
    principal: Principal,
    institutionId: string,
    id: string,
    input: UpdateLoanAdvanceInput,
  ): Promise<{ loan: LoanRow; previous: Partial<LoanRow> }> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadLoan(tx, institutionId, id);
      if (existing.status !== 'active') {
        throw new ConflictError(`Only an active loan can be changed; this one is ${existing.status}.`);
      }

      const { version, ...changes } = input;
      const normalized: Partial<LoanRow> = {};
      if (changes.notes !== undefined) normalized.notes = changes.notes;
      if (changes.instalment !== undefined) {
        const instalment = Money.fromDecimalString(changes.instalment);
        if (!instalment.isPositive()) {
          throw new ValidationError('The instalment must be greater than zero.');
        }
        if (instalment.greaterThan(Money.fromDecimalString(existing.principal))) {
          throw new ValidationError('The instalment cannot exceed the loan principal.');
        }
        normalized.instalment = instalment.toDecimalString();
      }

      const [updated] = await tx
        .update(loanAdvances)
        .set({ ...normalized, version: existing.version + 1, updatedBy: principal.userId })
        .where(and(eq(loanAdvances.id, id), eq(loanAdvances.version, version)))
        .returning();
      if (!updated) {
        throw new ConflictError(
          'This loan was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      const previous: Partial<LoanRow> = {};
      for (const key of Object.keys(normalized) as Array<keyof LoanRow>) {
        if (existing[key] !== updated[key]) {
          (previous as Record<string, unknown>)[key] = existing[key];
        }
      }
      return { loan: updated, previous };
    });
  }

  async cancelLoan(
    principal: Principal,
    institutionId: string,
    id: string,
    input: CancelLoanAdvanceInput,
  ): Promise<LoanRow> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadLoan(tx, institutionId, id);
      if (existing.status !== 'active') {
        throw new ConflictError(`Only an active loan can be cancelled; this one is ${existing.status}.`);
      }

      const [cancelled] = await tx
        .update(loanAdvances)
        .set({
          status: 'cancelled',
          cancelReason: input.reason,
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(loanAdvances.id, id), eq(loanAdvances.version, input.version)))
        .returning();
      if (!cancelled) {
        throw new ConflictError(
          'This loan was changed by someone else while you were working. Reload and try again.',
          { expectedVersion: input.version, currentVersion: existing.version },
        );
      }
      return cancelled;
    });
  }

  // ── Reports — computed in SQL ───────────────────────────────────────────────────────

  /** The payroll register: one row per payslip, with totals aggregated by the database. */
  async getRegister(principal: Principal, institutionId: string, runId: string) {
    return this.db.runInTenant(async (tx) => {
      const run = await this.loadRun(tx, institutionId, runId);

      const rows = await tx
        .select({
          payslipId: payslips.id,
          employeeId: payslips.employeeId,
          employeeCode: employees.employeeCode,
          employeeName: employees.fullNameEn,
          basic: payslips.basic,
          totalEarnings: payslips.totalEarnings,
          gross: payslips.gross,
          totalDeductions: payslips.totalDeductions,
          net: payslips.net,
          unpaidLeaveDays: payslips.unpaidLeaveDays,
          paymentStatus: payslips.paymentStatus,
        })
        .from(payslips)
        .innerJoin(employees, eq(employees.id, payslips.employeeId))
        .where(and(eq(payslips.runId, run.id), isNull(payslips.archivedAt)))
        .orderBy(asc(employees.employeeCode), asc(payslips.id));

      const [totals] = await tx
        .select({
          employeeCount: sql<number>`count(*)::int`,
          totalBasic: sql<string>`coalesce(sum(${payslips.basic}), 0)::numeric(14,2)`,
          totalEarnings: sql<string>`coalesce(sum(${payslips.totalEarnings}), 0)::numeric(14,2)`,
          totalGross: sql<string>`coalesce(sum(${payslips.gross}), 0)::numeric(14,2)`,
          totalDeductions: sql<string>`coalesce(sum(${payslips.totalDeductions}), 0)::numeric(14,2)`,
          totalNet: sql<string>`coalesce(sum(${payslips.net}), 0)::numeric(14,2)`,
        })
        .from(payslips)
        .where(and(eq(payslips.runId, run.id), isNull(payslips.archivedAt)));

      return {
        run: {
          id: run.id,
          name: run.name,
          period: formatPeriod(run.periodYear, run.periodMonth),
          status: run.status,
        },
        rows,
        totals: totals!,
      };
    });
  }

  /**
   * The statutory summary: structure-defined deductions (provident fund, income tax, …)
   * summed per component name across the run, straight from SQL.
   */
  async getStatutorySummary(principal: Principal, institutionId: string, runId: string) {
    return this.db.runInTenant(async (tx) => {
      const run = await this.loadRun(tx, institutionId, runId);

      const lineFilter = and(
        eq(payslips.runId, run.id),
        isNull(payslips.archivedAt),
        isNull(payslipLines.archivedAt),
        eq(payslipLines.kind, 'deduction'),
        eq(payslipLines.isStatutory, true),
      );

      const rows = await tx
        .select({
          name: payslipLines.name,
          employeeCount: sql<number>`count(distinct ${payslips.employeeId})::int`,
          total: sql<string>`sum(${payslipLines.amount})::numeric(14,2)`,
        })
        .from(payslipLines)
        .innerJoin(payslips, eq(payslips.id, payslipLines.payslipId))
        .where(lineFilter)
        .groupBy(payslipLines.name)
        .orderBy(asc(payslipLines.name));

      const [grand] = await tx
        .select({
          total: sql<string>`coalesce(sum(${payslipLines.amount}), 0)::numeric(14,2)`,
        })
        .from(payslipLines)
        .innerJoin(payslips, eq(payslips.id, payslipLines.payslipId))
        .where(lineFilter);

      return {
        run: {
          id: run.id,
          name: run.name,
          period: formatPeriod(run.periodYear, run.periodMonth),
          status: run.status,
        },
        deductions: rows,
        total: grand!.total,
      };
    });
  }

  // ── Internals ───────────────────────────────────────────────────────────────────────

  /**
   * The calculation itself. Runs inside the caller's transaction so a mid-flight failure
   * leaves nothing behind.
   *
   * Component evaluation is `computeSalaryBreakdown`'s two-pass sequence order: every
   * earning first (gross becomes known), then every deduction, `percentage_of_gross`
   * necessarily last. On top of that, per employee and in this order: earning
   * adjustments, the unpaid-leave pro-rata (via `Money.allocate`, so the parts sum
   * exactly back to the month's gross), deduction adjustments, then loan instalments
   * capped at what remains — a payslip can never go negative.
   */
  private async performCalculation(
    tx: Tx,
    principal: Principal,
    institutionId: string,
    run: PayrollRunRow,
    version: number,
  ): Promise<PayrollRunRow> {
    if (run.version !== version) {
      throw new ConflictError(
        'This run was changed by someone else while you were working. Reload and try again.',
        { expectedVersion: version, currentVersion: run.version },
      );
    }

    const daysInMonth = new Date(Date.UTC(run.periodYear, run.periodMonth, 0)).getUTCDate();
    const monthToken = String(run.periodMonth).padStart(2, '0');
    const periodStart = `${run.periodYear}-${monthToken}-01`;
    const periodEnd = `${run.periodYear}-${monthToken}-${String(daysInMonth).padStart(2, '0')}`;

    // Active employees whose salary assignment covers any part of the period; where an
    // assignment changed mid-period the latest one effective in the period wins.
    const assignmentRows = await tx
      .select({ assignment: employeeSalaryAssignments, employeeCode: employees.employeeCode })
      .from(employeeSalaryAssignments)
      .innerJoin(employees, eq(employees.id, employeeSalaryAssignments.employeeId))
      .where(
        and(
          eq(employeeSalaryAssignments.institutionId, institutionId),
          isNull(employeeSalaryAssignments.archivedAt),
          lte(employeeSalaryAssignments.effectiveFrom, periodEnd),
          or(
            isNull(employeeSalaryAssignments.effectiveTo),
            gte(employeeSalaryAssignments.effectiveTo, periodStart),
          ),
          eq(employees.employmentStatus, 'active'),
          isNull(employees.archivedAt),
        ),
      )
      .orderBy(asc(employees.employeeCode), asc(employeeSalaryAssignments.effectiveFrom));

    const chosen = new Map<
      string,
      { assignment: typeof employeeSalaryAssignments.$inferSelect; employeeCode: string }
    >();
    for (const row of assignmentRows) {
      // Later rows have a later effectiveFrom (the ORDER BY), so the last write wins.
      chosen.set(row.assignment.employeeId, {
        assignment: row.assignment,
        employeeCode: row.employeeCode,
      });
    }
    if (chosen.size === 0) {
      throw new ConflictError(
        `No employee holds a salary assignment covering ${formatPeriod(run.periodYear, run.periodMonth)}; assign salary structures before calculating.`,
      );
    }

    const structureIds = [
      ...new Set([...chosen.values()].map((entry) => entry.assignment.salaryStructureId)),
    ];
    const componentRows = await tx
      .select()
      .from(salaryComponents)
      .where(
        and(
          inArray(salaryComponents.salaryStructureId, structureIds),
          isNull(salaryComponents.archivedAt),
        ),
      );
    const componentsByStructure = new Map<string, typeof componentRows>();
    for (const component of componentRows) {
      const bucket = componentsByStructure.get(component.salaryStructureId) ?? [];
      bucket.push(component);
      componentsByStructure.set(component.salaryStructureId, bucket);
    }

    // Unpaid leave: days marked absent in the staff attendance register for the period.
    const absenceRows = await tx
      .select({
        employeeId: employeeAttendance.employeeId,
        days: sql<number>`count(*)::int`,
      })
      .from(employeeAttendance)
      .where(
        and(
          eq(employeeAttendance.institutionId, institutionId),
          eq(employeeAttendance.status, 'absent'),
          gte(employeeAttendance.attendanceDate, periodStart),
          lte(employeeAttendance.attendanceDate, periodEnd),
          isNull(employeeAttendance.archivedAt),
        ),
      )
      .groupBy(employeeAttendance.employeeId);
    const absencesByEmployee = new Map(absenceRows.map((row) => [row.employeeId, row.days]));

    const adjustmentRows = await tx
      .select()
      .from(payrollAdjustments)
      .where(and(eq(payrollAdjustments.runId, run.id), isNull(payrollAdjustments.archivedAt)))
      .orderBy(asc(payrollAdjustments.createdAt), asc(payrollAdjustments.id));
    const adjustmentsByEmployee = new Map<string, AdjustmentRow[]>();
    for (const adjustment of adjustmentRows) {
      if (!chosen.has(adjustment.employeeId)) {
        throw new ConflictError(
          `Adjustment "${adjustment.name}" names an employee with no salary assignment for this period; archive it or assign a structure first.`,
          { adjustmentId: adjustment.id, employeeId: adjustment.employeeId },
        );
      }
      const bucket = adjustmentsByEmployee.get(adjustment.employeeId) ?? [];
      bucket.push(adjustment);
      adjustmentsByEmployee.set(adjustment.employeeId, bucket);
    }

    const loanRows = await tx
      .select()
      .from(loanAdvances)
      .where(
        and(
          eq(loanAdvances.institutionId, institutionId),
          eq(loanAdvances.status, 'active'),
          isNull(loanAdvances.archivedAt),
          sql`(${loanAdvances.startYear} < ${run.periodYear}
               or (${loanAdvances.startYear} = ${run.periodYear}
                   and ${loanAdvances.startMonth} <= ${run.periodMonth}))`,
        ),
      )
      .orderBy(asc(loanAdvances.createdAt), asc(loanAdvances.id));
    const loansByEmployee = new Map<string, LoanRow[]>();
    for (const loan of loanRows) {
      const bucket = loansByEmployee.get(loan.employeeId) ?? [];
      bucket.push(loan);
      loansByEmployee.set(loan.employeeId, bucket);
    }

    const now = new Date();
    let runGross = Money.zero();
    let runDeductions = Money.zero();
    let slipCount = 0;

    // Deterministic order: by employee code, so reruns produce identical output.
    const ordered = [...chosen.values()].sort((a, b) =>
      a.employeeCode.localeCompare(b.employeeCode),
    );

    for (const { assignment, employeeCode } of ordered) {
      const components = componentsByStructure.get(assignment.salaryStructureId) ?? [];
      const breakdown = computeSalaryBreakdown(
        assignment.basic,
        components.map((component) => ({
          id: component.id,
          nameEn: component.nameEn,
          type: component.type,
          calculation: component.calculation,
          amount: component.amount,
          sequence: component.sequence,
        })),
      );

      const lines: DraftLine[] = [];
      for (const line of breakdown.lines.filter((entry) => entry.type === 'earning')) {
        lines.push({
          componentId: line.componentId,
          loanAdvanceId: null,
          name: line.nameEn,
          kind: 'earning',
          amount: Money.fromDecimalString(line.amount),
          isStatutory: false,
        });
      }

      const adjustments = adjustmentsByEmployee.get(assignment.employeeId) ?? [];
      for (const adjustment of adjustments.filter((entry) => entry.kind === 'earning')) {
        lines.push({
          componentId: null,
          loanAdvanceId: null,
          name: adjustment.name,
          kind: 'earning',
          amount: Money.fromDecimalString(adjustment.amount),
          isStatutory: false,
        });
      }

      const basic = Money.fromDecimalString(assignment.basic);
      const componentGross = Money.fromDecimalString(breakdown.gross);
      let gross = Money.zero();
      for (const line of lines) gross = gross.plus(line.amount);

      // Structure-defined deductions are the recurring, statutory ones (PF, tax).
      for (const line of breakdown.lines.filter((entry) => entry.type === 'deduction')) {
        lines.push({
          componentId: line.componentId,
          loanAdvanceId: null,
          name: line.nameEn,
          kind: 'deduction',
          amount: Money.fromDecimalString(line.amount),
          isStatutory: true,
        });
      }

      // Unpaid leave reduces the month's structural gross pro-rata. `allocate` splits the
      // gross across [unpaid, paid] days by the largest-remainder method, so the unpaid
      // part plus the paid part reconstruct the whole exactly — no poisa is invented or
      // lost, whatever the day counts are.
      const unpaidDays = Math.min(absencesByEmployee.get(assignment.employeeId) ?? 0, daysInMonth);
      if (unpaidDays > 0) {
        const [unpaidPortion] = componentGross.allocate([unpaidDays, daysInMonth - unpaidDays]);
        if (unpaidPortion!.isPositive()) {
          lines.push({
            componentId: null,
            loanAdvanceId: null,
            name: `Unpaid leave (${unpaidDays} of ${daysInMonth} days)`,
            kind: 'deduction',
            amount: unpaidPortion!,
            isStatutory: false,
          });
        }
      }

      for (const adjustment of adjustments.filter((entry) => entry.kind === 'deduction')) {
        lines.push({
          componentId: null,
          loanAdvanceId: null,
          name: adjustment.name,
          kind: 'deduction',
          amount: Money.fromDecimalString(adjustment.amount),
          isStatutory: false,
        });
      }

      let deductions = Money.zero();
      for (const line of lines) {
        if (line.kind === 'deduction') deductions = deductions.plus(line.amount);
      }
      if (deductions.greaterThan(gross)) {
        throw new ConflictError(
          `Deductions exceed gross pay for employee ${employeeCode}; reduce the adjustments before calculating.`,
        );
      }

      // Loan instalments recover min(instalment, remaining), further capped at what is
      // left of the net so a payslip can never go negative.
      let available = gross.minus(deductions);
      for (const loan of loansByEmployee.get(assignment.employeeId) ?? []) {
        let due = Money.min(
          Money.fromDecimalString(loan.instalment),
          Money.fromDecimalString(loan.remaining),
        );
        due = Money.min(due, available);
        if (!due.isPositive()) continue;
        available = available.minus(due);
        deductions = deductions.plus(due);
        lines.push({
          componentId: null,
          loanAdvanceId: loan.id,
          name: 'Loan instalment',
          kind: 'deduction',
          amount: due,
          isStatutory: false,
        });
      }

      const net = gross.minus(deductions);
      const payslipId = uuidv7();
      await tx.insert(payslips).values({
        id: payslipId,
        tenantId: principal.tenantId!,
        institutionId,
        runId: run.id,
        employeeId: assignment.employeeId,
        salaryStructureId: assignment.salaryStructureId,
        salaryAssignmentId: assignment.id,
        basic: basic.toDecimalString(),
        totalEarnings: gross.minus(basic).toDecimalString(),
        gross: gross.toDecimalString(),
        totalDeductions: deductions.toDecimalString(),
        net: net.toDecimalString(),
        unpaidLeaveDays: unpaidDays,
        paymentStatus: 'pending',
        createdBy: principal.userId,
        updatedBy: principal.userId,
      });

      let sequence = 0;
      for (const line of lines) {
        sequence += 10;
        await tx.insert(payslipLines).values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          payslipId,
          componentId: line.componentId,
          loanAdvanceId: line.loanAdvanceId,
          name: line.name,
          kind: line.kind,
          amount: line.amount.toDecimalString(),
          sequence,
          isStatutory: line.isStatutory,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        });
      }

      runGross = runGross.plus(gross);
      runDeductions = runDeductions.plus(deductions);
      slipCount += 1;
    }

    const [updated] = await tx
      .update(payrollRuns)
      .set({
        status: 'calculated',
        calculatedBy: principal.userId,
        calculatedAt: now,
        totalGross: runGross.toDecimalString(),
        totalDeductions: runDeductions.toDecimalString(),
        totalNet: runGross.minus(runDeductions).toDecimalString(),
        employeeCount: slipCount,
        version: run.version + 1,
        updatedBy: principal.userId,
      })
      .where(and(eq(payrollRuns.id, run.id), eq(payrollRuns.version, version)))
      .returning();
    if (!updated) {
      throw new ConflictError(
        'This run was changed by someone else while you were working. Reload and try again.',
        { expectedVersion: version, currentVersion: run.version },
      );
    }

    await this.recordRunAudit(tx, principal, institutionId, updated, 'update', {
      previousValue: { status: run.status },
      newValue: {
        status: 'calculated',
        totalGross: updated.totalGross,
        totalDeductions: updated.totalDeductions,
        totalNet: updated.totalNet,
        employeeCount: updated.employeeCount,
      },
    });

    return updated;
  }

  /** Decrement each loan by exactly what this run's payslip lines withheld from it. */
  private async settleLoanInstalments(tx: Tx, principal: Principal, runId: string): Promise<void> {
    const instalmentSums = await tx
      .select({
        loanAdvanceId: payslipLines.loanAdvanceId,
        total: sql<string>`sum(${payslipLines.amount})::numeric(14,2)`,
      })
      .from(payslipLines)
      .innerJoin(payslips, eq(payslips.id, payslipLines.payslipId))
      .where(
        and(
          eq(payslips.runId, runId),
          isNull(payslips.archivedAt),
          isNull(payslipLines.archivedAt),
          isNotNull(payslipLines.loanAdvanceId),
        ),
      )
      .groupBy(payslipLines.loanAdvanceId);
    if (instalmentSums.length === 0) return;

    const loanIds = instalmentSums.map((row) => row.loanAdvanceId!);
    const loans = await tx.select().from(loanAdvances).where(inArray(loanAdvances.id, loanIds));
    const loansById = new Map(loans.map((loan) => [loan.id, loan]));

    for (const row of instalmentSums) {
      const loan = loansById.get(row.loanAdvanceId!);
      if (!loan || loan.status !== 'active') continue;
      const remaining = Money.fromDecimalString(loan.remaining).minus(
        Money.fromDecimalString(row.total),
      );
      const settled = remaining.isZero() || remaining.isNegative();
      await tx
        .update(loanAdvances)
        .set({
          remaining: (settled ? Money.zero() : remaining).toDecimalString(),
          status: settled ? 'settled' : 'active',
          settledAt: settled ? new Date() : null,
          version: loan.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(loanAdvances.id, loan.id));
    }
  }

  /**
   * A guarded status transition with optimistic locking. The database's immutability
   * trigger is the real guarantee for approved runs; the version check produces the
   * friendly conflict for concurrent editors.
   */
  private async transitionRun(
    tx: Tx,
    principal: Principal,
    run: PayrollRunRow,
    version: number,
    changes: Partial<PayrollRunRow>,
  ): Promise<PayrollRunRow> {
    const [updated] = await tx
      .update(payrollRuns)
      .set({ ...changes, version: run.version + 1, updatedBy: principal.userId })
      .where(and(eq(payrollRuns.id, run.id), eq(payrollRuns.version, version)))
      .returning();
    if (!updated) {
      throw new ConflictError(
        'This run was changed by someone else while you were working. Reload and try again.',
        { expectedVersion: version, currentVersion: run.version },
      );
    }
    return updated;
  }

  private async recordRunAudit(
    tx: Tx,
    principal: Principal,
    institutionId: string,
    run: PayrollRunRow,
    action: 'update' | 'approve' | 'archive',
    detail: { previousValue?: unknown; newValue?: unknown; reason?: string },
  ): Promise<void> {
    const context = currentContext();
    await this.audit.recordInTransaction(tx, {
      tenantId: principal.tenantId,
      institutionId,
      actorUserId: principal.userId,
      actorRoles: principal.roles.map((role) => role.roleKey),
      action,
      module: 'payroll',
      resourceType: 'payroll_run',
      resourceId: run.id,
      resourceLabel: run.name,
      previousValue: detail.previousValue,
      newValue: detail.newValue,
      reason: detail.reason ?? null,
      requestId: context?.requestId ?? null,
      ipAddress: context?.ipAddress ?? null,
      userAgent: context?.userAgent ?? null,
    });
  }

  private async loadRun(tx: Tx, institutionId: string, id: string): Promise<PayrollRunRow> {
    const [run] = await tx
      .select()
      .from(payrollRuns)
      .where(
        and(
          eq(payrollRuns.id, id),
          eq(payrollRuns.institutionId, institutionId),
          isNull(payrollRuns.archivedAt),
        ),
      )
      .limit(1);
    if (!run) throw new NotFoundError('Payroll run', id);
    return run;
  }

  /**
   * Load a payslip the caller is allowed to see, or 404. The same rule for a single read
   * as for lists: `view.all` sees any slip in the institution; `view.own` sees exactly
   * the caller's own, and only once the run is approved or paid. A slip outside that
   * scope is a `NotFoundError` — confirming it exists is itself a leak.
   */
  private async loadVisiblePayslip(
    tx: Tx,
    principal: Principal,
    institutionId: string,
    id: string,
  ): Promise<PayslipRow> {
    const [row] = await tx
      .select({ slip: payslips, runStatus: payrollRuns.status })
      .from(payslips)
      .innerJoin(payrollRuns, eq(payrollRuns.id, payslips.runId))
      .where(
        and(
          eq(payslips.id, id),
          eq(payslips.institutionId, institutionId),
          isNull(payslips.archivedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError('Payslip', id);

    if (can(principal, 'payroll.payslips.view.all')) return row.slip;

    const ownSlip =
      can(principal, 'payroll.payslips.view.own') &&
      principal.employeeId != null &&
      row.slip.employeeId === principal.employeeId &&
      (row.runStatus === 'approved' || row.runStatus === 'paid');
    if (ownSlip) return row.slip;

    throw new NotFoundError('Payslip', id);
  }

  private async loadAdjustment(
    tx: Tx,
    institutionId: string,
    id: string,
  ): Promise<AdjustmentRow> {
    const [adjustment] = await tx
      .select()
      .from(payrollAdjustments)
      .where(
        and(
          eq(payrollAdjustments.id, id),
          eq(payrollAdjustments.institutionId, institutionId),
          isNull(payrollAdjustments.archivedAt),
        ),
      )
      .limit(1);
    if (!adjustment) throw new NotFoundError('Payroll adjustment', id);
    return adjustment;
  }

  private async loadLoan(tx: Tx, institutionId: string, id: string): Promise<LoanRow> {
    const [loan] = await tx
      .select()
      .from(loanAdvances)
      .where(
        and(
          eq(loanAdvances.id, id),
          eq(loanAdvances.institutionId, institutionId),
          isNull(loanAdvances.archivedAt),
        ),
      )
      .limit(1);
    if (!loan) throw new NotFoundError('Loan or advance', id);
    return loan;
  }

  private async assertEmployeeInInstitution(
    tx: Tx,
    institutionId: string,
    employeeId: string,
  ): Promise<void> {
    const [employee] = await tx
      .select({ id: employees.id })
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
  }

  private assertRunAdjustable(run: PayrollRunRow): void {
    if (run.status === 'approved' || run.status === 'paid' || run.status === 'cancelled') {
      throw new ConflictError(
        `Payroll run ${run.name} is ${run.status}; record the correction as an adjustment in the next run instead.`,
      );
    }
  }
}

function formatPeriod(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** Sort-field allow-lists mapped to real columns. */
const PAYROLL_RUN_COLUMNS = {
  periodYear: payrollRuns.periodYear,
  periodMonth: payrollRuns.periodMonth,
  status: payrollRuns.status,
  createdAt: payrollRuns.createdAt,
} as const;

const LOAN_ADVANCE_COLUMNS = {
  startYear: loanAdvances.startYear,
  startMonth: loanAdvances.startMonth,
  status: loanAdvances.status,
  createdAt: loanAdvances.createdAt,
} as const;
