/**
 * Audit log writer and reader.
 *
 * Writes go through `runAsPlatform` for one specific reason: an audit record must be written
 * even when the action that produced it was a platform-level or pre-authentication action with
 * no tenant context. Reads go through `runInTenant`, so a tenant can only ever read its own
 * trail — the write path being privileged does not make the read path privileged.
 */

import { Injectable } from '@nestjs/common';
import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { auditLogs } from '@shikkha/db';
import {
  buildOffsetPage,
  offsetOf,
  type OffsetPage,
  type OffsetPageRequest,
} from '@shikkha/shared';
import { DatabaseService } from '../database/database.service';

export type AuditAction =
  | 'create'
  | 'update'
  | 'archive'
  | 'restore'
  | 'approve'
  | 'reject'
  | 'publish'
  | 'unpublish'
  | 'login'
  | 'logout'
  | 'login_failed'
  | 'password_reset'
  | 'permission_change'
  | 'export'
  | 'import'
  | 'payment'
  | 'refund'
  | 'ai_action'
  | 'impersonate';

export interface AuditRecordInput {
  tenantId: string | null;
  institutionId?: string | null;
  campusId?: string | null;
  actorUserId: string | null;
  actorEmail?: string | null;
  actorRoles?: string[];
  impersonatorUserId?: string | null;
  action: AuditAction;
  module: string;
  resourceType: string;
  resourceId?: string | null;
  resourceLabel?: string | null;
  previousValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  isAiInitiated?: boolean;
}

export interface AuditQuery {
  module?: string;
  resourceType?: string;
  resourceId?: string;
  actorUserId?: string;
  action?: AuditAction;
  from?: Date;
  to?: Date;
}

@Injectable()
export class AuditService {
  constructor(private readonly db: DatabaseService) {}

  async record(input: AuditRecordInput): Promise<void> {
    await this.db.runAsPlatform(async (tx) => {
      await tx.insert(auditLogs).values({
        tenantId: input.tenantId,
        institutionId: input.institutionId ?? null,
        campusId: input.campusId ?? null,
        actorUserId: input.actorUserId,
        actorEmail: input.actorEmail ?? null,
        actorRoles: input.actorRoles ?? [],
        impersonatorUserId: input.impersonatorUserId ?? null,
        action: input.action,
        module: input.module,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        resourceLabel: input.resourceLabel ?? null,
        previousValue: normalize(input.previousValue),
        newValue: normalize(input.newValue),
        reason: input.reason ?? null,
        requestId: input.requestId ?? null,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        isAiInitiated: input.isAiInitiated ?? false,
      });
    });
  }

  /**
   * Write an audit record inside a caller-supplied transaction.
   *
   * Used where the audit row is part of the business transaction rather than a side effect —
   * journal postings, mark approvals, refunds. If the action rolls back, so does its record,
   * which is the correct behaviour for a financial trail.
   *
   * Note this runs under the caller's tenant context, so `tenantId` must match it; RLS will
   * refuse otherwise, which is the intended safety net.
   */
  async recordInTransaction(
    tx: Parameters<Parameters<DatabaseService['runInTenant']>[0]>[0],
    input: AuditRecordInput,
  ): Promise<void> {
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      institutionId: input.institutionId ?? null,
      campusId: input.campusId ?? null,
      actorUserId: input.actorUserId,
      actorEmail: input.actorEmail ?? null,
      actorRoles: input.actorRoles ?? [],
      action: input.action,
      module: input.module,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      resourceLabel: input.resourceLabel ?? null,
      previousValue: normalize(input.previousValue),
      newValue: normalize(input.newValue),
      reason: input.reason ?? null,
      requestId: input.requestId ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      isAiInitiated: input.isAiInitiated ?? false,
    });
  }

  async list(
    query: AuditQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<typeof auditLogs.$inferSelect>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [];
      if (query.module) filters.push(eq(auditLogs.module, query.module));
      if (query.resourceType) filters.push(eq(auditLogs.resourceType, query.resourceType));
      if (query.resourceId) filters.push(eq(auditLogs.resourceId, query.resourceId));
      if (query.actorUserId) filters.push(eq(auditLogs.actorUserId, query.actorUserId));
      if (query.action) filters.push(eq(auditLogs.action, query.action));
      if (query.from) filters.push(gte(auditLogs.occurredAt, query.from));
      if (query.to) filters.push(lte(auditLogs.occurredAt, query.to));

      const where = filters.length > 0 ? and(...filters) : undefined;

      const rows = await tx
        .select()
        .from(auditLogs)
        .where(where)
        .orderBy(desc(auditLogs.occurredAt))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(auditLogs)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }
}

/**
 * jsonb columns reject `undefined` and accept `null`. Normalising here means every call site
 * does not have to remember the difference, and a value that failed to serialise is recorded
 * as an explicit marker rather than silently dropping the whole record.
 */
function normalize(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    JSON.stringify(value);
    return value;
  } catch {
    return { __unserializable: true };
  }
}
