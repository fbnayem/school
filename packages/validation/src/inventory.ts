/**
 * Inventory and procurement schemas (Phase 19).
 *
 * Three rules shape every schema in this file:
 *
 *  - **Quantities cross the wire as decimal strings** with at most three decimal places
 *    (kg/litre), mirroring the `numeric(14, 3)` columns; costs are `positiveMoneySchema`
 *    strings mirroring `numeric(14, 2)` (ADR-004: no float, ever).
 *  - **A client never states a derived fact.** There is no `quantity` on a stock level, no
 *    `receivedQuantity` on an order item, no `status`, `subtotal` or `total` on a purchase
 *    order, and no `orderNumber`. Stock changes only by posting a movement; totals are
 *    computed by the service and restated by database constraints.
 *  - **Decisions carry reasons.** A rejection, a cancellation, a write-off and an
 *    adjustment all require a reason that lands in the audit log.
 *
 * Constants carry an `INVENTORY_`/`STOCK_`/`PURCHASE_` prefix because `@shikkha/validation`
 * re-exports flat.
 */

import { z } from 'zod';
import {
  calendarDateSchema,
  paginationSchema,
  positiveMoneySchema,
  reasonSchema,
  searchSchema,
  sortSchema,
  uuidSchema,
} from './common';

const code = (max: number) =>
  z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]+$/, 'Use letters, numbers, hyphens and underscores only')
    .min(1)
    .max(max);

const nameEn = z.string().trim().min(1).max(128);
const nameBn = z.string().trim().max(128).optional();

/** A strictly positive quantity with at most three decimal places, e.g. "12.500". */
export const inventoryQuantitySchema = z
  .string()
  .trim()
  .regex(/^\d{1,11}(\.\d{1,3})?$/, 'Enter a quantity with at most three decimal places')
  .refine((value) => !/^0+(\.0{1,3})?$/.test(value), {
    message: 'The quantity must be greater than zero',
  });

/** A signed, non-zero quantity — adjustments can add stock as well as remove it. */
export const inventorySignedQuantitySchema = z
  .string()
  .trim()
  .regex(/^-?\d{1,11}(\.\d{1,3})?$/, 'Enter a quantity with at most three decimal places')
  .refine((value) => !/^-?0+(\.0{1,3})?$/.test(value), {
    message: 'A zero adjustment changes nothing — state the signed difference found',
  });

/** A non-negative quantity, used for reorder levels ("0" disables the alert). */
export const inventoryNonNegativeQuantitySchema = z
  .string()
  .trim()
  .regex(/^\d{1,11}(\.\d{1,3})?$/, 'Enter a quantity with at most three decimal places');

// ── Value sets, mirrored from the database enums ─────────────────────────────────────

export const INVENTORY_UNITS = ['piece', 'box', 'kg', 'litre', 'metre', 'set'] as const;

export const INVENTORY_ITEM_STATUSES = ['active', 'inactive', 'discontinued'] as const;

export const INVENTORY_SUPPLIER_STATUSES = ['active', 'inactive'] as const;

export const STOCK_MOVEMENT_KINDS = [
  'receipt',
  'issue',
  'return',
  'adjustment',
  'transfer_in',
  'transfer_out',
  'write_off',
] as const;

export const PURCHASE_REQUISITION_STATUSES = [
  'draft',
  'submitted',
  'approved',
  'rejected',
  'ordered',
  'cancelled',
] as const;

export const PURCHASE_ORDER_STATUSES = [
  'draft',
  'issued',
  'partially_received',
  'received',
  'cancelled',
] as const;

// ── Sort allow-lists, consumed by parseSort ──────────────────────────────────────────

export const INVENTORY_CATEGORY_SORT_FIELDS = ['nameEn', 'sortOrder', 'createdAt'] as const;

export const INVENTORY_ITEM_SORT_FIELDS = ['code', 'nameEn', 'unit', 'status', 'createdAt'] as const;

export const INVENTORY_STORE_SORT_FIELDS = ['code', 'nameEn', 'createdAt'] as const;

export const INVENTORY_SUPPLIER_SORT_FIELDS = ['code', 'nameEn', 'status', 'createdAt'] as const;

export const STOCK_MOVEMENT_SORT_FIELDS = ['movedOn', 'kind', 'createdAt'] as const;

export const STOCK_LEVEL_SORT_FIELDS = ['quantity', 'updatedAt'] as const;

export const PURCHASE_REQUISITION_SORT_FIELDS = ['status', 'neededBy', 'createdAt'] as const;

export const PURCHASE_ORDER_SORT_FIELDS = [
  'orderNumber',
  'orderedOn',
  'status',
  'createdAt',
] as const;

// ── Shared ───────────────────────────────────────────────────────────────────────────

/** Every archive endpoint in this module records why. */
export const archiveInventoryRecordSchema = z.object({ reason: reasonSchema });

// ── Item categories ──────────────────────────────────────────────────────────────────

export const createItemCategorySchema = z.object({
  nameEn,
  nameBn,
  parentId: uuidSchema.optional(),
  sortOrder: z.coerce.number().int().min(0).max(999).default(0),
});

export type CreateItemCategoryInput = z.infer<typeof createItemCategorySchema>;

export const updateItemCategorySchema = z
  .object({
    nameEn: nameEn.optional(),
    nameBn: z.string().trim().max(128).nullable().optional(),
    parentId: uuidSchema.nullable().optional(),
    sortOrder: z.coerce.number().int().min(0).max(999).optional(),
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, { message: 'No changes were submitted' });

export type UpdateItemCategoryInput = z.infer<typeof updateItemCategorySchema>;

export const listItemCategoriesSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    includeArchived: z.coerce.boolean().default(false),
  });

// ── Items ────────────────────────────────────────────────────────────────────────────

export const createInventoryItemSchema = z.object({
  code: code(32),
  nameEn,
  nameBn,
  categoryId: uuidSchema.optional(),
  unit: z.enum(INVENTORY_UNITS).default('piece'),
  reorderLevel: inventoryNonNegativeQuantitySchema.default('0'),
  isConsumable: z.boolean().default(true),
  /** Chart-of-accounts code this item's stock is carried under. Required before receiving. */
  ledgerAccountCode: code(32).optional(),
});

export type CreateInventoryItemInput = z.infer<typeof createInventoryItemSchema>;

export const updateInventoryItemSchema = z
  .object({
    nameEn: nameEn.optional(),
    nameBn: z.string().trim().max(128).nullable().optional(),
    categoryId: uuidSchema.nullable().optional(),
    unit: z.enum(INVENTORY_UNITS).optional(),
    reorderLevel: inventoryNonNegativeQuantitySchema.optional(),
    isConsumable: z.boolean().optional(),
    ledgerAccountCode: code(32).nullable().optional(),
    status: z.enum(INVENTORY_ITEM_STATUSES).optional(),
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, { message: 'No changes were submitted' });

export type UpdateInventoryItemInput = z.infer<typeof updateInventoryItemSchema>;

export const listInventoryItemsSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    categoryId: uuidSchema.optional(),
    unit: z.enum(INVENTORY_UNITS).optional(),
    status: z.enum(INVENTORY_ITEM_STATUSES).optional(),
    includeArchived: z.coerce.boolean().default(false),
  });

// ── Stores ───────────────────────────────────────────────────────────────────────────

export const createStoreSchema = z.object({
  code: code(32),
  nameEn,
  nameBn,
  campusId: uuidSchema,
  keeperEmployeeId: uuidSchema.optional(),
});

export type CreateStoreInput = z.infer<typeof createStoreSchema>;

export const updateStoreSchema = z
  .object({
    nameEn: nameEn.optional(),
    nameBn: z.string().trim().max(128).nullable().optional(),
    campusId: uuidSchema.optional(),
    keeperEmployeeId: uuidSchema.nullable().optional(),
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, { message: 'No changes were submitted' });

export type UpdateStoreInput = z.infer<typeof updateStoreSchema>;

export const listStoresSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    campusId: uuidSchema.optional(),
    includeArchived: z.coerce.boolean().default(false),
  });

// ── Suppliers ────────────────────────────────────────────────────────────────────────

export const createSupplierSchema = z.object({
  code: code(32),
  nameEn,
  nameBn,
  contactPerson: z.string().trim().max(128).optional(),
  /** Free-form: suppliers legitimately have landlines, so no BD-mobile normalisation. */
  phone: z.string().trim().max(20).optional(),
  email: z.string().trim().email('Not a valid email address').max(255).optional(),
  address: z.string().trim().max(500).optional(),
});

export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;

export const updateSupplierSchema = z
  .object({
    nameEn: nameEn.optional(),
    nameBn: z.string().trim().max(128).nullable().optional(),
    contactPerson: z.string().trim().max(128).nullable().optional(),
    phone: z.string().trim().max(20).nullable().optional(),
    email: z.string().trim().email('Not a valid email address').max(255).nullable().optional(),
    address: z.string().trim().max(500).nullable().optional(),
    status: z.enum(INVENTORY_SUPPLIER_STATUSES).optional(),
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, { message: 'No changes were submitted' });

export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;

export const listSuppliersSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    status: z.enum(INVENTORY_SUPPLIER_STATUSES).optional(),
    includeArchived: z.coerce.boolean().default(false),
  });

// ── Stock: levels, movements, and the five stock operations ──────────────────────────

export const listStockLevelsSchema = paginationSchema.merge(sortSchema).extend({
  itemId: uuidSchema.optional(),
  storeId: uuidSchema.optional(),
});

export const listStockMovementsSchema = paginationSchema.merge(sortSchema).extend({
  itemId: uuidSchema.optional(),
  storeId: uuidSchema.optional(),
  kind: z.enum(STOCK_MOVEMENT_KINDS).optional(),
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
});

/** A direct receipt outside procurement — a donation, an opening balance. */
export const receiveStockSchema = z.object({
  itemId: uuidSchema,
  storeId: uuidSchema,
  quantity: inventoryQuantitySchema,
  unitCost: positiveMoneySchema,
  movedOn: calendarDateSchema,
  note: z.string().trim().max(1000).optional(),
});

export type ReceiveStockInput = z.infer<typeof receiveStockSchema>;

export const issueStockSchema = z.object({
  itemId: uuidSchema,
  storeId: uuidSchema,
  quantity: inventoryQuantitySchema,
  movedOn: calendarDateSchema,
  /** Who or what the stock went to — a department, a classroom, an event. */
  issuedTo: z.string().trim().max(255).optional(),
  note: z.string().trim().max(1000).optional(),
});

export type IssueStockInput = z.infer<typeof issueStockSchema>;

export const adjustStockSchema = z.object({
  itemId: uuidSchema,
  storeId: uuidSchema,
  /** Signed: a physical count can find stock as well as lose it. */
  quantity: inventorySignedQuantitySchema,
  /** Cost of found stock, so a positive adjustment enters valuation priced. */
  unitCost: positiveMoneySchema.optional(),
  movedOn: calendarDateSchema,
  reason: reasonSchema,
});

export type AdjustStockInput = z.infer<typeof adjustStockSchema>;

export const transferStockSchema = z
  .object({
    itemId: uuidSchema,
    fromStoreId: uuidSchema,
    toStoreId: uuidSchema,
    quantity: inventoryQuantitySchema,
    movedOn: calendarDateSchema,
    note: z.string().trim().max(1000).optional(),
  })
  .refine((data) => data.fromStoreId !== data.toStoreId, {
    message: 'A transfer needs two different stores',
    path: ['toStoreId'],
  });

export type TransferStockInput = z.infer<typeof transferStockSchema>;

export const writeOffStockSchema = z.object({
  itemId: uuidSchema,
  storeId: uuidSchema,
  quantity: inventoryQuantitySchema,
  movedOn: calendarDateSchema,
  reason: reasonSchema,
});

export type WriteOffStockInput = z.infer<typeof writeOffStockSchema>;

// ── Purchase requisitions ────────────────────────────────────────────────────────────

export const createPurchaseRequisitionSchema = z.object({
  neededBy: calendarDateSchema.optional(),
  justification: z
    .string()
    .trim()
    .min(10, 'Explain why this purchase is needed — the approver reads this')
    .max(1000),
  items: z
    .array(
      z.object({
        itemId: uuidSchema,
        quantity: inventoryQuantitySchema,
        estimatedUnitCost: positiveMoneySchema.optional(),
      }),
    )
    .min(1, 'A requisition needs at least one item')
    .max(100),
});

export type CreatePurchaseRequisitionInput = z.infer<typeof createPurchaseRequisitionSchema>;

export const submitPurchaseRequisitionSchema = z.object({
  version: z.number().int().min(1),
});

export const approvePurchaseRequisitionSchema = z.object({
  note: z.string().trim().max(1000).optional(),
  version: z.number().int().min(1),
});

export const rejectPurchaseRequisitionSchema = z.object({
  reason: reasonSchema,
  version: z.number().int().min(1),
});

export const listPurchaseRequisitionsSchema = paginationSchema.merge(sortSchema).extend({
  status: z.enum(PURCHASE_REQUISITION_STATUSES).optional(),
  requestedBy: uuidSchema.optional(),
  includeArchived: z.coerce.boolean().default(false),
});

// ── Purchase orders ──────────────────────────────────────────────────────────────────

export const createPurchaseOrderSchema = z.object({
  supplierId: uuidSchema,
  /** Optional link back to the approved requisition this order fulfils. */
  requisitionId: uuidSchema.optional(),
  orderedOn: calendarDateSchema,
  expectedOn: calendarDateSchema.optional(),
  tax: positiveMoneySchema.default('0.00'),
  items: z
    .array(
      z.object({
        itemId: uuidSchema,
        quantity: inventoryQuantitySchema,
        unitCost: positiveMoneySchema,
      }),
    )
    .min(1, 'A purchase order needs at least one item')
    .max(100),
});

export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderSchema>;

export const issuePurchaseOrderSchema = z.object({
  version: z.number().int().min(1),
});

export const cancelPurchaseOrderSchema = z.object({
  reason: reasonSchema,
  version: z.number().int().min(1),
});

export const listPurchaseOrdersSchema = paginationSchema.merge(sortSchema).extend({
  supplierId: uuidSchema.optional(),
  status: z.enum(PURCHASE_ORDER_STATUSES).optional(),
  includeArchived: z.coerce.boolean().default(false),
});

// ── Goods receipts ───────────────────────────────────────────────────────────────────

export const createGoodsReceiptSchema = z.object({
  receivedOn: calendarDateSchema,
  note: z.string().trim().max(1000).optional(),
  /**
   * The chart-of-accounts code credited by the receipt's journal entry — normally the
   * supplier payable account. The debit side comes from each item's `ledgerAccountCode`.
   */
  creditAccountCode: code(32),
  items: z
    .array(
      z.object({
        orderItemId: uuidSchema,
        quantity: inventoryQuantitySchema,
        unitCost: positiveMoneySchema,
        storeId: uuidSchema,
      }),
    )
    .min(1, 'Record at least one received line')
    .max(100),
});

export type CreateGoodsReceiptInput = z.infer<typeof createGoodsReceiptSchema>;

// ── Reports ──────────────────────────────────────────────────────────────────────────

export const lowStockReportSchema = z.object({
  storeId: uuidSchema.optional(),
});

export const stockValuationReportSchema = z.object({
  categoryId: uuidSchema.optional(),
});
