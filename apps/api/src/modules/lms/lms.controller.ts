/**
 * Learning Management System endpoints (Phase 10).
 *
 * Every route is `@InstitutionScoped()`: a course belongs to one class level of one
 * institution, and a group administrator running three schools has no safe default. The
 * header is required by the tenant guard rather than guessed here.
 *
 * The permission split, using the LMS catalogue entries:
 *
 *   lms.view           — read, within the caller's row scope (staff see all/assigned
 *                        classes' courses; students and guardians see enrolled + published).
 *                        Also the student actions — recording progress, sitting a quiz —
 *                        because the catalogue has no `lms.submit`; the service pins those
 *                        paths to the caller's own student identity and fails closed.
 *   lms.manage         — author: courses, structure, resources, enrolment, quizzes, grading
 *   lms.publish        — the lifecycle switch: publish and withdraw courses and quizzes
 *   lms.progress.view  — rosters, attempt lists, the gradebook and completion report —
 *                        the views that name every student, which is staff data
 *
 * The guards answer "may they do this kind of thing"; *which rows* — which classes, whose
 * drafts, whose attempts — is decided in the service as SQL predicates, and an out-of-scope
 * record is a 404, never a 403. `quiz_options.is_correct` never leaves the service on a
 * student path at all — the projection does not carry the field.
 *
 * Route order matters: Nest matches in declaration order, so `reports/completion` and the
 * plain collections are declared before any `:id` route that could swallow them.
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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { normalizeOffsetPage } from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import {
  addLessonLinkResourceSchema,
  archiveCourseSchema,
  archiveQuizSchema,
  courseTransitionSchema,
  createCourseSchema,
  createQuizSchema,
  enrolCourseStudentsSchema,
  gradeQuizAnswerSchema,
  idParamSchema,
  listCourseEnrolmentsSchema,
  listCoursesSchema,
  listQuizAttemptsSchema,
  lmsCompletionQuerySchema,
  lmsResourceParamsSchema,
  quizTransitionSchema,
  recordLessonProgressSchema,
  replaceCourseModulesSchema,
  replaceModuleLessonsSchema,
  replaceQuizQuestionsSchema,
  submitQuizAttemptSchema,
  updateCourseSchema,
  updateQuizSchema,
} from '@shikkha/validation';
import { LmsService, type UploadedFileLike } from './lms.service';
import {
  Audited,
  CurrentUser,
  InstitutionScoped,
  RequirePermissions,
} from '../../common/decorators';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { currentContext } from '../../common/context/request-context';

@ApiTags('lms')
@Controller('lms')
@InstitutionScoped()
export class LmsController {
  constructor(private readonly lms: LmsService) {}

  // ── Courses ─────────────────────────────────────────────────────────────────────────

  @Get('courses')
  @RequirePermissions('lms.view')
  @ApiOperation({ summary: 'List courses within the caller’s data scope' })
  async listCourses(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listCoursesSchema)) query: z.infer<typeof listCoursesSchema>,
  ) {
    return this.lms.listCourses(principal, requireInstitution(), query, normalizeOffsetPage(query));
  }

  @Post('courses')
  @RequirePermissions('lms.manage')
  @Audited({
    module: 'lms',
    resourceType: 'course',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create a draft course for a class level and subject' })
  async createCourse(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createCourseSchema)) body: z.infer<typeof createCourseSchema>,
  ) {
    return this.lms.createCourse(principal, requireInstitution(), body);
  }

  /** Declared before the `courses/:id` routes so `reports` is never parsed as an id. */
  @Get('reports/completion')
  @RequirePermissions('lms.progress.view')
  @ApiOperation({ summary: 'Per-lesson and whole-course completion rates, computed in SQL' })
  async completionReport(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(lmsCompletionQuerySchema)) query: z.infer<typeof lmsCompletionQuerySchema>,
  ) {
    return this.lms.completionReport(principal, requireInstitution(), query.courseId);
  }

  @Get('courses/:id')
  @RequirePermissions('lms.view')
  @ApiOperation({ summary: 'One course with its visible modules and lesson summaries' })
  async findCourse(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.lms.findCourse(principal, requireInstitution(), params.id);
  }

  @Patch('courses/:id')
  @RequirePermissions('lms.manage')
  @Audited({ module: 'lms', resourceType: 'course', action: 'update', resourceIdFrom: 'param:id' })
  @ApiOperation({ summary: 'Update a course' })
  async updateCourse(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateCourseSchema)) body: z.infer<typeof updateCourseSchema>,
  ) {
    const result = await this.lms.updateCourse(principal, requireInstitution(), params.id, body);
    // `__audit` is read by the audit interceptor and stripped from the HTTP response, so the
    // trail records what actually changed rather than the whole submitted body.
    return { ...result.course, __audit: { previousValue: result.previous, newValue: body } };
  }

  @Post('courses/:id/publish')
  @RequirePermissions('lms.publish')
  @Audited({ module: 'lms', resourceType: 'course', action: 'publish', resourceIdFrom: 'param:id' })
  @ApiOperation({ summary: 'Publish a draft course to its class' })
  async publishCourse(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(courseTransitionSchema)) body: { version: number },
  ) {
    return this.lms.publishCourse(principal, requireInstitution(), params.id, body.version);
  }

  /** Withdrawal is an archive — a status change with a recorded reason, never a DELETE. */
  @Post('courses/:id/archive')
  @RequirePermissions('lms.publish')
  @Audited({
    module: 'lms',
    resourceType: 'course',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Withdraw (archive) a course' })
  async archiveCourse(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(archiveCourseSchema)) body: { reason: string; version: number },
  ) {
    return this.lms.archiveCourse(
      principal,
      requireInstitution(),
      params.id,
      body.reason,
      body.version,
    );
  }

  /** The whole ordered module set in one write — a PUT, because that is what a PUT means. */
  @Put('courses/:id/modules')
  @RequirePermissions('lms.manage')
  @Audited({
    module: 'lms',
    resourceType: 'course_module',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Replace the ordered module set of a course' })
  async replaceModules(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(replaceCourseModulesSchema)) body: z.infer<typeof replaceCourseModulesSchema>,
  ) {
    return this.lms.replaceModules(principal, requireInstitution(), params.id, body);
  }

  @Post('courses/:id/enrol')
  @RequirePermissions('lms.manage')
  @Audited({
    module: 'lms',
    resourceType: 'course_enrolment',
    action: 'create',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Enrol students in a course (idempotent over repeats)' })
  async enrolStudents(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(enrolCourseStudentsSchema)) body: z.infer<typeof enrolCourseStudentsSchema>,
  ) {
    return this.lms.enrolStudents(principal, requireInstitution(), params.id, body);
  }

  @Get('courses/:id/enrolments')
  @RequirePermissions('lms.progress.view')
  @ApiOperation({ summary: 'The course roster — every enrolled student' })
  async listEnrolments(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Query(zodQuery(listCourseEnrolmentsSchema)) query: z.infer<typeof listCourseEnrolmentsSchema>,
  ) {
    return this.lms.listEnrolments(
      principal,
      requireInstitution(),
      params.id,
      normalizeOffsetPage(query),
    );
  }

  @Get('courses/:id/gradebook')
  @RequirePermissions('lms.progress.view')
  @ApiOperation({ summary: 'Every enrolled student × every quiz, best graded score per pair' })
  async gradebook(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.lms.gradebook(principal, requireInstitution(), params.id);
  }

  // ── Lessons ─────────────────────────────────────────────────────────────────────────

  @Put('modules/:id/lessons')
  @RequirePermissions('lms.manage')
  @Audited({ module: 'lms', resourceType: 'lesson', action: 'update', resourceIdFrom: 'param:id' })
  @ApiOperation({ summary: 'Replace the ordered lesson set of a module' })
  async replaceLessons(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(replaceModuleLessonsSchema)) body: z.infer<typeof replaceModuleLessonsSchema>,
  ) {
    return this.lms.replaceLessons(principal, requireInstitution(), params.id, body);
  }

  @Get('lessons/:id')
  @RequirePermissions('lms.view')
  @ApiOperation({ summary: 'One lesson with its content and resources' })
  async lessonView(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.lms.lessonView(principal, requireInstitution(), params.id);
  }

  @Post('lessons/:id/resources')
  @RequirePermissions('lms.manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  @Audited({
    module: 'lms',
    resourceType: 'lesson_resource',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Attach a file to a lesson' })
  async addFileResource(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @UploadedFile() file: UploadedFileLike,
  ) {
    return this.lms.addFileResource(principal, requireInstitution(), params.id, file);
  }

  @Post('lessons/:id/resources/link')
  @RequirePermissions('lms.manage')
  @Audited({
    module: 'lms',
    resourceType: 'lesson_resource',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Attach a link or embedded video to a lesson' })
  async addLinkResource(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(addLessonLinkResourceSchema)) body: z.infer<typeof addLessonLinkResourceSchema>,
  ) {
    return this.lms.addLinkResource(principal, requireInstitution(), params.id, body);
  }

  @Get('lessons/:id/resources')
  @RequirePermissions('lms.view')
  @ApiOperation({ summary: 'List the resources of a lesson' })
  async listResources(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.lms.listResources(principal, requireInstitution(), params.id);
  }

  /**
   * Issue a signed, expiring download URL — never a static path. Audited as an export: the
   * trail shows who received which file and when.
   */
  @Get('lessons/:id/resources/:resourceId/download')
  @RequirePermissions('lms.view')
  @Audited({
    module: 'lms',
    resourceType: 'lesson_resource',
    action: 'export',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Get a short-lived download URL for a lesson resource' })
  async downloadResource(
    @CurrentUser() principal: Principal,
    @Param(zodParam(lmsResourceParamsSchema)) params: { id: string; resourceId: string },
  ) {
    const result = await this.lms.resourceDownloadUrl(
      principal,
      requireInstitution(),
      params.id,
      params.resourceId,
    );
    return {
      ...result,
      __audit: { newValue: { lessonId: params.id, resourceId: params.resourceId } },
    };
  }

  /**
   * A student reporting their own progress. Status only moves forward, `secondsSpent`
   * accumulates, and completion is stamped by the server clock — the service ignores every
   * derived fact a client might try to state.
   */
  @Post('lessons/:id/progress')
  @RequirePermissions('lms.view')
  @Audited({
    module: 'lms',
    resourceType: 'lesson_progress',
    action: 'update',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Record the caller’s own progress through a lesson (student)' })
  async recordProgress(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(recordLessonProgressSchema)) body: z.infer<typeof recordLessonProgressSchema>,
  ) {
    return this.lms.recordProgress(principal, requireInstitution(), params.id, body);
  }

  // ── Quizzes ─────────────────────────────────────────────────────────────────────────

  @Post('quizzes')
  @RequirePermissions('lms.manage')
  @Audited({ module: 'lms', resourceType: 'quiz', action: 'create', resourceIdFrom: 'response:id' })
  @ApiOperation({ summary: 'Create a draft quiz with its questions and options' })
  async createQuiz(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createQuizSchema)) body: z.infer<typeof createQuizSchema>,
  ) {
    return this.lms.createQuiz(principal, requireInstitution(), body);
  }

  /**
   * A caller who may manage the course receives the full definition, answer key included;
   * anyone else — students above all — receives metadata only. The service decides which.
   */
  @Get('quizzes/:id')
  @RequirePermissions('lms.view')
  @ApiOperation({ summary: 'One quiz — full definition for staff, metadata for students' })
  async quizView(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.lms.quizView(principal, requireInstitution(), params.id);
  }

  @Patch('quizzes/:id')
  @RequirePermissions('lms.manage')
  @Audited({ module: 'lms', resourceType: 'quiz', action: 'update', resourceIdFrom: 'param:id' })
  @ApiOperation({ summary: 'Update a draft quiz' })
  async updateQuiz(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateQuizSchema)) body: z.infer<typeof updateQuizSchema>,
  ) {
    const result = await this.lms.updateQuiz(principal, requireInstitution(), params.id, body);
    return { ...result.quiz, __audit: { previousValue: result.previous, newValue: body } };
  }

  @Put('quizzes/:id/questions')
  @RequirePermissions('lms.manage')
  @Audited({
    module: 'lms',
    resourceType: 'quiz_question',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Replace the whole question set of a draft quiz' })
  async replaceQuestions(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(replaceQuizQuestionsSchema)) body: z.infer<typeof replaceQuizQuestionsSchema>,
  ) {
    return this.lms.replaceQuestions(principal, requireInstitution(), params.id, body);
  }

  @Post('quizzes/:id/publish')
  @RequirePermissions('lms.publish')
  @Audited({ module: 'lms', resourceType: 'quiz', action: 'publish', resourceIdFrom: 'param:id' })
  @ApiOperation({ summary: 'Publish a draft quiz once its marks sum exactly to the total' })
  async publishQuiz(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(quizTransitionSchema)) body: { version: number },
  ) {
    return this.lms.publishQuiz(principal, requireInstitution(), params.id, body.version);
  }

  @Post('quizzes/:id/archive')
  @RequirePermissions('lms.publish')
  @Audited({
    module: 'lms',
    resourceType: 'quiz',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Withdraw (archive) a quiz' })
  async archiveQuiz(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(archiveQuizSchema)) body: { reason: string; version: number },
  ) {
    return this.lms.archiveQuiz(
      principal,
      requireInstitution(),
      params.id,
      body.reason,
      body.version,
    );
  }

  /**
   * Start an attempt (student). The server assigns the attempt number, refuses a start
   * beyond `attempts_allowed`, and stamps `started_at` — the sole anchor for the time
   * limit. The questions returned carry no `isCorrect`, structurally.
   */
  @Post('quizzes/:id/attempts')
  @RequirePermissions('lms.view')
  @Audited({
    module: 'lms',
    resourceType: 'quiz_attempt',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Start a quiz attempt (student)' })
  async startAttempt(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.lms.startAttempt(principal, requireInstitution(), params.id);
  }

  @Get('quizzes/:id/attempts')
  @RequirePermissions('lms.progress.view')
  @ApiOperation({ summary: 'List a quiz’s attempts (staff), optionally only pending grading' })
  async listAttempts(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Query(zodQuery(listQuizAttemptsSchema)) query: z.infer<typeof listQuizAttemptsSchema>,
  ) {
    return this.lms.listAttempts(
      principal,
      requireInstitution(),
      params.id,
      query,
      normalizeOffsetPage(query),
    );
  }

  /**
   * Submit an attempt. The time limit is judged from `started_at` against the server clock
   * — a client-supplied elapsed time does not exist in the schema. Choice questions are
   * auto-graded in exact hundredths; short-text answers queue for manual marking. A
   * submitted attempt is immutable.
   */
  @Post('attempts/:id/submit')
  @RequirePermissions('lms.view')
  @Audited({
    module: 'lms',
    resourceType: 'quiz_attempt',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Submit a quiz attempt (student)' })
  async submitAttempt(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(submitQuizAttemptSchema)) body: z.infer<typeof submitQuizAttemptSchema>,
  ) {
    return this.lms.submitAttempt(principal, requireInstitution(), params.id, body);
  }

  @Get('attempts/:id')
  @RequirePermissions('lms.view')
  @ApiOperation({ summary: 'One attempt with its answers — owner, linked guardian, or staff' })
  async attemptView(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.lms.attemptView(principal, requireInstitution(), params.id);
  }

  /**
   * Grade (or re-grade) one short-text answer. Re-grading a settled mark requires a reason,
   * and the service writes the before/after audit record inside the business transaction —
   * hence `recordedBy: 'service'`, so the interceptor does not write a second, before-less
   * row.
   */
  @Post('answers/:id/grade')
  @RequirePermissions('lms.manage')
  @Audited({
    module: 'lms',
    resourceType: 'quiz_answer',
    action: 'update',
    resourceIdFrom: 'param:id',
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Grade one short-text answer by hand' })
  async gradeAnswer(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(gradeQuizAnswerSchema)) body: z.infer<typeof gradeQuizAnswerSchema>,
  ) {
    const result = await this.lms.gradeAnswer(principal, requireInstitution(), params.id, body);
    return {
      ...result.answer,
      attempt: {
        id: result.attempt.id,
        score: result.attempt.score,
        isGraded: result.attempt.isGraded,
      },
      __audit: {
        previousValue: result.previous,
        newValue: { marksAwarded: result.answer.marksAwarded },
      },
    };
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
      'Send the x-institution-id header to indicate which institution this course belongs to.',
    );
  }
  return institutionId;
}
