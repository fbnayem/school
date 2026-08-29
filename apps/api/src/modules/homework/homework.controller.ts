/**
 * Homework endpoints (Phase 9).
 *
 * Every route is `@InstitutionScoped()`: an assignment belongs to a section of an
 * institution, and a group administrator running three schools has no safe default.
 *
 * The permission split, using the homework catalogue entries:
 *
 *   homework.view    — read, within the caller's row scope (staff see all/assigned
 *                      sections' work; students and guardians see enrolled + published)
 *   homework.create  — set work, only for a section+subject the teacher is assigned to
 *   homework.update  — edit, publish, close, attach teacher files
 *   homework.delete  — withdraw (a status change plus archive marker; never a DELETE)
 *   homework.grade   — mark submissions
 *   homework.submit  — a student handing work in
 *
 * The guards answer "may they do this kind of thing"; *which rows* — which sections, whose
 * submissions, whose attachments — is decided in the service as SQL predicates, and an
 * out-of-scope record is a 404, never a 403.
 *
 * Route order matters: literal paths (`reports/completion`, `students/:id/...`) and the
 * plain `assignments` collection are declared before `assignments/:id` — Express matches in
 * declaration order.
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
  archiveAssignmentSchema,
  assignmentTransitionSchema,
  bulkGradeSchema,
  createAssignmentSchema,
  gradeSubmissionSchema,
  homeworkAttachmentParamsSchema,
  homeworkCompletionQuerySchema,
  idParamSchema,
  listAssignmentsSchema,
  listSubmissionsSchema,
  studentSubmissionHistorySchema,
  submitHomeworkSchema,
  updateAssignmentSchema,
} from '@shikkha/validation';
import { HomeworkService, type UploadedFileLike } from './homework.service';
import {
  Audited,
  CurrentUser,
  InstitutionScoped,
  RequirePermissions,
} from '../../common/decorators';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { currentContext } from '../../common/context/request-context';

@ApiTags('homework')
@Controller('homework')
@InstitutionScoped()
export class HomeworkController {
  constructor(private readonly homework: HomeworkService) {}

  // ── Assignments ─────────────────────────────────────────────────────────────────────

  @Get('assignments')
  @RequirePermissions('homework.view')
  @ApiOperation({ summary: 'List assignments within the caller’s data scope' })
  async list(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listAssignmentsSchema)) query: z.infer<typeof listAssignmentsSchema>,
  ) {
    return this.homework.list(principal, requireInstitution(), query, normalizeOffsetPage(query));
  }

  @Post('assignments')
  @RequirePermissions('homework.create')
  @Audited({
    module: 'homework',
    resourceType: 'assignment',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create a draft assignment for a section and subject' })
  async create(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createAssignmentSchema)) body: z.infer<typeof createAssignmentSchema>,
  ) {
    return this.homework.create(principal, requireInstitution(), body);
  }

  /**
   * Declared before the `assignments/:id` routes so `reports` and `students` are never
   * parsed as ids.
   */
  @Get('reports/completion')
  @RequirePermissions('homework.view')
  @ApiOperation({ summary: 'Per-assignment completion rates for one section, computed in SQL' })
  async completionReport(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(homeworkCompletionQuerySchema))
    query: z.infer<typeof homeworkCompletionQuerySchema>,
  ) {
    return this.homework.completionReport(principal, requireInstitution(), query.sectionId);
  }

  @Get('students/:id/submissions')
  @RequirePermissions('homework.view')
  @ApiOperation({ summary: 'One student’s submission history across assignments' })
  async studentHistory(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Query(zodQuery(studentSubmissionHistorySchema))
    query: z.infer<typeof studentSubmissionHistorySchema>,
  ) {
    return this.homework.studentHistory(
      principal,
      requireInstitution(),
      params.id,
      query,
      normalizeOffsetPage(query),
    );
  }

  @Get('assignments/:id')
  @RequirePermissions('homework.view')
  @ApiOperation({ summary: 'Fetch one assignment with its attachments' })
  async findOne(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.homework.findOne(principal, requireInstitution(), params.id);
  }

  @Patch('assignments/:id')
  @RequirePermissions('homework.update')
  @Audited({
    module: 'homework',
    resourceType: 'assignment',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update an assignment' })
  async update(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateAssignmentSchema)) body: z.infer<typeof updateAssignmentSchema>,
  ) {
    const result = await this.homework.update(principal, requireInstitution(), params.id, body);
    // `__audit` is read by the audit interceptor and stripped from the HTTP response, so the
    // trail records what actually changed rather than the whole submitted body.
    return { ...result.assignment, __audit: { previousValue: result.previous, newValue: body } };
  }

  @Post('assignments/:id/publish')
  @RequirePermissions('homework.update')
  @Audited({
    module: 'homework',
    resourceType: 'assignment',
    action: 'publish',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Publish a draft assignment to its section' })
  async publish(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(assignmentTransitionSchema)) body: { version: number },
  ) {
    return this.homework.publish(principal, requireInstitution(), params.id, body.version);
  }

  @Post('assignments/:id/close')
  @RequirePermissions('homework.update')
  @Audited({
    module: 'homework',
    resourceType: 'assignment',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Close a published assignment to further submissions' })
  async close(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(assignmentTransitionSchema)) body: { version: number },
  ) {
    return this.homework.close(principal, requireInstitution(), params.id, body.version);
  }

  /** Withdrawal is an archive — a status change with a recorded reason, never a DELETE. */
  @Post('assignments/:id/archive')
  @RequirePermissions('homework.delete')
  @Audited({
    module: 'homework',
    resourceType: 'assignment',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Withdraw (archive) an assignment' })
  async archive(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(archiveAssignmentSchema)) body: { reason: string; version: number },
  ) {
    return this.homework.archive(
      principal,
      requireInstitution(),
      params.id,
      body.reason,
      body.version,
    );
  }

  // ── Assignment attachments ──────────────────────────────────────────────────────────

  @Post('assignments/:id/attachments')
  @RequirePermissions('homework.update')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  @Audited({
    module: 'homework',
    resourceType: 'assignment_attachment',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Attach a file to an assignment' })
  async uploadAssignmentAttachment(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @UploadedFile() file: UploadedFileLike,
  ) {
    return this.homework.addAssignmentAttachment(principal, requireInstitution(), params.id, file);
  }

  /**
   * Issue a signed, expiring download URL — never a static path. Audited as an export: the
   * trail shows who received which file and when.
   */
  @Get('assignments/:id/attachments/:attachmentId/download')
  @RequirePermissions('homework.view')
  @Audited({
    module: 'homework',
    resourceType: 'assignment_attachment',
    action: 'export',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Get a short-lived signed download URL for an assignment file' })
  async downloadAssignmentAttachment(
    @CurrentUser() principal: Principal,
    @Param(zodParam(homeworkAttachmentParamsSchema))
    params: { id: string; attachmentId: string },
  ) {
    const result = await this.homework.assignmentAttachmentDownloadUrl(
      principal,
      requireInstitution(),
      params.id,
      params.attachmentId,
    );
    return {
      ...result,
      __audit: { newValue: { assignmentId: params.id, attachmentId: params.attachmentId } },
    };
  }

  // ── Submissions ─────────────────────────────────────────────────────────────────────

  @Get('assignments/:id/submissions')
  @RequirePermissions('homework.view')
  @ApiOperation({ summary: 'List submissions for an assignment within the caller’s scope' })
  async listSubmissions(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Query(zodQuery(listSubmissionsSchema)) query: z.infer<typeof listSubmissionsSchema>,
  ) {
    return this.homework.listSubmissions(
      principal,
      requireInstitution(),
      params.id,
      query,
      normalizeOffsetPage(query),
    );
  }

  @Post('assignments/:id/submissions')
  @RequirePermissions('homework.submit')
  @Audited({
    module: 'homework',
    resourceType: 'assignment_submission',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Submit homework (student). Lateness is decided by the server clock' })
  async submit(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(submitHomeworkSchema)) body: z.infer<typeof submitHomeworkSchema>,
  ) {
    return this.homework.submit(principal, requireInstitution(), params.id, body);
  }

  @Post('assignments/:id/resubmit')
  @RequirePermissions('homework.submit')
  @Audited({
    module: 'homework',
    resourceType: 'assignment_submission',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Hand in a new attempt for an already-submitted assignment' })
  async resubmit(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(submitHomeworkSchema)) body: z.infer<typeof submitHomeworkSchema>,
  ) {
    return this.homework.resubmit(principal, requireInstitution(), params.id, body);
  }

  /** Bulk grading never overwrites a settled mark — that path is the single-grade route. */
  @Post('assignments/:id/grades')
  @RequirePermissions('homework.grade')
  @Audited({
    module: 'homework',
    resourceType: 'submission_grade',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Grade many submissions of one assignment' })
  async bulkGrade(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(bulkGradeSchema)) body: z.infer<typeof bulkGradeSchema>,
  ) {
    return this.homework.bulkGrade(principal, requireInstitution(), params.id, body);
  }

  @Post('submissions/:id/attachments')
  @RequirePermissions('homework.submit')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  @Audited({
    module: 'homework',
    resourceType: 'submission_attachment',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Attach a file to the caller’s own submission' })
  async uploadSubmissionAttachment(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @UploadedFile() file: UploadedFileLike,
  ) {
    return this.homework.addSubmissionAttachment(principal, requireInstitution(), params.id, file);
  }

  /**
   * A submission attachment download URL. The service enforces the ownership rule — a
   * student reaches only their own files, a guardian their children's, staff their
   * sections' — and answers 404 for anything else.
   */
  @Get('submissions/:id/attachments/:attachmentId/download')
  @RequirePermissions('homework.view')
  @Audited({
    module: 'homework',
    resourceType: 'submission_attachment',
    action: 'export',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Get a short-lived signed download URL for a submission file' })
  async downloadSubmissionAttachment(
    @CurrentUser() principal: Principal,
    @Param(zodParam(homeworkAttachmentParamsSchema))
    params: { id: string; attachmentId: string },
  ) {
    const result = await this.homework.submissionAttachmentDownloadUrl(
      principal,
      requireInstitution(),
      params.id,
      params.attachmentId,
    );
    return {
      ...result,
      __audit: { newValue: { submissionId: params.id, attachmentId: params.attachmentId } },
    };
  }

  /**
   * Grading. Re-grading a submission that already carries a final mark requires a reason;
   * the service writes the before/after audit record inside the same transaction.
   */
  @Post('submissions/:id/grade')
  @RequirePermissions('homework.grade')
  @Audited({
    module: 'homework',
    resourceType: 'submission_grade',
    action: 'update',
    resourceIdFrom: 'param:id',
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Grade one submission' })
  async grade(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(gradeSubmissionSchema)) body: z.infer<typeof gradeSubmissionSchema>,
  ) {
    const result = await this.homework.grade(principal, requireInstitution(), params.id, body);
    return {
      ...result.grade,
      __audit: {
        previousValue: result.previous,
        newValue: { marks: result.grade.marks, feedback: result.grade.feedback },
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
      'Send the x-institution-id header to indicate which institution this homework belongs to.',
    );
  }
  return institutionId;
}
