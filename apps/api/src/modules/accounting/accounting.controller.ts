/**
 * Accounting endpoints (Phase 13): the double-entry ledger.
 *
 * Every route is `@InstitutionScoped()`: a ledger belongs to one institution, and a group
 * administrator running three schools has no safe default. The header is required by the
 * tenant guard rather than guessed here.
 *
 * The permission split is separation of duties written down:
 *
 *   accounting.coa.view        — read the chart of accounts and cost centres
 *   accounting.coa.manage      — maintain the chart and the cost centres
 *   accounting.journal.view    — read the journal and the expense claims
 *   accounting.journal.create  — *draft* an entry, or file/submit an expense claim
 *   accounting.journal.post    — *post* one (a different person; the service refuses a
 *                                self-post even for someone holding both), decide and pay
 *                                expense claims
 *   accounting.journal.reverse — cancel a posted entry with a mirrored one
 *   accounting.period.close    — lay out fiscal years, close and reopen periods
 *   accounting.budgets.manage  — plan amounts per account and cost centre
 *   accounting.reports.view    — trial balance, ledgers, statements
 *
 * No preset role in `packages/permissions/src/roles.ts` holds both `accounting.journal.create`
 * and `accounting.journal.post` (the accountant drafts, the accounts manager posts), and
 * `AccountingService.postJournalEntry` refuses self-posting on the data as well, so the split
 * holds even if a school invents a role that carries both.
 *
 * Route order matters: Nest matches in declaration order, so literal segments (`accounts`,
 * `fiscal-years`, `journal`, `reports/...`) are declared before the `:id` routes that would
 * otherwise swallow them.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { normalizeOffsetPage } from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import {
  archiveAccountSchema,
  archiveBudgetSchema,
  archiveCostCentreSchema,
  balanceSheetQuerySchema,
  budgetVsActualQuerySchema,
  cashFlowQuerySchema,
  closeFiscalYearSchema,
  closePeriodSchema,
  createAccountSchema,
  createBudgetSchema,
  createCostCentreSchema,
  createExpenseClaimSchema,
  createFiscalYearSchema,
  createJournalEntrySchema,
  decideExpenseClaimSchema,
  generalLedgerQuerySchema,
  idParamSchema,
  incomeStatementQuerySchema,
  listAccountsSchema,
  listBudgetsSchema,
  listCostCentresSchema,
  listExpenseClaimsSchema,
  listFiscalYearsSchema,
  listJournalEntriesSchema,
  payExpenseClaimSchema,
  postJournalEntrySchema,
  reopenFiscalYearSchema,
  reopenPeriodSchema,
  reverseJournalEntrySchema,
  submitExpenseClaimSchema,
  trialBalanceQuerySchema,
  updateAccountSchema,
  updateBudgetSchema,
  updateCostCentreSchema,
  updateJournalEntrySchema,
} from '@shikkha/validation';
import { AccountingService } from './accounting.service';
import {
  Audited,
  CurrentUser,
  InstitutionScoped,
  RequirePermissions,
} from '../../common/decorators';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { currentContext } from '../../common/context/request-context';

@ApiTags('accounting')
@Controller('accounting')
@InstitutionScoped()
export class AccountingController {
  constructor(private readonly accounting: AccountingService) {}

  // ── Chart of accounts ───────────────────────────────────────────────────────────────

  @Get('accounts')
  @RequirePermissions('accounting.coa.view')
  @ApiOperation({ summary: 'List the chart of accounts' })
  async listAccounts(
    @Query(zodQuery(listAccountsSchema)) query: z.infer<typeof listAccountsSchema>,
  ) {
    return this.accounting.listAccounts(requireInstitution(), query, normalizeOffsetPage(query));
  }

  @Post('accounts')
  @RequirePermissions('accounting.coa.manage')
  @Audited({
    module: 'accounting',
    resourceType: 'chart_account',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create an account in the chart' })
  async createAccount(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createAccountSchema)) body: z.infer<typeof createAccountSchema>,
  ) {
    return this.accounting.createAccount(principal, requireInstitution(), body);
  }

  @Patch('accounts/:id')
  @RequirePermissions('accounting.coa.manage')
  @Audited({
    module: 'accounting',
    resourceType: 'chart_account',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update an account' })
  async updateAccount(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateAccountSchema)) body: z.infer<typeof updateAccountSchema>,
  ) {
    const result = await this.accounting.updateAccount(
      principal,
      requireInstitution(),
      params.id,
      body,
    );
    // `__audit` is read by the audit interceptor and stripped from the HTTP response, so the
    // trail records what actually changed rather than the whole submitted body.
    return { ...result.account, __audit: { previousValue: result.previous, newValue: body } };
  }

  @Post('accounts/:id/archive')
  @RequirePermissions('accounting.coa.manage')
  @Audited({
    module: 'accounting',
    resourceType: 'chart_account',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive an account' })
  async archiveAccount(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(archiveAccountSchema)) body: { reason: string },
  ) {
    return this.accounting.archiveAccount(principal, requireInstitution(), params.id, body.reason);
  }

  // ── Fiscal years and periods ────────────────────────────────────────────────────────

  @Get('fiscal-years')
  @RequirePermissions('accounting.journal.view', 'accounting.reports.view', { mode: 'any' })
  @ApiOperation({ summary: 'List fiscal years' })
  async listFiscalYears(
    @Query(zodQuery(listFiscalYearsSchema)) query: z.infer<typeof listFiscalYearsSchema>,
  ) {
    return this.accounting.listFiscalYears(requireInstitution(), query, normalizeOffsetPage(query));
  }

  /**
   * Creating a fiscal year also lays out its posting periods. Guarded by
   * `accounting.period.close` — the catalog has no dedicated fiscal-year permission, and the
   * person trusted to close periods is the person trusted to lay them out.
   */
  @Post('fiscal-years')
  @RequirePermissions('accounting.period.close')
  @Audited({
    module: 'accounting',
    resourceType: 'fiscal_year',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create a fiscal year and lay out its periods' })
  async createFiscalYear(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createFiscalYearSchema)) body: z.infer<typeof createFiscalYearSchema>,
  ) {
    return this.accounting.createFiscalYear(principal, requireInstitution(), body);
  }

  @Get('fiscal-years/:id')
  @RequirePermissions('accounting.journal.view', 'accounting.reports.view', { mode: 'any' })
  @ApiOperation({ summary: 'Fetch one fiscal year with its periods' })
  async getFiscalYear(@Param(zodParam(idParamSchema)) params: { id: string }) {
    return this.accounting.getFiscalYear(requireInstitution(), params.id);
  }

  @Post('fiscal-years/:id/close')
  @RequirePermissions('accounting.period.close')
  @Audited({
    module: 'accounting',
    resourceType: 'fiscal_year',
    action: 'update',
    resourceIdFrom: 'param:id',
    requiresReason: true,
    // The service writes the record inside the closing transaction, with the before-state.
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Close a fiscal year' })
  async closeFiscalYear(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(closeFiscalYearSchema)) body: { reason: string },
  ) {
    return this.accounting.closeFiscalYear(principal, requireInstitution(), params.id, body.reason);
  }

  @Post('fiscal-years/:id/reopen')
  @RequirePermissions('accounting.period.close')
  @Audited({
    module: 'accounting',
    resourceType: 'fiscal_year',
    action: 'restore',
    resourceIdFrom: 'param:id',
    requiresReason: true,
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Reopen a closed fiscal year' })
  async reopenFiscalYear(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(reopenFiscalYearSchema)) body: { reason: string },
  ) {
    return this.accounting.reopenFiscalYear(
      principal,
      requireInstitution(),
      params.id,
      body.reason,
    );
  }

  @Post('periods/:id/close')
  @RequirePermissions('accounting.period.close')
  @Audited({
    module: 'accounting',
    resourceType: 'accounting_period',
    action: 'update',
    resourceIdFrom: 'param:id',
    requiresReason: true,
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Close an accounting period' })
  async closePeriod(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(closePeriodSchema)) body: { reason: string },
  ) {
    return this.accounting.closePeriod(principal, requireInstitution(), params.id, body.reason);
  }

  @Post('periods/:id/reopen')
  @RequirePermissions('accounting.period.close')
  @Audited({
    module: 'accounting',
    resourceType: 'accounting_period',
    action: 'restore',
    resourceIdFrom: 'param:id',
    requiresReason: true,
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Reopen a closed accounting period' })
  async reopenPeriod(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(reopenPeriodSchema)) body: { reason: string },
  ) {
    return this.accounting.reopenPeriod(principal, requireInstitution(), params.id, body.reason);
  }

  // ── Journal ─────────────────────────────────────────────────────────────────────────

  @Get('journal')
  @RequirePermissions('accounting.journal.view')
  @ApiOperation({ summary: 'List journal entries' })
  async listJournalEntries(
    @Query(zodQuery(listJournalEntriesSchema)) query: z.infer<typeof listJournalEntriesSchema>,
  ) {
    return this.accounting.listJournalEntries(
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  /** Creates a **draft**. Posting is a separate, separately-permissioned act below. */
  @Post('journal')
  @RequirePermissions('accounting.journal.create')
  @Audited({
    module: 'accounting',
    resourceType: 'journal_entry',
    action: 'create',
  })
  @ApiOperation({ summary: 'Draft a manual journal entry' })
  async createJournalEntry(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createJournalEntrySchema)) body: z.infer<typeof createJournalEntrySchema>,
  ) {
    return this.accounting.createJournalEntry(principal, requireInstitution(), body);
  }

  @Get('journal/:id')
  @RequirePermissions('accounting.journal.view')
  @ApiOperation({ summary: 'Fetch one journal entry with its lines' })
  async getJournalEntry(@Param(zodParam(idParamSchema)) params: { id: string }) {
    return this.accounting.getJournalEntry(requireInstitution(), params.id);
  }

  /** Edits a draft; the lines are replaced as a complete set. Posted entries refuse this. */
  @Patch('journal/:id')
  @RequirePermissions('accounting.journal.create')
  @Audited({
    module: 'accounting',
    resourceType: 'journal_entry',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Edit a draft journal entry' })
  async updateJournalEntry(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateJournalEntrySchema)) body: z.infer<typeof updateJournalEntrySchema>,
  ) {
    return this.accounting.updateJournalEntry(principal, requireInstitution(), params.id, body);
  }

  /**
   * Posting: the moment an entry becomes immutable. A different permission from drafting,
   * and the service additionally refuses a poster who is also the drafter — separation of
   * duties holds even for someone holding both permissions.
   *
   * The service writes the substantive audit record (with the entry's totals) inside the
   * business transaction; the route-level `approve` record ties it to the HTTP request.
   */
  @Post('journal/:id/post')
  @RequirePermissions('accounting.journal.post')
  @Audited({
    module: 'accounting',
    resourceType: 'journal_entry',
    action: 'approve',
    resourceIdFrom: 'param:id',
    // The service records the posting (with the entry's totals) inside the transaction.
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Post a draft journal entry' })
  async postJournalEntry(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(postJournalEntrySchema)) body: z.infer<typeof postJournalEntrySchema>,
  ) {
    return this.accounting.postJournalEntry(
      principal,
      requireInstitution(),
      params.id,
      body.version,
    );
  }

  /** Correction is a mirrored reversing entry, never an edit and never a delete. */
  @Post('journal/:id/reverse')
  @RequirePermissions('accounting.journal.reverse')
  @Audited({
    module: 'accounting',
    resourceType: 'journal_entry',
    action: 'update',
    resourceIdFrom: 'param:id',
    requiresReason: true,
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Reverse a posted journal entry with a mirrored one' })
  async reverseJournalEntry(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(reverseJournalEntrySchema)) body: z.infer<typeof reverseJournalEntrySchema>,
  ) {
    return this.accounting.reverseJournalEntry(principal, requireInstitution(), params.id, body);
  }

  // ── Cost centres ────────────────────────────────────────────────────────────────────

  @Get('cost-centres')
  @RequirePermissions('accounting.coa.view')
  @ApiOperation({ summary: 'List cost centres' })
  async listCostCentres(
    @Query(zodQuery(listCostCentresSchema)) query: z.infer<typeof listCostCentresSchema>,
  ) {
    return this.accounting.listCostCentres(requireInstitution(), query, normalizeOffsetPage(query));
  }

  @Post('cost-centres')
  @RequirePermissions('accounting.coa.manage')
  @Audited({
    module: 'accounting',
    resourceType: 'cost_centre',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create a cost centre' })
  async createCostCentre(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createCostCentreSchema)) body: z.infer<typeof createCostCentreSchema>,
  ) {
    return this.accounting.createCostCentre(principal, requireInstitution(), body);
  }

  @Patch('cost-centres/:id')
  @RequirePermissions('accounting.coa.manage')
  @Audited({
    module: 'accounting',
    resourceType: 'cost_centre',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update a cost centre' })
  async updateCostCentre(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateCostCentreSchema)) body: z.infer<typeof updateCostCentreSchema>,
  ) {
    const result = await this.accounting.updateCostCentre(
      principal,
      requireInstitution(),
      params.id,
      body,
    );
    return { ...result.costCentre, __audit: { previousValue: result.previous, newValue: body } };
  }

  @Post('cost-centres/:id/archive')
  @RequirePermissions('accounting.coa.manage')
  @Audited({
    module: 'accounting',
    resourceType: 'cost_centre',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive a cost centre' })
  async archiveCostCentre(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(archiveCostCentreSchema)) body: { reason: string },
  ) {
    return this.accounting.archiveCostCentre(
      principal,
      requireInstitution(),
      params.id,
      body.reason,
    );
  }

  // ── Budgets ─────────────────────────────────────────────────────────────────────────

  @Get('budgets')
  @RequirePermissions('accounting.budgets.manage', 'accounting.reports.view', { mode: 'any' })
  @ApiOperation({ summary: 'List budgets' })
  async listBudgets(@Query(zodQuery(listBudgetsSchema)) query: z.infer<typeof listBudgetsSchema>) {
    return this.accounting.listBudgets(requireInstitution(), query, normalizeOffsetPage(query));
  }

  @Post('budgets')
  @RequirePermissions('accounting.budgets.manage')
  @Audited({
    module: 'accounting',
    resourceType: 'budget',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create a budget line' })
  async createBudget(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createBudgetSchema)) body: z.infer<typeof createBudgetSchema>,
  ) {
    return this.accounting.createBudget(principal, requireInstitution(), body);
  }

  @Patch('budgets/:id')
  @RequirePermissions('accounting.budgets.manage')
  @Audited({
    module: 'accounting',
    resourceType: 'budget',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update a budget line' })
  async updateBudget(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateBudgetSchema)) body: z.infer<typeof updateBudgetSchema>,
  ) {
    const result = await this.accounting.updateBudget(
      principal,
      requireInstitution(),
      params.id,
      body,
    );
    return { ...result.budget, __audit: { previousValue: result.previous, newValue: body } };
  }

  @Post('budgets/:id/archive')
  @RequirePermissions('accounting.budgets.manage')
  @Audited({
    module: 'accounting',
    resourceType: 'budget',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive a budget line' })
  async archiveBudget(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(archiveBudgetSchema)) body: { reason: string },
  ) {
    return this.accounting.archiveBudget(principal, requireInstitution(), params.id, body.reason);
  }

  // ── Expense claims ──────────────────────────────────────────────────────────────────
  //
  // The catalog has no expense-claim permissions, so the journal ones govern: filing and
  // submitting are `accounting.journal.create` (an accountant's work), deciding and paying
  // are `accounting.journal.post` (the approver's — paying posts a system journal entry).
  // The service refuses a self-decision on the data regardless of permissions held.

  @Get('expense-claims')
  @RequirePermissions('accounting.journal.view')
  @ApiOperation({ summary: 'List expense claims' })
  async listExpenseClaims(
    @Query(zodQuery(listExpenseClaimsSchema)) query: z.infer<typeof listExpenseClaimsSchema>,
  ) {
    return this.accounting.listExpenseClaims(
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Post('expense-claims')
  @RequirePermissions('accounting.journal.create')
  @Audited({
    module: 'accounting',
    resourceType: 'expense_claim',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'File an expense claim' })
  async createExpenseClaim(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createExpenseClaimSchema)) body: z.infer<typeof createExpenseClaimSchema>,
  ) {
    return this.accounting.createExpenseClaim(principal, requireInstitution(), body);
  }

  @Get('expense-claims/:id')
  @RequirePermissions('accounting.journal.view')
  @ApiOperation({ summary: 'Fetch one expense claim' })
  async getExpenseClaim(@Param(zodParam(idParamSchema)) params: { id: string }) {
    return this.accounting.getExpenseClaim(requireInstitution(), params.id);
  }

  @Post('expense-claims/:id/submit')
  @RequirePermissions('accounting.journal.create')
  @Audited({
    module: 'accounting',
    resourceType: 'expense_claim',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Submit a draft expense claim for decision' })
  async submitExpenseClaim(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(submitExpenseClaimSchema)) body: z.infer<typeof submitExpenseClaimSchema>,
  ) {
    return this.accounting.submitExpenseClaim(
      principal,
      requireInstitution(),
      params.id,
      body.version,
    );
  }

  /**
   * Approve or reject — a different permission from filing, and the service refuses a
   * decider who is also the filer. The route-level audit action is recorded as `approve`
   * for both outcomes; the record the service writes inside the transaction carries the
   * actual decision.
   */
  @Post('expense-claims/:id/decision')
  @RequirePermissions('accounting.journal.post')
  @Audited({
    module: 'accounting',
    resourceType: 'expense_claim',
    action: 'approve',
    resourceIdFrom: 'param:id',
    requiresReason: true,
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Approve or reject a submitted expense claim' })
  async decideExpenseClaim(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(decideExpenseClaimSchema)) body: z.infer<typeof decideExpenseClaimSchema>,
  ) {
    return this.accounting.decideExpenseClaim(
      principal,
      requireInstitution(),
      params.id,
      body.decision,
      body.reason,
    );
  }

  /**
   * Paying an approved claim posts the ledger entry (debit expense, credit cash) in the
   * same transaction and links it, so the claim and its ledger effect commit together or
   * not at all.
   */
  @Post('expense-claims/:id/pay')
  @RequirePermissions('accounting.journal.post')
  @Audited({
    module: 'accounting',
    resourceType: 'expense_claim',
    action: 'payment',
    resourceIdFrom: 'param:id',
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Pay an approved expense claim through the ledger' })
  async payExpenseClaim(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(payExpenseClaimSchema)) body: z.infer<typeof payExpenseClaimSchema>,
  ) {
    return this.accounting.payExpenseClaim(principal, requireInstitution(), params.id, body);
  }

  // ── Reports ─────────────────────────────────────────────────────────────────────────

  @Get('reports/trial-balance')
  @RequirePermissions('accounting.reports.view')
  @ApiOperation({ summary: 'Trial balance as of a date' })
  async trialBalance(
    @Query(zodQuery(trialBalanceQuerySchema)) query: z.infer<typeof trialBalanceQuerySchema>,
  ) {
    return this.accounting.trialBalance(requireInstitution(), query.asOf);
  }

  @Get('reports/general-ledger')
  @RequirePermissions('accounting.reports.view')
  @ApiOperation({ summary: 'One account’s ledger with a running balance' })
  async generalLedger(
    @Query(zodQuery(generalLedgerQuerySchema)) query: z.infer<typeof generalLedgerQuerySchema>,
  ) {
    return this.accounting.generalLedger(requireInstitution(), query);
  }

  @Get('reports/income-statement')
  @RequirePermissions('accounting.reports.view')
  @ApiOperation({ summary: 'Income statement over a date range' })
  async incomeStatement(
    @Query(zodQuery(incomeStatementQuerySchema))
    query: z.infer<typeof incomeStatementQuerySchema>,
  ) {
    return this.accounting.incomeStatement(requireInstitution(), query);
  }

  @Get('reports/balance-sheet')
  @RequirePermissions('accounting.reports.view')
  @ApiOperation({ summary: 'Balance sheet as of a date' })
  async balanceSheet(
    @Query(zodQuery(balanceSheetQuerySchema)) query: z.infer<typeof balanceSheetQuerySchema>,
  ) {
    return this.accounting.balanceSheet(requireInstitution(), query.asOf);
  }

  @Get('reports/cash-flow')
  @RequirePermissions('accounting.reports.view')
  @ApiOperation({ summary: 'Cash movement over a date range' })
  async cashFlow(@Query(zodQuery(cashFlowQuerySchema)) query: z.infer<typeof cashFlowQuerySchema>) {
    return this.accounting.cashFlow(requireInstitution(), query);
  }

  @Get('reports/budget-vs-actual')
  @RequirePermissions('accounting.reports.view')
  @ApiOperation({ summary: 'Budgeted against actual spend for a fiscal year' })
  async budgetVsActual(
    @Query(zodQuery(budgetVsActualQuerySchema)) query: z.infer<typeof budgetVsActualQuerySchema>,
  ) {
    return this.accounting.budgetVsActual(requireInstitution(), query);
  }
}

/**
 * `@InstitutionScoped()` makes the tenant guard require and validate the header; this is the
 * belt-and-braces read, because `currentContext()` returns `string | null` and a service that
 * received `null` would silently query across institutions.
 */
function requireInstitution(): string {
  const institutionId = currentContext()?.institutionId;
  if (!institutionId) {
    throw new BadRequestException(
      'Send the x-institution-id header to indicate which institution these books belong to.',
    );
  }
  return institutionId;
}
