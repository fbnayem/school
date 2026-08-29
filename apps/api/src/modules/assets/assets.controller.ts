/**
 * Asset endpoints (Phase 20): the fixed-asset register.
 *
 * Every route is `@InstitutionScoped()`: an asset register belongs to one institution, and
 * a group administrator running three schools has no safe default. The header is required
 * by the tenant guard rather than guessed here.
 *
 * The permission split, from `packages/permissions/src/catalog.ts`:
 *
 *   assets.view                — read the register, custody, maintenance, runs, disposals
 *   assets.manage              — maintain it: categories, assets, depreciation, disposals
 *   assets.assign              — custody: hand an asset over and take it back
 *   assets.maintenance.manage  — record maintenance work
 *
 * Posting a depreciation run and approving a disposal *should* each carry their own
 * permission (`assets.depreciation.post` and `assets.disposal.approve`, mirroring
 * `accounting.journal.post`) so the person who calculates cannot also post and the person
 * who requests cannot also approve. Neither string exists in the catalog, so both routes
 * use `assets.manage` and the service enforces the separation on the data instead: a
 * disposal's approver can never be its requester, whoever holds the permission — and
 * migration 0026's `asset_disposals_distinct_approver` restates that refusal on the row.
 *
 * Route order matters: Nest matches in declaration order, so the literal segments
 * (`categories`, `assignments`, `maintenance`, `depreciation-runs`, `disposals`) are
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
  approveAssetDisposalSchema,
  assetArchiveSchema,
  assetMaintenanceDueQuerySchema,
  cancelDepreciationRunSchema,
  createAssetAssignmentSchema,
  createAssetCategorySchema,
  createAssetDisposalSchema,
  createAssetMaintenanceSchema,
  createAssetSchema,
  createDepreciationRunSchema,
  idParamSchema,
  listAssetAssignmentsSchema,
  listAssetCategoriesSchema,
  listAssetDisposalsSchema,
  listAssetMaintenanceSchema,
  listAssetsSchema,
  listDepreciationRunsSchema,
  postDepreciationRunSchema,
  returnAssetAssignmentSchema,
  updateAssetCategorySchema,
  updateAssetSchema,
} from '@shikkha/validation';
import { AssetsService } from './assets.service';
import {
  Audited,
  CurrentUser,
  InstitutionScoped,
  RequirePermissions,
} from '../../common/decorators';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { currentContext } from '../../common/context/request-context';

@ApiTags('assets')
@Controller('assets')
@InstitutionScoped()
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  // ── Categories ──────────────────────────────────────────────────────────────────────

  @Get('categories')
  @RequirePermissions('assets.view')
  @ApiOperation({ summary: 'List the asset taxonomy' })
  async listCategories(
    @Query(zodQuery(listAssetCategoriesSchema)) query: z.infer<typeof listAssetCategoriesSchema>,
  ) {
    return this.assets.listCategories(requireInstitution(), query, normalizeOffsetPage(query));
  }

  @Post('categories')
  @RequirePermissions('assets.manage')
  @Audited({
    module: 'assets',
    resourceType: 'asset_category',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create an asset category' })
  async createCategory(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createAssetCategorySchema)) body: z.infer<typeof createAssetCategorySchema>,
  ) {
    return this.assets.createCategory(principal, requireInstitution(), body);
  }

  @Patch('categories/:id')
  @RequirePermissions('assets.manage')
  @Audited({
    module: 'assets',
    resourceType: 'asset_category',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update an asset category' })
  async updateCategory(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateAssetCategorySchema)) body: z.infer<typeof updateAssetCategorySchema>,
  ) {
    const result = await this.assets.updateCategory(
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
  @RequirePermissions('assets.manage')
  @Audited({
    module: 'assets',
    resourceType: 'asset_category',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive an asset category' })
  async archiveCategory(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(assetArchiveSchema)) body: { reason: string },
  ) {
    return this.assets.archiveCategory(principal, requireInstitution(), params.id, body.reason);
  }

  // ── Assignments — custody ───────────────────────────────────────────────────────────

  @Get('assignments')
  @RequirePermissions('assets.view')
  @ApiOperation({ summary: 'List assignments — the custody history and the live map' })
  async listAssignments(
    @Query(zodQuery(listAssetAssignmentsSchema))
    query: z.infer<typeof listAssetAssignmentsSchema>,
  ) {
    return this.assets.listAssignments(requireInstitution(), query, normalizeOffsetPage(query));
  }

  /**
   * One open assignment per asset: the service's check produces the friendly 409, and the
   * partial unique index `asset_assignments_open_key` makes a concurrent double-issue a
   * database error rather than a race.
   */
  @Post('assignments')
  @RequirePermissions('assets.assign')
  @Audited({
    module: 'assets',
    resourceType: 'asset_assignment',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Hand an asset to an employee, room or department' })
  async createAssignment(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createAssetAssignmentSchema)) body: z.infer<typeof createAssetAssignmentSchema>,
  ) {
    return this.assets.createAssignment(principal, requireInstitution(), body);
  }

  @Post('assignments/:id/return')
  @RequirePermissions('assets.assign')
  @Audited({
    module: 'assets',
    resourceType: 'asset_assignment',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Take an assigned asset back into store' })
  async returnAssignment(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(returnAssetAssignmentSchema)) body: z.infer<typeof returnAssetAssignmentSchema>,
  ) {
    return this.assets.returnAssignment(principal, requireInstitution(), params.id, body);
  }

  // ── Maintenance ─────────────────────────────────────────────────────────────────────

  /** Declared before `maintenance` reads with `:id` would — and there are none, by design. */
  @Get('maintenance/due')
  @RequirePermissions('assets.view')
  @ApiOperation({ summary: 'Every asset with maintenance due on or before a date' })
  async maintenanceDue(
    @Query(zodQuery(assetMaintenanceDueQuerySchema))
    query: z.infer<typeof assetMaintenanceDueQuerySchema>,
  ) {
    return this.assets.maintenanceDueReport(requireInstitution(), query.asOf);
  }

  @Get('maintenance')
  @RequirePermissions('assets.view')
  @ApiOperation({ summary: 'List maintenance records' })
  async listMaintenance(
    @Query(zodQuery(listAssetMaintenanceSchema)) query: z.infer<typeof listAssetMaintenanceSchema>,
  ) {
    return this.assets.listMaintenance(requireInstitution(), query, normalizeOffsetPage(query));
  }

  @Post('maintenance')
  @RequirePermissions('assets.maintenance.manage')
  @Audited({
    module: 'assets',
    resourceType: 'asset_maintenance',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Record maintenance work on an asset' })
  async createMaintenance(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createAssetMaintenanceSchema)) body: z.infer<typeof createAssetMaintenanceSchema>,
  ) {
    return this.assets.createMaintenance(principal, requireInstitution(), body);
  }

  // ── Depreciation runs ───────────────────────────────────────────────────────────────

  @Get('depreciation-runs')
  @RequirePermissions('assets.view')
  @ApiOperation({ summary: 'List depreciation runs' })
  async listRuns(
    @Query(zodQuery(listDepreciationRunsSchema)) query: z.infer<typeof listDepreciationRunsSchema>,
  ) {
    return this.assets.listRuns(requireInstitution(), query, normalizeOffsetPage(query));
  }

  /**
   * Calculates a **draft**: per-asset lines are computed and written, and nothing touches
   * the assets or the ledger until the separate post below. Audited even though it mutates
   * no asset — it materialises the whole register's figures in bulk.
   */
  @Post('depreciation-runs')
  @RequirePermissions('assets.manage')
  @Audited({
    module: 'assets',
    resourceType: 'depreciation_run',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Calculate a month’s depreciation as a draft run' })
  async createRun(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createDepreciationRunSchema)) body: z.infer<typeof createDepreciationRunSchema>,
  ) {
    return this.assets.createRun(principal, requireInstitution(), body);
  }

  @Get('depreciation-runs/:id')
  @RequirePermissions('assets.view')
  @ApiOperation({ summary: 'One depreciation run with its per-asset lines' })
  async getRun(@Param(zodParam(idParamSchema)) params: { id: string }) {
    return this.assets.getRun(requireInstitution(), params.id);
  }

  /**
   * The moment a run becomes immutable. See the file header: this should carry a distinct
   * `assets.depreciation.post`, which does not exist in the permission catalog yet.
   *
   * The service writes the substantive audit record (with the run's total and the journal
   * entry it wrote) inside the business transaction.
   */
  @Post('depreciation-runs/:id/post')
  @RequirePermissions('assets.manage')
  @Audited({
    module: 'assets',
    resourceType: 'depreciation_run',
    action: 'approve',
    resourceIdFrom: 'param:id',
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Post a draft run: one balanced journal entry, atomically' })
  async postRun(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(postDepreciationRunSchema)) body: z.infer<typeof postDepreciationRunSchema>,
  ) {
    return this.assets.postRun(principal, requireInstitution(), params.id, body);
  }

  @Post('depreciation-runs/:id/cancel')
  @RequirePermissions('assets.manage')
  @Audited({
    module: 'assets',
    resourceType: 'depreciation_run',
    action: 'update',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Cancel a draft run so the period can be recalculated' })
  async cancelRun(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(cancelDepreciationRunSchema)) body: z.infer<typeof cancelDepreciationRunSchema>,
  ) {
    return this.assets.cancelRun(principal, requireInstitution(), params.id, body);
  }

  // ── Disposals ───────────────────────────────────────────────────────────────────────

  @Get('disposals')
  @RequirePermissions('assets.view')
  @ApiOperation({ summary: 'List disposal requests' })
  async listDisposals(
    @Query(zodQuery(listAssetDisposalsSchema)) query: z.infer<typeof listAssetDisposalsSchema>,
  ) {
    return this.assets.listDisposals(requireInstitution(), query, normalizeOffsetPage(query));
  }

  @Post('disposals')
  @RequirePermissions('assets.manage')
  @Audited({
    module: 'assets',
    resourceType: 'asset_disposal',
    action: 'create',
    resourceIdFrom: 'response:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Request the disposal of an asset' })
  async createDisposal(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createAssetDisposalSchema)) body: z.infer<typeof createAssetDisposalSchema>,
  ) {
    return this.assets.createDisposal(principal, requireInstitution(), body);
  }

  /**
   * The two-person rule: the service refuses the requester as approver whatever
   * permissions they hold, and `asset_disposals_distinct_approver` refuses it again on
   * the data. The service writes the audit record inside the approving transaction.
   */
  @Post('disposals/:id/approve')
  @RequirePermissions('assets.manage')
  @Audited({
    module: 'assets',
    resourceType: 'asset_disposal',
    action: 'approve',
    resourceIdFrom: 'param:id',
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Approve a disposal — a different person from the requester' })
  async approveDisposal(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(approveAssetDisposalSchema)) body: z.infer<typeof approveAssetDisposalSchema>,
  ) {
    return this.assets.approveDisposal(principal, requireInstitution(), params.id, body);
  }

  // ── Assets — the register itself (the `:id` routes come last) ──────────────────────

  @Get()
  @RequirePermissions('assets.view')
  @ApiOperation({ summary: 'List the asset register' })
  async listAssets(@Query(zodQuery(listAssetsSchema)) query: z.infer<typeof listAssetsSchema>) {
    return this.assets.listAssets(requireInstitution(), query, normalizeOffsetPage(query));
  }

  @Post()
  @RequirePermissions('assets.manage')
  @Audited({
    module: 'assets',
    resourceType: 'asset',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Register an asset (opens at book value = purchase cost)' })
  async createAsset(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createAssetSchema)) body: z.infer<typeof createAssetSchema>,
  ) {
    return this.assets.createAsset(principal, requireInstitution(), body);
  }

  @Get(':id')
  @RequirePermissions('assets.view')
  @ApiOperation({ summary: 'One asset with its open assignment' })
  async getAsset(@Param(zodParam(idParamSchema)) params: { id: string }) {
    return this.assets.getAsset(requireInstitution(), params.id);
  }

  @Patch(':id')
  @RequirePermissions('assets.manage')
  @Audited({
    module: 'assets',
    resourceType: 'asset',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update an asset’s identity and custody details' })
  async updateAsset(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateAssetSchema)) body: z.infer<typeof updateAssetSchema>,
  ) {
    const result = await this.assets.updateAsset(principal, requireInstitution(), params.id, body);
    return { ...result.asset, __audit: { previousValue: result.previous, newValue: body } };
  }

  @Post(':id/archive')
  @RequirePermissions('assets.manage')
  @Audited({
    module: 'assets',
    resourceType: 'asset',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive an asset (its history stays in the register)' })
  async archiveAsset(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(assetArchiveSchema)) body: { reason: string },
  ) {
    return this.assets.archiveAsset(principal, requireInstitution(), params.id, body.reason);
  }
}

/**
 * `@InstitutionScoped()` makes the tenant guard require and validate the header; this is
 * the belt-and-braces read, because `currentContext()` returns `string | null` and a
 * service that received `null` would silently query across institutions.
 */
function requireInstitution(): string {
  const institutionId = currentContext()?.institutionId;
  if (!institutionId) {
    throw new BadRequestException(
      'Send the x-institution-id header to indicate which institution this register belongs to.',
    );
  }
  return institutionId;
}
