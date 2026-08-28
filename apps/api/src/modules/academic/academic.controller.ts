/**
 * Academic structure endpoints (Phase 2).
 *
 * Every route here is `@InstitutionScoped()`: academic structure belongs to an institution,
 * and a group administrator with three schools has no sensible default. Requiring the header
 * makes the ambiguity impossible rather than resolving it with a guess.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { Principal } from '@shikkha/permissions';
import {
  archiveRoomSchema,
  assignSectionTeacherSchema,
  assignSubjectTeacherSchema,
  createAcademicYearSchema,
  createCalendarEventSchema,
  createClassLevelSchema,
  createRoomSchema,
  createSectionSchema,
  createShiftSchema,
  createSubjectSchema,
  deleteCalendarEventSchema,
  idParamSchema,
  listCalendarEventsSchema,
  listClassSubjectsSchema,
  listRoomsSchema,
  listShiftsSchema,
  listTeacherAssignmentsSchema,
  replaceClassSubjectsSchema,
  replacePeriodsSchema,
  replaceTermsSchema,
  unassignTeacherSchema,
  updateCalendarEventSchema,
  updateRoomSchema,
  updateShiftSchema,
  uuidSchema,
} from '@shikkha/validation';
import { AcademicService } from './academic.service';
import {
  Audited,
  CurrentUser,
  InstitutionScoped,
  RequirePermissions,
} from '../../common/decorators';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { currentContext } from '../../common/context/request-context';

@ApiTags('academic')
@Controller('academic')
@InstitutionScoped()
export class AcademicController {
  constructor(private readonly academic: AcademicService) {}

  // ── Academic years ──────────────────────────────────────────────────────────────────

  @Get('years')
  @RequirePermissions('academic.years.view')
  @ApiOperation({ summary: 'List academic years' })
  async listYears() {
    return this.academic.listAcademicYears(requireInstitution());
  }

  @Post('years')
  @RequirePermissions('academic.years.manage')
  @Audited({ module: 'academic', resourceType: 'academic_year', action: 'create' })
  @ApiOperation({ summary: 'Create an academic year' })
  async createYear(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createAcademicYearSchema)) body: z.infer<typeof createAcademicYearSchema>,
  ) {
    return this.academic.createAcademicYear(principal, requireInstitution(), body);
  }

  /**
   * Making a year current changes what every default query in the product returns, which is
   * why it is a distinct, audited endpoint rather than a field on a generic update.
   */
  @Post('years/:id/set-current')
  @RequirePermissions('academic.years.manage')
  @Audited({
    module: 'academic',
    resourceType: 'academic_year',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Make an academic year the current one' })
  async setCurrentYear(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.academic.setCurrentAcademicYear(principal, requireInstitution(), params.id);
  }

  // ── Terms ───────────────────────────────────────────────────────────────────────────

  @Get('years/:id/terms')
  @RequirePermissions('academic.years.view')
  @ApiOperation({ summary: 'List the terms of an academic year' })
  async listTerms(@Param(zodParam(idParamSchema)) params: { id: string }) {
    return this.academic.listTerms(params.id);
  }

  @Put('terms')
  @RequirePermissions('academic.terms.manage')
  @Audited({ module: 'academic', resourceType: 'term', action: 'update' })
  @ApiOperation({
    summary: 'Replace the full set of terms for an academic year',
    description:
      'Terms are validated as a set: weights must total 100% and date ranges must not overlap.',
  })
  async replaceTerms(
    @CurrentUser() principal: Principal,
    @Body(zodBody(replaceTermsSchema)) body: z.infer<typeof replaceTermsSchema>,
  ) {
    return this.academic.replaceTerms(
      principal,
      requireInstitution(),
      body.academicYearId,
      body.terms,
    );
  }

  // ── Classes and sections ────────────────────────────────────────────────────────────

  @Get('class-levels')
  @RequirePermissions('academic.classes.view')
  @ApiOperation({ summary: 'List class levels' })
  async listClassLevels() {
    return this.academic.listClassLevels(requireInstitution());
  }

  @Post('class-levels')
  @RequirePermissions('academic.classes.manage')
  @Audited({ module: 'academic', resourceType: 'class_level', action: 'create' })
  @ApiOperation({ summary: 'Create a class level' })
  async createClassLevel(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createClassLevelSchema)) body: z.infer<typeof createClassLevelSchema>,
  ) {
    return this.academic.createClassLevel(principal, requireInstitution(), body);
  }

  @Get('sections')
  @RequirePermissions('academic.sections.view')
  @ApiOperation({ summary: 'List sections with their live enrolment counts' })
  async listSections(
    @Query(zodQuery(z.object({ academicYearId: uuidSchema.optional() })))
    query: {
      academicYearId?: string;
    },
  ) {
    return this.academic.listSections(requireInstitution(), query.academicYearId);
  }

  @Post('sections')
  @RequirePermissions('academic.sections.manage')
  @Audited({ module: 'academic', resourceType: 'section', action: 'create' })
  @ApiOperation({ summary: 'Create a section' })
  async createSection(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createSectionSchema)) body: z.infer<typeof createSectionSchema>,
  ) {
    return this.academic.createSection(principal, requireInstitution(), body);
  }

  // ── Subjects ────────────────────────────────────────────────────────────────────────

  @Get('subjects')
  @RequirePermissions('academic.subjects.view')
  @ApiOperation({ summary: 'List subjects' })
  async listSubjects() {
    return this.academic.listSubjects(requireInstitution());
  }

  @Post('subjects')
  @RequirePermissions('academic.subjects.manage')
  @Audited({ module: 'academic', resourceType: 'subject', action: 'create' })
  @ApiOperation({ summary: 'Create a subject' })
  async createSubject(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createSubjectSchema)) body: z.infer<typeof createSubjectSchema>,
  ) {
    return this.academic.createSubject(principal, requireInstitution(), body);
  }

  // ── Rooms ───────────────────────────────────────────────────────────────────────────
  //
  // There is no `academic.rooms.view` in the catalogue, so reads are opened to anyone who can
  // already see the section structure a room is attached to, or who can manage rooms. Writes
  // need `academic.rooms.manage` and nothing else.

  @Get('rooms')
  @RequirePermissions('academic.sections.view', 'academic.rooms.manage', { mode: 'any' })
  @ApiOperation({ summary: 'List rooms' })
  async listRooms(@Query(zodQuery(listRoomsSchema)) query: z.infer<typeof listRoomsSchema>) {
    return this.academic.listRooms(requireInstitution(), query);
  }

  @Post('rooms')
  @RequirePermissions('academic.rooms.manage')
  @Audited({
    module: 'academic',
    resourceType: 'room',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create a room' })
  async createRoom(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createRoomSchema)) body: z.infer<typeof createRoomSchema>,
  ) {
    return this.academic.createRoom(principal, requireInstitution(), body);
  }

  @Patch('rooms/:id')
  @RequirePermissions('academic.rooms.manage')
  @Audited({
    module: 'academic',
    resourceType: 'room',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update a room' })
  async updateRoom(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateRoomSchema)) body: z.infer<typeof updateRoomSchema>,
  ) {
    const result = await this.academic.updateRoom(principal, requireInstitution(), params.id, body);
    // `__audit` is read by the audit interceptor and stripped from the HTTP response, so the
    // trail records what actually changed rather than the whole submitted body.
    return { ...result.room, __audit: { previousValue: result.previous, newValue: body } };
  }

  /**
   * Rooms are archived, not deleted (ADR-008): a timetable printed last term still names this
   * room, and a hard delete would leave that reference pointing at nothing.
   */
  @Post('rooms/:id/archive')
  @RequirePermissions('academic.rooms.manage')
  @Audited({
    module: 'academic',
    resourceType: 'room',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive a room' })
  async archiveRoom(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(archiveRoomSchema)) body: { reason: string },
  ) {
    return this.academic.archiveRoom(principal, requireInstitution(), params.id, body.reason);
  }

  // ── Shifts and the bell schedule ────────────────────────────────────────────────────

  @Get('shifts')
  @RequirePermissions('academic.sections.view', 'academic.shifts.manage', { mode: 'any' })
  @ApiOperation({ summary: 'List shifts' })
  async listShifts(@Query(zodQuery(listShiftsSchema)) query: z.infer<typeof listShiftsSchema>) {
    return this.academic.listShifts(requireInstitution(), query);
  }

  @Post('shifts')
  @RequirePermissions('academic.shifts.manage')
  @Audited({
    module: 'academic',
    resourceType: 'shift',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create a shift' })
  async createShift(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createShiftSchema)) body: z.infer<typeof createShiftSchema>,
  ) {
    return this.academic.createShift(principal, requireInstitution(), body);
  }

  @Patch('shifts/:id')
  @RequirePermissions('academic.shifts.manage')
  @Audited({
    module: 'academic',
    resourceType: 'shift',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update a shift' })
  async updateShift(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateShiftSchema)) body: z.infer<typeof updateShiftSchema>,
  ) {
    const result = await this.academic.updateShift(
      principal,
      requireInstitution(),
      params.id,
      body,
    );
    return { ...result.shift, __audit: { previousValue: result.previous, newValue: body } };
  }

  /**
   * Declared before any `shifts/:id` route that could swallow it. Nest matches in declaration
   * order, and getting this backwards produces a confusing error on a route that is fine.
   */
  @Get('shifts/:id/periods')
  @RequirePermissions('timetable.view', 'academic.shifts.manage', { mode: 'any' })
  @ApiOperation({ summary: 'List the bell schedule of a shift' })
  async listPeriods(@Param(zodParam(idParamSchema)) params: { id: string }) {
    return this.academic.listPeriods(requireInstitution(), params.id);
  }

  @Put('periods')
  @RequirePermissions('academic.shifts.manage')
  @Audited({ module: 'academic', resourceType: 'period', action: 'update' })
  @ApiOperation({
    summary: 'Replace the full bell schedule of a shift',
    description:
      'Periods are validated as a set: numbers must run from 1 with no gaps, no two periods may overlap, and every period must lie inside its shift.',
  })
  async replacePeriods(
    @CurrentUser() principal: Principal,
    @Body(zodBody(replacePeriodsSchema)) body: z.infer<typeof replacePeriodsSchema>,
  ) {
    return this.academic.replacePeriods(principal, requireInstitution(), body);
  }

  // ── Academic calendar ───────────────────────────────────────────────────────────────

  @Get('calendar')
  @RequirePermissions('academic.calendar.view')
  @ApiOperation({ summary: 'List calendar entries, optionally within a date range' })
  async listCalendar(
    @Query(zodQuery(listCalendarEventsSchema)) query: z.infer<typeof listCalendarEventsSchema>,
  ) {
    return this.academic.listCalendarEvents(requireInstitution(), query);
  }

  @Post('calendar')
  @RequirePermissions('academic.calendar.manage')
  @Audited({
    module: 'academic',
    resourceType: 'calendar_event',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Add a holiday, exam window, vacation, event or working day' })
  async createCalendarEvent(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createCalendarEventSchema)) body: z.infer<typeof createCalendarEventSchema>,
  ) {
    return this.academic.createCalendarEvent(principal, requireInstitution(), body);
  }

  @Patch('calendar/:id')
  @RequirePermissions('academic.calendar.manage')
  @Audited({
    module: 'academic',
    resourceType: 'calendar_event',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update a calendar entry' })
  async updateCalendarEvent(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateCalendarEventSchema)) body: z.infer<typeof updateCalendarEventSchema>,
  ) {
    const result = await this.academic.updateCalendarEvent(
      principal,
      requireInstitution(),
      params.id,
      body,
    );
    return { ...result.event, __audit: { previousValue: result.previous, newValue: body } };
  }

  /**
   * Only a future, unreferenced entry can be removed, and "removed" means archived — a past
   * holiday is already baked into every attendance percentage for that month.
   */
  @Delete('calendar/:id')
  @RequirePermissions('academic.calendar.manage')
  @Audited({
    module: 'academic',
    resourceType: 'calendar_event',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Remove a future calendar entry' })
  async deleteCalendarEvent(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(deleteCalendarEventSchema)) body: { reason: string },
  ) {
    return this.academic.deleteCalendarEvent(
      principal,
      requireInstitution(),
      params.id,
      body.reason,
    );
  }

  // ── Curriculum ──────────────────────────────────────────────────────────────────────

  @Get('curriculum')
  @RequirePermissions('academic.subjects.view')
  @ApiOperation({ summary: 'List the curriculum for an academic year, optionally by class' })
  async listCurriculum(
    @Query(zodQuery(listClassSubjectsSchema)) query: z.infer<typeof listClassSubjectsSchema>,
  ) {
    return this.academic.listClassSubjects(requireInstitution(), query);
  }

  @Put('curriculum')
  @RequirePermissions('academic.subjects.manage')
  @Audited({ module: 'academic', resourceType: 'class_subject', action: 'update' })
  @ApiOperation({
    summary: 'Replace the curriculum of one class level for one academic year',
    description:
      'Validated as a set: a subject appears at most once per group, and each entry’s mark components must add up to its full marks.',
  })
  async replaceCurriculum(
    @CurrentUser() principal: Principal,
    @Body(zodBody(replaceClassSubjectsSchema)) body: z.infer<typeof replaceClassSubjectsSchema>,
  ) {
    return this.academic.replaceClassSubjects(principal, requireInstitution(), body);
  }

  // ── Teacher assignments ─────────────────────────────────────────────────────────────
  //
  // Assignment rows are what `students.view.assigned` resolves against, so these routes change
  // who can see which children. They are audited in both directions and unassignment requires
  // a written reason.

  @Get('assignments')
  @RequirePermissions('academic.sections.view', 'academic.assignments.manage', { mode: 'any' })
  @ApiOperation({ summary: 'List class-teacher and subject-teacher assignments' })
  async listAssignments(
    @Query(zodQuery(listTeacherAssignmentsSchema))
    query: z.infer<typeof listTeacherAssignmentsSchema>,
  ) {
    return this.academic.listTeacherAssignments(requireInstitution(), query);
  }

  @Post('assignments/sections')
  @RequirePermissions('academic.assignments.manage')
  @Audited({
    module: 'academic',
    resourceType: 'employee_section_assignment',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Assign an employee to a section, normally as its class teacher' })
  async assignSectionTeacher(
    @CurrentUser() principal: Principal,
    @Body(zodBody(assignSectionTeacherSchema)) body: z.infer<typeof assignSectionTeacherSchema>,
  ) {
    return this.academic.assignSectionTeacher(principal, requireInstitution(), body);
  }

  @Post('assignments/sections/:id/unassign')
  @RequirePermissions('academic.assignments.manage')
  @Audited({
    module: 'academic',
    resourceType: 'employee_section_assignment',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'End a section assignment' })
  async unassignSectionTeacher(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(unassignTeacherSchema)) body: { reason: string },
  ) {
    return this.academic.unassignSectionTeacher(
      principal,
      requireInstitution(),
      params.id,
      body.reason,
    );
  }

  @Post('assignments/subjects')
  @RequirePermissions('academic.assignments.manage')
  @Audited({
    module: 'academic',
    resourceType: 'employee_subject_assignment',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Assign an employee to teach one subject to one section' })
  async assignSubjectTeacher(
    @CurrentUser() principal: Principal,
    @Body(zodBody(assignSubjectTeacherSchema)) body: z.infer<typeof assignSubjectTeacherSchema>,
  ) {
    return this.academic.assignSubjectTeacher(principal, requireInstitution(), body);
  }

  @Post('assignments/subjects/:id/unassign')
  @RequirePermissions('academic.assignments.manage')
  @Audited({
    module: 'academic',
    resourceType: 'employee_subject_assignment',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'End a subject assignment' })
  async unassignSubjectTeacher(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(unassignTeacherSchema)) body: { reason: string },
  ) {
    return this.academic.unassignSubjectTeacher(
      principal,
      requireInstitution(),
      params.id,
      body.reason,
    );
  }
}

function requireInstitution(): string {
  const institutionId = currentContext()?.institutionId;
  if (!institutionId) {
    throw new BadRequestException('Send the x-institution-id header for academic endpoints.');
  }
  return institutionId;
}
