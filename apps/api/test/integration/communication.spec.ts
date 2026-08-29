/**
 * Communication centre integration suite (Phase 14).
 *
 * This file exists to hold the communication invariants, not to prove the routes return
 * 200. Each describe block corresponds to a rule that, if it broke in production, would
 * either leak a family's data, let one person blast every guardian's phone alone, or
 * silently triple a school's SMS bill:
 *
 *  - a mass campaign above the recipient threshold cannot be self-approved, even by an
 *    actor holding every permission — and the database restates the rule as a check
 *    constraint (`notification_campaigns_approver_distinct`),
 *  - recipients are resolved at send time through the CALLER's data scope: the same
 *    campaign previews to different counts for different callers,
 *  - a guardian may never broadcast, and may only open a thread with staff connected to
 *    their own children — an unconnected staff id gets the same 404 a nonexistent user
 *    gets,
 *  - the messages table refuses UPDATE and DELETE at the database level (the
 *    `messages_no_mutation` trigger from migration 0022), for every role, in direct SQL
 *    that bypasses the service entirely,
 *  - Bangla SMS is UCS-2 (70 characters a part, 67 concatenated), Latin is GSM 7-bit
 *    (160/153) — the part arithmetic that decides the bill,
 *  - a redelivered delivery report keyed on `provider_message_id` is a recorded no-op,
 *    and the partial unique index makes that key a real key,
 *  - and none of it crosses a tenant boundary.
 *
 * Everything runs over HTTP through the real guards, interceptors and database, because
 * the properties under test live precisely in the parts a stub would replace.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Client } from 'pg';
import { uuidv7 } from '@shikkha/shared';
import {
  DELIVERY_SIGNATURE_HEADER,
  signDeliveryWebhook,
} from '../../src/modules/communication/communication.service';
import {
  createTestApp,
  seedTenant,
  testClient,
  truncateAll,
  TEST_APP_DATABASE_URL,
  TEST_PASSWORD,
  type SeededTenant,
} from '../helpers/test-app';

describe('Communication centre', () => {
  let app: INestApplication;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
  const tokens: Record<string, string> = {};

  // Ids captured as the suite builds up real conversations and campaigns.
  let threadId: string;
  let firstMessageId: string;
  let smsTemplateId: string;
  let inAppTemplateId: string;
  let campaignId: string; // the above-threshold guardians campaign
  let campaignVersion: number;
  let providerMessageId: string;

  async function login(email: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: email, password: TEST_PASSWORD });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body.accessToken as string;
  }

  const get = (role: string, path: string, query: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .get(path)
      .query(query)
      .set('Authorization', `Bearer ${tokens[role]}`)
      .set('x-institution-id', tenantA.institutionId);

  const post = (role: string, path: string, body: object = {}) =>
    request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${tokens[role]}`)
      .set('x-institution-id', tenantA.institutionId)
      .send(body);

  /**
   * Deliver one delivery report the way a provider would: raw JSON on the wire, HMAC
   * signature in the header. `signature: 'auto'` signs the exact bytes being sent with the
   * same secret the service verifies with; `null` omits the header; any other string is
   * sent verbatim (a forgery).
   */
  const webhook = (
    payload: Record<string, unknown>,
    signature: string | 'auto' | null = 'auto',
  ) => {
    const raw = JSON.stringify(payload);
    let req = request(app.getHttpServer())
      .post('/api/v1/communication/deliveries/webhook')
      .set('content-type', 'application/json');
    if (signature !== null) {
      req = req.set(
        DELIVERY_SIGNATURE_HEADER,
        signature === 'auto' ? signDeliveryWebhook(raw) : signature,
      );
    }
    return req.send(raw);
  };

  /**
   * A second section ('B') with two students and two portal-enabled guardians the seeded
   * teacher does NOT teach. The teacher's `assigned` data scope therefore covers section A
   * only, so the same campaign must preview to different counts for the teacher and for a
   * caller with `students.view.all` — the scope-resolution property under test.
   */
  async function seedSecondSection(tenant: SeededTenant): Promise<void> {
    const client = testClient();
    await client.connect();
    try {
      await client.query('begin');

      const sectionBId = uuidv7();
      await client.query(
        `insert into sections (id, tenant_id, institution_id, campus_id, academic_year_id, class_level_id, name_en, capacity)
         values ($1,$2,$3,$4,$5,$6,'B',60)`,
        [
          sectionBId,
          tenant.tenantId,
          tenant.institutionId,
          tenant.campusId,
          tenant.academicYearId,
          tenant.classLevelId,
        ],
      );

      const { rows: hashRows } = await client.query<{ password_hash: string }>(
        `select password_hash from users where id = $1`,
        [tenant.users['guardian1']!.id],
      );
      const passwordHash = hashRows[0]!.password_hash;

      for (let i = 1; i <= 2; i += 1) {
        const studentId = uuidv7();
        await client.query(
          `insert into students (id, tenant_id, institution_id, student_code, admission_number, admission_date, full_name_en, date_of_birth, gender, status)
           values ($1,$2,$3,$4,$5,'2026-01-05',$6,'2014-06-15','female','active')`,
          [
            studentId,
            tenant.tenantId,
            tenant.institutionId,
            `comma-BS${i}`,
            `comma-BA${i}`,
            `comma Section-B Student ${i}`,
          ],
        );
        await client.query(
          `insert into enrollments (id, tenant_id, institution_id, campus_id, student_id, academic_year_id, class_level_id, section_id, roll_number, status, enrolled_on)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active','2026-01-05')`,
          [
            uuidv7(),
            tenant.tenantId,
            tenant.institutionId,
            tenant.campusId,
            studentId,
            tenant.academicYearId,
            tenant.classLevelId,
            sectionBId,
            String(i),
          ],
        );

        const guardianUserId = uuidv7();
        await client.query(
          `insert into users (id, tenant_id, email, password_hash, full_name_en, status, email_verified_at)
           values ($1,$2,$3,$4,$5,'active',now())`,
          [
            guardianUserId,
            tenant.tenantId,
            `bguardian${i}@comma.test`,
            passwordHash,
            `comma Section-B Guardian ${i}`,
          ],
        );
        await client.query(
          `insert into user_roles (id, tenant_id, user_id, role_id, institution_id)
           values ($1,$2,$3,$4,$5)`,
          [uuidv7(), tenant.tenantId, guardianUserId, tenant.roleIds['guardian'], tenant.institutionId],
        );
        const guardianId = uuidv7();
        await client.query(
          `insert into guardians (id, tenant_id, institution_id, user_id, full_name_en, phone)
           values ($1,$2,$3,$4,$5,$6)`,
          [
            guardianId,
            tenant.tenantId,
            tenant.institutionId,
            guardianUserId,
            `comma Section-B Guardian ${i}`,
            `+880199000000${i}`,
          ],
        );
        await client.query(
          `insert into student_guardians (id, tenant_id, institution_id, student_id, guardian_id, relation, is_primary, is_billing_contact, can_access_portal)
           values ($1,$2,$3,$4,$5,'mother',true,true,true)`,
          [uuidv7(), tenant.tenantId, tenant.institutionId, studentId, guardianId],
        );
      }

      // Grant the teacher `communication.send.bulk` through an extra role, so the suite has
      // a bulk sender whose STUDENT scope is still `assigned` — the seeded teacher role only
      // holds `students.view.assigned`. The principal is loaded fresh on every request, so
      // no re-login is needed.
      const bulkRoleId = uuidv7();
      await client.query(
        `insert into roles (id, tenant_id, key, name_en, permissions, audience, is_system, is_sensitive)
         values ($1,$2,'comm_bulk_sender','Bulk Sender','["communication.send.bulk"]'::jsonb,'staff',false,false)`,
        [bulkRoleId, tenant.tenantId],
      );
      await client.query(
        `insert into user_roles (id, tenant_id, user_id, role_id, institution_id)
         values ($1,$2,$3,$4,$5)`,
        [uuidv7(), tenant.tenantId, tenant.users['teacher']!.id, bulkRoleId, tenant.institutionId],
      );

      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    // The approval threshold is read at call time from the environment, so the suite can
    // exercise the two-person rule with 7 guardians instead of 51.
    process.env['COMMUNICATION_APPROVAL_THRESHOLD'] = '3';

    app = await createTestApp();
    await truncateAll();
    tenantA = await seedTenant('comma', { students: 5 });
    tenantB = await seedTenant('commb', { students: 2 });
    await seedSecondSection(tenantA);

    for (const key of ['owner', 'principal', 'accountant', 'teacher', 'guardian1']) {
      tokens[key] = await login(tenantA.users[key]!.email);
    }
    tokens['otherPrincipal'] = await login(tenantB.users['principal']!.email);
  }, 120_000);

  afterAll(async () => {
    delete process.env['COMMUNICATION_APPROVAL_THRESHOLD'];
    await app?.close();
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // SMS part arithmetic — the property the bill rests on
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('SMS part counting', () => {
    it('counts a Latin body in GSM 7-bit: 160 characters is one part, 161 is two', async () => {
      const single = await post('teacher', '/api/v1/communication/templates/preview', {
        bodyEn: 'A'.repeat(160),
      });
      expect(single.status, JSON.stringify(single.body)).toBe(201);
      expect(single.body.en.encoding).toBe('gsm7');
      expect(single.body.en.singlePartLimit).toBe(160);
      expect(single.body.en.concatenatedPartLimit).toBe(153);
      expect(single.body.en.parts).toBe(1);

      const double = await post('teacher', '/api/v1/communication/templates/preview', {
        bodyEn: 'A'.repeat(161),
      });
      expect(double.status).toBe(201);
      expect(double.body.en.parts, 'a 161-character GSM body concatenates at 153 a part').toBe(2);
    });

    it('counts a Bangla body in UCS-2: 70 characters is one part, 71 is two — not 160', async () => {
      const response = await post('teacher', '/api/v1/communication/templates/preview', {
        bodyEn: 'placeholder',
        bodyBn: 'আ'.repeat(70),
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.bn.encoding).toBe('ucs2');
      expect(response.body.bn.singlePartLimit, 'Bangla is billed at 70 a part, never 160').toBe(70);
      expect(response.body.bn.concatenatedPartLimit).toBe(67);
      expect(response.body.bn.parts).toBe(1);

      const over = await post('teacher', '/api/v1/communication/templates/preview', {
        bodyEn: 'placeholder',
        bodyBn: 'আ'.repeat(71),
      });
      expect(over.status).toBe(201);
      // 71 UTF-16 units concatenate at 67 a part: two billable parts. A counter using the
      // Latin limits would still claim one — the silent bill-tripling bug.
      expect(over.body.bn.parts).toBe(2);
    });

    it('re-classifies a Latin template as UCS-2 when a substituted variable is Bangla', async () => {
      const response = await post('teacher', '/api/v1/communication/templates/preview', {
        bodyEn: 'Hello {{name}}, your fees are due.',
        variables: { name: 'রাফি' },
      });
      expect(response.status).toBe(201);
      expect(
        response.body.en.encoding,
        'one Bangla character anywhere forces the whole message to UCS-2',
      ).toBe('ucs2');
      expect(response.body.en.singlePartLimit).toBe(70);
    });

    it('exposes the per-encoding part counts on an SMS template read', async () => {
      const created = await post('owner', '/api/v1/communication/templates', {
        key: 'exam-alert',
        name: 'Exam alert',
        channel: 'sms',
        bodyEn: 'Exam on Sunday at 10am. Bring the admit card.',
        bodyBn: 'পরীক্ষা রবিবার সকাল ১০টায়। প্রবেশপত্র আনুন।',
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      smsTemplateId = created.body.id;
      expect(created.body.smsParts.en.encoding).toBe('gsm7');
      expect(created.body.smsParts.en.parts).toBe(1);
      expect(created.body.smsParts.bn.encoding).toBe('ucs2');
      expect(created.body.smsParts.bn.parts).toBe(1);

      const fetched = await get('owner', `/api/v1/communication/templates/${smsTemplateId}`);
      expect(fetched.status).toBe(200);
      expect(fetched.body.smsParts.bn.encoding).toBe('ucs2');
    });

    it('reports no part counts for a non-SMS template', async () => {
      const created = await post('owner', '/api/v1/communication/templates', {
        key: 'office-note',
        name: 'Office note',
        channel: 'in_app',
        bodyEn: 'Please visit the school office.',
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      inAppTemplateId = created.body.id;
      expect(created.body.smsParts).toBeNull();
    });

    it('refuses template creation to a role without the manage permission', async () => {
      const response = await post('accountant', '/api/v1/communication/templates', {
        key: 'sneaky',
        name: 'Sneaky template',
        channel: 'sms',
        bodyEn: 'Should never be created',
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
      // Naming the missing permission would be free reconnaissance.
      expect(JSON.stringify(response.body)).not.toContain('communication.templates.manage');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Person-to-person messaging — who may reach whom is decided in SQL, not by the client
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('message threads and reach', () => {
    it('lets staff with the send permission open a direct thread', async () => {
      const response = await post('teacher', '/api/v1/communication/threads', {
        subject: 'About homework',
        kind: 'direct',
        participantUserIds: [tenantA.users['guardian1']!.id],
        body: 'Your child has been doing very well this term.',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.kind).toBe('direct');
      threadId = response.body.id;
      firstMessageId = response.body.firstMessage.id;
      expect(firstMessageId).toBeTruthy();
    });

    it('lets the guardian participant read and reply', async () => {
      const reply = await post('guardian1', `/api/v1/communication/threads/${threadId}/messages`, {
        body: 'Thank you for letting me know.',
      });
      expect(reply.status, JSON.stringify(reply.body)).toBe(201);
      expect(reply.body.senderUserId).toBe(tenantA.users['guardian1']!.id);
    });

    it('hides the thread from a non-participant with a 404, not a 403', async () => {
      const response = await get('accountant', `/api/v1/communication/threads/${threadId}`);
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('lets a guardian open a thread with the teacher of their own child', async () => {
      const response = await post('guardian1', '/api/v1/communication/threads', {
        subject: 'Absence tomorrow',
        kind: 'direct',
        participantUserIds: [tenantA.users['teacher']!.id],
        body: 'My son will be absent tomorrow for a doctor visit.',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
    });

    it('refuses a guardian a thread with staff not connected to their children — as a 404', async () => {
      // The accountant is a real, active staff user of the same institution, but teaches no
      // section any of guardian1's children are enrolled in. Reachability must look exactly
      // like nonexistence — confirming the id is valid is itself a leak.
      const response = await post('guardian1', '/api/v1/communication/threads', {
        subject: 'Fee question',
        kind: 'direct',
        participantUserIds: [tenantA.users['accountant']!.id],
        body: 'I would like to ask about the February invoice.',
      });
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('never lets a guardian broadcast, whatever the payload claims', async () => {
      const response = await post('guardian1', '/api/v1/communication/threads', {
        subject: 'To all teachers',
        kind: 'broadcast',
        participantUserIds: [tenantA.users['teacher']!.id, tenantA.users['principal']!.id],
        body: 'A guardian must never be able to broadcast.',
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('lets staff with the send permission broadcast', async () => {
      const response = await post('teacher', '/api/v1/communication/threads', {
        subject: 'Parent-teacher meeting',
        kind: 'broadcast',
        participantUserIds: [tenantA.users['guardian1']!.id, tenantA.users['guardian2']!.id],
        body: 'The parent-teacher meeting is on Thursday at 4pm.',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.kind).toBe('broadcast');
    });

    it('retracts by appending a system message and leaves the original exactly as sent', async () => {
      const retraction = await post(
        'teacher',
        `/api/v1/communication/messages/${firstMessageId}/retract`,
        { reason: 'Sent to the wrong guardian by mistake' },
      );
      expect(retraction.status, JSON.stringify(retraction.body)).toBe(201);
      expect(retraction.body.isSystem).toBe(true);
      expect(retraction.body.id).not.toBe(firstMessageId);

      const thread = await get('teacher', `/api/v1/communication/threads/${threadId}`);
      expect(thread.status).toBe(200);
      const original = thread.body.messages.find(
        (one: { id: string }) => one.id === firstMessageId,
      );
      expect(original, 'the original message disappeared').toBeTruthy();
      expect(original.body, 'a retraction rewrote the original').toBe(
        'Your child has been doing very well this term.',
      );
      expect(
        thread.body.messages.filter((one: { isSystem: boolean }) => one.isSystem),
      ).toHaveLength(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Messages are append-only AT THE DATABASE — direct SQL, bypassing the service
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('messages append-only enforcement', () => {
    it('refuses UPDATE even to the table owner running hand-written SQL', async () => {
      const client = testClient(); // connects as the migrator, which owns the tables
      await client.connect();
      try {
        await expect(
          client.query(`update messages set body = 'tampered' where id = $1`, [firstMessageId]),
        ).rejects.toThrow(/append-only/i);
      } finally {
        await client.end();
      }
    });

    it('refuses DELETE even to the table owner', async () => {
      const client = testClient();
      await client.connect();
      try {
        await expect(
          client.query(`delete from messages where id = $1`, [firstMessageId]),
        ).rejects.toThrow(/append-only/i);
      } finally {
        await client.end();
      }
    });

    it('denies the application role UPDATE and DELETE at the privilege level besides', async () => {
      // Connects as `shikkha_app` — the same unprivileged role the API uses — so this is
      // what an attacker with SQL execution inside the application could actually do.
      const client = new Client({ connectionString: TEST_APP_DATABASE_URL });
      await client.connect();
      try {
        await client.query('begin');
        await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantA.tenantId]);
        await expect(
          client.query(`update messages set body = 'tampered' where id = $1`, [firstMessageId]),
        ).rejects.toThrow(/permission denied|append-only/i);
        await client.query('rollback').catch(() => undefined);

        await client.query('begin');
        await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantA.tenantId]);
        await expect(
          client.query(`delete from messages where id = $1`, [firstMessageId]),
        ).rejects.toThrow(/permission denied|append-only/i);
      } finally {
        await client.query('rollback').catch(() => undefined);
        await client.end();
      }
    });

    it('the append-only trigger from migration 0022 is installed under its recorded name', async () => {
      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query(
          `select tg.tgname
             from pg_trigger tg
             join pg_class c on c.oid = tg.tgrelid
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relname = 'messages'
              and tg.tgname = 'messages_no_mutation'`,
        );
        expect(rows, 'messages_no_mutation is missing').toHaveLength(1);
      } finally {
        await client.end();
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Campaigns — scope-resolved recipients and the two-person rule
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('notification campaigns', () => {
    it('creates a draft campaign carrying only the audience definition', async () => {
      const response = await post('owner', '/api/v1/communication/campaigns', {
        templateId: smsTemplateId,
        audience: { audience: 'guardians' },
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('draft');
      expect(response.body.channel).toBe('sms');
      expect(response.body.totalRecipients, 'no recipients are resolved at create time').toBe(0);
      campaignId = response.body.id;
      campaignVersion = response.body.version as number;
    });

    it('resolves recipients through the caller’s own data scope', async () => {
      // The owner holds students.view.all: every portal guardian of the institution — five
      // in section A, two in section B.
      const asOwner = await post(
        'owner',
        `/api/v1/communication/campaigns/${campaignId}/preview-recipients`,
      );
      expect(asOwner.status, JSON.stringify(asOwner.body)).toBe(201);
      expect(asOwner.body.totalRecipients).toBe(7);
      expect(asOwner.body.approvalThreshold).toBe(3);
      expect(asOwner.body.requiresApproval).toBe(true);

      // The teacher (granted communication.send.bulk, but only students.view.assigned)
      // resolves the SAME campaign to the guardians of section A only.
      const asTeacher = await post(
        'teacher',
        `/api/v1/communication/campaigns/${campaignId}/preview-recipients`,
      );
      expect(asTeacher.status, JSON.stringify(asTeacher.body)).toBe(201);
      expect(
        asTeacher.body.totalRecipients,
        'the same audience definition must resolve through the caller’s scope, not globally',
      ).toBe(5);
    });

    it('previews user ids only — never an address or a phone number', async () => {
      const response = await post(
        'owner',
        `/api/v1/communication/campaigns/${campaignId}/preview-recipients`,
      );
      expect(response.status).toBe(201);
      expect(response.body.sampleUserIds.length).toBeGreaterThan(0);
      for (const id of response.body.sampleUserIds) {
        expect(id).toMatch(/^[0-9a-f-]{36}$/i);
      }
      expect(JSON.stringify(response.body), 'the preview leaked a phone number').not.toContain(
        '+880',
      );
    });

    it('refuses to send an unapproved campaign above the threshold', async () => {
      const submitted = await post(
        'owner',
        `/api/v1/communication/campaigns/${campaignId}/submit`,
        { version: campaignVersion },
      );
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
      expect(submitted.body.status).toBe('queued');
      campaignVersion = submitted.body.version as number;

      const sent = await post('owner', `/api/v1/communication/campaigns/${campaignId}/send`, {
        version: campaignVersion,
      });
      expect(sent.status).toBe(403);
      expect(sent.body.error.code).toBe('FORBIDDEN');

      // The refusal changed nothing: still queued, nothing delivered.
      const after = await get('owner', `/api/v1/communication/campaigns/${campaignId}`);
      expect(after.body.status).toBe('queued');
      expect(after.body.sentCount).toBe(0);
    });

    it('refuses a self-approval even to the owner holding every permission', async () => {
      const response = await post(
        'owner',
        `/api/v1/communication/campaigns/${campaignId}/approve`,
        { reason: 'Approving the campaign I requested myself', version: campaignVersion },
      );
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
      expect(response.body.error.message).toMatch(/different person/i);
    });

    it('the database restates the two-person rule as a check constraint', async () => {
      // Hand-written SQL as the table owner — bypassing every service check — still cannot
      // make the requester their own approver.
      const client = testClient();
      await client.connect();
      try {
        await expect(
          client.query(
            `update notification_campaigns
                set approved_by = requested_by, approved_at = now()
              where id = $1`,
            [campaignId],
          ),
        ).rejects.toThrow(/notification_campaigns_approver_distinct/i);
      } finally {
        await client.end();
      }
    });

    it('accepts an approval from a different person, recording it exactly once', async () => {
      const response = await post(
        'principal',
        `/api/v1/communication/campaigns/${campaignId}/approve`,
        { reason: 'Reviewed the audience and the message body', version: campaignVersion },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.approvedBy).toBe(tenantA.users['principal']!.id);
      expect(response.body.approvedAt).toBeTruthy();
      campaignVersion = response.body.version as number;

      // The service records the approval inside its own transaction and the route is marked
      // `recordedBy: 'service'` — exactly ONE audit row, not a duplicate pair.
      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query<{ count: string }>(
          `select count(*) as count from audit_logs
            where tenant_id = $1 and module = 'communication'
              and resource_type = 'notification_campaign' and action = 'approve'
              and resource_id = $2`,
          [tenantA.tenantId, campaignId],
        );
        expect(Number(rows[0]!.count), 'the approval must produce exactly one audit row').toBe(1);
      } finally {
        await client.end();
      }
    });

    it('sends the approved campaign, recording counts and the SMS part arithmetic', async () => {
      const response = await post('owner', `/api/v1/communication/campaigns/${campaignId}/send`, {
        version: campaignVersion,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.totalRecipients).toBe(7);
      expect(response.body.sentCount).toBe(7);
      expect(response.body.failedCount).toBe(0);
      expect(response.body.smsParts).toBe(1);
      expect(response.body.campaign.status).toBe('sent');
      expect(response.body.campaign.sentAt).toBeTruthy();

      const client = testClient();
      await client.connect();
      try {
        // One audit row, written by the service inside the sending transaction; a count and
        // the part arithmetic — never an address. Ordered by occurred_at: audit_logs has no
        // created_at column.
        const { rows } = await client.query<{ new_value: Record<string, unknown> }>(
          `select new_value from audit_logs
            where tenant_id = $1 and module = 'communication'
              and resource_type = 'notification_campaign' and action = 'publish'
              and resource_id = $2
            order by occurred_at desc`,
          [tenantA.tenantId, campaignId],
        );
        expect(rows, 'the send must produce exactly one audit row').toHaveLength(1);
        const value = rows[0]!.new_value;
        expect(value['totalRecipients']).toBe(7);
        expect(value['smsEncoding']).toBe('gsm7');
        expect(value['smsPartsPerMessage']).toBe(1);
        expect(JSON.stringify(value), 'the audit trail leaked a phone number').not.toContain(
          '+880',
        );
      } finally {
        await client.end();
      }
    });

    it('lets a below-threshold campaign be sent by its requester alone', async () => {
      const created = await post('owner', '/api/v1/communication/campaigns', {
        templateId: inAppTemplateId,
        audience: { audience: 'role', refId: tenantA.roleIds['accountant'] },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);

      const submitted = await post(
        'owner',
        `/api/v1/communication/campaigns/${created.body.id}/submit`,
        { version: created.body.version },
      );
      expect(submitted.status).toBe(201);

      // One accountant holds that role: 1 recipient, below the threshold of 3 — no second
      // person required.
      const sent = await post('owner', `/api/v1/communication/campaigns/${created.body.id}/send`, {
        version: submitted.body.version,
      });
      expect(sent.status, JSON.stringify(sent.body)).toBe(201);
      expect(sent.body.totalRecipients).toBe(1);
      expect(sent.body.sentCount).toBe(1);
      expect(sent.body.campaign.approvedBy).toBeNull();
    });

    it('refuses campaign creation to a guardian', async () => {
      const response = await post('guardian1', '/api/v1/communication/campaigns', {
        templateId: smsTemplateId,
        audience: { audience: 'guardians' },
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('refuses the delivery report list to a role without the view permission', async () => {
      const response = await get('accountant', '/api/v1/communication/deliveries');
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Delivery reports — signed, idempotent on provider_message_id
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('delivery reports', () => {
    it('recorded one delivery per resolved recipient, each keyed for the provider', async () => {
      const response = await get('owner', '/api/v1/communication/deliveries', {
        campaignId,
        pageSize: 100,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.meta.total).toBe(7);
      for (const delivery of response.body.data) {
        expect(delivery.status).toBe('sent');
        expect(delivery.providerMessageId).toMatch(/^console-/);
      }
      providerMessageId = response.body.data[0].providerMessageId;
    });

    it('applies a signed delivered report exactly once', async () => {
      const first = await webhook({ providerMessageId, status: 'delivered' });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body).toEqual({ received: true, result: 'updated', duplicate: false });

      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query<{ status: string; delivered_at: Date }>(
          `select status, delivered_at from notification_deliveries where provider_message_id = $1`,
          [providerMessageId],
        );
        expect(rows[0]!.status).toBe('delivered');
        expect(rows[0]!.delivered_at).toBeTruthy();
      } finally {
        await client.end();
      }
    });

    it('treats the redelivered report as a recorded no-op — never a second effect', async () => {
      const client = testClient();
      await client.connect();
      try {
        const before = await client.query<{ delivered_at: Date; updated_at: Date }>(
          `select delivered_at, updated_at from notification_deliveries where provider_message_id = $1`,
          [providerMessageId],
        );

        const duplicate = await webhook({ providerMessageId, status: 'delivered' });
        expect(duplicate.status).toBe(200);
        expect(duplicate.body).toEqual({ received: true, result: 'no_op', duplicate: true });

        const after = await client.query<{ delivered_at: Date; updated_at: Date }>(
          `select delivered_at, updated_at from notification_deliveries where provider_message_id = $1`,
          [providerMessageId],
        );
        expect(after.rows[0]!.delivered_at.getTime(), 'a duplicate report rewrote the row').toBe(
          before.rows[0]!.delivered_at.getTime(),
        );
        expect(after.rows[0]!.updated_at.getTime()).toBe(before.rows[0]!.updated_at.getTime());
      } finally {
        await client.end();
      }
    });

    it('ignores a report that would move the status backwards', async () => {
      const response = await webhook({ providerMessageId, status: 'sent' });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ received: true, result: 'no_op', duplicate: true });
    });

    it('acknowledges an unknown provider message id without inventing a row', async () => {
      const response = await webhook({ providerMessageId: 'console-never-issued', status: 'delivered' });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ received: true, result: 'unknown_message', duplicate: false });
    });

    it('refuses a forged signature and a missing one', async () => {
      const forged = await webhook({ providerMessageId, status: 'failed' }, 'deadbeef');
      expect(forged.status).toBe(422);
      expect(forged.body.error.code).toBe('VALIDATION_FAILED');

      const unsigned = await webhook({ providerMessageId, status: 'failed' }, null);
      expect(unsigned.status).toBe(422);

      // Neither attempt touched the row.
      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query<{ status: string }>(
          `select status from notification_deliveries where provider_message_id = $1`,
          [providerMessageId],
        );
        expect(rows[0]!.status).toBe('delivered');
      } finally {
        await client.end();
      }
    });

    it('the partial unique index makes provider_message_id a real key', async () => {
      const client = testClient();
      await client.connect();
      try {
        await expect(
          client.query(
            `insert into notification_deliveries
               (tenant_id, institution_id, recipient_address, channel, template_key, status, provider_message_id)
             values ($1,$2,'+8801700000000','sms','exam-alert','sent',$3)`,
            [tenantA.tenantId, tenantA.institutionId, providerMessageId],
          ),
        ).rejects.toThrow(/notification_deliveries_provider_message_key|duplicate key/i);
      } finally {
        await client.end();
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Tenant isolation
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('tenant isolation', () => {
    it('another tenant cannot read a campaign by its exact id', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/communication/campaigns/${campaignId}`)
        .set('Authorization', `Bearer ${tokens['otherPrincipal']}`)
        .set('x-institution-id', tenantB.institutionId);
      // 404, not 403: confirming the record exists elsewhere is itself a leak.
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('another tenant cannot read a thread by its exact id', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/communication/threads/${threadId}`)
        .set('Authorization', `Bearer ${tokens['otherPrincipal']}`)
        .set('x-institution-id', tenantB.institutionId);
      expect(response.status).toBe(404);
    });

    it('another tenant cannot borrow the institution header', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/communication/campaigns')
        .set('Authorization', `Bearer ${tokens['otherPrincipal']}`)
        .set('x-institution-id', tenantA.institutionId);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('another tenant’s own campaign list is empty rather than leaky', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/communication/campaigns')
        .set('Authorization', `Bearer ${tokens['otherPrincipal']}`)
        .set('x-institution-id', tenantB.institutionId);
      expect(response.status).toBe(200);
      expect(response.body.meta.total).toBe(0);
      expect(response.body.data).toEqual([]);
    });

    it('all nine communication tables carry forced row-level security', async () => {
      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query<{ relname: string }>(
          `select c.relname
             from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public'
              and c.relkind = 'r'
              and c.relname in ('message_templates','announcements','announcement_reads',
                                'message_threads','thread_participants','messages',
                                'message_attachments','notification_campaigns',
                                'notification_deliveries')
              and (not c.relrowsecurity
                   or not c.relforcerowsecurity
                   or not exists (select 1 from pg_policy p
                                   where p.polrelid = c.oid and p.polname = 'tenant_isolation'))`,
        );
        expect(rows.map((row) => row.relname)).toEqual([]);
      } finally {
        await client.end();
      }
    });

    it('the database refuses a template stamped with another tenant’s id', async () => {
      // Connects as `shikkha_app` — the same unprivileged role the API uses.
      const client = new Client({ connectionString: TEST_APP_DATABASE_URL });
      await client.connect();
      try {
        await client.query('begin');
        await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantB.tenantId]);
        await expect(
          client.query(
            `insert into message_templates (tenant_id, institution_id, key, name, channel, body_en)
             values ($1,$2,'smuggled','Smuggled','sms','cross-tenant write')`,
            [tenantA.tenantId, tenantA.institutionId],
          ),
        ).rejects.toThrow(/row-level security/i);
      } finally {
        await client.query('rollback').catch(() => undefined);
        await client.end();
      }
    });
  });
});
