/**
 * Asset services (Phase 20): the fixed-asset register.
 *
 * The rules this file keeps absolutely, mirroring accounting (the module it posts through):
 *
 *  1. **No floating point.** Every monetary value is parsed with `Money.fromDecimalString`
 *     and written with `Money.toDecimalString` (ADR-004). Straight-line depreciation splits
 *     the depreciable amount across the life in months with `Money.allocate`, so the monthly
 *     parts sum back to exactly `purchase_cost - salvage_value` — no poisa invented or lost
 *     over the whole life of the asset.
 *  2. **The database is the last line of defence, not the first.** Book-value derivation,
 *     the salvage floor, one open assignment per asset, one run per period, the immutability
 *     of a posted run and the two-person disposal rule are all validated here for friendly
 *     errors, and all enforced again by the constraints, indexes and triggers of migration
 *     0026 — a bug in this file fails the write instead of misstating the register.
 *  3. **Posting a run is atomic with its ledger effect.** The per-asset updates, the one
 *     balanced journal entry through `LedgerService.post`, the status flip and the audit
 *     record share one transaction: if the ledger refuses (closed period, header account),
 *     nothing moves.
 *  4. **Every financially significant mutation writes its audit record inside the business
 *     transaction** (`recordInTransaction`), so the trail rolls back with the money. The
 *     corresponding routes carry `recordedBy: 'service'`.
 *  5. **Nothing is hard-deleted.** Assets are archived or disposed, runs are cancelled, and
 *     DELETE is revoked from the application role.
 */

import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ilike, inArray, isNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  assetAssignments,
  assetCategories,
  assetDisposals,
  assetMaintenance,
  assets,
  campuses,
  chartOfAccounts,
  departments,
  depreciationLines,
  depreciationRuns,
  employees,
  rooms,
} from '@shikkha/db';
import {
  buildOffsetPage,
  ConflictError,
  Money,
  NotFoundError,
  offsetOf,
  parseSort,
  todayInDhaka,
  uuidv7,
  ValidationError,
  type OffsetPage,
  type OffsetPageRequest,
} from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import {
  ASSET_ASSIGNMENT_SORT_FIELDS,
  ASSET_CATEGORY_SORT_FIELDS,
  ASSET_DISPOSAL_SORT_FIELDS,
  ASSET_MAINTENANCE_SORT_FIELDS,
  ASSET_SORT_FIELDS,
  DEPRECIATION_RUN_SORT_FIELDS,
  type ApproveAssetDisposalInput,
  type CreateAssetAssignmentInput,
  type CreateAssetCategoryInput,
  type CreateAssetDisposalInput,
  type CreateAssetInput,
  type CreateAssetMaintenanceInput,
  type CreateDepreciationRunInput,
  type PostDepreciationRunInput,
  type ReturnAssetAssignmentInput,
} from '@shikkha/validation';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { LedgerService, type LedgerLineInput } from '../accounting/accounting.service';
import { currentContext } from '../../common/context/request-context';

/** The transaction handle `runInTenant` hands to its callback. */
type Tx = Parameters<Parameters<DatabaseService['runInTenant']>[0]>[0];

type CategoryRow = typeof assetCategories.$inferSelect;
type AssetRow = typeof assets.$inferSelect;
type AssignmentRow = typeof assetAssignments.$inferSelect;
type MaintenanceRow = typeof assetMaintenance.$inferSelect;
type RunRow = typeof depreciationRuns.$inferSelect;
type LineRow = typeof depreciationLines.$inferSelect;
type DisposalRow = typeof assetDisposals.$inferSelect;

const CATEGORY_COLUMNS = {
  name: assetCategories.name,
  createdAt: assetCategories.createdAt,
} as const;

const ASSET_COLUMNS = {
  assetTag: assets.assetTag,
  name: assets.name,
  purchasedOn: assets.purchasedOn,
  purchaseCost: assets.purchaseCost,
  bookValue: assets.bookValue,
  status: assets.status,
  createdAt: assets.createdAt,
} as const;

const ASSIGNMENT_COLUMNS = {
  assignedOn: assetAssignments.assignedOn,
  returnedOn: assetAssignments.returnedOn,
  createdAt: assetAssignments.createdAt,
} as const;

const MAINTENANCE_COLUMNS = {
  performedOn: assetMaintenance.performedOn,
  cost: assetMaintenance.cost,
  nextDueOn: assetMaintenance.nextDueOn,
  createdAt: assetMaintenance.createdAt,
} as const;

const RUN_COLUMNS = {
  periodYear: depreciationRuns.periodYear,
  periodMonth: depreciationRuns.periodMonth,
  status: depreciationRuns.status,
  createdAt: depreciationRuns.createdAt,
} as const;

const DISPOSAL_COLUMNS = {
  disposedOn: assetDisposals.disposedOn,
  method: assetDisposals.method,
  createdAt: assetDisposals.createdAt,
} as const;

@Injectable()
export class AssetsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════════════
  // Categories
  // ══════════════════════════════════════════════════════════════════════════════════

  async listCategories(
    institutionId: string,
    query: { sort?: string; q?: string; parentId?: string; includeArchived: boolean },
    page: OffsetPageRequest,
  ): Promise<OffsetPage<CategoryRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(assetCategories.institutionId, institutionId)];
      if (!query.includeArchived) filters.push(isNull(assetCategories.archivedAt));
      if (query.parentId) filters.push(eq(assetCategories.parentId, query.parentId));
      if (query.q) filters.push(ilike(assetCategories.name, `%${query.q}%`));

      const where = and(...filters);
      const orderBy = parseSort(query.sort, ASSET_CATEGORY_SORT_FIELDS, {
        field: 'name',
        direction: 'asc',
      }).map((spec) => {
        const column = CATEGORY_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(assetCategories)
        .where(where)
        .orderBy(...orderBy, asc(assetCategories.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(assetCategories)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async createCategory(
    principal: Principal,
    institutionId: string,
    input: CreateAssetCategoryInput,
  ): Promise<CategoryRow> {
    return this.db.runInTenant(async (tx) => {
      const [duplicate] = await tx
        .select({ id: assetCategories.id })
        .from(assetCategories)
        .where(
          and(
            eq(assetCategories.institutionId, institutionId),
            eq(assetCategories.name, input.name),
            isNull(assetCategories.archivedAt),
          ),
        )
        .limit(1);
      if (duplicate) {
        throw new ConflictError(`A category named ${input.name} already exists.`, {
          existingCategoryId: duplicate.id,
        });
      }

      if (input.parentId) {
        await this.loadCategory(tx, institutionId, input.parentId);
      }

      const [created] = await tx
        .insert(assetCategories)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          name: input.name,
          nameBn: input.nameBn ?? null,
          parentId: input.parentId ?? null,
          defaultUsefulLifeYears: input.defaultUsefulLifeYears ?? null,
          defaultDepreciationMethod: input.defaultDepreciationMethod,
          ledgerAccountCode: input.ledgerAccountCode ?? null,
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
  ): Promise<{ category: CategoryRow; previous: Partial<CategoryRow> }> {
    const version = input['version'] as number;
    const { version: _ignored, ...changes } = input;

    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadCategory(tx, institutionId, id);

      if (typeof changes['parentId'] === 'string') {
        if (changes['parentId'] === id) {
          throw new ValidationError('A category cannot be its own parent', [
            { path: 'parentId', message: 'Choose a different parent' },
          ]);
        }
        await this.loadCategory(tx, institutionId, changes['parentId']);
      }

      const [updated] = await tx
        .update(assetCategories)
        .set({
          ...(changes as Partial<CategoryRow>),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(assetCategories.id, id), eq(assetCategories.version, version)))
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
  ): Promise<CategoryRow> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadCategory(tx, institutionId, id);

      const [liveAsset] = await tx
        .select({ id: assets.id })
        .from(assets)
        .where(and(eq(assets.categoryId, id), isNull(assets.archivedAt)))
        .limit(1);
      if (liveAsset) {
        throw new ConflictError('Re-categorise or archive this category’s assets first.');
      }

      const [child] = await tx
        .select({ id: assetCategories.id })
        .from(assetCategories)
        .where(and(eq(assetCategories.parentId, id), isNull(assetCategories.archivedAt)))
        .limit(1);
      if (child) {
        throw new ConflictError('Archive or re-parent this category’s children first.');
      }

      const [archived] = await tx
        .update(assetCategories)
        .set({
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(eq(assetCategories.id, id))
        .returning();
      return archived!;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Assets
  // ══════════════════════════════════════════════════════════════════════════════════

  async listAssets(
    institutionId: string,
    query: {
      sort?: string;
      q?: string;
      categoryId?: string;
      campusId?: string;
      status?: AssetRow['status'];
      condition?: AssetRow['condition'];
      depreciationMethod?: AssetRow['depreciationMethod'];
      includeArchived: boolean;
    },
    page: OffsetPageRequest,
  ): Promise<OffsetPage<AssetRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(assets.institutionId, institutionId)];
      if (!query.includeArchived) filters.push(isNull(assets.archivedAt));
      if (query.categoryId) filters.push(eq(assets.categoryId, query.categoryId));
      if (query.campusId) filters.push(eq(assets.campusId, query.campusId));
      if (query.status) filters.push(eq(assets.status, query.status));
      if (query.condition) filters.push(eq(assets.condition, query.condition));
      if (query.depreciationMethod) {
        filters.push(eq(assets.depreciationMethod, query.depreciationMethod));
      }
      if (query.q) {
        filters.push(
          or(
            ilike(assets.name, `%${query.q}%`),
            ilike(assets.assetTag, `${query.q}%`),
            ilike(assets.serialNumber, `%${query.q}%`),
          )!,
        );
      }

      const where = and(...filters);
      const orderBy = parseSort(query.sort, ASSET_SORT_FIELDS, {
        field: 'assetTag',
        direction: 'asc',
      }).map((spec) => {
        const column = ASSET_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(assets)
        .where(where)
        .orderBy(...orderBy, asc(assets.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(assets)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  /**
   * Register an asset. It opens at book value = purchase cost with zero accumulated
   * depreciation — the only state `assets_book_value_derived` admits for a new row.
   */
  async createAsset(
    principal: Principal,
    institutionId: string,
    input: CreateAssetInput,
  ): Promise<AssetRow> {
    return this.db.runInTenant(async (tx) => {
      await this.loadCategory(tx, institutionId, input.categoryId);

      if (input.campusId) {
        const [campus] = await tx
          .select({ id: campuses.id })
          .from(campuses)
          .where(and(eq(campuses.id, input.campusId), eq(campuses.institutionId, institutionId)))
          .limit(1);
        if (!campus) throw new NotFoundError('Campus', input.campusId);
      }

      // Not filtered on archived_at: an asset tag is a physical label, never reused —
      // `assets_institution_tag_key` is deliberately not partial.
      const [duplicate] = await tx
        .select({ id: assets.id })
        .from(assets)
        .where(and(eq(assets.institutionId, institutionId), eq(assets.assetTag, input.assetTag)))
        .limit(1);
      if (duplicate) {
        throw new ConflictError(`Asset tag ${input.assetTag} is already in use.`, {
          existingAssetId: duplicate.id,
        });
      }

      const cost = Money.fromDecimalString(input.purchaseCost);
      const salvage = Money.fromDecimalString(input.salvageValue);
      if (salvage.greaterThan(cost)) {
        throw new ValidationError('The salvage value cannot exceed the purchase cost', [
          { path: 'salvageValue', message: `Purchase cost is ${cost.toDecimalString()}` },
        ]);
      }

      const [created] = await tx
        .insert(assets)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          campusId: input.campusId ?? null,
          assetTag: input.assetTag,
          name: input.name,
          nameBn: input.nameBn ?? null,
          categoryId: input.categoryId,
          serialNumber: input.serialNumber ?? null,
          purchasedOn: input.purchasedOn,
          purchaseCost: cost.toDecimalString(),
          supplierName: input.supplierName ?? null,
          warrantyExpiresOn: input.warrantyExpiresOn ?? null,
          usefulLifeYears: input.depreciationMethod === 'none' ? null : input.usefulLifeYears!,
          salvageValue: salvage.toDecimalString(),
          depreciationMethod: input.depreciationMethod,
          accumulatedDepreciation: Money.zero().toDecimalString(),
          bookValue: cost.toDecimalString(),
          condition: input.condition,
          status: 'in_store',
          location: input.location ?? null,
          sourceReference: input.sourceReference ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  /** One asset with its open assignment, if anyone currently holds it. */
  async getAsset(
    institutionId: string,
    id: string,
  ): Promise<AssetRow & { openAssignment: AssignmentRow | null }> {
    return this.db.runInTenant(async (tx) => {
      const asset = await this.loadAsset(tx, institutionId, id);
      const [open] = await tx
        .select()
        .from(assetAssignments)
        .where(
          and(
            eq(assetAssignments.assetId, id),
            isNull(assetAssignments.returnedOn),
            isNull(assetAssignments.archivedAt),
          ),
        )
        .limit(1);
      return { ...asset, openAssignment: open ?? null };
    });
  }

  async updateAsset(
    principal: Principal,
    institutionId: string,
    id: string,
    input: Record<string, unknown>,
  ): Promise<{ asset: AssetRow; previous: Partial<AssetRow> }> {
    const version = input['version'] as number;
    const { version: _ignored, ...changes } = input;

    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadAsset(tx, institutionId, id);

      if (typeof changes['categoryId'] === 'string') {
        await this.loadCategory(tx, institutionId, changes['categoryId']);
      }
      if (typeof changes['campusId'] === 'string') {
        const [campus] = await tx
          .select({ id: campuses.id })
          .from(campuses)
          .where(
            and(eq(campuses.id, changes['campusId']), eq(campuses.institutionId, institutionId)),
          )
          .limit(1);
        if (!campus) throw new NotFoundError('Campus', changes['campusId']);
      }

      const [updated] = await tx
        .update(assets)
        .set({
          ...(changes as Partial<AssetRow>),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(assets.id, id), eq(assets.version, version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This asset was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      return { asset: updated, previous: diffOf(existing, updated, Object.keys(changes)) };
    });
  }

  async archiveAsset(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<AssetRow> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadAsset(tx, institutionId, id);

      const [open] = await tx
        .select({ id: assetAssignments.id })
        .from(assetAssignments)
        .where(
          and(
            eq(assetAssignments.assetId, id),
            isNull(assetAssignments.returnedOn),
            isNull(assetAssignments.archivedAt),
          ),
        )
        .limit(1);
      if (open) {
        throw new ConflictError('Take the asset back before archiving it — custody is still open.');
      }

      const [archived] = await tx
        .update(assets)
        .set({
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(eq(assets.id, id))
        .returning();
      return archived!;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Assignments — custody
  // ══════════════════════════════════════════════════════════════════════════════════

  async listAssignments(
    institutionId: string,
    query: {
      sort?: string;
      assetId?: string;
      employeeId?: string;
      roomId?: string;
      departmentId?: string;
      openOnly: boolean;
      includeArchived: boolean;
    },
    page: OffsetPageRequest,
  ): Promise<OffsetPage<AssignmentRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(assetAssignments.institutionId, institutionId)];
      if (!query.includeArchived) filters.push(isNull(assetAssignments.archivedAt));
      if (query.assetId) filters.push(eq(assetAssignments.assetId, query.assetId));
      if (query.employeeId) filters.push(eq(assetAssignments.employeeId, query.employeeId));
      if (query.roomId) filters.push(eq(assetAssignments.roomId, query.roomId));
      if (query.departmentId) filters.push(eq(assetAssignments.departmentRef, query.departmentId));
      if (query.openOnly) filters.push(isNull(assetAssignments.returnedOn));

      const where = and(...filters);
      const orderBy = parseSort(query.sort, ASSET_ASSIGNMENT_SORT_FIELDS, {
        field: 'assignedOn',
        direction: 'desc',
      }).map((spec) => {
        const column = ASSIGNMENT_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(assetAssignments)
        .where(where)
        .orderBy(...orderBy, asc(assetAssignments.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(assetAssignments)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  /**
   * Hand the asset over. The service's open-assignment check produces the friendly 409;
   * the partial unique index `asset_assignments_open_key` is what actually makes two
   * clerks assigning the same projector at once impossible.
   */
  async createAssignment(
    principal: Principal,
    institutionId: string,
    input: CreateAssetAssignmentInput,
  ): Promise<AssignmentRow> {
    return this.db.runInTenant(async (tx) => {
      const asset = await this.loadAsset(tx, institutionId, input.assetId);
      if (asset.status !== 'in_store') {
        throw new ConflictError(
          `Only an asset in store can be assigned; ${asset.assetTag} is ${asset.status}.`,
        );
      }

      const [open] = await tx
        .select({ id: assetAssignments.id })
        .from(assetAssignments)
        .where(
          and(
            eq(assetAssignments.assetId, input.assetId),
            isNull(assetAssignments.returnedOn),
            isNull(assetAssignments.archivedAt),
          ),
        )
        .limit(1);
      if (open) {
        throw new ConflictError(
          `${asset.assetTag} is already out on an open assignment. Take it back first.`,
          { openAssignmentId: open.id },
        );
      }

      if (input.assigneeKind === 'employee') {
        const [employee] = await tx
          .select({ id: employees.id })
          .from(employees)
          .where(
            and(
              eq(employees.id, input.employeeId!),
              eq(employees.institutionId, institutionId),
              isNull(employees.archivedAt),
            ),
          )
          .limit(1);
        if (!employee) throw new NotFoundError('Employee', input.employeeId!);
      } else if (input.assigneeKind === 'room') {
        const [room] = await tx
          .select({ id: rooms.id })
          .from(rooms)
          .where(and(eq(rooms.id, input.roomId!), eq(rooms.institutionId, institutionId)))
          .limit(1);
        if (!room) throw new NotFoundError('Room', input.roomId!);
      } else {
        const [department] = await tx
          .select({ id: departments.id })
          .from(departments)
          .where(
            and(
              eq(departments.id, input.departmentId!),
              eq(departments.institutionId, institutionId),
            ),
          )
          .limit(1);
        if (!department) throw new NotFoundError('Department', input.departmentId!);
      }

      const [created] = await tx
        .insert(assetAssignments)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          assetId: input.assetId,
          assigneeKind: input.assigneeKind,
          employeeId: input.assigneeKind === 'employee' ? input.employeeId! : null,
          roomId: input.assigneeKind === 'room' ? input.roomId! : null,
          departmentRef: input.assigneeKind === 'department' ? input.departmentId! : null,
          assignedOn: input.assignedOn,
          assignedBy: principal.userId,
          conditionOut: input.conditionOut,
          notes: input.notes ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      await tx
        .update(assets)
        .set({
          status: 'assigned',
          version: asset.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(assets.id, asset.id));

      return created!;
    });
  }

  /** Take the asset back: who, when and in what condition are part of the record. */
  async returnAssignment(
    principal: Principal,
    institutionId: string,
    id: string,
    input: ReturnAssetAssignmentInput,
  ): Promise<AssignmentRow> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(assetAssignments)
        .where(
          and(
            eq(assetAssignments.id, id),
            eq(assetAssignments.institutionId, institutionId),
            isNull(assetAssignments.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Assignment', id);

      if (existing.returnedOn !== null) {
        throw new ConflictError('This assignment was already returned.', {
          returnedOn: existing.returnedOn,
        });
      }
      if (input.returnedOn < existing.assignedOn) {
        throw new ValidationError('The return cannot predate the assignment', [
          { path: 'returnedOn', message: `Assigned on ${existing.assignedOn}` },
        ]);
      }

      const [returned] = await tx
        .update(assetAssignments)
        .set({
          returnedOn: input.returnedOn,
          returnedBy: principal.userId,
          conditionIn: input.conditionIn,
          notes: input.notes ?? existing.notes,
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(assetAssignments.id, id), eq(assetAssignments.version, input.version)))
        .returning();

      if (!returned) {
        throw new ConflictError(
          'This assignment was changed by someone else while you were working. Reload and try again.',
          { expectedVersion: input.version, currentVersion: existing.version },
        );
      }

      // Back in store, in the condition it came back in.
      await tx
        .update(assets)
        .set({
          status: 'in_store',
          condition: input.conditionIn,
          version: sql`${assets.version} + 1`,
          updatedBy: principal.userId,
        })
        .where(eq(assets.id, existing.assetId));

      return returned;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Maintenance
  // ══════════════════════════════════════════════════════════════════════════════════

  async listMaintenance(
    institutionId: string,
    query: {
      sort?: string;
      assetId?: string;
      kind?: MaintenanceRow['kind'];
      includeArchived: boolean;
    },
    page: OffsetPageRequest,
  ): Promise<OffsetPage<MaintenanceRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(assetMaintenance.institutionId, institutionId)];
      if (!query.includeArchived) filters.push(isNull(assetMaintenance.archivedAt));
      if (query.assetId) filters.push(eq(assetMaintenance.assetId, query.assetId));
      if (query.kind) filters.push(eq(assetMaintenance.kind, query.kind));

      const where = and(...filters);
      const orderBy = parseSort(query.sort, ASSET_MAINTENANCE_SORT_FIELDS, {
        field: 'performedOn',
        direction: 'desc',
      }).map((spec) => {
        const column = MAINTENANCE_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(assetMaintenance)
        .where(where)
        .orderBy(...orderBy, asc(assetMaintenance.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(assetMaintenance)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async createMaintenance(
    principal: Principal,
    institutionId: string,
    input: CreateAssetMaintenanceInput,
  ): Promise<MaintenanceRow> {
    return this.db.runInTenant(async (tx) => {
      await this.loadAsset(tx, institutionId, input.assetId);

      const [created] = await tx
        .insert(assetMaintenance)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          assetId: input.assetId,
          kind: input.kind,
          performedOn: input.performedOn,
          cost: Money.fromDecimalString(input.cost).toDecimalString(),
          vendor: input.vendor ?? null,
          downtimeDays: input.downtimeDays,
          notes: input.notes ?? null,
          nextDueOn: input.nextDueOn ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  /** Everything due on or before a date — the preventive-maintenance worklist. */
  async maintenanceDueReport(
    institutionId: string,
    asOf: string | undefined,
  ): Promise<{ asOf: string; due: Array<MaintenanceRow & { assetTag: string; assetName: string }> }> {
    const cutoff = asOf ?? (todayInDhaka() as string);
    return this.db.runInTenant(async (tx) => {
      const rows = await tx
        .select({ record: assetMaintenance, assetTag: assets.assetTag, assetName: assets.name })
        .from(assetMaintenance)
        .innerJoin(assets, eq(assets.id, assetMaintenance.assetId))
        .where(
          and(
            eq(assetMaintenance.institutionId, institutionId),
            isNull(assetMaintenance.archivedAt),
            isNull(assets.archivedAt),
            lte(assetMaintenance.nextDueOn, cutoff),
            // A disposed or lost asset needs no servicing.
            inArray(assets.status, ['in_store', 'assigned', 'under_maintenance']),
          ),
        )
        .orderBy(asc(assetMaintenance.nextDueOn), asc(assetMaintenance.id));

      return {
        asOf: cutoff,
        due: rows.map((row) => ({
          ...row.record,
          assetTag: row.assetTag,
          assetName: row.assetName,
        })),
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Depreciation runs
  // ══════════════════════════════════════════════════════════════════════════════════

  async listRuns(
    institutionId: string,
    query: {
      sort?: string;
      status?: RunRow['status'];
      periodYear?: number;
      includeArchived: boolean;
    },
    page: OffsetPageRequest,
  ): Promise<OffsetPage<RunRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(depreciationRuns.institutionId, institutionId)];
      if (!query.includeArchived) filters.push(isNull(depreciationRuns.archivedAt));
      if (query.status) filters.push(eq(depreciationRuns.status, query.status));
      if (query.periodYear !== undefined) {
        filters.push(eq(depreciationRuns.periodYear, query.periodYear));
      }

      const where = and(...filters);
      const orderBy = parseSort(query.sort, DEPRECIATION_RUN_SORT_FIELDS, {
        field: 'createdAt',
        direction: 'desc',
      }).map((spec) => {
        const column = RUN_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(depreciationRuns)
        .where(where)
        .orderBy(...orderBy, asc(depreciationRuns.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(depreciationRuns)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  /**
   * Calculate one month's depreciation as a draft run.
   *
   * **Straight line** splits `purchase_cost - salvage_value` across the useful life in
   * months with `Money.allocate`, and this month's line is the part at this month's index
   * in that schedule. Because `allocate` distributes the remainder deterministically, the
   * parts across the whole life sum back to exactly the depreciable amount — no drift,
   * ever, and the final month lands the book value on the salvage value to the poisa.
   *
   * **Reducing balance** applies a fixed monthly rate — the double-declining convention,
   * `2 / life` per year, held as integer basis points so no float touches the money — to
   * the opening book value, clamped to the salvage floor, with the final scheduled month
   * absorbing whatever depreciable amount remains.
   *
   * Lines are written while the run is a draft — the only state
   * `depreciation_lines_run_must_be_draft` admits them in.
   */
  async createRun(
    principal: Principal,
    institutionId: string,
    input: CreateDepreciationRunInput,
  ): Promise<RunRow & { lines: LineRow[] }> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select({ id: depreciationRuns.id, status: depreciationRuns.status })
        .from(depreciationRuns)
        .where(
          and(
            eq(depreciationRuns.institutionId, institutionId),
            eq(depreciationRuns.periodYear, input.periodYear),
            eq(depreciationRuns.periodMonth, input.periodMonth),
            ne(depreciationRuns.status, 'cancelled'),
          ),
        )
        .limit(1);
      if (existing) {
        throw new ConflictError(
          `A depreciation run for ${input.periodYear}-${String(input.periodMonth).padStart(2, '0')} already exists (${existing.status}). Cancel the draft to recalculate.`,
          { existingRunId: existing.id },
        );
      }

      const candidates = await tx
        .select()
        .from(assets)
        .where(
          and(
            eq(assets.institutionId, institutionId),
            isNull(assets.archivedAt),
            ne(assets.depreciationMethod, 'none'),
            inArray(assets.status, ['in_store', 'assigned', 'under_maintenance']),
          ),
        )
        .orderBy(asc(assets.assetTag), asc(assets.id));

      const computed: Array<{ asset: AssetRow; opening: Money; depreciation: Money }> = [];
      for (const asset of candidates) {
        const depreciation = this.monthlyDepreciation(asset, input.periodYear, input.periodMonth);
        if (depreciation === null || !depreciation.isPositive()) continue;
        computed.push({
          asset,
          opening: Money.fromDecimalString(asset.bookValue),
          depreciation,
        });
      }

      if (computed.length === 0) {
        throw new ConflictError(
          `No asset has depreciation to record for ${input.periodYear}-${String(input.periodMonth).padStart(2, '0')}.`,
        );
      }

      const total = Money.sum(computed.map((entry) => entry.depreciation));

      const runId = uuidv7();
      const [run] = await tx
        .insert(depreciationRuns)
        .values({
          id: runId,
          tenantId: principal.tenantId!,
          institutionId,
          periodYear: input.periodYear,
          periodMonth: input.periodMonth,
          status: 'draft',
          totalDepreciation: total.toDecimalString(),
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      const lines = await tx
        .insert(depreciationLines)
        .values(
          computed.map((entry) => ({
            id: uuidv7(),
            tenantId: principal.tenantId!,
            institutionId,
            runId,
            assetId: entry.asset.id,
            openingBookValue: entry.opening.toDecimalString(),
            depreciation: entry.depreciation.toDecimalString(),
            closingBookValue: entry.opening.minus(entry.depreciation).toDecimalString(),
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })),
        )
        .returning();

      return { ...run!, lines };
    });
  }

  async getRun(institutionId: string, id: string): Promise<RunRow & { lines: LineRow[] }> {
    return this.db.runInTenant(async (tx) => {
      const run = await this.loadRun(tx, institutionId, id);
      const lines = await this.loadRunLines(tx, id);
      return { ...run, lines };
    });
  }

  /**
   * Post a draft run: per-asset accumulated depreciation and book value move together
   * (the derivation constraint admits nothing else), ONE balanced journal entry — debit
   * depreciation expense, credit accumulated depreciation, for exactly the run total —
   * is posted through the ledger, and the run flips to `posted`, all in one transaction.
   * A refused posting (closed period, header account) rolls every asset back.
   */
  async postRun(
    principal: Principal,
    institutionId: string,
    id: string,
    input: PostDepreciationRunInput,
  ): Promise<RunRow & { lines: LineRow[] }> {
    const context = currentContext();

    return this.db.runInTenant(async (tx) => {
      const run = await this.loadRun(tx, institutionId, id);
      if (run.status !== 'draft') {
        throw new ConflictError(
          `Only a draft run can be posted; this run is ${run.status}.`,
        );
      }
      if (run.version !== input.version) {
        throw new ConflictError(
          'This run was changed by someone else while you were posting it. Reload and try again.',
          { expectedVersion: input.version, currentVersion: run.version },
        );
      }

      const lines = await this.loadRunLines(tx, id);
      if (lines.length === 0) {
        throw new ConflictError('This run has no lines to post.');
      }

      const expenseAccount = await this.loadAccount(tx, institutionId, input.expenseAccountId);
      if (expenseAccount.type !== 'expense') {
        throw new ValidationError('Depreciation is charged to an expense account', [
          { path: 'expenseAccountId', message: 'Choose an account of type "expense"' },
        ]);
      }
      const accumulatedAccount = await this.loadAccount(
        tx,
        institutionId,
        input.accumulatedDepreciationAccountId,
      );
      if (accumulatedAccount.type !== 'asset') {
        throw new ValidationError(
          'Accumulated depreciation is a contra-asset account (type "asset")',
          [{ path: 'accumulatedDepreciationAccountId', message: 'Choose an asset-type account' }],
        );
      }

      // The assets move first, the ledger last: if the ledger refuses, the transaction
      // rolls the register back with it — which is exactly what the atomicity test proves.
      const total = Money.fromDecimalString(run.totalDepreciation);
      const lineAssets = await tx
        .select()
        .from(assets)
        .where(
          inArray(
            assets.id,
            lines.map((line) => line.assetId),
          ),
        );
      const assetById = new Map(lineAssets.map((asset) => [asset.id, asset]));

      for (const line of lines) {
        const asset = assetById.get(line.assetId);
        if (!asset) throw new NotFoundError('Asset', line.assetId);

        const accumulated = Money.fromDecimalString(asset.accumulatedDepreciation).plus(
          Money.fromDecimalString(line.depreciation),
        );
        const bookValue = Money.fromDecimalString(asset.purchaseCost).minus(accumulated);
        // One statement moves the pair, so `assets_book_value_derived` holds at every step.
        await tx
          .update(assets)
          .set({
            accumulatedDepreciation: accumulated.toDecimalString(),
            bookValue: bookValue.toDecimalString(),
            version: asset.version + 1,
            updatedBy: principal.userId,
          })
          .where(eq(assets.id, asset.id));
      }

      const period = `${run.periodYear}-${String(run.periodMonth).padStart(2, '0')}`;
      const entryDate = input.entryDate ?? lastDayOfMonth(run.periodYear, run.periodMonth);
      const { entry } = await this.ledger.post(tx, {
        tenantId: principal.tenantId!,
        institutionId,
        actorUserId: principal.userId,
        entryDate,
        description: `Depreciation for ${period}`,
        referenceType: 'depreciation_run',
        referenceId: run.id,
        sourceModule: 'assets',
        isSystemGenerated: true,
        lines: [
          {
            accountId: input.expenseAccountId,
            debit: total.toDecimalString(),
            description: `Depreciation expense for ${period}`,
          },
          {
            accountId: input.accumulatedDepreciationAccountId,
            credit: total.toDecimalString(),
            description: `Accumulated depreciation for ${period}`,
          },
        ],
      });

      const [posted] = await tx
        .update(depreciationRuns)
        .set({
          status: 'posted',
          postedBy: principal.userId,
          postedAt: new Date(),
          journalEntryId: entry.id,
          version: run.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(depreciationRuns.id, id), eq(depreciationRuns.version, input.version)))
        .returning();

      if (!posted) {
        throw new ConflictError(
          'This run was changed by someone else while you were posting it. Reload and try again.',
          { expectedVersion: input.version, currentVersion: run.version },
        );
      }

      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'approve',
        module: 'assets',
        resourceType: 'depreciation_run',
        resourceId: id,
        resourceLabel: `Depreciation ${period}`,
        previousValue: { status: 'draft' },
        // Money as strings, never numbers — an audit record read back as a float would be
        // a worse lie than no record at all.
        newValue: {
          status: 'posted',
          totalDepreciation: run.totalDepreciation,
          assetCount: lines.length,
          journalEntryId: entry.id,
          journalEntryNumber: entry.entryNumber,
        },
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      return { ...posted, lines };
    });
  }

  /** Cancel a draft. A posted run accepts no change — correct it with a reversing entry. */
  async cancelRun(
    principal: Principal,
    institutionId: string,
    id: string,
    input: { reason: string; version: number },
  ): Promise<RunRow> {
    return this.db.runInTenant(async (tx) => {
      const run = await this.loadRun(tx, institutionId, id);
      if (run.status !== 'draft') {
        throw new ConflictError(`Only a draft run can be cancelled; this run is ${run.status}.`);
      }

      const [cancelled] = await tx
        .update(depreciationRuns)
        .set({
          status: 'cancelled',
          cancelledBy: principal.userId,
          cancelledAt: new Date(),
          cancelReason: input.reason,
          version: run.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(depreciationRuns.id, id), eq(depreciationRuns.version, input.version)))
        .returning();

      if (!cancelled) {
        throw new ConflictError(
          'This run was changed by someone else while you were working. Reload and try again.',
          { expectedVersion: input.version, currentVersion: run.version },
        );
      }
      return cancelled;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Disposals
  // ══════════════════════════════════════════════════════════════════════════════════

  async listDisposals(
    institutionId: string,
    query: {
      sort?: string;
      assetId?: string;
      method?: DisposalRow['method'];
      pendingOnly: boolean;
      includeArchived: boolean;
    },
    page: OffsetPageRequest,
  ): Promise<OffsetPage<DisposalRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(assetDisposals.institutionId, institutionId)];
      if (!query.includeArchived) filters.push(isNull(assetDisposals.archivedAt));
      if (query.assetId) filters.push(eq(assetDisposals.assetId, query.assetId));
      if (query.method) filters.push(eq(assetDisposals.method, query.method));
      if (query.pendingOnly) filters.push(isNull(assetDisposals.approvedBy));

      const where = and(...filters);
      const orderBy = parseSort(query.sort, ASSET_DISPOSAL_SORT_FIELDS, {
        field: 'createdAt',
        direction: 'desc',
      }).map((spec) => {
        const column = DISPOSAL_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(assetDisposals)
        .where(where)
        .orderBy(...orderBy, asc(assetDisposals.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(assetDisposals)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  /** Record a disposal request. The asset does not change until a second person approves. */
  async createDisposal(
    principal: Principal,
    institutionId: string,
    input: CreateAssetDisposalInput,
  ): Promise<DisposalRow> {
    return this.db.runInTenant(async (tx) => {
      const asset = await this.loadAsset(tx, institutionId, input.assetId);
      if (asset.status === 'disposed' || asset.status === 'lost') {
        throw new ConflictError(`${asset.assetTag} is already ${asset.status}.`);
      }
      if (asset.status === 'assigned') {
        throw new ConflictError(
          `${asset.assetTag} is out on assignment. Take it back before disposing of it.`,
        );
      }

      const [open] = await tx
        .select({ id: assetDisposals.id })
        .from(assetDisposals)
        .where(
          and(
            eq(assetDisposals.assetId, input.assetId),
            isNull(assetDisposals.approvedBy),
            isNull(assetDisposals.archivedAt),
          ),
        )
        .limit(1);
      if (open) {
        throw new ConflictError(
          `${asset.assetTag} already has a disposal request awaiting approval.`,
          { openDisposalId: open.id },
        );
      }

      const [created] = await tx
        .insert(assetDisposals)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          assetId: input.assetId,
          disposedOn: input.disposedOn,
          method: input.method,
          proceeds: Money.fromDecimalString(input.proceeds).toDecimalString(),
          reason: input.reason,
          requestedBy: principal.userId,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  /**
   * Approve a disposal — a **different** person from the requester, whatever permissions
   * either holds. The service refuses first for the friendly 409;
   * `asset_disposals_distinct_approver` refuses again on the data itself.
   *
   * With a `ledger` block, the disposal entry posts in the same transaction: write the
   * cost off the asset account, recapture accumulated depreciation, bank any proceeds,
   * and book the balancing gain or loss. Without one, the asset is still retired and
   * `journal_entry_id` stays null for a later manual entry.
   */
  async approveDisposal(
    principal: Principal,
    institutionId: string,
    id: string,
    input: ApproveAssetDisposalInput,
  ): Promise<{ disposal: DisposalRow; asset: AssetRow }> {
    const context = currentContext();

    return this.db.runInTenant(async (tx) => {
      const [disposal] = await tx
        .select()
        .from(assetDisposals)
        .where(
          and(
            eq(assetDisposals.id, id),
            eq(assetDisposals.institutionId, institutionId),
            isNull(assetDisposals.archivedAt),
          ),
        )
        .limit(1);
      if (!disposal) throw new NotFoundError('Disposal request', id);

      if (disposal.approvedBy !== null) {
        throw new ConflictError('This disposal has already been approved.', {
          approvedBy: disposal.approvedBy,
        });
      }
      if (disposal.version !== input.version) {
        throw new ConflictError(
          'This disposal was changed by someone else while you were working. Reload and try again.',
          { expectedVersion: input.version, currentVersion: disposal.version },
        );
      }
      if (disposal.requestedBy === principal.userId) {
        throw new ConflictError(
          'A disposal must be approved by someone other than the person who requested it.',
        );
      }

      const asset = await this.loadAsset(tx, institutionId, disposal.assetId);
      if (asset.status === 'disposed' || asset.status === 'lost') {
        throw new ConflictError(`${asset.assetTag} is already ${asset.status}.`);
      }

      let journalEntryId: string | null = null;
      if (input.ledger) {
        journalEntryId = await this.postDisposalEntry(tx, principal, institutionId, {
          disposal,
          asset,
          ledger: input.ledger,
        });
      }

      const [approved] = await tx
        .update(assetDisposals)
        .set({
          approvedBy: principal.userId,
          approvedAt: new Date(),
          journalEntryId,
          version: disposal.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(assetDisposals.id, id))
        .returning();

      const [retired] = await tx
        .update(assets)
        .set({
          status: disposal.method === 'lost' ? 'lost' : 'disposed',
          version: asset.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(assets.id, asset.id))
        .returning();

      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'approve',
        module: 'assets',
        resourceType: 'asset_disposal',
        resourceId: id,
        resourceLabel: asset.assetTag,
        previousValue: { assetStatus: asset.status, approvedBy: null },
        newValue: {
          assetStatus: retired!.status,
          method: disposal.method,
          proceeds: disposal.proceeds,
          bookValueAtDisposal: asset.bookValue,
          requestedBy: disposal.requestedBy,
          approvedBy: principal.userId,
          journalEntryId,
        },
        reason: disposal.reason,
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      return { disposal: approved!, asset: retired! };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Internals
  // ══════════════════════════════════════════════════════════════════════════════════

  /**
   * One asset's depreciation for one calendar month, or null when the month is outside
   * the asset's schedule. All arithmetic is `Money`; the only numbers are month indexes
   * and integer basis points.
   */
  private monthlyDepreciation(asset: AssetRow, year: number, month: number): Money | null {
    const lifeMonths = (asset.usefulLifeYears ?? 0) * 12;
    if (lifeMonths <= 0) return null;

    const purchaseYear = Number(asset.purchasedOn.slice(0, 4));
    const purchaseMonth = Number(asset.purchasedOn.slice(5, 7));
    const monthIndex = (year - purchaseYear) * 12 + (month - purchaseMonth);
    if (monthIndex < 0 || monthIndex >= lifeMonths) return null;

    const cost = Money.fromDecimalString(asset.purchaseCost);
    const salvage = Money.fromDecimalString(asset.salvageValue);
    const accumulated = Money.fromDecimalString(asset.accumulatedDepreciation);
    const remaining = cost.minus(salvage).minus(accumulated);
    if (!remaining.isPositive()) return null;

    if (asset.depreciationMethod === 'straight_line') {
      // The full schedule, recomputed identically every month: allocate() hands the
      // remainder out deterministically, so schedule[i] is stable and the parts sum to
      // exactly cost - salvage across the life.
      const schedule = cost.minus(salvage).split(lifeMonths);
      const scheduled = schedule[monthIndex]!;
      return Money.min(scheduled, remaining);
    }

    // Reducing balance: 2/life per year, in integer basis points, applied monthly to the
    // opening book value. The final scheduled month absorbs the remainder so the asset
    // still lands exactly on its salvage value.
    if (monthIndex === lifeMonths - 1) return remaining;
    const monthlyBasisPoints = Math.max(1, Math.round(20_000 / lifeMonths));
    const openingBook = cost.minus(accumulated);
    return Money.min(openingBook.percentage(monthlyBasisPoints), remaining);
  }

  /** Post the disposal entry; returns the journal entry id. Balanced by construction. */
  private async postDisposalEntry(
    tx: Tx,
    principal: Principal,
    institutionId: string,
    input: {
      disposal: DisposalRow;
      asset: AssetRow;
      ledger: NonNullable<ApproveAssetDisposalInput['ledger']>;
    },
  ): Promise<string> {
    const { disposal, asset, ledger } = input;

    const cost = Money.fromDecimalString(asset.purchaseCost);
    const accumulated = Money.fromDecimalString(asset.accumulatedDepreciation);
    const bookValue = Money.fromDecimalString(asset.bookValue);
    const proceeds = Money.fromDecimalString(disposal.proceeds);

    if (!cost.isPositive()) {
      throw new ConflictError(
        `${asset.assetTag} has no cost on the books; there is nothing to post. Approve without a ledger block.`,
      );
    }

    const assetAccount = await this.loadAccount(tx, institutionId, ledger.assetAccountId);
    if (assetAccount.type !== 'asset') {
      throw new ValidationError('The asset-cost account must be of type "asset"', [
        { path: 'ledger.assetAccountId', message: 'Choose an asset-type account' },
      ]);
    }
    const accumulatedAccount = await this.loadAccount(
      tx,
      institutionId,
      ledger.accumulatedDepreciationAccountId,
    );
    if (accumulatedAccount.type !== 'asset') {
      throw new ValidationError(
        'Accumulated depreciation is a contra-asset account (type "asset")',
        [
          {
            path: 'ledger.accumulatedDepreciationAccountId',
            message: 'Choose an asset-type account',
          },
        ],
      );
    }
    await this.loadAccount(tx, institutionId, ledger.gainLossAccountId);

    if (proceeds.isPositive()) {
      if (!ledger.cashAccountId) {
        throw new ValidationError('This disposal carries proceeds; name the account they bank to', [
          { path: 'ledger.cashAccountId', message: 'Choose a cash-equivalent account' },
        ]);
      }
      const cashAccount = await this.loadAccount(tx, institutionId, ledger.cashAccountId);
      if (!cashAccount.isCashEquivalent) {
        throw new ValidationError('Disposal proceeds bank to a cash or bank account', [
          { path: 'ledger.cashAccountId', message: 'Choose an account marked as cash-equivalent' },
        ]);
      }
    }

    // Debits: accumulated depreciation recaptured, proceeds banked, and any loss.
    // Credits: the cost written off, and any gain. Balanced because
    // cost = accumulated + book and gain/loss = proceeds - book.
    const lines: LedgerLineInput[] = [];
    if (accumulated.isPositive()) {
      lines.push({
        accountId: ledger.accumulatedDepreciationAccountId,
        debit: accumulated.toDecimalString(),
        description: `Accumulated depreciation recaptured on ${asset.assetTag}`,
      });
    }
    if (proceeds.isPositive()) {
      lines.push({
        accountId: ledger.cashAccountId!,
        debit: proceeds.toDecimalString(),
        description: `Proceeds from disposal of ${asset.assetTag}`,
      });
    }
    lines.push({
      accountId: ledger.assetAccountId,
      credit: cost.toDecimalString(),
      description: `Cost of ${asset.assetTag} written off`,
    });
    const gainOrLoss = proceeds.minus(bookValue);
    if (gainOrLoss.isPositive()) {
      lines.push({
        accountId: ledger.gainLossAccountId,
        credit: gainOrLoss.toDecimalString(),
        description: `Gain on disposal of ${asset.assetTag}`,
      });
    } else if (gainOrLoss.isNegative()) {
      lines.push({
        accountId: ledger.gainLossAccountId,
        debit: gainOrLoss.abs().toDecimalString(),
        description: `Loss on disposal of ${asset.assetTag}`,
      });
    }

    const { entry } = await this.ledger.post(tx, {
      tenantId: principal.tenantId!,
      institutionId,
      actorUserId: principal.userId,
      entryDate: ledger.entryDate ?? disposal.disposedOn,
      description: `Disposal of ${asset.assetTag} (${disposal.method})`,
      referenceType: 'asset_disposal',
      referenceId: disposal.id,
      sourceModule: 'assets',
      isSystemGenerated: true,
      lines,
    });
    return entry.id;
  }

  private async loadCategory(tx: Tx, institutionId: string, id: string): Promise<CategoryRow> {
    const [category] = await tx
      .select()
      .from(assetCategories)
      .where(
        and(
          eq(assetCategories.id, id),
          eq(assetCategories.institutionId, institutionId),
          isNull(assetCategories.archivedAt),
        ),
      )
      .limit(1);
    if (!category) throw new NotFoundError('Asset category', id);
    return category;
  }

  private async loadAsset(tx: Tx, institutionId: string, id: string): Promise<AssetRow> {
    const [asset] = await tx
      .select()
      .from(assets)
      .where(
        and(eq(assets.id, id), eq(assets.institutionId, institutionId), isNull(assets.archivedAt)),
      )
      .limit(1);
    if (!asset) throw new NotFoundError('Asset', id);
    return asset;
  }

  private async loadRun(tx: Tx, institutionId: string, id: string): Promise<RunRow> {
    const [run] = await tx
      .select()
      .from(depreciationRuns)
      .where(
        and(
          eq(depreciationRuns.id, id),
          eq(depreciationRuns.institutionId, institutionId),
          isNull(depreciationRuns.archivedAt),
        ),
      )
      .limit(1);
    if (!run) throw new NotFoundError('Depreciation run', id);
    return run;
  }

  private async loadRunLines(tx: Tx, runId: string): Promise<LineRow[]> {
    return tx
      .select()
      .from(depreciationLines)
      .where(and(eq(depreciationLines.runId, runId), isNull(depreciationLines.archivedAt)))
      .orderBy(asc(depreciationLines.id));
  }

  private async loadAccount(
    tx: Tx,
    institutionId: string,
    id: string,
  ): Promise<typeof chartOfAccounts.$inferSelect> {
    const [account] = await tx
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
    if (!account) throw new NotFoundError('Account', id);
    return account;
  }
}

/** The keys the caller changed, valued as they were before — for the audit trail. */
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

/** The last calendar day of a month, as a YYYY-MM-DD string. No timezone arithmetic. */
function lastDayOfMonth(year: number, month: number): string {
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
