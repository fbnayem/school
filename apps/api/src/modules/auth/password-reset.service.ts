/**
 * Self-service password reset.
 *
 * The property everything here is arranged around: **the endpoint must not be an account
 * oracle.** Whether the identifier matches an account or not, the caller gets byte-for-byte
 * the same response, and the request performs the same expensive work (`burnTime()` runs a
 * real Argon2 verification in *both* branches), so neither the body nor the latency
 * separates "account exists" from "account does not". Notification delivery is
 * fire-and-forget for the same reason — an SMTP round-trip that only happens for real
 * accounts would be a timing oracle.
 *
 * Tokens follow the house rules for single-use credentials: 256 bits from `secureToken`,
 * stored only as a SHA-256 hash in `auth_tokens`, 30-minute expiry, claimed atomically on
 * use, and revoked in bulk whenever the password changes by any other route.
 *
 * Completing a reset revokes every session through the existing machinery —
 * `credentials_changed_at` is bumped (which invalidates every outstanding access token at
 * the guard) and `AuthService.logoutAll` revokes the refresh-token sessions. Nothing new
 * is invented for revocation.
 */

import { Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { authTokens, users } from '@shikkha/db';
import { NotFoundError, ValidationError, secureToken } from '@shikkha/shared';
import { DatabaseService } from '../database/database.service';
import { AuthService, normalizeIdentifier } from './auth.service';
import { PasswordService } from './password.service';
import { hashToken } from './token.service';
import { SecurityEventService } from '../audit/security-event.service';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from '../notifications/notification.service';
import { env } from '../../config/env';
import { currentContext } from '../../common/context/request-context';
import { getLogger } from '../../common/logger';

export const PASSWORD_RESET_TTL_MINUTES = 30;

/** The one message both branches return. Changing one side breaks the anti-enumeration. */
export const RESET_REQUESTED_MESSAGE =
  'If an account exists for that email or phone number, a reset link has been sent.';

@Injectable()
export class PasswordResetService {
  constructor(
    private readonly db: DatabaseService,
    private readonly auth: AuthService,
    private readonly passwords: PasswordService,
    private readonly securityEvents: SecurityEventService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Request a reset. Always resolves to the same message; all the branching below is
   * side effects (token issuance, delivery, security telemetry).
   */
  async request(rawIdentifier: string): Promise<{ message: string }> {
    const identifier = normalizeIdentifier(rawIdentifier);

    const user = await this.db.runAsPlatform(async (tx) => {
      const [found] = await tx
        .select()
        .from(users)
        .where(
          and(
            identifier.kind === 'email'
              ? eq(users.email, identifier.value)
              : eq(users.phone, identifier.value),
            isNull(users.archivedAt),
          ),
        )
        .limit(1);
      return found ?? null;
    });

    // The same Argon2-shaped work in both branches, so latency is not an oracle.
    await this.passwords.burnTime();

    // An account that cannot log in with a password cannot be "reset" into one either —
    // an invited-but-never-activated user must go through their invitation, which is the
    // flow that carries the role grants.
    const eligible = user !== null && user.passwordHash !== null && user.status === 'active';

    if (!eligible) {
      await this.securityEvents.record({
        eventType: 'password_reset_requested',
        severity: 'info',
        userId: user?.id ?? null,
        tenantId: user?.tenantId ?? null,
        attemptedIdentifier: identifier.value,
        detail: { outcome: user ? 'not_eligible' : 'no_account' },
      });
      return { message: RESET_REQUESTED_MESSAGE };
    }

    const token = secureToken(32);
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60_000);

    await this.db.runAsPlatform(async (tx) => {
      // One live reset link per account: requesting again moves the window, never widens it.
      await tx
        .update(authTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(authTokens.userId, user.id),
            eq(authTokens.purpose, 'password_reset'),
            isNull(authTokens.usedAt),
            isNull(authTokens.revokedAt),
          ),
        );

      await tx.insert(authTokens).values({
        tenantId: user.tenantId,
        userId: user.id,
        purpose: 'password_reset',
        tokenHash: hashToken(token),
        email: identifier.kind === 'email' ? identifier.value : null,
        phone: identifier.kind === 'phone' ? identifier.value : null,
        expiresAt,
      });
    });

    await this.securityEvents.record({
      eventType: 'password_reset_requested',
      severity: 'info',
      userId: user.id,
      tenantId: user.tenantId,
      attemptedIdentifier: identifier.value,
      detail: { outcome: 'token_issued', channel: identifier.kind },
    });

    // Fire-and-forget: delivery latency must not differ between branches, and a slow SMTP
    // relay must not slow the response only when the account is real.
    void this.deliver(user.locale, user.fullNameEn, identifier, token).catch((error) => {
      getLogger().error({ err: error }, 'password reset delivery failed');
    });

    return { message: RESET_REQUESTED_MESSAGE };
  }

  /** Complete a reset with a valid token. */
  async reset(rawToken: string, newPassword: string): Promise<void> {
    const tokenHash = hashToken(rawToken);

    const outcome = await this.db.runAsPlatform(async (tx) => {
      // Atomic claim — identical shape to invitation acceptance: first presenter wins,
      // everyone else (including a replay of a leaked link) matches zero rows.
      const [token] = await tx
        .update(authTokens)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(authTokens.tokenHash, tokenHash),
            eq(authTokens.purpose, 'password_reset'),
            isNull(authTokens.usedAt),
            isNull(authTokens.revokedAt),
            gt(authTokens.expiresAt, new Date()),
          ),
        )
        .returning();

      if (!token?.userId) {
        return { ok: false as const };
      }

      const [user] = await tx
        .select()
        .from(users)
        .where(and(eq(users.id, token.userId), isNull(users.archivedAt)))
        .limit(1);
      if (!user) return { ok: false as const };

      const policy = this.passwords.check(newPassword, {
        email: user.email,
        name: user.fullNameEn,
      });
      if (!policy.valid) {
        // Thrown inside the transaction on purpose: the rollback un-claims the token, so
        // a typo in the new password does not burn the link.
        throw new ValidationError(
          'The new password does not meet the requirements',
          policy.issues.map((message) => ({ path: 'newPassword', message })),
        );
      }

      const passwordHash = await this.passwords.hash(newPassword);
      await tx
        .update(users)
        .set({
          passwordHash,
          mustChangePassword: false,
          failedLoginAttempts: 0,
          lockedUntil: null,
          // The credentials version moves forward, so every access token issued before
          // this instant is rejected by the guard — the existing revocation mechanism.
          credentialsChangedAt: sql`now()`,
        })
        .where(eq(users.id, user.id));

      // Any *other* outstanding reset link dies with the password it was issued against.
      await tx
        .update(authTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(authTokens.userId, user.id),
            eq(authTokens.purpose, 'password_reset'),
            isNull(authTokens.usedAt),
            isNull(authTokens.revokedAt),
          ),
        );

      return { ok: true as const, user };
    });

    if (!outcome.ok) {
      await this.securityEvents.record({
        eventType: 'password_reset_requested',
        severity: 'warning',
        detail: { outcome: 'rejected', phase: 'reset', reason: 'invalid_or_expired_token' },
      });
      // Unknown, expired, used and revoked all read the same from outside.
      throw new NotFoundError('Password reset link');
    }

    const user = outcome.user;

    // Refresh-token sessions are revoked through the existing path, which also records
    // its own `session_revoked` security event.
    await this.auth.logoutAll(user.id);

    await this.securityEvents.record({
      eventType: 'password_changed',
      severity: 'info',
      userId: user.id,
      tenantId: user.tenantId,
      detail: { via: 'password_reset' },
    });
    await this.audit.record({
      tenantId: user.tenantId,
      actorUserId: user.id,
      actorEmail: user.email,
      action: 'password_reset',
      module: 'auth',
      resourceType: 'user',
      resourceId: user.id,
      requestId: currentContext()?.requestId ?? null,
      ipAddress: currentContext()?.ipAddress ?? null,
      userAgent: currentContext()?.userAgent ?? null,
    });
  }

  private async deliver(
    locale: string,
    recipientName: string,
    identifier: { kind: 'email' | 'phone'; value: string },
    token: string,
  ): Promise<void> {
    await this.notifications.send(
      identifier.kind === 'email' ? 'email' : 'sms',
      identifier.value,
      'password_reset',
      {
        locale,
        recipientName,
        actionUrl: `${env().WEB_APP_URL}/reset-password?token=${token}`,
        expiresInText: locale === 'bn' ? '৩০ মিনিটে' : 'in 30 minutes',
      },
    );
  }
}
