/**
 * Token issuance and verification.
 *
 * Access tokens are short-lived JWTs. Refresh tokens are opaque random strings stored as
 * SHA-256 hashes (ADR-007). The asymmetry is deliberate:
 *
 *  - A JWT is fast to verify with no database round trip, which is what makes a 15-minute
 *    access token cheap. It is also impossible to revoke, which is why it is short-lived and
 *    why `JwtAuthGuard` additionally checks `credentialsChangedAt`.
 *  - A refresh token lives for 30 days, so it *must* be revocable. Storing only its hash means
 *    a database read — from a backup, a log, or an injection — yields nothing usable.
 *
 * The access token carries no permissions. Encoding them would mean a role change does not
 * take effect until the token expires, and it would let a 4KB permission set travel on every
 * request. Permissions are loaded per request by `PrincipalService` instead.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { secureToken } from '@shikkha/shared';
import { env } from '../../config/env';

export interface AccessTokenClaims {
  /** User id. */
  sub: string;
  /** Tenant id, or null for platform staff. */
  tid: string | null;
  /**
   * Credentials version: the user's `credentials_changed_at` in epoch **milliseconds** at the
   * moment this token was issued.
   *
   * The obvious implementation compares `credentials_changed_at` against the standard `iat`
   * claim — but `iat` has one-second resolution, so a token minted 50ms before a password
   * change still looks newer than the change and survives. That is a real, if narrow, window in
   * which a revoked session keeps working. An explicit millisecond claim closes it exactly,
   * with no tolerance to tune.
   */
  cav: number;
  /** Issued-at, seconds. Standard JWT claim; not used for revocation. */
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

export interface IssuedRefreshToken {
  /** The value handed to the client. Never stored. */
  token: string;
  /** What goes in the database. */
  tokenHash: string;
  expiresAt: Date;
}

@Injectable()
export class TokenService {
  constructor(private readonly jwt: JwtService) {}

  async issueAccessToken(
    userId: string,
    tenantId: string | null,
    credentialsChangedAtMs: number,
  ): Promise<string> {
    const config = env();
    return this.jwt.signAsync(
      { sub: userId, tid: tenantId, cav: credentialsChangedAtMs },
      {
        secret: config.JWT_SECRET,
        expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
        issuer: config.JWT_ISSUER,
        audience: config.JWT_AUDIENCE,
      },
    );
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    const config = env();
    // Issuer and audience are verified, not merely present: a token minted by a different
    // service that happens to share the secret must not authenticate here.
    return this.jwt.verifyAsync<AccessTokenClaims>(token, {
      secret: config.JWT_SECRET,
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
      algorithms: ['HS256'],
    });
  }

  issueRefreshToken(): IssuedRefreshToken {
    const config = env();
    const token = secureToken(32);
    return {
      token,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + config.REFRESH_TOKEN_TTL_SECONDS * 1000),
    };
  }

  hashToken(token: string): string {
    return hashToken(token);
  }
}

/**
 * SHA-256 rather than a password hash.
 *
 * A refresh token is 256 bits of uniform randomness, so it is not brute-forceable and needs no
 * key stretching. Argon2 here would add tens of milliseconds to every token refresh for no
 * security gain — the slow-hash argument applies to low-entropy human-chosen secrets.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Constant-time comparison for token hashes.
 *
 * Database lookups are by indexed hash, so this is mostly belt-and-braces — but any place
 * that compares a secret with `===` eventually gets copied somewhere it matters.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
