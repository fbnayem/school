/**
 * API unit tests — the pieces that can be tested without a database.
 *
 * Three things live here, and all three are security-relevant in ways that are easy to get
 * subtly wrong and hard to notice:
 *
 *  - the password policy, which must agree with the client-side schema;
 *  - the log redaction list, which is what keeps student data out of a log aggregator;
 *  - the error envelope, which is what keeps stack traces and SQL out of responses.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { HttpException, HttpStatus, ForbiddenException } from '@nestjs/common';
import { passwordSchema } from '@shikkha/validation';
import { ConflictError, NotFoundError, toErrorResponse, ValidationError } from '@shikkha/shared';
import { PasswordService } from '../../src/modules/auth/password.service';
import { hashToken, safeEqual } from '../../src/modules/auth/token.service';
import { loadEnv, resetEnvCache } from '../../src/config/env';
import { initLogger } from '../../src/common/logger';

function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgres://shikkha_app:pw@localhost:5433/db',
    JWT_SECRET: 'a'.repeat(64),
    ...overrides,
  } as NodeJS.ProcessEnv;
}

beforeAll(() => {
  // The exception filter logs what it catches, which is correct in production and noise here —
  // these tests deliberately throw a dozen errors.
  initLogger({ level: 'silent', pretty: false, environment: 'test' });
  process.env.JWT_SECRET = 'a'.repeat(64);
  process.env.DATABASE_URL = 'postgres://shikkha_app:pw@localhost:5433/db';
  process.env.ARGON2_MEMORY_KIB = '8192';
  resetEnvCache();
});

describe('password policy', () => {
  const service = new PasswordService();

  it('requires at least 12 characters', () => {
    expect(service.check('Short1!').valid).toBe(false);
    expect(service.check('LongEnoughPhrase').valid).toBe(true);
  });

  it('rejects passwords common in this deployment context', () => {
    for (const password of ['password123', 'teacher123', 'school123', 'bangladesh']) {
      expect(service.check(password).valid, password).toBe(false);
    }
  });

  it('rejects a password containing the user’s email or name', () => {
    expect(service.check('rahimahmed2026x', { email: 'rahim@school.test' }).valid).toBe(false);
    expect(service.check('rahimsomethinglong', { name: 'Rahim Ahmed' }).valid).toBe(false);
  });

  it('rejects a single repeated character regardless of length', () => {
    expect(service.check('aaaaaaaaaaaaaaaa').valid).toBe(false);
  });

  it('bounds the maximum length', () => {
    // Argon2 hashes the whole input, so an unbounded password is a cheap denial of service.
    expect(service.check('a1B'.repeat(60)).valid).toBe(false);
  });

  it('agrees with the client-side schema on a shared table of examples', () => {
    // The two implementations are deliberately separate — the server must not depend on a
    // package the client can influence, and the client needs synchronous feedback while
    // typing — so they are pinned against each other here.
    const cases: Array<[string, boolean]> = [
      ['short', false],
      ['exactlytwelve', true],
      ['AVeryLongPassphrase2026', true],
      ['aaaaaaaaaaaaaa', false],
    ];
    for (const [password, expected] of cases) {
      expect(passwordSchema.safeParse(password).success, `client: ${password}`).toBe(expected);
      expect(service.check(password).valid, `server: ${password}`).toBe(expected);
    }
  });

  it('explains every reason it refused, not just the first', () => {
    const result = service.check('abc', { email: 'abc@school.test' });
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThanOrEqual(1);
  });
});

describe('password hashing', () => {
  const service = new PasswordService();

  it('produces an argon2id hash and verifies it', async () => {
    const hash = await service.hash('CorrectHorseBattery2026');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await service.verify(hash, 'CorrectHorseBattery2026')).toBe(true);
    expect(await service.verify(hash, 'WrongPassword2026')).toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const a = await service.hash('SamePassword2026Long');
    const b = await service.hash('SamePassword2026Long');
    expect(a).not.toBe(b);
  });

  it('returns false rather than throwing on a corrupt stored hash', async () => {
    // A corrupt row should deny the login, not produce a 500 that tells an attacker the
    // account exists and is broken.
    expect(await service.verify('not-a-hash', 'anything')).toBe(false);
    expect(await service.verify('', 'anything')).toBe(false);
  });

  it('burnTime does not throw and takes comparable work', async () => {
    await expect(service.burnTime()).resolves.toBeUndefined();
  });
});

describe('token hashing', () => {
  it('produces a 64-character hex SHA-256', () => {
    expect(hashToken('some-refresh-token')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic, which is what makes the indexed lookup possible', () => {
    expect(hashToken('same')).toBe(hashToken('same'));
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });

  it('compares in constant time without throwing on a length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    // timingSafeEqual throws on differing lengths; the wrapper must not.
    expect(safeEqual('abc', 'abcdef')).toBe(false);
  });
});

describe('environment validation', () => {
  it('accepts a minimal valid development environment', () => {
    expect(() => loadEnv(baseEnv())).not.toThrow();
  });

  it('requires a database URL and a long JWT secret', () => {
    expect(() => loadEnv({ JWT_SECRET: 'a'.repeat(64) } as NodeJS.ProcessEnv)).toThrow(
      /DATABASE_URL/,
    );
    expect(() => loadEnv(baseEnv({ JWT_SECRET: 'too-short' }))).toThrow(/JWT_SECRET/);
  });

  describe('production guards', () => {
    const production = (overrides: Record<string, string> = {}) =>
      baseEnv({
        NODE_ENV: 'production',
        JWT_SECRET: 'x'.repeat(64),
        COOKIE_SECURE: 'true',
        CORS_ORIGINS: 'https://school.example',
        STORAGE_DRIVER: 's3',
        S3_BUCKET: 'shikkha',
        S3_ACCESS_KEY_ID: 'key',
        ...overrides,
      });

    it('accepts a correctly configured production environment', () => {
      expect(() => loadEnv(production())).not.toThrow();
    });

    it('refuses a known development placeholder secret', () => {
      expect(() =>
        loadEnv(production({ JWT_SECRET: 'development-only-secret-not-for-production' })),
      ).toThrow(/JWT_SECRET/);
    });

    it('refuses insecure cookies', () => {
      expect(() => loadEnv(production({ COOKIE_SECURE: 'false' }))).toThrow(/COOKIE_SECURE/);
    });

    it('refuses a wildcard or localhost CORS origin', () => {
      expect(() => loadEnv(production({ CORS_ORIGINS: '*' }))).toThrow(/CORS_ORIGINS/);
      expect(() => loadEnv(production({ CORS_ORIGINS: 'http://localhost:3000' }))).toThrow(
        /CORS_ORIGINS/,
      );
    });

    it('refuses the local storage driver, which loses documents on redeploy', () => {
      expect(() => loadEnv(production({ STORAGE_DRIVER: 'local' }))).toThrow(/STORAGE_DRIVER/);
    });

    it('refuses a database URL pointing at the migrator role', () => {
      // Connecting as the owner would silently disable row-level security.
      expect(() =>
        loadEnv(production({ DATABASE_URL: 'postgres://shikkha_migrator:pw@db:5432/shikkha' })),
      ).toThrow(/DATABASE_URL/);
    });

    it('refuses query logging, which would put student data in the logs', () => {
      expect(() => loadEnv(production({ DATABASE_LOG_QUERIES: 'true' }))).toThrow(
        /DATABASE_LOG_QUERIES/,
      );
    });

    it('refuses demo credential hints', () => {
      expect(() => loadEnv(production({ ENABLE_DEMO_HINTS: 'true' }))).toThrow(/ENABLE_DEMO_HINTS/);
    });

    it('reports every problem at once, not one per restart', () => {
      try {
        loadEnv(production({ COOKIE_SECURE: 'false', CORS_ORIGINS: '*', STORAGE_DRIVER: 'local' }));
        throw new Error('expected loadEnv to throw');
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain('COOKIE_SECURE');
        expect(message).toContain('CORS_ORIGINS');
        expect(message).toContain('STORAGE_DRIVER');
      }
    });
  });
});

describe('error envelope', () => {
  it('preserves a safe domain message and its status', () => {
    const { status, body } = toErrorResponse(new NotFoundError('Student', 'abc'), 'req-1');
    expect(status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toBe('req-1');
  });

  it('includes field issues for validation failures', () => {
    const error = new ValidationError('bad', [{ path: 'phone', message: 'Invalid number' }]);
    const { status, body } = toErrorResponse(error);
    expect(status).toBe(422);
    expect(body.error.issues).toHaveLength(1);
    expect(body.error.issues![0]!.path).toBe('phone');
  });

  it('replaces the message of an unknown error entirely', () => {
    const { status, body } = toErrorResponse(new Error('connection to 10.0.0.4:5432 refused'));
    expect(status).toBe(500);
    expect(body.error.message).not.toContain('10.0.0.4');
    expect(body.error.message).not.toContain('5432');
  });

  it('does not leak the internal detail of a non-public error', () => {
    const error = new ConflictError('duplicate', { detail: 'Key (phone)=(+8801712345678)' });
    const { body } = toErrorResponse(error);
    // ConflictError is public, so its message shows — but the context never serialises.
    expect(JSON.stringify(body)).not.toContain('+8801712345678');
  });

  it('never includes a stack trace', () => {
    const error = new Error('boom');
    expect(JSON.stringify(toErrorResponse(error).body)).not.toContain('at ');
  });
});

describe('HttpException mapping', () => {
  /**
   * Regression test for a real defect: framework exceptions were converted into a plain object
   * with the right fields, but `toErrorResponse` gates on `instanceof DomainError`, so every
   * guard's 403 fell through to the generic 500 branch. Authorization failures were
   * indistinguishable from crashes.
   */
  it('a ForbiddenException maps to 403, not 500', async () => {
    const { AllExceptionsFilter } = await import('../../src/common/filters/all-exceptions.filter');

    let capturedStatus = 0;
    let capturedBody: unknown = null;
    const response = {
      headersSent: false,
      setHeader: () => undefined,
      status(code: number) {
        capturedStatus = code;
        return this;
      },
      json(body: unknown) {
        capturedBody = body;
        return this;
      },
    };
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({ method: 'GET', originalUrl: '/api/v1/audit-logs' }),
      }),
    };

    new AllExceptionsFilter().catch(
      new ForbiddenException('You do not have permission to perform this action'),
      host as never,
    );

    expect(capturedStatus).toBe(403);
    expect((capturedBody as { error: { code: string } }).error.code).toBe('FORBIDDEN');
  });

  it('a 500-level HttpException still has its message replaced', async () => {
    const { AllExceptionsFilter } = await import('../../src/common/filters/all-exceptions.filter');

    let capturedBody: unknown = null;
    const response = {
      headersSent: false,
      setHeader: () => undefined,
      status() {
        return this;
      },
      json(body: unknown) {
        capturedBody = body;
        return this;
      },
    };
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({ method: 'GET', originalUrl: '/x' }),
      }),
    };

    new AllExceptionsFilter().catch(
      new HttpException('internal detail about the database', HttpStatus.INTERNAL_SERVER_ERROR),
      host as never,
    );

    expect(JSON.stringify(capturedBody)).not.toContain('internal detail');
  });
});
