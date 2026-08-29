/**
 * Payroll endpoints (Phase 16).
 *
 * Every route is `@InstitutionScoped()`: payroll belongs to one institution, and a group
 * administrator running three schools has no safe default. The header is required by the
 * tenant guard rather than guessed here.
 *
 * The permission split is separation of duties written down:
 *
 *   payroll.runs.view          — read runs, adjustments, the register and the summary
 *   payroll.runs.create        — create, calculate, recalculate and submit a run, and
 *                                maintain its adjustments
 *   payroll.runs.approve       — approve a run (the service refuses the calculator, even
 *                                one holding every permission) and cancel one
 *   payroll.disburse           — mark an approved run paid, posting the ledger entry
 *   payroll.structures.manage  — maintain loans and advances (their figures feed pay)
 *   payroll.payslips.view.all  — read anyone's payslip and the per-slip breakdowns
 *   payroll.payslips.view.own  — read exactly your own payslips, once the run is approved
 *
 * No preset role in `packages/permissions/src/roles.ts` holds both `payroll.runs.create`
 * and `payroll.runs.approve` (the HR manager prepares, the chairman approves), and
 * `PayrollService.approveRun` refuses the calculator on the data as well, so the split
 * holds even if a school invents a role that carries both.
 *
 * Route order matters: Nest matches in declaration order, so literal segments (`runs`,
 * `my-payslips`, `loans`) are declared before the `:id` routes that would otherwise
 * swallow them.
 */

import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { normalizeOffsetPage } from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import {
  approvePayrollRunSchema,
  archivePayrollAdjustmentSchema,
  cancelLoanAdvanceSchema,
  cancelPayrollRunSchema,
  createLoanAdvanceSchema,
  createPayrollAdjustmentSchema,
  createPayrollRunSchema,
  idParamSchema,
  listLoanAdvancesSchema,
  listMyPayslipsSchema,
  listPayrollRunsSchema,
  markPayrollRunPaidSchema,
  payrollRunVersionSchema,
  updateLoanAdvanceSchema,
  updatePayrollAdjustmentSchema,
} from '@shikkha/validation';
import { PayrollService } from './payroll.service';
import {
  Audited,
  CurrentUser,
  InstitutionScoped,
  RequirePermissions,
} from '../../common/decorators';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { currentContext } from '../../common/context/request-context';

@ApiTags('payroll')
@Controller('payroll')
@InstitutionScoped()
export class PayrollController {
  constructor(private readonly payroll: PayrollService) {}

  // ── Runs ────────────────────────────────────────────────────────────────────────────

  @Post('runs')
  @RequirePermissions('payroll.runs.create')
  @Audited({
    module: 'payroll',
    resourceType: 'payroll_run',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create a draft payroll run for one month' })
  async createRun(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createPayrollRunSchema)) body: z.infer<typeof createPayrollRunSchema>,
  ) {
    return this.payroll.createRun(principal, requireInstitution(), body);
  }

  @Get('runs')
  @RequirePermissions('payroll.runs.view')
  @ApiOperation({ summary: 'List payroll runs' })
  async listRuns(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listPayrollRunsSchema)) query: z.infer<typeof listPayrollRunsSchema>,
  ) {
    return this.payroll.listRuns(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Get('runs/:id')
  @RequirePermissions('payroll.runs.view')
  @ApiOperation({ summary: 'Read one payroll run, with payslips for payslip-privileged callers' })
  async getRun(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.payroll.getRun(principal, requireInstitution(), params.id);
  }

  @Post('runs/:id/calculate')
  @RequirePermissions('payroll.runs.create')
  @Audited({
    module: 'payroll',
    resourceType: 'payroll_run',
    action: 'update',
    resourceIdFrom: 'param:id',
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Calculate a draft run into payslips' })
  async calculateRun(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(payrollRunVersionSchema)) body: { version: number },
  ) {
    return this.payroll.calculateRun(principal, requireInstitution(), params.id, body.version);
  }

  @Post('runs/:id/recalculate')
  @RequirePermissions('payroll.runs.create')
  @Audited({
    module: 'payroll',
    resourceType: 'payroll_run',
    action: 'update',
    resourceIdFrom: 'param:id',
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Recalculate a not-yet-approved run, archiving its previous payslips' })
  async recalculateRun(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(payrollRunVersionSchema)) body: { version: number },
  ) {
    return this.payroll.recalculateRun(principal, requireInstitution(), params.id, body.version);
  }

  @Post('runs/:id/submit')
  @RequirePermissions('payroll.runs.create')
  @Audited({
    module: 'payroll',
    resourceType: 'payroll_run',
    action: 'update',
    resourceIdFrom: 'param:id',
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Submit a calculated run for review' })
  async submitRun(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(payrollRunVersionSchema)) body: { version: number },
  ) {
    return this.payroll.submitRun(principal, requireInstitution(), params.id, body.version);
  }

  @Post('runs/:id/approve')
  @RequirePermissions('payroll.runs.approve')
  @Audited({
    module: 'payroll',
    resourceType: 'payroll_run',
    action: 'approve',
    resourceIdFrom: 'param:id',
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Approve a calculated run (a different person than the calculator)' })
  async approveRun(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(approvePayrollRunSchema)) body: { version: number },
  ) {
    return this.payroll.approveRun(principal, requireInstitution(), params.id, body.version);
  }

  @Post('runs/:id/cancel')
  @RequirePermissions('payroll.runs.approve')
  @Audited({
    module: 'payroll',
    resourceType: 'payroll_run',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Cancel a run with a reason, freeing its month for a fresh run' })
  async cancelRun(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(cancelPayrollRunSchema)) body: { reason: string; version: number },
  ) {
    return this.payroll.cancelRun(
      principal,
      requireInstitution(),
      params.id,
      body.reason,
      body.version,
    );
  }

  @Post('runs/:id/pay')
  @RequirePermissions('payroll.disburse')
  @Audited({
    module: 'payroll',
    resourceType: 'payroll_run',
    action: 'payment',
    resourceIdFrom: 'param:id',
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Mark an approved run paid, posting one balanced ledger entry' })
  async markRunPaid(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(markPayrollRunPaidSchema)) body: z.infer<typeof markPayrollRunPaidSchema>,
  ) {
    return this.payroll.markRunPaid(principal, requireInstitution(), params.id, body);
  }

  // ── Adjustments ─────────────────────────────────────────────────────────────────────

  @Get('runs/:id/adjustments')
  @RequirePermissions('payroll.runs.view')
  @ApiOperation({ summary: "List a run's one-off adjustments" })
  async listAdjustments(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.payroll.listAdjustments(principal, requireInstitution(), params.id);
  }

  @Post('runs/:id/adjustments')
  @RequirePermissions('payroll.runs.create')
  @Audited({
    module: 'payroll',
    resourceType: 'payroll_adjustment',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Add a one-off bonus or fine to a not-yet-approved run' })
  async createAdjustment(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(createPayrollAdjustmentSchema))
    body: z.infer<typeof createPayrollAdjustmentSchema>,
  ) {
    return this.payroll.createAdjustment(principal, requireInstitution(), params.id, body);
  }

  @Get('runs/:id/register')
  @RequirePermissions('payroll.runs.view')
  @ApiOperation({ summary: 'The payroll register: one row per payslip with SQL-computed totals' })
  async getRegister(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.payroll.getRegister(principal, requireInstitution(), params.id);
  }

  @Get('runs/:id/statutory-summary')
  @RequirePermissions('payroll.runs.view')
  @ApiOperation({ summary: 'Statutory deductions (PF, tax, …) summed per component in SQL' })
  async getStatutorySummary(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.payroll.getStatutorySummary(principal, requireInstitution(), params.id);
  }

  @Patch('adjustments/:id')
  @RequirePermissions('payroll.runs.create')
  @Audited({
    module: 'payroll',
    resourceType: 'payroll_adjustment',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Change an adjustment on a not-yet-approved run' })
  async updateAdjustment(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updatePayrollAdjustmentSchema))
    body: z.infer<typeof updatePayrollAdjustmentSchema>,
  ) {
    const result = await this.payroll.updateAdjustment(
      principal,
      requireInstitution(),
      params.id,
      body,
    );
    // `__audit` is read by the audit interceptor and stripped from the HTTP response, so
    // the trail records what actually changed rather than the whole submitted body.
    return { ...result.adjustment, __audit: { previousValue: result.previous, newValue: body } };
  }

  @Post('adjustments/:id/archive')
  @RequirePermissions('payroll.runs.create')
  @Audited({
    module: 'payroll',
    resourceType: 'payroll_adjustment',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive an adjustment with a reason' })
  async archiveAdjustment(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(archivePayrollAdjustmentSchema)) body: { reason: string },
  ) {
    return this.payroll.archiveAdjustment(principal, requireInstitution(), params.id, body.reason);
  }

  // ── Payslips ────────────────────────────────────────────────────────────────────────

  @Get('my-payslips')
  @RequirePermissions('payroll.payslips.view.own')
  @ApiOperation({ summary: 'Your own payslips, from approved or paid runs only' })
  async listMyPayslips(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listMyPayslipsSchema)) query: z.infer<typeof listMyPayslipsSchema>,
  ) {
    return this.payroll.listMyPayslips(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Get('payslips/:id')
  @RequirePermissions('payroll.payslips.view.all', 'payroll.payslips.view.own', { mode: 'any' })
  @ApiOperation({ summary: 'Read one payslip with its lines' })
  async getPayslip(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.payroll.getPayslip(principal, requireInstitution(), params.id);
  }

  @Get('payslips/:id/print')
  @RequirePermissions('payroll.payslips.view.all', 'payroll.payslips.view.own', { mode: 'any' })
  @ApiOperation({ summary: 'PDF-ready payslip data: employee, institution, period and lines' })
  async getPayslipPrintData(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.payroll.getPayslipPrintData(principal, requireInstitution(), params.id);
  }

  // ── Loans and advances ──────────────────────────────────────────────────────────────

  @Post('loans')
  @RequirePermissions('payroll.structures.manage')
  @Audited({
    module: 'payroll',
    resourceType: 'loan_advance',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Record a staff loan or advance recovered through payroll' })
  async createLoan(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createLoanAdvanceSchema)) body: z.infer<typeof createLoanAdvanceSchema>,
  ) {
    return this.payroll.createLoan(principal, requireInstitution(), body);
  }

  @Get('loans')
  @RequirePermissions('payroll.runs.view')
  @ApiOperation({ summary: 'List loans and advances' })
  async listLoans(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listLoanAdvancesSchema)) query: z.infer<typeof listLoanAdvancesSchema>,
  ) {
    return this.payroll.listLoans(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Get('loans/:id')
  @RequirePermissions('payroll.runs.view')
  @ApiOperation({ summary: 'Read one loan or advance' })
  async getLoan(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.payroll.getLoan(principal, requireInstitution(), params.id);
  }

  @Patch('loans/:id')
  @RequirePermissions('payroll.structures.manage')
  @Audited({
    module: 'payroll',
    resourceType: 'loan_advance',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Change an active loan (instalment, notes)' })
  async updateLoan(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateLoanAdvanceSchema)) body: z.infer<typeof updateLoanAdvanceSchema>,
  ) {
    const result = await this.payroll.updateLoan(principal, requireInstitution(), params.id, body);
    return { ...result.loan, __audit: { previousValue: result.previous, newValue: body } };
  }

  @Post('loans/:id/cancel')
  @RequirePermissions('payroll.structures.manage')
  @Audited({
    module: 'payroll',
    resourceType: 'loan_advance',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Cancel an active loan with a reason' })
  async cancelLoan(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(cancelLoanAdvanceSchema)) body: z.infer<typeof cancelLoanAdvanceSchema>,
  ) {
    return this.payroll.cancelLoan(principal, requireInstitution(), params.id, body);
  }
}

function requireInstitution(): string {
  const institutionId = currentContext()?.institutionId;
  if (!institutionId) {
    throw new BadRequestException(
      'Send the x-institution-id header to indicate which institution this payroll belongs to.',
    );
  }
  return institutionId;
}
