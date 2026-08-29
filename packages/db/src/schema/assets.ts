/**
 * Asset management (Phase 20): the fixed-asset register.
 *
 * The invariants that matter here are financial, so — as in accounting (0018) — they are
 * enforced in the **database**, not only in the service:
 *
 *  1. **`book_value` is derived, never asserted.** A check constraint
 *     (`assets_book_value_derived`) refuses any row where
 *     `book_value <> purchase_cost - accumulated_depreciation`.
 *  2. **An asset never depreciates below its salvage value.**
 *     `assets_accumulated_within_depreciable` refuses
 *     `accumulated_depreciation > purchase_cost - salvage_value`.
 *  3. **One open assignment per asset.** A partial unique index
 *     (`asset_assignments_open_key`) makes a second `returned_on IS NULL` row a database
 *     error, whatever the service does.
 *  4. **A depreciation run happens once per (institution, year, month)** unless cancelled —
 *     `depreciation_runs_period_key` is partial on `status <> 'cancelled'`.
 *  5. **A posted depreciation run is immutable.** Triggers refuse UPDATE and DELETE on a
 *     posted run and any mutation of its lines, the same philosophy as posted journal
 *     entries. Posting writes one balanced journal entry through `LedgerService.post`
 *     inside the same transaction, so the run and its ledger effect commit together.
 *  6. **Disposal is approved by a second person.** `asset_disposals_distinct_approver`
 *     refuses `approved_by = requested_by` on the data itself.
 *  7. **Money is `numeric(14, 2)`**, parsed only by `Money.fromDecimalString` (ADR-004).
 *
 * Nothing here is ever hard-deleted: assets are archived or disposed (a status change with
 * full history), runs are cancelled, and DELETE is revoked from the application role.
 *
 * `assets.source_reference` is a bare uuid, deliberately without a foreign key: the
 * inventory/procurement module (Phase 19) is an optional peer being built separately, and
 * the asset register must keep working when it is absent. A constraint can be added by a
 * later migration once both modules are stable.
 */

import { relations, sql } from 'drizzle-orm';
import {
  date,
  index,
  integer,
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
import { departments, employees } from './people';
import { rooms } from './academic';
import { journalEntries } from './accounting';

// ─────────────────────────────────────────────────────────────────────────────────────
// Enumerations. Every set below is genuinely closed: a new depreciation method or asset
// status changes the calculation and reporting code as well as the schema. The things a
// school invents for itself — categories, vendors, locations — are rows or free text.
// ─────────────────────────────────────────────────────────────────────────────────────

export const assetDepreciationMethodEnum = pgEnum('asset_depreciation_method', [
  'straight_line',
  'reducing_balance',
  'none',
]);

export const assetConditionEnum = pgEnum('asset_condition', [
  'new',
  'good',
  'fair',
  'poor',
  'unserviceable',
]);

export const assetStatusEnum = pgEnum('asset_status', [
  'in_store',
  'assigned',
  'under_maintenance',
  'disposed',
  'lost',
]);

export const assetAssigneeKindEnum = pgEnum('asset_assignee_kind', [
  'employee',
  'room',
  'department',
]);

export const assetMaintenanceKindEnum = pgEnum('asset_maintenance_kind', [
  'preventive',
  'repair',
  'calibration',
]);

/** `draft` may be posted or cancelled; `posted` is immutable; there is no `deleted`. */
export const depreciationRunStatusEnum = pgEnum('depreciation_run_status', [
  'draft',
  'posted',
  'cancelled',
]);

export const assetDisposalMethodEnum = pgEnum('asset_disposal_method', [
  'sold',
  'scrapped',
  'donated',
  'written_off',
  'lost',
]);

// ─────────────────────────────────────────────────────────────────────────────────────
// Categories
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A category in the institution's asset taxonomy — a tree, like the chart of accounts.
 * Defaults here seed a new asset's useful life and method; the asset keeps its own copy so
 * a later category change never silently rewrites existing depreciation plans.
 */
export const assetCategories = pgTable(
  'asset_categories',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    name: varchar('name', { length: 128 }).notNull(),
    nameBn: varchar('name_bn', { length: 128 }),
    parentId: uuid('parent_id').references((): AnyPgColumn => assetCategories.id, {
      onDelete: 'restrict',
    }),
    defaultUsefulLifeYears: smallint('default_useful_life_years'),
    defaultDepreciationMethod: assetDepreciationMethodEnum('default_depreciation_method')
      .notNull()
      .default('straight_line'),
    /**
     * Optional link to the chart of accounts by *code*, not id: the chart is maintained by
     * accounting and codes are stable across re-imports where ids are not.
     */
    ledgerAccountCode: varchar('ledger_account_code', { length: 32 }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('asset_categories_institution_name_key')
      .on(table.institutionId, table.name)
      .where(sql`${table.archivedAt} IS NULL`),
    index('asset_categories_tenant_idx').on(table.tenantId),
    index('asset_categories_parent_idx').on(table.parentId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Assets
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * One physical asset. `asset_tag` is the label on the object (`AST-2026-000042`), unique
 * per institution and — like a document number — never reused, archived or not.
 *
 * `book_value` and `accumulated_depreciation` are maintained exclusively by posting
 * depreciation runs; check constraints make an inconsistent row impossible even for raw SQL.
 */
export const assets = pgTable(
  'assets',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    campusId: uuid('campus_id').references(() => campuses.id, { onDelete: 'set null' }),
    assetTag: varchar('asset_tag', { length: 32 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    nameBn: varchar('name_bn', { length: 255 }),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => assetCategories.id, { onDelete: 'restrict' }),
    serialNumber: varchar('serial_number', { length: 128 }),
    purchasedOn: date('purchased_on').notNull(),
    purchaseCost: numeric('purchase_cost', { precision: 14, scale: 2 }).notNull(),
    supplierName: varchar('supplier_name', { length: 255 }),
    warrantyExpiresOn: date('warranty_expires_on'),
    /** Nullable exactly when the method is `none`; the check constraint holds the pair. */
    usefulLifeYears: smallint('useful_life_years'),
    salvageValue: numeric('salvage_value', { precision: 14, scale: 2 }).notNull().default('0.00'),
    depreciationMethod: assetDepreciationMethodEnum('depreciation_method').notNull(),
    accumulatedDepreciation: numeric('accumulated_depreciation', { precision: 14, scale: 2 })
      .notNull()
      .default('0.00'),
    /** Always `purchase_cost - accumulated_depreciation`; the database refuses anything else. */
    bookValue: numeric('book_value', { precision: 14, scale: 2 }).notNull(),
    condition: assetConditionEnum('condition').notNull().default('new'),
    status: assetStatusEnum('status').notNull().default('in_store'),
    location: varchar('location', { length: 255 }),
    /**
     * The purchased stock item this asset originated from, when procurement went through the
     * inventory module. Deliberately **no foreign key** — see the module comment at the top
     * of this file; a constraint can be added later once Phase 19 is stable.
     */
    sourceReference: uuid('source_reference'),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    // Not partial: an asset tag is a physical label and is never reused, archived or not.
    uniqueIndex('assets_institution_tag_key').on(table.institutionId, table.assetTag),
    index('assets_tenant_idx').on(table.tenantId),
    index('assets_institution_status_idx').on(table.institutionId, table.status),
    index('assets_category_idx').on(table.categoryId),
    index('assets_campus_idx').on(table.campusId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Assignments
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Custody: who holds the asset now, and who held it before. At most one row per asset has
 * `returned_on IS NULL` — the partial unique index is the guarantee, so two clerks assigning
 * the same projector at once is a database error, not a race.
 */
export const assetAssignments = pgTable(
  'asset_assignments',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'restrict' }),
    assigneeKind: assetAssigneeKindEnum('assignee_kind').notNull(),
    employeeId: uuid('employee_id').references(() => employees.id, { onDelete: 'restrict' }),
    roomId: uuid('room_id').references(() => rooms.id, { onDelete: 'restrict' }),
    departmentRef: uuid('department_ref').references(() => departments.id, {
      onDelete: 'restrict',
    }),
    assignedOn: date('assigned_on').notNull(),
    returnedOn: date('returned_on'),
    /** The user who handed the asset over. Not an FK to employees: admins assign too. */
    assignedBy: uuid('assigned_by').notNull(),
    returnedBy: uuid('returned_by'),
    conditionOut: assetConditionEnum('condition_out').notNull(),
    conditionIn: assetConditionEnum('condition_in'),
    notes: varchar('notes', { length: 1000 }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    // One open assignment per asset. The service checks first for a friendly error; this
    // index is the real guarantee.
    uniqueIndex('asset_assignments_open_key')
      .on(table.assetId)
      .where(sql`${table.returnedOn} IS NULL AND ${table.archivedAt} IS NULL`),
    index('asset_assignments_tenant_idx').on(table.tenantId),
    index('asset_assignments_asset_idx').on(table.assetId),
    index('asset_assignments_employee_idx').on(table.employeeId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Maintenance
// ─────────────────────────────────────────────────────────────────────────────────────

/** A maintenance event that happened. `next_due_on` drives the maintenance-due report. */
export const assetMaintenance = pgTable(
  'asset_maintenance',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'restrict' }),
    kind: assetMaintenanceKindEnum('kind').notNull(),
    performedOn: date('performed_on').notNull(),
    cost: numeric('cost', { precision: 14, scale: 2 }).notNull().default('0.00'),
    vendor: varchar('vendor', { length: 255 }),
    downtimeDays: integer('downtime_days').notNull().default(0),
    notes: varchar('notes', { length: 1000 }),
    nextDueOn: date('next_due_on'),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('asset_maintenance_tenant_idx').on(table.tenantId),
    index('asset_maintenance_asset_idx').on(table.assetId),
    // Serves the maintenance-due report without scanning archived rows.
    index('asset_maintenance_next_due_idx')
      .on(table.institutionId, table.nextDueOn)
      .where(sql`${table.archivedAt} IS NULL AND ${table.nextDueOn} IS NOT NULL`),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Depreciation runs
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * One monthly depreciation calculation for one institution.
 *
 * draft → posted | cancelled. Posting writes ONE balanced journal entry (debit depreciation
 * expense, credit accumulated depreciation) through `LedgerService.post` in the same
 * transaction as the status change and the per-asset accumulated-depreciation updates —
 * if the ledger refuses (closed period, non-postable account), nothing is posted.
 */
export const depreciationRuns = pgTable(
  'depreciation_runs',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    periodYear: integer('period_year').notNull(),
    periodMonth: smallint('period_month').notNull(),
    status: depreciationRunStatusEnum('status').notNull().default('draft'),
    totalDepreciation: numeric('total_depreciation', { precision: 14, scale: 2 })
      .notNull()
      .default('0.00'),
    postedBy: uuid('posted_by'),
    postedAt: timestamp('posted_at', { withTimezone: true, mode: 'date' }),
    /** The one balanced entry the posting wrote. Set exactly when the run is `posted`. */
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    cancelledBy: uuid('cancelled_by'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
    cancelReason: varchar('cancel_reason', { length: 1000 }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    // Once per month per institution — unless that attempt was cancelled.
    uniqueIndex('depreciation_runs_period_key')
      .on(table.institutionId, table.periodYear, table.periodMonth)
      .where(sql`${table.status} <> 'cancelled'`),
    index('depreciation_runs_tenant_idx').on(table.tenantId),
    index('depreciation_runs_institution_status_idx').on(table.institutionId, table.status),
  ],
);

/**
 * One asset's slice of one run. A pure child row: written once at calculation, immutable
 * ever after (append-only at the database level), no `version`.
 */
export const depreciationLines = pgTable(
  'depreciation_lines',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => depreciationRuns.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'restrict' }),
    openingBookValue: numeric('opening_book_value', { precision: 14, scale: 2 }).notNull(),
    depreciation: numeric('depreciation', { precision: 14, scale: 2 }).notNull(),
    closingBookValue: numeric('closing_book_value', { precision: 14, scale: 2 }).notNull(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('depreciation_lines_run_asset_key').on(table.runId, table.assetId),
    index('depreciation_lines_tenant_idx').on(table.tenantId),
    index('depreciation_lines_run_idx').on(table.runId),
    index('depreciation_lines_asset_idx').on(table.assetId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Disposals
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The end of an asset's life: sold, scrapped, donated, written off or lost.
 *
 * Two-person rule: `requested_by` records, a *different* user approves — enforced by
 * `asset_disposals_distinct_approver` on the data, and again in the service so the refusal
 * is a friendly 403 rather than a constraint violation. Approval flips the asset to
 * `disposed` (or `lost`); the asset row and its whole history remain forever.
 *
 * `journal_entry_id` is reserved for the ledger entry recording proceeds and gain/loss on
 * disposal; the posting itself is not implemented in this phase and the column stays null.
 */
export const assetDisposals = pgTable(
  'asset_disposals',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'restrict' }),
    disposedOn: date('disposed_on').notNull(),
    method: assetDisposalMethodEnum('method').notNull(),
    proceeds: numeric('proceeds', { precision: 14, scale: 2 }).notNull().default('0.00'),
    reason: varchar('reason', { length: 1000 }).notNull(),
    requestedBy: uuid('requested_by').notNull(),
    approvedBy: uuid('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true, mode: 'date' }),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    // One open (unapproved) disposal request per asset.
    uniqueIndex('asset_disposals_open_key')
      .on(table.assetId)
      .where(sql`${table.approvedBy} IS NULL AND ${table.archivedAt} IS NULL`),
    index('asset_disposals_tenant_idx').on(table.tenantId),
    index('asset_disposals_asset_idx').on(table.assetId),
    index('asset_disposals_institution_idx').on(table.institutionId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────

export const assetCategoriesRelations = relations(assetCategories, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [assetCategories.institutionId],
    references: [institutions.id],
  }),
  parent: one(assetCategories, {
    fields: [assetCategories.parentId],
    references: [assetCategories.id],
    relationName: 'asset_category_parent',
  }),
  children: many(assetCategories, { relationName: 'asset_category_parent' }),
  assets: many(assets),
}));

export const assetsRelations = relations(assets, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [assets.institutionId],
    references: [institutions.id],
  }),
  campus: one(campuses, { fields: [assets.campusId], references: [campuses.id] }),
  category: one(assetCategories, {
    fields: [assets.categoryId],
    references: [assetCategories.id],
  }),
  assignments: many(assetAssignments),
  maintenance: many(assetMaintenance),
  depreciationLines: many(depreciationLines),
  disposals: many(assetDisposals),
}));

export const assetAssignmentsRelations = relations(assetAssignments, ({ one }) => ({
  asset: one(assets, { fields: [assetAssignments.assetId], references: [assets.id] }),
  employee: one(employees, {
    fields: [assetAssignments.employeeId],
    references: [employees.id],
  }),
  room: one(rooms, { fields: [assetAssignments.roomId], references: [rooms.id] }),
  department: one(departments, {
    fields: [assetAssignments.departmentRef],
    references: [departments.id],
  }),
}));

export const assetMaintenanceRelations = relations(assetMaintenance, ({ one }) => ({
  asset: one(assets, { fields: [assetMaintenance.assetId], references: [assets.id] }),
}));

export const depreciationRunsRelations = relations(depreciationRuns, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [depreciationRuns.institutionId],
    references: [institutions.id],
  }),
  journalEntry: one(journalEntries, {
    fields: [depreciationRuns.journalEntryId],
    references: [journalEntries.id],
  }),
  lines: many(depreciationLines),
}));

export const depreciationLinesRelations = relations(depreciationLines, ({ one }) => ({
  run: one(depreciationRuns, {
    fields: [depreciationLines.runId],
    references: [depreciationRuns.id],
  }),
  asset: one(assets, { fields: [depreciationLines.assetId], references: [assets.id] }),
}));

export const assetDisposalsRelations = relations(assetDisposals, ({ one }) => ({
  asset: one(assets, { fields: [assetDisposals.assetId], references: [assets.id] }),
  journalEntry: one(journalEntries, {
    fields: [assetDisposals.journalEntryId],
    references: [journalEntries.id],
  }),
}));
