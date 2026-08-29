/**
 * AI usage metering, budgets and provider settings (Phase 28).
 *
 * This is the service every other AI code path goes through before it spends anything.
 * docs/06 §8 is the whole specification:
 *
 *   "Per-tenant token budgets, per-user rate limits, cached embeddings, and a usage log with
 *    cost attribution. A school on a fixed subscription cannot be exposed to an unbounded
 *    inference bill, so **the budget is enforced before the call rather than reported after
 *    it**."
 *
 * Four decisions follow from that sentence:
 *
 *  1. **`assertWithinBudget` runs before the provider call, never after.** A budget checked
 *     afterwards is a report, not a budget. The check can overshoot by at most the cost of
 *     the one call that crosses the line — nobody can know a call's cost before making it —
 *     and that is precisely why `hard_stop` refuses *at* the ceiling rather than trying to
 *     predict the next call's size.
 *  2. **The tally is the database's, not this service's.** `record` inserts an event; a
 *     trigger applies it to the month's budget row in the same transaction, and a guard
 *     trigger refuses this service (and raw SQL, and a compromised application) from writing
 *     the tally directly. There is therefore no code path through which usage can be
 *     under-reported by forgetting to increment something.
 *  3. **Cost is integer arithmetic at four decimals** (`ai-pricing.ts`), never a float and
 *     never rounded per call. `Money` appears only where a figure is presented as settlement
 *     currency (ADR-004).
 *  4. **Settings live here too**, because the monthly defaults an unbudgeted month falls back
 *     to are part of the enforcement decision, and splitting them across two services would
 *     mean two places could disagree about what the ceiling is.
 */

import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { aiBudgets, aiProviderSettings, aiUsageEvents } from '@shikkha/db';
import {
  ConflictError,
  DHAKA_UTC_OFFSET_MINUTES,
  InternalError,
  uuidv7,
  type CurrencyCode,
} from '@shikkha/shared';
import { can, type Principal } from '@shikkha/permissions';
import type {
  AiConversationPurpose,
  AiTaskName,
  ListAiBudgetsInput,
  ListAiUsageInput,
  PutAiBudgetInput,
  PutAiSettingsInput,
} from '@shikkha/validation';
import { DatabaseService } from '../database/database.service';
import { currentContext } from '../../common/context/request-context';
import { getLogger } from '../../common/logger';
import {
  computeAiCostDecimal,
  formatCost,
  isSupportedCurrency,
  parseCost,
  priceOf,
  roundToCurrency,
} from './ai-pricing';
import { AiProviderRegistry } from './providers/registry';
import { AI_TASK_LIST, type AiTask } from './providers/provider.interface';

/** The transaction handle `runInTenant` hands to its callback. */
export type Tx = Parameters<Parameters<DatabaseService['runInTenant']>[0]>[0];

type BudgetRow = typeof aiBudgets.$inferSelect;
type SettingsRow = typeof aiProviderSettings.$inferSelect;

/**
 * The settings applied when an institution has never saved any. Mirrors the column defaults,
 * and deliberately opens with the credential-free provider and tutoring switched off.
 */
export const DEFAULT_AI_SETTINGS = {
  defaultProvider: 'mock',
  taskRouting: {} as Record<string, string>,
  defaultMonthlyTokenLimit: null,
  defaultMonthlyCostLimit: null,
  defaultHardStop: true,
  tutoringEnabledForStudents: false,
  currency: 'USD',
} as const;

/** What `assertWithinBudget` decided, and why. */
export interface BudgetDecision {
  yearMonth: string;
  withinBudget: boolean;
  /** Present when the ceiling is exceeded but `hardStop` is false: the call proceeds. */
  warning?: string;
  tokenLimit: number | null;
  costLimit: string | null;
  tokensUsed: number;
  costUsed: string;
  hardStop: boolean;
  currency: string;
}

export interface RecordUsageInput {
  tenantId: string;
  institutionId: string;
  conversationId?: string | null;
  task: AiTask;
  providerKey: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  userId?: string | null;
  purpose?: AiConversationPurpose | null;
  currency?: string;
  /**
   * An explicit cost, as a four-decimal string. Supplied only where a provider reports the
   * charge itself; otherwise the price sheet computes it. Never a number.
   */
  cost?: string;
  occurredAt?: Date;
}

@Injectable()
export class AiUsageService {
  constructor(
    private readonly db: DatabaseService,
    private readonly providers: AiProviderRegistry,
  ) {}

  // ── Budget periods ────────────────────────────────────────────────────────────────

  /**
   * The budget period an instant falls in, `YYYY-MM` in Asia/Dhaka.
   *
   * Must agree exactly with `ai_usage_events_apply_budget`, which derives the same string in
   * SQL. Deriving it in UTC instead would move the first six hours of every local month's
   * spend into the previous month, and the enforcement check would then be reading a
   * different row from the one the tally lands on.
   */
  yearMonthOf(instant: Date = new Date()): string {
    const shifted = new Date(instant.getTime() + DHAKA_UTC_OFFSET_MINUTES * 60_000);
    const year = shifted.getUTCFullYear().toString().padStart(4, '0');
    const month = (shifted.getUTCMonth() + 1).toString().padStart(2, '0');
    return `${year}-${month}`;
  }

  // ── Enforcement ───────────────────────────────────────────────────────────────────

  /**
   * Refuse the call if this institution's budget is exhausted and `hardStop` is set.
   *
   * Called *before* the provider is consulted. When there is no budget row for the month, the
   * institution's settings supply the ceiling; when there is a row with a null limit, that
   * limit does not apply — "unbudgeted" and "budgeted at zero" stay distinguishable, which
   * matters because a school that sets a zero ceiling means something specific by it.
   *
   * `task` is accepted and recorded in the refusal context so an operator can see which
   * workload hit the ceiling. It does not currently change the decision: a per-task budget
   * would need a per-task limit column, and there is no product requirement for one yet.
   */
  async assertWithinBudget(
    principal: Principal,
    institutionId: string,
    task: AiTask,
  ): Promise<BudgetDecision> {
    const yearMonth = this.yearMonthOf();

    const decision = await this.db.runInTenant(async (tx) => {
      const [settings] = await tx
        .select()
        .from(aiProviderSettings)
        .where(eq(aiProviderSettings.institutionId, institutionId))
        .limit(1);

      const [budget] = await tx
        .select()
        .from(aiBudgets)
        .where(
          and(eq(aiBudgets.institutionId, institutionId), eq(aiBudgets.yearMonth, yearMonth)),
        )
        .limit(1);

      return this.decide(yearMonth, budget ?? null, settings ?? null);
    });

    if (decision.withinBudget) return decision;

    if (decision.hardStop) {
      // A 409, not a 429: this is not "slow down", it is "this month's budget is spent".
      // Retrying does not help; a human raising the ceiling does.
      throw new ConflictError(
        `This institution's AI budget for ${yearMonth} is exhausted. An administrator can raise it, or clear the hard stop, in AI settings.`,
        {
          institutionId,
          yearMonth,
          task,
          tokenLimit: decision.tokenLimit,
          costLimit: decision.costLimit,
          tokensUsed: decision.tokensUsed,
          costUsed: decision.costUsed,
          userId: principal.userId,
        },
      );
    }

    // Soft budget: the call proceeds, the overage is recorded in the log at warn level and
    // returned to the caller so it can be shown to the user rather than discovered on a bill.
    getLogger().warn(
      {
        institutionId,
        yearMonth,
        task,
        tokensUsed: decision.tokensUsed,
        tokenLimit: decision.tokenLimit,
        costUsed: decision.costUsed,
        costLimit: decision.costLimit,
      },
      'AI budget exceeded; hard stop is off so the call proceeds as an overage',
    );
    return decision;
  }

  /**
   * The pure decision, split out so the enforcement rule is one readable function rather than
   * a condition buried in a transaction.
   */
  private decide(
    yearMonth: string,
    budget: BudgetRow | null,
    settings: SettingsRow | null,
  ): BudgetDecision {
    const tokenLimit = budget
      ? (budget.tokenLimit ?? settings?.defaultMonthlyTokenLimit ?? null)
      : (settings?.defaultMonthlyTokenLimit ?? null);
    const costLimit = budget
      ? (budget.costLimit ?? settings?.defaultMonthlyCostLimit ?? null)
      : (settings?.defaultMonthlyCostLimit ?? null);
    const hardStop = budget ? budget.hardStop : (settings?.defaultHardStop ?? true);
    const currency = budget?.currency ?? settings?.currency ?? DEFAULT_AI_SETTINGS.currency;

    const tokensUsed = budget?.tokensUsed ?? 0;
    const costUsed = budget?.costUsed ?? '0.0000';

    const tokensExhausted = tokenLimit !== null && tokensUsed >= tokenLimit;
    const costExhausted = costLimit !== null && parseCost(costUsed) >= parseCost(costLimit);
    const withinBudget = !tokensExhausted && !costExhausted;

    const decision: BudgetDecision = {
      yearMonth,
      withinBudget,
      tokenLimit,
      costLimit,
      tokensUsed,
      costUsed,
      hardStop,
      currency,
    };

    if (!withinBudget && !hardStop) {
      decision.warning = tokensExhausted
        ? `The AI token budget for ${yearMonth} is exhausted (${tokensUsed} of ${tokenLimit}). The call was allowed because the hard stop is off.`
        : `The AI cost budget for ${yearMonth} is exhausted (${costUsed} of ${costLimit} ${currency}). The call was allowed because the hard stop is off.`;
    }

    return decision;
  }

  // ── Recording ─────────────────────────────────────────────────────────────────────

  /** What one call costs, as the four-decimal string the column stores. */
  costOf(model: string, inputTokens: number, outputTokens: number): string {
    return computeAiCostDecimal(model, inputTokens, outputTokens);
  }

  /**
   * Write a usage event **inside the caller's transaction**.
   *
   * In-transaction on purpose: if the business work rolls back, so does the charge, and if it
   * commits, the charge is on the ledger — there is no window in which a school was billed
   * for a message that does not exist, or holds a message that cost nothing. The month's
   * tally is applied by a database trigger on this insert, so nothing here increments a
   * counter and nothing here can forget to.
   */
  async record(tx: Tx, input: RecordUsageInput): Promise<{ id: string; cost: string }> {
    // A caller that has no transaction of its own — background ingestion, a scheduled job —
    // wants `recordStandalone`. Calling `record` with the input alone would otherwise fail
    // deep inside the query builder with an unreadable error; naming the right method here
    // costs one check and turns a confusing crash into an instruction.
    if (input === undefined || (tx as unknown as RecordUsageInput)?.tenantId !== undefined) {
      throw new InternalError(
        'AiUsageService.record(tx, input) writes inside the caller transaction. A caller with no transaction should use recordStandalone(input).',
        { expected: 'record(tx, input)' },
      );
    }

    const cost = input.cost ?? this.costOf(input.model, input.inputTokens, input.outputTokens);

    const { isFallback } = priceOf(input.model);
    if (isFallback) {
      // Not an error — the call happened and must be metered — but somebody has to add the
      // row, and an unpriced model quietly costing the ceiling rate is worth saying out loud.
      getLogger().warn(
        { model: input.model, provider: input.providerKey },
        'no price sheet row for this model; charged at the conservative fallback rate. Add it to MODEL_PRICES in ai-pricing.ts',
      );
    }

    const id = uuidv7();
    await tx.insert(aiUsageEvents).values({
      id,
      tenantId: input.tenantId,
      institutionId: input.institutionId,
      conversationId: input.conversationId ?? null,
      task: input.task,
      providerKey: input.providerKey,
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cost,
      currency: input.currency ?? DEFAULT_AI_SETTINGS.currency,
      occurredAt: input.occurredAt ?? new Date(),
      userId: input.userId ?? null,
      purpose: input.purpose ?? null,
      createdBy: input.userId ?? null,
      updatedBy: input.userId ?? null,
    });

    return { id, cost };
  }

  /**
   * Write a usage event in a transaction of its own.
   *
   * For callers that genuinely have none — retrieval ingestion, a scheduled embedding
   * refresh, anything driven by a queue rather than an HTTP request. The atomicity guarantee
   * `record` gives is weaker here by construction: the spend is recorded whether or not the
   * work that caused it ultimately succeeds. That is the right trade for ingestion, where the
   * provider has already been paid, and the wrong one for a conversation turn, which is why
   * both methods exist rather than one tolerant method.
   */
  async recordStandalone(input: RecordUsageInput): Promise<{ id: string; cost: string }> {
    return this.db.runInTenant(async (tx) => this.record(tx, input));
  }

  // ── Reporting ─────────────────────────────────────────────────────────────────────

  /**
   * Usage aggregated by month, by user or by task.
   *
   * Aggregates rather than raw events, which is the same rule docs/06 §2 applies to AI tools:
   * return the minimum that answers the question. A per-call log with prompts in it is not
   * what "how much are we spending" needs, and `ai.usage.view` is held by people who have no
   * business reading other users' conversations.
   */
  async summary(institutionId: string, query: ListAiUsageInput) {
    const monthExpression = sql<string>`to_char(${aiUsageEvents.occurredAt} at time zone 'Asia/Dhaka', 'YYYY-MM')`;

    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(aiUsageEvents.institutionId, institutionId)];
      // Compared as SQL rather than through `gte(column, …)` because the left-hand side is a
      // derived expression, not a column — the month is computed in Asia/Dhaka.
      if (query.from) filters.push(sql`${monthExpression} >= ${query.from}`);
      if (query.to) filters.push(sql`${monthExpression} <= ${query.to}`);
      if (query.task) filters.push(eq(aiUsageEvents.task, query.task as AiTaskName));
      if (query.userId) filters.push(eq(aiUsageEvents.userId, query.userId));

      const where = and(...filters);

      const groupExpression =
        query.groupBy === 'user'
          ? sql<string>`coalesce(${aiUsageEvents.userId}::text, 'system')`
          : query.groupBy === 'task'
            ? sql<string>`${aiUsageEvents.task}::text`
            : monthExpression;

      // Every aggregate crosses the driver as a **string**. `sum(integer)` is a `bigint` and
      // `sum(numeric)` is a `numeric`; casting either to `int` to make the driver hand back a
      // number would overflow silently at two billion tokens, and reading the cost as a
      // float would defeat the whole point of the four-decimal column.
      const rows = await tx
        .select({
          key: sql<string>`${groupExpression}`,
          calls: sql<string>`count(*)::text`,
          inputTokens: sql<string>`coalesce(sum(${aiUsageEvents.inputTokens}), 0)::text`,
          outputTokens: sql<string>`coalesce(sum(${aiUsageEvents.outputTokens}), 0)::text`,
          cost: sql<string>`to_char(coalesce(sum(${aiUsageEvents.cost}), 0), 'FM9999999999990.0000')`,
        })
        .from(aiUsageEvents)
        .where(where)
        .groupBy(groupExpression)
        .orderBy(asc(sql`${groupExpression}`));

      const currency = await this.currencyOf(tx, institutionId);

      const mapped = rows.map((row) => {
        const inputTokens = Number(row.inputTokens);
        const outputTokens = Number(row.outputTokens);
        return {
          key: row.key,
          calls: Number(row.calls),
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          cost: row.cost,
          costRounded: this.presentAsCurrency(row.cost, currency),
        };
      });

      const totalCost = formatCost(
        mapped.reduce<bigint>((total, row) => total + parseCost(row.cost), 0n),
      );

      return {
        groupBy: query.groupBy,
        rows: mapped,
        totals: {
          calls: mapped.reduce((total, row) => total + row.calls, 0),
          inputTokens: mapped.reduce((total, row) => total + row.inputTokens, 0),
          outputTokens: mapped.reduce((total, row) => total + row.outputTokens, 0),
          cost: totalCost,
          costRounded: this.presentAsCurrency(totalCost, currency),
          currency,
        },
      };
    });
  }

  /** Every budget row in range, with the effective ceiling each month actually has. */
  async listBudgets(institutionId: string, query: ListAiBudgetsInput) {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(aiBudgets.institutionId, institutionId)];
      if (query.from) filters.push(gte(aiBudgets.yearMonth, query.from));
      if (query.to) filters.push(lte(aiBudgets.yearMonth, query.to));

      const [settings] = await tx
        .select()
        .from(aiProviderSettings)
        .where(eq(aiProviderSettings.institutionId, institutionId))
        .limit(1);

      const rows = await tx
        .select()
        .from(aiBudgets)
        .where(and(...filters))
        .orderBy(desc(aiBudgets.yearMonth));

      return {
        currentPeriod: this.yearMonthOf(),
        budgets: rows.map((row) => ({
          ...row,
          // The ceiling that is actually in force, after the institution's defaults are
          // applied. Returned alongside the raw columns so a UI does not have to re-implement
          // the fallback rule and get it subtly different.
          effective: this.decide(row.yearMonth, row, settings ?? null),
        })),
      };
    });
  }

  /**
   * Set one month's budget. Limits only — `tokensUsed` and `costUsed` are the database's, and
   * the `ai_budgets_derived_guard` trigger would refuse this statement if it tried.
   *
   * Returns `previous` so the controller can hand the audit interceptor a real before-state.
   */
  async putBudget(
    principal: Principal,
    institutionId: string,
    yearMonth: string,
    input: PutAiBudgetInput,
  ) {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(aiBudgets)
        .where(
          and(eq(aiBudgets.institutionId, institutionId), eq(aiBudgets.yearMonth, yearMonth)),
        )
        .limit(1);

      const values = {
        tokenLimit: input.tokenLimit ?? null,
        costLimit: input.costLimit ?? null,
        hardStop: input.hardStop,
        currency: input.currency ?? existing?.currency ?? DEFAULT_AI_SETTINGS.currency,
        updatedBy: principal.userId,
      };

      let row: BudgetRow;
      if (existing) {
        const [updated] = await tx
          .update(aiBudgets)
          .set({ ...values, version: existing.version + 1 })
          .where(eq(aiBudgets.id, existing.id))
          .returning();
        row = updated!;
      } else {
        const [created] = await tx
          .insert(aiBudgets)
          .values({
            id: uuidv7(),
            tenantId: principal.tenantId!,
            institutionId,
            yearMonth,
            ...values,
            createdBy: principal.userId,
          })
          .returning();
        row = created!;
      }

      return {
        budget: row,
        previous: existing
          ? {
              tokenLimit: existing.tokenLimit,
              costLimit: existing.costLimit,
              hardStop: existing.hardStop,
              currency: existing.currency,
            }
          : null,
      };
    });
  }

  // ── Provider settings ─────────────────────────────────────────────────────────────

  /**
   * The institution's settings, with the deployment's live routing beside them.
   *
   * The two are different things and the response says so: `taskRouting` is what this school
   * asked for, `deploymentRouting` is what the environment will actually do. A school can
   * name a provider the deployment has no key for, and an administrator needs to be able to
   * see that rather than wonder why answers still come from the default.
   */
  async getSettings(institutionId: string) {
    const stored = await this.db.runInTenant(async (tx) => {
      const [row] = await tx
        .select()
        .from(aiProviderSettings)
        .where(eq(aiProviderSettings.institutionId, institutionId))
        .limit(1);
      return row ?? null;
    });

    return {
      settings: stored ?? { institutionId, ...DEFAULT_AI_SETTINGS },
      isDefault: stored === null,
      deployment: {
        routing: this.providers.routingTable(AI_TASK_LIST),
        embeddingDimensions: this.providers.embeddingDimensions(),
      },
    };
  }

  /**
   * Replace the settings row. A PUT, because the whole policy is replaced.
   *
   * Updated, never inserted repeatedly: there is one row per institution and a unique index
   * says so, which is what stops two half-configured policies existing at once.
   */
  async putSettings(principal: Principal, institutionId: string, input: PutAiSettingsInput) {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(aiProviderSettings)
        .where(eq(aiProviderSettings.institutionId, institutionId))
        .limit(1);

      const values = {
        defaultProvider: input.defaultProvider,
        taskRouting: input.taskRouting as Record<string, string>,
        defaultMonthlyTokenLimit: input.defaultMonthlyTokenLimit ?? null,
        defaultMonthlyCostLimit: input.defaultMonthlyCostLimit ?? null,
        defaultHardStop: input.defaultHardStop,
        tutoringEnabledForStudents: input.tutoringEnabledForStudents,
        currency: input.currency ?? existing?.currency ?? DEFAULT_AI_SETTINGS.currency,
        updatedBy: principal.userId,
      };

      let row: SettingsRow;
      if (existing) {
        const [updated] = await tx
          .update(aiProviderSettings)
          .set({ ...values, version: existing.version + 1 })
          .where(eq(aiProviderSettings.id, existing.id))
          .returning();
        row = updated!;
      } else {
        const [created] = await tx
          .insert(aiProviderSettings)
          .values({
            id: uuidv7(),
            tenantId: principal.tenantId!,
            institutionId,
            ...values,
            createdBy: principal.userId,
          })
          .returning();
        row = created!;
      }

      return {
        settings: row,
        previous: existing
          ? {
              defaultProvider: existing.defaultProvider,
              taskRouting: existing.taskRouting,
              defaultMonthlyTokenLimit: existing.defaultMonthlyTokenLimit,
              defaultMonthlyCostLimit: existing.defaultMonthlyCostLimit,
              defaultHardStop: existing.defaultHardStop,
              tutoringEnabledForStudents: existing.tutoringEnabledForStudents,
              currency: existing.currency,
            }
          : null,
      };
    });
  }

  /**
   * Is AI tutoring switched on for students at this institution?
   *
   * Read by the tutor surface before it will answer a student. Fails closed: an institution
   * that has never saved settings has tutoring off, because turning an AI loose on children
   * is a decision a school makes deliberately rather than one it inherits from a default.
   */
  async isTutoringEnabled(institutionId: string): Promise<boolean> {
    return this.db.runInTenant(async (tx) => {
      const [row] = await tx
        .select({ enabled: aiProviderSettings.tutoringEnabledForStudents })
        .from(aiProviderSettings)
        .where(eq(aiProviderSettings.institutionId, institutionId))
        .limit(1);
      return row?.enabled ?? false;
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────────

  /**
   * The exact four-decimal total, expressed in settlement currency for display.
   *
   * `null` when the configured currency is one `Money` does not model — reported rather than
   * approximated, because a wrong currency is worse than an absent one. The exact figure is
   * always present beside it and remains the authority.
   */
  private presentAsCurrency(cost: string, currency: string): string | null {
    if (!isSupportedCurrency(currency)) return null;
    return roundToCurrency(cost, currency as CurrencyCode).toDecimalString();
  }

  private async currencyOf(tx: Tx, institutionId: string): Promise<string> {
    const [row] = await tx
      .select({ currency: aiProviderSettings.currency })
      .from(aiProviderSettings)
      .where(eq(aiProviderSettings.institutionId, institutionId))
      .limit(1);
    return row?.currency ?? DEFAULT_AI_SETTINGS.currency;
  }

  /**
   * May this principal see somebody else's usage attribution?
   *
   * `ai.usage.view` answers "may you see the spend"; it does not answer "whose". A user who
   * holds it without `ai.settings.manage` is shown their own attribution only, which is the
   * same fail-closed rule the conversation service applies to transcripts.
   */
  scopeUsageQuery(principal: Principal, query: ListAiUsageInput): ListAiUsageInput {
    if (can(principal, 'ai.settings.manage')) return query;
    return { ...query, userId: principal.userId };
  }

  /** Attach the audit context every AI-initiated write shares. */
  auditContext() {
    const context = currentContext();
    return {
      requestId: context?.requestId ?? null,
      ipAddress: context?.ipAddress ?? null,
      userAgent: context?.userAgent ?? null,
    };
  }

  /** Exposed so a caller can present a total the way this service does. */
  toCurrency(cost: string, currency: string): string | null {
    return this.presentAsCurrency(cost, currency);
  }
}
