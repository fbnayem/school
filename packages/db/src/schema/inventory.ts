/**
 * Inventory and procurement (Phase 19).
 *
 * The stock ledger is built on the same philosophy as the accounting journal (0018): the
 * facts are an append-only movement log, and everything else is derived from it.
 *
 *  1. **`stock_movements` is append-only.** A wrong movement is corrected by a compensating
 *     movement, never an edit or a delete — a database trigger refuses UPDATE and DELETE for
 *     every role except the migrator.
 *  2. **`stock_levels` is derived, never asserted.** A trigger on `stock_movements` applies
 *     every movement's signed effect to the matching level row in the same transaction, and a
 *     guard trigger on `stock_levels` refuses any write that does not come from that trigger.
 *     The level therefore cannot drift from the movement log, and a reconciliation endpoint
 *     recomputes the sum to prove it.
 *  3. **Stock never goes negative.** `stock_levels_quantity_non_negative` is a check
 *     constraint; because the level row is updated by the movement trigger inside the same
 *     transaction, an over-issue fails in Postgres even when raw SQL bypasses the service.
 *  4. **Quantities are `numeric(14, 3)`** — three decimals for kg and litre — and costs are
 *     `numeric(14, 2)`. No float exists anywhere; arithmetic runs on `bigint` milli-units and
 *     `Money` minor units in code, and on `numeric` in SQL.
 *  5. **Received never exceeds ordered.** `purchase_order_items_received_within_ordered`
 *     restates the service check in the database.
 *
 * `purchase_requisitions.workflow_request_id` and `goods_receipts.journal_entry_id` are bare
 * uuids without foreign keys, deliberately: the workflow engine is an optional peer, and the
 * journal entry belongs to the accounting module — inventory calls its `LedgerService` inside
 * the same transaction but never touches its tables.
 */

import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  actorColumns,
  archiveColumns,
  primaryKeyColumn,
  timestampColumns,
  versionColumn,
} from './_shared';
import { campuses, institutions, organizations } from './tenancy';
import { employees } from './people';

// ─────────────────────────────────────────────────────────────────────────────────────
// Enumerations. Every set is genuinely closed: a new movement kind or order status changes
// the stock and procurement code as well as the schema. The things a school invents for
// itself — item categories, stores, suppliers — are rows, not enum values.
// ─────────────────────────────────────────────────────────────────────────────────────

/** Units of measure. Three-decimal quantities exist for kg, litre and metre. */
export const inventoryUnitEnum = pgEnum('inventory_unit', [
  'piece',
  'box',
  'kg',
  'litre',
  'metre',
  'set',
]);

export const inventoryItemStatusEnum = pgEnum('inventory_item_status', [
  'active',
  'inactive',
  'discontinued',
]);

export const inventorySupplierStatusEnum = pgEnum('inventory_supplier_status', [
  'active',
  'inactive',
]);

/**
 * The sign of a movement is a function of its kind: `receipt`, `return` and `transfer_in`
 * add stock; `issue`, `transfer_out` and `write_off` remove it; `adjustment` carries a
 * signed quantity because a physical count can find stock as well as lose it.
 */
export const stockMovementKindEnum = pgEnum('stock_movement_kind', [
  'receipt',
  'issue',
  'return',
  'adjustment',
  'transfer_in',
  'transfer_out',
  'write_off',
]);

export const purchaseRequisitionStatusEnum = pgEnum('purchase_requisition_status', [
  'draft',
  'submitted',
  'approved',
  'rejected',
  'ordered',
  'cancelled',
]);

export const purchaseOrderStatusEnum = pgEnum('purchase_order_status', [
  'draft',
  'issued',
  'partially_received',
  'received',
  'cancelled',
]);

// ─────────────────────────────────────────────────────────────────────────────────────
// Catalogue: categories, items, stores, suppliers
// ─────────────────────────────────────────────────────────────────────────────────────

export const itemCategories = pgTable(
  'item_categories',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    nameEn: varchar('name_en', { length: 128 }).notNull(),
    nameBn: varchar('name_bn', { length: 128 }),
    parentId: uuid('parent_id').references((): AnyPgColumn => itemCategories.id, {
      onDelete: 'restrict',
    }),
    sortOrder: smallint('sort_order').notNull().default(0),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('item_categories_institution_name_key')
      .on(table.institutionId, table.nameEn)
      .where(sql`${table.archivedAt} IS NULL`),
    index('item_categories_tenant_idx').on(table.tenantId),
    index('item_categories_parent_idx').on(table.parentId),
  ],
);

export const inventoryItems = pgTable(
  'items',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    code: varchar('code', { length: 32 }).notNull(),
    nameEn: varchar('name_en', { length: 128 }).notNull(),
    nameBn: varchar('name_bn', { length: 128 }),
    categoryId: uuid('category_id').references(() => itemCategories.id, {
      onDelete: 'restrict',
    }),
    unit: inventoryUnitEnum('unit').notNull().default('piece'),
    /** Stock at or below this level appears on the low-stock report. Zero disables it. */
    reorderLevel: numeric('reorder_level', { precision: 14, scale: 3 })
      .notNull()
      .default('0.000'),
    isConsumable: boolean('is_consumable').notNull().default(true),
    /**
     * The chart-of-accounts code of the asset account this item's stock is carried under.
     * A bare code rather than an id: the chart belongs to the accounting module, and an
     * archived-and-recreated account keeps its code. Required before the item can be
     * received against a purchase order (the goods receipt posts to this account).
     */
    ledgerAccountCode: varchar('ledger_account_code', { length: 32 }),
    status: inventoryItemStatusEnum('status').notNull().default('active'),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('items_institution_code_key')
      .on(table.institutionId, table.code)
      .where(sql`${table.archivedAt} IS NULL`),
    index('items_tenant_idx').on(table.tenantId),
    index('items_category_idx').on(table.categoryId),
    index('items_institution_status_idx').on(table.institutionId, table.status),
  ],
);

export const stores = pgTable(
  'stores',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    campusId: uuid('campus_id')
      .notNull()
      .references(() => campuses.id, { onDelete: 'restrict' }),
    code: varchar('code', { length: 32 }).notNull(),
    nameEn: varchar('name_en', { length: 128 }).notNull(),
    nameBn: varchar('name_bn', { length: 128 }),
    /** The storekeeper answerable for this store's stock. */
    keeperEmployeeId: uuid('keeper_employee_id').references(() => employees.id, {
      onDelete: 'restrict',
    }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('stores_institution_code_key')
      .on(table.institutionId, table.code)
      .where(sql`${table.archivedAt} IS NULL`),
    index('stores_tenant_idx').on(table.tenantId),
    index('stores_campus_idx').on(table.campusId),
    index('stores_keeper_idx').on(table.keeperEmployeeId),
  ],
);

export const suppliers = pgTable(
  'suppliers',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    code: varchar('code', { length: 32 }).notNull(),
    nameEn: varchar('name_en', { length: 128 }).notNull(),
    nameBn: varchar('name_bn', { length: 128 }),
    contactPerson: varchar('contact_person', { length: 128 }),
    /** Not BD-mobile-normalised: suppliers legitimately have landlines. */
    phone: varchar('phone', { length: 20 }),
    email: varchar('email', { length: 255 }),
    address: varchar('address', { length: 500 }),
    status: inventorySupplierStatusEnum('status').notNull().default('active'),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('suppliers_institution_code_key')
      .on(table.institutionId, table.code)
      .where(sql`${table.archivedAt} IS NULL`),
    index('suppliers_tenant_idx').on(table.tenantId),
    index('suppliers_institution_status_idx').on(table.institutionId, table.status),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Stock: the append-only movement log and the derived level
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * One physical stock event. APPEND-ONLY — `inventory_stock_movements_no_mutation` refuses
 * UPDATE and DELETE; a mistake is corrected by a compensating movement. The archive columns
 * exist to satisfy the schema convention but are unusable by construction, which is the
 * point: a movement is a historical fact.
 */
export const stockMovements = pgTable(
  'stock_movements',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => inventoryItems.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    kind: stockMovementKindEnum('kind').notNull(),
    /** Signed only for `adjustment`; every other kind is positive and its kind is the sign. */
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    /** Required on a receipt — that is where valuation cost enters the system. */
    unitCost: numeric('unit_cost', { precision: 14, scale: 2 }),
    /** What caused the movement: 'goods_receipt', 'stock_transfer', 'direct_receipt', … */
    referenceType: varchar('reference_type', { length: 64 }),
    referenceId: uuid('reference_id'),
    movedOn: date('moved_on').notNull(),
    movedBy: uuid('moved_by'),
    reason: varchar('reason', { length: 1000 }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('stock_movements_tenant_idx').on(table.tenantId),
    index('stock_movements_item_store_idx').on(table.itemId, table.storeId, table.movedOn),
    index('stock_movements_store_idx').on(table.storeId),
    index('stock_movements_reference_idx').on(table.referenceType, table.referenceId),
    index('stock_movements_institution_kind_idx').on(table.institutionId, table.kind),
  ],
);

/**
 * DERIVED: the running balance of one item in one store, equal by construction to the sum
 * of that pair's movements. Maintained exclusively by the `inventory_stock_movements_apply`
 * trigger; a guard trigger refuses every other writer, so the API can only change it by
 * writing a movement. `stock_levels_quantity_non_negative` is the database's word that
 * stock never goes negative.
 */
export const stockLevels = pgTable(
  'stock_levels',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => inventoryItems.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull().default('0.000'),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    // Not partial: a level row is a running balance, never archived — and the movement
    // trigger's upsert needs a total unique constraint as its conflict target.
    uniqueIndex('stock_levels_item_store_key').on(table.itemId, table.storeId),
    index('stock_levels_tenant_idx').on(table.tenantId),
    index('stock_levels_store_idx').on(table.storeId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Procurement: requisition → purchase order → goods receipt
// ─────────────────────────────────────────────────────────────────────────────────────

export const purchaseRequisitions = pgTable(
  'purchase_requisitions',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    /** The user who asked. The service refuses this user as the approver — four eyes. */
    requestedBy: uuid('requested_by').notNull(),
    neededBy: date('needed_by'),
    justification: varchar('justification', { length: 1000 }).notNull(),
    status: purchaseRequisitionStatusEnum('status').notNull().default('draft'),
    /** Optional workflow-engine integration; a bare uuid, deliberately without an FK. */
    workflowRequestId: uuid('workflow_request_id'),
    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' }),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    decisionReason: varchar('decision_reason', { length: 1000 }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('purchase_requisitions_tenant_idx').on(table.tenantId),
    index('purchase_requisitions_institution_status_idx').on(table.institutionId, table.status),
    index('purchase_requisitions_requested_by_idx').on(table.requestedBy),
  ],
);

export const requisitionItems = pgTable(
  'requisition_items',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    requisitionId: uuid('requisition_id')
      .notNull()
      .references(() => purchaseRequisitions.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => inventoryItems.id, { onDelete: 'restrict' }),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    estimatedUnitCost: numeric('estimated_unit_cost', { precision: 14, scale: 2 }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('requisition_items_requisition_item_key')
      .on(table.requisitionId, table.itemId)
      .where(sql`${table.archivedAt} IS NULL`),
    index('requisition_items_tenant_idx').on(table.tenantId),
    index('requisition_items_item_idx').on(table.itemId),
  ],
);

export const purchaseOrders = pgTable(
  'purchase_orders',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    /** A document number is never reused, so the unique index is NOT partial. */
    orderNumber: varchar('order_number', { length: 32 }).notNull(),
    requisitionId: uuid('requisition_id').references(() => purchaseRequisitions.id, {
      onDelete: 'restrict',
    }),
    orderedOn: date('ordered_on').notNull(),
    expectedOn: date('expected_on'),
    status: purchaseOrderStatusEnum('status').notNull().default('draft'),
    subtotal: numeric('subtotal', { precision: 14, scale: 2 }).notNull().default('0.00'),
    tax: numeric('tax', { precision: 14, scale: 2 }).notNull().default('0.00'),
    total: numeric('total', { precision: 14, scale: 2 }).notNull().default('0.00'),
    issuedBy: uuid('issued_by'),
    issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'date' }),
    cancelledReason: varchar('cancelled_reason', { length: 1000 }),
    cancelledBy: uuid('cancelled_by'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('purchase_orders_institution_number_key').on(
      table.institutionId,
      table.orderNumber,
    ),
    index('purchase_orders_tenant_idx').on(table.tenantId),
    index('purchase_orders_supplier_idx').on(table.supplierId),
    index('purchase_orders_institution_status_idx').on(table.institutionId, table.status),
    index('purchase_orders_requisition_idx').on(table.requisitionId),
  ],
);

export const purchaseOrderItems = pgTable(
  'purchase_order_items',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => inventoryItems.id, { onDelete: 'restrict' }),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    unitCost: numeric('unit_cost', { precision: 14, scale: 2 }).notNull(),
    /**
     * Maintained by the goods-receipt service in the receipt's transaction;
     * `purchase_order_items_received_within_ordered` is the database's word that received
     * never exceeds ordered.
     */
    receivedQuantity: numeric('received_quantity', { precision: 14, scale: 3 })
      .notNull()
      .default('0.000'),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('purchase_order_items_order_item_key')
      .on(table.orderId, table.itemId)
      .where(sql`${table.archivedAt} IS NULL`),
    index('purchase_order_items_tenant_idx').on(table.tenantId),
    index('purchase_order_items_item_idx').on(table.itemId),
  ],
);

export const goodsReceipts = pgTable(
  'goods_receipts',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'restrict' }),
    receivedOn: date('received_on').notNull(),
    receivedBy: uuid('received_by').notNull(),
    note: varchar('note', { length: 1000 }),
    /**
     * The inventory journal entry this receipt posted, written in the same transaction.
     * A bare uuid: `journal_entries` belongs to the accounting module.
     */
    journalEntryId: uuid('journal_entry_id'),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('goods_receipts_tenant_idx').on(table.tenantId),
    index('goods_receipts_order_idx').on(table.orderId),
  ],
);

export const goodsReceiptItems = pgTable(
  'goods_receipt_items',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    receiptId: uuid('receipt_id')
      .notNull()
      .references(() => goodsReceipts.id, { onDelete: 'cascade' }),
    orderItemId: uuid('order_item_id')
      .notNull()
      .references(() => purchaseOrderItems.id, { onDelete: 'restrict' }),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    unitCost: numeric('unit_cost', { precision: 14, scale: 2 }).notNull(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('goods_receipt_items_tenant_idx').on(table.tenantId),
    index('goods_receipt_items_receipt_idx').on(table.receiptId),
    index('goods_receipt_items_order_item_idx').on(table.orderItemId),
    index('goods_receipt_items_store_idx').on(table.storeId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Relations
// ─────────────────────────────────────────────────────────────────────────────────────

export const itemCategoriesRelations = relations(itemCategories, ({ one, many }) => ({
  parent: one(itemCategories, {
    fields: [itemCategories.parentId],
    references: [itemCategories.id],
  }),
  items: many(inventoryItems),
}));

export const inventoryItemsRelations = relations(inventoryItems, ({ one, many }) => ({
  category: one(itemCategories, {
    fields: [inventoryItems.categoryId],
    references: [itemCategories.id],
  }),
  levels: many(stockLevels),
  movements: many(stockMovements),
}));

export const storesRelations = relations(stores, ({ one, many }) => ({
  campus: one(campuses, { fields: [stores.campusId], references: [campuses.id] }),
  keeper: one(employees, { fields: [stores.keeperEmployeeId], references: [employees.id] }),
  levels: many(stockLevels),
}));

export const stockLevelsRelations = relations(stockLevels, ({ one }) => ({
  item: one(inventoryItems, { fields: [stockLevels.itemId], references: [inventoryItems.id] }),
  store: one(stores, { fields: [stockLevels.storeId], references: [stores.id] }),
}));

export const stockMovementsRelations = relations(stockMovements, ({ one }) => ({
  item: one(inventoryItems, {
    fields: [stockMovements.itemId],
    references: [inventoryItems.id],
  }),
  store: one(stores, { fields: [stockMovements.storeId], references: [stores.id] }),
}));

export const purchaseRequisitionsRelations = relations(purchaseRequisitions, ({ many }) => ({
  items: many(requisitionItems),
  orders: many(purchaseOrders),
}));

export const requisitionItemsRelations = relations(requisitionItems, ({ one }) => ({
  requisition: one(purchaseRequisitions, {
    fields: [requisitionItems.requisitionId],
    references: [purchaseRequisitions.id],
  }),
  item: one(inventoryItems, {
    fields: [requisitionItems.itemId],
    references: [inventoryItems.id],
  }),
}));

export const purchaseOrdersRelations = relations(purchaseOrders, ({ one, many }) => ({
  supplier: one(suppliers, { fields: [purchaseOrders.supplierId], references: [suppliers.id] }),
  requisition: one(purchaseRequisitions, {
    fields: [purchaseOrders.requisitionId],
    references: [purchaseRequisitions.id],
  }),
  items: many(purchaseOrderItems),
  receipts: many(goodsReceipts),
}));

export const purchaseOrderItemsRelations = relations(purchaseOrderItems, ({ one, many }) => ({
  order: one(purchaseOrders, {
    fields: [purchaseOrderItems.orderId],
    references: [purchaseOrders.id],
  }),
  item: one(inventoryItems, {
    fields: [purchaseOrderItems.itemId],
    references: [inventoryItems.id],
  }),
  receiptItems: many(goodsReceiptItems),
}));

export const goodsReceiptsRelations = relations(goodsReceipts, ({ one, many }) => ({
  order: one(purchaseOrders, {
    fields: [goodsReceipts.orderId],
    references: [purchaseOrders.id],
  }),
  items: many(goodsReceiptItems),
}));

export const goodsReceiptItemsRelations = relations(goodsReceiptItems, ({ one }) => ({
  receipt: one(goodsReceipts, {
    fields: [goodsReceiptItems.receiptId],
    references: [goodsReceipts.id],
  }),
  orderItem: one(purchaseOrderItems, {
    fields: [goodsReceiptItems.orderItemId],
    references: [purchaseOrderItems.id],
  }),
  store: one(stores, { fields: [goodsReceiptItems.storeId], references: [stores.id] }),
}));
