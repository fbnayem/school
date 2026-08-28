/**
 * Student endpoints (Phase 3).
 *
 * Note what each route declares: a permission, and — for anything that mutates — an audit
 * record. The boot-time route audit enforces the first and warns about the second, so this
 * shape is not a convention people have to remember.
 *
 * Archive and status change are separate endpoints from update, with separate permissions and
 * separate audit actions. Collapsing them into a generic PATCH would make "a clerk corrected a
 * spelling" and "a student was withdrawn from the school" indistinguishable in the audit log,
 * which is exactly the distinction an auditor is looking for.
 */

import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { normalizeOffsetPage } from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import {
  archiveStudentSchema,
  createStudentSchema,
  idParamSchema,
  listStudentsSchema,
  updateStudentSchema,
} from '@shikkha/validation';
import { StudentsService } from './students.service';
import {
  Audited,
  CurrentUser,
  InstitutionScoped,
  RequirePermissions,
} from '../../common/decorators';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { currentContext } from '../../common/context/request-context';
import { BadRequestException } from '@nestjs/common';

@ApiTags('students')
@Controller('students')
export class StudentsController {
  constructor(private readonly students: StudentsService) {}

  /**
   * Three permissions in `any` mode: the *widest* one the caller holds determines what they
   * see, and the service resolves that. A teacher and a parent hit the same endpoint and get
   * different result sets, which is what keeps the mobile clients simple.
   */
  @Get()
  @RequirePermissions('students.view.all', 'students.view.assigned', 'students.view.own', {
    mode: 'any',
  })
  @ApiOperation({ summary: 'List students within the caller’s data scope' })
  async list(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listStudentsSchema)) query: z.infer<typeof listStudentsSchema>,
  ) {
    return this.students.list(principal, query, normalizeOffsetPage(query));
  }

  @Get(':id')
  @RequirePermissions('students.view.all', 'students.view.assigned', 'students.view.own', {
    mode: 'any',
  })
  @ApiOperation({ summary: 'Fetch one student' })
  async findOne(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.students.findOne(principal, params.id);
  }

  @Post()
  @InstitutionScoped()
  @RequirePermissions('students.create')
  @Audited({
    module: 'students',
    resourceType: 'student',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Admit a new student' })
  async create(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createStudentSchema)) body: z.infer<typeof createStudentSchema>,
  ) {
    const institutionId = requireInstitution();
    return this.students.create(principal, institutionId, body);
  }

  @Patch(':id')
  @RequirePermissions('students.update')
  @Audited({
    module: 'students',
    resourceType: 'student',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update a student’s details' })
  async update(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateStudentSchema)) body: z.infer<typeof updateStudentSchema>,
  ) {
    const result = await this.students.update(principal, params.id, body);
    // `__audit` is read by the audit interceptor and stripped from the HTTP response, so the
    // trail records what actually changed rather than the whole submitted body.
    return { ...result.student, __audit: { previousValue: result.previous, newValue: body } };
  }

  /**
   * Archive, not delete. Academic records are legal records (ADR-008), so the row stays and
   * the reason is mandatory — `requiresReason` refuses the request before the handler runs.
   */
  @Post(':id/archive')
  @RequirePermissions('students.archive')
  @Audited({
    module: 'students',
    resourceType: 'student',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive a student record' })
  async archive(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(archiveStudentSchema)) body: { reason: string },
  ) {
    return this.students.archive(principal, params.id, body.reason);
  }
}

/**
 * Creating a student requires knowing which institution it belongs to, and there is no safe
 * default when a tenant has several. `@InstitutionScoped()` makes the tenant guard require the
 * header; this is the belt-and-braces read.
 */
function requireInstitution(): string {
  const institutionId = currentContext()?.institutionId;
  if (!institutionId) {
    throw new BadRequestException(
      'Send the x-institution-id header to indicate which institution this student belongs to.',
    );
  }
  return institutionId;
}
