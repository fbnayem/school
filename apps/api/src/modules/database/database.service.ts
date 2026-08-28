/**
 * The database access point for the whole API.
 *
 * Services do not receive a raw Drizzle handle. They receive this, and the only broadly
 * useful method on it is `runInTenant`, which opens a transaction with the RLS tenant context
 * already set. That shape is deliberate: it is easier to use the safe path than to bypass it,
 * which is the only way a safety property survives contact with a growing codebase.
 *
 * `runAsPlatform` exists for tenant provisioning and platform administration. It is named to
 * be conspicuous in code review and in a grep, and every call site is expected to justify
 * itself in a comment.
 */

import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import {
  checkDatabaseHealth,
  withPlatformContext,
  withTenantContext,
  type Database,
  type DatabaseHandle,
  type DatabaseHealth,
  type Transaction,
} from '@shikkha/db';
import { InternalError } from '@shikkha/shared';
import { currentContext } from '../../common/context/request-context';

export const DATABASE_HANDLE = Symbol('DATABASE_HANDLE');

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  constructor(@Inject(DATABASE_HANDLE) private readonly handle: DatabaseHandle) {}

  /**
   * Escape hatch for queries that are genuinely tenant-independent: health checks, the
   * migration status endpoint, and reads of platform-level tables such as `plans`.
   *
   * Row-level security still applies — this is not a privileged handle, it is simply one
   * without a transaction. A tenant-scoped table queried through it returns zero rows.
   */
  get raw(): Database {
    return this.handle.db;
  }

  /**
   * Run inside the current request's tenant.
   *
   * Throws when no tenant is resolved rather than silently falling back, because a query that
   * runs without a tenant returns nothing and would otherwise present as an empty list —
   * a bug that looks like missing data instead of a missing guard.
   */
  async runInTenant<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const context = currentContext();
    if (!context?.tenantId) {
      throw new InternalError(
        'runInTenant was called with no resolved tenant. The route is missing authentication, or a background job should be using runInTenantId.',
      );
    }
    return withTenantContext(
      this.handle.db,
      {
        tenantId: context.tenantId,
        userId: context.principal?.userId ?? null,
        isPlatformAdmin: context.principal?.isPlatformAdmin ?? false,
      },
      fn,
    );
  }

  /**
   * Run inside an explicit tenant. For background jobs and scheduled work, which have a
   * tenant but no HTTP request.
   */
  async runInTenantId<T>(
    tenantId: string,
    fn: (tx: Transaction) => Promise<T>,
    options: { userId?: string | null } = {},
  ): Promise<T> {
    return withTenantContext(
      this.handle.db,
      { tenantId, userId: options.userId ?? null, isPlatformAdmin: false },
      fn,
    );
  }

  /**
   * Run with row-level security relaxed.
   *
   * Legitimate uses are narrow: creating a tenant (whose rows cannot yet be scoped to it),
   * authenticating a user (the lookup happens before a tenant is known), and platform
   * administration. Anything else is a bug.
   */
  async runAsPlatform<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return withPlatformContext(this.handle.db, fn);
  }

  async health(): Promise<DatabaseHealth> {
    return checkDatabaseHealth(this.handle);
  }

  async onModuleDestroy(): Promise<void> {
    await this.handle.close();
  }
}
