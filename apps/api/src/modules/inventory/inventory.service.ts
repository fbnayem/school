/**
 * Inventory and procurement service (Phase 19).
 *
 * The rules this file is written around:
 *
 *  1. **`stock_levels` is derived; this service never writes it.** Every stock operation is
 *     an INSERT into `stock_movements`; a database trigger applies the movement to the level
 *     row in the same transaction, and a guard trigger refuses every other writer. The
 *     service pre-checks sufficiency to produce a friendly 409, but the
 *     `stock_levels_quantity_non_negative` check constraint is the guarantee.
 *  2. **`stock_movements` is append-only.** A mistake is corrected by a compensating
 *     movement; the database refuses UPDATE and DELETE outright.
 *  3. **No floating point.** Quantities are `numeric(14, 3)`, handled as `bigint`
 *     milli-units; costs are `numeric(14, 2)`, handled only through `Money`. Where the two
 *     multiply (line value = quantity x unit cost) the arithmetic is integer:
 *     milli-units x poisa, divided by 1000 with half-up rounding. Reports run on Postgres
 *     `numeric` — exact decimal — never on `double precision`.
 *  4. **A goods receipt is atomic**: the receipt, its stock movements, the purchase-order
 *     progress, the inventory journal entry (posted through the accounting module's
 *     `LedgerService` inside this transaction) and the audit record all commit together or
 *     not at all.
 *  5. **Four eyes on procurement.** The user who raised a requisition cannot approve it, no
 *     matter what permissions they hold — checked against `requested_by` before anything
 *     else, exactly as the workflow engine and fee-concession flows do.
 */

import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  like,
  lte,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import {
  campuses,
  chartOfAccounts,
  employees,
  goodsReceiptItems,
  goodsReceipts,
  inventoryItems,
  itemCategories,
  purchaseOrderItems,
  purchaseOrders,
  purchaseRequisitions,
  requisitionItems,
  stockLevels,
  stockMovements,
  stores,
  suppliers,
} from '@shikkha/db';
import {
  buildOffsetPage,
  ConflictError,
  ForbiddenError,
  Money,
  NotFoundError,
  offsetOf,
  parseSort,
  uuidv7,
  ValidationError,
  type OffsetPage,
  type OffsetPageRequest,
} from '@shikkha/shared';
import { can, type Principal } from '@shikkha/permissions';
import {
  INVENTORY_CATEGORY_SORT_FIELDS,
  INVENTORY_ITEM_SORT_FIELDS,
  INVENTORY_STORE_SORT_FIELDS,
  INVENTORY_SUPPLIER_SORT_FIELDS,
  PURCHASE_ORDER_SORT_FIELDS,
  PURCHASE_REQUISITION_SORT_FIELDS,
  STOCK_LEVEL_SORT_FIELDS,
  STOCK_MOVEMENT_SORT_FIELDS,
  type AdjustStockInput,
  type CreateGoodsReceiptInput,
  type CreateInventoryItemInput,
  type CreateItemCategoryInput,
  type CreatePurchaseOrderInput,
  type CreatePurchaseRequisitionInput,
  type CreateStoreInput,
  type CreateSupplierInput,
  type IssueStockInput,
  type ReceiveStockInput,
  type TransferStockInput,
  type WriteOffStockInput,
} from '@shikkha/validation';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { LedgerService } from '../accounting/accounting.service';
import { currentContext } from '../../common/context/request-context';

/** The transaction handle `runInTenant` hands to its callback. */
type Tx = Parameters<Parameters<DatabaseService['runInTenant']>[0]>[0];

type ItemCategoryRow = typeof itemCategories.$inferSelect;
type ItemRow = typeof inventoryItems.$inferSelect;
type StoreRow = typeof stores.$inferSelect;
type SupplierRow = typeof suppliers.$inferSelect;
type StockMovementRow = typeof stockMovements.$inferSelect;
type RequisitionRow = typeof purchaseRequisitions.$inferSelect;
type RequisitionItemRow = typeof requisitionItems.$inferSelect;
type PurchaseOrderRow = typeof purchaseOrders.$inferSelect;
type PurchaseOrderItemRow = typeof purchaseOrderItems.$inferSelect;
type GoodsReceiptRow = typeof goodsReceipts.$inferSelect;
type GoodsReceiptItemRow = typeof goodsReceiptItems.$inferSelect;

// ── List-query shapes (parsed by the Zod schemas in @shikkha/validation) ─────────────

export interface ListItemCategoriesQuery {
  q?: string;
  sort?: string;
  includeArchived: boolean;
}

export interface ListInventoryItemsQuery {
  q?: string;
  sort?: string;
  categoryId?: string;
  unit?: string;
  status?: string;
  includeArchived: boolean;
}

export interface ListStoresQuery {
  q?: string;
  sort?: string;
  campusId?: string;
  includeArchived: boolean;
}

export interface ListSuppliersQuery {
  q?: string;
  sort?: string;
  status?: string;
  includeArchived: boolean;
}

export interface ListStockLevelsQuery {
  sort?: string;
  itemId?: string;
  storeId?: string;
}

export interface ListStockMovementsQuery {
  sort?: string;
  itemId?: string;
  storeId?: string;
  kind?: string;
  from?: string;
  to?: string;
}

export interface ListRequisitionsQuery {
  sort?: string;
  status?: string;
  requestedBy?: string;
  includeArchived: boolean;
}

export interface ListPurchaseOrdersQuery {
  sort?: string;
  supplierId?: string;
  status?: string;
  includeArchived: boolean;
}

@Injectable()
export class InventoryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════════════
  // Item categories
  // ══════════════════════════════════════════════════════════════════════════════════

  async listCategories(
    principal: Principal,
    institutionId: string,
    query: ListItemCategoriesQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<ItemCategoryRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(itemCategories.institutionId, institutionId)];
      this.applyArchiveFilter(principal, filters, itemCategories.archivedAt, query.includeArchived);
      if (query.q) filters.push(ilike(itemCategories.nameEn, `%${query.q}%`));

      const where = and(...filters);
      const orderBy = parseSort(query.sort, INVENTORY_CATEGORY_SORT_FIELDS, {
        field: 'sortOrder',
        direction: 'asc',
      }).map((spec) => {
        const column = CATEGORY_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(itemCategories)
        .where(where)
        .orderBy(...orderBy, asc(itemCategories.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(itemCategories)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async createCategory(
    principal: Principal,
    institutionId: string,
    input: CreateItemCategoryInput,
  ): Promise<ItemCategoryRow> {
    return this.db.runInTenant(async (tx) => {
      if (input.parentId) {
        await this.loadCategory(tx, institutionId, input.parentId);
      }
      const [created] = await tx
        .insert(itemCategories)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          nameEn: input.nameEn,
          nameBn: input.nameBn ?? null,
          parentId: input.parentId ?? null,
          sortOrder: input.sortOrder,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  async updateCategory(
    principal: Principal,
    institutionId: string,
    id: string,
    input: Record<string, unknown>,
  ): Promise<{ category: ItemCategoryRow; previous: Partial<ItemCategoryRow> }> {
    const version = input['version'] as number;
    const { version: _ignored, ...changes } = input;

    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadCategory(tx, institutionId, id);

      if (changes['parentId']) {
        if (changes['parentId'] === id) {
          throw new ConflictError('A category cannot be its own parent.');
        }
        await this.loadCategory(tx, institutionId, changes['parentId'] as string);
      }

      const [updated] = await tx
        .update(itemCategories)
        .set({
          ...(changes as Partial<ItemCategoryRow>),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(itemCategories.id, id), eq(itemCategories.version, version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This category was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      return { category: updated, previous: diffOf(existing, updated, Object.keys(changes)) };
    });
  }

  async archiveCategory(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<ItemCategoryRow> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadCategory(tx, institutionId, id);

      const [child] = await tx
        .select({ id: itemCategories.id })
        .from(itemCategories)
        .where(and(eq(itemCategories.parentId, id), isNull(itemCategories.archivedAt)))
        .limit(1);
      if (child) {
        throw new ConflictError('This category still has sub-categories. Archive those first.');
      }

      const [inUse] = await tx
        .select({ id: inventoryItems.id })
        .from(inventoryItems)
        .where(and(eq(inventoryItems.categoryId, id), isNull(inventoryItems.archivedAt)))
        .limit(1);
      if (inUse) {
        throw new ConflictError(
          'Items still belong to this category. Move or archive them first.',
        );
      }

      const [archived] = await tx
        .update(itemCategories)
        .set({
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(eq(itemCategories.id, id))
        .returning();
      return archived!;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Items
  // ══════════════════════════════════════════════════════════════════════════════════

  async listItems(
    principal: Principal,
    institutionId: string,
    query: ListInventoryItemsQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<ItemRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(inventoryItems.institutionId, institutionId)];
      this.applyArchiveFilter(principal, filters, inventoryItems.archivedAt, query.includeArchived);
      if (query.categoryId) filters.push(eq(inventoryItems.categoryId, query.categoryId));
      if (query.unit) filters.push(eq(inventoryItems.unit, query.unit as ItemRow['unit']));
      if (query.status) filters.push(eq(inventoryItems.status, query.status as ItemRow['status']));
      if (query.q) {
        filters.push(
          or(ilike(inventoryItems.nameEn, `%${query.q}%`), ilike(inventoryItems.code, `${query.q}%`))!,
        );
      }

      const where = and(...filters);
      const orderBy = parseSort(query.sort, INVENTORY_ITEM_SORT_FIELDS, {
        field: 'code',
        direction: 'asc',
      }).map((spec) => {
        const column = ITEM_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(inventoryItems)
        .where(where)
        .orderBy(...orderBy, asc(inventoryItems.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(inventoryItems)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async getItem(institutionId: string, id: string): Promise<ItemRow> {
    return this.db.runInTenant(async (tx) => this.loadItem(tx, institutionId, id));
  }

  async createItem(
    principal: Principal,
    institutionId: string,
    input: CreateInventoryItemInput,
  ): Promise<ItemRow> {
    return this.db.runInTenant(async (tx) => {
      if (input.categoryId) {
        await this.loadCategory(tx, institutionId, input.categoryId);
      }
      const [created] = await tx
        .insert(inventoryItems)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          code: input.code,
          nameEn: input.nameEn,
          nameBn: input.nameBn ?? null,
          categoryId: input.categoryId ?? null,
          unit: input.unit,
          reorderLevel: normalizeQuantity(input.reorderLevel),
          isConsumable: input.isConsumable,
          ledgerAccountCode: input.ledgerAccountCode ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  async updateItem(
    principal: Principal,
    institutionId: string,
    id: string,
    input: Record<string, unknown>,
  ): Promise<{ item: ItemRow; previous: Partial<ItemRow> }> {
    const version = input['version'] as number;
    const { version: _ignored, ...changes } = input;

    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadItem(tx, institutionId, id);

      if (changes['categoryId']) {
        await this.loadCategory(tx, institutionId, changes['categoryId'] as string);
      }
      if (typeof changes['reorderLevel'] === 'string') {
        changes['reorderLevel'] = normalizeQuantity(changes['reorderLevel']);
      }

      const [updated] = await tx
        .update(inventoryItems)
        .set({
          ...(changes as Partial<ItemRow>),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(inventoryItems.id, id), eq(inventoryItems.version, version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This item was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      return { item: updated, previous: diffOf(existing, updated, Object.keys(changes)) };
    });
  }

  async archiveItem(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<ItemRow> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadItem(tx, institutionId, id);

      const [held] = await tx
        .select({
          onHand: sql<string>`coalesce(sum(${stockLevels.quantity}), 0)::numeric(14,3)`,
        })
        .from(stockLevels)
        .where(eq(stockLevels.itemId, id));
      if (held && quantityToMilli(held.onHand) !== 0n) {
        throw new ConflictError(
          `This item still has ${held.onHand} on hand. Issue, transfer or write off the stock before archiving it.`,
        );
      }

      const [archived] = await tx
        .update(inventoryItems)
        .set({
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(eq(inventoryItems.id, id))
        .returning();
      return archived!;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Stores
  // ══════════════════════════════════════════════════════════════════════════════════

  async listStores(
    principal: Principal,
    institutionId: string,
    query: ListStoresQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<StoreRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(stores.institutionId, institutionId)];
      this.applyArchiveFilter(principal, filters, stores.archivedAt, query.includeArchived);
      if (query.campusId) filters.push(eq(stores.campusId, query.campusId));
      if (query.q) {
        filters.push(or(ilike(stores.nameEn, `%${query.q}%`), ilike(stores.code, `${query.q}%`))!);
      }

      const where = and(...filters);
      const orderBy = parseSort(query.sort, INVENTORY_STORE_SORT_FIELDS, {
        field: 'code',
        direction: 'asc',
      }).map((spec) => {
        const column = STORE_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(stores)
        .where(where)
        .orderBy(...orderBy, asc(stores.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(stores)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async createStore(
    principal: Principal,
    institutionId: string,
    input: CreateStoreInput,
  ): Promise<StoreRow> {
    return this.db.runInTenant(async (tx) => {
      const [campus] = await tx
        .select({ id: campuses.id })
        .from(campuses)
        .where(
          and(
            eq(campuses.id, input.campusId),
            eq(campuses.institutionId, institutionId),
            isNull(campuses.archivedAt),
          ),
        )
        .limit(1);
      if (!campus) throw new NotFoundError('Campus', input.campusId);

      if (input.keeperEmployeeId) {
        await this.assertEmployee(tx, institutionId, input.keeperEmployeeId);
      }

      const [created] = await tx
        .insert(stores)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          campusId: input.campusId,
          code: input.code,
          nameEn: input.nameEn,
          nameBn: input.nameBn ?? null,
          keeperEmployeeId: input.keeperEmployeeId ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  async updateStore(
    principal: Principal,
    institutionId: string,
    id: string,
    input: Record<string, unknown>,
  ): Promise<{ store: StoreRow; previous: Partial<StoreRow> }> {
    const version = input['version'] as number;
    const { version: _ignored, ...changes } = input;

    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadStore(tx, institutionId, id);

      if (changes['campusId']) {
        const [campus] = await tx
          .select({ id: campuses.id })
          .from(campuses)
          .where(
            and(
              eq(campuses.id, changes['campusId'] as string),
              eq(campuses.institutionId, institutionId),
              isNull(campuses.archivedAt),
            ),
          )
          .limit(1);
        if (!campus) throw new NotFoundError('Campus', changes['campusId'] as string);
      }
      if (changes['keeperEmployeeId']) {
        await this.assertEmployee(tx, institutionId, changes['keeperEmployeeId'] as string);
      }

      const [updated] = await tx
        .update(stores)
        .set({
          ...(changes as Partial<StoreRow>),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(stores.id, id), eq(stores.version, version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This store was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      return { store: updated, previous: diffOf(existing, updated, Object.keys(changes)) };
    });
  }

  async archiveStore(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<StoreRow> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadStore(tx, institutionId, id);

      const [held] = await tx
        .select({
          onHand: sql<string>`coalesce(sum(${stockLevels.quantity}), 0)::numeric(14,3)`,
        })
        .from(stockLevels)
        .where(eq(stockLevels.storeId, id));
      if (held && quantityToMilli(held.onHand) !== 0n) {
        throw new ConflictError(
          `This store still holds ${held.onHand} across its items. Transfer or write off the stock before archiving it.`,
        );
      }

      const [archived] = await tx
        .update(stores)
        .set({
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(eq(stores.id, id))
        .returning();
      return archived!;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Suppliers
  // ══════════════════════════════════════════════════════════════════════════════════

  async listSuppliers(
    principal: Principal,
    institutionId: string,
    query: ListSuppliersQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<SupplierRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(suppliers.institutionId, institutionId)];
      this.applyArchiveFilter(principal, filters, suppliers.archivedAt, query.includeArchived);
      if (query.status) filters.push(eq(suppliers.status, query.status as SupplierRow['status']));
      if (query.q) {
        filters.push(
          or(ilike(suppliers.nameEn, `%${query.q}%`), ilike(suppliers.code, `${query.q}%`))!,
        );
      }

      const where = and(...filters);
      const orderBy = parseSort(query.sort, INVENTORY_SUPPLIER_SORT_FIELDS, {
        field: 'code',
        direction: 'asc',
      }).map((spec) => {
        const column = SUPPLIER_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(suppliers)
        .where(where)
        .orderBy(...orderBy, asc(suppliers.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(suppliers)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async createSupplier(
    principal: Principal,
    institutionId: string,
    input: CreateSupplierInput,
  ): Promise<SupplierRow> {
    return this.db.runInTenant(async (tx) => {
      const [created] = await tx
        .insert(suppliers)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          code: input.code,
          nameEn: input.nameEn,
          nameBn: input.nameBn ?? null,
          contactPerson: input.contactPerson ?? null,
          phone: input.phone ?? null,
          email: input.email ?? null,
          address: input.address ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  async updateSupplier(
    principal: Principal,
    institutionId: string,
    id: string,
    input: Record<string, unknown>,
  ): Promise<{ supplier: SupplierRow; previous: Partial<SupplierRow> }> {
    const version = input['version'] as number;
    const { version: _ignored, ...changes } = input;

    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadSupplier(tx, institutionId, id);

      const [updated] = await tx
        .update(suppliers)
        .set({
          ...(changes as Partial<SupplierRow>),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(suppliers.id, id), eq(suppliers.version, version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This supplier was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      return { supplier: updated, previous: diffOf(existing, updated, Object.keys(changes)) };
    });
  }

  async archiveSupplier(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<SupplierRow> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadSupplier(tx, institutionId, id);

      const [openOrder] = await tx
        .select({ id: purchaseOrders.id })
        .from(purchaseOrders)
        .where(
          and(
            eq(purchaseOrders.supplierId, id),
            inArray(purchaseOrders.status, ['draft', 'issued', 'partially_received']),
            isNull(purchaseOrders.archivedAt),
          ),
        )
        .limit(1);
      if (openOrder) {
        throw new ConflictError(
          'This supplier still has open purchase orders. Receive or cancel them first.',
        );
      }

      const [archived] = await tx
        .update(suppliers)
        .set({
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(eq(suppliers.id, id))
        .returning();
      return archived!;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Stock levels and movement history
  // ══════════════════════════════════════════════════════════════════════════════════

  async listStockLevels(
    _principal: Principal,
    institutionId: string,
    query: ListStockLevelsQuery,
    page: OffsetPageRequest,
  ) {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(stockLevels.institutionId, institutionId)];
      if (query.itemId) filters.push(eq(stockLevels.itemId, query.itemId));
      if (query.storeId) filters.push(eq(stockLevels.storeId, query.storeId));

      const where = and(...filters);
      const orderBy = parseSort(query.sort, STOCK_LEVEL_SORT_FIELDS, {
        field: 'quantity',
        direction: 'desc',
      }).map((spec) => {
        const column = LEVEL_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select({
          id: stockLevels.id,
          itemId: stockLevels.itemId,
          storeId: stockLevels.storeId,
          quantity: stockLevels.quantity,
          updatedAt: stockLevels.updatedAt,
          itemCode: inventoryItems.code,
          itemNameEn: inventoryItems.nameEn,
          unit: inventoryItems.unit,
          reorderLevel: inventoryItems.reorderLevel,
          storeCode: stores.code,
          storeNameEn: stores.nameEn,
        })
        .from(stockLevels)
        .innerJoin(inventoryItems, eq(inventoryItems.id, stockLevels.itemId))
        .innerJoin(stores, eq(stores.id, stockLevels.storeId))
        .where(where)
        .orderBy(...orderBy, asc(stockLevels.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(stockLevels)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async listStockMovements(
    _principal: Principal,
    institutionId: string,
    query: ListStockMovementsQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<StockMovementRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(stockMovements.institutionId, institutionId)];
      if (query.itemId) filters.push(eq(stockMovements.itemId, query.itemId));
      if (query.storeId) filters.push(eq(stockMovements.storeId, query.storeId));
      if (query.kind) filters.push(eq(stockMovements.kind, query.kind as StockMovementRow['kind']));
      if (query.from) filters.push(gte(stockMovements.movedOn, query.from));
      if (query.to) filters.push(lte(stockMovements.movedOn, query.to));

      const where = and(...filters);
      const orderBy = parseSort(query.sort, STOCK_MOVEMENT_SORT_FIELDS, {
        field: 'createdAt',
        direction: 'desc',
      }).map((spec) => {
        const column = MOVEMENT_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(stockMovements)
        .where(where)
        .orderBy(...orderBy, asc(stockMovements.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(stockMovements)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Stock operations — each is one INSERT into the append-only movement log; the trigger
  // maintains the level and the check constraint refuses a negative outcome.
  // ══════════════════════════════════════════════════════════════════════════════════

  async receiveStock(
    principal: Principal,
    institutionId: string,
    input: ReceiveStockInput,
  ): Promise<StockMovementRow> {
    return this.db.runInTenant(async (tx) => {
      const item = await this.loadItem(tx, institutionId, input.itemId, { activeOnly: true });
      const store = await this.loadStore(tx, institutionId, input.storeId);

      return this.insertMovement(tx, principal, {
        institutionId,
        itemId: item.id,
        storeId: store.id,
        kind: 'receipt',
        quantity: normalizeQuantity(input.quantity),
        unitCost: Money.fromDecimalString(input.unitCost).toDecimalString(),
        referenceType: 'direct_receipt',
        referenceId: null,
        movedOn: input.movedOn,
        reason: input.note ?? null,
      });
    });
  }

  async issueStock(
    principal: Principal,
    institutionId: string,
    input: IssueStockInput,
  ): Promise<StockMovementRow> {
    return this.db.runInTenant(async (tx) => {
      const item = await this.loadItem(tx, institutionId, input.itemId, { activeOnly: true });
      const store = await this.loadStore(tx, institutionId, input.storeId);
      await this.assertSufficientStock(tx, item, store, normalizeQuantity(input.quantity));

      const reasonParts = [
        input.issuedTo ? `Issued to ${input.issuedTo}` : null,
        input.note ?? null,
      ].filter((part): part is string => part !== null);

      return this.insertMovement(tx, principal, {
        institutionId,
        itemId: item.id,
        storeId: store.id,
        kind: 'issue',
        quantity: normalizeQuantity(input.quantity),
        unitCost: null,
        referenceType: null,
        referenceId: null,
        movedOn: input.movedOn,
        reason: reasonParts.length > 0 ? reasonParts.join(': ').slice(0, 1000) : null,
      });
    });
  }

  async adjustStock(
    principal: Principal,
    institutionId: string,
    input: AdjustStockInput,
  ): Promise<StockMovementRow> {
    const quantityMilli = quantityToMilli(input.quantity);
    if (quantityMilli < 0n && input.unitCost !== undefined) {
      throw new ValidationError('A negative adjustment removes stock and carries no cost.', [
        { path: 'unitCost', message: 'Omit the unit cost when adjusting stock downward' },
      ]);
    }

    return this.db.runInTenant(async (tx) => {
      const item = await this.loadItem(tx, institutionId, input.itemId, { activeOnly: true });
      const store = await this.loadStore(tx, institutionId, input.storeId);
      if (quantityMilli < 0n) {
        await this.assertSufficientStock(tx, item, store, milliToQuantity(-quantityMilli));
      }

      return this.insertMovement(tx, principal, {
        institutionId,
        itemId: item.id,
        storeId: store.id,
        kind: 'adjustment',
        quantity: milliToQuantity(quantityMilli),
        unitCost:
          input.unitCost !== undefined
            ? Money.fromDecimalString(input.unitCost).toDecimalString()
            : null,
        referenceType: null,
        referenceId: null,
        movedOn: input.movedOn,
        reason: input.reason,
      });
    });
  }

  async transferStock(
    principal: Principal,
    institutionId: string,
    input: TransferStockInput,
  ): Promise<{ out: StockMovementRow; in: StockMovementRow }> {
    return this.db.runInTenant(async (tx) => {
      const item = await this.loadItem(tx, institutionId, input.itemId, { activeOnly: true });
      const fromStore = await this.loadStore(tx, institutionId, input.fromStoreId);
      const toStore = await this.loadStore(tx, institutionId, input.toStoreId);
      const quantity = normalizeQuantity(input.quantity);
      await this.assertSufficientStock(tx, item, fromStore, quantity);

      // The two halves share a reference id so they can always be paired later.
      const transferId = uuidv7();

      const outMovement = await this.insertMovement(tx, principal, {
        institutionId,
        itemId: item.id,
        storeId: fromStore.id,
        kind: 'transfer_out',
        quantity,
        unitCost: null,
        referenceType: 'stock_transfer',
        referenceId: transferId,
        movedOn: input.movedOn,
        reason: input.note ?? null,
      });
      const inMovement = await this.insertMovement(tx, principal, {
        institutionId,
        itemId: item.id,
        storeId: toStore.id,
        kind: 'transfer_in',
        quantity,
        unitCost: null,
        referenceType: 'stock_transfer',
        referenceId: transferId,
        movedOn: input.movedOn,
        reason: input.note ?? null,
      });

      return { out: outMovement, in: inMovement };
    });
  }

  async writeOffStock(
    principal: Principal,
    institutionId: string,
    input: WriteOffStockInput,
  ): Promise<StockMovementRow> {
    return this.db.runInTenant(async (tx) => {
      const item = await this.loadItem(tx, institutionId, input.itemId, { activeOnly: true });
      const store = await this.loadStore(tx, institutionId, input.storeId);
      const quantity = normalizeQuantity(input.quantity);
      await this.assertSufficientStock(tx, item, store, quantity);

      return this.insertMovement(tx, principal, {
        institutionId,
        itemId: item.id,
        storeId: store.id,
        kind: 'write_off',
        quantity,
        unitCost: null,
        referenceType: null,
        referenceId: null,
        movedOn: input.movedOn,
        reason: input.reason,
      });
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Purchase requisitions
  // ══════════════════════════════════════════════════════════════════════════════════

  async listRequisitions(
    principal: Principal,
    institutionId: string,
    query: ListRequisitionsQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<RequisitionRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(purchaseRequisitions.institutionId, institutionId)];
      this.applyArchiveFilter(
        principal,
        filters,
        purchaseRequisitions.archivedAt,
        query.includeArchived,
      );
      if (query.status) {
        filters.push(eq(purchaseRequisitions.status, query.status as RequisitionRow['status']));
      }
      if (query.requestedBy) filters.push(eq(purchaseRequisitions.requestedBy, query.requestedBy));

      const where = and(...filters);
      const orderBy = parseSort(query.sort, PURCHASE_REQUISITION_SORT_FIELDS, {
        field: 'createdAt',
        direction: 'desc',
      }).map((spec) => {
        const column = REQUISITION_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(purchaseRequisitions)
        .where(where)
        .orderBy(...orderBy, asc(purchaseRequisitions.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(purchaseRequisitions)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async getRequisition(
    institutionId: string,
    id: string,
  ): Promise<{ requisition: RequisitionRow; items: RequisitionItemRow[] }> {
    return this.db.runInTenant(async (tx) => {
      const requisition = await this.loadRequisition(tx, institutionId, id);
      const items = await tx
        .select()
        .from(requisitionItems)
        .where(and(eq(requisitionItems.requisitionId, id), isNull(requisitionItems.archivedAt)))
        .orderBy(asc(requisitionItems.id));
      return { requisition, items };
    });
  }

  async createRequisition(
    principal: Principal,
    institutionId: string,
    input: CreatePurchaseRequisitionInput,
  ): Promise<{ requisition: RequisitionRow; items: RequisitionItemRow[] }> {
    return this.db.runInTenant(async (tx) => {
      for (const line of input.items) {
        await this.loadItem(tx, institutionId, line.itemId, { activeOnly: true });
      }

      const requisitionId = uuidv7();
      const [requisition] = await tx
        .insert(purchaseRequisitions)
        .values({
          id: requisitionId,
          tenantId: principal.tenantId!,
          institutionId,
          requestedBy: principal.userId,
          neededBy: input.neededBy ?? null,
          justification: input.justification,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      const items: RequisitionItemRow[] = [];
      for (const line of input.items) {
        const [row] = await tx
          .insert(requisitionItems)
          .values({
            id: uuidv7(),
            tenantId: principal.tenantId!,
            institutionId,
            requisitionId,
            itemId: line.itemId,
            quantity: normalizeQuantity(line.quantity),
            estimatedUnitCost:
              line.estimatedUnitCost !== undefined
                ? Money.fromDecimalString(line.estimatedUnitCost).toDecimalString()
                : null,
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning();
        items.push(row!);
      }

      return { requisition: requisition!, items };
    });
  }

  async submitRequisition(
    principal: Principal,
    institutionId: string,
    id: string,
    version: number,
  ): Promise<RequisitionRow> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadRequisition(tx, institutionId, id);
      if (existing.status !== 'draft') {
        throw new ConflictError(
          `Only a draft requisition can be submitted; this one is ${existing.status}.`,
        );
      }

      const [updated] = await tx
        .update(purchaseRequisitions)
        .set({
          status: 'submitted',
          submittedAt: new Date(),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(purchaseRequisitions.id, id), eq(purchaseRequisitions.version, version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This requisition was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }
      return updated;
    });
  }

  async approveRequisition(
    principal: Principal,
    institutionId: string,
    id: string,
    note: string | undefined,
    version: number,
  ): Promise<RequisitionRow> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadRequisition(tx, institutionId, id);

      // Four eyes, checked before anything else: the requester cannot approve their own
      // requisition no matter which permissions they hold. The budget-holder decides.
      if (existing.requestedBy === principal.userId) {
        throw new ForbiddenError(
          'inventory.purchase.approve',
          'You cannot approve your own purchase requisition. A different budget-holder must decide it.',
        );
      }

      if (existing.status !== 'submitted') {
        throw new ConflictError(
          `Only a submitted requisition can be approved; this one is ${existing.status}.`,
        );
      }

      const [updated] = await tx
        .update(purchaseRequisitions)
        .set({
          status: 'approved',
          decidedBy: principal.userId,
          decidedAt: new Date(),
          decisionReason: note ?? null,
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(purchaseRequisitions.id, id), eq(purchaseRequisitions.version, version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This requisition was changed by someone else while you were deciding. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      // The approval is legally part of the business transaction, so its audit record
      // commits (or rolls back) with it.
      await this.recordDecision(tx, principal, institutionId, {
        action: 'approve',
        requisition: updated,
        reason: note ?? null,
      });

      return updated;
    });
  }

  async rejectRequisition(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
    version: number,
  ): Promise<RequisitionRow> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadRequisition(tx, institutionId, id);

      if (existing.requestedBy === principal.userId) {
        throw new ForbiddenError(
          'inventory.purchase.approve',
          'You cannot decide your own purchase requisition. A different budget-holder must decide it.',
        );
      }

      if (existing.status !== 'submitted') {
        throw new ConflictError(
          `Only a submitted requisition can be rejected; this one is ${existing.status}.`,
        );
      }

      const [updated] = await tx
        .update(purchaseRequisitions)
        .set({
          status: 'rejected',
          decidedBy: principal.userId,
          decidedAt: new Date(),
          decisionReason: reason,
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(purchaseRequisitions.id, id), eq(purchaseRequisitions.version, version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This requisition was changed by someone else while you were deciding. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      await this.recordDecision(tx, principal, institutionId, {
        action: 'reject',
        requisition: updated,
        reason,
      });

      return updated;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Purchase orders
  // ══════════════════════════════════════════════════════════════════════════════════

  async listPurchaseOrders(
    principal: Principal,
    institutionId: string,
    query: ListPurchaseOrdersQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<PurchaseOrderRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(purchaseOrders.institutionId, institutionId)];
      this.applyArchiveFilter(principal, filters, purchaseOrders.archivedAt, query.includeArchived);
      if (query.supplierId) filters.push(eq(purchaseOrders.supplierId, query.supplierId));
      if (query.status) {
        filters.push(eq(purchaseOrders.status, query.status as PurchaseOrderRow['status']));
      }

      const where = and(...filters);
      const orderBy = parseSort(query.sort, PURCHASE_ORDER_SORT_FIELDS, {
        field: 'orderedOn',
        direction: 'desc',
      }).map((spec) => {
        const column = ORDER_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(purchaseOrders)
        .where(where)
        .orderBy(...orderBy, asc(purchaseOrders.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(purchaseOrders)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async getPurchaseOrder(
    institutionId: string,
    id: string,
  ): Promise<{ order: PurchaseOrderRow; items: PurchaseOrderItemRow[]; receipts: GoodsReceiptRow[] }> {
    return this.db.runInTenant(async (tx) => {
      const order = await this.loadPurchaseOrder(tx, institutionId, id);
      const items = await tx
        .select()
        .from(purchaseOrderItems)
        .where(and(eq(purchaseOrderItems.orderId, id), isNull(purchaseOrderItems.archivedAt)))
        .orderBy(asc(purchaseOrderItems.id));
      const receipts = await tx
        .select()
        .from(goodsReceipts)
        .where(and(eq(goodsReceipts.orderId, id), isNull(goodsReceipts.archivedAt)))
        .orderBy(asc(goodsReceipts.id));
      return { order, items, receipts };
    });
  }

  async createPurchaseOrder(
    principal: Principal,
    institutionId: string,
    input: CreatePurchaseOrderInput,
  ): Promise<{ order: PurchaseOrderRow; items: PurchaseOrderItemRow[] }> {
    return this.db.runInTenant(async (tx) => {
      const supplier = await this.loadSupplier(tx, institutionId, input.supplierId);
      if (supplier.status !== 'active') {
        throw new ConflictError('This supplier is inactive. Reactivate it before ordering.');
      }

      if (input.requisitionId) {
        const requisition = await this.loadRequisition(tx, institutionId, input.requisitionId);
        if (requisition.status !== 'approved') {
          throw new ConflictError(
            `Only an approved requisition can be ordered against; this one is ${requisition.status}.`,
          );
        }
      }

      const lineValues: Money[] = [];
      for (const line of input.items) {
        await this.loadItem(tx, institutionId, line.itemId, { activeOnly: true });
        lineValues.push(lineValueOf(line.quantity, Money.fromDecimalString(line.unitCost)));
      }
      const subtotal = Money.sum(lineValues);
      const tax = Money.fromDecimalString(input.tax);
      const total = subtotal.plus(tax);

      const year4 = input.orderedOn.slice(0, 4);
      const prefix = `PO-${year4}-`;
      const sequence = (await this.currentOrderSequence(tx, institutionId, prefix)) + 1;
      const orderNumber = `${prefix}${String(sequence).padStart(6, '0')}`;

      const orderId = uuidv7();
      const [order] = await tx
        .insert(purchaseOrders)
        .values({
          id: orderId,
          tenantId: principal.tenantId!,
          institutionId,
          supplierId: input.supplierId,
          orderNumber,
          requisitionId: input.requisitionId ?? null,
          orderedOn: input.orderedOn,
          expectedOn: input.expectedOn ?? null,
          subtotal: subtotal.toDecimalString(),
          tax: tax.toDecimalString(),
          total: total.toDecimalString(),
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      const items: PurchaseOrderItemRow[] = [];
      for (const line of input.items) {
        const [row] = await tx
          .insert(purchaseOrderItems)
          .values({
            id: uuidv7(),
            tenantId: principal.tenantId!,
            institutionId,
            orderId,
            itemId: line.itemId,
            quantity: normalizeQuantity(line.quantity),
            unitCost: Money.fromDecimalString(line.unitCost).toDecimalString(),
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning();
        items.push(row!);
      }

      return { order: order!, items };
    });
  }

  async issuePurchaseOrder(
    principal: Principal,
    institutionId: string,
    id: string,
    version: number,
  ): Promise<PurchaseOrderRow> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadPurchaseOrder(tx, institutionId, id);
      if (existing.status !== 'draft') {
        throw new ConflictError(
          `Only a draft purchase order can be issued; ${existing.orderNumber} is ${existing.status}.`,
        );
      }

      const [updated] = await tx
        .update(purchaseOrders)
        .set({
          status: 'issued',
          issuedBy: principal.userId,
          issuedAt: new Date(),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.version, version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This purchase order was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      if (existing.requisitionId) {
        // The requisition's request has now been acted on; keep its lifecycle honest.
        await tx
          .update(purchaseRequisitions)
          .set({ status: 'ordered', updatedBy: principal.userId })
          .where(
            and(
              eq(purchaseRequisitions.id, existing.requisitionId),
              eq(purchaseRequisitions.status, 'approved'),
            ),
          );
      }

      return updated;
    });
  }

  async cancelPurchaseOrder(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
    version: number,
  ): Promise<PurchaseOrderRow> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadPurchaseOrder(tx, institutionId, id);
      if (existing.status !== 'draft' && existing.status !== 'issued') {
        throw new ConflictError(
          `Only a draft or issued purchase order can be cancelled; ${existing.orderNumber} is ${existing.status}.`,
        );
      }

      const [receipt] = await tx
        .select({ id: goodsReceipts.id })
        .from(goodsReceipts)
        .where(and(eq(goodsReceipts.orderId, id), isNull(goodsReceipts.archivedAt)))
        .limit(1);
      if (receipt) {
        throw new ConflictError(
          'Goods have already been received against this order; it can no longer be cancelled.',
        );
      }

      const [updated] = await tx
        .update(purchaseOrders)
        .set({
          status: 'cancelled',
          cancelledReason: reason,
          cancelledBy: principal.userId,
          cancelledAt: new Date(),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.version, version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This purchase order was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      if (existing.requisitionId) {
        // An ordered requisition whose order was cancelled goes back to approved, so it can
        // be ordered again from another supplier.
        await tx
          .update(purchaseRequisitions)
          .set({ status: 'approved', updatedBy: principal.userId })
          .where(
            and(
              eq(purchaseRequisitions.id, existing.requisitionId),
              eq(purchaseRequisitions.status, 'ordered'),
            ),
          );
      }

      return updated;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Goods receipt — movements, order progress, journal entry and audit in ONE transaction
  // ══════════════════════════════════════════════════════════════════════════════════

  async createGoodsReceipt(
    principal: Principal,
    institutionId: string,
    orderId: string,
    input: CreateGoodsReceiptInput,
  ): Promise<{
    receipt: GoodsReceiptRow;
    items: GoodsReceiptItemRow[];
    orderStatus: PurchaseOrderRow['status'];
    journalEntryId: string | null;
    journalEntryNumber: string | null;
  }> {
    return this.db.runInTenant(async (tx) => {
      const order = await this.loadPurchaseOrder(tx, institutionId, orderId);
      if (order.status !== 'issued' && order.status !== 'partially_received') {
        throw new ConflictError(
          `Goods can only be received against an issued order; ${order.orderNumber} is ${order.status}.`,
        );
      }

      // Locked: two concurrent receipts against the same order line must serialise here,
      // or the second would compute its new received_quantity from a stale value.
      const orderLines = await tx
        .select()
        .from(purchaseOrderItems)
        .where(and(eq(purchaseOrderItems.orderId, orderId), isNull(purchaseOrderItems.archivedAt)))
        .for('update');
      const orderLineById = new Map(orderLines.map((line) => [line.id, line]));

      // Aggregate the receipt lines per order line, then check over-receipt once per line —
      // two receipt lines against the same order line must not slip past the cap together.
      const receiptMilliByOrderLine = new Map<string, bigint>();
      for (const line of input.items) {
        const orderLine = orderLineById.get(line.orderItemId);
        if (!orderLine) throw new NotFoundError('Purchase order line', line.orderItemId);
        const already = receiptMilliByOrderLine.get(line.orderItemId) ?? 0n;
        receiptMilliByOrderLine.set(line.orderItemId, already + quantityToMilli(line.quantity));
      }
      for (const [orderItemId, receivingMilli] of receiptMilliByOrderLine) {
        const orderLine = orderLineById.get(orderItemId)!;
        const orderedMilli = quantityToMilli(orderLine.quantity);
        const receivedMilli = quantityToMilli(orderLine.receivedQuantity);
        if (receivedMilli + receivingMilli > orderedMilli) {
          throw new ConflictError(
            `Receiving ${milliToQuantity(receivingMilli)} would exceed the ordered quantity: ` +
              `${orderLine.quantity} ordered, ${orderLine.receivedQuantity} already received.`,
            { orderItemId },
          );
        }
      }

      // Resolve the ledger accounts before writing anything, so the failure mode is a clean
      // 409 rather than a half-validated transaction.
      const itemIds = [...new Set(orderLines.map((line) => line.itemId))];
      const itemRows = await tx
        .select()
        .from(inventoryItems)
        .where(and(inArray(inventoryItems.id, itemIds), isNull(inventoryItems.archivedAt)));
      const itemById = new Map(itemRows.map((row) => [row.id, row]));

      const neededCodes = new Set<string>([input.creditAccountCode]);
      for (const line of input.items) {
        const orderLine = orderLineById.get(line.orderItemId)!;
        const item = itemById.get(orderLine.itemId);
        if (!item) throw new NotFoundError('Item', orderLine.itemId);
        if (!item.ledgerAccountCode) {
          throw new ConflictError(
            `Item ${item.code} has no ledger account code. Set one before receiving it against a purchase order.`,
          );
        }
        neededCodes.add(item.ledgerAccountCode);
      }

      const accountRows = await tx
        .select()
        .from(chartOfAccounts)
        .where(
          and(
            eq(chartOfAccounts.institutionId, institutionId),
            inArray(chartOfAccounts.code, [...neededCodes]),
            isNull(chartOfAccounts.archivedAt),
          ),
        );
      const accountByCode = new Map(accountRows.map((row) => [row.code, row]));
      for (const codeNeeded of neededCodes) {
        if (!accountByCode.has(codeNeeded)) {
          throw new ConflictError(
            `No account with code ${codeNeeded} exists in the chart of accounts. Create it before receiving.`,
          );
        }
      }

      // Validate the destination stores.
      const storeIds = [...new Set(input.items.map((line) => line.storeId))];
      for (const storeId of storeIds) {
        await this.loadStore(tx, institutionId, storeId);
      }

      // 1. The receipt document and its lines.
      const receiptId = uuidv7();
      const [receipt] = await tx
        .insert(goodsReceipts)
        .values({
          id: receiptId,
          tenantId: principal.tenantId!,
          institutionId,
          orderId,
          receivedOn: input.receivedOn,
          receivedBy: principal.userId,
          note: input.note ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      const receiptItems: GoodsReceiptItemRow[] = [];
      const debitByAccountId = new Map<string, Money>();
      for (const line of input.items) {
        const orderLine = orderLineById.get(line.orderItemId)!;
        const item = itemById.get(orderLine.itemId)!;
        const unitCost = Money.fromDecimalString(line.unitCost);
        const quantity = normalizeQuantity(line.quantity);

        const [receiptItem] = await tx
          .insert(goodsReceiptItems)
          .values({
            id: uuidv7(),
            tenantId: principal.tenantId!,
            institutionId,
            receiptId,
            orderItemId: line.orderItemId,
            quantity,
            unitCost: unitCost.toDecimalString(),
            storeId: line.storeId,
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning();
        receiptItems.push(receiptItem!);

        // 2. The stock movement — the trigger applies it to the level in this transaction.
        await this.insertMovement(tx, principal, {
          institutionId,
          itemId: item.id,
          storeId: line.storeId,
          kind: 'receipt',
          quantity,
          unitCost: unitCost.toDecimalString(),
          referenceType: 'goods_receipt',
          referenceId: receiptId,
          movedOn: input.receivedOn,
          reason: null,
        });

        const accountId = accountByCode.get(item.ledgerAccountCode!)!.id;
        const previous = debitByAccountId.get(accountId) ?? Money.zero();
        debitByAccountId.set(accountId, previous.plus(lineValueOf(quantity, unitCost)));
      }

      // 3. Purchase-order progress. The database check restates the cap.
      for (const [orderItemId, receivingMilli] of receiptMilliByOrderLine) {
        const orderLine = orderLineById.get(orderItemId)!;
        const newReceived = milliToQuantity(
          quantityToMilli(orderLine.receivedQuantity) + receivingMilli,
        );
        await tx
          .update(purchaseOrderItems)
          .set({
            receivedQuantity: newReceived,
            version: orderLine.version + 1,
            updatedBy: principal.userId,
          })
          .where(eq(purchaseOrderItems.id, orderItemId));
      }

      const fullyReceived = orderLines.every((line) => {
        const received =
          quantityToMilli(line.receivedQuantity) + (receiptMilliByOrderLine.get(line.id) ?? 0n);
        return received >= quantityToMilli(line.quantity);
      });
      const orderStatus: PurchaseOrderRow['status'] = fullyReceived
        ? 'received'
        : 'partially_received';
      await tx
        .update(purchaseOrders)
        .set({ status: orderStatus, version: order.version + 1, updatedBy: principal.userId })
        .where(eq(purchaseOrders.id, orderId));

      // 4. The inventory journal entry, posted through the accounting module inside THIS
      // transaction: debit each item's stock account, credit the payable account with the
      // sum. Balanced by construction. A receipt whose every line is zero-cost (donated
      // goods) has no financial effect and posts nothing.
      const totalValue = Money.sum([...debitByAccountId.values()]);
      let journalEntryId: string | null = null;
      let journalEntryNumber: string | null = null;
      if (totalValue.isPositive()) {
        const creditAccount = accountByCode.get(input.creditAccountCode)!;
        const { entry } = await this.ledger.post(tx, {
          tenantId: principal.tenantId!,
          institutionId,
          actorUserId: principal.userId,
          entryDate: input.receivedOn,
          description: `Goods receipt against ${order.orderNumber}`,
          referenceType: 'goods_receipt',
          referenceId: receiptId,
          sourceModule: 'inventory',
          isSystemGenerated: true,
          lines: [
            ...[...debitByAccountId.entries()]
              .filter(([, amount]) => amount.isPositive())
              .map(([accountId, amount]) => ({
                accountId,
                debit: amount.toDecimalString(),
                description: `Stock received against ${order.orderNumber}`,
              })),
            {
              accountId: creditAccount.id,
              credit: totalValue.toDecimalString(),
              description: `Payable for ${order.orderNumber}`,
            },
          ],
        });
        journalEntryId = entry.id;
        journalEntryNumber = entry.entryNumber;

        await tx
          .update(goodsReceipts)
          .set({ journalEntryId })
          .where(eq(goodsReceipts.id, receiptId));
      }

      // 5. The audit record, in the same transaction — the trail rolls back with the stock.
      const context = currentContext();
      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'create',
        module: 'inventory',
        resourceType: 'goods_receipt',
        resourceId: receiptId,
        resourceLabel: order.orderNumber,
        newValue: {
          orderId,
          orderNumber: order.orderNumber,
          receivedOn: input.receivedOn,
          items: receiptItems.map((line) => ({
            orderItemId: line.orderItemId,
            storeId: line.storeId,
            quantity: line.quantity,
            unitCost: line.unitCost,
          })),
          totalValue: totalValue.toDecimalString(),
          journalEntryId,
          journalEntryNumber,
          orderStatus,
        },
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      return {
        receipt: { ...receipt!, journalEntryId },
        items: receiptItems,
        orderStatus,
        journalEntryId,
        journalEntryNumber,
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Reports — computed in SQL over `numeric` (exact decimal), never in floating point.
  // ══════════════════════════════════════════════════════════════════════════════════

  /** Items whose total on-hand stock is at or below their reorder level. */
  async lowStockReport(institutionId: string, storeId?: string) {
    return this.db.runInTenant(async (tx) => {
      const storeFilter = storeId ? sql` and l.store_id = ${storeId}` : sql``;
      const result = await tx.execute(sql`
        select i.id as item_id,
               i.code,
               i.name_en,
               i.name_bn,
               i.unit,
               i.reorder_level::text as reorder_level,
               coalesce(sum(l.quantity), 0)::numeric(14, 3)::text as on_hand
          from items i
          left join stock_levels l
            on l.item_id = i.id${storeFilter}
         where i.institution_id = ${institutionId}
           and i.archived_at is null
           and i.status = 'active'
           and i.reorder_level > 0
         group by i.id, i.code, i.name_en, i.name_bn, i.unit, i.reorder_level
        having coalesce(sum(l.quantity), 0) <= i.reorder_level
         order by i.code
      `);
      return { items: result.rows };
    });
  }

  /**
   * Stock valuation at weighted average cost.
   *
   * The average is periodic weighted average: total value of cost-bearing inbound
   * movements (receipts, priced returns, priced positive adjustments) divided by their
   * total quantity, computed entirely in Postgres `numeric` — exact decimal arithmetic,
   * rounded to 4 decimals for the unit cost and 2 for the value. Internal transfers move
   * quantity between stores without touching the cost basis, so they are excluded.
   */
  async valuationReport(institutionId: string, categoryId?: string) {
    return this.db.runInTenant(async (tx) => {
      const categoryFilter = categoryId ? sql` and i.category_id = ${categoryId}` : sql``;
      const result = await tx.execute(sql`
        with cost_basis as (
          select m.item_id,
                 sum(m.quantity)::numeric(14, 3) as inbound_qty,
                 sum(round(m.quantity * m.unit_cost, 2))::numeric(14, 2) as inbound_value
            from stock_movements m
           where m.institution_id = ${institutionId}
             and m.unit_cost is not null
             and (
               m.kind = 'receipt'
               or m.kind = 'return'
               or (m.kind = 'adjustment' and m.quantity > 0)
             )
           group by m.item_id
        ),
        on_hand as (
          select l.item_id, sum(l.quantity)::numeric(14, 3) as qty
            from stock_levels l
           where l.institution_id = ${institutionId}
           group by l.item_id
        )
        select i.id as item_id,
               i.code,
               i.name_en,
               i.unit,
               coalesce(h.qty, 0)::numeric(14, 3)::text as on_hand,
               case when coalesce(b.inbound_qty, 0) > 0
                    then round(b.inbound_value / b.inbound_qty, 4)::text
                    else null end as weighted_average_cost,
               case when coalesce(b.inbound_qty, 0) > 0
                    then round(
                      coalesce(h.qty, 0) * round(b.inbound_value / b.inbound_qty, 4), 2
                    )::text
                    else '0.00' end as stock_value
          from items i
          left join cost_basis b on b.item_id = i.id
          left join on_hand h on h.item_id = i.id
         where i.institution_id = ${institutionId}
           and i.archived_at is null${categoryFilter}
         order by i.code
      `);

      const rows = result.rows as Array<{ stock_value: string }>;
      const totalValue = Money.sum(rows.map((row) => Money.fromDecimalString(row.stock_value)));
      return { items: result.rows, totalValue: totalValue.toDecimalString() };
    });
  }

  /**
   * Recompute every stock level from the movement log and report any mismatch.
   *
   * The trigger pair makes drift impossible by construction; this endpoint is the proof —
   * it must always return zero mismatches, and a non-empty answer is a sev-1.
   */
  async stockReconciliation(institutionId: string) {
    return this.db.runInTenant(async (tx) => {
      const result = await tx.execute(sql`
        select coalesce(l.item_id, m.item_id) as item_id,
               coalesce(l.store_id, m.store_id) as store_id,
               coalesce(l.quantity, 0)::numeric(14, 3)::text as recorded_quantity,
               coalesce(m.movement_sum, 0)::numeric(14, 3)::text as computed_quantity
          from (
            select item_id, store_id, quantity
              from stock_levels
             where institution_id = ${institutionId}
          ) l
          full outer join (
            select item_id,
                   store_id,
                   sum(
                     case when kind in ('issue', 'transfer_out', 'write_off')
                          then -quantity
                          else quantity
                     end
                   )::numeric(14, 3) as movement_sum
              from stock_movements
             where institution_id = ${institutionId}
             group by item_id, store_id
          ) m on m.item_id = l.item_id and m.store_id = l.store_id
         where coalesce(l.quantity, 0) <> coalesce(m.movement_sum, 0)
      `);

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(stockLevels)
        .where(eq(stockLevels.institutionId, institutionId));

      return {
        checkedLevels: counted?.total ?? 0,
        mismatches: result.rows,
        clean: result.rows.length === 0,
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Private helpers
  // ══════════════════════════════════════════════════════════════════════════════════

  private applyArchiveFilter(
    principal: Principal,
    filters: SQL[],
    archivedAtColumn: SQLWrapper,
    includeArchived: boolean,
  ): void {
    if (!includeArchived) {
      filters.push(isNull(archivedAtColumn));
      return;
    }
    if (!can(principal, 'inventory.manage')) {
      throw new ForbiddenError('inventory.manage', 'You cannot view archived inventory records');
    }
  }

  private async loadCategory(
    tx: Tx,
    institutionId: string,
    id: string,
  ): Promise<ItemCategoryRow> {
    const [row] = await tx
      .select()
      .from(itemCategories)
      .where(
        and(
          eq(itemCategories.id, id),
          eq(itemCategories.institutionId, institutionId),
          isNull(itemCategories.archivedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError('Item category', id);
    return row;
  }

  private async loadItem(
    tx: Tx,
    institutionId: string,
    id: string,
    options: { activeOnly?: boolean } = {},
  ): Promise<ItemRow> {
    const [row] = await tx
      .select()
      .from(inventoryItems)
      .where(
        and(
          eq(inventoryItems.id, id),
          eq(inventoryItems.institutionId, institutionId),
          isNull(inventoryItems.archivedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError('Item', id);
    if (options.activeOnly && row.status !== 'active') {
      throw new ConflictError(`Item ${row.code} is ${row.status} and cannot be moved.`);
    }
    return row;
  }

  private async loadStore(tx: Tx, institutionId: string, id: string): Promise<StoreRow> {
    const [row] = await tx
      .select()
      .from(stores)
      .where(
        and(eq(stores.id, id), eq(stores.institutionId, institutionId), isNull(stores.archivedAt)),
      )
      .limit(1);
    if (!row) throw new NotFoundError('Store', id);
    return row;
  }

  private async loadSupplier(tx: Tx, institutionId: string, id: string): Promise<SupplierRow> {
    const [row] = await tx
      .select()
      .from(suppliers)
      .where(
        and(
          eq(suppliers.id, id),
          eq(suppliers.institutionId, institutionId),
          isNull(suppliers.archivedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError('Supplier', id);
    return row;
  }

  private async loadRequisition(
    tx: Tx,
    institutionId: string,
    id: string,
  ): Promise<RequisitionRow> {
    const [row] = await tx
      .select()
      .from(purchaseRequisitions)
      .where(
        and(
          eq(purchaseRequisitions.id, id),
          eq(purchaseRequisitions.institutionId, institutionId),
          isNull(purchaseRequisitions.archivedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError('Purchase requisition', id);
    return row;
  }

  private async loadPurchaseOrder(
    tx: Tx,
    institutionId: string,
    id: string,
  ): Promise<PurchaseOrderRow> {
    const [row] = await tx
      .select()
      .from(purchaseOrders)
      .where(
        and(
          eq(purchaseOrders.id, id),
          eq(purchaseOrders.institutionId, institutionId),
          isNull(purchaseOrders.archivedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError('Purchase order', id);
    return row;
  }

  private async assertEmployee(tx: Tx, institutionId: string, id: string): Promise<void> {
    const [row] = await tx
      .select({ id: employees.id })
      .from(employees)
      .where(
        and(
          eq(employees.id, id),
          eq(employees.institutionId, institutionId),
          isNull(employees.archivedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError('Employee', id);
  }

  /**
   * Friendly pre-check for an outbound movement. Locks the level row so a concurrent
   * issue serialises here; the `stock_levels_quantity_non_negative` check constraint is
   * the actual guarantee if anything slips past.
   */
  private async assertSufficientStock(
    tx: Tx,
    item: ItemRow,
    store: StoreRow,
    quantity: string,
  ): Promise<void> {
    const [level] = await tx
      .select({ quantity: stockLevels.quantity })
      .from(stockLevels)
      .where(and(eq(stockLevels.itemId, item.id), eq(stockLevels.storeId, store.id)))
      .for('update');

    const onHand = level ? quantityToMilli(level.quantity) : 0n;
    if (onHand < quantityToMilli(quantity)) {
      throw new ConflictError(
        `Not enough stock: ${item.code} has ${level?.quantity ?? '0.000'} ${item.unit} on hand ` +
          `in ${store.code}, but ${quantity} was requested.`,
        { itemId: item.id, storeId: store.id, onHand: level?.quantity ?? '0.000', requested: quantity },
      );
    }
  }

  private async insertMovement(
    tx: Tx,
    principal: Principal,
    input: {
      institutionId: string;
      itemId: string;
      storeId: string;
      kind: StockMovementRow['kind'];
      quantity: string;
      unitCost: string | null;
      referenceType: string | null;
      referenceId: string | null;
      movedOn: string;
      reason: string | null;
    },
  ): Promise<StockMovementRow> {
    const [row] = await tx
      .insert(stockMovements)
      .values({
        id: uuidv7(),
        tenantId: principal.tenantId!,
        institutionId: input.institutionId,
        itemId: input.itemId,
        storeId: input.storeId,
        kind: input.kind,
        quantity: input.quantity,
        unitCost: input.unitCost,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        movedOn: input.movedOn,
        movedBy: principal.userId,
        reason: input.reason,
        createdBy: principal.userId,
        updatedBy: principal.userId,
      })
      .returning();
    return row!;
  }

  private async recordDecision(
    tx: Tx,
    principal: Principal,
    institutionId: string,
    input: {
      action: 'approve' | 'reject';
      requisition: RequisitionRow;
      reason: string | null;
    },
  ): Promise<void> {
    const context = currentContext();
    await this.audit.recordInTransaction(tx, {
      tenantId: principal.tenantId,
      institutionId,
      actorUserId: principal.userId,
      actorRoles: principal.roles.map((role) => role.roleKey),
      action: input.action,
      module: 'inventory',
      resourceType: 'purchase_requisition',
      resourceId: input.requisition.id,
      newValue: {
        status: input.requisition.status,
        requestedBy: input.requisition.requestedBy,
        decidedBy: input.requisition.decidedBy,
      },
      reason: input.reason,
      requestId: context?.requestId ?? null,
      ipAddress: context?.ipAddress ?? null,
      userAgent: context?.userAgent ?? null,
    });
  }

  /**
   * The highest order number already issued under a prefix. `max` rather than `count`,
   * because numbers are never reused; the unique index on `(institution_id, order_number)`
   * is the real guarantee against a race.
   */
  private async currentOrderSequence(
    tx: Tx,
    institutionId: string,
    prefix: string,
  ): Promise<number> {
    const [row] = await tx
      .select({ maxNumber: sql<string | null>`max(${purchaseOrders.orderNumber})` })
      .from(purchaseOrders)
      .where(
        and(
          eq(purchaseOrders.institutionId, institutionId),
          like(purchaseOrders.orderNumber, `${prefix}%`),
        ),
      );
    return sequenceAfter(row?.maxNumber ?? null, prefix);
  }
}

// ────────────────────────────────────────────────────────────────────────────────────
// Pure helpers — quantity arithmetic on bigint milli-units (numeric(14, 3) mirrors)
// ────────────────────────────────────────────────────────────────────────────────────

/** Parse a decimal quantity string into an integer count of milli-units. */
function quantityToMilli(value: string): bigint {
  const negative = value.startsWith('-');
  const magnitude = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = magnitude.split('.');
  const milli = BigInt(whole || '0') * 1000n + BigInt(`${fraction}000`.slice(0, 3));
  return negative ? -milli : milli;
}

/** Serialise milli-units back to the canonical three-decimal string. */
function milliToQuantity(milli: bigint): string {
  const negative = milli < 0n;
  const magnitude = negative ? -milli : milli;
  const whole = magnitude / 1000n;
  const fraction = (magnitude % 1000n).toString().padStart(3, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

/** Bring a quantity to its canonical form ("12.5" -> "12.500"). */
function normalizeQuantity(value: string): string {
  return milliToQuantity(quantityToMilli(value));
}

/**
 * quantity x unit cost, exactly: milli-units x poisa, divided by 1000 with half-up
 * rounding on the last poisa. Both factors are non-negative wherever this is called.
 */
function lineValueOf(quantity: string, unitCost: Money): Money {
  const milli = quantityToMilli(quantity);
  const scaled = milli * unitCost.minor;
  return Money.fromMinor((scaled + 500n) / 1000n, unitCost.currency);
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

/** Next number after the highest one already issued under a prefix. */
function sequenceAfter(highest: string | null, prefix: string): number {
  if (!highest) return 0;
  const parsed = Number.parseInt(highest.slice(prefix.length), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

// ────────────────────────────────────────────────────────────────────────────────────
// Sort allow-lists mapped to columns
// ────────────────────────────────────────────────────────────────────────────────────

const CATEGORY_COLUMNS = {
  nameEn: itemCategories.nameEn,
  sortOrder: itemCategories.sortOrder,
  createdAt: itemCategories.createdAt,
} as const;

const ITEM_COLUMNS = {
  code: inventoryItems.code,
  nameEn: inventoryItems.nameEn,
  unit: inventoryItems.unit,
  status: inventoryItems.status,
  createdAt: inventoryItems.createdAt,
} as const;

const STORE_COLUMNS = {
  code: stores.code,
  nameEn: stores.nameEn,
  createdAt: stores.createdAt,
} as const;

const SUPPLIER_COLUMNS = {
  code: suppliers.code,
  nameEn: suppliers.nameEn,
  status: suppliers.status,
  createdAt: suppliers.createdAt,
} as const;

const MOVEMENT_COLUMNS = {
  movedOn: stockMovements.movedOn,
  kind: stockMovements.kind,
  createdAt: stockMovements.createdAt,
} as const;

const LEVEL_COLUMNS = {
  quantity: stockLevels.quantity,
  updatedAt: stockLevels.updatedAt,
} as const;

const REQUISITION_COLUMNS = {
  status: purchaseRequisitions.status,
  neededBy: purchaseRequisitions.neededBy,
  createdAt: purchaseRequisitions.createdAt,
} as const;

const ORDER_COLUMNS = {
  orderNumber: purchaseOrders.orderNumber,
  orderedOn: purchaseOrders.orderedOn,
  status: purchaseOrders.status,
  createdAt: purchaseOrders.createdAt,
} as const;
