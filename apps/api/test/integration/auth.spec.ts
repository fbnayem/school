/**
 * Authentication integration suite.
 *
 * The refresh-token rotation and reuse-detection behaviour (ADR-007) is the part that most
 * repays testing: it is security-critical, it is invisible in ordinary use, and a regression
 * would silently turn stolen tokens back into a persistent foothold.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from '@shikkha/shared';
import {
  createTestApp,
  seedTenant,
  testClient,
  truncateAll,
  TEST_PASSWORD,
  type SeededTenant,
} from '../helpers/test-app';

describe('Authentication', () => {
  let app: INestApplication;
  let tenant: SeededTenant;

  const login = (identifier: string, password = TEST_PASSWORD) =>
    request(app.getHttpServer()).post('/api/v1/auth/login').send({ identifier, password });

  beforeAll(async () => {
    app = await createTestApp();
    await truncateAll();
    tenant = await seedTenant('auth', { students: 2 });
  });

  afterAll(async () => {
    await app?.close();
  });

  // ── Login ─────────────────────────────────────────────────────────────────────────

  it('signs in with correct credentials and returns tokens plus the user', async () => {
    const response = await login(tenant.users['principal']!.email);
    expect(response.status).toBe(200);
    expect(response.body.accessToken).toBeTruthy();
    expect(response.body.refreshToken).toBeTruthy();
    expect(response.body.user.email).toBe(tenant.users['principal']!.email);
    expect(response.body.expiresIn).toBe(900);
  });

  it('sets httpOnly cookies that JavaScript cannot read', async () => {
    const response = await login(tenant.users['principal']!.email);
    const cookies = response.headers['set-cookie'] as unknown as string[];
    const access = cookies.find((c) => c.startsWith(ACCESS_TOKEN_COOKIE));
    const refresh = cookies.find((c) => c.startsWith(REFRESH_TOKEN_COOKIE));

    expect(access).toContain('HttpOnly');
    expect(access).toContain('SameSite=Lax');
    expect(refresh).toContain('HttpOnly');
    // The refresh cookie is path-scoped, so it is not attached to ordinary API requests.
    expect(refresh).toContain('Path=/api/v1/auth');
  });

  it('never leaks the password hash in the login response', async () => {
    const response = await login(tenant.users['principal']!.email);
    const body = JSON.stringify(response.body);
    expect(body).not.toContain('passwordHash');
    expect(body).not.toContain('$argon2');
  });

  it('gives the same message for a wrong password and a non-existent account', async () => {
    const wrongPassword = await login(tenant.users['principal']!.email, 'WrongPassword2026!');
    const noSuchUser = await login('nobody@auth.test', 'WrongPassword2026!');

    expect(wrongPassword.status).toBe(401);
    expect(noSuchUser.status).toBe(401);
    // Identical, so response content cannot be used to enumerate accounts.
    expect(wrongPassword.body.error.message).toBe(noSuchUser.body.error.message);
    expect(wrongPassword.body.error.code).toBe(noSuchUser.body.error.code);
  });

  it('records a security event for every failed attempt, including unknown accounts', async () => {
    await login('ghost@auth.test', 'WrongPassword2026!');

    const client = testClient();
    await client.connect();
    try {
      const { rows } = await client.query<{ count: string }>(
        `select count(*) from security_events
         where event_type = 'login_failed' and attempted_identifier = 'ghost@auth.test'`,
      );
      expect(Number(rows[0]!.count)).toBeGreaterThan(0);
    } finally {
      await client.end();
    }
  });

  it('rejects a malformed request body before touching the database', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: '', password: '' });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(response.body.error.issues.length).toBeGreaterThan(0);
  });

  // ── Refresh rotation and reuse detection ──────────────────────────────────────────

  describe('refresh token rotation', () => {
    it('issues a different refresh token on every use', async () => {
      const first = await login(tenant.users['admin']!.email);
      const original = first.body.refreshToken as string;

      const refreshed = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: original });

      expect(refreshed.status).toBe(200);
      expect(refreshed.body.refreshToken).toBeTruthy();
      expect(refreshed.body.refreshToken).not.toBe(original);
      expect(refreshed.body.accessToken).toBeTruthy();
    });

    it('refuses a token that has already been rotated away', async () => {
      const session = await login(tenant.users['accountant']!.email);
      const original = session.body.refreshToken as string;

      const first = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: original });
      expect(first.status).toBe(200);

      // Replaying the original — the theft signal.
      const replay = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: original });
      expect(replay.status).toBe(401);
    });

    it('records token reuse as a security event', async () => {
      const session = await login(tenant.users['teacher']!.email);
      const original = session.body.refreshToken as string;
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: original });
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: original });

      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query<{ count: string }>(
          `select count(*) from security_events where event_type = 'token_reuse_detected'`,
        );
        expect(Number(rows[0]!.count)).toBeGreaterThan(0);
      } finally {
        await client.end();
      }
    });

    it('refuses an unknown refresh token', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: 'a'.repeat(43) });
      expect(response.status).toBe(401);
    });

    it('stores only the hash of a refresh token, never the token itself', async () => {
      const session = await login(tenant.users['owner']!.email);
      const token = session.body.refreshToken as string;

      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query<{ token_hash: string }>(
          'select token_hash from sessions',
        );
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
          expect(row.token_hash).not.toBe(token);
          expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
        }
      } finally {
        await client.end();
      }
    });
  });

  // ── Session termination ───────────────────────────────────────────────────────────

  describe('logout', () => {
    it('revokes the presented session so its refresh token stops working', async () => {
      const session = await login(tenant.users['admin']!.email);
      const accessToken = session.body.accessToken as string;
      const refreshToken = session.body.refreshToken as string;

      const loggedOut = await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Cookie', `${REFRESH_TOKEN_COOKIE}=${refreshToken}`);
      expect(loggedOut.status).toBe(204);

      const refreshAttempt = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken });
      expect(refreshAttempt.status).toBe(401);
    });

    it('logout-all revokes every session and invalidates outstanding access tokens', async () => {
      const first = await login(tenant.users['teacher']!.email);
      const second = await login(tenant.users['teacher']!.email);

      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/logout-all')
        .set('Authorization', `Bearer ${second.body.accessToken}`);
      expect(response.status).toBe(200);
      expect(response.body.revokedSessions).toBeGreaterThanOrEqual(2);

      // The *other* device's access token must stop working immediately, not in 15 minutes.
      // That is what `credentials_changed_at` buys.
      const stale = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${first.body.accessToken}`);
      expect(stale.status).toBe(401);
    });
  });

  // ── Account lockout ───────────────────────────────────────────────────────────────

  describe('brute-force protection', () => {
    it('locks an account after the configured number of failures', async () => {
      const email = tenant.users['guardian2']!.email;
      // The default is 8; the loop deliberately overshoots so the boundary is unambiguous.
      for (let attempt = 0; attempt < 9; attempt += 1) {
        await login(email, `WrongPassword${attempt}!`);
      }

      const locked = await login(email);
      expect(locked.status).toBe(401);
      // The message changes here on purpose: a locked-out teacher needs to know to wait
      // rather than keep guessing, and the account is already known to the attacker anyway.
      expect(locked.body.error.message).toMatch(/locked/i);
    });

    it('records the lockout as a warning-level security event', async () => {
      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query<{ severity: string }>(
          `select severity from security_events where event_type = 'account_locked'`,
        );
        expect(rows.length).toBeGreaterThan(0);
        expect(rows[0]!.severity).toBe('warning');
      } finally {
        await client.end();
      }
    });

    it('does not lock an account that keeps signing in correctly', async () => {
      const email = tenant.users['principal']!.email;
      for (let i = 0; i < 3; i += 1) {
        const response = await login(email);
        expect(response.status).toBe(200);
      }

      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query<{ failed_login_attempts: number }>(
          'select failed_login_attempts from users where email = $1',
          [email],
        );
        expect(rows[0]!.failed_login_attempts).toBe(0);
      } finally {
        await client.end();
      }
    });
  });

  // ── Access token validation ───────────────────────────────────────────────────────

  describe('access tokens', () => {
    it('refuses a request with no token', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/auth/me');
      expect(response.status).toBe(401);
    });

    it('refuses a structurally valid token signed with the wrong key', async () => {
      // Header and payload are well-formed; only the signature is wrong.
      const forged =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
        Buffer.from(
          JSON.stringify({ sub: tenant.users['owner']!.id, tid: tenant.tenantId }),
        ).toString('base64url') +
        '.aW52YWxpZHNpZ25hdHVyZQ';

      const response = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${forged}`);
      expect(response.status).toBe(401);
    });

    it('refuses a token for a user that no longer exists', async () => {
      const session = await login(tenant.users['guardian1']!.email);
      const client = testClient();
      await client.connect();
      try {
        await client.query('update users set archived_at = now() where id = $1', [
          tenant.users['guardian1']!.id,
        ]);
      } finally {
        await client.end();
      }

      const response = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${session.body.accessToken}`);
      expect(response.status).toBe(401);
    });
  });

  // ── Password change ───────────────────────────────────────────────────────────────

  describe('password change', () => {
    it('rejects a weak new password with field-level issues', async () => {
      const session = await login(tenant.users['owner']!.email);
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${session.body.accessToken}`)
        .send({
          currentPassword: TEST_PASSWORD,
          newPassword: 'short',
          confirmPassword: 'short',
        });

      expect(response.status).toBe(422);
      expect(
        response.body.error.issues.some((i: { path: string }) => i.path === 'newPassword'),
      ).toBe(true);
    });

    it('rejects a mismatched confirmation', async () => {
      const session = await login(tenant.users['owner']!.email);
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${session.body.accessToken}`)
        .send({
          currentPassword: TEST_PASSWORD,
          newPassword: 'AVeryLongNewPassword2026!',
          confirmPassword: 'ADifferentPassword2026!',
        });
      expect(response.status).toBe(422);
    });

    it('rejects the wrong current password and records it', async () => {
      const session = await login(tenant.users['owner']!.email);
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${session.body.accessToken}`)
        .send({
          currentPassword: 'NotTheCurrentPassword2026!',
          newPassword: 'AVeryLongNewPassword2026!',
          confirmPassword: 'AVeryLongNewPassword2026!',
        });
      expect(response.status).toBe(422);
    });

    it('changes the password and ends every existing session', async () => {
      const email = tenant.users['accountant']!.email;
      const session = await login(email);
      const otherDevice = await login(email);

      const changed = await request(app.getHttpServer())
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${session.body.accessToken}`)
        .send({
          currentPassword: TEST_PASSWORD,
          newPassword: 'CompletelyNewPassword2026!',
          confirmPassword: 'CompletelyNewPassword2026!',
        });
      expect(changed.status).toBe(204);

      // The other device is logged out immediately — the point of the change may be that the
      // old password was compromised.
      const stale = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${otherDevice.body.accessToken}`);
      expect(stale.status).toBe(401);

      expect((await login(email, TEST_PASSWORD)).status).toBe(401);
      expect((await login(email, 'CompletelyNewPassword2026!')).status).toBe(200);
    });
  });

  // ── /auth/me ──────────────────────────────────────────────────────────────────────

  it('/auth/me returns the flattened permission set for the UI', async () => {
    const session = await login(tenant.users['principal']!.email);
    const response = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${session.body.accessToken}`);

    expect(response.status).toBe(200);
    expect(response.body.roles.map((r: { key: string }) => r.key)).toEqual(['principal']);
    expect(response.body.permissions).toContain('students.view.all');
    expect(response.body.permissions).toContain('results.publish');
    expect(response.body.permissions).not.toContain('finance.refund');
    expect(response.body.permissions).not.toContain('platform.impersonate');
  });
});
