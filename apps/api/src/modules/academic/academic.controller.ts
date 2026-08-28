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
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { Principal } from '@shikkha/permissions';
import {
  createAcademicYearSchema,
  createClassLevelSchema,
  createSectionSchema,
  createSubjectSchema,
  idParamSchema,
  replaceTermsSchema,
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
}

function requireInstitution(): string {
  const institutionId = currentContext()?.institutionId;
  if (!institutionId) {
    throw new BadRequestException('Send the x-institution-id header for academic endpoints.');
  }
  return institutionId;
}
