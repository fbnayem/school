/**
 * Attendance endpoints (Phase 7).
 *
 * Every route is `@InstitutionScoped()`: a register belongs to one school's calendar, one
 * school's sections and one school's academic year, so a group administrator with three
 * schools has no sensible default and must say which one they mean.
 *
 * The permission split is the shape of the domain rather than a convention:
 *
 *  - `attendance.mark` takes the register. A class teacher has it.
 *  - `attendance.correct` asks to change a submitted mark. It never changes one on its own.
 *  - `attendance.correct.approve` decides those requests and locks a register. A principal or
 *    an administrator has it; a class teacher does not.
 *  - `attendance.employee.*` is staff presence, held by HR, and deliberately disjoint from the
 *    permissions that let a teacher mark students.
 *
 * Reads are `{ mode: 'any' }` over the three scoped view permissions, and the *service*
 * narrows the rows. A guardian and a principal call the same summary endpoint and get
 * different data, which is what keeps the parent portal from needing its own code path.
 */

import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { normalizeOffsetPage } from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import {
  consecutiveAbsenceSchema,
  decideAttendanceCorrectionSchema,
  employeeCheckInSchema,
  employeeCheckOutSchema,
  idParamSchema,
  listAttendanceCorrectionsSchema,
  listAttendanceSessionsSchema,
  listEmployeeAttendanceSchema,
  lockAttendanceSessionSchema,
  openAttendanceSessionSchema,
  requestAttendanceCorrectionSchema,
  sectionAttendanceSummarySchema,
  studentAttendanceSummarySchema,
  submitAttendanceSchema,
} from '@shikkha/validation';
import { AttendanceService } from './attendance.service';
import {
  Audited,
  CurrentUser,
  InstitutionScoped,
  RequirePermissions,
} from '../../common/decorators';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { currentContext } from '../../common/context/request-context';

@ApiTags('attendance')
@Controller('attendance')
@InstitutionScoped()
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  // ── Registers ───────────────────────────────────────────────────────────────────────

  @Post('sessions')
  @RequirePermissions('attendance.mark')
  @Audited({
    module: 'attendance',
    resourceType: 'attendance_session',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Open the attendance register for a section on a date' })
  async openSession(
    @CurrentUser() principal: Principal,
    @Body(zodBody(openAttendanceSessionSchema)) body: z.infer<typeof openAttendanceSessionSchema>,
  ) {
    return this.attendance.openSession(principal, requireInstitution(), body);
  }

  @Get('sessions')
  @RequirePermissions('attendance.view.all', 'attendance.view.assigned', 'attendance.view.own', {
    mode: 'any',
  })
  @ApiOperation({ summary: 'List attendance registers within the caller’s data scope' })
  async listSessions(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listAttendanceSessionsSchema))
    query: z.infer<typeof listAttendanceSessionsSchema>,
  ) {
    return this.attendance.listSessions(principal, query, normalizeOffsetPage(query));
  }

  /**
   * The register, pre-filled with any marks already recorded.
   *
   * Declared before the two `sessions/:id/...` writes purely for readability — Nest matches on
   * method as well as path, so there is no ambiguity between them.
   */
  @Get('sessions/:id/roster')
  @RequirePermissions('attendance.view.all', 'attendance.view.assigned', { mode: 'any' })
  @ApiOperation({ summary: 'The roster for a register, with existing marks' })
  async roster(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.attendance.roster(principal, params.id);
  }

  @Post('sessions/:id/marks')
  @RequirePermissions('attendance.mark')
  @Audited({
    module: 'attendance',
    resourceType: 'attendance_session',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Record the whole register in one transaction' })
  async submitMarks(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(submitAttendanceSchema)) body: z.infer<typeof submitAttendanceSchema>,
  ) {
    return this.attendance.submitMarks(principal, params.id, body);
  }

  @Post('sessions/:id/lock')
  @RequirePermissions('attendance.correct.approve')
  @Audited({
    module: 'attendance',
    resourceType: 'attendance_session',
    action: 'update',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Close a submitted register for the reporting period' })
  async lockSession(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(lockAttendanceSessionSchema)) body: z.infer<typeof lockAttendanceSessionSchema>,
  ) {
    return this.attendance.lockSession(principal, params.id, body.reason, body.version);
  }

  // ── Corrections ─────────────────────────────────────────────────────────────────────

  /**
   * Ask to change a mark on a submitted register.
   *
   * `requiresReason` is enforced twice on purpose: by the Zod schema, which demands a
   * meaningful ten characters, and by the audit interceptor before the handler runs at all.
   */
  @Post('marks/:id/corrections')
  @RequirePermissions('attendance.correct')
  @Audited({
    module: 'attendance',
    resourceType: 'attendance_correction',
    action: 'create',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Request a correction to a submitted attendance mark' })
  async requestCorrection(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(requestAttendanceCorrectionSchema))
    body: z.infer<typeof requestAttendanceCorrectionSchema>,
  ) {
    return this.attendance.requestCorrection(principal, params.id, body);
  }

  @Get('corrections')
  @RequirePermissions('attendance.view.all', 'attendance.view.assigned', { mode: 'any' })
  @ApiOperation({ summary: 'List attendance corrections within the caller’s data scope' })
  async listCorrections(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listAttendanceCorrectionsSchema))
    query: z.infer<typeof listAttendanceCorrectionsSchema>,
  ) {
    return this.attendance.listCorrections(principal, query, normalizeOffsetPage(query));
  }

  @Post('corrections/:id/approve')
  @RequirePermissions('attendance.correct.approve')
  @Audited({
    module: 'attendance',
    resourceType: 'attendance_correction',
    action: 'approve',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Approve a pending attendance correction and apply it' })
  async approveCorrection(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(decideAttendanceCorrectionSchema))
    body: z.infer<typeof decideAttendanceCorrectionSchema>,
  ) {
    return this.attendance.decideCorrection(
      principal,
      params.id,
      'approved',
      body.reason,
      body.version,
    );
  }

  @Post('corrections/:id/reject')
  @RequirePermissions('attendance.correct.approve')
  @Audited({
    module: 'attendance',
    resourceType: 'attendance_correction',
    action: 'reject',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Reject a pending attendance correction' })
  async rejectCorrection(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(decideAttendanceCorrectionSchema))
    body: z.infer<typeof decideAttendanceCorrectionSchema>,
  ) {
    return this.attendance.decideCorrection(
      principal,
      params.id,
      'rejected',
      body.reason,
      body.version,
    );
  }

  // ── Employee attendance ─────────────────────────────────────────────────────────────

  @Post('employees/check-in')
  @RequirePermissions('attendance.employee.mark')
  @Audited({
    module: 'attendance',
    resourceType: 'employee_attendance',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Record an employee check-in' })
  async employeeCheckIn(
    @CurrentUser() principal: Principal,
    @Body(zodBody(employeeCheckInSchema)) body: z.infer<typeof employeeCheckInSchema>,
  ) {
    return this.attendance.employeeCheckIn(principal, requireInstitution(), body);
  }

  @Post('employees/check-out')
  @RequirePermissions('attendance.employee.mark')
  @Audited({
    module: 'attendance',
    resourceType: 'employee_attendance',
    action: 'update',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Record an employee check-out' })
  async employeeCheckOut(
    @CurrentUser() principal: Principal,
    @Body(zodBody(employeeCheckOutSchema)) body: z.infer<typeof employeeCheckOutSchema>,
  ) {
    return this.attendance.employeeCheckOut(principal, requireInstitution(), body);
  }

  @Get('employees')
  @RequirePermissions('attendance.employee.view')
  @ApiOperation({ summary: 'List employee attendance' })
  async listEmployeeAttendance(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listEmployeeAttendanceSchema))
    query: z.infer<typeof listEmployeeAttendanceSchema>,
  ) {
    return this.attendance.listEmployeeAttendance(principal, query, normalizeOffsetPage(query));
  }

  // ── Reports ─────────────────────────────────────────────────────────────────────────

  /**
   * Per-student totals and percentage over a date range.
   *
   * Open to `attendance.view.own` so a guardian can see their own children's figures on the
   * parent portal; the service's scope filter is what limits them to those children.
   */
  @Get('reports/student-summary')
  @RequirePermissions('attendance.view.all', 'attendance.view.assigned', 'attendance.view.own', {
    mode: 'any',
  })
  @ApiOperation({ summary: 'Per-student attendance totals over a date range' })
  async studentSummary(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(studentAttendanceSummarySchema))
    query: z.infer<typeof studentAttendanceSummarySchema>,
  ) {
    return this.attendance.studentSummary(principal, query, normalizeOffsetPage(query));
  }

  @Get('reports/section-daily')
  @RequirePermissions('attendance.reports.view')
  @ApiOperation({ summary: 'Per-section daily attendance summary' })
  async sectionDailySummary(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(sectionAttendanceSummarySchema))
    query: z.infer<typeof sectionAttendanceSummarySchema>,
  ) {
    return this.attendance.sectionDailySummary(principal, query);
  }

  /**
   * Runs of consecutive absences.
   *
   * Built for the Phase 12 automation engine, which will use it to notify guardians. This
   * endpoint only reports; nothing here sends anything.
   */
  @Get('reports/consecutive-absences')
  @RequirePermissions('attendance.reports.view')
  @ApiOperation({ summary: 'Students absent for several consecutive school days' })
  async consecutiveAbsences(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(consecutiveAbsenceSchema)) query: z.infer<typeof consecutiveAbsenceSchema>,
  ) {
    return this.attendance.consecutiveAbsences(principal, query);
  }
}

function requireInstitution(): string {
  const institutionId = currentContext()?.institutionId;
  if (!institutionId) {
    throw new BadRequestException(
      'Send the x-institution-id header to indicate which institution this attendance belongs to.',
    );
  }
  return institutionId;
}
