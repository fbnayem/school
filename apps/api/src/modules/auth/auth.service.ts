/**
 * Authentication: login, refresh with rotation, logout, password change.
 *
 * The refresh flow is the part that repays careful reading. Refresh tokens rotate on every
 * use, and a rotated token is deleted. If a *previously rotated* token is presented, one of
 * two things happened: the legitimate client retried after a network failure, or a stolen
 * token is being replayed. There is no way to tell them apart, so the safe response is to
 * revoke the entire session family and force a fresh login. That is the standard OAuth 2.1
 * refresh-token-rotation defence, and it turns token theft from a persistent foothold into a
 * single-use window that also alerts.
 */

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { sessions, users } from '@shikkha/db';
import {
  ForbiddenError,
  UnauthenticatedError,
  ValidationError,
  uuidv7,
  normalizeBdMobile,
} from '@shikkha/shared';
import { DatabaseService } from '../database/database.service';
import { PasswordService } from './password.service';
import { PrincipalService } from './principal.service';
import { TokenService, hashToken } from './token.service';
import { SecurityEventService } from '../audit/security-event.service';
import { AuditService } from '../audit/audit.service';
import { env } from '../../config/env';
import { currentContext } from '../../common/context/request-context';

export interface LoginInput {
  /** Email address or Bangladeshi mobile number — many parents have no email. */
  identifier: string;
  password: string;
  /** Optional tenant slug, for a school-specific login page. */
  tenantSlug?: string;
  deviceLabel?: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  refreshTokenExpiresAt: Date;
}

export interface LoginResult extends AuthTokens {
  user: {
    id: string;
    email: string;
    fullNameEn: string;
    locale: string;
    tenantId: string | null;
    isPlatformAdmin: boolean;
    mustChangePassword: boolean;
  };
}

const GENERIC_LOGIN_FAILURE = 'Incorrect credentials. Please check and try again.';

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly passwords: PasswordService,
    private readonly principals: PrincipalService,
    private readonly tokens: TokenService,
    private readonly securityEvents: SecurityEventService,
    private readonly audit: AuditService,
  ) {}

  async login(input: LoginInput): Promise<LoginResult> {
    const config = env();
    const identifier = normalizeIdentifier(input.identifier);

    // Runs with RLS relaxed: at this point we do not know the tenant, and the user row is
    // what tells us. Bounded to a single indexed lookup on a normalised identifier.
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

    if (!user) {
      // Constant-ish time regardless of whether the account exists, so response latency is
      // not an account-enumeration oracle.
      await this.passwords.burnTime();
      await this.securityEvents.record({
        eventType: 'login_failed',
        severity: 'info',
        attemptedIdentifier: identifier.value,
        detail: { reason: 'no_such_account' },
      });
      throw new UnauthenticatedError(GENERIC_LOGIN_FAILURE);
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.securityEvents.record({
        eventType: 'login_failed',
        severity: 'warning',
        userId: user.id,
        tenantId: user.tenantId,
        attemptedIdentifier: identifier.value,
        detail: { reason: 'account_locked', lockedUntil: user.lockedUntil.toISOString() },
      });
      // Told plainly: a locked-out teacher needs to know to wait rather than keep guessing.
      throw new UnauthenticatedError(
        'This account is temporarily locked after too many failed attempts. Try again shortly or ask an administrator to reset it.',
      );
    }

    if (!user.passwordHash) {
      await this.passwords.burnTime();
      await this.securityEvents.record({
        eventType: 'login_failed',
        severity: 'info',
        userId: user.id,
        tenantId: user.tenantId,
        detail: { reason: 'no_password_set' },
      });
      throw new UnauthenticatedError(
        'This account has not been activated yet. Use the invitation link that was sent to you.',
      );
    }

    const passwordMatches = await this.passwords.verify(user.passwordHash, input.password);

    if (!passwordMatches) {
      await this.registerFailedAttempt(user.id, user.failedLoginAttempts + 1);
      await this.securityEvents.record({
        eventType: 'login_failed',
        severity:
          user.failedLoginAttempts + 1 >= config.MAX_FAILED_LOGIN_ATTEMPTS ? 'warning' : 'info',
        userId: user.id,
        tenantId: user.tenantId,
        attemptedIdentifier: identifier.value,
        detail: { reason: 'bad_password', attempt: user.failedLoginAttempts + 1 },
      });
      throw new UnauthenticatedError(GENERIC_LOGIN_FAILURE);
    }

    // Status is checked *after* the password, on purpose. Refusing a suspended account before
    // verifying the password would confirm the account exists to anyone who guesses an email.
    if (user.status !== 'active' && user.status !== 'invited') {
      await this.securityEvents.record({
        eventType: 'login_failed',
        severity: 'warning',
        userId: user.id,
        tenantId: user.tenantId,
        detail: { reason: `status_${user.status}` },
      });
      throw new ForbiddenError(
        undefined,
        'This account is not active. Contact your administrator.',
      );
    }

    if (user.tenantId) {
      const organizationActive = await this.isOrganizationActive(user.tenantId);
      if (!organizationActive) {
        throw new ForbiddenError(
          undefined,
          'Your school’s subscription is not active. Contact your administrator.',
        );
      }
    }

    const issued = await this.createSession(
      user.id,
      user.tenantId,
      user.credentialsChangedAt.getTime(),
      input.deviceLabel,
    );
    await this.markLoginSuccess(user.id);

    await this.securityEvents.record({
      eventType: 'login_success',
      userId: user.id,
      tenantId: user.tenantId,
      detail: { device: input.deviceLabel ?? null },
    });
    await this.audit.record({
      tenantId: user.tenantId,
      actorUserId: user.id,
      actorEmail: user.email,
      action: 'login',
      module: 'auth',
      resourceType: 'session',
      resourceId: null,
      requestId: currentContext()?.requestId ?? null,
      ipAddress: currentContext()?.ipAddress ?? null,
      userAgent: currentContext()?.userAgent ?? null,
    });

    return {
      ...issued,
      user: {
        id: user.id,
        email: user.email,
        fullNameEn: user.fullNameEn,
        locale: user.locale,
        tenantId: user.tenantId,
        isPlatformAdmin: user.isPlatformAdmin,
        mustChangePassword: user.mustChangePassword,
      },
    };
  }

  /**
   * Rotate a refresh token.
   *
   * Presenting a token that is not the session's current one means it has already been
   * rotated — either a retry or a replay. Both revoke the family.
   */
  async refresh(refreshToken: string, deviceLabel?: string): Promise<AuthTokens> {
    const presentedHash = hashToken(refreshToken);

    const outcome = await this.db.runAsPlatform(async (tx) => {
      const [session] = await tx
        .select()
        .from(sessions)
        .where(eq(sessions.tokenHash, presentedHash))
        .limit(1);

      if (!session) return { kind: 'unknown' as const };

      if (session.revokedAt) {
        // A revoked session's token was presented. The family is already dead, but this is
        // worth recording — it means a token survived past a logout somewhere.
        return { kind: 'revoked' as const, session };
      }

      if (session.expiresAt <= new Date()) {
        return { kind: 'expired' as const, session };
      }

      const issued = this.tokens.issueRefreshToken();
      await tx
        .update(sessions)
        .set({
          tokenHash: issued.tokenHash,
          rotationCount: session.rotationCount + 1,
          lastUsedAt: new Date(),
          expiresAt: issued.expiresAt,
          deviceLabel: deviceLabel ?? session.deviceLabel,
        })
        .where(eq(sessions.id, session.id));

      return { kind: 'rotated' as const, session, issued };
    });

    if (outcome.kind === 'unknown') {
      // The token matches no live session. It may be a token that was rotated away, which is
      // the replay signal — but we cannot identify the family from a hash we no longer store,
      // so the best available response is to refuse and record.
      await this.securityEvents.record({
        eventType: 'token_reuse_detected',
        severity: 'warning',
        detail: { reason: 'refresh_token_not_recognised' },
      });
      throw new UnauthorizedException('Your session has ended. Please sign in again.');
    }

    if (outcome.kind === 'revoked' || outcome.kind === 'expired') {
      await this.revokeFamily(outcome.session.familyId, 'reuse_detected');
      await this.securityEvents.record({
        eventType: 'token_reuse_detected',
        severity: 'critical',
        userId: outcome.session.userId,
        tenantId: outcome.session.tenantId,
        detail: {
          reason: outcome.kind,
          familyId: outcome.session.familyId,
          rotations: outcome.session.rotationCount,
        },
      });
      throw new UnauthorizedException('Your session has ended. Please sign in again.');
    }

    // Re-read the credentials version rather than assuming the session's is current: a
    // password change between refreshes must not be papered over by a stale value.
    const credentialsChangedAt = await this.credentialsChangedAt(outcome.session.userId);
    const accessToken = await this.tokens.issueAccessToken(
      outcome.session.userId,
      outcome.session.tenantId,
      credentialsChangedAt,
    );

    return {
      accessToken,
      refreshToken: outcome.issued.token,
      accessTokenExpiresIn: env().ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenExpiresAt: outcome.issued.expiresAt,
    };
  }

  /** Revoke the presented session. Idempotent: an unknown token is not an error. */
  async logout(refreshToken: string | null, userId: string): Promise<void> {
    if (refreshToken) {
      const tokenHash = hashToken(refreshToken);
      await this.db.runAsPlatform(async (tx) => {
        await tx
          .update(sessions)
          .set({ revokedAt: new Date(), revokedReason: 'logout' })
          .where(and(eq(sessions.tokenHash, tokenHash), eq(sessions.userId, userId)));
      });
    }
    await this.securityEvents.record({
      eventType: 'session_revoked',
      userId,
      detail: { reason: 'logout' },
    });
  }

  /** "Log out everywhere". Revokes every session and invalidates outstanding access tokens. */
  async logoutAll(userId: string): Promise<number> {
    const revoked = await this.db.runAsPlatform(async (tx) => {
      const result = await tx
        .update(sessions)
        .set({ revokedAt: new Date(), revokedReason: 'logout_all' })
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
        .returning({ id: sessions.id });
      return result.length;
    });
    await this.principals.invalidateTokens(userId);
    await this.securityEvents.record({
      eventType: 'session_revoked',
      userId,
      detail: { reason: 'logout_all', count: revoked },
    });
    return revoked;
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.db.runAsPlatform(async (tx) => {
      const [found] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
      return found ?? null;
    });
    if (!user?.passwordHash) throw new UnauthenticatedError('Unable to change password');

    const matches = await this.passwords.verify(user.passwordHash, currentPassword);
    if (!matches) {
      await this.securityEvents.record({
        eventType: 'login_failed',
        severity: 'warning',
        userId,
        tenantId: user.tenantId,
        detail: { reason: 'wrong_current_password_on_change' },
      });
      throw new ValidationError('Your current password is not correct', [
        { path: 'currentPassword', message: 'Incorrect password' },
      ]);
    }

    const policy = this.passwords.check(newPassword, {
      email: user.email,
      name: user.fullNameEn,
    });
    if (!policy.valid) {
      throw new ValidationError(
        'The new password does not meet the requirements',
        policy.issues.map((message) => ({ path: 'newPassword', message })),
      );
    }

    const hash = await this.passwords.hash(newPassword);
    await this.db.runAsPlatform(async (tx) => {
      await tx
        .update(users)
        .set({
          passwordHash: hash,
          mustChangePassword: false,
          // Invalidates every outstanding access token immediately.
          credentialsChangedAt: sql`now()`,
        })
        .where(eq(users.id, userId));
    });

    // Changing a password logs out other devices. If the password was changed because it was
    // compromised, leaving the attacker's session alive would defeat the point.
    await this.logoutAll(userId);

    await this.securityEvents.record({
      eventType: 'password_changed',
      severity: 'info',
      userId,
      tenantId: user.tenantId,
    });
    await this.audit.record({
      tenantId: user.tenantId,
      actorUserId: userId,
      actorEmail: user.email,
      action: 'password_reset',
      module: 'auth',
      resourceType: 'user',
      resourceId: userId,
      requestId: currentContext()?.requestId ?? null,
      ipAddress: currentContext()?.ipAddress ?? null,
    });
  }

  // ────────────────────────────────────────────────────────────────────────────────────

  private async createSession(
    userId: string,
    tenantId: string | null,
    credentialsChangedAtMs: number,
    deviceLabel?: string,
  ): Promise<AuthTokens> {
    const config = env();
    const issued = this.tokens.issueRefreshToken();
    const context = currentContext();

    await this.db.runAsPlatform(async (tx) => {
      await tx.insert(sessions).values({
        tenantId,
        userId,
        tokenHash: issued.tokenHash,
        // A new login starts a new family; rotations within it share this id, so reuse
        // detection can revoke exactly the compromised chain and nothing else.
        familyId: uuidv7(),
        rotationCount: 0,
        userAgent: context?.userAgent ?? null,
        ipAddress: context?.ipAddress ?? null,
        deviceLabel: deviceLabel ?? null,
        expiresAt: issued.expiresAt,
      });
    });

    const accessToken = await this.tokens.issueAccessToken(
      userId,
      tenantId,
      credentialsChangedAtMs,
    );
    return {
      accessToken,
      refreshToken: issued.token,
      accessTokenExpiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenExpiresAt: issued.expiresAt,
    };
  }

  private async revokeFamily(familyId: string, reason: string): Promise<void> {
    await this.db.runAsPlatform(async (tx) => {
      await tx
        .update(sessions)
        .set({ revokedAt: new Date(), revokedReason: reason })
        .where(and(eq(sessions.familyId, familyId), isNull(sessions.revokedAt)));
    });
  }

  private async registerFailedAttempt(userId: string, attempts: number): Promise<void> {
    const config = env();
    const shouldLock = attempts >= config.MAX_FAILED_LOGIN_ATTEMPTS;
    await this.db.runAsPlatform(async (tx) => {
      await tx
        .update(users)
        .set({
          failedLoginAttempts: attempts,
          lockedUntil: shouldLock
            ? new Date(Date.now() + config.ACCOUNT_LOCK_MINUTES * 60_000)
            : null,
        })
        .where(eq(users.id, userId));
    });
    if (shouldLock) {
      await this.securityEvents.record({
        eventType: 'account_locked',
        severity: 'warning',
        userId,
        detail: { attempts, lockMinutes: config.ACCOUNT_LOCK_MINUTES },
      });
    }
  }

  private async markLoginSuccess(userId: string): Promise<void> {
    const context = currentContext();
    await this.db.runAsPlatform(async (tx) => {
      await tx
        .update(users)
        .set({
          failedLoginAttempts: 0,
          lockedUntil: null,
          lastLoginAt: new Date(),
          lastLoginIp: context?.ipAddress ?? null,
          // An invited user becomes active on their first successful sign-in.
          status: sql`case when ${users.status} = 'invited' then 'active'::user_status else ${users.status} end`,
        })
        .where(eq(users.id, userId));
    });
  }

  /** The user's current credentials version, in epoch milliseconds. */
  private async credentialsChangedAt(userId: string): Promise<number> {
    return this.db.runAsPlatform(async (tx) => {
      const [row] = await tx
        .select({ changedAt: users.credentialsChangedAt })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return row?.changedAt.getTime() ?? Date.now();
    });
  }

  private async isOrganizationActive(tenantId: string): Promise<boolean> {
    return this.db.runAsPlatform(async (tx) => {
      const rows = await tx.execute<{ ok: boolean }>(
        sql`select (is_active and suspended_at is null and archived_at is null) as ok
            from organizations where id = ${tenantId}`,
      );
      return rows.rows[0]?.ok ?? false;
    });
  }
}

/**
 * Accept an email address or a Bangladeshi mobile number as the login identifier.
 *
 * Normalising the phone number here is what makes `01712345678` and `+8801712345678` the same
 * account. Without it, a parent who typed their number differently at registration is simply
 * locked out with no way to discover why.
 */
function normalizeIdentifier(raw: string): { kind: 'email' | 'phone'; value: string } {
  const trimmed = raw.trim();
  if (trimmed.includes('@')) {
    return { kind: 'email', value: trimmed.toLowerCase() };
  }
  const phone = normalizeBdMobile(trimmed);
  if (phone) return { kind: 'phone', value: phone };
  // Not a valid phone and not an email: treat as an email so the lookup fails normally rather
  // than returning a different error that would distinguish "malformed" from "no such account".
  return { kind: 'email', value: trimmed.toLowerCase() };
}
