/**
 * AI endpoints (Phases 27–28).
 *
 * Every route is `@InstitutionScoped()`: a conversation, a budget and a settings row belong to
 * one institution, and a group administrator running three schools has no safe default. The
 * header is required by the tenant guard rather than guessed here.
 *
 * The permission split, which is the point of this file:
 *
 *   ai.copilot.use      — use the assistant: create conversations, send messages, read your own
 *   ai.usage.view       — see what AI is costing this institution
 *   ai.settings.manage  — provider routing and institution AI settings: which vendor, which
 *                         model per task, whether tutoring is on
 *   ai.budgets.manage   — the spending ceiling. Separate from routing, because the person who
 *                         chooses the model should not be the one who decides how much may be
 *                         spent on it
 *   ai.conversations.view.all — read somebody else's transcript. Granted to no system role by
 *                         default: a conversation holds whatever its user pasted in, which in
 *                         a school is usually about a child
 *
 * Two things worth stating because they are easy to get wrong:
 *
 *  1. **Reading someone else's conversation is not covered by `ai.copilot.use`.** A transcript
 *     contains whatever the user pasted into it, which in a school is usually about a child.
 *     `GET /ai/conversations/:id` therefore carries `ai.copilot.use` at the route and the
 *     service pins the row to the caller unless they also hold `ai.conversations.view.all` —
 *     failing closed on the data, and answering 404 rather than 403 so the existence of
 *     another person's conversation is not confirmed. No system role holds that permission by
 *     default; a school that wants a named person to read staff transcripts has to grant it.
 *  2. **`GET /ai/providers` never returns a credential.** It reports, per adapter, whether the
 *     deployment has what it needs and the *names* of any variables that are missing. Not a
 *     value, not a prefix, not a masked form, not a length — a masked key still narrows a
 *     search space, and there is no operational question it answers that a name does not.
 *
 * Route order matters: Nest matches in declaration order, so the literal segments (`usage`,
 * `budgets`, `settings`, `providers`) are declared before any `:id` route that would otherwise
 * swallow them.
 */

import { BadRequestException, Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { normalizeOffsetPage } from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import {
  aiYearMonthParamSchema,
  appendAiMessageSchema,
  archiveAiConversationSchema,
  createAiConversationSchema,
  idParamSchema,
  listAiBudgetsSchema,
  listAiConversationsSchema,
  listAiUsageSchema,
  putAiBudgetSchema,
  putAiSettingsSchema,
} from '@shikkha/validation';
import { AiConversationService } from './ai-conversation.service';
import { AiUsageService } from './ai-usage.service';
import { AiProviderRegistry } from './providers/registry';
import { AI_TASK_LIST } from './providers/provider.interface';
import { Audited, CurrentUser, InstitutionScoped, RequirePermissions } from '../../common/decorators';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { currentContext } from '../../common/context/request-context';

@ApiTags('ai')
@Controller('ai')
@InstitutionScoped()
export class AiController {
  constructor(
    private readonly conversations: AiConversationService,
    private readonly usage: AiUsageService,
    private readonly providers: AiProviderRegistry,
  ) {}

  // ── Usage, budgets and settings ─────────────────────────────────────────────────────
  // Declared before `:id` so the literal segments are not swallowed by the parameter route.

  @Get('usage')
  @RequirePermissions('ai.usage.view')
  @ApiOperation({ summary: 'What AI is costing, aggregated by month, user or task' })
  async usageSummary(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listAiUsageSchema)) query: z.infer<typeof listAiUsageSchema>,
  ) {
    // `ai.usage.view` answers "may you see the spend", not "whose". Without
    // `ai.settings.manage` the query is pinned to the caller's own attribution.
    return this.usage.summary(requireInstitution(), this.usage.scopeUsageQuery(principal, query));
  }

  @Get('budgets')
  @RequirePermissions('ai.usage.view')
  @ApiOperation({ summary: 'Monthly AI budgets, with the ceiling actually in force' })
  async listBudgets(
    @Query(zodQuery(listAiBudgetsSchema)) query: z.infer<typeof listAiBudgetsSchema>,
  ) {
    return this.usage.listBudgets(requireInstitution(), query);
  }

  /** The budget is replaced whole — a PUT, because that is what a PUT means. */
  @Put('budgets/:yearMonth')
  // Setting the ceiling is a budget decision, not a vendor one. It used to share
  // `ai.settings.manage` with provider routing, which meant whoever chose the model also
  // chose how much the school could spend on it — the separation accounting gets between
  // creating a journal entry and posting it.
  @RequirePermissions('ai.budgets.manage')
  @Audited({
    module: 'ai',
    resourceType: 'ai_budget',
    action: 'update',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Set one month\'s AI budget' })
  async putBudget(
    @CurrentUser() principal: Principal,
    @Param(zodParam(aiYearMonthParamSchema)) params: { yearMonth: string },
    @Body(zodBody(putAiBudgetSchema)) body: z.infer<typeof putAiBudgetSchema>,
  ) {
    const result = await this.usage.putBudget(
      principal,
      requireInstitution(),
      params.yearMonth,
      body,
    );
    // `__audit` is read by the audit interceptor and stripped from the HTTP response, so the
    // trail records what actually changed rather than the whole submitted body.
    return {
      ...result.budget,
      __audit: {
        previousValue: result.previous,
        newValue: {
          tokenLimit: result.budget.tokenLimit,
          costLimit: result.budget.costLimit,
          hardStop: result.budget.hardStop,
          currency: result.budget.currency,
        },
      },
    };
  }

  @Get('settings')
  @RequirePermissions('ai.settings.manage')
  @ApiOperation({ summary: 'Provider routing and budget defaults for this institution' })
  async getSettings() {
    return this.usage.getSettings(requireInstitution());
  }

  @Put('settings')
  @RequirePermissions('ai.settings.manage')
  @Audited({
    module: 'ai',
    resourceType: 'ai_provider_settings',
    action: 'update',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Replace this institution\'s AI settings' })
  async putSettings(
    @CurrentUser() principal: Principal,
    @Body(zodBody(putAiSettingsSchema)) body: z.infer<typeof putAiSettingsSchema>,
  ) {
    const result = await this.usage.putSettings(principal, requireInstitution(), body);
    return {
      ...result.settings,
      __audit: {
        previousValue: result.previous,
        newValue: {
          defaultProvider: result.settings.defaultProvider,
          taskRouting: result.settings.taskRouting,
          defaultMonthlyTokenLimit: result.settings.defaultMonthlyTokenLimit,
          defaultMonthlyCostLimit: result.settings.defaultMonthlyCostLimit,
          defaultHardStop: result.settings.defaultHardStop,
          tutoringEnabledForStudents: result.settings.tutoringEnabledForStudents,
          currency: result.settings.currency,
        },
      },
    };
  }

  /**
   * Which adapters exist, which the deployment can actually use, and which task each one
   * currently answers.
   *
   * No credential, in any form, appears in this response — see the file header. What it does
   * carry is the *names* of missing variables, which is what an administrator needs in order
   * to ask the right person for the right thing.
   */
  @Get('providers')
  @RequirePermissions('ai.settings.manage')
  @ApiOperation({ summary: 'Configured AI providers and whether their credentials are present' })
  async listProviders() {
    return {
      providers: this.providers.statuses(),
      routing: this.providers.routingTable(AI_TASK_LIST),
      embeddingDimensions: this.providers.embeddingDimensions(),
    };
  }

  // ── Conversations ───────────────────────────────────────────────────────────────────

  @Post('conversations')
  @RequirePermissions('ai.copilot.use')
  @Audited({
    module: 'ai',
    resourceType: 'ai_conversation',
    action: 'create',
    resourceIdFrom: 'response:id',
    // The service writes the audit row inside its own transaction, with the AI-initiation
    // flag set correctly. Without this the interceptor would write a second row with a null
    // previous value.
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Start an AI conversation, optionally with its first message' })
  async createConversation(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createAiConversationSchema)) body: z.infer<typeof createAiConversationSchema>,
  ) {
    const result = await this.conversations.create(principal, requireInstitution(), body);
    return { ...result.conversation, completion: result.completion ?? null };
  }

  @Get('conversations')
  @RequirePermissions('ai.copilot.use')
  @ApiOperation({ summary: 'Your AI conversations (everyone’s, with ai.conversations.view.all)' })
  async listConversations(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listAiConversationsSchema))
    query: z.infer<typeof listAiConversationsSchema>,
  ) {
    return this.conversations.list(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Get('conversations/:id')
  @RequirePermissions('ai.copilot.use')
  @ApiOperation({ summary: 'One conversation and its transcript' })
  async getConversation(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.conversations.findOne(principal, requireInstitution(), params.id);
  }

  @Post('conversations/:id/messages')
  @RequirePermissions('ai.copilot.use')
  @Audited({
    module: 'ai',
    resourceType: 'ai_message',
    action: 'create',
    resourceIdFrom: 'param:id',
    // In-transaction again, and this one carries `is_ai_initiated = true`.
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Send a message and receive the assistant\'s answer' })
  async sendMessage(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(appendAiMessageSchema)) body: z.infer<typeof appendAiMessageSchema>,
  ) {
    return this.conversations.complete(principal, requireInstitution(), params.id, body);
  }

  @Post('conversations/:id/archive')
  @RequirePermissions('ai.copilot.use')
  @Audited({
    module: 'ai',
    resourceType: 'ai_conversation',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive a conversation (the transcript is never deleted)' })
  async archiveConversation(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(archiveAiConversationSchema))
    body: z.infer<typeof archiveAiConversationSchema>,
  ) {
    const result = await this.conversations.archive(
      principal,
      requireInstitution(),
      params.id,
      body,
    );
    return {
      ...result.conversation,
      __audit: {
        previousValue: result.previous,
        newValue: { archivedAt: result.conversation.archivedAt, reason: body.reason },
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
      'Send the x-institution-id header to indicate which institution this AI conversation belongs to.',
    );
  }
  return institutionId;
}
