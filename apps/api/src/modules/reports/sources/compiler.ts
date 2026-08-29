/**
 * The query compiler: a validated report document in, one parameterised statement out.
 *
 * Assume an attacker is reading this file, because they are. The properties it maintains:
 *
 *  1. **No caller-supplied string is ever concatenated into SQL.** Identifiers come from the
 *     registry and pass through `sql.identifier`; values are bound as parameters by
 *     Drizzle's `sql` tag. There is no `sql.raw` anywhere in this module.
 *  2. **A key that is not in the source's allow-list is a 422 that names the field**, and so
 *     is a key the caller lacks the permission for when it is used as a *filter*, *sort* or
 *     *group* key. The message is identical in both cases: telling an attacker that
 *     `medicalConditions` exists but is forbidden is a free hint, and being able to filter on
 *     a column you cannot see is an oracle even when it never appears in the output.
 *  3. **An operator outside the column's declared list is a 422**, even if it is a valid
 *     operator elsewhere. `contains` on a uuid column is not a search, it is an attempt.
 *  4. **A value is type-checked before it is bound.** A non-uuid in a uuid filter is a 422; a
 *     SQL fragment in a *text* filter is bound as a parameter and simply matches nothing,
 *     which is the correct outcome for a legitimate search for a string containing a quote.
 *  5. **Selecting a column the caller may not see omits it** — from the projection and from
 *     the reported column list — rather than returning it as null. A null column implies the
 *     value is empty; an absent column says nothing at all.
 *
 * The compiler never opens a transaction, never touches the database, and knows nothing about
 * tenancy: the scope and institution predicates arrive already built, so a caller cannot
 * forget them by taking a different code path.
 */

import { sql, type SQL } from 'drizzle-orm';
import { ValidationError, type FieldIssue } from '@shikkha/shared';
import { can, type Principal } from '@shikkha/permissions';
import type {
  ReportFilterInput,
  ReportQueryInput,
  ReportSortInput,
} from '@shikkha/validation';
import {
  columnRef,
  type ReportAggregateFn,
  type ReportColumnDef,
  type ReportColumnType,
  type ReportSourceDef,
} from './types';

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const NUMERIC_PATTERN = /^-?\d{1,15}(\.\d{1,6})?$/;

export interface CompiledColumn {
  key: string;
  label: string;
  labelBn?: string;
  type: ReportColumnType;
  /** Set for an aggregate output column, so a client can render it differently. */
  aggregate?: ReportAggregateFn;
}

export interface CompiledReport {
  /** The columns actually projected, in output order. */
  columns: CompiledColumn[];
  /** Columns the caller asked for and may not see. Reported, never silently dropped. */
  omittedColumns: string[];
  statement: SQL;
  /** Relations that ended up joined — recorded on the run for later explanation. */
  joinedRelations: string[];
}

/**
 * The column keys this principal may see on this source.
 *
 * One function, used by the picker endpoint and by the compiler, so the set the UI offers and
 * the set the query honours can never drift apart.
 */
export function visibleColumnKeys(source: ReportSourceDef, principal: Principal): Set<string> {
  const visible = new Set<string>();
  for (const [key, definition] of Object.entries(source.columns)) {
    if (definition.permission && !can(principal, definition.permission)) continue;
    visible.add(key);
  }
  return visible;
}

export interface CompileInput {
  source: ReportSourceDef;
  query: ReportQueryInput;
  visible: ReadonlySet<string>;
  /** Scope, institution, archived and any source-specific predicates. Already built. */
  predicates: readonly SQL[];
  /** Rows to fetch. The service passes limit + 1 so it can detect truncation honestly. */
  fetch: number;
}

export function compileReport(input: CompileInput): CompiledReport {
  const { source, query, visible, predicates, fetch } = input;

  const usedRelations = new Set<string>();
  const selections: SQL[] = [];
  const columns: CompiledColumn[] = [];
  const omittedColumns: string[] = [];
  const outputKeys = new Set<string>();

  const noteRelation = (definition: ReportColumnDef) => {
    if (definition.relation) usedRelations.add(definition.relation);
  };

  // ── Projection ─────────────────────────────────────────────────────────────────────

  if (query.grouping) {
    for (const field of query.grouping.fields) {
      // A grouping key is a filter by another name: it partitions the data, so an invisible
      // column must be refused rather than dropped.
      const definition = requireUsableColumn(source, visible, field, 'grouping.fields');
      if (!definition.groupable) {
        throw fieldError(
          `The field "${field}" cannot be grouped on report source "${source.key}"`,
          'grouping.fields',
        );
      }
      noteRelation(definition);
      selections.push(sql`${columnRef(source, definition)} as ${sql.identifier(field)}`);
      columns.push(describe(field, definition));
      outputKeys.add(field);
    }

    for (const aggregate of query.grouping.aggregates) {
      const definition = requireUsableColumn(source, visible, aggregate.field, 'grouping.aggregates');
      const permitted = definition.aggregates ?? [];
      if (!permitted.includes(aggregate.fn)) {
        throw fieldError(
          `The aggregate "${aggregate.fn}" is not available for "${aggregate.field}" on report source "${source.key}"`,
          'grouping.aggregates',
        );
      }
      const alias = aggregate.alias ?? `${aggregate.fn}_${aggregate.field}`;
      if (outputKeys.has(alias)) {
        throw fieldError(
          `The output name "${alias}" is used twice; give the aggregate an alias`,
          'grouping.aggregates',
        );
      }
      noteRelation(definition);
      selections.push(
        sql`${aggregateExpression(aggregate.fn, columnRef(source, definition))} as ${sql.identifier(alias)}`,
      );
      columns.push({
        key: alias,
        label: `${aggregate.fn} of ${definition.label}`,
        // `count` is a count whatever it counts; the rest keep the column's own type.
        type: aggregate.fn === 'count' ? 'number' : definition.type,
        aggregate: aggregate.fn,
      });
      outputKeys.add(alias);
    }
  } else {
    for (const key of query.columns) {
      const definition = source.columns[key];
      if (!definition) throw unknownField(source, key, 'columns');
      if (!visible.has(key)) {
        // The permission case, and the only place a requested key does not become an error:
        // a saved definition written by a colleague who *does* hold `students.medical.view`
        // must still run for everyone else, minus the columns they may not read.
        omittedColumns.push(key);
        continue;
      }
      noteRelation(definition);
      selections.push(sql`${columnRef(source, definition)} as ${sql.identifier(key)}`);
      columns.push(describe(key, definition));
      outputKeys.add(key);
    }

    if (selections.length === 0) {
      throw fieldError(
        `None of the selected columns are available to you on report source "${source.key}"`,
        'columns',
      );
    }
  }

  // ── Filters ────────────────────────────────────────────────────────────────────────

  const wherePredicates: SQL[] = [...predicates];
  query.filters.forEach((clause, index) => {
    const definition = requireUsableColumn(source, visible, clause.field, `filters.${index}.field`);
    noteRelation(definition);
    wherePredicates.push(
      compileFilter(source, definition, clause, `filters.${index}`),
    );
  });

  // ── Sorting ────────────────────────────────────────────────────────────────────────

  const orderBy: SQL[] = [];
  query.sorting.forEach((spec, index) => {
    orderBy.push(compileSort(source, visible, query, outputKeys, spec, `sorting.${index}.field`));
  });

  if (orderBy.length === 0) {
    // A report with no stable order paginates and exports inconsistently. The source's own
    // default is used when it is still available to this caller; otherwise the first
    // projected column, which always is.
    const fallback = source.columns[source.defaultSort.field];
    if (!query.grouping && fallback && visible.has(source.defaultSort.field)) {
      noteRelation(fallback);
      orderBy.push(direction(columnRef(source, fallback), source.defaultSort.direction));
    } else {
      const first = columns[0]!;
      orderBy.push(direction(sql`${sql.identifier(first.key)}`, 'asc'));
    }
  }

  // ── Assembly ───────────────────────────────────────────────────────────────────────

  const joinedRelations = Object.keys(source.relations).filter((key) => usedRelations.has(key));
  const joins: SQL[] = joinedRelations.map((key) => {
    const relation = source.relations[key]!;
    // Always LEFT: a relation exists to decorate a row, never to silently remove one. An
    // INNER JOIN here would make "students with no current salary assignment" vanish from a
    // staff report, which reads as data loss rather than as a join.
    return sql` left join public.${sql.identifier(relation.table)} as ${sql.identifier(relation.alias)} on ${relation.on}`;
  });

  const statement = sql`select ${sql.join(selections, sql`, `)} from public.${sql.identifier(source.table)}${sql.join(joins, sql``)} where ${sql.join(wherePredicates, sql` and `)}${
    query.grouping
      ? sql` group by ${sql.join(
          query.grouping.fields.map((field) => columnRef(source, source.columns[field]!)),
          sql`, `,
        )}`
      : sql``
  } order by ${sql.join(orderBy, sql`, `)} limit ${fetch}`;

  return { columns, omittedColumns, statement, joinedRelations };
}

// ─────────────────────────────────────────────────────────────────────────────────────

function describe(key: string, definition: ReportColumnDef): CompiledColumn {
  return {
    key,
    label: definition.label,
    ...(definition.labelBn ? { labelBn: definition.labelBn } : {}),
    type: definition.type,
  };
}

/**
 * Resolve a key that is being used as a filter, sort or group field.
 *
 * Unknown and forbidden produce the *same* error, on purpose — see the header. This is the
 * single choke point for "may this key influence the query at all".
 */
function requireUsableColumn(
  source: ReportSourceDef,
  visible: ReadonlySet<string>,
  key: string,
  path: string,
): ReportColumnDef {
  const definition = source.columns[key];
  if (!definition || !visible.has(key)) throw unknownField(source, key, path);
  return definition;
}

function unknownField(source: ReportSourceDef, key: string, path: string): ValidationError {
  return fieldError(
    `The field "${key}" is not available on report source "${source.key}"`,
    path,
  );
}

function fieldError(message: string, path: string): ValidationError {
  const issues: FieldIssue[] = [{ path, message }];
  return new ValidationError(message, issues);
}

function aggregateExpression(fn: ReportAggregateFn, reference: SQL): SQL {
  // A closed switch rather than string interpolation: there is no branch in which a caller's
  // text becomes a function name.
  switch (fn) {
    case 'count':
      return sql`count(${reference})`;
    case 'sum':
      return sql`sum(${reference})`;
    case 'avg':
      return sql`avg(${reference})`;
    case 'min':
      return sql`min(${reference})`;
    case 'max':
      return sql`max(${reference})`;
  }
}

function direction(reference: SQL, dir: 'asc' | 'desc'): SQL {
  return dir === 'desc' ? sql`${reference} desc` : sql`${reference} asc`;
}

function compileSort(
  source: ReportSourceDef,
  visible: ReadonlySet<string>,
  query: ReportQueryInput,
  outputKeys: ReadonlySet<string>,
  spec: ReportSortInput,
  path: string,
): SQL {
  if (query.grouping) {
    // Under a `group by`, the only orderable things are the grouped columns and the
    // aggregates that were actually produced. Anything else is not merely disallowed by
    // Postgres, it is meaningless.
    if (!outputKeys.has(spec.field)) {
      throw fieldError(
        `The field "${spec.field}" is not one of this grouped report's output columns`,
        path,
      );
    }
    return direction(sql`${sql.identifier(spec.field)}`, spec.direction);
  }

  const definition = requireUsableColumn(source, visible, spec.field, path);
  if (!definition.sortable) {
    throw fieldError(
      `The field "${spec.field}" cannot be sorted on report source "${source.key}"`,
      path,
    );
  }
  return direction(columnRef(source, definition), spec.direction);
}

/**
 * One filter clause.
 *
 * The operator must be in the column's own declared list — the global operator vocabulary in
 * `@shikkha/validation` says what a filter may *look* like, the registry says what this
 * column *accepts*.
 */
function compileFilter(
  source: ReportSourceDef,
  definition: ReportColumnDef,
  clause: ReportFilterInput,
  path: string,
): SQL {
  const permitted = definition.operators ?? [];
  if (!permitted.includes(clause.operator)) {
    throw fieldError(
      `The operator "${clause.operator}" is not available for "${clause.field}" on report source "${source.key}"`,
      `${path}.operator`,
    );
  }

  const reference = columnRef(source, definition);

  switch (clause.operator) {
    case 'is_null':
      return sql`${reference} is null`;
    case 'is_not_null':
      return sql`${reference} is not null`;
    case 'contains':
      return sql`${reference}::text ilike ${`%${escapeLikePattern(asText(clause.value, path))}%`}`;
    case 'starts_with':
      return sql`${reference}::text ilike ${`${escapeLikePattern(asText(clause.value, path))}%`}`;
    case 'in':
      return sql`${comparableReference(reference, definition.type)} in (${sql.join(
        (clause.values ?? []).map((value) => bind(definition.type, value, `${path}.values`)),
        sql`, `,
      )})`;
    case 'not_in':
      return sql`${comparableReference(reference, definition.type)} not in (${sql.join(
        (clause.values ?? []).map((value) => bind(definition.type, value, `${path}.values`)),
        sql`, `,
      )})`;
    case 'between': {
      const values = clause.values ?? [];
      const lower = bind(definition.type, values[0], `${path}.values`);
      const upper = bind(definition.type, values[1], `${path}.values`);
      return sql`${comparableReference(reference, definition.type)} between ${lower} and ${upper}`;
    }
    case 'eq':
      return sql`${comparableReference(reference, definition.type)} = ${bind(definition.type, clause.value, `${path}.value`)}`;
    case 'ne':
      return sql`${comparableReference(reference, definition.type)} <> ${bind(definition.type, clause.value, `${path}.value`)}`;
    case 'lt':
      return sql`${comparableReference(reference, definition.type)} < ${bind(definition.type, clause.value, `${path}.value`)}`;
    case 'lte':
      return sql`${comparableReference(reference, definition.type)} <= ${bind(definition.type, clause.value, `${path}.value`)}`;
    case 'gt':
      return sql`${comparableReference(reference, definition.type)} > ${bind(definition.type, clause.value, `${path}.value`)}`;
    case 'gte':
      return sql`${comparableReference(reference, definition.type)} >= ${bind(definition.type, clause.value, `${path}.value`)}`;
  }
}

/**
 * An enum column is compared as text.
 *
 * Casting the *column* rather than the parameter means an unrecognised value matches nothing
 * instead of raising `invalid input value for enum`, which would turn a guess into a
 * distinguishable error — an enumeration oracle for the value set.
 */
function comparableReference(reference: SQL, type: ReportColumnType): SQL {
  return type === 'enum' ? sql`${reference}::text` : reference;
}

/**
 * Bind one value, with the cast its column's declared type requires.
 *
 * The type check is not decoration. Without it, `1=1` in a uuid filter would reach Postgres
 * as `"students"."id" = $1::uuid` and raise a 500 that reveals the column is a uuid; with it,
 * the caller gets a 422 naming the field. In a *text* filter the same string is bound and
 * matches nothing, which is correct: someone may legitimately search for it.
 */
function bind(type: ReportColumnType, value: unknown, path: string): SQL {
  switch (type) {
    case 'uuid': {
      const text = asText(value, path);
      if (!UUID_PATTERN.test(text)) {
        throw fieldError('This filter needs a valid identifier', path);
      }
      return sql`${text}::uuid`;
    }
    case 'number':
    case 'money': {
      const text = typeof value === 'number' ? String(value) : asText(value, path);
      if (!NUMERIC_PATTERN.test(text)) {
        throw fieldError('This filter needs a number', path);
      }
      return sql`${text}::numeric`;
    }
    case 'date': {
      const text = asText(value, path);
      if (!DATE_PATTERN.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
        throw fieldError('This filter needs a date in the format YYYY-MM-DD', path);
      }
      return sql`${text}::date`;
    }
    case 'timestamp': {
      const text = asText(value, path);
      if (Number.isNaN(Date.parse(text))) {
        throw fieldError('This filter needs a date or timestamp', path);
      }
      return sql`${new Date(text).toISOString()}::timestamptz`;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return sql`${value}::boolean`;
      const text = asText(value, path).toLowerCase();
      if (text !== 'true' && text !== 'false') {
        throw fieldError('This filter needs true or false', path);
      }
      return sql`${text === 'true'}::boolean`;
    }
    case 'enum':
    case 'text':
      return sql`${asText(value, path)}::text`;
  }
}

function asText(value: unknown, path: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw fieldError('This filter needs a value', path);
}

/**
 * Escape the pattern metacharacters so a search for `100%` means "the text 100%", not "the
 * text 100 followed by anything". Backslash first, or the escapes would be escaped again.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}
