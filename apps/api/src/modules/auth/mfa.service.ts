/**
 * TOTP multi-factor authentication.
 *
 * Lifecycle: enrol (secret generated, returned exactly once as an otpauth URI), enable
 * (requires a code that proves the authenticator actually holds the secret), verify at
 * login (a second step that upgrades a short-lived MFA challenge into a session), recovery
 * codes (hashed, single-use, regenerable), disable (requires the current password).
 *
 * The invariants that carry the security weight:
 *
 *  - **The secret is returned only during enrolment.** After `enable`, no endpoint ever
 *    includes it — and the serialization interceptor strips `mfaSecret`/`mfaRecoveryCodes`
 *    as a backstop should a whole user row ever leak into a response.
 *  - **A code never works twice.** `users.mfa_last_verified_step` records the highest
 *    verified TOTP step; a code at or below it is a replay and is refused even though the
 *    HMAC still matches. Recovery codes are removed from the stored array on use.
 *  - **The login challenge is not a session.** It is a single-use `auth_tokens` row
 *    (`purpose = 'mfa_challenge'`, 5-minute expiry, hashed) proving only that the password
 *    step passed. Five wrong codes revoke it and the password must be re-entered.
 *  - Every transition is written to the security event log, and enable/disable/regenerate
 *    are audited.
 */

import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { authTokens, users } from '@shikkha/db';
import {
  ConflictError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
  humanCode,
} from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import { DatabaseService } from '../database/database.service';
import { AuthService, type LoginResult } from './auth.service';
import { PasswordService } from './password.service';
import { hashToken, safeEqual } from './token.service';
import { SecurityEventService } from '../audit/security-event.service';
import { AuditService } from '../audit/audit.service';
import { buildOtpauthUri, generateTotpSecret, verifyTotp } from './totp';
import { env } from '../../config/env';
import { currentContext } from '../../common/context/request-context';

const RECOVERY_CODE_COUNT = 10;
/** Wrong codes allowed against one login challenge before it is revoked outright. */
const MAX_CHALLENGE_ATTEMPTS = 5;

const GENERIC_MFA_FAILURE =
  'This sign-in code is not valid. Check your authenticator and try again.';
const GENERIC_CHALLENGE_FAILURE =
  'This sign-in session has expired. Please enter your password again.';

type UserRow = typeof users.$inferSelect;

export interface MfaEnrolment {
  /** Base32 shared secret — shown once, at enrolment, never again. */
  secret: string;
  otpauthUri: string;
  /** What a client renders as a QR code. Identical to the URI by design. */
  qrPayload: string;
}

@Injectable()
export class MfaService {
  constructor(
    private readonly db: DatabaseService,
    private readonly auth: AuthService,
    private readonly passwords: PasswordService,
    private readonly securityEvents: SecurityEventService,
    private readonly audit: AuditService,
  ) {}

  /** Step 1 of enrolment: mint a secret. MFA is *not* on until `enable` verifies a code. */
  async enroll(principal: Principal): Promise<MfaEnrolment> {
    const user = await this.loadUser(principal.userId);
    if (user.mfaEnabled) {
      throw new ConflictError(
        'Two-factor authentication is already enabled. Disable it before enrolling again.',
      );
    }

    const secret = generateTotpSecret();
    await this.db.runAsPlatform(async (tx) => {
      await tx
        .update(users)
        .set({ mfaSecret: secret, mfaLastVerifiedStep: null })
        .where(eq(users.id, user.id));
    });

    await this.securityEvents.record({
      eventType: 'mfa_challenge',
      severity: 'info',
      userId: user.id,
      tenantId: user.tenantId,
      detail: { phase: 'enrolment_started' },
    });

    return {
      secret,
      otpauthUri: buildOtpauthUri(secret, env().JWT_ISSUER, user.email),
      qrPayload: buildOtpauthUri(secret, env().JWT_ISSUER, user.email),
    };
  }

  /** Step 2 of enrolment: prove the authenticator holds the secret, then switch MFA on. */
  async enable(principal: Principal, code: string): Promise<{ recoveryCodes: string[] }> {
    const user = await this.loadUser(principal.userId);
    if (user.mfaEnabled) {
      throw new ConflictError('Two-factor authentication is already enabled');
    }
    if (!user.mfaSecret) {
      throw new ConflictError('Start enrolment first to get a secret to verify against');
    }

    const step = verifyTotp(user.mfaSecret, code);
    if (step === null) {
      await this.securityEvents.record({
        eventType: 'mfa_challenge',
        severity: 'warning',
        userId: user.id,
        tenantId: user.tenantId,
        detail: { phase: 'enable_failed', reason: 'bad_code' },
      });
      throw new ValidationError('The code did not match', [
        { path: 'code', message: 'The code did not match. Scan the QR again and retry.' },
      ]);
    }

    const recoveryCodes = this.generateRecoveryCodes();
    await this.db.runAsPlatform(async (tx) => {
      await tx
        .update(users)
        .set({
          mfaEnabled: true,
          mfaRecoveryCodes: recoveryCodes.map(hashRecoveryCode),
          mfaLastVerifiedStep: step,
        })
        .where(eq(users.id, user.id));
    });

    await this.securityEvents.record({
      eventType: 'mfa_challenge',
      severity: 'info',
      userId: user.id,
      tenantId: user.tenantId,
      detail: { phase: 'enabled' },
    });
    await this.recordAudit(user, 'mfa_enabled');

    // The plain codes exist in this response and nowhere else — only hashes are stored.
    return { recoveryCodes };
  }

  /**
   * The second login step: exchange a live MFA challenge plus a valid TOTP or recovery
   * code for a real session.
   */
  async verifyChallenge(
    challengeToken: string,
    code: string,
    deviceLabel?: string,
  ): Promise<LoginResult> {
    const tokenHash = hashToken(challengeToken);

    const challenge = await this.db.runAsPlatform(async (tx) => {
      const [row] = await tx
        .select()
        .from(authTokens)
        .where(and(eq(authTokens.tokenHash, tokenHash), eq(authTokens.purpose, 'mfa_challenge')))
        .limit(1);
      return row ?? null;
    });

    if (
      !challenge?.userId ||
      challenge.usedAt ||
      challenge.revokedAt ||
      challenge.expiresAt <= new Date()
    ) {
      await this.securityEvents.record({
        eventType: 'mfa_challenge',
        severity: 'warning',
        userId: challenge?.userId ?? null,
        tenantId: challenge?.tenantId ?? null,
        detail: {
          phase: 'verify_failed',
          reason: challenge ? 'stale_challenge' : 'unknown_challenge',
        },
      });
      throw new UnauthenticatedError(GENERIC_CHALLENGE_FAILURE);
    }

    const user = await this.loadUser(challenge.userId);
    if (!user.mfaEnabled || !user.mfaSecret) {
      // MFA was disabled between the two steps; the challenge is meaningless now.
      throw new UnauthenticatedError(GENERIC_CHALLENGE_FAILURE);
    }

    const verified = /^\d{6}$/.test(code.replace(/\s+/g, ''))
      ? await this.verifyTotpCode(user, code.replace(/\s+/g, ''))
      : await this.verifyRecoveryCode(user, code);

    if (!verified.ok) {
      await this.registerFailedChallengeAttempt(challenge.id, challenge.attempts + 1);
      await this.securityEvents.record({
        eventType: 'mfa_challenge',
        severity: 'warning',
        userId: user.id,
        tenantId: user.tenantId,
        detail: {
          phase: 'verify_failed',
          reason: verified.reason,
          attempt: challenge.attempts + 1,
        },
      });
      throw new UnauthenticatedError(GENERIC_MFA_FAILURE);
    }

    // Claim the challenge atomically; a parallel verification with the same token loses.
    const claimed = await this.db.runAsPlatform(async (tx) => {
      const rows = await tx
        .update(authTokens)
        .set({ usedAt: new Date() })
        .where(and(eq(authTokens.id, challenge.id), isNull(authTokens.usedAt)))
        .returning({ id: authTokens.id });
      return rows.length > 0;
    });
    if (!claimed) {
      throw new UnauthenticatedError(GENERIC_CHALLENGE_FAILURE);
    }

    await this.securityEvents.record({
      eventType: 'mfa_challenge',
      severity: 'info',
      userId: user.id,
      tenantId: user.tenantId,
      detail: { phase: 'verified', method: verified.method },
    });

    return this.auth.completeLogin(user, deviceLabel);
  }

  /** Disabling the second factor always re-proves the password. */
  async disable(principal: Principal, password: string): Promise<void> {
    const user = await this.loadUser(principal.userId);
    if (!user.mfaEnabled) {
      throw new ConflictError('Two-factor authentication is not enabled');
    }
    await this.assertPassword(user, password, 'disable');

    await this.db.runAsPlatform(async (tx) => {
      await tx
        .update(users)
        .set({
          mfaEnabled: false,
          mfaSecret: null,
          mfaRecoveryCodes: null,
          mfaLastVerifiedStep: null,
        })
        .where(eq(users.id, user.id));
    });

    await this.securityEvents.record({
      eventType: 'mfa_challenge',
      severity: 'warning',
      userId: user.id,
      tenantId: user.tenantId,
      detail: { phase: 'disabled' },
    });
    await this.recordAudit(user, 'mfa_disabled');
  }

  /** Replace all recovery codes. The old set dies wholesale — no mixed generations. */
  async regenerateRecoveryCodes(
    principal: Principal,
    password: string,
  ): Promise<{ recoveryCodes: string[] }> {
    const user = await this.loadUser(principal.userId);
    if (!user.mfaEnabled) {
      throw new ConflictError('Two-factor authentication is not enabled');
    }
    await this.assertPassword(user, password, 'regenerate_recovery_codes');

    const recoveryCodes = this.generateRecoveryCodes();
    await this.db.runAsPlatform(async (tx) => {
      await tx
        .update(users)
        .set({ mfaRecoveryCodes: recoveryCodes.map(hashRecoveryCode) })
        .where(eq(users.id, user.id));
    });

    await this.securityEvents.record({
      eventType: 'mfa_challenge',
      severity: 'info',
      userId: user.id,
      tenantId: user.tenantId,
      detail: { phase: 'recovery_codes_regenerated' },
    });
    await this.recordAudit(user, 'mfa_recovery_codes_regenerated');

    return { recoveryCodes };
  }

  // ────────────────────────────────────────────────────────────────────────────────────

  private async verifyTotpCode(
    user: UserRow,
    code: string,
  ): Promise<{ ok: true; method: 'totp' } | { ok: false; reason: string }> {
    const step = verifyTotp(user.mfaSecret!, code);
    if (step === null) return { ok: false, reason: 'bad_code' };

    // Replay defence: the accepted step must move strictly forward.
    if (user.mfaLastVerifiedStep !== null && step <= user.mfaLastVerifiedStep) {
      return { ok: false, reason: 'replayed_code' };
    }

    // Guarded by the step read above, so two concurrent presentations of the same code
    // race on the database row and exactly one advances it.
    const advanced = await this.db.runAsPlatform(async (tx) => {
      const rows = await tx
        .update(users)
        .set({ mfaLastVerifiedStep: step })
        .where(
          and(
            eq(users.id, user.id),
            user.mfaLastVerifiedStep === null
              ? isNull(users.mfaLastVerifiedStep)
              : eq(users.mfaLastVerifiedStep, user.mfaLastVerifiedStep),
          ),
        )
        .returning({ id: users.id });
      return rows.length > 0;
    });

    if (!advanced) return { ok: false, reason: 'concurrent_verification' };
    return { ok: true, method: 'totp' };
  }

  private async verifyRecoveryCode(
    user: UserRow,
    code: string,
  ): Promise<{ ok: true; method: 'recovery_code' } | { ok: false; reason: string }> {
    const stored = Array.isArray(user.mfaRecoveryCodes) ? (user.mfaRecoveryCodes as string[]) : [];
    const presented = hashRecoveryCode(code);
    const match = stored.find((hash) => typeof hash === 'string' && safeEqual(hash, presented));
    if (!match) return { ok: false, reason: 'bad_recovery_code' };

    // Single-use: the matched hash is removed. The guarded update means a concurrent
    // presentation of the same code finds it already gone.
    const consumed = await this.db.runAsPlatform(async (tx) => {
      const [current] = await tx
        .select({ codes: users.mfaRecoveryCodes })
        .from(users)
        .where(eq(users.id, user.id))
        .limit(1);
      const liveCodes = Array.isArray(current?.codes) ? (current.codes as string[]) : [];
      if (!liveCodes.includes(match)) return false;
      await tx
        .update(users)
        .set({ mfaRecoveryCodes: liveCodes.filter((hash) => hash !== match) })
        .where(eq(users.id, user.id));
      return true;
    });

    if (!consumed) return { ok: false, reason: 'recovery_code_already_used' };
    return { ok: true, method: 'recovery_code' };
  }

  private async registerFailedChallengeAttempt(
    challengeId: string,
    attempts: number,
  ): Promise<void> {
    await this.db.runAsPlatform(async (tx) => {
      await tx
        .update(authTokens)
        .set(
          attempts >= MAX_CHALLENGE_ATTEMPTS ? { attempts, revokedAt: new Date() } : { attempts },
        )
        .where(eq(authTokens.id, challengeId));
    });
  }

  private async assertPassword(user: UserRow, password: string, phase: string): Promise<void> {
    const matches = user.passwordHash
      ? await this.passwords.verify(user.passwordHash, password)
      : false;
    if (!matches) {
      await this.securityEvents.record({
        eventType: 'mfa_challenge',
        severity: 'warning',
        userId: user.id,
        tenantId: user.tenantId,
        detail: { phase: `${phase}_denied`, reason: 'wrong_password' },
      });
      throw new ValidationError('Your password is not correct', [
        { path: 'password', message: 'Incorrect password' },
      ]);
    }
  }

  private generateRecoveryCodes(): string[] {
    // XXXX-XXXX over the unambiguous human alphabet: read aloud over the phone to a school
    // office, so no 0/O or 1/I confusables.
    return Array.from({ length: RECOVERY_CODE_COUNT }, () => `${humanCode(4)}-${humanCode(4)}`);
  }

  private async loadUser(userId: string): Promise<UserRow> {
    const user = await this.db.runAsPlatform(async (tx) => {
      const [row] = await tx
        .select()
        .from(users)
        .where(and(eq(users.id, userId), isNull(users.archivedAt)))
        .limit(1);
      return row ?? null;
    });
    if (!user) throw new NotFoundError('User', userId);
    return user;
  }

  private async recordAudit(user: UserRow, change: string): Promise<void> {
    await this.audit.record({
      tenantId: user.tenantId,
      actorUserId: user.id,
      actorEmail: user.email,
      action: 'update',
      module: 'auth',
      resourceType: 'user',
      resourceId: user.id,
      newValue: { change },
      requestId: currentContext()?.requestId ?? null,
      ipAddress: currentContext()?.ipAddress ?? null,
      userAgent: currentContext()?.userAgent ?? null,
    });
  }
}

/**
 * Recovery codes are high-entropy machine-generated values, so — like refresh tokens, and
 * unlike passwords — SHA-256 is the right hash. Normalised so `abcd-efgh` typed with a
 * space or in lower case still matches.
 */
function hashRecoveryCode(code: string): string {
  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}
