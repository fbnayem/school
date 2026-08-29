/**
 * Report builder service (Phase 24).
 *
 * The dangerous part of this module is small and lives next door, in
 * `sources/compiler.ts`. What lives here is everything that must be true *around* it:
 *
 *  1. **Every query runs inside `runInTenant`.** Tenant isolation is the transaction's job,
 *     not this service's memory. A cross-tenant report is not filtered out — it is invisible,
 *     because RLS never returns the rows.
 *  2. **The caller's data scope is resolved from permissions and reused, never re-derived.**
 *     A student-centred source resolves the same `SCOPED_RESOURCES` triple its own module
 *     uses and then applies `StudentsService.scopeFilterSql`. A teacher's student report
 *     therefore contains exactly the students their student list does; there is no second
 *     scoping rule that could drift from the first.
 *  3. **Column permissions are applied twice** — the picker only offers what the caller may
 *     see, and the compiler drops from the projection anything they may not, even if a saved
 *     definition asks for it. Filtering, sorting or grouping on such a column is refused
 *     outright, because those influence the result set and would be an oracle.
 *  4. **Nothing is unbounded.** Every statement carries a row limit and runs under a
 *     transaction-local `statement_timeout`. A run that reaches the limit is reported as
 *     truncated, and exporting a truncated run is refused rather than handing back a partial
 *     file that looks complete.
 *  5. **Every run is recorded and every export is audited inside its own transaction.** A
 *     bulk read of pupil, staff or financial records is a security event; if the record
 *     cannot be written, the disclosure does not happen.
 *
 * What this service deliberately does not do: execute a schedule on its own. Schedules are
 * stored, validated and computed (`next_run_at` is real), and `runSchedule` executes one on
 * demand, producing a real run and a real export. No background process fires them yet —
 * that is reported as a gap rather than faked with a timer that would silently die with the
 * process.
 */

import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  reportDefinitions,
  reportExports,
  reportRuns,
  reportSchedules,
  reportShares,
  roles,
  users,
} from '@shikkha/db';
import {
  buildOffsetPage,
  ConflictError,
  DHAKA_UTC_OFFSET_MINUTES,
  ForbiddenError,
  InternalError,
  NotFoundError,
  offsetOf,
  parseSort,
  PreconditionFailedError,
  uuidv7,
  ValidationError,
  type OffsetPage,
  type OffsetPageRequest,
} from '@shikkha/shared';
import {
  canAny,
  resolveDataScope,
  type DataScope,
  type Principal,
} from '@shikkha/permissions';
import {
  REPORT_DEFINITION_SORT_FIELDS,
  REPORT_EXPORT_TTL_HOURS,
  REPORT_MAX_ROWS,
  REPORT_RUN_SORT_FIELDS,
  REPORT_STATEMENT_TIMEOUT_MS,
  reportQuerySchema,
  type ReportQueryInput,
} from '@shikkha/validation';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';
import { StudentsService } from '../students/students.service';
import { currentContext } from '../../common/context/request-context';
import { findReportSource, listReportSources } from './sources';
import { compileReport, visibleColumnKeys, type CompiledColumn } from './sources/compiler';
import { ref, type ReportSourceDef } from './sources/types';

export type Tx = Parameters<Parameters<DatabaseService['runInTenant']>[0]>[0];

type DefinitionRow = typeof reportDefinitions.$inferSelect;
type RunRow = typeof reportRuns.$inferSelect;
type ExportRow = typeof reportExports.$inferSelect;
type ScheduleRow = typeof reportSchedules.$inferSelect;
type ShareRow = typeof reportShares.$inferSelect;

export interface ReportColumnOption extends CompiledColumn {
  filterable: boolean;
  operators: readonly string[];
  sortable: boolean;
  groupable: boolean;
  aggregates: readonly string[];
  enumValues?: readonly string[];
}

export interface ReportSourceSummary {
  key: string;
  label: string;
  labelBn: string;
  columnCount: number;
}

export interface ReportSourceDetail extends ReportSourceSummary {
  /** Only what this caller may see. The picker and the query honour the same set. */
  columns: ReportColumnOption[];
  defaultSort: { field: string; direction: 'asc' | 'desc' };
  maxRows: number;
}

export interface ReportResult {
  runId: string;
  definitionId: string | null;
  sourceKey: string;
  columns: CompiledColumn[];
  /** Requested columns the caller may not read. Reported, never returned as nulls. */
  omittedColumns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  /** True when the row limit was reached. An export of a truncated result is refused. */
  truncated: boolean;
  limit: number;
  durationMs: number;
}

export interface ReportExportResult {
  export: ExportRow;
  runId: string;
  basedOnRunId: string | null;
  rowCount: number;
  filename: string;
}

interface ListQuery extends OffsetPageRequest {
  sort?: string;
}

interface ExecutionPlan {
  source: ReportSourceDef;
  query: ReportQueryInput;
  limit: number;
  scope: DataScope | null;
  compiled: ReturnType<typeof compileReport>;
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly students: StudentsService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  // ────────────────────────────────────────────────────────────────────────────────────
  // The registry, as the caller sees it
  // ────────────────────────────────────────────────────────────────────────────────────

  /** Sources this caller may use at all. A source they cannot use is not listed. */
  listSources(principal: Principal): ReportSourceSummary[] {
    return listReportSources()
      .filter((source) => this.canUseSource(principal, source))
      .map((source) => ({
        key: source.key,
        label: source.label,
        labelBn: source.labelBn,
        columnCount: visibleColumnKeys(source, principal).size,
      }));
  }

  /**
   * The column picker.
   *
   * A column whose permission the caller lacks is absent here, exactly as it is absent from
   * the projection — one `visibleColumnKeys` call answers both questions, so the UI cannot
   * offer a column the query would refuse or drop.
   */
  describeSource(principal: Principal, key: string): ReportSourceDetail {
    const source = this.requireSource(key);
    if (!this.canUseSource(principal, source)) {
      throw new ForbiddenError(source.permissions[0], 'You cannot use this report source');
    }

    const visible = visibleColumnKeys(source, principal);
    const columns: ReportColumnOption[] = [];
    for (const [columnKey, definition] of Object.entries(source.columns)) {
      if (!visible.has(columnKey)) continue;
      columns.push({
        key: columnKey,
        label: definition.label,
        ...(definition.labelBn ? { labelBn: definition.labelBn } : {}),
        type: definition.type,
        filterable: (definition.operators ?? []).length > 0,
        operators: definition.operators ?? [],
        sortable: definition.sortable ?? false,
        groupable: definition.groupable ?? false,
        aggregates: definition.aggregates ?? [],
        ...(definition.enumValues ? { enumValues: definition.enumValues } : {}),
      });
    }

    return {
      key: source.key,
      label: source.label,
      labelBn: source.labelBn,
      columnCount: columns.length,
      columns,
      defaultSort: source.defaultSort,
      maxRows: REPORT_MAX_ROWS,
    };
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Execution
  // ────────────────────────────────────────────────────────────────────────────────────

  /** Run a one-off query document. */
  async runAdHoc(
    principal: Principal,
    institutionId: string,
    query: ReportQueryInput,
  ): Promise<ReportResult> {
    const plan = this.plan(principal, institutionId, query);
    return this.execute(principal, institutionId, plan, { definitionId: null, scheduleId: null });
  }

  /**
   * Run a saved definition, optionally narrowed further.
   *
   * Extra filters can only reduce the result set: both sets are ANDed and both go through
   * the same allow-list, so "run someone else's report with my own filters" cannot become
   * "run it against rows I could not otherwise see".
   */
  async runDefinition(
    principal: Principal,
    institutionId: string,
    definitionId: string,
    input: { filters: ReportQueryInput['filters']; limit?: number },
  ): Promise<ReportResult> {
    const definition = await this.loadVisibleDefinition(principal, institutionId, definitionId);
    const saved = this.parseStoredQuery(definition);

    const query: ReportQueryInput = {
      ...saved,
      filters: [...saved.filters, ...input.filters],
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    };

    const plan = this.plan(principal, institutionId, query);
    return this.execute(principal, institutionId, plan, {
      definitionId: definition.id,
      scheduleId: null,
    });
  }

  /**
   * Validate and compile, without touching the database.
   *
   * Separated from `execute` so that a malformed request produces a 422 and **no run row**:
   * a run record means "data was read", and one that records a request the database never
   * saw would make the trail less trustworthy, not more.
   */
  private plan(
    principal: Principal,
    institutionId: string,
    query: ReportQueryInput,
  ): ExecutionPlan {
    const source = this.requireSource(query.sourceKey);
    const { predicate, scope } = this.resolveSourceAccess(principal, source);

    const predicates: SQL[] = [predicate];
    if (source.institutionColumn) {
      predicates.push(
        sql`${ref(source.table, source.institutionColumn)} = ${institutionId}::uuid`,
      );
    }
    if (source.archivedColumn) {
      predicates.push(sql`${ref(source.table, source.archivedColumn)} is null`);
    }
    // A module-specific rule that must survive the reporting surface: a family reads a
    // published result, never a computed draft.
    if (scope === 'own' && source.ownOnly) predicates.push(source.ownOnly);

    const limit = Math.min(query.limit ?? REPORT_MAX_ROWS, REPORT_MAX_ROWS);
    const visible = visibleColumnKeys(source, principal);

    // One row over the limit, so truncation is observed rather than guessed at.
    const compiled = compileReport({ source, query, visible, predicates, fetch: limit + 1 });

    return { source, query, limit, scope, compiled };
  }

  private async execute(
    principal: Principal,
    institutionId: string,
    plan: ExecutionPlan,
    origin: { definitionId: string | null; scheduleId: string | null },
  ): Promise<ReportResult> {
    const tenantId = principal.tenantId!;
    const compiled = plan.compiled;

    const runId = uuidv7();
    const startedAt = new Date();

    // Recorded before the query starts, in its own transaction, so a statement that times
    // out or is killed still leaves a `running` row behind rather than vanishing.
    await this.db.runInTenant(async (tx) => {
      await tx.insert(reportRuns).values({
        id: runId,
        tenantId,
        institutionId,
        definitionId: origin.definitionId,
        // The database refuses a row that is both, or neither.
        adHocDefinition: origin.definitionId ? null : plan.query,
        runBy: principal.userId,
        startedAt,
        status: 'running',
        parameters: {
          query: plan.query,
          limit: plan.limit,
          omittedColumns: compiled.omittedColumns,
          joinedRelations: compiled.joinedRelations,
          scope: plan.scope,
          scheduleId: origin.scheduleId,
        },
        createdBy: principal.userId,
      });
    });

    const started = Date.now();
    let rows: Record<string, unknown>[];
    try {
      rows = await this.db.runInTenant(async (tx) => {
        // Transaction-local, so it cannot leak into another request on a pooled connection.
        // A report is allowed to be slow; it is not allowed to hold a connection forever.
        await tx.execute(
          sql`select set_config('statement_timeout', ${String(REPORT_STATEMENT_TIMEOUT_MS)}, true)`,
        );
        const result = await tx.execute<Record<string, unknown>>(compiled.statement);
        return [...result.rows];
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.settleRun(runId, {
        status: 'failed',
        error: detail.slice(0, 1000),
        rowCount: null,
        durationMs: Date.now() - started,
      });
      // The upstream message can name tables and columns. It belongs in the run record and
      // the log, never in a response body.
      throw new InternalError('The report could not be completed', { runId, detail });
    }

    const truncated = rows.length > plan.limit;
    const page = truncated ? rows.slice(0, plan.limit) : rows;
    const durationMs = Date.now() - started;

    await this.settleRun(runId, {
      status: 'succeeded',
      error: null,
      rowCount: page.length,
      durationMs,
      truncated,
    });

    return {
      runId,
      definitionId: origin.definitionId,
      sourceKey: plan.source.key,
      columns: compiled.columns,
      omittedColumns: compiled.omittedColumns,
      rows: page,
      rowCount: page.length,
      truncated,
      limit: plan.limit,
      durationMs,
    };
  }

  private async settleRun(
    runId: string,
    outcome: {
      status: 'succeeded' | 'failed';
      error: string | null;
      rowCount: number | null;
      durationMs: number;
      truncated?: boolean;
    },
  ): Promise<void> {
    await this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select({ parameters: reportRuns.parameters })
        .from(reportRuns)
        .where(eq(reportRuns.id, runId))
        .limit(1);
      const parameters =
        existing && typeof existing.parameters === 'object' && existing.parameters !== null
          ? (existing.parameters as Record<string, unknown>)
          : {};

      await tx
        .update(reportRuns)
        .set({
          status: outcome.status,
          error: outcome.error,
          rowCount: outcome.rowCount,
          durationMs: outcome.durationMs,
          finishedAt: new Date(),
          parameters: { ...parameters, truncated: outcome.truncated ?? false },
        })
        .where(eq(reportRuns.id, runId));
    });
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Scoping
  // ────────────────────────────────────────────────────────────────────────────────────

  private canUseSource(principal: Principal, source: ReportSourceDef): boolean {
    if (source.scope.kind === 'institution') return canAny(principal, source.permissions);
    return this.resolveScope(principal, source) !== 'none';
  }

  private resolveScope(principal: Principal, source: ReportSourceDef): DataScope {
    const rule = source.scope;
    if (rule.kind === 'institution') return 'all';
    const context = currentContext();
    return resolveDataScope(principal, rule.resource, {
      institutionId: context?.institutionId ?? null,
      campusId: context?.campusId ?? null,
    });
  }

  /**
   * The row predicate for this caller on this source.
   *
   * For a student-centred source it is `StudentsService.scopeFilterSql` — the very predicate
   * the student list uses — either applied directly (the base table *is* `students`) or
   * wrapped in an `exists` keyed on the source's own student column. Writing a second
   * "which students may they see" rule here is precisely the mistake this module could not
   * survive, so it does not have one.
   */
  private resolveSourceAccess(
    principal: Principal,
    source: ReportSourceDef,
  ): { predicate: SQL; scope: DataScope | null } {
    // Captured in a const so the discriminated-union narrowing below survives the method
    // calls that follow it.
    const rule = source.scope;

    if (rule.kind === 'institution') {
      if (!canAny(principal, source.permissions)) {
        throw new ForbiddenError(source.permissions[0], 'You cannot use this report source');
      }
      return { predicate: sql`true`, scope: null };
    }

    const scope = this.resolveScope(principal, source);
    if (scope === 'none') {
      throw new ForbiddenError(rule.resource.all, 'You cannot use this report source');
    }

    const studentPredicate = this.students.scopeFilterSql(principal, scope);
    const studentColumn = rule.studentColumn;
    if (studentColumn === null) {
      return { predicate: studentPredicate, scope };
    }

    return {
      predicate: sql`exists (select 1 from public.students where ${ref('students', 'id')} = ${ref(
        source.table,
        studentColumn,
      )} and ${ref('students', 'archived_at')} is null and ${studentPredicate})`,
      scope,
    };
  }

  private requireSource(key: string): ReportSourceDef {
    const source = findReportSource(key);
    if (!source) {
      throw new ValidationError(`There is no report source named "${key}"`, [
        { path: 'sourceKey', message: `Unknown report source "${key}"` },
      ]);
    }
    return source;
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Definitions
  // ────────────────────────────────────────────────────────────────────────────────────

  async createDefinition(
    principal: Principal,
    institutionId: string,
    input: {
      key: string;
      name: string;
      nameBn?: string;
      query: ReportQueryInput;
      visibility: 'private' | 'role' | 'institution';
      status: 'draft' | 'published';
    },
  ): Promise<DefinitionRow> {
    // Compiling before saving means a definition that could never run is never stored — a
    // saved report that 422s the first time someone opens it is worse than a refused save.
    this.plan(principal, institutionId, input.query);

    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select({ id: reportDefinitions.id })
        .from(reportDefinitions)
        .where(
          and(
            eq(reportDefinitions.institutionId, institutionId),
            eq(reportDefinitions.key, input.key),
            isNull(reportDefinitions.archivedAt),
          ),
        )
        .limit(1);
      if (existing) {
        throw new ConflictError(`A report with the key "${input.key}" already exists`);
      }

      const [row] = await tx
        .insert(reportDefinitions)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          key: input.key,
          name: input.name,
          nameBn: input.nameBn ?? null,
          sourceKey: input.query.sourceKey,
          columns: input.query.columns,
          filters: input.query.filters,
          grouping: input.query.grouping ?? null,
          sorting: input.query.sorting,
          visibility: input.visibility,
          status: input.status,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return row!;
    });
  }

  async listDefinitions(
    principal: Principal,
    institutionId: string,
    query: { q?: string; sourceKey?: string; visibility?: string; status?: string },
    page: ListQuery,
  ): Promise<OffsetPage<DefinitionRow>> {
    const [sort] = parseSort(page.sort, REPORT_DEFINITION_SORT_FIELDS, {
      field: 'name',
      direction: 'asc',
    });
    const column =
      sort!.field === 'key'
        ? reportDefinitions.key
        : sort!.field === 'createdAt'
          ? reportDefinitions.createdAt
          : sort!.field === 'updatedAt'
            ? reportDefinitions.updatedAt
            : reportDefinitions.name;

    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [
        eq(reportDefinitions.institutionId, institutionId),
        isNull(reportDefinitions.archivedAt),
        this.definitionVisibilityFilter(principal),
      ];
      if (query.q) filters.push(ilike(reportDefinitions.name, `%${escapeLike(query.q)}%`));
      if (query.sourceKey) filters.push(eq(reportDefinitions.sourceKey, query.sourceKey));
      if (query.visibility) {
        filters.push(
          eq(reportDefinitions.visibility, query.visibility as DefinitionRow['visibility']),
        );
      }
      if (query.status) {
        filters.push(eq(reportDefinitions.status, query.status as DefinitionRow['status']));
      }

      const where = and(...filters);
      const rows = await tx
        .select()
        .from(reportDefinitions)
        .where(where)
        .orderBy(sort!.direction === 'desc' ? desc(column) : asc(column))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(reportDefinitions)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async getDefinition(
    principal: Principal,
    institutionId: string,
    id: string,
  ): Promise<DefinitionRow> {
    return this.loadVisibleDefinition(principal, institutionId, id);
  }

  async updateDefinition(
    principal: Principal,
    institutionId: string,
    id: string,
    input: {
      name?: string;
      nameBn?: string;
      query?: ReportQueryInput;
      visibility?: 'private' | 'role' | 'institution';
      status?: 'draft' | 'published';
      version: number;
    },
  ): Promise<DefinitionRow & { __audit: { previousValue: DefinitionRow } }> {
    if (input.query) this.plan(principal, institutionId, input.query);

    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadEditableDefinition(tx, principal, institutionId, id);
      if (existing.version !== input.version) {
        throw new ConflictError(
          'This report was changed by someone else. Reload it and try again.',
        );
      }

      const [row] = await tx
        .update(reportDefinitions)
        .set({
          name: input.name ?? existing.name,
          nameBn: input.nameBn ?? existing.nameBn,
          ...(input.query
            ? {
                sourceKey: input.query.sourceKey,
                columns: input.query.columns,
                filters: input.query.filters,
                grouping: input.query.grouping ?? null,
                sorting: input.query.sorting,
              }
            : {}),
          visibility: input.visibility ?? existing.visibility,
          status: input.status ?? existing.status,
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(reportDefinitions.id, id))
        .returning();

      return { ...row!, __audit: { previousValue: existing } };
    });
  }

  async archiveDefinition(
    principal: Principal,
    institutionId: string,
    id: string,
    input: { version: number; reason: string },
  ): Promise<DefinitionRow & { __audit: { previousValue: DefinitionRow } }> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadEditableDefinition(tx, principal, institutionId, id);
      if (existing.version !== input.version) {
        throw new ConflictError(
          'This report was changed by someone else. Reload it and try again.',
        );
      }

      const [row] = await tx
        .update(reportDefinitions)
        .set({
          status: 'archived',
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: input.reason,
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(reportDefinitions.id, id))
        .returning();

      return { ...row!, __audit: { previousValue: existing } };
    });
  }

  async shareDefinition(
    principal: Principal,
    institutionId: string,
    definitionId: string,
    input: { roleId?: string; userId?: string },
  ): Promise<ShareRow> {
    return this.db.runInTenant(async (tx) => {
      const definition = await this.loadEditableDefinition(
        tx,
        principal,
        institutionId,
        definitionId,
      );

      // Both lookups run under RLS, so a role or user id from another tenant simply is not
      // found — the 404 is produced by the same mechanism that would hide the row itself.
      if (input.roleId) {
        const [role] = await tx
          .select({ id: roles.id })
          .from(roles)
          .where(eq(roles.id, input.roleId))
          .limit(1);
        if (!role) throw new NotFoundError('Role', input.roleId);
      }
      if (input.userId) {
        const [user] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, input.userId))
          .limit(1);
        if (!user) throw new NotFoundError('User', input.userId);
      }

      const [row] = await tx
        .insert(reportShares)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId: definition.institutionId,
          definitionId: definition.id,
          roleId: input.roleId ?? null,
          userId: input.userId ?? null,
          createdBy: principal.userId,
        })
        .returning();
      return row!;
    });
  }

  async listShares(
    principal: Principal,
    institutionId: string,
    definitionId: string,
  ): Promise<ShareRow[]> {
    await this.loadVisibleDefinition(principal, institutionId, definitionId);
    return this.db.runInTenant(async (tx) =>
      tx
        .select()
        .from(reportShares)
        .where(
          and(eq(reportShares.definitionId, definitionId), isNull(reportShares.archivedAt)),
        ),
    );
  }

  /**
   * Who may read a definition.
   *
   * `institution` is open to anyone in the institution holding `reports.view`; `private` is
   * the author's alone; `role` adds whoever `report_shares` names. Note what this does *not*
   * do: it never widens data access. Sharing a definition shares the question.
   */
  private definitionVisibilityFilter(principal: Principal): SQL {
    const roleIds = principal.roles.map((grant) => grant.roleId).filter((id) => Boolean(id));

    const shareMatch: SQL =
      roleIds.length > 0
        ? or(
            eq(reportShares.userId, principal.userId),
            inArray(reportShares.roleId, roleIds),
          )!
        : eq(reportShares.userId, principal.userId);

    return or(
      eq(reportDefinitions.visibility, 'institution'),
      eq(reportDefinitions.createdBy, principal.userId),
      exists(
        this.db.raw
          .select({ one: sql`1` })
          .from(reportShares)
          .where(
            and(
              eq(reportShares.definitionId, reportDefinitions.id),
              isNull(reportShares.archivedAt),
              shareMatch,
            ),
          ),
      ),
    )!;
  }

  private async loadVisibleDefinition(
    principal: Principal,
    institutionId: string,
    id: string,
  ): Promise<DefinitionRow> {
    const row = await this.db.runInTenant(async (tx) => {
      const [found] = await tx
        .select()
        .from(reportDefinitions)
        .where(
          and(
            eq(reportDefinitions.id, id),
            eq(reportDefinitions.institutionId, institutionId),
            isNull(reportDefinitions.archivedAt),
            this.definitionVisibilityFilter(principal),
          ),
        )
        .limit(1);
      return found ?? null;
    });
    // A definition in another tenant, another institution, or one this caller may not see
    // are all the same answer. Confirming existence is itself a leak.
    if (!row) throw new NotFoundError('Report', id);
    return row;
  }

  /**
   * Load for editing: visible, not archived, and either the caller's own or something they
   * hold `reports.build` over *and* the author shared with them. A system definition is
   * never editable by a tenant.
   */
  private async loadEditableDefinition(
    tx: Tx,
    principal: Principal,
    institutionId: string,
    id: string,
  ): Promise<DefinitionRow> {
    const [found] = await tx
      .select()
      .from(reportDefinitions)
      .where(
        and(
          eq(reportDefinitions.id, id),
          eq(reportDefinitions.institutionId, institutionId),
          isNull(reportDefinitions.archivedAt),
          this.definitionVisibilityFilter(principal),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundError('Report', id);

    if (found.isSystem) {
      throw new PreconditionFailedError(
        'This report ships with the product and cannot be edited. Copy it instead.',
      );
    }
    if (found.createdBy !== principal.userId && !principal.isPlatformAdmin) {
      // Visible is not editable. Someone who was shared a report may run it, not rewrite it
      // under the original author's name.
      throw new ForbiddenError('reports.build', 'Only the author can change this report');
    }
    return found;
  }

  /**
   * Re-validate a stored definition into a query document.
   *
   * The stored jsonb is parsed through the *same* Zod schema a fresh request goes through.
   * A definition written before a registry change, or hand-edited in the database, therefore
   * fails validation rather than reaching the compiler in an unexpected shape.
   */
  private parseStoredQuery(definition: DefinitionRow): ReportQueryInput {
    const parsed = reportQuerySchema.safeParse({
      sourceKey: definition.sourceKey,
      columns: definition.columns,
      filters: definition.filters,
      grouping: definition.grouping ?? undefined,
      sorting: definition.sorting,
    });
    if (!parsed.success) {
      throw new ValidationError(
        'This saved report is no longer valid and must be edited before it can run',
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.') || '(root)',
          message: issue.message,
        })),
      );
    }
    return parsed.data;
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Runs
  // ────────────────────────────────────────────────────────────────────────────────────

  async listRuns(
    principal: Principal,
    institutionId: string,
    query: { definitionId?: string; status?: string; mine?: boolean },
    page: ListQuery,
  ): Promise<OffsetPage<RunRow>> {
    const [sort] = parseSort(page.sort, REPORT_RUN_SORT_FIELDS, {
      field: 'startedAt',
      direction: 'desc',
    });
    const column =
      sort!.field === 'finishedAt'
        ? reportRuns.finishedAt
        : sort!.field === 'rowCount'
          ? reportRuns.rowCount
          : reportRuns.startedAt;

    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [
        eq(reportRuns.institutionId, institutionId),
        this.runVisibilityFilter(principal),
      ];
      if (query.definitionId) filters.push(eq(reportRuns.definitionId, query.definitionId));
      if (query.status) filters.push(eq(reportRuns.status, query.status as RunRow['status']));
      if (query.mine) filters.push(eq(reportRuns.runBy, principal.userId));

      const where = and(...filters);
      const rows = await tx
        .select()
        .from(reportRuns)
        .where(where)
        .orderBy(sort!.direction === 'asc' ? asc(column) : desc(column))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(reportRuns)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async getRun(principal: Principal, institutionId: string, id: string): Promise<RunRow> {
    const row = await this.db.runInTenant(async (tx) => {
      const [found] = await tx
        .select()
        .from(reportRuns)
        .where(
          and(
            eq(reportRuns.id, id),
            eq(reportRuns.institutionId, institutionId),
            this.runVisibilityFilter(principal),
          ),
        )
        .limit(1);
      return found ?? null;
    });
    if (!row) throw new NotFoundError('Report run', id);
    return row;
  }

  /**
   * A run is visible to the person who ran it, and to anyone who can see the definition
   * behind it. An ad-hoc run belongs to its author alone: nobody else has any way to know
   * what it asked for, so nobody else has business reading its record.
   */
  private runVisibilityFilter(principal: Principal): SQL {
    return or(
      eq(reportRuns.runBy, principal.userId),
      exists(
        this.db.raw
          .select({ one: sql`1` })
          .from(reportDefinitions)
          .where(
            and(
              eq(reportDefinitions.id, reportRuns.definitionId),
              this.definitionVisibilityFilter(principal),
            ),
          ),
      ),
    )!;
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Exports
  // ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Produce a downloadable file from a previous run.
   *
   * The query is **re-executed under the exporting caller's own scope** rather than replayed
   * from stored rows. That is the safe direction: an export can only ever contain what this
   * caller could read right now, so a shared definition cannot become a way to obtain
   * someone else's result set. It also means the export gets its own run record — a second
   * disclosure deserves a second entry in the trail, not a footnote on the first.
   *
   * A truncated result is **refused**. Handing back a CSV that silently stops at row 5000 is
   * how a school reconciles its fee collection against the wrong number.
   */
  async createExport(
    principal: Principal,
    institutionId: string,
    runId: string,
    format: 'csv' | 'json',
  ): Promise<ReportExportResult> {
    const source = await this.getRun(principal, institutionId, runId);
    const query = this.queryFromRun(source);

    const plan = this.plan(principal, institutionId, query);
    const result = await this.execute(principal, institutionId, plan, {
      definitionId: source.definitionId,
      scheduleId: readScheduleId(source.parameters),
    });

    if (result.truncated) {
      throw new ValidationError(
        `This report returns more than ${result.limit} rows. Narrow the filters and export again — a partial file is worse than no file.`,
        [{ path: 'filters', message: 'Too many rows to export' }],
      );
    }

    return this.materialize(principal, institutionId, result, format, runId);
  }

  private async materialize(
    principal: Principal,
    institutionId: string,
    result: ReportResult,
    format: 'csv' | 'json',
    basedOnRunId: string | null,
  ): Promise<ReportExportResult> {
    const headers = result.columns.map((column) => column.key);
    const content =
      format === 'json'
        ? // `Date` values serialise as ISO strings, which is what the CSV path emits too.
          JSON.stringify(result.rows, null, 2)
        : serializeCsv(
            headers,
            result.rows.map((row) => headers.map((header) => toCell(row[header]))),
          );

    const body = Buffer.from(content, 'utf8');
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `${result.sourceKey}-${stamp}.${format}`;

    // The tenant prefix is applied by the storage service, not here; a report has no
    // business constructing an object key.
    const stored = await this.storage.put({
      tenantId: principal.tenantId!,
      category: 'reports',
      filename,
      contentType: format === 'json' ? 'application/json' : 'text/csv',
      body,
    });

    const ctx = currentContext();
    const expiresAt = new Date(Date.now() + REPORT_EXPORT_TTL_HOURS * 3_600_000);

    const row = await this.db.runInTenant(async (tx) => {
      const [inserted] = await tx
        .insert(reportExports)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          runId: result.runId,
          format,
          storageKey: stored.key,
          sizeBytes: stored.sizeBytes,
          rowCount: result.rowCount,
          expiresAt,
          createdBy: principal.userId,
        })
        .returning();

      // In the same transaction as the row that records the file. If the audit cannot be
      // written, the export does not exist — for a bulk disclosure, an untracked success is
      // worse than a failure.
      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((grant) => grant.roleKey),
        action: 'export',
        module: 'reports',
        resourceType: 'report_export',
        resourceId: inserted!.id,
        resourceLabel: `${result.rowCount} rows from ${result.sourceKey} as ${format}`,
        newValue: {
          runId: result.runId,
          basedOnRunId,
          definitionId: result.definitionId,
          sourceKey: result.sourceKey,
          format,
          rowCount: result.rowCount,
          columns: headers,
          omittedColumns: result.omittedColumns,
          sizeBytes: stored.sizeBytes,
        },
        requestId: ctx?.requestId ?? null,
        ipAddress: ctx?.ipAddress ?? null,
        userAgent: ctx?.userAgent ?? null,
      });

      return inserted!;
    });

    return {
      export: row,
      runId: result.runId,
      basedOnRunId,
      rowCount: result.rowCount,
      filename,
    };
  }

  /**
   * Fetch an export's bytes.
   *
   * Three gates, in order: the row must be visible under RLS, the caller must be entitled to
   * the run behind it, and the download window must still be open. The download is audited
   * as its own event — the file may be fetched long after, and by someone other than, the
   * person who produced it.
   */
  async downloadExport(
    principal: Principal,
    institutionId: string,
    id: string,
  ): Promise<{ content: Buffer; format: 'csv' | 'json'; filename: string }> {
    const row = await this.db.runInTenant(async (tx) => {
      const [found] = await tx
        .select()
        .from(reportExports)
        .where(and(eq(reportExports.id, id), eq(reportExports.institutionId, institutionId)))
        .limit(1);
      return found ?? null;
    });
    if (!row) throw new NotFoundError('Report export', id);

    await this.assertExportReadable(principal, institutionId, row);

    if (row.expiresAt.getTime() <= Date.now()) {
      throw new PreconditionFailedError(
        'This export has expired. Run the report again to produce a fresh one.',
      );
    }

    const content = await this.storage.get(row.storageKey);

    const ctx = currentContext();
    await this.audit.record({
      tenantId: principal.tenantId,
      institutionId,
      actorUserId: principal.userId,
      actorRoles: principal.roles.map((grant) => grant.roleKey),
      action: 'export',
      module: 'reports',
      resourceType: 'report_export_download',
      resourceId: row.id,
      resourceLabel: `${row.rowCount} rows as ${row.format}`,
      newValue: { runId: row.runId, format: row.format, sizeBytes: row.sizeBytes },
      requestId: ctx?.requestId ?? null,
      ipAddress: ctx?.ipAddress ?? null,
      userAgent: ctx?.userAgent ?? null,
    });

    const stamp = row.createdAt.toISOString().slice(0, 10);
    return {
      content,
      format: row.format,
      filename: `report-${stamp}.${row.format}`,
    };
  }

  /**
   * May this caller take the file?
   *
   * Producing it is not the only legitimate route: a scheduled run's `recipients` are exactly
   * the people the schedule exists to serve, so they may download what it produced even
   * though they did not run it. That is what makes `recipients` a real permission rather
   * than a decorative list.
   */
  private async assertExportReadable(
    principal: Principal,
    institutionId: string,
    row: ExportRow,
  ): Promise<void> {
    const run = await this.db.runInTenant(async (tx) => {
      const [found] = await tx
        .select()
        .from(reportRuns)
        .where(eq(reportRuns.id, row.runId))
        .limit(1);
      return found ?? null;
    });
    if (!run) throw new NotFoundError('Report export', row.id);

    if (run.runBy === principal.userId) return;

    const scheduleId = readScheduleId(run.parameters);
    if (scheduleId) {
      const schedule = await this.db.runInTenant(async (tx) => {
        const [found] = await tx
          .select()
          .from(reportSchedules)
          .where(eq(reportSchedules.id, scheduleId))
          .limit(1);
        return found ?? null;
      });
      if (schedule && readRecipients(schedule.recipients).includes(principal.userId)) return;
    }

    if (run.definitionId) {
      // Throws NotFound when the definition is not visible, which is the right answer here
      // too: the caller learns nothing about an export they have no claim on.
      await this.loadVisibleDefinition(principal, institutionId, run.definitionId);
      return;
    }

    throw new NotFoundError('Report export', row.id);
  }

  private queryFromRun(run: RunRow): ReportQueryInput {
    const parameters =
      typeof run.parameters === 'object' && run.parameters !== null
        ? (run.parameters as Record<string, unknown>)
        : {};
    const candidate = parameters['query'] ?? run.adHocDefinition;
    const parsed = reportQuerySchema.safeParse(candidate);
    if (!parsed.success) {
      throw new ValidationError('This run cannot be replayed; its query is no longer valid', [
        { path: 'runId', message: 'The stored query document is not valid' },
      ]);
    }
    return parsed.data;
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Schedules
  // ────────────────────────────────────────────────────────────────────────────────────

  async createSchedule(
    principal: Principal,
    institutionId: string,
    input: {
      definitionId: string;
      cronExpression: string;
      timezone: 'Asia/Dhaka';
      recipients: string[];
      format: 'csv' | 'json';
      isActive: boolean;
    },
  ): Promise<ScheduleRow> {
    const definition = await this.loadVisibleDefinition(
      principal,
      institutionId,
      input.definitionId,
    );

    const spec = parseCronExpression(input.cronExpression);
    const nextRunAt = nextCronOccurrence(spec, new Date());

    return this.db.runInTenant(async (tx) => {
      await this.assertRecipientsExist(tx, input.recipients);

      const [row] = await tx
        .insert(reportSchedules)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId: definition.institutionId,
          definitionId: definition.id,
          cronExpression: input.cronExpression,
          timezone: input.timezone,
          recipients: input.recipients,
          format: input.format,
          isActive: input.isActive,
          nextRunAt,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return row!;
    });
  }

  async listSchedules(
    principal: Principal,
    institutionId: string,
    query: { definitionId?: string; isActive?: boolean },
    page: OffsetPageRequest,
  ): Promise<OffsetPage<ScheduleRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [
        eq(reportSchedules.institutionId, institutionId),
        isNull(reportSchedules.archivedAt),
        exists(
          this.db.raw
            .select({ one: sql`1` })
            .from(reportDefinitions)
            .where(
              and(
                eq(reportDefinitions.id, reportSchedules.definitionId),
                this.definitionVisibilityFilter(principal),
              ),
            ),
        ),
      ];
      if (query.definitionId) filters.push(eq(reportSchedules.definitionId, query.definitionId));
      if (query.isActive !== undefined) {
        filters.push(eq(reportSchedules.isActive, query.isActive));
      }

      const where = and(...filters);
      const rows = await tx
        .select()
        .from(reportSchedules)
        .where(where)
        .orderBy(asc(reportSchedules.nextRunAt))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(reportSchedules)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async updateSchedule(
    principal: Principal,
    institutionId: string,
    id: string,
    input: {
      cronExpression?: string;
      recipients?: string[];
      format?: 'csv' | 'json';
      isActive?: boolean;
      version: number;
    },
  ): Promise<ScheduleRow & { __audit: { previousValue: ScheduleRow } }> {
    const nextRunAt = input.cronExpression
      ? nextCronOccurrence(parseCronExpression(input.cronExpression), new Date())
      : undefined;

    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadSchedule(tx, principal, institutionId, id);
      if (existing.version !== input.version) {
        throw new ConflictError(
          'This schedule was changed by someone else. Reload it and try again.',
        );
      }
      if (input.recipients) await this.assertRecipientsExist(tx, input.recipients);

      const [row] = await tx
        .update(reportSchedules)
        .set({
          cronExpression: input.cronExpression ?? existing.cronExpression,
          recipients: input.recipients ?? existing.recipients,
          format: input.format ?? existing.format,
          isActive: input.isActive ?? existing.isActive,
          ...(nextRunAt ? { nextRunAt } : {}),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(reportSchedules.id, id))
        .returning();

      return { ...row!, __audit: { previousValue: existing } };
    });
  }

  async archiveSchedule(
    principal: Principal,
    institutionId: string,
    id: string,
    input: { version: number; reason: string },
  ): Promise<ScheduleRow & { __audit: { previousValue: ScheduleRow } }> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadSchedule(tx, principal, institutionId, id);
      if (existing.version !== input.version) {
        throw new ConflictError(
          'This schedule was changed by someone else. Reload it and try again.',
        );
      }

      const [row] = await tx
        .update(reportSchedules)
        .set({
          isActive: false,
          nextRunAt: null,
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: input.reason,
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(reportSchedules.id, id))
        .returning();

      return { ...row!, __audit: { previousValue: existing } };
    });
  }

  /**
   * Execute a schedule now.
   *
   * This is the whole schedule, actually happening: the definition runs under the caller's
   * scope, an export is produced and audited, `last_run_at` moves and `next_run_at` is
   * recomputed from the cron expression. Nothing here pretends a background worker exists.
   */
  async runSchedule(
    principal: Principal,
    institutionId: string,
    id: string,
  ): Promise<ReportExportResult> {
    const schedule = await this.db.runInTenant(async (tx) =>
      this.loadSchedule(tx, principal, institutionId, id),
    );
    if (!schedule.isActive) {
      throw new PreconditionFailedError('This schedule is paused. Activate it before running it.');
    }

    const definition = await this.loadVisibleDefinition(
      principal,
      institutionId,
      schedule.definitionId,
    );
    const query = this.parseStoredQuery(definition);
    const plan = this.plan(principal, institutionId, query);
    const result = await this.execute(principal, institutionId, plan, {
      definitionId: definition.id,
      scheduleId: schedule.id,
    });

    if (result.truncated) {
      throw new ValidationError(
        `This report returns more than ${result.limit} rows. Narrow the saved filters before scheduling it.`,
        [{ path: 'filters', message: 'Too many rows to export' }],
      );
    }

    const produced = await this.materialize(principal, institutionId, result, schedule.format, null);

    const ranAt = new Date();
    await this.db.runInTenant(async (tx) => {
      await tx
        .update(reportSchedules)
        .set({
          lastRunAt: ranAt,
          nextRunAt: nextCronOccurrence(parseCronExpression(schedule.cronExpression), ranAt),
          version: schedule.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(reportSchedules.id, schedule.id));
    });

    return produced;
  }

  private async loadSchedule(
    tx: Tx,
    principal: Principal,
    institutionId: string,
    id: string,
  ): Promise<ScheduleRow> {
    const [found] = await tx
      .select()
      .from(reportSchedules)
      .where(
        and(
          eq(reportSchedules.id, id),
          eq(reportSchedules.institutionId, institutionId),
          isNull(reportSchedules.archivedAt),
          exists(
            this.db.raw
              .select({ one: sql`1` })
              .from(reportDefinitions)
              .where(
                and(
                  eq(reportDefinitions.id, reportSchedules.definitionId),
                  this.definitionVisibilityFilter(principal),
                ),
              ),
          ),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundError('Report schedule', id);
    return found;
  }

  /**
   * Recipients must be real users in this tenant.
   *
   * The lookup runs under RLS, so a user id from another tenant is simply not found — which
   * is also how a schedule cannot be used to probe for user ids elsewhere.
   */
  private async assertRecipientsExist(tx: Tx, recipients: string[]): Promise<void> {
    if (recipients.length === 0) return;
    const unique = [...new Set(recipients)];
    const found = await tx
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, unique));
    const known = new Set(found.map((row) => row.id));
    const missing = unique.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw new ValidationError('Some recipients are not users of this school', [
        { path: 'recipients', message: `Unknown user(s): ${missing.join(', ')}` },
      ]);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Serialisation
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * RFC 4180 quoting, plus one hardening step: a cell whose first character is `=`, `+`, `-`
 * or `@` is prefixed with a single quote.
 *
 * Without it, a student whose name a data-entry clerk typed as `=cmd|...` becomes a formula
 * the moment the exported register is opened in Excel. The value is preserved exactly; only
 * its interpretation as a formula is disarmed.
 */
function serializeCsv(headers: string[], rows: string[][]): string {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

function csvCell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (/[",\r\n]/.test(guarded)) return `"${guarded.replace(/"/g, '""')}"`;
  return guarded;
}

function toCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function readScheduleId(parameters: unknown): string | null {
  if (typeof parameters !== 'object' || parameters === null) return null;
  const value = (parameters as Record<string, unknown>)['scheduleId'];
  return typeof value === 'string' ? value : null;
}

function readRecipients(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Cron
//
// A five-field parser and a forward search for the next occurrence. Hand-written rather than
// pulled in as a dependency because the platform serves one timezone with no daylight saving,
// which makes the arithmetic exact: shift into Dhaka wall-clock time by a fixed +06:00, match
// day by day, and shift back. A zone with DST would need a real library, which is why the
// schema refuses one.
// ─────────────────────────────────────────────────────────────────────────────────────

export interface CronSpec {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
  domRestricted: boolean;
  dowRestricted: boolean;
}

const DAY_MS = 86_400_000;
const DHAKA_OFFSET_MS = DHAKA_UTC_OFFSET_MINUTES * 60_000;

export function parseCronExpression(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new ValidationError('A cron expression has five fields', [
      {
        path: 'cronExpression',
        message: 'Use: minute hour day-of-month month day-of-week',
      },
    ]);
  }

  const daysOfWeek = parseCronField(fields[4]!, 0, 7, 'day-of-week').map((value) =>
    value === 7 ? 0 : value,
  );

  return {
    minutes: parseCronField(fields[0]!, 0, 59, 'minute'),
    hours: parseCronField(fields[1]!, 0, 23, 'hour'),
    daysOfMonth: parseCronField(fields[2]!, 1, 31, 'day-of-month'),
    months: parseCronField(fields[3]!, 1, 12, 'month'),
    daysOfWeek: [...new Set(daysOfWeek)].sort((a, b) => a - b),
    domRestricted: fields[2] !== '*',
    dowRestricted: fields[4] !== '*',
  };
}

function parseCronField(raw: string, min: number, max: number, label: string): number[] {
  const values = new Set<number>();

  for (const part of raw.split(',')) {
    const segments = part.split('/');
    if (segments.length > 2 || segments[0] === undefined || segments[0] === '') {
      throw cronError(label);
    }

    let step = 1;
    if (segments.length === 2) {
      step = Number(segments[1]);
      if (!Number.isInteger(step) || step < 1 || step > max) throw cronError(label);
    }

    const range = segments[0];
    let low: number;
    let high: number;

    if (range === '*') {
      low = min;
      high = max;
    } else if (range.includes('-')) {
      const bounds = range.split('-');
      if (bounds.length !== 2) throw cronError(label);
      low = Number(bounds[0]);
      high = Number(bounds[1]);
    } else {
      low = Number(range);
      // `5/2` means "from 5, every 2, to the end of the field"; a bare `5` means only 5.
      high = segments.length === 2 ? max : low;
    }

    if (!Number.isInteger(low) || !Number.isInteger(high)) throw cronError(label);
    if (low < min || high > max || low > high) throw cronError(label);

    for (let value = low; value <= high; value += step) values.add(value);
  }

  if (values.size === 0) throw cronError(label);
  return [...values].sort((a, b) => a - b);
}

function cronError(label: string): ValidationError {
  return new ValidationError(`The ${label} field of this cron expression is not valid`, [
    { path: 'cronExpression', message: `Invalid ${label} field` },
  ]);
}

/**
 * The first instant strictly after `after` that the expression matches.
 *
 * The search is bounded at ~8 years of days, which is the longest legitimate gap a five-field
 * expression can produce (`0 0 29 2 *` — the 29th of February across a century boundary).
 * Beyond that the expression matches nothing, and a schedule that will never fire is refused
 * rather than stored as a promise nobody keeps.
 */
export function nextCronOccurrence(spec: CronSpec, after: Date): Date {
  const localAfter = after.getTime() + DHAKA_OFFSET_MS;
  const firstMinute = Math.floor(localAfter / 60_000) * 60_000 + 60_000;
  let day = Math.floor(firstMinute / DAY_MS) * DAY_MS;

  for (let attempt = 0; attempt < 3000; attempt += 1) {
    const cursor = new Date(day);
    const month = cursor.getUTCMonth() + 1;
    if (spec.months.includes(month) && dayMatches(spec, cursor.getUTCDate(), cursor.getUTCDay())) {
      for (const hour of spec.hours) {
        for (const minute of spec.minutes) {
          const candidate = day + hour * 3_600_000 + minute * 60_000;
          if (candidate >= firstMinute) return new Date(candidate - DHAKA_OFFSET_MS);
        }
      }
    }
    day += DAY_MS;
  }

  throw new ValidationError('This cron expression never matches a date', [
    { path: 'cronExpression', message: 'This schedule would never run' },
  ]);
}

/**
 * The standard cron day rule: when *both* day-of-month and day-of-week are restricted, a day
 * matching either one matches. It reads as a bug and is not one — `0 0 1,15 * 1` means "the
 * 1st, the 15th, and every Monday".
 */
function dayMatches(spec: CronSpec, dayOfMonth: number, dayOfWeek: number): boolean {
  if (spec.domRestricted && spec.dowRestricted) {
    return spec.daysOfMonth.includes(dayOfMonth) || spec.daysOfWeek.includes(dayOfWeek);
  }
  if (spec.domRestricted) return spec.daysOfMonth.includes(dayOfMonth);
  if (spec.dowRestricted) return spec.daysOfWeek.includes(dayOfWeek);
  return true;
}
