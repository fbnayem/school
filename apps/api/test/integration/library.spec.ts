/**
 * Library integration suite (Phase 17).
 *
 * This file holds the circulation invariants, not proof that routes return 200. Each block
 * corresponds to a rule that, if it broke in production, would either lose a school its books
 * or charge a family money nobody decided they owe:
 *
 *  - at most one live loan per copy, enforced by the DATABASE — the partial unique index
 *    `library_loans_copy_active_key` is asserted with a direct SQL insert that bypasses the
 *    service entirely,
 *  - the borrowing limit is enforced at issue time,
 *  - a suspended or validity-expired member cannot borrow,
 *  - a fine is an explicit, audited assessment, never a computation on read, and the run is
 *    idempotent per loan per day (`library_fines_loan_day_key`, again asserted in SQL),
 *  - waiving needs the permission, a mandatory reason, and a person other than the assessor,
 *    and `library_fines_waive_recorded` refuses an unaccountable waiver even in raw SQL,
 *  - a loan cannot be renewed while a reservation queue exists,
 *  - fulfilling a reservation advances the queue atomically in the same transaction,
 *  - a student sees only their own loans, derived from identity rather than input,
 *  - and none of it crosses a tenant boundary.
 *
 * Everything runs over HTTP through the real guards, interceptors and database, because the
 * properties under test live precisely in the parts a stub would replace.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Client } from 'pg';
import argon2 from 'argon2';
import { uuidv7 } from '@shikkha/shared';
import {
  createTestApp,
  seedTenant,
  testClient,
  truncateAll,
  TEST_APP_DATABASE_URL,
  TEST_PASSWORD,
  type SeededTenant,
} from '../helpers/test-app';

describe('Library management', () => {
  let app: INestApplication;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
  const tokens: Record<string, string> = {};

  // Ids captured as the suite builds a real catalogue and circulates it.
  let titleId: string;
  const copyIds: string[] = [];
  let memberAId: string;
  let memberBId: string;
  let memberCId: string;
  let memberBVersion: number;
  let loan1Id: string; // copy 1 → member A, later backdated and fined
  let loan2Id: string; // copy 2 → member A, later returned into the reservation hold
  let loan3Id: string; // copy 2 → member B, the renewal subject
  let overdueFineId: string; // the 50.00 assessment on loan 1
  let reservationCId: string;

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
    tenantA = await seedTenant('liba', { students: 3 });
    tenantB = await seedTenant('libb', { students: 1 });

    const client = testClient();
    await client.connect();
    try {
      const passwordHash = await argon2.hash(TEST_PASSWORD, {
        type: argon2.argon2id,
        memoryCost: 8192,
        timeCost: 2,
        parallelism: 1,
      });

      // A librarian in each tenant. The harness seeds the role but no user holding it.
      for (const [tenant, email] of [
        [tenantA, 'librarian@liba.test'],
        [tenantB, 'librarian@libb.test'],
      ] as const) {
        const userId = uuidv7();
        await client.query(
          `insert into users (id, tenant_id, email, password_hash, full_name_en, status, email_verified_at)
           values ($1,$2,$3,$4,'Test Librarian','active',now())`,
          [userId, tenant.tenantId, email, passwordHash],
        );
        await client.query(
          `insert into user_roles (id, tenant_id, user_id, role_id, institution_id)
           values ($1,$2,$3,$4,$5)`,
          [uuidv7(), tenant.tenantId, userId, tenant.roleIds['librarian'], tenant.institutionId],
        );
      }

      // A student login. The harness seeds student rows without user accounts; `my-loans`
      // needs a student principal, which resolves via students.user_id.
      const studentUserId = uuidv7();
      await client.query(
        `insert into users (id, tenant_id, email, password_hash, full_name_en, status, email_verified_at)
         values ($1,$2,'student1@liba.test',$3,'liba Student 1','active',now())`,
        [studentUserId, tenantA.tenantId, passwordHash],
      );
      await client.query(
        `insert into user_roles (id, tenant_id, user_id, role_id, institution_id)
         values ($1,$2,$3,$4,$5)`,
        [
          uuidv7(),
          tenantA.tenantId,
          studentUserId,
          tenantA.roleIds['student'],
          tenantA.institutionId,
        ],
      );
      await client.query(`update students set user_id = $1 where id = $2`, [
        studentUserId,
        tenantA.studentIds[0],
      ]);
    } finally {
      await client.end();
    }

    for (const key of ['owner', 'principal', 'teacher']) {
      tokens[key] = await login(tenantA.users[key]!.email);
    }
    tokens['librarian'] = await login('librarian@liba.test');
    tokens['student1'] = await login('student1@liba.test');
    tokens['otherLibrarian'] = await login('librarian@libb.test');
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Catalogue and membership setup — asserting the derived facts along the way
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('catalogue setup', () => {
    it('saves the circulation policy with money as a decimal string', async () => {
      const response = await put('librarian', '/api/v1/library/settings', {
        finePerDay: '5.00',
        maxRenewals: 1,
        reservationHoldDays: 3,
        defaultLoanDays: 14,
        defaultMaxBooks: 2,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(typeof response.body.finePerDay).toBe('string');
      expect(response.body.finePerDay).toBe('5.00');
      expect(response.body.defaultMaxBooks).toBe(2);
    });

    it('creates a title and accessions three copies under the ACC- register', async () => {
      const title = await post('librarian', '/api/v1/library/titles', {
        title: 'Physics for Class 9-10',
        author: 'NCTB',
        language: 'bangla',
      });
      expect(title.status, JSON.stringify(title.body)).toBe(201);
      titleId = title.body.id;

      const copies = await post('librarian', '/api/v1/library/copies', {
        titleId,
        count: 3,
        cost: '250.00',
      });
      expect(copies.status, JSON.stringify(copies.body)).toBe(201);
      expect(copies.body).toHaveLength(3);
      expect(copies.body.map((one: { accessionNumber: string }) => one.accessionNumber)).toEqual([
        'ACC-000001',
        'ACC-000002',
        'ACC-000003',
      ]);
      for (const copy of copies.body) {
        expect(typeof copy.cost).toBe('string');
        expect(copy.cost).toBe('250.00');
        expect(copy.status).toBe('available');
        copyIds.push(copy.id);
      }
    });

    it('derives total_copies from the copy rows, never from the client', async () => {
      const response = await get('librarian', `/api/v1/library/titles/${titleId}`);
      expect(response.status).toBe(200);
      expect(response.body.totalCopies).toBe(3);
      expect(response.body.copies).toHaveLength(3);
    });

    it('creates memberships that inherit the policy defaults', async () => {
      const bodies = [0, 1, 2].map((index) => ({
        memberType: 'student',
        studentId: tenantA.studentIds[index],
      }));
      const created: string[] = [];
      for (const body of bodies) {
        const response = await post('librarian', '/api/v1/library/members', body);
        expect(response.status, JSON.stringify(response.body)).toBe(201);
        expect(response.body.maxBooks, 'the policy default was not copied').toBe(2);
        created.push(response.body.id);
      }
      [memberAId, memberBId, memberCId] = created as [string, string, string];

      const listed = await get('librarian', '/api/v1/library/members', { pageSize: 10 });
      expect(listed.body.data.map((one: { cardNumber: string }) => one.cardNumber)).toEqual([
        'LM-000001',
        'LM-000002',
        'LM-000003',
      ]);
      memberBVersion = 1;
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // One live loan per copy — a property of the database, not the service
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('single active loan per copy', () => {
    it('issues a copy to a member', async () => {
      const response = await post('librarian', '/api/v1/library/loans', {
        copyId: copyIds[0],
        memberId: memberAId,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.accessionNumber).toBe('ACC-000001');
      expect(response.body.status).toBe('issued');
      loan1Id = response.body.id;
    });

    it('the DATABASE refuses a second live loan on the same copy, bypassing the service', async () => {
      // A direct insert as the table owner — no service pre-check, no row lock, no RLS.
      // What survives is the partial unique index the migration created:
      //   library_loans_copy_active_key on (copy_id) where returned_at is null.
      const client = testClient();
      await client.connect();
      try {
        await expect(
          client.query(
            `insert into library_loans (tenant_id, institution_id, copy_id, member_id, due_on)
             values ($1,$2,$3,$4,current_date + 14)`,
            [tenantA.tenantId, tenantA.institutionId, copyIds[0], memberBId],
          ),
        ).rejects.toThrow(/library_loans_copy_active_key|duplicate key/i);

        // The same insert with returned_at set is history, not a live loan, and is accepted —
        // proving the index is partial on `returned_at is null`, exactly as the migration
        // declares it. Rolled back so it leaves no trace in the register.
        await client.query('begin');
        await client.query(
          `insert into library_loans (tenant_id, institution_id, copy_id, member_id, due_on,
                                      issued_at, returned_at, status)
           values ($1,$2,$3,$4,current_date, now() - interval '2 days', now(), 'returned')`,
          [tenantA.tenantId, tenantA.institutionId, copyIds[0], memberBId],
        );
        await client.query('rollback');
      } finally {
        await client.end();
      }
    });

    it('the service surfaces the same collision as a 409, not a 500', async () => {
      const response = await post('librarian', '/api/v1/library/loans', {
        copyId: copyIds[0],
        memberId: memberBId,
      });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('CONFLICT');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Borrowing limits and member eligibility
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('borrowing limits and eligibility', () => {
    it('enforces the member borrowing limit at issue time', async () => {
      const second = await post('librarian', '/api/v1/library/loans', {
        copyId: copyIds[1],
        memberId: memberAId,
      });
      expect(second.status, JSON.stringify(second.body)).toBe(201);
      loan2Id = second.body.id;

      // Member A now has 2 of 2 allowed books out.
      const third = await post('librarian', '/api/v1/library/loans', {
        copyId: copyIds[2],
        memberId: memberAId,
      });
      expect(third.status).toBe(409);
      expect(third.body.error.code).toBe('CONFLICT');
      expect(third.body.error.message).toMatch(/2 of 2 allowed/);
    });

    it('refuses a suspended member', async () => {
      const suspended = await patch('librarian', `/api/v1/library/members/${memberBId}`, {
        status: 'suspended',
        version: memberBVersion,
      });
      expect(suspended.status, JSON.stringify(suspended.body)).toBe(200);
      memberBVersion = suspended.body.version;

      const refused = await post('librarian', '/api/v1/library/loans', {
        copyId: copyIds[2],
        memberId: memberBId,
      });
      expect(refused.status).toBe(409);
      expect(refused.body.error.message).toMatch(/suspended/i);
    });

    it('refuses a member whose validity date has passed', async () => {
      const reinstated = await patch('librarian', `/api/v1/library/members/${memberBId}`, {
        status: 'active',
        validUntil: '2020-01-01',
        version: memberBVersion,
      });
      expect(reinstated.status, JSON.stringify(reinstated.body)).toBe(200);
      memberBVersion = reinstated.body.version;

      const refused = await post('librarian', '/api/v1/library/loans', {
        copyId: copyIds[2],
        memberId: memberBId,
      });
      expect(refused.status).toBe(409);
      expect(refused.body.error.message).toMatch(/validity/i);

      // Fully reinstate member B for the reservation flow below.
      const restored = await patch('librarian', `/api/v1/library/members/${memberBId}`, {
        validUntil: null,
        version: memberBVersion,
      });
      expect(restored.status).toBe(200);
      memberBVersion = restored.body.version;
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Fines: explicit, audited, idempotent — never computed on read
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('fine assessment', () => {
    it('shows an overdue loan with no fine until somebody assesses one', async () => {
      // Age loan 1 in SQL: ten whole days overdue as of the fixed assessment date below.
      // The issue timestamp (and created_at) move with the due date, so the row stays
      // internally consistent — library_loans_return_after_issue compares against issued_at.
      const client = testClient();
      await client.connect();
      try {
        await client.query(
          `update library_loans
              set due_on = '2026-08-01',
                  issued_at = timestamptz '2026-07-18 10:00:00+06',
                  created_at = timestamptz '2026-07-18 10:00:00+06'
            where id = $1`,
          [loan1Id],
        );
      } finally {
        await client.end();
      }

      const fines = await get('librarian', '/api/v1/library/fines', { pageSize: 10 });
      expect(fines.status).toBe(200);
      expect(fines.body.meta.total, 'a fine existed before any assessment ran').toBe(0);

      const loans = await get('librarian', '/api/v1/library/loans', { memberId: memberAId });
      const loan1 = loans.body.data.find((one: { id: string }) => one.id === loan1Id);
      expect(loan1.fineAmount, 'the fine was computed on read').toBe('0.00');
    });

    it('assesses rate × whole overdue days as an explicit, reasoned action', async () => {
      const response = await post('librarian', '/api/v1/library/fines/assess', {
        asOfDate: '2026-08-11',
        reason: 'Weekly overdue assessment run, approved by the head teacher',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.assessed).toHaveLength(1);
      expect(response.body.assessed[0].loanId).toBe(loan1Id);
      // 5.00 per day × 10 whole days (2026-08-01 → 2026-08-11), as a string, never a float.
      expect(response.body.assessed[0].amount).toBe('50.00');
      expect(response.body.totalAssessed).toBe('50.00');
      overdueFineId = response.body.assessed[0].fineId;

      const loans = await get('librarian', '/api/v1/library/loans', { memberId: memberAId });
      const loan1 = loans.body.data.find((one: { id: string }) => one.id === loan1Id);
      expect(loan1.fineAmount).toBe('50.00');
      expect(loan1.status).toBe('overdue');
    });

    it('writes an audit record for the run, with money as a string', async () => {
      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query<{ new_value: Record<string, unknown> }>(
          `select new_value from audit_logs
            where tenant_id = $1 and module = 'library' and resource_type = 'library_fine_run'
            order by occurred_at desc limit 1`,
          [tenantA.tenantId],
        );
        expect(rows.length, 'the assessment ran with no audit row').toBeGreaterThan(0);
        const value = rows[0]!.new_value;
        expect(typeof value['totalAssessed']).toBe('string');
        expect(value['totalAssessed']).toBe('50.00');
        expect(value['assessedCount']).toBe(1);
      } finally {
        await client.end();
      }
    });

    it('is idempotent — re-running the same date charges nothing more', async () => {
      const rerun = await post('librarian', '/api/v1/library/fines/assess', {
        asOfDate: '2026-08-11',
        reason: 'Re-running the same date to prove nothing double-charges',
      });
      expect(rerun.status).toBe(201);
      expect(rerun.body.assessed, 'the same overdue days were charged twice').toHaveLength(0);
      expect(rerun.body.skipped.map((one: { loanId: string }) => one.loanId)).toContain(loan1Id);
      expect(rerun.body.totalAssessed).toBe('0.00');
    });

    it('the DATABASE refuses a same-day duplicate assessment row outright', async () => {
      // library_fines_loan_day_key on (loan_id, assessed_on) where not is_replacement —
      // the control that holds even if two assessment runs race past the service's check.
      const client = testClient();
      await client.connect();
      try {
        await expect(
          client.query(
            `insert into library_fines (tenant_id, institution_id, loan_id, member_id,
                                        amount, reason, assessed_on)
             values ($1,$2,$3,$4,'5.00','Racing duplicate of the daily run','2026-08-11')`,
            [tenantA.tenantId, tenantA.institutionId, loan1Id, memberAId],
          ),
        ).rejects.toThrow(/library_fines_loan_day_key|duplicate key/i);
      } finally {
        await client.end();
      }
    });
  });

  describe('waiving a fine', () => {
    it('requires a reason — a waiver with no why is refused before it happens', async () => {
      const response = await post('owner', `/api/v1/library/fines/${overdueFineId}/waive`, {});
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('requires the permission, and does not name it in the refusal', async () => {
      const response = await post('teacher', `/api/v1/library/fines/${overdueFineId}/waive`, {
        reason: 'A teacher attempting to forgive a fine they cannot touch',
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
      expect(JSON.stringify(response.body)).not.toContain('library.fines.manage');
    });

    it('refuses the person who assessed the fine — separation of duties on the data', async () => {
      const response = await post('librarian', `/api/v1/library/fines/${overdueFineId}/waive`, {
        reason: 'The assessor forgiving their own assessment, which must be refused',
      });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('CONFLICT');
    });

    it('the DATABASE refuses a waiver with no named waiver and reason', async () => {
      // library_fines_waive_recorded: status = 'waived' requires waived_by and waived_reason.
      const client = testClient();
      await client.connect();
      try {
        await expect(
          client.query(`update library_fines set status = 'waived' where id = $1`, [overdueFineId]),
        ).rejects.toThrow(/library_fines_waive_recorded/i);
      } finally {
        await client.end();
      }
    });

    it('waives with who, when and why on the row, and recomputes the loan total', async () => {
      const response = await post('owner', `/api/v1/library/fines/${overdueFineId}/waive`, {
        reason: 'Hardship waiver approved by the managing committee on appeal',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('waived');
      expect(response.body.waivedBy).toBe(tenantA.users['owner']!.id);
      expect(response.body.waivedAt).toBeTruthy();
      expect(response.body.waivedReason).toMatch(/hardship/i);
      // The row survives — a waived fine is forgiven, not erased.
      expect(response.body.amount).toBe('50.00');

      const loans = await get('librarian', '/api/v1/library/loans', { memberId: memberAId });
      const loan1 = loans.body.data.find((one: { id: string }) => one.id === loan1Id);
      expect(loan1.fineAmount, 'the loan total still counts the waived fine').toBe('0.00');
      expect(loan1.fineWaivedBy).toBe(tenantA.users['owner']!.id);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Reservations: renewal refusal, atomic queue advance on fulfilment
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('reservations and renewals', () => {
    it('queues two members in order', async () => {
      const first = await post('librarian', '/api/v1/library/reservations', {
        titleId,
        memberId: memberBId,
      });
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(first.body.queuePosition).toBe(1);

      const second = await post('librarian', '/api/v1/library/reservations', {
        titleId,
        memberId: memberCId,
      });
      expect(second.status).toBe(201);
      expect(second.body.queuePosition).toBe(2);
      reservationCId = second.body.id;
    });

    it('refuses to renew any loan of the title while the queue exists', async () => {
      const response = await post('librarian', `/api/v1/library/loans/${loan2Id}/renew`, {});
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('CONFLICT');
      expect(response.body.error.message).toMatch(/reservation queue/i);
    });

    it('holds a returned copy for the queue head instead of the open shelf', async () => {
      const response = await post('librarian', `/api/v1/library/loans/${loan2Id}/return`, {});
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.copyStatus).toBe('reserved');
      expect(response.body.heldForMemberId).toBe(memberBId);
    });

    it('refuses to issue the held copy to anyone but the queue head', async () => {
      const response = await post('librarian', '/api/v1/library/loans', {
        copyId: copyIds[1],
        memberId: memberCId,
      });
      expect(response.status).toBe(409);
      expect(response.body.error.message).toMatch(/held for the next member/i);
    });

    it('fulfils the head and advances the rest of the queue in the same transaction', async () => {
      const issued = await post('librarian', '/api/v1/library/loans', {
        copyId: copyIds[1],
        memberId: memberBId,
      });
      expect(issued.status, JSON.stringify(issued.body)).toBe(201);
      loan3Id = issued.body.id;

      const active = await get('librarian', '/api/v1/library/reservations', {
        titleId,
        status: 'active',
      });
      expect(active.status).toBe(200);
      expect(active.body.data).toHaveLength(1);
      expect(active.body.data[0].memberId).toBe(memberCId);
      expect(active.body.data[0].queuePosition, 'the queue did not close ranks on fulfilment').toBe(
        1,
      );

      const fulfilled = await get('librarian', '/api/v1/library/reservations', {
        titleId,
        status: 'fulfilled',
      });
      expect(fulfilled.body.data).toHaveLength(1);
      expect(fulfilled.body.data[0].memberId).toBe(memberBId);
    });

    it('renews once the queue is empty, up to the policy cap', async () => {
      const cancelled = await post(
        'librarian',
        `/api/v1/library/reservations/${reservationCId}/cancel`,
        { reason: 'The member found a copy elsewhere and asked to leave the queue' },
      );
      expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(201);
      expect(cancelled.body.status).toBe('cancelled');

      const renewed = await post('librarian', `/api/v1/library/loans/${loan3Id}/renew`, {});
      expect(renewed.status, JSON.stringify(renewed.body)).toBe(201);
      expect(renewed.body.renewalCount).toBe(1);

      // maxRenewals is 1 in the saved policy.
      const again = await post('librarian', `/api/v1/library/loans/${loan3Id}/renew`, {});
      expect(again.status).toBe(409);
      expect(again.body.error.message).toMatch(/limit is 1/);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Self-service: identity-scoped, no parameter to abuse
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('self-service', () => {
    it('a student sees exactly their own loans and fines', async () => {
      const response = await get('student1', '/api/v1/library/my-loans');
      expect(response.status, JSON.stringify(response.body)).toBe(200);

      expect(response.body.members).toHaveLength(1);
      expect(response.body.members[0].id).toBe(memberAId);

      // Loans 1 and 2 belong to member A; loan 3 (member B) must be invisible.
      const loanIds = response.body.loans.map((one: { id: string }) => one.id);
      expect(loanIds).toContain(loan1Id);
      expect(loanIds).toContain(loan2Id);
      expect(loanIds, 'a student was shown another member’s loan').not.toContain(loan3Id);
      for (const loan of response.body.loans) {
        expect(loan.memberId).toBe(memberAId);
      }

      // Their waived fine is visible as history, money still a string.
      expect(response.body.fines).toHaveLength(1);
      expect(response.body.fines[0].id).toBe(overdueFineId);
      expect(response.body.fines[0].amount).toBe('50.00');
      expect(response.body.fines[0].status).toBe('waived');
    });

    it('a student cannot reach the staff loan list at all', async () => {
      const response = await get('student1', '/api/v1/library/loans');
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('a caller with no membership gets an empty result, not an error', async () => {
      const response = await get('teacher', '/api/v1/library/my-loans');
      expect(response.status).toBe(200);
      expect(response.body.members).toEqual([]);
      expect(response.body.loans).toEqual([]);
      expect(response.body.fines).toEqual([]);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Permission denials
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('permission enforcement', () => {
    it('refuses catalogue writes to a role with no library authority', async () => {
      const response = await post('teacher', '/api/v1/library/titles', {
        title: 'Sneaked-in title',
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
      expect(JSON.stringify(response.body)).not.toContain('library.catalog.manage');
    });

    it('view-only catalogue access does not extend to circulation', async () => {
      // The principal preset holds library.catalog.view and nothing else in the module.
      const browse = await get('principal', '/api/v1/library/titles');
      expect(browse.status).toBe(200);

      const issue = await post('principal', '/api/v1/library/loans', {
        copyId: copyIds[2],
        memberId: memberAId,
      });
      expect(issue.status).toBe(403);
      expect(issue.body.error.code).toBe('FORBIDDEN');
    });

    it('refuses a fine assessment to a student', async () => {
      const response = await post('student1', '/api/v1/library/fines/assess', {
        reason: 'A student attempting to run the fine assessment endpoint',
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Tenant isolation
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('tenant isolation', () => {
    it('another tenant cannot read a title by its exact id — 404, never 403', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/library/titles/${titleId}`)
        .set('Authorization', `Bearer ${tokens['otherLibrarian']}`)
        .set('x-institution-id', tenantB.institutionId);

      // 404, not 403: confirming the record exists elsewhere is itself a leak.
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain('Physics for Class 9-10');
    });

    it('another tenant cannot borrow the institution header', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/library/titles')
        .set('Authorization', `Bearer ${tokens['otherLibrarian']}`)
        .set('x-institution-id', tenantA.institutionId);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('another tenant’s catalogue is empty rather than leaky', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/library/titles')
        .set('Authorization', `Bearer ${tokens['otherLibrarian']}`)
        .set('x-institution-id', tenantB.institutionId);

      expect(response.status).toBe(200);
      expect(response.body.meta.total).toBe(0);
      expect(response.body.data).toEqual([]);
    });

    it('every library table carries forced row-level security', async () => {
      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query<{ relname: string }>(
          `select c.relname
             from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public'
              and c.relkind = 'r'
              and c.relname in ('library_settings','library_categories','library_titles',
                                'library_copies','library_members','library_loans',
                                'library_reservations','library_fines')
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

    it('the database refuses a title stamped with another tenant’s id', async () => {
      // Connects as `shikkha_app` — the same unprivileged role the API uses — so this is what
      // an attacker with SQL execution inside the application would actually be able to do.
      const client = new Client({ connectionString: TEST_APP_DATABASE_URL });
      await client.connect();
      try {
        await client.query('begin');
        await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantB.tenantId]);
        await expect(
          client.query(
            `insert into library_titles (tenant_id, institution_id, title)
             values ($1,$2,'Cross-tenant write attempt')`,
            [tenantA.tenantId, tenantA.institutionId],
          ),
        ).rejects.toThrow(/row-level security/i);
      } finally {
        await client.query('rollback').catch(() => undefined);
        await client.end();
      }
    });
  });
});
