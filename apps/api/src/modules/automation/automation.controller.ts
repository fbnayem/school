/**
 * Automation engine endpoints (Phase 26).
 *
 * Two shapes here are deliberate and worth reading before adding a route.
 *
 * **There is no scheduler.** `POST events/process` drains the pending queue and
 * `GET schedule/due` reports which scheduled rules are due at a given instant. Both are
 * ordinary permission-checked requests, which is what makes the engine testable now and keeps
 * *when* work runs a deployment concern — a cron entry, a queue worker — instead of a
 * background thread this API silently owns.
 *
 * **Dry run writes nothing.** It is a POST because it carries a sample payload in a body, and
 * it is audited as an `export` for the same reason the fee-generation preview is: it computes
 * real facts about real people, which somebody then acts on. Every mutating route here carries
 * `@Audited(...)`, including that one.
 *
 * Accepting a suggestion records a decision; it does not perform the underlying action. The
 * reviewer then acts in the module that owns the record, under that module's permissions. A
 * route that applied the suggestion for them would be the automation engine acting
 * autonomously with one extra step in front of it.
 */

import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { normalizeOffsetPage } from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import {
  activateAutomationRuleSchema,
  archiveAutomationRuleSchema,
  automationActivityReportSchema,
  createAutomationRuleSchema,
  deactivateAutomationRuleSchema,
  decideAutomationSuggestionSchema,
  dryRunAutomationRuleSchema,
  emitAutomationEventSchema,
  idParamSchema,
  listAutomationEventsSchema,
  listAutomationExecutionsSchema,
  listAutomationRulesSchema,
  listAutomationSuggestionsSchema,
  listDueAutomationSchedulesSchema,
  processAutomationEventsSchema,
  updateAutomationRuleSchema,
} from '@shikkha/validation';
import { AutomationService } from './automation.service';
import {
  Audited,
  CurrentUser,
  InstitutionScoped,
  RequirePermissions,
} from '../../common/decorators';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { currentContext } from '../../common/context/request-context';

@ApiTags('automation')
@Controller('automation')
export class AutomationController {
  constructor(private readonly automation: AutomationService) {}

  // ───────────────────────────────────────────────────────────────────────────────────
  // Discovery
  // ───────────────────────────────────────────────────────────────────────────────────

  /**
   * The vocabulary a rule may use: the events this system raises with their declared payload
   * fields, the facts the engine can compute, and the resources that force a human into the
   * loop. Published because a rule author who has to guess writes rules that never match.
   */
  @Get('catalog')
  @InstitutionScoped()
  @RequirePermissions('automation.rules.view')
  @ApiOperation({ summary: 'Events, facts and sensitive resources a rule may reference' })
  catalog() {
    return this.automation.describeCatalog();
  }

  // ───────────────────────────────────────────────────────────────────────────────────
  // Rules. Literal paths are declared before `:id` routes.
  // ───────────────────────────────────────────────────────────────────────────────────

  @Get('rules')
  @InstitutionScoped()
  @RequirePermissions('automation.rules.view')
  @ApiOperation({ summary: 'List automation rules' })
  async listRules(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listAutomationRulesSchema)) query: z.infer<typeof listAutomationRulesSchema>,
  ) {
    return this.automation.listRules(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Post('rules')
  @InstitutionScoped()
  @RequirePermissions('automation.rules.manage')
  @Audited({
    module: 'automation',
    resourceType: 'automation_rule',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create an automation rule (version 1, inactive)' })
  async createRule(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createAutomationRuleSchema)) body: z.infer<typeof createAutomationRuleSchema>,
  ) {
    return this.automation.createRule(principal, requireInstitution(), body);
  }

  /**
   * Write the four defaults docs/08 §5 anticipates for this institution, inactive and
   * idempotent. Migration 0030 seeds them for institutions that existed when it ran; this is
   * how one created afterwards gets them.
   */
  @Post('rules/install-defaults')
  @InstitutionScoped()
  @RequirePermissions('automation.rules.manage')
  @Audited({ module: 'automation', resourceType: 'automation_rule', action: 'create' })
  @ApiOperation({ summary: 'Install the default rule set for this institution, inactive' })
  async installDefaults(@CurrentUser() principal: Principal) {
    return this.automation.installDefaultRules(principal, requireInstitution());
  }

  @Get('rules/:id')
  @InstitutionScoped()
  @RequirePermissions('automation.rules.view')
  @ApiOperation({ summary: 'Fetch one automation rule' })
  async getRule(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.automation.getRule(principal, requireInstitution(), params.id);
  }

  /** An edit creates version n+1 and stands version n down; running history keeps its version. */
  @Patch('rules/:id')
  @InstitutionScoped()
  @RequirePermissions('automation.rules.manage')
  @Audited({
    module: 'automation',
    resourceType: 'automation_rule',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Edit an automation rule by creating a new version' })
  async updateRule(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateAutomationRuleSchema)) body: z.infer<typeof updateAutomationRuleSchema>,
  ) {
    const result = await this.automation.updateRule(
      principal,
      requireInstitution(),
      params.id,
      body,
    );
    return { ...result.rule, __audit: { previousValue: result.previous, newValue: body } };
  }

  @Post('rules/:id/activate')
  @InstitutionScoped()
  @RequirePermissions('automation.rules.manage')
  @Audited({
    module: 'automation',
    resourceType: 'automation_rule',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Activate a rule version (the others of its key stand down)' })
  async activateRule(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(activateAutomationRuleSchema))
    body: z.infer<typeof activateAutomationRuleSchema>,
  ) {
    return this.automation.activateRule(principal, requireInstitution(), params.id, body.version);
  }

  @Post('rules/:id/deactivate')
  @InstitutionScoped()
  @RequirePermissions('automation.rules.manage')
  @Audited({
    module: 'automation',
    resourceType: 'automation_rule',
    action: 'update',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Stop a rule from running, with a recorded reason' })
  async deactivateRule(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(deactivateAutomationRuleSchema))
    body: z.infer<typeof deactivateAutomationRuleSchema>,
  ) {
    return this.automation.deactivateRule(principal, requireInstitution(), params.id, body.version);
  }

  @Post('rules/:id/archive')
  @InstitutionScoped()
  @RequirePermissions('automation.rules.manage')
  @Audited({
    module: 'automation',
    resourceType: 'automation_rule',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive a rule (never deleted; its executions remain evidence)' })
  async archiveRule(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(archiveAutomationRuleSchema)) body: { reason: string },
  ) {
    return this.automation.archiveRule(principal, requireInstitution(), params.id, body.reason);
  }

  /**
   * Evaluate a rule against a sample payload. Nothing is written and no action is taken —
   * the response is the clause-by-clause verdict, the facts as they really are right now, and
   * a sentence describing what the rule *would* have done.
   */
  @Post('rules/:id/dry-run')
  @InstitutionScoped()
  @RequirePermissions('automation.rules.manage')
  @Audited({
    module: 'automation',
    resourceType: 'automation_rule_dry_run',
    action: 'export',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Evaluate a rule against a sample payload without acting' })
  async dryRun(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(dryRunAutomationRuleSchema)) body: z.infer<typeof dryRunAutomationRuleSchema>,
  ) {
    return this.automation.dryRunRule(principal, requireInstitution(), params.id, body.payload);
  }

  // ───────────────────────────────────────────────────────────────────────────────────
  // Events
  // ───────────────────────────────────────────────────────────────────────────────────

  @Get('events')
  @InstitutionScoped()
  @RequirePermissions('automation.rules.view')
  @ApiOperation({ summary: 'List recorded automation events' })
  async listEvents(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listAutomationEventsSchema)) query: z.infer<typeof listAutomationEventsSchema>,
  ) {
    return this.automation.listEvents(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  /**
   * Raise an event for rules to react to.
   *
   * Internal in the sense that matters: permission-checked, and its event names and payload
   * fields are a closed catalogue (`GET catalog`). A repeated `dedupeKey` returns the original
   * event with `duplicate: true` and writes nothing.
   */
  @Post('events')
  @InstitutionScoped()
  @RequirePermissions('automation.events.emit')
  @Audited({ module: 'automation', resourceType: 'automation_event', action: 'create' })
  @ApiOperation({ summary: 'Emit an automation event (idempotent on dedupeKey)' })
  async emitEvent(
    @CurrentUser() principal: Principal,
    @Body(zodBody(emitAutomationEventSchema)) body: z.infer<typeof emitAutomationEventSchema>,
  ) {
    return this.automation.emitEvent(principal, requireInstitution(), body);
  }

  /**
   * Run the rules for pending events — or, with `eventId`, re-run one event after a rule
   * change. Idempotent either way: a rule that already executed against an event is recorded
   * `suppressed_duplicate` rather than acting twice.
   */
  @Post('events/process')
  @InstitutionScoped()
  @RequirePermissions('automation.events.process')
  @Audited({ module: 'automation', resourceType: 'automation_event', action: 'update' })
  @ApiOperation({ summary: 'Process pending automation events (no background worker exists)' })
  async processEvents(
    @CurrentUser() principal: Principal,
    @Body(zodBody(processAutomationEventsSchema))
    body: z.infer<typeof processAutomationEventsSchema>,
  ) {
    return this.automation.processPendingEvents(principal, requireInstitution(), body);
  }

  /**
   * Which scheduled rules are due at an instant, in each rule's own time zone. This endpoint
   * reports; it does not run anything. Whatever schedules — a cron entry, a queue worker —
   * reads this and then calls the ordinary endpoints.
   */
  @Get('schedule/due')
  @InstitutionScoped()
  @RequirePermissions('automation.rules.view')
  @ApiOperation({ summary: 'Scheduled rules due at a given instant (reporting only)' })
  async listDue(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listDueAutomationSchedulesSchema))
    query: z.infer<typeof listDueAutomationSchedulesSchema>,
  ) {
    return this.automation.listDueSchedules(
      principal,
      requireInstitution(),
      query.at ? new Date(query.at) : new Date(),
    );
  }

  // ───────────────────────────────────────────────────────────────────────────────────
  // Executions, suggestions and the activity report
  // ───────────────────────────────────────────────────────────────────────────────────

  @Get('executions')
  @InstitutionScoped()
  @RequirePermissions('automation.executions.view')
  @ApiOperation({ summary: 'Execution history — acted, suppressed, awaiting and failed alike' })
  async listExecutions(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listAutomationExecutionsSchema))
    query: z.infer<typeof listAutomationExecutionsSchema>,
  ) {
    return this.automation.listExecutions(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Get('suggestions')
  @InstitutionScoped()
  @RequirePermissions('automation.executions.view')
  @ApiOperation({ summary: 'Suggestions raised by rules, awaiting a human decision' })
  async listSuggestions(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listAutomationSuggestionsSchema))
    query: z.infer<typeof listAutomationSuggestionsSchema>,
  ) {
    return this.automation.listSuggestions(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  /** Records that a person agreed. It does not carry out the suggestion — a person does. */
  @Post('suggestions/:id/accept')
  @InstitutionScoped()
  @RequirePermissions('automation.suggestions.decide')
  @Audited({
    module: 'automation',
    resourceType: 'automation_suggestion',
    action: 'approve',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Accept a suggestion (records the decision; performs no action)' })
  async acceptSuggestion(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(decideAutomationSuggestionSchema))
    body: z.infer<typeof decideAutomationSuggestionSchema>,
  ) {
    return this.automation.decideSuggestion(
      principal,
      requireInstitution(),
      params.id,
      'accepted',
      body.note,
      body.version,
    );
  }

  @Post('suggestions/:id/dismiss')
  @InstitutionScoped()
  @RequirePermissions('automation.suggestions.decide')
  @Audited({
    module: 'automation',
    resourceType: 'automation_suggestion',
    action: 'reject',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Dismiss a suggestion with a recorded note' })
  async dismissSuggestion(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(decideAutomationSuggestionSchema))
    body: z.infer<typeof decideAutomationSuggestionSchema>,
  ) {
    return this.automation.decideSuggestion(
      principal,
      requireInstitution(),
      params.id,
      'dismissed',
      body.note,
      body.version,
    );
  }

  @Get('reports/activity')
  @InstitutionScoped()
  @RequirePermissions('automation.executions.view')
  @ApiOperation({ summary: 'What the automation engine did, by status and by rule' })
  async activityReport(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(automationActivityReportSchema))
    query: z.infer<typeof automationActivityReportSchema>,
  ) {
    return this.automation.activityReport(principal, requireInstitution(), query);
  }
}

/**
 * Every automation route belongs to exactly one institution: a rule, its events and its
 * executions are institution-scoped rows. `@InstitutionScoped()` already refuses a request
 * without the header; this converts the resolved value into a plain string for the service.
 */
function requireInstitution(): string {
  const institutionId = currentContext()?.institutionId;
  if (!institutionId) {
    throw new BadRequestException(
      'Send the x-institution-id header to indicate which institution these rules belong to.',
    );
  }
  return institutionId;
}
