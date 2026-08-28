/**
 * Fee management integration suite (Phase 11).
 *
 * This file exists to hold the money invariants, not to prove the routes return 200. Each
 * describe block below corresponds to a rule that, if it broke in production, would either
 * cost a school money or cost a family money:
 *
 *  - a proportional allocation never loses or invents a poisa,
 *  - re-running a billing job does not bill a family twice,
 *  - concessions apply percentage-then-fixed and can never make an invoice negative,
 *  - a pending concession changes nothing until somebody with the approval permission acts,
 *  - allocations sum exactly to the payment, and default to oldest-due-first,
 *  - status is derived from what has actually been paid,
 *  - a paid invoice cannot be voided,
 *  - reversing a payment restores every balance it touched,
 *  - a guardian sees their own children's bills and nobody else's,
 *  - and none of it crosses a tenant boundary.
 *
 * Everything runs over HTTP through the real guards, interceptors and database, because the
 * properties under test live precisely in the parts a stub would replace.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Client } from 'pg';
import { Money } from '@shikkha/shared';
import {
  createTestApp,
  seedTenant,
  testClient,
  truncateAll,
  TEST_APP_DATABASE_URL,
  TEST_PASSWORD,
  type SeededTenant,
} from '../helpers/test-app';

describe('Fee management', () => {
  let app: INestApplication;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
  const tokens: Record<string, string> = {};

  // Ids captured as the suite builds up a real fee configuration.
  let tuitionHeadId: string;
  let transportHeadId: string;
  let fineHeadId: string;
  let structureId: string;

  const januaryInvoiceIds: string[] = [];
  const februaryInvoiceIds: string[] = [];

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

  const patch = (role: string, path: string, body: object = {}) =>
    request(app.getHttpServer())
      .patch(path)
      .set('Authorization', `Bearer ${tokens[role]}`)
      .set('x-institution-id', tenantA.institutionId)
      .send(body);

  const put = (role: string, path: string, body: object = {}) =>
    request(app.getHttpServer())
      .put(path)
      .set('Authorization', `Bearer ${tokens[role]}`)
      .set('x-institution-id', tenantA.institutionId)
      .send(body);

  beforeAll(async () => {
    app = await createTestApp();
    await truncateAll();
    tenantA = await seedTenant('feea', { students: 3 });
    tenantB = await seedTenant('feeb', { students: 2 });

    for (const key of ['owner', 'principal', 'accountant', 'teacher', 'guardian1']) {
      tokens[key] = await login(tenantA.users[key]!.email);
    }
    tokens['otherAccountant'] = await login(tenantB.users['accountant']!.email);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Money arithmetic — the property everything else rests on
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('money arithmetic', () => {
    it('never loses or invents a poisa across an allocation', () => {
      const cases: Array<{ amount: string; ratios: number[] }> = [
        { amount: '1000.00', ratios: [1, 1, 1] },
        { amount: '0.01', ratios: [1, 1, 1] },
        { amount: '1234.57', ratios: [100000, 80000] },
        { amount: '99999.99', ratios: [7, 11, 13, 17] },
        { amount: '10.00', ratios: [1, 2, 3, 4, 5, 6, 7] },
      ];

      for (const testCase of cases) {
        const whole = Money.fromDecimalString(testCase.amount);
        const parts = whole.allocate(testCase.ratios);
        expect(parts).toHaveLength(testCase.ratios.length);
        expect(
          Money.sum(parts).toDecimalString(),
          `allocating ${testCase.amount} over ${testCase.ratios.join(':')} did not sum back`,
        ).toBe(whole.toDecimalString());
      }
    });

    it('splits evenly without drift over many parts', () => {
      const whole = Money.fromDecimalString('100.00');
      const parts = whole.split(3);
      expect(parts.map((part) => part.toDecimalString())).toEqual(['33.34', '33.33', '33.33']);
      expect(Money.sum(parts).toDecimalString()).toBe('100.00');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Configuration
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('fee configuration', () => {
    it('creates fee heads', async () => {
      const tuition = await post('accountant', '/api/v1/fees/heads', {
        code: 'TUITION',
        nameEn: 'Tuition',
        nameBn: 'টিউশন',
        type: 'tuition',
        isRecurring: true,
      });
      expect(tuition.status, JSON.stringify(tuition.body)).toBe(201);
      tuitionHeadId = tuition.body.id;

      const transport = await post('accountant', '/api/v1/fees/heads', {
        code: 'TRANSPORT',
        nameEn: 'Transport',
        type: 'transport',
        isRecurring: true,
      });
      expect(transport.status).toBe(201);
      transportHeadId = transport.body.id;

      const fine = await post('accountant', '/api/v1/fees/heads', {
        code: 'LATEFINE',
        nameEn: 'Late fine',
        type: 'fine',
        isRefundable: false,
      });
      expect(fine.status).toBe(201);
      fineHeadId = fine.body.id;
    });

    it('refuses a fee head to a role with no finance authority', async () => {
      const response = await post('teacher', '/api/v1/fees/heads', {
        code: 'SNEAK',
        nameEn: 'Sneaky fee',
        type: 'other',
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
      // Naming the missing permission would be free reconnaissance.
      expect(JSON.stringify(response.body)).not.toContain('finance.fees.manage');
    });

    it('creates a fee structure with a late-fine rule and publishes it', async () => {
      const created = await post('accountant', '/api/v1/fees/structures', {
        campusId: tenantA.campusId,
        academicYearId: tenantA.academicYearId,
        nameEn: 'Standard 2026',
        nameBn: 'সাধারণ ২০২৬',
        effectiveFrom: '2026-01-01',
        lateFineKind: 'percentage',
        lateFineValue: '2.00',
        lateFineGraceDays: 5,
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body.status).toBe('draft');
      structureId = created.body.id;

      const published = await patch('accountant', `/api/v1/fees/structures/${structureId}`, {
        status: 'active',
        version: created.body.version,
      });
      expect(published.status, JSON.stringify(published.body)).toBe(200);
      expect(published.body.status).toBe('active');
    });

    it('stores money as a two-decimal string, never a number', async () => {
      const response = await put('accountant', `/api/v1/fees/structures/${structureId}/items`, {
        items: [
          { feeHeadId: tuitionHeadId, amount: '1000.00', frequency: 'monthly', sortOrder: 1 },
          {
            feeHeadId: transportHeadId,
            amount: '500.00',
            frequency: 'monthly',
            isOptional: true,
            sortOrder: 2,
          },
        ],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.items).toHaveLength(2);
      for (const item of response.body.items) {
        expect(typeof item.amount).toBe('string');
        expect(item.amount).toMatch(/^\d+\.\d{2}$/);
      }
    });

    it('replaces items as a set, archiving what is no longer submitted', async () => {
      const withoutTransport = await put(
        'accountant',
        `/api/v1/fees/structures/${structureId}/items`,
        {
          items: [
            { feeHeadId: tuitionHeadId, amount: '1000.00', frequency: 'monthly', sortOrder: 1 },
          ],
        },
      );
      expect(withoutTransport.status).toBe(200);
      expect(withoutTransport.body.items).toHaveLength(1);

      // Put it back — the rest of the suite bills the optional transport line by choice.
      const restored = await put('accountant', `/api/v1/fees/structures/${structureId}/items`, {
        items: [
          { feeHeadId: tuitionHeadId, amount: '1000.00', frequency: 'monthly', sortOrder: 1 },
          {
            feeHeadId: transportHeadId,
            amount: '500.00',
            frequency: 'monthly',
            isOptional: true,
            sortOrder: 2,
          },
        ],
      });
      expect(restored.status).toBe(200);
      expect(restored.body.items).toHaveLength(2);
    });

    it('rejects an amount with more than two decimal places at the boundary', async () => {
      const response = await put('accountant', `/api/v1/fees/structures/${structureId}/items`, {
        items: [
          { feeHeadId: tuitionHeadId, amount: '1000.005', frequency: 'monthly', sortOrder: 1 },
        ],
      });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Generation and idempotency
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('invoice generation', () => {
    const january = {
      billingPeriodStart: '2026-01-01',
      billingPeriodEnd: '2026-01-31',
      issueDate: '2026-01-01',
      dueDate: '2026-01-10',
      frequencies: ['monthly'],
      includeOptional: false,
    };

    it('previews without writing anything', async () => {
      const preview = await post('accountant', '/api/v1/fees/invoices/preview', {
        academicYearId: tenantA.academicYearId,
        sectionId: tenantA.sectionId,
        ...january,
      });
      expect(preview.status, JSON.stringify(preview.body)).toBe(201);
      expect(preview.body.committed).toBe(false);
      expect(preview.body.invoices).toHaveLength(3);
      // Optional items are excluded unless asked for, so this is tuition only.
      expect(preview.body.totals.total).toBe('3000.00');

      const listed = await get('accountant', '/api/v1/fees/invoices');
      expect(listed.status).toBe(200);
      expect(listed.body.meta.total, 'the preview wrote invoices').toBe(0);
    });

    it('generates one invoice per enrolled student', async () => {
      const response = await post('accountant', '/api/v1/fees/invoices/generate', {
        academicYearId: tenantA.academicYearId,
        sectionId: tenantA.sectionId,
        ...january,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.committed).toBe(true);
      expect(response.body.invoices).toHaveLength(3);

      for (const invoice of response.body.invoices) {
        expect(invoice.id).toBeTruthy();
        expect(invoice.invoiceNumber).toMatch(/^INV-2026-\d{6}$/);
        expect(invoice.total).toBe('1000.00');
        januaryInvoiceIds.push(invoice.id);
      }
      expect(
        new Set(response.body.invoices.map((one: { invoiceNumber: string }) => one.invoiceNumber))
          .size,
      ).toBe(3);
    });

    it('is idempotent — a second run bills nobody twice', async () => {
      const rerun = await post('accountant', '/api/v1/fees/invoices/generate', {
        academicYearId: tenantA.academicYearId,
        sectionId: tenantA.sectionId,
        ...january,
      });
      expect(rerun.status).toBe(201);
      expect(rerun.body.invoices, 'a re-run created invoices').toHaveLength(0);
      expect(rerun.body.skipped).toHaveLength(3);
      for (const skip of rerun.body.skipped) {
        expect(skip.reason).toMatch(/already invoiced/i);
        expect(skip.existingInvoiceId).toBeTruthy();
      }

      const listed = await get('accountant', '/api/v1/fees/invoices', { pageSize: 100 });
      expect(listed.body.meta.total, 'the second run duplicated invoices').toBe(3);
    });

    it('enforces idempotency in the database, not only in the service', async () => {
      // The service's pre-check is a convenience. This asserts the control that survives two
      // concurrent runs: the partial unique index on (institution_id, generation_key).
      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query<{ generation_key: string }>(
          `select generation_key from invoices where institution_id = $1 limit 1`,
          [tenantA.institutionId],
        );
        const key = rows[0]!.generation_key;
        await expect(
          client.query(
            `insert into invoices (tenant_id, institution_id, student_id, academic_year_id,
                                   invoice_number, generation_key, billing_period_start,
                                   billing_period_end, issue_date, due_date, total, balance)
             values ($1,$2,$3,$4,'INV-DUP-1',$5,'2026-01-01','2026-01-31','2026-01-01','2026-01-10','1000.00','1000.00')`,
            [
              tenantA.tenantId,
              tenantA.institutionId,
              tenantA.studentIds[0],
              tenantA.academicYearId,
              key,
            ],
          ),
        ).rejects.toThrow(/invoices_generation_key|duplicate key/i);
      } finally {
        await client.end();
      }
    });

    it('refuses to generate without the invoice-generation permission', async () => {
      const response = await post('teacher', '/api/v1/fees/invoices/generate', {
        academicYearId: tenantA.academicYearId,
        sectionId: tenantA.sectionId,
        ...january,
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Concessions
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('concessions', () => {
    const february = {
      billingPeriodStart: '2026-02-01',
      billingPeriodEnd: '2026-02-28',
      issueDate: '2026-02-01',
      dueDate: '2026-02-10',
      frequencies: ['monthly'],
      includeOptional: false,
    };
    const concessionIds: Record<string, string> = {};

    async function requestConcession(
      studentIndex: number,
      body: Record<string, unknown>,
      key: string,
    ) {
      const response = await post('accountant', '/api/v1/fees/concessions', {
        studentId: tenantA.studentIds[studentIndex],
        feeHeadId: tuitionHeadId,
        validFrom: '2026-02-01',
        ...body,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('pending');
      concessionIds[key] = response.body.id;
      return response.body.id as string;
    }

    it('creates concessions as pending, whoever requests them', async () => {
      await requestConcession(
        0,
        { type: 'percentage', value: '10.00', reason: 'Sibling discount agreed with the office' },
        'a-percent',
      );
      await requestConcession(
        1,
        { type: 'percentage', value: '100.00', reason: 'Full merit scholarship for 2026' },
        'b-percent',
      );
      await requestConcession(
        1,
        { type: 'fixed', value: '500.00', reason: 'Additional hardship grant from the fund' },
        'b-fixed',
      );
      await requestConcession(
        2,
        { type: 'percentage', value: '10.00', reason: 'Staff child discount for the year' },
        'c-percent',
      );
      await requestConcession(
        2,
        { type: 'fixed', value: '100.00', reason: 'Transport hardship grant for the year' },
        'c-fixed',
      );
    });

    it('changes nothing on an invoice until it is approved', async () => {
      const preview = await post('accountant', '/api/v1/fees/invoices/preview', {
        academicYearId: tenantA.academicYearId,
        sectionId: tenantA.sectionId,
        ...february,
      });
      expect(preview.status).toBe(201);
      // Five pending concessions, none approved: everybody still pays the full 1000.
      expect(preview.body.totals.discountTotal).toBe('0.00');
      expect(preview.body.totals.total).toBe('3000.00');
    });

    it('refuses approval to the role that may only request', async () => {
      const response = await post(
        'accountant',
        `/api/v1/fees/concessions/${concessionIds['a-percent']}/decision`,
        { decision: 'approved', reason: 'Approving my own request, which should be refused' },
      );
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
      expect(JSON.stringify(response.body)).not.toContain('finance.discounts.approve');
    });

    it('refuses a self-approval even to someone holding both permissions', async () => {
      const requested = await post('owner', '/api/v1/fees/concessions', {
        studentId: tenantA.studentIds[0],
        feeHeadId: transportHeadId,
        type: 'percentage',
        value: '50.00',
        validFrom: '2026-03-01',
        reason: 'Owner-raised discount used to test separation of duties',
      });
      expect(requested.status).toBe(201);

      const selfApproved = await post(
        'owner',
        `/api/v1/fees/concessions/${requested.body.id}/decision`,
        { decision: 'approved', reason: 'Approving the request that I raised myself' },
      );
      expect(selfApproved.status).toBe(409);
      expect(selfApproved.body.error.code).toBe('CONFLICT');
    });

    it('lets the approver grant them', async () => {
      for (const key of ['a-percent', 'b-percent', 'b-fixed', 'c-percent', 'c-fixed']) {
        const response = await post(
          'principal',
          `/api/v1/fees/concessions/${concessionIds[key]}/decision`,
          { decision: 'approved', reason: 'Checked against the supporting documents on file' },
        );
        expect(response.status, `${key}: ${JSON.stringify(response.body)}`).toBe(201);
        expect(response.body.status).toBe('approved');
        expect(response.body.approvedBy).toBeTruthy();
        expect(response.body.approvedAt).toBeTruthy();
      }
    });

    it('applies percentages before fixed amounts, and never goes negative', async () => {
      const response = await post('accountant', '/api/v1/fees/invoices/generate', {
        academicYearId: tenantA.academicYearId,
        sectionId: tenantA.sectionId,
        ...february,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.invoices).toHaveLength(3);

      const byStudent = new Map<string, Record<string, string>>(
        response.body.invoices.map((one: { studentId: string }) => [one.studentId, one as never]),
      );

      // Student A: 10% of 1000 = 100 discount.
      const a = byStudent.get(tenantA.studentIds[0]!)!;
      expect(a['discountTotal']).toBe('100.00');
      expect(a['total']).toBe('900.00');

      // Student B: 100% (1000) plus a fixed 500 is 1500 of discount on a 1000 line. The floor
      // clamps it to 1000 — a bill can be reduced to nothing, never turned into a payout.
      const b = byStudent.get(tenantA.studentIds[1]!)!;
      expect(b['discountTotal']).toBe('1000.00');
      expect(b['total']).toBe('0.00');

      // Student C proves the order: percentage first, then fixed, both against the gross.
      // 10% of 1000 = 100, plus 100 fixed = 200. Applying the fixed amount first and then the
      // percentage on the remainder would give 190, which is the bug this asserts against.
      const c = byStudent.get(tenantA.studentIds[2]!)!;
      expect(c['discountTotal']).toBe('200.00');
      expect(c['total']).toBe('800.00');

      for (const invoice of response.body.invoices) {
        februaryInvoiceIds.push(invoice.id);
      }
    });

    it('leaves already-issued invoices untouched — an invoice is a document', async () => {
      const january = await get('accountant', `/api/v1/fees/invoices/${januaryInvoiceIds[0]}`);
      expect(january.status).toBe(200);
      expect(january.body.total, 'a later concession rewrote an issued invoice').toBe('1000.00');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Payments and allocation
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('payments', () => {
    let bulkPaymentId: string;
    let bulkPaymentVersion: number;

    it('refuses allocations that do not sum to the payment', async () => {
      const januaryForA = await findInvoice(tenantA.studentIds[0]!, '2026-01-01');
      const response = await post('accountant', '/api/v1/fees/payments', {
        studentId: tenantA.studentIds[0],
        amount: '100.00',
        method: 'cash',
        allocations: [{ invoiceId: januaryForA.id, amount: '60.00' }],
      });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(response.body)).toMatch(/add up to exactly/i);
    });

    it('refuses an allocation larger than what the invoice still owes', async () => {
      const januaryForA = await findInvoice(tenantA.studentIds[0]!, '2026-01-01');
      const response = await post('accountant', '/api/v1/fees/payments', {
        studentId: tenantA.studentIds[0],
        amount: '5000.00',
        method: 'cash',
        allocations: [{ invoiceId: januaryForA.id, amount: '5000.00' }],
      });
      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body)).toMatch(/outstanding/i);
    });

    it('allocates oldest-due-first by default and derives the invoice status', async () => {
      const response = await post('accountant', '/api/v1/fees/payments', {
        studentId: tenantA.studentIds[0],
        amount: '1500.00',
        method: 'bkash',
        reference: 'TXN-TEST-0001',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.payment.receiptNumber).toMatch(/^RCT-\d{4}-\d{6}$/);
      expect(response.body.unallocated).toBe('0.00');
      expect(response.body.allocations).toHaveLength(2);

      bulkPaymentId = response.body.payment.id;
      bulkPaymentVersion = response.body.payment.version;

      // January is due first, so it is settled first and in full.
      const january = await findInvoice(tenantA.studentIds[0]!, '2026-01-01');
      expect(january.paidTotal).toBe('1000.00');
      expect(january.balance).toBe('0.00');
      expect(january.status, 'a fully paid invoice must read as paid').toBe('paid');

      // February takes the remainder and is therefore partly paid, not paid.
      const february = await findInvoice(tenantA.studentIds[0]!, '2026-02-01');
      expect(february.paidTotal).toBe('500.00');
      expect(february.balance).toBe('400.00');
      expect(february.status).toBe('partially_paid');
    });

    it('writes an audit record whose money is a string, not a number', async () => {
      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query<{ new_value: Record<string, unknown> }>(
          `select new_value from audit_logs
           where tenant_id = $1 and module = 'fees' and resource_type = 'payment'
             and action = 'payment'
           order by occurred_at desc limit 1`,
          [tenantA.tenantId],
        );
        expect(rows.length, 'a payment was recorded with no audit row').toBeGreaterThan(0);
        const value = rows[0]!.new_value;
        expect(typeof value['amount']).toBe('string');
        expect(value['amount']).toBe('1500.00');
      } finally {
        await client.end();
      }
    });

    it('splits a proportional payment so the parts sum exactly to the whole', async () => {
      // Student C owes 1000.00 (January) and 800.00 (February) — 1800.00 in total. A 1000.00
      // proportional payment must divide as 555.56 / 444.44, which sums back exactly.
      const response = await post('accountant', '/api/v1/fees/payments', {
        studentId: tenantA.studentIds[2],
        amount: '1000.00',
        method: 'cash',
        strategy: 'proportional',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.allocations).toHaveLength(2);

      const parts = response.body.allocations.map((one: { amount: string }) => one.amount);
      expect(parts).toEqual(['555.56', '444.44']);
      expect(
        Money.sum(parts.map((part: string) => Money.fromDecimalString(part))).toDecimalString(),
        'a proportional split lost or invented a poisa',
      ).toBe('1000.00');
    });

    it('refuses to collect a payment without the collection permission', async () => {
      const response = await post('principal', '/api/v1/fees/payments', {
        studentId: tenantA.studentIds[0],
        amount: '10.00',
        method: 'cash',
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('refuses to void an invoice that has been paid against', async () => {
      const january = await findInvoice(tenantA.studentIds[0]!, '2026-01-01');
      const response = await post('owner', `/api/v1/fees/invoices/${january.id}/void`, {
        reason: 'Attempting to void a bill that has already been settled',
      });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('CONFLICT');
      expect(response.body.error.message).toMatch(/credit/i);
    });

    it('refuses voiding to a role without the void permission', async () => {
      const zeroInvoice = await findInvoice(tenantA.studentIds[1]!, '2026-02-01');
      const response = await post('accountant', `/api/v1/fees/invoices/${zeroInvoice.id}/void`, {
        reason: 'An accountant should not be able to cancel a bill unilaterally',
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('voids an unpaid invoice and keeps it out of the outstanding list', async () => {
      const target = await findInvoice(tenantA.studentIds[1]!, '2026-02-01');
      const response = await post('owner', `/api/v1/fees/invoices/${target.id}/void`, {
        reason: 'Raised against the wrong billing period and replaced',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('void');
      expect(response.body.voidedReason).toBeTruthy();
      expect(response.body.voidedBy).toBeTruthy();

      const outstanding = await get('accountant', '/api/v1/fees/invoices', {
        outstandingOnly: true,
        pageSize: 100,
      });
      const ids = outstanding.body.data.map((one: { id: string }) => one.id);
      expect(ids).not.toContain(target.id);
    });

    it('reverses a payment and recomputes every balance it touched', async () => {
      const response = await post('accountant', `/api/v1/fees/payments/${bulkPaymentId}/reverse`, {
        reason: 'Cheque returned unpaid by the bank on 12 February',
        version: bulkPaymentVersion,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.payment.status).toBe('reversed');
      expect(response.body.payment.reversalReason).toBeTruthy();
      expect(response.body.recomputedInvoiceIds).toHaveLength(2);

      const january = await findInvoice(tenantA.studentIds[0]!, '2026-01-01');
      expect(january.paidTotal, 'the reversal did not restore the balance').toBe('0.00');
      expect(january.balance).toBe('1000.00');
      expect(['issued', 'overdue']).toContain(january.status);

      const february = await findInvoice(tenantA.studentIds[0]!, '2026-02-01');
      expect(february.paidTotal).toBe('0.00');
      expect(february.balance).toBe('900.00');
    });

    it('never deletes a reversed payment', async () => {
      const listed = await get('accountant', '/api/v1/fees/payments', { pageSize: 100 });
      const reversed = listed.body.data.find((one: { id: string }) => one.id === bulkPaymentId);
      expect(reversed, 'the reversed payment disappeared from the record').toBeTruthy();
      expect(reversed.status).toBe('reversed');
      expect(reversed.amount).toBe('1500.00');
    });

    it('refuses to reverse the same payment twice', async () => {
      const response = await post('accountant', `/api/v1/fees/payments/${bulkPaymentId}/reverse`, {
        reason: 'Attempting a second reversal of the same receipt',
        version: bulkPaymentVersion + 1,
      });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('CONFLICT');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Late fines
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('late fines', () => {
    it('refuses to charge a fine to a head that is not a fine head', async () => {
      const response = await post('accountant', '/api/v1/fees/invoices/late-fines', {
        academicYearId: tenantA.academicYearId,
        fineFeeHeadId: tuitionHeadId,
        asOfDate: '2026-03-01',
        reason: 'Attempting to post a fine against the tuition head',
      });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('applies the structure rule to an overdue invoice, once', async () => {
      const january = await findInvoice(tenantA.studentIds[0]!, '2026-01-01');
      expect(january.balance).toBe('1000.00');

      const first = await post('accountant', '/api/v1/fees/invoices/late-fines', {
        academicYearId: tenantA.academicYearId,
        fineFeeHeadId: fineHeadId,
        asOfDate: '2026-03-01',
        invoiceIds: [january.id],
        reason: 'Monthly late-fine run for February, approved by the principal',
      });
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(first.body.applied).toHaveLength(1);
      // 2% of 1000.00, with a five-day grace period that expired on 15 January.
      expect(first.body.applied[0].fine).toBe('20.00');
      expect(first.body.totalFined).toBe('20.00');

      const after = await findInvoice(tenantA.studentIds[0]!, '2026-01-01');
      expect(after.fineTotal).toBe('20.00');
      expect(after.total).toBe('1020.00');
      expect(after.balance).toBe('1020.00');

      const second = await post('accountant', '/api/v1/fees/invoices/late-fines', {
        academicYearId: tenantA.academicYearId,
        fineFeeHeadId: fineHeadId,
        asOfDate: '2026-03-01',
        invoiceIds: [january.id],
        reason: 'Re-running the same late-fine date to prove it does not double charge',
      });
      expect(second.status).toBe(201);
      expect(second.body.applied, 'the same fine was charged twice').toHaveLength(0);
      expect(second.body.skipped[0].reason).toMatch(/already fined/i);
    });

    it('is refused to a role that cannot manage fees', async () => {
      const response = await post('principal', '/api/v1/fees/invoices/late-fines', {
        academicYearId: tenantA.academicYearId,
        fineFeeHeadId: fineHeadId,
        asOfDate: '2026-03-01',
        reason: 'A principal has no authority to post financial charges',
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Reports
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('reports', () => {
    it('agrees with the invoice list on what is outstanding', async () => {
      const listed = await get('accountant', '/api/v1/fees/invoices', {
        outstandingOnly: true,
        pageSize: 200,
      });
      expect(listed.status).toBe(200);
      const fromInvoices = Money.sum(
        listed.body.data.map((one: { balance: string }) => Money.fromDecimalString(one.balance)),
      );

      const report = await get('accountant', '/api/v1/fees/reports/outstanding', {
        academicYearId: tenantA.academicYearId,
        groupBy: 'section',
      });
      expect(report.status, JSON.stringify(report.body)).toBe(200);
      expect(report.body.rows.length).toBeGreaterThan(0);
      expect(report.body.rows[0].sectionName).toBe('A');
      expect(
        report.body.totals.outstanding,
        'the SQL aggregate disagrees with the invoice rows',
      ).toBe(fromInvoices.toDecimalString());
    });

    it('rolls up to the class when asked', async () => {
      const report = await get('accountant', '/api/v1/fees/reports/outstanding', {
        academicYearId: tenantA.academicYearId,
        groupBy: 'class',
      });
      expect(report.status).toBe(200);
      expect(report.body.rows[0].sectionId).toBeNull();
      expect(report.body.rows[0].classLevelName).toBe('Class 6');
    });

    it('summarises collections by method, counting only completed payments', async () => {
      const report = await get('accountant', '/api/v1/fees/reports/collections', {
        from: '2020-01-01',
        to: '2030-12-31',
      });
      expect(report.status, JSON.stringify(report.body)).toBe(200);

      // The 1500.00 bKash payment was reversed, so only the 1000.00 cash payment counts.
      const methods = new Map<string, string>(
        report.body.byMethod.map((row: { method: string; amount: string }) => [
          row.method,
          row.amount,
        ]),
      );
      expect(methods.get('bkash')).toBeUndefined();
      expect(report.body.totalAmount).toBe('1000.00');
    });

    it('refuses reports to a role without the reporting permission', async () => {
      const response = await get('teacher', '/api/v1/fees/reports/collections', {
        from: '2026-01-01',
        to: '2026-12-31',
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Guardian scope
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('guardian access', () => {
    it('sees only their own child’s invoices', async () => {
      const response = await get('guardian1', '/api/v1/fees/invoices', { pageSize: 100 });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.meta.total).toBeGreaterThan(0);
      for (const invoice of response.body.data) {
        expect(invoice.studentId, 'a guardian was shown another family’s invoice').toBe(
          tenantA.studentIds[0],
        );
      }
    });

    it('gets a 404, not a 403, for another family’s invoice', async () => {
      const otherFamily = await findInvoice(tenantA.studentIds[2]!, '2026-01-01');
      const response = await request(app.getHttpServer())
        .get(`/api/v1/fees/invoices/${otherFamily.id}`)
        .set('Authorization', `Bearer ${tokens['guardian1']}`)
        .set('x-institution-id', tenantA.institutionId);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('reads their own child’s ledger and nobody else’s', async () => {
      const own = await get('guardian1', `/api/v1/fees/students/${tenantA.studentIds[0]}/ledger`);
      expect(own.status, JSON.stringify(own.body)).toBe(200);
      expect(own.body.entries.length).toBeGreaterThan(0);
      // The running balance is accumulated with Money, so every figure is a decimal string.
      for (const entry of own.body.entries) {
        expect(entry.balance).toMatch(/^-?\d+\.\d{2}$/);
      }

      const other = await get('guardian1', `/api/v1/fees/students/${tenantA.studentIds[2]}/ledger`);
      expect(other.status).toBe(404);
    });

    it('cannot record a payment against their own child', async () => {
      const response = await post('guardian1', '/api/v1/fees/payments', {
        studentId: tenantA.studentIds[0],
        amount: '10.00',
        method: 'cash',
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Tenant isolation
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('tenant isolation', () => {
    it('another tenant cannot read an invoice by its exact id', async () => {
      const target = await findInvoice(tenantA.studentIds[0]!, '2026-01-01');

      const response = await request(app.getHttpServer())
        .get(`/api/v1/fees/invoices/${target.id}`)
        .set('Authorization', `Bearer ${tokens['otherAccountant']}`)
        .set('x-institution-id', tenantB.institutionId);

      // 404, not 403: confirming the record exists elsewhere is itself a leak.
      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain(target.invoiceNumber);
    });

    it('another tenant cannot borrow the institution header', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/fees/invoices')
        .set('Authorization', `Bearer ${tokens['otherAccountant']}`)
        .set('x-institution-id', tenantA.institutionId);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('another tenant’s own list is empty rather than leaky', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/fees/invoices')
        .set('Authorization', `Bearer ${tokens['otherAccountant']}`)
        .set('x-institution-id', tenantB.institutionId);

      expect(response.status).toBe(200);
      expect(response.body.meta.total).toBe(0);
      expect(response.body.data).toEqual([]);
    });

    it('the fee tables all carry forced row-level security', async () => {
      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query<{ relname: string }>(
          `select c.relname
             from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public'
              and c.relkind = 'r'
              and c.relname in ('fee_heads','fee_structures','fee_structure_items',
                                'student_fee_assignments','fee_concessions','invoices',
                                'invoice_lines','payments','payment_allocations')
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

    it('the database refuses an invoice stamped with another tenant’s id', async () => {
      // Connects as `shikkha_app` — the same unprivileged role the API uses — so this is what
      // an attacker with SQL execution inside the application would actually be able to do.
      const client = new Client({ connectionString: TEST_APP_DATABASE_URL });
      await client.connect();
      try {
        await client.query('begin');
        await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantB.tenantId]);
        await expect(
          client.query(
            `insert into invoices (tenant_id, institution_id, student_id, academic_year_id,
                                   invoice_number, billing_period_start, billing_period_end,
                                   issue_date, due_date, total, balance)
             values ($1,$2,$3,$4,'INV-XT-1','2026-01-01','2026-01-31','2026-01-01','2026-01-10','1.00','1.00')`,
            [
              tenantA.tenantId,
              tenantA.institutionId,
              tenantA.studentIds[0],
              tenantA.academicYearId,
            ],
          ),
        ).rejects.toThrow(/row-level security/i);
      } finally {
        await client.query('rollback').catch(() => undefined);
        await client.end();
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Fetch one student's invoice for a billing period through the API.
   *
   * Deliberately goes over HTTP rather than reading the table directly: a test that asserts a
   * balance the API would never return is asserting the wrong thing.
   */
  async function findInvoice(
    studentId: string,
    billingPeriodStart: string,
  ): Promise<Record<string, string>> {
    const response = await get('accountant', '/api/v1/fees/invoices', {
      studentId,
      pageSize: 100,
      includeArchived: false,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const found = response.body.data.find(
      (one: { billingPeriodStart: string }) => one.billingPeriodStart === billingPeriodStart,
    );
    expect(found, `no invoice for ${studentId} starting ${billingPeriodStart}`).toBeTruthy();
    return found as Record<string, string>;
  }
});
