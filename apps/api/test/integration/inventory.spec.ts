/**
 * Inventory and procurement integration suite (Phase 19).
 *
 * This file exists to hold the stock invariants, not to prove the routes return 200. The
 * load-bearing tests go UNDER the service: a raw `pg` client connected as `shikkha_app` —
 * the same unprivileged role the API uses — attacks the stock ledger directly and the
 * DATABASE must refuse it:
 *
 *  - stock can never go negative (`stock_levels_quantity_non_negative`, applied by the
 *    `inventory_stock_movements_apply_level` trigger in the movement's own transaction),
 *  - `stock_movements` refuses UPDATE and DELETE (`inventory_stock_movements_no_mutation`),
 *  - `stock_levels` refuses every writer but the movement trigger
 *    (`inventory_stock_levels_guard`),
 *  - received can never exceed ordered (`purchase_order_items_received_within_ordered`),
 *  - a receipt without a cost and a correction without a reason are refused outright.
 *
 * Above the database, the service-level rules: the derived level always equals the sum of
 * the movement log (the reconciliation endpoint reports zero drift after a batch of awkward
 * operations), weighted average cost is exact decimal arithmetic, a requester cannot approve
 * their own requisition even holding every permission, a goods receipt posts one balanced
 * journal entry atomically (both the receipt and the entry exist, or neither), and none of
 * it crosses a tenant boundary.
 *
 * Everything HTTP runs through the real guards, interceptors and database, because the
 * properties under test live precisely in the parts a stub would replace.
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

describe('Inventory and procurement', () => {
  let app: INestApplication;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
  const tokens: Record<string, string> = {};

  // Catalogue built by the suite, captured for later assertions.
  let categoryId: string;
  let penItemId: string; // stock-operation batch + transfer neutrality in valuation
  let inkItemId: string; // weighted-average-cost exactness
  let chalkItemId: string; // low-stock report
  let paperItemId: string; // procurement flow
  let mainStoreId: string;
  let labStoreId: string;
  let supplierId: string;

  // Chart of accounts for the goods-receipt journal entry.
  let stockAccountId: string; // 1200, postable — debited per item
  let payableAccountId: string; // 2100, postable — credited
  // 2900 is a non-postable header, used to force a ledger failure mid-receipt.

  // Procurement documents.
  let requisitionId: string;
  let purchaseOrderId: string;
  let paperOrderLineId: string;
  let receiptId: string;
  let receiptJournalEntryId: string;

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

  /** One-off query as the migrator, which sees across tenants — for state assertions only. */
  async function migratorQuery<T extends Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const client = testClient();
    await client.connect();
    try {
      const { rows } = await client.query<T>(text, params);
      return rows;
    } finally {
      await client.end();
    }
  }

  /**
   * Run a callback as the unprivileged application role inside one transaction with the
   * tenant GUC set — exactly the credentials a compromised application would hold. The
   * transaction is rolled back afterwards, so a refused write cannot leak state.
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

  /** Insert a raw stock movement in tenant A as the app role. */
  async function insertRawMovement(
    client: Client,
    opts: {
      itemId: string;
      storeId: string;
      kind: string;
      quantity: string;
      unitCost?: string | null;
      reason?: string | null;
      referenceId?: string | null;
    },
  ): Promise<void> {
    await client.query(
      `insert into stock_movements
         (tenant_id, institution_id, item_id, store_id, kind, quantity, unit_cost, reason,
          reference_id, moved_on)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, '2026-06-20')`,
      [
        tenantA.tenantId,
        tenantA.institutionId,
        opts.itemId,
        opts.storeId,
        opts.kind,
        opts.quantity,
        opts.unitCost ?? null,
        opts.reason ?? null,
        opts.referenceId ?? null,
      ],
    );
  }

  beforeAll(async () => {
    app = await createTestApp();
    await truncateAll();
    tenantA = await seedTenant('inva', { students: 1 });
    tenantB = await seedTenant('invb', { students: 1 });

    for (const key of ['owner', 'accountant', 'teacher']) {
      tokens[key] = await login(tenantA.users[key]!.email);
    }
    // Tenant B's accountant holds inventory.view — the right credentials for proving that a
    // cross-tenant read fails because of tenancy, not because of a missing permission.
    tokens['otherViewer'] = await login(tenantB.users['accountant']!.email);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // The migration's controls are actually installed — asserted by name, so a renamed or
  // dropped trigger fails here instead of silently disabling an invariant.
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('database controls from 0025_inventory', () => {
    it('installs the append-only and level-maintenance triggers on stock_movements', async () => {
      const rows = await migratorQuery<{ tgname: string }>(
        `select tgname from pg_trigger
          where tgrelid = 'public.stock_movements'::regclass and not tgisinternal`,
      );
      const names = rows.map((row) => row.tgname);
      expect(names).toContain('inventory_stock_movements_no_mutation');
      expect(names).toContain('inventory_stock_movements_apply_level');
    });

    it('installs the derived-write guard on stock_levels', async () => {
      const rows = await migratorQuery<{ tgname: string }>(
        `select tgname from pg_trigger
          where tgrelid = 'public.stock_levels'::regclass and not tgisinternal`,
      );
      expect(rows.map((row) => row.tgname)).toContain('inventory_stock_levels_guard');
    });

    it('carries the non-negative check and the trigger upsert target index on stock_levels', async () => {
      const checks = await migratorQuery<{ conname: string }>(
        `select conname from pg_constraint
          where conrelid = 'public.stock_levels'::regclass and contype = 'c'`,
      );
      expect(checks.map((row) => row.conname)).toContain('stock_levels_quantity_non_negative');

      const indexes = await migratorQuery<{ indexname: string }>(
        `select indexname from pg_indexes
          where schemaname = 'public' and tablename = 'stock_levels'`,
      );
      expect(indexes.map((row) => row.indexname)).toContain('stock_levels_item_store_key');
    });

    it('carries the received-within-ordered check on purchase_order_items', async () => {
      const checks = await migratorQuery<{ conname: string }>(
        `select conname from pg_constraint
          where conrelid = 'public.purchase_order_items'::regclass and contype = 'c'`,
      );
      expect(checks.map((row) => row.conname)).toContain(
        'purchase_order_items_received_within_ordered',
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Catalogue setup and permission enforcement
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('catalogue and permissions', () => {
    it('creates a category, items, stores and a supplier', async () => {
      const category = await post('owner', '/api/v1/inventory/categories', {
        nameEn: 'Stationery',
        nameBn: 'স্টেশনারি',
      });
      expect(category.status, JSON.stringify(category.body)).toBe(201);
      categoryId = category.body.id;

      const pen = await post('owner', '/api/v1/inventory/items', {
        code: 'PEN',
        nameEn: 'Ballpoint pen',
        categoryId,
        unit: 'piece',
        reorderLevel: '10',
        ledgerAccountCode: '1200',
      });
      expect(pen.status, JSON.stringify(pen.body)).toBe(201);
      expect(pen.body.reorderLevel).toBe('10.000');
      penItemId = pen.body.id;

      const ink = await post('owner', '/api/v1/inventory/items', {
        code: 'INK',
        nameEn: 'Printer ink',
        categoryId,
        unit: 'litre',
        ledgerAccountCode: '1200',
      });
      expect(ink.status).toBe(201);
      inkItemId = ink.body.id;

      const chalk = await post('owner', '/api/v1/inventory/items', {
        code: 'CHALK',
        nameEn: 'Chalk box',
        unit: 'box',
        reorderLevel: '5',
      });
      expect(chalk.status).toBe(201);
      chalkItemId = chalk.body.id;

      const paper = await post('owner', '/api/v1/inventory/items', {
        code: 'PAPER',
        nameEn: 'A4 paper ream',
        unit: 'piece',
        ledgerAccountCode: '1200',
      });
      expect(paper.status).toBe(201);
      paperItemId = paper.body.id;

      const mainStore = await post('owner', '/api/v1/inventory/stores', {
        code: 'MAIN',
        nameEn: 'Main store',
        campusId: tenantA.campusId,
      });
      expect(mainStore.status, JSON.stringify(mainStore.body)).toBe(201);
      mainStoreId = mainStore.body.id;

      const labStore = await post('owner', '/api/v1/inventory/stores', {
        code: 'LAB',
        nameEn: 'Science lab store',
        campusId: tenantA.campusId,
      });
      expect(labStore.status).toBe(201);
      labStoreId = labStore.body.id;

      const supplier = await post('owner', '/api/v1/inventory/suppliers', {
        code: 'SUP-1',
        nameEn: 'Dhaka Stationers Ltd',
        phone: '029876543',
      });
      expect(supplier.status, JSON.stringify(supplier.body)).toBe(201);
      supplierId = supplier.body.id;
    });

    it('refuses the catalogue to a teacher, with no permission leaked', async () => {
      const listed = await get('teacher', '/api/v1/inventory/items');
      expect(listed.status).toBe(403);
      expect(listed.body.error.code).toBe('FORBIDDEN');

      const created = await post('teacher', '/api/v1/inventory/items', {
        code: 'SNEAK',
        nameEn: 'Sneaky item',
      });
      expect(created.status).toBe(403);
      // Naming the missing permission would be free reconnaissance.
      expect(JSON.stringify(created.body)).not.toContain('inventory.manage');
    });

    it('the accountant can read the catalogue but not maintain it', async () => {
      const listed = await get('accountant', '/api/v1/inventory/items');
      expect(listed.status).toBe(200);
      expect(listed.body.meta.total).toBe(4);

      const created = await post('accountant', '/api/v1/inventory/items', {
        code: 'NOPE',
        nameEn: 'Not allowed',
      });
      expect(created.status).toBe(403);
      expect(JSON.stringify(created.body)).not.toContain('inventory.manage');

      const received = await post('accountant', '/api/v1/inventory/stock/receive', {
        itemId: penItemId,
        storeId: mainStoreId,
        quantity: '1',
        unitCost: '1.00',
        movedOn: '2026-06-01',
      });
      expect(received.status).toBe(403);
    });

    it('refuses every inventory route without the institution header', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/inventory/items')
        .set('Authorization', `Bearer ${tokens['owner']}`);
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).toContain('x-institution-id');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Accounting groundwork — the goods receipt posts through the real ledger
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('accounting groundwork', () => {
    it('creates the stock and payable accounts and a non-postable header', async () => {
      const stock = await post('owner', '/api/v1/accounting/accounts', {
        code: '1200',
        nameEn: 'Stock in hand',
        type: 'asset',
        normalBalance: 'debit',
      });
      expect(stock.status, JSON.stringify(stock.body)).toBe(201);
      stockAccountId = stock.body.id;

      const payable = await post('owner', '/api/v1/accounting/accounts', {
        code: '2100',
        nameEn: 'Supplier payables',
        type: 'liability',
        normalBalance: 'credit',
      });
      expect(payable.status).toBe(201);
      payableAccountId = payable.body.id;

      const header = await post('owner', '/api/v1/accounting/accounts', {
        code: '2900',
        nameEn: 'Liabilities (header)',
        type: 'liability',
        normalBalance: 'credit',
        isPostable: false,
      });
      expect(header.status).toBe(201);
      expect(header.body.isPostable).toBe(false);
    });

    it('lays out an open fiscal year around the receipt dates', async () => {
      const response = await post('owner', '/api/v1/accounting/fiscal-years', {
        name: 'FY 2026',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        periodLayout: 'monthly',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.periods).toHaveLength(12);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Stock operations — a batch of awkward movements, and the level that cannot drift
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('stock operations and the derived level', () => {
    it('receives, transfers, issues, adjusts and writes off — every movement normalised', async () => {
      const received = await post('owner', '/api/v1/inventory/stock/receive', {
        itemId: penItemId,
        storeId: mainStoreId,
        quantity: '100',
        unitCost: '5.50',
        movedOn: '2026-06-01',
        note: 'Opening balance',
      });
      expect(received.status, JSON.stringify(received.body)).toBe(201);
      expect(received.body.kind).toBe('receipt');
      expect(received.body.quantity).toBe('100.000');
      expect(received.body.unitCost).toBe('5.50');

      const transferred = await post('owner', '/api/v1/inventory/stock/transfer', {
        itemId: penItemId,
        fromStoreId: mainStoreId,
        toStoreId: labStoreId,
        quantity: '30',
        movedOn: '2026-06-02',
      });
      expect(transferred.status, JSON.stringify(transferred.body)).toBe(201);
      // The two halves of the transfer share a reference id so they can always be paired.
      expect(transferred.body.out.kind).toBe('transfer_out');
      expect(transferred.body.in.kind).toBe('transfer_in');
      expect(transferred.body.out.referenceId).toBe(transferred.body.in.referenceId);
      expect(transferred.body.out.referenceId).toBeTruthy();

      const issued = await post('owner', '/api/v1/inventory/stock/issue', {
        itemId: penItemId,
        storeId: labStoreId,
        quantity: '20',
        movedOn: '2026-06-03',
        issuedTo: 'Science department',
      });
      expect(issued.status, JSON.stringify(issued.body)).toBe(201);
      expect(issued.body.unitCost).toBeNull();

      const adjusted = await post('owner', '/api/v1/inventory/stock/adjust', {
        itemId: penItemId,
        storeId: labStoreId,
        quantity: '2',
        unitCost: '5.50',
        movedOn: '2026-06-04',
        reason: 'Physical count found two more boxes behind the shelf',
      });
      expect(adjusted.status, JSON.stringify(adjusted.body)).toBe(201);
      expect(adjusted.body.kind).toBe('adjustment');

      const writtenOff = await post('owner', '/api/v1/inventory/stock/write-off', {
        itemId: penItemId,
        storeId: labStoreId,
        quantity: '5',
        movedOn: '2026-06-05',
        reason: 'Water damage from the June storm ruined five pens',
      });
      expect(writtenOff.status, JSON.stringify(writtenOff.body)).toBe(201);
      expect(writtenOff.body.kind).toBe('write_off');
    });

    it('the levels are exactly the running sums: 70.000 in MAIN, 7.000 in LAB', async () => {
      const response = await get('owner', '/api/v1/inventory/stock/levels', {
        itemId: penItemId,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const byStore = new Map(
        (response.body.data as Array<{ storeId: string; quantity: string }>).map((row) => [
          row.storeId,
          row.quantity,
        ]),
      );
      expect(byStore.get(mainStoreId)).toBe('70.000');
      expect(byStore.get(labStoreId)).toBe('7.000');
    });

    it('refuses an over-issue with a 409 before the database has to', async () => {
      const response = await post('owner', '/api/v1/inventory/stock/issue', {
        itemId: penItemId,
        storeId: labStoreId,
        quantity: '999',
        movedOn: '2026-06-06',
      });
      expect(response.status).toBe(409);
      expect(JSON.stringify(response.body)).toContain('Not enough stock');
    });

    it('refuses a negative adjustment that carries a cost', async () => {
      const response = await post('owner', '/api/v1/inventory/stock/adjust', {
        itemId: penItemId,
        storeId: labStoreId,
        quantity: '-1',
        unitCost: '5.50',
        movedOn: '2026-06-06',
        reason: 'A downward count correction should carry no cost',
      });
      expect(response.status).toBe(422);
    });

    it('receives fractional quantities for the weighted-average item', async () => {
      const first = await post('owner', '/api/v1/inventory/stock/receive', {
        itemId: inkItemId,
        storeId: mainStoreId,
        quantity: '2.5',
        unitCost: '40.10',
        movedOn: '2026-06-01',
      });
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(first.body.quantity).toBe('2.500');

      const second = await post('owner', '/api/v1/inventory/stock/receive', {
        itemId: inkItemId,
        storeId: mainStoreId,
        quantity: '1.5',
        unitCost: '60.30',
        movedOn: '2026-06-02',
      });
      expect(second.status).toBe(201);

      const issued = await post('owner', '/api/v1/inventory/stock/issue', {
        itemId: inkItemId,
        storeId: mainStoreId,
        quantity: '1.25',
        movedOn: '2026-06-03',
        issuedTo: 'Office printer',
      });
      expect(issued.status).toBe(201);
    });

    it('stocks the low-stock demonstration item below its reorder level', async () => {
      const response = await post('owner', '/api/v1/inventory/stock/receive', {
        itemId: chalkItemId,
        storeId: mainStoreId,
        quantity: '2',
        unitCost: '3.00',
        movedOn: '2026-06-01',
      });
      expect(response.status).toBe(201);
    });

    it('the movement history is filterable and append-only in shape', async () => {
      const transfersIn = await get('owner', '/api/v1/inventory/stock/movements', {
        itemId: penItemId,
        kind: 'transfer_in',
      });
      expect(transfersIn.status).toBe(200);
      expect(transfersIn.body.meta.total).toBe(1);
      expect(transfersIn.body.data[0].storeId).toBe(labStoreId);

      const all = await get('owner', '/api/v1/inventory/stock/movements', {
        itemId: penItemId,
      });
      expect(all.status).toBe(200);
      expect(all.body.meta.total).toBe(6); // receipt, out, in, issue, adjustment, write_off
    });

    it('the reconciliation endpoint reports zero drift after the batch', async () => {
      const response = await get('owner', '/api/v1/inventory/stock/reconciliation');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.clean).toBe(true);
      expect(response.body.mismatches).toEqual([]);
      expect(response.body.checkedLevels).toBeGreaterThan(0);
    });

    it('every stock level equals the sum of its movements — checked in raw SQL', async () => {
      const levels = await migratorQuery<{ n: number }>(
        `select count(*)::int as n from stock_levels where tenant_id = $1`,
        [tenantA.tenantId],
      );
      expect(levels[0]!.n).toBeGreaterThan(0);

      const drifted = await migratorQuery<{ n: number }>(
        `select count(*)::int as n
           from stock_levels l
           left join (
             select item_id, store_id,
                    sum(case when kind in ('issue', 'transfer_out', 'write_off')
                             then -quantity else quantity end) as movement_sum
               from stock_movements
              where tenant_id = $1
              group by item_id, store_id
           ) m on m.item_id = l.item_id and m.store_id = l.store_id
          where l.tenant_id = $1
            and l.quantity is distinct from coalesce(m.movement_sum, 0)`,
        [tenantA.tenantId],
      );
      expect(drifted[0]!.n).toBe(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Reports — exact decimal arithmetic, never floating point
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('reports', () => {
    it('weighted average cost is exact to the fourth decimal', async () => {
      const response = await get('owner', '/api/v1/inventory/reports/valuation');
      expect(response.status, JSON.stringify(response.body)).toBe(200);

      const rows = response.body.items as Array<{
        item_id: string;
        on_hand: string;
        weighted_average_cost: string | null;
        stock_value: string;
      }>;

      // INK: (2.500 × 40.10 + 1.500 × 60.30) / 4.000 = 190.70 / 4.000 = 47.6750 exactly;
      // 2.750 on hand × 47.6750 = 131.10625 → 131.11. A float path disagrees eventually.
      const ink = rows.find((row) => row.item_id === inkItemId)!;
      expect(ink.on_hand).toBe('2.750');
      expect(ink.weighted_average_cost).toBe('47.6750');
      expect(ink.stock_value).toBe('131.11');

      // PEN: the transfer moved 30 pieces between stores without touching the cost basis, so
      // the average stays (550.00 + 11.00) / 102 = 5.5000, valued over 77 on hand = 423.50.
      const pen = rows.find((row) => row.item_id === penItemId)!;
      expect(pen.on_hand).toBe('77.000');
      expect(pen.weighted_average_cost).toBe('5.5000');
      expect(pen.stock_value).toBe('423.50');

      // 131.11 + 423.50 + 6.00 (chalk) + 0.00 (paper, no stock yet) — summed with Money.
      expect(response.body.totalValue).toBe('560.61');
    });

    it('the low-stock report names only items at or below their reorder level', async () => {
      const response = await get('owner', '/api/v1/inventory/reports/low-stock');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const rows = response.body.items as Array<{
        item_id: string;
        on_hand: string;
        reorder_level: string;
      }>;

      const chalk = rows.find((row) => row.item_id === chalkItemId)!;
      expect(chalk, 'chalk (2 on hand, reorder at 5) should be listed').toBeTruthy();
      expect(chalk.on_hand).toBe('2.000');
      expect(chalk.reorder_level).toBe('5.000');

      // 77 pens against a reorder level of 10 is healthy stock.
      expect(rows.find((row) => row.item_id === penItemId)).toBeUndefined();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Procurement — requisition, four eyes, purchase order, atomic goods receipt
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('procurement', () => {
    it('the accountant raises and submits a requisition', async () => {
      const created = await post('accountant', '/api/v1/inventory/requisitions', {
        neededBy: '2026-07-01',
        justification: 'A4 paper stock will run out before the half-yearly exams',
        items: [{ itemId: paperItemId, quantity: '50', estimatedUnitCost: '25.00' }],
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body.status).toBe('draft');
      expect(created.body.requestedBy).toBe(tenantA.users['accountant']!.id);
      expect(created.body.items).toHaveLength(1);
      requisitionId = created.body.id;

      const submitted = await post(
        'accountant',
        `/api/v1/inventory/requisitions/${requisitionId}/submit`,
        { version: 1 },
      );
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
      expect(submitted.body.status).toBe('submitted');
      expect(submitted.body.version).toBe(2);
    });

    it('a teacher cannot raise a requisition; the accountant cannot approve one', async () => {
      const teacherAttempt = await post('teacher', '/api/v1/inventory/requisitions', {
        justification: 'Teachers do not hold the purchase.request permission',
        items: [{ itemId: paperItemId, quantity: '1' }],
      });
      expect(teacherAttempt.status).toBe(403);

      const accountantAttempt = await post(
        'accountant',
        `/api/v1/inventory/requisitions/${requisitionId}/approve`,
        { version: 2 },
      );
      expect(accountantAttempt.status).toBe(403);
      expect(JSON.stringify(accountantAttempt.body)).not.toContain('inventory.purchase.approve');
    });

    it('the requester cannot approve their own requisition even holding every permission', async () => {
      // The owner holds '*' — including inventory.purchase.approve — and is still refused.
      const own = await post('owner', '/api/v1/inventory/requisitions', {
        justification: 'The owner wants a new filing cabinet for the office',
        items: [{ itemId: paperItemId, quantity: '2' }],
      });
      expect(own.status).toBe(201);
      const ownId = own.body.id as string;

      const submitted = await post('owner', `/api/v1/inventory/requisitions/${ownId}/submit`, {
        version: 1,
      });
      expect(submitted.status).toBe(201);

      const approved = await post('owner', `/api/v1/inventory/requisitions/${ownId}/approve`, {
        version: 2,
      });
      expect(approved.status).toBe(403);
      expect(JSON.stringify(approved.body)).toContain('your own purchase requisition');

      const rejected = await post('owner', `/api/v1/inventory/requisitions/${ownId}/reject`, {
        reason: 'Trying to reject my own requisition instead',
        version: 2,
      });
      expect(rejected.status).toBe(403);
      expect(JSON.stringify(rejected.body)).toContain('your own purchase requisition');

      // The refusals changed nothing.
      const fetched = await get('owner', `/api/v1/inventory/requisitions/${ownId}`);
      expect(fetched.status).toBe(200);
      expect(fetched.body.requisition.status).toBe('submitted');
    });

    it('a different budget-holder approves, and the decision is audited exactly once', async () => {
      const response = await post(
        'owner',
        `/api/v1/inventory/requisitions/${requisitionId}/approve`,
        { note: 'Within the stationery budget for this term', version: 2 },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('approved');
      expect(response.body.decidedBy).toBe(tenantA.users['owner']!.id);

      // recordedBy: 'service' — the service wrote the row inside the transaction, and the
      // interceptor must not have written a duplicate with a null previous_value.
      const rows = await migratorQuery<{ n: number }>(
        `select count(*)::int as n from audit_logs
          where module = 'inventory' and resource_type = 'purchase_requisition'
            and action = 'approve' and resource_id = $1`,
        [requisitionId],
      );
      expect(rows[0]!.n).toBe(1);
    });

    it('an approved requisition cannot be approved again', async () => {
      const response = await post(
        'owner',
        `/api/v1/inventory/requisitions/${requisitionId}/approve`,
        { version: 3 },
      );
      expect(response.status).toBe(409);
      expect(JSON.stringify(response.body)).toContain('Only a submitted requisition');
    });

    it('a rejection carries its reason and is audited exactly once', async () => {
      const created = await post('accountant', '/api/v1/inventory/requisitions', {
        justification: 'Spare toner cartridges for the office printer',
        items: [{ itemId: paperItemId, quantity: '5' }],
      });
      expect(created.status).toBe(201);
      const rejectedId = created.body.id as string;
      await post('accountant', `/api/v1/inventory/requisitions/${rejectedId}/submit`, {
        version: 1,
      });

      const rejected = await post(
        'owner',
        `/api/v1/inventory/requisitions/${rejectedId}/reject`,
        { reason: 'The toner budget is exhausted for this quarter', version: 2 },
      );
      expect(rejected.status, JSON.stringify(rejected.body)).toBe(201);
      expect(rejected.body.status).toBe('rejected');
      expect(rejected.body.decisionReason).toBe('The toner budget is exhausted for this quarter');

      const rows = await migratorQuery<{ n: number }>(
        `select count(*)::int as n from audit_logs
          where module = 'inventory' and resource_type = 'purchase_requisition'
            and action = 'reject' and resource_id = $1`,
        [rejectedId],
      );
      expect(rows[0]!.n).toBe(1);
    });

    it('creates and issues a purchase order with exact integer money arithmetic', async () => {
      const created = await post('owner', '/api/v1/inventory/purchase-orders', {
        supplierId,
        requisitionId,
        orderedOn: '2026-06-10',
        expectedOn: '2026-06-20',
        tax: '2.53',
        items: [{ itemId: paperItemId, quantity: '10', unitCost: '25.25' }],
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body.orderNumber).toBe('PO-2026-000001');
      expect(created.body.subtotal).toBe('252.50'); // 10 × 25.25, computed in poisa
      expect(created.body.tax).toBe('2.53');
      expect(created.body.total).toBe('255.03');
      expect(created.body.status).toBe('draft');
      purchaseOrderId = created.body.id;
      paperOrderLineId = created.body.items[0].id;

      const issued = await post(
        'owner',
        `/api/v1/inventory/purchase-orders/${purchaseOrderId}/issue`,
        { version: 1 },
      );
      expect(issued.status, JSON.stringify(issued.body)).toBe(201);
      expect(issued.body.status).toBe('issued');

      // Issuing the order moves the requisition's lifecycle along with it.
      const requisition = await get('owner', `/api/v1/inventory/requisitions/${requisitionId}`);
      expect(requisition.body.requisition.status).toBe('ordered');
    });

    it('refuses receiving beyond the ordered quantity — on one line and split across lines', async () => {
      const single = await post(
        'owner',
        `/api/v1/inventory/purchase-orders/${purchaseOrderId}/receipts`,
        {
          receivedOn: '2026-06-15',
          creditAccountCode: '2100',
          items: [
            { orderItemId: paperOrderLineId, quantity: '12', unitCost: '25.25', storeId: mainStoreId },
          ],
        },
      );
      expect(single.status).toBe(409);
      expect(JSON.stringify(single.body)).toContain('exceed the ordered quantity');

      // Two receipt lines against the same order line must not slip past the cap together.
      const split = await post(
        'owner',
        `/api/v1/inventory/purchase-orders/${purchaseOrderId}/receipts`,
        {
          receivedOn: '2026-06-15',
          creditAccountCode: '2100',
          items: [
            { orderItemId: paperOrderLineId, quantity: '6', unitCost: '25.25', storeId: mainStoreId },
            { orderItemId: paperOrderLineId, quantity: '5', unitCost: '25.25', storeId: labStoreId },
          ],
        },
      );
      expect(split.status).toBe(409);
      expect(JSON.stringify(split.body)).toContain('exceed the ordered quantity');
    });

    it('the accountant cannot receive goods — separation of duties', async () => {
      const response = await post(
        'accountant',
        `/api/v1/inventory/purchase-orders/${purchaseOrderId}/receipts`,
        {
          receivedOn: '2026-06-15',
          creditAccountCode: '2100',
          items: [
            { orderItemId: paperOrderLineId, quantity: '1', unitCost: '25.25', storeId: mainStoreId },
          ],
        },
      );
      expect(response.status).toBe(403);
    });

    it('a goods receipt posts one balanced system journal entry in the same transaction', async () => {
      const response = await post(
        'owner',
        `/api/v1/inventory/purchase-orders/${purchaseOrderId}/receipts`,
        {
          receivedOn: '2026-06-15',
          creditAccountCode: '2100',
          items: [
            { orderItemId: paperOrderLineId, quantity: '4', unitCost: '25.25', storeId: mainStoreId },
          ],
        },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.orderStatus).toBe('partially_received');
      expect(response.body.journalEntryId).toBeTruthy();
      expect(response.body.journalEntryNumber).toBe('JE-2026-000001');
      expect(response.body.receipt.journalEntryId).toBe(response.body.journalEntryId);
      receiptId = response.body.receipt.id;
      receiptJournalEntryId = response.body.journalEntryId;

      // The journal entry: debit stock 101.00 (4 × 25.25), credit payables 101.00.
      const entry = await get('owner', `/api/v1/accounting/journal/${receiptJournalEntryId}`);
      expect(entry.status, JSON.stringify(entry.body)).toBe(200);
      expect(entry.body.status).toBe('posted');
      expect(entry.body.isSystemGenerated).toBe(true);
      expect(entry.body.sourceModule).toBe('inventory');
      expect(entry.body.referenceType).toBe('goods_receipt');
      expect(entry.body.referenceId).toBe(receiptId);
      const lines = entry.body.lines as Array<{ accountId: string; debit: string; credit: string }>;
      expect(lines).toHaveLength(2);
      expect(lines.find((line) => line.accountId === stockAccountId)!.debit).toBe('101.00');
      expect(lines.find((line) => line.accountId === payableAccountId)!.credit).toBe('101.00');

      // The receipt row itself carries the link, durably.
      const linked = await migratorQuery<{ journal_entry_id: string }>(
        `select journal_entry_id from goods_receipts where id = $1`,
        [receiptId],
      );
      expect(linked[0]!.journal_entry_id).toBe(receiptJournalEntryId);

      // Stock and order progress moved with it.
      const order = await get('owner', `/api/v1/inventory/purchase-orders/${purchaseOrderId}`);
      expect(order.body.order.status).toBe('partially_received');
      expect(order.body.items[0].receivedQuantity).toBe('4.000');
      expect(order.body.receipts).toHaveLength(1);

      const level = await get('owner', '/api/v1/inventory/stock/levels', {
        itemId: paperItemId,
        storeId: mainStoreId,
      });
      expect(level.body.data[0].quantity).toBe('4.000');
    });

    it('the receipt is audited exactly once, by the service, with the money as a string', async () => {
      const rows = await migratorQuery<{ n: number }>(
        `select count(*)::int as n from audit_logs
          where module = 'inventory' and resource_type = 'goods_receipt' and resource_id = $1`,
        [receiptId],
      );
      // recordedBy: 'service' — a second interceptor-written row would have a null
      // previous_value and double-count the receipt.
      expect(rows[0]!.n).toBe(1);

      const [row] = await migratorQuery<{ new_value: Record<string, unknown> }>(
        `select new_value from audit_logs
          where module = 'inventory' and resource_type = 'goods_receipt' and resource_id = $1`,
        [receiptId],
      );
      expect(row!.new_value['totalValue']).toBe('101.00');
      expect(row!.new_value['orderNumber']).toBe('PO-2026-000001');
      expect(row!.new_value['journalEntryId']).toBe(receiptJournalEntryId);
    });

    it('a receipt whose journal posting fails leaves NOTHING behind — receipt, movements, progress', async () => {
      // 2900 exists in the chart but is a non-postable header: the service's existence check
      // passes, the receipt and movements are written, and then the ledger refuses — so the
      // whole transaction must roll back.
      const response = await post(
        'owner',
        `/api/v1/inventory/purchase-orders/${purchaseOrderId}/receipts`,
        {
          receivedOn: '2026-06-16',
          creditAccountCode: '2900',
          items: [
            { orderItemId: paperOrderLineId, quantity: '6', unitCost: '25.25', storeId: mainStoreId },
          ],
        },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(JSON.stringify(response.body)).toContain('not postable');

      const receipts = await migratorQuery<{ n: number }>(
        `select count(*)::int as n from goods_receipts where order_id = $1`,
        [purchaseOrderId],
      );
      expect(receipts[0]!.n).toBe(1); // only the successful one

      const movements = await migratorQuery<{ n: number }>(
        `select count(*)::int as n from stock_movements
          where tenant_id = $1 and reference_type = 'goods_receipt'`,
        [tenantA.tenantId],
      );
      expect(movements[0]!.n).toBe(1);

      const progress = await migratorQuery<{ received_quantity: string }>(
        `select received_quantity from purchase_order_items where id = $1`,
        [paperOrderLineId],
      );
      expect(progress[0]!.received_quantity).toBe('4.000');

      const level = await migratorQuery<{ quantity: string }>(
        `select quantity from stock_levels where item_id = $1 and store_id = $2`,
        [paperItemId, mainStoreId],
      );
      expect(level[0]!.quantity).toBe('4.000');

      const entries = await migratorQuery<{ n: number }>(
        `select count(*)::int as n from journal_entries
          where tenant_id = $1 and reference_type = 'goods_receipt'`,
        [tenantA.tenantId],
      );
      expect(entries[0]!.n).toBe(1);
    });

    it('receiving the remainder completes the order; a received order accepts no more', async () => {
      const completed = await post(
        'owner',
        `/api/v1/inventory/purchase-orders/${purchaseOrderId}/receipts`,
        {
          receivedOn: '2026-06-18',
          creditAccountCode: '2100',
          items: [
            { orderItemId: paperOrderLineId, quantity: '6', unitCost: '25.25', storeId: mainStoreId },
          ],
        },
      );
      expect(completed.status, JSON.stringify(completed.body)).toBe(201);
      expect(completed.body.orderStatus).toBe('received');
      expect(completed.body.journalEntryNumber).toBe('JE-2026-000002');

      const extra = await post(
        'owner',
        `/api/v1/inventory/purchase-orders/${purchaseOrderId}/receipts`,
        {
          receivedOn: '2026-06-19',
          creditAccountCode: '2100',
          items: [
            { orderItemId: paperOrderLineId, quantity: '1', unitCost: '25.25', storeId: mainStoreId },
          ],
        },
      );
      expect(extra.status).toBe(409);

      const cancel = await post(
        'owner',
        `/api/v1/inventory/purchase-orders/${purchaseOrderId}/cancel`,
        { reason: 'Trying to cancel an order that was fully received', version: 4 },
      );
      expect(cancel.status).toBe(409);
    });

    it('a draft order nothing was received against can still be cancelled, with a reason', async () => {
      const created = await post('owner', '/api/v1/inventory/purchase-orders', {
        supplierId,
        orderedOn: '2026-06-21',
        items: [{ itemId: paperItemId, quantity: '3', unitCost: '10.00' }],
      });
      expect(created.status).toBe(201);
      expect(created.body.orderNumber).toBe('PO-2026-000002');

      const cancelled = await post(
        'owner',
        `/api/v1/inventory/purchase-orders/${created.body.id}/cancel`,
        { reason: 'Supplier quoted a better price elsewhere', version: 1 },
      );
      expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(201);
      expect(cancelled.body.status).toBe('cancelled');
      expect(cancelled.body.cancelledReason).toBe('Supplier quoted a better price elsewhere');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // The database itself refuses corrupt stock — raw SQL, service entirely bypassed.
  //
  // Connected as `shikkha_app`, never the migrator: the migrator is deliberately exempt
  // from the stock triggers (for controlled repairs), so a test through it would prove
  // nothing about what the application role can do.
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('database-enforced invariants (raw SQL)', () => {
    it('stock can never go negative — the level check aborts the movement insert itself', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        const error = await expectRefusal(
          insertRawMovement(client, {
            itemId: penItemId,
            storeId: mainStoreId,
            kind: 'issue',
            quantity: '999999.000', // MAIN holds 70.000
          }),
        );
        expect(error.constraint).toBe('stock_levels_quantity_non_negative');
      });

      // The refused insert left the level untouched.
      const level = await migratorQuery<{ quantity: string }>(
        `select quantity from stock_levels where item_id = $1 and store_id = $2`,
        [penItemId, mainStoreId],
      );
      expect(level[0]!.quantity).toBe('70.000');
    });

    it('stock_movements refuses UPDATE — inventory_stock_movements_no_mutation', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        const error = await expectRefusal(
          client.query(
            `update stock_movements set quantity = '1.000' where item_id = $1`,
            [penItemId],
          ),
        );
        expect(error.code).toBe('42501');
        expect(error.message).toMatch(/append-only/);
      });
    });

    it('stock_movements refuses DELETE — history is never erased', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        const error = await expectRefusal(
          client.query(`delete from stock_movements where item_id = $1`, [penItemId]),
        );
        expect(error.code).toBe('42501');
        expect(error.message).toMatch(/append-only/);
      });
    });

    it('stock_levels refuses a direct UPDATE — inventory_stock_levels_guard', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        const error = await expectRefusal(
          client.query(
            `update stock_levels set quantity = '1000000.000' where item_id = $1`,
            [penItemId],
          ),
        );
        expect(error.code).toBe('42501');
        expect(error.message).toMatch(/derived from stock_movements/);
      });
    });

    it('stock_levels refuses a direct INSERT — a level exists only through a movement', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        const error = await expectRefusal(
          client.query(
            `insert into stock_levels (tenant_id, institution_id, item_id, store_id, quantity)
             values ($1, $2, $3, $4, '500.000')`,
            [tenantA.tenantId, tenantA.institutionId, chalkItemId, labStoreId],
          ),
        );
        expect(error.code).toBe('42501');
        expect(error.message).toMatch(/derived from stock_movements/);
      });
    });

    it('received can never exceed ordered — purchase_order_items_received_within_ordered', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        const error = await expectRefusal(
          client.query(
            `update purchase_order_items set received_quantity = '11.000' where id = $1`,
            [paperOrderLineId],
          ),
        );
        expect(error.constraint).toBe('purchase_order_items_received_within_ordered');
      });
    });

    it('a receipt without a cost is unpriceable — stock_movements_receipt_has_cost', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        const error = await expectRefusal(
          insertRawMovement(client, {
            itemId: penItemId,
            storeId: mainStoreId,
            kind: 'receipt',
            quantity: '1.000',
            unitCost: null,
          }),
        );
        expect(error.constraint).toBe('stock_movements_receipt_has_cost');
      });
    });

    it('a correction without a reason is unaccountable — stock_movements_correction_has_reason', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        const error = await expectRefusal(
          insertRawMovement(client, {
            itemId: penItemId,
            storeId: mainStoreId,
            kind: 'adjustment',
            quantity: '1.000',
            reason: null,
          }),
        );
        expect(error.constraint).toBe('stock_movements_correction_has_reason');
      });
    });

    it('a transfer half without its pairing reference is refused — stock_movements_transfer_has_reference', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        const error = await expectRefusal(
          insertRawMovement(client, {
            itemId: penItemId,
            storeId: mainStoreId,
            kind: 'transfer_out',
            quantity: '1.000',
            referenceId: null,
          }),
        );
        expect(error.constraint).toBe('stock_movements_transfer_has_reference');
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Tenant isolation
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('tenant isolation', () => {
    it('another tenant gets a 404, not a 403, for an item it names exactly', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/inventory/items/${penItemId}`)
        .set('Authorization', `Bearer ${tokens['otherViewer']}`)
        .set('x-institution-id', tenantB.institutionId);

      // 404, not 403: confirming the record exists elsewhere is itself a leak.
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('another tenant cannot borrow the institution header', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/inventory/items')
        .set('Authorization', `Bearer ${tokens['otherViewer']}`)
        .set('x-institution-id', tenantA.institutionId);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('the other tenant’s own inventory is empty rather than leaky', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/inventory/items')
        .set('Authorization', `Bearer ${tokens['otherViewer']}`)
        .set('x-institution-id', tenantB.institutionId);

      expect(response.status).toBe(200);
      expect(response.body.meta.total).toBe(0);
      expect(response.body.data).toEqual([]);
    });

    it('row-level security hides every movement from the other tenant, even in raw SQL', async () => {
      await asAppRole(tenantB.tenantId, async (client) => {
        const { rows } = await client.query<{ n: number }>(
          `select count(*)::int as n from stock_movements`,
        );
        // Tenant A has a full movement log by now; under tenant B's GUC it is invisible.
        expect(rows[0]!.n).toBe(0);
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Final proof: after every operation in this file, the derived level still equals the
  // movement log exactly — zero drift, by construction.
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('no drift after the full suite', () => {
    it('the reconciliation endpoint still reports zero mismatches', async () => {
      const response = await get('owner', '/api/v1/inventory/stock/reconciliation');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.clean).toBe(true);
      expect(response.body.mismatches).toEqual([]);
    });

    it('and raw SQL agrees, level for level', async () => {
      const drifted = await migratorQuery<{ n: number }>(
        `select count(*)::int as n
           from stock_levels l
           left join (
             select item_id, store_id,
                    sum(case when kind in ('issue', 'transfer_out', 'write_off')
                             then -quantity else quantity end) as movement_sum
               from stock_movements
              where tenant_id = $1
              group by item_id, store_id
           ) m on m.item_id = l.item_id and m.store_id = l.store_id
          where l.tenant_id = $1
            and l.quantity is distinct from coalesce(m.movement_sum, 0)`,
        [tenantA.tenantId],
      );
      expect(drifted[0]!.n).toBe(0);
    });
  });
});
