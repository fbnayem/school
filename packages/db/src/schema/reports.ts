/**
 * Reporting (Phase 24) — a generic query surface over entities that already exist.
 *
 * This is the module with the largest blast radius in the product, because it is the one
 * that turns user input into a query. Two design decisions carry that weight, and both are
 * visible in the shape of these tables:
 *
 *  1. **A report is assembled from a registry, never from client-supplied SQL.** Nothing
 *     here stores a query string. `source_key` names a `ReportSource` in
 *     `apps/api/src/modules/reports/sources/`, and `columns` / `filters` / `grouping` /
 *     `sorting` are jsonb documents of *keys* that must appear in that source's allow-lists.
 *     A key outside the allow-list is a 422; it never reaches SQL. Adding a source later
 *     needs no migration — the registry is code, not data.
 *  2. **A report can never widen access.** Every run executes inside the caller's tenant
 *     transaction with the caller's data scope applied (`StudentsService.scopeFilterSql`,
 *     reused rather than re-derived), and a column whose permission the caller lacks is
 *     omitted from the projection *and* from the column picker. Medical and salary columns
 *     are the cases that prove it.
 *
 * `report_runs` and `report_exports` exist because a bulk read of pupil, staff or financial
 * data is a security event: every run is recorded with its parameters, row count and
 * duration, and every export additionally writes an audit row inside the same transaction
 * that creates it. Exports are immutable and never deleted — the same append-only
 * philosophy as `audit_logs` (0005) and posted journal lines (0018), enforced by a trigger
 * rather than by convention.
 *
 * `report_runs.definition_id` XOR `ad_hoc_definition` is a check constraint: a run is either
 * a saved definition or the one-off document that produced it, never both and never neither,
 * so "what exactly did this export contain?" is always answerable.
 *
 * `report_schedules.recipients` is a list of user ids, and it is load-bearing rather than
 * decorative: a recipient may download the export a scheduled run produced even though they
 * did not run it. No delivery channel is wired (see the module's risk notes).
 */

import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  actorColumns,
  archiveColumns,
  primaryKeyColumn,
  timestampColumns,
  versionColumn,
} from './_shared';
import { institutions, organizations } from './tenancy';
import { roles, users } from './identity';

// ─────────────────────────────────────────────────────────────────────────────────────
// Enumerations. Each set is genuinely closed: adding a visibility mode or an export format
// changes the authorization or serialisation code as well as the schema. What a school
// invents for itself — the reports themselves — are rows, not enum values.
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Who may read a saved definition.
 *
 * `private` — only its author. `role` — the author plus whoever `report_shares` names.
 * `institution` — anyone in the institution holding `reports.view`. Note that visibility
 * governs the *definition*, never the data: running any definition still applies the
 * caller's own data scope and column permissions.
 */
export const reportVisibilityEnum = pgEnum('report_visibility', [
  'private',
  'role',
  'institution',
]);

export const reportDefinitionStatusEnum = pgEnum('report_definition_status', [
  'draft',
  'published',
  'archived',
]);

export const reportRunStatusEnum = pgEnum('report_run_status', ['running', 'succeeded', 'failed']);

/** CSV for spreadsheets, JSON for machines. Neither format can carry a formula. */
export const reportExportFormatEnum = pgEnum('report_export_format', ['csv', 'json']);

// ─────────────────────────────────────────────────────────────────────────────────────
// Definitions
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A saved report: a source key plus the allow-listed keys that shape the query.
 *
 * None of the four jsonb documents is trusted on read. They are re-validated against the
 * registry every single time the definition runs, because the registry (and the caller's
 * permissions) can change after the definition was saved — a definition written while
 * someone held `students.medical.view` must not keep working once they lose it.
 */
export const reportDefinitions = pgTable(
  'report_definitions',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    /** Stable, institution-unique handle: `overdue-invoices`, `class-6-attendance`. */
    key: varchar('key', { length: 64 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    nameBn: varchar('name_bn', { length: 128 }),
    /** Names a `ReportSource` in the registry. Validated on every run, never on trust. */
    sourceKey: varchar('source_key', { length: 64 }).notNull(),
    /** `string[]` of column keys. */
    columns: jsonb('columns')
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** `{field, operator, value|values}[]`. */
    filters: jsonb('filters')
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** `{fields: string[], aggregates: {field, fn}[]}` or null. */
    grouping: jsonb('grouping'),
    /** `{field, direction}[]`. */
    sorting: jsonb('sorting')
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Shipped with the product; a tenant may run it but not edit or archive it. */
    isSystem: boolean('is_system').notNull().default(false),
    visibility: reportVisibilityEnum('visibility').notNull().default('private'),
    status: reportDefinitionStatusEnum('status').notNull().default('draft'),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('report_definitions_institution_key_key')
      .on(table.institutionId, table.key)
      .where(sql`${table.archivedAt} IS NULL`),
    index('report_definitions_tenant_idx').on(table.tenantId),
    index('report_definitions_institution_source_idx').on(table.institutionId, table.sourceKey),
    index('report_definitions_author_idx').on(table.createdBy),
    index('report_definitions_visibility_idx').on(table.institutionId, table.visibility),
  ],
);

/**
 * One grant of read access to a `role` definition — to a role or to a single user.
 *
 * Exactly one of the two is set; the database refuses a row that names both or neither.
 * Sharing a definition shares the *question*, never the answer: the recipient still runs it
 * under their own data scope and column permissions.
 */
export const reportShares = pgTable(
  'report_shares',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    definitionId: uuid('definition_id')
      .notNull()
      .references(() => reportDefinitions.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id').references(() => roles.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('report_shares_definition_role_key')
      .on(table.definitionId, table.roleId)
      .where(sql`${table.roleId} IS NOT NULL AND ${table.archivedAt} IS NULL`),
    uniqueIndex('report_shares_definition_user_key')
      .on(table.definitionId, table.userId)
      .where(sql`${table.userId} IS NOT NULL AND ${table.archivedAt} IS NULL`),
    index('report_shares_tenant_idx').on(table.tenantId),
    index('report_shares_definition_idx').on(table.definitionId),
    index('report_shares_user_idx').on(table.userId),
    index('report_shares_role_idx').on(table.roleId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Runs and exports
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * One execution. Recorded before the query starts and updated when it settles, so a query
 * that timed out or was killed still leaves a `running` row behind rather than vanishing.
 *
 * `parameters` captures what actually executed — the resolved source key, the projected
 * column keys, the filters, the applied row limit and whether the result hit it. It never
 * contains result rows: the run record is evidence that a disclosure happened, not a second
 * copy of the data disclosed.
 */
export const reportRuns = pgTable(
  'report_runs',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    /** Set for a saved definition. Mutually exclusive with `adHocDefinition`. */
    definitionId: uuid('definition_id').references(() => reportDefinitions.id, {
      onDelete: 'restrict',
    }),
    /** The one-off document, when the run had no saved definition behind it. */
    adHocDefinition: jsonb('ad_hoc_definition'),
    runBy: uuid('run_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    rowCount: integer('row_count'),
    durationMs: integer('duration_ms'),
    status: reportRunStatusEnum('status').notNull().default('running'),
    /** Operator-facing failure detail. Never rendered to the client verbatim. */
    error: varchar('error', { length: 1000 }),
    parameters: jsonb('parameters')
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('report_runs_tenant_idx').on(table.tenantId),
    index('report_runs_definition_idx').on(table.definitionId, table.startedAt),
    index('report_runs_actor_idx').on(table.runBy, table.startedAt),
    index('report_runs_institution_status_idx').on(table.institutionId, table.status),
  ],
);

/**
 * A materialised result file.
 *
 * Immutable and never deleted (trigger `report_exports_guard_mutation`): the record that a
 * bulk export of pupil records happened must outlive the file itself. `expires_at` is when
 * the *download* stops working, not when the row disappears — and it is always strictly
 * after `created_at`, by check constraint, so a backdated expiry cannot be smuggled in.
 */
export const reportExports = pgTable(
  'report_exports',
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
      .references(() => reportRuns.id, { onDelete: 'restrict' }),
    format: reportExportFormatEnum('format').notNull(),
    /** Built by `StorageService.buildKey`, which applies the tenant prefix. */
    storageKey: varchar('storage_key', { length: 512 }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    rowCount: integer('row_count').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('report_exports_storage_key_key').on(table.storageKey),
    index('report_exports_tenant_idx').on(table.tenantId),
    index('report_exports_run_idx').on(table.runId),
    index('report_exports_expiry_idx').on(table.institutionId, table.expiresAt),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Schedules
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A saved run configuration with a cron expression.
 *
 * `timezone` is stored rather than assumed, but only `Asia/Dhaka` is accepted today: it is
 * the one zone the platform serves and it has no DST, so `next_run_at` is exact arithmetic
 * rather than a guess. Accepting a zone the scheduler cannot compute correctly would be a
 * worse lie than refusing it.
 *
 * `recipients` is a list of user ids. It is enforced, not decorative: a recipient may
 * download the export a scheduled run produced even though they did not run it themselves.
 */
export const reportSchedules = pgTable(
  'report_schedules',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    definitionId: uuid('definition_id')
      .notNull()
      .references(() => reportDefinitions.id, { onDelete: 'restrict' }),
    /** Five-field cron: minute hour day-of-month month day-of-week. */
    cronExpression: varchar('cron_expression', { length: 120 }).notNull(),
    timezone: varchar('timezone', { length: 64 }).notNull().default('Asia/Dhaka'),
    /** `string[]` of user ids in this tenant. */
    recipients: jsonb('recipients')
      .notNull()
      .default(sql`'[]'::jsonb`),
    format: reportExportFormatEnum('format').notNull().default('csv'),
    isActive: boolean('is_active').notNull().default(true),
    lastRunAt: timestamp('last_run_at', { withTimezone: true, mode: 'date' }),
    nextRunAt: timestamp('next_run_at', { withTimezone: true, mode: 'date' }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('report_schedules_definition_cron_key')
      .on(table.definitionId, table.cronExpression)
      .where(sql`${table.archivedAt} IS NULL`),
    index('report_schedules_tenant_idx').on(table.tenantId),
    index('report_schedules_due_idx').on(table.isActive, table.nextRunAt),
    index('report_schedules_institution_idx').on(table.institutionId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────

export const reportDefinitionsRelations = relations(reportDefinitions, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [reportDefinitions.institutionId],
    references: [institutions.id],
  }),
  shares: many(reportShares),
  runs: many(reportRuns),
  schedules: many(reportSchedules),
}));

export const reportSharesRelations = relations(reportShares, ({ one }) => ({
  definition: one(reportDefinitions, {
    fields: [reportShares.definitionId],
    references: [reportDefinitions.id],
  }),
  role: one(roles, { fields: [reportShares.roleId], references: [roles.id] }),
  user: one(users, { fields: [reportShares.userId], references: [users.id] }),
}));

export const reportRunsRelations = relations(reportRuns, ({ one, many }) => ({
  definition: one(reportDefinitions, {
    fields: [reportRuns.definitionId],
    references: [reportDefinitions.id],
  }),
  actor: one(users, { fields: [reportRuns.runBy], references: [users.id] }),
  exports: many(reportExports),
}));

export const reportExportsRelations = relations(reportExports, ({ one }) => ({
  run: one(reportRuns, { fields: [reportExports.runId], references: [reportRuns.id] }),
}));

export const reportSchedulesRelations = relations(reportSchedules, ({ one }) => ({
  definition: one(reportDefinitions, {
    fields: [reportSchedules.definitionId],
    references: [reportDefinitions.id],
  }),
}));
