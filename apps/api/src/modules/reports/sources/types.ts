/**
 * The report source registry's vocabulary.
 *
 * The single rule this file exists to enforce: **a report is assembled from a registry,
 * never from client-supplied SQL.** A client sends *keys*. A key is looked up in a source's
 * `columns` / `relations` map, and only the constants found there — physical table and
 * column names written by a developer, in this repository — are ever turned into
 * identifiers. Everything a caller supplies that is not a key is a bound parameter.
 *
 * That gives three independent layers, and an attacker has to defeat all three:
 *
 *   1. Zod narrows a key to `[A-Za-z][A-Za-z0-9_]*` before it reaches this code.
 *   2. The key must be present in the source's allow-list, or the request is a 422 that
 *      names the field. Presence is decided by `Map.has`, not by string matching.
 *   3. What is emitted is the registry's own constant, wrapped in `sql.identifier(...)`,
 *      which quotes and escapes it.
 *
 * A column additionally declares the permission required to *see* it. Anything the caller
 * lacks is dropped from the projection and from the column picker, and is unusable as a
 * filter, sort or group key — a filter on an invisible column would be an oracle
 * ("does any student's medical note contain 'HIV'?") even though the column never appears
 * in the output.
 */

import { sql, type SQL } from 'drizzle-orm';
import type { Permission, ScopedResourcePermissions } from '@shikkha/permissions';
import type { REPORT_AGGREGATE_FUNCTIONS, REPORT_FILTER_OPERATORS } from '@shikkha/validation';

export type ReportOperator = (typeof REPORT_FILTER_OPERATORS)[number];
export type ReportAggregateFn = (typeof REPORT_AGGREGATE_FUNCTIONS)[number];

/**
 * The column's storage type, which decides three things: the cast applied to a bound
 * parameter, whether a value is plausible before it is bound, and which aggregates make
 * sense. It is registry-declared, never inferred from the caller.
 */
export type ReportColumnType =
  | 'uuid'
  | 'text'
  | 'enum'
  | 'number'
  | 'money'
  | 'date'
  | 'timestamp'
  | 'boolean';

export interface ReportColumnDef {
  /** Physical column name. A constant in this repository; never client-supplied. */
  column: string;
  /**
   * Which relation this column lives on. Absent means the source's base table. A named
   * relation must exist in the source's `relations` map; selecting the column is what
   * causes that relation's LEFT JOIN to be emitted.
   */
  relation?: string;
  type: ReportColumnType;
  label: string;
  labelBn?: string;
  /**
   * Extra permission required to see this column at all. Absent means the source's own
   * permission is enough. Medical notes and salary figures are the reason this exists.
   */
  permission?: Permission;
  /** Operators this column accepts. Absent or empty means the column is not filterable. */
  operators?: readonly ReportOperator[];
  sortable?: boolean;
  groupable?: boolean;
  /** Aggregates this column accepts under a `group by`. */
  aggregates?: readonly ReportAggregateFn[];
  /** Enum members, so the column picker can render a value list rather than a free text box. */
  enumValues?: readonly string[];
}

/**
 * A joinable relation.
 *
 * `on` is built from `sql.identifier` calls at module load — never from a string that could
 * be assembled at request time — which is why the type is `SQL` and not `string`.
 */
export interface ReportRelationDef {
  /** Physical table to join. */
  table: string;
  /** Fixed SQL alias. A constant, so two relations can join the same table unambiguously. */
  alias: string;
  /** The ON predicate. Always a LEFT JOIN: a relation must never drop base rows. */
  on: SQL;
  /** Human label for the picker. */
  label: string;
}

/**
 * How rows are narrowed to what this caller may read.
 *
 *  - `student` — resolve the caller's data scope over `resource` and apply
 *    `StudentsService.scopeFilterSql`, the same predicate the normal endpoints use. When
 *    `studentColumn` is null the source's base table *is* `students`; otherwise the
 *    predicate is wrapped in an `exists` against `students` keyed on that column.
 *  - `institution` — the source carries no per-row rule beyond its permission and the
 *    institution filter. Used for staff and audit data, matching what the HR directory and
 *    the audit log endpoint already do.
 */
export type ReportScopeRule =
  | { kind: 'student'; resource: ScopedResourcePermissions; studentColumn: string | null }
  | { kind: 'institution' };

export interface ReportSourceDef {
  key: string;
  label: string;
  labelBn: string;
  /** Physical base table. A constant in this repository. */
  table: string;
  /**
   * Any one of these lets the caller use the source at all. For a student-scoped source the
   * real gate is `resolveDataScope`, and this list exists so the source picker can be
   * filtered without resolving a scope per source.
   */
  permissions: readonly Permission[];
  scope: ReportScopeRule;
  /** Column carrying `institution_id`, or null for a tenant-wide source (the audit log). */
  institutionColumn: string | null;
  /** Column carrying `archived_at`, filtered to live rows. Null when the table has none. */
  archivedColumn: string | null;
  /**
   * An extra predicate ANDed when the resolved data scope is `own`. This is where a rule
   * that belongs to a specific module lives — a family may only read a *published* result,
   * so the reporting surface cannot become the way around that.
   */
  ownOnly?: SQL;
  relations: Record<string, ReportRelationDef>;
  columns: Record<string, ReportColumnDef>;
  defaultSort: { field: string; direction: 'asc' | 'desc' };
}

/** `"table"."column"`, both sides escaped. The only way this module names a column. */
export function ref(table: string, column: string): SQL {
  return sql`${sql.identifier(table)}.${sql.identifier(column)}`;
}

/** The physical location a column key resolves to: base table, or a relation's alias. */
export function columnRef(source: ReportSourceDef, definition: ReportColumnDef): SQL {
  if (!definition.relation) return ref(source.table, definition.column);
  const relation = source.relations[definition.relation];
  if (!relation) {
    // A registry bug, not a request problem: a column naming a relation the source does not
    // declare would otherwise emit an unqualified identifier. Fail loudly at the first use.
    throw new Error(
      `Report source "${source.key}" column "${definition.column}" names unknown relation "${definition.relation}"`,
    );
  }
  return ref(relation.alias, definition.column);
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Registry-building helpers. Every argument is a literal written here; nothing in this
// section may ever be reached with a value that came off the wire.
// ─────────────────────────────────────────────────────────────────────────────────────

export const TEXT_OPERATORS = [
  'eq',
  'ne',
  'in',
  'not_in',
  'contains',
  'starts_with',
  'is_null',
  'is_not_null',
] as const satisfies readonly ReportOperator[];

export const ENUM_OPERATORS = [
  'eq',
  'ne',
  'in',
  'not_in',
  'is_null',
  'is_not_null',
] as const satisfies readonly ReportOperator[];

export const NUMERIC_OPERATORS = [
  'eq',
  'ne',
  'lt',
  'lte',
  'gt',
  'gte',
  'between',
  'is_null',
  'is_not_null',
] as const satisfies readonly ReportOperator[];

export const TEMPORAL_OPERATORS = NUMERIC_OPERATORS;

export const ID_OPERATORS = [
  'eq',
  'ne',
  'in',
  'not_in',
  'is_null',
  'is_not_null',
] as const satisfies readonly ReportOperator[];

export const BOOLEAN_OPERATORS = [
  'eq',
  'ne',
  'is_null',
  'is_not_null',
] as const satisfies readonly ReportOperator[];

export const NUMERIC_AGGREGATES = [
  'count',
  'sum',
  'avg',
  'min',
  'max',
] as const satisfies readonly ReportAggregateFn[];

export const COUNT_ONLY = ['count'] as const satisfies readonly ReportAggregateFn[];
