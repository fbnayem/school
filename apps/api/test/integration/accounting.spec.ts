/**
 * Accounting integration suite (Phase 13).
 *
 * This file exists to hold the double-entry invariants, not to prove the routes return 200.
 * A mistake in this module is a financial misstatement, so the load-bearing tests here go
 * UNDER the service: a raw `pg` client connected as `shikkha_app` — the same unprivileged
 * role the API uses — writes deliberately corrupt books and the DATABASE must refuse them:
 *
 *  - an unbalanced entry is refused at COMMIT by the deferred `journal_entries_balanced`
 *    constraint trigger,
 *  - a line with both sides non-zero, or neither, breaks `journal_lines_debit_xor_credit`,
 *  - a negative amount breaks `journal_lines_amounts_non_negative`,
 *  - a posted entry's lines cannot be updated or deleted (`journal_lines_immutable_when_posted`),
 *  - nothing posts to a closed period (`journal_entries_period_open`),
 *  - nothing posts to a header account (`journal_lines_account_postable`).
 *
 * Above the database, the service-level rules: a reversal is a mirrored entry that leaves
 * the original intact, the trial balance balances to the poisa after a batch of awkward
 * amounts, drafting and posting are different people, expense claims pay out through the
 * ledger, and none of it crosses a tenant boundary.
 *
 * Everything HTTP runs through the real guards, interceptors and database, because the
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

describe('Accounting — the double-entry ledger', () => {
  let app: INestApplication;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
  const tokens: Record<string, string> = {};

  // The chart this suite builds up, captured for the raw-SQL tests at the bottom.
  let headerAccountId: string; // 1000 ASSETS — non-postable, must refuse lines
  let cashAccountId: string; // 1010 CASH — postable, cash-equivalent
  let incomeAccountId: string; // 4010 TUITION
  let expenseAccountId: string; // 5010 OFFICE
  let cash2AccountId: string; // dedicated to the trial-balance batch
  let income2AccountId: string;

  let fiscalYearId: string;
  let openPeriodId: string; // 2026-04, stays open
  let closedPeriodId: string; // 2025-02, closed early in the suite

  // A posted (never reversed) entry and one of its lines, for the immutability tests.
  let postedEntryId: string;
  let postedLineId: string;

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

  /** Insert a raw draft journal entry in tenant A, returning its id. */
  async function insertRawEntry(
    client: Client,
    opts: { periodId: string; entryDate: string; entryNumber: string },
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `insert into journal_entries
         (tenant_id, institution_id, entry_number, period_id, entry_date, description, source_module)
       values ($1, $2, $3, $4, $5, 'Raw SQL invariant test', 'accounting')
       returning id`,
      [tenantA.tenantId, tenantA.institutionId, opts.entryNumber, opts.periodId, opts.entryDate],
    );
    return rows[0]!.id;
  }

  async function insertRawLine(
    client: Client,
    opts: { entryId: string; accountId: string; debit: string; credit: string },
  ): Promise<void> {
    await client.query(
      `insert into journal_lines (tenant_id, institution_id, entry_id, account_id, debit, credit)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        tenantA.tenantId,
        tenantA.institutionId,
        opts.entryId,
        opts.accountId,
        opts.debit,
        opts.credit,
      ],
    );
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
    tenantA = await seedTenant('acca', { students: 2 });
    tenantB = await seedTenant('accb', { students: 2 });

    for (const key of ['owner', 'accountant', 'teacher']) {
      tokens[key] = await login(tenantA.users[key]!.email);
    }
    tokens['otherAccountant'] = await login(tenantB.users['accountant']!.email);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Setup: the chart of accounts and the fiscal calendar
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('chart of accounts and fiscal calendar', () => {
    it('creates a header account and postable leaves under it', async () => {
      const header = await post('owner', '/api/v1/accounting/accounts', {
        code: '1000',
        nameEn: 'Assets',
        type: 'asset',
        normalBalance: 'debit',
        isPostable: false,
      });
      expect(header.status, JSON.stringify(header.body)).toBe(201);
      expect(header.body.isPostable).toBe(false);
      headerAccountId = header.body.id;

      const cash = await post('owner', '/api/v1/accounting/accounts', {
        code: '1010',
        nameEn: 'Cash in hand',
        nameBn: 'নগদ',
        type: 'asset',
        parentAccountId: headerAccountId,
        normalBalance: 'debit',
        isCashEquivalent: true,
      });
      expect(cash.status, JSON.stringify(cash.body)).toBe(201);
      cashAccountId = cash.body.id;

      const income = await post('owner', '/api/v1/accounting/accounts', {
        code: '4010',
        nameEn: 'Tuition income',
        type: 'income',
        normalBalance: 'credit',
      });
      expect(income.status).toBe(201);
      incomeAccountId = income.body.id;

      const expense = await post('owner', '/api/v1/accounting/accounts', {
        code: '5010',
        nameEn: 'Office expenses',
        type: 'expense',
        normalBalance: 'debit',
      });
      expect(expense.status).toBe(201);
      expenseAccountId = expense.body.id;
    });

    it('refuses a child under a postable parent — only headers hold children', async () => {
      const response = await post('owner', '/api/v1/accounting/accounts', {
        code: '1011',
        nameEn: 'Petty cash',
        type: 'asset',
        parentAccountId: cashAccountId,
        normalBalance: 'debit',
      });
      expect(response.status).toBe(409);
    });

    it('refuses a duplicate account code', async () => {
      const response = await post('owner', '/api/v1/accounting/accounts', {
        code: '1010',
        nameEn: 'Second cash',
        type: 'asset',
        normalBalance: 'debit',
      });
      expect(response.status).toBe(409);
    });

    it('lays out a fiscal year into monthly periods', async () => {
      const response = await post('owner', '/api/v1/accounting/fiscal-years', {
        name: 'FY 2025-2027',
        startDate: '2025-01-01',
        endDate: '2027-12-31',
        periodLayout: 'monthly',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      fiscalYearId = response.body.id;
      expect(response.body.periods).toHaveLength(36);

      const byName = new Map(
        (response.body.periods as Array<{ id: string; name: string; status: string }>).map(
          (period) => [period.name, period],
        ),
      );
      expect(byName.get('2025-02')).toBeTruthy();
      expect(byName.get('2026-04')).toBeTruthy();
      closedPeriodId = byName.get('2025-02')!.id;
      openPeriodId = byName.get('2026-04')!.id;
    });

    it('closes one period, with a recorded reason', async () => {
      const response = await post('owner', `/api/v1/accounting/periods/${closedPeriodId}/close`, {
        reason: 'February 2025 accounts finalised for the audit',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('closed');
      expect(response.body.closedAt).toBeTruthy();
    });

    it('reads the fiscal year back with the closure visible on its period', async () => {
      const response = await get('accountant', `/api/v1/accounting/fiscal-years/${fiscalYearId}`);
      expect(response.status).toBe(200);
      const periods = response.body.periods as Array<{ name: string; status: string }>;
      expect(periods.find((period) => period.name === '2025-02')!.status).toBe('closed');
      expect(periods.find((period) => period.name === '2026-04')!.status).toBe('open');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Permissions
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('permission enforcement', () => {
    it('refuses the chart of accounts to a role with no accounting authority', async () => {
      const response = await post('teacher', '/api/v1/accounting/accounts', {
        code: '9999',
        nameEn: 'Sneaky account',
        type: 'expense',
        normalBalance: 'debit',
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
      // Naming the missing permission would be free reconnaissance.
      expect(JSON.stringify(response.body)).not.toContain('accounting.coa.manage');
    });

    it('refuses a teacher a journal draft and the trial balance', async () => {
      const draft = await post('teacher', '/api/v1/accounting/journal', {
        entryDate: '2026-03-10',
        description: 'Should never exist',
        lines: [
          { accountId: cashAccountId, debit: '10.00' },
          { accountId: incomeAccountId, credit: '10.00' },
        ],
      });
      expect(draft.status).toBe(403);

      const report = await get('teacher', '/api/v1/accounting/reports/trial-balance');
      expect(report.status).toBe(403);
    });

    it('the accountant can draft but cannot post — different permissions', async () => {
      const response = await post(
        'accountant',
        '/api/v1/accounting/journal/00000000-0000-7000-8000-000000000000/post',
        {
          version: 1,
        },
      );
      expect(response.status).toBe(403);
      expect(JSON.stringify(response.body)).not.toContain('accounting.journal.post');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Journal lifecycle: draft → edit → post
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('journal lifecycle', () => {
    let draftId: string;

    it('drafts a balanced entry with a generated sequential number', async () => {
      const response = await post('accountant', '/api/v1/accounting/journal', {
        entryDate: '2026-03-10',
        description: 'March tuition banked to cash',
        lines: [
          { accountId: cashAccountId, debit: '250.75', description: 'Cash received' },
          { accountId: incomeAccountId, credit: '250.75' },
        ],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.entry.status).toBe('draft');
      expect(response.body.entry.entryNumber).toBe('JE-2026-000001');
      expect(response.body.entry.version).toBe(1);
      expect(response.body.lines).toHaveLength(2);
      draftId = response.body.entry.id;
    });

    it('refuses an unbalanced entry at the API edge', async () => {
      const response = await post('accountant', '/api/v1/accounting/journal', {
        entryDate: '2026-03-10',
        description: 'Debits and credits disagree',
        lines: [
          { accountId: cashAccountId, debit: '100.00' },
          { accountId: incomeAccountId, credit: '99.99' },
        ],
      });
      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body)).toContain('does not balance');
    });

    it('refuses a line carrying both a debit and a credit', async () => {
      const response = await post('accountant', '/api/v1/accounting/journal', {
        entryDate: '2026-03-10',
        description: 'One line, both sides',
        lines: [
          { accountId: cashAccountId, debit: '50.00', credit: '50.00' },
          { accountId: incomeAccountId, credit: '50.00' },
        ],
      });
      expect(response.status).toBe(422);
    });

    it('refuses a draft naming a header account', async () => {
      const response = await post('accountant', '/api/v1/accounting/journal', {
        entryDate: '2026-03-10',
        description: 'Posting to a non-leaf',
        lines: [
          { accountId: headerAccountId, debit: '10.00' },
          { accountId: incomeAccountId, credit: '10.00' },
        ],
      });
      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body)).toContain('not postable');
    });

    it('refuses a draft dated inside the closed period', async () => {
      const response = await post('accountant', '/api/v1/accounting/journal', {
        entryDate: '2025-02-15',
        description: 'Back-dated into a closed month',
        lines: [
          { accountId: cashAccountId, debit: '10.00' },
          { accountId: incomeAccountId, credit: '10.00' },
        ],
      });
      expect(response.status).toBe(409);
    });

    it('edits a draft by replacing its lines as a set', async () => {
      const response = await patch('accountant', `/api/v1/accounting/journal/${draftId}`, {
        description: 'March tuition banked to cash (corrected amount)',
        lines: [
          { accountId: cashAccountId, debit: '300.25' },
          { accountId: incomeAccountId, credit: '300.25' },
        ],
        version: 1,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.version).toBe(2);
      expect(response.body.lines).toHaveLength(2);
      const debits = (response.body.lines as Array<{ debit: string }>).map((line) => line.debit);
      expect(debits).toContain('300.25');
    });

    it('a stale version cannot post — optimistic locking holds', async () => {
      const response = await post('owner', `/api/v1/accounting/journal/${draftId}/post`, {
        version: 1,
      });
      expect(response.status).toBe(409);
    });

    it('posts the draft — a different person from the drafter', async () => {
      const response = await post('owner', `/api/v1/accounting/journal/${draftId}/post`, {
        version: 2,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('posted');
      expect(response.body.postedAt).toBeTruthy();
      expect(response.body.version).toBe(3);
    });

    it('a posted entry refuses editing outright', async () => {
      const response = await patch('accountant', `/api/v1/accounting/journal/${draftId}`, {
        description: 'Trying to rewrite history',
        version: 3,
      });
      expect(response.status).toBe(409);
      expect(JSON.stringify(response.body)).toContain('immutable');
    });

    it('refuses self-posting even for someone holding both permissions', async () => {
      const drafted = await post('owner', '/api/v1/accounting/journal', {
        entryDate: '2026-03-20',
        description: 'Owner drafts and then tries to post their own entry',
        lines: [
          { accountId: cashAccountId, debit: '20.00' },
          { accountId: incomeAccountId, credit: '20.00' },
        ],
      });
      expect(drafted.status).toBe(201);

      const selfPost = await post(
        'owner',
        `/api/v1/accounting/journal/${drafted.body.entry.id}/post`,
        { version: 1 },
      );
      expect(selfPost.status).toBe(409);
      expect(JSON.stringify(selfPost.body)).toContain('someone other than');
    });

    // The entry drafted at 2026-03-10 stays referenced by the reversal suite below.
    it('exposes the entry with its lines on read', async () => {
      const response = await get('accountant', `/api/v1/accounting/journal/${draftId}`);
      expect(response.status).toBe(200);
      expect(response.body.lines).toHaveLength(2);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Reversal — correction is a mirrored entry, never an edit
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('reversal', () => {
    let originalId: string;
    let reversalId: string;

    it('reverses a posted entry with a mirrored one and links the pair', async () => {
      // The posted JE-2026-000001 from the lifecycle suite: cash 300.25 / income 300.25.
      const listed = await get('accountant', '/api/v1/accounting/journal', {
        status: 'posted',
        pageSize: 50,
      });
      expect(listed.status).toBe(200);
      const original = listed.body.data.find(
        (entry: { entryNumber: string }) => entry.entryNumber === 'JE-2026-000001',
      );
      expect(original, 'JE-2026-000001 should be posted by now').toBeTruthy();
      originalId = original.id;

      const response = await post('owner', `/api/v1/accounting/journal/${originalId}/reverse`, {
        reason: 'Entered against the wrong month — reversing',
        entryDate: '2026-03-12',
        version: original.version,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.original.status).toBe('reversed');
      expect(response.body.reversal.status).toBe('posted');
      expect(response.body.original.reversedByEntryId).toBe(response.body.reversal.id);
      expect(response.body.reversal.referenceType).toBe('journal_reversal');
      expect(response.body.reversal.referenceId).toBe(originalId);
      reversalId = response.body.reversal.id;
    });

    it('the mirror swaps every debit and credit, amount for amount', async () => {
      const response = await get('accountant', `/api/v1/accounting/journal/${reversalId}`);
      expect(response.status).toBe(200);
      const lines = response.body.lines as Array<{
        accountId: string;
        debit: string;
        credit: string;
      }>;
      expect(lines).toHaveLength(2);

      const cashLine = lines.find((line) => line.accountId === cashAccountId)!;
      const incomeLine = lines.find((line) => line.accountId === incomeAccountId)!;
      // Original: cash debit 300.25, income credit 300.25. The mirror inverts both sides.
      expect(cashLine.debit).toBe('0.00');
      expect(cashLine.credit).toBe('300.25');
      expect(incomeLine.debit).toBe('300.25');
      expect(incomeLine.credit).toBe('0.00');
    });

    it('leaves the original entry and its lines completely intact', async () => {
      const response = await get('accountant', `/api/v1/accounting/journal/${originalId}`);
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('reversed');
      const cashLine = (
        response.body.lines as Array<{ accountId: string; debit: string; credit: string }>
      ).find((line) => line.accountId === cashAccountId)!;
      expect(cashLine.debit).toBe('300.25');
      expect(cashLine.credit).toBe('0.00');
    });

    it('the pair nets to exactly zero in the general ledger', async () => {
      const response = await get('owner', '/api/v1/accounting/reports/general-ledger', {
        accountId: cashAccountId,
        from: '2026-03-01',
        to: '2026-03-31',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.totalDebits).toBe('300.25');
      expect(response.body.totalCredits).toBe('300.25');
      expect(response.body.closingBalance).toBe('0.00');
    });

    it('an already-reversed entry cannot be reversed again', async () => {
      const response = await post('owner', `/api/v1/accounting/journal/${originalId}/reverse`, {
        reason: 'Trying to double-cancel the entry',
        version: 4,
      });
      expect(response.status).toBe(409);
      expect(JSON.stringify(response.body)).toContain('already been reversed');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Trial balance — exact to the poisa after an awkward batch
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('trial balance and Money exactness', () => {
    // Amounts chosen to catch floating-point rounding: 0.01 + 0.02 + 33.33 + 1234.57 +
    // 99999.99 is exactly 101267.92, and any float path would eventually disagree.
    const amounts = ['0.01', '33.33', '1234.57', '99999.99', '0.02'];
    const expectedTotal = amounts
      .reduce((sum, amount) => sum.plus(Money.fromDecimalString(amount)), Money.zero())
      .toDecimalString();

    it('posts a batch of poisa-precise entries to dedicated accounts', async () => {
      const cash2 = await post('owner', '/api/v1/accounting/accounts', {
        code: '1020',
        nameEn: 'Bank current account',
        type: 'asset',
        normalBalance: 'debit',
        isCashEquivalent: true,
      });
      expect(cash2.status).toBe(201);
      cash2AccountId = cash2.body.id;

      const income2 = await post('owner', '/api/v1/accounting/accounts', {
        code: '4020',
        nameEn: 'Admission fees income',
        type: 'income',
        normalBalance: 'credit',
      });
      expect(income2.status).toBe(201);
      income2AccountId = income2.body.id;

      for (const [index, amount] of amounts.entries()) {
        const drafted = await post('accountant', '/api/v1/accounting/journal', {
          entryDate: `2026-05-${String(index + 1).padStart(2, '0')}`,
          description: `Batch entry ${index + 1} of ${amounts.length} (${amount})`,
          lines: [
            { accountId: cash2AccountId, debit: amount },
            { accountId: income2AccountId, credit: amount },
          ],
        });
        expect(drafted.status, JSON.stringify(drafted.body)).toBe(201);

        const posted = await post(
          'owner',
          `/api/v1/accounting/journal/${drafted.body.entry.id}/post`,
          { version: 1 },
        );
        expect(posted.status, JSON.stringify(posted.body)).toBe(201);

        if (index === 0) {
          // A posted, never-reversed entry for the raw-SQL immutability tests below.
          postedEntryId = posted.body.id;
          postedLineId = posted.body.lines[0].id;
        }
      }
    }, 30_000);

    it('the trial balance balances, and every poisa is accounted for', async () => {
      const response = await get('owner', '/api/v1/accounting/reports/trial-balance', {
        asOf: '2027-12-31',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.balanced).toBe(true);
      expect(response.body.totalDebits).toBe(response.body.totalCredits);

      const rows = response.body.accounts as Array<{
        accountId: string;
        debits: string;
        credits: string;
        balance: string;
      }>;
      const cashRow = rows.find((row) => row.accountId === cash2AccountId)!;
      const incomeRow = rows.find((row) => row.accountId === income2AccountId)!;
      expect(cashRow.debits).toBe(expectedTotal); // 101267.92 — exact, no float drift
      expect(cashRow.balance).toBe(expectedTotal);
      expect(incomeRow.credits).toBe(expectedTotal);
      expect(incomeRow.balance).toBe(expectedTotal);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Expense claims — the money leaves through the ledger
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('expense claims', () => {
    let claimId: string;

    it('files and submits a claim', async () => {
      const created = await post('accountant', '/api/v1/accounting/expense-claims', {
        employeeId: tenantA.employeeIds[3], // the accountant's own employee record
        amount: '450.50',
        category: 'stationery',
        description: 'Exam answer scripts and markers for the March tests',
        expenseDate: '2026-03-05',
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body.status).toBe('draft');
      expect(created.body.claimNumber).toBe('EXP-2026-000001');
      claimId = created.body.id;

      const submitted = await post(
        'accountant',
        `/api/v1/accounting/expense-claims/${claimId}/submit`,
        { version: 1 },
      );
      expect(submitted.status).toBe(201);
      expect(submitted.body.status).toBe('submitted');
    });

    it('the filer cannot decide — permission split', async () => {
      const response = await post(
        'accountant',
        `/api/v1/accounting/expense-claims/${claimId}/decision`,
        { decision: 'approved', reason: 'Approving my own claim, surely fine' },
      );
      expect(response.status).toBe(403);
    });

    it('refuses a self-decision even for someone holding the permission', async () => {
      const own = await post('owner', '/api/v1/accounting/expense-claims', {
        employeeId: tenantA.employeeIds[0],
        amount: '99.00',
        category: 'travel',
        description: 'Rickshaw fares for the bank run this week',
        expenseDate: '2026-03-06',
      });
      expect(own.status).toBe(201);
      const submitted = await post(
        'owner',
        `/api/v1/accounting/expense-claims/${own.body.id}/submit`,
        { version: 1 },
      );
      expect(submitted.status).toBe(201);

      const decision = await post(
        'owner',
        `/api/v1/accounting/expense-claims/${own.body.id}/decision`,
        { decision: 'approved', reason: 'Deciding the claim I filed myself' },
      );
      expect(decision.status).toBe(409);
      expect(JSON.stringify(decision.body)).toContain('someone other than');
    });

    it('approves and pays; the payout is a system journal entry in the same transaction', async () => {
      const decided = await post('owner', `/api/v1/accounting/expense-claims/${claimId}/decision`, {
        decision: 'approved',
        reason: 'Receipts attached and verified against stock',
      });
      expect(decided.status, JSON.stringify(decided.body)).toBe(201);
      expect(decided.body.status).toBe('approved');

      const paid = await post('owner', `/api/v1/accounting/expense-claims/${claimId}/pay`, {
        expenseAccountId,
        cashAccountId,
        version: 3,
      });
      expect(paid.status, JSON.stringify(paid.body)).toBe(201);
      expect(paid.body.claim.status).toBe('paid');
      expect(paid.body.claim.paymentJournalEntryId).toBe(paid.body.entry.id);
      expect(paid.body.entry.status).toBe('posted');
      expect(paid.body.entry.isSystemGenerated).toBe(true);
      expect(paid.body.entry.referenceType).toBe('expense_claim');
      expect(paid.body.entry.referenceId).toBe(claimId);

      // Debit the expense, credit the cash — for exactly the claim amount.
      const entry = await get('accountant', `/api/v1/accounting/journal/${paid.body.entry.id}`);
      expect(entry.status).toBe(200);
      const lines = entry.body.lines as Array<{
        accountId: string;
        debit: string;
        credit: string;
      }>;
      expect(lines.find((line) => line.accountId === expenseAccountId)!.debit).toBe('450.50');
      expect(lines.find((line) => line.accountId === cashAccountId)!.credit).toBe('450.50');

      // A system-generated posted entry is doubly untouchable by hand.
      const edit = await patch('accountant', `/api/v1/accounting/journal/${paid.body.entry.id}`, {
        description: 'Rewriting a system entry',
        version: 2,
      });
      expect(edit.status).toBe(409);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Tenant isolation
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('tenant isolation', () => {
    it('another tenant gets a 404, not a 403, for an entry it names exactly', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/accounting/journal/${postedEntryId}`)
        .set('Authorization', `Bearer ${tokens['otherAccountant']}`)
        .set('x-institution-id', tenantB.institutionId);

      // 404, not 403: confirming the record exists elsewhere is itself a leak.
      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain('JE-2026');
    });

    it('another tenant cannot borrow the institution header', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/accounting/journal')
        .set('Authorization', `Bearer ${tokens['otherAccountant']}`)
        .set('x-institution-id', tenantA.institutionId);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('another tenant’s own journal is empty rather than leaky', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/accounting/journal')
        .set('Authorization', `Bearer ${tokens['otherAccountant']}`)
        .set('x-institution-id', tenantB.institutionId);

      expect(response.status).toBe(200);
      expect(response.body.meta.total).toBe(0);
      expect(response.body.data).toEqual([]);
    });

    it('row-level security hides every journal row from the other tenant, even in raw SQL', async () => {
      await asAppRole(tenantB.tenantId, async (client) => {
        const { rows } = await client.query<{ n: number }>(
          `select count(*)::int as n from journal_entries`,
        );
        // Tenant A has posted several entries by now; under tenant B's GUC they are invisible.
        expect(rows[0]!.n).toBe(0);
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // The database itself refuses corrupt books — raw SQL, service entirely bypassed.
  //
  // Connected as `shikkha_app`, never the migrator: the migrator is deliberately exempt
  // from the immutability triggers (for retention), so a test through it would prove
  // nothing about what the application role can do.
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('database-enforced invariants (raw SQL)', () => {
    it('refuses an unbalanced entry at COMMIT — the deferred journal_entries_balanced trigger', async () => {
      const client = new Client({ connectionString: TEST_APP_DATABASE_URL });
      await client.connect();
      try {
        await client.query('begin');
        await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantA.tenantId]);
        const entryId = await insertRawEntry(client, {
          periodId: openPeriodId,
          entryDate: '2026-04-10',
          entryNumber: 'JE-RAW-BAL',
        });
        // Each line is individually legal (XOR holds); the SET does not balance.
        await insertRawLine(client, {
          entryId,
          accountId: cashAccountId,
          debit: '100.00',
          credit: '0.00',
        });
        await insertRawLine(client, {
          entryId,
          accountId: incomeAccountId,
          debit: '0.00',
          credit: '99.99',
        });

        // Mid-transaction the imbalance is tolerated — the trigger is deferred to COMMIT.
        const error = await expectRefusal(client.query('commit'));
        expect(error.message).toMatch(/does not balance/);
        expect(error.constraint).toBe('journal_entries_balanced');
      } finally {
        await client.query('rollback').catch(() => undefined);
        await client.end();
      }

      // Nothing survived the refused commit.
      const migrator = testClient();
      await migrator.connect();
      try {
        const { rows } = await migrator.query<{ n: number }>(
          `select count(*)::int as n from journal_entries where entry_number = 'JE-RAW-BAL'`,
        );
        expect(rows[0]!.n).toBe(0);
      } finally {
        await migrator.end();
      }
    });

    it('refuses a line with both a debit and a credit — journal_lines_debit_xor_credit', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        const entryId = await insertRawEntry(client, {
          periodId: openPeriodId,
          entryDate: '2026-04-11',
          entryNumber: 'JE-RAW-XOR1',
        });
        const error = await expectRefusal(
          insertRawLine(client, {
            entryId,
            accountId: cashAccountId,
            debit: '10.00',
            credit: '10.00',
          }),
        );
        expect(error.constraint).toBe('journal_lines_debit_xor_credit');
      });
    });

    it('refuses a line with neither side — journal_lines_debit_xor_credit', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        const entryId = await insertRawEntry(client, {
          periodId: openPeriodId,
          entryDate: '2026-04-12',
          entryNumber: 'JE-RAW-XOR2',
        });
        const error = await expectRefusal(
          insertRawLine(client, {
            entryId,
            accountId: cashAccountId,
            debit: '0.00',
            credit: '0.00',
          }),
        );
        expect(error.constraint).toBe('journal_lines_debit_xor_credit');
      });
    });

    it('refuses a negative debit or credit — journal_lines_amounts_non_negative', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        const entryId = await insertRawEntry(client, {
          periodId: openPeriodId,
          entryDate: '2026-04-13',
          entryNumber: 'JE-RAW-NEG1',
        });
        const error = await expectRefusal(
          insertRawLine(client, {
            entryId,
            accountId: cashAccountId,
            debit: '-5.00',
            credit: '0.00',
          }),
        );
        expect(error.constraint).toBe('journal_lines_amounts_non_negative');
      });

      await asAppRole(tenantA.tenantId, async (client) => {
        const entryId = await insertRawEntry(client, {
          periodId: openPeriodId,
          entryDate: '2026-04-13',
          entryNumber: 'JE-RAW-NEG2',
        });
        const error = await expectRefusal(
          insertRawLine(client, {
            entryId,
            accountId: cashAccountId,
            debit: '0.00',
            credit: '-5.00',
          }),
        );
        expect(error.constraint).toBe('journal_lines_amounts_non_negative');
      });
    });

    it('refuses updating a posted entry’s line — journal_lines_immutable_when_posted', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        const error = await expectRefusal(
          client.query(`update journal_lines set debit = '999999.00' where id = $1`, [
            postedLineId,
          ]),
        );
        expect(error.message).toMatch(/immutable/);
        expect(error.message).toMatch(/reversing entry/);
      });
    });

    it('refuses deleting a posted entry’s line — lines are never deleted at all', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        const error = await expectRefusal(
          client.query(`delete from journal_lines where id = $1`, [postedLineId]),
        );
        expect(error.message).toMatch(/never deleted/);
      });
    });

    it('refuses smuggling a line out of a posted entry by re-pointing its entry_id', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        const freshEntryId = await insertRawEntry(client, {
          periodId: openPeriodId,
          entryDate: '2026-04-14',
          entryNumber: 'JE-RAW-SMUGGLE',
        });
        const error = await expectRefusal(
          client.query(`update journal_lines set entry_id = $1 where id = $2`, [
            freshEntryId,
            postedLineId,
          ]),
        );
        expect(error.message).toMatch(/immutable/);
      });
    });

    it('refuses deleting a journal entry outright', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        const error = await expectRefusal(
          client.query(`delete from journal_entries where id = $1`, [postedEntryId]),
        );
        expect(error.message).toMatch(/never deleted/);
      });
    });

    it('refuses an entry in a closed period — journal_entries_period_open', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        const error = await expectRefusal(
          insertRawEntry(client, {
            periodId: closedPeriodId,
            entryDate: '2025-02-10',
            entryNumber: 'JE-RAW-CLOSED',
          }),
        );
        expect(error.message).toMatch(/closed and accepts no journal entries/);
        expect(error.constraint).toBe('journal_entries_period_open');
      });
    });

    it('refuses a line on a header account — journal_lines_account_postable', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        const entryId = await insertRawEntry(client, {
          periodId: openPeriodId,
          entryDate: '2026-04-15',
          entryNumber: 'JE-RAW-HEADER',
        });
        const error = await expectRefusal(
          insertRawLine(client, {
            entryId,
            accountId: headerAccountId,
            debit: '10.00',
            credit: '0.00',
          }),
        );
        expect(error.message).toMatch(/not postable/);
        expect(error.constraint).toBe('journal_lines_account_postable');
      });
    });
  });
});
