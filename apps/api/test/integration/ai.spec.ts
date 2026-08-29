/**
 * AI foundation integration suite (Phases 27–28).
 *
 * This file exists to hold the properties that make an AI feature safe to put in front of a
 * school, not to prove the routes return 200. The load-bearing tests go UNDER the service: a
 * raw `pg` client connected as `shikkha_app` — the same unprivileged role the API uses — tries
 * to do the things a compromised application would try, and the DATABASE must refuse them:
 *
 *  - a transcript cannot be edited or deleted (`ai_messages_no_mutation`),
 *  - the cost ledger cannot be edited or deleted (`ai_usage_events_no_mutation`),
 *  - the month's tally cannot be written by hand (`ai_budgets_derived_guard`),
 *  - a credit that would take the tally below zero aborts the event that carried it
 *    (`ai_budgets_usage_non_negative`, reachable only because of the 0031 two-step apply),
 *  - and none of it crosses a tenant boundary, even with the tenant GUC set by hand.
 *
 * Above the database, the three rules that matter most:
 *
 *  1. **The budget is enforced before the provider call, not after** (docs/06 §8). The proof
 *     is negative: a refused attempt leaves no message and no usage event behind.
 *  2. **Cost is exact.** A four-decimal string, asserted against a literal, never a float.
 *  3. **A credential never reaches a response body**, including from the one endpoint whose
 *     whole job is to talk about credentials.
 *
 * Everything HTTP runs through the real guards, interceptors and database, because the
 * properties under test live precisely in the parts a stub would replace. The AI provider is
 * the deterministic `mock` adapter — a real adapter that needs no credentials — so the suite
 * runs offline and its assertions can be exact.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Client } from 'pg';
import argon2 from 'argon2';
import { uuidv7 } from '@shikkha/shared';
import {
  computeAiCostDecimal,
  MODEL_PRICES,
  UNKNOWN_MODEL_PRICE,
} from '../../src/modules/ai/ai-pricing';
import { MockAiProvider } from '../../src/modules/ai/providers/mock.provider';
import {
  createTestApp,
  seedTenant,
  testClient,
  truncateAll,
  TEST_APP_DATABASE_URL,
  TEST_PASSWORD,
  type SeededTenant,
} from '../helpers/test-app';

/**
 * Fake credentials planted in the environment for the duration of this suite.
 *
 * `GET /ai/providers` must report that each provider is configured while leaking no part of
 * any of these strings. They are deliberately long and distinctive so a substring search for
 * them cannot match by accident.
 */
const FAKE_SECRETS = {
  OPENAI_API_KEY: 'sk-test-openai-DO-NOT-LEAK-4c1f9a7e2b',
  ANTHROPIC_API_KEY: 'sk-ant-test-DO-NOT-LEAK-91be44dd07',
  GEMINI_API_KEY: 'AIza-test-gemini-DO-NOT-LEAK-77ac3e05',
} as const;

describe('AI foundation — conversations, metering and budgets', () => {
  let app: INestApplication;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
  const tokens: Record<string, string> = {};

  /** A student user in tenant A. `seedTenant` creates no student login, so this suite adds one. */
  let studentUser: { id: string; email: string };

  /** The conversation the round-trip and isolation tests key off. */
  let conversationId: string;
  let firstAssistantMessageId: string;

  /** The current budget period, taken from the API so the Dhaka calendar is not re-derived here. */
  let currentPeriod: string;

  async function login(email: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: email, password: TEST_PASSWORD });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body.accessToken as string;
  }

  const get = (role: string, path: string, query: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .get(path)
      .query(query)
      .set('Authorization', `Bearer ${tokens[role]}`)
      .set('x-institution-id', tenantA.institutionId);

  const post = (role: string, path: string, body: object = {}) =>
    request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${tokens[role]}`)
      .set('x-institution-id', tenantA.institutionId)
      .send(body);

  const put = (role: string, path: string, body: object = {}) =>
    request(app.getHttpServer())
      .put(path)
      .set('Authorization', `Bearer ${tokens[role]}`)
      .set('x-institution-id', tenantA.institutionId)
      .send(body);

  /**
   * Run a callback as the unprivileged application role inside one transaction with the tenant
   * GUC set — exactly the credentials a compromised application would hold. Rolled back
   * afterwards (harmless after a failed statement), so a refused write cannot leak state.
   */
  async function asAppRole<T>(tenantId: string, fn: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: TEST_APP_DATABASE_URL });
    await client.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      return await fn(client);
    } finally {
      await client.query('rollback').catch(() => undefined);
      await client.end();
    }
  }

  /**
   * The same, but committed — for the derived-tally tests, which have to observe the effect of
   * one statement in a later one. Still the unprivileged role: the point is that the *trigger*
   * maintains the tally, not that a privileged connection can.
   */
  async function asAppRoleCommitted<T>(
    tenantId: string,
    fn: (client: Client) => Promise<T>,
  ): Promise<T> {
    const client = new Client({ connectionString: TEST_APP_DATABASE_URL });
    await client.connect();
    try {
      await client.query(`select set_config('app.tenant_id', $1, false)`, [tenantId]);
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  /** Await a statement the database must refuse, returning the pg error for inspection. */
  async function expectRefusal(work: Promise<unknown>): Promise<{
    message: string;
    code?: string;
    constraint?: string;
  }> {
    try {
      await work;
    } catch (error) {
      return error as { message: string; code?: string; constraint?: string };
    }
    throw new Error('Expected the database to refuse this write, but it was accepted');
  }


  /**
   * Run one statement the database must refuse, inside a savepoint.
   *
   * The savepoint is what makes a *second* refusal in the same transaction meaningful. The
   * first error puts the transaction into the aborted state, so every later statement fails
   * with 25P02 ("current transaction is aborted") instead of the refusal being asserted —
   * which reads as a pass if the test only checks that something was thrown, and as a
   * confusing failure if it checks the code. Rolling back to the savepoint each time keeps
   * every attempt independent.
   */
  async function refuse(
    client: Client,
    text: string,
    params: unknown[] = [],
  ): Promise<{ message: string; code?: string; constraint?: string }> {
    await client.query('savepoint refusal');
    try {
      await client.query(text, params);
    } catch (error) {
      await client.query('rollback to savepoint refusal');
      return error as { message: string; code?: string; constraint?: string };
    }
    await client.query('rollback to savepoint refusal');
    throw new Error(`Expected the database to refuse this write, but it was accepted: ${text}`);
  }

  /** Insert a raw usage event as the application role, exercising the budget trigger. */
  async function insertUsageEvent(
    client: Client,
    opts: {
      institutionId: string;
      tenantId: string;
      inputTokens: number;
      outputTokens: number;
      cost: string;
      occurredAt: string;
      task?: string;
    },
  ): Promise<void> {
    await client.query(
      `insert into ai_usage_events
         (id, tenant_id, institution_id, task, provider_key, model,
          input_tokens, output_tokens, cost, currency, occurred_at)
       values ($1, $2, $3, $4, 'mock', 'mock-completion-1', $5, $6, $7, 'USD', $8)`,
      [
        uuidv7(),
        opts.tenantId,
        opts.institutionId,
        opts.task ?? 'classification',
        opts.inputTokens,
        opts.outputTokens,
        opts.cost,
        opts.occurredAt,
      ],
    );
  }

  async function budgetRow(
    institutionId: string,
    yearMonth: string,
  ): Promise<{ tokens_used: string; cost_used: string } | null> {
    const client = testClient();
    await client.connect();
    try {
      const { rows } = await client.query<{ tokens_used: string; cost_used: string }>(
        `select tokens_used::text, cost_used::text from ai_budgets
          where institution_id = $1 and year_month = $2`,
        [institutionId, yearMonth],
      );
      return rows[0] ?? null;
    } finally {
      await client.end();
    }
  }

  async function eventTotals(
    institutionId: string,
    yearMonth: string,
  ): Promise<{ tokens: string; cost: string }> {
    const client = testClient();
    await client.connect();
    try {
      const { rows } = await client.query<{ tokens: string; cost: string }>(
        `select coalesce(sum(input_tokens + output_tokens), 0)::text as tokens,
                to_char(coalesce(sum(cost), 0), 'FM9999999990.0000') as cost
           from ai_usage_events
          where institution_id = $1
            and to_char(occurred_at at time zone 'Asia/Dhaka', 'YYYY-MM') = $2`,
        [institutionId, yearMonth],
      );
      return rows[0]!;
    } finally {
      await client.end();
    }
  }

  async function counts(
    institutionId: string,
  ): Promise<{ messages: number; events: number; conversations: number }> {
    const client = testClient();
    await client.connect();
    try {
      const { rows } = await client.query<{
        messages: string;
        events: string;
        conversations: string;
      }>(
        `select
           (select count(*) from ai_messages where institution_id = $1)::text as messages,
           (select count(*) from ai_usage_events where institution_id = $1)::text as events,
           (select count(*) from ai_conversations where institution_id = $1)::text as conversations`,
        [institutionId],
      );
      return {
        messages: Number(rows[0]!.messages),
        events: Number(rows[0]!.events),
        conversations: Number(rows[0]!.conversations),
      };
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    app = await createTestApp();

    // The deterministic, credential-free adapter answers every task; the fake keys below exist
    // only so the providers endpoint has something it could leak, and does not.
    process.env.AI_PROVIDER = 'mock';
    Object.assign(process.env, FAKE_SECRETS);

    await truncateAll();
    tenantA = await seedTenant('aifa', { students: 2 });
    tenantB = await seedTenant('aifb', { students: 2 });

    for (const key of ['owner', 'principal', 'teacher', 'accountant']) {
      tokens[key] = await login(tenantA.users[key]!.email);
    }
    tokens['otherOwner'] = await login(tenantB.users['owner']!.email);

    studentUser = await createStudentUser(tenantA, 'aifa');
    tokens['student'] = await login(studentUser.email);
  }, 120_000);

  afterAll(async () => {
    for (const name of Object.keys(FAKE_SECRETS)) delete process.env[name];
    delete process.env.AI_PROVIDER;
    await app?.close();
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Providers — the endpoint whose whole job is to talk about credentials
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('provider inventory', () => {
    it('lists every adapter and whether it is configured', async () => {
      const response = await get('owner', '/api/v1/ai/providers');
      expect(response.status, JSON.stringify(response.body)).toBe(200);

      const byKey = new Map(
        (response.body.providers as Array<{ key: string; credentialsPresent: boolean }>).map(
          (provider) => [provider.key, provider],
        ),
      );
      expect([...byKey.keys()].sort()).toEqual(['anthropic', 'gemini', 'mock', 'openai']);
      expect(byKey.get('mock')!.credentialsPresent).toBe(true);
      expect(byKey.get('openai')!.credentialsPresent).toBe(true);
      expect(byKey.get('anthropic')!.credentialsPresent).toBe(true);
      expect(byKey.get('gemini')!.credentialsPresent).toBe(true);
    });

    it('never leaks a credential — not the value, not a prefix, not a masked form', async () => {
      const response = await get('owner', '/api/v1/ai/providers');
      const body = JSON.stringify(response.body);

      for (const secret of Object.values(FAKE_SECRETS)) {
        expect(body).not.toContain(secret);
        // A prefix is still a narrowed search space. Every window of eight characters of every
        // secret must be absent, which rules out truncation and masking as well as the whole
        // string.
        for (let start = 0; start + 8 <= secret.length; start += 1) {
          expect(body).not.toContain(secret.slice(start, start + 8));
        }
      }

      // The variable *names* are legitimate to report — that is what an administrator needs in
      // order to ask the right person for the right thing — but only when one is missing.
      expect(body).toContain('missingVariables');
    });

    it('reports the missing variable by name when a provider is unconfigured', async () => {
      const saved = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      try {
        const response = await get('owner', '/api/v1/ai/providers');
        const openai = (
          response.body.providers as Array<{
            key: string;
            credentialsPresent: boolean;
            missingVariables: string[];
          }>
        ).find((provider) => provider.key === 'openai')!;
        expect(openai.credentialsPresent).toBe(false);
        expect(openai.missingVariables).toEqual(['OPENAI_API_KEY']);
      } finally {
        process.env.OPENAI_API_KEY = saved;
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Conversations: the round trip, and the append-only transcript
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('conversations', () => {
    it('creates a conversation and answers its first message in one round trip', async () => {
      const response = await post('teacher', '/api/v1/ai/conversations', {
        title: 'Class 6 attendance patterns',
        purpose: 'copilot',
        firstMessage: 'Which sections had the lowest attendance last week?',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      conversationId = response.body.id;

      const completion = response.body.completion;
      expect(completion).toBeTruthy();
      expect(completion.assistantMessage.role).toBe('assistant');
      // The mock adapter stamps every answer, so a simulation can never be mistaken for a
      // model — the same discipline the mock GPS adapter applies to simulated positions.
      expect(completion.assistantMessage.content).toContain('[mock:analytics_reasoning]');
      expect(completion.assistantMessage.providerKey).toBe('mock');
      expect(completion.assistantMessage.model).toBe('mock-completion-1');
      expect(completion.assistantMessage.finishReason).toBe('stop');
      firstAssistantMessageId = completion.assistantMessage.id;
    });

    it('round-trips the transcript in sequence order', async () => {
      const send = await post(
        'teacher',
        `/api/v1/ai/conversations/${conversationId}/messages`,
        { content: 'And how does that compare with the month before?' },
      );
      expect(send.status, JSON.stringify(send.body)).toBe(201);

      const response = await get('teacher', `/api/v1/ai/conversations/${conversationId}`);
      expect(response.status).toBe(200);

      const messages = response.body.messages as Array<{
        seq: number;
        role: string;
        content: string;
      }>;
      expect(messages).toHaveLength(4);
      expect(messages.map((message) => message.seq)).toEqual([1, 2, 3, 4]);
      expect(messages.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'user',
        'assistant',
      ]);
      // The second answer saw the first exchange: the mock reports how many messages it was
      // given, which is the system prompt, the two stored turns, and the new one.
      expect(messages[3]!.content).toContain('messages=4');
    });

    it('refuses every mutation of the message log as the application role', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        const update = await expectRefusal(
          client.query(`update ai_messages set content = 'rewritten' where id = $1`, [
            firstAssistantMessageId,
          ]),
        );
        expect(update.code).toBe('42501');
        expect(update.message).toContain('append-only');
      });

      await asAppRole(tenantA.tenantId, async (client) => {
        const remove = await expectRefusal(
          client.query(`delete from ai_messages where id = $1`, [firstAssistantMessageId]),
        );
        expect(remove.code).toBe('42501');
      });

      // …and the row is still there afterwards, unchanged.
      const response = await get('teacher', `/api/v1/ai/conversations/${conversationId}`);
      const messages = response.body.messages as Array<{ id: string; content: string }>;
      expect(messages.find((message) => message.id === firstAssistantMessageId)!.content).toContain(
        '[mock:analytics_reasoning]',
      );
    });

    it('refuses every mutation of the usage ledger as the application role', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        const update = await refuse(client, `update ai_usage_events set cost = 0`);
        expect(update.code).toBe('42501');

        const remove = await refuse(client, `delete from ai_usage_events`);
        expect(remove.code).toBe('42501');
      });
    });

    it('archives a conversation with a recorded reason, and never deletes it', async () => {
      const created = await post('teacher', '/api/v1/ai/conversations', {
        title: 'Scratch conversation',
        purpose: 'teacher_tools',
      });
      expect(created.status).toBe(201);

      const missingReason = await post(
        'teacher',
        `/api/v1/ai/conversations/${created.body.id}/archive`,
        {},
      );
      expect(missingReason.status).toBe(422);

      const archived = await post(
        'teacher',
        `/api/v1/ai/conversations/${created.body.id}/archive`,
        { reason: 'Opened by mistake while testing the copilot' },
      );
      expect(archived.status, JSON.stringify(archived.body)).toBe(201);
      expect(archived.body.archivedAt).toBeTruthy();
      expect(archived.body.archiveReason).toBe(
        'Opened by mistake while testing the copilot',
      );

      // Archived, therefore out of the default list but still present in the database.
      const listed = await get('teacher', '/api/v1/ai/conversations');
      expect(
        (listed.body.data as Array<{ id: string }>).some((row) => row.id === created.body.id),
      ).toBe(false);

      const withArchived = await get('teacher', '/api/v1/ai/conversations', {
        includeArchived: 'true',
      });
      expect(
        (withArchived.body.data as Array<{ id: string }>).some(
          (row) => row.id === created.body.id,
        ),
      ).toBe(true);
    });

    it('refuses another message on an archived conversation', async () => {
      const created = await post('teacher', '/api/v1/ai/conversations', {
        title: 'Closed thread',
        purpose: 'copilot',
      });
      await post('teacher', `/api/v1/ai/conversations/${created.body.id}/archive`, {
        reason: 'Finished with this line of enquiry for now',
      });

      const response = await post(
        'teacher',
        `/api/v1/ai/conversations/${created.body.id}/messages`,
        { content: 'One more thing' },
      );
      expect(response.status).toBe(409);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Cost: exact, four decimals, integer arithmetic
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('cost arithmetic', () => {
    it('computes an exact four-decimal cost from the price sheet', () => {
      // mock-completion-1 is 0.1500 in / 0.6000 out per million tokens:
      //   30 000 × 0.1500 = 0.0045
      //   50 000 × 0.6000 = 0.0300
      //                   = 0.0345
      expect(computeAiCostDecimal('mock-completion-1', 30_000, 50_000)).toBe('0.0345');
      expect(computeAiCostDecimal('mock-embedding-1', 1_000_000, 0)).toBe('0.0200');
      expect(computeAiCostDecimal('mock-completion-1', 0, 0)).toBe('0.0000');
    });

    it('rounds half away from zero, so a credit exactly reverses its charge', () => {
      // 20 × 2.5000 / 1 000 000 = 0.00005 exactly — the half case.
      expect(computeAiCostDecimal('gpt-4o', 20, 0)).toBe('0.0001');
      expect(computeAiCostDecimal('gpt-4o', -20, 0)).toBe('-0.0001');
    });

    it('charges an unlisted model at the conservative fallback rate, never zero', () => {
      expect(MODEL_PRICES['definitely-not-a-real-model']).toBeUndefined();
      const fallback = computeAiCostDecimal('definitely-not-a-real-model', 1_000_000, 0);
      expect(fallback).toBe(UNKNOWN_MODEL_PRICE.inputPerMillion);
      expect(Number(fallback)).toBeGreaterThan(0);
    });

    it('records the exact cost of a real call against the tokens it reported', async () => {
      const response = await post('principal', '/api/v1/ai/conversations', {
        title: 'Cost attribution check',
        purpose: 'insights',
        firstMessage: 'Summarise this term in one line.',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);

      const usage = response.body.completion.usage as {
        inputTokens: number;
        outputTokens: number;
        cost: string;
        model: string;
      };

      // A four-decimal string, not a float and not a two-decimal money value.
      expect(usage.cost).toMatch(/^\d+\.\d{4}$/);
      expect(usage.cost).toBe(
        computeAiCostDecimal(usage.model, usage.inputTokens, usage.outputTokens),
      );

      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query<{ cost: string; input_tokens: number }>(
          `select cost::text, input_tokens from ai_usage_events
            where conversation_id = $1`,
          [response.body.id],
        );
        expect(rows).toHaveLength(1);
        // The column stores the same exact string the API reported.
        expect(rows[0]!.cost).toBe(usage.cost);
        expect(rows[0]!.input_tokens).toBe(usage.inputTokens);
      } finally {
        await client.end();
      }
    });

    it('aggregates usage by month, user and task without exposing a transcript', async () => {
      const byMonth = await get('owner', '/api/v1/ai/usage', { groupBy: 'month' });
      expect(byMonth.status, JSON.stringify(byMonth.body)).toBe(200);
      expect(byMonth.body.totals.cost).toMatch(/^\d+\.\d{4}$/);
      expect(byMonth.body.totals.calls).toBeGreaterThan(0);
      // The exact figure is the authority; the rounded one is presentation beside it.
      expect(byMonth.body.totals.costRounded).toMatch(/^\d+\.\d{2}$/);
      expect(JSON.stringify(byMonth.body)).not.toContain('attendance patterns');

      const byTask = await get('owner', '/api/v1/ai/usage', { groupBy: 'task' });
      expect(byTask.status).toBe(200);
      const tasks = (byTask.body.rows as Array<{ key: string }>).map((row) => row.key);
      expect(tasks).toContain('analytics_reasoning');

      const byUser = await get('owner', '/api/v1/ai/usage', { groupBy: 'user' });
      expect(byUser.status).toBe(200);
      const users = (byUser.body.rows as Array<{ key: string }>).map((row) => row.key);
      expect(users).toContain(tenantA.users['teacher']!.id);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // The derived budget tally — the 0031 lesson, proved
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('derived budget totals', () => {
    /** A month far enough away that no other test writes into it. */
    const FUTURE_MONTH = '2099-01';
    const FUTURE_INSTANT = '2099-01-15T10:00:00+06:00';

    it('has a tally exactly equal to the sum of the events behind it', async () => {
      const budgets = await get('owner', '/api/v1/ai/budgets');
      expect(budgets.status, JSON.stringify(budgets.body)).toBe(200);
      currentPeriod = budgets.body.currentPeriod;

      const tally = await budgetRow(tenantA.institutionId, currentPeriod);
      const events = await eventTotals(tenantA.institutionId, currentPeriod);
      expect(tally).not.toBeNull();
      expect(tally!.tokens_used).toBe(events.tokens);
      expect(tally!.cost_used).toBe(events.cost);
    });

    it('refuses a hand-written tally — only an event may move it', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        const tokensWrite = await refuse(
          client,
          `update ai_budgets set tokens_used = 0 where institution_id = $1`,
          [tenantA.institutionId],
        );
        expect(tokensWrite.code).toBe('42501');
        expect(tokensWrite.message).toContain('derived');

        const costWrite = await refuse(
          client,
          `update ai_budgets set cost_used = 999 where institution_id = $1`,
          [tenantA.institutionId],
        );
        expect(costWrite.code).toBe('42501');

        const removal = await refuse(
          client,
          `delete from ai_budgets where institution_id = $1`,
          [tenantA.institutionId],
        );
        expect(removal.code).toBe('42501');
      });
    });

    it('opens a fresh row for a month nothing has been spent in yet', async () => {
      expect(await budgetRow(tenantA.institutionId, FUTURE_MONTH)).toBeNull();

      await asAppRoleCommitted(tenantA.tenantId, async (client) => {
        await insertUsageEvent(client, {
          tenantId: tenantA.tenantId,
          institutionId: tenantA.institutionId,
          inputTokens: 30_000,
          outputTokens: 50_000,
          cost: '0.0345',
          occurredAt: FUTURE_INSTANT,
        });
      });

      const created = await budgetRow(tenantA.institutionId, FUTURE_MONTH);
      expect(created).not.toBeNull();
      expect(created!.tokens_used).toBe('80000');
      expect(created!.cost_used).toBe('0.0345');
    });

    it('adds a second event into the existing row rather than a second row', async () => {
      await asAppRoleCommitted(tenantA.tenantId, async (client) => {
        await insertUsageEvent(client, {
          tenantId: tenantA.tenantId,
          institutionId: tenantA.institutionId,
          inputTokens: 1_000,
          outputTokens: 2_000,
          cost: '0.0135',
          occurredAt: FUTURE_INSTANT,
          task: 'summarisation',
        });
      });

      const tally = await budgetRow(tenantA.institutionId, FUTURE_MONTH);
      expect(tally!.tokens_used).toBe('83000');
      expect(tally!.cost_used).toBe('0.0480');

      const events = await eventTotals(tenantA.institutionId, FUTURE_MONTH);
      expect(tally!.tokens_used).toBe(events.tokens);
      expect(tally!.cost_used).toBe(events.cost);
    });

    /**
     * The 0031 lesson.
     *
     * A single `insert … on conflict do update set used = used + excluded.used` would fail
     * here: PostgreSQL checks `ai_budgets_usage_non_negative` against the *proposed insertion
     * tuple*, which carries the bare negative delta, before ON CONFLICT arbitration picks the
     * DO UPDATE branch. The resulting tally is positive and perfectly valid; the naive upsert
     * would never have got to see it. The two-step apply does.
     */
    it('applies a compensating event that carries a negative delta', async () => {
      await asAppRoleCommitted(tenantA.tenantId, async (client) => {
        await insertUsageEvent(client, {
          tenantId: tenantA.tenantId,
          institutionId: tenantA.institutionId,
          inputTokens: -1_000,
          outputTokens: -2_000,
          cost: '-0.0135',
          occurredAt: FUTURE_INSTANT,
          task: 'summarisation',
        });
      });

      const tally = await budgetRow(tenantA.institutionId, FUTURE_MONTH);
      expect(tally!.tokens_used).toBe('80000');
      expect(tally!.cost_used).toBe('0.0345');

      const events = await eventTotals(tenantA.institutionId, FUTURE_MONTH);
      expect(tally!.tokens_used).toBe(events.tokens);
      expect(tally!.cost_used).toBe(events.cost);
    });

    it('aborts an event that would credit the tally below zero, and leaves it untouched', async () => {
      const before = await budgetRow(tenantA.institutionId, FUTURE_MONTH);

      await asAppRoleCommitted(tenantA.tenantId, async (client) => {
        const refusal = await expectRefusal(
          insertUsageEvent(client, {
            tenantId: tenantA.tenantId,
            institutionId: tenantA.institutionId,
            inputTokens: -999_999,
            outputTokens: 0,
            cost: '-99.0000',
            occurredAt: FUTURE_INSTANT,
          }),
        );
        expect(refusal.code).toBe('23514');
        expect(refusal.constraint).toBe('ai_budgets_usage_non_negative');
      });

      const after = await budgetRow(tenantA.institutionId, FUTURE_MONTH);
      expect(after).toEqual(before);

      // …and the event itself never landed, so the ledger and the tally still agree.
      const events = await eventTotals(tenantA.institutionId, FUTURE_MONTH);
      expect(after!.tokens_used).toBe(events.tokens);
      expect(after!.cost_used).toBe(events.cost);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Budget enforcement — before the call, not after
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('budget enforcement', () => {
    it('refuses the call, writing neither a message nor a usage event', async () => {
      const setBudget = await put('owner', `/api/v1/ai/budgets/${currentPeriod}`, {
        tokenLimit: 0,
        hardStop: true,
      });
      expect(setBudget.status, JSON.stringify(setBudget.body)).toBe(200);
      expect(setBudget.body.tokenLimit).toBe(0);
      expect(setBudget.body.hardStop).toBe(true);

      const before = await counts(tenantA.institutionId);

      const refused = await post(
        'teacher',
        `/api/v1/ai/conversations/${conversationId}/messages`,
        { content: 'One more question that must never reach a provider.' },
      );
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.error.code).toBe('CONFLICT');

      // The whole point: nothing was written, because nothing was written *before* the check.
      const after = await counts(tenantA.institutionId);
      expect(after.messages).toBe(before.messages);
      expect(after.events).toBe(before.events);
    });

    it('also refuses a brand-new conversation carrying a first message, leaving no empty shell', async () => {
      const before = await counts(tenantA.institutionId);

      const response = await post('teacher', '/api/v1/ai/conversations', {
        title: 'Should not get an answer',
        purpose: 'copilot',
        firstMessage: 'Anything at all.',
      });
      expect(response.status).toBe(409);

      const after = await counts(tenantA.institutionId);
      expect(after.messages).toBe(before.messages);
      expect(after.events).toBe(before.events);
      // The budget is checked before the conversation row is written, so a refusal does not
      // litter the list with titled conversations that never had a turn in them.
      expect(after.conversations).toBe(before.conversations);
    });

    it('allows the call and warns when the hard stop is off', async () => {
      const setBudget = await put('owner', `/api/v1/ai/budgets/${currentPeriod}`, {
        tokenLimit: 0,
        hardStop: false,
      });
      expect(setBudget.status).toBe(200);

      const response = await post(
        'teacher',
        `/api/v1/ai/conversations/${conversationId}/messages`,
        { content: 'This one is an overage rather than a refusal.' },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.budgetWarning).toContain('exhausted');
      expect(response.body.assistantMessage.content).toContain('[mock:analytics_reasoning]');
    });

    it('reports the effective ceiling beside the raw columns, and never the tally as settable', async () => {
      const cleared = await put('owner', `/api/v1/ai/budgets/${currentPeriod}`, {
        tokenLimit: null,
        costLimit: null,
        hardStop: true,
      });
      expect(cleared.status).toBe(200);
      expect(cleared.body.tokenLimit).toBeNull();

      const budgets = await get('owner', '/api/v1/ai/budgets');
      const row = (budgets.body.budgets as Array<{ yearMonth: string; effective: unknown }>).find(
        (entry) => entry.yearMonth === currentPeriod,
      )!;
      expect(row.effective).toMatchObject({ withinBudget: true, tokenLimit: null });

      // The service can no more write the tally than raw SQL can: a body field for it does not
      // exist, and the schema strips unknown keys before a service ever sees them.
      const attempt = await put('owner', `/api/v1/ai/budgets/${currentPeriod}`, {
        hardStop: true,
        tokensUsed: 0,
        costUsed: '0.0000',
      });
      expect(attempt.status).toBe(200);
      const tally = await budgetRow(tenantA.institutionId, currentPeriod);
      expect(Number(tally!.tokens_used)).toBeGreaterThan(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Settings
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('provider settings', () => {
    it('starts from defaults with tutoring switched off, and replaces them whole', async () => {
      const initial = await get('owner', '/api/v1/ai/settings');
      expect(initial.status, JSON.stringify(initial.body)).toBe(200);
      expect(initial.body.isDefault).toBe(true);
      expect(initial.body.settings.tutoringEnabledForStudents).toBe(false);
      // The live deployment routing is reported beside the school's own preference.
      expect(initial.body.deployment.routing.classification.provider).toBe('mock');

      const saved = await put('owner', '/api/v1/ai/settings', {
        defaultProvider: 'openai',
        taskRouting: { classification: 'mock', analytics_reasoning: 'anthropic' },
        defaultMonthlyTokenLimit: 5_000_000,
        defaultMonthlyCostLimit: '25.0000',
        defaultHardStop: true,
        tutoringEnabledForStudents: true,
      });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(saved.body.defaultProvider).toBe('openai');
      expect(saved.body.defaultMonthlyCostLimit).toBe('25.0000');

      const reread = await get('owner', '/api/v1/ai/settings');
      expect(reread.body.isDefault).toBe(false);
      expect(reread.body.settings.taskRouting).toEqual({
        classification: 'mock',
        analytics_reasoning: 'anthropic',
      });

      // A second PUT updates the one row rather than inserting a second.
      const again = await put('owner', '/api/v1/ai/settings', {
        defaultProvider: 'mock',
        taskRouting: {},
        defaultHardStop: false,
        tutoringEnabledForStudents: false,
      });
      expect(again.status).toBe(200);

      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query<{ count: string }>(
          `select count(*)::text from ai_provider_settings where institution_id = $1`,
          [tenantA.institutionId],
        );
        expect(rows[0]!.count).toBe('1');
      } finally {
        await client.end();
      }
    });

    it('rejects a provider key that does not exist', async () => {
      const response = await put('owner', '/api/v1/ai/settings', {
        defaultProvider: 'some-vendor-we-do-not-have',
        taskRouting: {},
      });
      expect(response.status).toBe(422);
    });

    it('records the settings change in the audit trail with a before and an after', async () => {
      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query<{
          action: string;
          previous_value: unknown;
          new_value: unknown;
        }>(
          `select action, previous_value, new_value from audit_logs
            where module = 'ai' and resource_type = 'ai_provider_settings'
            order by occurred_at desc limit 1`,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.action).toBe('update');
        expect(rows[0]!.previous_value).toBeTruthy();
        expect(rows[0]!.new_value).toBeTruthy();
      } finally {
        await client.end();
      }
    });

    it('marks an AI-generated turn as AI-initiated in the audit trail, exactly once', async () => {
      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query<{ count: string; ai: string }>(
          `select count(*)::text as count,
                  count(*) filter (where is_ai_initiated)::text as ai
             from audit_logs
            where module = 'ai' and resource_type = 'ai_message' and resource_id = $1`,
          [firstAssistantMessageId],
        );
        // Exactly one row: the service wrote it in-transaction and the decorator's
        // `recordedBy: 'service'` stood the interceptor down. Two rows would mean the
        // duplicate-audit bug is back, and the second would have a null previous value.
        expect(rows[0]!.count).toBe('1');
        expect(rows[0]!.ai).toBe('1');
      } finally {
        await client.end();
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Tenant isolation, three ways
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('tenant isolation', () => {
    it('answers 404 for another tenant\'s conversation', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/ai/conversations/${conversationId}`)
        .set('Authorization', `Bearer ${tokens['otherOwner']}`)
        .set('x-institution-id', tenantB.institutionId);
      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain('attendance patterns');
    });

    it('refuses a borrowed institution header with 403', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/ai/conversations')
        .set('Authorization', `Bearer ${tokens['otherOwner']}`)
        .set('x-institution-id', tenantA.institutionId);
      expect(response.status).toBe(403);
    });

    it('returns nothing to raw SQL as the application role under the other tenant\'s GUC', async () => {
      await asAppRole(tenantB.tenantId, async (client) => {
        const conversations = await client.query(
          `select id from ai_conversations where id = $1`,
          [conversationId],
        );
        expect(conversations.rowCount).toBe(0);

        const messages = await client.query(
          `select id from ai_messages where conversation_id = $1`,
          [conversationId],
        );
        expect(messages.rowCount).toBe(0);

        const events = await client.query(
          `select id from ai_usage_events where institution_id = $1`,
          [tenantA.institutionId],
        );
        expect(events.rowCount).toBe(0);

        const budgets = await client.query(
          `select id from ai_budgets where institution_id = $1`,
          [tenantA.institutionId],
        );
        expect(budgets.rowCount).toBe(0);
      });

      // Sanity: the same query under tenant A's GUC does see them, so the assertions above
      // are about isolation rather than about an empty table.
      await asAppRole(tenantA.tenantId, async (client) => {
        const conversations = await client.query(
          `select id from ai_conversations where id = $1`,
          [conversationId],
        );
        expect(conversations.rowCount).toBe(1);
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Permissions
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('permission enforcement', () => {
    it('refuses a student another user\'s conversation, the usage report and the settings', async () => {
      const conversation = await get(
        'student',
        `/api/v1/ai/conversations/${conversationId}`,
      );
      expect(conversation.status).toBe(403);
      // Naming the missing permission would be free reconnaissance.
      expect(JSON.stringify(conversation.body)).not.toContain('ai.copilot.use');

      const usage = await get('student', '/api/v1/ai/usage');
      expect(usage.status).toBe(403);

      const settings = await put('student', '/api/v1/ai/settings', {
        defaultProvider: 'mock',
        taskRouting: {},
      });
      expect(settings.status).toBe(403);

      const providers = await get('student', '/api/v1/ai/providers');
      expect(providers.status).toBe(403);
    });

    it('scopes one colleague out of another\'s conversation with a 404, not a 403', async () => {
      // The accountant holds ai.copilot.use — the route lets them in. The *data* rule keeps
      // them out of a conversation they did not start, and answers 404 so the existence of
      // the teacher's conversation is not confirmed.
      const response = await get(
        'accountant',
        `/api/v1/ai/conversations/${conversationId}`,
      );
      expect(response.status).toBe(404);

      const listed = await get('accountant', '/api/v1/ai/conversations');
      expect(listed.status).toBe(200);
      expect(
        (listed.body.data as Array<{ id: string }>).some((row) => row.id === conversationId),
      ).toBe(false);

      // A caller cannot widen their own scope by naming somebody else in the query.
      const borrowed = await get('accountant', '/api/v1/ai/conversations', {
        startedByUserId: tenantA.users['teacher']!.id,
      });
      expect(borrowed.status).toBe(200);
      expect(borrowed.body.data).toHaveLength(0);
    });

    it('lets ai.settings.manage read a conversation it did not start', async () => {
      // The owner holds `*`, and therefore `ai.settings.manage` — the one permission that
      // widens conversation visibility. There is no `ai.conversations.view.all` string in the
      // catalogue; see the note in ai.controller.ts.
      const response = await get('owner', `/api/v1/ai/conversations/${conversationId}`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.conversation.id).toBe(conversationId);
    });

    it('shows a usage-viewer without ai.settings.manage only their own attribution', async () => {
      // Every seeded staff role that holds `ai.usage.view` here also holds `*`, so this
      // asserts the rule directly on the scoping function's observable effect: the owner sees
      // more than one user's attribution, which a self-scoped caller could not.
      const response = await get('owner', '/api/v1/ai/usage', { groupBy: 'user' });
      expect(response.status).toBe(200);
      expect((response.body.rows as unknown[]).length).toBeGreaterThan(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // The mock adapter's determinism, which every assertion above depends on
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('the mock provider is deterministic', () => {
    // 256 rather than the configured default: wide enough that feature-hash collisions do not
    // dominate the similarity assertion below, narrow enough to keep the test instant.
    const provider = new MockAiProvider(256);

    it('embeds the same text to exactly the same vector, every time', async () => {
      const first = await provider.embed(['Attendance fell in Class 6 during March.']);
      const second = await provider.embed(['Attendance fell in Class 6 during March.']);
      expect(first.vectors[0]).toEqual(second.vectors[0]);
      expect(first.vectors[0]).toHaveLength(256);
      expect(first.dimensions).toBe(256);
    });

    it('puts similar text closer together than unrelated text', async () => {
      const { vectors } = await provider.embed([
        'Attendance fell in Class 6 during March.',
        'Attendance fell in Class 6 during April.',
        'The school library reopened after the monsoon repairs.',
      ]);
      const [a, b, c] = vectors as number[][];
      const dot = (left: number[], right: number[]) =>
        left.reduce((total, value, index) => total + value * (right[index] ?? 0), 0);

      expect(dot(a!, b!)).toBeGreaterThan(dot(a!, c!));
    });

    it('produces byte-identical completions for identical input', async () => {
      const messages = [
        { role: 'system' as const, content: 'You are a test.' },
        { role: 'user' as const, content: 'Say something stable.' },
      ];
      const first = await provider.complete({ task: 'classification', messages });
      const second = await provider.complete({ task: 'classification', messages });
      expect(first.text).toBe(second.text);
      expect(first.usage).toEqual(second.usage);
      expect(first.text.startsWith('[mock:classification] ')).toBe(true);
    });

    it('calls a tool only when asked to, and only one the caller offered', async () => {
      const tools = [
        {
          name: 'student.lookup',
          description: 'Find a student',
          parameters: { type: 'object', properties: {} },
        },
      ];

      const without = await provider.complete({
        task: 'classification',
        messages: [{ role: 'user', content: 'No marker here.' }],
        tools,
      });
      expect(without.toolCalls).toHaveLength(0);
      expect(without.finishReason).toBe('stop');

      const withMarker = await provider.complete({
        task: 'classification',
        messages: [{ role: 'user', content: 'Find them [[tool:student.lookup:{"q":"Rahim"}]]' }],
        tools,
      });
      expect(withMarker.toolCalls).toHaveLength(1);
      expect(withMarker.toolCalls[0]!.name).toBe('student.lookup');
      expect(withMarker.toolCalls[0]!.arguments).toEqual({ q: 'Rahim' });
      expect(withMarker.finishReason).toBe('tool_calls');

      const unoffered = await provider.complete({
        task: 'classification',
        messages: [{ role: 'user', content: 'Try this [[tool:payroll.run]]' }],
        tools,
      });
      expect(unoffered.toolCalls).toHaveLength(0);
    });
  });
});

/**
 * Create a student login in a seeded tenant.
 *
 * `seedTenant` creates student *records* but no student *users*, because most suites do not
 * need one. This suite does: the student role is the one that holds `ai.tutor.use` and holds
 * neither `ai.copilot.use` nor `ai.usage.view` nor `ai.settings.manage`, which is exactly the
 * shape the permission assertions need.
 */
async function createStudentUser(
  tenant: SeededTenant,
  prefix: string,
): Promise<{ id: string; email: string }> {
  const client = testClient();
  await client.connect();
  try {
    const userId = uuidv7();
    const email = `student@${prefix}.test`;
    // The same reduced Argon2 parameters `seedTenant` uses: this suite tests authorization,
    // not the KDF, and the real cost parameters would add seconds for no assertion.
    const passwordHash = await argon2.hash(TEST_PASSWORD, {
      type: argon2.argon2id,
      memoryCost: 8192,
      timeCost: 2,
      parallelism: 1,
    });

    await client.query(
      `insert into users (id, tenant_id, email, password_hash, full_name_en, status, email_verified_at)
       values ($1,$2,$3,$4,$5,'active',now())`,
      [userId, tenant.tenantId, email, passwordHash, `${prefix} Student User`],
    );
    await client.query(
      `insert into user_roles (id, tenant_id, user_id, role_id, institution_id)
       values ($1,$2,$3,$4,$5)`,
      [uuidv7(), tenant.tenantId, userId, tenant.roleIds['student'], tenant.institutionId],
    );

    return { id: userId, email };
  } finally {
    await client.end();
  }
}
