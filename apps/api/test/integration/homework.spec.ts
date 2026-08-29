/**
 * Homework over HTTP (Phase 9).
 *
 * The suite asserts the *refusals* rather than the happy path, because that is where the
 * rules live: a teacher setting work for a section they do not teach, a subject teacher
 * reaching for a subject they do not take, a student seeing a draft, a client trying to
 * declare its own lateness, a late submission against `allow_late = false`, marks above the
 * maximum, a student fetching another student's file, a settled grade changed without a
 * reason, and one tenant reading another's assignment by its exact id.
 *
 * It also proves two invariants at the database itself, bypassing the service: the unique
 * attempt index refuses a duplicate (assignment, student, attempt) row, and every new table
 * carries forced row-level security with the tenant_isolation policy.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import argon2 from 'argon2';
import { addDays, todayInDhaka, uuidv7 } from '@shikkha/shared';
import {
  createTestApp,
  seedTenant,
  testClient,
  truncateAll,
  TEST_PASSWORD,
  type SeededTenant,
} from '../helpers/test-app';

const PDF_BYTES = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
);

describe('Homework', () => {
  let app: INestApplication;
  let tenant: SeededTenant;
  let other: SeededTenant;
  const tokens: Record<string, string> = {};

  /** Subjects seeded for the suite. */
  let subjectAId: string; // taught by teacher2 in section A
  let subjectBId: string; // no subject teacher; the class teacher may still use it
  let otherSubjectId: string; // tenant B

  /** A second section in tenant A that no seeded teacher is assigned to. */
  let unassignedSectionId: string;

  /** Seeded users beyond the harness defaults. */
  let teacher2EmployeeId: string;

  /** State threaded between ordered tests. */
  let assignment1: { id: string; version: number };
  let assignment2: { id: string; version: number };
  let assignment3: { id: string; version: number };
  let otherAssignmentId: string;
  let student1SubmissionId: string; // attempt 2, the one that gets graded
  let student2LateSubmissionId: string;
  let assignment3SubmissionIds: string[] = [];
  let teacherAttachmentId: string;
  let student1AttachmentId: string;

  async function login(email: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: email, password: TEST_PASSWORD });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
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

  function tomorrowIso(): string {
    return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  }

  beforeAll(async () => {
    app = await createTestApp();
    await truncateAll();
    tenant = await seedTenant('hw', { students: 3 });
    other = await seedTenant('hwother', { students: 2 });

    const client = testClient();
    await client.connect();
    try {
      // Subjects. The harness seeds none, and an assignment needs one.
      subjectAId = uuidv7();
      subjectBId = uuidv7();
      otherSubjectId = uuidv7();
      await client.query(
        `insert into subjects (id, tenant_id, institution_id, code, name_en)
         values ($1,$2,$3,'BAN','Bangla'), ($4,$2,$3,'ENG','English')`,
        [subjectAId, tenant.tenantId, tenant.institutionId, subjectBId],
      );
      await client.query(
        `insert into subjects (id, tenant_id, institution_id, code, name_en)
         values ($1,$2,$3,'BAN','Bangla')`,
        [otherSubjectId, other.tenantId, other.institutionId],
      );

      // A second section that neither seeded teacher is assigned to.
      unassignedSectionId = uuidv7();
      await client.query(
        `insert into sections (id, tenant_id, institution_id, campus_id, academic_year_id, class_level_id, name_en, capacity)
         values ($1,$2,$3,$4,$5,$6,'B',40)`,
        [
          unassignedSectionId,
          tenant.tenantId,
          tenant.institutionId,
          tenant.campusId,
          tenant.academicYearId,
          tenant.classLevelId,
        ],
      );

      const passwordHash = await argon2.hash(TEST_PASSWORD, {
        type: argon2.argon2id,
        memoryCost: 8192,
        timeCost: 2,
        parallelism: 1,
      });

      // A subject teacher: teaches Bangla (subject A) to section A, and nothing else.
      const teacher2UserId = uuidv7();
      teacher2EmployeeId = uuidv7();
      await client.query(
        `insert into users (id, tenant_id, email, password_hash, full_name_en, status, email_verified_at)
         values ($1,$2,'teacher2@hw.test',$3,'hw teacher2','active',now())`,
        [teacher2UserId, tenant.tenantId, passwordHash],
      );
      await client.query(
        `insert into user_roles (id, tenant_id, user_id, role_id, institution_id)
         values ($1,$2,$3,$4,$5)`,
        [
          uuidv7(),
          tenant.tenantId,
          teacher2UserId,
          tenant.roleIds['teacher'],
          tenant.institutionId,
        ],
      );
      await client.query(
        `insert into employees (id, tenant_id, institution_id, campus_id, user_id, employee_code, full_name_en, phone, joining_date)
         values ($1,$2,$3,$4,$5,'hw-EMP-T2','hw teacher2','+8801755550001','2021-01-01')`,
        [
          teacher2EmployeeId,
          tenant.tenantId,
          tenant.institutionId,
          tenant.campusId,
          teacher2UserId,
        ],
      );
      await client.query(
        `insert into employee_subject_assignments (id, tenant_id, institution_id, academic_year_id, employee_id, section_id, subject_id)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          uuidv7(),
          tenant.tenantId,
          tenant.institutionId,
          tenant.academicYearId,
          teacher2EmployeeId,
          tenant.sectionId,
          subjectAId,
        ],
      );

      // A head teacher: homework.* plus students.view.all, i.e. the "all" data scope.
      const headUserId = uuidv7();
      await client.query(
        `insert into users (id, tenant_id, email, password_hash, full_name_en, status, email_verified_at)
         values ($1,$2,'headteacher@hw.test',$3,'hw headteacher','active',now())`,
        [headUserId, tenant.tenantId, passwordHash],
      );
      await client.query(
        `insert into user_roles (id, tenant_id, user_id, role_id, institution_id)
         values ($1,$2,$3,$4,$5)`,
        [
          uuidv7(),
          tenant.tenantId,
          headUserId,
          tenant.roleIds['head_teacher'],
          tenant.institutionId,
        ],
      );
      await client.query(
        `insert into employees (id, tenant_id, institution_id, campus_id, user_id, employee_code, full_name_en, phone, joining_date)
         values ($1,$2,$3,$4,$5,'hw-EMP-HT','hw headteacher','+8801755550002','2019-01-01')`,
        [uuidv7(), tenant.tenantId, tenant.institutionId, tenant.campusId, headUserId],
      );

      // Student logins. The harness seeds student rows without user accounts; homework
      // submission needs a student principal, which resolves via students.user_id.
      for (const [index, studentId] of [tenant.studentIds[0]!, tenant.studentIds[1]!].entries()) {
        const studentUserId = uuidv7();
        await client.query(
          `insert into users (id, tenant_id, email, password_hash, full_name_en, status, email_verified_at)
           values ($1,$2,$3,$4,$5,'active',now())`,
          [
            studentUserId,
            tenant.tenantId,
            `student${index + 1}@hw.test`,
            passwordHash,
            `hw Student ${index + 1}`,
          ],
        );
        await client.query(
          `insert into user_roles (id, tenant_id, user_id, role_id, institution_id)
           values ($1,$2,$3,$4,$5)`,
          [
            uuidv7(),
            tenant.tenantId,
            studentUserId,
            tenant.roleIds['student'],
            tenant.institutionId,
          ],
        );
        await client.query(`update students set user_id = $1 where id = $2`, [
          studentUserId,
          studentId,
        ]);
      }
    } finally {
      await client.end();
    }

    for (const key of ['principal', 'accountant', 'teacher', 'guardian1', 'guardian2']) {
      tokens[key] = await login(tenant.users[key]!.email);
    }
    tokens['teacher2'] = await login('teacher2@hw.test');
    tokens['headteacher'] = await login('headteacher@hw.test');
    tokens['student1'] = await login('student1@hw.test');
    tokens['student2'] = await login('student2@hw.test');
    tokens['otherOwner'] = await login(other.users['owner']!.email);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  // ── Creating assignments ────────────────────────────────────────────────────────────

  describe('creating', () => {
    it('lets the class teacher set work for their own section', async () => {
      const response = await post('teacher', '/api/v1/homework/assignments', {
        sectionId: tenant.sectionId,
        subjectId: subjectBId,
        title: 'Essay: My Village',
        type: 'homework',
        assignedOn: todayInDhaka(),
        dueAt: tomorrowIso(),
        isGraded: true,
        maxMarks: '20.00',
        allowLate: false,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('draft');
      expect(response.body.maxMarks).toBe('20.00');
      assignment1 = { id: response.body.id as string, version: response.body.version as number };
    });

    it('refuses a section the teacher is not assigned to, with 404 rather than 403', async () => {
      const response = await post('teacher', '/api/v1/homework/assignments', {
        sectionId: unassignedSectionId,
        subjectId: subjectAId,
        title: 'Should never exist',
        assignedOn: todayInDhaka(),
        dueAt: tomorrowIso(),
      });
      // 404: a teacher probing section ids must not learn which of them are real.
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('lets a subject teacher set work for exactly their section+subject', async () => {
      const response = await post('teacher2', '/api/v1/homework/assignments', {
        sectionId: tenant.sectionId,
        subjectId: subjectAId,
        title: 'Bangla reading practice',
        type: 'reading',
        assignedOn: todayInDhaka(),
        dueAt: tomorrowIso(),
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
    });

    it('refuses the subject teacher for a subject they do not take in that section', async () => {
      const response = await post('teacher2', '/api/v1/homework/assignments', {
        sectionId: tenant.sectionId,
        subjectId: subjectBId,
        title: 'English homework from the Bangla teacher',
        assignedOn: todayInDhaka(),
        dueAt: tomorrowIso(),
      });
      expect(response.status, JSON.stringify(response.body)).toBe(404);
    });

    it('refuses a graded assignment without maximum marks', async () => {
      const response = await post('teacher', '/api/v1/homework/assignments', {
        sectionId: tenant.sectionId,
        subjectId: subjectBId,
        title: 'Graded but boundless',
        assignedOn: todayInDhaka(),
        dueAt: tomorrowIso(),
        isGraded: true,
      });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('denies creation to a role without homework.create (student)', async () => {
      const response = await post('student1', '/api/v1/homework/assignments', {
        sectionId: tenant.sectionId,
        subjectId: subjectAId,
        title: 'A student assigning homework',
        assignedOn: todayInDhaka(),
        dueAt: tomorrowIso(),
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
      // Authorization failures never name the missing permission.
      expect(JSON.stringify(response.body)).not.toContain('homework.create');
    });

    it('denies the whole module to a role without homework.view (accountant)', async () => {
      const response = await get('accountant', '/api/v1/homework/assignments');
      expect(response.status).toBe(403);
    });
  });

  // ── Draft invisibility and publishing ───────────────────────────────────────────────

  describe('publishing', () => {
    it('keeps a draft invisible to students', async () => {
      const list = await get('student1', '/api/v1/homework/assignments');
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      expect(list.body.meta.total).toBe(0);
      expect(list.body.data).toEqual([]);

      const byId = await get('student1', `/api/v1/homework/assignments/${assignment1.id}`);
      // 404, not 403: confirming the draft exists is itself a leak.
      expect(byId.status).toBe(404);
    });

    it('keeps a draft invisible to guardians', async () => {
      const list = await get('guardian1', '/api/v1/homework/assignments');
      expect(list.status).toBe(200);
      expect(list.body.meta.total).toBe(0);
    });

    it('shows the draft to an all-scope staff member (head teacher)', async () => {
      const response = await get('headteacher', `/api/v1/homework/assignments/${assignment1.id}`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.status).toBe('draft');
    });

    it('publishes a draft', async () => {
      const response = await post(
        'teacher',
        `/api/v1/homework/assignments/${assignment1.id}/publish`,
        { version: assignment1.version },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('published');
      expect(response.body.publishedAt).toBeTruthy();
      assignment1.version = response.body.version as number;
    });

    it('now shows the assignment to an enrolled student and their guardian', async () => {
      const asStudent = await get('student1', `/api/v1/homework/assignments/${assignment1.id}`);
      expect(asStudent.status, JSON.stringify(asStudent.body)).toBe(200);
      expect(asStudent.body.title).toBe('Essay: My Village');

      const asGuardian = await get('guardian1', '/api/v1/homework/assignments');
      expect(asGuardian.status).toBe(200);
      const ids = (asGuardian.body.data as { id: string }[]).map((row) => row.id);
      expect(ids).toContain(assignment1.id);
    });
  });

  // ── Tenant isolation ────────────────────────────────────────────────────────────────

  describe('tenant isolation', () => {
    it('another tenant cannot read an assignment by its exact id', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/homework/assignments/${assignment1.id}`)
        .set('Authorization', `Bearer ${tokens['otherOwner']}`)
        .set('x-institution-id', other.institutionId);

      // 404, not 403: confirming the record exists elsewhere is itself a leak.
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain('Essay: My Village');
    });

    it('refuses a borrowed institution header outright', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/homework/assignments/${assignment1.id}`)
        .set('Authorization', `Bearer ${tokens['otherOwner']}`)
        .set('x-institution-id', tenant.institutionId);
      expect(response.status).toBe(403);
    });

    it('gives the other tenant an empty, not leaky, list', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/homework/assignments')
        .set('Authorization', `Bearer ${tokens['otherOwner']}`)
        .set('x-institution-id', other.institutionId);
      expect(response.status).toBe(200);
      expect(response.body.meta.total).toBe(0);
      expect(response.body.data).toEqual([]);
    });

    it('every homework table has forced RLS and the tenant_isolation policy', async () => {
      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query(
          `select c.relname,
                  c.relrowsecurity,
                  c.relforcerowsecurity,
                  exists (
                    select 1 from pg_policy p
                    where p.polrelid = c.oid and p.polname = 'tenant_isolation'
                  ) as has_policy
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public'
             and c.relname = any (array[
               'assignments', 'assignment_attachments', 'assignment_submissions',
               'submission_attachments', 'submission_grades'
             ])`,
        );
        expect(rows).toHaveLength(5);
        for (const row of rows) {
          expect(row.relrowsecurity, `${row.relname} rowsecurity`).toBe(true);
          expect(row.relforcerowsecurity, `${row.relname} force`).toBe(true);
          expect(row.has_policy, `${row.relname} policy`).toBe(true);
        }
      } finally {
        await client.end();
      }
    });
  });

  // ── Submitting ──────────────────────────────────────────────────────────────────────

  describe('submitting', () => {
    it('accepts an on-time submission, with lateness decided by the server', async () => {
      const response = await post(
        'student1',
        `/api/v1/homework/assignments/${assignment1.id}/submissions`,
        {
          textResponse: 'Amar gram khub sundor.',
          // A client trying to state derived facts; zod strips them all.
          isLate: true,
          status: 'graded',
          attemptNumber: 9,
        },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.isLate).toBe(false);
      expect(response.body.status).toBe('submitted');
      expect(response.body.attemptNumber).toBe(1);
    });

    it('refuses a second plain submit — resubmission is explicit', async () => {
      const response = await post(
        'student1',
        `/api/v1/homework/assignments/${assignment1.id}/submissions`,
        { textResponse: 'Second try' },
      );
      expect(response.status).toBe(409);
    });

    it('accepts a resubmission as the next attempt', async () => {
      const response = await post(
        'student1',
        `/api/v1/homework/assignments/${assignment1.id}/resubmit`,
        { textResponse: 'Amar gram khub sundor. (Revised)' },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.attemptNumber).toBe(2);
      expect(response.body.status).toBe('resubmitted');
      student1SubmissionId = response.body.id as string;
    });

    it('denies submission to a guardian (no homework.submit)', async () => {
      const response = await post(
        'guardian1',
        `/api/v1/homework/assignments/${assignment1.id}/submissions`,
        { textResponse: 'A parent doing the homework' },
      );
      expect(response.status).toBe(403);
    });

    it('the database itself refuses a duplicate (assignment, student, attempt) row', async () => {
      const client = testClient();
      await client.connect();
      try {
        await expect(
          client.query(
            `insert into assignment_submissions
               (id, tenant_id, institution_id, assignment_id, student_id, attempt_number)
             values ($1,$2,$3,$4,$5,2)`,
            [uuidv7(), tenant.tenantId, tenant.institutionId, assignment1.id, tenant.studentIds[0]],
          ),
        ).rejects.toMatchObject({ code: '23505' });
      } finally {
        await client.end();
      }
    });
  });

  // ── Lateness ────────────────────────────────────────────────────────────────────────

  describe('late submissions', () => {
    it('sets up a published assignment whose deadline has passed', async () => {
      const created = await post('teacher', '/api/v1/homework/assignments', {
        sectionId: tenant.sectionId,
        subjectId: subjectBId,
        title: 'Yesterday homework',
        assignedOn: todayInDhaka(),
        dueAt: tomorrowIso(),
        allowLate: false,
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      assignment2 = { id: created.body.id as string, version: created.body.version as number };

      const published = await post(
        'teacher',
        `/api/v1/homework/assignments/${assignment2.id}/publish`,
        { version: assignment2.version },
      );
      expect(published.status).toBe(201);
      assignment2.version = published.body.version as number;

      // Move the deadline into the past underneath the service — the submission path must
      // judge lateness by the clock, not by what the client claims.
      const client = testClient();
      await client.connect();
      try {
        await client.query(
          `update assignments
             set due_at = now() - interval '5 minutes', assigned_on = $2
           where id = $1`,
          [assignment2.id, addDays(todayInDhaka(), -1)],
        );
      } finally {
        await client.end();
      }
    });

    it('refuses a late submission when late work is not allowed, with 422', async () => {
      const response = await post(
        'student2',
        `/api/v1/homework/assignments/${assignment2.id}/submissions`,
        { textResponse: 'Sorry, late' },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('flags a late submission is_late by the server clock once late work is allowed', async () => {
      const client = testClient();
      await client.connect();
      try {
        await client.query(`update assignments set allow_late = true where id = $1`, [
          assignment2.id,
        ]);
      } finally {
        await client.end();
      }

      const response = await post(
        'student2',
        `/api/v1/homework/assignments/${assignment2.id}/submissions`,
        { textResponse: 'Sorry, late' },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.isLate).toBe(true);
      expect(response.body.status).toBe('late');
      student2LateSubmissionId = response.body.id as string;
    });
  });

  // ── Grading ─────────────────────────────────────────────────────────────────────────

  describe('grading', () => {
    it('rejects marks above the maximum', async () => {
      const response = await post(
        'teacher',
        `/api/v1/homework/submissions/${student1SubmissionId}/grade`,
        { marks: '25.00', feedback: 'Too generous' },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('grades a submission and marks it graded', async () => {
      const response = await post(
        'teacher',
        `/api/v1/homework/submissions/${student1SubmissionId}/grade`,
        { marks: '18.50', feedback: 'Sundor lekha' },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.marks).toBe('18.50');
      expect(response.body.isFinal).toBe(true);
      // The __audit hint never reaches the client.
      expect(response.body.__audit).toBeUndefined();

      const list = await get(
        'teacher',
        `/api/v1/homework/assignments/${assignment1.id}/submissions`,
      );
      expect(list.status).toBe(200);
      const graded = (list.body.data as { id: string; status: string; marks: string }[]).find(
        (row) => row.id === student1SubmissionId,
      );
      expect(graded?.status).toBe('graded');
      expect(graded?.marks).toBe('18.50');
    });

    it('denies grading to a student', async () => {
      const response = await post(
        'student1',
        `/api/v1/homework/submissions/${student1SubmissionId}/grade`,
        { marks: '20.00' },
      );
      expect(response.status).toBe(403);
    });

    it('refuses to change a final grade without a reason', async () => {
      const response = await post(
        'teacher',
        `/api/v1/homework/submissions/${student1SubmissionId}/grade`,
        { marks: '19.00' },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(JSON.stringify(response.body)).toMatch(/reason/i);
    });

    it('re-grades with a reason and writes the before/after audit record', async () => {
      const response = await post(
        'teacher',
        `/api/v1/homework/submissions/${student1SubmissionId}/grade`,
        {
          marks: '19.00',
          feedback: 'Recounted the essay marks',
          reason: 'Adding the marks again after a parent query',
        },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.marks).toBe('19.00');

      // The correction's audit record is written inside the business transaction, so it is
      // durably present the moment the response arrives.
      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query(
          `select previous_value, new_value, reason
           from audit_logs
           where module = 'homework'
             and resource_type = 'submission_grade'
             and action = 'update'
             and reason is not null
             and tenant_id = $1
           order by occurred_at desc`,
          [tenant.tenantId],
        );
        expect(rows.length).toBeGreaterThanOrEqual(1);
        const record = rows[0]!;
        expect(record.previous_value.marks).toBe('18.50');
        expect(record.new_value.marks).toBe('19.00');
        expect(record.reason).toMatch(/parent query/);
      } finally {
        await client.end();
      }
    });

    it('bulk-grades fresh submissions and refuses to touch settled ones', async () => {
      // A third assignment both students hand in on time.
      const created = await post('teacher', '/api/v1/homework/assignments', {
        sectionId: tenant.sectionId,
        subjectId: subjectBId,
        title: 'Sums page 42',
        assignedOn: todayInDhaka(),
        dueAt: tomorrowIso(),
        isGraded: true,
        maxMarks: '10.00',
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      assignment3 = { id: created.body.id as string, version: created.body.version as number };
      const published = await post(
        'teacher',
        `/api/v1/homework/assignments/${assignment3.id}/publish`,
        { version: assignment3.version },
      );
      expect(published.status).toBe(201);
      assignment3.version = published.body.version as number;

      assignment3SubmissionIds = [];
      for (const student of ['student1', 'student2']) {
        const submitted = await post(
          student,
          `/api/v1/homework/assignments/${assignment3.id}/submissions`,
          { textResponse: 'Done' },
        );
        expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
        assignment3SubmissionIds.push(submitted.body.id as string);
      }

      const bulk = await post('teacher', `/api/v1/homework/assignments/${assignment3.id}/grades`, {
        items: [
          { submissionId: assignment3SubmissionIds[0], marks: '8.00' },
          { submissionId: assignment3SubmissionIds[1], marks: '7.50', feedback: 'Neat work' },
        ],
      });
      expect(bulk.status, JSON.stringify(bulk.body)).toBe(201);
      expect(bulk.body.graded).toBe(2);

      // The settled marks can only be changed one at a time, with a reason.
      const again = await post('teacher', `/api/v1/homework/assignments/${assignment3.id}/grades`, {
        items: [{ submissionId: assignment3SubmissionIds[0], marks: '9.00' }],
      });
      expect(again.status).toBe(409);
    });
  });

  // ── Attachments ─────────────────────────────────────────────────────────────────────

  describe('attachments', () => {
    it('lets the teacher attach a worksheet and a student download it via a signed URL', async () => {
      const upload = await request(app.getHttpServer())
        .post(`/api/v1/homework/assignments/${assignment1.id}/attachments`)
        .set('Authorization', `Bearer ${tokens['teacher']}`)
        .set('x-institution-id', tenant.institutionId)
        .attach('file', PDF_BYTES, { filename: 'worksheet.pdf', contentType: 'application/pdf' });
      expect(upload.status, JSON.stringify(upload.body)).toBe(201);
      teacherAttachmentId = upload.body.id as string;
      expect(upload.body.mimeType).toBe('application/pdf');

      const link = await get(
        'student1',
        `/api/v1/homework/assignments/${assignment1.id}/attachments/${teacherAttachmentId}/download`,
      );
      expect(link.status, JSON.stringify(link.body)).toBe(200);
      expect(link.body.url).toContain('/api/v1/files/download?');
      expect(link.body.url).toContain('signature=');

      // The signed URL itself is the credential — no auth header.
      const download = await request(app.getHttpServer()).get(link.body.url as string);
      expect(download.status, download.text).toBe(200);
      expect(download.headers['content-type']).toContain('application/pdf');
    });

    it('lets a student attach a file to their own submission', async () => {
      const upload = await request(app.getHttpServer())
        .post(`/api/v1/homework/submissions/${student1SubmissionId}/attachments`)
        .set('Authorization', `Bearer ${tokens['student1']}`)
        .set('x-institution-id', tenant.institutionId)
        .attach('file', PDF_BYTES, { filename: 'my-essay.pdf', contentType: 'application/pdf' });
      expect(upload.status, JSON.stringify(upload.body)).toBe(201);
      student1AttachmentId = upload.body.id as string;
    });

    it('refuses another student access to that attachment, with 404', async () => {
      const response = await get(
        'student2',
        `/api/v1/homework/submissions/${student1SubmissionId}/attachments/${student1AttachmentId}/download`,
      );
      // 404, not 403: student2 must not even learn the attachment exists.
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain('my-essay');
    });

    it('refuses an unlinked guardian, and admits the linked one and the teacher', async () => {
      const wrongGuardian = await get(
        'guardian2',
        `/api/v1/homework/submissions/${student1SubmissionId}/attachments/${student1AttachmentId}/download`,
      );
      expect(wrongGuardian.status).toBe(404);

      const rightGuardian = await get(
        'guardian1',
        `/api/v1/homework/submissions/${student1SubmissionId}/attachments/${student1AttachmentId}/download`,
      );
      expect(rightGuardian.status, JSON.stringify(rightGuardian.body)).toBe(200);

      const asTeacher = await get(
        'teacher',
        `/api/v1/homework/submissions/${student1SubmissionId}/attachments/${student1AttachmentId}/download`,
      );
      expect(asTeacher.status).toBe(200);
    });

    it('refuses a student attaching to another student’s submission', async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/v1/homework/submissions/${student1SubmissionId}/attachments`)
        .set('Authorization', `Bearer ${tokens['student2']}`)
        .set('x-institution-id', tenant.institutionId)
        .attach('file', PDF_BYTES, { filename: 'imposter.pdf', contentType: 'application/pdf' });
      expect(response.status).toBe(404);
    });

    it('refuses a disallowed file type', async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/v1/homework/assignments/${assignment1.id}/attachments`)
        .set('Authorization', `Bearer ${tokens['teacher']}`)
        .set('x-institution-id', tenant.institutionId)
        .attach('file', Buffer.from('#!/bin/sh\necho pwned\n'), {
          filename: 'script.sh',
          contentType: 'application/x-sh',
        });
      expect(response.status).toBe(422);
    });
  });

  // ── History and reports ─────────────────────────────────────────────────────────────

  describe('history and reports', () => {
    it('gives a student their own history, and their teacher the same view', async () => {
      const own = await get(
        'student1',
        `/api/v1/homework/students/${tenant.studentIds[0]}/submissions`,
      );
      expect(own.status, JSON.stringify(own.body)).toBe(200);
      expect(own.body.meta.total).toBeGreaterThanOrEqual(3); // attempts 1+2 plus assignment 3
      const titles = (own.body.data as { assignmentTitle: string }[]).map(
        (row) => row.assignmentTitle,
      );
      expect(titles).toContain('Essay: My Village');

      const asTeacher = await get(
        'teacher',
        `/api/v1/homework/students/${tenant.studentIds[0]}/submissions`,
      );
      expect(asTeacher.status).toBe(200);
      expect(asTeacher.body.meta.total).toBe(own.body.meta.total);
    });

    it('refuses a guardian another family’s history, with 404', async () => {
      const response = await get(
        'guardian1',
        `/api/v1/homework/students/${tenant.studentIds[1]}/submissions`,
      );
      expect(response.status).toBe(404);
    });

    it('computes the completion report in SQL, counting students once across attempts', async () => {
      const response = await get(
        'teacher',
        `/api/v1/homework/reports/completion?sectionId=${tenant.sectionId}`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.enrolled).toBe(3);

      const rows = response.body.assignments as {
        assignmentId: string;
        enrolled: number;
        submitted: number;
        graded: number;
        completionPercent: string;
      }[];

      const first = rows.find((row) => row.assignmentId === assignment1.id);
      expect(first, 'assignment 1 in report').toBeTruthy();
      // Two attempts by one student count once.
      expect(first!.submitted).toBe(1);
      expect(first!.completionPercent).toBe('33.33');

      const third = rows.find((row) => row.assignmentId === assignment3.id);
      expect(third!.submitted).toBe(2);
      expect(third!.graded).toBe(2);
      expect(third!.completionPercent).toBe('66.67');
    });

    it('withholds the section report from guardians', async () => {
      const response = await get(
        'guardian1',
        `/api/v1/homework/reports/completion?sectionId=${tenant.sectionId}`,
      );
      expect(response.status).toBe(403);
    });

    it('gives the teacher a 404 for another tenant’s section id', async () => {
      const response = await get(
        'teacher',
        `/api/v1/homework/reports/completion?sectionId=${other.sectionId}`,
      );
      expect(response.status).toBe(404);
    });
  });

  // ── Withdrawal ──────────────────────────────────────────────────────────────────────

  describe('withdrawing', () => {
    it('archives with a reason — a status change, never a delete', async () => {
      // Fetch the current version first; the late-submission tests changed the row in SQL,
      // but version is only bumped by the service, so the stored one is still current.
      const current = await get('teacher', `/api/v1/homework/assignments/${assignment2.id}`);
      expect(current.status).toBe(200);

      const response = await post(
        'teacher',
        `/api/v1/homework/assignments/${assignment2.id}/archive`,
        {
          reason: 'Set by mistake for the wrong week',
          version: current.body.version as number,
        },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('archived');
      expect(response.body.archivedAt).toBeTruthy();

      // Gone from every list…
      const list = await get('student2', '/api/v1/homework/assignments');
      const ids = (list.body.data as { id: string }[]).map((row) => row.id);
      expect(ids).not.toContain(assignment2.id);

      // …but still on disk, with its submissions intact.
      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query(
          `select archived_at, archive_reason, status from assignments where id = $1`,
          [assignment2.id],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].archived_at).toBeTruthy();
        expect(rows[0].status).toBe('archived');

        const { rows: submissions } = await client.query(
          `select id from assignment_submissions where assignment_id = $1`,
          [assignment2.id],
        );
        expect(submissions.length).toBeGreaterThanOrEqual(1);
        expect(submissions.map((row) => row.id)).toContain(student2LateSubmissionId);
      } finally {
        await client.end();
      }
    });

    it('lets an all-scope staff member list everything, including other teachers’ work', async () => {
      const response = await get('headteacher', '/api/v1/homework/assignments');
      expect(response.status).toBe(200);
      // assignment 1 and 3 (published), teacher2's draft; assignment 2 is archived.
      expect(response.body.meta.total).toBeGreaterThanOrEqual(3);
      // A cross-tenant assignment can never appear.
      const create = await request(app.getHttpServer())
        .post('/api/v1/homework/assignments')
        .set('Authorization', `Bearer ${tokens['otherOwner']}`)
        .set('x-institution-id', other.institutionId)
        .send({
          sectionId: other.sectionId,
          subjectId: otherSubjectId,
          title: 'Other tenant homework',
          assignedOn: todayInDhaka(),
          dueAt: tomorrowIso(),
        });
      expect(create.status, JSON.stringify(create.body)).toBe(201);
      otherAssignmentId = create.body.id as string;

      const again = await get('headteacher', '/api/v1/homework/assignments');
      const ids = (again.body.data as { id: string }[]).map((row) => row.id);
      expect(ids).not.toContain(otherAssignmentId);
    });
  });
});
