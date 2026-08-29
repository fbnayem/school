/**
 * Accounting services (Phase 13): the double-entry ledger.
 *
 * Two injectables live here:
 *
 *  - **`LedgerService`** — the posting engine. Every method takes the caller's transaction
 *    handle, so a fee payment and its ledger entry commit together or not at all. Other
 *    modules import this service and nothing else from accounting; accounting never
 *    reaches into their tables.
 *  - **`AccountingService`** — the controller-facing service: chart of accounts, fiscal
 *    years and periods, manual journal work, cost centres, budgets, expense claims, and
 *    the reports.
 *
 * The rules this file keeps absolutely:
 *
 *  1. **No floating point.** Every monetary value is parsed with `Money.fromDecimalString`
 *     and written with `Money.toDecimalString`. SQL aggregates come back as `numeric`
 *     strings and go straight into `Money` (ADR-004).
 *  2. **The database is the last line of defence, not the first.** Balance, immutability,
 *     closed periods and postable-only accounts are all validated here for friendly
 *     errors, and all enforced again by constraints and triggers in migration 0018 —
 *     a bug in this file fails the write instead of misstating the books.
 *  3. **Correction is a reversing entry, never an edit and never a delete.**
 *  4. **Every financially significant mutation writes its audit record inside the business
 *     transaction**, so the trail rolls back with the money.
 *  5. **The workflow engine is an optional peer, not a dependency.** Expense claims store a
 *     bare `workflow_request_id` and this module exposes callback methods
 *     (`attachExpenseClaimWorkflow`, `onExpenseClaimWorkflowDecision`) the workflow module
 *     may call; nothing here imports it.
 */

import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  ilike,
  inArray,
  isNull,
  like,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  accountingPeriods,
  budgets,
  chartOfAccounts,
  costCentres,
  employees,
  expenseClaims,
  fiscalYears,
  journalEntries,
  journalLines,
} from '@shikkha/db';
import {
  addDays,
  addMonths,
  buildOffsetPage,
  calendarDate,
  ConflictError,
  InternalError,
  Money,
  NotFoundError,
  offsetOf,
  parseSort,
  todayInDhaka,
  uuidv7,
  ValidationError,
  type CalendarDate,
  type OffsetPage,
  type OffsetPageRequest,
} from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import {
  BUDGET_SORT_FIELDS,
  COA_SORT_FIELDS,
  COST_CENTRE_SORT_FIELDS,
  EXPENSE_CLAIM_SORT_FIELDS,
  FISCAL_YEAR_SORT_FIELDS,
  JOURNAL_ENTRY_SORT_FIELDS,
} from '@shikkha/validation';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { currentContext } from '../../common/context/request-context';

/** The transaction handle `runInTenant` hands to its callback. */
type Tx = Parameters<Parameters<DatabaseService['runInTenant']>[0]>[0];

type AccountRow = typeof chartOfAccounts.$inferSelect;
type FiscalYearRow = typeof fiscalYears.$inferSelect;
type PeriodRow = typeof accountingPeriods.$inferSelect;
type JournalEntryRow = typeof journalEntries.$inferSelect;
type JournalLineRow = typeof journalLines.$inferSelect;
type CostCentreRow = typeof costCentres.$inferSelect;
type BudgetRow = typeof budgets.$inferSelect;
type ExpenseClaimRow = typeof expenseClaims.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────────────
// LedgerService — the posting engine other modules import
// ─────────────────────────────────────────────────────────────────────────────────────

/** One side of one line, on the wire and in code always a decimal string. */
export interface LedgerLineInput {
  accountId: string;
  debit?: string;
  credit?: string;
  description?: string;
  costCentreId?: string;
}

export interface LedgerPostInput {
  tenantId: string;
  institutionId: string;
  /** Null for postings by unattended jobs. */
  actorUserId: string | null;
  /** Calendar date of the entry; must fall inside an open accounting period. */
  entryDate: string;
  description: string;
  /** What caused the entry: 'fee_payment', 'expense_claim', 'manual', … */
  referenceType?: string;
  referenceId?: string;
  /** Which module is posting. 'accounting' for manual work. */
  sourceModule: string;
  /** System entries are flagged and can never be edited by hand. */
  isSystemGenerated?: boolean;
  lines: LedgerLineInput[];
}

export interface LedgerReverseInput {
  tenantId: string;
  institutionId: string;
  actorUserId: string | null;
  entryId: string;
  reason: string;
  /** Date of the reversing entry; defaults to today. Must fall in an open period. */
  entryDate?: string;
}

interface PreparedLedgerLine {
  accountId: string;
  debit: Money;
  credit: Money;
  description: string | null;
  costCentreId: string | null;
}

@Injectable()
export class LedgerService {
  /**
   * Post a balanced entry inside the caller's transaction.
   *
   * The entry is inserted as a draft, its lines are written, and it is then flipped to
   * `posted` — the order the immutability trigger requires. Validation here produces the
   * friendly error; the database's deferred balance trigger, XOR constraint, postable
   * check and closed-period trigger are the guarantees.
   */
  async post(
    tx: Tx,
    input: LedgerPostInput,
  ): Promise<{ entry: JournalEntryRow; lines: JournalLineRow[] }> {
    const prepared = this.prepareLines(input.lines);

    const period = await this.resolveOpenPeriod(tx, input.institutionId, input.entryDate);
    await this.assertAccountsPostable(
      tx,
      input.institutionId,
      prepared.map((line) => line.accountId),
    );

    const year4 = input.entryDate.slice(0, 4);
    const sequence = (await this.currentEntrySequence(tx, input.institutionId, `JE-${year4}-`)) + 1;
    const entryNumber = `JE-${year4}-${String(sequence).padStart(6, '0')}`;

    const entryId = uuidv7();
    await tx.insert(journalEntries).values({
      id: entryId,
      tenantId: input.tenantId,
      institutionId: input.institutionId,
      entryNumber,
      periodId: period.id,
      entryDate: input.entryDate,
      description: input.description,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      status: 'draft',
      isSystemGenerated: input.isSystemGenerated ?? false,
      sourceModule: input.sourceModule,
      createdBy: input.actorUserId,
      updatedBy: input.actorUserId,
    });

    const lines = await this.writeLines(tx, {
      tenantId: input.tenantId,
      institutionId: input.institutionId,
      entryId,
      actorUserId: input.actorUserId,
      lines: prepared,
    });

    const [posted] = await tx
      .update(journalEntries)
      .set({
        status: 'posted',
        postedBy: input.actorUserId,
        postedAt: new Date(),
        version: 2,
        updatedBy: input.actorUserId,
      })
      .where(eq(journalEntries.id, entryId))
      .returning();

    return { entry: posted!, lines };
  }

  /**
   * Reverse a posted entry: a mirrored entry (debits and credits swapped) is posted in an
   * open period and the original is marked `reversed` with a link to it. The original's
   * lines are untouched — the immutability trigger would refuse anything else.
   */
  async reverse(
    tx: Tx,
    input: LedgerReverseInput,
  ): Promise<{ original: JournalEntryRow; reversal: JournalEntryRow }> {
    const [original] = await tx
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.id, input.entryId),
          eq(journalEntries.institutionId, input.institutionId),
          isNull(journalEntries.archivedAt),
        ),
      )
      .limit(1);
    if (!original) throw new NotFoundError('Journal entry', input.entryId);

    if (original.status === 'reversed') {
      throw new ConflictError(`Entry ${original.entryNumber} has already been reversed.`, {
        reversedByEntryId: original.reversedByEntryId,
      });
    }
    if (original.status !== 'posted') {
      throw new ConflictError(
        `Only a posted entry can be reversed; ${original.entryNumber} is a draft. Edit or archive it instead.`,
      );
    }

    const originalLines = await tx
      .select()
      .from(journalLines)
      .where(and(eq(journalLines.entryId, original.id), isNull(journalLines.archivedAt)))
      .orderBy(asc(journalLines.sortOrder), asc(journalLines.id));

    const { entry: reversal } = await this.post(tx, {
      tenantId: input.tenantId,
      institutionId: input.institutionId,
      actorUserId: input.actorUserId,
      entryDate: input.entryDate ?? (todayInDhaka() as string),
      description: `Reversal of ${original.entryNumber}: ${input.reason}`,
      referenceType: 'journal_reversal',
      referenceId: original.id,
      sourceModule: original.sourceModule,
      isSystemGenerated: original.isSystemGenerated,
      // The mirror: every debit becomes a credit and vice versa, amount for amount, so the
      // pair nets to exactly zero on every account it touches.
      lines: originalLines.map((line) => ({
        accountId: line.accountId,
        debit: Money.fromDecimalString(line.credit).isPositive() ? line.credit : undefined,
        credit: Money.fromDecimalString(line.debit).isPositive() ? line.debit : undefined,
        description: line.description ?? undefined,
        costCentreId: line.costCentreId ?? undefined,
      })),
    });

    const [updated] = await tx
      .update(journalEntries)
      .set({
        status: 'reversed',
        reversedByEntryId: reversal.id,
        version: original.version + 1,
        updatedBy: input.actorUserId,
      })
      .where(eq(journalEntries.id, original.id))
      .returning();

    return { original: updated!, reversal };
  }

  /**
   * Create a **draft** manual entry — used by `AccountingService` for the create/edit/post
   * workflow. Draft lines are written and the entry stays editable until posted.
   */
  async createDraft(
    tx: Tx,
    input: Omit<LedgerPostInput, 'isSystemGenerated'>,
  ): Promise<{ entry: JournalEntryRow; lines: JournalLineRow[] }> {
    const prepared = this.prepareLines(input.lines);
    const period = await this.resolveOpenPeriod(tx, input.institutionId, input.entryDate);
    await this.assertAccountsPostable(
      tx,
      input.institutionId,
      prepared.map((line) => line.accountId),
    );

    const year4 = input.entryDate.slice(0, 4);
    const sequence = (await this.currentEntrySequence(tx, input.institutionId, `JE-${year4}-`)) + 1;
    const entryNumber = `JE-${year4}-${String(sequence).padStart(6, '0')}`;

    const entryId = uuidv7();
    const [entry] = await tx
      .insert(journalEntries)
      .values({
        id: entryId,
        tenantId: input.tenantId,
        institutionId: input.institutionId,
        entryNumber,
        periodId: period.id,
        entryDate: input.entryDate,
        description: input.description,
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
        status: 'draft',
        isSystemGenerated: false,
        sourceModule: input.sourceModule,
        createdBy: input.actorUserId,
        updatedBy: input.actorUserId,
      })
      .returning();

    const lines = await this.writeLines(tx, {
      tenantId: input.tenantId,
      institutionId: input.institutionId,
      entryId,
      actorUserId: input.actorUserId,
      lines: prepared,
    });

    return { entry: entry!, lines };
  }

  /**
   * Validate and write a **draft** entry's replacement lines — the edit path, which has
   * already archived the old set. The same validation and write path as creation, and the
   * database's deferred balance trigger re-checks the whole set at commit.
   */
  async createDraftLines(
    tx: Tx,
    input: {
      tenantId: string;
      institutionId: string;
      entryId: string;
      actorUserId: string | null;
      lines: LedgerLineInput[];
    },
  ): Promise<JournalLineRow[]> {
    const prepared = this.prepareLines(input.lines);
    await this.assertAccountsPostable(
      tx,
      input.institutionId,
      prepared.map((line) => line.accountId),
    );
    return this.writeLines(tx, {
      tenantId: input.tenantId,
      institutionId: input.institutionId,
      entryId: input.entryId,
      actorUserId: input.actorUserId,
      lines: prepared,
    });
  }

  /**
   * Resolve the single open period covering a date, or refuse.
   *
   * The trigger re-checks this at write time; resolving here turns "check violation" into
   * an actionable message naming the date.
   */
  async resolveOpenPeriod(tx: Tx, institutionId: string, entryDate: string): Promise<PeriodRow> {
    const [period] = await tx
      .select({ period: accountingPeriods })
      .from(accountingPeriods)
      .innerJoin(fiscalYears, eq(fiscalYears.id, accountingPeriods.fiscalYearId))
      .where(
        and(
          eq(accountingPeriods.institutionId, institutionId),
          lte(accountingPeriods.startDate, entryDate),
          gte(accountingPeriods.endDate, entryDate),
          eq(accountingPeriods.status, 'open'),
          isNull(accountingPeriods.archivedAt),
          eq(fiscalYears.status, 'open'),
          isNull(fiscalYears.archivedAt),
        ),
      )
      .limit(1);

    if (!period) {
      throw new ConflictError(
        `No open accounting period covers ${entryDate}. Create the fiscal year, or reopen the period, before posting.`,
        { entryDate },
      );
    }
    return period.period;
  }

  /** Every named account must exist here, be a postable leaf, and be active. */
  private async assertAccountsPostable(
    tx: Tx,
    institutionId: string,
    accountIds: string[],
  ): Promise<void> {
    const unique = [...new Set(accountIds)];
    const rows = await tx
      .select({
        id: chartOfAccounts.id,
        isPostable: chartOfAccounts.isPostable,
        status: chartOfAccounts.status,
      })
      .from(chartOfAccounts)
      .where(
        and(
          inArray(chartOfAccounts.id, unique),
          eq(chartOfAccounts.institutionId, institutionId),
          isNull(chartOfAccounts.archivedAt),
        ),
      );
    const byId = new Map(rows.map((row) => [row.id, row]));

    const problems: string[] = [];
    for (const id of unique) {
      const account = byId.get(id);
      if (!account) problems.push(`${id} does not exist in this institution`);
      else if (!account.isPostable) problems.push(`${id} is a header account and not postable`);
      else if (account.status !== 'active') problems.push(`${id} is archived`);
    }
    if (problems.length > 0) {
      throw new ValidationError('Some accounts cannot take postings', [
        { path: 'lines', message: problems.join('; ') },
      ]);
    }
  }

  /** Parse, validate and balance the lines. All arithmetic is `Money`. */
  private prepareLines(lines: LedgerLineInput[]): PreparedLedgerLine[] {
    if (lines.length < 2) {
      throw new ValidationError('A journal entry needs at least two lines', [
        { path: 'lines', message: 'Provide at least one debit line and one credit line' },
      ]);
    }

    const prepared: PreparedLedgerLine[] = [];
    let debits = Money.zero();
    let credits = Money.zero();

    for (const [index, line] of lines.entries()) {
      const debit = line.debit ? Money.fromDecimalString(line.debit) : Money.zero();
      const credit = line.credit ? Money.fromDecimalString(line.credit) : Money.zero();

      if (debit.isNegative() || credit.isNegative()) {
        throw new ValidationError('Amounts must be non-negative; the side is the direction', [
          { path: `lines.${index}`, message: 'Negative amounts are not allowed' },
        ]);
      }
      if (debit.isPositive() === credit.isPositive()) {
        throw new ValidationError(
          'Each line must carry exactly one of a positive debit or a positive credit',
          [{ path: `lines.${index}`, message: 'Set either debit or credit, not both or neither' }],
        );
      }

      debits = debits.plus(debit);
      credits = credits.plus(credit);
      prepared.push({
        accountId: line.accountId,
        debit,
        credit,
        description: line.description ?? null,
        costCentreId: line.costCentreId ?? null,
      });
    }

    if (!debits.equals(credits)) {
      throw new ValidationError('The entry does not balance', [
        {
          path: 'lines',
          message: `Debits total ${debits.toDecimalString()} but credits total ${credits.toDecimalString()}`,
        },
      ]);
    }

    return prepared;
  }

  private async writeLines(
    tx: Tx,
    input: {
      tenantId: string;
      institutionId: string;
      entryId: string;
      actorUserId: string | null;
      lines: PreparedLedgerLine[];
    },
  ): Promise<JournalLineRow[]> {
    const written: JournalLineRow[] = [];
    for (const [index, line] of input.lines.entries()) {
      const [row] = await tx
        .insert(journalLines)
        .values({
          id: uuidv7(),
          tenantId: input.tenantId,
          institutionId: input.institutionId,
          entryId: input.entryId,
          accountId: line.accountId,
          debit: line.debit.toDecimalString(),
          credit: line.credit.toDecimalString(),
          description: line.description,
          costCentreId: line.costCentreId,
          sortOrder: index,
          createdBy: input.actorUserId,
          updatedBy: input.actorUserId,
        })
        .returning();
      written.push(row!);
    }
    return written;
  }

  /**
   * The highest entry number already issued under a prefix. `max` rather than `count`,
   * because numbers are never reused; the unique index on `(institution_id, entry_number)`
   * is the real guarantee against a race.
   */
  private async currentEntrySequence(
    tx: Tx,
    institutionId: string,
    prefix: string,
  ): Promise<number> {
    const [row] = await tx
      .select({ maxNumber: sql<string | null>`max(${journalEntries.entryNumber})` })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.institutionId, institutionId),
          like(journalEntries.entryNumber, `${prefix}%`),
        ),
      );
    return sequenceAfter(row?.maxNumber ?? null, prefix);
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────
// AccountingService — controller-facing
// ─────────────────────────────────────────────────────────────────────────────────────

export interface ListAccountsQuery {
  page: number;
  pageSize: number;
  sort?: string;
  q?: string;
  type?: string;
  postableOnly: boolean;
  includeArchived: boolean;
}

export interface ListJournalEntriesQuery {
  page: number;
  pageSize: number;
  sort?: string;
  q?: string;
  status?: string;
  periodId?: string;
  fiscalYearId?: string;
  accountId?: string;
  sourceModule?: string;
  referenceType?: string;
  referenceId?: string;
  dateFrom?: string;
  dateTo?: string;
  includeArchived: boolean;
}

export interface ListExpenseClaimsQuery {
  page: number;
  pageSize: number;
  sort?: string;
  q?: string;
  status?: string;
  employeeId?: string;
  includeArchived: boolean;
}

@Injectable()
export class AccountingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════════════
  // Chart of accounts
  // ══════════════════════════════════════════════════════════════════════════════════

  async listAccounts(
    institutionId: string,
    query: ListAccountsQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<AccountRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(chartOfAccounts.institutionId, institutionId)];
      if (!query.includeArchived) filters.push(isNull(chartOfAccounts.archivedAt));
      if (query.type) filters.push(eq(chartOfAccounts.type, query.type as AccountRow['type']));
      if (query.postableOnly) filters.push(eq(chartOfAccounts.isPostable, true));
      if (query.q) {
        filters.push(
          or(
            ilike(chartOfAccounts.nameEn, `%${query.q}%`),
            ilike(chartOfAccounts.code, `${query.q}%`),
          )!,
        );
      }

      const where = and(...filters);
      const orderBy = parseSort(query.sort, COA_SORT_FIELDS, {
        field: 'code',
        direction: 'asc',
      }).map((spec) => {
        const column = ACCOUNT_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(chartOfAccounts)
        .where(where)
        .orderBy(...orderBy, asc(chartOfAccounts.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(chartOfAccounts)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async createAccount(
    principal: Principal,
    institutionId: string,
    input: {
      code: string;
      nameEn: string;
      nameBn?: string;
      type: AccountRow['type'];
      parentAccountId?: string;
      normalBalance: AccountRow['normalBalance'];
      isPostable: boolean;
      isCashEquivalent: boolean;
      description?: string;
      sortOrder: number;
    },
  ): Promise<AccountRow> {
    return this.db.runInTenant(async (tx) => {
      const [duplicate] = await tx
        .select({ id: chartOfAccounts.id })
        .from(chartOfAccounts)
        .where(
          and(
            eq(chartOfAccounts.institutionId, institutionId),
            eq(chartOfAccounts.code, input.code),
            isNull(chartOfAccounts.archivedAt),
          ),
        )
        .limit(1);
      if (duplicate) {
        throw new ConflictError(`An account with code ${input.code} already exists.`, {
          existingAccountId: duplicate.id,
        });
      }

      if (input.parentAccountId) {
        const [parent] = await tx
          .select()
          .from(chartOfAccounts)
          .where(
            and(
              eq(chartOfAccounts.id, input.parentAccountId),
              eq(chartOfAccounts.institutionId, institutionId),
              isNull(chartOfAccounts.archivedAt),
            ),
          )
          .limit(1);
        if (!parent) throw new NotFoundError('Parent account', input.parentAccountId);
        if (parent.type !== input.type) {
          throw new ValidationError('A child account must share its parent’s type', [
            { path: 'parentAccountId', message: `The parent is ${parent.type}` },
          ]);
        }
        if (parent.isPostable) {
          throw new ConflictError(
            'The parent account is postable. Only header accounts (is_postable = false) may hold children — the database refuses lines on non-leaves.',
          );
        }
      }

      const [created] = await tx
        .insert(chartOfAccounts)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          code: input.code,
          nameEn: input.nameEn,
          nameBn: input.nameBn ?? null,
          type: input.type,
          parentAccountId: input.parentAccountId ?? null,
          normalBalance: input.normalBalance,
          isPostable: input.isPostable,
          isSystem: false,
          isCashEquivalent: input.isCashEquivalent,
          status: 'active',
          description: input.description ?? null,
          sortOrder: input.sortOrder,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  async updateAccount(
    principal: Principal,
    institutionId: string,
    id: string,
    input: Record<string, unknown>,
  ): Promise<{ account: AccountRow; previous: Partial<AccountRow> }> {
    const version = input['version'] as number;
    const { version: _ignored, ...changes } = input;

    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(chartOfAccounts)
        .where(
          and(
            eq(chartOfAccounts.id, id),
            eq(chartOfAccounts.institutionId, institutionId),
            isNull(chartOfAccounts.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Account', id);

      if (typeof changes['parentAccountId'] === 'string') {
        if (changes['parentAccountId'] === id) {
          throw new ValidationError('An account cannot be its own parent', [
            { path: 'parentAccountId', message: 'Choose a different parent' },
          ]);
        }
        const [parent] = await tx
          .select()
          .from(chartOfAccounts)
          .where(
            and(
              eq(chartOfAccounts.id, changes['parentAccountId']),
              eq(chartOfAccounts.institutionId, institutionId),
              isNull(chartOfAccounts.archivedAt),
            ),
          )
          .limit(1);
        if (!parent) throw new NotFoundError('Parent account', changes['parentAccountId']);
        if (parent.type !== existing.type || parent.isPostable) {
          throw new ConflictError(
            'The parent must be a header account of the same type as this one.',
          );
        }
      }

      const [updated] = await tx
        .update(chartOfAccounts)
        .set({
          ...(changes as Partial<AccountRow>),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(chartOfAccounts.id, id), eq(chartOfAccounts.version, version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This account was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      return { account: updated, previous: diffOf(existing, updated, Object.keys(changes)) };
    });
  }

  /**
   * Archive an account. Its history stays; the postable trigger refuses any *new* line the
   * moment the status flips. System accounts and accounts with live children are protected.
   */
  async archiveAccount(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<AccountRow> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(chartOfAccounts)
        .where(
          and(
            eq(chartOfAccounts.id, id),
            eq(chartOfAccounts.institutionId, institutionId),
            isNull(chartOfAccounts.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Account', id);

      if (existing.isSystem) {
        throw new ConflictError(
          'This is a system account another module posts to; it cannot be archived by hand.',
        );
      }

      const [child] = await tx
        .select({ id: chartOfAccounts.id })
        .from(chartOfAccounts)
        .where(and(eq(chartOfAccounts.parentAccountId, id), isNull(chartOfAccounts.archivedAt)))
        .limit(1);
      if (child) {
        throw new ConflictError('Archive or re-parent this account’s children first.');
      }

      const [archived] = await tx
        .update(chartOfAccounts)
        .set({
          status: 'archived',
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(eq(chartOfAccounts.id, id))
        .returning();
      return archived!;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Fiscal years and periods
  // ══════════════════════════════════════════════════════════════════════════════════

  async listFiscalYears(
    institutionId: string,
    query: { sort?: string; status?: string; includeArchived: boolean },
    page: OffsetPageRequest,
  ): Promise<OffsetPage<FiscalYearRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(fiscalYears.institutionId, institutionId)];
      if (!query.includeArchived) filters.push(isNull(fiscalYears.archivedAt));
      if (query.status) {
        filters.push(eq(fiscalYears.status, query.status as FiscalYearRow['status']));
      }

      const where = and(...filters);
      const orderBy = parseSort(query.sort, FISCAL_YEAR_SORT_FIELDS, {
        field: 'startDate',
        direction: 'desc',
      }).map((spec) => {
        const column = FISCAL_YEAR_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(fiscalYears)
        .where(where)
        .orderBy(...orderBy, asc(fiscalYears.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(fiscalYears)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async getFiscalYear(
    institutionId: string,
    id: string,
  ): Promise<FiscalYearRow & { periods: PeriodRow[] }> {
    return this.db.runInTenant(async (tx) => {
      const [year] = await tx
        .select()
        .from(fiscalYears)
        .where(and(eq(fiscalYears.id, id), eq(fiscalYears.institutionId, institutionId)))
        .limit(1);
      if (!year) throw new NotFoundError('Fiscal year', id);

      const periods = await tx
        .select()
        .from(accountingPeriods)
        .where(and(eq(accountingPeriods.fiscalYearId, id), isNull(accountingPeriods.archivedAt)))
        .orderBy(asc(accountingPeriods.startDate));

      return { ...year, periods };
    });
  }

  /**
   * Create a fiscal year and lay out its posting periods in one transaction, so no year
   * ever exists with a gap nothing can post into.
   */
  async createFiscalYear(
    principal: Principal,
    institutionId: string,
    input: {
      name: string;
      startDate: string;
      endDate: string;
      periodLayout: 'monthly' | 'quarterly' | 'single';
    },
  ): Promise<FiscalYearRow & { periods: PeriodRow[] }> {
    return this.db.runInTenant(async (tx) => {
      const [overlapping] = await tx
        .select({ id: fiscalYears.id, name: fiscalYears.name })
        .from(fiscalYears)
        .where(
          and(
            eq(fiscalYears.institutionId, institutionId),
            isNull(fiscalYears.archivedAt),
            lte(fiscalYears.startDate, input.endDate),
            gte(fiscalYears.endDate, input.startDate),
          ),
        )
        .limit(1);
      if (overlapping) {
        throw new ConflictError(
          `The dates overlap fiscal year "${overlapping.name}". Fiscal years may not overlap.`,
          { overlappingFiscalYearId: overlapping.id },
        );
      }

      const yearId = uuidv7();
      const [year] = await tx
        .insert(fiscalYears)
        .values({
          id: yearId,
          tenantId: principal.tenantId!,
          institutionId,
          name: input.name,
          startDate: input.startDate,
          endDate: input.endDate,
          status: 'open',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      const spans = layoutPeriods(
        calendarDate(input.startDate),
        calendarDate(input.endDate),
        input.periodLayout,
      );
      const periods: PeriodRow[] = [];
      for (const span of spans) {
        const [period] = await tx
          .insert(accountingPeriods)
          .values({
            id: uuidv7(),
            tenantId: principal.tenantId!,
            institutionId,
            fiscalYearId: yearId,
            name: span.name,
            startDate: span.start,
            endDate: span.end,
            status: 'open',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning();
        periods.push(period!);
      }

      return { ...year!, periods };
    });
  }

  /**
   * Close a fiscal year: every period in it is closed in the same transaction. Refused
   * while any draft entry remains, because a draft in a closed year could never be posted
   * or meaningfully resolved. Audited inside the transaction — closing the books is the
   * canonical sensitive accounting act.
   */
  async closeFiscalYear(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<FiscalYearRow> {
    const context = currentContext();

    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(fiscalYears)
        .where(
          and(
            eq(fiscalYears.id, id),
            eq(fiscalYears.institutionId, institutionId),
            isNull(fiscalYears.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Fiscal year', id);
      if (existing.status === 'closed') {
        throw new ConflictError('This fiscal year is already closed.');
      }

      await this.assertNoDraftEntries(tx, {
        institutionId,
        fiscalYearId: id,
        what: `fiscal year "${existing.name}"`,
      });

      const now = new Date();
      await tx
        .update(accountingPeriods)
        .set({
          status: 'closed',
          closedBy: principal.userId,
          closedAt: now,
          updatedBy: principal.userId,
        })
        .where(
          and(
            eq(accountingPeriods.fiscalYearId, id),
            eq(accountingPeriods.status, 'open'),
            isNull(accountingPeriods.archivedAt),
          ),
        );

      const [closed] = await tx
        .update(fiscalYears)
        .set({
          status: 'closed',
          closedBy: principal.userId,
          closedAt: now,
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(eq(fiscalYears.id, id))
        .returning();

      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'update',
        module: 'accounting',
        resourceType: 'fiscal_year',
        resourceId: id,
        resourceLabel: existing.name,
        previousValue: { status: existing.status },
        newValue: { status: 'closed' },
        reason,
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      return closed!;
    });
  }

  /** Reopening a closed year — the documented, higher-permission exception. */
  async reopenFiscalYear(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<FiscalYearRow> {
    const context = currentContext();

    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(fiscalYears)
        .where(
          and(
            eq(fiscalYears.id, id),
            eq(fiscalYears.institutionId, institutionId),
            isNull(fiscalYears.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Fiscal year', id);
      if (existing.status === 'open') {
        throw new ConflictError('This fiscal year is already open.');
      }

      const [reopened] = await tx
        .update(fiscalYears)
        .set({
          status: 'open',
          reopenedBy: principal.userId,
          reopenedAt: new Date(),
          reopenReason: reason,
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(eq(fiscalYears.id, id))
        .returning();

      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'restore',
        module: 'accounting',
        resourceType: 'fiscal_year',
        resourceId: id,
        resourceLabel: existing.name,
        previousValue: { status: 'closed' },
        newValue: { status: 'open' },
        reason,
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      // The year is open again, but every period stays closed until it is individually and
      // audibly reopened — reopening the year does not quietly reopen twelve months.
      return reopened!;
    });
  }

  async closePeriod(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<PeriodRow> {
    const context = currentContext();

    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(accountingPeriods)
        .where(
          and(
            eq(accountingPeriods.id, id),
            eq(accountingPeriods.institutionId, institutionId),
            isNull(accountingPeriods.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Accounting period', id);
      if (existing.status === 'closed') {
        throw new ConflictError('This period is already closed.');
      }

      await this.assertNoDraftEntries(tx, {
        institutionId,
        periodId: id,
        what: `period "${existing.name}"`,
      });

      const [closed] = await tx
        .update(accountingPeriods)
        .set({
          status: 'closed',
          closedBy: principal.userId,
          closedAt: new Date(),
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(eq(accountingPeriods.id, id))
        .returning();

      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'update',
        module: 'accounting',
        resourceType: 'accounting_period',
        resourceId: id,
        resourceLabel: existing.name,
        previousValue: { status: existing.status },
        newValue: { status: 'closed' },
        reason,
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      return closed!;
    });
  }

  async reopenPeriod(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<PeriodRow> {
    const context = currentContext();

    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select({ period: accountingPeriods, yearStatus: fiscalYears.status })
        .from(accountingPeriods)
        .innerJoin(fiscalYears, eq(fiscalYears.id, accountingPeriods.fiscalYearId))
        .where(
          and(
            eq(accountingPeriods.id, id),
            eq(accountingPeriods.institutionId, institutionId),
            isNull(accountingPeriods.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Accounting period', id);
      if (existing.period.status === 'open') {
        throw new ConflictError('This period is already open.');
      }
      if (existing.yearStatus !== 'open') {
        throw new ConflictError('Reopen the fiscal year before reopening a period inside it.');
      }

      const [reopened] = await tx
        .update(accountingPeriods)
        .set({
          status: 'open',
          reopenedBy: principal.userId,
          reopenedAt: new Date(),
          reopenReason: reason,
          updatedBy: principal.userId,
          version: existing.period.version + 1,
        })
        .where(eq(accountingPeriods.id, id))
        .returning();

      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'restore',
        module: 'accounting',
        resourceType: 'accounting_period',
        resourceId: id,
        resourceLabel: existing.period.name,
        previousValue: { status: 'closed' },
        newValue: { status: 'open' },
        reason,
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      return reopened!;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Journal
  // ══════════════════════════════════════════════════════════════════════════════════

  async listJournalEntries(
    institutionId: string,
    query: ListJournalEntriesQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<JournalEntryRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(journalEntries.institutionId, institutionId)];
      if (!query.includeArchived) filters.push(isNull(journalEntries.archivedAt));
      if (query.status) {
        filters.push(eq(journalEntries.status, query.status as JournalEntryRow['status']));
      }
      if (query.periodId) filters.push(eq(journalEntries.periodId, query.periodId));
      if (query.fiscalYearId) {
        filters.push(
          exists(
            this.db.raw
              .select({ one: sql`1` })
              .from(accountingPeriods)
              .where(
                and(
                  eq(accountingPeriods.id, journalEntries.periodId),
                  eq(accountingPeriods.fiscalYearId, query.fiscalYearId),
                ),
              ),
          ),
        );
      }
      if (query.accountId) {
        filters.push(
          exists(
            this.db.raw
              .select({ one: sql`1` })
              .from(journalLines)
              .where(
                and(
                  eq(journalLines.entryId, journalEntries.id),
                  eq(journalLines.accountId, query.accountId),
                  isNull(journalLines.archivedAt),
                ),
              ),
          ),
        );
      }
      if (query.sourceModule) filters.push(eq(journalEntries.sourceModule, query.sourceModule));
      if (query.referenceType) {
        filters.push(eq(journalEntries.referenceType, query.referenceType));
      }
      if (query.referenceId) filters.push(eq(journalEntries.referenceId, query.referenceId));
      if (query.dateFrom) filters.push(gte(journalEntries.entryDate, query.dateFrom));
      if (query.dateTo) filters.push(lte(journalEntries.entryDate, query.dateTo));
      if (query.q) filters.push(ilike(journalEntries.entryNumber, `${query.q}%`));

      const where = and(...filters);
      const orderBy = parseSort(query.sort, JOURNAL_ENTRY_SORT_FIELDS, {
        field: 'entryDate',
        direction: 'desc',
      }).map((spec) => {
        const column = JOURNAL_ENTRY_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(journalEntries)
        .where(where)
        .orderBy(...orderBy, asc(journalEntries.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(journalEntries)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async getJournalEntry(institutionId: string, id: string) {
    return this.db.runInTenant(async (tx) => {
      const [entry] = await tx
        .select()
        .from(journalEntries)
        .where(and(eq(journalEntries.id, id), eq(journalEntries.institutionId, institutionId)))
        .limit(1);
      if (!entry) throw new NotFoundError('Journal entry', id);

      const lines = await tx
        .select({
          id: journalLines.id,
          accountId: journalLines.accountId,
          accountCode: chartOfAccounts.code,
          accountName: chartOfAccounts.nameEn,
          debit: journalLines.debit,
          credit: journalLines.credit,
          description: journalLines.description,
          costCentreId: journalLines.costCentreId,
          sortOrder: journalLines.sortOrder,
        })
        .from(journalLines)
        .innerJoin(chartOfAccounts, eq(chartOfAccounts.id, journalLines.accountId))
        .where(and(eq(journalLines.entryId, id), isNull(journalLines.archivedAt)))
        .orderBy(asc(journalLines.sortOrder), asc(journalLines.id));

      return { ...entry, lines };
    });
  }

  /** A manual draft. Nothing hits any account balance until it is posted. */
  async createJournalEntry(
    principal: Principal,
    institutionId: string,
    input: {
      entryDate: string;
      description: string;
      referenceType?: string;
      referenceId?: string;
      lines: LedgerLineInput[];
    },
  ) {
    return this.db.runInTenant(async (tx) =>
      this.ledger.createDraft(tx, {
        tenantId: principal.tenantId!,
        institutionId,
        actorUserId: principal.userId,
        entryDate: input.entryDate,
        description: input.description,
        referenceType: input.referenceType ?? 'manual',
        referenceId: input.referenceId,
        sourceModule: 'accounting',
        lines: input.lines,
      }),
    );
  }

  /**
   * Edit a draft. Lines are replaced as a set — the old ones archived, never deleted —
   * and the database's deferred balance trigger re-checks the whole at commit. A posted
   * or system-generated entry refuses this outright.
   */
  async updateJournalEntry(
    principal: Principal,
    institutionId: string,
    id: string,
    input: {
      entryDate?: string;
      description?: string;
      referenceType?: string | null;
      referenceId?: string | null;
      lines?: LedgerLineInput[];
      version: number;
    },
  ) {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(journalEntries)
        .where(
          and(
            eq(journalEntries.id, id),
            eq(journalEntries.institutionId, institutionId),
            isNull(journalEntries.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Journal entry', id);

      if (existing.status !== 'draft') {
        throw new ConflictError(
          `Entry ${existing.entryNumber} is ${existing.status} and immutable. Correct it with a reversing entry.`,
        );
      }
      if (existing.isSystemGenerated) {
        throw new ConflictError(
          'This entry was generated by the system and cannot be edited by hand. Reverse it and let the source module re-post.',
        );
      }

      const entryDate = input.entryDate ?? existing.entryDate;
      const period = await this.ledger.resolveOpenPeriod(tx, institutionId, entryDate);

      const [updated] = await tx
        .update(journalEntries)
        .set({
          entryDate,
          periodId: period.id,
          description: input.description ?? existing.description,
          referenceType:
            input.referenceType === undefined ? existing.referenceType : input.referenceType,
          referenceId: input.referenceId === undefined ? existing.referenceId : input.referenceId,
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(journalEntries.id, id), eq(journalEntries.version, input.version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This entry was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: input.version, currentVersion: existing.version },
        );
      }

      if (input.lines) {
        await tx
          .update(journalLines)
          .set({
            archivedAt: new Date(),
            archivedBy: principal.userId,
            archiveReason: 'Replaced when the draft entry was edited',
            updatedBy: principal.userId,
          })
          .where(and(eq(journalLines.entryId, id), isNull(journalLines.archivedAt)));

        // Re-validated and re-written through the same code path as creation.
        await this.ledger.createDraftLines(tx, {
          tenantId: principal.tenantId!,
          institutionId,
          entryId: id,
          actorUserId: principal.userId,
          lines: input.lines,
        });
      }

      return this.loadEntryWithLines(tx, institutionId, id);
    });
  }

  /**
   * Post a draft. Separation of duties: the poster must not be the person who created the
   * draft — `accounting.journal.create` and `accounting.journal.post` are different
   * permissions for exactly this reason, and holding both does not waive it.
   */
  async postJournalEntry(principal: Principal, institutionId: string, id: string, version: number) {
    const context = currentContext();

    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(journalEntries)
        .where(
          and(
            eq(journalEntries.id, id),
            eq(journalEntries.institutionId, institutionId),
            isNull(journalEntries.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Journal entry', id);

      if (existing.status !== 'draft') {
        throw new ConflictError(`Entry ${existing.entryNumber} is already ${existing.status}.`);
      }
      if (existing.createdBy && existing.createdBy === principal.userId) {
        throw new ConflictError(
          'A journal entry must be posted by someone other than the person who drafted it.',
        );
      }

      // Friendly refusal before the trigger's: the period may have closed since drafting.
      await this.ledger.resolveOpenPeriod(tx, institutionId, existing.entryDate);

      const [posted] = await tx
        .update(journalEntries)
        .set({
          status: 'posted',
          postedBy: principal.userId,
          postedAt: new Date(),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(journalEntries.id, id), eq(journalEntries.version, version)))
        .returning();

      if (!posted) {
        throw new ConflictError(
          'This entry was changed by someone else while you were posting it. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      const totals = await this.entryTotals(tx, id);
      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'approve',
        module: 'accounting',
        resourceType: 'journal_entry',
        resourceId: id,
        resourceLabel: existing.entryNumber,
        previousValue: { status: 'draft' },
        // Money as strings, never numbers — an audit record read back as a float would be
        // a worse lie than no record at all.
        newValue: { status: 'posted', debits: totals.debits, credits: totals.credits },
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      return this.loadEntryWithLines(tx, institutionId, id);
    });
  }

  /** Reverse a posted entry. Never an edit, never a delete. */
  async reverseJournalEntry(
    principal: Principal,
    institutionId: string,
    id: string,
    input: { reason: string; entryDate?: string; version: number },
  ) {
    const context = currentContext();

    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select({ version: journalEntries.version, entryNumber: journalEntries.entryNumber })
        .from(journalEntries)
        .where(
          and(
            eq(journalEntries.id, id),
            eq(journalEntries.institutionId, institutionId),
            isNull(journalEntries.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Journal entry', id);
      if (existing.version !== input.version) {
        throw new ConflictError(
          'This entry was changed by someone else while you were working. Reload and try again.',
          { expectedVersion: input.version, currentVersion: existing.version },
        );
      }

      const { original, reversal } = await this.ledger.reverse(tx, {
        tenantId: principal.tenantId!,
        institutionId,
        actorUserId: principal.userId,
        entryId: id,
        reason: input.reason,
        entryDate: input.entryDate,
      });

      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'update',
        module: 'accounting',
        resourceType: 'journal_entry',
        resourceId: id,
        resourceLabel: existing.entryNumber,
        previousValue: { status: 'posted' },
        newValue: {
          status: 'reversed',
          reversedByEntryId: reversal.id,
          reversingEntryNumber: reversal.entryNumber,
        },
        reason: input.reason,
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      return { original, reversal };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Cost centres
  // ══════════════════════════════════════════════════════════════════════════════════

  async listCostCentres(
    institutionId: string,
    query: { sort?: string; q?: string; includeArchived: boolean },
    page: OffsetPageRequest,
  ): Promise<OffsetPage<CostCentreRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(costCentres.institutionId, institutionId)];
      if (!query.includeArchived) filters.push(isNull(costCentres.archivedAt));
      if (query.q) {
        filters.push(
          or(ilike(costCentres.nameEn, `%${query.q}%`), ilike(costCentres.code, `${query.q}%`))!,
        );
      }

      const where = and(...filters);
      const orderBy = parseSort(query.sort, COST_CENTRE_SORT_FIELDS, {
        field: 'sortOrder',
        direction: 'asc',
      }).map((spec) => {
        const column = COST_CENTRE_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(costCentres)
        .where(where)
        .orderBy(...orderBy, asc(costCentres.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(costCentres)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async createCostCentre(
    principal: Principal,
    institutionId: string,
    input: {
      code: string;
      nameEn: string;
      nameBn?: string;
      parentId?: string;
      description?: string;
      sortOrder: number;
    },
  ): Promise<CostCentreRow> {
    return this.db.runInTenant(async (tx) => {
      const [duplicate] = await tx
        .select({ id: costCentres.id })
        .from(costCentres)
        .where(
          and(
            eq(costCentres.institutionId, institutionId),
            eq(costCentres.code, input.code),
            isNull(costCentres.archivedAt),
          ),
        )
        .limit(1);
      if (duplicate) {
        throw new ConflictError(`A cost centre with code ${input.code} already exists.`);
      }

      if (input.parentId) {
        const [parent] = await tx
          .select({ id: costCentres.id })
          .from(costCentres)
          .where(
            and(
              eq(costCentres.id, input.parentId),
              eq(costCentres.institutionId, institutionId),
              isNull(costCentres.archivedAt),
            ),
          )
          .limit(1);
        if (!parent) throw new NotFoundError('Parent cost centre', input.parentId);
      }

      const [created] = await tx
        .insert(costCentres)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          code: input.code,
          nameEn: input.nameEn,
          nameBn: input.nameBn ?? null,
          parentId: input.parentId ?? null,
          description: input.description ?? null,
          sortOrder: input.sortOrder,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  async updateCostCentre(
    principal: Principal,
    institutionId: string,
    id: string,
    input: Record<string, unknown>,
  ): Promise<{ costCentre: CostCentreRow; previous: Partial<CostCentreRow> }> {
    const version = input['version'] as number;
    const { version: _ignored, ...changes } = input;

    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(costCentres)
        .where(
          and(
            eq(costCentres.id, id),
            eq(costCentres.institutionId, institutionId),
            isNull(costCentres.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Cost centre', id);

      const [updated] = await tx
        .update(costCentres)
        .set({
          ...(changes as Partial<CostCentreRow>),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(costCentres.id, id), eq(costCentres.version, version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This cost centre was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      return { costCentre: updated, previous: diffOf(existing, updated, Object.keys(changes)) };
    });
  }

  async archiveCostCentre(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<CostCentreRow> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(costCentres)
        .where(
          and(
            eq(costCentres.id, id),
            eq(costCentres.institutionId, institutionId),
            isNull(costCentres.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Cost centre', id);

      const [child] = await tx
        .select({ id: costCentres.id })
        .from(costCentres)
        .where(and(eq(costCentres.parentId, id), isNull(costCentres.archivedAt)))
        .limit(1);
      if (child) throw new ConflictError('Archive or re-parent this cost centre’s children first.');

      const [archived] = await tx
        .update(costCentres)
        .set({
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(eq(costCentres.id, id))
        .returning();
      return archived!;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Budgets
  // ══════════════════════════════════════════════════════════════════════════════════

  async listBudgets(
    institutionId: string,
    query: {
      sort?: string;
      fiscalYearId?: string;
      accountId?: string;
      costCentreId?: string;
      includeArchived: boolean;
    },
    page: OffsetPageRequest,
  ): Promise<OffsetPage<BudgetRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(budgets.institutionId, institutionId)];
      if (!query.includeArchived) filters.push(isNull(budgets.archivedAt));
      if (query.fiscalYearId) filters.push(eq(budgets.fiscalYearId, query.fiscalYearId));
      if (query.accountId) filters.push(eq(budgets.accountId, query.accountId));
      if (query.costCentreId) filters.push(eq(budgets.costCentreId, query.costCentreId));

      const where = and(...filters);
      const orderBy = parseSort(query.sort, BUDGET_SORT_FIELDS, {
        field: 'createdAt',
        direction: 'desc',
      }).map((spec) => {
        const column = BUDGET_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(budgets)
        .where(where)
        .orderBy(...orderBy, asc(budgets.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(budgets)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async createBudget(
    principal: Principal,
    institutionId: string,
    input: {
      fiscalYearId: string;
      accountId: string;
      costCentreId?: string;
      amount: string;
      note?: string;
    },
  ): Promise<BudgetRow> {
    return this.db.runInTenant(async (tx) => {
      const [year] = await tx
        .select({ id: fiscalYears.id })
        .from(fiscalYears)
        .where(
          and(
            eq(fiscalYears.id, input.fiscalYearId),
            eq(fiscalYears.institutionId, institutionId),
            isNull(fiscalYears.archivedAt),
          ),
        )
        .limit(1);
      if (!year) throw new NotFoundError('Fiscal year', input.fiscalYearId);

      const [account] = await tx
        .select({ id: chartOfAccounts.id })
        .from(chartOfAccounts)
        .where(
          and(
            eq(chartOfAccounts.id, input.accountId),
            eq(chartOfAccounts.institutionId, institutionId),
            isNull(chartOfAccounts.archivedAt),
          ),
        )
        .limit(1);
      if (!account) throw new NotFoundError('Account', input.accountId);

      if (input.costCentreId) {
        const [centre] = await tx
          .select({ id: costCentres.id })
          .from(costCentres)
          .where(
            and(
              eq(costCentres.id, input.costCentreId),
              eq(costCentres.institutionId, institutionId),
              isNull(costCentres.archivedAt),
            ),
          )
          .limit(1);
        if (!centre) throw new NotFoundError('Cost centre', input.costCentreId);
      } else {
        // NULLs are distinct in the partial unique index, so the "whole institution"
        // duplicate must be refused here, the same way fee_concessions handles its NULL head.
        const [duplicate] = await tx
          .select({ id: budgets.id })
          .from(budgets)
          .where(
            and(
              eq(budgets.fiscalYearId, input.fiscalYearId),
              eq(budgets.accountId, input.accountId),
              isNull(budgets.costCentreId),
              isNull(budgets.archivedAt),
            ),
          )
          .limit(1);
        if (duplicate) {
          throw new ConflictError(
            'A budget for this account and fiscal year already exists. Update it instead.',
            { existingBudgetId: duplicate.id },
          );
        }
      }

      const [created] = await tx
        .insert(budgets)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          fiscalYearId: input.fiscalYearId,
          accountId: input.accountId,
          costCentreId: input.costCentreId ?? null,
          amount: Money.fromDecimalString(input.amount).toDecimalString(),
          note: input.note ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  async updateBudget(
    principal: Principal,
    institutionId: string,
    id: string,
    input: { amount?: string; note?: string | null; version: number },
  ): Promise<{ budget: BudgetRow; previous: Partial<BudgetRow> }> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(budgets)
        .where(
          and(
            eq(budgets.id, id),
            eq(budgets.institutionId, institutionId),
            isNull(budgets.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Budget', id);

      const changes: Partial<BudgetRow> = {};
      if (input.amount !== undefined) {
        changes.amount = Money.fromDecimalString(input.amount).toDecimalString();
      }
      if (input.note !== undefined) changes.note = input.note;

      const [updated] = await tx
        .update(budgets)
        .set({
          ...changes,
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(budgets.id, id), eq(budgets.version, input.version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This budget was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: input.version, currentVersion: existing.version },
        );
      }

      return { budget: updated, previous: diffOf(existing, updated, Object.keys(changes)) };
    });
  }

  async archiveBudget(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<BudgetRow> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(budgets)
        .where(
          and(
            eq(budgets.id, id),
            eq(budgets.institutionId, institutionId),
            isNull(budgets.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Budget', id);

      const [archived] = await tx
        .update(budgets)
        .set({
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(eq(budgets.id, id))
        .returning();
      return archived!;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Expense claims
  // ══════════════════════════════════════════════════════════════════════════════════

  async listExpenseClaims(
    institutionId: string,
    query: ListExpenseClaimsQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<ExpenseClaimRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(expenseClaims.institutionId, institutionId)];
      if (!query.includeArchived) filters.push(isNull(expenseClaims.archivedAt));
      if (query.status) {
        filters.push(eq(expenseClaims.status, query.status as ExpenseClaimRow['status']));
      }
      if (query.employeeId) filters.push(eq(expenseClaims.employeeId, query.employeeId));
      if (query.q) filters.push(ilike(expenseClaims.claimNumber, `${query.q}%`));

      const where = and(...filters);
      const orderBy = parseSort(query.sort, EXPENSE_CLAIM_SORT_FIELDS, {
        field: 'createdAt',
        direction: 'desc',
      }).map((spec) => {
        const column = EXPENSE_CLAIM_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(expenseClaims)
        .where(where)
        .orderBy(...orderBy, asc(expenseClaims.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(expenseClaims)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async getExpenseClaim(institutionId: string, id: string): Promise<ExpenseClaimRow> {
    return this.db.runInTenant(async (tx) => {
      const [claim] = await tx
        .select()
        .from(expenseClaims)
        .where(and(eq(expenseClaims.id, id), eq(expenseClaims.institutionId, institutionId)))
        .limit(1);
      if (!claim) throw new NotFoundError('Expense claim', id);
      return claim;
    });
  }

  async createExpenseClaim(
    principal: Principal,
    institutionId: string,
    input: {
      employeeId: string;
      amount: string;
      category: string;
      description: string;
      expenseDate: string;
    },
  ): Promise<ExpenseClaimRow> {
    return this.db.runInTenant(async (tx) => {
      const [employee] = await tx
        .select({ id: employees.id, name: employees.fullNameEn })
        .from(employees)
        .where(
          and(
            eq(employees.id, input.employeeId),
            eq(employees.institutionId, institutionId),
            isNull(employees.archivedAt),
          ),
        )
        .limit(1);
      if (!employee) throw new NotFoundError('Employee', input.employeeId);

      const year4 = input.expenseDate.slice(0, 4);
      const sequence = (await this.currentClaimSequence(tx, institutionId, `EXP-${year4}-`)) + 1;
      const claimNumber = `EXP-${year4}-${String(sequence).padStart(6, '0')}`;

      const [created] = await tx
        .insert(expenseClaims)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          claimNumber,
          employeeId: input.employeeId,
          amount: Money.fromDecimalString(input.amount).toDecimalString(),
          category: input.category,
          description: input.description,
          expenseDate: input.expenseDate,
          status: 'draft',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  async submitExpenseClaim(
    principal: Principal,
    institutionId: string,
    id: string,
    version: number,
  ): Promise<ExpenseClaimRow> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadClaim(tx, institutionId, id);
      if (existing.status !== 'draft') {
        throw new ConflictError(`Claim ${existing.claimNumber} is already ${existing.status}.`);
      }

      const [submitted] = await tx
        .update(expenseClaims)
        .set({
          status: 'submitted',
          submittedAt: new Date(),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(expenseClaims.id, id), eq(expenseClaims.version, version)))
        .returning();

      if (!submitted) {
        throw new ConflictError(
          'This claim was changed by someone else while you were submitting it. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }
      return submitted;
    });
  }

  /**
   * Approve or reject a submitted claim. The decider must not be the person who filed it —
   * a person who can both claim and approve their own expenses is an unreviewed payout.
   */
  async decideExpenseClaim(
    principal: Principal,
    institutionId: string,
    id: string,
    decision: 'approved' | 'rejected',
    reason: string,
  ): Promise<ExpenseClaimRow> {
    const context = currentContext();

    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadClaim(tx, institutionId, id);
      if (existing.status !== 'submitted') {
        throw new ConflictError(
          `Only a submitted claim can be decided; ${existing.claimNumber} is ${existing.status}.`,
        );
      }
      if (existing.createdBy && existing.createdBy === principal.userId) {
        throw new ConflictError(
          'An expense claim must be decided by someone other than the person who filed it.',
        );
      }

      const [decided] = await tx
        .update(expenseClaims)
        .set({
          status: decision,
          decidedBy: principal.userId,
          decidedAt: new Date(),
          decisionNote: reason,
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(expenseClaims.id, id))
        .returning();

      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: decision === 'approved' ? 'approve' : 'reject',
        module: 'accounting',
        resourceType: 'expense_claim',
        resourceId: id,
        resourceLabel: existing.claimNumber,
        previousValue: { status: existing.status },
        newValue: { status: decision, amount: existing.amount, employeeId: existing.employeeId },
        reason,
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      return decided!;
    });
  }

  /**
   * Pay an approved claim: the money leaves through the ledger, in the same transaction —
   * debit the expense account, credit the cash account — and the claim links the entry.
   */
  async payExpenseClaim(
    principal: Principal,
    institutionId: string,
    id: string,
    input: { expenseAccountId: string; cashAccountId: string; version: number },
  ): Promise<{ claim: ExpenseClaimRow; entry: JournalEntryRow }> {
    const context = currentContext();

    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadClaim(tx, institutionId, id);
      if (existing.status !== 'approved') {
        throw new ConflictError(
          `Only an approved claim can be paid; ${existing.claimNumber} is ${existing.status}.`,
        );
      }
      if (existing.version !== input.version) {
        throw new ConflictError(
          'This claim was changed by someone else while you were paying it. Reload and try again.',
          { expectedVersion: input.version, currentVersion: existing.version },
        );
      }

      const [cashAccount] = await tx
        .select()
        .from(chartOfAccounts)
        .where(
          and(
            eq(chartOfAccounts.id, input.cashAccountId),
            eq(chartOfAccounts.institutionId, institutionId),
            isNull(chartOfAccounts.archivedAt),
          ),
        )
        .limit(1);
      if (!cashAccount) throw new NotFoundError('Account', input.cashAccountId);
      if (!cashAccount.isCashEquivalent) {
        throw new ValidationError('The credit side of a payout must be a cash or bank account', [
          { path: 'cashAccountId', message: 'Choose an account marked as cash-equivalent' },
        ]);
      }

      const [expenseAccount] = await tx
        .select()
        .from(chartOfAccounts)
        .where(
          and(
            eq(chartOfAccounts.id, input.expenseAccountId),
            eq(chartOfAccounts.institutionId, institutionId),
            isNull(chartOfAccounts.archivedAt),
          ),
        )
        .limit(1);
      if (!expenseAccount) throw new NotFoundError('Account', input.expenseAccountId);
      if (expenseAccount.type !== 'expense') {
        throw new ValidationError('An expense claim posts to an expense account', [
          { path: 'expenseAccountId', message: 'Choose an account of type "expense"' },
        ]);
      }

      const amount = Money.fromDecimalString(existing.amount);
      const { entry } = await this.ledger.post(tx, {
        tenantId: principal.tenantId!,
        institutionId,
        actorUserId: principal.userId,
        entryDate: todayInDhaka() as string,
        description: `Expense claim ${existing.claimNumber} paid (${existing.category})`,
        referenceType: 'expense_claim',
        referenceId: existing.id,
        sourceModule: 'accounting',
        isSystemGenerated: true,
        lines: [
          {
            accountId: input.expenseAccountId,
            debit: amount.toDecimalString(),
            description: existing.description.slice(0, 255),
          },
          {
            accountId: input.cashAccountId,
            credit: amount.toDecimalString(),
            description: `Paid to employee for claim ${existing.claimNumber}`,
          },
        ],
      });

      const [paid] = await tx
        .update(expenseClaims)
        .set({
          status: 'paid',
          paidBy: principal.userId,
          paidAt: new Date(),
          paymentJournalEntryId: entry.id,
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(expenseClaims.id, id))
        .returning();

      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'payment',
        module: 'accounting',
        resourceType: 'expense_claim',
        resourceId: id,
        resourceLabel: existing.claimNumber,
        previousValue: { status: 'approved' },
        newValue: {
          status: 'paid',
          amount: existing.amount,
          journalEntryId: entry.id,
          journalEntryNumber: entry.entryNumber,
        },
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      return { claim: paid!, entry };
    });
  }

  // ── Workflow integration (callbacks; the workflow module is never imported) ─────────

  /**
   * Called by the workflow module (if installed) when it picks a submitted claim up.
   * Records the request id so the two systems can find each other later.
   */
  async attachExpenseClaimWorkflow(params: {
    tenantId: string;
    institutionId: string;
    claimId: string;
    workflowRequestId: string;
    actorUserId: string | null;
  }): Promise<ExpenseClaimRow> {
    return this.db.runInTenantId(
      params.tenantId,
      async (tx) => {
        const existing = await this.loadClaim(tx, params.institutionId, params.claimId);
        if (existing.status !== 'submitted') {
          throw new ConflictError(
            `Only a submitted claim can enter a workflow; ${existing.claimNumber} is ${existing.status}.`,
          );
        }
        const [updated] = await tx
          .update(expenseClaims)
          .set({
            workflowRequestId: params.workflowRequestId,
            version: existing.version + 1,
            updatedBy: params.actorUserId,
          })
          .where(eq(expenseClaims.id, params.claimId))
          .returning();
        return updated!;
      },
      { userId: params.actorUserId },
    );
  }

  /**
   * Called by the workflow module when its approval chain reaches a decision. The claim
   * must carry the same workflow request id — a stale or foreign callback changes nothing.
   */
  async onExpenseClaimWorkflowDecision(params: {
    tenantId: string;
    institutionId: string;
    claimId: string;
    workflowRequestId: string;
    decision: 'approved' | 'rejected';
    actorUserId: string | null;
    note: string;
  }): Promise<ExpenseClaimRow> {
    return this.db.runInTenantId(
      params.tenantId,
      async (tx) => {
        const existing = await this.loadClaim(tx, params.institutionId, params.claimId);
        if (existing.workflowRequestId !== params.workflowRequestId) {
          throw new ConflictError(
            'The workflow request does not match the one attached to this claim.',
          );
        }
        if (existing.status !== 'submitted') {
          throw new ConflictError(
            `Only a submitted claim can be decided; ${existing.claimNumber} is ${existing.status}.`,
          );
        }

        const [decided] = await tx
          .update(expenseClaims)
          .set({
            status: params.decision,
            decidedBy: params.actorUserId,
            decidedAt: new Date(),
            decisionNote: params.note,
            version: existing.version + 1,
            updatedBy: params.actorUserId,
          })
          .where(eq(expenseClaims.id, params.claimId))
          .returning();

        await this.audit.recordInTransaction(tx, {
          tenantId: params.tenantId,
          institutionId: params.institutionId,
          actorUserId: params.actorUserId,
          action: params.decision === 'approved' ? 'approve' : 'reject',
          module: 'accounting',
          resourceType: 'expense_claim',
          resourceId: params.claimId,
          resourceLabel: existing.claimNumber,
          previousValue: { status: existing.status },
          newValue: {
            status: params.decision,
            amount: existing.amount,
            workflowRequestId: params.workflowRequestId,
          },
          reason: params.note,
        });

        return decided!;
      },
      { userId: params.actorUserId },
    );
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Reports — all computed in SQL, combined with Money
  // ══════════════════════════════════════════════════════════════════════════════════

  /**
   * The trial balance: per-account debit and credit totals over every effective entry up
   * to a date. It **must** balance — the deferred trigger guarantees it — and this method
   * asserts it rather than trusting it, because a report that could silently disagree with
   * its own footing is worse than a crash.
   */
  async trialBalance(institutionId: string, asOf?: string) {
    const cutoff = asOf ?? (todayInDhaka() as string);

    return this.db.runInTenant(async (tx) => {
      const rows = await tx
        .select({
          accountId: chartOfAccounts.id,
          code: chartOfAccounts.code,
          nameEn: chartOfAccounts.nameEn,
          type: chartOfAccounts.type,
          normalBalance: chartOfAccounts.normalBalance,
          debits: sql<string>`coalesce(sum(${journalLines.debit}), 0)::numeric(14,2)`,
          credits: sql<string>`coalesce(sum(${journalLines.credit}), 0)::numeric(14,2)`,
        })
        .from(journalLines)
        .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
        .innerJoin(chartOfAccounts, eq(chartOfAccounts.id, journalLines.accountId))
        .where(this.effectiveLineFilter(institutionId, { to: cutoff }))
        .groupBy(
          chartOfAccounts.id,
          chartOfAccounts.code,
          chartOfAccounts.nameEn,
          chartOfAccounts.type,
          chartOfAccounts.normalBalance,
        )
        .orderBy(asc(chartOfAccounts.code));

      let totalDebits = Money.zero();
      let totalCredits = Money.zero();

      const accounts = rows.map((row) => {
        const debits = Money.fromDecimalString(row.debits);
        const credits = Money.fromDecimalString(row.credits);
        totalDebits = totalDebits.plus(debits);
        totalCredits = totalCredits.plus(credits);

        const net = row.normalBalance === 'debit' ? debits.minus(credits) : credits.minus(debits);
        return {
          accountId: row.accountId,
          code: row.code,
          nameEn: row.nameEn,
          type: row.type,
          normalBalance: row.normalBalance,
          debits: debits.toDecimalString(),
          credits: credits.toDecimalString(),
          balance: net.toDecimalString(),
        };
      });

      // The assertion the whole module rests on. If this ever throws, the database trigger
      // has been circumvented and the books are misstated; a 500 is the correct answer.
      if (!totalDebits.equals(totalCredits)) {
        throw new InternalError('The trial balance does not balance', {
          totalDebits: totalDebits.toDecimalString(),
          totalCredits: totalCredits.toDecimalString(),
        });
      }

      return {
        asOf: cutoff,
        currency: 'BDT',
        accounts,
        totalDebits: totalDebits.toDecimalString(),
        totalCredits: totalCredits.toDecimalString(),
        balanced: true,
      };
    });
  }

  /**
   * The general ledger for one account: every effective line in order, with a running
   * balance accumulated in `Money` so two thousand rows are exact rather than nearly exact.
   * `from` omitted means "since inception"; supplied, an opening balance is computed first.
   */
  async generalLedger(
    institutionId: string,
    query: { accountId: string; from?: string; to?: string },
  ) {
    return this.db.runInTenant(async (tx) => {
      const [account] = await tx
        .select()
        .from(chartOfAccounts)
        .where(
          and(
            eq(chartOfAccounts.id, query.accountId),
            eq(chartOfAccounts.institutionId, institutionId),
          ),
        )
        .limit(1);
      if (!account) throw new NotFoundError('Account', query.accountId);

      let opening = Money.zero();
      if (query.from) {
        const [before] = await tx
          .select({
            debits: sql<string>`coalesce(sum(${journalLines.debit}), 0)::numeric(14,2)`,
            credits: sql<string>`coalesce(sum(${journalLines.credit}), 0)::numeric(14,2)`,
          })
          .from(journalLines)
          .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
          .where(
            and(
              this.effectiveLineFilter(institutionId, { before: query.from }),
              eq(journalLines.accountId, query.accountId),
            ),
          );
        const debits = Money.fromDecimalString(before?.debits ?? '0.00');
        const credits = Money.fromDecimalString(before?.credits ?? '0.00');
        opening = account.normalBalance === 'debit' ? debits.minus(credits) : credits.minus(debits);
      }

      const lines = await tx
        .select({
          entryId: journalEntries.id,
          entryNumber: journalEntries.entryNumber,
          entryDate: journalEntries.entryDate,
          entryStatus: journalEntries.status,
          description: sql<
            string | null
          >`coalesce(${journalLines.description}, ${journalEntries.description})`,
          debit: journalLines.debit,
          credit: journalLines.credit,
        })
        .from(journalLines)
        .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
        .where(
          and(
            this.effectiveLineFilter(institutionId, { from: query.from, to: query.to }),
            eq(journalLines.accountId, query.accountId),
          ),
        )
        .orderBy(
          asc(journalEntries.entryDate),
          asc(journalEntries.entryNumber),
          asc(journalLines.sortOrder),
          asc(journalLines.id),
        );

      let running = opening;
      let totalDebits = Money.zero();
      let totalCredits = Money.zero();

      const entries = lines.map((line) => {
        const debit = Money.fromDecimalString(line.debit);
        const credit = Money.fromDecimalString(line.credit);
        totalDebits = totalDebits.plus(debit);
        totalCredits = totalCredits.plus(credit);
        running =
          account.normalBalance === 'debit'
            ? running.plus(debit).minus(credit)
            : running.plus(credit).minus(debit);
        return {
          entryId: line.entryId,
          entryNumber: line.entryNumber,
          date: line.entryDate,
          status: line.entryStatus,
          description: line.description,
          debit: debit.toDecimalString(),
          credit: credit.toDecimalString(),
          balance: running.toDecimalString(),
        };
      });

      return {
        account: {
          id: account.id,
          code: account.code,
          nameEn: account.nameEn,
          type: account.type,
          normalBalance: account.normalBalance,
        },
        currency: 'BDT',
        from: query.from ?? null,
        to: query.to ?? null,
        openingBalance: opening.toDecimalString(),
        totalDebits: totalDebits.toDecimalString(),
        totalCredits: totalCredits.toDecimalString(),
        closingBalance: running.toDecimalString(),
        entries,
      };
    });
  }

  /** Income statement over a range: income and expense accounts, on their normal side. */
  async incomeStatement(
    institutionId: string,
    query: { from: string; to: string; costCentreId?: string },
  ) {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [
        this.effectiveLineFilter(institutionId, { from: query.from, to: query.to }),
        inArray(chartOfAccounts.type, ['income', 'expense']),
      ];
      if (query.costCentreId) filters.push(eq(journalLines.costCentreId, query.costCentreId));

      const rows = await tx
        .select({
          accountId: chartOfAccounts.id,
          code: chartOfAccounts.code,
          nameEn: chartOfAccounts.nameEn,
          type: chartOfAccounts.type,
          debits: sql<string>`coalesce(sum(${journalLines.debit}), 0)::numeric(14,2)`,
          credits: sql<string>`coalesce(sum(${journalLines.credit}), 0)::numeric(14,2)`,
        })
        .from(journalLines)
        .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
        .innerJoin(chartOfAccounts, eq(chartOfAccounts.id, journalLines.accountId))
        .where(and(...filters))
        .groupBy(
          chartOfAccounts.id,
          chartOfAccounts.code,
          chartOfAccounts.nameEn,
          chartOfAccounts.type,
        )
        .orderBy(asc(chartOfAccounts.code));

      const income: Array<{ accountId: string; code: string; nameEn: string; amount: string }> = [];
      const expenses: Array<{ accountId: string; code: string; nameEn: string; amount: string }> =
        [];
      let totalIncome = Money.zero();
      let totalExpenses = Money.zero();

      for (const row of rows) {
        const debits = Money.fromDecimalString(row.debits);
        const credits = Money.fromDecimalString(row.credits);
        if (row.type === 'income') {
          const amount = credits.minus(debits);
          totalIncome = totalIncome.plus(amount);
          income.push({
            accountId: row.accountId,
            code: row.code,
            nameEn: row.nameEn,
            amount: amount.toDecimalString(),
          });
        } else {
          const amount = debits.minus(credits);
          totalExpenses = totalExpenses.plus(amount);
          expenses.push({
            accountId: row.accountId,
            code: row.code,
            nameEn: row.nameEn,
            amount: amount.toDecimalString(),
          });
        }
      }

      return {
        from: query.from,
        to: query.to,
        currency: 'BDT',
        income,
        expenses,
        totalIncome: totalIncome.toDecimalString(),
        totalExpenses: totalExpenses.toDecimalString(),
        netResult: totalIncome.minus(totalExpenses).toDecimalString(),
      };
    });
  }

  /**
   * Balance sheet as of a date. Retained earnings are computed, not stored: income minus
   * expenses over all effective postings up to the date, shown inside equity. The equation
   * `assets = liabilities + equity` is asserted — it follows from the balance trigger, and
   * a sheet that does not add up must fail loudly, not render.
   */
  async balanceSheet(institutionId: string, asOf?: string) {
    const cutoff = asOf ?? (todayInDhaka() as string);

    return this.db.runInTenant(async (tx) => {
      const rows = await tx
        .select({
          accountId: chartOfAccounts.id,
          code: chartOfAccounts.code,
          nameEn: chartOfAccounts.nameEn,
          type: chartOfAccounts.type,
          debits: sql<string>`coalesce(sum(${journalLines.debit}), 0)::numeric(14,2)`,
          credits: sql<string>`coalesce(sum(${journalLines.credit}), 0)::numeric(14,2)`,
        })
        .from(journalLines)
        .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
        .innerJoin(chartOfAccounts, eq(chartOfAccounts.id, journalLines.accountId))
        .where(this.effectiveLineFilter(institutionId, { to: cutoff }))
        .groupBy(
          chartOfAccounts.id,
          chartOfAccounts.code,
          chartOfAccounts.nameEn,
          chartOfAccounts.type,
        )
        .orderBy(asc(chartOfAccounts.code));

      type Section = Array<{ accountId: string; code: string; nameEn: string; amount: string }>;
      const assets: Section = [];
      const liabilities: Section = [];
      const equity: Section = [];
      let totalAssets = Money.zero();
      let totalLiabilities = Money.zero();
      let totalEquity = Money.zero();
      let retainedEarnings = Money.zero();

      for (const row of rows) {
        const debits = Money.fromDecimalString(row.debits);
        const credits = Money.fromDecimalString(row.credits);
        switch (row.type) {
          case 'asset': {
            const amount = debits.minus(credits);
            totalAssets = totalAssets.plus(amount);
            assets.push(sectionRow(row, amount));
            break;
          }
          case 'liability': {
            const amount = credits.minus(debits);
            totalLiabilities = totalLiabilities.plus(amount);
            liabilities.push(sectionRow(row, amount));
            break;
          }
          case 'equity': {
            const amount = credits.minus(debits);
            totalEquity = totalEquity.plus(amount);
            equity.push(sectionRow(row, amount));
            break;
          }
          case 'income':
            retainedEarnings = retainedEarnings.plus(credits.minus(debits));
            break;
          case 'expense':
            retainedEarnings = retainedEarnings.minus(debits.minus(credits));
            break;
        }
      }

      const equityWithEarnings = totalEquity.plus(retainedEarnings);
      const rightSide = totalLiabilities.plus(equityWithEarnings);

      if (!totalAssets.equals(rightSide)) {
        throw new InternalError('The balance sheet does not balance', {
          totalAssets: totalAssets.toDecimalString(),
          liabilitiesAndEquity: rightSide.toDecimalString(),
        });
      }

      return {
        asOf: cutoff,
        currency: 'BDT',
        assets,
        liabilities,
        equity,
        retainedEarnings: retainedEarnings.toDecimalString(),
        totalAssets: totalAssets.toDecimalString(),
        totalLiabilities: totalLiabilities.toDecimalString(),
        totalEquity: equityWithEarnings.toDecimalString(),
        balanced: true,
      };
    });
  }

  /**
   * Cash-flow statement, indirect method: start from net income, adjust for the movement
   * in every non-cash balance-sheet account, and arrive at the change in cash. Because
   * every entry balances, the arrival is exact — and it is asserted against the change
   * computed directly from the cash accounts.
   */
  async cashFlow(institutionId: string, query: { from: string; to: string }) {
    return this.db.runInTenant(async (tx) => {
      const rows = await tx
        .select({
          accountId: chartOfAccounts.id,
          code: chartOfAccounts.code,
          nameEn: chartOfAccounts.nameEn,
          type: chartOfAccounts.type,
          isCashEquivalent: chartOfAccounts.isCashEquivalent,
          debits: sql<string>`coalesce(sum(${journalLines.debit}), 0)::numeric(14,2)`,
          credits: sql<string>`coalesce(sum(${journalLines.credit}), 0)::numeric(14,2)`,
        })
        .from(journalLines)
        .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
        .innerJoin(chartOfAccounts, eq(chartOfAccounts.id, journalLines.accountId))
        .where(this.effectiveLineFilter(institutionId, { from: query.from, to: query.to }))
        .groupBy(
          chartOfAccounts.id,
          chartOfAccounts.code,
          chartOfAccounts.nameEn,
          chartOfAccounts.type,
          chartOfAccounts.isCashEquivalent,
        )
        .orderBy(asc(chartOfAccounts.code));

      let netIncome = Money.zero();
      let cashDelta = Money.zero();
      let adjustmentsTotal = Money.zero();
      const adjustments: Array<{
        accountId: string;
        code: string;
        nameEn: string;
        type: string;
        effect: string;
      }> = [];

      for (const row of rows) {
        const debits = Money.fromDecimalString(row.debits);
        const credits = Money.fromDecimalString(row.credits);

        if (row.type === 'income') {
          netIncome = netIncome.plus(credits.minus(debits));
          continue;
        }
        if (row.type === 'expense') {
          netIncome = netIncome.minus(debits.minus(credits));
          continue;
        }
        if (row.isCashEquivalent) {
          cashDelta = cashDelta.plus(debits.minus(credits));
          continue;
        }

        // Non-cash balance-sheet movement, always `credits - debits`: an asset growing
        // (debits exceed credits) consumes cash and lands negative; a liability or equity
        // balance growing (credits exceed debits) provides cash and lands positive.
        const effect = credits.minus(debits);
        if (!effect.isZero()) {
          adjustmentsTotal = adjustmentsTotal.plus(effect);
          adjustments.push({
            accountId: row.accountId,
            code: row.code,
            nameEn: row.nameEn,
            type: row.type,
            effect: effect.toDecimalString(),
          });
        }
      }

      const netCashFlow = netIncome.plus(adjustmentsTotal);

      // The accounting identity: net income plus non-cash movements is exactly the change
      // in cash, because every entry balanced. If it is not, the report is lying.
      if (!netCashFlow.equals(cashDelta)) {
        throw new InternalError('The cash-flow statement does not reconcile', {
          netCashFlow: netCashFlow.toDecimalString(),
          cashDelta: cashDelta.toDecimalString(),
        });
      }

      return {
        from: query.from,
        to: query.to,
        currency: 'BDT',
        method: 'indirect',
        netIncome: netIncome.toDecimalString(),
        adjustments,
        netCashFlow: netCashFlow.toDecimalString(),
        changeInCash: cashDelta.toDecimalString(),
        reconciled: true,
      };
    });
  }

  /** Budget vs actual for a fiscal year: what was planned against what was posted. */
  async budgetVsActual(
    institutionId: string,
    query: { fiscalYearId: string; costCentreId?: string },
  ) {
    return this.db.runInTenant(async (tx) => {
      const [year] = await tx
        .select()
        .from(fiscalYears)
        .where(
          and(eq(fiscalYears.id, query.fiscalYearId), eq(fiscalYears.institutionId, institutionId)),
        )
        .limit(1);
      if (!year) throw new NotFoundError('Fiscal year', query.fiscalYearId);

      const budgetFilters: SQL[] = [
        eq(budgets.institutionId, institutionId),
        eq(budgets.fiscalYearId, query.fiscalYearId),
        isNull(budgets.archivedAt),
      ];
      if (query.costCentreId) budgetFilters.push(eq(budgets.costCentreId, query.costCentreId));

      const budgetRows = await tx
        .select({
          budgetId: budgets.id,
          accountId: budgets.accountId,
          costCentreId: budgets.costCentreId,
          amount: budgets.amount,
          code: chartOfAccounts.code,
          nameEn: chartOfAccounts.nameEn,
          type: chartOfAccounts.type,
          normalBalance: chartOfAccounts.normalBalance,
        })
        .from(budgets)
        .innerJoin(chartOfAccounts, eq(chartOfAccounts.id, budgets.accountId))
        .where(and(...budgetFilters))
        .orderBy(asc(chartOfAccounts.code));

      const rows = [];
      let totalBudget = Money.zero();
      let totalActual = Money.zero();

      for (const budget of budgetRows) {
        const actualFilters: SQL[] = [
          this.effectiveLineFilter(institutionId, {
            from: year.startDate,
            to: year.endDate,
          }),
          eq(journalLines.accountId, budget.accountId),
        ];
        if (budget.costCentreId) {
          actualFilters.push(eq(journalLines.costCentreId, budget.costCentreId));
        }

        const [sums] = await tx
          .select({
            debits: sql<string>`coalesce(sum(${journalLines.debit}), 0)::numeric(14,2)`,
            credits: sql<string>`coalesce(sum(${journalLines.credit}), 0)::numeric(14,2)`,
          })
          .from(journalLines)
          .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
          .where(and(...actualFilters));

        const debits = Money.fromDecimalString(sums?.debits ?? '0.00');
        const credits = Money.fromDecimalString(sums?.credits ?? '0.00');
        const actual =
          budget.normalBalance === 'debit' ? debits.minus(credits) : credits.minus(debits);
        const planned = Money.fromDecimalString(budget.amount);

        totalBudget = totalBudget.plus(planned);
        totalActual = totalActual.plus(actual);

        rows.push({
          budgetId: budget.budgetId,
          accountId: budget.accountId,
          code: budget.code,
          nameEn: budget.nameEn,
          type: budget.type,
          costCentreId: budget.costCentreId,
          budget: planned.toDecimalString(),
          actual: actual.toDecimalString(),
          variance: planned.minus(actual).toDecimalString(),
        });
      }

      return {
        fiscalYear: {
          id: year.id,
          name: year.name,
          startDate: year.startDate,
          endDate: year.endDate,
        },
        currency: 'BDT',
        rows,
        totals: {
          budget: totalBudget.toDecimalString(),
          actual: totalActual.toDecimalString(),
          variance: totalBudget.minus(totalActual).toDecimalString(),
        },
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Internals
  // ══════════════════════════════════════════════════════════════════════════════════

  /**
   * The filter every report shares: live lines of effective (posted or later-reversed —
   * i.e. anything but draft) entries in this institution, optionally bounded by date.
   * Reversed originals still count; their mirror entries cancel them numerically, which
   * is exactly what "reversal, never deletion" means for a report.
   */
  private effectiveLineFilter(
    institutionId: string,
    range: { from?: string; to?: string; before?: string },
  ): SQL {
    const filters: SQL[] = [
      eq(journalEntries.institutionId, institutionId),
      ne(journalEntries.status, 'draft'),
      isNull(journalEntries.archivedAt),
      isNull(journalLines.archivedAt),
    ];
    if (range.from) filters.push(gte(journalEntries.entryDate, range.from));
    if (range.to) filters.push(lte(journalEntries.entryDate, range.to));
    if (range.before) filters.push(sql`${journalEntries.entryDate} < ${range.before}`);
    return and(...filters)!;
  }

  private async assertNoDraftEntries(
    tx: Tx,
    scope: { institutionId: string; periodId?: string; fiscalYearId?: string; what: string },
  ): Promise<void> {
    const filters: SQL[] = [
      eq(journalEntries.institutionId, scope.institutionId),
      eq(journalEntries.status, 'draft'),
      isNull(journalEntries.archivedAt),
    ];
    if (scope.periodId) filters.push(eq(journalEntries.periodId, scope.periodId));
    if (scope.fiscalYearId) {
      filters.push(
        exists(
          this.db.raw
            .select({ one: sql`1` })
            .from(accountingPeriods)
            .where(
              and(
                eq(accountingPeriods.id, journalEntries.periodId),
                eq(accountingPeriods.fiscalYearId, scope.fiscalYearId),
              ),
            ),
        ),
      );
    }

    const [draft] = await tx
      .select({ id: journalEntries.id, entryNumber: journalEntries.entryNumber })
      .from(journalEntries)
      .where(and(...filters))
      .limit(1);

    if (draft) {
      throw new ConflictError(
        `Draft entries remain in ${scope.what} (e.g. ${draft.entryNumber}). Post or archive them before closing.`,
        { draftEntryId: draft.id },
      );
    }
  }

  private async loadClaim(tx: Tx, institutionId: string, id: string): Promise<ExpenseClaimRow> {
    const [claim] = await tx
      .select()
      .from(expenseClaims)
      .where(
        and(
          eq(expenseClaims.id, id),
          eq(expenseClaims.institutionId, institutionId),
          isNull(expenseClaims.archivedAt),
        ),
      )
      .limit(1);
    if (!claim) throw new NotFoundError('Expense claim', id);
    return claim;
  }

  private async loadEntryWithLines(tx: Tx, institutionId: string, id: string) {
    const [entry] = await tx
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.id, id), eq(journalEntries.institutionId, institutionId)))
      .limit(1);
    if (!entry) throw new NotFoundError('Journal entry', id);

    const lines = await tx
      .select()
      .from(journalLines)
      .where(and(eq(journalLines.entryId, id), isNull(journalLines.archivedAt)))
      .orderBy(asc(journalLines.sortOrder), asc(journalLines.id));

    return { ...entry, lines };
  }

  private async entryTotals(tx: Tx, entryId: string): Promise<{ debits: string; credits: string }> {
    const [sums] = await tx
      .select({
        debits: sql<string>`coalesce(sum(${journalLines.debit}), 0)::numeric(14,2)`,
        credits: sql<string>`coalesce(sum(${journalLines.credit}), 0)::numeric(14,2)`,
      })
      .from(journalLines)
      .where(and(eq(journalLines.entryId, entryId), isNull(journalLines.archivedAt)));
    return {
      debits: Money.fromDecimalString(sums?.debits ?? '0.00').toDecimalString(),
      credits: Money.fromDecimalString(sums?.credits ?? '0.00').toDecimalString(),
    };
  }

  private async currentClaimSequence(
    tx: Tx,
    institutionId: string,
    prefix: string,
  ): Promise<number> {
    const [row] = await tx
      .select({ maxNumber: sql<string | null>`max(${expenseClaims.claimNumber})` })
      .from(expenseClaims)
      .where(
        and(
          eq(expenseClaims.institutionId, institutionId),
          like(expenseClaims.claimNumber, `${prefix}%`),
        ),
      );
    return sequenceAfter(row?.maxNumber ?? null, prefix);
  }
}

// ────────────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────────────────────────

/** Next number after the highest one already issued under a prefix. */
function sequenceAfter(highest: string | null, prefix: string): number {
  if (!highest) return 0;
  const parsed = Number.parseInt(highest.slice(prefix.length), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function diffOf<T extends Record<string, unknown>>(
  before: T,
  after: T,
  keys: string[],
): Partial<T> {
  const previous: Partial<T> = {};
  for (const key of keys) {
    const typedKey = key as keyof T;
    if (before[typedKey] !== after[typedKey]) {
      (previous as Record<string, unknown>)[key] = before[typedKey];
    }
  }
  return previous;
}

function sectionRow(
  row: { accountId: string; code: string; nameEn: string },
  amount: Money,
): { accountId: string; code: string; nameEn: string; amount: string } {
  return {
    accountId: row.accountId,
    code: row.code,
    nameEn: row.nameEn,
    amount: amount.toDecimalString(),
  };
}

/**
 * Cut a fiscal year into periods. Month boundaries clamp correctly because `addMonths`
 * clamps month-end; the final period always ends exactly on the year's end date.
 */
export function layoutPeriods(
  start: CalendarDate,
  end: CalendarDate,
  layout: 'monthly' | 'quarterly' | 'single',
): Array<{ name: string; start: string; end: string }> {
  if (layout === 'single') {
    return [{ name: 'Full year', start: start as string, end: end as string }];
  }

  const step = layout === 'monthly' ? 1 : 3;
  const spans: Array<{ name: string; start: string; end: string }> = [];
  let cursor = start;
  let index = 0;

  while (cursor <= end) {
    const nextStart = addMonths(cursor, step);
    const spanEnd = addDays(nextStart, -1) <= end ? addDays(nextStart, -1) : end;
    index += 1;
    const label =
      layout === 'monthly'
        ? (cursor as string).slice(0, 7)
        : `Q${index} ${(cursor as string).slice(0, 4)}`;
    spans.push({ name: label, start: cursor as string, end: spanEnd as string });
    cursor = nextStart;
  }

  return spans;
}

/**
 * Sortable columns, one map per listed resource.
 *
 * Keys must match the corresponding `*_SORT_FIELDS` in `@shikkha/validation` exactly: the
 * query schema validates the field name, and this maps the validated name onto a column. The
 * indirection is what stops a client-supplied sort string from reaching SQL.
 */
const ACCOUNT_COLUMNS = {
  code: chartOfAccounts.code,
  nameEn: chartOfAccounts.nameEn,
  type: chartOfAccounts.type,
  sortOrder: chartOfAccounts.sortOrder,
  createdAt: chartOfAccounts.createdAt,
} as const;

const FISCAL_YEAR_COLUMNS = {
  name: fiscalYears.name,
  startDate: fiscalYears.startDate,
  status: fiscalYears.status,
  createdAt: fiscalYears.createdAt,
} as const;

const JOURNAL_ENTRY_COLUMNS = {
  entryNumber: journalEntries.entryNumber,
  entryDate: journalEntries.entryDate,
  status: journalEntries.status,
  createdAt: journalEntries.createdAt,
} as const;

const COST_CENTRE_COLUMNS = {
  code: costCentres.code,
  nameEn: costCentres.nameEn,
  sortOrder: costCentres.sortOrder,
  createdAt: costCentres.createdAt,
} as const;

const BUDGET_COLUMNS = {
  amount: budgets.amount,
  createdAt: budgets.createdAt,
} as const;

const EXPENSE_CLAIM_COLUMNS = {
  claimNumber: expenseClaims.claimNumber,
  expenseDate: expenseClaims.expenseDate,
  amount: expenseClaims.amount,
  status: expenseClaims.status,
  createdAt: expenseClaims.createdAt,
} as const;
