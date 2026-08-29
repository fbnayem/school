/**
 * Typed client for the `/accounting` module (Phase 13 — the double-entry ledger).
 *
 * Every route on `AccountingController` is `@InstitutionScoped()`, so every function here takes
 * the institution id and passes it through `RequestOptions.institutionId`; `apiRequest` turns
 * that into the `x-institution-id` header. A missing id is a bug at the call site, not
 * something to paper over with a default.
 *
 * Money fields are typed `string` throughout and stay strings: `numeric(14,2)` comes back from
 * the driver as a decimal string and nothing in the browser may parse one (ADR-004). The
 * balance of every report below was computed by `Money` on the server; this file transports it.
 *
 * Only the endpoints the accounting screens actually call are wrapped. Budgets, cost-centre
 * mutation and expense claims exist on the API but have no screen in this batch, and an unused
 * wrapper is a promise the UI does not keep.
 */

import { apiRequest, type Paged } from '@/lib/api';
import type {
  ACCOUNTING_PERIOD_STATUSES,
  COA_ACCOUNT_TYPES,
  COA_NORMAL_BALANCES,
  FISCAL_YEAR_STATUSES,
  JOURNAL_ENTRY_STATUSES,
} from '@shikkha/validation';

export type AccountType = (typeof COA_ACCOUNT_TYPES)[number];
export type NormalBalance = (typeof COA_NORMAL_BALANCES)[number];
export type FiscalYearStatus = (typeof FISCAL_YEAR_STATUSES)[number];
export type AccountingPeriodStatus = (typeof ACCOUNTING_PERIOD_STATUSES)[number];
export type JournalEntryStatus = (typeof JOURNAL_ENTRY_STATUSES)[number];

/** One row of `chart_of_accounts`, as `listAccounts` selects it (`select()` — every column). */
export interface Account {
  id: string;
  code: string;
  nameEn: string;
  nameBn: string | null;
  type: AccountType;
  parentAccountId: string | null;
  normalBalance: NormalBalance;
  /** Header accounts group and subtotal; only leaves accept a journal line. */
  isPostable: boolean;
  /** Maintained by another module (the fees cash account, payroll salary expense). */
  isSystem: boolean;
  isCashEquivalent: boolean;
  status: 'active' | 'archived';
  description: string | null;
  sortOrder: number;
  version: number;
  archivedAt: string | null;
}

export interface FiscalYear {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: FiscalYearStatus;
  closedAt: string | null;
  reopenedAt: string | null;
  reopenReason: string | null;
  version: number;
  archivedAt: string | null;
}

export interface AccountingPeriod {
  id: string;
  fiscalYearId: string;
  name: string;
  startDate: string;
  endDate: string;
  status: AccountingPeriodStatus;
  closedAt: string | null;
  version: number;
}

export interface JournalEntry {
  id: string;
  entryNumber: string;
  periodId: string;
  entryDate: string;
  description: string;
  referenceType: string | null;
  referenceId: string | null;
  status: JournalEntryStatus;
  postedBy: string | null;
  postedAt: string | null;
  /** Set exactly when `status` is `reversed`: the mirror entry that cancelled this one. */
  reversedByEntryId: string | null;
  isSystemGenerated: boolean;
  sourceModule: string;
  version: number;
  createdAt: string;
  archivedAt: string | null;
}

/** `GET /accounting/journal/:id` joins the account so a line reads as a name, not a uuid. */
export interface JournalEntryLine {
  id: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  debit: string;
  credit: string;
  description: string | null;
  costCentreId: string | null;
  sortOrder: number;
}

export interface JournalEntryDetail extends JournalEntry {
  lines: JournalEntryLine[];
}

/**
 * `POST /journal` and `POST /journal/:id/post` return the raw `journal_lines` rows — the same
 * entry, but *without* the joined account code and name. Typing them as one shape would make
 * `line.accountCode` compile against a response that never carries it.
 */
export interface JournalEntryRawLine {
  id: string;
  accountId: string;
  debit: string;
  credit: string;
  description: string | null;
  costCentreId: string | null;
  sortOrder: number;
}

export interface CostCentre {
  id: string;
  code: string;
  nameEn: string;
  nameBn: string | null;
  parentId: string | null;
  description: string | null;
  sortOrder: number;
  version: number;
  archivedAt: string | null;
}

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  nameEn: string;
  type: AccountType;
  normalBalance: NormalBalance;
  debits: string;
  credits: string;
  /** Net movement on the account's normal side. Signed, so a contra balance shows negative. */
  balance: string;
}

export interface TrialBalance {
  asOf: string;
  currency: string;
  accounts: TrialBalanceRow[];
  totalDebits: string;
  totalCredits: string;
  /**
   * Always `true` when the response arrives: the service throws a 500 rather than returning an
   * unbalanced trial balance, because a report that does not balance is a lie, not a warning.
   */
  balanced: boolean;
}

export interface GeneralLedgerEntry {
  entryId: string;
  entryNumber: string;
  date: string;
  status: JournalEntryStatus;
  description: string | null;
  debit: string;
  credit: string;
  balance: string;
}

export interface GeneralLedger {
  account: {
    id: string;
    code: string;
    nameEn: string;
    type: AccountType;
    normalBalance: NormalBalance;
  };
  currency: string;
  from: string | null;
  to: string | null;
  openingBalance: string;
  totalDebits: string;
  totalCredits: string;
  closingBalance: string;
  entries: GeneralLedgerEntry[];
}

type Query = Record<string, string | number | boolean | undefined | null>;

export const accountingApi = {
  // ── Chart of accounts ──────────────────────────────────────────────────────────────
  listAccounts: (institutionId: string, query: Query) =>
    apiRequest<Paged<Account>>('/accounting/accounts', { query, institutionId }),
  createAccount: (institutionId: string, body: unknown) =>
    apiRequest<Account>('/accounting/accounts', { method: 'POST', body, institutionId }),
  updateAccount: (institutionId: string, id: string, body: unknown) =>
    apiRequest<Account>(`/accounting/accounts/${id}`, { method: 'PATCH', body, institutionId }),
  archiveAccount: (institutionId: string, id: string, reason: string) =>
    apiRequest<Account>(`/accounting/accounts/${id}/archive`, {
      method: 'POST',
      body: { reason },
      institutionId,
    }),

  // ── Fiscal years ───────────────────────────────────────────────────────────────────
  listFiscalYears: (institutionId: string, query: Query) =>
    apiRequest<Paged<FiscalYear>>('/accounting/fiscal-years', { query, institutionId }),
  getFiscalYear: (institutionId: string, id: string) =>
    apiRequest<FiscalYear & { periods: AccountingPeriod[] }>(
      `/accounting/fiscal-years/${id}`,
      { institutionId },
    ),

  // ── Journal ────────────────────────────────────────────────────────────────────────
  listJournalEntries: (institutionId: string, query: Query) =>
    apiRequest<Paged<JournalEntry>>('/accounting/journal', { query, institutionId }),
  getJournalEntry: (institutionId: string, id: string) =>
    apiRequest<JournalEntryDetail>(`/accounting/journal/${id}`, { institutionId }),
  createJournalEntry: (institutionId: string, body: unknown) =>
    apiRequest<{ entry: JournalEntry; lines: JournalEntryRawLine[] }>('/accounting/journal', {
      method: 'POST',
      body,
      institutionId,
    }),
  /** Edits a draft; the lines are replaced as a complete set. A posted entry refuses this. */
  updateJournalEntry: (institutionId: string, id: string, body: unknown) =>
    apiRequest<JournalEntry & { lines: JournalEntryRawLine[] }>(`/accounting/journal/${id}`, {
      method: 'PATCH',
      body,
      institutionId,
    }),
  postJournalEntry: (institutionId: string, id: string, version: number) =>
    apiRequest<JournalEntry & { lines: JournalEntryRawLine[] }>(
      `/accounting/journal/${id}/post`,
      { method: 'POST', body: { version }, institutionId },
    ),
  reverseJournalEntry: (
    institutionId: string,
    id: string,
    body: { reason: string; entryDate?: string; version: number },
  ) =>
    apiRequest<{ original: JournalEntry; reversal: JournalEntry }>(
      `/accounting/journal/${id}/reverse`,
      { method: 'POST', body, institutionId },
    ),

  // ── Cost centres (read-only here: the line form offers them, nothing edits them) ────
  listCostCentres: (institutionId: string, query: Query) =>
    apiRequest<Paged<CostCentre>>('/accounting/cost-centres', { query, institutionId }),

  // ── Reports ────────────────────────────────────────────────────────────────────────
  trialBalance: (institutionId: string, query: Query) =>
    apiRequest<TrialBalance>('/accounting/reports/trial-balance', { query, institutionId }),
  generalLedger: (institutionId: string, query: Query) =>
    apiRequest<GeneralLedger>('/accounting/reports/general-ledger', { query, institutionId }),
};
