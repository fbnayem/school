/**
 * Password hashing and strength policy.
 *
 * Argon2id at the OWASP baseline (ADR-007). The parameters are configurable because the right
 * memory cost depends on the deployment's hardware, and a fixed value would either be too slow
 * on a small VPS or too weak on a proper server.
 */

import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import { env } from '../../config/env';

/**
 * Passwords that appear constantly in Bangladeshi school deployments and would otherwise pass
 * a naive length check. This is a short denylist, not a substitute for a breach corpus — the
 * length requirement does the heavy lifting.
 */
const OBVIOUS_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  '12345678',
  '123456789',
  'qwertyuiop',
  'admin123',
  'school123',
  'teacher123',
  'student123',
  'bangladesh',
  'dhaka1234',
  'letmein123',
  'welcome123',
  'shikkha123',
]);

export interface PasswordCheck {
  valid: boolean;
  issues: string[];
}

@Injectable()
export class PasswordService {
  async hash(plain: string): Promise<string> {
    const config = env();
    return argon2.hash(plain, {
      type: argon2.argon2id,
      memoryCost: config.ARGON2_MEMORY_KIB,
      timeCost: config.ARGON2_TIME_COST,
      parallelism: config.ARGON2_PARALLELISM,
    });
  }

  /**
   * Verify a password against a stored hash.
   *
   * Returns false rather than throwing on a malformed hash. A corrupt row should deny the
   * login, not produce a 500 that tells an attacker the account exists and is broken.
   */
  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false;
    }
  }

  /**
   * Burn roughly the same time as a real verification when the account does not exist.
   *
   * Without this, "user not found" returns in under a millisecond while a real verification
   * takes ~50ms, and that difference is a reliable account-enumeration oracle. The hash below
   * is a fixed dummy, so the work is genuinely performed.
   */
  async burnTime(): Promise<void> {
    await argon2
      .verify(
        '$argon2id$v=19$m=19456,t=2,p=1$c2hpa2toYS1kdW1teS1zYWx0$RdescudvJCsgt3ub+b+dWRWJTmaaJObG',
        'not-the-real-password',
      )
      .catch(() => false);
  }

  /**
   * Password policy.
   *
   * Length over composition rules: NIST dropped mandatory character-class requirements
   * because they push users toward predictable substitutions (`Password1!`) without adding
   * meaningful entropy. Twelve characters with a denylist is the better trade for a product
   * whose users include teachers logging in on a shared staffroom machine.
   */
  check(password: string, context: { email?: string; name?: string } = {}): PasswordCheck {
    const issues: string[] = [];

    if (password.length < 12) {
      issues.push('Password must be at least 12 characters long');
    }
    if (password.length > 128) {
      // Bounded because Argon2 hashes the whole input; an unbounded password is a cheap DoS.
      issues.push('Password must be at most 128 characters long');
    }
    if (OBVIOUS_PASSWORDS.has(password.toLowerCase())) {
      issues.push('This password is too common. Choose something less predictable.');
    }
    if (/^(.)\1+$/.test(password)) {
      issues.push('Password cannot be a single repeated character');
    }
    if (context.email) {
      const localPart = context.email.split('@')[0]?.toLowerCase();
      if (localPart && localPart.length >= 4 && password.toLowerCase().includes(localPart)) {
        issues.push('Password must not contain your email address');
      }
    }
    if (context.name) {
      const firstName = context.name.trim().split(/\s+/)[0]?.toLowerCase();
      if (firstName && firstName.length >= 4 && password.toLowerCase().includes(firstName)) {
        issues.push('Password must not contain your name');
      }
    }

    return { valid: issues.length === 0, issues };
  }
}
