/**
 * Report builder endpoints (Phase 24).
 *
 * Every route is `@InstitutionScoped()`: a report is always about one school's data, and a
 * group administrator running three of them has no safe default. The tenant guard requires
 * and validates the header rather than this controller guessing.
 *
 * The permission split says what each verb costs:
 *
 *   reports.view      — see the source registry and the column picker, list and read saved
 *                       reports, run one, read run records
 *   reports.build     — create, edit, archive and share a saved report; run an ad-hoc query
 *   reports.export    — turn a result into a file, and take that file
 *   reports.schedule  — maintain schedules and fire one on demand
 *
 * Note that `POST /reports/run` is a *mutating* route in the audit sense even though it
 * writes no business data: it returns records in bulk, and a bulk read of pupil, staff or
 * financial data is a security event. Every route here that discloses rows carries
 * `@Audited(...)`. The two export routes set `recordedBy: 'service'` because the service
 * writes that exact record inside the transaction that creates the export — without it the
 * action would produce two rows, the later one with no before-state.
 *
 * Route order matters: Nest matches in declaration order, so literal segments are declared
 * before any `:id` route that would otherwise swallow them.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { z } from 'zod';
import { normalizeOffsetPage } from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import {
  archiveReportDefinitionSchema,
  archiveReportScheduleSchema,
  createReportDefinitionSchema,
  createReportExportSchema,
  createReportScheduleSchema,
  createReportShareSchema,
  idParamSchema,
  listReportDefinitionsSchema,
  listReportRunsSchema,
  listReportSchedulesSchema,
  reportSourceParamSchema,
  runAdHocReportSchema,
  runReportDefinitionSchema,
  updateReportDefinitionSchema,
  updateReportScheduleSchema,
} from '@shikkha/validation';
import { ReportsService } from './reports.service';
import {
  Audited,
  CurrentUser,
  InstitutionScoped,
  RequirePermissions,
} from '../../common/decorators';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { currentContext } from '../../common/context/request-context';

@ApiTags('reports')
@Controller('reports')
@InstitutionScoped()
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  // ── The registry ────────────────────────────────────────────────────────────────────

  @Get('sources')
  @RequirePermissions('reports.view')
  @ApiOperation({ summary: 'List the report sources this caller may query' })
  listSources(@CurrentUser() principal: Principal) {
    return { data: this.reports.listSources(principal) };
  }

  /**
   * The column picker.
   *
   * What comes back is filtered by the caller's permissions: someone without
   * `students.medical.view` is never offered a medical column, which is the same set the
   * query itself honours.
   */
  @Get('sources/:key')
  @RequirePermissions('reports.view')
  @ApiOperation({ summary: 'Describe one report source and its selectable columns' })
  describeSource(
    @CurrentUser() principal: Principal,
    @Param(zodParam(reportSourceParamSchema)) params: z.infer<typeof reportSourceParamSchema>,
  ) {
    return this.reports.describeSource(principal, params.key);
  }

  // ── Running ─────────────────────────────────────────────────────────────────────────

  /**
   * Run a one-off query document. Audited: it returns records in bulk.
   *
   * The audit hint carries the shape of the disclosure — source, columns, row count — and
   * never the rows themselves. The audit log is read widely and kept for years; a second
   * copy of every report that has ever been run does not belong in it.
   */
  @Post('run')
  // A POST because the query document is a body, not a query string — but it reads rather
  // than creates something the client will address later, so it answers 200.
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('reports.build')
  @Audited({ module: 'reports', resourceType: 'report_run', action: 'export' })
  @ApiOperation({ summary: 'Run an ad-hoc report' })
  async run(
    @CurrentUser() principal: Principal,
    @Body(zodBody(runAdHocReportSchema)) body: z.infer<typeof runAdHocReportSchema>,
  ) {
    const result = await this.reports.runAdHoc(principal, requireInstitution(), body.query);
    return { ...result, __audit: { newValue: auditSummary(result) } };
  }

  // ── Saved definitions ───────────────────────────────────────────────────────────────

  @Get('definitions')
  @RequirePermissions('reports.view')
  @ApiOperation({ summary: 'List saved reports visible to the caller' })
  async listDefinitions(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listReportDefinitionsSchema))
    query: z.infer<typeof listReportDefinitionsSchema>,
  ) {
    return this.reports.listDefinitions(principal, requireInstitution(), query, {
      ...normalizeOffsetPage(query),
      sort: query.sort,
    });
  }

  @Post('definitions')
  @RequirePermissions('reports.build')
  @Audited({
    module: 'reports',
    resourceType: 'report_definition',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Save a report definition' })
  async createDefinition(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createReportDefinitionSchema))
    body: z.infer<typeof createReportDefinitionSchema>,
  ) {
    return this.reports.createDefinition(principal, requireInstitution(), body);
  }

  @Get('definitions/:id')
  @RequirePermissions('reports.view')
  @ApiOperation({ summary: 'Read one saved report' })
  async getDefinition(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: z.infer<typeof idParamSchema>,
  ) {
    return this.reports.getDefinition(principal, requireInstitution(), params.id);
  }

  @Patch('definitions/:id')
  @RequirePermissions('reports.build')
  @Audited({
    module: 'reports',
    resourceType: 'report_definition',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Change a saved report' })
  async updateDefinition(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: z.infer<typeof idParamSchema>,
    @Body(zodBody(updateReportDefinitionSchema))
    body: z.infer<typeof updateReportDefinitionSchema>,
  ) {
    return this.reports.updateDefinition(principal, requireInstitution(), params.id, body);
  }

  @Post('definitions/:id/archive')
  @RequirePermissions('reports.build')
  @Audited({
    module: 'reports',
    resourceType: 'report_definition',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive a saved report' })
  async archiveDefinition(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: z.infer<typeof idParamSchema>,
    @Body(zodBody(archiveReportDefinitionSchema))
    body: z.infer<typeof archiveReportDefinitionSchema>,
  ) {
    return this.reports.archiveDefinition(principal, requireInstitution(), params.id, body);
  }

  /**
   * Run a saved report. `reports.view` is enough — running someone else's saved question
   * still applies *your* data scope and *your* column permissions.
   */
  @Post('definitions/:id/run')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('reports.view')
  @Audited({
    module: 'reports',
    resourceType: 'report_run',
    action: 'export',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Run a saved report' })
  async runDefinition(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: z.infer<typeof idParamSchema>,
    @Body(zodBody(runReportDefinitionSchema)) body: z.infer<typeof runReportDefinitionSchema>,
  ) {
    const result = await this.reports.runDefinition(
      principal,
      requireInstitution(),
      params.id,
      body,
    );
    return { ...result, __audit: { newValue: auditSummary(result) } };
  }

  @Get('definitions/:id/shares')
  @RequirePermissions('reports.view')
  @ApiOperation({ summary: 'List who a saved report is shared with' })
  async listShares(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: z.infer<typeof idParamSchema>,
  ) {
    return { data: await this.reports.listShares(principal, requireInstitution(), params.id) };
  }

  @Post('definitions/:id/shares')
  @RequirePermissions('reports.build')
  @Audited({
    module: 'reports',
    resourceType: 'report_share',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Share a saved report with a role or a user' })
  async shareDefinition(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: z.infer<typeof idParamSchema>,
    @Body(zodBody(createReportShareSchema)) body: z.infer<typeof createReportShareSchema>,
  ) {
    return this.reports.shareDefinition(principal, requireInstitution(), params.id, body);
  }

  // ── Runs ────────────────────────────────────────────────────────────────────────────

  @Get('runs')
  @RequirePermissions('reports.view')
  @ApiOperation({ summary: 'List report runs the caller may see' })
  async listRuns(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listReportRunsSchema)) query: z.infer<typeof listReportRunsSchema>,
  ) {
    return this.reports.listRuns(principal, requireInstitution(), query, {
      ...normalizeOffsetPage(query),
      sort: query.sort,
    });
  }

  @Get('runs/:id')
  @RequirePermissions('reports.view')
  @ApiOperation({ summary: 'Read one run record' })
  async getRun(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: z.infer<typeof idParamSchema>,
  ) {
    return this.reports.getRun(principal, requireInstitution(), params.id);
  }

  // ── Exports ─────────────────────────────────────────────────────────────────────────

  /**
   * Materialise a result as a file.
   *
   * The query is re-executed under *this* caller's scope, so an export can never contain
   * more than they could read right now, and it gets its own run record. A result that hit
   * the row limit is refused rather than truncated into a file that looks complete.
   */
  @Post('runs/:id/exports')
  @RequirePermissions('reports.export')
  @Audited({
    module: 'reports',
    resourceType: 'report_export',
    action: 'export',
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Export a report run as CSV or JSON' })
  async createExport(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: z.infer<typeof idParamSchema>,
    @Body(zodBody(createReportExportSchema)) body: z.infer<typeof createReportExportSchema>,
  ) {
    return this.reports.createExport(principal, requireInstitution(), params.id, body.format);
  }

  /**
   * Take the file. A GET, so the boot-time route audit does not require a decorator — but the
   * service writes an audit record anyway, because the disclosure happens here and may be
   * long after, and by someone other than, the person who produced the export.
   */
  @Get('exports/:id/download')
  @RequirePermissions('reports.export')
  @ApiOperation({ summary: 'Download a produced export' })
  async downloadExport(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: z.infer<typeof idParamSchema>,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.reports.downloadExport(principal, requireInstitution(), params.id);
    response.setHeader(
      'Content-Type',
      result.format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
    );
    response.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    response.setHeader('Cache-Control', 'no-store');
    return result.content.toString('utf8');
  }

  // ── Schedules ───────────────────────────────────────────────────────────────────────

  @Get('schedules')
  @RequirePermissions('reports.view')
  @ApiOperation({ summary: 'List report schedules' })
  async listSchedules(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listReportSchedulesSchema)) query: z.infer<typeof listReportSchedulesSchema>,
  ) {
    return this.reports.listSchedules(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Post('schedules')
  @RequirePermissions('reports.schedule')
  @Audited({
    module: 'reports',
    resourceType: 'report_schedule',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Schedule a saved report' })
  async createSchedule(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createReportScheduleSchema)) body: z.infer<typeof createReportScheduleSchema>,
  ) {
    return this.reports.createSchedule(principal, requireInstitution(), body);
  }

  @Patch('schedules/:id')
  @RequirePermissions('reports.schedule')
  @Audited({
    module: 'reports',
    resourceType: 'report_schedule',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Change a report schedule' })
  async updateSchedule(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: z.infer<typeof idParamSchema>,
    @Body(zodBody(updateReportScheduleSchema)) body: z.infer<typeof updateReportScheduleSchema>,
  ) {
    return this.reports.updateSchedule(principal, requireInstitution(), params.id, body);
  }

  @Post('schedules/:id/archive')
  @RequirePermissions('reports.schedule')
  @Audited({
    module: 'reports',
    resourceType: 'report_schedule',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive a report schedule' })
  async archiveSchedule(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: z.infer<typeof idParamSchema>,
    @Body(zodBody(archiveReportScheduleSchema)) body: z.infer<typeof archiveReportScheduleSchema>,
  ) {
    return this.reports.archiveSchedule(principal, requireInstitution(), params.id, body);
  }

  /**
   * Fire a schedule now.
   *
   * This is the schedule genuinely executing: the report runs, an export is produced and
   * audited, `last_run_at` moves and `next_run_at` is recomputed from the cron expression.
   * Nothing in the platform fires it automatically yet, and this endpoint does not pretend
   * otherwise.
   */
  @Post('schedules/:id/run')
  @RequirePermissions('reports.schedule', 'reports.export')
  @Audited({
    module: 'reports',
    resourceType: 'report_export',
    action: 'export',
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Run a scheduled report now' })
  async runSchedule(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: z.infer<typeof idParamSchema>,
  ) {
    return this.reports.runSchedule(principal, requireInstitution(), params.id);
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
      'Send the x-institution-id header to indicate which institution this report is about.',
    );
  }
  return institutionId;
}

/** What the audit log records about a run: the shape of the disclosure, never its contents. */
function auditSummary(result: {
  runId: string;
  sourceKey: string;
  definitionId: string | null;
  rowCount: number;
  truncated: boolean;
  omittedColumns: string[];
  columns: { key: string }[];
}): Record<string, unknown> {
  return {
    runId: result.runId,
    sourceKey: result.sourceKey,
    definitionId: result.definitionId,
    rowCount: result.rowCount,
    truncated: result.truncated,
    columns: result.columns.map((column) => column.key),
    omittedColumns: result.omittedColumns,
  };
}
