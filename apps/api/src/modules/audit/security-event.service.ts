/**
 * Security event recording.
 *
 * Separate from the audit log because the two answer different questions and have different
 * constraints:
 *
 *  - `audit_logs`      — "what changed, and who changed it". Always has an actor and a resource.
 *  - `security_events` — "who tried, and did it work". Often has neither: a failed login
 *    against a non-existent account has no user, no tenant, and no resource, and that is
 *    precisely the event most worth recording.
 *
 * Writes go through `runAsPlatform` because a pre-authentication event has no tenant context.
 * The RLS policy on the table allows unconditional INSERT for exactly this reason, while
 * keeping SELECT tenant-scoped.
 */

import { Injectable } from '@nestjs/common';
import { and, count, eq, gte } from 'drizzle-orm';
import { securityEvents } from '@shikkha/db';
import { DatabaseService } from '../database/database.service';
import { getLogger } from '../../common/logger';
import { currentContext } from '../../common/context/request-context';

export type SecurityEventType =
  | 'login_success'
  | 'login_failed'
  | 'account_locked'
  | 'password_reset_requested'
  | 'password_changed'
  | 'token_reuse_detected'
  | 'permission_denied'
  | 'cross_tenant_attempt'
  | 'rate_limited'
  | 'mfa_challenge'
  | 'session_revoked'
  | 'invitation_accepted'
  | 'impersonation_started';

export type SecuritySeverity = 'info' | 'warning' | 'critical';

export interface SecurityEventInput {
  eventType: SecurityEventType;
  severity?: SecuritySeverity;
  userId?: string | null;
  tenantId?: string | null;
  attemptedIdentifier?: string | null;
  detail?: Record<string, unknown>;
}

@Injectable()
export class SecurityEventService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Record an event.
   *
   * Never throws. A security event is telemetry about a request, not part of it — failing the
   * user's login because the audit insert failed would turn a monitoring outage into an
   * availability outage. Failures are logged at error level so monitoring still sees them.
   */
  async record(input: SecurityEventInput): Promise<void> {
    try {
      const context = currentContext();
      await this.db.runAsPlatform(async (tx) => {
        await tx.insert(securityEvents).values({
          tenantId: input.tenantId ?? null,
          userId: input.userId ?? null,
          attemptedIdentifier: input.attemptedIdentifier ?? null,
          eventType: input.eventType,
          severity: input.severity ?? 'info',
          detail: input.detail ?? {},
          requestId: context?.requestId ?? null,
          ipAddress: context?.ipAddress ?? null,
          userAgent: context?.userAgent ?? null,
        });
      });
    } catch (error) {
      getLogger().error(
        { err: error, eventType: input.eventType },
        'failed to record security event',
      );
    }
  }

  /**
   * Failed attempts from one IP within a window.
   *
   * Used alongside the per-account lockout: an attacker spraying one password across many
   * accounts never trips a per-account counter, so the IP-level view is what catches it.
   */
  async recentFailuresFromIp(ipAddress: string, sinceMinutes: number): Promise<number> {
    const since = new Date(Date.now() - sinceMinutes * 60_000);
    const rows = await this.db.runAsPlatform(async (tx) =>
      tx
        .select({ total: count() })
        .from(securityEvents)
        .where(
          and(
            eq(securityEvents.eventType, 'login_failed'),
            eq(securityEvents.ipAddress, ipAddress),
            gte(securityEvents.occurredAt, since),
          ),
        ),
    );
    return rows[0]?.total ?? 0;
  }
}
