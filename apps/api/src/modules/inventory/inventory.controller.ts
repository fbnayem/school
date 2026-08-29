/**
 * Inventory and procurement endpoints (Phase 19).
 *
 * Every route is `@InstitutionScoped()`: stock belongs to an institution, and a group
 * administrator running three schools has no safe default. The header is required by the
 * tenant guard rather than guessed here.
 *
 * The permission split is separation of duties written down:
 *
 *   inventory.view             — see the catalogue, stock, procurement and reports
 *   inventory.manage           — maintain the catalogue; issue, adjust, transfer, write off
 *   inventory.receive          — take goods in (direct receipts and goods receipts)
 *   inventory.purchase.request — raise and submit a purchase requisition
 *   inventory.purchase.approve — decide requisitions and place purchase orders (a different
 *                                person; the service refuses a self-approval even for
 *                                someone holding both)
 *
 * Every mutating route is `@Audited`. The financially significant ones (goods receipt,
 * requisition decisions) are recorded by the service inside the business transaction and
 * carry `recordedBy: 'service'`; the rest are recorded by the interceptor.
 *
 * Route ordering matters: literal segments (`stock/levels`, `reports/low-stock`) are
 * declared before the `:id` routes that would otherwise swallow them.
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
  adjustStockSchema,
  approvePurchaseRequisitionSchema,
  archiveInventoryRecordSchema,
  cancelPurchaseOrderSchema,
  createGoodsReceiptSchema,
  createInventoryItemSchema,
  createItemCategorySchema,
  createPurchaseOrderSchema,
  createPurchaseRequisitionSchema,
  createStoreSchema,
  createSupplierSchema,
  idParamSchema,
  issuePurchaseOrderSchema,
  issueStockSchema,
  listInventoryItemsSchema,
  listItemCategoriesSchema,
  listPurchaseOrdersSchema,
  listPurchaseRequisitionsSchema,
  listStockLevelsSchema,
  listStockMovementsSchema,
  listStoresSchema,
  listSuppliersSchema,
  lowStockReportSchema,
  receiveStockSchema,
  rejectPurchaseRequisitionSchema,
  stockValuationReportSchema,
  submitPurchaseRequisitionSchema,
  transferStockSchema,
  updateInventoryItemSchema,
  updateItemCategorySchema,
  updateStoreSchema,
  updateSupplierSchema,
  writeOffStockSchema,
} from '@shikkha/validation';
import { InventoryService } from './inventory.service';
import {
  Audited,
  CurrentUser,
  InstitutionScoped,
  RequirePermissions,
} from '../../common/decorators';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { currentContext } from '../../common/context/request-context';

@ApiTags('inventory')
@Controller('inventory')
@InstitutionScoped()
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  // ── Item categories ─────────────────────────────────────────────────────────────────

  @Get('categories')
  @RequirePermissions('inventory.view')
  @ApiOperation({ summary: 'List item categories' })
  async listCategories(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listItemCategoriesSchema)) query: z.infer<typeof listItemCategoriesSchema>,
  ) {
    return this.inventory.listCategories(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Post('categories')
  @RequirePermissions('inventory.manage')
  @Audited({
    module: 'inventory',
    resourceType: 'item_category',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create an item category' })
  async createCategory(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createItemCategorySchema)) body: z.infer<typeof createItemCategorySchema>,
  ) {
    return this.inventory.createCategory(principal, requireInstitution(), body);
  }

  @Patch('categories/:id')
  @RequirePermissions('inventory.manage')
  @Audited({
    module: 'inventory',
    resourceType: 'item_category',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update an item category' })
  async updateCategory(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateItemCategorySchema)) body: z.infer<typeof updateItemCategorySchema>,
  ) {
    const result = await this.inventory.updateCategory(
      principal,
      requireInstitution(),
      params.id,
      body,
    );
    // `__audit` is read by the audit interceptor and stripped from the HTTP response, so the
    // trail records what actually changed rather than the whole submitted body.
    return { ...result.category, __audit: { previousValue: result.previous, newValue: body } };
  }

  @Post('categories/:id/archive')
  @RequirePermissions('inventory.manage')
  @Audited({
    module: 'inventory',
    resourceType: 'item_category',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive an item category' })
  async archiveCategory(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(archiveInventoryRecordSchema)) body: { reason: string },
  ) {
    return this.inventory.archiveCategory(principal, requireInstitution(), params.id, body.reason);
  }

  // ── Items ───────────────────────────────────────────────────────────────────────────

  @Get('items')
  @RequirePermissions('inventory.view')
  @ApiOperation({ summary: 'List items' })
  async listItems(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listInventoryItemsSchema)) query: z.infer<typeof listInventoryItemsSchema>,
  ) {
    return this.inventory.listItems(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Post('items')
  @RequirePermissions('inventory.manage')
  @Audited({
    module: 'inventory',
    resourceType: 'item',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create an item' })
  async createItem(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createInventoryItemSchema)) body: z.infer<typeof createInventoryItemSchema>,
  ) {
    return this.inventory.createItem(principal, requireInstitution(), body);
  }

  @Get('items/:id')
  @RequirePermissions('inventory.view')
  @ApiOperation({ summary: 'Fetch one item' })
  async getItem(@Param(zodParam(idParamSchema)) params: { id: string }) {
    return this.inventory.getItem(requireInstitution(), params.id);
  }

  @Patch('items/:id')
  @RequirePermissions('inventory.manage')
  @Audited({
    module: 'inventory',
    resourceType: 'item',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update an item' })
  async updateItem(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateInventoryItemSchema)) body: z.infer<typeof updateInventoryItemSchema>,
  ) {
    const result = await this.inventory.updateItem(principal, requireInstitution(), params.id, body);
    return { ...result.item, __audit: { previousValue: result.previous, newValue: body } };
  }

  @Post('items/:id/archive')
  @RequirePermissions('inventory.manage')
  @Audited({
    module: 'inventory',
    resourceType: 'item',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive an item' })
  async archiveItem(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(archiveInventoryRecordSchema)) body: { reason: string },
  ) {
    return this.inventory.archiveItem(principal, requireInstitution(), params.id, body.reason);
  }

  // ── Stores ──────────────────────────────────────────────────────────────────────────

  @Get('stores')
  @RequirePermissions('inventory.view')
  @ApiOperation({ summary: 'List stores' })
  async listStores(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listStoresSchema)) query: z.infer<typeof listStoresSchema>,
  ) {
    return this.inventory.listStores(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Post('stores')
  @RequirePermissions('inventory.manage')
  @Audited({
    module: 'inventory',
    resourceType: 'store',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create a store' })
  async createStore(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createStoreSchema)) body: z.infer<typeof createStoreSchema>,
  ) {
    return this.inventory.createStore(principal, requireInstitution(), body);
  }

  @Patch('stores/:id')
  @RequirePermissions('inventory.manage')
  @Audited({
    module: 'inventory',
    resourceType: 'store',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update a store' })
  async updateStore(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateStoreSchema)) body: z.infer<typeof updateStoreSchema>,
  ) {
    const result = await this.inventory.updateStore(
      principal,
      requireInstitution(),
      params.id,
      body,
    );
    return { ...result.store, __audit: { previousValue: result.previous, newValue: body } };
  }

  @Post('stores/:id/archive')
  @RequirePermissions('inventory.manage')
  @Audited({
    module: 'inventory',
    resourceType: 'store',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive a store' })
  async archiveStore(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(archiveInventoryRecordSchema)) body: { reason: string },
  ) {
    return this.inventory.archiveStore(principal, requireInstitution(), params.id, body.reason);
  }

  // ── Suppliers ───────────────────────────────────────────────────────────────────────

  @Get('suppliers')
  @RequirePermissions('inventory.view')
  @ApiOperation({ summary: 'List suppliers' })
  async listSuppliers(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listSuppliersSchema)) query: z.infer<typeof listSuppliersSchema>,
  ) {
    return this.inventory.listSuppliers(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Post('suppliers')
  @RequirePermissions('inventory.manage')
  @Audited({
    module: 'inventory',
    resourceType: 'supplier',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create a supplier' })
  async createSupplier(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createSupplierSchema)) body: z.infer<typeof createSupplierSchema>,
  ) {
    return this.inventory.createSupplier(principal, requireInstitution(), body);
  }

  @Patch('suppliers/:id')
  @RequirePermissions('inventory.manage')
  @Audited({
    module: 'inventory',
    resourceType: 'supplier',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update a supplier' })
  async updateSupplier(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateSupplierSchema)) body: z.infer<typeof updateSupplierSchema>,
  ) {
    const result = await this.inventory.updateSupplier(
      principal,
      requireInstitution(),
      params.id,
      body,
    );
    return { ...result.supplier, __audit: { previousValue: result.previous, newValue: body } };
  }

  @Post('suppliers/:id/archive')
  @RequirePermissions('inventory.manage')
  @Audited({
    module: 'inventory',
    resourceType: 'supplier',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive a supplier' })
  async archiveSupplier(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(archiveInventoryRecordSchema)) body: { reason: string },
  ) {
    return this.inventory.archiveSupplier(principal, requireInstitution(), params.id, body.reason);
  }

  // ── Stock levels, movement history, reconciliation ──────────────────────────────────

  @Get('stock/levels')
  @RequirePermissions('inventory.view')
  @ApiOperation({ summary: 'List stock levels (derived from the movement log)' })
  async listStockLevels(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listStockLevelsSchema)) query: z.infer<typeof listStockLevelsSchema>,
  ) {
    return this.inventory.listStockLevels(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Get('stock/movements')
  @RequirePermissions('inventory.view')
  @ApiOperation({ summary: 'List stock movements (append-only history)' })
  async listStockMovements(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listStockMovementsSchema)) query: z.infer<typeof listStockMovementsSchema>,
  ) {
    return this.inventory.listStockMovements(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Get('stock/reconciliation')
  @RequirePermissions('inventory.view')
  @ApiOperation({
    summary: 'Recompute every stock level from the movement log and report any drift',
  })
  async stockReconciliation() {
    return this.inventory.stockReconciliation(requireInstitution());
  }

  // ── Stock operations — each is one audited, append-only movement ────────────────────

  @Post('stock/receive')
  @RequirePermissions('inventory.receive')
  @Audited({
    module: 'inventory',
    resourceType: 'stock_movement',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Receive stock directly (donation, opening balance)' })
  async receiveStock(
    @CurrentUser() principal: Principal,
    @Body(zodBody(receiveStockSchema)) body: z.infer<typeof receiveStockSchema>,
  ) {
    return this.inventory.receiveStock(principal, requireInstitution(), body);
  }

  @Post('stock/issue')
  @RequirePermissions('inventory.manage')
  @Audited({
    module: 'inventory',
    resourceType: 'stock_movement',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Issue stock out of a store' })
  async issueStock(
    @CurrentUser() principal: Principal,
    @Body(zodBody(issueStockSchema)) body: z.infer<typeof issueStockSchema>,
  ) {
    return this.inventory.issueStock(principal, requireInstitution(), body);
  }

  @Post('stock/adjust')
  @RequirePermissions('inventory.manage')
  @Audited({
    module: 'inventory',
    resourceType: 'stock_movement',
    action: 'create',
    resourceIdFrom: 'response:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Adjust stock after a physical count (signed, with reason)' })
  async adjustStock(
    @CurrentUser() principal: Principal,
    @Body(zodBody(adjustStockSchema)) body: z.infer<typeof adjustStockSchema>,
  ) {
    return this.inventory.adjustStock(principal, requireInstitution(), body);
  }

  @Post('stock/transfer')
  @RequirePermissions('inventory.manage')
  @Audited({
    module: 'inventory',
    resourceType: 'stock_transfer',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Transfer stock between two stores' })
  async transferStock(
    @CurrentUser() principal: Principal,
    @Body(zodBody(transferStockSchema)) body: z.infer<typeof transferStockSchema>,
  ) {
    const result = await this.inventory.transferStock(principal, requireInstitution(), body);
    // The out-movement's id identifies the transfer in the audit trail; the two movements
    // also share a reference_id in the table itself.
    return { id: result.out.id, out: result.out, in: result.in };
  }

  @Post('stock/write-off')
  @RequirePermissions('inventory.manage')
  @Audited({
    module: 'inventory',
    resourceType: 'stock_movement',
    action: 'create',
    resourceIdFrom: 'response:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Write off damaged or lost stock (with reason)' })
  async writeOffStock(
    @CurrentUser() principal: Principal,
    @Body(zodBody(writeOffStockSchema)) body: z.infer<typeof writeOffStockSchema>,
  ) {
    return this.inventory.writeOffStock(principal, requireInstitution(), body);
  }

  // ── Reports ─────────────────────────────────────────────────────────────────────────

  @Get('reports/low-stock')
  @RequirePermissions('inventory.view')
  @ApiOperation({ summary: 'Items at or below their reorder level' })
  async lowStockReport(
    @Query(zodQuery(lowStockReportSchema)) query: z.infer<typeof lowStockReportSchema>,
  ) {
    return this.inventory.lowStockReport(requireInstitution(), query.storeId);
  }

  @Get('reports/valuation')
  @RequirePermissions('inventory.view')
  @ApiOperation({ summary: 'Stock valuation at weighted average cost' })
  async valuationReport(
    @Query(zodQuery(stockValuationReportSchema)) query: z.infer<typeof stockValuationReportSchema>,
  ) {
    return this.inventory.valuationReport(requireInstitution(), query.categoryId);
  }

  // ── Purchase requisitions ───────────────────────────────────────────────────────────

  @Get('requisitions')
  @RequirePermissions('inventory.view')
  @ApiOperation({ summary: 'List purchase requisitions' })
  async listRequisitions(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listPurchaseRequisitionsSchema))
    query: z.infer<typeof listPurchaseRequisitionsSchema>,
  ) {
    return this.inventory.listRequisitions(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Post('requisitions')
  @RequirePermissions('inventory.purchase.request')
  @Audited({
    module: 'inventory',
    resourceType: 'purchase_requisition',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Raise a purchase requisition' })
  async createRequisition(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createPurchaseRequisitionSchema))
    body: z.infer<typeof createPurchaseRequisitionSchema>,
  ) {
    const result = await this.inventory.createRequisition(principal, requireInstitution(), body);
    return { ...result.requisition, items: result.items };
  }

  @Get('requisitions/:id')
  @RequirePermissions('inventory.view')
  @ApiOperation({ summary: 'Fetch one requisition with its items' })
  async getRequisition(@Param(zodParam(idParamSchema)) params: { id: string }) {
    return this.inventory.getRequisition(requireInstitution(), params.id);
  }

  @Post('requisitions/:id/submit')
  @RequirePermissions('inventory.purchase.request')
  @Audited({
    module: 'inventory',
    resourceType: 'purchase_requisition',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Submit a draft requisition for approval' })
  async submitRequisition(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(submitPurchaseRequisitionSchema))
    body: z.infer<typeof submitPurchaseRequisitionSchema>,
  ) {
    return this.inventory.submitRequisition(
      principal,
      requireInstitution(),
      params.id,
      body.version,
    );
  }

  @Post('requisitions/:id/approve')
  @RequirePermissions('inventory.purchase.approve')
  @Audited({
    module: 'inventory',
    resourceType: 'purchase_requisition',
    action: 'approve',
    resourceIdFrom: 'param:id',
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Approve a requisition (never one\'s own — four eyes)' })
  async approveRequisition(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(approvePurchaseRequisitionSchema))
    body: z.infer<typeof approvePurchaseRequisitionSchema>,
  ) {
    return this.inventory.approveRequisition(
      principal,
      requireInstitution(),
      params.id,
      body.note,
      body.version,
    );
  }

  @Post('requisitions/:id/reject')
  @RequirePermissions('inventory.purchase.approve')
  @Audited({
    module: 'inventory',
    resourceType: 'purchase_requisition',
    action: 'reject',
    resourceIdFrom: 'param:id',
    requiresReason: true,
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Reject a requisition (with reason)' })
  async rejectRequisition(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(rejectPurchaseRequisitionSchema))
    body: z.infer<typeof rejectPurchaseRequisitionSchema>,
  ) {
    return this.inventory.rejectRequisition(
      principal,
      requireInstitution(),
      params.id,
      body.reason,
      body.version,
    );
  }

  // ── Purchase orders ─────────────────────────────────────────────────────────────────

  @Get('purchase-orders')
  @RequirePermissions('inventory.view')
  @ApiOperation({ summary: 'List purchase orders' })
  async listPurchaseOrders(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listPurchaseOrdersSchema)) query: z.infer<typeof listPurchaseOrdersSchema>,
  ) {
    return this.inventory.listPurchaseOrders(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Post('purchase-orders')
  @RequirePermissions('inventory.purchase.approve')
  @Audited({
    module: 'inventory',
    resourceType: 'purchase_order',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create a purchase order' })
  async createPurchaseOrder(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createPurchaseOrderSchema)) body: z.infer<typeof createPurchaseOrderSchema>,
  ) {
    const result = await this.inventory.createPurchaseOrder(principal, requireInstitution(), body);
    return { ...result.order, items: result.items };
  }

  @Get('purchase-orders/:id')
  @RequirePermissions('inventory.view')
  @ApiOperation({ summary: 'Fetch one purchase order with its items and receipts' })
  async getPurchaseOrder(@Param(zodParam(idParamSchema)) params: { id: string }) {
    return this.inventory.getPurchaseOrder(requireInstitution(), params.id);
  }

  @Post('purchase-orders/:id/issue')
  @RequirePermissions('inventory.purchase.approve')
  @Audited({
    module: 'inventory',
    resourceType: 'purchase_order',
    action: 'publish',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Issue a draft purchase order to its supplier' })
  async issuePurchaseOrder(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(issuePurchaseOrderSchema)) body: z.infer<typeof issuePurchaseOrderSchema>,
  ) {
    return this.inventory.issuePurchaseOrder(
      principal,
      requireInstitution(),
      params.id,
      body.version,
    );
  }

  @Post('purchase-orders/:id/cancel')
  @RequirePermissions('inventory.purchase.approve')
  @Audited({
    module: 'inventory',
    resourceType: 'purchase_order',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Cancel a purchase order nothing has been received against' })
  async cancelPurchaseOrder(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(cancelPurchaseOrderSchema)) body: z.infer<typeof cancelPurchaseOrderSchema>,
  ) {
    return this.inventory.cancelPurchaseOrder(
      principal,
      requireInstitution(),
      params.id,
      body.reason,
      body.version,
    );
  }

  // ── Goods receipts ──────────────────────────────────────────────────────────────────

  @Post('purchase-orders/:id/receipts')
  @RequirePermissions('inventory.receive')
  @Audited({
    module: 'inventory',
    resourceType: 'goods_receipt',
    action: 'create',
    recordedBy: 'service',
  })
  @ApiOperation({
    summary:
      'Receive goods against a purchase order — movements and the inventory journal entry post in one transaction',
  })
  async createGoodsReceipt(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(createGoodsReceiptSchema)) body: z.infer<typeof createGoodsReceiptSchema>,
  ) {
    return this.inventory.createGoodsReceipt(principal, requireInstitution(), params.id, body);
  }
}

function requireInstitution(): string {
  const institutionId = currentContext()?.institutionId;
  if (!institutionId) {
    throw new BadRequestException(
      'Send the x-institution-id header to indicate which institution this inventory belongs to.',
    );
  }
  return institutionId;
}
