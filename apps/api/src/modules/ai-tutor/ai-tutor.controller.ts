/**
 * AI tutor endpoints (Phase 35).
 *
 * Every route is `@InstitutionScoped()`: a session, a turn and a safeguarding flag belong to
 * one institution, and a group administrator running three schools has no safe default.
 *
 * ── The permissions, and the two places there is not one ──────────────────────────────
 *
 *   ai.tutor.use              — use the tutor: open a session, ask, end. Held by the
 *                               `student` system role, which deliberately does NOT hold
 *                               `ai.copilot.use`. This module exists so that separation
 *                               survives: no route in `modules/ai` was widened for students.
 *   discipline.records.action — the pastoral queue: read safeguarding flags and close one.
 *
 * **Gap 1 — the pastoral permission.** There is no safeguarding string in
 * `packages/permissions/src/catalog.ts`. `discipline.records.action` is the closest that
 * exists and it is the narrower of the two candidates: `discipline.records.view` is held by
 * every subject teacher, and a child's disclosure of harm is not something every teacher in
 * the building should be able to read. `discipline.records.action` is held by the principal
 * and the vice principal, which is the shape a designated safeguarding lead has. It is still
 * the wrong *name*: safeguarding is not discipline, and filing the two under one permission
 * says something about children this product does not mean. `ai.safeguarding.review` (or
 * `pastoral.safeguarding.review`) is the string that should exist, and the gap is reported
 * rather than papered over.
 *
 * **Gap 2 — reading somebody else's child's session.** `GET /tutor/sessions/:id` carries
 * `@Authenticated()` and no permission, because the *relationship* is the authorization: the
 * student, a guardian with a live portal-enabled link, and the teachers of that student's
 * sections, resolved in SQL by `tutor_session_visible_to()`. Inventing a permission for it
 * would make the rule weaker, not stronger — someone would eventually grant it to a role
 * that has no relationship to any child. This is the same pattern `GET /library/my-loans`
 * uses, and the boot-time route audit is satisfied because the route says, in writing, that
 * authentication plus the data rule is the whole of it.
 *
 * Route order matters: Nest matches in declaration order, so the literal segments
 * (`enabled`, `flags`) are declared before any `:id` route that would otherwise swallow them.
 */

import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { normalizeOffsetPage } from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import {
  createTutorSessionSchema,
  createTutorTurnSchema,
  endTutorSessionSchema,
  idParamSchema,
  listTutorFlagsSchema,
  listTutorSessionsSchema,
  reviewTutorFlagSchema,
} from '@shikkha/validation';
import { AiTutorService } from './ai-tutor.service';
import {
  Audited,
  Authenticated,
  CurrentUser,
  InstitutionScoped,
  RequirePermissions,
} from '../../common/decorators';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { currentContext } from '../../common/context/request-context';

@ApiTags('tutor')
@Controller('tutor')
@InstitutionScoped()
export class AiTutorController {
  constructor(private readonly tutor: AiTutorService) {}

  // ── Availability ────────────────────────────────────────────────────────────────────

  /**
   * Whether the school has switched tutoring on.
   *
   * A 200 with `enabled: false`, never a 403: this is the route a client calls to decide
   * whether to show the tutor at all, and refusing it would make "your school has not turned
   * this on" indistinguishable from "you are not allowed to ask".
   */
  @Get('enabled')
  @RequirePermissions('ai.tutor.use')
  @ApiOperation({ summary: 'Whether this school has enabled the AI tutor for students' })
  async enabled(@CurrentUser() principal: Principal) {
    return this.tutor.availability(principal, requireInstitution());
  }

  // ── Safeguarding queue ──────────────────────────────────────────────────────────────
  // Declared before `sessions/:id` only for readability; `flags` cannot collide with it.
  // Deliberately NOT gated on the tutoring toggle — see the service.

  @Get('flags')
  @RequirePermissions('discipline.records.action')
  @ApiOperation({ summary: 'Safeguarding flags raised by the tutor, oldest first' })
  async listFlags(
    @Query(zodQuery(listTutorFlagsSchema)) query: z.infer<typeof listTutorFlagsSchema>,
  ) {
    return this.tutor.listFlags(requireInstitution(), query, normalizeOffsetPage(query));
  }

  /**
   * Record that a person has read a flag and what they decided.
   *
   * `requiresReason`, because "why" is the whole record here — and because a safeguarding
   * review with no note is a checkbox, which is not a safeguarding record. The database
   * refuses a review whose `reviewed_by` is not the acting user of the connection, so this
   * decision cannot be made by anything that is not a logged-in person.
   *
   * Nothing else happens. Contacting a family, opening a pastoral record or making a
   * referral are separate, permission-checked actions in the modules that own them, taken by
   * a person who chose to take them.
   */
  @Post('flags/:id/review')
  @RequirePermissions('discipline.records.action')
  @Audited({
    module: 'ai_tutor',
    resourceType: 'tutor_safeguarding_flag',
    action: 'update',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Close a safeguarding flag with the reviewer\'s decision' })
  async reviewFlag(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(reviewTutorFlagSchema)) body: z.infer<typeof reviewTutorFlagSchema>,
  ) {
    const result = await this.tutor.reviewFlag(principal, requireInstitution(), params.id, body);
    // `__audit` is read by the audit interceptor and stripped from the HTTP response, so the
    // trail records what actually changed rather than the whole submitted body.
    return {
      ...result.flag,
      __audit: {
        previousValue: result.previous,
        newValue: {
          status: result.flag.status,
          reviewedBy: result.flag.reviewedBy,
          reviewedAt: result.flag.reviewedAt,
          automatedFollowUp: 'none',
        },
      },
    };
  }

  // ── Sessions ────────────────────────────────────────────────────────────────────────

  @Post('sessions')
  @RequirePermissions('ai.tutor.use')
  @Audited({
    module: 'ai_tutor',
    resourceType: 'tutor_session',
    action: 'create',
    resourceIdFrom: 'response:id',
    // The service writes the audit row inside its own transaction. Without this the
    // interceptor would write a second row with a null previous value.
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Start a tutoring session anchored to a course, lesson, assignment or quiz question' })
  async createSession(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createTutorSessionSchema)) body: z.infer<typeof createTutorSessionSchema>,
  ) {
    return this.tutor.create(principal, requireInstitution(), body);
  }

  /** Your own sessions. The scope is enforced on the data, not by the permission. */
  @Get('sessions')
  @RequirePermissions('ai.tutor.use')
  @ApiOperation({ summary: 'Your tutoring sessions' })
  async listSessions(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listTutorSessionsSchema)) query: z.infer<typeof listTutorSessionsSchema>,
  ) {
    return this.tutor.list(principal, requireInstitution(), query, normalizeOffsetPage(query));
  }

  /**
   * One session and its transcript.
   *
   * `@Authenticated()` with the rule on the data — see gap 2 in the file header. The student,
   * their linked guardian and the teachers of their sections; everyone else gets the 404 a
   * caller from another tenant gets.
   */
  @Get('sessions/:id')
  @Authenticated()
  @ApiOperation({ summary: 'One tutoring session, its turns and its transcript' })
  async getSession(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.tutor.findOne(principal, requireInstitution(), params.id);
  }

  /**
   * Ask the tutor something.
   *
   * `is_ai_initiated` is set on the audit row the service writes in the same transaction as
   * the turn, so what an AI told a child stays distinguishable in the trail forever — which
   * is the point of docs/06 §6 and the only reason a decision is explicable years later.
   */
  @Post('sessions/:id/turns')
  @RequirePermissions('ai.tutor.use')
  @Audited({
    module: 'ai_tutor',
    resourceType: 'tutor_turn',
    action: 'create',
    resourceIdFrom: 'param:id',
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Ask a question and receive the tutor\'s answer with its evidence' })
  async addTurn(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(createTutorTurnSchema)) body: z.infer<typeof createTutorTurnSchema>,
  ) {
    return this.tutor.addTurn(principal, requireInstitution(), params.id, body);
  }

  @Post('sessions/:id/end')
  @RequirePermissions('ai.tutor.use')
  @Audited({
    module: 'ai_tutor',
    resourceType: 'tutor_session',
    action: 'update',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'End a tutoring session' })
  async endSession(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(endTutorSessionSchema)) body: z.infer<typeof endTutorSessionSchema>,
  ) {
    const result = await this.tutor.end(principal, requireInstitution(), params.id, body);
    return {
      ...result.session,
      __audit: {
        previousValue: result.previous,
        newValue: {
          status: result.session.status,
          endedAt: result.session.endedAt,
          reason: body.reason,
        },
      },
    };
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
      'Send the x-institution-id header to indicate which institution this tutoring session belongs to.',
    );
  }
  return institutionId;
}
