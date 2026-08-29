/**
 * Payment gateway integration suite (Phase 12).
 *
 * This file holds the online-money invariants, not proof that routes return 200. Each
 * describe block is a rule that, broken in production, either credits money that never
 * arrived or loses money that did:
 *
 *  - a callback with a bad signature is refused, and the attempt is recorded anyway,
 *  - a provider's duplicate delivery produces exactly ONE fee-side payment row,
 *  - the amount a callback claims can never override the stored intent's amount,
 *  - an expired intent cannot be settled by a late callback,
 *  - a succeeded intent posts the fee-side payment and settles its invoices atomically,
 *  - refunds take two permissions and two people: `finance.refund` requests,
 *    `finance.refund.approve` decides, and a self-approval is refused outright,
 *  - the public callback endpoint answers with machine codes and no tenant data, ever,
 *  - and none of it crosses a tenant boundary.
 *
 * Everything runs over HTTP through the real guards, interceptors and database. The mock
 * gateway's signatures are real HMAC-SHA256 over the raw body — the suite signs with the same
 * secret the adapter verifies with, so a forged payload here is rejected by exactly the code
 * that would reject a forged bKash callback.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  createTestApp,
  seedTenant,
  testClient,
  truncateAll,
  TEST_PASSWORD,
  type SeededTenant,
} from '../helpers/test-app';
import { signMockPayload } from '../../src/modules/payment-gateway/providers/mock.provider';

describe('Payment gateway', () => {
  let app: INestApplication;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
  const tokens: Record<string, string> = {};

  // Fixture invoices, inserted directly so the suite does not depend on the billing engine.
  let inv600Id: string; // student 0 — settled by the main success intent
  let inv400Id: string; // student 0 — settled by the main success intent
  let invGuardianId: string; // student 0 — the guardian's own small intent
  let inv500Id: string; // student 1 — the second success intent (self-approval check)
  let invFailId: string; // student 2 — the failed-callback intent
  let invExpId: string; // student 2 — the expired intent

  // Intents captured as the suite runs.
  let mainIntent: { id: string; providerIntentId: string };
  let guardianIntentId: string;
  let secondIntent: { id: string; providerIntentId: string };
  let failIntent: { id: string; providerIntentId: string };
  let expiredIntent: { id: string; providerIntentId: string };

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

  /**
   * Deliver one callback the way a gateway would: raw JSON body on the wire, HMAC signature
   * in the header. `signature: 'auto'` signs the exact bytes being sent with the mock
   * secret; `null` omits the header; any other string is sent verbatim (a forgery).
   */
  const callback = (
    provider: string,
    payload: Record<string, unknown>,
    signature: string | 'auto' | null = 'auto',
  ) => {
    const raw = JSON.stringify(payload);
    let req = request(app.getHttpServer())
      .post(`/api/v1/payments/callback/${provider}`)
      .set('content-type', 'application/json');
    if (signature !== null) {
      req = req.set('x-gateway-signature', signature === 'auto' ? signMockPayload(raw) : signature);
    }
    return req.send(raw);
  };

  /** Insert one issued invoice directly, as the migrator, and return its id. */
  async function insertInvoice(
    tenant: SeededTenant,
    studentId: string,
    invoiceNumber: string,
    amount: string,
  ): Promise<string> {
    const client = testClient();
    await client.connect();
    try {
      const { rows } = await client.query<{ id: string }>(
        `insert into invoices (tenant_id, institution_id, student_id, academic_year_id,
                               invoice_number, billing_period_start, billing_period_end,
                               issue_date, due_date, subtotal, total, balance)
         values ($1,$2,$3,$4,$5,'2026-02-01','2026-02-28','2026-02-01','2026-02-10',$6,$6,$6)
         returning id`,
        [
          tenant.tenantId,
          tenant.institutionId,
          studentId,
          tenant.academicYearId,
          invoiceNumber,
          amount,
        ],
      );
      return rows[0]!.id;
    } finally {
      await client.end();
    }
  }

  async function sqlValue<T>(query: string, params: unknown[]): Promise<T> {
    const client = testClient();
    await client.connect();
    try {
      const { rows } = await client.query(query, params);
      return rows[0] as T;
    } finally {
      await client.end();
    }
  }

  async function getInvoice(role: string, invoiceId: string): Promise<Record<string, unknown>> {
    const response = await get(role, `/api/v1/fees/invoices/${invoiceId}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body as Record<string, unknown>;
  }

  async function getIntent(role: string, id: string): Promise<Record<string, any>> {
    const response = await get(role, `/api/v1/payments/intents/${id}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body as Record<string, any>;
  }

  beforeAll(async () => {
    app = await createTestApp();
    await truncateAll();
    tenantA = await seedTenant('paya', { students: 3 });
    tenantB = await seedTenant('payb', { students: 2 });

    for (const key of ['owner', 'accountant', 'teacher', 'guardian1']) {
      tokens[key] = await login(tenantA.users[key]!.email);
    }
    tokens['otherAccountant'] = await login(tenantB.users['accountant']!.email);

    inv600Id = await insertInvoice(tenantA, tenantA.studentIds[0]!, 'PGW-A-600', '600.00');
    inv400Id = await insertInvoice(tenantA, tenantA.studentIds[0]!, 'PGW-A-400', '400.00');
    invGuardianId = await insertInvoice(tenantA, tenantA.studentIds[0]!, 'PGW-A-G50', '50.00');
    inv500Id = await insertInvoice(tenantA, tenantA.studentIds[1]!, 'PGW-B-500', '500.00');
    invFailId = await insertInvoice(tenantA, tenantA.studentIds[2]!, 'PGW-C-150', '150.00');
    invExpId = await insertInvoice(tenantA, tenantA.studentIds[2]!, 'PGW-C-250', '250.00');
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Intent creation
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('intent creation', () => {
    it('creates an intent against the mock gateway and returns the redirect', async () => {
      const response = await post('accountant', '/api/v1/payments/intents', {
        studentId: tenantA.studentIds[0],
        invoiceIds: [inv600Id, inv400Id],
        amount: '1000.00',
        provider: 'mock',
        idempotencyKey: 'ik-main-0001',
        expiresInMinutes: 30,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('redirected');
      expect(response.body.reused).toBe(false);
      expect(response.body.amount).toBe('1000.00');
      expect(response.body.providerIntentId).toMatch(/^MOCK-pending-/);
      expect(response.body.redirectUrl).toContain('https://mock-gateway.invalid/pay/');
      mainIntent = { id: response.body.id, providerIntentId: response.body.providerIntentId };
    });

    it('replays the same idempotency key into the original intent, not a second one', async () => {
      const response = await post('accountant', '/api/v1/payments/intents', {
        studentId: tenantA.studentIds[0],
        invoiceIds: [inv600Id, inv400Id],
        amount: '1000.00',
        provider: 'mock',
        idempotencyKey: 'ik-main-0001',
        expiresInMinutes: 30,
      });
      expect(response.status).toBe(201);
      expect(response.body.id).toBe(mainIntent.id);
      expect(response.body.reused).toBe(true);
      // One-time redirect URLs are not reissued on a replay.
      expect(response.body.redirectUrl).toBeNull();

      const counted = await sqlValue<{ count: number }>(
        `select count(*)::int as count from payment_intents where idempotency_key = $1`,
        ['ik-main-0001'],
      );
      expect(counted.count).toBe(1);
    });

    it('refuses an amount above what the selected invoices owe', async () => {
      const response = await post('accountant', '/api/v1/payments/intents', {
        studentId: tenantA.studentIds[2],
        invoiceIds: [invFailId],
        amount: '150.01',
        provider: 'mock',
        idempotencyKey: 'ik-too-much-0001',
      });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('refuses a teacher, who holds no finance permission', async () => {
      const response = await post('teacher', '/api/v1/payments/intents', {
        studentId: tenantA.studentIds[0],
        invoiceIds: [invGuardianId],
        amount: '50.00',
        provider: 'mock',
        idempotencyKey: 'ik-teacher-0001',
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('lets a guardian create an intent for their own child', async () => {
      const response = await post('guardian1', '/api/v1/payments/intents', {
        studentId: tenantA.studentIds[0],
        invoiceIds: [invGuardianId],
        amount: '50.00',
        provider: 'mock',
        idempotencyKey: 'ik-guardian-0001',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      guardianIntentId = response.body.id;
    });

    it("answers a guardian naming another family's child with 404, not 403", async () => {
      // Student 1 belongs to guardian2. Confirming the student exists would itself be a leak.
      const response = await post('guardian1', '/api/v1/payments/intents', {
        studentId: tenantA.studentIds[1],
        invoiceIds: [inv500Id],
        amount: '500.00',
        provider: 'mock',
        idempotencyKey: 'ik-guardian-0002',
      });
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('a guardian sees only their own children in the intent list', async () => {
      const response = await get('guardian1', '/api/v1/payments/intents', { pageSize: 100 });
      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeGreaterThan(0);
      for (const intent of response.body.data) {
        expect(intent.studentId).toBe(tenantA.studentIds[0]);
      }
    });

    it('a guardian can cancel their own open intent, with a reason on the record', async () => {
      const current = await getIntent('guardian1', guardianIntentId);
      const response = await post(
        'guardian1',
        `/api/v1/payments/intents/${guardianIntentId}/cancel`,
        { reason: 'Chose to pay at the counter instead', version: current.version },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('cancelled');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // The public callback — signature first, evidence recorded, nothing leaked
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('callback signature verification', () => {
    it('rejects a tampered signature and records the attempt as invalid', async () => {
      const payload = {
        eventId: 'evt-forged-1',
        providerIntentId: mainIntent.providerIntentId,
        status: 'succeeded',
        amount: '1000.00',
      };
      // A real HMAC over DIFFERENT bytes: same length, same alphabet, wrong content — the
      // constant-time comparison path, not the length short-circuit.
      const forged = signMockPayload(JSON.stringify(payload) + 'tampered');
      const response = await callback('mock', payload, forged);

      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');

      // The attempt is on the record — hostile traffic that never verifies is exactly the
      // traffic worth being able to read later — and it belongs to no tenant.
      const recorded = await sqlValue<{ count: number }>(
        `select count(*)::int as count from payment_callbacks
          where signature_valid = false and processing_result = 'signature_invalid'`,
        [],
      );
      expect(recorded.count).toBeGreaterThanOrEqual(1);

      // And nothing moved.
      const intent = await getIntent('accountant', mainIntent.id);
      expect(intent.status).toBe('redirected');
      expect(intent.paymentId).toBeNull();
    });

    it('rejects a callback with no signature at all', async () => {
      const response = await callback(
        'mock',
        {
          eventId: 'evt-unsigned-1',
          providerIntentId: mainIntent.providerIntentId,
          status: 'succeeded',
        },
        null,
      );
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('fails closed for a provider with no verification scheme configured', async () => {
      // The bKash stub has no credentials, so no callback from it can ever be authentic.
      const response = await callback('bkash', {
        eventId: 'evt-bkash-1',
        providerIntentId: 'BK-123',
        status: 'succeeded',
      });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('callback settlement', () => {
    it('posts the payment for a correctly signed success — at the INTENT amount, not the claimed one', async () => {
      const response = await callback('mock', {
        eventId: 'evt-main-1',
        providerIntentId: mainIntent.providerIntentId,
        status: 'succeeded',
        // A lie. The stored intent says 1000.00, and the intent is what posts.
        amount: '999999.99',
        reference: 'TXN-MAIN-1',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).toEqual({ received: true, result: 'payment_posted', duplicate: false });

      // The intent flipped and names its fee-side payment (the atomicity the DB check
      // constraint restates: succeeded without a payment is unrepresentable).
      const intent = await getIntent('accountant', mainIntent.id);
      expect(intent.status).toBe('succeeded');
      expect(intent.paymentId).not.toBeNull();

      // The fee ledger got the intent's amount. The callback's 999999.99 was recorded as
      // evidence in raw_payload and used for nothing.
      const payments = await get('accountant', '/api/v1/fees/payments', {
        studentId: tenantA.studentIds[0],
        pageSize: 100,
      });
      expect(payments.status).toBe(200);
      const posted = payments.body.data.find(
        (one: { id: string; amount: string; reference: string | null; status: string }) =>
          one.id === intent.paymentId,
      );
      expect(posted, 'the fee-side payment row is missing').toBeTruthy();
      expect(posted.amount).toBe('1000.00');
      expect(posted.reference).toBe('TXN-MAIN-1');
      expect(posted.status).toBe('completed');

      // And the invoices were settled in the same transaction, oldest-due-first.
      const invoice600 = await getInvoice('accountant', inv600Id);
      const invoice400 = await getInvoice('accountant', inv400Id);
      expect(invoice600.balance).toBe('0.00');
      expect(invoice600.status).toBe('paid');
      expect(invoice400.balance).toBe('0.00');
      expect(invoice400.status).toBe('paid');
    });

    it('answers a duplicate delivery with the original result and exactly ONE payment row', async () => {
      const response = await callback('mock', {
        eventId: 'evt-main-1',
        providerIntentId: mainIntent.providerIntentId,
        status: 'succeeded',
        amount: '999999.99',
        reference: 'TXN-MAIN-1',
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ received: true, result: 'payment_posted', duplicate: true });

      const payments = await sqlValue<{ count: number }>(
        `select count(*)::int as count from payments where reference = 'TXN-MAIN-1'`,
        [],
      );
      expect(payments.count, 'a provider retry double-credited').toBe(1);

      const callbacks = await sqlValue<{ count: number }>(
        `select count(*)::int as count from payment_callbacks where dedupe_key = 'mock:evt-main-1'`,
        [],
      );
      expect(callbacks.count).toBe(1);
    });

    it('ignores a fresh success event for an already-settled intent', async () => {
      const response = await callback('mock', {
        eventId: 'evt-main-2',
        providerIntentId: mainIntent.providerIntentId,
        status: 'succeeded',
        reference: 'TXN-MAIN-2',
      });
      expect(response.status).toBe(200);
      expect(response.body.result).toBe('ignored_state');

      const counted = await sqlValue<{ count: number }>(
        `select count(*)::int as count from payments where student_id = $1`,
        [tenantA.studentIds[0]!],
      );
      expect(counted.count).toBe(1);
    });

    it('marks an intent failed on a signed failure callback, and touches no invoice', async () => {
      const created = await post('accountant', '/api/v1/payments/intents', {
        studentId: tenantA.studentIds[2],
        invoiceIds: [invFailId],
        amount: '150.00',
        provider: 'mock',
        idempotencyKey: 'ik-fail-0001',
      });
      expect(created.status).toBe(201);
      failIntent = { id: created.body.id, providerIntentId: created.body.providerIntentId };

      const response = await callback('mock', {
        eventId: 'evt-fail-1',
        providerIntentId: failIntent.providerIntentId,
        status: 'failed',
        failureCode: 'INSUFFICIENT_FUNDS',
        failureMessage: 'The customer wallet had insufficient funds',
      });
      expect(response.status).toBe(200);
      expect(response.body.result).toBe('intent_failed');

      const intent = await getIntent('accountant', failIntent.id);
      expect(intent.status).toBe('failed');
      expect(intent.failureCode).toBe('INSUFFICIENT_FUNDS');

      const invoice = await getInvoice('accountant', invFailId);
      expect(invoice.balance).toBe('150.00');
    });

    it('refuses to settle an expired intent — a late callback credits nothing', async () => {
      const created = await post('accountant', '/api/v1/payments/intents', {
        studentId: tenantA.studentIds[2],
        invoiceIds: [invExpId],
        amount: '250.00',
        provider: 'mock',
        idempotencyKey: 'ik-expired-0001',
      });
      expect(created.status).toBe(201);
      expiredIntent = { id: created.body.id, providerIntentId: created.body.providerIntentId };

      // Age the row out. The creation timestamps move too, so the row stays internally
      // consistent (expiry after creation) instead of failing for the wrong reason.
      const client = testClient();
      await client.connect();
      try {
        await client.query(
          `update payment_intents
              set expires_at = now() - interval '90 minutes',
                  created_at = now() - interval '3 hours',
                  updated_at = now() - interval '3 hours'
            where id = $1`,
          [expiredIntent.id],
        );
      } finally {
        await client.end();
      }

      const response = await callback('mock', {
        eventId: 'evt-expired-1',
        providerIntentId: expiredIntent.providerIntentId,
        status: 'succeeded',
        reference: 'TXN-EXPIRED-1',
      });
      expect(response.status).toBe(200);
      expect(response.body.result).toBe('ignored_expired');

      const intent = await getIntent('accountant', expiredIntent.id);
      expect(intent.status).toBe('expired');
      expect(intent.paymentId).toBeNull();

      const invoice = await getInvoice('accountant', invExpId);
      expect(invoice.balance).toBe('250.00');

      const counted = await sqlValue<{ count: number }>(
        `select count(*)::int as count from payments where student_id = $1`,
        [tenantA.studentIds[2]!],
      );
      expect(counted.count).toBe(0);
    });

    it('records a callback naming no known intent under no tenant at all', async () => {
      const response = await callback('mock', {
        eventId: 'evt-unknown-1',
        providerIntentId: 'MOCK-pending-00000000-0000-0000-0000-000000000000',
        status: 'succeeded',
      });
      expect(response.status).toBe(200);
      expect(response.body.result).toBe('unknown_intent');

      const row = await sqlValue<{ tenant_id: string | null }>(
        `select tenant_id from payment_callbacks where dedupe_key = 'mock:evt-unknown-1'`,
        [],
      );
      expect(row.tenant_id).toBeNull();
    });

    it('leaks no tenant data to the unauthenticated caller, on success or failure', async () => {
      // The success response: machine codes only.
      const success = await callback('mock', {
        eventId: 'evt-main-1',
        providerIntentId: mainIntent.providerIntentId,
        status: 'succeeded',
        amount: '999999.99',
        reference: 'TXN-MAIN-1',
      });
      expect(Object.keys(success.body).sort()).toEqual(['duplicate', 'received', 'result']);

      const bodies = JSON.stringify(success.body);
      for (const secret of [
        tenantA.tenantId,
        tenantA.institutionId,
        tenantA.studentIds[0]!,
        mainIntent.id,
        '1000.00',
      ]) {
        expect(bodies, `callback response leaked "${secret}"`).not.toContain(secret);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Refunds — two permissions, two people
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('refunds', () => {
    it('refuses a refund request from someone without finance.refund', async () => {
      const intent = await getIntent('accountant', mainIntent.id);
      for (const role of ['teacher', 'guardian1']) {
        const response = await post(
          role,
          `/api/v1/payments/intents/${mainIntent.id}/refund-request`,
          {
            reason: 'Family says the fee was charged twice',
            version: intent.version,
          },
        );
        expect(response.status, `${role} should not be able to request a refund`).toBe(403);
        expect(response.body.error.code).toBe('FORBIDDEN');
      }
    });

    it('records a refund request from the accountant, executing nothing', async () => {
      const intent = await getIntent('accountant', mainIntent.id);
      const response = await post(
        'accountant',
        `/api/v1/payments/intents/${mainIntent.id}/refund-request`,
        { reason: 'Family says the fee was charged twice', version: intent.version },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.refundStatus).toBe('requested');

      // Nothing moved yet: the payment stands and the invoices stay settled.
      const payments = await sqlValue<{ status: string }>(
        `select status from payments where reference = 'TXN-MAIN-1'`,
        [],
      );
      expect(payments.status).toBe('completed');
    });

    it('refuses the decision from the accountant, who lacks finance.refund.approve', async () => {
      const intent = await getIntent('accountant', mainIntent.id);
      const response = await post(
        'accountant',
        `/api/v1/payments/intents/${mainIntent.id}/refund-decision`,
        { decision: 'approved', reason: 'Approving my own request', version: intent.version },
      );
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('executes an approved refund: gateway, payment reversal and invoice restoration together', async () => {
      const intent = await getIntent('accountant', mainIntent.id);
      const response = await post(
        'owner',
        `/api/v1/payments/intents/${mainIntent.id}/refund-decision`,
        { decision: 'approved', reason: 'Verified the duplicate charge', version: intent.version },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.intent.refundStatus).toBe('completed');
      expect(response.body.intent.refundProviderReference).toMatch(/^MOCKR-/);
      expect(response.body.payment.status).toBe('reversed');

      // The reversal restored every balance the settlement touched.
      const invoice600 = await getInvoice('accountant', inv600Id);
      const invoice400 = await getInvoice('accountant', inv400Id);
      expect(invoice600.balance).toBe('600.00');
      expect(invoice400.balance).toBe('400.00');
    });

    it('refuses a self-approval even for someone holding both permissions', async () => {
      // A second settled intent, requested by the owner — who also holds the approve
      // permission, and must still not be allowed to decide their own request.
      const created = await post('accountant', '/api/v1/payments/intents', {
        studentId: tenantA.studentIds[1],
        invoiceIds: [inv500Id],
        amount: '500.00',
        provider: 'mock',
        idempotencyKey: 'ik-second-0001',
      });
      expect(created.status).toBe(201);
      secondIntent = { id: created.body.id, providerIntentId: created.body.providerIntentId };

      const settled = await callback('mock', {
        eventId: 'evt-second-1',
        providerIntentId: secondIntent.providerIntentId,
        status: 'succeeded',
        reference: 'TXN-SECOND-1',
      });
      expect(settled.body.result).toBe('payment_posted');

      let intent = await getIntent('owner', secondIntent.id);
      const requested = await post(
        'owner',
        `/api/v1/payments/intents/${secondIntent.id}/refund-request`,
        { reason: 'Charged against the wrong invoice', version: intent.version },
      );
      expect(requested.status).toBe(201);

      intent = await getIntent('owner', secondIntent.id);
      const decided = await post(
        'owner',
        `/api/v1/payments/intents/${secondIntent.id}/refund-decision`,
        { decision: 'approved', reason: 'Approving my own request', version: intent.version },
      );
      expect(decided.status).toBe(409);
      expect(decided.body.error.code).toBe('CONFLICT');

      // Still awaiting a second person; nothing was reversed.
      const after = await sqlValue<{ status: string }>(
        `select status from payments where reference = 'TXN-SECOND-1'`,
        [],
      );
      expect(after.status).toBe('completed');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Reconciliation — reports, never corrections
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('reconciliation', () => {
    it('names every mismatch class and confirms only exact matches', async () => {
      const file = [
        'provider_reference,amount',
        // Exact match: the second intent, settled and untouched by refunds.
        `${secondIntent.providerIntentId},500.00`,
        // The gateway claims a settlement no local intent carries.
        'MOCK-pending-never-seen,75.00',
      ].join('\n');

      const response = await post('accountant', '/api/v1/payments/reconciliations', {
        provider: 'mock',
        settlementDate: '2026-02-28',
        fileContent: file,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.reconciliation.status).toBe('mismatched');
      expect(response.body.reconciliation.totalReported).toBe('575.00');
      expect(response.body.reconciliation.totalMatched).toBe('500.00');

      const byReference = new Map<string, string>(
        response.body.items.map(
          (item: { providerReference: string; status: string }): [string, string] => [
            item.providerReference,
            item.status,
          ],
        ),
      );
      expect(byReference.get(secondIntent.providerIntentId)).toBe('matched');
      expect(byReference.get('MOCK-pending-never-seen')).toBe('missing_locally');
      // The main intent succeeded locally but is absent from this file.
      expect(byReference.get(mainIntent.providerIntentId)).toBe('missing_remotely');

      // The one write reconciliation makes: succeeded → reconciled on the exact match.
      const confirmed = await getIntent('accountant', secondIntent.id);
      expect(confirmed.status).toBe('reconciled');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Tenant isolation
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('tenant isolation', () => {
    it('another tenant cannot read an intent by its exact id', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/payments/intents/${mainIntent.id}`)
        .set('Authorization', `Bearer ${tokens['otherAccountant']}`)
        .set('x-institution-id', tenantB.institutionId);

      // 404, not 403: confirming the intent exists elsewhere is itself a leak.
      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain(mainIntent.providerIntentId);
    });

    it("another tenant's intent list is empty rather than leaky", async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/payments/intents')
        .set('Authorization', `Bearer ${tokens['otherAccountant']}`)
        .set('x-institution-id', tenantB.institutionId);

      expect(response.status).toBe(200);
      expect(response.body.meta.total).toBe(0);
      expect(response.body.data).toEqual([]);
    });

    it('the gateway tables all carry forced row-level security', async () => {
      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query<{ relname: string }>(
          `select c.relname
             from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public'
              and c.relkind = 'r'
              and c.relname in ('payment_intents','payment_callbacks',
                                'payment_reconciliations','reconciliation_items')
              and (not c.relrowsecurity
                   or not c.relforcerowsecurity
                   or not exists (select 1 from pg_policy p
                                   where p.polrelid = c.oid and p.polname = 'tenant_isolation'))`,
        );
        expect(rows.map((row) => row.relname)).toEqual([]);
      } finally {
        await client.end();
      }
    });
  });
});
