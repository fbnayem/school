/**
 * The AI tool surface (Phases 29-30, docs/06 §1-2).
 *
 * Two routes, and the reason there are only two is the security model. `apps/ai` holds no
 * database credentials and no service account: it calls back into this API with **the caller's
 * own bearer token**, so every tool call is authenticated as the human who asked the question
 * and authorized by that human's permissions. The AI cannot call a tool the user could not
 * call themselves, because there is no identity available to it under which it could.
 *
 * That is a structural property rather than a policy one, which is the whole point of docs/06
 * §1: "the AI must not bypass permissions" as a rule is something a prompt injection can talk
 * its way around; as a missing connection string, it is not.
 *
 *   GET  /api/v1/ai/tools                — the manifest, filtered to what this caller may use
 *   POST /api/v1/ai/tools/:name/invoke   — the single invocation route
 *
 * `@InstitutionScoped()`: a tool answers a question about one school. A group administrator
 * running three institutions has no safe default, so the tenant guard requires and validates
 * the `x-institution-id` header rather than this controller guessing.
 *
 * ── The route-level permission ─────────────────────────────────────────────────────────
 *
 * The invoke route declares the four "may use AI at all" permissions with `mode: 'any'`. That
 * is deliberately the *weakest* useful gate: it keeps a user with no AI entitlement out of the
 * surface entirely, and it leaves the real decision — may you use *this tool* — to the
 * registry, which re-checks the tool's own permissions against the principal on every single
 * invocation. Putting the per-tool permission on the route is impossible (there is one route
 * for six tools) and putting a strong permission there would be worse than useless: it would
 * read like the check, and it would not be.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import type { Principal } from '@shikkha/permissions';
import { aiToolInvokeSchema, aiToolNameParamSchema } from '@shikkha/validation';
import { ToolRegistryService } from './tool-registry.service';
import {
  Audited,
  CurrentUser,
  InstitutionScoped,
  RequirePermissions,
} from '../../common/decorators';
import { zodBody, zodParam } from '../../common/pipes/zod-validation.pipe';
import { currentContext } from '../../common/context/request-context';

@ApiTags('ai-tools')
@Controller('ai/tools')
@InstitutionScoped()
export class AiToolsController {
  constructor(private readonly registry: ToolRegistryService) {}

  /**
   * The manifest.
   *
   * Gated on `ai.copilot.use` because the manifest is what a copilot is given; a user with
   * only `ai.tutor.use` reaches the tutor's own surface rather than the general tool list.
   * Tools the caller cannot use are absent, not marked unavailable — see the registry.
   */
  @Get()
  @RequirePermissions('ai.copilot.use')
  @ApiOperation({
    summary: 'The tools this caller is permitted to use, with JSON Schema arguments',
  })
  async manifest(@CurrentUser() principal: Principal) {
    // The institution is required so the manifest reflects the caller's grants *in this
    // school*: a group administrator scoped to one institution should not be told about a
    // capability they hold only in another.
    requireInstitution();
    return { tools: this.registry.manifest(principal) };
  }

  /**
   * Invoke one tool.
   *
   * A POST, and therefore audited — but the audit row is written by the registry, inside the
   * invocation path, with `is_ai_initiated = true` and the token cost attached. `recordedBy:
   * 'service'` stands the interceptor down: without it every invocation would produce two
   * rows, the second with a null previous value and no AI flag, and the trail would over-count
   * every copilot session by a factor of two.
   *
   * `action: 'export'` on the decorator is the closest verb the metadata union offers for a
   * read that leaves the building; the record the registry actually writes uses `ai_action`,
   * which is the accurate one. The decorator's value is never persisted for a service-recorded
   * route — it exists here to satisfy the boot-time route audit.
   */
  @Post(':name/invoke')
  // 200, not Nest's default 201 for a POST. A tool invocation creates nothing — it is a read
  // that takes a body, which is the only reason it is not a GET. Answering 201 Created would
  // tell a caller a resource now exists at some location, and none does.
  @HttpCode(200)
  @RequirePermissions(
    'ai.copilot.use',
    'ai.tutor.use',
    'ai.teacher_tools.use',
    'ai.principal_insights.view',
    { mode: 'any' },
  )
  @Audited({
    module: 'ai-tools',
    resourceType: 'ai_tool_invocation',
    action: 'export',
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Invoke one AI tool on behalf of the caller' })
  async invoke(
    @CurrentUser() principal: Principal,
    @Param(zodParam(aiToolNameParamSchema)) params: { name: string },
    @Body(zodBody(aiToolInvokeSchema)) body: z.infer<typeof aiToolInvokeSchema>,
  ) {
    return this.registry.invoke(
      { principal, institutionId: requireInstitution() },
      params.name,
      body.arguments,
    );
  }
}

/**
 * Belt and braces, exactly as the library controller does it: `@InstitutionScoped()` makes the
 * tenant guard refuse the request without the header, and this re-reads it because
 * `currentContext()` is typed `string | null` and a tool should not have to handle a case the
 * guard already excluded.
 */
function requireInstitution(): string {
  const institutionId = currentContext()?.institutionId;
  if (!institutionId) {
    throw new BadRequestException(
      'Send the x-institution-id header to indicate which institution this question is about.',
    );
  }
  return institutionId;
}
