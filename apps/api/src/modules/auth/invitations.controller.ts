/**
 * Invitation endpoints.
 *
 * Creating, listing and revoking are administrative actions behind `users.invite` /
 * `users.view`. Acceptance is public — the single-use token *is* the credential — and sits
 * behind the strict credential-endpoint rate limit, because an invitation token is exactly
 * the kind of thing an attacker sprays guesses at.
 *
 * Note the deliberate asymmetry: the create response hands the acceptance URL back to the
 * inviting administrator (so a school with no SMTP/SMS configured can hand it over in
 * person), while acceptance failures return one generic 404 whatever the actual reason —
 * unknown, expired, used or revoked — so the endpoint cannot be used to probe token state.
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { normalizeOffsetPage } from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import {
  acceptInvitationSchema,
  idParamSchema,
  inviteUserSchema,
  listInvitationsSchema,
  revokeInvitationSchema,
  type InviteUserInput,
} from '@shikkha/validation';
import { InvitationsService } from './invitations.service';
import { Audited, CurrentUser, Public, RequirePermissions } from '../../common/decorators';
import { AuthRateLimit } from '../../common/guards/rate-limit.guard';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';

@ApiTags('auth')
@Controller('auth/invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  /**
   * Declared before any `:id` route so the literal path is never parsed as an id.
   */
  @Public()
  @Post('accept')
  @HttpCode(HttpStatus.OK)
  @AuthRateLimit()
  @ApiOperation({ summary: 'Accept an invitation: set a password and activate the account' })
  async accept(
    @Body(zodBody(acceptInvitationSchema))
    body: z.infer<typeof acceptInvitationSchema>,
  ) {
    return this.invitations.accept({
      token: body.token,
      password: body.password,
      fullNameEn: body.fullNameEn,
      fullNameBn: body.fullNameBn,
      email: body.email,
    });
  }

  @Post()
  @RequirePermissions('users.invite')
  @Audited({
    module: 'users',
    resourceType: 'invitation',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Invite a user by email or Bangladeshi mobile with a set of roles' })
  async invite(
    @CurrentUser() principal: Principal,
    @Body(zodBody(inviteUserSchema)) body: InviteUserInput,
  ) {
    return this.invitations.inviteUser(principal, body);
  }

  @Get()
  @RequirePermissions('users.view')
  @ApiOperation({ summary: 'List pending invitations' })
  async list(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listInvitationsSchema)) query: z.infer<typeof listInvitationsSchema>,
  ) {
    return this.invitations.list(principal, query, normalizeOffsetPage(query));
  }

  @Post(':id/revoke')
  @RequirePermissions('users.invite')
  @Audited({
    module: 'users',
    resourceType: 'invitation',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Revoke a pending invitation' })
  async revoke(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(revokeInvitationSchema)) _body: { reason: string },
  ) {
    return this.invitations.revoke(principal, params.id);
  }
}
