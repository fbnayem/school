/**
 * Auth lifecycle suite: invitations, guardian portal invitations, password reset, TOTP MFA.
 *
 * These flows are the ones where a regression is not a bug but a breach: a reusable
 * invitation token is a persistent credential, a distinguishable password-reset response is
 * an account-enumeration oracle, and a replayable TOTP code is not a second factor. Every
 * test here asserts the *invariant*, not just a status code.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  createTestApp,
  seedTenant,
  testClient,
  truncateAll,
  TEST_PASSWORD,
  type SeededTenant,
} from '../helpers/test-app';
import { NotificationService } from '../../src/modules/notifications/notification.service';
import { hotp, totpStep } from '../../src/modules/auth/totp';
import { resetEnvCache } from '../../src/config/env';

const NEW_PASSWORD = 'BrandNewSecret2026!';

function tokenFromUrl(url: string): string {
  return new URL(url).searchParams.get('token')!;
}

describe('Auth lifecycle: invitations, password reset, MFA', () => {
  let app: INestApplication;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
  let notifications: NotificationService;

  const api = () => request(app.getHttpServer());

  async function login(identifier: string, password = TEST_PASSWORD) {
    return api().post('/api/v1/auth/login').send({ identifier, password });
  }

  async function loginToken(identifier: string, password = TEST_PASSWORD): Promise<string> {
    const response = await login(identifier, password);
    expect(
      response.status,
      `login failed for ${identifier}: ${JSON.stringify(response.body)}`,
    ).toBe(200);
    return response.body.accessToken as string;
  }

  /** Delivery is fire-and-forget on some paths, so the outbox is polled, not read once. */
  async function waitForNotification(
    predicate: (entry: { to: string; template: string; data: Record<string, unknown> }) => boolean,
    timeoutMs = 3000,
  ) {
    const startedAt = Date.now();
    for (;;) {
      // Newest match, not oldest: requesting a second reset or invitation revokes the first,
      // so a test that acts twice for one recipient must redeem the token it just caused.
      const match = notifications.recent().findLast(predicate);
      if (match) return match;
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error('expected notification never arrived in the outbox');
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function sqlRows<T extends Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const client = testClient();
    await client.connect();
    try {
      const result = await client.query(text, params);
      return result.rows as T[];
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    app = await createTestApp();
    await truncateAll();
    tenantA = await seedTenant('alpha', { students: 3 });
    tenantB = await seedTenant('bravo', { students: 2 });
    notifications = app.get(NotificationService);
  });

  afterAll(async () => {
    await app?.close();
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  // User invitations
  // ────────────────────────────────────────────────────────────────────────────────────

  describe('user invitations', () => {
    it('accepting an invitation sets the password and activates the account in one step', async () => {
      const ownerToken = await loginToken(tenantA.users['owner']!.email);

      const invite = await api()
        .post('/api/v1/auth/invitations')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          email: 'newteacher@alpha.test',
          fullNameEn: 'Nadia Rahman',
          roleIds: [tenantA.roleIds['teacher']],
        });
      expect(invite.status, JSON.stringify(invite.body)).toBe(201);
      expect(invite.body.invitationUrl).toContain('token=');

      // The raw token is never persisted: only a 64-hex SHA-256 hash reaches the database.
      const raw = tokenFromUrl(invite.body.invitationUrl);
      const stored = await sqlRows<{ token_hash: string }>(
        `select token_hash from auth_tokens where id = $1`,
        [invite.body.id],
      );
      expect(stored[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored[0]!.token_hash).not.toContain(raw);

      const accept = await api().post('/api/v1/auth/invitations/accept').send({
        token: raw,
        password: NEW_PASSWORD,
        confirmPassword: NEW_PASSWORD,
        fullNameEn: 'Nadia Rahman',
      });
      expect(accept.status, JSON.stringify(accept.body)).toBe(200);

      // The account is live, the password works, and the invited role is attached.
      const token = await loginToken('newteacher@alpha.test', NEW_PASSWORD);
      const me = await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
      expect(me.status).toBe(200);
      expect(me.body.user.tenantId).toBe(tenantA.tenantId);
      expect(me.body.roles.map((r: { key: string }) => r.key)).toContain('teacher');

      const [userRow] = await sqlRows<{ status: string; password_hash: string | null }>(
        `select status, password_hash from users where email = 'newteacher@alpha.test'`,
      );
      expect(userRow!.status).toBe('active');
      expect(userRow!.password_hash).toMatch(/^\$argon2/);

      // The acceptance is on the security event log.
      const events = await sqlRows<{ count: string }>(
        `select count(*) from security_events where event_type = 'invitation_accepted'`,
      );
      expect(Number(events[0]!.count)).toBeGreaterThan(0);
    });

    it('rejects an expired invitation token', async () => {
      const ownerToken = await loginToken(tenantA.users['owner']!.email);
      const invite = await api()
        .post('/api/v1/auth/invitations')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          email: 'expired@alpha.test',
          fullNameEn: 'Expired Invitee',
          roleIds: [tenantA.roleIds['teacher']],
        });
      expect(invite.status).toBe(201);

      await sqlRows(
        `update auth_tokens set expires_at = now() - interval '1 hour', created_at = now() - interval '2 hours' where id = $1`,
        [invite.body.id],
      );

      const accept = await api()
        .post('/api/v1/auth/invitations/accept')
        .send({
          token: tokenFromUrl(invite.body.invitationUrl),
          password: NEW_PASSWORD,
          confirmPassword: NEW_PASSWORD,
          fullNameEn: 'Expired Invitee',
        });
      expect(accept.status).toBe(404);
      // No account came into being.
      const rows = await sqlRows(`select 1 from users where email = 'expired@alpha.test'`);
      expect(rows.length).toBe(0);
    });

    it('rejects a reused invitation token with the same generic 404', async () => {
      const ownerToken = await loginToken(tenantA.users['owner']!.email);
      const invite = await api()
        .post('/api/v1/auth/invitations')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          email: 'onceonly@alpha.test',
          fullNameEn: 'Once Only',
          roleIds: [tenantA.roleIds['teacher']],
        });
      const raw = tokenFromUrl(invite.body.invitationUrl);
      const body = {
        token: raw,
        password: NEW_PASSWORD,
        confirmPassword: NEW_PASSWORD,
        fullNameEn: 'Once Only',
      };

      const first = await api().post('/api/v1/auth/invitations/accept').send(body);
      expect(first.status).toBe(200);

      const replay = await api().post('/api/v1/auth/invitations/accept').send(body);
      expect(replay.status).toBe(404);
    });

    it('re-inviting the same person invalidates the previous token', async () => {
      const ownerToken = await loginToken(tenantA.users['owner']!.email);
      const send = () =>
        api()
          .post('/api/v1/auth/invitations')
          .set('Authorization', `Bearer ${ownerToken}`)
          .send({
            email: 'reinvited@alpha.test',
            fullNameEn: 'Re Invited',
            roleIds: [tenantA.roleIds['teacher']],
          });

      const first = await send();
      const second = await send();
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);

      const oldAccept = await api()
        .post('/api/v1/auth/invitations/accept')
        .send({
          token: tokenFromUrl(first.body.invitationUrl),
          password: NEW_PASSWORD,
          confirmPassword: NEW_PASSWORD,
          fullNameEn: 'Re Invited',
        });
      expect(oldAccept.status).toBe(404);

      const newAccept = await api()
        .post('/api/v1/auth/invitations/accept')
        .send({
          token: tokenFromUrl(second.body.invitationUrl),
          password: NEW_PASSWORD,
          confirmPassword: NEW_PASSWORD,
          fullNameEn: 'Re Invited',
        });
      expect(newAccept.status).toBe(200);
    });

    it('refuses an invitation that would grant permissions the inviter does not hold', async () => {
      // The administrator holds `users.invite` but nothing like the owner's `*` grant, so
      // inviting a school_owner is privilege escalation by proxy.
      const adminToken = await loginToken(tenantA.users['admin']!.email);
      const invite = await api()
        .post('/api/v1/auth/invitations')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          email: 'shadowowner@alpha.test',
          fullNameEn: 'Shadow Owner',
          roleIds: [tenantA.roleIds['school_owner']],
        });
      expect(invite.status).toBe(403);
      expect(invite.body.error.code).toBe('FORBIDDEN');

      // Refused before anything durable exists: no token row, and a denial on the log.
      const tokens = await sqlRows(
        `select 1 from auth_tokens where email = 'shadowowner@alpha.test'`,
      );
      expect(tokens.length).toBe(0);
      const denials = await sqlRows<{ count: string }>(
        `select count(*) from security_events
         where event_type = 'permission_denied'
           and detail->>'reason' = 'invitation_privilege_escalation'`,
      );
      expect(Number(denials[0]!.count)).toBeGreaterThan(0);
    });

    it('denies invitation creation to a role without users.invite', async () => {
      const teacherToken = await loginToken(tenantA.users['teacher']!.email);
      const response = await api()
        .post('/api/v1/auth/invitations')
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({
          email: 'whoever@alpha.test',
          fullNameEn: 'Who Ever',
          roleIds: [tenantA.roleIds['teacher']],
        });
      expect(response.status).toBe(403);
    });

    it("tenant B cannot revoke tenant A's invitation — 404, not 403", async () => {
      const ownerA = await loginToken(tenantA.users['owner']!.email);
      const invite = await api()
        .post('/api/v1/auth/invitations')
        .set('Authorization', `Bearer ${ownerA}`)
        .send({
          email: 'crosstenant@alpha.test',
          fullNameEn: 'Cross Tenant',
          roleIds: [tenantA.roleIds['teacher']],
        });
      expect(invite.status).toBe(201);

      const ownerB = await loginToken(tenantB.users['owner']!.email);
      const revoke = await api()
        .post(`/api/v1/auth/invitations/${invite.body.id}/revoke`)
        .set('Authorization', `Bearer ${ownerB}`)
        .send({ reason: 'attempting a cross-tenant revocation' });
      // 404 rather than 403: confirming the invitation exists elsewhere is itself a leak.
      expect(revoke.status).toBe(404);
    });

    it('cannot invite a role belonging to another tenant', async () => {
      const ownerA = await loginToken(tenantA.users['owner']!.email);
      const invite = await api()
        .post('/api/v1/auth/invitations')
        .set('Authorization', `Bearer ${ownerA}`)
        .send({
          email: 'borrowedrole@alpha.test',
          fullNameEn: 'Borrowed Role',
          roleIds: [tenantB.roleIds['teacher']],
        });
      // RLS hides the foreign role, so it simply "does not exist".
      expect(invite.status).toBe(404);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  // Guardian portal invitations — the Phase 4 gap
  // ────────────────────────────────────────────────────────────────────────────────────

  describe('guardian portal invitations', () => {
    let guardianId: string;
    const guardianPhone = '01399999999';

    it('invites a linked guardian, binds the account to the guardian record, and grants only the guardian role', async () => {
      const ownerToken = await loginToken(tenantA.users['owner']!.email);

      // A fresh guardian with no user account, linked to exactly one student.
      const created = await api()
        .post('/api/v1/guardians')
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('x-institution-id', tenantA.institutionId)
        .send({ fullNameEn: 'Portal Guardian', phone: guardianPhone });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      guardianId = created.body.id as string;

      const linked = await api()
        .post(`/api/v1/guardians/students/${tenantA.studentIds[0]}/link`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('x-institution-id', tenantA.institutionId)
        .send({ guardianId, relation: 'uncle' });
      expect(linked.status, JSON.stringify(linked.body)).toBe(201);

      const invite = await api()
        .post(`/api/v1/guardians/${guardianId}/invite`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ locale: 'en' });
      expect(invite.status, JSON.stringify(invite.body)).toBe(201);
      // No email on the record: delivery falls back to SMS, whose result must carry the
      // encoding so a Bangla template can never silently triple the bill.
      expect(invite.body.deliveredVia).toBe('sms');

      const accept = await api()
        .post('/api/v1/auth/invitations/accept')
        .send({
          token: tokenFromUrl(invite.body.invitationUrl),
          password: NEW_PASSWORD,
          confirmPassword: NEW_PASSWORD,
          fullNameEn: 'Portal Guardian',
        });
      expect(accept.status, JSON.stringify(accept.body)).toBe(200);

      // The user row is bound to the guardian record and carries only the guardian role.
      const [row] = await sqlRows<{ user_id: string | null }>(
        `select user_id from guardians where id = $1`,
        [guardianId],
      );
      expect(row!.user_id).toBeTruthy();
      const roleRows = await sqlRows<{ key: string }>(
        `select r.key from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = $1`,
        [row!.user_id],
      );
      expect(roleRows.map((r) => r.key)).toEqual(['guardian']);

      // Logging in by phone works, and my-children shows exactly the linked child.
      const guardianToken = await loginToken(guardianPhone, NEW_PASSWORD);
      const children = await api()
        .get('/api/v1/guardians/my-children')
        .set('Authorization', `Bearer ${guardianToken}`);
      expect(children.status).toBe(200);
      const childIds = JSON.stringify(children.body);
      expect(childIds).toContain(tenantA.studentIds[0]!);
      expect(childIds).not.toContain(tenantA.studentIds[1]!);
    });

    it('cannot be used to reach a student the guardian is not linked to', async () => {
      const guardianToken = await loginToken(guardianPhone, NEW_PASSWORD);

      // Same tenant, unlinked student: 404, not 403 — existence is not confirmed.
      const sameTenant = await api()
        .get(`/api/v1/students/${tenantA.studentIds[1]}`)
        .set('Authorization', `Bearer ${guardianToken}`);
      expect(sameTenant.status).toBe(404);

      // Another tenant's student: identical 404.
      const otherTenant = await api()
        .get(`/api/v1/students/${tenantB.studentIds[0]}`)
        .set('Authorization', `Bearer ${guardianToken}`);
      expect(otherTenant.status).toBe(404);

      // The linked child stays visible — the scope filter is the same code path.
      const linkedChild = await api()
        .get(`/api/v1/students/${tenantA.studentIds[0]}`)
        .set('Authorization', `Bearer ${guardianToken}`);
      expect(linkedChild.status).toBe(200);
    });

    it('refuses to invite a guardian with no live portal-enabled student link', async () => {
      const ownerToken = await loginToken(tenantA.users['owner']!.email);
      const created = await api()
        .post('/api/v1/guardians')
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('x-institution-id', tenantA.institutionId)
        .send({ fullNameEn: 'Unlinked Guardian', phone: '01388888888' });
      expect(created.status).toBe(201);

      const invite = await api()
        .post(`/api/v1/guardians/${created.body.id}/invite`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({});
      expect(invite.status).toBe(409);
    });

    it("tenant B cannot invite tenant A's guardian — 404, not 403", async () => {
      const ownerB = await loginToken(tenantB.users['owner']!.email);
      const response = await api()
        .post(`/api/v1/guardians/${guardianId}/invite`)
        .set('Authorization', `Bearer ${ownerB}`)
        .send({});
      expect(response.status).toBe(404);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  // Password reset
  // ────────────────────────────────────────────────────────────────────────────────────

  describe('password reset', () => {
    it('returns a byte-identical response for a known and an unknown account', async () => {
      const known = await api()
        .post('/api/v1/auth/forgot-password')
        .send({ identifier: tenantA.users['accountant']!.email });
      const unknown = await api()
        .post('/api/v1/auth/forgot-password')
        .send({ identifier: 'no-such-account@nowhere.test' });

      expect(known.status).toBe(200);
      expect(unknown.status).toBe(200);
      expect(known.body).toEqual(unknown.body);

      // Both requests are on the security event log, including the one with no account.
      const events = await sqlRows<{ outcome: string }>(
        `select detail->>'outcome' as outcome from security_events
         where event_type = 'password_reset_requested'`,
      );
      const outcomes = events.map((event) => event.outcome);
      expect(outcomes).toContain('token_issued');
      expect(outcomes).toContain('no_account');
    });

    it('completes a reset, revokes every session, and burns the token', async () => {
      const email = tenantA.users['principal']!.email;
      const oldAccessToken = await loginToken(email);

      await api().post('/api/v1/auth/forgot-password').send({ identifier: email });
      const message = await waitForNotification(
        (entry) => entry.template === 'password_reset' && entry.to === email,
      );
      const raw = tokenFromUrl(String(message.data['actionUrl']));

      // The raw reset token exists in the delivered message only — the database has a hash.
      const hashes = await sqlRows<{ token_hash: string }>(
        `select token_hash from auth_tokens where purpose = 'password_reset'`,
      );
      for (const row of hashes) {
        expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(row.token_hash).not.toBe(raw);
      }

      const reset = await api().post('/api/v1/auth/reset-password').send({
        token: raw,
        newPassword: NEW_PASSWORD,
        confirmPassword: NEW_PASSWORD,
      });
      expect(reset.status, JSON.stringify(reset.body)).toBe(204);

      // The pre-reset access token dies immediately — credentials-version revocation.
      const stale = await api()
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${oldAccessToken}`);
      expect(stale.status).toBe(401);

      // Refresh-token sessions are revoked in the database, not merely forgotten.
      const sessions = await sqlRows<{ count: string }>(
        `select count(*) from sessions s join users u on u.id = s.user_id
         where u.email = $1 and s.revoked_at is null`,
        [email],
      );
      expect(Number(sessions[0]!.count)).toBe(0);

      // Old password dead, new password live.
      expect((await login(email, TEST_PASSWORD)).status).toBe(401);
      expect((await login(email, NEW_PASSWORD)).status).toBe(200);
    });

    it('rejects a reset token the second time it is presented', async () => {
      const email = tenantA.users['accountant']!.email;
      await api().post('/api/v1/auth/forgot-password').send({ identifier: email });
      const message = await waitForNotification(
        (entry) => entry.template === 'password_reset' && entry.to === email,
      );
      const raw = tokenFromUrl(String(message.data['actionUrl']));
      const body = { token: raw, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD };

      expect((await api().post('/api/v1/auth/reset-password').send(body)).status).toBe(204);
      expect((await api().post('/api/v1/auth/reset-password').send(body)).status).toBe(404);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  // MFA (TOTP)
  // ────────────────────────────────────────────────────────────────────────────────────

  describe('mfa', () => {
    // The accountant's password was changed by the reset suite above.
    const mfaUser = () => tenantA.users['accountant']!.email;
    let secret: string;
    let recoveryCodes: string[];

    it('enrols, requires a verified code to enable, and returns recovery codes exactly once', async () => {
      const token = await loginToken(mfaUser(), NEW_PASSWORD);

      const enroll = await api()
        .post('/api/v1/auth/mfa/enroll')
        .set('Authorization', `Bearer ${token}`);
      expect(enroll.status, JSON.stringify(enroll.body)).toBe(200);
      expect(enroll.body.secret).toMatch(/^[A-Z2-7]+$/);
      expect(enroll.body.otpauthUri).toContain('otpauth://totp/');
      secret = enroll.body.secret as string;

      // Not enabled until a code proves the authenticator holds the secret.
      const wrong = await api()
        .post('/api/v1/auth/mfa/enable')
        .set('Authorization', `Bearer ${token}`)
        .send({ code: '000000' });
      expect([400, 422]).toContain(wrong.status);

      const enable = await api()
        .post('/api/v1/auth/mfa/enable')
        .set('Authorization', `Bearer ${token}`)
        .send({ code: hotp(secret, totpStep()) });
      expect(enable.status, JSON.stringify(enable.body)).toBe(200);
      recoveryCodes = enable.body.recoveryCodes as string[];
      expect(recoveryCodes).toHaveLength(10);

      // Only hashes are stored; the plain codes and the secret never round-trip again.
      const [row] = await sqlRows<{ mfa_enabled: boolean; codes: string[] }>(
        `select mfa_enabled, mfa_recovery_codes as codes from users where email = $1`,
        [mfaUser()],
      );
      expect(row!.mfa_enabled).toBe(true);
      for (const code of recoveryCodes) {
        expect(JSON.stringify(row!.codes)).not.toContain(code.replace('-', ''));
      }
    });

    it('login becomes a two-step flow that never returns a session on step one', async () => {
      const step1 = await login(mfaUser(), NEW_PASSWORD);
      expect(step1.status).toBe(200);
      expect(step1.body.mfaRequired).toBe(true);
      expect(step1.body.challengeToken).toBeTruthy();
      expect(step1.body.accessToken).toBeUndefined();
      expect(step1.body.refreshToken).toBeUndefined();

      // A fresh code one step ahead of the enable code satisfies monotonic verification.
      const verify = await api()
        .post('/api/v1/auth/mfa/verify')
        .send({
          challengeToken: step1.body.challengeToken,
          code: hotp(secret, totpStep() + 1),
        });
      expect(verify.status, JSON.stringify(verify.body)).toBe(200);
      expect(verify.body.accessToken).toBeTruthy();

      const me = await api()
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${verify.body.accessToken}`);
      expect(me.status).toBe(200);
    });

    it('rejects a replayed TOTP code', async () => {
      // The step used by the previous test is now the high-water mark; replaying any code
      // at or below it must fail even though the HMAC still matches.
      const replayedCode = hotp(secret, totpStep() + 1);

      // Depending on the previous test's timing the first presentation may itself already
      // be a replay; either way the *second* presentation of one code must always fail.
      const stepA = await login(mfaUser(), NEW_PASSWORD);
      await api().post('/api/v1/auth/mfa/verify').send({
        challengeToken: stepA.body.challengeToken,
        code: replayedCode,
      });

      const stepB = await login(mfaUser(), NEW_PASSWORD);
      const second = await api().post('/api/v1/auth/mfa/verify').send({
        challengeToken: stepB.body.challengeToken,
        code: replayedCode,
      });
      expect(second.status).toBe(401);
      expect(JSON.stringify(second.body)).not.toContain('accessToken');
    });

    it('accepts a recovery code once and only once', async () => {
      const code = recoveryCodes[0]!;

      const stepA = await login(mfaUser(), NEW_PASSWORD);
      const first = await api().post('/api/v1/auth/mfa/verify').send({
        challengeToken: stepA.body.challengeToken,
        code,
      });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body.accessToken).toBeTruthy();

      const stepB = await login(mfaUser(), NEW_PASSWORD);
      const second = await api().post('/api/v1/auth/mfa/verify').send({
        challengeToken: stepB.body.challengeToken,
        code,
      });
      expect(second.status).toBe(401);
    });

    it('revokes a challenge after repeated wrong codes', async () => {
      const step1 = await login(mfaUser(), NEW_PASSWORD);
      const challengeToken = step1.body.challengeToken as string;

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const wrong = await api()
          .post('/api/v1/auth/mfa/verify')
          .send({ challengeToken, code: 'ZZZZ-ZZZZ' });
        expect(wrong.status).toBe(401);
      }

      // Even a valid recovery code is refused now: the challenge itself is dead.
      const afterLockout = await api()
        .post('/api/v1/auth/mfa/verify')
        .send({ challengeToken, code: recoveryCodes[1]! });
      expect(afterLockout.status).toBe(401);
    });

    it('cannot be disabled without the current password', async () => {
      const step1 = await login(mfaUser(), NEW_PASSWORD);
      const verify = await api().post('/api/v1/auth/mfa/verify').send({
        challengeToken: step1.body.challengeToken,
        code: recoveryCodes[2]!,
      });
      expect(verify.status).toBe(200);
      const token = verify.body.accessToken as string;

      const noPassword = await api()
        .post('/api/v1/auth/mfa/disable')
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(noPassword.status).toBe(422);

      const wrongPassword = await api()
        .post('/api/v1/auth/mfa/disable')
        .set('Authorization', `Bearer ${token}`)
        .send({ password: 'DefinitelyWrong2026!' });
      expect(wrongPassword.status).toBe(422);

      const [still] = await sqlRows<{ mfa_enabled: boolean }>(
        `select mfa_enabled from users where email = $1`,
        [mfaUser()],
      );
      expect(still!.mfa_enabled).toBe(true);

      const disabled = await api()
        .post('/api/v1/auth/mfa/disable')
        .set('Authorization', `Bearer ${token}`)
        .send({ password: NEW_PASSWORD });
      expect(disabled.status).toBe(204);

      // The secret is gone and login is single-step again.
      const [cleared] = await sqlRows<{ mfa_enabled: boolean; mfa_secret: string | null }>(
        `select mfa_enabled, mfa_secret from users where email = $1`,
        [mfaUser()],
      );
      expect(cleared!.mfa_enabled).toBe(false);
      expect(cleared!.mfa_secret).toBeNull();

      const plain = await login(mfaUser(), NEW_PASSWORD);
      expect(plain.status).toBe(200);
      expect(plain.body.accessToken).toBeTruthy();
      expect(plain.body.mfaRequired).toBeUndefined();
    });

    it('never returns the TOTP secret after enrolment completes', async () => {
      const token = await loginToken(mfaUser(), NEW_PASSWORD);
      const me = await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
      const body = JSON.stringify(me.body);
      expect(body).not.toContain('mfaSecret');
      expect(body).not.toContain(secret);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  // Rate limiting — last, because it deliberately trips the throttler
  // ────────────────────────────────────────────────────────────────────────────────────

  describe('rate limiting', () => {
    it('applies the strict credential-endpoint limit to forgot-password', async () => {
      process.env.AUTH_RATE_LIMIT_MAX_ATTEMPTS = '3';
      resetEnvCache();
      try {
        const statuses: number[] = [];
        for (let i = 0; i < 6; i += 1) {
          const response = await api()
            .post('/api/v1/auth/forgot-password')
            .send({ identifier: 'rate-limit-probe@alpha.test' });
          statuses.push(response.status);
        }
        expect(statuses).toContain(429);
      } finally {
        process.env.AUTH_RATE_LIMIT_MAX_ATTEMPTS = '100000';
        resetEnvCache();
      }
    });
  });
});
