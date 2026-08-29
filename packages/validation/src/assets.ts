/**
 * Asset management schemas (Phase 20): the fixed-asset register.
 *
 * The rules that shape everything here, inherited from accounting and the library:
 *
 *  - **Money crosses the wire as a decimal string, never a number** (ADR-004). A purchase
 *    cost, a salvage value, maintenance spend and disposal proceeds all use
 *    `positiveMoneySchema`; nothing in this module is ever a float.
 *  - **A client never states a derived fact.** There is no `bookValue`, no
 *    `accumulatedDepreciation`, no `status` on an asset input, no `totalDepreciation` on a
 *    run and no line amounts anywhere — those are computed by the service and restated as
 *    check constraints in migration 0026. Posting and cancelling a run, returning an
 *    assignment and approving a disposal are explicit endpoints, not fields.
 *  - **The financial identity of an asset is written once.** `updateAssetSchema` carries no
 *    `purchaseCost`, `salvageValue`, `usefulLifeYears` or `depreciationMethod`: changing any
 *    of them after depreciation has begun would silently rewrite the plan the register has
 *    already partly executed. A mistake is corrected by disposal and re-registration, with
 *    the history intact.
 *
 * Every exported constant carries an `ASSET_`/`DEPRECIATION_` prefix because
 * `@shikkha/validation` re-exports flat.
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

/** Positive-money decimal string to minor units, without ever touching a float. */
const toMinor = (value: string): bigint => {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2) || '0');
};

// ── Value sets, mirrored from the database enums ─────────────────────────────────────

export const ASSET_DEPRECIATION_METHODS = ['straight_line', 'reducing_balance', 'none'] as const;

export const ASSET_CONDITIONS = ['new', 'good', 'fair', 'poor', 'unserviceable'] as const;

export const ASSET_STATUSES = [
  'in_store',
  'assigned',
  'under_maintenance',
  'disposed',
  'lost',
] as const;

export const ASSET_ASSIGNEE_KINDS = ['employee', 'room', 'department'] as const;

export const ASSET_MAINTENANCE_KINDS = ['preventive', 'repair', 'calibration'] as const;

export const DEPRECIATION_RUN_STATUSES = ['draft', 'posted', 'cancelled'] as const;

export const ASSET_DISPOSAL_METHODS = [
  'sold',
  'scrapped',
  'donated',
  'written_off',
  'lost',
] as const;

// ── Sort-field allow-lists ───────────────────────────────────────────────────────────

export const ASSET_CATEGORY_SORT_FIELDS = ['name', 'createdAt'] as const;

export const ASSET_SORT_FIELDS = [
  'assetTag',
  'name',
  'purchasedOn',
  'purchaseCost',
  'bookValue',
  'status',
  'createdAt',
] as const;

export const ASSET_ASSIGNMENT_SORT_FIELDS = ['assignedOn', 'returnedOn', 'createdAt'] as const;

export const ASSET_MAINTENANCE_SORT_FIELDS = [
  'performedOn',
  'cost',
  'nextDueOn',
  'createdAt',
] as const;

export const DEPRECIATION_RUN_SORT_FIELDS = [
  'periodYear',
  'periodMonth',
  'status',
  'createdAt',
] as const;

export const ASSET_DISPOSAL_SORT_FIELDS = ['disposedOn', 'method', 'createdAt'] as const;

// ── Categories ───────────────────────────────────────────────────────────────────────

export const createAssetCategorySchema = z.object({
  name: z.string().trim().min(1).max(128),
  nameBn: z.string().trim().max(128).optional(),
  parentId: uuidSchema.optional(),
  /** Seeds a new asset's plan; the asset keeps its own copy thereafter. */
  defaultUsefulLifeYears: z.coerce.number().int().min(1).max(100).optional(),
  defaultDepreciationMethod: z.enum(ASSET_DEPRECIATION_METHODS).default('straight_line'),
  /** Optional link to the chart of accounts by *code* — codes are stable, ids are not. */
  ledgerAccountCode: code(32).optional(),
});

export type CreateAssetCategoryInput = z.infer<typeof createAssetCategorySchema>;

export const updateAssetCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(128).optional(),
    nameBn: z.string().trim().max(128).nullable().optional(),
    parentId: uuidSchema.nullable().optional(),
    // Not coerced: `z.coerce` would turn an explicit null into 0 instead of clearing it.
    defaultUsefulLifeYears: z.number().int().min(1).max(100).nullable().optional(),
    defaultDepreciationMethod: z.enum(ASSET_DEPRECIATION_METHODS).optional(),
    ledgerAccountCode: code(32).nullable().optional(),
    /** Optimistic lock. Rejecting a stale write beats silently overwriting a colleague. */
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, {
    message: 'No changes were submitted',
  });

export type UpdateAssetCategoryInput = z.infer<typeof updateAssetCategorySchema>;

export const listAssetCategoriesSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    parentId: uuidSchema.optional(),
    includeArchived: z.coerce.boolean().default(false),
  });

/** Archival always carries a recorded reason; nothing in this module is hard-deleted. */
export const assetArchiveSchema = z.object({ reason: reasonSchema });

// ── Assets ───────────────────────────────────────────────────────────────────────────

/**
 * Register one physical asset. `bookValue` and `accumulatedDepreciation` are absent by
 * design: a new asset opens at book value = purchase cost, and only posted depreciation
 * runs move it from there — `assets_book_value_derived` refuses anything else.
 */
export const createAssetSchema = z
  .object({
    /** The label on the object, e.g. AST-2026-000042. Unique per institution, never reused. */
    assetTag: code(32),
    name: z.string().trim().min(1).max(255),
    nameBn: z.string().trim().max(255).optional(),
    categoryId: uuidSchema,
    campusId: uuidSchema.optional(),
    serialNumber: z.string().trim().max(128).optional(),
    purchasedOn: calendarDateSchema,
    purchaseCost: positiveMoneySchema,
    supplierName: z.string().trim().max(255).optional(),
    warrantyExpiresOn: calendarDateSchema.optional(),
    /** Required exactly when the asset depreciates; refused when the method is `none`. */
    usefulLifeYears: z.coerce.number().int().min(1).max(100).optional(),
    salvageValue: positiveMoneySchema.default('0.00'),
    depreciationMethod: z.enum(ASSET_DEPRECIATION_METHODS),
    condition: z.enum(ASSET_CONDITIONS).default('new'),
    location: z.string().trim().max(255).optional(),
    /** Bare reference to the originating stock item; deliberately unvalidated (Phase 19). */
    sourceReference: uuidSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.depreciationMethod !== 'none' && data.usefulLifeYears === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['usefulLifeYears'],
        message: 'A depreciating asset needs a useful life in years',
      });
    }
    if (toMinor(data.salvageValue) > toMinor(data.purchaseCost)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['salvageValue'],
        message: 'The salvage value cannot exceed the purchase cost',
      });
    }
    if (data.warrantyExpiresOn !== undefined && data.warrantyExpiresOn < data.purchasedOn) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['warrantyExpiresOn'],
        message: 'The warranty cannot expire before the purchase date',
      });
    }
  });

export type CreateAssetInput = z.infer<typeof createAssetSchema>;

/**
 * Identity and custody only. The financial plan — cost, salvage, life, method — and the
 * derived pair — accumulated depreciation, book value — are immutable through this route;
 * see the file header.
 */
export const updateAssetSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    nameBn: z.string().trim().max(255).nullable().optional(),
    categoryId: uuidSchema.optional(),
    campusId: uuidSchema.nullable().optional(),
    serialNumber: z.string().trim().max(128).nullable().optional(),
    supplierName: z.string().trim().max(255).nullable().optional(),
    warrantyExpiresOn: calendarDateSchema.nullable().optional(),
    condition: z.enum(ASSET_CONDITIONS).optional(),
    location: z.string().trim().max(255).nullable().optional(),
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, {
    message: 'No changes were submitted',
  });

export type UpdateAssetInput = z.infer<typeof updateAssetSchema>;

export const listAssetsSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    categoryId: uuidSchema.optional(),
    campusId: uuidSchema.optional(),
    status: z.enum(ASSET_STATUSES).optional(),
    condition: z.enum(ASSET_CONDITIONS).optional(),
    depreciationMethod: z.enum(ASSET_DEPRECIATION_METHODS).optional(),
    includeArchived: z.coerce.boolean().default(false),
  });

// ── Assignments ──────────────────────────────────────────────────────────────────────

/**
 * Hand an asset to an employee, a room or a department. Exactly one assignee reference,
 * matching the declared kind — the same shape `asset_assignments_assignee_present` holds
 * on the data. One open assignment per asset is the partial unique index
 * `asset_assignments_open_key`; the service's friendly 409 merely front-runs it.
 */
export const createAssetAssignmentSchema = z
  .object({
    assetId: uuidSchema,
    assigneeKind: z.enum(ASSET_ASSIGNEE_KINDS),
    employeeId: uuidSchema.optional(),
    roomId: uuidSchema.optional(),
    departmentId: uuidSchema.optional(),
    assignedOn: calendarDateSchema,
    conditionOut: z.enum(ASSET_CONDITIONS),
    notes: z.string().trim().max(1000).optional(),
  })
  .superRefine((data, ctx) => {
    const provided = [
      data.employeeId !== undefined,
      data.roomId !== undefined,
      data.departmentId !== undefined,
    ].filter(Boolean).length;
    const matches =
      (data.assigneeKind === 'employee' && data.employeeId !== undefined) ||
      (data.assigneeKind === 'room' && data.roomId !== undefined) ||
      (data.assigneeKind === 'department' && data.departmentId !== undefined);
    if (provided !== 1 || !matches) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assigneeKind'],
        message: 'Provide exactly one assignee reference, matching the declared kind',
      });
    }
  });

export type CreateAssetAssignmentInput = z.infer<typeof createAssetAssignmentSchema>;

/** Take the asset back. Who and in what condition are part of the record, not optional. */
export const returnAssetAssignmentSchema = z.object({
  returnedOn: calendarDateSchema,
  conditionIn: z.enum(ASSET_CONDITIONS),
  notes: z.string().trim().max(1000).optional(),
  version: z.number().int().min(1),
});

export type ReturnAssetAssignmentInput = z.infer<typeof returnAssetAssignmentSchema>;

export const listAssetAssignmentsSchema = paginationSchema.merge(sortSchema).extend({
  assetId: uuidSchema.optional(),
  employeeId: uuidSchema.optional(),
  roomId: uuidSchema.optional(),
  departmentId: uuidSchema.optional(),
  /** Only assignments still out — the live custody map. */
  openOnly: z.coerce.boolean().default(false),
  includeArchived: z.coerce.boolean().default(false),
});

// ── Maintenance ──────────────────────────────────────────────────────────────────────

export const createAssetMaintenanceSchema = z
  .object({
    assetId: uuidSchema,
    kind: z.enum(ASSET_MAINTENANCE_KINDS),
    performedOn: calendarDateSchema,
    cost: positiveMoneySchema.default('0.00'),
    vendor: z.string().trim().max(255).optional(),
    downtimeDays: z.coerce.number().int().min(0).max(3650).default(0),
    notes: z.string().trim().max(1000).optional(),
    nextDueOn: calendarDateSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.nextDueOn !== undefined && data.nextDueOn <= data.performedOn) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nextDueOn'],
        message: 'The next due date must fall after the date the work was performed',
      });
    }
  });

export type CreateAssetMaintenanceInput = z.infer<typeof createAssetMaintenanceSchema>;

export const listAssetMaintenanceSchema = paginationSchema.merge(sortSchema).extend({
  assetId: uuidSchema.optional(),
  kind: z.enum(ASSET_MAINTENANCE_KINDS).optional(),
  includeArchived: z.coerce.boolean().default(false),
});

export const assetMaintenanceDueQuerySchema = z.object({
  /** Everything due on or before this date. Defaults to today in the service. */
  asOf: calendarDateSchema.optional(),
});

// ── Depreciation runs ────────────────────────────────────────────────────────────────

/**
 * Calculate one month's depreciation as a **draft**: the per-asset lines are computed and
 * written, and nothing touches the assets or the ledger until the run is posted. One run
 * per (institution, year, month) unless cancelled — `depreciation_runs_period_key`.
 */
export const createDepreciationRunSchema = z.object({
  periodYear: z.coerce.number().int().min(1990).max(2100),
  periodMonth: z.coerce.number().int().min(1).max(12),
});

export type CreateDepreciationRunInput = z.infer<typeof createDepreciationRunSchema>;

/**
 * Post a draft run: one balanced journal entry — debit depreciation expense, credit
 * accumulated depreciation — through the ledger, in the same transaction as the per-asset
 * updates and the status flip. If the ledger refuses, nothing moves.
 */
export const postDepreciationRunSchema = z.object({
  expenseAccountId: uuidSchema,
  /** The contra-asset account (an `asset` account with a credit normal balance). */
  accumulatedDepreciationAccountId: uuidSchema,
  /** Date of the journal entry. Defaults to the last day of the run's month. */
  entryDate: calendarDateSchema.optional(),
  /** Optimistic lock: posting what someone else just recalculated must fail loudly. */
  version: z.number().int().min(1),
});

export type PostDepreciationRunInput = z.infer<typeof postDepreciationRunSchema>;

export const cancelDepreciationRunSchema = z.object({
  reason: reasonSchema,
  version: z.number().int().min(1),
});

export const listDepreciationRunsSchema = paginationSchema.merge(sortSchema).extend({
  status: z.enum(DEPRECIATION_RUN_STATUSES).optional(),
  periodYear: z.coerce.number().int().min(1990).max(2100).optional(),
  includeArchived: z.coerce.boolean().default(false),
});

// ── Disposals ────────────────────────────────────────────────────────────────────────

/**
 * Request the end of an asset's life. The requester records; a **different** person
 * approves — `asset_disposals_distinct_approver` holds that on the data, and the service
 * repeats it as a friendly refusal.
 */
export const createAssetDisposalSchema = z
  .object({
    assetId: uuidSchema,
    disposedOn: calendarDateSchema,
    method: z.enum(ASSET_DISPOSAL_METHODS),
    proceeds: positiveMoneySchema.default('0.00'),
    reason: reasonSchema,
  })
  .superRefine((data, ctx) => {
    if (data.method !== 'sold' && toMinor(data.proceeds) > 0n) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proceeds'],
        message: 'Only a sale carries proceeds',
      });
    }
  });

export type CreateAssetDisposalInput = z.infer<typeof createAssetDisposalSchema>;

/**
 * Approve a disposal. When the `ledger` block is present the approval also posts the
 * disposal entry — write off the cost, recapture accumulated depreciation, bank any
 * proceeds, and book the gain or loss — in the same transaction; omitted, the asset is
 * still retired and `journal_entry_id` stays null for a later manual entry.
 */
export const approveAssetDisposalSchema = z.object({
  version: z.number().int().min(1),
  ledger: z
    .object({
      /** The asset-cost account the original purchase sits on (type `asset`). */
      assetAccountId: uuidSchema,
      accumulatedDepreciationAccountId: uuidSchema,
      /** Where the gain or loss on disposal lands. */
      gainLossAccountId: uuidSchema,
      /** Required when the disposal carries proceeds; must be cash-equivalent. */
      cashAccountId: uuidSchema.optional(),
      /** Date of the journal entry. Defaults to the disposal date. */
      entryDate: calendarDateSchema.optional(),
    })
    .optional(),
});

export type ApproveAssetDisposalInput = z.infer<typeof approveAssetDisposalSchema>;

export const listAssetDisposalsSchema = paginationSchema.merge(sortSchema).extend({
  assetId: uuidSchema.optional(),
  method: z.enum(ASSET_DISPOSAL_METHODS).optional(),
  /** Only requests still awaiting a second person. */
  pendingOnly: z.coerce.boolean().default(false),
  includeArchived: z.coerce.boolean().default(false),
});
