/**
 * Schema conformance.
 *
 * Introspects the Drizzle schema — no database required — and asserts the conventions that make
 * tenant isolation, soft archiving and auditability properties of the *schema* rather than
 * habits individual developers have to remember.
 *
 * The value is in what happens when someone adds a table. A new business table without
 * `tenant_id` fails here in milliseconds, rather than in migration `0003`'s assertion after a
 * container spin-up, or — worse — not at all until a customer sees another school's students.
 */

import { describe, expect, it } from 'vitest';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../src/schema';
import { markDistribution } from '../src/cli/seed';

/**
 * Tables that legitimately have no `tenant_id`.
 *
 * Every entry needs a written reason. Adding to this list should feel like a decision, because
 * it is one.
 */
const TENANT_EXEMPT: Record<string, string> = {
  organizations: 'It *is* the tenant — its primary key is the tenant id',
  plans: 'Platform-level catalogue, identical for every tenant',
  feature_flags: 'Platform-level flag definitions; overrides are tenant-scoped',
  security_events: 'Written before authentication, when no tenant is known',
};

/** Reference and log tables that are not soft-archived. */
const ARCHIVE_EXEMPT = new Set([
  'audit_logs',
  'security_events',
  'sessions',
  'auth_tokens',
  'user_roles',
  'feature_flag_overrides',
  'subscriptions',
  'student_status_history',
  'plans',
  'feature_flags',
]);

/** Append-only tables, which by definition are never updated. */
const UPDATED_AT_EXEMPT = new Set(['audit_logs', 'security_events']);

interface TableInfo {
  name: string;
  columns: Set<string>;
  indexes: string[];
  table: PgTable;
}

function allTables(): TableInfo[] {
  const out: TableInfo[] = [];
  for (const value of Object.values(schema)) {
    if (!(value instanceof PgTable)) continue;
    const config = getTableConfig(value);
    out.push({
      name: config.name,
      columns: new Set(config.columns.map((column) => column.name)),
      indexes: config.indexes.map((index) => index.config.name ?? '(unnamed)'),
      table: value,
    });
  }
  return out;
}

const TABLES = allTables();

describe('schema inventory', () => {
  it('discovers every table', () => {
    // A sanity floor: if the introspection silently returns nothing, every assertion below
    // would vacuously pass and this file would be worthless.
    expect(TABLES.length).toBeGreaterThan(30);
  });

  it('has unique table names', () => {
    const names = TABLES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('uses snake_case for every table and column name', () => {
    const offenders: string[] = [];
    for (const table of TABLES) {
      if (!/^[a-z][a-z0-9_]*$/.test(table.name)) offenders.push(table.name);
      for (const column of table.columns) {
        if (!/^[a-z][a-z0-9_]*$/.test(column)) offenders.push(`${table.name}.${column}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('tenant isolation conventions', () => {
  it('every business table carries tenant_id', () => {
    const missing = TABLES.filter(
      (table) => !table.columns.has('tenant_id') && !(table.name in TENANT_EXEMPT),
    ).map((table) => table.name);

    expect(
      missing,
      `Tables without tenant_id. Either add the column, or add the table to TENANT_EXEMPT with a reason.`,
    ).toEqual([]);
  });

  it('every exemption is still a real table', () => {
    // A stale exemption is how a table quietly loses its protection during a rename.
    const names = new Set(TABLES.map((t) => t.name));
    const stale = Object.keys(TENANT_EXEMPT).filter((name) => !names.has(name));
    expect(stale).toEqual([]);
  });

  it('every tenant-scoped table has an index that can serve a tenant filter', () => {
    const missing: string[] = [];
    for (const table of TABLES) {
      if (!table.columns.has('tenant_id')) continue;
      const hasTenantIndex = table.indexes.some((name) => /tenant|_idx$/.test(name));
      if (!hasTenantIndex) missing.push(table.name);
    }
    // Without one, every tenant-scoped query on a large table is a sequential scan.
    expect(missing).toEqual([]);
  });
});

describe('audit and lifecycle conventions', () => {
  it('every table records when its row came into existence', () => {
    // Append-only log tables use `occurred_at` instead: for an audit record the meaningful
    // timestamp is when the event happened, not when the row was inserted. Requiring both
    // would add a column that is always equal to the other one.
    const missing = TABLES.filter(
      (table) => !table.columns.has('created_at') && !table.columns.has('occurred_at'),
    ).map((t) => t.name);
    expect(missing).toEqual([]);
  });

  it('every mutable table records when it was updated', () => {
    const missing = TABLES.filter(
      (table) => !table.columns.has('updated_at') && !UPDATED_AT_EXEMPT.has(table.name),
    ).map((t) => t.name);
    expect(missing).toEqual([]);
  });

  it('business tables are soft-archived rather than deleted', () => {
    const missing = TABLES.filter(
      (table) => !table.columns.has('archived_at') && !ARCHIVE_EXEMPT.has(table.name),
    ).map((t) => t.name);

    expect(
      missing,
      'Academic and financial records are legal records and must not be hard-deleted (ADR-008).',
    ).toEqual([]);
  });

  it('archivable tables record who archived them', () => {
    const missing = TABLES.filter(
      (table) => table.columns.has('archived_at') && !table.columns.has('archived_by'),
    ).map((t) => t.name);
    expect(missing).toEqual([]);
  });
});

describe('optimistic locking', () => {
  /**
   * Tables users edit through a form, where two people saving at once would silently lose one
   * of the edits. Join tables and append-only logs are excluded — they have no partial update
   * that could conflict.
   */
  const CONCURRENTLY_EDITED = [
    'organizations',
    'institutions',
    'campuses',
    'users',
    'roles',
    'academic_years',
    'terms',
    'sections',
    'class_levels',
    'subjects',
    'students',
    'enrollments',
    'guardians',
    'employees',
  ];

  it('carries a version column on every concurrently edited table', () => {
    const byName = new Map(TABLES.map((table) => [table.name, table]));
    const missing = CONCURRENTLY_EDITED.filter((name) => !byName.get(name)?.columns.has('version'));
    expect(missing).toEqual([]);
  });
});

describe('money columns', () => {
  it('no business table stores money in a floating-point column', () => {
    // `real` and `double precision` are disqualifying for currency (ADR-004). The check is by
    // column *name* as well as type, so a `price` stored as an integer of unclear unit is
    // also visible.
    const offenders: string[] = [];
    for (const table of TABLES) {
      const config = getTableConfig(table.table);
      for (const column of config.columns) {
        const looksMonetary = /amount|price|salary|fee|balance|total|cost/.test(column.name);
        const type = column.getSQLType().toLowerCase();
        if (looksMonetary && (type.includes('real') || type.includes('double'))) {
          offenders.push(`${table.name}.${column.name} (${type})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('bilingual fields', () => {
  it('every table with an English name field allows a Bangla one', () => {
    // A Bangla name is not a translation of the English one — both are official and appear on
    // different documents. A table that stores only `name_en` cannot represent a student's
    // legal name.
    const missing: string[] = [];
    for (const table of TABLES) {
      if (table.columns.has('name_en') && !table.columns.has('name_bn')) missing.push(table.name);
      if (table.columns.has('full_name_en') && !table.columns.has('full_name_bn')) {
        missing.push(table.name);
      }
      if (table.columns.has('title_en') && !table.columns.has('title_bn')) missing.push(table.name);
    }
    expect(missing).toEqual([]);
  });
});

describe('timestamps', () => {
  it('every timestamp column carries a timezone', () => {
    // A naive `timestamp` silently loses the offset, and this product runs in UTC+6 while its
    // servers may be anywhere (ADR-009).
    const offenders: string[] = [];
    for (const table of TABLES) {
      const config = getTableConfig(table.table);
      for (const column of config.columns) {
        const type = column.getSQLType().toLowerCase();
        if (type.startsWith('timestamp') && !type.includes('with time zone')) {
          offenders.push(`${table.name}.${column.name} (${type})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('calendar dates use `date`, not a timestamp', () => {
    // An attendance date or a date of birth is a calendar fact, not an instant. Storing it as
    // a timestamp creates off-by-one-day bugs at midnight boundaries.
    const offenders: string[] = [];
    for (const table of TABLES) {
      const config = getTableConfig(table.table);
      for (const column of config.columns) {
        const isCalendarish =
          /^(date_of_birth|admission_date|start_date|end_date|joining_date|enrolled_on|ended_on|effective_date|issued_on|expires_on)$/.test(
            column.name,
          );
        if (isCalendarish && column.getSQLType().toLowerCase() !== 'date') {
          offenders.push(`${table.name}.${column.name} (${column.getSQLType()})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * The demo seeder writes `class_subjects.mark_distribution`, and migration 0015 constrains
 * its components to total `full_marks` exactly. Those two were out of step: the seeder
 * rounded theory and practical independently, so a 50-mark practical subject produced
 * 38 + 13 = 51 and `pnpm db:seed --fresh` failed on a clean database — the command the
 * README lists first. This is the arithmetic, tested where a database is not needed.
 */
describe('seed mark distribution', () => {
  const FULL_MARKS = [10, 20, 25, 30, 33, 40, 50, 66, 75, 100, 101, 150];

  it('always totals full marks when there is a practical component', () => {
    for (const fullMarks of FULL_MARKS) {
      const distribution = markDistribution(fullMarks, true);
      const total = Object.values(distribution).reduce((sum, part) => sum + part, 0);
      expect(total, `full marks ${fullMarks}`).toBe(fullMarks);
    }
  });

  it('gives a theory-only subject the whole allocation', () => {
    for (const fullMarks of FULL_MARKS) {
      expect(markDistribution(fullMarks, false)).toEqual({ theory: fullMarks });
    }
  });

  it('splits roughly three to one, and never negatively', () => {
    for (const fullMarks of FULL_MARKS) {
      const { theory, practical } = markDistribution(fullMarks, true) as {
        theory: number;
        practical: number;
      };
      expect(practical).toBeGreaterThan(0);
      expect(theory).toBeGreaterThan(practical);
      // The practical share is within half a mark of a quarter — the rounding, and nothing more.
      expect(Math.abs(practical - fullMarks / 4)).toBeLessThanOrEqual(0.5);
    }
  });
});
