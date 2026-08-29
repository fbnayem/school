/**
 * The autonomy boundary (Phase 36, docs/06 §6, docs/16).
 *
 * A failure in this file is not a bug. It means a language model can change a child's grade,
 * approve an admission, decide a punishment, move money, or delete a record without a person
 * having looked at it. It belongs in the `security` project alongside `tenant-isolation` and
 * `rbac-enforcement`, and it blocks a release on its own.
 *
 * ── What is asserted, and why in this shape ────────────────────────────────────────────
 *
 * docs/06 §6 says: **AI suggests → human reviews → human confirms → system executes**, and
 * the confirmation is a normal permission-checked, audited API call made by the human. Every
 * case below is therefore driven **twice, with the same token and the same body**, and the
 * only difference between the two requests is one header:
 *
 *   with `x-ai-initiated`     → 403, a fixed refusal, no audit row, nothing created
 *   without it                → the action goes through, audited, `is_ai_initiated = false`
 *
 * Driving the identical request both ways is what makes this a test of a *boundary* rather
 * than of a blanket denial. If the guard simply refused everything, the second half of every
 * case would fail; if it refused nothing, the first half would.
 *
 * The guard under test is the real one, registered globally. Nothing here is mocked — mocking
 * the guard would leave exactly the thing being asserted unexercised.
 *
 * ── The attestation case ───────────────────────────────────────────────────────────────
 *
 * The last section asserts that **every** mutating route in the application that appears to
 * touch a forbidden resource is covered by the policy, by walking the live Nest router. The
 * ten cases below can only ever cover the routes somebody remembered to list. That test is
 * what catches the refund endpoint a later phase adds.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { addDays, dhakaWeekday, todayInDhaka, uuidv7, type CalendarDate } from '@shikkha/shared';
import { AppModule } from '../../src/app.module';
import { AiGovernanceModule } from '../../src/modules/ai-governance/ai-governance.module';
import { AI_AUTONOMY_REFUSAL_MESSAGE } from '../../src/modules/ai-governance/ai-autonomy.guard';
import { AI_INITIATION_HEADER } from '../../src/modules/ai-governance/ai-initiation';
import { FORBIDDEN_AUTONOMOUS_ACTIONS } from '../../src/modules/ai-governance/ai-autonomy.policy';
import {
  configureTestEnv,
  ensureTestDatabase,
  seedTenant,
  testClient,
  truncateAll,
  TEST_PASSWORD,
  type SeededTenant,
} from '../helpers/test-app';

/**
 * The most recent day the school was open.
 *
 * A register may not be opened in the future, on a weekend (Friday and Saturday, the seeded
 * year's default), on a calendar holiday (`seedTenant` creates none), or outside the academic
 * year — and every one of those is refused by the attendance service for reasons that have
 * nothing to do with this suite. Walking back from yesterday, skipping the weekend, is the
 * same approach `test/integration/attendance.spec.ts` takes, and for the same reason: a date
 * written as a literal makes the suite fail on two days in seven for the wrong reason.
 */
function mostRecentSchoolDay(): CalendarDate {
  let cursor: CalendarDate = addDays(todayInDhaka(), -1);
  while (dhakaWeekday(cursor) === 5 || dhakaWeekday(cursor) === 6) {
    cursor = addDays(cursor, -1);
  }
  return cursor;
}

interface BoundaryCase {
  /** The policy entry this route belongs to. Every entry must appear at least once. */
  key: string;
  method: 'post' | 'put' | 'patch' | 'delete';
  path: string;
  body: Record<string, unknown>;
  /** The seeded user who *may* do this. Never a user who could not — see the file header. */
  actor: string;
  /**
   * The status the human's identical request returns.
   *
   * `null` where the action needs fixtures this suite deliberately does not build (a real
   * invoice to refund, a calculated payroll run to disburse). Those cases still assert the AI
   * refusal and still assert the human is *not* refused by the autonomy boundary — the human
   * gets a 404 or a 422 from the module's own rules, which is proof the guard let them
   * through, and is the honest thing to claim rather than seeding half a finance ledger.
   */
  humanStatus: number | null;
}

describe('AI autonomy boundary — docs/06 §6', () => {
  let app: INestApplication;
  let tenant: SeededTenant;
  const tokens: Record<string, string> = {};

  /** Created during the human half, and archived later to exercise "delete records". */
  let gradingScaleId: string;

  async function login(email: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: email, password: TEST_PASSWORD });
    expect(response.status, `login failed for ${email}: ${JSON.stringify(response.body)}`).toBe(
      200,
    );
    return response.body.accessToken as string;
  }

  /** One request builder for both halves, so the two differ only in the header. */
  function send(
    method: BoundaryCase['method'],
    actor: string,
    path: string,
    body: Record<string, unknown>,
    options: { asAi?: boolean } = {},
  ) {
    // `request(...)` and `[method]` on separate lines is an automatic-semicolon-insertion
    // hazard: it reads as an index into the previous expression only because there is no
    // semicolon, and a formatter that adds one silently changes what this calls.
    const agent = request(app.getHttpServer());
    let call = agent[method](path)
      .set('Authorization', `Bearer ${tokens[actor]!}`)
      .set('x-institution-id', tenant.institutionId);
    if (options.asAi) call = call.set(AI_INITIATION_HEADER, 'shikkha-ai-gateway');
    return call.send(body);
  }

  async function query<T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const client = testClient();
    await client.connect();
    try {
      const { rows } = await client.query(sql, params);
      return rows as T[];
    } finally {
      await client.end();
    }
  }

  const auditCount = async (): Promise<number> =>
    Number((await query<{ total: string }>('select count(*)::text as total from audit_logs'))[0]!
      .total);

  beforeAll(async () => {
    configureTestEnv();
    await ensureTestDatabase();

    /**
     * `AiGovernanceModule` is imported explicitly alongside `AppModule`.
     *
     * Nest de-duplicates modules by class, so once `AppModule` imports it this line is a
     * no-op and the suite keeps passing unchanged. Until then it is what makes the guard and
     * the governance routes exist at all — a suite that silently tested nothing because a
     * module was not wired would be worse than a red one.
     */
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, AiGovernanceModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    await app.init();

    await truncateAll();
    tenant = await seedTenant('autonomy', { students: 3 });

    // Widen the seeded academic year around today, exactly as the attendance suite does, so
    // "is this date inside the academic year" is never the rule that decides a case here.
    const client = testClient();
    await client.connect();
    try {
      await client.query(`update academic_years set start_date = $1, end_date = $2 where id = $3`, [
        addDays(todayInDhaka(), -400),
        addDays(todayInDhaka(), 400),
        tenant.academicYearId,
      ]);
    } finally {
      await client.end();
    }

    tokens['owner'] = await login(tenant.users['owner']!.email);
    tokens['teacher'] = await login(tenant.users['teacher']!.email);
    tokens['principal'] = await login(tenant.users['principal']!.email);
  });

  afterAll(async () => {
    await app?.close();
  });

  /**
   * One case per clause of docs/06 §6, on a route the policy covers.
   *
   * The bodies are the ones the modules' own integration suites use, so a failure here is
   * about the boundary rather than about a body this file invented.
   */
  const cases: BoundaryCase[] = [
    {
      key: 'grades.change',
      method: 'post',
      path: '/api/v1/exams/grading-scales',
      body: { code: 'GPA5', nameEn: 'GPA 5.00 scale' },
      actor: 'owner',
      humanStatus: 201,
    },
    {
      key: 'grades.change',
      method: 'post',
      // The heaviest of the grade routes, and the one a headteacher actually worries about.
      // No exam is seeded, so the human half asserts "not refused by the boundary" rather
      // than a 201 — see `humanStatus`.
      path: `/api/v1/exams/${uuidv7()}/publish`,
      body: {},
      actor: 'owner',
      humanStatus: null,
    },
    {
      key: 'attendance.change',
      method: 'post',
      path: '/api/v1/attendance/sessions',
      body: { sectionId: '', attendanceDate: mostRecentSchoolDay() },
      actor: 'teacher',
      humanStatus: 201,
    },
    {
      key: 'admissions.approve',
      method: 'post',
      path: '/api/v1/admissions/sessions',
      body: {
        academicYearId: '',
        nameEn: 'Admission 2026',
        applicationStartDate: '2026-02-01',
        applicationEndDate: '2026-04-30',
        applicationFee: '500.00',
        classCapacity: [{ classLevelId: '', seats: 2 }],
      },
      actor: 'owner',
      humanStatus: 201,
    },
    {
      key: 'discipline.punish',
      method: 'post',
      path: '/api/v1/discipline/categories',
      body: {
        code: 'FIGHTING',
        nameEn: 'Fighting',
        kind: 'negative',
        defaultSeverity: 'major',
        defaultPoints: -10,
      },
      actor: 'owner',
      humanStatus: 201,
    },
    {
      key: 'finance.refund',
      method: 'post',
      path: `/api/v1/fees/payments/${uuidv7()}/reverse`,
      body: { reason: 'Reversing a payment taken in error' },
      actor: 'owner',
      humanStatus: null,
    },
    {
      key: 'salary.change',
      method: 'post',
      path: '/api/v1/hr/salary-structures',
      body: { nameEn: 'Teaching Scale 2026', effectiveFrom: '2026-01-01' },
      actor: 'owner',
      humanStatus: 201,
    },
    {
      key: 'payroll.run',
      method: 'post',
      path: '/api/v1/payroll/runs',
      body: { periodYear: 2026, periodMonth: 3 },
      actor: 'owner',
      humanStatus: null,
    },
    {
      key: 'accounting.entries',
      method: 'post',
      path: '/api/v1/accounting/accounts',
      body: { code: '1000', nameEn: 'Assets', type: 'asset', normalBalance: 'debit', isPostable: false },
      actor: 'owner',
      humanStatus: 201,
    },
    {
      key: 'records.delete',
      method: 'delete',
      path: `/api/v1/academic/calendar/${uuidv7()}`,
      body: { reason: 'Removing a duplicated holiday' },
      actor: 'owner',
      humanStatus: null,
    },
    {
      key: 'communication.mass_sensitive',
      method: 'post',
      path: '/api/v1/communication/templates',
      body: {
        key: 'exam-alert',
        name: 'Exam alert',
        channel: 'sms',
        bodyEn: 'Exam on Sunday at 10am. Bring the admit card.',
      },
      actor: 'owner',
      humanStatus: 201,
    },
  ];

  /** Ids seeded per tenant are only known at runtime, so the placeholders are filled here. */
  function resolveBody(testCase: BoundaryCase): Record<string, unknown> {
    const body = structuredClone(testCase.body);
    if (body['sectionId'] === '') body['sectionId'] = tenant.sectionId;
    if (body['academicYearId'] === '') body['academicYearId'] = tenant.academicYearId;
    const capacity = body['classCapacity'];
    if (Array.isArray(capacity)) {
      body['classCapacity'] = capacity.map((entry) => ({
        ...(entry as Record<string, unknown>),
        classLevelId: tenant.classLevelId,
      }));
    }
    return body;
  }

  // ── 1. Every forbidden action is refused when AI-initiated ───────────────────────────

  describe('an AI-initiated request is refused at the boundary', () => {
    for (const testCase of cases) {
      it(`refuses ${testCase.method.toUpperCase()} ${testCase.path.replace(/[0-9a-f-]{36}/g, ':id')} — ${testCase.key}`, async () => {
        const before = await auditCount();

        const response = await send(
          testCase.method,
          testCase.actor,
          testCase.path,
          resolveBody(testCase),
          { asAi: true },
        );

        expect(response.status, JSON.stringify(response.body)).toBe(403);
        expect(response.body.error.code).toBe('FORBIDDEN');
        // The exact message, imported rather than copied: a test asserting its own copy of a
        // string proves the two copies match, not that the boundary holds.
        expect(response.body.error.message).toBe(AI_AUTONOMY_REFUSAL_MESSAGE);

        // Refused before the handler, so nothing was written — not even an audit row, because
        // there is nothing to audit. The refusal itself is a security event, asserted below.
        expect(await auditCount()).toBe(before);
      });
    }

    it('records each refusal as a critical security event naming the clause', async () => {
      const rows = await query<{
        event_type: string;
        severity: string;
        detail: { reason?: string; forbiddenActions?: string[]; route?: string };
      }>(
        `select event_type, severity, detail
           from security_events
          where detail ->> 'reason' = 'ai_autonomy_boundary'
          order by occurred_at`,
      );

      // One per case above, at least — the guard fires before anything else can refuse.
      expect(rows.length).toBeGreaterThanOrEqual(cases.length);
      for (const row of rows) {
        expect(row.severity).toBe('critical');
        expect(row.detail.forbiddenActions?.length ?? 0).toBeGreaterThan(0);
        expect(row.detail.route).toBeTruthy();
      }

      // Every clause in docs/06 §6 is represented, so a refusal cannot have come from one
      // over-broad entry standing in for all ten.
      const seen = [...new Set(rows.flatMap((row) => row.detail.forbiddenActions ?? []))];
      for (const testCase of cases) {
        expect(seen, `no refusal recorded for ${testCase.key}`).toContain(testCase.key);
      }
    });

    it('refuses whichever route in the pair is asked, not merely the first', async () => {
      // Guards can be short-circuited by a stale reflector cache or an early return that
      // happens to be right once. Two different clauses, back to back, in one test.
      const payroll = await send('post', 'owner', '/api/v1/payroll/runs', { periodYear: 2026, periodMonth: 4 }, { asAi: true });
      const journal = await send('post', 'owner', '/api/v1/accounting/journal', {}, { asAi: true });
      expect(payroll.status).toBe(403);
      expect(journal.status).toBe(403);
      expect(payroll.body.error.message).toBe(AI_AUTONOMY_REFUSAL_MESSAGE);
      expect(journal.body.error.message).toBe(AI_AUTONOMY_REFUSAL_MESSAGE);
    });
  });

  // ── 2. The same action, performed by a human, succeeds ───────────────────────────────

  describe('the identical request performed by a person is not refused', () => {
    for (const testCase of cases) {
      const label = `${testCase.method.toUpperCase()} ${testCase.path.replace(/[0-9a-f-]{36}/g, ':id')}`;
      it(`lets ${testCase.actor} perform ${label} — ${testCase.key}`, async () => {
        const response = await send(
          testCase.method,
          testCase.actor,
          testCase.path,
          resolveBody(testCase),
        );

        // Whatever else happens, it is not the autonomy boundary. This is the assertion that
        // distinguishes a boundary from a blanket denial, and it holds for every case
        // including the ones with no fixtures.
        expect(
          response.body?.error?.message,
          `${label} was refused by the autonomy guard for a human caller`,
        ).not.toBe(AI_AUTONOMY_REFUSAL_MESSAGE);

        if (testCase.humanStatus !== null) {
          expect(response.status, JSON.stringify(response.body)).toBe(testCase.humanStatus);
          expect(response.body.id).toBeTruthy();
          if (testCase.path.endsWith('/grading-scales')) {
            gradingScaleId = response.body.id as string;
          }
        } else {
          // The module's own rules refused it — no such payment, no such calendar entry, no
          // salary data to run payroll against. A 4xx that is not 403-with-this-message means
          // the request reached the handler, which is exactly what is being proven.
          expect(response.status).not.toBe(403);
        }
      });
    }

    it('writes the human confirmation to the audit trail with is_ai_initiated false', async () => {
      const rows = await query<{
        actor_user_id: string | null;
        is_ai_initiated: boolean;
        module: string;
        resource_type: string;
      }>(
        `select actor_user_id, is_ai_initiated, module, resource_type
           from audit_logs
          where module = 'exams' and resource_type = 'grading_scale' and action = 'create'
          order by occurred_at desc
          limit 1`,
      );

      expect(rows).toHaveLength(1);
      // docs/06 §6: the confirmation is a normal API call made by the human. The trail has to
      // say so, or "was a model involved in this decision" becomes unanswerable later.
      expect(rows[0]!.is_ai_initiated).toBe(false);
      expect(rows[0]!.actor_user_id).toBe(tenant.users['owner']!.id);
    });

    it('lets a person archive a record the AI could not — "delete records", both halves', async () => {
      expect(gradingScaleId, 'the grading scale was not created above').toBeTruthy();
      const path = `/api/v1/exams/grading-scales/${gradingScaleId}/archive`;
      const body = { reason: 'Superseded by the 2027 scale' };

      const refused = await send('post', 'owner', path, body, { asAi: true });
      expect(refused.status).toBe(403);
      expect(refused.body.error.message).toBe(AI_AUTONOMY_REFUSAL_MESSAGE);

      const confirmed = await send('post', 'owner', path, body);
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);

      const [row] = await query<{ is_ai_initiated: boolean; reason: string | null }>(
        `select is_ai_initiated, reason
           from audit_logs
          where resource_type = 'grading_scale' and action = 'archive'
          order by occurred_at desc
          limit 1`,
      );
      expect(row!.is_ai_initiated).toBe(false);
      expect(row!.reason).toBe('Superseded by the 2027 scale');
    });
  });

  // ── 3. The boundary is a write boundary, not a wall ──────────────────────────────────

  describe('what the boundary does not refuse', () => {
    it('allows an AI-initiated read', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/students')
        .set('Authorization', `Bearer ${tokens['owner']!}`)
        .set('x-institution-id', tenant.institutionId)
        .set(AI_INITIATION_HEADER, 'shikkha-ai-gateway');

      // docs/06 §2: a model may read whatever its user may read. Refusing reads would break
      // the copilot and defend nothing — every tool is a read.
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    });

    it('allows an AI-initiated tool invocation, which is the whole point of the surface', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/ai/tools/student.lookup/invoke')
        .set('Authorization', `Bearer ${tokens['owner']!}`)
        .set('x-institution-id', tenant.institutionId)
        .set(AI_INITIATION_HEADER, 'shikkha-ai-gateway')
        .send({ arguments: { studentId: tenant.studentIds[0] } });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.result.students[0].id).toBe(tenant.studentIds[0]);
    });

    it('allows an AI-initiated write that is not in the forbidden set', async () => {
      // Starting a conversation is a write, is audited, and is nothing docs/06 §6 names. The
      // policy has to be a list, not a mood.
      const response = await request(app.getHttpServer())
        .post('/api/v1/ai/conversations')
        .set('Authorization', `Bearer ${tokens['owner']!}`)
        .set('x-institution-id', tenant.institutionId)
        .set(AI_INITIATION_HEADER, 'shikkha-ai-gateway')
        .send({ purpose: 'copilot', title: 'Boundary check' });

      expect(response.status, JSON.stringify(response.body)).toBe(201);
    });

    it('cannot be talked out of by a header claiming the request is human', async () => {
      // The header sets the flag and can never clear it. A caller who has declared itself
      // AI-initiated cannot un-declare, and a caller who has not is human anyway — so the
      // only thing a forged value can do is refuse the forger.
      const response = await send(
        'post',
        'owner',
        '/api/v1/accounting/accounts',
        { code: '9999', nameEn: 'Sneaky', type: 'asset', normalBalance: 'debit' },
        { asAi: true },
      );
      expect(response.status).toBe(403);

      const denied = await request(app.getHttpServer())
        .post('/api/v1/accounting/accounts')
        .set('Authorization', `Bearer ${tokens['owner']!}`)
        .set('x-institution-id', tenant.institutionId)
        .set(AI_INITIATION_HEADER, 'false')
        .send({ code: '9998', nameEn: 'Sneakier', type: 'asset', normalBalance: 'debit' });
      expect(denied.status, 'a header value of "false" must not clear the flag').toBe(403);
      expect(denied.body.error.message).toBe(AI_AUTONOMY_REFUSAL_MESSAGE);
    });
  });

  // ── 4. The attestation: the cases above cannot be the whole answer ───────────────────

  describe('attestation over the whole router', () => {
    const asOwner = (path: string) =>
      request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${tokens['owner']!}`)
        .set('x-institution-id', tenant.institutionId);

    it('covers every mutating route that touches a forbidden resource', async () => {
      const response = await asOwner('/api/v1/ai/governance/attestation');
      expect(response.status, JSON.stringify(response.body)).toBe(200);

      // The failure message carries the offending routes, because "compliant was false" sends
      // whoever is on call reading source rather than fixing a policy entry.
      const gaps = response.body.gaps as Array<{ route: { method: string; path: string }; why: string }>;
      expect(
        gaps.map((gap) => `${gap.route.method} ${gap.route.path}: ${gap.why}`),
        'a mutating route touches a resource docs/06 §6 forbids and no policy entry covers it',
      ).toEqual([]);
      expect(response.body.compliant).toBe(true);
      expect(response.body.summary.mutatingRoutes).toBeGreaterThan(100);
      expect(response.body.summary.coveredRoutes).toBeGreaterThan(0);
    });

    it('reports a route for every clause, so no clause is enforced by an empty set', async () => {
      const response = await asOwner('/api/v1/ai/governance/attestation');
      const coverage = response.body.coverage as Array<{ key: string; routeCount: number }>;

      expect(coverage.map((entry) => entry.key).sort()).toEqual(
        FORBIDDEN_AUTONOMOUS_ACTIONS.map((action) => action.key).sort(),
      );
      for (const entry of coverage) {
        expect(entry.routeCount, `${entry.key} covers no route at all`).toBeGreaterThan(0);
      }
    });

    it('publishes the policy with the routes each rule covers, and how to test it', async () => {
      const response = await asOwner('/api/v1/ai/governance/policy');
      expect(response.status).toBe(200);

      expect(response.body.actions).toHaveLength(FORBIDDEN_AUTONOMOUS_ACTIONS.length);
      expect(response.body.initiationHeader).toBe(AI_INITIATION_HEADER);
      expect(response.body.refusal.message).toBe(AI_AUTONOMY_REFUSAL_MESSAGE);

      const refunds = (
        response.body.actions as Array<{ key: string; routes: Array<{ path: string }> }>
      ).find((action) => action.key === 'finance.refund');
      // Concrete, checkable, and the reason the endpoint returns routes at all: a DPO can hold
      // this list next to the router instead of taking the sentence on trust.
      expect(refunds!.routes.map((route) => route.path)).toContain('/fees/payments/:id/reverse');
    });

    it('is not readable without ai.settings.manage', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/ai/governance/policy')
        .set('Authorization', `Bearer ${tokens['teacher']!}`)
        .set('x-institution-id', tenant.institutionId);
      expect(response.status).toBe(403);
    });
  });

  // ── 5. The trail that answers "how was this decided" ─────────────────────────────────

  describe('the AI-initiated audit trail', () => {
    it('returns AI-initiated rows and nothing else', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/ai/governance/ai-actions')
        .set('Authorization', `Bearer ${tokens['owner']!}`)
        .set('x-institution-id', tenant.institutionId)
        .query({ pageSize: 100 });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.data.length).toBeGreaterThan(0);
      for (const row of response.body.data as Array<{ isAiInitiated: boolean }>) {
        expect(row.isAiInitiated).toBe(true);
      }

      // The tool invocation from section 3 is in it — that is what a model reading a child's
      // record looks like in the trail, and it is the row somebody will want years later.
      const labels = (response.body.data as Array<{ resourceType: string }>).map(
        (row) => row.resourceType,
      );
      expect(labels).toContain('ai_tool_invocation');
    });

    it('excludes the human confirmation, which is the point of the flag', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/ai/governance/ai-actions')
        .set('Authorization', `Bearer ${tokens['owner']!}`)
        .set('x-institution-id', tenant.institutionId)
        .query({ module: 'exams', pageSize: 100 });

      expect(response.status).toBe(200);
      // The grading scale was created and archived by a person. Neither may appear here.
      expect(response.body.data).toEqual([]);
    });

    it('needs audit.view, not an AI permission', async () => {
      // The teacher preset holds `ai.copilot.use` and no `audit.view`. Being allowed to use
      // the assistant must not carry being allowed to read what everyone else asked it.
      const response = await request(app.getHttpServer())
        .get('/api/v1/ai/governance/ai-actions')
        .set('Authorization', `Bearer ${tokens['teacher']!}`)
        .set('x-institution-id', tenant.institutionId);
      expect(response.status).toBe(403);
    });
  });
});
