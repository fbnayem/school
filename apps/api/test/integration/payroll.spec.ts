/**
 * Payroll integration suite (Phase 16).
 *
 * A rounding error here is somebody's salary, so the load-bearing tests go UNDER the
 * service: a raw `pg` client connected as `shikkha_app` — the same unprivileged role the
 * API uses — writes deliberately corrupt payroll data and the DATABASE must refuse it:
 *
 *  - a payslip whose lines disagree with its totals is refused at COMMIT by the deferred
 *    `payslips_totals_balanced` constraint trigger,
 *  - `net <> gross - total_deductions` breaks `payslips_net_is_derived` immediately,
 *  - a second live run for the same month breaks `payroll_runs_institution_period_key`,
 *  - an approved run, its payslips, its lines and its adjustments are immutable
 *    (`payroll_runs_immutable` and friends),
 *  - nothing payroll-shaped is ever hard-deleted.
 *
 * Above the database: component sequencing (`percentage_of_gross` after every earning),
 * pro-rata unpaid leave exact to the poisa through `Money.allocate`, the calculator
 * refused as approver even while holding every permission, marking a run paid posting one
 * balanced journal entry atomically (both or neither), an employee seeing exactly their
 * own payslip, and none of it crossing a tenant boundary.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Client } from 'pg';
import { Money, uuidv7 } from '@shikkha/shared';
import {
  createTestApp,
  seedTenant,
  testClient,
  truncateAll,
  TEST_APP_DATABASE_URL,
  TEST_PASSWORD,
  type SeededTenant,
} from '../helpers/test-app';

describe('Payroll', () => {
  let app: INestApplication;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
  const tokens: Record<string, string> = {};

  let teacherEmployeeId: string;
  let accountantEmployeeId: string;
  let structureId: string;

  let expenseAccountId: string;
  let payableAccountId: string;
  let bankAccountId: string;

  let runId: string; // 2026-01: the main lifecycle run
  let run2Id: string; // 2026-02: stays draft for the raw-SQL tests, then cancelled
  let loanId: string;
  let teacherSlipId: string;
  let accountantSlipId: string;
  let teacherLineId: string;
  let journalEntryId: string;

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

  /** Fetch the current optimistic-locking version of a run, as the owner. */
  async function runVersion(id: string): Promise<number> {
    const response = await get('owner', `/api/v1/payroll/runs/${id}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body.version as number;
  }

  /**
   * Run a callback as the unprivileged application role inside one transaction with the
   * tenant GUC set — exactly the credentials a compromised application would hold. The
   * transaction is rolled back afterwards (harmless after a failed COMMIT), so a refused
   * write cannot leak state into later tests.
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

  /** Await a query that the database must refuse, returning the pg error for inspection. */
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

  beforeAll(async () => {
    app = await createTestApp();
    await truncateAll();
    tenantA = await seedTenant('payra', { students: 1 });
    tenantB = await seedTenant('payrb', { students: 1 });

    teacherEmployeeId = tenantA.employeeIds[4]!;
    accountantEmployeeId = tenantA.employeeIds[3]!;

    const client = testClient();
    await client.connect();
    try {
      // The admin doubles as the chairman, the only preset role besides the owner that
      // holds payroll.runs.approve — the second pair of eyes the approval flow requires.
      await client.query(
        `insert into user_roles (id, tenant_id, user_id, role_id, institution_id)
         values ($1, $2, $3, $4, $5)`,
        [
          uuidv7(),
          tenantA.tenantId,
          tenantA.users['admin']!.id,
          tenantA.roleIds['chairman'],
          tenantA.institutionId,
        ],
      );

      // Two unpaid-leave days for the teacher in January 2026, straight into the staff
      // attendance register the payroll calculation reads.
      for (const day of ['2026-01-12', '2026-01-13']) {
        await client.query(
          `insert into employee_attendance
             (id, tenant_id, institution_id, campus_id, employee_id, attendance_date, status, source)
           values ($1, $2, $3, $4, $5, $6, 'absent', 'manual')`,
          [
            uuidv7(),
            tenantA.tenantId,
            tenantA.institutionId,
            tenantA.campusId,
            teacherEmployeeId,
            day,
          ],
        );
      }
    } finally {
      await client.end();
    }

    for (const key of ['owner', 'teacher'] as const) {
      tokens[key] = await login(tenantA.users[key]!.email);
    }
    tokens['approver'] = await login(tenantA.users['admin']!.email);
    tokens['otherOwner'] = await login(tenantB.users['owner']!.email);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Setup: salary structure (HR module), chart of accounts and fiscal calendar
  // (accounting module). Payroll consumes both; it owns neither.
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('setup through the HR and accounting modules', () => {
    it('creates, populates and activates a salary structure, then assigns it', async () => {
      const structure = await post('owner', '/api/v1/hr/salary-structures', {
        nameEn: 'Payroll Test Scale',
        effectiveFrom: '2026-01-01',
      });
      expect(structure.status, JSON.stringify(structure.body)).toBe(201);
      structureId = structure.body.id;

      const components = await put(
        'owner',
        `/api/v1/hr/salary-structures/${structureId}/components`,
        {
          components: [
            {
              nameEn: 'House Rent',
              type: 'earning',
              calculation: 'percentage_of_basic',
              amount: '50.00',
              sequence: 10,
            },
            {
              nameEn: 'Medical Allowance',
              type: 'earning',
              calculation: 'fixed',
              amount: '1500.00',
              sequence: 20,
            },
            {
              nameEn: 'Transport Allowance',
              type: 'earning',
              calculation: 'fixed',
              amount: '700.55',
              sequence: 30,
            },
            {
              nameEn: 'Provident Fund',
              type: 'deduction',
              calculation: 'percentage_of_basic',
              amount: '10.00',
              sequence: 40,
            },
            {
              nameEn: 'Income Tax',
              type: 'deduction',
              calculation: 'percentage_of_gross',
              amount: '5.00',
              sequence: 50,
            },
          ],
        },
      );
      expect(components.status, JSON.stringify(components.body)).toBe(200);

      const activated = await post('owner', `/api/v1/hr/salary-structures/${structureId}/activate`);
      expect(activated.status, JSON.stringify(activated.body)).toBe(201);

      const teacherAssignment = await post('owner', '/api/v1/hr/salary-assignments', {
        employeeId: teacherEmployeeId,
        salaryStructureId: structureId,
        basic: '20000.00',
        effectiveFrom: '2026-01-01',
      });
      expect(teacherAssignment.status, JSON.stringify(teacherAssignment.body)).toBe(201);

      const accountantAssignment = await post('owner', '/api/v1/hr/salary-assignments', {
        employeeId: accountantEmployeeId,
        salaryStructureId: structureId,
        basic: '30000.00',
        effectiveFrom: '2026-01-01',
      });
      expect(accountantAssignment.status, JSON.stringify(accountantAssignment.body)).toBe(201);
    });

    it('creates the payroll accounts and the fiscal calendar', async () => {
      const expense = await post('owner', '/api/v1/accounting/accounts', {
        code: '5100',
        nameEn: 'Salary expense',
        type: 'expense',
        normalBalance: 'debit',
      });
      expect(expense.status, JSON.stringify(expense.body)).toBe(201);
      expenseAccountId = expense.body.id;

      const payable = await post('owner', '/api/v1/accounting/accounts', {
        code: '2110',
        nameEn: 'Payroll deductions payable',
        type: 'liability',
        normalBalance: 'credit',
      });
      expect(payable.status).toBe(201);
      payableAccountId = payable.body.id;

      const bank = await post('owner', '/api/v1/accounting/accounts', {
        code: '1030',
        nameEn: 'Bank current account',
        type: 'asset',
        normalBalance: 'debit',
        isCashEquivalent: true,
      });
      expect(bank.status).toBe(201);
      bankAccountId = bank.body.id;

      const fiscalYear = await post('owner', '/api/v1/accounting/fiscal-years', {
        name: 'FY 2026',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        periodLayout: 'monthly',
      });
      expect(fiscalYear.status, JSON.stringify(fiscalYear.body)).toBe(201);
      const periods = fiscalYear.body.periods as Array<{ id: string; name: string }>;
      const february = periods.find((period) => period.name === '2026-02')!;

      // February 2026 is closed so the atomicity test can aim a posting at a closed
      // period and watch the whole payment roll back.
      const closed = await post('owner', `/api/v1/accounting/periods/${february.id}/close`, {
        reason: 'Closed early so payroll can prove its posting is atomic',
      });
      expect(closed.status, JSON.stringify(closed.body)).toBe(201);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Money: the pro-rata split is exact to the poisa
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('pro-rata arithmetic', () => {
    it('allocates an awkward gross across unpaid/paid days with no drift', () => {
      const gross = Money.fromDecimalString('32200.55');
      const [unpaid, paid] = gross.allocate([2, 29]);
      expect(unpaid!.toDecimalString()).toBe('2077.45');
      expect(paid!.toDecimalString()).toBe('30123.10');
      // The parts reconstruct the whole exactly — no poisa invented or lost.
      expect(Money.sum([unpaid!, paid!]).toDecimalString()).toBe('32200.55');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Run lifecycle: create → adjust → calculate → recalculate → approve
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('run lifecycle', () => {
    it('denies run creation to a teacher, without naming the missing permission', async () => {
      const response = await post('teacher', '/api/v1/payroll/runs', {
        periodYear: 2026,
        periodMonth: 1,
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
      expect(JSON.stringify(response.body)).not.toContain('payroll.runs.create');
    });

    it('creates a draft run for January 2026', async () => {
      const response = await post('owner', '/api/v1/payroll/runs', {
        periodYear: 2026,
        periodMonth: 1,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('draft');
      expect(response.body.name).toBe('Payroll 2026-01');
      runId = response.body.id;
    });

    it('refuses a second run for the same month', async () => {
      const response = await post('owner', '/api/v1/payroll/runs', {
        periodYear: 2026,
        periodMonth: 1,
        name: 'Duplicate January',
      });
      expect(response.status).toBe(409);
    });

    it('the database itself refuses a duplicate month, even from raw SQL', async () => {
      const error = await asAppRole(tenantA.tenantId, (client) =>
        expectRefusal(
          client.query(
            `insert into payroll_runs (tenant_id, institution_id, period_year, period_month, name)
             values ($1, $2, 2026, 1, 'Sneaky duplicate')`,
            [tenantA.tenantId, tenantA.institutionId],
          ),
        ),
      );
      expect(error.constraint).toBe('payroll_runs_institution_period_key');
    });

    it('records a loan and a one-off bonus before calculation', async () => {
      const loan = await post('owner', '/api/v1/payroll/loans', {
        employeeId: teacherEmployeeId,
        principal: '5000.00',
        instalment: '2000.00',
        startYear: 2026,
        startMonth: 1,
      });
      expect(loan.status, JSON.stringify(loan.body)).toBe(201);
      expect(loan.body.remaining).toBe('5000.00');
      loanId = loan.body.id;

      const bonus = await post('owner', `/api/v1/payroll/runs/${runId}/adjustments`, {
        employeeId: teacherEmployeeId,
        kind: 'earning',
        name: 'Festival Bonus',
        amount: '1000.00',
        reason: 'Eid festival bonus approved by the managing committee',
      });
      expect(bonus.status, JSON.stringify(bonus.body)).toBe(201);
    });

    it('calculates the run with percentage_of_gross evaluated after every earning', async () => {
      const response = await post('owner', `/api/v1/payroll/runs/${runId}/calculate`, {
        version: await runVersion(runId),
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('calculated');
      expect(response.body.employeeCount).toBe(2);
      // Teacher 33200.55 + accountant 47200.55.
      expect(response.body.totalGross).toBe('80401.10');
      expect(response.body.totalDeductions).toBe('13047.51');
      expect(response.body.totalNet).toBe('67353.59');

      const detail = await get('owner', `/api/v1/payroll/runs/${runId}`);
      expect(detail.status).toBe(200);
      const slips = detail.body.payslips as Array<{
        id: string;
        employeeId: string;
        basic: string;
        totalEarnings: string;
        gross: string;
        totalDeductions: string;
        net: string;
        unpaidLeaveDays: number;
        lines: Array<{ name: string; kind: string; amount: string; isStatutory: boolean }>;
      }>;
      expect(slips).toHaveLength(2);

      const teacher = slips.find((slip) => slip.employeeId === teacherEmployeeId)!;
      // Basic 20000 + HR 50% (10000) + Medical 1500 + Transport 700.55 + Bonus 1000.
      expect(teacher.basic).toBe('20000.00');
      expect(teacher.totalEarnings).toBe('13200.55');
      expect(teacher.gross).toBe('33200.55');
      expect(teacher.unpaidLeaveDays).toBe(2);

      const byName = new Map(teacher.lines.map((line) => [line.name, line]));
      expect(byName.get('House Rent')!.amount).toBe('10000.00');
      expect(byName.get('Provident Fund')!.amount).toBe('2000.00');
      expect(byName.get('Provident Fund')!.isStatutory).toBe(true);
      // THE ordering proof: income tax is 5% of the full component gross (32200.55 =
      // basic + every earning, House Rent included) → 1610.03. Evaluated before the
      // earnings it would have been 1000.00 (5% of basic alone).
      expect(byName.get('Income Tax')!.amount).toBe('1610.03');
      expect(byName.get('Income Tax')!.isStatutory).toBe(true);
      // Pro-rata unpaid leave: 2 of 31 days of 32200.55, largest-remainder exact.
      expect(byName.get('Unpaid leave (2 of 31 days)')!.amount).toBe('2077.45');
      expect(byName.get('Loan instalment')!.amount).toBe('2000.00');
      expect(byName.get('Festival Bonus')!.amount).toBe('1000.00');

      // The lines and the totals agree to the poisa, summed through Money.
      const earnings = teacher.lines.filter((line) => line.kind === 'earning');
      const deductions = teacher.lines.filter((line) => line.kind === 'deduction');
      expect(
        Money.sum(earnings.map((line) => Money.fromDecimalString(line.amount))).toDecimalString(),
      ).toBe(teacher.gross);
      expect(
        Money.sum(deductions.map((line) => Money.fromDecimalString(line.amount))).toDecimalString(),
      ).toBe(teacher.totalDeductions);
      expect(teacher.totalDeductions).toBe('7687.48');
      expect(teacher.net).toBe('25513.07');

      const accountant = slips.find((slip) => slip.employeeId === accountantEmployeeId)!;
      expect(accountant.gross).toBe('47200.55');
      expect(accountant.totalDeductions).toBe('5360.03'); // PF 3000 + tax 2360.03
      expect(accountant.net).toBe('41840.52');
      expect(accountant.unpaidLeaveDays).toBe(0);
    });

    it('refuses to calculate the same run twice', async () => {
      const response = await post('owner', `/api/v1/payroll/runs/${runId}/calculate`, {
        version: await runVersion(runId),
      });
      expect(response.status).toBe(409);
    });

    it('refuses the calculator as approver — even the owner, who holds every permission', async () => {
      const response = await post('owner', `/api/v1/payroll/runs/${runId}/approve`, {
        version: await runVersion(runId),
      });
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body.error.message).toContain('someone other than');
    });

    it('refuses approval while an adjustment is newer than the calculation', async () => {
      const fine = await post('owner', `/api/v1/payroll/runs/${runId}/adjustments`, {
        employeeId: teacherEmployeeId,
        kind: 'deduction',
        name: 'Canteen Fine',
        amount: '500.00',
        reason: 'Unreturned canteen advances for December, per HR memo 44',
      });
      expect(fine.status, JSON.stringify(fine.body)).toBe(201);

      const response = await post('approver', `/api/v1/payroll/runs/${runId}/approve`, {
        version: await runVersion(runId),
      });
      expect(response.status).toBe(409);
      expect(response.body.error.message).toContain('recalculate');
    });

    it('recalculates, reflecting the fine, and archives the previous payslips', async () => {
      const response = await post('owner', `/api/v1/payroll/runs/${runId}/recalculate`, {
        version: await runVersion(runId),
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('calculated');
      expect(response.body.totalGross).toBe('80401.10'); // fine is a deduction; gross unchanged
      expect(response.body.totalDeductions).toBe('13547.51');
      expect(response.body.totalNet).toBe('66853.59');

      const detail = await get('owner', `/api/v1/payroll/runs/${runId}`);
      const slips = detail.body.payslips as Array<{
        id: string;
        employeeId: string;
        net: string;
        lines: Array<{ id: string; name: string }>;
      }>;
      // Still exactly two live slips — the superseded set is archived, not deleted.
      expect(slips).toHaveLength(2);
      const teacher = slips.find((slip) => slip.employeeId === teacherEmployeeId)!;
      expect(teacher.net).toBe('25013.07');
      teacherSlipId = teacher.id;
      teacherLineId = teacher.lines[0]!.id;
      accountantSlipId = slips.find((slip) => slip.employeeId === accountantEmployeeId)!.id;
    });

    it('submits for review and lets a different user approve', async () => {
      const submitted = await post('owner', `/api/v1/payroll/runs/${runId}/submit`, {
        version: await runVersion(runId),
      });
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
      expect(submitted.body.status).toBe('under_review');

      const approved = await post('approver', `/api/v1/payroll/runs/${runId}/approve`, {
        version: await runVersion(runId),
      });
      expect(approved.status, JSON.stringify(approved.body)).toBe(201);
      expect(approved.body.status).toBe('approved');
      expect(approved.body.approvedBy).toBe(tenantA.users['admin']!.id);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // The approved run is immutable — at the database, not merely in the service
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('approved run immutability', () => {
    it('the database refuses any edit to the approved run row', async () => {
      const error = await asAppRole(tenantA.tenantId, (client) =>
        expectRefusal(
          client.query(
            `update payroll_runs set total_net = '1.00', total_gross = '1.00' where id = $1`,
            [runId],
          ),
        ),
      );
      expect(error.message).toContain('immutable');
    });

    it('the database refuses deleting the run', async () => {
      const error = await asAppRole(tenantA.tenantId, (client) =>
        expectRefusal(client.query(`delete from payroll_runs where id = $1`, [runId])),
      );
      expect(error.message).toContain('never deleted');
    });

    it('the database refuses touching a payslip of the approved run', async () => {
      const error = await asAppRole(tenantA.tenantId, (client) =>
        expectRefusal(
          client.query(`update payslips set net = net + 1, gross = gross + 1 where id = $1`, [
            teacherSlipId,
          ]),
        ),
      );
      expect(error.message).toContain('immutable');
    });

    it('the database refuses touching a payslip line of the approved run', async () => {
      const error = await asAppRole(tenantA.tenantId, (client) =>
        expectRefusal(
          client.query(`update payslip_lines set amount = '0.01' where id = $1`, [teacherLineId]),
        ),
      );
      expect(error.message).toContain('immutable');
    });

    it('the database refuses a new adjustment against the approved run', async () => {
      const error = await asAppRole(tenantA.tenantId, (client) =>
        expectRefusal(
          client.query(
            `insert into payroll_adjustments
               (tenant_id, institution_id, run_id, employee_id, kind, name, amount, reason)
             values ($1, $2, $3, $4, 'earning', 'Backdoor bonus', '9999.00', 'no')`,
            [tenantA.tenantId, tenantA.institutionId, runId, teacherEmployeeId],
          ),
        ),
      );
      expect(error.message).toContain('frozen');
    });

    it('the service likewise refuses an adjustment on the approved run', async () => {
      const response = await post('owner', `/api/v1/payroll/runs/${runId}/adjustments`, {
        employeeId: teacherEmployeeId,
        kind: 'earning',
        name: 'Too Late Bonus',
        amount: '100.00',
        reason: 'This should be refused because the run is approved',
      });
      expect(response.status).toBe(409);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // The database refuses an inconsistent payslip
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('payslip consistency is a database guarantee', () => {
    it('creates a second draft run to attack', async () => {
      const response = await post('owner', '/api/v1/payroll/runs', {
        periodYear: 2026,
        periodMonth: 2,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      run2Id = response.body.id;
    });

    it('refuses net that is not gross minus deductions, immediately', async () => {
      const error = await asAppRole(tenantA.tenantId, (client) =>
        expectRefusal(
          client.query(
            `insert into payslips
               (tenant_id, institution_id, run_id, employee_id, basic, total_earnings,
                gross, total_deductions, net)
             values ($1, $2, $3, $4, '100.00', '0.00', '100.00', '0.00', '90.00')`,
            [tenantA.tenantId, tenantA.institutionId, run2Id, teacherEmployeeId],
          ),
        ),
      );
      expect(error.constraint).toBe('payslips_net_is_derived');
    });

    it('refuses, at COMMIT, a payslip whose lines disagree with its totals', async () => {
      const error = await asAppRole(tenantA.tenantId, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `insert into payslips
             (tenant_id, institution_id, run_id, employee_id, basic, total_earnings,
              gross, total_deductions, net)
           values ($1, $2, $3, $4, '100.00', '0.00', '100.00', '0.00', '100.00')
           returning id`,
          [tenantA.tenantId, tenantA.institutionId, run2Id, teacherEmployeeId],
        );
        await client.query(
          `insert into payslip_lines (tenant_id, institution_id, payslip_id, name, kind, amount)
           values ($1, $2, $3, 'Basic', 'earning', '50.00')`,
          [tenantA.tenantId, tenantA.institutionId, rows[0]!.id],
        );
        // Both inserts were individually legal; the deferred trigger judges the whole.
        return expectRefusal(client.query('commit'));
      });
      expect(error.constraint).toBe('payslips_lines_match_gross');
    });

    it('refuses hard-deleting a payslip line even on a draft run, via a calculated slip', async () => {
      const error = await asAppRole(tenantA.tenantId, (client) =>
        expectRefusal(client.query(`delete from payslip_lines where id = $1`, [teacherLineId])),
      );
      expect(error.message).toContain('never deleted');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Marking paid posts ONE balanced journal entry — atomically
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('mark paid and the ledger', () => {
    it('a posting aimed at a closed period fails and leaves the run untouched', async () => {
      const response = await post('owner', `/api/v1/payroll/runs/${runId}/pay`, {
        version: await runVersion(runId),
        entryDate: '2026-02-15', // February 2026 was closed in setup
        expenseAccountId,
        paymentAccountId: bankAccountId,
        deductionsPayableAccountId: payableAccountId,
      });
      expect(response.status, JSON.stringify(response.body)).toBeGreaterThanOrEqual(400);

      // Both or neither: the run is still approved, no link exists, no entry was kept,
      // no payslip was stamped, the loan balance is untouched.
      const detail = await get('owner', `/api/v1/payroll/runs/${runId}`);
      expect(detail.body.status).toBe('approved');

      const client = testClient();
      await client.connect();
      try {
        const links = await client.query(
          `select count(*)::int as n from payroll_journal_links where run_id = $1`,
          [runId],
        );
        expect(links.rows[0]!.n).toBe(0);
        const entries = await client.query(
          `select count(*)::int as n from journal_entries
            where reference_type = 'payroll_run' and reference_id = $1`,
          [runId],
        );
        expect(entries.rows[0]!.n).toBe(0);
        const slips = await client.query(
          `select count(*)::int as n from payslips
            where run_id = $1 and archived_at is null and payment_status = 'paid'`,
          [runId],
        );
        expect(slips.rows[0]!.n).toBe(0);
      } finally {
        await client.end();
      }

      const loan = await get('owner', `/api/v1/payroll/loans/${loanId}`);
      expect(loan.body.remaining).toBe('5000.00');
    });

    it('pays the run: one balanced entry, the link, stamped payslips, the loan decremented', async () => {
      const response = await post('owner', `/api/v1/payroll/runs/${runId}/pay`, {
        version: await runVersion(runId),
        entryDate: '2026-01-31',
        expenseAccountId,
        paymentAccountId: bankAccountId,
        deductionsPayableAccountId: payableAccountId,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.run.status).toBe('paid');
      journalEntryId = response.body.journalEntryId as string;
      expect(journalEntryId).toBeTruthy();

      const client = testClient();
      await client.connect();
      try {
        // The one entry balances to the poisa: debit gross, credit deductions + net.
        const sums = await client.query<{ debits: string; credits: string }>(
          `select coalesce(sum(debit), 0)::numeric(14,2) as debits,
                  coalesce(sum(credit), 0)::numeric(14,2) as credits
             from journal_lines where entry_id = $1 and archived_at is null`,
          [journalEntryId],
        );
        expect(sums.rows[0]!.debits).toBe('80401.10');
        expect(sums.rows[0]!.credits).toBe('80401.10');

        const entry = await client.query<{ status: string; source_module: string }>(
          `select status, source_module from journal_entries where id = $1`,
          [journalEntryId],
        );
        expect(entry.rows[0]!.status).toBe('posted');
        expect(entry.rows[0]!.source_module).toBe('payroll');

        const link = await client.query(
          `select count(*)::int as n from payroll_journal_links
            where run_id = $1 and journal_entry_id = $2`,
          [runId, journalEntryId],
        );
        expect(link.rows[0]!.n).toBe(1);

        const unpaid = await client.query(
          `select count(*)::int as n from payslips
            where run_id = $1 and archived_at is null and payment_status <> 'paid'`,
          [runId],
        );
        expect(unpaid.rows[0]!.n).toBe(0);
      } finally {
        await client.end();
      }

      // The instalment withheld on the payslip is now recovered from the loan.
      const loan = await get('owner', `/api/v1/payroll/loans/${loanId}`);
      expect(loan.body.remaining).toBe('3000.00');
      expect(loan.body.status).toBe('active');
    });

    it('refuses to pay the run twice', async () => {
      const response = await post('owner', `/api/v1/payroll/runs/${runId}/pay`, {
        version: await runVersion(runId),
        entryDate: '2026-01-31',
        expenseAccountId,
        paymentAccountId: bankAccountId,
        deductionsPayableAccountId: payableAccountId,
      });
      expect(response.status).toBe(409);
    });

    it('a paid run is terminally immutable at the database', async () => {
      const error = await asAppRole(tenantA.tenantId, (client) =>
        expectRefusal(
          client.query(`update payroll_runs set name = 'Rewritten history' where id = $1`, [runId]),
        ),
      );
      expect(error.message).toContain('immutable');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Payslip visibility: view.own is exactly your own
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('payslip visibility', () => {
    it('an employee lists exactly their own payslips', async () => {
      const response = await get('teacher', '/api/v1/payroll/my-payslips');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].employeeId).toBe(teacherEmployeeId);
      expect(response.body.data[0].net).toBe('25013.07');
    });

    it('an employee reads their own payslip and its print data', async () => {
      const slip = await get('teacher', `/api/v1/payroll/payslips/${teacherSlipId}`);
      expect(slip.status, JSON.stringify(slip.body)).toBe(200);
      expect(slip.body.net).toBe('25013.07');
      expect(slip.body.lines.length).toBeGreaterThan(0);

      const print = await get('teacher', `/api/v1/payroll/payslips/${teacherSlipId}/print`);
      expect(print.status, JSON.stringify(print.body)).toBe(200);
      // The employee code is asserted by shape, not by index: seedTenant derives it from
      // insertion order, so a literal like 'payra-EMP-5' breaks whenever the fixture changes.
      // Identity is already established by teacherSlipId; this checks the print header names
      // an employee of this tenant rather than leaking another one.
      expect(print.body.employee.code).toMatch(/^payra-EMP-[0-9]+$/);
      expect(print.body.employee.nameEn).toContain('payra');
      expect(print.body.run.period).toBe('2026-01');
      expect(print.body.earnings.length).toBeGreaterThan(0);
      expect(print.body.deductions.length).toBeGreaterThan(0);
    });

    it("an employee cannot read a colleague's payslip — 404, not 403", async () => {
      const response = await get('teacher', `/api/v1/payroll/payslips/${accountantSlipId}`);
      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain('41840.52');
    });

    it('an employee cannot read the runs or the register', async () => {
      const runs = await get('teacher', '/api/v1/payroll/runs');
      expect(runs.status).toBe(403);
      const register = await get('teacher', `/api/v1/payroll/runs/${runId}/register`);
      expect(register.status).toBe(403);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Cancellation frees the month
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('cancellation', () => {
    it('cancels the February draft with a recorded reason', async () => {
      const response = await post('owner', `/api/v1/payroll/runs/${run2Id}/cancel`, {
        reason: 'February payroll restarted after the structure change',
        version: await runVersion(run2Id),
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('cancelled');
      expect(response.body.cancelReason).toContain('restarted');
    });

    it('a fresh run for the freed month is accepted', async () => {
      const response = await post('owner', '/api/v1/payroll/runs', {
        periodYear: 2026,
        periodMonth: 2,
        name: 'February payroll, second attempt',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('draft');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Reports — computed in SQL
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('reports', () => {
    it('the register lists every payslip with SQL-computed totals', async () => {
      const response = await get('owner', `/api/v1/payroll/runs/${runId}/register`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.rows).toHaveLength(2);
      expect(response.body.totals.employeeCount).toBe(2);
      expect(response.body.totals.totalBasic).toBe('50000.00');
      expect(response.body.totals.totalGross).toBe('80401.10');
      expect(response.body.totals.totalDeductions).toBe('13547.51');
      expect(response.body.totals.totalNet).toBe('66853.59');
    });

    it('the statutory summary aggregates structure-defined deductions per component', async () => {
      const response = await get('owner', `/api/v1/payroll/runs/${runId}/statutory-summary`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const byName = new Map(
        (
          response.body.deductions as Array<{ name: string; total: string; employeeCount: number }>
        ).map((row) => [row.name, row]),
      );
      expect(byName.get('Provident Fund')!.total).toBe('5000.00');
      expect(byName.get('Provident Fund')!.employeeCount).toBe(2);
      expect(byName.get('Income Tax')!.total).toBe('3970.06');
      // One-off fines, unpaid leave and loan instalments are NOT statutory lines.
      expect(byName.has('Canteen Fine')).toBe(false);
      expect(byName.has('Loan instalment')).toBe(false);
      expect(response.body.total).toBe('8970.06');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Tenant isolation
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('tenant isolation', () => {
    it('another tenant cannot read a run by its exact id', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/payroll/runs/${runId}`)
        .set('Authorization', `Bearer ${tokens['otherOwner']}`)
        .set('x-institution-id', tenantB.institutionId);

      // 404, not 403: confirming the record exists elsewhere is itself a leak.
      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain('80401.10');
    });

    it('another tenant cannot borrow the institution header', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/payroll/runs')
        .set('Authorization', `Bearer ${tokens['otherOwner']}`)
        .set('x-institution-id', tenantA.institutionId);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it("the other tenant's own list is empty rather than leaky", async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/payroll/runs')
        .set('Authorization', `Bearer ${tokens['otherOwner']}`)
        .set('x-institution-id', tenantB.institutionId);

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(0);
    });

    it('every payroll table has forced RLS and the tenant_isolation policy', async () => {
      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query<{
          relname: string;
          relrowsecurity: boolean;
          relforcerowsecurity: boolean;
          has_policy: boolean;
        }>(
          `select c.relname, c.relrowsecurity, c.relforcerowsecurity,
                  exists(select 1 from pg_policy p
                          where p.polrelid = c.oid and p.polname = 'tenant_isolation') as has_policy
             from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public'
              and c.relname = any($1)`,
          [
            [
              'payroll_runs',
              'payslips',
              'payslip_lines',
              'payroll_adjustments',
              'loan_advances',
              'payroll_journal_links',
            ],
          ],
        );
        expect(rows).toHaveLength(6);
        for (const row of rows) {
          expect(row.relrowsecurity, row.relname).toBe(true);
          expect(row.relforcerowsecurity, row.relname).toBe(true);
          expect(row.has_policy, row.relname).toBe(true);
        }
      } finally {
        await client.end();
      }
    });

    it("row-level security refuses a write stamped with another tenant's ids", async () => {
      const error = await asAppRole(tenantB.tenantId, (client) =>
        expectRefusal(
          client.query(
            `insert into payroll_runs (tenant_id, institution_id, period_year, period_month, name)
             values ($1, $2, 2099, 12, 'Cross-tenant forgery')`,
            [tenantA.tenantId, tenantA.institutionId],
          ),
        ),
      );
      // The policy's WITH CHECK refuses the row before any constraint sees it.
      expect(error.code).toBe('42501');
    });
  });
});
