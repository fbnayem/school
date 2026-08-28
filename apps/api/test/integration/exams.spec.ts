/**
 * Examinations and results integration suite (Phase 8).
 *
 * The whole module is exercised through HTTP against a real Postgres, because the properties
 * worth asserting here live precisely in the parts a stub would replace: the permission
 * guards, the tenant transaction, the SQL window function that assigns positions, and the
 * `numeric` round trip that keeps a GPA exact.
 *
 * The cohort is constructed so that four students demonstrate the four Bangladeshi rules that
 * matter, and so that two of them tie on total marks:
 *
 *   Student 1 — the ordinary case, with a fourth subject that lifts the GPA to 4.83
 *   Student 2 — a fourth subject sitting exactly on the 2.00 threshold, contributing nothing
 *   Student 3 — a failed compulsory subject: GPA 0.00 and grade F despite three A+ grades
 *   Student 4 — 50% in Bangla but below the written-component threshold: the subject is
 *               failed, which is the rule most systems get wrong, and the compulsory-fail
 *               rule then takes the whole result to F
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { uuidv7 } from '@shikkha/shared';
import {
  createTestApp,
  seedTenant,
  testClient,
  truncateAll,
  TEST_APP_DATABASE_URL,
  TEST_PASSWORD,
  type SeededTenant,
} from '../helpers/test-app';
import { Client } from 'pg';

/** The NCTB GPA 5.0 scale, as half-open bands: `[min, max)`, with the top band closed at 100. */
const NCTB_BANDS = [
  { grade: 'F', minPercentage: '0', maxPercentage: '33', gradePoint: '0', isPassing: false },
  { grade: 'D', minPercentage: '33', maxPercentage: '40', gradePoint: '1', isPassing: true },
  { grade: 'C', minPercentage: '40', maxPercentage: '50', gradePoint: '2', isPassing: true },
  { grade: 'B', minPercentage: '50', maxPercentage: '60', gradePoint: '3', isPassing: true },
  { grade: 'A-', minPercentage: '60', maxPercentage: '70', gradePoint: '3.5', isPassing: true },
  { grade: 'A', minPercentage: '70', maxPercentage: '80', gradePoint: '4', isPassing: true },
  { grade: 'A+', minPercentage: '80', maxPercentage: '100', gradePoint: '5', isPassing: true },
];

describe('Examinations and results', () => {
  let app: INestApplication;
  let tenant: SeededTenant;
  let other: SeededTenant;
  const tokens: Record<string, string> = {};

  const subjectIds: Record<string, string> = {};
  let roomId = '';
  let gradingScaleId = '';
  let examId = '';
  const examSubjectIds: Record<string, string> = {};

  async function login(email: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: email, password: TEST_PASSWORD });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body.accessToken as string;
  }

  const get = (role: string, path: string, institution = tenant.institutionId) =>
    request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${tokens[role]}`)
      .set('x-institution-id', institution);

  const post = (role: string, path: string, body: object = {}) =>
    request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${tokens[role]}`)
      .set('x-institution-id', tenant.institutionId)
      .send(body);

  const put = (role: string, path: string, body: object = {}) =>
    request(app.getHttpServer())
      .put(path)
      .set('Authorization', `Bearer ${tokens[role]}`)
      .set('x-institution-id', tenant.institutionId)
      .send(body);

  const patch = (role: string, path: string, body: object = {}) =>
    request(app.getHttpServer())
      .patch(path)
      .set('Authorization', `Bearer ${tokens[role]}`)
      .set('x-institution-id', tenant.institutionId)
      .send(body);

  beforeAll(async () => {
    app = await createTestApp();
    await truncateAll();
    tenant = await seedTenant('exam', { students: 4 });
    other = await seedTenant('rival', { students: 2 });
    await seedExaminationFixtures();

    for (const key of [
      'owner',
      'principal',
      'teacher',
      'controller',
      'head',
      'solo',
      'guardian1',
    ]) {
      tokens[key] = await login(tenant.users[key]!.email);
    }
    tokens['rivalPrincipal'] = await login(other.users['principal']!.email);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  /**
   * Fixtures the shared harness does not provide: subjects with the GPA flags, a room, a
   * subject-teacher assignment, and the three extra staff accounts the workflow needs. Written
   * as the migrator, which owns the tables, exactly as `seedTenant` does.
   */
  async function seedExaminationFixtures(): Promise<void> {
    const client = testClient();
    await client.connect();
    try {
      await client.query('begin');

      const catalogue: Array<[string, string, string, boolean, boolean]> = [
        // key, code, name, isFourthSubject, excludeFromGpa
        ['bangla', '101', 'Bangla', false, false],
        ['english', '107', 'English', false, false],
        ['math', '109', 'Mathematics', false, false],
        ['higherMath', '126', 'Higher Mathematics', true, false],
        ['religion', '111', 'Religion and Moral Education', false, true],
      ];

      for (const [key, code, name, isFourth, excluded] of catalogue) {
        const id = uuidv7();
        subjectIds[key] = id;
        await client.query(
          `insert into subjects
             (id, tenant_id, institution_id, code, name_en, kind, is_fourth_subject, exclude_from_gpa, sort_order)
           values ($1,$2,$3,$4,$5,'compulsory',$6,$7,$8)`,
          [
            id,
            tenant.tenantId,
            tenant.institutionId,
            code,
            name,
            isFourth,
            excluded,
            catalogue.findIndex(([k]) => k === key),
          ],
        );
      }

      roomId = uuidv7();
      await client.query(
        `insert into rooms (id, tenant_id, institution_id, campus_id, code, name_en, kind)
         values ($1,$2,$3,$4,'HALL-1','Examination Hall 1','hall')`,
        [roomId, tenant.tenantId, tenant.institutionId, tenant.campusId],
      );

      // A role holding both mark entry and approval. No system preset grants both; this exists
      // only so the suite can prove the service refuses self-approval on the data, rather than
      // relying on the presets to keep the two apart.
      const soloRoleId = uuidv7();
      await client.query(
        `insert into roles (id, tenant_id, key, name_en, permissions, audience, is_system, is_sensitive)
         values ($1,$2,'solo_examiner','Solo Examiner',$3::jsonb,'teaching',false,true)`,
        [
          soloRoleId,
          tenant.tenantId,
          JSON.stringify([
            'exams.view',
            'exams.manage',
            'exams.grading_scheme.manage',
            'results.enter_marks',
            'results.submit_marks',
            'results.review',
            'results.approve',
            'results.view.all',
          ]),
        ],
      );

      // The password hash is copied from a seeded account rather than recomputed: these tests
      // are about examinations, and an Argon2 hash per user is several seconds of nothing.
      const sourceUserId = tenant.users['owner']!.id;
      async function addUser(key: string, roleId: string, asEmployee: boolean): Promise<string> {
        const userId = uuidv7();
        const email = `${key}@exam.test`;
        await client.query(
          `insert into users (id, tenant_id, email, password_hash, full_name_en, status, email_verified_at)
           select $1, tenant_id, $2, password_hash, $3, 'active', now() from users where id = $4`,
          [userId, email, `exam ${key}`, sourceUserId],
        );
        await client.query(
          `insert into user_roles (id, tenant_id, user_id, role_id, institution_id)
           values ($1,$2,$3,$4,$5)`,
          [uuidv7(), tenant.tenantId, userId, roleId, tenant.institutionId],
        );
        if (asEmployee) {
          const employeeId = uuidv7();
          await client.query(
            `insert into employees
               (id, tenant_id, institution_id, campus_id, user_id, employee_code, full_name_en, phone, joining_date)
             values ($1,$2,$3,$4,$5,$6,$7,$8,'2020-01-01')`,
            [
              employeeId,
              tenant.tenantId,
              tenant.institutionId,
              tenant.campusId,
              userId,
              `exam-EMP-${key}`,
              `exam ${key}`,
              `+8801799${String(key.length).padStart(5, '0')}`,
            ],
          );
        }
        tenant.users[key] = { id: userId, email };
        return userId;
      }

      await addUser('controller', tenant.roleIds['examination_controller']!, false);
      await addUser('head', tenant.roleIds['head_teacher']!, true);
      await addUser('solo', soloRoleId, true);

      // The seeded `teacher` is the class teacher of the section. Being a class teacher is not
      // being the Bangla examiner, so mark entry needs this row — and only this row.
      await client.query(
        `insert into employee_subject_assignments
           (id, tenant_id, institution_id, academic_year_id, employee_id, section_id, subject_id, is_primary)
         values ($1,$2,$3,$4,$5,$6,$7,true)`,
        [
          uuidv7(),
          tenant.tenantId,
          tenant.institutionId,
          tenant.academicYearId,
          tenant.employeeIds[4],
          tenant.sectionId,
          subjectIds['bangla'],
        ],
      );

      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }

  // ── Grading scales and band coverage ──────────────────────────────────────────────

  describe('grading scales', () => {
    it('creates a scale', async () => {
      const response = await post('controller', '/api/v1/exams/grading-scales', {
        code: 'NCTB5',
        nameEn: 'NCTB GPA 5.0',
        nameBn: 'এনসিটিবি জিপিএ ৫.০',
        isDefault: true,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      gradingScaleId = response.body.id as string;
      expect(gradingScaleId).toBeTruthy();
    });

    it('refuses overlapping bands', async () => {
      const overlapping = [
        ...NCTB_BANDS.slice(0, 6),
        // A+ starting at 75 while A already covers 70-80.
        {
          grade: 'A+',
          minPercentage: '75',
          maxPercentage: '100',
          gradePoint: '5',
          isPassing: true,
        },
      ];
      const response = await put(
        'controller',
        `/api/v1/exams/grading-scales/${gradingScaleId}/bands`,
        { bands: overlapping },
      );

      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(response.body)).toMatch(/overlap/i);
    });

    it('refuses bands that leave a gap', async () => {
      const gapped = [
        ...NCTB_BANDS.slice(0, 6),
        {
          grade: 'A+',
          minPercentage: '85',
          maxPercentage: '100',
          gradePoint: '5',
          isPassing: true,
        },
      ];
      const response = await put(
        'controller',
        `/api/v1/exams/grading-scales/${gradingScaleId}/bands`,
        { bands: gapped },
      );
      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body)).toMatch(/gap/i);
    });

    it('refuses a scale with no failing band, which could never express a failed subject', async () => {
      const allPassing = NCTB_BANDS.map((band) => ({ ...band, isPassing: true }));
      const response = await put(
        'controller',
        `/api/v1/exams/grading-scales/${gradingScaleId}/bands`,
        { bands: allPassing },
      );
      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body)).toMatch(/failing band/i);
    });

    it('accepts a contiguous set covering 0 to 100', async () => {
      const response = await put(
        'controller',
        `/api/v1/exams/grading-scales/${gradingScaleId}/bands`,
        { bands: NCTB_BANDS },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).toHaveLength(7);
      expect(response.body[0].grade).toBe('A+');
      // `numeric` on the wire is a decimal string, never a JavaScript number.
      expect(response.body[0].gradePoint).toBe('5.00');
    });

    it('refuses a teacher, who has no grading-scheme permission', async () => {
      const response = await put(
        'teacher',
        `/api/v1/exams/grading-scales/${gradingScaleId}/bands`,
        { bands: NCTB_BANDS },
      );
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
      // Naming the permission a caller lacks is free reconnaissance.
      expect(JSON.stringify(response.body)).not.toContain('grading_scheme');
    });
  });

  // ── Exam and paper configuration ──────────────────────────────────────────────────

  describe('exam configuration', () => {
    it('creates an exam in draft', async () => {
      const response = await post('controller', '/api/v1/exams', {
        academicYearId: tenant.academicYearId,
        gradingScaleId,
        code: 'HY2026',
        nameEn: 'Half Yearly 2026',
        nameBn: 'অর্ধবার্ষিক ২০২৬',
        type: 'half_yearly',
        startDate: '2026-06-01',
        endDate: '2026-06-15',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      examId = response.body.id as string;
      expect(response.body.status).toBe('draft');
    });

    it('refuses a paper whose components do not add up to its full marks', async () => {
      const response = await put('controller', `/api/v1/exams/${examId}/subjects`, {
        classLevelId: tenant.classLevelId,
        subjects: [
          {
            subjectId: subjectIds['bangla'],
            fullMarks: '100',
            passMarks: '33',
            writtenFullMarks: '70',
            mcqFullMarks: '40',
          },
        ],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(JSON.stringify(response.body)).toMatch(/add up to 110/);
    });

    it('configures the five papers as a set', async () => {
      const response = await put('controller', `/api/v1/exams/${examId}/subjects`, {
        classLevelId: tenant.classLevelId,
        subjects: [
          {
            subjectId: subjectIds['bangla'],
            fullMarks: '100',
            passMarks: '33',
            writtenFullMarks: '70',
            writtenPassMarks: '23',
            mcqFullMarks: '30',
            mcqPassMarks: '10',
            sortOrder: 1,
          },
          { subjectId: subjectIds['english'], fullMarks: '100', passMarks: '33', sortOrder: 2 },
          { subjectId: subjectIds['math'], fullMarks: '100', passMarks: '33', sortOrder: 3 },
          { subjectId: subjectIds['higherMath'], fullMarks: '100', passMarks: '33', sortOrder: 4 },
          { subjectId: subjectIds['religion'], fullMarks: '100', passMarks: '33', sortOrder: 5 },
        ],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).toHaveLength(5);

      const listed = await get('controller', `/api/v1/exams/${examId}/subjects`);
      expect(listed.status).toBe(200);
      for (const row of listed.body) {
        const key = Object.keys(subjectIds).find(
          (name) => subjectIds[name] === row.examSubject.subjectId,
        )!;
        examSubjectIds[key] = row.examSubject.id;
      }
      expect(Object.keys(examSubjectIds)).toHaveLength(5);
    });

    it('schedules a paper, and refuses a second one in the same room at the same time', async () => {
      const first = await post('controller', `/api/v1/exams/${examId}/schedules`, {
        examSubjectId: examSubjectIds['bangla'],
        roomId,
        examDate: '2026-06-01',
        startTime: '10:00',
        endTime: '13:00',
      });
      expect(first.status, JSON.stringify(first.body)).toBe(201);

      const clash = await post('controller', `/api/v1/exams/${examId}/schedules`, {
        examSubjectId: examSubjectIds['english'],
        roomId,
        examDate: '2026-06-01',
        startTime: '12:00',
        endTime: '15:00',
      });
      expect(clash.status, JSON.stringify(clash.body)).toBe(409);
      expect(clash.body.error.code).toBe('CONFLICT');
      expect(clash.body.error.message).toMatch(/room is already booked/i);

      // A paper starting exactly when the first one ends is not a clash.
      const adjacent = await post('controller', `/api/v1/exams/${examId}/schedules`, {
        examSubjectId: examSubjectIds['english'],
        roomId,
        examDate: '2026-06-01',
        startTime: '13:00',
        endTime: '16:00',
      });
      expect(adjacent.status, JSON.stringify(adjacent.body)).toBe(201);
    });
  });

  // ── Mark entry ────────────────────────────────────────────────────────────────────

  describe('mark entry', () => {
    it('refuses marks while the exam is not open for entry', async () => {
      const response = await put('teacher', `/api/v1/exams/${examId}/marks`, {
        examSubjectId: examSubjectIds['bangla'],
        marks: [{ studentId: tenant.studentIds[0], writtenMarks: '60', mcqMarks: '25' }],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body.error.code).toBe('WORKFLOW_STATE_INVALID');
    });

    it('walks the exam to mark entry', async () => {
      for (const status of ['scheduled', 'ongoing', 'marks_entry']) {
        const response = await post('controller', `/api/v1/exams/${examId}/status`, { status });
        expect(response.status, `${status}: ${JSON.stringify(response.body)}`).toBe(201);
        expect(response.body.status).toBe(status);
      }
    });

    it('refuses the examination controller, who may approve marks but not enter them', async () => {
      const response = await put('controller', `/api/v1/exams/${examId}/marks`, {
        examSubjectId: examSubjectIds['bangla'],
        marks: [{ studentId: tenant.studentIds[0], writtenMarks: '60', mcqMarks: '25' }],
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('refuses a teacher for a subject they are not assigned to', async () => {
      // The teacher is the section's class teacher and its Bangla examiner. That does not make
      // them the Higher Mathematics examiner.
      const response = await put('teacher', `/api/v1/exams/${examId}/marks`, {
        examSubjectId: examSubjectIds['higherMath'],
        marks: [{ studentId: tenant.studentIds[0], writtenMarks: '70' }],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('refuses a component mark above that component’s full marks', async () => {
      const response = await put('teacher', `/api/v1/exams/${examId}/marks`, {
        examSubjectId: examSubjectIds['bangla'],
        marks: [{ studentId: tenant.studentIds[0], writtenMarks: '80', mcqMarks: '25' }],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.message).toMatch(/above the written full marks/i);
    });

    it('refuses a mark against a component this paper does not assess', async () => {
      const response = await put('teacher', `/api/v1/exams/${examId}/marks`, {
        examSubjectId: examSubjectIds['bangla'],
        marks: [
          {
            studentId: tenant.studentIds[0],
            writtenMarks: '60',
            mcqMarks: '25',
            practicalMarks: '5',
          },
        ],
      });
      expect(response.status).toBe(422);
      expect(response.body.error.message).toMatch(/no practical component/i);
    });

    it('refuses a row that is both absent and marked', async () => {
      const response = await put('teacher', `/api/v1/exams/${examId}/marks`, {
        examSubjectId: examSubjectIds['bangla'],
        marks: [{ studentId: tenant.studentIds[0], writtenMarks: '60', isAbsent: true }],
      });
      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body)).toMatch(/absent/i);
    });

    it('accepts the Bangla marks from the assigned teacher, in one transaction', async () => {
      const response = await put('teacher', `/api/v1/exams/${examId}/marks`, {
        examSubjectId: examSubjectIds['bangla'],
        marks: [
          { studentId: tenant.studentIds[0], writtenMarks: '60', mcqMarks: '25' },
          { studentId: tenant.studentIds[1], writtenMarks: '60', mcqMarks: '25' },
          { studentId: tenant.studentIds[2], writtenMarks: '60', mcqMarks: '25' },
          // 20 written is below the 23 written threshold, even though 50/100 clears the total.
          { studentId: tenant.studentIds[3], writtenMarks: '20', mcqMarks: '30' },
        ],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.saved).toBe(4);
      expect(response.body.marks[0].obtainedMarks).toBe('85.00');
      expect(response.body.marks[0].status).toBe('draft');
    });

    it('accepts the remaining papers from a head teacher, whose scope is the whole school', async () => {
      const papers: Array<[string, string[]]> = [
        ['english', ['75', '85', '85', '85']],
        ['math', ['65', '85', '20', '85']],
        ['religion', ['90', '93', '85', '85']],
        ['higherMath', ['78', '45', '85', '85']],
      ];

      for (const [key, marks] of papers) {
        const response = await put('head', `/api/v1/exams/${examId}/marks`, {
          examSubjectId: examSubjectIds[key],
          marks: marks.map((value, index) => ({
            studentId: tenant.studentIds[index],
            writtenMarks: value,
          })),
        });
        expect(response.status, `${key}: ${JSON.stringify(response.body)}`).toBe(200);
        expect(response.body.saved).toBe(4);
      }
    });

    it('refuses a guardian who tries to read the raw mark sheet', async () => {
      const response = await get('guardian1', `/api/v1/exams/${examId}/marks`);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });
  });

  // ── Workflow ──────────────────────────────────────────────────────────────────────

  describe('submit, review and approve', () => {
    it('refuses review while marks are still in draft', async () => {
      const response = await post('controller', `/api/v1/exams/${examId}/review`);
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body.error.message).toMatch(/have not been submitted/i);
    });

    it('submits every paper', async () => {
      const bangla = await post('teacher', `/api/v1/exams/${examId}/marks/submit`, {
        examSubjectId: examSubjectIds['bangla'],
      });
      expect(bangla.status, JSON.stringify(bangla.body)).toBe(201);
      expect(bangla.body.submitted).toBe(4);

      for (const key of ['english', 'math', 'religion', 'higherMath']) {
        const response = await post('head', `/api/v1/exams/${examId}/marks/submit`, {
          examSubjectId: examSubjectIds[key],
        });
        expect(response.status, `${key}: ${JSON.stringify(response.body)}`).toBe(201);
      }
    });

    it('refuses a teacher who tries to review', async () => {
      const response = await post('teacher', `/api/v1/exams/${examId}/review`);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('moves the exam into review', async () => {
      const response = await post('controller', `/api/v1/exams/${examId}/review`);
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('under_review');
      expect(response.body.reviewed).toBe(20);
    });

    it('refuses publication before the marks are approved', async () => {
      const response = await post('controller', `/api/v1/exams/${examId}/publish`);
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body.error.message).toMatch(/have not been approved/i);
    });

    it('approves the marks', async () => {
      const response = await post('controller', `/api/v1/exams/${examId}/approve`, {});
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.approved).toBe(20);
    });

    it('refuses to let one person both enter and approve the same marks', async () => {
      // A separate exam, run end to end by a single account holding both permissions. The role
      // presets never grant both; this proves the service refuses it on the data as well.
      const created = await post('solo', '/api/v1/exams', {
        academicYearId: tenant.academicYearId,
        gradingScaleId,
        code: 'SOLO1',
        nameEn: 'Separation of duties check',
        type: 'class_test',
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const soloExamId = created.body.id as string;

      const configured = await put('solo', `/api/v1/exams/${soloExamId}/subjects`, {
        classLevelId: tenant.classLevelId,
        subjects: [{ subjectId: subjectIds['english'], fullMarks: '50', passMarks: '17' }],
      });
      expect(configured.status, JSON.stringify(configured.body)).toBe(200);
      const soloExamSubjectId = configured.body[0].id as string;

      for (const status of ['scheduled', 'ongoing', 'marks_entry']) {
        const moved = await post('solo', `/api/v1/exams/${soloExamId}/status`, { status });
        expect(moved.status, JSON.stringify(moved.body)).toBe(201);
      }

      const entered = await put('solo', `/api/v1/exams/${soloExamId}/marks`, {
        examSubjectId: soloExamSubjectId,
        marks: tenant.studentIds.map((studentId) => ({ studentId, writtenMarks: '40' })),
      });
      expect(entered.status, JSON.stringify(entered.body)).toBe(200);

      const submitted = await post('solo', `/api/v1/exams/${soloExamId}/marks/submit`, {
        examSubjectId: soloExamSubjectId,
      });
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);

      const reviewed = await post('solo', `/api/v1/exams/${soloExamId}/review`);
      expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(201);

      const approved = await post('solo', `/api/v1/exams/${soloExamId}/approve`, {});
      expect(approved.status, JSON.stringify(approved.body)).toBe(409);
      expect(approved.body.error.message).toMatch(/other than the person who entered/i);
    });
  });

  // ── Publication and the Bangladeshi GPA rules ─────────────────────────────────────

  describe('publication', () => {
    it('hides an unpublished result from a guardian', async () => {
      const response = await get(
        'guardian1',
        `/api/v1/exams/${examId}/marksheet/${tenant.studentIds[0]}`,
      );
      // 404 rather than 403: whether the school has computed a result yet is not the parent's
      // business until it is published.
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('refuses a teacher who tries to publish', async () => {
      // Entering the marks does not carry any right to release them. The teacher holds
      // `results.enter_marks` and `results.submit_marks`, and neither is `results.publish`.
      const refused = await post('teacher', `/api/v1/exams/${examId}/publish`);
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('FORBIDDEN');
      expect(JSON.stringify(refused.body)).not.toContain('results.publish');
    });

    it('publishes the whole cohort in one transaction', async () => {
      const response = await post('controller', `/api/v1/exams/${examId}/publish`);
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('published');
      expect(response.body.published).toBe(4);
      expect(response.body.resultsPublishedAt).toBeTruthy();
    });

    it('requires a reason to retract a published result', async () => {
      const noReason = await post('controller', `/api/v1/exams/${examId}/unpublish`, {});
      expect(noReason.status, JSON.stringify(noReason.body)).toBe(422);
      expect(noReason.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('computes a normal GPA, with the fourth subject counting only above 2.00', async () => {
      const response = await get(
        'controller',
        `/api/v1/exams/${examId}/marksheet/${tenant.studentIds[0]}`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);

      const result = response.body.result;
      // Bangla 5.00 + English 4.00 + Mathematics 3.50 = 12.50 over three subjects, plus the
      // fourth subject's 4.00 - 2.00 = 2.00, giving 14.50 / 3 = 4.83.
      expect(result.gpa).toBe('4.83');
      expect(result.grade).toBe('A');
      expect(result.isPassed).toBe(true);
      expect(result.gpaSubjectCount).toBe(3);
      expect(result.obtainedMarks).toBe('393.00');
      expect(result.totalMarks).toBe('500.00');
      expect(result.percentage).toBe('78.60');

      const religion = result.subjectBreakdown.find(
        (row: { subjectCode: string }) => row.subjectCode === '111',
      );
      expect(religion.excludeFromGpa, 'religion should be outside the GPA').toBe(true);
    });

    it('never lets the fourth subject lower a GPA', async () => {
      const response = await get(
        'controller',
        `/api/v1/exams/${examId}/marksheet/${tenant.studentIds[1]}`,
      );
      expect(response.status).toBe(200);
      // Three A+ subjects average 5.00. The fourth subject scored 2.00, exactly the threshold,
      // so it contributes nothing — and cannot drag the average down.
      expect(response.body.result.gpa).toBe('5.00');
      expect(response.body.result.grade).toBe('A+');
    });

    it('takes a failed compulsory subject to GPA 0.00 and grade F', async () => {
      const response = await get(
        'controller',
        `/api/v1/exams/${examId}/marksheet/${tenant.studentIds[2]}`,
      );
      expect(response.status).toBe(200);
      const result = response.body.result;
      expect(result.gpa).toBe('0.00');
      expect(result.grade).toBe('F');
      expect(result.isPassed).toBe(false);
      expect(result.failedSubjectCount).toBe(1);

      const maths = result.subjectBreakdown.find(
        (row: { subjectCode: string }) => row.subjectCode === '109',
      );
      expect(maths.grade).toBe('F');
      expect(maths.isPassed).toBe(false);
    });

    it('fails a subject on a missed component threshold, even when the total passes', async () => {
      const response = await get(
        'controller',
        `/api/v1/exams/${examId}/marksheet/${tenant.studentIds[3]}`,
      );
      expect(response.status).toBe(200);
      const result = response.body.result;

      const bangla = result.subjectBreakdown.find(
        (row: { subjectCode: string }) => row.subjectCode === '101',
      );
      // 20 written + 30 MCQ is 50 out of 100 — comfortably past the 33 overall pass mark — but
      // the written threshold of 23 was not reached, so the paper is failed.
      expect(bangla.obtainedMarks).toBe('50.00');
      expect(bangla.percentage).toBe('50.00');
      expect(bangla.isPassed, 'a missed component threshold must fail the subject').toBe(false);
      expect(bangla.grade).toBe('F');
      expect(bangla.failedComponents).toEqual(['written']);

      // Bangla is compulsory, so the whole result follows it down.
      expect(result.gpa).toBe('0.00');
      expect(result.grade).toBe('F');
    });

    it('gives tied totals the same position, and skips the next one', async () => {
      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query<{
          student_id: string;
          obtained_marks: string;
          position_in_section: number;
          position_in_class: number;
        }>(
          `select student_id, obtained_marks, position_in_section, position_in_class
             from results where exam_id = $1 order by position_in_section, obtained_marks desc`,
          [examId],
        );

        expect(rows).toHaveLength(4);
        const byStudent = new Map(rows.map((row) => [row.student_id, row]));

        // Students 1 and 2 both scored 393.
        expect(byStudent.get(tenant.studentIds[0]!)!.obtained_marks).toBe('393.00');
        expect(byStudent.get(tenant.studentIds[1]!)!.obtained_marks).toBe('393.00');
        expect(byStudent.get(tenant.studentIds[0]!)!.position_in_section).toBe(1);
        expect(byStudent.get(tenant.studentIds[1]!)!.position_in_section).toBe(1);
        // `rank()`, not `row_number()`: the next student is third, not second.
        expect(byStudent.get(tenant.studentIds[3]!)!.position_in_section).toBe(3);
        expect(byStudent.get(tenant.studentIds[2]!)!.position_in_section).toBe(4);
        // One section, one class level, so the two rankings agree here.
        expect(byStudent.get(tenant.studentIds[3]!)!.position_in_class).toBe(3);
      } finally {
        await client.end();
      }
    });

    it('shows a published result to the linked guardian, and nobody else’s', async () => {
      const own = await get(
        'guardian1',
        `/api/v1/exams/${examId}/marksheet/${tenant.studentIds[0]}`,
      );
      expect(own.status, JSON.stringify(own.body)).toBe(200);
      expect(own.body.result.gpa).toBe('4.83');

      const someoneElse = await get(
        'guardian1',
        `/api/v1/exams/${examId}/marksheet/${tenant.studentIds[2]}`,
      );
      expect(someoneElse.status).toBe(404);
      expect(someoneElse.body.error.code).toBe('NOT_FOUND');
    });

    it('hides results again once they are retracted, and restores them on republication', async () => {
      const retracted = await post('controller', `/api/v1/exams/${examId}/unpublish`, {
        reason: 'A tabulation error was reported by the mathematics department',
      });
      expect(retracted.status, JSON.stringify(retracted.body)).toBe(201);
      expect(retracted.body.retracted).toBe(4);

      const hidden = await get(
        'guardian1',
        `/api/v1/exams/${examId}/marksheet/${tenant.studentIds[0]}`,
      );
      expect(hidden.status, 'a retracted result must disappear for families').toBe(404);

      // Staff can still see it: the result was not destroyed, only unpublished.
      const staff = await get(
        'controller',
        `/api/v1/exams/${examId}/marksheet/${tenant.studentIds[0]}`,
      );
      expect(staff.status).toBe(200);

      const republished = await post('controller', `/api/v1/exams/${examId}/publish`);
      expect(republished.status, JSON.stringify(republished.body)).toBe(201);

      const visible = await get(
        'guardian1',
        `/api/v1/exams/${examId}/marksheet/${tenant.studentIds[0]}`,
      );
      expect(visible.status).toBe(200);
    });
  });

  // ── Corrections after approval ────────────────────────────────────────────────────

  describe('correcting an approved mark', () => {
    let markId = '';

    it('finds the mark to correct', async () => {
      const response = await get('controller', `/api/v1/exams/${examId}/marks`).query({
        examSubjectId: examSubjectIds['math'],
        studentId: tenant.studentIds[2],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).toHaveLength(1);
      markId = response.body[0].mark.id as string;
      expect(response.body[0].mark.status).toBe('approved');
    });

    it('refuses a correction with no reason', async () => {
      const response = await patch('controller', `/api/v1/exams/marks/${markId}`, {
        writtenMarks: '55',
        version: 1,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('refuses a teacher, who cannot correct an approved mark', async () => {
      const response = await patch('teacher', `/api/v1/exams/marks/${markId}`, {
        writtenMarks: '55',
        reason: 'The script was re-marked after the review meeting',
        version: 1,
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('refuses a stale version', async () => {
      const response = await patch('controller', `/api/v1/exams/marks/${markId}`, {
        writtenMarks: '55',
        reason: 'The script was re-marked after the review meeting',
        version: 999,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body.error.code).toBe('CONFLICT');
    });

    it('applies the correction and records the before and after values', async () => {
      // Read the live version rather than assuming one: entry, submission, review and
      // approval have each bumped it, and hard-coding the count would make this test fail for
      // a reason that has nothing to do with corrections.
      const version = await currentMarkVersion(markId);

      const response = await patch('controller', `/api/v1/exams/marks/${markId}`, {
        writtenMarks: '55',
        reason: 'The script was re-marked after the review meeting on 20 June',
        version,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.obtainedMarks).toBe('55.00');
      expect(response.body.correctionCount).toBe(1);
      // The hint the audit interceptor reads must never reach the wire.
      expect(response.body.__audit).toBeUndefined();

      const audited = await waitForAuditRecord(markId);
      expect(audited, 'a correction with no audit record is an incomplete mutation').toBeTruthy();
      expect(audited!.action).toBe('update');
      expect(audited!.module).toBe('exams');
      expect(audited!.reason).toMatch(/re-marked/);
      expect(audited!.previous_value.obtainedMarks).toBe('20.00');
      expect(audited!.new_value.writtenMarks).toBe('55');
    });

    it('leaves the published result untouched until it is republished', async () => {
      // A correction changes a mark, not a transcript. Rewriting a published result silently
      // would mean the copy a parent is holding no longer matches the system, with nothing to
      // show that it changed.
      const response = await get(
        'controller',
        `/api/v1/exams/${examId}/marksheet/${tenant.studentIds[2]}`,
      );
      expect(response.status).toBe(200);
      expect(response.body.result.gpa).toBe('0.00');
    });
  });

  // ── Reports ───────────────────────────────────────────────────────────────────────

  describe('reports', () => {
    it('computes the pass rate and grade distribution in SQL', async () => {
      const response = await get('controller', `/api/v1/exams/${examId}/summary`).query({
        sectionId: tenant.sectionId,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);

      expect(response.body.totals.students).toBe(4);
      expect(response.body.totals.passed).toBe(2);
      expect(response.body.totals.failed).toBe(2);
      // A decimal string straight from Postgres numeric — no floating-point tail.
      expect(response.body.totals.passRate).toBe('50.00');

      const grades = Object.fromEntries(
        response.body.gradeDistribution.map((row: { grade: string; students: number }) => [
          row.grade,
          row.students,
        ]),
      );
      expect(grades).toEqual({ 'A+': 1, A: 1, F: 2 });
    });

    it('builds a tabulation sheet for a section', async () => {
      const response = await get('controller', `/api/v1/exams/${examId}/tabulation`).query({
        sectionId: tenant.sectionId,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.students).toHaveLength(4);
      expect(response.body.students[0].papers).toHaveLength(5);
      expect(response.body.students[0].result).toBeTruthy();
    });

    it('refuses a guardian the tabulation sheet', async () => {
      const response = await get('guardian1', `/api/v1/exams/${examId}/tabulation`).query({
        sectionId: tenant.sectionId,
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });
  });

  // ── Tenant isolation ──────────────────────────────────────────────────────────────

  describe('tenant isolation', () => {
    it('refuses another tenant’s exam by its exact id', async () => {
      const response = await get('rivalPrincipal', `/api/v1/exams/${examId}`, other.institutionId);
      // 404, not 403: confirming the exam exists elsewhere is itself a leak.
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain('Half Yearly');
    });

    it('refuses a forged x-institution-id header pointing at the other tenant', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/exams/${examId}`)
        .set('Authorization', `Bearer ${tokens['rivalPrincipal']}`)
        .set('x-institution-id', tenant.institutionId);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('returns no results for another tenant’s exam', async () => {
      const response = await get(
        'rivalPrincipal',
        `/api/v1/exams/${examId}/results`,
        other.institutionId,
      );
      expect(response.status).toBe(200);
      expect(response.body.meta.total).toBe(0);
      expect(response.body.data).toEqual([]);
    });

    it('leaks nothing to the application role outside a tenant context', async () => {
      // Connects as `shikkha_app` — the unprivileged role the API itself uses — so this is
      // what an attacker with SQL execution inside the application could actually see.
      const client = new Client({ connectionString: TEST_APP_DATABASE_URL });
      await client.connect();
      try {
        for (const table of [
          'grading_scales',
          'grade_bands',
          'exams',
          'exam_subjects',
          'exam_schedules',
          'exam_marks',
          'results',
        ]) {
          const { rows } = await client.query<{ count: string }>(`select count(*) from ${table}`);
          expect(Number(rows[0]!.count), `${table} leaked without a tenant context`).toBe(0);
        }
      } finally {
        await client.end();
      }
    });

    it('refuses a mark stamped with another tenant’s id', async () => {
      const client = new Client({ connectionString: TEST_APP_DATABASE_URL });
      await client.connect();
      try {
        await client.query('begin');
        await client.query(`select set_config('app.tenant_id', $1, true)`, [other.tenantId]);
        await expect(
          client.query(
            `insert into exam_marks
               (tenant_id, institution_id, exam_id, exam_subject_id, student_id, section_id, written_marks)
             values ($1,$2,$3,$4,$5,$6,'99')`,
            [
              tenant.tenantId,
              tenant.institutionId,
              examId,
              examSubjectIds['bangla'],
              tenant.studentIds[0],
              tenant.sectionId,
            ],
          ),
        ).rejects.toThrow(/row-level security/i);
        await client.query('rollback');
      } finally {
        await client.end();
      }
    });

    it('has forced row-level security on every examination table', async () => {
      const client = new Client({ connectionString: TEST_APP_DATABASE_URL });
      await client.connect();
      try {
        const { rows } = await client.query<{ relname: string }>(
          `select c.relname
             from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public'
              and c.relkind = 'r'
              and c.relname in ('grading_scales','grade_bands','exams','exam_subjects',
                                'exam_schedules','exam_marks','results')
              and (not c.relrowsecurity or not c.relforcerowsecurity)`,
        );
        expect(rows.map((row) => row.relname)).toEqual([]);
      } finally {
        await client.end();
      }
    });
  });

  async function currentMarkVersion(markId: string): Promise<number> {
    const client = testClient();
    await client.connect();
    try {
      const { rows } = await client.query<{ version: number }>(
        `select version from exam_marks where id = $1`,
        [markId],
      );
      return rows[0]!.version;
    } finally {
      await client.end();
    }
  }

  /**
   * The audit interceptor writes after the response has been sent, deliberately — an audit
   * failure must not roll back a business action that already committed. So the record is
   * polled for rather than assumed to be there the instant the request returns.
   */
  async function waitForAuditRecord(resourceId: string): Promise<{
    action: string;
    module: string;
    reason: string | null;
    previous_value: Record<string, string>;
    new_value: Record<string, string>;
  } | null> {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query(
          `select action, module, reason, previous_value, new_value
             from audit_logs
            where module = 'exams' and resource_type = 'exam_mark' and resource_id = $1
            order by occurred_at desc limit 1`,
          [resourceId],
        );
        if (rows.length > 0) return rows[0] as never;
      } finally {
        await client.end();
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }
});
