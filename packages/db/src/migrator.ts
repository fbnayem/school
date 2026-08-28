/**
 * Migration runner.
 *
 * Deliberately hand-rolled rather than using `drizzle-kit migrate`, for three reasons that
 * matter for this product:
 *
 *  1. **Hand-written SQL is a first-class citizen.** RLS policies, database roles, grants,
 *     triggers and check constraints cannot be expressed in the Drizzle schema DSL, and they
 *     are exactly the parts a reviewer most needs to read before they touch a school's ledger.
 *  2. **Migrations run as a different database role** (`shikkha_migrator`) from the
 *     application (`shikkha_app`), which is what makes RLS actually apply — a table owner is
 *     exempt from its own policies unless forced.
 *  3. **Advisory locking**, so two API instances starting simultaneously do not both try to
 *     apply the same migration.
 *
 * Each file runs inside its own transaction. A failure rolls that file back and stops; nothing
 * later is applied, and the recorded state stays consistent with the database.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';

/** Arbitrary but stable — namespaces the advisory lock to this application. */
const MIGRATION_ADVISORY_LOCK_KEY = 4_827_301_996;

export interface MigrationRecord {
  name: string;
  checksum: string;
  appliedAt: Date;
  durationMs: number;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export interface MigrateOptions {
  connectionString: string;
  migrationsDir: string;
  /** Report what would run without touching the database. */
  dryRun?: boolean;
  log?: (message: string) => void;
}

async function ensureMigrationsTable(client: Client): Promise<void> {
  await client.query(`
    create table if not exists _migrations (
      name        text primary key,
      checksum    text not null,
      applied_at  timestamptz not null default now(),
      duration_ms integer not null default 0
    )
  `);
}

async function loadMigrationFiles(dir: string): Promise<{ name: string; sql: string }[]> {
  const entries = await readdir(dir);
  const files = entries.filter((entry) => entry.endsWith('.sql')).sort();
  return Promise.all(
    files.map(async (name) => ({ name, sql: await readFile(join(dir, name), 'utf8') })),
  );
}

function checksumOf(sql: string): string {
  // Normalise line endings so a Windows checkout does not appear to change every migration.
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

export async function migrate(options: MigrateOptions): Promise<MigrationResult> {
  const log = options.log ?? (() => undefined);
  const client = new Client({ connectionString: options.connectionString });
  await client.connect();

  try {
    await ensureMigrationsTable(client);

    // Serialise concurrent starters. Released automatically when the session ends.
    await client.query('select pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);

    const { rows } = await client.query<{ name: string; checksum: string }>(
      'select name, checksum from _migrations',
    );
    const appliedByName = new Map(rows.map((row) => [row.name, row.checksum]));

    const files = await loadMigrationFiles(options.migrationsDir);
    const applied: string[] = [];
    const skipped: string[] = [];

    for (const file of files) {
      const checksum = checksumOf(file.sql);
      const previous = appliedByName.get(file.name);

      if (previous !== undefined) {
        if (previous !== checksum) {
          // An edited migration means the database and the repository disagree about what
          // was run. Refusing is the only safe answer — silently re-running it could drop data.
          throw new Error(
            `Migration ${file.name} has changed since it was applied.\n` +
              `Applied checksum: ${previous}\nCurrent checksum:  ${checksum}\n` +
              `Migrations are immutable once applied. Add a new migration instead.`,
          );
        }
        skipped.push(file.name);
        continue;
      }

      if (options.dryRun) {
        log(`[dry-run] would apply ${file.name}`);
        applied.push(file.name);
        continue;
      }

      log(`applying ${file.name}`);
      const startedAt = Date.now();
      try {
        await client.query('begin');
        await client.query(file.sql);
        const durationMs = Date.now() - startedAt;
        await client.query(
          'insert into _migrations (name, checksum, duration_ms) values ($1, $2, $3)',
          [file.name, checksum, durationMs],
        );
        await client.query('commit');
        log(`  applied in ${durationMs}ms`);
        applied.push(file.name);
      } catch (error) {
        await client.query('rollback');
        const message = error instanceof Error ? error.message : String(error);
        // `cause` preserves the Postgres error — SQLSTATE, constraint name, position — which
        // is the half of the message that says how to fix it.
        throw new Error(`Migration ${file.name} failed and was rolled back: ${message}`, {
          cause: error,
        });
      }
    }

    return { applied, skipped };
  } finally {
    await client
      .query('select pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY])
      .catch(() => undefined);
    await client.end();
  }
}

export async function migrationStatus(
  connectionString: string,
  migrationsDir: string,
): Promise<{ applied: MigrationRecord[]; pending: string[] }> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await ensureMigrationsTable(client);
    const { rows } = await client.query<{
      name: string;
      checksum: string;
      applied_at: Date;
      duration_ms: number;
    }>('select name, checksum, applied_at, duration_ms from _migrations order by name');

    const appliedNames = new Set(rows.map((row) => row.name));
    const files = await loadMigrationFiles(migrationsDir);

    return {
      applied: rows.map((row) => ({
        name: row.name,
        checksum: row.checksum,
        appliedAt: row.applied_at,
        durationMs: row.duration_ms,
      })),
      pending: files.filter((file) => !appliedNames.has(file.name)).map((file) => file.name),
    };
  } finally {
    await client.end();
  }
}
