/**
 * Database connection and the tenant transaction boundary.
 *
 * The single most important function here is `withTenantContext`. Row-Level Security policies
 * read `current_setting('app.tenant_id')`, and that setting only exists for the life of a
 * transaction when set with `SET LOCAL`. So the rule is:
 *
 *   **Every tenant-scoped query runs inside a transaction that has declared its tenant.**
 *
 * Outside such a transaction, RLS sees no tenant and the policies return zero rows. That is
 * deliberate: a query that forgets the context fails closed and returns nothing, rather than
 * failing open and returning everything.
 */

import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Anything you can run a query on — the pool-backed db, or a transaction inside it. */
export type Queryable = Database | Transaction;

export interface DatabaseConfig {
  connectionString: string;
  /** Pool ceiling. Sized against Postgres `max_connections`, not against request volume. */
  maxConnections?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  statementTimeoutMillis?: number;
  ssl?: PoolConfig['ssl'];
  /** Emits every statement. Development only — SQL logs contain personal data. */
  logQueries?: boolean;
}

export interface DatabaseHandle {
  db: Database;
  pool: Pool;
  close: () => Promise<void>;
}

export function createDatabase(config: DatabaseConfig): DatabaseHandle {
  const pool = new Pool({
    connectionString: config.connectionString,
    max: config.maxConnections ?? 10,
    idleTimeoutMillis: config.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? 5_000,
    ssl: config.ssl,
    // A runaway query holds a connection and a row lock; the ceiling bounds the damage.
    statement_timeout: config.statementTimeoutMillis ?? 30_000,
    application_name: 'shikkha-api',
  });

  // An idle client erroring (network blip, server restart) must not take down the process.
  pool.on('error', (error) => {
    console.error('[db] idle client error', { message: error.message });
  });

  const db = drizzle(pool, { schema, logger: config.logQueries ?? false });

  return {
    db,
    pool,
    close: async () => {
      await pool.end();
    },
  };
}

/** Who the queries inside a tenant transaction are running as. */
export interface TenantContext {
  tenantId: string;
  userId?: string | null;
  /**
   * Platform admins legitimately cross tenants. Setting this relaxes the RLS predicate, and
   * the value is set from the server-side principal only — never from request input.
   */
  isPlatformAdmin?: boolean;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `fn` inside a transaction whose RLS context is set to the given tenant.
 *
 * The identifiers are validated as UUIDs before being interpolated. They arrive from the
 * authenticated session rather than from request input, so this is defence in depth rather
 * than the primary control — but `set_config` with an unvalidated string is exactly the kind
 * of thing that quietly becomes an injection point after three refactors.
 */
export async function withTenantContext<T>(
  db: Database,
  context: TenantContext,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  if (!UUID_PATTERN.test(context.tenantId)) {
    throw new Error(`withTenantContext received a malformed tenant id`);
  }
  if (context.userId != null && !UUID_PATTERN.test(context.userId)) {
    throw new Error(`withTenantContext received a malformed user id`);
  }

  return db.transaction(async (tx) => {
    // `true` = SET LOCAL: reverts when the transaction ends, so a pooled connection never
    // carries one request's tenant into the next request.
    await tx.execute(sql`select set_config('app.tenant_id', ${context.tenantId}, true)`);
    await tx.execute(sql`select set_config('app.user_id', ${context.userId ?? ''}, true)`);
    await tx.execute(
      sql`select set_config('app.is_platform_admin', ${context.isPlatformAdmin ? 'on' : 'off'}, true)`,
    );
    return fn(tx);
  });
}

/**
 * Run `fn` with RLS bypassed for platform-level work: creating a tenant, cross-tenant
 * reporting, migrations, the seeder.
 *
 * Named to be conspicuous in review and in a grep. Any call site that is not platform
 * administration is a bug.
 */
export async function withPlatformContext<T>(
  db: Database,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.is_platform_admin', 'on', true)`);
    await tx.execute(sql`select set_config('app.tenant_id', '', true)`);
    return fn(tx);
  });
}

export interface DatabaseHealth {
  healthy: boolean;
  latencyMs: number;
  poolTotal: number;
  poolIdle: number;
  poolWaiting: number;
  error?: string;
}

export async function checkDatabaseHealth(handle: DatabaseHandle): Promise<DatabaseHealth> {
  const startedAt = Date.now();
  const base = {
    poolTotal: handle.pool.totalCount,
    poolIdle: handle.pool.idleCount,
    poolWaiting: handle.pool.waitingCount,
  };
  try {
    // A short timeout: a health check that hangs is worse than one that reports unhealthy.
    const client: PoolClient = await handle.pool.connect();
    try {
      await client.query('select 1');
    } finally {
      client.release();
    }
    return { healthy: true, latencyMs: Date.now() - startedAt, ...base };
  } catch (error) {
    return {
      healthy: false,
      latencyMs: Date.now() - startedAt,
      ...base,
      error: error instanceof Error ? error.message : 'unknown error',
    };
  }
}

export { schema };
