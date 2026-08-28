/**
 * RBAC enforcement over HTTP (brief §50).
 *
 * `packages/permissions` already tests the evaluator and the role presets as pure logic. This
 * suite tests something different and equally necessary: that the **HTTP surface actually
 * consults it**. A perfect permission model is worthless if a controller forgets its decorator,
 * and that failure mode is invisible to a unit test.
 *
 * Every case is phrased as "role X must be refused action Y", because the dangerous bug is a
 * permission being granted, never one being denied.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  createTestApp,
  seedTenant,
  truncateAll,
  TEST_PASSWORD,
  type SeededTenant,
} from '../helpers/test-app';

describe('RBAC enforcement over HTTP', () => {
  let app: INestApplication;
  let tenant: SeededTenant;
  const tokens: Record<string, string> = {};

  async function login(email: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: email, password: TEST_PASSWORD });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body.accessToken as string;
  }

  beforeAll(async () => {
    app = await createTestApp();
    await truncateAll();
    tenant = await seedTenant('rbac', { students: 3 });
    for (const key of ['owner', 'principal', 'admin', 'accountant', 'teacher', 'guardian1']) {
      tokens[key] = await login(tenant.users[key]!.email);
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  const get = (role: string, path: string) =>
    request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${tokens[role]}`);
  const post = (role: string, path: string, body: unknown = {}) =>
    request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${tokens[role]}`)
      .set('x-institution-id', tenant.institutionId)
      .send(body);

  // ── The audit log ─────────────────────────────────────────────────────────────────

  describe('audit log access', () => {
    it('is available to the owner and the principal', async () => {
      expect((await get('owner', '/api/v1/audit-logs')).status).toBe(200);
      expect((await get('principal', '/api/v1/audit-logs')).status).toBe(200);
    });

    it('is refused to teachers, accountants and guardians', async () => {
      for (const role of ['teacher', 'accountant', 'guardian1']) {
        const response = await get(role, '/api/v1/audit-logs');
        expect(response.status, `${role} reached the audit log`).toBe(403);
        expect(response.body.error.code).toBe('FORBIDDEN');
      }
    });

    it('never names the missing permission in the response', async () => {
      const response = await get('teacher', '/api/v1/audit-logs');
      // Telling an attacker exactly which permission they lack is free reconnaissance.
      expect(JSON.stringify(response.body)).not.toContain('audit.view');
    });
  });

  // ── Student writes ────────────────────────────────────────────────────────────────

  describe('student records', () => {
    const validStudent = {
      admissionDate: '2026-02-01',
      fullNameEn: 'Newly Admitted',
      dateOfBirth: '2015-03-15',
      gender: 'male',
    };

    it('an administrator may create a student', async () => {
      const response = await post('admin', '/api/v1/students', validStudent);
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.studentCode).toBeTruthy();
    });

    it('a teacher may not create a student', async () => {
      const response = await post('teacher', '/api/v1/students', {
        ...validStudent,
        fullNameEn: 'Created By Teacher',
      });
      expect(response.status).toBe(403);
    });

    it('a guardian may not create a student', async () => {
      const response = await post('guardian1', '/api/v1/students', {
        ...validStudent,
        fullNameEn: 'Created By Guardian',
      });
      expect(response.status).toBe(403);
    });

    it('a teacher may not archive a student', async () => {
      const response = await post('teacher', `/api/v1/students/${tenant.studentIds[0]}/archive`, {
        reason: 'Attempting to archive without permission',
      });
      expect(response.status).toBe(403);
    });

    it('an accountant may not update a student record', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/students/${tenant.studentIds[0]}`)
        .set('Authorization', `Bearer ${tokens['accountant']}`)
        .send({ fullNameEn: 'Renamed By Accountant', version: 1 });
      expect(response.status).toBe(403);
    });
  });

  // ── Academic structure ────────────────────────────────────────────────────────────

  describe('academic configuration', () => {
    it('an accountant may not create subjects or class levels', async () => {
      expect(
        (await post('accountant', '/api/v1/academic/subjects', { code: 'X', nameEn: 'X' })).status,
      ).toBe(403);
      expect(
        (
          await post('accountant', '/api/v1/academic/class-levels', {
            code: 'X',
            nameEn: 'X',
            ordinal: 1,
          })
        ).status,
      ).toBe(403);
    });

    it('a teacher may read the academic structure but not change it', async () => {
      const read = await request(app.getHttpServer())
        .get('/api/v1/academic/class-levels')
        .set('Authorization', `Bearer ${tokens['teacher']}`)
        .set('x-institution-id', tenant.institutionId);
      expect(read.status).toBe(200);

      const write = await post('teacher', '/api/v1/academic/class-levels', {
        code: 'C7',
        nameEn: 'Class 7',
        ordinal: 8,
      });
      expect(write.status).toBe(403);
    });

    it('a guardian may not read the academic structure at all', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/academic/subjects')
        .set('Authorization', `Bearer ${tokens['guardian1']}`)
        .set('x-institution-id', tenant.institutionId);
      expect(response.status).toBe(403);
    });
  });

  // ── Guardian links are an access grant ────────────────────────────────────────────

  describe('guardian links', () => {
    it('a teacher may not link a guardian to a student', async () => {
      const response = await post(
        'teacher',
        `/api/v1/guardians/students/${tenant.studentIds[0]}/link`,
        { guardianId: tenant.guardianIds[1], relation: 'uncle' },
      );
      expect(response.status).toBe(403);
    });

    it('a guardian may not link themselves to another student', async () => {
      const response = await post(
        'guardian1',
        `/api/v1/guardians/students/${tenant.studentIds[2]}/link`,
        { guardianId: tenant.guardianIds[0], relation: 'father' },
      );
      expect(response.status).toBe(403);
    });

    it('an administrator may link a guardian, and it is recorded in the audit log', async () => {
      const link = await post('admin', `/api/v1/guardians/students/${tenant.studentIds[0]}/link`, {
        guardianId: tenant.guardianIds[1],
        relation: 'uncle',
        isEmergencyContact: true,
      });
      expect(link.status, JSON.stringify(link.body)).toBe(201);

      const audit = await get('owner', '/api/v1/audit-logs?resourceType=student_guardian');
      expect(audit.status).toBe(200);
      expect(audit.body.data.length).toBeGreaterThan(0);
      expect(audit.body.data[0].module).toBe('guardians');
    });
  });

  // ── Data scope, over HTTP ─────────────────────────────────────────────────────────

  describe('data scope', () => {
    it('a guardian sees only their own children', async () => {
      const response = await get('guardian1', '/api/v1/guardians/my-children');
      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(response.body[0].studentId).toBe(tenant.studentIds[0]);
    });

    it('a guardian listing students sees only their own children', async () => {
      const response = await get('guardian1', '/api/v1/students');
      expect(response.status).toBe(200);
      expect(response.body.meta.total).toBe(1);
    });

    it('a teacher sees the students in their assigned section', async () => {
      const response = await get('teacher', '/api/v1/students');
      expect(response.status).toBe(200);
      // Every seeded student is in the one section this teacher is class teacher of, plus the
      // one created earlier in this suite, which has no enrolment and so is not "assigned".
      expect(response.body.meta.total).toBe(3);
    });

    it('an administrator sees every student including the unenrolled one', async () => {
      const response = await get('admin', '/api/v1/students');
      expect(response.status).toBe(200);
      expect(response.body.meta.total).toBe(4);
    });

    it('a guardian cannot read another family’s student by id', async () => {
      const response = await get('guardian1', `/api/v1/students/${tenant.studentIds[2]}`);
      expect(response.status).toBe(404);
    });

    it('a guardian cannot read another family’s guardian list', async () => {
      const response = await get('guardian1', `/api/v1/guardians/students/${tenant.studentIds[2]}`);
      expect(response.status).toBe(404);
    });
  });

  // ── Medical data is separately gated ──────────────────────────────────────────────

  describe('sensitive fields', () => {
    it('redacts medical fields for a caller without students.medical.view', async () => {
      const response = await get('teacher', `/api/v1/students/${tenant.studentIds[0]}`);
      expect(response.status).toBe(200);
      expect(response.body.medicalConditions).toBeNull();
      expect(response.body.allergies).toBeNull();
      expect(response.body.specialNeeds).toBeNull();
    });

    it('never serialises a password hash, anywhere', async () => {
      const responses = await Promise.all([
        get('owner', '/api/v1/auth/me'),
        get('owner', '/api/v1/students'),
        get('owner', '/api/v1/guardians'),
        get('owner', '/api/v1/audit-logs'),
      ]);
      for (const response of responses) {
        const body = JSON.stringify(response.body);
        expect(body).not.toContain('passwordHash');
        expect(body).not.toContain('password_hash');
        expect(body).not.toContain('$argon2');
        expect(body).not.toContain('tokenHash');
        expect(body).not.toContain('searchVector');
      }
    });
  });

  // ── Reason-required actions ───────────────────────────────────────────────────────

  describe('actions that require a recorded reason', () => {
    // Archiving is a principal-level action: the `administrator` preset can create and update
    // students but deliberately cannot archive them, so these use the principal's token.
    it('an administrator cannot archive at all', async () => {
      const response = await post('admin', `/api/v1/students/${tenant.studentIds[1]}/archive`, {
        reason: 'Family relocated to another district and the student has left',
      });
      expect(response.status).toBe(403);
    });

    it('refuses an archive with no reason', async () => {
      const response = await post(
        'principal',
        `/api/v1/students/${tenant.studentIds[1]}/archive`,
        {},
      );
      expect(response.status).toBe(422);
    });

    it('refuses an archive with a trivially short reason', async () => {
      const response = await post('principal', `/api/v1/students/${tenant.studentIds[1]}/archive`, {
        reason: 'x',
      });
      expect(response.status).toBe(422);
    });

    it('refuses to archive a student who is still enrolled', async () => {
      const response = await post('principal', `/api/v1/students/${tenant.studentIds[1]}/archive`, {
        reason: 'Family relocated to another district and the student has left',
      });
      // The student still has an active enrolment, which must be ended first.
      expect(response.status).toBe(409);
      expect(response.body.error.message).toMatch(/still enrolled/i);
    });
  });
});
