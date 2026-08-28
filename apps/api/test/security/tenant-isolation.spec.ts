/**
 * Tenant isolation suite (brief §49).
 *
 * Two structurally identical tenants are created. Tenant B's administrator — a fully
 * authenticated user with broad permissions *inside their own tenant* — then attempts to reach
 * every kind of Tenant A record, by id, by list, by search, and by write.
 *
 * A failure in this file is release-blocking. It is not "a bug"; it is a data breach.
 *
 * The attacks are deliberately the realistic ones:
 *  - direct object reference by a known id (IDOR),
 *  - a forged `x-institution-id` header pointing at the other tenant,
 *  - a write stamped with the other tenant's id,
 *  - a search term that only matches the other tenant's rows,
 *  - and the same attempts made directly against the database as the application role, to
 *    prove the guard is not the only thing standing in the way.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Client } from 'pg';
import {
  createTestApp,
  seedTenant,
  testClient,
  truncateAll,
  TEST_APP_DATABASE_URL,
  TEST_PASSWORD,
  type SeededTenant,
} from '../helpers/test-app';

describe('Tenant isolation', () => {
  let app: INestApplication;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
  let tokenA: string;
  let tokenB: string;

  async function login(email: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: email, password: TEST_PASSWORD });
    expect(response.status, `login failed for ${email}: ${JSON.stringify(response.body)}`).toBe(
      200,
    );
    return response.body.accessToken as string;
  }

  beforeAll(async () => {
    app = await createTestApp();
    await truncateAll();
    tenantA = await seedTenant('alpha', { students: 5 });
    tenantB = await seedTenant('bravo', { students: 3 });
    tokenA = await login(tenantA.users['admin']!.email);
    tokenB = await login(tenantB.users['admin']!.email);
  });

  afterAll(async () => {
    await app?.close();
  });

  // ── Baseline: each tenant can see its own data ─────────────────────────────────────

  it('each tenant sees exactly its own students', async () => {
    const a = await request(app.getHttpServer())
      .get('/api/v1/students')
      .set('Authorization', `Bearer ${tokenA}`);
    const b = await request(app.getHttpServer())
      .get('/api/v1/students')
      .set('Authorization', `Bearer ${tokenB}`);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.meta.total).toBe(5);
    expect(b.body.meta.total).toBe(3);

    const aIds = a.body.data.map((s: { id: string }) => s.id);
    const bIds = b.body.data.map((s: { id: string }) => s.id);
    // The decisive assertion: no id appears in both result sets.
    expect(aIds.filter((id: string) => bIds.includes(id))).toEqual([]);
  });

  // ── IDOR: fetch another tenant's record by its exact id ────────────────────────────

  const idorCases: Array<{ label: string; path: (t: SeededTenant) => string }> = [
    { label: 'student', path: (t) => `/api/v1/students/${t.studentIds[0]}` },
    { label: 'student guardians', path: (t) => `/api/v1/guardians/students/${t.studentIds[0]}` },
  ];

  for (const testCase of idorCases) {
    it(`tenant B cannot read tenant A's ${testCase.label} by id`, async () => {
      const response = await request(app.getHttpServer())
        .get(testCase.path(tenantA))
        .set('Authorization', `Bearer ${tokenB}`);

      // 404 rather than 403: confirming the record exists elsewhere is itself a leak.
      expect([403, 404]).toContain(response.status);
      expect(JSON.stringify(response.body)).not.toContain('alpha Student');
    });
  }

  it('tenant A can read the same record, proving the id is valid', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/students/${tenantA.studentIds[0]}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(response.status).toBe(200);
    expect(response.body.fullNameEn).toBe('alpha Student 1');
  });

  // ── Header forgery ────────────────────────────────────────────────────────────────

  it("tenant B cannot borrow tenant A's institution via the x-institution-id header", async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/students')
      .set('Authorization', `Bearer ${tokenB}`)
      .set('x-institution-id', tenantA.institutionId);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('a forged institution header on an academic endpoint is refused too', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/academic/years')
      .set('Authorization', `Bearer ${tokenB}`)
      .set('x-institution-id', tenantA.institutionId);

    expect(response.status).toBe(403);
  });

  it('records the forgery attempt as a security event', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/students')
      .set('Authorization', `Bearer ${tokenB}`)
      .set('x-institution-id', tenantA.institutionId);

    const client = testClient();
    await client.connect();
    try {
      const { rows } = await client.query<{ count: string }>(
        `select count(*) from security_events
         where event_type = 'cross_tenant_attempt' and tenant_id = $1`,
        [tenantB.tenantId],
      );
      expect(Number(rows[0]!.count)).toBeGreaterThan(0);
    } finally {
      await client.end();
    }
  });

  // ── Writes ────────────────────────────────────────────────────────────────────────

  it("tenant B cannot create a student inside tenant A's institution", async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/students')
      .set('Authorization', `Bearer ${tokenB}`)
      .set('x-institution-id', tenantA.institutionId)
      .send({
        admissionDate: '2026-02-01',
        fullNameEn: 'Injected Student',
        dateOfBirth: '2015-01-01',
        gender: 'male',
      });

    expect([403, 404]).toContain(response.status);

    const client = testClient();
    await client.connect();
    try {
      const { rows } = await client.query(
        `select id from students where full_name_en = 'Injected Student'`,
      );
      expect(rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  it("tenant B cannot update tenant A's student", async () => {
    const response = await request(app.getHttpServer())
      .patch(`/api/v1/students/${tenantA.studentIds[0]}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ fullNameEn: 'Renamed By Attacker', version: 1 });

    expect([403, 404]).toContain(response.status);

    const client = testClient();
    await client.connect();
    try {
      const { rows } = await client.query<{ full_name_en: string }>(
        'select full_name_en from students where id = $1',
        [tenantA.studentIds[0]],
      );
      expect(rows[0]!.full_name_en).toBe('alpha Student 1');
    } finally {
      await client.end();
    }
  });

  it("tenant B cannot link its guardian to tenant A's student", async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/guardians/students/${tenantA.studentIds[0]}/link`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ guardianId: tenantB.guardianIds[0], relation: 'father' });

    expect([403, 404]).toContain(response.status);
  });

  // ── Search ────────────────────────────────────────────────────────────────────────

  it('search never returns another tenant’s rows', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/students')
      .query({ q: 'alpha' })
      .set('Authorization', `Bearer ${tokenB}`);

    expect(response.status).toBe(200);
    expect(response.body.meta.total).toBe(0);
    expect(response.body.data).toEqual([]);
  });

  it('search by exact student code from another tenant returns nothing', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/students')
      .query({ q: 'alpha-S1' })
      .set('Authorization', `Bearer ${tokenB}`);

    expect(response.status).toBe(200);
    expect(response.body.meta.total).toBe(0);
  });

  // ── Audit log ─────────────────────────────────────────────────────────────────────

  it('the audit log is tenant-scoped even though writes are privileged', async () => {
    const ownerA = await login(tenantA.users['owner']!.email);
    const ownerB = await login(tenantB.users['owner']!.email);

    const a = await request(app.getHttpServer())
      .get('/api/v1/audit-logs')
      .set('Authorization', `Bearer ${ownerA}`);
    const b = await request(app.getHttpServer())
      .get('/api/v1/audit-logs')
      .set('Authorization', `Bearer ${ownerB}`);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const tenantsInA = new Set(a.body.data.map((row: { tenantId: string }) => row.tenantId));
    const tenantsInB = new Set(b.body.data.map((row: { tenantId: string }) => row.tenantId));
    expect([...tenantsInA].every((id) => id === tenantA.tenantId)).toBe(true);
    expect([...tenantsInB].every((id) => id === tenantB.tenantId)).toBe(true);
  });

  // ── Database layer: the guard is not the only defence ──────────────────────────────

  describe('row-level security, independent of the application', () => {
    let client: Client;

    beforeAll(async () => {
      // Connects as `shikkha_app` — the same unprivileged role the API uses — so this is what
      // an attacker with SQL execution inside the application would actually be able to do.
      client = new Client({ connectionString: TEST_APP_DATABASE_URL });
      await client.connect();
    });

    afterAll(async () => {
      await client?.end();
    });

    it('returns zero rows with no tenant context — fails closed, not open', async () => {
      for (const table of ['students', 'guardians', 'enrollments', 'users', 'organizations']) {
        const { rows } = await client.query<{ count: string }>(`select count(*) from ${table}`);
        expect(Number(rows[0]!.count), `${table} leaked without a tenant context`).toBe(0);
      }
    });

    it('shows only the current tenant when a context is set', async () => {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantA.tenantId]);
      const { rows } = await client.query<{ count: string }>('select count(*) from students');
      await client.query('commit');
      expect(Number(rows[0]!.count)).toBe(5);
    });

    it('cannot read another tenant’s row even by primary key', async () => {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantB.tenantId]);
      const { rows } = await client.query('select id from students where id = $1', [
        tenantA.studentIds[0],
      ]);
      await client.query('commit');
      expect(rows).toHaveLength(0);
    });

    it('refuses a write stamped with another tenant id', async () => {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantB.tenantId]);
      await expect(
        client.query(
          `insert into students (tenant_id, institution_id, student_code, admission_number, admission_date, full_name_en, date_of_birth, gender)
           values ($1,$2,'X1','X1','2026-01-01','Cross Tenant Insert','2015-01-01','male')`,
          [tenantA.tenantId, tenantA.institutionId],
        ),
      ).rejects.toThrow(/row-level security/i);
      await client.query('rollback');
    });

    it('cannot update another tenant’s row', async () => {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantB.tenantId]);
      const result = await client.query('update students set full_name_en = $1 where id = $2', [
        'Hacked',
        tenantA.studentIds[0],
      ]);
      await client.query('commit');
      // Not an error — the row is simply invisible, so zero rows match.
      expect(result.rowCount).toBe(0);
    });

    it('cannot delete another tenant’s row', async () => {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantB.tenantId]);
      const result = await client.query('delete from students where id = $1', [
        tenantA.studentIds[0],
      ]);
      await client.query('commit');
      expect(result.rowCount).toBe(0);
    });

    it('sees only its own organization row', async () => {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantB.tenantId]);
      const { rows } = await client.query<{ slug: string }>('select slug from organizations');
      await client.query('commit');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.slug).toBe('bravo-org');
    });

    it('cannot rewrite the audit log', async () => {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantB.tenantId]);
      await expect(client.query(`update audit_logs set reason = 'tampered'`)).rejects.toThrow();
      await client.query('rollback');
    });

    it('the application role has neither superuser nor BYPASSRLS', async () => {
      const { rows } = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        `select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
      );
      expect(rows[0]!.rolsuper).toBe(false);
      expect(rows[0]!.rolbypassrls).toBe(false);
    });

    it('every table with a tenant_id has forced row-level security', async () => {
      const { rows } = await client.query<{ relname: string }>(
        `select c.relname
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid
         where n.nspname = 'public' and c.relkind = 'r'
           and a.attname = 'tenant_id' and a.attnum > 0 and not a.attisdropped
           and (not c.relrowsecurity or not c.relforcerowsecurity)`,
      );
      expect(rows.map((r) => r.relname)).toEqual([]);
    });
  });
});
