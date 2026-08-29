/**
 * Leave endpoints (Phase 21).
 *
 * Every route is `@InstitutionScoped()`: a leave policy, a balance and a working-day
 * calendar all belong to one institution, and a group administrator running three schools
 * has no safe default. The header is required by the tenant guard rather than guessed here.
 *
 * The permission split the catalogue gives us:
 *
 *   leave.policies.manage    — the type catalogue, and entitlement adjustments
 *   leave.requests.create    — file, submit, withdraw, attach evidence, ask for encashment
 *   leave.requests.approve   — decide an application or an encashment
 *   leave.requests.view.all  — see everyone's leave (HR, principal)
 *   leave.requests.view.own  — see your own, or your children's (staff, guardians)
 *   academic.calendar.*      — holiday overrides, which are institution calendar facts
 *
 * The catalogue has no dedicated permission for adjusting a balance, deciding an encashment
 * or reading the liability report, so the closest existing one governs each; the phase report
 * lists the permissions that would make the split exact.
 *
 * **Nothing here decides anything.** Approval goes through `WorkflowService`, which refuses
 * the initiator before it consults a single permission, and `LeaveService.assertNotOwnLeave`
 * refuses the applicant even when someone else filed the form for them. A route cannot opt
 * out of either.
 *
 * Route order matters: Nest matches in declaration order, so literal segments (`types`,
 * `balances/adjust`, `calendar`, `reports/...`) are declared before the `:id` routes that
 * would otherwise swallow them.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { normalizeOffsetPage } from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import {
  adjustLeaveBalanceSchema,
  applyForLeaveSchema,
  approveLeaveSchema,
  archiveHolidayOverrideSchema,
  archiveLeaveTypeSchema,
  cancelLeaveSchema,
  createHolidayOverrideSchema,
  createLeaveEncashmentSchema,
  createLeaveTypeSchema,
  decideLeaveEncashmentSchema,
  idParamSchema,
  leaveCalendarQuerySchema,
  leaveLiabilityQuerySchema,
  listHolidayOverridesSchema,
  listLeaveApplicationsSchema,
  listLeaveBalancesSchema,
  listLeaveEncashmentsSchema,
  listLeaveTypesSchema,
  rejectLeaveSchema,
  updateHolidayOverrideSchema,
  updateLeaveTypeSchema,
  withdrawLeaveSchema,
} from '@shikkha/validation';
import { LeaveService, type UploadedLeaveDocument } from './leave.service';
import {
  Audited,
  CurrentUser,
  InstitutionScoped,
  RequirePermissions,
} from '../../common/decorators';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { currentContext } from '../../common/context/request-context';

@ApiTags('leave')
@Controller('leave')
@InstitutionScoped()
export class LeaveController {
  constructor(private readonly leave: LeaveService) {}

  // ── Leave types ─────────────────────────────────────────────────────────────────────

  @Get('types')
  @RequirePermissions(
    'leave.policies.manage',
    'leave.requests.view.all',
    'leave.requests.view.own',
    'leave.requests.create',
    { mode: 'any' },
  )
  @ApiOperation({ summary: 'List the institution’s leave types' })
  async listTypes(
    @Query(zodQuery(listLeaveTypesSchema)) query: z.infer<typeof listLeaveTypesSchema>,
  ) {
    return this.leave.listTypes(requireInstitution(), query, normalizeOffsetPage(query));
  }

  @Post('types')
  @RequirePermissions('leave.policies.manage')
  @Audited({
    module: 'leave',
    resourceType: 'leave_type',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create a leave type' })
  async createType(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createLeaveTypeSchema)) body: z.infer<typeof createLeaveTypeSchema>,
  ) {
    return this.leave.createType(principal, requireInstitution(), body);
  }

  @Get('types/:id')
  @RequirePermissions(
    'leave.policies.manage',
    'leave.requests.view.all',
    'leave.requests.view.own',
    'leave.requests.create',
    { mode: 'any' },
  )
  @ApiOperation({ summary: 'Fetch one leave type' })
  async getType(@Param(zodParam(idParamSchema)) params: { id: string }) {
    return this.leave.getType(requireInstitution(), params.id);
  }

  @Patch('types/:id')
  @RequirePermissions('leave.policies.manage')
  @Audited({
    module: 'leave',
    resourceType: 'leave_type',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update a leave type' })
  async updateType(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateLeaveTypeSchema)) body: z.infer<typeof updateLeaveTypeSchema>,
  ) {
    const result = await this.leave.updateType(principal, requireInstitution(), params.id, body);
    // `__audit` is read by the audit interceptor and stripped from the HTTP response, so the
    // trail records what actually changed rather than the whole submitted body.
    return { ...result.leaveType, __audit: { previousValue: result.previous, newValue: body } };
  }

  @Post('types/:id/archive')
  @RequirePermissions('leave.policies.manage')
  @Audited({
    module: 'leave',
    resourceType: 'leave_type',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive a leave type' })
  async archiveType(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(archiveLeaveTypeSchema)) body: { reason: string },
  ) {
    return this.leave.archiveType(principal, requireInstitution(), params.id, body.reason);
  }

  // ── Balances ────────────────────────────────────────────────────────────────────────

  @Get('balances')
  @RequirePermissions('leave.requests.view.all', 'leave.requests.view.own', { mode: 'any' })
  @ApiOperation({ summary: 'List leave balances within your scope' })
  async listBalances(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listLeaveBalancesSchema)) query: z.infer<typeof listLeaveBalancesSchema>,
  ) {
    return this.leave.listBalances(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  /**
   * Adjust an entitlement. `leave.policies.manage` because the catalogue has no dedicated
   * balance permission and this is a policy act; the reason is mandatory and the service
   * writes the audit record inside the adjusting transaction, hence `recordedBy: 'service'`.
   */
  @Post('balances/adjust')
  @RequirePermissions('leave.balances.adjust')
  @Audited({
    module: 'leave',
    resourceType: 'leave_balance',
    action: 'update',
    requiresReason: true,
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Grant or correct a leave entitlement' })
  async adjustBalance(
    @CurrentUser() principal: Principal,
    @Body(zodBody(adjustLeaveBalanceSchema)) body: z.infer<typeof adjustLeaveBalanceSchema>,
  ) {
    return this.leave.adjustBalance(principal, requireInstitution(), body);
  }

  @Get('balances/:id')
  @RequirePermissions('leave.requests.view.all', 'leave.requests.view.own', { mode: 'any' })
  @ApiOperation({ summary: 'Fetch one leave balance with its remaining days' })
  async getBalance(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.leave.getBalance(principal, requireInstitution(), params.id);
  }

  // ── Views that must precede /applications/:id ───────────────────────────────────────

  @Get('my-applications')
  @RequirePermissions('leave.requests.view.own', 'leave.requests.view.all', { mode: 'any' })
  @ApiOperation({ summary: 'Leave you applied for, or applied for on your behalf' })
  async myApplications(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listLeaveApplicationsSchema))
    query: z.infer<typeof listLeaveApplicationsSchema>,
  ) {
    return this.leave.listApplications(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
      { view: 'mine' },
    );
  }

  /** An approver's queue: submitted applications they could decide — never their own. */
  @Get('team-applications')
  @RequirePermissions('leave.requests.approve')
  @ApiOperation({ summary: 'Applications awaiting your decision' })
  async teamApplications(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listLeaveApplicationsSchema))
    query: z.infer<typeof listLeaveApplicationsSchema>,
  ) {
    return this.leave.listApplications(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
      { view: 'team' },
    );
  }

  @Get('calendar')
  @RequirePermissions('leave.requests.view.all', 'leave.requests.view.own', { mode: 'any' })
  @ApiOperation({ summary: 'Who is away over a date range, and which days are not working days' })
  async calendar(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(leaveCalendarQuerySchema)) query: z.infer<typeof leaveCalendarQuerySchema>,
  ) {
    return this.leave.calendar(principal, requireInstitution(), query);
  }

  @Get('reports/liability')
  @RequirePermissions('leave.reports.view')
  @ApiOperation({ summary: 'Unused entitlement and what it would cost to pay out' })
  async liability(
    @Query(zodQuery(leaveLiabilityQuerySchema)) query: z.infer<typeof leaveLiabilityQuerySchema>,
  ) {
    return this.leave.liabilityReport(requireInstitution(), query);
  }

  // ── Applications ────────────────────────────────────────────────────────────────────

  @Get('applications')
  @RequirePermissions('leave.requests.view.all', 'leave.requests.view.own', { mode: 'any' })
  @ApiOperation({ summary: 'List leave applications within your scope' })
  async listApplications(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listLeaveApplicationsSchema))
    query: z.infer<typeof listLeaveApplicationsSchema>,
  ) {
    return this.leave.listApplications(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  /**
   * File an application. It is created as a **draft** so evidence can be attached; `submit`
   * is the act that reserves the dates and starts the approval chain.
   */
  @Post('applications')
  @RequirePermissions('leave.requests.create')
  @Audited({
    module: 'leave',
    resourceType: 'leave_application',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'File a leave application for an employee or a student' })
  async apply(
    @CurrentUser() principal: Principal,
    @Body(zodBody(applyForLeaveSchema)) body: z.infer<typeof applyForLeaveSchema>,
  ) {
    return this.leave.apply(principal, requireInstitution(), body);
  }

  @Get('applications/:id')
  @RequirePermissions('leave.requests.view.all', 'leave.requests.view.own', { mode: 'any' })
  @ApiOperation({ summary: 'Fetch one leave application with its documents' })
  async getApplication(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.leave.getApplication(principal, requireInstitution(), params.id);
  }

  @Get('applications/:id/documents')
  @RequirePermissions('leave.requests.view.all', 'leave.requests.view.own', { mode: 'any' })
  @ApiOperation({ summary: 'List the evidence attached to an application' })
  async listDocuments(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.leave.listDocuments(principal, requireInstitution(), params.id);
  }

  @Post('applications/:id/documents')
  @RequirePermissions('leave.requests.create')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  @Audited({
    module: 'leave',
    resourceType: 'leave_application_document',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Attach a medical certificate or other evidence' })
  async uploadDocument(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @UploadedFile() file: UploadedLeaveDocument,
  ) {
    const document = await this.leave.uploadDocument(
      principal,
      requireInstitution(),
      params.id,
      file,
    );
    return {
      ...document,
      __audit: {
        newValue: {
          applicationId: params.id,
          documentId: document.id,
          fileName: document.fileName,
          mimeType: document.mimeType,
        },
      },
    };
  }

  @Post('applications/:id/submit')
  @RequirePermissions('leave.requests.create')
  @Audited({
    module: 'leave',
    resourceType: 'leave_application',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Submit a draft application into the approval chain' })
  async submit(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.leave.submit(principal, requireInstitution(), params.id);
  }

  @Post('applications/:id/withdraw')
  @RequirePermissions('leave.requests.create')
  @Audited({
    module: 'leave',
    resourceType: 'leave_application',
    action: 'update',
    resourceIdFrom: 'param:id',
    requiresReason: true,
    // The service writes the record inside the transaction that restores the balance and
    // unwinds the attendance reflection, with the before-state.
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Withdraw your own application' })
  async withdraw(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(withdrawLeaveSchema)) body: { reason: string },
  ) {
    return this.leave.withdraw(principal, requireInstitution(), params.id, body.reason);
  }

  @Post('applications/:id/cancel')
  @RequirePermissions('leave.requests.approve', 'leave.requests.create', { mode: 'any' })
  @Audited({
    module: 'leave',
    resourceType: 'leave_application',
    action: 'update',
    resourceIdFrom: 'param:id',
    requiresReason: true,
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Cancel approved leave, restoring the balance and the register' })
  async cancel(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(cancelLeaveSchema)) body: { reason: string },
  ) {
    return this.leave.cancel(principal, requireInstitution(), params.id, body.reason);
  }

  /**
   * Approve, through the workflow engine. Holding `leave.requests.approve` is necessary and
   * never sufficient: the engine refuses the initiator and the service refuses the applicant,
   * so a school owner holding `*` cannot approve their own leave.
   */
  @Post('applications/:id/approve')
  @RequirePermissions('leave.requests.approve')
  @Audited({
    module: 'leave',
    resourceType: 'leave_application',
    action: 'approve',
    resourceIdFrom: 'param:id',
    // The service records the approval — with the balance movement — inside the deciding
    // transaction; a second row here would carry a null previous_value.
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Approve a submitted leave application' })
  async approve(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(approveLeaveSchema)) body: z.infer<typeof approveLeaveSchema>,
  ) {
    return this.leave.approve(principal, requireInstitution(), params.id, body.comment);
  }

  @Post('applications/:id/reject')
  @RequirePermissions('leave.requests.approve')
  @Audited({
    module: 'leave',
    resourceType: 'leave_application',
    action: 'reject',
    resourceIdFrom: 'param:id',
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Reject a submitted leave application' })
  async reject(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(rejectLeaveSchema)) body: z.infer<typeof rejectLeaveSchema>,
  ) {
    return this.leave.reject(principal, requireInstitution(), params.id, body.comment);
  }

  // ── Encashment ──────────────────────────────────────────────────────────────────────

  @Get('encashments')
  @RequirePermissions('leave.requests.view.all', 'leave.requests.view.own', { mode: 'any' })
  @ApiOperation({ summary: 'List leave encashment requests' })
  async listEncashments(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listLeaveEncashmentsSchema))
    query: z.infer<typeof listLeaveEncashmentsSchema>,
  ) {
    return this.leave.listEncashments(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Post('encashments')
  @RequirePermissions('leave.encashment.request')
  @Audited({
    module: 'leave',
    resourceType: 'leave_encashment',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Request payment for unused leave' })
  async requestEncashment(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createLeaveEncashmentSchema))
    body: z.infer<typeof createLeaveEncashmentSchema>,
  ) {
    return this.leave.requestEncashment(principal, requireInstitution(), body);
  }

  /**
   * Approve or reject. The route-level audit action is recorded as `approve` for both
   * outcomes (the accounting precedent); the record the service writes inside the
   * transaction carries the actual decision and the balance movement.
   */
  @Post('encashments/:id/decision')
  @RequirePermissions('leave.encashment.approve')
  @Audited({
    module: 'leave',
    resourceType: 'leave_encashment',
    action: 'approve',
    resourceIdFrom: 'param:id',
    requiresReason: true,
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Approve or reject an encashment request' })
  async decideEncashment(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(decideLeaveEncashmentSchema))
    body: z.infer<typeof decideLeaveEncashmentSchema>,
  ) {
    return this.leave.decideEncashment(
      principal,
      requireInstitution(),
      params.id,
      body.decision,
      body.reason,
      body.version,
    );
  }

  // ── Holiday overrides ───────────────────────────────────────────────────────────────
  //
  // These are institution calendar facts, so the academic calendar permissions govern them
  // rather than the leave ones: the person who sets the make-up Saturday is the person who
  // maintains the calendar it makes up for.

  @Get('holiday-overrides')
  @RequirePermissions('leave.holidays.view', 'leave.holidays.manage', { mode: 'any' })
  @ApiOperation({ summary: 'List the institution’s working-day exceptions' })
  async listHolidayOverrides(
    @Query(zodQuery(listHolidayOverridesSchema))
    query: z.infer<typeof listHolidayOverridesSchema>,
  ) {
    return this.leave.listHolidayOverrides(
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Post('holiday-overrides')
  @RequirePermissions('leave.holidays.manage')
  @Audited({
    module: 'leave',
    resourceType: 'holiday_override',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Open a weekend or close a working day' })
  async createHolidayOverride(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createHolidayOverrideSchema))
    body: z.infer<typeof createHolidayOverrideSchema>,
  ) {
    return this.leave.createHolidayOverride(principal, requireInstitution(), body);
  }

  @Patch('holiday-overrides/:id')
  @RequirePermissions('leave.holidays.manage')
  @Audited({
    module: 'leave',
    resourceType: 'holiday_override',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update a working-day exception' })
  async updateHolidayOverride(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateHolidayOverrideSchema))
    body: z.infer<typeof updateHolidayOverrideSchema>,
  ) {
    const result = await this.leave.updateHolidayOverride(
      principal,
      requireInstitution(),
      params.id,
      body,
    );
    return { ...result.override, __audit: { previousValue: result.previous, newValue: body } };
  }

  @Post('holiday-overrides/:id/archive')
  @RequirePermissions('leave.holidays.manage')
  @Audited({
    module: 'leave',
    resourceType: 'holiday_override',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive a working-day exception' })
  async archiveHolidayOverride(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(archiveHolidayOverrideSchema)) body: { reason: string },
  ) {
    return this.leave.archiveHolidayOverride(
      principal,
      requireInstitution(),
      params.id,
      body.reason,
    );
  }
}

/**
 * `@InstitutionScoped()` makes the tenant guard require and validate the header; this is the
 * belt-and-braces read, because `currentContext()` returns `string | null` and a service that
 * received `null` would silently query across institutions.
 */
function requireInstitution(): string {
  const institutionId = currentContext()?.institutionId;
  if (!institutionId) {
    throw new BadRequestException(
      'Send the x-institution-id header to indicate which institution this leave belongs to.',
    );
  }
  return institutionId;
}
