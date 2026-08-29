/**
 * Learning Management System over HTTP (Phase 10).
 *
 * The suite asserts the *refusals* rather than the happy path, because that is where the
 * rules live: a teacher building a course for a class they do not teach, a subject teacher
 * reaching for a subject they do not take, a student seeing a draft course/module/lesson,
 * the answer key (`quiz_options.is_correct`) leaking into any student-facing response — the
 * single most important assertion in the module — an attempt beyond `attempts_allowed`, a
 * time limit judged by anything but the server clock from `started_at`, a submitted attempt
 * changed, a settled mark changed without a reason, and one tenant reading another's course
 * by its exact id.
 *
 * It also proves the database's own contribution, bypassing the service: forced RLS with the
 * `tenant_isolation` policy and the `set_updated_at` trigger on all eleven tables, the
 * `quiz_attempts_attempt_key` unique index, and the `lesson_resources_exactly_one_source`
 * and `quizzes_exactly_one_anchor` CHECK constraints — by their migration names.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import argon2 from 'argon2';
import { uuidv7 } from '@shikkha/shared';
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

/** The eleven tables migration 0021 creates, for the database-contract assertions. */
const LMS_TABLES = [
  'courses',
  'course_enrolments',
  'course_modules',
  'lessons',
  'lesson_resources',
  'lesson_progress',
  'quizzes',
  'quiz_questions',
  'quiz_options',
  'quiz_attempts',
  'quiz_answers',
] as const;

/** The single most important assertion in the module, applied to every student response. */
function expectNoAnswerKey(body: unknown): void {
  const text = JSON.stringify(body);
  expect(text, 'the answer key must never reach a student').not.toContain('isCorrect');
  expect(text, 'the answer key must never reach a student').not.toContain('is_correct');
}

interface ManagerOption {
  id: string;
  isCorrect: boolean;
  text: string;
}
interface ManagerQuestion {
  id: string;
  kind: string;
  marks: string;
  options: ManagerOption[];
}

describe('LMS', () => {
  let app: INestApplication;
  let tenant: SeededTenant;
  let other: SeededTenant;
  const tokens: Record<string, string> = {};

  /** Subjects seeded for the suite. */
  let subjectAId: string; // taught by teacher2 in section A
  let subjectBId: string; // no subject teacher; the class teacher may still use it

  /** A second class level in tenant A that no seeded teacher is assigned to. */
  let classLevel2Id: string;

  /** State threaded between ordered tests. */
  let course1: { id: string };
  let course2Id: string; // teacher2's draft
  let module1Id: string;
  let module2Id: string;
  let lesson1Id: string;
  let lesson2Id: string;
  let hiddenLessonId: string;
  let fileResourceId: string;
  let quiz1Id: string;
  let quiz2Id: string;
  let quiz1Questions: ManagerQuestion[];
  let attempt1Id: string;
  let attempt2Id: string;
  let expiredAttemptId: string;
  let shortAnswerId: string;

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

  const put = (role: string, path: string, body: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .put(path)
      .set('Authorization', `Bearer ${tokens[role]}`)
      .set('x-institution-id', tenant.institutionId)
      .send(body);

  const patch = (role: string, path: string, body: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .patch(path)
      .set('Authorization', `Bearer ${tokens[role]}`)
      .set('x-institution-id', tenant.institutionId)
      .send(body);

  /** Map a manager-view quiz question to its correct / wrong option ids. */
  function optionsOf(kind: string): {
    question: ManagerQuestion;
    correct: string[];
    wrong: string[];
  } {
    const question = quiz1Questions.find((row) => row.kind === kind)!;
    return {
      question,
      correct: question.options.filter((option) => option.isCorrect).map((option) => option.id),
      wrong: question.options.filter((option) => !option.isCorrect).map((option) => option.id),
    };
  }

  beforeAll(async () => {
    app = await createTestApp();
    await truncateAll();
    tenant = await seedTenant('lmsa', { students: 3 });
    other = await seedTenant('lmsb', { students: 2 });

    const client = testClient();
    await client.connect();
    try {
      // Subjects. The harness seeds none, and a course needs one.
      subjectAId = uuidv7();
      subjectBId = uuidv7();
      await client.query(
        `insert into subjects (id, tenant_id, institution_id, code, name_en)
         values ($1,$2,$3,'BAN','Bangla'), ($4,$2,$3,'ENG','English')`,
        [subjectAId, tenant.tenantId, tenant.institutionId, subjectBId],
      );

      // A class level no seeded teacher has any section assignment for.
      classLevel2Id = uuidv7();
      await client.query(
        `insert into class_levels (id, tenant_id, institution_id, code, name_en, ordinal)
         values ($1,$2,$3,'C7','Class 7',8)`,
        [classLevel2Id, tenant.tenantId, tenant.institutionId],
      );

      const passwordHash = await argon2.hash(TEST_PASSWORD, {
        type: argon2.argon2id,
        memoryCost: 8192,
        timeCost: 2,
        parallelism: 1,
      });

      // A subject teacher: teaches Bangla (subject A) to section A, and nothing else.
      const teacher2UserId = uuidv7();
      const teacher2EmployeeId = uuidv7();
      await client.query(
        `insert into users (id, tenant_id, email, password_hash, full_name_en, status, email_verified_at)
         values ($1,$2,'teacher2@lmsa.test',$3,'lmsa teacher2','active',now())`,
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
         values ($1,$2,$3,$4,$5,'lmsa-EMP-T2','lmsa teacher2','+8801755553001','2021-01-01')`,
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

      // A head teacher: lms.* plus students.view.all, i.e. the "all" data scope — the role
      // that publishes, since plain teachers hold lms.manage but not lms.publish.
      const headUserId = uuidv7();
      await client.query(
        `insert into users (id, tenant_id, email, password_hash, full_name_en, status, email_verified_at)
         values ($1,$2,'headteacher@lmsa.test',$3,'lmsa headteacher','active',now())`,
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
         values ($1,$2,$3,$4,$5,'lmsa-EMP-HT','lmsa headteacher','+8801755553002','2019-01-01')`,
        [uuidv7(), tenant.tenantId, tenant.institutionId, tenant.campusId, headUserId],
      );

      // Student logins. The harness seeds student rows without user accounts; sitting a
      // quiz needs a student principal, which resolves via students.user_id.
      for (const [index, studentId] of tenant.studentIds.entries()) {
        const studentUserId = uuidv7();
        await client.query(
          `insert into users (id, tenant_id, email, password_hash, full_name_en, status, email_verified_at)
           values ($1,$2,$3,$4,$5,'active',now())`,
          [
            studentUserId,
            tenant.tenantId,
            `student${index + 1}@lmsa.test`,
            passwordHash,
            `lmsa Student ${index + 1}`,
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

    for (const key of ['teacher', 'accountant', 'guardian1']) {
      tokens[key] = await login(tenant.users[key]!.email);
    }
    tokens['teacher2'] = await login('teacher2@lmsa.test');
    tokens['headteacher'] = await login('headteacher@lmsa.test');
    tokens['student1'] = await login('student1@lmsa.test');
    tokens['student2'] = await login('student2@lmsa.test');
    tokens['student3'] = await login('student3@lmsa.test');
    tokens['otherOwner'] = await login(other.users['owner']!.email);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  // ── Creating courses ────────────────────────────────────────────────────────────────

  describe('creating courses', () => {
    it('lets the class teacher build a course for their own class, any subject', async () => {
      const response = await post('teacher', '/api/v1/lms/courses', {
        campusId: tenant.campusId,
        academicYearId: tenant.academicYearId,
        classLevelId: tenant.classLevelId,
        subjectId: subjectBId,
        title: 'Class 6 English Foundations',
        description: 'Grammar and composition for Class 6.',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('draft');
      expect(response.body.version).toBe(1);
      // The teacher who created it owns it.
      expect(response.body.ownerEmployeeId).toBe(tenant.employeeIds[4]);
      course1 = { id: response.body.id as string };
    });

    it('refuses a class the teacher is not assigned to, with 404 rather than 403', async () => {
      const response = await post('teacher', '/api/v1/lms/courses', {
        campusId: tenant.campusId,
        academicYearId: tenant.academicYearId,
        classLevelId: classLevel2Id,
        subjectId: subjectBId,
        title: 'Should never exist',
      });
      // 404: a teacher probing class ids must not learn which of them are real.
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('lets a subject teacher build a course for exactly their class+subject', async () => {
      const response = await post('teacher2', '/api/v1/lms/courses', {
        campusId: tenant.campusId,
        academicYearId: tenant.academicYearId,
        classLevelId: tenant.classLevelId,
        subjectId: subjectAId,
        title: 'Bangla Byakaran',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      course2Id = response.body.id as string;
    });

    it('refuses the subject teacher for a subject they do not take', async () => {
      const response = await post('teacher2', '/api/v1/lms/courses', {
        campusId: tenant.campusId,
        academicYearId: tenant.academicYearId,
        classLevelId: tenant.classLevelId,
        subjectId: subjectBId,
        title: 'An English course from the Bangla teacher',
      });
      expect(response.status).toBe(404);
    });

    it('denies creation to a student (no lms.manage)', async () => {
      const response = await post('student1', '/api/v1/lms/courses', {
        campusId: tenant.campusId,
        academicYearId: tenant.academicYearId,
        classLevelId: tenant.classLevelId,
        subjectId: subjectBId,
        title: 'A student teaching the class',
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
      // Authorization failures never name the missing permission.
      expect(JSON.stringify(response.body)).not.toContain('lms.manage');
    });

    it('denies the whole module to a role without lms.view (accountant)', async () => {
      const response = await get('accountant', '/api/v1/lms/courses');
      expect(response.status).toBe(403);
    });
  });

  // ── Structure ───────────────────────────────────────────────────────────────────────

  describe('structure', () => {
    it('replaces the module set as one ordered write', async () => {
      const response = await put('teacher', `/api/v1/lms/courses/${course1.id}/modules`, {
        version: 1,
        modules: [
          { title: 'Module 1: Parts of Speech', isPublished: true },
          { title: 'Module 2: Still Being Written', isPublished: false },
        ],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).toHaveLength(2);
      expect(response.body[0].sequence).toBe(1);
      expect(response.body[1].sequence).toBe(2);
      module1Id = response.body[0].id as string;
      module2Id = response.body[1].id as string;
    });

    it('replaces the lesson set of each module', async () => {
      const first = await put('teacher', `/api/v1/lms/modules/${module1Id}/lessons`, {
        version: 1,
        lessons: [
          {
            title: 'Lesson 1: Nouns',
            content: 'A noun names a person, place or thing.',
            estimatedMinutes: 30,
            isPublished: true,
          },
          { title: 'Lesson 2: Verbs (draft)', isPublished: false },
        ],
      });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body).toHaveLength(2);
      lesson1Id = first.body[0].id as string;
      lesson2Id = first.body[1].id as string;

      // A published lesson inside an unpublished module stays invisible to students.
      const second = await put('teacher', `/api/v1/lms/modules/${module2Id}/lessons`, {
        version: 1,
        lessons: [{ title: 'Hidden lesson', isPublished: true }],
      });
      expect(second.status, JSON.stringify(second.body)).toBe(200);
      hiddenLessonId = second.body[0].id as string;
    });

    it('refuses a stale optimistic-lock version with 409', async () => {
      const response = await patch('teacher', `/api/v1/lms/courses/${course1.id}`, {
        title: 'Renamed under a stale version',
        version: 999,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body.error.code).toBe('CONFLICT');
    });
  });

  // ── Draft invisibility and publishing ───────────────────────────────────────────────

  describe('visibility and publishing', () => {
    it('keeps a draft course invisible to students and guardians', async () => {
      const list = await get('student1', '/api/v1/lms/courses');
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      expect(list.body.meta.total).toBe(0);
      expect(list.body.data).toEqual([]);

      const byId = await get('student1', `/api/v1/lms/courses/${course1.id}`);
      // 404, not 403: confirming the draft exists is itself a leak.
      expect(byId.status).toBe(404);

      const asGuardian = await get('guardian1', '/api/v1/lms/courses');
      expect(asGuardian.status).toBe(200);
      expect(asGuardian.body.meta.total).toBe(0);
    });

    it('keeps another teacher’s draft invisible even to the class teacher', async () => {
      // course2 is teacher2's draft; the class teacher sees it only once it leaves draft.
      const response = await get('teacher', `/api/v1/lms/courses/${course2Id}`);
      expect(response.status).toBe(404);
    });

    it('shows the draft to an all-scope staff member (head teacher)', async () => {
      const response = await get('headteacher', `/api/v1/lms/courses/${course1.id}`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.status).toBe('draft');
    });

    it('denies publishing to a plain teacher (no lms.publish)', async () => {
      const response = await post('teacher', `/api/v1/lms/courses/${course1.id}/publish`, {
        version: 2,
      });
      expect(response.status).toBe(403);
    });

    it('publishes the course', async () => {
      const current = await get('headteacher', `/api/v1/lms/courses/${course1.id}`);
      expect(current.status).toBe(200);
      const response = await post('headteacher', `/api/v1/lms/courses/${course1.id}/publish`, {
        version: current.body.version as number,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('published');
      expect(response.body.publishedAt).toBeTruthy();
    });

    it('shows students only the published modules and lessons', async () => {
      const list = await get('student1', '/api/v1/lms/courses');
      expect(list.status).toBe(200);
      expect((list.body.data as { id: string }[]).map((row) => row.id)).toContain(course1.id);

      const course = await get('student1', `/api/v1/lms/courses/${course1.id}`);
      expect(course.status, JSON.stringify(course.body)).toBe(200);
      const modules = course.body.modules as { id: string; lessons: { id: string }[] }[];
      expect(modules).toHaveLength(1);
      expect(modules[0]!.id).toBe(module1Id);
      expect(modules[0]!.lessons).toHaveLength(1);
      expect(modules[0]!.lessons[0]!.id).toBe(lesson1Id);
      const text = JSON.stringify(course.body);
      expect(text).not.toContain('Lesson 2: Verbs');
      expect(text).not.toContain('Hidden lesson');
    });

    it('still shows the owner everything, drafts included', async () => {
      const response = await get('teacher', `/api/v1/lms/courses/${course1.id}`);
      expect(response.status).toBe(200);
      const modules = response.body.modules as { lessons: unknown[] }[];
      expect(modules).toHaveLength(2);
      expect(modules[0]!.lessons).toHaveLength(2);
    });

    it('answers 404 for a draft lesson and a lesson in an unpublished module', async () => {
      const draftLesson = await get('student1', `/api/v1/lms/lessons/${lesson2Id}`);
      expect(draftLesson.status).toBe(404);
      const hidden = await get('student1', `/api/v1/lms/lessons/${hiddenLessonId}`);
      expect(hidden.status).toBe(404);
      const visible = await get('student1', `/api/v1/lms/lessons/${lesson1Id}`);
      expect(visible.status, JSON.stringify(visible.body)).toBe(200);
      expect(visible.body.title).toBe('Lesson 1: Nouns');
    });
  });

  // ── Lesson resources ────────────────────────────────────────────────────────────────

  describe('resources', () => {
    it('lets the teacher attach a file and a link', async () => {
      const upload = await request(app.getHttpServer())
        .post(`/api/v1/lms/lessons/${lesson1Id}/resources`)
        .set('Authorization', `Bearer ${tokens['teacher']}`)
        .set('x-institution-id', tenant.institutionId)
        .attach('file', PDF_BYTES, { filename: 'nouns.pdf', contentType: 'application/pdf' });
      expect(upload.status, JSON.stringify(upload.body)).toBe(201);
      expect(upload.body.kind).toBe('file');
      expect(upload.body.mimeType).toBe('application/pdf');
      fileResourceId = upload.body.id as string;

      const link = await post('teacher', `/api/v1/lms/lessons/${lesson1Id}/resources/link`, {
        kind: 'link',
        url: 'https://example.org/grammar',
        title: 'Grammar reference',
      });
      expect(link.status, JSON.stringify(link.body)).toBe(201);
      expect(link.body.kind).toBe('link');
    });

    it('denies attaching resources to a student', async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/v1/lms/lessons/${lesson1Id}/resources`)
        .set('Authorization', `Bearer ${tokens['student1']}`)
        .set('x-institution-id', tenant.institutionId)
        .attach('file', PDF_BYTES, { filename: 'imposter.pdf', contentType: 'application/pdf' });
      expect(response.status).toBe(403);
    });

    it('gives an enrolled student the resources and a signed, expiring download URL', async () => {
      const lesson = await get('student1', `/api/v1/lms/lessons/${lesson1Id}`);
      expect(lesson.status).toBe(200);
      expect(lesson.body.resources).toHaveLength(2);

      const linkResponse = await get(
        'student1',
        `/api/v1/lms/lessons/${lesson1Id}/resources/${fileResourceId}/download`,
      );
      expect(linkResponse.status, JSON.stringify(linkResponse.body)).toBe(200);
      expect(linkResponse.body.url).toContain('/api/v1/files/download?');
      expect(linkResponse.body.url).toContain('signature=');

      // The signed URL itself is the credential — no auth header.
      const download = await request(app.getHttpServer()).get(linkResponse.body.url as string);
      expect(download.status, download.text).toBe(200);
      expect(download.headers['content-type']).toContain('application/pdf');
    });
  });

  // ── Enrolment and progress ──────────────────────────────────────────────────────────

  describe('enrolment and progress', () => {
    it('enrols students in bulk, idempotently over repeats', async () => {
      const first = await post('teacher', `/api/v1/lms/courses/${course1.id}/enrol`, {
        studentIds: [tenant.studentIds[0], tenant.studentIds[1]],
      });
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(first.body.enrolled).toBe(2);
      expect(first.body.alreadyEnrolled).toBe(0);

      const again = await post('teacher', `/api/v1/lms/courses/${course1.id}/enrol`, {
        studentIds: [tenant.studentIds[0], tenant.studentIds[1]],
      });
      expect(again.status).toBe(201);
      expect(again.body.enrolled).toBe(0);
      expect(again.body.alreadyEnrolled).toBe(2);
    });

    it('withholds the roster from students (no lms.progress.view)', async () => {
      const enrolling = await post('student1', `/api/v1/lms/courses/${course1.id}/enrol`, {
        studentIds: [tenant.studentIds[2]],
      });
      expect(enrolling.status).toBe(403);

      const roster = await get('student1', `/api/v1/lms/courses/${course1.id}/enrolments`);
      expect(roster.status).toBe(403);

      const asTeacher = await get('teacher', `/api/v1/lms/courses/${course1.id}/enrolments`);
      expect(asTeacher.status, JSON.stringify(asTeacher.body)).toBe(200);
      expect(asTeacher.body.meta.total).toBe(2);
    });

    it('records a student’s own progress, forward-only, on the server clock', async () => {
      const started = await post('student1', `/api/v1/lms/lessons/${lesson1Id}/progress`, {
        secondsSpent: 60,
      });
      expect(started.status, JSON.stringify(started.body)).toBe(201);
      expect(started.body.status).toBe('in_progress');
      expect(started.body.secondsSpent).toBe(60);
      expect(started.body.completedAt).toBeNull();

      const completed = await post('student1', `/api/v1/lms/lessons/${lesson1Id}/progress`, {
        status: 'completed',
        secondsSpent: 30,
      });
      expect(completed.status).toBe(201);
      expect(completed.body.status).toBe('completed');
      expect(completed.body.secondsSpent).toBe(90);
      expect(completed.body.completedAt).toBeTruthy();

      // Completion cannot be walked back by a later report.
      const relapse = await post('student1', `/api/v1/lms/lessons/${lesson1Id}/progress`, {
        status: 'in_progress',
      });
      expect(relapse.status).toBe(201);
      expect(relapse.body.status).toBe('completed');
    });

    it('refuses progress from a non-student principal', async () => {
      const response = await post('guardian1', `/api/v1/lms/lessons/${lesson1Id}/progress`, {
        secondsSpent: 10,
      });
      expect(response.status).toBe(403);
    });

    it('computes the completion report in SQL over published lessons only', async () => {
      const response = await get(
        'teacher',
        `/api/v1/lms/reports/completion?courseId=${course1.id}`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.enrolled).toBe(2);
      // Only lesson 1 counts: lesson 2 is a draft, and the hidden lesson's module is unpublished.
      expect(response.body.publishedLessons).toBe(1);
      expect(response.body.studentsCompletedAll).toBe(1);
      expect(response.body.completionPercent).toBe('50.00');
      const lessons = response.body.lessons as { lessonId: string; completionPercent: string }[];
      expect(lessons[0]!.lessonId).toBe(lesson1Id);
      expect(lessons[0]!.completionPercent).toBe('50.00');

      const asStudent = await get(
        'student1',
        `/api/v1/lms/reports/completion?courseId=${course1.id}`,
      );
      expect(asStudent.status).toBe(403);
    });
  });

  // ── Quizzes and the answer key ──────────────────────────────────────────────────────

  describe('quizzes and the answer key', () => {
    it('creates a quiz with all four question kinds', async () => {
      const response = await post('teacher', '/api/v1/lms/quizzes', {
        courseId: course1.id,
        title: 'Unit 1 quiz',
        totalMarks: '10.00',
        passMarks: '4.00',
        timeLimitMinutes: 30,
        attemptsAllowed: 2,
        questions: [
          {
            kind: 'mcq_single',
            prompt: 'Which word is a noun?',
            marks: '4.00',
            options: [
              { text: 'run' },
              { text: 'Dhaka', isCorrect: true },
              { text: 'quickly' },
            ],
          },
          {
            kind: 'mcq_multi',
            prompt: 'Select every vowel.',
            marks: '3.00',
            options: [
              { text: 'a', isCorrect: true },
              { text: 'b' },
              { text: 'e', isCorrect: true },
              { text: 'k' },
            ],
          },
          {
            kind: 'true_false',
            prompt: 'A sentence ends with a full stop.',
            marks: '2.00',
            options: [{ text: 'True', isCorrect: true }, { text: 'False' }],
          },
          {
            kind: 'short_text',
            prompt: 'Use the word "river" in a sentence.',
            marks: '1.00',
          },
        ],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('draft');
      expect(response.body.questionCount).toBe(4);
      quiz1Id = response.body.id as string;
    });

    it('denies publishing the quiz to a plain teacher, then the head teacher publishes', async () => {
      const denied = await post('teacher', `/api/v1/lms/quizzes/${quiz1Id}/publish`, {
        version: 1,
      });
      expect(denied.status).toBe(403);

      const published = await post('headteacher', `/api/v1/lms/quizzes/${quiz1Id}/publish`, {
        version: 1,
      });
      expect(published.status, JSON.stringify(published.body)).toBe(201);
      expect(published.body.status).toBe('published');
    });

    it('gives the managing teacher the full definition, answer key included', async () => {
      const response = await get('teacher', `/api/v1/lms/quizzes/${quiz1Id}`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      quiz1Questions = response.body.questions as ManagerQuestion[];
      expect(quiz1Questions).toHaveLength(4);
      // Positive control: the manager view DOES carry the key, so the student-side
      // assertions below are proving redaction, not absence.
      expect(JSON.stringify(response.body)).toContain('isCorrect');
    });

    it('gives a student metadata only — no questions, no options, no answer key', async () => {
      const response = await get('student1', `/api/v1/lms/quizzes/${quiz1Id}`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.title).toBe('Unit 1 quiz');
      expect(response.body.questions).toBeUndefined();
      expectNoAnswerKey(response.body);
    });
  });

  // ── Attempts ────────────────────────────────────────────────────────────────────────

  describe('attempts', () => {
    it('refuses a start from a student who is not enrolled in the course, with 404', async () => {
      const response = await post('student3', `/api/v1/lms/quizzes/${quiz1Id}/attempts`);
      expect(response.status, JSON.stringify(response.body)).toBe(404);
    });

    it('starts an attempt with server-stamped start and redacted questions', async () => {
      const response = await post('student1', `/api/v1/lms/quizzes/${quiz1Id}/attempts`);
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.attemptNumber).toBe(1);
      expect(response.body.startedAt).toBeTruthy();
      expect(response.body.timeLimitMinutes).toBe(30);
      const questions = response.body.questions as { options: unknown[] }[];
      expect(questions).toHaveLength(4);
      expectNoAnswerKey(response.body);
      attempt1Id = response.body.id as string;
    });

    it('refuses a second start while an attempt is open', async () => {
      const response = await post('student1', `/api/v1/lms/quizzes/${quiz1Id}/attempts`);
      expect(response.status).toBe(409);
    });

    it('auto-grades mcq_single, mcq_multi and true_false; queues short_text', async () => {
      const single = optionsOf('mcq_single');
      const multi = optionsOf('mcq_multi');
      const trueFalse = optionsOf('true_false');
      const short = optionsOf('short_text');

      const response = await post('student1', `/api/v1/lms/attempts/${attempt1Id}/submit`, {
        answers: [
          { questionId: single.question.id, selectedOptionIds: [single.correct[0]] },
          { questionId: multi.question.id, selectedOptionIds: multi.correct },
          { questionId: trueFalse.question.id, selectedOptionIds: [trueFalse.wrong[0]] },
          { questionId: short.question.id, textAnswer: 'The river flows past our school.' },
        ],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.submittedAt).toBeTruthy();
      // The short-text answer awaits manual marking, so the attempt is not yet graded.
      expect(response.body.isGraded).toBe(false);
      expect(response.body.score).toBeNull();
      expectNoAnswerKey(response.body);

      const answers = response.body.answers as {
        id: string;
        questionId: string;
        marksAwarded: string | null;
      }[];
      const markOf = (questionId: string) =>
        answers.find((answer) => answer.questionId === questionId)!.marksAwarded;
      expect(markOf(single.question.id)).toBe('4.00'); // right choice, full marks
      expect(markOf(multi.question.id)).toBe('3.00'); // exact correct set
      expect(markOf(trueFalse.question.id)).toBe('0.00'); // wrong choice
      expect(markOf(short.question.id)).toBeNull(); // queued for manual grading
      shortAnswerId = answers.find((answer) => answer.questionId === short.question.id)!.id;
    });

    it('a submitted attempt is immutable', async () => {
      const response = await post('student1', `/api/v1/lms/attempts/${attempt1Id}/submit`, {
        answers: [],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(409);
    });

    it('shows the attempt to its owner and linked guardian, never another student', async () => {
      const own = await get('student1', `/api/v1/lms/attempts/${attempt1Id}`);
      expect(own.status, JSON.stringify(own.body)).toBe(200);
      expectNoAnswerKey(own.body);

      const guardian = await get('guardian1', `/api/v1/lms/attempts/${attempt1Id}`);
      expect(guardian.status).toBe(200);

      const rival = await get('student2', `/api/v1/lms/attempts/${attempt1Id}`);
      // 404, not 403: student2 must not even learn the attempt exists.
      expect(rival.status).toBe(404);
    });

    it('grades an all-or-nothing multi and an unanswered short_text as zero', async () => {
      const started = await post('student1', `/api/v1/lms/quizzes/${quiz1Id}/attempts`);
      expect(started.status, JSON.stringify(started.body)).toBe(201);
      expect(started.body.attemptNumber).toBe(2);
      attempt2Id = started.body.id as string;

      const single = optionsOf('mcq_single');
      const multi = optionsOf('mcq_multi');
      const trueFalse = optionsOf('true_false');

      const response = await post('student1', `/api/v1/lms/attempts/${attempt2Id}/submit`, {
        answers: [
          { questionId: single.question.id, selectedOptionIds: [single.wrong[0]] },
          // One right and one wrong: without partial credit this is all-or-nothing zero.
          {
            questionId: multi.question.id,
            selectedOptionIds: [multi.correct[0], multi.wrong[0]],
          },
          { questionId: trueFalse.question.id, selectedOptionIds: [trueFalse.correct[0]] },
          // The short_text question is left unanswered: a zero, not a pending mark.
        ],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.isGraded).toBe(true);
      expect(response.body.score).toBe('2.00');
    });

    it('refuses an attempt beyond attempts_allowed', async () => {
      const response = await post('student1', `/api/v1/lms/quizzes/${quiz1Id}/attempts`);
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(JSON.stringify(response.body)).toMatch(/allowed attempt/);
    });
  });

  // ── The time limit ──────────────────────────────────────────────────────────────────

  describe('time limit', () => {
    it('sets up a published one-minute quiz and an attempt started in the past', async () => {
      const created = await post('teacher', '/api/v1/lms/quizzes', {
        courseId: course1.id,
        title: 'Speed round',
        totalMarks: '5.00',
        passMarks: '2.00',
        timeLimitMinutes: 1,
        attemptsAllowed: 1,
        questions: [
          {
            kind: 'mcq_single',
            prompt: 'Pick the noun.',
            marks: '5.00',
            options: [{ text: 'school', isCorrect: true }, { text: 'slowly' }],
          },
        ],
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      quiz2Id = created.body.id as string;

      const published = await post('headteacher', `/api/v1/lms/quizzes/${quiz2Id}/publish`, {
        version: 1,
      });
      expect(published.status, JSON.stringify(published.body)).toBe(201);

      const started = await post('student2', `/api/v1/lms/quizzes/${quiz2Id}/attempts`);
      expect(started.status, JSON.stringify(started.body)).toBe(201);
      expiredAttemptId = started.body.id as string;

      // Move started_at into the past underneath the service — the creation timestamp moves
      // with it, so no created/started ordering check can mask what is being tested.
      const client = testClient();
      await client.connect();
      try {
        await client.query(
          `update quiz_attempts
             set started_at = now() - interval '10 minutes',
                 created_at = now() - interval '15 minutes'
           where id = $1`,
          [expiredAttemptId],
        );
      } finally {
        await client.end();
      }
    });

    it('judges the limit by the server clock from started_at, whatever the client claims', async () => {
      const response = await post('student2', `/api/v1/lms/attempts/${expiredAttemptId}/submit`, {
        answers: [],
        // A client trying to state its own timing; the schema carries no such fields and
        // zod strips them before the service ever sees the body.
        elapsedSeconds: 5,
        submittedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
      });
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(response.body)).toMatch(/time limit/i);
    });
  });

  // ── Manual grading ──────────────────────────────────────────────────────────────────

  describe('manual grading', () => {
    it('lists only attempts still awaiting a manual mark', async () => {
      const response = await get(
        'teacher',
        `/api/v1/lms/quizzes/${quiz1Id}/attempts?pendingGrading=true`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const ids = (response.body.data as { id: string }[]).map((row) => row.id);
      expect(ids).toContain(attempt1Id);
      expect(ids).not.toContain(attempt2Id);
    });

    it('denies the attempt list and grading to a student', async () => {
      const list = await get('student1', `/api/v1/lms/quizzes/${quiz1Id}/attempts`);
      expect(list.status).toBe(403);

      const grading = await post('student1', `/api/v1/lms/answers/${shortAnswerId}/grade`, {
        marks: '1.00',
      });
      expect(grading.status).toBe(403);
    });

    it('rejects marks above the question maximum', async () => {
      const response = await post('teacher', `/api/v1/lms/answers/${shortAnswerId}/grade`, {
        marks: '2.00',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(422);
    });

    it('grades the short-text answer and recomputes the attempt score', async () => {
      const response = await post('teacher', `/api/v1/lms/answers/${shortAnswerId}/grade`, {
        marks: '1.00',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.marksAwarded).toBe('1.00');
      expect(response.body.gradedAt).toBeTruthy();
      // 4.00 + 3.00 + 0.00 + 1.00, summed in exact hundredths.
      expect(response.body.attempt.isGraded).toBe(true);
      expect(response.body.attempt.score).toBe('8.00');
      // The __audit hint never reaches the client.
      expect(response.body.__audit).toBeUndefined();
    });

    it('refuses to change a settled mark without a reason', async () => {
      const response = await post('teacher', `/api/v1/lms/answers/${shortAnswerId}/grade`, {
        marks: '0.50',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(JSON.stringify(response.body)).toMatch(/reason/i);
    });

    it('re-grades with a reason and audits before/after in the same transaction', async () => {
      const response = await post('teacher', `/api/v1/lms/answers/${shortAnswerId}/grade`, {
        marks: '0.50',
        reason: 'The sentence does not use the word correctly',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.marksAwarded).toBe('0.50');
      expect(response.body.attempt.score).toBe('7.50');

      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query(
          `select previous_value, new_value, reason
           from audit_logs
           where module = 'lms'
             and resource_type = 'quiz_answer'
             and action = 'update'
             and tenant_id = $1
           order by occurred_at desc`,
          [tenant.tenantId],
        );
        // Exactly two: the first grading and the re-grade. The route's recordedBy: 'service'
        // keeps the interceptor from writing a duplicate, before-less row for each.
        expect(rows).toHaveLength(2);
        expect(rows[0].previous_value.marksAwarded).toBe('1.00');
        expect(rows[0].new_value.marksAwarded).toBe('0.50');
        expect(rows[0].reason).toMatch(/does not use the word/);
        // The first grading of a fresh answer carries no before-state.
        expect(rows[1].previous_value).toBeNull();
        expect(rows[1].new_value.marksAwarded).toBe('1.00');
      } finally {
        await client.end();
      }
    });

    it('pivots the gradebook to the best graded score per student and quiz', async () => {
      const response = await get('teacher', `/api/v1/lms/courses/${course1.id}/gradebook`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect((response.body.quizzes as { id: string }[]).map((row) => row.id)).toEqual(
        expect.arrayContaining([quiz1Id, quiz2Id]),
      );
      const students = response.body.students as {
        studentId: string;
        scores: Record<string, string | null>;
      }[];
      expect(students).toHaveLength(2);
      const student1Row = students.find((row) => row.studentId === tenant.studentIds[0])!;
      // Best graded score across attempts: max(7.50 after the re-grade, 2.00).
      expect(student1Row.scores[quiz1Id]).toBe('7.50');

      const asStudent = await get('student1', `/api/v1/lms/courses/${course1.id}/gradebook`);
      expect(asStudent.status).toBe(403);
    });
  });

  // ── Tenant isolation and the database contract ──────────────────────────────────────

  describe('tenant isolation and the database contract', () => {
    it('another tenant cannot read a course or quiz by its exact id', async () => {
      const course = await request(app.getHttpServer())
        .get(`/api/v1/lms/courses/${course1.id}`)
        .set('Authorization', `Bearer ${tokens['otherOwner']}`)
        .set('x-institution-id', other.institutionId);
      // 404, not 403: confirming the record exists elsewhere is itself a leak.
      expect(course.status, JSON.stringify(course.body)).toBe(404);
      expect(JSON.stringify(course.body)).not.toContain('English Foundations');

      const quiz = await request(app.getHttpServer())
        .get(`/api/v1/lms/quizzes/${quiz1Id}`)
        .set('Authorization', `Bearer ${tokens['otherOwner']}`)
        .set('x-institution-id', other.institutionId);
      expect(quiz.status).toBe(404);
    });

    it('refuses a borrowed institution header outright', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/lms/courses/${course1.id}`)
        .set('Authorization', `Bearer ${tokens['otherOwner']}`)
        .set('x-institution-id', tenant.institutionId);
      expect(response.status).toBe(403);
    });

    it('gives the other tenant an empty, not leaky, list', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/lms/courses')
        .set('Authorization', `Bearer ${tokens['otherOwner']}`)
        .set('x-institution-id', other.institutionId);
      expect(response.status).toBe(200);
      expect(response.body.meta.total).toBe(0);
      expect(response.body.data).toEqual([]);
    });

    it('every LMS table has forced RLS with the tenant_isolation policy', async () => {
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
           where n.nspname = 'public' and c.relname = any ($1::text[])`,
          [LMS_TABLES],
        );
        expect(rows).toHaveLength(LMS_TABLES.length);
        for (const row of rows) {
          expect(row.relrowsecurity, `${row.relname} rowsecurity`).toBe(true);
          expect(row.relforcerowsecurity, `${row.relname} force`).toBe(true);
          expect(row.has_policy, `${row.relname} policy`).toBe(true);
        }
      } finally {
        await client.end();
      }
    });

    it('every LMS table carries the set_updated_at trigger', async () => {
      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query(
          `select c.relname
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           join pg_trigger t on t.tgrelid = c.oid
           where n.nspname = 'public'
             and t.tgname = 'set_updated_at'
             and not t.tgisinternal
             and c.relname = any ($1::text[])`,
          [LMS_TABLES],
        );
        expect(rows.map((row) => row.relname as string).sort()).toEqual([...LMS_TABLES].sort());
      } finally {
        await client.end();
      }
    });

    it('the database itself refuses a duplicate (quiz, student, attempt) row', async () => {
      const client = testClient();
      await client.connect();
      try {
        await expect(
          client.query(
            `insert into quiz_attempts
               (id, tenant_id, institution_id, quiz_id, student_id, attempt_number)
             values ($1,$2,$3,$4,$5,1)`,
            [uuidv7(), tenant.tenantId, tenant.institutionId, quiz1Id, tenant.studentIds[0]],
          ),
        ).rejects.toMatchObject({ code: '23505', constraint: 'quiz_attempts_attempt_key' });
      } finally {
        await client.end();
      }
    });

    it('the database refuses a resource with neither a storage key nor a URL', async () => {
      const client = testClient();
      await client.connect();
      try {
        await expect(
          client.query(
            `insert into lesson_resources
               (id, tenant_id, institution_id, lesson_id, kind, title)
             values ($1,$2,$3,$4,'link','Broken resource')`,
            [uuidv7(), tenant.tenantId, tenant.institutionId, lesson1Id],
          ),
        ).rejects.toMatchObject({
          code: '23514',
          constraint: 'lesson_resources_exactly_one_source',
        });
      } finally {
        await client.end();
      }
    });

    it('the database refuses a quiz anchored on neither a course nor a lesson', async () => {
      const client = testClient();
      await client.connect();
      try {
        await expect(
          client.query(
            `insert into quizzes
               (id, tenant_id, institution_id, title, total_marks, pass_marks)
             values ($1,$2,$3,'No anchor quiz','10.00','5.00')`,
            [uuidv7(), tenant.tenantId, tenant.institutionId],
          ),
        ).rejects.toMatchObject({ code: '23514', constraint: 'quizzes_exactly_one_anchor' });
      } finally {
        await client.end();
      }
    });
  });
});
