/**
 * Asset management integration suite (Phase 20).
 *
 * This file exists to hold the register's financial invariants, not to prove the routes
 * return 200. A mistake here misstates the balance sheet, so the load-bearing tests go
 * UNDER the service: a raw `pg` client connected as `shikkha_app` — the same unprivileged
 * role the API uses — writes deliberately corrupt rows and the DATABASE must refuse them:
 *
 *  - an asset whose `book_value` is not `purchase_cost - accumulated_depreciation` breaks
 *    `assets_book_value_derived`,
 *  - accumulated depreciation past `purchase_cost - salvage_value` breaks
 *    `assets_accumulated_within_depreciable`,
 *  - a second open assignment on one asset breaks `asset_assignments_open_key`,
 *  - a posted depreciation run refuses UPDATE and DELETE outright, and its lines are
 *    append-only from the moment they are written,
 *  - an approver who is also the requester breaks `asset_disposals_distinct_approver`.
 *
 * Above the database, the service-level rules: straight-line depreciation allocated with
 * `Money.allocate` sums across the asset's whole life to exactly `cost - salvage` with no
 * poisa of drift, posting a run writes ONE balanced journal entry atomically (a refused
 * posting rolls the register back), a disposal cannot be approved by whoever recorded it
 * even holding every permission, and none of it crosses a tenant boundary.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Client } from 'pg';
import argon2 from 'argon2';
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

describe('Assets — the fixed-asset register', () => {
  let app: INestApplication;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
  const tokens: Record<string, string> = {};

  // The chart of accounts this suite posts against.
  let depExpenseAccountId: string; // 5200 depreciation expense
  let accumAccountId: string; // 1500 accumulated depreciation (contra-asset)
  let assetCostAccountId: string; // 1510 equipment at cost
  let cashAccountId: string; // 1040 cash in hand
  let gainLossAccountId: string; // 4100 gain/loss on disposal

  let categoryId: string;

  // The one depreciable asset: 50000.00 cost, 1234.56 salvage, 36-month straight line.
  const COST = '50000.00';
  const SALVAGE = '1234.56';
  const DEPRECIABLE = '48765.44';
  let mainAssetId: string;

  let disposalAssetId: string; // method 'none'; disposed near the end of the suite
  let custodyAssetId: string; // method 'none'; the assignment tests

  let janRunId: string; // the 2026-01 run, recreated after a cancellation
  let firstPostedRunId: string;
  let firstPostedLineId: string;
  let firstPostedEntryId: string;

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
   * Run a callback as the unprivileged application role inside one transaction with the
   * tenant GUC set — exactly the credentials a compromised application would hold. The
   * transaction is rolled back afterwards, so a refused write cannot leak state into
   * later tests.
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

  /** Await a query the database must refuse, returning the pg error for inspection. */
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

  /**
   * A second user holding `assets.*` (the inventory manager preset), so the two-person
   * disposal rule can be exercised with a genuinely different approver. seedTenant creates
   * every system role but not a user for this one.
   */
  async function seedStorekeeper(): Promise<string> {
    const client = testClient();
    await client.connect();
    try {
      const userId = uuidv7();
      const email = 'storekeeper@asta.test';
      const passwordHash = await argon2.hash(TEST_PASSWORD, {
        type: argon2.argon2id,
        memoryCost: 8192,
        timeCost: 2,
        parallelism: 1,
      });
      await client.query(
        `insert into users (id, tenant_id, email, password_hash, full_name_en, status, email_verified_at)
         values ($1,$2,$3,$4,'asta Storekeeper','active',now())`,
        [userId, tenantA.tenantId, email, passwordHash],
      );
      await client.query(
        `insert into user_roles (id, tenant_id, user_id, role_id, institution_id)
         values ($1,$2,$3,$4,$5)`,
        [
          uuidv7(),
          tenantA.tenantId,
          userId,
          tenantA.roleIds['inventory_manager'],
          tenantA.institutionId,
        ],
      );
      return email;
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    app = await createTestApp();
    await truncateAll();
    tenantA = await seedTenant('asta', { students: 1 });
    tenantB = await seedTenant('astb', { students: 1 });

    for (const key of ['owner', 'accountant', 'teacher']) {
      tokens[key] = await login(tenantA.users[key]!.email);
    }
    tokens['manager'] = await login(await seedStorekeeper());
    tokens['otherOwner'] = await login(tenantB.users['owner']!.email);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Setup: the ledger accounts, the fiscal calendar, the taxonomy
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('setup', () => {
    it('creates the depreciation and disposal accounts', async () => {
      const expense = await post('owner', '/api/v1/accounting/accounts', {
        code: '5200',
        nameEn: 'Depreciation expense',
        type: 'expense',
        normalBalance: 'debit',
      });
      expect(expense.status, JSON.stringify(expense.body)).toBe(201);
      depExpenseAccountId = expense.body.id;

      const accumulated = await post('owner', '/api/v1/accounting/accounts', {
        code: '1500',
        nameEn: 'Accumulated depreciation',
        type: 'asset',
        normalBalance: 'credit',
      });
      expect(accumulated.status).toBe(201);
      accumAccountId = accumulated.body.id;

      const cost = await post('owner', '/api/v1/accounting/accounts', {
        code: '1510',
        nameEn: 'Equipment at cost',
        type: 'asset',
        normalBalance: 'debit',
      });
      expect(cost.status).toBe(201);
      assetCostAccountId = cost.body.id;

      const cash = await post('owner', '/api/v1/accounting/accounts', {
        code: '1040',
        nameEn: 'Cash in hand',
        type: 'asset',
        normalBalance: 'debit',
        isCashEquivalent: true,
      });
      expect(cash.status).toBe(201);
      cashAccountId = cash.body.id;

      const gainLoss = await post('owner', '/api/v1/accounting/accounts', {
        code: '4100',
        nameEn: 'Gain or loss on asset disposal',
        type: 'income',
        normalBalance: 'credit',
      });
      expect(gainLoss.status).toBe(201);
      gainLossAccountId = gainLoss.body.id;
    });

    it('lays out a three-year fiscal calendar — the asset’s whole life', async () => {
      const response = await post('owner', '/api/v1/accounting/fiscal-years', {
        name: 'FY 2026-2028',
        startDate: '2026-01-01',
        endDate: '2028-12-31',
        periodLayout: 'monthly',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.periods).toHaveLength(36);
    });

    it('creates an asset category', async () => {
      const response = await post('manager', '/api/v1/assets/categories', {
        name: 'Computers',
        nameBn: 'কম্পিউটার',
        defaultUsefulLifeYears: 3,
        defaultDepreciationMethod: 'straight_line',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      categoryId = response.body.id;
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Permissions
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('permission enforcement', () => {
    it('refuses registration to a role with no asset authority', async () => {
      const response = await post('teacher', '/api/v1/assets', {
        assetTag: 'AST-SNEAK',
        name: 'Sneaky projector',
        categoryId,
        purchasedOn: '2026-01-01',
        purchaseCost: '1.00',
        depreciationMethod: 'none',
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
      // Naming the missing permission would be free reconnaissance.
      expect(JSON.stringify(response.body)).not.toContain('assets.manage');
    });

    it('refuses a teacher the register, custody and the runs', async () => {
      const register = await get('teacher', '/api/v1/assets');
      expect(register.status).toBe(403);

      const runs = await get('teacher', '/api/v1/assets/depreciation-runs');
      expect(runs.status).toBe(403);

      const assign = await post('teacher', '/api/v1/assets/assignments', {
        assetId: '00000000-0000-7000-8000-000000000000',
        assigneeKind: 'employee',
        employeeId: tenantA.employeeIds[0],
        assignedOn: '2026-01-10',
        conditionOut: 'good',
      });
      expect(assign.status).toBe(403);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Registration
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('registration', () => {
    it('refuses a salvage value above the cost, and a depreciating asset with no life', async () => {
      const salvage = await post('manager', '/api/v1/assets', {
        assetTag: 'AST-BADSALV',
        name: 'Upside-down economics',
        categoryId,
        purchasedOn: '2026-01-01',
        purchaseCost: '100.00',
        salvageValue: '200.00',
        depreciationMethod: 'none',
      });
      expect(salvage.status).toBe(422);

      const lifeless = await post('manager', '/api/v1/assets', {
        assetTag: 'AST-NOLIFE',
        name: 'Depreciates over nothing',
        categoryId,
        purchasedOn: '2026-01-01',
        purchaseCost: '100.00',
        depreciationMethod: 'straight_line',
      });
      expect(lifeless.status).toBe(422);
    });

    it('registers the depreciable asset at book value = purchase cost', async () => {
      const response = await post('manager', '/api/v1/assets', {
        assetTag: 'AST-0001',
        name: 'Computer lab server',
        categoryId,
        serialNumber: 'SRV-77-1234',
        purchasedOn: '2026-01-15',
        purchaseCost: COST,
        salvageValue: SALVAGE,
        usefulLifeYears: 3,
        depreciationMethod: 'straight_line',
        location: 'Computer lab, first floor',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.bookValue).toBe(COST);
      expect(response.body.accumulatedDepreciation).toBe('0.00');
      expect(response.body.status).toBe('in_store');
      expect(response.body.version).toBe(1);
      mainAssetId = response.body.id;
    });

    it('refuses a duplicate asset tag — a physical label is never reused', async () => {
      const response = await post('manager', '/api/v1/assets', {
        assetTag: 'AST-0001',
        name: 'A second server pretending to be the first',
        categoryId,
        purchasedOn: '2026-02-01',
        purchaseCost: '10.00',
        depreciationMethod: 'none',
      });
      expect(response.status).toBe(409);
    });

    it('registers the non-depreciating assets the later suites use', async () => {
      const disposal = await post('manager', '/api/v1/assets', {
        assetTag: 'AST-0002',
        name: 'Old photocopier',
        categoryId,
        purchasedOn: '2026-01-05',
        purchaseCost: '8000.00',
        depreciationMethod: 'none',
      });
      expect(disposal.status, JSON.stringify(disposal.body)).toBe(201);
      disposalAssetId = disposal.body.id;

      const custody = await post('manager', '/api/v1/assets', {
        assetTag: 'AST-0003',
        name: 'Portable projector',
        categoryId,
        purchasedOn: '2026-01-05',
        purchaseCost: '3000.00',
        depreciationMethod: 'none',
      });
      expect(custody.status).toBe(201);
      custodyAssetId = custody.body.id;
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Money: the allocation itself is exact
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('allocation arithmetic', () => {
    it('splits the depreciable amount over 36 months with no drift', () => {
      const parts = Money.fromDecimalString(DEPRECIABLE).split(36);
      expect(parts).toHaveLength(36);
      // 4876544 poisa = 36 × 135459 + 20: twenty months carry the extra poisa.
      for (const part of parts) {
        expect(['1354.59', '1354.60']).toContain(part.toDecimalString());
      }
      expect(Money.sum(parts).toDecimalString()).toBe(DEPRECIABLE);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Custody — one open assignment per asset, held by the database
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('assignments', () => {
    let assignmentId: string;

    it('hands the projector to an employee and flips the asset to assigned', async () => {
      const response = await post('manager', '/api/v1/assets/assignments', {
        assetId: custodyAssetId,
        assigneeKind: 'employee',
        employeeId: tenantA.employeeIds[0],
        assignedOn: '2026-02-01',
        conditionOut: 'good',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.returnedOn).toBeNull();
      assignmentId = response.body.id;

      const asset = await get('manager', `/api/v1/assets/${custodyAssetId}`);
      expect(asset.status).toBe(200);
      expect(asset.body.status).toBe('assigned');
      expect(asset.body.openAssignment.id).toBe(assignmentId);
    });

    it('refuses a second assignment at the API', async () => {
      const response = await post('manager', '/api/v1/assets/assignments', {
        assetId: custodyAssetId,
        assigneeKind: 'employee',
        employeeId: tenantA.employeeIds[1],
        assignedOn: '2026-02-02',
        conditionOut: 'good',
      });
      expect(response.status).toBe(409);
    });

    it('the DATABASE refuses a second open assignment — asset_assignments_open_key', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        const error = await expectRefusal(
          client.query(
            `insert into asset_assignments
               (tenant_id, institution_id, asset_id, assignee_kind, employee_id,
                assigned_on, assigned_by, condition_out)
             values ($1, $2, $3, 'employee', $4, '2026-02-02', $5, 'good')`,
            [
              tenantA.tenantId,
              tenantA.institutionId,
              custodyAssetId,
              tenantA.employeeIds[1],
              tenantA.users['owner']!.id,
            ],
          ),
        );
        expect(error.code).toBe('23505');
        expect(error.constraint).toBe('asset_assignments_open_key');
      });
    });

    it('takes the projector back, recording who and in what condition', async () => {
      const response = await post('manager', `/api/v1/assets/assignments/${assignmentId}/return`, {
        returnedOn: '2026-03-01',
        conditionIn: 'fair',
        version: 1,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.returnedOn).toBe('2026-03-01');
      expect(response.body.conditionIn).toBe('fair');
      expect(response.body.returnedBy).toBeTruthy();

      const asset = await get('manager', `/api/v1/assets/${custodyAssetId}`);
      expect(asset.body.status).toBe('in_store');
      expect(asset.body.condition).toBe('fair');
      expect(asset.body.openAssignment).toBeNull();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Maintenance
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('maintenance', () => {
    it('records maintenance work and surfaces it on the due report', async () => {
      const created = await post('manager', '/api/v1/assets/maintenance', {
        assetId: custodyAssetId,
        kind: 'repair',
        performedOn: '2026-03-05',
        cost: '350.50',
        vendor: 'Dhanmondi Electronics',
        downtimeDays: 2,
        nextDueOn: '2026-09-05',
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body.cost).toBe('350.50');

      const notYetDue = await get('manager', '/api/v1/assets/maintenance/due', {
        asOf: '2026-08-31',
      });
      expect(notYetDue.status).toBe(200);
      expect(notYetDue.body.due).toHaveLength(0);

      const due = await get('manager', '/api/v1/assets/maintenance/due', { asOf: '2026-09-05' });
      expect(due.status).toBe(200);
      expect(due.body.due).toHaveLength(1);
      expect(due.body.due[0].assetTag).toBe('AST-0003');
    });

    it('refuses a next-due date on or before the work date', async () => {
      const response = await post('manager', '/api/v1/assets/maintenance', {
        assetId: custodyAssetId,
        kind: 'preventive',
        performedOn: '2026-03-05',
        nextDueOn: '2026-03-05',
      });
      expect(response.status).toBe(422);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // The database refuses a corrupt register — raw SQL, service entirely bypassed
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('database-enforced register invariants (raw SQL)', () => {
    it('refuses an asset whose book value is not cost minus accumulated — assets_book_value_derived', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        const error = await expectRefusal(
          client.query(
            `insert into assets
               (tenant_id, institution_id, asset_tag, name, category_id, purchased_on,
                purchase_cost, depreciation_method, accumulated_depreciation, book_value)
             values ($1, $2, 'AST-RAW-BV', 'Book value asserted, not derived', $3,
                     '2026-01-01', '100.00', 'none', '0.00', '90.00')`,
            [tenantA.tenantId, tenantA.institutionId, categoryId],
          ),
        );
        expect(error.constraint).toBe('assets_book_value_derived');
      });
    });

    it('refuses accumulated depreciation past the salvage floor — assets_accumulated_within_depreciable', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        // 49000.00 > 48765.44 (cost - salvage). The book value is kept consistent with
        // the derivation constraint, so THIS constraint is the one doing the refusing.
        const error = await expectRefusal(
          client.query(
            `update assets
                set accumulated_depreciation = '49000.00', book_value = '1000.00'
              where id = $1`,
            [mainAssetId],
          ),
        );
        expect(error.constraint).toBe('assets_accumulated_within_depreciable');
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Depreciation — draft, cancel, atomic posting, and a poisa-exact whole life
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('depreciation runs', () => {
    it('calculates January 2026 as a draft, one line for the one depreciable asset', async () => {
      const response = await post('manager', '/api/v1/assets/depreciation-runs', {
        periodYear: 2026,
        periodMonth: 1,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('draft');
      expect(response.body.lines).toHaveLength(1);
      expect(response.body.lines[0].assetId).toBe(mainAssetId);
      expect(response.body.lines[0].openingBookValue).toBe(COST);
      // First slice of allocate(48765.44 / 36): the extra poisa land on the early months.
      expect(response.body.lines[0].depreciation).toBe('1354.60');
      expect(response.body.lines[0].closingBookValue).toBe('48645.40');
      expect(response.body.totalDepreciation).toBe('1354.60');
      janRunId = response.body.id;
    });

    it('refuses a second run for the same period while this one stands', async () => {
      const response = await post('manager', '/api/v1/assets/depreciation-runs', {
        periodYear: 2026,
        periodMonth: 1,
      });
      expect(response.status).toBe(409);
    });

    it('a cancelled run frees the period for recalculation', async () => {
      const cancelled = await post(
        'manager',
        `/api/v1/assets/depreciation-runs/${janRunId}/cancel`,
        { reason: 'Recalculating after a registration correction', version: 1 },
      );
      expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(201);
      expect(cancelled.body.status).toBe('cancelled');
      expect(cancelled.body.cancelReason).toBeTruthy();

      const recreated = await post('manager', '/api/v1/assets/depreciation-runs', {
        periodYear: 2026,
        periodMonth: 1,
      });
      expect(recreated.status, JSON.stringify(recreated.body)).toBe(201);
      janRunId = recreated.body.id;
    });

    it('a posting the ledger refuses rolls the whole register back — atomicity', async () => {
      // 2025-06-15 falls in no accounting period at all; the ledger refuses, and the
      // per-asset updates written earlier in the same transaction must vanish with it.
      const response = await post(
        'manager',
        `/api/v1/assets/depreciation-runs/${janRunId}/post`,
        {
          expenseAccountId: depExpenseAccountId,
          accumulatedDepreciationAccountId: accumAccountId,
          entryDate: '2025-06-15',
          version: 1,
        },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(409);

      const run = await get('manager', `/api/v1/assets/depreciation-runs/${janRunId}`);
      expect(run.body.status).toBe('draft');
      expect(run.body.journalEntryId).toBeNull();

      const asset = await get('manager', `/api/v1/assets/${mainAssetId}`);
      expect(asset.body.accumulatedDepreciation).toBe('0.00');
      expect(asset.body.bookValue).toBe(COST);
    });

    it('posts every month of the asset’s life; the lines sum to cost minus salvage exactly', async () => {
      const monthly: string[] = [];
      let lastClosing = '';

      for (let year = 2026; year <= 2028; year += 1) {
        for (let month = 1; month <= 12; month += 1) {
          let runId: string;
          if (year === 2026 && month === 1) {
            runId = janRunId; // the draft recreated above
          } else {
            const created = await post('manager', '/api/v1/assets/depreciation-runs', {
              periodYear: year,
              periodMonth: month,
            });
            expect(created.status, JSON.stringify(created.body)).toBe(201);
            runId = created.body.id;
          }

          const posted = await post('manager', `/api/v1/assets/depreciation-runs/${runId}/post`, {
            expenseAccountId: depExpenseAccountId,
            accumulatedDepreciationAccountId: accumAccountId,
            version: 1,
          });
          expect(posted.status, JSON.stringify(posted.body)).toBe(201);
          expect(posted.body.status).toBe('posted');
          expect(posted.body.postedAt).toBeTruthy();
          expect(posted.body.journalEntryId).toBeTruthy();

          const line = (
            posted.body.lines as Array<{
              id: string;
              assetId: string;
              depreciation: string;
              closingBookValue: string;
            }>
          ).find((candidate) => candidate.assetId === mainAssetId)!;
          expect(line, `run ${year}-${month} should carry the server`).toBeTruthy();
          // Every monthly part is one of the two allocate() slice sizes — never a float
          // artifact like 1354.5955555.
          expect(['1354.59', '1354.60']).toContain(line.depreciation);
          monthly.push(line.depreciation);
          lastClosing = line.closingBookValue;

          if (year === 2026 && month === 1) {
            firstPostedRunId = runId;
            firstPostedLineId = line.id;
            firstPostedEntryId = posted.body.journalEntryId;
          }
        }
      }

      // The heart of the module: 36 monthly lines reconstruct the depreciable amount to
      // the poisa. Any independent divide-and-round would lose or invent money here.
      expect(monthly).toHaveLength(36);
      const total = Money.sum(monthly.map((amount) => Money.fromDecimalString(amount)));
      expect(total.toDecimalString()).toBe(DEPRECIABLE);

      // The final month lands the book value exactly on the salvage value.
      expect(lastClosing).toBe(SALVAGE);

      const asset = await get('manager', `/api/v1/assets/${mainAssetId}`);
      expect(asset.body.accumulatedDepreciation).toBe(DEPRECIABLE);
      expect(asset.body.bookValue).toBe(SALVAGE);
    }, 240_000);

    it('a month past the asset’s life has nothing to depreciate', async () => {
      const response = await post('manager', '/api/v1/assets/depreciation-runs', {
        periodYear: 2029,
        periodMonth: 1,
      });
      expect(response.status).toBe(409);
      expect(JSON.stringify(response.body)).toContain('No asset has depreciation to record');
    });

    it('each posting wrote ONE balanced system journal entry for exactly the run total', async () => {
      const entry = await get('accountant', `/api/v1/accounting/journal/${firstPostedEntryId}`);
      expect(entry.status, JSON.stringify(entry.body)).toBe(200);
      expect(entry.body.status).toBe('posted');
      expect(entry.body.isSystemGenerated).toBe(true);
      expect(entry.body.referenceType).toBe('depreciation_run');
      expect(entry.body.referenceId).toBe(firstPostedRunId);

      const lines = entry.body.lines as Array<{
        accountId: string;
        debit: string;
        credit: string;
      }>;
      expect(lines).toHaveLength(2);
      expect(lines.find((line) => line.accountId === depExpenseAccountId)!.debit).toBe('1354.60');
      expect(lines.find((line) => line.accountId === accumAccountId)!.credit).toBe('1354.60');
    });

    it('the posting left exactly one audit record — the service’s, not a duplicate', async () => {
      const migrator = testClient();
      await migrator.connect();
      try {
        const { rows } = await migrator.query<{ n: number }>(
          `select count(*)::int as n from audit_logs
            where module = 'assets' and resource_type = 'depreciation_run'
              and action = 'approve' and resource_id = $1`,
          [firstPostedRunId],
        );
        expect(rows[0]!.n).toBe(1);
      } finally {
        await migrator.end();
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // A posted run is immutable — raw SQL as the application role
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('posted-run immutability (raw SQL)', () => {
    it('refuses updating a posted run', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        const error = await expectRefusal(
          client.query(`update depreciation_runs set total_depreciation = '0.01' where id = $1`, [
            firstPostedRunId,
          ]),
        );
        expect(error.message).toMatch(/posted and immutable/);
      });
    });

    /**
     * Two layers, asserted separately, because they fail at different depths.
     *
     * 0026 revokes DELETE from `shikkha_app` outright, so the application role never even
     * reaches the trigger — the privilege check refuses first. That is the stronger
     * guarantee and the one a compromised API would actually hit, so it is asserted as
     * such rather than being papered over by matching the trigger's wording.
     */
    it('refuses deleting a run outright — the app role holds no DELETE at all', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        const error = await expectRefusal(
          client.query(`delete from depreciation_runs where id = $1`, [firstPostedRunId]),
        );
        expect(error.code).toBe('42501');
        expect(error.message).toMatch(/permission denied for table depreciation_runs/);
      });
    });

    /**
     * ...and the trigger is the backstop for any role that *does* hold DELETE — the
     * migrator, a DBA, a future maintenance script. Without this the revoke above would be
     * the only thing standing between a hand-run `delete` and a lost depreciation history.
     */

    it('refuses updating a depreciation line — lines are append-only', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        const error = await expectRefusal(
          client.query(`update depreciation_lines set depreciation = '999999.00' where id = $1`, [
            firstPostedLineId,
          ]),
        );
        expect(error.message).toMatch(/append-only/);
      });
    });

    it('refuses deleting a depreciation line — no DELETE for the app role', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        const error = await expectRefusal(
          client.query(`delete from depreciation_lines where id = $1`, [firstPostedLineId]),
        );
        expect(error.code).toBe('42501');
        expect(error.message).toMatch(/permission denied for table depreciation_lines/);
      });
    });

    /**
     * The revoke above is the first layer; the trigger is the second, and this is the only
     * test that can reach it.
     *
     * Neither existing role exercises the trigger's DELETE branch: `shikkha_app` holds no
     * DELETE at all and is stopped by the privilege check, while `shikkha_migrator` is
     * deliberately exempt for retention operations (0026, matching the workflow guard in
     * 0014 and the journal guards in 0018). Left there, the branch that protects a posted
     * depreciation history from a hand-run `delete` would have no coverage whatsoever.
     *
     * So it is exercised through a throwaway role shaped like a future maintenance
     * account: holds DELETE, is not a member of the migrator. Everything — the role, the
     * grants, the attempted deletes — lives inside one transaction that is rolled back,
     * and each attempt is wrapped in a savepoint because the first refusal would otherwise
     * abort the transaction and mask the second.
     */
    it('the trigger refuses a delete from a non-migrator role that does hold DELETE', async () => {
      const migrator = testClient();
      await migrator.connect();
      try {
        await migrator.query('begin');
        await migrator.query('create role assets_delete_probe');
        await migrator.query(
          `grant select, delete on public.depreciation_runs, public.depreciation_lines
             to assets_delete_probe`,
        );

        // `force row level security` applies to the table owner too, so the row is invisible
        // until the tenant GUC is set — without it the delete would match nothing, the
        // trigger would never fire, and the test would pass for the wrong reason.
        await migrator.query(`select set_config('app.tenant_id', $1, false)`, [tenantA.tenantId]);

        await migrator.query('savepoint probe_run');
        await migrator.query('set role assets_delete_probe');
        const runError = await expectRefusal(
          migrator.query(`delete from public.depreciation_runs where id = $1`, [firstPostedRunId]),
        );
        expect(runError.message).toMatch(/never deleted/);
        await migrator.query('rollback to savepoint probe_run');

        await migrator.query('savepoint probe_line');
        await migrator.query('set role assets_delete_probe');
        const lineError = await expectRefusal(
          migrator.query(`delete from public.depreciation_lines where id = $1`, [
            firstPostedLineId,
          ]),
        );
        expect(lineError.message).toMatch(/append-only/);
        await migrator.query('rollback to savepoint probe_line');
      } finally {
        await migrator.query('rollback').catch(() => undefined);
        await migrator.end();
      }
    });

    it('refuses writing a new line into a posted run', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        const error = await expectRefusal(
          client.query(
            `insert into depreciation_lines
               (tenant_id, institution_id, run_id, asset_id,
                opening_book_value, depreciation, closing_book_value)
             values ($1, $2, $3, $4, '10.00', '1.00', '9.00')`,
            [tenantA.tenantId, tenantA.institutionId, firstPostedRunId, disposalAssetId],
          ),
        );
        expect(error.message).toMatch(/draft run/);
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Disposal — two people, and the ledger effect in the same transaction
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('disposal', () => {
    let disposalId: string;

    it('records a disposal request without touching the asset', async () => {
      const response = await post('owner', '/api/v1/assets/disposals', {
        assetId: disposalAssetId,
        disposedOn: '2026-04-10',
        method: 'sold',
        proceeds: '500.00',
        reason: 'Beyond economic repair; sold for parts to a local dealer',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.requestedBy).toBe(tenantA.users['owner']!.id);
      expect(response.body.approvedBy).toBeNull();
      disposalId = response.body.id;

      const asset = await get('manager', `/api/v1/assets/${disposalAssetId}`);
      expect(asset.body.status).toBe('in_store');
    });

    it('refuses a second request while the first awaits approval', async () => {
      const response = await post('manager', '/api/v1/assets/disposals', {
        assetId: disposalAssetId,
        disposedOn: '2026-04-11',
        method: 'scrapped',
        proceeds: '0.00',
        reason: 'A competing disposal request for the same photocopier',
      });
      expect(response.status).toBe(409);
    });

    it('the requester cannot approve, even holding every permission', async () => {
      // The owner holds '*' — every permission in the catalog — and is still refused.
      const response = await post('owner', `/api/v1/assets/disposals/${disposalId}/approve`, {
        version: 1,
      });
      expect(response.status).toBe(409);
      expect(JSON.stringify(response.body)).toContain('someone other than');
    });

    it('the DATABASE refuses approver = requester — asset_disposals_distinct_approver', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        const error = await expectRefusal(
          client.query(
            `update asset_disposals
                set approved_by = requested_by, approved_at = now()
              where id = $1`,
            [disposalId],
          ),
        );
        expect(error.constraint).toBe('asset_disposals_distinct_approver');
      });
    });

    it('a second person approves; the ledger entry posts in the same transaction', async () => {
      const response = await post('manager', `/api/v1/assets/disposals/${disposalId}/approve`, {
        version: 1,
        ledger: {
          assetAccountId: assetCostAccountId,
          accumulatedDepreciationAccountId: accumAccountId,
          gainLossAccountId,
          cashAccountId,
        },
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.disposal.approvedBy).toBeTruthy();
      expect(response.body.disposal.approvedBy).not.toBe(response.body.disposal.requestedBy);
      expect(response.body.disposal.journalEntryId).toBeTruthy();
      expect(response.body.asset.status).toBe('disposed');

      // Sold for 500.00 against an 8000.00 book value: bank the proceeds, write off the
      // cost, and the 7500.00 loss balances the entry.
      const entry = await get(
        'accountant',
        `/api/v1/accounting/journal/${response.body.disposal.journalEntryId}`,
      );
      expect(entry.status).toBe(200);
      expect(entry.body.referenceType).toBe('asset_disposal');
      expect(entry.body.isSystemGenerated).toBe(true);
      const lines = entry.body.lines as Array<{
        accountId: string;
        debit: string;
        credit: string;
      }>;
      expect(lines.find((line) => line.accountId === cashAccountId)!.debit).toBe('500.00');
      expect(lines.find((line) => line.accountId === assetCostAccountId)!.credit).toBe('8000.00');
      expect(lines.find((line) => line.accountId === gainLossAccountId)!.debit).toBe('7500.00');
    });

    it('a disposed asset can no longer be assigned', async () => {
      const response = await post('manager', '/api/v1/assets/assignments', {
        assetId: disposalAssetId,
        assigneeKind: 'employee',
        employeeId: tenantA.employeeIds[0],
        assignedOn: '2026-05-01',
        conditionOut: 'poor',
      });
      expect(response.status).toBe(409);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Tenant isolation
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('tenant isolation', () => {
    it('another tenant gets a 404, not a 403, for an asset it names exactly', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/assets/${mainAssetId}`)
        .set('Authorization', `Bearer ${tokens['otherOwner']}`)
        .set('x-institution-id', tenantB.institutionId);

      // 404, not 403: confirming the record exists elsewhere is itself a leak.
      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain('AST-0001');
    });

    it('another tenant cannot borrow the institution header', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/assets')
        .set('Authorization', `Bearer ${tokens['otherOwner']}`)
        .set('x-institution-id', tenantA.institutionId);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('another tenant’s own register is empty rather than leaky', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/assets')
        .set('Authorization', `Bearer ${tokens['otherOwner']}`)
        .set('x-institution-id', tenantB.institutionId);

      expect(response.status).toBe(200);
      expect(response.body.meta.total).toBe(0);
      expect(response.body.data).toEqual([]);
    });

    it('row-level security hides every register row from the other tenant, even in raw SQL', async () => {
      await asAppRole(tenantB.tenantId, async (client) => {
        const assetsCount = await client.query<{ n: number }>(
          `select count(*)::int as n from assets`,
        );
        expect(assetsCount.rows[0]!.n).toBe(0);

        const runsCount = await client.query<{ n: number }>(
          `select count(*)::int as n from depreciation_runs`,
        );
        expect(runsCount.rows[0]!.n).toBe(0);
      });
    });
  });
});
