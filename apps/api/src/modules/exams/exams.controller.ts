/**
 * Examination and result endpoints (Phase 8).
 *
 * Every route is `@InstitutionScoped()`: an exam belongs to one institution, and a group
 * administrator running three schools has no sensible default. Requiring the header makes the
 * ambiguity impossible rather than resolving it with a guess.
 *
 * The permissions on these routes *are* the separation of duties, so they are worth reading
 * as a set rather than one at a time:
 *
 *   results.enter_marks   — the subject teacher, and only for a paper they are assigned to
 *   results.submit_marks  — the same person, declaring the paper finished
 *   results.review        — someone else, moving the exam into review
 *   results.approve       — someone else again, and never the person who entered the marks
 *   results.publish       — a distinct act from approval; this is what parents see
 *   results.unpublish     — retraction, with a mandatory reason
 *   results.correct       — changing an approved mark, with a mandatory reason
 *
 * No role preset in `packages/permissions/src/roles.ts` holds both `results.enter_marks` and
 * `results.approve`, and `ExamsService.approveMarks` refuses self-approval on the data as
 * well, so the split holds even if a school invents a role that does.
 *
 * Route order matters: Nest matches in declaration order, so every literal segment
 * (`grading-scales`, `schedules`, `marks`) is declared before the `:id` routes that would
 * otherwise swallow it and report a confusing "not a valid identifier".
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { normalizeOffsetPage } from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import {
  approveExamMarksSchema,
  archiveExamSchema,
  archiveExamScheduleSchema,
  archiveGradingScaleSchema,
  changeExamStatusSchema,
  correctExamMarkSchema,
  createExamScheduleSchema,
  createExamSchema,
  createGradingScaleSchema,
  enterExamMarksSchema,
  examSummaryQuerySchema,
  examTabulationQuerySchema,
  idParamSchema,
  listExamMarksSchema,
  listExamSchedulesSchema,
  listExamsSchema,
  listGradingScalesSchema,
  listResultsSchema,
  publishExamResultsSchema,
  replaceExamSubjectsSchema,
  replaceGradeBandsSchema,
  reviewExamSchema,
  submitExamMarksSchema,
  unpublishExamResultsSchema,
  updateExamScheduleSchema,
  updateExamSchema,
  updateGradingScaleSchema,
  uuidSchema,
} from '@shikkha/validation';
import { ExamsService } from './exams.service';
import {
  Audited,
  CurrentUser,
  InstitutionScoped,
  RequirePermissions,
} from '../../common/decorators';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { currentContext } from '../../common/context/request-context';

@ApiTags('exams')
@Controller('exams')
@InstitutionScoped()
export class ExamsController {
  constructor(private readonly exams: ExamsService) {}

  // ── Grading scales ──────────────────────────────────────────────────────────────────
  //
  // Declared first so `grading-scales` is never parsed as an exam id.

  @Get('grading-scales')
  @RequirePermissions('exams.view', 'exams.grading_scheme.manage', { mode: 'any' })
  @ApiOperation({ summary: 'List grading scales' })
  async listGradingScales(
    @Query(zodQuery(listGradingScalesSchema)) query: z.infer<typeof listGradingScalesSchema>,
  ) {
    return this.exams.listGradingScales(requireInstitution(), query);
  }

  @Post('grading-scales')
  @RequirePermissions('exams.grading_scheme.manage')
  @Audited({
    module: 'exams',
    resourceType: 'grading_scale',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create a grading scale' })
  async createGradingScale(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createGradingScaleSchema)) body: z.infer<typeof createGradingScaleSchema>,
  ) {
    return this.exams.createGradingScale(principal, requireInstitution(), body);
  }

  @Get('grading-scales/:id')
  @RequirePermissions('exams.view', 'exams.grading_scheme.manage', { mode: 'any' })
  @ApiOperation({ summary: 'One grading scale with its bands' })
  async findGradingScale(@Param(zodParam(idParamSchema)) params: { id: string }) {
    return this.exams.findGradingScale(requireInstitution(), params.id);
  }

  @Patch('grading-scales/:id')
  @RequirePermissions('exams.grading_scheme.manage')
  @Audited({
    module: 'exams',
    resourceType: 'grading_scale',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update a grading scale' })
  async updateGradingScale(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateGradingScaleSchema)) body: z.infer<typeof updateGradingScaleSchema>,
  ) {
    const result = await this.exams.updateGradingScale(
      principal,
      requireInstitution(),
      params.id,
      body,
    );
    // `__audit` is read by the audit interceptor and stripped from the HTTP response, so the
    // trail records what actually changed rather than the whole submitted body.
    return { ...result.scale, __audit: { previousValue: result.previous, newValue: body } };
  }

  /**
   * Replace a scale's bands as a set.
   *
   * Coverage of 0 to 100 without overlap or gap is a property of the whole set, so there is no
   * per-band endpoint: editing one at a time would pass through states no validator could
   * sensibly accept or reject.
   */
  @Put('grading-scales/:id/bands')
  @RequirePermissions('exams.grading_scheme.manage')
  @Audited({
    module: 'exams',
    resourceType: 'grade_band',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({
    summary: 'Replace the grade bands of a scale',
    description:
      'Bands are half-open [min, max) with the top band closed at 100. They must cover 0 to 100 with no overlap and no gap.',
  })
  async replaceGradeBands(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(replaceGradeBandsSchema)) body: z.infer<typeof replaceGradeBandsSchema>,
  ) {
    return this.exams.replaceGradeBands(principal, requireInstitution(), params.id, body.bands);
  }

  @Post('grading-scales/:id/archive')
  @RequirePermissions('exams.grading_scheme.manage')
  @Audited({
    module: 'exams',
    resourceType: 'grading_scale',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive a grading scale' })
  async archiveGradingScale(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(archiveGradingScaleSchema)) body: { reason: string },
  ) {
    return this.exams.archiveGradingScale(principal, requireInstitution(), params.id, body.reason);
  }

  // ── Schedules by their own id ───────────────────────────────────────────────────────
  //
  // `schedules/:id` is two segments and cannot collide with `:id`, but it is declared up here
  // with the other literals so the file reads in the order Nest matches.

  @Patch('schedules/:id')
  @RequirePermissions('exams.schedule.manage')
  @Audited({
    module: 'exams',
    resourceType: 'exam_schedule',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update an exam schedule, re-checking room and invigilator clashes' })
  async updateSchedule(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateExamScheduleSchema)) body: z.infer<typeof updateExamScheduleSchema>,
  ) {
    const result = await this.exams.updateSchedule(
      principal,
      requireInstitution(),
      params.id,
      body,
    );
    return { ...result.schedule, __audit: { previousValue: result.previous, newValue: body } };
  }

  @Post('schedules/:id/archive')
  @RequirePermissions('exams.schedule.manage')
  @Audited({
    module: 'exams',
    resourceType: 'exam_schedule',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive an exam schedule' })
  async archiveSchedule(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(archiveExamScheduleSchema)) body: { reason: string },
  ) {
    return this.exams.archiveSchedule(principal, requireInstitution(), params.id, body.reason);
  }

  // ── Corrections ─────────────────────────────────────────────────────────────────────

  /**
   * Change an approved mark.
   *
   * Its own permission, its own endpoint, and a reason the interceptor refuses to proceed
   * without. The before and after values go into the audit record, which is what makes the
   * change defensible when a parent asks about it three months later.
   */
  @Patch('marks/:id')
  @RequirePermissions('results.correct')
  @Audited({
    module: 'exams',
    resourceType: 'exam_mark',
    action: 'update',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Correct an approved mark' })
  async correctMark(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(correctExamMarkSchema)) body: z.infer<typeof correctExamMarkSchema>,
  ) {
    const result = await this.exams.correctMark(principal, requireInstitution(), params.id, body);
    return {
      ...result.mark,
      __audit: { previousValue: result.previous, newValue: body },
    };
  }

  // ── Exams ───────────────────────────────────────────────────────────────────────────

  @Get()
  @RequirePermissions('exams.view')
  @ApiOperation({ summary: 'List exams' })
  async list(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listExamsSchema)) query: z.infer<typeof listExamsSchema>,
  ) {
    return this.exams.listExams(principal, requireInstitution(), query, normalizeOffsetPage(query));
  }

  @Post()
  @RequirePermissions('exams.manage')
  @Audited({
    module: 'exams',
    resourceType: 'exam',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create an exam' })
  async create(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createExamSchema)) body: z.infer<typeof createExamSchema>,
  ) {
    return this.exams.createExam(principal, requireInstitution(), body);
  }

  @Get(':id')
  @RequirePermissions('exams.view')
  @ApiOperation({ summary: 'One exam, with its grading scale and subject count' })
  async findOne(@Param(zodParam(idParamSchema)) params: { id: string }) {
    return this.exams.findExam(requireInstitution(), params.id);
  }

  @Patch(':id')
  @RequirePermissions('exams.manage')
  @Audited({
    module: 'exams',
    resourceType: 'exam',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update an exam' })
  async update(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateExamSchema)) body: z.infer<typeof updateExamSchema>,
  ) {
    const result = await this.exams.updateExam(principal, requireInstitution(), params.id, body);
    return { ...result.exam, __audit: { previousValue: result.previous, newValue: body } };
  }

  /**
   * Move an exam between the states `exams.manage` owns.
   *
   * `under_review` and `published` are refused here even though they are real states: each is
   * reached only through its own permissioned endpoint, so that "may schedule an exam" can
   * never become "may publish results".
   */
  @Post(':id/status')
  @RequirePermissions('exams.manage')
  @Audited({
    module: 'exams',
    resourceType: 'exam',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Change an exam’s workflow status' })
  async changeStatus(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(changeExamStatusSchema)) body: z.infer<typeof changeExamStatusSchema>,
  ) {
    const result = await this.exams.changeExamStatus(
      principal,
      requireInstitution(),
      params.id,
      body.status,
    );
    return { ...result.exam, __audit: { previousValue: result.previous, newValue: body } };
  }

  @Post(':id/archive')
  @RequirePermissions('exams.manage')
  @Audited({
    module: 'exams',
    resourceType: 'exam',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive an exam' })
  async archive(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(archiveExamSchema)) body: { reason: string },
  ) {
    return this.exams.archiveExam(principal, requireInstitution(), params.id, body.reason);
  }

  // ── Exam subjects ───────────────────────────────────────────────────────────────────

  @Get(':id/subjects')
  @RequirePermissions('exams.view')
  @ApiOperation({ summary: 'The subject configuration of an exam' })
  async listSubjects(
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Query(zodQuery(z.object({ classLevelId: uuidSchema.optional() })))
    query: { classLevelId?: string },
  ) {
    return this.exams.listExamSubjects(requireInstitution(), params.id, query.classLevelId);
  }

  @Put(':id/subjects')
  @RequirePermissions('exams.manage')
  @Audited({
    module: 'exams',
    resourceType: 'exam_subject',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({
    summary: 'Replace the subject configuration for one class level in an exam',
    description:
      'Replaced as a set, because the written / MCQ / practical / continuous components must add up to each paper’s full marks.',
  })
  async replaceSubjects(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(replaceExamSubjectsSchema)) body: z.infer<typeof replaceExamSubjectsSchema>,
  ) {
    return this.exams.replaceExamSubjects(
      principal,
      requireInstitution(),
      params.id,
      body.classLevelId,
      body.subjects,
    );
  }

  // ── Schedules ───────────────────────────────────────────────────────────────────────

  @Get(':id/schedules')
  @RequirePermissions('exams.view')
  @ApiOperation({ summary: 'The timetable of an exam' })
  async listSchedules(
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Query(zodQuery(listExamSchedulesSchema)) query: z.infer<typeof listExamSchedulesSchema>,
  ) {
    return this.exams.listSchedules(requireInstitution(), params.id, query);
  }

  @Post(':id/schedules')
  @RequirePermissions('exams.schedule.manage')
  @Audited({
    module: 'exams',
    resourceType: 'exam_schedule',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({
    summary: 'Schedule a paper',
    description:
      'Refused when the room or the invigilator is already committed to an overlapping paper.',
  })
  async createSchedule(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(createExamScheduleSchema)) body: z.infer<typeof createExamScheduleSchema>,
  ) {
    return this.exams.createSchedule(principal, requireInstitution(), params.id, body);
  }

  // ── Marks ───────────────────────────────────────────────────────────────────────────

  /**
   * Raw marks, within the caller's data scope.
   *
   * `results.view.own` is deliberately not accepted: a family sees a published result, not the
   * mark sheet it was computed from.
   */
  @Get(':id/marks')
  @RequirePermissions('results.view.all', 'results.view.assigned', { mode: 'any' })
  @ApiOperation({ summary: 'Marks entered for an exam, within the caller’s data scope' })
  async listMarks(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Query(zodQuery(listExamMarksSchema)) query: z.infer<typeof listExamMarksSchema>,
  ) {
    return this.exams.listMarks(principal, requireInstitution(), params.id, query);
  }

  @Put(':id/marks')
  @RequirePermissions('results.enter_marks')
  @Audited({
    module: 'exams',
    resourceType: 'exam_mark',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({
    summary: 'Enter marks for one paper, in bulk',
    description:
      'One transaction. Allowed only while the exam is in mark entry, and only for a subject and section the caller is assigned to.',
  })
  async enterMarks(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(enterExamMarksSchema)) body: z.infer<typeof enterExamMarksSchema>,
  ) {
    const result = await this.exams.enterMarks(principal, requireInstitution(), params.id, body);
    return {
      examSubjectId: result.examSubjectId,
      saved: result.saved,
      marks: result.marks,
      __audit: {
        newValue: { examSubjectId: body.examSubjectId, savedCount: result.saved },
      },
    };
  }

  @Post(':id/marks/submit')
  @RequirePermissions('results.submit_marks')
  @Audited({
    module: 'exams',
    resourceType: 'exam_mark',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({
    summary: 'Submit a paper’s marks for review',
    description: 'Refused while any enrolled student has neither a mark nor an absence.',
  })
  async submitMarks(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(submitExamMarksSchema)) body: z.infer<typeof submitExamMarksSchema>,
  ) {
    return this.exams.submitMarks(principal, requireInstitution(), params.id, body);
  }

  @Post(':id/review')
  @RequirePermissions('results.review')
  @Audited({
    module: 'exams',
    resourceType: 'exam',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Move an exam into review once every paper has been submitted' })
  async review(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(reviewExamSchema)) body: z.infer<typeof reviewExamSchema>,
  ) {
    const result = await this.exams.reviewExam(principal, requireInstitution(), params.id);
    return {
      ...result.exam,
      reviewed: result.reviewed,
      __audit: { previousValue: result.previous, newValue: { status: 'under_review', ...body } },
    };
  }

  @Post(':id/approve')
  @RequirePermissions('results.approve')
  @Audited({
    module: 'exams',
    resourceType: 'exam_mark',
    action: 'approve',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({
    summary: 'Approve submitted marks',
    description: 'Refused when the approver is the person who entered the marks.',
  })
  async approve(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(approveExamMarksSchema)) body: z.infer<typeof approveExamMarksSchema>,
  ) {
    return this.exams.approveMarks(principal, requireInstitution(), params.id, body);
  }

  // ── Publication ─────────────────────────────────────────────────────────────────────

  @Post(':id/publish')
  @RequirePermissions('results.publish')
  @Audited({
    module: 'exams',
    resourceType: 'exam',
    action: 'publish',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({
    summary: 'Compute and publish results for every student in the exam',
    description:
      'One transaction: totals, percentage, GPA, grade and positions. Positions use a SQL window function, so tied totals share a position.',
  })
  async publish(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(publishExamResultsSchema)) body: z.infer<typeof publishExamResultsSchema>,
  ) {
    const result = await this.exams.publishResults(principal, requireInstitution(), params.id);
    return {
      ...result.exam,
      published: result.published,
      __audit: {
        previousValue: result.previous,
        newValue: { status: 'published', published: result.published, ...body },
      },
    };
  }

  @Post(':id/unpublish')
  @RequirePermissions('results.unpublish')
  @Audited({
    module: 'exams',
    resourceType: 'exam',
    action: 'unpublish',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({
    summary: 'Retract published results',
    description:
      'The computed results are kept and only their publication is withdrawn — deleting them would destroy the evidence of what families were shown.',
  })
  async unpublish(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(unpublishExamResultsSchema)) body: { reason: string },
  ) {
    const result = await this.exams.unpublishResults(
      principal,
      requireInstitution(),
      params.id,
      body.reason,
    );
    return {
      ...result.exam,
      retracted: result.retracted,
      __audit: {
        previousValue: result.previous,
        newValue: {
          status: 'under_review',
          retracted: result.retracted,
          reason: result.reason,
        },
      },
    };
  }

  // ── Reading results ─────────────────────────────────────────────────────────────────

  @Get(':id/tabulation')
  @RequirePermissions('results.view.all', 'results.view.assigned', { mode: 'any' })
  @ApiOperation({ summary: 'The tabulation sheet for one section: every student, every paper' })
  async tabulation(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Query(zodQuery(examTabulationQuerySchema)) query: z.infer<typeof examTabulationQuerySchema>,
  ) {
    return this.exams.tabulation(principal, requireInstitution(), params.id, query.sectionId);
  }

  @Get(':id/summary')
  @RequirePermissions('results.reports.view', 'results.view.all', { mode: 'any' })
  @ApiOperation({
    summary: 'Pass rate and grade distribution for a class or section',
    description: 'Aggregated in SQL, so the report does not grow a round trip per student.',
  })
  async summary(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Query(zodQuery(examSummaryQuerySchema)) query: z.infer<typeof examSummaryQuerySchema>,
  ) {
    return this.exams.summary(principal, requireInstitution(), params.id, query);
  }

  @Get(':id/results')
  @RequirePermissions('results.view.all', 'results.view.assigned', 'results.view.own', {
    mode: 'any',
  })
  @ApiOperation({ summary: 'Results for an exam, within the caller’s data scope' })
  async listResults(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Query(zodQuery(listResultsSchema)) query: z.infer<typeof listResultsSchema>,
  ) {
    return this.exams.listResults(
      principal,
      requireInstitution(),
      params.id,
      query,
      normalizeOffsetPage(query),
    );
  }

  /**
   * One student's marksheet.
   *
   * Reachable by a guardian with `results.view.own`, and for them the scope filter adds
   * "published only" — so guessing a result id gets a 404 until the school has actually
   * published, and a 404 for another family's child forever.
   */
  @Get(':id/marksheet/:studentId')
  @RequirePermissions('results.view.all', 'results.view.assigned', 'results.view.own', {
    mode: 'any',
  })
  @ApiOperation({ summary: 'A single student’s marksheet for an exam' })
  async marksheet(
    @CurrentUser() principal: Principal,
    @Param(zodParam(z.object({ id: uuidSchema, studentId: uuidSchema })))
    params: { id: string; studentId: string },
  ) {
    return this.exams.marksheet(principal, requireInstitution(), params.id, params.studentId);
  }
}

/**
 * `@InstitutionScoped()` and this helper are belt and braces: the tenant guard refuses the
 * request without the header, and this re-reads it because `currentContext()` is typed
 * `string | null` and a service should not have to handle a case the guard already excluded.
 */
function requireInstitution(): string {
  const institutionId = currentContext()?.institutionId;
  if (!institutionId) {
    throw new BadRequestException(
      'Send the x-institution-id header to indicate which institution this exam belongs to.',
    );
  }
  return institutionId;
}
