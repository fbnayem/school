/**
 * Guardian endpoints (Phase 4).
 *
 * `GET /guardians/my-children` is the parent portal's entry point. It is the one route that
 * derives its entire result from the caller's identity rather than from a parameter, which is
 * exactly why it is safe: there is no id for a parent to tamper with.
 */

import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { normalizeOffsetPage } from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import {
  createGuardianSchema,
  guardianPortalInviteSchema,
  idParamSchema,
  linkGuardianSchema,
  listGuardiansSchema,
  unlinkGuardianSchema,
  uuidSchema,
} from '@shikkha/validation';
import { GuardiansService } from './guardians.service';
import { InvitationsService } from '../auth/invitations.service';
import { Audited, CurrentUser, RequirePermissions } from '../../common/decorators';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { currentContext } from '../../common/context/request-context';

@ApiTags('guardians')
@Controller('guardians')
export class GuardiansController {
  constructor(
    private readonly guardians: GuardiansService,
    private readonly invitations: InvitationsService,
  ) {}

  /**
   * Declared before `:id`-style routes would be, so `my-children` is never parsed as an id.
   * Nest matches in declaration order, and getting this backwards produces a confusing
   * "invalid uuid" error on a route that has no id at all.
   */
  @Get('my-children')
  @RequirePermissions('students.view.own')
  @ApiOperation({ summary: 'The children linked to the signed-in guardian' })
  async myChildren(@CurrentUser() principal: Principal) {
    return this.guardians.myChildren(principal);
  }

  @Get()
  @RequirePermissions('guardians.view.all', 'guardians.view.own', { mode: 'any' })
  @ApiOperation({ summary: 'List guardians within the caller’s data scope' })
  async list(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listGuardiansSchema)) query: z.infer<typeof listGuardiansSchema>,
  ) {
    return this.guardians.list(principal, query, normalizeOffsetPage(query));
  }

  @Post()
  @RequirePermissions('guardians.create')
  @Audited({ module: 'guardians', resourceType: 'guardian', action: 'create' })
  @ApiOperation({ summary: 'Create a guardian record' })
  async create(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createGuardianSchema)) body: z.infer<typeof createGuardianSchema>,
  ) {
    return this.guardians.create(principal, requireInstitution(), body);
  }

  @Get('students/:id')
  @RequirePermissions('guardians.view.all', 'guardians.view.own', { mode: 'any' })
  @ApiOperation({ summary: 'List the guardians linked to a student' })
  async listForStudent(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.guardians.listForStudent(principal, params.id);
  }

  /**
   * Linking grants a parent access to a child's records, so it needs its own permission and
   * is always audited — `guardians.link_student` is deliberately separate from
   * `guardians.update`, because editing a phone number and granting access to a child's
   * medical and financial records are not the same act.
   */
  /**
   * Invite a guardian to activate parent-portal access — the Phase 4 gap.
   *
   * `guardians.grant_access` rather than `users.invite`, because what is being granted is
   * portal access to specific children, not a staff account. The roles are fixed
   * server-side to the tenant's `guardian` system role; the body cannot name one. What the
   * account can then see is decided per student by `student_guardians.can_access_portal`.
   */
  @Post(':id/invite')
  @RequirePermissions('guardians.grant_access')
  @Audited({
    module: 'guardians',
    resourceType: 'guardian_portal_invitation',
    action: 'create',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Invite a guardian to activate parent portal access' })
  async invite(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(guardianPortalInviteSchema)) body: z.infer<typeof guardianPortalInviteSchema>,
  ) {
    return this.invitations.inviteGuardian(principal, params.id, body);
  }

  @Post('students/:id/link')
  @RequirePermissions('guardians.link_student')
  @Audited({
    module: 'guardians',
    resourceType: 'student_guardian',
    action: 'create',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Link a guardian to a student' })
  async link(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(linkGuardianSchema)) body: z.infer<typeof linkGuardianSchema>,
  ) {
    return this.guardians.link(principal, params.id, body);
  }

  @Post('students/:id/unlink/:guardianId')
  @RequirePermissions('guardians.link_student')
  @Audited({
    module: 'guardians',
    resourceType: 'student_guardian',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Remove a guardian’s link to a student' })
  async unlink(
    @CurrentUser() principal: Principal,
    @Param(zodParam(z.object({ id: uuidSchema, guardianId: uuidSchema })))
    params: { id: string; guardianId: string },
    @Body(zodBody(unlinkGuardianSchema)) body: { reason: string },
  ) {
    return this.guardians.unlink(principal, params.id, params.guardianId, body.reason);
  }
}

function requireInstitution(): string {
  const institutionId = currentContext()?.institutionId;
  if (!institutionId) {
    throw new BadRequestException('Send the x-institution-id header for guardian endpoints.');
  }
  return institutionId;
}
