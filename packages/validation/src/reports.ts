/**
 * Report builder schemas (Phase 24).
 *
 * These schemas are the **first** of two gates, and deliberately the weaker one. All they
 * establish is that a request is structurally a report request: identifier-shaped keys, a
 * known operator, a value of a permitted primitive type, sane sizes. They cannot decide
 * whether `medicalConditions` is a real column, whether the caller may read it, or which
 * operators it accepts — that is the source registry's job
 * (`apps/api/src/modules/reports/sources/`), and it runs on every request against the
 * caller's live permissions.
 *
 * So: **nothing that passes validation here is trusted.** A key that matches
 * `reportFieldKeySchema` and is absent from the registry is a 422 naming the field; a value
 * is always bound as a parameter and never interpolated. The identifier regex exists to
 * reject obvious nonsense early and to keep error messages useful — it is not the defence.
 *
 * Every exported constant carries a `REPORT_` prefix because `@shikkha/validation`
 * re-exports flat.
 */

import { z } from 'zod';
import { paginationSchema, reasonSchema, searchSchema, sortSchema, uuidSchema } from './common';

// ── Value sets, mirrored from the database enums and the registry ────────────────────

export const REPORT_VISIBILITIES = ['private', 'role', 'institution'] as const;

export const REPORT_DEFINITION_STATUSES = ['draft', 'published', 'archived'] as const;

export const REPORT_RUN_STATUSES = ['running', 'succeeded', 'failed'] as const;

export const REPORT_EXPORT_FORMATS = ['csv', 'json'] as const;

/**
 * The complete operator vocabulary. A source's column declares which of these it accepts;
 * an operator outside *that* list is a 422 even though it appears here.
 *
 * There is no `raw`, no `sql`, and no `like` with a caller-supplied pattern: `contains` and
 * `starts_with` escape the pattern metacharacters themselves.
 */
export const REPORT_FILTER_OPERATORS = [
  'eq',
  'ne',
  'lt',
  'lte',
  'gt',
  'gte',
  'in',
  'not_in',
  'contains',
  'starts_with',
  'between',
  'is_null',
  'is_not_null',
] as const;

export const REPORT_AGGREGATE_FUNCTIONS = ['count', 'sum', 'avg', 'min', 'max'] as const;

export const REPORT_SORT_DIRECTIONS = ['asc', 'desc'] as const;

// ── Limits ───────────────────────────────────────────────────────────────────────────

/**
 * The hard row ceiling for one report. A run that reaches it is reported as truncated and
 * an export of a truncated run is **refused**: silently handing back a partial CSV that
 * looks complete is how a school reconciles its fee collection against the wrong number.
 */
export const REPORT_MAX_ROWS = 5000;

/** Statement timeout applied inside the reporting transaction, in milliseconds. */
export const REPORT_STATEMENT_TIMEOUT_MS = 15_000;

export const REPORT_MAX_COLUMNS = 40;
export const REPORT_MAX_FILTERS = 20;
export const REPORT_MAX_FILTER_VALUES = 200;
export const REPORT_MAX_SORTS = 5;
export const REPORT_MAX_GROUP_FIELDS = 5;
export const REPORT_MAX_AGGREGATES = 10;
export const REPORT_MAX_RECIPIENTS = 50;

/** How long a produced export file stays downloadable. */
export const REPORT_EXPORT_TTL_HOURS = 168;

// ── Primitives ───────────────────────────────────────────────────────────────────────

/**
 * A registry key: a source key, a column key, an aggregate alias.
 *
 * Restricted to `[A-Za-z][A-Za-z0-9_]*` so that even a key that somehow escaped the
 * registry lookup could not carry a quote, a semicolon or a comment marker. The registry
 * lookup is still what decides; this only narrows what an error message may echo back.
 */
export const reportFieldKeySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,62}$/, 'Not a valid field name');

export const reportSourceKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{0,62}$/, 'Not a valid report source');

/** A definition's stable handle within its institution. */
/** `:key` on the source-picker route. Same shape as the document's `sourceKey`. */
export const reportSourceParamSchema = z.object({ key: reportSourceKeySchema });

export const reportDefinitionKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_-]{0,62}$/, 'Use lowercase letters, digits, hyphens and underscores');

/**
 * A filter value. Primitives only — no objects, no nested arrays, no `null` masquerading as
 * a value (use `is_null`). Strings are capped so a filter cannot be used to push a megabyte
 * of text through the query planner.
 */
export const reportFilterValueSchema = z.union([
  z.string().max(500),
  z.number().finite(),
  z.boolean(),
]);

/**
 * One filter clause.
 *
 * The refinement enforces the arity each operator needs, which is what keeps the compiler
 * total: by the time it sees a clause, `between` has exactly two values and `is_null` has
 * none, so there is no branch where a missing value silently becomes `NULL` and turns the
 * predicate into an accidental tautology.
 */
export const reportFilterSchema = z
  .object({
    field: reportFieldKeySchema,
    operator: z.enum(REPORT_FILTER_OPERATORS),
    value: reportFilterValueSchema.optional(),
    values: z.array(reportFilterValueSchema).max(REPORT_MAX_FILTER_VALUES).optional(),
  })
  .superRefine((clause, ctx) => {
    const listOperator = clause.operator === 'in' || clause.operator === 'not_in';
    const nullOperator = clause.operator === 'is_null' || clause.operator === 'is_not_null';

    if (nullOperator) {
      if (clause.value !== undefined || clause.values !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value'],
          message: `The "${clause.operator}" operator takes no value`,
        });
      }
      return;
    }

    if (listOperator) {
      if (!clause.values || clause.values.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['values'],
          message: `The "${clause.operator}" operator needs at least one value`,
        });
      }
      return;
    }

    if (clause.operator === 'between') {
      if (!clause.values || clause.values.length !== 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['values'],
          message: 'The "between" operator needs exactly two values, lower then upper',
        });
      }
      return;
    }

    if (clause.value === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `The "${clause.operator}" operator needs a value`,
      });
    }
  });

export const reportSortSchema = z.object({
  field: reportFieldKeySchema,
  direction: z.enum(REPORT_SORT_DIRECTIONS).default('asc'),
});

export const reportAggregateSchema = z.object({
  field: reportFieldKeySchema,
  fn: z.enum(REPORT_AGGREGATE_FUNCTIONS),
  /** Output name. Defaults to `<fn>_<field>` in the compiler when omitted. */
  alias: reportFieldKeySchema.optional(),
});

export const reportGroupingSchema = z
  .object({
    fields: z.array(reportFieldKeySchema).min(1).max(REPORT_MAX_GROUP_FIELDS),
    aggregates: z.array(reportAggregateSchema).max(REPORT_MAX_AGGREGATES).default([]),
  })
  .superRefine((grouping, ctx) => {
    const seen = new Set<string>();
    for (const field of grouping.fields) {
      if (seen.has(field)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fields'],
          message: `The field "${field}" is grouped twice`,
        });
      }
      seen.add(field);
    }
  });

/**
 * The query document: everything that shapes one report, and nothing that could shape a
 * *statement*. There is no table name, no join specification, no expression — those come
 * from the registry entry named by `sourceKey`.
 */
export const reportQuerySchema = z
  .object({
    sourceKey: reportSourceKeySchema,
    columns: z.array(reportFieldKeySchema).min(1).max(REPORT_MAX_COLUMNS),
    filters: z.array(reportFilterSchema).max(REPORT_MAX_FILTERS).default([]),
    grouping: reportGroupingSchema.optional(),
    sorting: z.array(reportSortSchema).max(REPORT_MAX_SORTS).default([]),
    limit: z.number().int().min(1).max(REPORT_MAX_ROWS).optional(),
  })
  .superRefine((query, ctx) => {
    const duplicates = query.columns.filter((key, index) => query.columns.indexOf(key) !== index);
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['columns'],
        message: `The column "${duplicates[0]}" is selected twice`,
      });
    }

    // A grouped report projects its group fields and its aggregates — nothing else. Letting
    // a stray column through would either be dropped silently or produce a Postgres
    // "must appear in the GROUP BY clause" error the caller cannot act on.
    if (query.grouping) {
      const grouped = new Set(query.grouping.fields);
      for (const column of query.columns) {
        if (!grouped.has(column)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['columns'],
            message: `"${column}" is selected but not grouped; add it to grouping.fields or remove it`,
          });
        }
      }
    }
  });

export type ReportQueryInput = z.infer<typeof reportQuerySchema>;
export type ReportFilterInput = z.infer<typeof reportFilterSchema>;
export type ReportSortInput = z.infer<typeof reportSortSchema>;
export type ReportGroupingInput = z.infer<typeof reportGroupingSchema>;

// ── Ad-hoc runs ──────────────────────────────────────────────────────────────────────

export const runAdHocReportSchema = z.object({
  query: reportQuerySchema,
});

/**
 * Running a *saved* definition. `filters` are additional narrowing clauses applied on top of
 * the saved ones — they can only ever reduce the result set, never widen it, because both
 * sets are ANDed and both go through the same allow-list.
 */
export const runReportDefinitionSchema = z.object({
  filters: z.array(reportFilterSchema).max(REPORT_MAX_FILTERS).default([]),
  limit: z.number().int().min(1).max(REPORT_MAX_ROWS).optional(),
});

// ── Definitions ──────────────────────────────────────────────────────────────────────

export const createReportDefinitionSchema = z.object({
  key: reportDefinitionKeySchema,
  name: z.string().trim().min(2).max(128),
  nameBn: z.string().trim().max(128).optional(),
  query: reportQuerySchema,
  visibility: z.enum(REPORT_VISIBILITIES).default('private'),
  status: z.enum(['draft', 'published']).default('draft'),
});

export const updateReportDefinitionSchema = z
  .object({
    name: z.string().trim().min(2).max(128).optional(),
    nameBn: z.string().trim().max(128).optional(),
    query: reportQuerySchema.optional(),
    visibility: z.enum(REPORT_VISIBILITIES).optional(),
    status: z.enum(['draft', 'published']).optional(),
    version: z.number().int().min(1),
  })
  .refine(
    (input) =>
      input.name !== undefined ||
      input.nameBn !== undefined ||
      input.query !== undefined ||
      input.visibility !== undefined ||
      input.status !== undefined,
    { message: 'Change at least one field' },
  );

export const archiveReportDefinitionSchema = z.object({
  version: z.number().int().min(1),
  reason: reasonSchema,
});

export const createReportShareSchema = z
  .object({
    roleId: uuidSchema.optional(),
    userId: uuidSchema.optional(),
  })
  .refine((input) => (input.roleId === undefined) !== (input.userId === undefined), {
    message: 'Share with exactly one of a role or a user',
  });

export const REPORT_DEFINITION_SORT_FIELDS = ['name', 'key', 'createdAt', 'updatedAt'] as const;

export const listReportDefinitionsSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    sourceKey: reportSourceKeySchema.optional(),
    visibility: z.enum(REPORT_VISIBILITIES).optional(),
    status: z.enum(REPORT_DEFINITION_STATUSES).optional(),
  });

// ── Runs and exports ─────────────────────────────────────────────────────────────────

export const REPORT_RUN_SORT_FIELDS = ['startedAt', 'finishedAt', 'rowCount'] as const;

export const listReportRunsSchema = paginationSchema.merge(sortSchema).extend({
  definitionId: uuidSchema.optional(),
  status: z.enum(REPORT_RUN_STATUSES).optional(),
  mine: z.coerce.boolean().optional(),
});

export const createReportExportSchema = z.object({
  format: z.enum(REPORT_EXPORT_FORMATS),
});

// ── Schedules ────────────────────────────────────────────────────────────────────────

/**
 * Five whitespace-separated cron fields. The full parse — ranges, steps, lists, the
 * day-of-month / day-of-week disjunction — happens in the service, which also computes the
 * next occurrence; a schedule whose expression can never fire is refused there rather than
 * stored as a promise nothing will keep.
 */
export const reportCronSchema = z
  .string()
  .trim()
  .max(120)
  .regex(
    /^[0-9*,/-]+(\s+[0-9*,/-]+){4}$/,
    'Use five cron fields: minute hour day-of-month month day-of-week',
  );

/**
 * Only `Asia/Dhaka`. `next_run_at` is computed with the fixed +06:00 offset, which is exact
 * for Bangladesh and would be a lie anywhere with daylight saving. Storing a zone the
 * scheduler cannot compute correctly is worse than refusing it.
 */
export const reportTimezoneSchema = z.literal('Asia/Dhaka').default('Asia/Dhaka');

export const createReportScheduleSchema = z.object({
  definitionId: uuidSchema,
  cronExpression: reportCronSchema,
  timezone: reportTimezoneSchema,
  recipients: z.array(uuidSchema).max(REPORT_MAX_RECIPIENTS).default([]),
  format: z.enum(REPORT_EXPORT_FORMATS).default('csv'),
  isActive: z.boolean().default(true),
});

export const updateReportScheduleSchema = z
  .object({
    cronExpression: reportCronSchema.optional(),
    recipients: z.array(uuidSchema).max(REPORT_MAX_RECIPIENTS).optional(),
    format: z.enum(REPORT_EXPORT_FORMATS).optional(),
    isActive: z.boolean().optional(),
    version: z.number().int().min(1),
  })
  .refine(
    (input) =>
      input.cronExpression !== undefined ||
      input.recipients !== undefined ||
      input.format !== undefined ||
      input.isActive !== undefined,
    { message: 'Change at least one field' },
  );

export const archiveReportScheduleSchema = z.object({
  version: z.number().int().min(1),
  reason: reasonSchema,
});

export const listReportSchedulesSchema = paginationSchema.extend({
  definitionId: uuidSchema.optional(),
  isActive: z.coerce.boolean().optional(),
});
