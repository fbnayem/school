/**
 * Leave management over HTTP (Phase 21).
 *
 * The suite is built around the refusals and the arithmetic, because those are the module:
 *
 *  - **The applicant never approves their own leave.** The school owner holds `*` — every
 *    permission in the catalogue — applies for a day off, and is still refused. Proved over
 *    HTTP, and proved again against Postgres itself, where the
 *    `leave_applications_no_self_approval` trigger refuses the same UPDATE from raw SQL.
 *  - **Overlapping leave is refused**, by the service with a 409 naming the clash and by the
 *    deferred `leave_applications_no_overlap` constraint trigger at COMMIT.
 *  - **The balance is exact and reversible.** Approve → cancel → approve again, and the used
 *    days are 3.0, 0.0, 3.0 — never 2.9999999999999996.
 *  - **A balance cannot be overdrawn** unless the leave type allows it; the database refuses
 *    it too, through `leave_balances_not_overdrawn`.
 *  - **Days exclude weekends, calendar holidays and holiday overrides**, half days count 0.5,
 *    and an override opens a weekend as well as closing a working day.
 *  - **Approved leave lands in the existing attendance tables** in the same transaction, and
 *    a cancellation takes it back out again — by archiving, never by deleting.
 *  - **A gender-restricted type is a clear 422** for the wrong gender.
 *  - **Guardians see only their own children; an employee without a view-all permission sees
 *    only their own applications.** Cross-tenant reads are 404, never 403.
 *
 * Personas (seeded by the harness): owner (`*`), principal (`leave.requests.view.all`,
 * `leave.requests.approve`, `workflows.*`), teacher (`leave.requests.create`,
 * `leave.requests.view.own`), accountant, admin (the administrator role, which holds no leave
 * permission at all — the denial case), and two guardians with one child each.
 *
 * Calendar note: the seeded academic year 2026 uses the default Bangladeshi weekend of Friday
 * and Saturday, so every date below was chosen against a real 2026 calendar.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Client } from 'pg';
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

describe('Leave management', () => {
  let app: INestApplication;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;

  const tokens: Record<string, string> = {};
  let otherPrincipalToken: string;

  /** Employee ids resolved by identity, never by the fixture's insertion order. */
  const employeeOf: Record<string, string> = {};

  const types: Record<string, string> = {};

  async function login(email: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: email, password: TEST_PASSWORD });
    expect(response.status, `login failed for ${email}: ${JSON.stringify(response.body)}`).toBe(
      200,
    );
    return response.body.accessToken as string;
  }

  const get = (role: string, path: string) =>
    request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${tokens[role]}`)
      .set('x-institution-id', tenantA.institutionId);

  const post = (role: string, path: string, body: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${tokens[role]}`)
      .set('x-institution-id', tenantA.institutionId)
      .send(body);

  const patch = (role: string, path: string, body: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .patch(path)
      .set('Authorization', `Bearer ${tokens[role]}`)
      .set('x-institution-id', tenantA.institutionId)
      .send(body);

  /** Run raw SQL as `shikkha_app` with a tenant GUC set — a compromised application's rights. */
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

  async function expectRefusal(work: Promise<unknown>): Promise<{
    message: string;
    constraint?: string;
    code?: string;
  }> {
    try {
      await work;
    } catch (error) {
      return error as { message: string; constraint?: string; code?: string };
    }
    throw new Error('Expected the database to refuse this write, but it was accepted');
  }

  async function withMigrator<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = testClient();
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function createType(body: Record<string, unknown>): Promise<string> {
    const response = await post('owner', '/api/v1/leave/types', body);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.id as string;
  }

  async function applyLeave(
    role: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await post(role, '/api/v1/leave/applications', body);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body as Record<string, unknown>;
  }

  /** Used days on a holder's balance for one type, read straight from the database. */
  async function usedDays(leaveTypeId: string, employeeId: string): Promise<string | null> {
    return withMigrator(async (client) => {
      const { rows } = await client.query<{ used_days: string }>(
        `select used_days from leave_balances
          where leave_type_id = $1 and employee_id = $2 and archived_at is null`,
        [leaveTypeId, employeeId],
      );
      return rows[0]?.used_days ?? null;
    });
  }

  async function leaveAttendanceRows(employeeId: string): Promise<string[]> {
    return withMigrator(async (client) => {
      const { rows } = await client.query<{ attendance_date: string; status: string }>(
        `select attendance_date::text, status from employee_attendance
          where employee_id = $1 and remarks like 'leave:%' and archived_at is null
          order by attendance_date`,
        [employeeId],
      );
      return rows.map((row) => `${row.attendance_date}:${row.status}`);
    });
  }

  beforeAll(async () => {
    app = await createTestApp();
    await truncateAll();
    tenantA = await seedTenant('lva', { students: 2 });
    tenantB = await seedTenant('lvb', { students: 1 });

    for (const role of ['owner', 'principal', 'admin', 'accountant', 'teacher']) {
      tokens[role] = await login(tenantA.users[role]!.email);
    }
    tokens['guardian1'] = await login(tenantA.users['guardian1']!.email);
    tokens['guardian2'] = await login(tenantA.users['guardian2']!.email);
    otherPrincipalToken = await login(tenantB.users['principal']!.email);

    await withMigrator(async (client) => {
      for (const role of ['owner', 'principal', 'admin', 'accountant', 'teacher']) {
        const { rows } = await client.query<{ id: string }>(
          `select id from employees where user_id = $1`,
          [tenantA.users[role]!.id],
        );
        employeeOf[role] = rows[0]!.id;
      }

      // Gender is not part of the seed fixture, and the maternity rule needs it.
      await client.query(`update employees set gender = 'male' where id = $1`, [
        employeeOf['owner'],
      ]);
      await client.query(`update employees set gender = 'female' where id = $1`, [
        employeeOf['teacher'],
      ]);

      // A salary for the teacher, so the liability report has a rate to compute against.
      const structureId = uuidv7();
      await client.query(
        `insert into salary_structures
           (id, tenant_id, institution_id, name_en, status, effective_from)
         values ($1,$2,$3,'Standard 2026','active','2026-01-01')`,
        [structureId, tenantA.tenantId, tenantA.institutionId],
      );
      await client.query(
        `insert into employee_salary_assignments
           (id, tenant_id, institution_id, employee_id, salary_structure_id, basic, effective_from)
         values ($1,$2,$3,$4,$5,'30000.00','2026-01-01')`,
        [
          uuidv7(),
          tenantA.tenantId,
          tenantA.institutionId,
          employeeOf['teacher'],
          structureId,
        ],
      );

      // A daily register for the date a student will be on leave, so the reflection has
      // somewhere real to land.
      await client.query(
        `insert into attendance_sessions
           (id, tenant_id, institution_id, campus_id, academic_year_id, section_id,
            attendance_date, status)
         values ($1,$2,$3,$4,$5,$6,'2026-05-04','open')`,
        [
          uuidv7(),
          tenantA.tenantId,
          tenantA.institutionId,
          tenantA.campusId,
          tenantA.academicYearId,
          tenantA.sectionId,
        ],
      );
    });

    // The approval chain. Owned by the workflow engine; this module only starts requests.
    const definition = await post('principal', '/api/v1/workflows/definitions', {
      key: 'leave_approval',
      name: 'Leave approval',
      entityType: 'leave_application',
      steps: [
        {
          sequence: 1,
          name: 'Line manager',
          approverPermission: 'leave.requests.approve',
          onReject: 'terminate',
          slaHours: 48,
        },
      ],
    });
    expect(definition.status, JSON.stringify(definition.body)).toBe(201);

    types['casual'] = await createType({
      code: 'CASUAL',
      name: 'Casual leave',
      appliesTo: 'employee',
      annualQuotaDays: '10.0',
    });
    types['maternity'] = await createType({
      code: 'MATERNITY',
      name: 'Maternity leave',
      appliesTo: 'employee',
      genderRestriction: 'female',
      annualQuotaDays: '112.0',
    });
    types['medical'] = await createType({
      code: 'MEDICAL',
      name: 'Medical leave',
      appliesTo: 'employee',
      requiresDocument: true,
      annualQuotaDays: '14.0',
    });
    types['short'] = await createType({
      code: 'SHORT',
      name: 'Short special leave',
      appliesTo: 'employee',
      annualQuotaDays: '1.0',
      allowNegativeBalance: false,
    });
    types['studentCasual'] = await createType({
      code: 'SCASUAL',
      name: 'Student leave',
      appliesTo: 'student',
      annualQuotaDays: '10.0',
    });
  }, 180_000);

  afterAll(async () => {
    await app.close();
  });

  // ═════════════════════════════════════════════════════════════════════════════════════
  // Policy catalogue
  // ═════════════════════════════════════════════════════════════════════════════════════

  describe('leave types', () => {
    it('lists the types it created', async () => {
      const response = await get('owner', '/api/v1/leave/types?pageSize=50');
      expect(response.status).toBe(200);
      const codes = (response.body.data as { code: string }[]).map((row) => row.code);
      expect(codes).toEqual(
        expect.arrayContaining(['CASUAL', 'MATERNITY', 'MEDICAL', 'SHORT', 'SCASUAL']),
      );
    });

    it('refuses a duplicate code', async () => {
      const response = await post('owner', '/api/v1/leave/types', {
        code: 'CASUAL',
        name: 'Casual leave again',
      });
      expect(response.status).toBe(409);
    });

    it('denies type creation to the teacher, who may apply but not set policy', async () => {
      const response = await post('teacher', '/api/v1/leave/types', {
        code: 'TEACHERMADE',
        name: 'Invented by a teacher',
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('archives a type rather than deleting it, and the row survives', async () => {
      const id = await createType({ code: 'RETIRED', name: 'Retired policy' });
      const archived = await post(`owner`, `/api/v1/leave/types/${id}/archive`, {
        reason: 'This policy was replaced by the 2026 staff handbook',
      });
      expect(archived.status, JSON.stringify(archived.body)).toBe(201);

      const survived = await withMigrator(async (client) => {
        const { rows } = await client.query<{ archived_at: string | null; status: string }>(
          `select archived_at, status from leave_types where id = $1`,
          [id],
        );
        return rows[0];
      });
      expect(survived).toBeDefined();
      expect(survived!.archived_at).not.toBeNull();
      expect(survived!.status).toBe('inactive');
    });

    it('updates under the optimistic lock and rejects a stale version', async () => {
      const current = await get('owner', `/api/v1/leave/types/${types['casual']}`);
      expect(current.status).toBe(200);
      const version = current.body.version as number;

      const ok = await patch('owner', `/api/v1/leave/types/${types['casual']}`, {
        nameBn: 'নৈমিত্তিক ছুটি',
        version,
      });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.version).toBe(version + 1);

      const stale = await patch('owner', `/api/v1/leave/types/${types['casual']}`, {
        nameBn: 'again',
        version,
      });
      expect(stale.status).toBe(409);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════
  // Working-day arithmetic. Every application here stays a draft, so nothing reserves a
  // date range and the day counts can be read independently of each other.
  // ═════════════════════════════════════════════════════════════════════════════════════

  describe('working days exclude weekends, holidays and overrides', () => {
    it('counts three working days for Monday to Wednesday', async () => {
      const body = await applyLeave('teacher', {
        leaveTypeId: types['casual'],
        fromDate: '2026-03-02',
        toDate: '2026-03-04',
        reason: 'Family commitments in the village for three days',
      });
      expect(body['days']).toBe('3.0');
      expect(body['workingDays']).toEqual(['2026-03-02', '2026-03-03', '2026-03-04']);
      expect(body['status']).toBe('draft');
    });

    it('skips the Friday and Saturday weekend inside a five-day range', async () => {
      const body = await applyLeave('teacher', {
        leaveTypeId: types['casual'],
        fromDate: '2026-03-05',
        toDate: '2026-03-09',
        reason: 'Travelling over the weekend and returning on the Monday',
      });
      // Thu 5th, Fri 6th (weekend), Sat 7th (weekend), Sun 8th, Mon 9th.
      expect(body['days']).toBe('3.0');
      expect(body['workingDays']).toEqual(['2026-03-05', '2026-03-08', '2026-03-09']);
    });

    it('counts a half day as 0.5', async () => {
      const body = await applyLeave('teacher', {
        leaveTypeId: types['casual'],
        fromDate: '2026-07-06',
        toDate: '2026-07-06',
        isHalfDay: true,
        halfDayPeriod: 'first',
        reason: 'Morning appointment at the passport office',
      });
      expect(body['days']).toBe('0.5');
    });

    it('drops a day closed by a holiday override', async () => {
      const created = await post('owner', '/api/v1/leave/holiday-overrides', {
        date: '2026-04-07',
        isWorkingDay: false,
        note: 'Ad-hoc closure',
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);

      const body = await applyLeave('teacher', {
        leaveTypeId: types['casual'],
        fromDate: '2026-04-06',
        toDate: '2026-04-08',
        reason: 'Three days away, one of which the school is closed anyway',
      });
      expect(body['days']).toBe('2.0');
      expect(body['workingDays']).toEqual(['2026-04-06', '2026-04-08']);
    });

    it('counts a working Saturday opened by an override, and still skips the Friday', async () => {
      const created = await post('owner', '/api/v1/leave/holiday-overrides', {
        date: '2026-03-07',
        isWorkingDay: true,
        note: 'Make-up Saturday',
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);

      const body = await applyLeave('teacher', {
        leaveTypeId: types['casual'],
        fromDate: '2026-03-06',
        toDate: '2026-03-07',
        reason: 'Away for the weekend including the make-up Saturday',
      });
      expect(body['days']).toBe('1.0');
      expect(body['workingDays']).toEqual(['2026-03-07']);
    });

    it('refuses a range that contains no working day at all', async () => {
      const response = await post('teacher', '/api/v1/leave/applications', {
        leaveTypeId: types['casual'],
        // 2026-05-01 is a Friday, 2026-05-02 a Saturday: both weekend, no override.
        fromDate: '2026-05-01',
        toDate: '2026-05-02',
        reason: 'Asking for leave on days the school is already closed',
      });
      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body)).toMatch(/no working days/i);
    });

    it('denies holiday-override management to someone who only reads the calendar', async () => {
      const response = await post('admin', '/api/v1/leave/holiday-overrides', {
        date: '2026-09-07',
        isWorkingDay: false,
      });
      expect(response.status).toBe(403);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════
  // Gender restriction
  // ═════════════════════════════════════════════════════════════════════════════════════

  describe('gender-restricted leave', () => {
    it('refuses maternity leave for a male employee with a clear 422', async () => {
      const response = await post('owner', '/api/v1/leave/applications', {
        leaveTypeId: types['maternity'],
        employeeId: employeeOf['owner'],
        fromDate: '2026-03-02',
        toDate: '2026-03-06',
        reason: 'Applying for a leave type this record is not eligible for',
      });
      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body)).toMatch(/female/i);
    });

    it('allows it for a female employee', async () => {
      const body = await applyLeave('teacher', {
        leaveTypeId: types['maternity'],
        fromDate: '2026-10-05',
        toDate: '2026-10-07',
        reason: 'Maternity leave beginning in the first week of October',
      });
      expect(body['status']).toBe('draft');
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════
  // The rule the module exists for
  // ═════════════════════════════════════════════════════════════════════════════════════

  describe('an applicant may never approve their own leave', () => {
    let applicationId: string;

    it('lets the owner — who holds every permission — file and submit their own leave', async () => {
      const body = await applyLeave('owner', {
        leaveTypeId: types['casual'],
        fromDate: '2026-08-03',
        toDate: '2026-08-03',
        reason: 'One day off for a family matter in early August',
      });
      applicationId = body['id'] as string;

      const submitted = await post(
        'owner',
        `/api/v1/leave/applications/${applicationId}/submit`,
      );
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
      expect(submitted.body.status).toBe('submitted');
      expect(submitted.body.workflowRequestId).toBeTruthy();
    });

    it('REFUSES the owner approving it, despite holding `*`', async () => {
      const response = await post(
        'owner',
        `/api/v1/leave/applications/${applicationId}/approve`,
        { comment: 'Approving my own leave' },
      );
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
      expect(response.body.error.message).toMatch(/own leave/i);
    });

    it('equally refuses the owner rejecting their own leave', async () => {
      const response = await post(
        'owner',
        `/api/v1/leave/applications/${applicationId}/reject`,
        { comment: 'Rejecting my own application to test the rule' },
      );
      expect(response.status).toBe(403);
    });

    it('leaves the application untouched and lets the owner withdraw it instead', async () => {
      const still = await get('owner', `/api/v1/leave/applications/${applicationId}`);
      expect(still.body.status).toBe('submitted');
      expect(still.body.decidedBy).toBeNull();

      const withdrawn = await post(
        'owner',
        `/api/v1/leave/applications/${applicationId}/withdraw`,
        { reason: 'No longer needed; the family matter resolved itself' },
      );
      expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(201);
      expect(withdrawn.body.status).toBe('withdrawn');

      // Withdrawal is a status, not a deletion.
      const row = await withMigrator(async (client) => {
        const { rows } = await client.query<{ status: string }>(
          `select status from leave_applications where id = $1`,
          [applicationId],
        );
        return rows[0];
      });
      expect(row!.status).toBe('withdrawn');
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════
  // Balance arithmetic and the attendance reflection
  // ═════════════════════════════════════════════════════════════════════════════════════

  describe('approve → cancel → approve returns the balance to the right figure each time', () => {
    let firstId: string;
    let secondId: string;

    it('charges 3.0 days on approval and writes the register', async () => {
      const body = await applyLeave('teacher', {
        leaveTypeId: types['casual'],
        fromDate: '2026-06-01',
        toDate: '2026-06-03',
        reason: 'Three working days off at the start of June',
      });
      firstId = body['id'] as string;
      expect(body['days']).toBe('3.0');

      const submitted = await post('teacher', `/api/v1/leave/applications/${firstId}/submit`);
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);

      const approved = await post('principal', `/api/v1/leave/applications/${firstId}/approve`, {
        comment: 'Approved by the line manager',
      });
      expect(approved.status, JSON.stringify(approved.body)).toBe(201);
      expect(approved.body.status).toBe('approved');
      expect(approved.body.decidedBy).toBe(tenantA.users['principal']!.id);

      expect(await usedDays(types['casual']!, employeeOf['teacher']!)).toBe('3.0');
      expect(await leaveAttendanceRows(employeeOf['teacher']!)).toEqual([
        '2026-06-01:on_leave',
        '2026-06-02:on_leave',
        '2026-06-03:on_leave',
      ]);
    });

    it('returns the balance to 0.0 on cancellation and takes the register back out', async () => {
      const cancelled = await post(
        'principal',
        `/api/v1/leave/applications/${firstId}/cancel`,
        { reason: 'Cancelled at the employee’s request; cover was arranged instead' },
      );
      expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(201);
      expect(cancelled.body.status).toBe('cancelled');

      expect(await usedDays(types['casual']!, employeeOf['teacher']!)).toBe('0.0');
      expect(await leaveAttendanceRows(employeeOf['teacher']!)).toEqual([]);

      // Nothing was deleted — the reflection rows are archived, and still there.
      const archived = await withMigrator(async (client) => {
        const { rows } = await client.query<{ n: number }>(
          `select count(*)::int as n from employee_attendance
            where employee_id = $1 and archived_at is not null`,
          [employeeOf['teacher']],
        );
        return rows[0]!.n;
      });
      expect(archived).toBe(3);
    });

    it('charges 3.0 again when the same dates are approved a second time', async () => {
      const body = await applyLeave('teacher', {
        leaveTypeId: types['casual'],
        fromDate: '2026-06-01',
        toDate: '2026-06-03',
        reason: 'Re-applying for the same three days now that cover is unavailable',
      });
      secondId = body['id'] as string;

      const submitted = await post('teacher', `/api/v1/leave/applications/${secondId}/submit`);
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);

      const approved = await post(
        'principal',
        `/api/v1/leave/applications/${secondId}/approve`,
        {},
      );
      expect(approved.status, JSON.stringify(approved.body)).toBe(201);

      expect(await usedDays(types['casual']!, employeeOf['teacher']!)).toBe('3.0');
      expect(await leaveAttendanceRows(employeeOf['teacher']!)).toEqual([
        '2026-06-01:on_leave',
        '2026-06-02:on_leave',
        '2026-06-03:on_leave',
      ]);
    });

    it('shows the remaining days on the balance endpoint', async () => {
      const list = await get(
        'principal',
        `/api/v1/leave/balances?employeeId=${employeeOf['teacher']}&leaveTypeId=${types['casual']}`,
      );
      expect(list.status).toBe(200);
      expect(list.body.data).toHaveLength(1);
      const balanceId = list.body.data[0].id as string;

      const one = await get('principal', `/api/v1/leave/balances/${balanceId}`);
      expect(one.status).toBe(200);
      expect(one.body.entitledDays).toBe('10.0');
      expect(one.body.usedDays).toBe('3.0');
      expect(one.body.availableDays).toBe('7.0');
    });

    it('writes exactly one audit row for the approval, with the before-state', async () => {
      const rows = await withMigrator(async (client) => {
        const result = await client.query<{ previous_value: unknown; new_value: unknown }>(
          `select previous_value, new_value from audit_logs
            where module = 'leave' and resource_type = 'leave_application'
              and resource_id = $1 and action = 'approve'
            order by occurred_at`,
          [secondId],
        );
        return result.rows;
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.previous_value).toMatchObject({ status: 'submitted' });
      expect(rows[0]!.new_value).toMatchObject({ status: 'approved', days: '3.0' });
    });

    it('refuses leave that overlaps the approved dates', async () => {
      const body = await applyLeave('teacher', {
        leaveTypeId: types['casual'],
        fromDate: '2026-06-02',
        toDate: '2026-06-04',
        reason: 'Deliberately overlapping the leave that is already approved',
      });
      const response = await post(
        'teacher',
        `/api/v1/leave/applications/${body['id'] as string}/submit`,
      );
      expect(response.status).toBe(409);
      expect(response.body.error.message).toMatch(/overlaps/i);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════
  // Entitlement limits
  // ═════════════════════════════════════════════════════════════════════════════════════

  describe('a balance is not overdrawn unless the type allows it', () => {
    it('refuses a submission that would take the balance negative', async () => {
      const body = await applyLeave('teacher', {
        leaveTypeId: types['short'],
        fromDate: '2026-09-07',
        toDate: '2026-09-09',
        reason: 'Three days against a leave type that grants only one',
      });
      const response = await post(
        'teacher',
        `/api/v1/leave/applications/${body['id'] as string}/submit`,
      );
      expect(response.status).toBe(409);
      expect(response.body.error.message).toMatch(/negative balance/i);
    });

    it('adjusts an entitlement with a mandatory reason, and records it', async () => {
      const response = await post('owner', '/api/v1/leave/balances/adjust', {
        leaveTypeId: types['medical'],
        academicYearId: tenantA.academicYearId,
        employeeId: employeeOf['accountant'],
        entitledDays: '4.0',
        reason: 'Pro-rated medical entitlement for a mid-year joiner',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.entitledDays).toBe('4.0');
      expect(response.body.usedDays).toBe('0.0');

      const audited = await withMigrator(async (client) => {
        const { rows } = await client.query<{ reason: string; action: string }>(
          `select reason, action from audit_logs
            where module = 'leave' and resource_type = 'leave_balance'
              and resource_id = $1`,
          [response.body.id],
        );
        return rows;
      });
      expect(audited).toHaveLength(1);
      expect(audited[0]!.action).toBe('update');
      expect(audited[0]!.reason).toMatch(/mid-year joiner/);
    });

    it('refuses an adjustment with no reason', async () => {
      const response = await post('owner', '/api/v1/leave/balances/adjust', {
        leaveTypeId: types['medical'],
        academicYearId: tenantA.academicYearId,
        employeeId: employeeOf['accountant'],
        entitledDays: '5.0',
      });
      expect(response.status).toBe(422);
    });

    it('denies adjustment to the teacher', async () => {
      const response = await post('teacher', '/api/v1/leave/balances/adjust', {
        leaveTypeId: types['casual'],
        academicYearId: tenantA.academicYearId,
        employeeId: employeeOf['teacher'],
        entitledDays: '99.0',
        reason: 'Giving myself a much larger entitlement than policy allows',
      });
      expect(response.status).toBe(403);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════
  // Supporting evidence
  // ═════════════════════════════════════════════════════════════════════════════════════

  describe('a type that requires a document cannot be submitted without one', () => {
    let applicationId: string;

    it('refuses the submission while no document is attached', async () => {
      const body = await applyLeave('teacher', {
        leaveTypeId: types['medical'],
        fromDate: '2026-11-09',
        toDate: '2026-11-10',
        reason: 'Two days of medical leave following a procedure',
      });
      applicationId = body['id'] as string;

      const response = await post(
        'teacher',
        `/api/v1/leave/applications/${applicationId}/submit`,
      );
      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body)).toMatch(/document/i);
    });

    it('accepts the submission once a certificate is attached', async () => {
      const upload = await request(app.getHttpServer())
        .post(`/api/v1/leave/applications/${applicationId}/documents`)
        .set('Authorization', `Bearer ${tokens['teacher']}`)
        .set('x-institution-id', tenantA.institutionId)
        .attach('file', Buffer.from('%PDF-1.4 medical certificate'), {
          filename: 'certificate.pdf',
          contentType: 'application/pdf',
        });
      expect(upload.status, JSON.stringify(upload.body)).toBe(201);
      expect(upload.body.fileName).toBe('certificate.pdf');

      const submitted = await post(
        'teacher',
        `/api/v1/leave/applications/${applicationId}/submit`,
      );
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
      expect(submitted.body.status).toBe('submitted');
    });

    it('rejects it through the workflow engine, with the reason recorded', async () => {
      const response = await post(
        'principal',
        `/api/v1/leave/applications/${applicationId}/reject`,
        { comment: 'The certificate does not cover the second day of the request' },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('rejected');
      expect(response.body.decidedBy).toBe(tenantA.users['principal']!.id);

      // A rejection charges nothing.
      expect(await usedDays(types['medical']!, employeeOf['teacher']!)).toBeNull();
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════
  // Students and guardians
  // ═════════════════════════════════════════════════════════════════════════════════════

  describe('guardians apply for their own children only', () => {
    let studentApplicationId: string;

    it('lets guardian1 apply for their own child', async () => {
      const body = await applyLeave('guardian1', {
        leaveTypeId: types['studentCasual'],
        studentId: tenantA.studentIds[0],
        fromDate: '2026-05-04',
        toDate: '2026-05-05',
        reason: 'Attending a family wedding out of Dhaka for two days',
      });
      studentApplicationId = body['id'] as string;
      expect(body['days']).toBe('2.0');
      expect(body['studentId']).toBe(tenantA.studentIds[0]);
    });

    it('refuses guardian2 applying for guardian1’s child, with a 404', async () => {
      const response = await post('guardian2', '/api/v1/leave/applications', {
        leaveTypeId: types['studentCasual'],
        studentId: tenantA.studentIds[0],
        fromDate: '2026-05-11',
        toDate: '2026-05-12',
        reason: 'Applying for a child this guardian is not linked to',
      });
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('hides guardian1’s application from guardian2', async () => {
      const list = await get('guardian2', '/api/v1/leave/applications?pageSize=100');
      expect(list.status).toBe(200);
      const ids = (list.body.data as { id: string }[]).map((row) => row.id);
      expect(ids).not.toContain(studentApplicationId);

      const direct = await get(
        'guardian2',
        `/api/v1/leave/applications/${studentApplicationId}`,
      );
      expect(direct.status).toBe(404);
    });

    it('shows it to guardian1', async () => {
      const direct = await get(
        'guardian1',
        `/api/v1/leave/applications/${studentApplicationId}`,
      );
      expect(direct.status).toBe(200);
      expect(direct.body.id).toBe(studentApplicationId);
    });

    it('reflects the approval into the existing student register', async () => {
      const submitted = await post(
        'guardian1',
        `/api/v1/leave/applications/${studentApplicationId}/submit`,
      );
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);

      const approved = await post(
        'principal',
        `/api/v1/leave/applications/${studentApplicationId}/approve`,
        {},
      );
      expect(approved.status, JSON.stringify(approved.body)).toBe(201);

      const marks = await withMigrator(async (client) => {
        const { rows } = await client.query<{ status: string; attendance_date: string }>(
          `select sa.status, s.attendance_date::text
             from student_attendance sa
             join attendance_sessions s on s.id = sa.session_id
            where sa.student_id = $1 and sa.archived_at is null and sa.remarks like 'leave:%'`,
          [tenantA.studentIds[0]],
        );
        return rows;
      });
      // Only the 4th has a register; the 5th has none, so there is nothing to write there.
      expect(marks).toHaveLength(1);
      expect(marks[0]!.status).toBe('excused');
      expect(marks[0]!.attendance_date).toBe('2026-05-04');
    });
  });

  describe('an employee without a view-all permission sees only their own leave', () => {
    it('shows the teacher their own applications and nobody else’s', async () => {
      const list = await get('teacher', '/api/v1/leave/applications?pageSize=100');
      expect(list.status).toBe(200);
      const rows = list.body.data as { employeeId: string | null; studentId: string | null }[];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.employeeId).toBe(employeeOf['teacher']);
        expect(row.studentId).toBeNull();
      }
    });

    it('lists the teacher’s own applications under my-applications', async () => {
      const mine = await get('teacher', '/api/v1/leave/my-applications?pageSize=100');
      expect(mine.status).toBe(200);
      const rows = mine.body.data as { employeeId: string | null }[];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.employeeId).toBe(employeeOf['teacher']);
      }
    });

    it('gives an approver a queue of submitted applications, never their own', async () => {
      const pending = await applyLeave('teacher', {
        leaveTypeId: types['casual'],
        fromDate: '2026-07-13',
        toDate: '2026-07-14',
        reason: 'Two days in mid-July, awaiting a decision',
      });
      const submitted = await post(
        'teacher',
        `/api/v1/leave/applications/${pending['id'] as string}/submit`,
      );
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);

      const queue = await get('principal', '/api/v1/leave/team-applications?pageSize=100');
      expect(queue.status).toBe(200);
      const rows = queue.body.data as { id: string; status: string; createdBy: string }[];
      expect(rows.map((row) => row.id)).toContain(pending['id']);
      for (const row of rows) {
        expect(row.status).toBe('submitted');
        expect(row.createdBy).not.toBe(tenantA.users['principal']!.id);
      }
    });

    it('denies every leave read to the administrator, who holds no leave permission', async () => {
      const list = await get('admin', '/api/v1/leave/applications');
      expect(list.status).toBe(403);
      expect(list.body.error.code).toBe('FORBIDDEN');

      const queue = await get('admin', '/api/v1/leave/team-applications');
      expect(queue.status).toBe(403);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════
  // Encashment
  // ═════════════════════════════════════════════════════════════════════════════════════

  describe('encashment needs a second person', () => {
    let encashmentId: string;

    it('lets the owner raise a request against the teacher’s balance', async () => {
      const response = await post('owner', '/api/v1/leave/encashments', {
        employeeId: employeeOf['teacher'],
        leaveTypeId: types['casual'],
        academicYearId: tenantA.academicYearId,
        days: '2.0',
        amount: '2000.00',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      encashmentId = response.body.id as string;
      expect(response.body.status).toBe('pending');
      expect(response.body.amount).toBe('2000.00');
    });

    it('REFUSES the owner deciding the request they raised, despite holding `*`', async () => {
      const response = await post(
        'owner',
        `/api/v1/leave/encashments/${encashmentId}/decision`,
        {
          decision: 'approve',
          reason: 'Approving the encashment I asked for myself',
          version: 1,
        },
      );
      expect(response.status).toBe(403);
      expect(response.body.error.message).toMatch(/second person/i);
    });

    it('lets a second person approve it, and deducts the days', async () => {
      const response = await post(
        'principal',
        `/api/v1/leave/encashments/${encashmentId}/decision`,
        {
          decision: 'approve',
          reason: 'Approved against the remaining casual entitlement for 2026',
          version: 1,
        },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('approved');
      expect(await usedDays(types['casual']!, employeeOf['teacher']!)).toBe('5.0');
    });

    it('refuses more days than remain', async () => {
      const response = await post('owner', '/api/v1/leave/encashments', {
        employeeId: employeeOf['teacher'],
        leaveTypeId: types['casual'],
        academicYearId: tenantA.academicYearId,
        days: '99.0',
        amount: '99000.00',
      });
      expect(response.status).toBe(409);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════
  // Calendar and the liability report
  // ═════════════════════════════════════════════════════════════════════════════════════

  describe('calendar and reports', () => {
    it('lists who is away and which days are not working days', async () => {
      const response = await get(
        'principal',
        '/api/v1/leave/calendar?from=2026-06-01&to=2026-06-07',
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const entries = response.body.entries as { employeeId: string | null; days: string }[];
      expect(entries.some((entry) => entry.employeeId === employeeOf['teacher'])).toBe(true);
      // 2026-06-05 is a Friday and 2026-06-06 a Saturday.
      expect(response.body.nonWorkingDays).toEqual(['2026-06-05', '2026-06-06']);
    });

    it('computes the leave liability in SQL, in exact decimal', async () => {
      const response = await get('principal', '/api/v1/leave/reports/liability');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.daysPerMonth).toBe(30);

      const rows = response.body.rows as {
        code: string;
        outstandingDays: string;
        liabilityAmount: string;
        holdersWithoutSalary: number;
      }[];

      const casual = rows.find((row) => row.code === 'CASUAL');
      expect(casual).toBeDefined();
      // 10.0 entitled − 5.0 used = 5.0 days, at 30000.00 / 30 = 1000.00 a day.
      expect(casual!.outstandingDays).toBe('5.0');
      expect(casual!.liabilityAmount).toBe('5000.00');
      expect(casual!.holdersWithoutSalary).toBe(0);

      const medical = rows.find((row) => row.code === 'MEDICAL');
      expect(medical).toBeDefined();
      expect(medical!.outstandingDays).toBe('4.0');
      // The accountant has no salary assignment, so the days are reported and the money is
      // not invented.
      expect(medical!.liabilityAmount).toBe('0.00');
      expect(medical!.holdersWithoutSalary).toBe(1);
    });

    it('denies the liability report to an employee without a view-all permission', async () => {
      const response = await get('teacher', '/api/v1/leave/reports/liability');
      expect(response.status).toBe(403);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════
  // Tenant isolation
  // ═════════════════════════════════════════════════════════════════════════════════════

  describe('tenant isolation', () => {
    let tenantAApplicationId: string;

    beforeAll(async () => {
      const list = await get('principal', '/api/v1/leave/applications?pageSize=1');
      tenantAApplicationId = (list.body.data as { id: string }[])[0]!.id;
    });

    it('returns 404, never 403, for a cross-tenant read', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/leave/applications/${tenantAApplicationId}`)
        .set('Authorization', `Bearer ${otherPrincipalToken}`)
        .set('x-institution-id', tenantB.institutionId);
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('shows the other tenant an empty leave list', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/leave/applications')
        .set('Authorization', `Bearer ${otherPrincipalToken}`)
        .set('x-institution-id', tenantB.institutionId);
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
    });

    it('hides every leave row from the other tenant even in raw SQL', async () => {
      await asAppRole(tenantB.tenantId, async (client) => {
        const { rows } = await client.query<{ n: number }>(
          `select count(*)::int as n from leave_applications`,
        );
        expect(rows[0]!.n).toBe(0);
      });
      await asAppRole(tenantB.tenantId, async (client) => {
        const { rows } = await client.query<{ n: number }>(
          `select count(*)::int as n from leave_balances`,
        );
        expect(rows[0]!.n).toBe(0);
      });
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════
  // The database refuses these on its own — raw SQL, the service entirely bypassed.
  //
  // Connected as `shikkha_app`, never the migrator, because that is the credential a
  // compromised application would hold.
  // ═════════════════════════════════════════════════════════════════════════════════════

  describe('database-enforced invariants (raw SQL)', () => {
    /** Insert a leave application directly, returning its id. */
    async function insertRawApplication(
      client: Client,
      opts: {
        employeeId: string;
        from: string;
        to: string;
        days: string;
        status: string;
        createdBy: string;
      },
    ): Promise<string> {
      const { rows } = await client.query<{ id: string }>(
        `insert into leave_applications
           (tenant_id, institution_id, leave_type_id, academic_year_id, employee_id,
            from_date, to_date, days, reason, status, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'Raw SQL invariant test',$9,$10)
         returning id`,
        [
          tenantA.tenantId,
          tenantA.institutionId,
          types['casual'],
          tenantA.academicYearId,
          opts.employeeId,
          opts.from,
          opts.to,
          opts.days,
          opts.status,
          opts.createdBy,
        ],
      );
      return rows[0]!.id;
    }

    it('refuses an approval by the person who filed the application', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        const id = await insertRawApplication(client, {
          employeeId: employeeOf['admin']!,
          from: '2026-11-02',
          to: '2026-11-04',
          days: '3.0',
          status: 'submitted',
          createdBy: tenantA.users['owner']!.id,
        });

        const error = await expectRefusal(
          client.query(
            `update leave_applications
                set status = 'approved', decided_by = $2, decided_at = now()
              where id = $1`,
            [id, tenantA.users['owner']!.id],
          ),
        );
        expect(error.message).toMatch(/cannot be approved by the person who applied/i);
        expect(error.code).toBe('42501');
      });
    });

    it('refuses an approval by the employee the leave is for, however it was filed', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        const id = await insertRawApplication(client, {
          employeeId: employeeOf['admin']!,
          from: '2026-12-07',
          to: '2026-12-08',
          days: '2.0',
          // Filed by HR (the owner), for the administrator.
          status: 'submitted',
          createdBy: tenantA.users['owner']!.id,
        });

        const error = await expectRefusal(
          client.query(
            `update leave_applications
                set status = 'approved', decided_by = $2, decided_at = now()
              where id = $1`,
            [id, tenantA.users['admin']!.id],
          ),
        );
        expect(error.message).toMatch(/employee whose leave it is/i);
      });
    });

    it('refuses two overlapping submitted applications at COMMIT', async () => {
      const client = new Client({ connectionString: TEST_APP_DATABASE_URL });
      await client.connect();
      try {
        await client.query('begin');
        await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantA.tenantId]);

        await insertRawApplication(client, {
          employeeId: employeeOf['accountant']!,
          from: '2026-11-16',
          to: '2026-11-18',
          days: '3.0',
          status: 'submitted',
          createdBy: tenantA.users['owner']!.id,
        });
        await insertRawApplication(client, {
          employeeId: employeeOf['accountant']!,
          from: '2026-11-17',
          to: '2026-11-19',
          days: '3.0',
          status: 'submitted',
          createdBy: tenantA.users['owner']!.id,
        });

        // The trigger is deferred, so the overlap is tolerated mid-transaction and refused
        // at COMMIT — which is what lets the service rewrite an application in one go.
        const error = await expectRefusal(client.query('commit'));
        expect(error.message).toMatch(/overlaps existing/i);
        expect(error.constraint).toBe('leave_applications_no_overlap');
      } finally {
        await client.query('rollback').catch(() => undefined);
        await client.end();
      }

      const survived = await withMigrator(async (migrator) => {
        const { rows } = await migrator.query<{ n: number }>(
          `select count(*)::int as n from leave_applications where from_date = '2026-11-16'`,
        );
        return rows[0]!.n;
      });
      expect(survived).toBe(0);
    });

    it('refuses a balance overdrawn against a type that forbids it', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        const error = await expectRefusal(
          client.query(
            `insert into leave_balances
               (tenant_id, institution_id, leave_type_id, employee_id, academic_year_id,
                entitled_days, used_days, carried_days)
             values ($1,$2,$3,$4,$5,'1.0','4.0','0.0')`,
            [
              tenantA.tenantId,
              tenantA.institutionId,
              types['short'],
              employeeOf['admin'],
              tenantA.academicYearId,
            ],
          ),
        );
        expect(error.message).toMatch(/overdrawn/i);
        expect(error.constraint).toBe('leave_balances_not_overdrawn');
      });
    });

    it('accepts the same overdraft when the type allows a negative balance', async () => {
      const allowingTypeId = await createType({
        code: 'ADVANCE',
        name: 'Advance leave',
        annualQuotaDays: '1.0',
        allowNegativeBalance: true,
      });

      await asAppRole(tenantA.tenantId, async (client) => {
        const { rowCount } = await client.query(
          `insert into leave_balances
             (tenant_id, institution_id, leave_type_id, employee_id, academic_year_id,
              entitled_days, used_days, carried_days)
           values ($1,$2,$3,$4,$5,'1.0','4.0','0.0')`,
          [
            tenantA.tenantId,
            tenantA.institutionId,
            allowingTypeId,
            employeeOf['admin'],
            tenantA.academicYearId,
          ],
        );
        expect(rowCount).toBe(1);
      });
    });

    it('refuses an application that names both an employee and a student', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        const error = await expectRefusal(
          client.query(
            `insert into leave_applications
               (tenant_id, institution_id, leave_type_id, academic_year_id, employee_id,
                student_id, from_date, to_date, days, reason, status)
             values ($1,$2,$3,$4,$5,$6,'2026-12-14','2026-12-15','2.0','Two holders','draft')`,
            [
              tenantA.tenantId,
              tenantA.institutionId,
              types['casual'],
              tenantA.academicYearId,
              employeeOf['admin'],
              tenantA.studentIds[0],
            ],
          ),
        );
        expect(error.constraint).toBe('leave_applications_exactly_one_holder');
      });
    });

    it('refuses an encashment approved by the person who requested it', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        const error = await expectRefusal(
          client.query(
            `insert into leave_encashments
               (tenant_id, institution_id, employee_id, leave_type_id, academic_year_id,
                days, amount, status, requested_by, approved_by, decided_at)
             values ($1,$2,$3,$4,$5,'1.0','1000.00','approved',$6,$6, now())`,
            [
              tenantA.tenantId,
              tenantA.institutionId,
              employeeOf['admin'],
              types['casual'],
              tenantA.academicYearId,
              tenantA.users['owner']!.id,
            ],
          ),
        );
        expect(error.constraint).toBe('leave_encashments_no_self_approval');
      });
    });
  });
});
