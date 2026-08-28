/**
 * Timetable endpoints (Phase 6).
 *
 * Two controllers, because there are two audiences and they want opposite shapes:
 *
 *  - `/timetables` is the authoring surface. A coordinator builds a draft, checks it, publishes
 *    it, and records covers against it. Everything that changes state is separately
 *    permissioned and separately audited, so "a room was swapped" and "the routine went live"
 *    are different lines in the trail rather than two generic updates.
 *  - `/timetable` is the reading surface: one section's week, one teacher's week. Both are
 *    scope-aware in the service, so a teacher, a guardian and the principal call the same
 *    route and get different rows.
 *
 * Publishing and substituting are separate permissions from managing on purpose. Drafting next
 * term's routine is clerical; putting it in force changes where 900 children are at 10am, and
 * arranging cover commits a colleague's time.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { normalizeOffsetPage } from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import {
  archiveTimetableEntrySchema,
  archiveTimetableSchema,
  cancelTimetableSubstitutionSchema,
  cloneTimetableSchema,
  createTimetableSchema,
  createTimetableSubstitutionSchema,
  idParamSchema,
  listTimetablesSchema,
  publishTimetableSchema,
  replaceTimetableEntriesSchema,
  timetableEntryParamSchema,
  timetableSectionParamSchema,
  timetableTeacherParamSchema,
  timetableViewQuerySchema,
} from '@shikkha/validation';
import { TimetableService } from './timetable.service';
import {
  Audited,
  CurrentUser,
  InstitutionScoped,
  RequirePermissions,
} from '../../common/decorators';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { currentContext } from '../../common/context/request-context';

@ApiTags('timetable')
@Controller('timetables')
@InstitutionScoped()
export class TimetableController {
  constructor(private readonly timetable: TimetableService) {}

  @Get()
  @RequirePermissions('timetable.view')
  @ApiOperation({ summary: 'List timetables for the institution' })
  async list(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listTimetablesSchema)) query: z.infer<typeof listTimetablesSchema>,
  ) {
    return this.timetable.list(principal, requireInstitution(), query, normalizeOffsetPage(query));
  }

  @Post()
  @RequirePermissions('timetable.manage')
  @Audited({
    module: 'timetable',
    resourceType: 'timetable',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Start a new draft timetable' })
  async create(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createTimetableSchema)) body: z.infer<typeof createTimetableSchema>,
  ) {
    return this.timetable.create(principal, requireInstitution(), body);
  }

  /**
   * Declared before the `:id`-style routes, so `substitutions` is never parsed as a timetable
   * id. Nest matches in declaration order, and getting this backwards produces an "invalid
   * identifier" error on a route whose id is somewhere else entirely.
   */
  @Post('substitutions/:id/cancel')
  @RequirePermissions('timetable.substitute')
  @Audited({
    module: 'timetable',
    resourceType: 'timetable_substitution',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Cancel a substitution that has not happened yet' })
  async cancelSubstitution(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(cancelTimetableSubstitutionSchema))
    body: z.infer<typeof cancelTimetableSubstitutionSchema>,
  ) {
    const result = await this.timetable.cancelSubstitution(
      principal,
      requireInstitution(),
      params.id,
      body.reason,
    );
    return {
      ...result.substitution,
      __audit: { previousValue: result.previous, newValue: { cancelled: true } },
    };
  }

  @Get(':id')
  @RequirePermissions('timetable.view')
  @ApiOperation({ summary: 'Fetch one timetable with the entries the caller may see' })
  async findOne(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.timetable.findOne(principal, requireInstitution(), params.id);
  }

  /**
   * A read, so it is a GET: running the checks must be free of consequence, otherwise nobody
   * runs them until publication is refused.
   */
  @Get(':id/validate')
  @RequirePermissions('timetable.manage')
  @ApiOperation({
    summary: 'Report every clash in a timetable without changing anything',
    description:
      'Returns section, teacher and room clashes, including the extra slot a double period occupies.',
  })
  async validate(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.timetable.validate(principal, requireInstitution(), params.id);
  }

  @Post(':id/clone')
  @RequirePermissions('timetable.manage')
  @Audited({
    module: 'timetable',
    resourceType: 'timetable',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Copy a timetable into a new draft' })
  async clone(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(cloneTimetableSchema)) body: z.infer<typeof cloneTimetableSchema>,
  ) {
    const result = await this.timetable.clone(principal, requireInstitution(), params.id, body);
    return {
      ...result.timetable,
      entriesCopied: result.entriesCopied,
      __audit: { newValue: { clonedFrom: params.id, entriesCopied: result.entriesCopied } },
    };
  }

  @Put(':id/entries')
  @RequirePermissions('timetable.manage')
  @Audited({
    module: 'timetable',
    resourceType: 'timetable',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({
    summary: 'Replace one section’s entries in a draft timetable',
    description:
      'The submitted list becomes the section’s complete week. Clashes with the rest of the routine are refused as a 409 listing every conflict.',
  })
  async replaceEntries(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(replaceTimetableEntriesSchema))
    body: z.infer<typeof replaceTimetableEntriesSchema>,
  ) {
    const result = await this.timetable.replaceSectionEntries(
      principal,
      requireInstitution(),
      params.id,
      body,
    );
    // The audit trail records the slots that were there before and the ones submitted, not the
    // whole routine — a diff of 40 unchanged lessons makes the trail unreadable.
    return {
      sectionId: body.sectionId,
      entries: result.entries,
      __audit: {
        previousValue: { sectionId: body.sectionId, entries: result.previous },
        newValue: body,
      },
    };
  }

  /**
   * Removing a lesson archives it. The entry stays because attendance taken last Tuesday has
   * to remain readable against the routine that was in force last Tuesday (ADR-008).
   */
  @Delete(':id/entries/:entryId')
  @RequirePermissions('timetable.manage')
  @Audited({
    module: 'timetable',
    resourceType: 'timetable_entry',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Remove one lesson from a draft timetable' })
  async archiveEntry(
    @CurrentUser() principal: Principal,
    @Param(zodParam(timetableEntryParamSchema)) params: { id: string; entryId: string },
    @Body(zodBody(archiveTimetableEntrySchema))
    body: z.infer<typeof archiveTimetableEntrySchema>,
  ) {
    const result = await this.timetable.archiveEntry(
      principal,
      requireInstitution(),
      params.id,
      params.entryId,
      body.reason,
    );
    return {
      ...result.entry,
      __audit: { previousValue: result.previous, newValue: { archived: true } },
    };
  }

  /**
   * Publishing is its own permission and its own audit action. It is the moment the routine
   * becomes the school's operating reality, and it silently retires the routine it replaces —
   * both facts belong in the trail under their own names.
   */
  @Post(':id/publish')
  @RequirePermissions('timetable.publish')
  @Audited({
    module: 'timetable',
    resourceType: 'timetable',
    action: 'publish',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({
    summary: 'Publish a draft timetable',
    description:
      'Re-validates every clash, archives the previously published timetable for the same campus, term and year, and makes this one live — all in one transaction.',
  })
  async publish(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(publishTimetableSchema)) body: z.infer<typeof publishTimetableSchema>,
  ) {
    const result = await this.timetable.publish(principal, requireInstitution(), params.id, body);
    return {
      ...result.timetable,
      supersededTimetableId: result.superseded?.id ?? null,
      __audit: {
        previousValue: { status: 'draft' },
        newValue: {
          status: 'published',
          effectiveFrom: result.timetable.effectiveFrom,
          supersededTimetableId: result.superseded?.id ?? null,
        },
      },
    };
  }

  @Post(':id/archive')
  @RequirePermissions('timetable.manage')
  @Audited({
    module: 'timetable',
    resourceType: 'timetable',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Retire a timetable' })
  async archive(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(archiveTimetableSchema)) body: z.infer<typeof archiveTimetableSchema>,
  ) {
    return this.timetable.archive(principal, requireInstitution(), params.id, body.reason);
  }

  @Post(':id/substitutions')
  @RequirePermissions('timetable.substitute')
  @Audited({
    module: 'timetable',
    resourceType: 'timetable_substitution',
    action: 'create',
    resourceIdFrom: 'response:id',
    requiresReason: true,
  })
  @ApiOperation({
    summary: 'Record a one-day substitute for a lesson',
    description:
      'Refused if the substitute is already teaching or already covering another lesson in that period on that date.',
  })
  async createSubstitution(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(createTimetableSubstitutionSchema))
    body: z.infer<typeof createTimetableSubstitutionSchema>,
  ) {
    return this.timetable.createSubstitution(principal, requireInstitution(), params.id, body);
  }
}

/**
 * The read surface. Separate from the authoring controller because these are the two routes
 * the mobile apps call every morning, and they answer "what is happening today", not "what is
 * the state of this document".
 */
@ApiTags('timetable')
@Controller('timetable')
@InstitutionScoped()
export class TimetableViewController {
  constructor(private readonly timetable: TimetableService) {}

  @Get('section/:sectionId')
  @RequirePermissions('timetable.view')
  @ApiOperation({
    summary: 'The published routine of one section',
    description:
      'Scope-aware: a coordinator may read any section, a teacher only the sections they teach or are responsible for, a guardian only their children’s.',
  })
  async section(
    @CurrentUser() principal: Principal,
    @Param(zodParam(timetableSectionParamSchema)) params: { sectionId: string },
    @Query(zodQuery(timetableViewQuerySchema)) query: z.infer<typeof timetableViewQuerySchema>,
  ) {
    return this.timetable.sectionTimetable(
      principal,
      requireInstitution(),
      params.sectionId,
      query,
    );
  }

  @Get('teacher/:employeeId')
  @RequirePermissions('timetable.view')
  @ApiOperation({
    summary: 'One teacher’s week, with the covers they are involved in',
    description:
      'A teacher may read their own; reading someone else’s requires the timetable management permissions.',
  })
  async teacher(
    @CurrentUser() principal: Principal,
    @Param(zodParam(timetableTeacherParamSchema)) params: { employeeId: string },
    @Query(zodQuery(timetableViewQuerySchema)) query: z.infer<typeof timetableViewQuerySchema>,
  ) {
    return this.timetable.teacherTimetable(
      principal,
      requireInstitution(),
      params.employeeId,
      query,
    );
  }
}

/**
 * A timetable belongs to one institution and one campus, and a group administrator running
 * three schools has no sensible default. `@InstitutionScoped()` makes the tenant guard demand
 * the header; this is the belt-and-braces read, because `currentContext()` is typed nullable.
 */
function requireInstitution(): string {
  const institutionId = currentContext()?.institutionId;
  if (!institutionId) {
    throw new BadRequestException(
      'Send the x-institution-id header to indicate which institution this timetable belongs to.',
    );
  }
  return institutionId;
}
