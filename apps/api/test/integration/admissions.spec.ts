/**
 * Admissions over HTTP (Phase 5).
 *
 * The funnel is the one surface where an anonymous member of the public can write into the
 * platform, and the one place where a race can give away a seat twice — so this suite leans
 * on the refusals and the invariants rather than the happy path:
 *
 *  - the public form works unauthenticated, is rate-limited, and leaks no tenant data;
 *  - an invalid status transition is a 409 naming the from and to states, and every
 *    transition leaves an audit record with actor and reason;
 *  - merit ranking is deterministic and ties break by the documented rule;
 *  - seats cannot be oversold under concurrent acceptance (proved with a real race);
 *  - an expired offer cannot be accepted;
 *  - acceptance creates the student, the guardian and the enrolment atomically, and never
 *    duplicates an existing student;
 *  - one tenant cannot see another's funnel, and staff without admission permissions are
 *    refused.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Client } from 'pg';
import { addDays, todayInDhaka } from '@shikkha/shared';
import {
  createTestApp,
  seedTenant,
  testClient,
  truncateAll,
  TEST_APP_DATABASE_URL,
  TEST_PASSWORD,
  type SeededTenant,
} from '../helpers/test-app';
import { resetEnvCache } from '../../src/config/env';

const ADMISSION_TABLES = [
  'admission_sessions',
  'admission_applications',
  'admission_application_documents',
  'admission_tests',
  'admission_test_results',
  'admission_interviews',
  'admission_merit_lists',
  'admission_merit_entries',
  'admission_offers',
];

describe('Admissions', () => {
  let app: INestApplication;
  let tenant: SeededTenant;
  let other: SeededTenant;
  const tokens: Record<string, string> = {};
  let otherToken: string;

  let sessionId: string;
  let session2Id: string;
  let testId: string;

  /** Application ids by applicant key. */
  const apps: Record<string, string> = {};
  /** Offer ids by applicant key. */
  const offers: Record<string, string> = {};

  const today = todayInDhaka();
  const windowStart = addDays(today, -10);
  const windowEnd = addDays(today, 30);

  async function login(email: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: email, password: TEST_PASSWORD });
    expect(response.status, `login failed for ${email}: ${JSON.stringify(response.body)}`).toBe(
      200,
    );
    return response.body.accessToken as string;
  }

  const get = (role: string, path: string) =>
    request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${tokens[role]}`)
      .set('x-institution-id', tenant.institutionId);

  const post = (role: string, path: string, body: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${tokens[role]}`)
      .set('x-institution-id', tenant.institutionId)
      .send(body);

  const patch = (role: string, path: string, body: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .patch(path)
      .set('Authorization', `Bearer ${tokens[role]}`)
      .set('x-institution-id', tenant.institutionId)
      .send(body);

  const put = (role: string, path: string, body: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .put(path)
      .set('Authorization', `Bearer ${tokens[role]}`)
      .set('x-institution-id', tenant.institutionId)
      .send(body);

  function publicPayload(overrides: Record<string, unknown> = {}) {
    return {
      organizationSlug: 'adm-org',
      institutionCode: 'adm-INST',
      classLevelCode: 'C6',
      applicantNameEn: 'Applicant One',
      dateOfBirth: '2015-03-10',
      gender: 'male',
      guardianNameEn: 'Guardian One',
      guardianRelation: 'father',
      guardianPhone: '01712345601',
      ...overrides,
    };
  }

  async function queryDb<T extends Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    const client = testClient();
    await client.connect();
    try {
      const result = await client.query(text, values as never[]);
      return result.rows as T[];
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    app = await createTestApp();
    await truncateAll();
    tenant = await seedTenant('adm');
    other = await seedTenant('advb');

    for (const role of ['principal', 'admin', 'teacher']) {
      tokens[role] = await login(tenant.users[role]!.email);
    }
    otherToken = await login(other.users['principal']!.email);
  });

  afterAll(async () => {
    await app.close();
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  // Sessions
  // ────────────────────────────────────────────────────────────────────────────────────

  describe('sessions', () => {
    it('creates a session in draft', async () => {
      const response = await post('principal', '/api/v1/admissions/sessions', {
        academicYearId: tenant.academicYearId,
        nameEn: 'Admission 2026',
        applicationStartDate: windowStart,
        applicationEndDate: windowEnd,
        applicationFee: '500.00',
        classCapacity: [{ classLevelId: tenant.classLevelId, seats: 2 }],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('draft');
      expect(response.body.applicationFee).toBe('500.00');
      sessionId = response.body.id as string;
    });

    it('refuses an invalid session transition, naming both states', async () => {
      const response = await post('principal', `/api/v1/admissions/sessions/${sessionId}/status`, {
        status: 'completed',
        reason: 'Trying to skip straight to completed',
      });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('WORKFLOW_STATE_INVALID');
      expect(response.body.error.message).toContain('draft');
      expect(response.body.error.message).toContain('completed');
    });

    it('opens the session', async () => {
      const response = await post('principal', `/api/v1/admissions/sessions/${sessionId}/status`, {
        status: 'open',
        reason: 'Application window opens today',
      });
      expect(response.status).toBe(201);
      expect(response.body.status).toBe('open');
    });

    it('refuses session creation to a teacher', async () => {
      const response = await post('teacher', '/api/v1/admissions/sessions', {
        academicYearId: tenant.academicYearId,
        nameEn: 'Rogue Session',
        applicationStartDate: windowStart,
        applicationEndDate: windowEnd,
        classCapacity: [{ classLevelId: tenant.classLevelId, seats: 1 }],
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  // Public submission
  // ────────────────────────────────────────────────────────────────────────────────────

  describe('public submission', () => {
    it('accepts an unauthenticated application and leaks no tenant data', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/admissions/public/applications')
        .send(publicPayload());

      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.applicationNumber).toMatch(/^ADM\d{4}-\d{5}$/);
      expect(response.body.applicantNameEn).toBe('Applicant One');

      // The response must carry no internal identifiers: no tenant id, no institution id,
      // no session id, no application row id.
      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain(tenant.tenantId);
      expect(serialized).not.toContain(tenant.institutionId);
      expect(serialized).not.toContain(sessionId);
      expect(serialized).not.toContain(tenant.academicYearId);

      const [row] = await queryDb<{
        id: string;
        tenant_id: string;
        status: string;
        source: string;
      }>(
        `select id, tenant_id, status, source from admission_applications
          where application_number = $1`,
        [response.body.applicationNumber],
      );
      expect(row).toBeDefined();
      expect(row!.tenant_id).toBe(tenant.tenantId);
      expect(row!.status).toBe('submitted');
      expect(row!.source).toBe('online');
      apps['a1'] = row!.id;
    });

    it('writes an audit record for the anonymous submission', async () => {
      const rows = await queryDb<{ actor_user_id: string | null }>(
        `select actor_user_id from audit_logs
          where module = 'admissions' and resource_type = 'admission_application'
            and action = 'create' and resource_id = $1`,
        [apps['a1']],
      );
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0]!.actor_user_id).toBeNull();
    });

    it('accepts the remaining applicants', async () => {
      const specs = [
        ['a2', 'Applicant Two', '2015-04-11', '01712345602'],
        ['a3', 'Applicant Three', '2015-05-12', '01712345603'],
        ['a4', 'Applicant Four', '2015-06-13', '01712345604'],
      ] as const;
      for (const [key, name, dob, phone] of specs) {
        const response = await request(app.getHttpServer())
          .post('/api/v1/admissions/public/applications')
          .send(
            publicPayload({
              applicantNameEn: name,
              dateOfBirth: dob,
              guardianNameEn: `Guardian ${name.split(' ')[1]}`,
              guardianPhone: phone,
            }),
          );
        expect(response.status, JSON.stringify(response.body)).toBe(201);
        const [row] = await queryDb<{ id: string }>(
          `select id from admission_applications where application_number = $1`,
          [response.body.applicationNumber],
        );
        apps[key] = row!.id;
      }
    });

    it('refuses a duplicate application for the same child in the same cycle', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/admissions/public/applications')
        .send(publicPayload());
      expect(response.status).toBe(409);
    });

    it('gives an unknown school the same 404 as a closed one', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/admissions/public/applications')
        .send(publicPayload({ organizationSlug: 'no-such-school', applicantNameEn: 'Nobody' }));
      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain(tenant.tenantId);
    });

    it('validates the payload with Zod', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/admissions/public/applications')
        .send(publicPayload({ guardianPhone: 'not-a-phone', applicantNameEn: 'Bad Phone Kid' }));
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  // Status transitions
  // ────────────────────────────────────────────────────────────────────────────────────

  describe('status transitions', () => {
    it('refuses an invalid transition with a 409 naming the from and to states', async () => {
      const response = await post(
        'principal',
        `/api/v1/admissions/applications/${apps['a4']}/status`,
        { status: 'tested', reason: 'Trying to skip the whole review pipeline' },
      );
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('WORKFLOW_STATE_INVALID');
      expect(response.body.error.message).toContain('submitted');
      expect(response.body.error.message).toContain('tested');
    });

    it('refuses a transition without a reason', async () => {
      const response = await post(
        'principal',
        `/api/v1/admissions/applications/${apps['a4']}/status`,
        { status: 'shortlisted' },
      );
      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body.error.issues ?? [])).toContain('reason');
    });

    it('refuses a transition to staff without admission permissions', async () => {
      const response = await post('admin', `/api/v1/admissions/applications/${apps['a4']}/status`, {
        status: 'shortlisted',
        reason: 'Administrator has no admissions authority',
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('shortlists all four applicants and audits each move with actor and reason', async () => {
      for (const key of ['a1', 'a2', 'a3', 'a4']) {
        const response = await post(
          'principal',
          `/api/v1/admissions/applications/${apps[key]}/status`,
          { status: 'shortlisted', reason: 'Meets the shortlisting criteria for Class 6' },
        );
        expect(response.status, JSON.stringify(response.body)).toBe(201);
        expect(response.body.status).toBe('shortlisted');
      }

      const rows = await queryDb<{ actor_user_id: string | null; reason: string | null }>(
        `select actor_user_id, reason from audit_logs
          where module = 'admissions' and resource_type = 'admission_application'
            and action = 'update' and resource_id = $1`,
        [apps['a1']],
      );
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0]!.actor_user_id).toBe(tenant.users['principal']!.id);
      expect(rows[0]!.reason).toContain('shortlisting criteria');
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  // Tests, results, interviews, documents
  // ────────────────────────────────────────────────────────────────────────────────────

  describe('tests and interviews', () => {
    it('creates an admission test', async () => {
      const response = await post('principal', `/api/v1/admissions/sessions/${sessionId}/tests`, {
        nameEn: 'Written Test',
        testDate: today,
        totalMarks: '100.00',
        passMarks: '40.00',
        venue: 'Main Hall',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      testId = response.body.id as string;
    });

    it('refuses marks above the test total', async () => {
      const response = await put('principal', `/api/v1/admissions/tests/${testId}/results`, {
        results: [{ applicationId: apps['a1'], marksObtained: '150.00' }],
      });
      expect(response.status).toBe(422);
    });

    it('refuses an absent candidate with marks', async () => {
      const response = await put('principal', `/api/v1/admissions/tests/${testId}/results`, {
        results: [{ applicationId: apps['a4'], marksObtained: '10.00', isAbsent: true }],
      });
      expect(response.status).toBe(422);
    });

    it('enters the results', async () => {
      const response = await put('principal', `/api/v1/admissions/tests/${testId}/results`, {
        results: [
          { applicationId: apps['a1'], marksObtained: '90.00' },
          { applicationId: apps['a2'], marksObtained: '80.00' },
          { applicationId: apps['a3'], marksObtained: '80.00' },
          { applicationId: apps['a4'], isAbsent: true },
        ],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.saved).toBe(4);
    });

    it('schedules and scores an interview', async () => {
      const scheduled = await post(
        'principal',
        `/api/v1/admissions/applications/${apps['a1']}/interview`,
        { scheduledAt: new Date().toISOString(), panelName: 'Panel A' },
      );
      expect(scheduled.status, JSON.stringify(scheduled.body)).toBe(201);

      const scored = await post(
        'principal',
        `/api/v1/admissions/interviews/${scheduled.body.id}/score`,
        { score: '95.00', remarks: 'Confident and well prepared', version: 1 },
      );
      expect(scored.status, JSON.stringify(scored.body)).toBe(201);
      expect(scored.body.score).toBe('95.00');
    });

    it('attaches and verifies a document', async () => {
      const added = await post(
        'principal',
        `/api/v1/admissions/applications/${apps['a1']}/documents`,
        {
          storageKey: 'tenants/adm/admissions/birth-cert-a1.pdf',
          documentType: 'birth_certificate',
          title: 'Birth Certificate',
        },
      );
      expect(added.status, JSON.stringify(added.body)).toBe(201);

      const verified = await post(
        'principal',
        `/api/v1/admissions/documents/${added.body.id}/verify`,
      );
      expect(verified.status).toBe(201);
      expect(verified.body.verifiedAt).toBeTruthy();

      const again = await post('principal', `/api/v1/admissions/documents/${added.body.id}/verify`);
      expect(again.status).toBe(409);

      // The application detail endpoint returns everything attached to the application.
      const detail = await get('principal', `/api/v1/admissions/applications/${apps['a1']}`);
      expect(detail.status).toBe(200);
      expect(detail.body.documents).toHaveLength(1);
      expect(detail.body.documents[0].verifiedAt).toBeTruthy();
      expect(detail.body.testResults).toHaveLength(1);
      expect(detail.body.interview).toBeTruthy();
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  // Merit lists
  // ────────────────────────────────────────────────────────────────────────────────────

  describe('merit lists', () => {
    const criteria = {
      testWeightBp: 7000,
      interviewWeightBp: 2000,
      previousResultWeightBp: 1000,
      quotaBonuses: {},
    };

    let firstOrder: string[] = [];
    let listId: string;

    it('generates a deterministic ranking and records the criteria', async () => {
      const response = await post(
        'principal',
        `/api/v1/admissions/sessions/${sessionId}/merit-lists`,
        { classLevelId: tenant.classLevelId, name: 'First List', criteria },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      listId = response.body.id as string;

      const entries = response.body.entries as Array<{
        applicationId: string;
        rank: number;
        aggregateScore: string;
        isWaitlisted: boolean;
      }>;
      expect(entries).toHaveLength(4);

      // a1: 90 × 0.7 + 95 × 0.2 = 82.  a2/a3: 80 × 0.7 = 56.  a4 (absent): 0.
      expect(entries[0]!.applicationId).toBe(apps['a1']);
      expect(entries[0]!.aggregateScore).toBe('82.0000');
      expect(entries[0]!.rank).toBe(1);

      // a2 and a3 tie on aggregate AND test percentage; the documented rule breaks the tie
      // by earlier submission, and a2 was submitted first.
      expect(entries[1]!.applicationId).toBe(apps['a2']);
      expect(entries[1]!.aggregateScore).toBe('56.0000');
      expect(entries[2]!.applicationId).toBe(apps['a3']);
      expect(entries[2]!.aggregateScore).toBe('56.0000');

      expect(entries[3]!.applicationId).toBe(apps['a4']);

      // Two seats: ranks 3 and 4 are waitlisted.
      expect(entries.map((entry) => entry.isWaitlisted)).toEqual([false, false, true, true]);

      // The criteria — including the tie-break rule — are recorded on the list itself.
      expect(response.body.criteria.testWeightBp).toBe(7000);
      expect(response.body.criteria.tieBreaker).toEqual([
        'aggregateScore desc',
        'testPercent desc',
        'submittedAt asc',
        'applicationNumber asc',
      ]);

      firstOrder = entries.map((entry) => entry.applicationId);
    });

    it('produces the identical ranking when generated again', async () => {
      const response = await post(
        'principal',
        `/api/v1/admissions/sessions/${sessionId}/merit-lists`,
        { classLevelId: tenant.classLevelId, name: 'Second Run', criteria },
      );
      expect(response.status).toBe(201);
      const order = (response.body.entries as Array<{ applicationId: string }>).map(
        (entry) => entry.applicationId,
      );
      expect(order).toEqual(firstOrder);
    });

    it('publishing is separate from generating, audited, and single-shot', async () => {
      const generatedRows = await queryDb<{ published_at: Date | null }>(
        `select published_at from admission_merit_lists where id = $1`,
        [listId],
      );
      expect(generatedRows[0]!.published_at).toBeNull();

      const published = await post('principal', `/api/v1/admissions/merit-lists/${listId}/publish`);
      expect(published.status).toBe(201);
      expect(published.body.publishedAt).toBeTruthy();

      const again = await post('principal', `/api/v1/admissions/merit-lists/${listId}/publish`);
      expect(again.status).toBe(409);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  // Offers, seats and enrolment
  // ────────────────────────────────────────────────────────────────────────────────────

  describe('offers and enrolment', () => {
    it('selects the top two and offers them the seats', async () => {
      for (const key of ['a1', 'a2']) {
        const selected = await post(
          'principal',
          `/api/v1/admissions/applications/${apps[key]}/status`,
          { status: 'selected', reason: 'Within the seat count on the published merit list' },
        );
        expect(selected.status, JSON.stringify(selected.body)).toBe(201);

        const offered = await post(
          'principal',
          `/api/v1/admissions/applications/${apps[key]}/offers`,
          { expiresInDays: 7, feeDue: '5000.00' },
        );
        expect(offered.status, JSON.stringify(offered.body)).toBe(201);
        expect(offered.body.offer.feeDue).toBe('5000.00');
        offers[key] = offered.body.offer.id as string;
      }
    });

    it('refuses an offer beyond the seat count — the applicant stays waitlisted', async () => {
      const waitlisted = await post(
        'principal',
        `/api/v1/admissions/applications/${apps['a3']}/status`,
        { status: 'waitlisted', reason: 'Beyond the seat count on the merit list' },
      );
      expect(waitlisted.status).toBe(201);

      const response = await post(
        'principal',
        `/api/v1/admissions/applications/${apps['a3']}/offers`,
        { expiresInDays: 7 },
      );
      expect(response.status).toBe(409);
      expect(response.body.error.message).toContain('waitlist');
    });

    it('a declined offer frees the seat for the waitlist', async () => {
      const declined = await post(
        'principal',
        `/api/v1/admissions/offers/${offers['a2']}/decline`,
        {
          reason: 'Family chose another school',
        },
      );
      expect(declined.status, JSON.stringify(declined.body)).toBe(201);
      expect(declined.body.application.status).toBe('declined');

      const response = await post(
        'principal',
        `/api/v1/admissions/applications/${apps['a3']}/offers`,
        { expiresInDays: 7 },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      offers['a3'] = response.body.offer.id as string;
    });

    it('an expired offer cannot be accepted', async () => {
      // Age the offer out: offered eight days ago, lapsed yesterday. offered_at moves with it
      // because admission_offers_expiry_after_offer forbids an offer that expired before it was
      // made. The API refuses to issue an already-expired offer, which is exactly the point.
      await queryDb(
        `update admission_offers set expires_at = now() - interval '1 day', offered_at = now() - interval '8 days' where id = $1`,
        [offers['a3']],
      );

      const response = await post('principal', `/api/v1/admissions/offers/${offers['a3']}/accept`, {
        sectionId: tenant.sectionId,
        rollNumber: '103',
      });
      expect(response.status).toBe(409);
      expect(response.body.error.message).toContain('expired');

      // Nothing moved: the application is still `offered`, the offer still `pending`.
      const [offerRow] = await queryDb<{ status: string }>(
        `select status from admission_offers where id = $1`,
        [offers['a3']],
      );
      expect(offerRow!.status).toBe('pending');
    });

    it('the expire endpoint records the lapse and waitlists the applicant', async () => {
      const response = await post('principal', `/api/v1/admissions/offers/${offers['a3']}/expire`);
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.offer.status).toBe('expired');
      expect(response.body.application.status).toBe('waitlisted');
    });

    it('accepting an offer creates the student, guardian and enrolment atomically', async () => {
      const response = await post('principal', `/api/v1/admissions/offers/${offers['a1']}/accept`, {
        sectionId: tenant.sectionId,
        rollNumber: '101',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.application.status).toBe('enrolled');
      const studentId = response.body.studentId as string;
      const guardianId = response.body.guardianId as string;
      expect(studentId).toBeTruthy();
      expect(guardianId).toBeTruthy();

      // The student exists through the real student service (visible over its API).
      const student = await get('principal', `/api/v1/students/${studentId}`);
      expect(student.status).toBe(200);
      expect(student.body.fullNameEn).toBe('Applicant One');

      // The enrolment is real: section, roll and year all match what was accepted.
      const enrollmentRows = await queryDb<{ section_id: string; roll_number: string }>(
        `select section_id, roll_number from enrollments
          where student_id = $1 and status = 'active'`,
        [studentId],
      );
      expect(enrollmentRows).toHaveLength(1);
      expect(enrollmentRows[0]!.section_id).toBe(tenant.sectionId);
      expect(enrollmentRows[0]!.roll_number).toBe('101');

      // The guardian was created from the application, deduplicated by phone, and linked
      // as the primary, portal-enabled contact.
      const guardianRows = await queryDb<{ phone: string; is_primary: boolean }>(
        `select g.phone, sg.is_primary
           from student_guardians sg join guardians g on g.id = sg.guardian_id
          where sg.student_id = $1 and sg.archived_at is null`,
        [studentId],
      );
      expect(guardianRows).toHaveLength(1);
      expect(guardianRows[0]!.phone).toBe('+8801712345601');
      expect(guardianRows[0]!.is_primary).toBe(true);

      // The application carries the back-reference.
      const [appRow] = await queryDb<{ status: string; student_id: string }>(
        `select status, student_id from admission_applications where id = $1`,
        [apps['a1']],
      );
      expect(appRow!.status).toBe('enrolled');
      expect(appRow!.student_id).toBe(studentId);
    });

    it('does not duplicate a student who already exists, and reverts nothing it did not do', async () => {
      // "adm Student 1" (dob 2014-05-10) is a seeded, already-admitted student.
      const created = await post('principal', '/api/v1/admissions/applications', {
        sessionId,
        classLevelId: tenant.classLevelId,
        applicantNameEn: 'adm Student 1',
        dateOfBirth: '2014-05-10',
        gender: 'male',
        guardianNameEn: 'Duplicate Guardian',
        guardianRelation: 'father',
        guardianPhone: '01712345699',
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body.source).toBe('counter');
      const duplicateAppId = created.body.id as string;

      for (const status of ['shortlisted', 'selected'] as const) {
        const moved = await post(
          'principal',
          `/api/v1/admissions/applications/${duplicateAppId}/status`,
          { status, reason: 'Progressing the duplicate applicant for the test' },
        );
        expect(moved.status, JSON.stringify(moved.body)).toBe(201);
      }
      const offered = await post(
        'principal',
        `/api/v1/admissions/applications/${duplicateAppId}/offers`,
        { expiresInDays: 7 },
      );
      expect(offered.status, JSON.stringify(offered.body)).toBe(201);
      const duplicateOfferId = offered.body.offer.id as string;

      const before = await queryDb<{ total: number }>(
        `select count(*)::int as total from students where full_name_en = 'adm Student 1'`,
      );

      const accepted = await post(
        'principal',
        `/api/v1/admissions/offers/${duplicateOfferId}/accept`,
        { sectionId: tenant.sectionId, rollNumber: '104' },
      );
      expect(accepted.status).toBe(409);

      // Atomic failure: no second student, no guardian, and the acceptance itself was
      // never recorded — the offer is still pending and the application still offered.
      const after = await queryDb<{ total: number }>(
        `select count(*)::int as total from students where full_name_en = 'adm Student 1'`,
      );
      expect(after[0]!.total).toBe(before[0]!.total);

      const guardianRows = await queryDb<{ total: number }>(
        `select count(*)::int as total from guardians where phone = '+8801712345699'`,
      );
      expect(guardianRows[0]!.total).toBe(0);

      const [offerRow] = await queryDb<{ status: string }>(
        `select status from admission_offers where id = $1`,
        [duplicateOfferId],
      );
      expect(offerRow!.status).toBe('pending');
      const [appRow] = await queryDb<{ status: string }>(
        `select status from admission_applications where id = $1`,
        [duplicateAppId],
      );
      expect(appRow!.status).toBe('offered');
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  // Concurrency: seats cannot be oversold
  // ────────────────────────────────────────────────────────────────────────────────────

  describe('seat concurrency', () => {
    const concurrent: Record<string, { appId: string; offerId: string }> = {};

    it('sets up two pending offers contending for one seat', async () => {
      const created = await post('principal', '/api/v1/admissions/sessions', {
        academicYearId: tenant.academicYearId,
        nameEn: 'Concurrency Session',
        applicationStartDate: windowStart,
        applicationEndDate: windowEnd,
        classCapacity: [{ classLevelId: tenant.classLevelId, seats: 2 }],
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      session2Id = created.body.id as string;
      const opened = await post('principal', `/api/v1/admissions/sessions/${session2Id}/status`, {
        status: 'open',
        reason: 'Opening the concurrency test session',
      });
      expect(opened.status).toBe(201);

      const specs = [
        ['x', 'Concurrent X', '2015-07-01', '01712345621'],
        ['y', 'Concurrent Y', '2015-08-02', '01712345622'],
      ] as const;
      for (const [key, name, dob, phone] of specs) {
        const application = await post('principal', '/api/v1/admissions/applications', {
          sessionId: session2Id,
          classLevelId: tenant.classLevelId,
          applicantNameEn: name,
          dateOfBirth: dob,
          gender: 'female',
          guardianNameEn: `${name} Guardian`,
          guardianRelation: 'mother',
          guardianPhone: phone,
        });
        expect(application.status, JSON.stringify(application.body)).toBe(201);

        for (const status of ['shortlisted', 'selected'] as const) {
          const moved = await post(
            'principal',
            `/api/v1/admissions/applications/${application.body.id}/status`,
            { status, reason: 'Progressing for the concurrency test' },
          );
          expect(moved.status).toBe(201);
        }
        const offered = await post(
          'principal',
          `/api/v1/admissions/applications/${application.body.id}/offers`,
          { expiresInDays: 7 },
        );
        expect(offered.status, JSON.stringify(offered.body)).toBe(201);
        concurrent[key] = {
          appId: application.body.id as string,
          offerId: offered.body.offer.id as string,
        };
      }

      // Shrink the capacity to one seat: both offers are now live, but only one acceptance
      // can win. (A capacity cut while offers are out is a real scenario, and the seat gate
      // must hold regardless of how the contention arose.)
      const fresh = await get('principal', `/api/v1/admissions/sessions/${session2Id}`);
      const shrunk = await patch('principal', `/api/v1/admissions/sessions/${session2Id}`, {
        classCapacity: [{ classLevelId: tenant.classLevelId, seats: 1 }],
        version: fresh.body.version,
      });
      expect(shrunk.status, JSON.stringify(shrunk.body)).toBe(200);
    });

    it('two concurrent acceptances cannot oversell the last seat', async () => {
      const [first, second] = await Promise.all([
        post('principal', `/api/v1/admissions/offers/${concurrent['x']!.offerId}/accept`, {
          sectionId: tenant.sectionId,
          rollNumber: '111',
        }),
        post('principal', `/api/v1/admissions/offers/${concurrent['y']!.offerId}/accept`, {
          sectionId: tenant.sectionId,
          rollNumber: '112',
        }),
      ]);

      const statuses = [first!.status, second!.status].sort((a, b) => a - b);
      expect(statuses[0], JSON.stringify([first!.body, second!.body])).toBe(201);
      expect(statuses[1]).toBe(409);

      // Exactly one student was created and exactly one application enrolled.
      const studentRows = await queryDb<{ total: number }>(
        `select count(*)::int as total from students
          where full_name_en in ('Concurrent X', 'Concurrent Y')`,
      );
      expect(studentRows[0]!.total).toBe(1);

      const enrolledRows = await queryDb<{ total: number }>(
        `select count(*)::int as total from admission_applications
          where id in ($1, $2) and status = 'enrolled'`,
        [concurrent['x']!.appId, concurrent['y']!.appId],
      );
      expect(enrolledRows[0]!.total).toBe(1);

      // The loser is untouched: offer still pending, application still offered — free to be
      // waitlisted or accepted later if the seat count rises.
      const loserRows = await queryDb<{ status: string }>(
        `select status from admission_offers
          where id in ($1, $2) and status = 'pending'`,
        [concurrent['x']!.offerId, concurrent['y']!.offerId],
      );
      expect(loserRows).toHaveLength(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  // Funnel report
  // ────────────────────────────────────────────────────────────────────────────────────

  describe('funnel report', () => {
    it('reports the funnel for the session, computed in SQL', async () => {
      const response = await get('principal', `/api/v1/admissions/sessions/${sessionId}/funnel`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);

      // Session one holds a1–a4 plus the duplicate counter application.
      expect(response.body.totalApplications).toBe(5);
      expect(response.body.statusCounts.enrolled).toBe(1);
      expect(response.body.conversion.enrolled).toBe(1);
      expect(response.body.classLevels).toHaveLength(1);
      expect(response.body.classLevels[0].seats).toBe(2);
      expect(response.body.classLevels[0].enrolled).toBe(1);
      expect(response.body.classLevels[0].applications).toBe(5);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  // Tenant isolation
  // ────────────────────────────────────────────────────────────────────────────────────

  describe('tenant isolation', () => {
    const otherGet = (path: string) =>
      request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${otherToken}`)
        .set('x-institution-id', other.institutionId);

    it("tenant B cannot read tenant A's session by id", async () => {
      const response = await otherGet(`/api/v1/admissions/sessions/${sessionId}`);
      // 404 rather than 403: confirming the record exists elsewhere is itself a leak.
      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain('Admission 2026');
    });

    it("tenant B cannot read tenant A's application by id", async () => {
      const response = await otherGet(`/api/v1/admissions/applications/${apps['a1']}`);
      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain('Applicant One');
    });

    it("tenant B's application list contains nothing of tenant A's", async () => {
      const response = await otherGet('/api/v1/admissions/applications');
      expect(response.status).toBe(200);
      expect(response.body.meta.total).toBe(0);
      expect(JSON.stringify(response.body)).not.toContain('Applicant');
    });

    it("tenant B cannot borrow tenant A's institution via the x-institution-id header", async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/admissions/applications')
        .set('Authorization', `Bearer ${otherToken}`)
        .set('x-institution-id', tenant.institutionId);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('RLS alone returns zero admission rows with no tenant context', async () => {
      const client = new Client({ connectionString: TEST_APP_DATABASE_URL });
      await client.connect();
      try {
        for (const table of ADMISSION_TABLES) {
          const result = await client.query(`select count(*)::int as total from ${table}`);
          expect(result.rows[0].total, `${table} leaked rows without tenant context`).toBe(0);
        }
      } finally {
        await client.end();
      }
    });

    it('every admission table has row-level security enabled AND forced', async () => {
      const rows = await queryDb<{ relname: string }>(
        `select c.relname
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r'
            and c.relname = any ($1)
            and not (c.relrowsecurity and c.relforcerowsecurity)`,
        [ADMISSION_TABLES],
      );
      expect(rows.map((row) => row.relname)).toEqual([]);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  // Permission enforcement
  // ────────────────────────────────────────────────────────────────────────────────────

  describe('permission enforcement', () => {
    it('a teacher cannot list applications', async () => {
      const response = await get('teacher', '/api/v1/admissions/applications');
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('an administrator without admission permissions cannot issue an offer', async () => {
      const response = await post('admin', `/api/v1/admissions/applications/${apps['a4']}/offers`, {
        expiresInDays: 7,
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('an unauthenticated caller can reach only the public form', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/admissions/applications');
      expect(response.status).toBe(401);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  // Rate limiting on the public form (last: it tightens the shared limiter)
  // ────────────────────────────────────────────────────────────────────────────────────

  describe('public form rate limiting', () => {
    it('throttles a burst from one address with the strict credential-endpoint limit', async () => {
      // The harness disables rate limiting so the auth suites can hammer the login
      // endpoint; tighten it here, prove the 429, and restore it.
      process.env.AUTH_RATE_LIMIT_MAX_ATTEMPTS = '3';
      resetEnvCache();
      try {
        let throttled = false;
        for (let attempt = 0; attempt < 6; attempt += 1) {
          const response = await request(app.getHttpServer())
            .post('/api/v1/admissions/public/applications')
            .send(
              publicPayload({
                applicantNameEn: `Burst Applicant ${attempt}`,
                dateOfBirth: '2016-01-15',
                guardianPhone: `0171234570${attempt}`,
              }),
            );
          if (response.status === 429) {
            throttled = true;
            break;
          }
        }
        expect(throttled, 'expected a 429 within a burst of 6 submissions').toBe(true);
      } finally {
        process.env.AUTH_RATE_LIMIT_MAX_ATTEMPTS = '100000';
        resetEnvCache();
      }
    });
  });
});
