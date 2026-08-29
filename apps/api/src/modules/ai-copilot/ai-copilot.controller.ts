/**
 * The copilot and suggestion routes (Phase 33).
 *
 * Every route is `@InstitutionScoped()`: a suggestion is about one school's child, one
 * school's invoice, one school's claim, and a group administrator running three institutions
 * has no safe default. The tenant guard requires and validates `x-institution-id`.
 *
 * ── The permission on each route, and why it is that one ───────────────────────────────
 *
 *   POST /ai/copilot/ask            the four `ai.*` use permissions, `mode: 'any'`
 *   GET  /ai/copilot/capabilities   the same four
 *   GET  /ai/suggestions            ai.copilot.use
 *   GET  /ai/suggestions/:id        ai.copilot.use
 *   POST /ai/suggestions/:id/accept ai.copilot.use  ← the route guard, NOT the real check
 *   POST /ai/suggestions/:id/dismiss ai.copilot.use
 *
 * `ask` carries the weakest useful gate for the same reason `POST /ai/tools/:name/invoke`
 * does: there is one route for four surfaces, so a strong permission here would read like the
 * check and would not be one. The per-surface conjunction — `ai.principal_insights.view`,
 * `ai.teacher_tools.use`, `ai.copilot.use` + `finance.reports.view`, `ai.copilot.use` +
 * `admissions.applications.view` — is enforced in the service, on the surface the caller
 * actually asked for.
 *
 * **The accept route is the one to read carefully.** Its `@RequirePermissions('ai.copilot.use')`
 * is *not* the check that matters, and the file would be dangerous if anybody believed it was.
 * The real check is `AiSuggestionService.assertAcceptable`, which reads the permission of the
 * ACTION off `suggestion-contracts.ts` — `communication.send` for a fee reminder,
 * `discipline.records.create` for a referral, `accounting.journal.post` for an expense flag —
 * and refuses without it. It cannot be a route decorator because one route accepts seven kinds
 * of suggestion with seven different permissions, and a decorator listing all seven with
 * `mode: 'any'` would let a teacher accept an expense flag. The guard here only keeps people
 * with no AI entitlement at all out of the surface.
 *
 * Route order matters: Nest matches in declaration order, so `copilot/capabilities` is
 * declared before anything that could swallow it, and the literal `suggestions` segments come
 * before `suggestions/:id`.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { normalizeOffsetPage } from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import {
  acceptAiSuggestionSchema,
  askAiCopilotSchema,
  dismissAiSuggestionSchema,
  idParamSchema,
  listAiSuggestionsSchema,
} from '@shikkha/validation';
import { AiCopilotService } from './ai-copilot.service';
import { AiSuggestionService } from './ai-suggestion.service';
import {
  Audited,
  CurrentUser,
  InstitutionScoped,
  RequirePermissions,
} from '../../common/decorators';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { currentContext } from '../../common/context/request-context';

@ApiTags('ai-copilot')
@Controller('ai')
@InstitutionScoped()
export class AiCopilotController {
  constructor(
    private readonly copilot: AiCopilotService,
    private readonly suggestions: AiSuggestionService,
  ) {}

  // ── The copilot ─────────────────────────────────────────────────────────────────────

  /**
   * What this caller's copilot can actually do.
   *
   * Declared first so the literal segment is not swallowed, and a GET because it reads the
   * caller's own grants and writes nothing.
   */
  @Get('copilot/capabilities')
  @RequirePermissions(
    'ai.copilot.use',
    'ai.teacher_tools.use',
    'ai.principal_insights.view',
    'ai.tutor.use',
    { mode: 'any' },
  )
  @ApiOperation({ summary: 'Which copilot surfaces, tools and suggestion actions this caller has' })
  async capabilities(@CurrentUser() principal: Principal) {
    // Required so the answer reflects the caller's grants *in this school*: a group
    // administrator scoped to one institution should not be told about a capability they hold
    // only in another.
    requireInstitution();
    return this.copilot.capabilities(principal);
  }

  /**
   * One copilot turn.
   *
   * A POST because it carries a question in a body and because it spends money and writes a
   * transcript — but 200 rather than 201: a turn does not create a resource at a location the
   * client can then fetch. The conversation it may have opened is named in the response.
   *
   * `recordedBy: 'service'`: the copilot service writes the audit row inside the same
   * transaction as the transcript and the usage event, with `is_ai_initiated = true`. Without
   * this the interceptor would write a second row per turn with a null previous value and no
   * AI flag, and every copilot session would be double-counted in the trail.
   */
  @Post('copilot/ask')
  @HttpCode(200)
  @RequirePermissions(
    'ai.copilot.use',
    'ai.teacher_tools.use',
    'ai.principal_insights.view',
    'ai.tutor.use',
    { mode: 'any' },
  )
  @Audited({
    module: 'ai-copilot',
    resourceType: 'ai_message',
    action: 'create',
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Ask a copilot: a grounded answer, its citations, and any suggestions' })
  async ask(
    @CurrentUser() principal: Principal,
    @Body(zodBody(askAiCopilotSchema)) body: z.infer<typeof askAiCopilotSchema>,
  ) {
    return this.copilot.ask(principal, requireInstitution(), body);
  }

  // ── The review queue ────────────────────────────────────────────────────────────────

  /**
   * The suggestions this caller may see.
   *
   * `ai.copilot.use` opens the queue; which rows are in it is decided on the data, per subject
   * — a class teacher never sees a suggestion about a child outside their sections, and a
   * teacher never sees one about a colleague's expense claim. That rule is in
   * `AiSuggestionService.visibilityFilter`, applied to the query rather than to the route, so
   * a caller outside the scope gets the same answer a caller from another tenant gets.
   */
  @Get('suggestions')
  @RequirePermissions('ai.copilot.use')
  @ApiOperation({ summary: 'AI suggestions awaiting a human decision, scoped to what you may see' })
  async list(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listAiSuggestionsSchema)) query: z.infer<typeof listAiSuggestionsSchema>,
  ) {
    return this.suggestions.list(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Get('suggestions/:id')
  @RequirePermissions('ai.copilot.use')
  @ApiOperation({ summary: 'One suggestion, with its evidence and its proposed action' })
  async findOne(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.suggestions.findOne(principal, requireInstitution(), params.id);
  }

  /**
   * Accept: the human confirmation, and the only route in this module that changes anything
   * outside `ai_suggestions`.
   *
   * READ THE FILE HEADER before changing the decorator. `ai.copilot.use` here is the gate that
   * keeps people with no AI entitlement out; the permission that decides whether this
   * particular suggestion may be carried out is the ACTION's, read from the contract table in
   * the service. Adding permissions to this decorator would not strengthen it — the seven
   * kinds need seven different ones, and any `mode: 'any'` list of them is weaker than the
   * per-kind check it would appear to replace.
   *
   * 200 rather than 201: the created record — a thread, a behaviour record, a substitution —
   * is named in the response body, and the resource at this URL is still the suggestion.
   */
  @Post('suggestions/:id/accept')
  @HttpCode(200)
  @RequirePermissions('ai.copilot.use')
  @Audited({
    module: 'ai-copilot',
    resourceType: 'ai_suggestion',
    action: 'approve',
    resourceIdFrom: 'param:id',
    // The service writes the row in-transaction with `is_ai_initiated = true` and with the
    // executed resource attached, so the trail leads from the action back to the evidence.
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Accept a suggestion: performs the action through the owning module' })
  async accept(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(acceptAiSuggestionSchema)) body: z.infer<typeof acceptAiSuggestionSchema>,
  ) {
    const result = await this.suggestions.accept(
      principal,
      requireInstitution(),
      params.id,
      body,
    );
    return result.suggestion;
  }

  @Post('suggestions/:id/dismiss')
  @HttpCode(200)
  @RequirePermissions('ai.copilot.use')
  @Audited({
    module: 'ai-copilot',
    resourceType: 'ai_suggestion',
    action: 'reject',
    resourceIdFrom: 'param:id',
    // Why a suggestion was refused is the only signal anyone will ever have about whether the
    // copilot is worth having. An acceptance rate on its own measures how agreeable staff are.
    requiresReason: true,
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Dismiss a suggestion with a recorded reason' })
  async dismiss(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(dismissAiSuggestionSchema)) body: z.infer<typeof dismissAiSuggestionSchema>,
  ) {
    const result = await this.suggestions.dismiss(
      principal,
      requireInstitution(),
      params.id,
      body,
    );
    return result.suggestion;
  }
}

/**
 * Belt and braces, exactly as the library and AI controllers do it: `@InstitutionScoped()`
 * makes the tenant guard refuse the request without the header, and this re-reads it because
 * `currentContext()` is typed `string | null` and a service should not have to handle a case
 * the guard already excluded.
 */
function requireInstitution(): string {
  const institutionId = currentContext()?.institutionId;
  if (!institutionId) {
    throw new BadRequestException(
      'Send the x-institution-id header to indicate which institution this copilot question is about.',
    );
  }
  return institutionId;
}
