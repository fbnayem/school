/**
 * AI governance (Phase 36, docs/06 §6, docs/16).
 *
 * Three reads, for three people who are not engineers:
 *
 *   GET /ai/governance/policy        ai.settings.manage  — what AI may never do on its own,
 *                                                          and the routes each entry covers
 *   GET /ai/governance/attestation   ai.settings.manage  — whether that is currently true,
 *                                                          computed from the live router
 *   GET /ai/governance/ai-actions    audit.view          — everything a model was involved in
 *
 * ── Why these permissions ──────────────────────────────────────────────────────────────
 *
 * `ai.settings.manage` on the first two: the person who configures the AI is the person
 * accountable for what it is allowed to do, and both documents are *descriptions of the build*
 * rather than institutional data — no pupil, no family and no money appears in either. It is
 * not a perfect fit. The honest string would be something like `ai.governance.view`, granted
 * to a data protection officer who has no business changing the provider; there is no such
 * string in `packages/permissions/src/catalog.ts` and this module does not edit that file, so
 * the closest existing one is used and the gap is reported rather than papered over.
 *
 * `audit.view` on the third, and not an `ai.` permission: it returns audit rows. Anyone who
 * may read the trail may read the AI-initiated part of it, and nobody who may not read the
 * trail should be able to read it by going through a differently-named door.
 *
 * ── Not `@InstitutionScoped()` ─────────────────────────────────────────────────────────
 *
 * The policy and the attestation are properties of the deployment, not of one school, so
 * demanding an institution header would be asking for a value the answer does not depend on.
 * `ai-actions` accepts the header and narrows to it when present; without it a group
 * administrator sees their whole tenant's AI trail, which is the question they are asking.
 * Either way `TenantGuard` still validates the header against the caller's grants, so a
 * borrowed institution id is refused before this controller runs.
 *
 * No route here mutates anything, so none carries `@Audited(...)` — the boot-time route audit
 * requires it only for mutating routes.
 */

import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { normalizeOffsetPage } from '@shikkha/shared';
import { paginationSchema, uuidSchema } from '@shikkha/validation';
import { RequirePermissions } from '../../common/decorators';
import { zodQuery } from '../../common/pipes/zod-validation.pipe';
import { currentContext } from '../../common/context/request-context';
import { AUDIT_ACTIONS, AiGovernanceService } from './ai-governance.service';
import { AI_AUTONOMY_REFUSAL_MESSAGE } from './ai-autonomy.guard';
import { AI_INITIATION_HEADER } from './ai-initiation';

/**
 * The refusal, published with the policy.
 *
 * So an auditor can reproduce it: send this header, hit one of these routes, expect this
 * status and this message. A policy nobody can test is a policy nobody can trust.
 */
const REFUSAL = {
  status: 403,
  code: 'FORBIDDEN',
  message: AI_AUTONOMY_REFUSAL_MESSAGE,
} as const;

const aiActionsQuerySchema = paginationSchema.extend({
  module: z.string().trim().max(64).optional(),
  resourceType: z.string().trim().max(64).optional(),
  resourceId: uuidSchema.optional(),
  actorUserId: uuidSchema.optional(),
  // From the database enum, so a filter can only ever name a verb the column can hold.
  action: z.enum(AUDIT_ACTIONS).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

@ApiTags('ai-governance')
@Controller('ai/governance')
export class AiGovernanceController {
  constructor(private readonly governance: AiGovernanceService) {}

  @Get('policy')
  @RequirePermissions('ai.settings.manage')
  @ApiOperation({
    summary: 'What AI may never do autonomously, and the routes each rule covers',
    description:
      'The forbidden set from docs/06 §6, expanded against the live router so the list can be ' +
      'checked rather than trusted.',
  })
  async policy() {
    return this.governance.policy(REFUSAL, AI_INITIATION_HEADER);
  }

  @Get('attestation')
  @RequirePermissions('ai.settings.manage')
  @ApiOperation({
    summary: 'Whether every route touching a forbidden resource is covered by the policy',
    description:
      'Reports gaps as gaps. `compliant` is false whenever a mutating route appears to touch a ' +
      'forbidden resource and no policy entry covers it.',
  })
  async attestation() {
    return this.governance.attestation();
  }

  @Get('ai-actions')
  @RequirePermissions('audit.view')
  @ApiOperation({
    summary: 'The AI-initiated audit trail',
    description:
      'Every audit record with is_ai_initiated set, filterable by module, resource, actor and ' +
      'date. This is what answers "was a model involved in this decision, and what did it see".',
  })
  async aiActions(@Query(zodQuery(aiActionsQuerySchema)) query: z.infer<typeof aiActionsQuerySchema>) {
    return this.governance.aiActions(
      {
        module: query.module,
        resourceType: query.resourceType,
        resourceId: query.resourceId,
        actorUserId: query.actorUserId,
        action: query.action,
        // Narrowed only when the caller named an institution. `TenantGuard` has already
        // validated it against their grants, so an id they may not use never reaches here.
        institutionId: currentContext()?.institutionId ?? null,
        from: query.from,
        to: query.to,
      },
      normalizeOffsetPage(query),
    );
  }
}
