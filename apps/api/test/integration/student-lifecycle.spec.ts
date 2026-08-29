/**
 * Student lifecycle (Phase 3 completion): standalone enrolment, promotion, transfers,
 * withdrawal and readmission, status history, CSV import/export, documents, bulk operations.
 *
 * The properties under test are the release-blocking ones, not the plumbing:
 *
 *  - capacity and double-enrolment are refused at the service, with the partial unique
 *    indexes as backstop;
 *  - promotion is idempotent per (student, target year), retention is an explicit choice,
 *    and an unpaid-dues hold (an outstanding invoice) skips a student without failing the run;
 *  - an inter-institution transfer writes status history on **both** sides in one transaction;
 *  - import validation writes nothing, and an import commit is atomic;
 *  - export applies the caller's data scope — a teacher gets only assigned students — and
 *    medical fields appear only for holders of `students.medical.view`;
 *  - document downloads are signed and expiring, never static;
 *  - a section id from another institution of the same tenant is a 404 (the case RLS cannot
 *    catch), and everything cross-tenant is a 404;
 *  - every sensitive denial is a denial, not a filtered success.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { uuidv7 } from '@shikkha/shared';
import {
  createTestApp,
  seedTenant,
  testClient,
  truncateAll,
  TEST_PASSWORD,
  type SeededTenant,
} from '../helpers/test-app';

/** Matches the default in `config/env.ts`; the test env does not override it. */
const STORAGE_URL_SECRET = 'local-storage-signing-key-dev';

const PDF_BYTES = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
);

describe('student lifecycle (Phase 3 completion)', () => {
  let app: INestApplication;
  let tenant: SeededTenant;
  let rival: SeededTenant;
  const tokens: Record<string, string> = {};

  // Fixtures created on top of the seeded tenant.
  let nextYearId = '';
  let classC7Id = '';
  let targetSectionId = ''; // 2027, Class 7
  let repeatSectionId = ''; // 2027, Class 6 (for retained students)
  let sectionCId = ''; // 2026, Class 6, second section
  let tinySectionId = ''; // 2026, Class 6, capacity 1
  let student6Id = ''; // enrolled in section C — outside the teacher's assignments
  let freshStudentA = ''; // no enrolment at seed time
  let freshStudentB = ''; // no enrolment at seed time
  let institutionBId = '';
  let sectionBId = ''; // a section inside institution B

  async function login(email: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: email, password: TEST_PASSWORD });
    expect(response.status, `login failed for ${email}: ${JSON.stringify(response.body)}`).toBe(
      200,
    );
    return response.body.accessToken as string;
  }

  const api = () => request(app.getHttpServer());
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

  async function sqlOne<T = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<T | undefined> {
    const client = testClient();
    await client.connect();
    try {
      const result = await client.query(text, params);
      return result.rows[0] as T | undefined;
    } finally {
      await client.end();
    }
  }

  async function sqlAll<T = Record<string, unknown>>(
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
    tenant = await seedTenant('life', { students: 5 });
    rival = await seedTenant('rival', { students: 2 });

    const client = testClient();
    await client.connect();
    try {
      await client.query('begin');

      // The next academic year, the next class level, and the promotion target sections.
      nextYearId = uuidv7();
      await client.query(
        `insert into academic_years (id, tenant_id, institution_id, name, start_date, end_date, status, is_current)
         values ($1,$2,$3,'2027','2027-01-01','2027-12-31','planning',false)`,
        [nextYearId, tenant.tenantId, tenant.institutionId],
      );
      classC7Id = uuidv7();
      await client.query(
        `insert into class_levels (id, tenant_id, institution_id, code, name_en, ordinal)
         values ($1,$2,$3,'C7','Class 7',8)`,
        [classC7Id, tenant.tenantId, tenant.institutionId],
      );
      targetSectionId = uuidv7();
      await client.query(
        `insert into sections (id, tenant_id, institution_id, campus_id, academic_year_id, class_level_id, name_en, capacity)
         values ($1,$2,$3,$4,$5,$6,'A',60)`,
        [
          targetSectionId,
          tenant.tenantId,
          tenant.institutionId,
          tenant.campusId,
          nextYearId,
          classC7Id,
        ],
      );
      repeatSectionId = uuidv7();
      await client.query(
        `insert into sections (id, tenant_id, institution_id, campus_id, academic_year_id, class_level_id, name_en, capacity)
         values ($1,$2,$3,$4,$5,$6,'R',60)`,
        [
          repeatSectionId,
          tenant.tenantId,
          tenant.institutionId,
          tenant.campusId,
          nextYearId,
          tenant.classLevelId,
        ],
      );

      // A second 2026 section and a capacity-1 section, both Class 6.
      sectionCId = uuidv7();
      await client.query(
        `insert into sections (id, tenant_id, institution_id, campus_id, academic_year_id, class_level_id, name_en, capacity)
         values ($1,$2,$3,$4,$5,$6,'C',60)`,
        [
          sectionCId,
          tenant.tenantId,
          tenant.institutionId,
          tenant.campusId,
          tenant.academicYearId,
          tenant.classLevelId,
        ],
      );
      tinySectionId = uuidv7();
      await client.query(
        `insert into sections (id, tenant_id, institution_id, campus_id, academic_year_id, class_level_id, name_en, capacity)
         values ($1,$2,$3,$4,$5,$6,'T',1)`,
        [
          tinySectionId,
          tenant.tenantId,
          tenant.institutionId,
          tenant.campusId,
          tenant.academicYearId,
          tenant.classLevelId,
        ],
      );

      // Student 6 sits in section C — visible to admins, invisible to the class teacher of A.
      student6Id = uuidv7();
      await client.query(
        `insert into students (id, tenant_id, institution_id, student_code, admission_number, admission_date, full_name_en, date_of_birth, gender, status)
         values ($1,$2,$3,'life-S6','life-A6','2026-01-05','life Outsider Six','2014-04-10','female','active')`,
        [student6Id, tenant.tenantId, tenant.institutionId],
      );
      await client.query(
        `insert into enrollments (id, tenant_id, institution_id, campus_id, student_id, academic_year_id, class_level_id, section_id, roll_number, status, enrolled_on)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'1','active','2026-01-05')`,
        [
          uuidv7(),
          tenant.tenantId,
          tenant.institutionId,
          tenant.campusId,
          student6Id,
          tenant.academicYearId,
          tenant.classLevelId,
          sectionCId,
        ],
      );

      // Two students with no enrolment, for the standalone enrolment and withdrawal tests.
      freshStudentA = uuidv7();
      freshStudentB = uuidv7();
      await client.query(
        `insert into students (id, tenant_id, institution_id, student_code, admission_number, admission_date, full_name_en, date_of_birth, gender, status)
         values ($1,$2,$3,'life-S7','life-A7','2026-01-05','life Fresh Seven','2014-07-01','male','active'),
                ($4,$2,$3,'life-S8','life-A8','2026-01-05','life Fresh Eight','2014-08-01','male','active')`,
        [freshStudentA, tenant.tenantId, tenant.institutionId, freshStudentB],
      );

      // Medical data on student 1 — must never reach an exporter without the permission.
      await client.query(
        `update students set medical_conditions = 'Asthma — salbutamol inhaler' where id = $1`,
        [tenant.studentIds[0]],
      );

      // The unpaid-dues hold for promotion: an issued invoice with an outstanding balance.
      await client.query(
        `insert into invoices (id, tenant_id, institution_id, student_id, academic_year_id, invoice_number,
                               billing_period_start, billing_period_end, issue_date, due_date,
                               subtotal, total, paid_total, balance, status)
         values ($1,$2,$3,$4,$5,'INV-2026-00001','2026-01-01','2026-01-31','2026-01-01','2026-01-15',
                 '500.00','500.00','0.00','500.00','issued')`,
        [
          uuidv7(),
          tenant.tenantId,
          tenant.institutionId,
          tenant.studentIds[1],
          tenant.academicYearId,
        ],
      );

      // The teacher may export (scoped): roles are ordinary rows, so grant it in data.
      await client.query(
        `update roles set permissions = permissions || '["students.export"]'::jsonb where id = $1`,
        [tenant.roleIds['teacher']],
      );

      // A second institution in the same tenant — the cross-institution reference target.
      institutionBId = uuidv7();
      await client.query(
        `insert into institutions (id, tenant_id, code, name_en, type, medium)
         values ($1,$2,'life-B','life Second Institution','school','bangla')`,
        [institutionBId, tenant.tenantId],
      );
      const campusBId = uuidv7();
      await client.query(
        `insert into campuses (id, tenant_id, institution_id, code, name_en, is_primary)
         values ($1,$2,$3,'MAIN','life B Campus',true)`,
        [campusBId, tenant.tenantId, institutionBId],
      );
      const yearBId = uuidv7();
      await client.query(
        `insert into academic_years (id, tenant_id, institution_id, name, start_date, end_date, status, is_current)
         values ($1,$2,$3,'2026B','2026-01-01','2026-12-31','active',true)`,
        [yearBId, tenant.tenantId, institutionBId],
      );
      const classBId = uuidv7();
      await client.query(
        `insert into class_levels (id, tenant_id, institution_id, code, name_en, ordinal)
         values ($1,$2,$3,'C7B','Class 7',8)`,
        [classBId, tenant.tenantId, institutionBId],
      );
      sectionBId = uuidv7();
      await client.query(
        `insert into sections (id, tenant_id, institution_id, campus_id, academic_year_id, class_level_id, name_en, capacity)
         values ($1,$2,$3,$4,$5,$6,'A',60)`,
        [sectionBId, tenant.tenantId, institutionBId, campusBId, yearBId, classBId],
      );

      // The principal also administers institution B — needed to transfer students into it.
      await client.query(
        `insert into user_roles (id, tenant_id, user_id, role_id, institution_id)
         values ($1,$2,$3,$4,$5)`,
        [
          uuidv7(),
          tenant.tenantId,
          tenant.users['principal']!.id,
          tenant.roleIds['principal'],
          institutionBId,
        ],
      );

      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }

    tokens['owner'] = await login(tenant.users['owner']!.email);
    tokens['principal'] = await login(tenant.users['principal']!.email);
    tokens['admin'] = await login(tenant.users['admin']!.email);
    tokens['teacher'] = await login(tenant.users['teacher']!.email);
    tokens['guardian1'] = await login(tenant.users['guardian1']!.email);
    tokens['guardian2'] = await login(tenant.users['guardian2']!.email);
    tokens['rivalAdmin'] = await login(rival.users['admin']!.email);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  // ── Export: scope and redaction ────────────────────────────────────────────────────
  // These run first: the teacher's "assigned" scope is defined by *active* enrolments in
  // section A, which the transfer and promotion tests below deliberately close.

  it('a teacher exports only their assigned students', async () => {
    const response = await api().get('/api/v1/students/export?format=csv').set(auth('teacher'));

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    const text = response.text as string;
    // Header + the 5 students of section A; the section-C student never appears.
    const dataLines = text.trim().split('\r\n').slice(1);
    expect(dataLines.length).toBe(5);
    expect(text).toContain('life Student 1');
    expect(text).not.toContain('life Outsider Six');
  });

  it('export redacts medical fields unless students.medical.view is held', async () => {
    const admin = await api().get('/api/v1/students/export?format=csv').set(auth('admin'));
    expect(admin.status).toBe(200);
    // The administrator sees every student of the institution (5 seeded + the section-C
    // student + the two not-yet-enrolled ones) — but no medical column at all.
    expect(admin.text.trim().split('\r\n').slice(1).length).toBe(8);
    expect(admin.text).not.toContain('medicalConditions');
    expect(admin.text).not.toContain('Asthma');

    const owner = await api().get('/api/v1/students/export?format=json').set(auth('owner'));
    expect(owner.status).toBe(200);
    const rows = JSON.parse(owner.text) as Array<Record<string, unknown>>;
    const withMedical = rows.find((row) => row['id'] === tenant.studentIds[0]);
    expect(withMedical?.['medicalConditions']).toContain('Asthma');
  });

  it('every export writes an audit record', async () => {
    const rows = await sqlAll(
      `select 1 from audit_logs where module = 'students' and action = 'export' and resource_type = 'student_export' and tenant_id = $1`,
      [tenant.tenantId],
    );
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });

  it('a guardian cannot export at all', async () => {
    const response = await api().get('/api/v1/students/export').set(auth('guardian1'));
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  // ── Import: validate writes nothing; commit is atomic ─────────────────────────────

  const countStudents = async (): Promise<number> => {
    const row = await sqlOne<{ n: string }>(
      `select count(*)::text as n from students where tenant_id = $1`,
      [tenant.tenantId],
    );
    return Number(row!.n);
  };

  it('import validate reports per-row results and writes nothing', async () => {
    const before = await countStudents();
    const csv = [
      'fullNameEn,dateOfBirth,gender,admissionDate',
      'Imported Alpha,2014-03-01,male,2026-01-10',
      'Imported Beta,2014-04-02,female,2026-01-10',
      // Same name and date of birth as a seeded student: the duplicate detector must fire.
      'life Student 3,2014-05-10,male,2026-01-10',
      'Broken Row,2014-05-10,not_a_gender,2026-01-10',
    ].join('\r\n');

    const response = await api()
      .post('/api/v1/students/import/validate')
      .set(auth('admin'))
      .set('x-institution-id', tenant.institutionId)
      .send({ csv });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.totalRows).toBe(4);
    expect(response.body.valid).toBe(2);
    expect(response.body.duplicates).toBe(1);
    expect(response.body.errors).toBe(1);

    const duplicate = response.body.rows.find((r: { row: number }) => r.row === 3);
    expect(duplicate.status).toBe('duplicate');
    expect(duplicate.existingStudentId).toBe(tenant.studentIds[2]);

    const broken = response.body.rows.find((r: { row: number }) => r.row === 4);
    expect(broken.status).toBe('error');
    expect(JSON.stringify(broken.issues)).toContain('gender');

    expect(await countStudents()).toBe(before);
  });

  it('import commit refuses a file with any invalid row and writes nothing', async () => {
    const before = await countStudents();
    const csv = [
      'fullNameEn,dateOfBirth,gender,admissionDate',
      'Imported Gamma,2014-03-01,male,2026-01-10',
      'Broken Row,2014-05-10,not_a_gender,2026-01-10',
    ].join('\r\n');

    const response = await api()
      .post('/api/v1/students/import/commit')
      .set(auth('admin'))
      .set('x-institution-id', tenant.institutionId)
      .send({ csv });

    expect(response.status).toBe(422);
    expect(await countStudents()).toBe(before);
  });

  it('import commit inserts valid rows, skips duplicates, and reports a summary', async () => {
    const before = await countStudents();
    const csv = [
      'fullNameEn,dateOfBirth,gender,admissionDate',
      'Imported Alpha,2014-03-01,male,2026-01-10',
      'Imported Beta,2014-04-02,female,2026-01-10',
      'life Student 3,2014-05-10,male,2026-01-10',
    ].join('\r\n');

    const response = await api()
      .post('/api/v1/students/import/commit')
      .set(auth('admin'))
      .set('x-institution-id', tenant.institutionId)
      .send({ csv });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.inserted).toBe(2);
    expect(response.body.duplicates).toBe(1);
    expect(response.body.insertedStudentIds).toHaveLength(2);
    expect(await countStudents()).toBe(before + 2);

    // Each import lands as domain history, and the whole batch as one audit record.
    const history = await sqlAll(
      `select 1 from student_status_history where student_id = any($1::uuid[]) and event = 'admitted'`,
      [response.body.insertedStudentIds],
    );
    expect(history.length).toBe(2);
  });

  it('rejects an oversized import', async () => {
    const rows = ['fullNameEn,dateOfBirth,gender,admissionDate'];
    for (let i = 0; i < 501; i += 1) rows.push(`Bulk Person ${i},2014-01-01,male,2026-01-10`);
    // Keep under the byte cap so the row cap is what fires.
    const response = await api()
      .post('/api/v1/students/import/validate')
      .set(auth('admin'))
      .set('x-institution-id', tenant.institutionId)
      .send({ csv: rows.join('\n') });
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).toContain('500');
  });

  // ── Standalone enrolment ──────────────────────────────────────────────────────────

  it('enrols an existing student and writes status history', async () => {
    const response = await api()
      .post(`/api/v1/students/${freshStudentA}/enroll`)
      .set(auth('principal'))
      .set('x-institution-id', tenant.institutionId)
      .send({
        academicYearId: tenant.academicYearId,
        sectionId: tinySectionId,
        rollNumber: '1',
        enrolledOn: '2026-02-01',
      });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.sectionId).toBe(tinySectionId);
    expect(response.body.status).toBe('active');

    const history = await api()
      .get(`/api/v1/students/${freshStudentA}/status-history`)
      .set(auth('owner'));
    expect(history.status).toBe(200);
    expect(history.body.map((h: { event: string }) => h.event)).toContain('enrolled');
  });

  it('rejects enrolment beyond section capacity', async () => {
    const response = await api()
      .post(`/api/v1/students/${freshStudentB}/enroll`)
      .set(auth('principal'))
      .set('x-institution-id', tenant.institutionId)
      .send({
        academicYearId: tenant.academicYearId,
        sectionId: tinySectionId,
        rollNumber: '2',
        enrolledOn: '2026-02-01',
      });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toContain('full');
  });

  it('rejects a second enrolment in the same academic year', async () => {
    const response = await api()
      .post(`/api/v1/students/${tenant.studentIds[0]}/enroll`)
      .set(auth('principal'))
      .set('x-institution-id', tenant.institutionId)
      .send({
        academicYearId: tenant.academicYearId,
        sectionId: sectionCId,
        rollNumber: '9',
        enrolledOn: '2026-02-01',
      });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toContain('already enrolled');
  });

  it('rejects a section belonging to another institution of the same tenant', async () => {
    const response = await api()
      .post(`/api/v1/students/${freshStudentB}/enroll`)
      .set(auth('principal'))
      .set('x-institution-id', tenant.institutionId)
      .send({
        academicYearId: tenant.academicYearId,
        sectionId: sectionBId,
        rollNumber: '1',
        enrolledOn: '2026-02-01',
      });

    // 404, not 403: RLS cannot catch this (both rows belong to the tenant), the service
    // must — and it must not confirm what the id is.
    expect(response.status).toBe(404);
  });

  // ── Withdrawal frees the seat; readmission reopens ────────────────────────────────

  it('withdraws a student, closing the enrolment and freeing the seat', async () => {
    const withdrawal = await api()
      .post(`/api/v1/students/${freshStudentA}/withdraw`)
      .set(auth('principal'))
      .set('x-institution-id', tenant.institutionId)
      .send({
        effectiveDate: '2026-03-01',
        reason: 'Family relocated to Chattogram',
      });
    expect(withdrawal.status, JSON.stringify(withdrawal.body)).toBe(201);
    expect(withdrawal.body.status).toBe('withdrawn');

    // The enrolment row survives with a terminal status — never deleted.
    const closed = await sqlOne<{ status: string; ended_on: string }>(
      `select status, ended_on::text from enrollments where student_id = $1 order by created_at desc limit 1`,
      [freshStudentA],
    );
    expect(closed!.status).toBe('withdrawn');
    expect(closed!.ended_on).toBe('2026-03-01');

    // The seat in the capacity-1 section is free again: the other student can now enrol.
    const reuse = await api()
      .post(`/api/v1/students/${freshStudentB}/enroll`)
      .set(auth('principal'))
      .set('x-institution-id', tenant.institutionId)
      .send({
        academicYearId: tenant.academicYearId,
        sectionId: tinySectionId,
        rollNumber: '2',
        enrolledOn: '2026-03-02',
      });
    expect(reuse.status, JSON.stringify(reuse.body)).toBe(201);
  });

  it('readmits a withdrawn student with a new enrolment', async () => {
    const response = await api()
      .post(`/api/v1/students/${freshStudentA}/readmit`)
      .set(auth('principal'))
      .set('x-institution-id', tenant.institutionId)
      .send({
        academicYearId: tenant.academicYearId,
        sectionId: sectionCId,
        effectiveDate: '2026-04-01',
        reason: 'Family returned to Dhaka',
      });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.status).toBe('active');
    expect(response.body.enrollment.sectionId).toBe(sectionCId);

    const history = await api()
      .get(`/api/v1/students/${freshStudentA}/status-history`)
      .set(auth('owner'));
    const events = history.body.map((h: { event: string }) => h.event);
    expect(events).toContain('withdrawn');
    expect(events).toContain('readmitted');
  });

  // ── Status history is scope-filtered like GET /students/:id ──────────────────────

  it('a guardian reads their own child’s history and 404s on another child', async () => {
    const own = await api()
      .get(`/api/v1/students/${tenant.studentIds[0]}/status-history`)
      .set(auth('guardian1'));
    expect(own.status).toBe(200);

    const other = await api()
      .get(`/api/v1/students/${tenant.studentIds[0]}/status-history`)
      .set(auth('guardian2'));
    expect(other.status).toBe(404);
  });

  // ── Documents ─────────────────────────────────────────────────────────────────────

  let documentId = '';
  let signedUrl = '';

  it('uploads a document through the storage abstraction', async () => {
    const response = await api()
      .post(`/api/v1/students/${tenant.studentIds[0]}/documents`)
      .set(auth('admin'))
      .set('x-institution-id', tenant.institutionId)
      .field('documentType', 'birth_certificate')
      .field('title', 'Birth Certificate')
      .attach('file', PDF_BYTES, 'birth-certificate.pdf');

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    documentId = response.body.id as string;
    expect(response.body.mimeType).toBe('application/pdf');

    // The key came from the central builder: tenant-prefixed, category, uuid, extension.
    const fileRow = await sqlOne<{ storage_key: string }>(
      `select f.storage_key from student_documents d join files f on f.id = d.file_id where d.id = $1`,
      [documentId],
    );
    expect(fileRow!.storage_key).toMatch(
      new RegExp(`^tenants/${tenant.tenantId}/student_document/[0-9a-f-]{36}\\.pdf$`),
    );
  });

  it('issues a signed expiring download URL that actually serves the bytes', async () => {
    const response = await api()
      .get(`/api/v1/students/${tenant.studentIds[0]}/documents/${documentId}/download`)
      .set(auth('admin'));

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    signedUrl = response.body.url as string;
    expect(signedUrl).toContain('/api/v1/files/download?');
    expect(signedUrl).toContain('expires=');
    expect(signedUrl).toContain('signature=');

    const download = await api()
      .get(signedUrl)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toContain('application/pdf');
    expect((download.body as Buffer).toString('latin1')).toContain('%PDF');
  });

  it('refuses an expired signature even when the signature itself is valid', async () => {
    const url = new URL(signedUrl, 'http://localhost');
    const key = url.searchParams.get('key')!;
    const pastExpiry = Math.floor(Date.now() / 1000) - 60;
    const validButExpired = createHmac('sha256', STORAGE_URL_SECRET)
      .update(`${key}:${pastExpiry}`)
      .digest('hex');

    const response = await api().get(
      `/api/v1/files/download?key=${encodeURIComponent(key)}&expires=${pastExpiry}&signature=${validButExpired}`,
    );
    expect(response.status).toBe(404);
  });

  it('refuses a tampered expiry', async () => {
    const url = new URL(signedUrl, 'http://localhost');
    url.searchParams.set('expires', String(Math.floor(Date.now() / 1000) + 9999));
    const response = await api().get(`${url.pathname}?${url.searchParams.toString()}`);
    expect(response.status).toBe(404);
  });

  it('hides medical documents from callers without students.medical.view', async () => {
    const upload = await api()
      .post(`/api/v1/students/${tenant.studentIds[0]}/documents`)
      .set(auth('owner'))
      .set('x-institution-id', tenant.institutionId)
      .field('documentType', 'medical')
      .field('title', 'Treatment plan')
      .attach('file', PDF_BYTES, 'plan.pdf');
    expect(upload.status, JSON.stringify(upload.body)).toBe(201);

    const asOwner = await api()
      .get(`/api/v1/students/${tenant.studentIds[0]}/documents`)
      .set(auth('owner'));
    expect(asOwner.body.length).toBe(2);

    // The administrator manages documents but holds no medical permission: the medical
    // document is absent from the list, and its download URL endpoint 404s.
    const asAdmin = await api()
      .get(`/api/v1/students/${tenant.studentIds[0]}/documents`)
      .set(auth('admin'));
    expect(asAdmin.body.length).toBe(1);

    const medicalId = asOwner.body.find(
      (d: { documentType: string }) => d.documentType === 'medical',
    ).id as string;
    const denied = await api()
      .get(`/api/v1/students/${tenant.studentIds[0]}/documents/${medicalId}/download`)
      .set(auth('admin'));
    expect(denied.status).toBe(404);
  });

  it('soft-deletes a document and kills its already-issued URLs', async () => {
    const response = await api()
      .post(`/api/v1/students/${tenant.studentIds[0]}/documents/${documentId}/archive`)
      .set(auth('admin'))
      .set('x-institution-id', tenant.institutionId)
      .send({ reason: 'Replaced by a corrected scan' });
    expect(response.status, JSON.stringify(response.body)).toBe(201);

    // Soft delete: the row is still there, marked.
    const row = await sqlOne<{ archived_at: string | null }>(
      `select archived_at from student_documents where id = $1`,
      [documentId],
    );
    expect(row!.archived_at).not.toBeNull();

    // The previously-issued signed URL dies before its expiry.
    const download = await api().get(signedUrl);
    expect(download.status).toBe(404);
  });

  // ── Transfers ─────────────────────────────────────────────────────────────────────

  it('transfers a student between sections, preserving the old enrolment row', async () => {
    const studentId = tenant.studentIds[2]!;
    const response = await api()
      .post(`/api/v1/students/${studentId}/transfer-section`)
      .set(auth('principal'))
      .set('x-institution-id', tenant.institutionId)
      .send({
        targetSectionId: sectionCId,
        effectiveDate: '2026-05-01',
        reason: 'Balancing section sizes after readmissions',
      });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.sectionId).toBe(sectionCId);

    const rows = await sqlAll<{ section_id: string; status: string; archived_at: string | null }>(
      `select section_id, status, archived_at from enrollments where student_id = $1 order by created_at`,
      [studentId],
    );
    expect(rows.length).toBe(2);
    expect(rows[0]!.status).toBe('transferred_out');
    expect(rows[0]!.archived_at).not.toBeNull(); // soft-archived, never deleted
    expect(rows[1]!.status).toBe('active');
    expect(rows[1]!.section_id).toBe(sectionCId);
  });

  // ── Promotion ─────────────────────────────────────────────────────────────────────

  const promoteBody = () => ({
    sourceSectionId: tenant.sectionId,
    targetSectionId,
    repeatSectionId,
    effectiveDate: '2027-01-01',
    retainedStudentIds: [tenant.studentIds[4]!],
  });

  it('promotes a section with per-student outcomes: promoted, retained, dues-held', async () => {
    const response = await api()
      .post('/api/v1/students/promote')
      .set(auth('principal'))
      .set('x-institution-id', tenant.institutionId)
      .send(promoteBody());

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const outcomes = new Map(
      response.body.results.map((r: { studentId: string }) => [r.studentId, r]),
    );

    // Students 0 and 3 promote (student 2 left the section in the transfer test above).
    expect((outcomes.get(tenant.studentIds[0]) as { outcome: string }).outcome).toBe('promoted');
    expect((outcomes.get(tenant.studentIds[3]) as { outcome: string }).outcome).toBe('promoted');
    // Student 1 has an unpaid invoice: skipped, with the reason on record.
    const held = outcomes.get(tenant.studentIds[1]) as { outcome: string; reason: string };
    expect(held.outcome).toBe('skipped');
    expect(held.reason).toBe('unpaid_dues');
    // Student 4 was an explicit retention: re-enrolled in the repeat section, same class.
    const retained = outcomes.get(tenant.studentIds[4]) as { outcome: string };
    expect(retained.outcome).toBe('retained');

    expect(response.body.summary).toEqual({ promoted: 2, retained: 1, skipped: 1 });

    const repeatRow = await sqlOne<{ is_repeating: boolean; class_level_id: string }>(
      `select is_repeating, class_level_id from enrollments
       where student_id = $1 and academic_year_id = $2`,
      [tenant.studentIds[4], nextYearId],
    );
    expect(repeatRow!.is_repeating).toBe(true);
    expect(repeatRow!.class_level_id).toBe(tenant.classLevelId);
  });

  it('promotion is idempotent per (student, target academic year)', async () => {
    const before = await sqlOne<{ n: string }>(
      `select count(*)::text as n from enrollments where academic_year_id = $1`,
      [nextYearId],
    );

    const response = await api()
      .post('/api/v1/students/promote')
      .set(auth('principal'))
      .set('x-institution-id', tenant.institutionId)
      .send(promoteBody());

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.summary.promoted).toBe(0);
    expect(response.body.summary.retained).toBe(0);
    // 'not_in_source_section' is expected on a re-run: the student named as retained by the
    // first run is no longer in the source section, and enrollment.service reports a stray id
    // rather than ignoring it so a mistyped id is visible in the run report.
    for (const result of response.body.results as Array<{ studentId: string; reason: string }>) {
      expect(['already_enrolled_in_target_year', 'unpaid_dues', 'not_in_source_section']).toContain(
        result.reason,
      );
    }

    const after = await sqlOne<{ n: string }>(
      `select count(*)::text as n from enrollments where academic_year_id = $1`,
      [nextYearId],
    );
    expect(after!.n).toBe(before!.n);
  });

  // ── Inter-institution transfer ────────────────────────────────────────────────────

  it('transfers a student between institutions, writing history on both sides', async () => {
    const studentId = tenant.studentIds[0]!;
    const response = await api()
      .post(`/api/v1/students/${studentId}/transfer-institution`)
      .set(auth('principal'))
      .set('x-institution-id', tenant.institutionId)
      .send({
        targetInstitutionId: institutionBId,
        targetSectionId: sectionBId,
        effectiveDate: '2027-01-15',
        reason: 'Family moved near the second campus',
      });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.institutionId).toBe(institutionBId);
    expect(response.body.enrollment.institutionId).toBe(institutionBId);

    // Both sides of the move, in one transaction: departure on A, arrival on B.
    const history = await sqlAll<{ event: string; institution_id: string }>(
      `select event, institution_id from student_status_history
       where student_id = $1 and event in ('transferred_out', 'transferred_in')`,
      [studentId],
    );
    expect(history.length).toBe(2);
    const out = history.find((h) => h.event === 'transferred_out');
    const incoming = history.find((h) => h.event === 'transferred_in');
    expect(out!.institution_id).toBe(tenant.institutionId);
    expect(incoming!.institution_id).toBe(institutionBId);

    const closed = await sqlAll<{ status: string }>(
      `select status from enrollments where student_id = $1 and institution_id = $2 and status = 'active'`,
      [studentId, tenant.institutionId],
    );
    expect(closed.length).toBe(0); // nothing active left behind at the source
  });

  it('refuses an inter-institution transfer without authority in the target', async () => {
    // The administrator's grant covers institution A only.
    const response = await api()
      .post(`/api/v1/students/${tenant.studentIds[3]}/transfer-institution`)
      .set(auth('admin'))
      .set('x-institution-id', tenant.institutionId)
      .send({
        targetInstitutionId: institutionBId,
        targetSectionId: sectionBId,
        effectiveDate: '2027-01-15',
        reason: 'Attempt without target authority',
      });
    expect(response.status).toBe(403);
  });

  // ── Bulk operations ───────────────────────────────────────────────────────────────

  it('bulk status change: preview computes without writing, commit writes one audit batch', async () => {
    const ghostId = uuidv7();
    const body = {
      studentIds: [student6Id, ghostId],
      status: 'on_leave',
      effectiveDate: '2026-06-01',
      reason: 'Extended medical leave recorded for the family',
    };

    const preview = await api()
      .post('/api/v1/students/bulk/status-change/preview')
      .set(auth('principal'))
      .set('x-institution-id', tenant.institutionId)
      .send(body);
    expect(preview.status, JSON.stringify(preview.body)).toBe(201);
    const previewOutcomes = new Map(
      preview.body.results.map((r: { studentId: string; outcome: string }) => [
        r.studentId,
        r.outcome,
      ]),
    );
    expect(previewOutcomes.get(student6Id)).toBe('changed');
    expect(previewOutcomes.get(ghostId)).toBe('not_found');

    const unchanged = await sqlOne<{ status: string }>(
      `select status from students where id = $1`,
      [student6Id],
    );
    expect(unchanged!.status).toBe('active'); // the preview wrote nothing

    const commit = await api()
      .post('/api/v1/students/bulk/status-change/commit')
      .set(auth('principal'))
      .set('x-institution-id', tenant.institutionId)
      .send(body);
    expect(commit.status, JSON.stringify(commit.body)).toBe(201);

    const changed = await sqlOne<{ status: string }>(`select status from students where id = $1`, [
      student6Id,
    ]);
    expect(changed!.status).toBe('on_leave');

    // One batch audit record carrying every affected id — not one record per student.
    const audits = await sqlAll<{ new_value: { changedStudentIds: string[] } }>(
      `select new_value from audit_logs where resource_type = 'bulk_status_change' and tenant_id = $1`,
      [tenant.tenantId],
    );
    expect(audits.length).toBe(1);
    expect(audits[0]!.new_value.changedStudentIds).toContain(student6Id);
  });

  it('bulk section change: preview then commit, audited as one batch', async () => {
    const body = {
      studentIds: [student6Id],
      targetSectionId: tenant.sectionId,
      effectiveDate: '2026-06-10',
      reason: 'Rebalancing sections after the promotion run',
    };

    const preview = await api()
      .post('/api/v1/students/bulk/section-change/preview')
      .set(auth('principal'))
      .set('x-institution-id', tenant.institutionId)
      .send(body);
    expect(preview.status, JSON.stringify(preview.body)).toBe(201);
    expect(preview.body.results[0].outcome).toBe('moved');

    const still = await sqlOne<{ section_id: string }>(
      `select section_id from enrollments where student_id = $1 and status = 'active'`,
      [student6Id],
    );
    expect(still!.section_id).toBe(sectionCId); // preview wrote nothing

    const commit = await api()
      .post('/api/v1/students/bulk/section-change/commit')
      .set(auth('principal'))
      .set('x-institution-id', tenant.institutionId)
      .send(body);
    expect(commit.status, JSON.stringify(commit.body)).toBe(201);

    const moved = await sqlOne<{ section_id: string }>(
      `select section_id from enrollments where student_id = $1 and status = 'active'`,
      [student6Id],
    );
    expect(moved!.section_id).toBe(tenant.sectionId);

    const audits = await sqlAll(
      `select 1 from audit_logs where resource_type = 'bulk_section_change' and tenant_id = $1`,
      [tenant.tenantId],
    );
    expect(audits.length).toBe(1);
  });

  // ── Permission denials ────────────────────────────────────────────────────────────

  it('a teacher cannot promote', async () => {
    const response = await api()
      .post('/api/v1/students/promote')
      .set(auth('teacher'))
      .set('x-institution-id', tenant.institutionId)
      .send(promoteBody());
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('an administrator cannot withdraw', async () => {
    const response = await api()
      .post(`/api/v1/students/${tenant.studentIds[3]}/withdraw`)
      .set(auth('admin'))
      .set('x-institution-id', tenant.institutionId)
      .send({ effectiveDate: '2026-07-01', reason: 'Attempt without the permission' });
    expect(response.status).toBe(403);
  });

  it('a guardian cannot upload documents for their own child', async () => {
    const response = await api()
      .post(`/api/v1/students/${tenant.studentIds[0]}/documents`)
      .set(auth('guardian1'))
      .set('x-institution-id', tenant.institutionId)
      .field('documentType', 'other')
      .field('title', 'Attempt')
      .attach('file', PDF_BYTES, 'x.pdf');
    expect(response.status).toBe(403);
  });

  // ── Tenant isolation ──────────────────────────────────────────────────────────────

  it("tenant B cannot read tenant A's status history by id", async () => {
    const response = await api()
      .get(`/api/v1/students/${tenant.studentIds[1]}/status-history`)
      .set(auth('rivalAdmin'));
    // 404 rather than 403: confirming the record exists elsewhere is itself a leak.
    expect(response.status).toBe(404);
  });

  it("tenant B cannot withdraw tenant A's student", async () => {
    const response = await api()
      .post(`/api/v1/students/${tenant.studentIds[1]}/withdraw`)
      .set(auth('rivalAdmin'))
      .set('x-institution-id', rival.institutionId)
      .send({ effectiveDate: '2026-07-01', reason: 'Cross-tenant attack attempt' });
    expect([403, 404]).toContain(response.status);

    const untouched = await sqlOne<{ status: string }>(
      `select status from students where id = $1`,
      [tenant.studentIds[1]],
    );
    expect(untouched!.status).toBe('active');
  });

  it("tenant B cannot borrow tenant A's institution header to promote", async () => {
    const response = await api()
      .post('/api/v1/students/promote')
      .set(auth('rivalAdmin'))
      .set('x-institution-id', tenant.institutionId)
      .send(promoteBody());
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });
});
