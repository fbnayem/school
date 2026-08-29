/**
 * Fee management endpoints (Phase 11).
 *
 * Every route is `@InstitutionScoped()`: money belongs to an institution, and a group
 * administrator running three schools has no safe default. The header is required by the
 * tenant guard rather than guessed here.
 *
 * The permission split is the point of this file, and it is separation of duties written down:
 *
 *   finance.fees.manage       — maintain the fee heads
 *   finance.plans.manage      — publish price lists and assign them to students
 *   finance.discounts.manage  — *request* a concession
 *   finance.discounts.approve — *grant* one (a different person; the service refuses a
 *                               self-approval even for someone holding both)
 *   finance.invoices.generate — bill
 *   finance.invoices.void     — cancel a bill that nobody has paid against
 *   finance.collect_payment   — take money
 *   finance.refund            — reverse a receipt
 *   finance.reports.view      — see the aggregates
 *   finance.own.view          — a parent, seeing only their own children
 *
 * Reading is separated from writing throughout: an accountant who can raise a discount cannot
 * approve it, and the person who approves cannot quietly edit the price list underneath it.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { normalizeOffsetPage } from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import {
  applyLateFinesSchema,
  archiveFeeHeadSchema,
  archiveFeeStructureSchema,
  assignFeeStructureSchema,
  collectionSummaryQuerySchema,
  createFeeConcessionSchema,
  createFeeHeadSchema,
  createFeeStructureSchema,
  decideFeeConcessionSchema,
  generateInvoicesSchema,
  idParamSchema,
  listFeeConcessionsSchema,
  listFeeHeadsSchema,
  listFeeStructuresSchema,
  listInvoicesSchema,
  listPaymentsSchema,
  outstandingDuesQuerySchema,
  recordPaymentSchema,
  replaceFeeStructureItemsSchema,
  reversePaymentSchema,
  studentLedgerQuerySchema,
  updateFeeHeadSchema,
  updateFeeStructureSchema,
  voidInvoiceSchema,
} from '@shikkha/validation';
import { FeesService } from './fees.service';
import {
  Audited,
  CurrentUser,
  InstitutionScoped,
  RequirePermissions,
} from '../../common/decorators';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { currentContext } from '../../common/context/request-context';

@ApiTags('fees')
@Controller('fees')
@InstitutionScoped()
export class FeesController {
  constructor(private readonly fees: FeesService) {}

  // ── Fee heads ───────────────────────────────────────────────────────────────────────

  @Get('heads')
  @RequirePermissions('finance.fees.view')
  @ApiOperation({ summary: 'List fee heads' })
  async listHeads(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listFeeHeadsSchema)) query: z.infer<typeof listFeeHeadsSchema>,
  ) {
    return this.fees.listFeeHeads(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Post('heads')
  @RequirePermissions('finance.fees.manage')
  @Audited({
    module: 'fees',
    resourceType: 'fee_head',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create a fee head' })
  async createHead(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createFeeHeadSchema)) body: z.infer<typeof createFeeHeadSchema>,
  ) {
    return this.fees.createFeeHead(principal, requireInstitution(), body);
  }

  @Patch('heads/:id')
  @RequirePermissions('finance.fees.manage')
  @Audited({
    module: 'fees',
    resourceType: 'fee_head',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update a fee head' })
  async updateHead(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateFeeHeadSchema)) body: z.infer<typeof updateFeeHeadSchema>,
  ) {
    const result = await this.fees.updateFeeHead(principal, requireInstitution(), params.id, body);
    // `__audit` is read by the audit interceptor and stripped from the HTTP response, so the
    // trail records what actually changed rather than the whole submitted body.
    return { ...result.feeHead, __audit: { previousValue: result.previous, newValue: body } };
  }

  @Post('heads/:id/archive')
  @RequirePermissions('finance.fees.manage')
  @Audited({
    module: 'fees',
    resourceType: 'fee_head',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive a fee head' })
  async archiveHead(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(archiveFeeHeadSchema)) body: { reason: string },
  ) {
    return this.fees.archiveFeeHead(principal, requireInstitution(), params.id, body.reason);
  }

  // ── Fee structures ──────────────────────────────────────────────────────────────────

  @Get('structures')
  @RequirePermissions('finance.fees.view')
  @ApiOperation({ summary: 'List fee structures' })
  async listStructures(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listFeeStructuresSchema)) query: z.infer<typeof listFeeStructuresSchema>,
  ) {
    return this.fees.listFeeStructures(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Post('structures')
  @RequirePermissions('finance.plans.manage')
  @Audited({
    module: 'fees',
    resourceType: 'fee_structure',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create a fee structure' })
  async createStructure(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createFeeStructureSchema)) body: z.infer<typeof createFeeStructureSchema>,
  ) {
    return this.fees.createFeeStructure(principal, requireInstitution(), body);
  }

  /**
   * Declared before the `:id` routes below, so `assign` is never parsed as an id. Nest matches
   * in declaration order, and getting this backwards produces a confusing "invalid identifier"
   * error on a route that has no id at all.
   */
  @Post('structures/assign')
  @RequirePermissions('finance.plans.manage')
  @Audited({ module: 'fees', resourceType: 'student_fee_assignment', action: 'create' })
  @ApiOperation({ summary: 'Assign a fee structure to many students' })
  async assignStructure(
    @CurrentUser() principal: Principal,
    @Body(zodBody(assignFeeStructureSchema)) body: z.infer<typeof assignFeeStructureSchema>,
  ) {
    return this.fees.assignFeeStructure(principal, requireInstitution(), body);
  }

  @Get('structures/:id')
  @RequirePermissions('finance.fees.view')
  @ApiOperation({ summary: 'Fetch one fee structure with its items' })
  async getStructure(@Param(zodParam(idParamSchema)) params: { id: string }) {
    return this.fees.getFeeStructure(requireInstitution(), params.id);
  }

  @Patch('structures/:id')
  @RequirePermissions('finance.plans.manage')
  @Audited({
    module: 'fees',
    resourceType: 'fee_structure',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update a fee structure' })
  async updateStructure(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateFeeStructureSchema)) body: z.infer<typeof updateFeeStructureSchema>,
  ) {
    const result = await this.fees.updateFeeStructure(
      principal,
      requireInstitution(),
      params.id,
      body,
    );
    return { ...result.structure, __audit: { previousValue: result.previous, newValue: body } };
  }

  /** Items are replaced as a complete set — a PUT, because that is what a PUT means. */
  @Put('structures/:id/items')
  @RequirePermissions('finance.plans.manage')
  @Audited({
    module: 'fees',
    resourceType: 'fee_structure_items',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Replace a fee structure’s items' })
  async replaceStructureItems(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(replaceFeeStructureItemsSchema))
    body: z.infer<typeof replaceFeeStructureItemsSchema>,
  ) {
    return this.fees.replaceFeeStructureItems(
      principal,
      requireInstitution(),
      params.id,
      body.items,
    );
  }

  @Post('structures/:id/archive')
  @RequirePermissions('finance.plans.manage')
  @Audited({
    module: 'fees',
    resourceType: 'fee_structure',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive a fee structure' })
  async archiveStructure(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(archiveFeeStructureSchema)) body: { reason: string },
  ) {
    return this.fees.archiveFeeStructure(principal, requireInstitution(), params.id, body.reason);
  }

  // ── Concessions ─────────────────────────────────────────────────────────────────────

  @Get('concessions')
  @RequirePermissions(
    'finance.fees.view',
    'finance.discounts.manage',
    'finance.discounts.approve',
    'finance.own.view',
    { mode: 'any' },
  )
  @ApiOperation({ summary: 'List fee concessions within the caller’s data scope' })
  async listConcessions(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listFeeConcessionsSchema)) query: z.infer<typeof listFeeConcessionsSchema>,
  ) {
    return this.fees.listConcessions(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  /** Requesting a concession. It is created `pending` and changes no invoice until approved. */
  @Post('concessions')
  @RequirePermissions('finance.discounts.manage')
  @Audited({
    module: 'fees',
    resourceType: 'fee_concession',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Request a fee concession' })
  async createConcession(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createFeeConcessionSchema)) body: z.infer<typeof createFeeConcessionSchema>,
  ) {
    return this.fees.createConcession(principal, requireInstitution(), body);
  }

  /**
   * Granting or refusing one — a **different** permission from requesting it, and the service
   * additionally refuses an approver who is also the requester.
   *
   * The route-level audit action is recorded as `approve` for both outcomes; the record the
   * service writes inside the transaction carries the actual decision.
   */
  @Post('concessions/:id/decision')
  @RequirePermissions('finance.discounts.approve')
  @Audited({
    module: 'fees',
    resourceType: 'fee_concession',
    action: 'approve',
    resourceIdFrom: 'param:id',
    requiresReason: true,
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Approve or reject a fee concession' })
  async decideConcession(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(decideFeeConcessionSchema)) body: z.infer<typeof decideFeeConcessionSchema>,
  ) {
    return this.fees.decideConcession(
      principal,
      requireInstitution(),
      params.id,
      body.decision,
      body.reason,
    );
  }

  // ── Invoice generation ──────────────────────────────────────────────────────────────

  /**
   * A dry run. Computes exactly what `generate` would write, writes nothing, and reports which
   * students would be skipped and why.
   *
   * Audited as an `export`: it produces the figures somebody then acts on, and knowing who ran
   * a billing preview before a disputed invoice appeared is worth the row.
   */
  @Post('invoices/preview')
  @RequirePermissions('finance.invoices.generate')
  @Audited({ module: 'fees', resourceType: 'invoice_generation', action: 'export' })
  @ApiOperation({ summary: 'Preview an invoice generation run without writing anything' })
  async previewInvoices(
    @CurrentUser() principal: Principal,
    @Body(zodBody(generateInvoicesSchema)) body: z.infer<typeof generateInvoicesSchema>,
  ) {
    return this.fees.generateInvoices(principal, requireInstitution(), body, { commit: false });
  }

  @Post('invoices/generate')
  @RequirePermissions('finance.invoices.generate')
  @Audited({ module: 'fees', resourceType: 'invoice_generation', action: 'create' })
  @ApiOperation({ summary: 'Generate invoices for a section, class or list of students' })
  async generateInvoices(
    @CurrentUser() principal: Principal,
    @Body(zodBody(generateInvoicesSchema)) body: z.infer<typeof generateInvoicesSchema>,
  ) {
    return this.fees.generateInvoices(principal, requireInstitution(), body, { commit: true });
  }

  /**
   * Charging late fines. Declared before `invoices/:id` and deliberately explicit: a fine is
   * money a family owes because somebody decided they owe it, so it is never computed on read.
   */
  @Post('invoices/late-fines')
  @RequirePermissions('finance.fees.manage', 'finance.invoices.generate')
  @Audited({
    module: 'fees',
    resourceType: 'late_fine_run',
    action: 'update',
    requiresReason: true,
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Apply late fines to overdue invoices' })
  async applyLateFines(
    @CurrentUser() principal: Principal,
    @Body(zodBody(applyLateFinesSchema)) body: z.infer<typeof applyLateFinesSchema>,
  ) {
    return this.fees.applyLateFines(principal, requireInstitution(), body);
  }

  // ── Invoices ────────────────────────────────────────────────────────────────────────

  @Get('invoices')
  @RequirePermissions('finance.invoices.view', 'finance.own.view', { mode: 'any' })
  @ApiOperation({ summary: 'List invoices within the caller’s data scope' })
  async listInvoices(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listInvoicesSchema)) query: z.infer<typeof listInvoicesSchema>,
  ) {
    return this.fees.listInvoices(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Get('invoices/:id')
  @RequirePermissions('finance.invoices.view', 'finance.own.view', { mode: 'any' })
  @ApiOperation({ summary: 'Fetch one invoice with its lines and payments' })
  async getInvoice(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.fees.getInvoice(principal, requireInstitution(), params.id);
  }

  /**
   * Voiding. Refused once any payment has been allocated — a bill that has been paid against
   * is corrected with a credit, so both the original and the correction stay visible.
   */
  @Post('invoices/:id/void')
  @RequirePermissions('finance.invoices.void')
  @Audited({
    module: 'fees',
    resourceType: 'invoice',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Void an invoice' })
  async voidInvoice(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(voidInvoiceSchema)) body: { reason: string },
  ) {
    return this.fees.voidInvoice(principal, requireInstitution(), params.id, body.reason);
  }

  // ── Payments ────────────────────────────────────────────────────────────────────────

  @Get('payments')
  @RequirePermissions('finance.invoices.view', 'finance.own.view', { mode: 'any' })
  @ApiOperation({ summary: 'List payments within the caller’s data scope' })
  async listPayments(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listPaymentsSchema)) query: z.infer<typeof listPaymentsSchema>,
  ) {
    return this.fees.listPayments(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Post('payments')
  @RequirePermissions('finance.collect_payment')
  @Audited({
    module: 'fees',
    resourceType: 'payment',
    action: 'payment',
    resourceIdFrom: 'response:id',
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Record a payment and allocate it to invoices' })
  async recordPayment(
    @CurrentUser() principal: Principal,
    @Body(zodBody(recordPaymentSchema)) body: z.infer<typeof recordPaymentSchema>,
  ) {
    return this.fees.recordPayment(principal, requireInstitution(), body);
  }

  /**
   * Reversal, never deletion. The receipt keeps its number; the allocations are archived and
   * every invoice it touched is recomputed in the same transaction.
   */
  @Post('payments/:id/reverse')
  @RequirePermissions('finance.refund')
  @Audited({
    module: 'fees',
    resourceType: 'payment',
    action: 'refund',
    resourceIdFrom: 'param:id',
    requiresReason: true,
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Reverse a payment' })
  async reversePayment(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(reversePaymentSchema)) body: z.infer<typeof reversePaymentSchema>,
  ) {
    return this.fees.reversePayment(
      principal,
      requireInstitution(),
      params.id,
      body.reason,
      body.version,
    );
  }

  // ── Reports ─────────────────────────────────────────────────────────────────────────

  /**
   * A student's full financial history with a running balance.
   *
   * A guardian holding only `finance.own.view` reaches this for their own children and gets a
   * 404 for anyone else's — the scope filter is applied inside the service, not here.
   */
  @Get('students/:id/ledger')
  @RequirePermissions('finance.ledger.view', 'finance.invoices.view', 'finance.own.view', {
    mode: 'any',
  })
  @ApiOperation({ summary: 'A student’s ledger of invoices and payments' })
  async studentLedger(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Query(zodQuery(studentLedgerQuerySchema)) query: z.infer<typeof studentLedgerQuerySchema>,
  ) {
    return this.fees.studentLedger(principal, requireInstitution(), params.id, query);
  }

  @Get('reports/outstanding')
  @RequirePermissions('finance.reports.view')
  @ApiOperation({ summary: 'Outstanding dues by class or section' })
  async outstandingDues(
    @Query(zodQuery(outstandingDuesQuerySchema))
    query: z.infer<typeof outstandingDuesQuerySchema>,
  ) {
    return this.fees.outstandingDues(requireInstitution(), query);
  }

  @Get('reports/collections')
  @RequirePermissions('finance.reports.view')
  @ApiOperation({ summary: 'Collections by date range and payment method' })
  async collectionSummary(
    @Query(zodQuery(collectionSummaryQuerySchema))
    query: z.infer<typeof collectionSummaryQuerySchema>,
  ) {
    return this.fees.collectionSummary(requireInstitution(), query);
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
      'Send the x-institution-id header to indicate which institution these fees belong to.',
    );
  }
  return institutionId;
}
