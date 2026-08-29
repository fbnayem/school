/**
 * Human resources over HTTP (Phase 15).
 *
 * The suite asserts the refusals as much as the happy path, because that is where the money
 * and the privacy live:
 *
 *  - salary is visible only with `payroll.payslips.view.all`, or to the employee themselves
 *    (and a wrong id under the narrow permission is a 404, not a 403);
 *  - the directory redacts bank details and the national id for callers without the
 *    payroll-wide permission;
 *  - overlapping active contracts are rejected, and so are contracts whose dates are not
 *    ordered;
 *  - salary components evaluate in sequence with `percentage_of_gross` after all earnings,
 *    and the arithmetic is exact to the poisa (asserted against hand-computed strings);
 *  - separation is a status change with history — the row provably survives in the database;
 *  - a transfer to a campus of another institution is indistinguishable from a campus that
 *    does not exist;
 *  - one tenant cannot read another's employee by id.
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
  TEST_PASSWORD,
  type SeededTenant,
} from '../helpers/test-app';

describe('Human resources', () => {
  let app: INestApplication;
  let tenant: SeededTenant;
  let other: SeededTenant;
  const tokens: Record<string, string> = {};
  let otherOwnerToken: string;

  /** A second campus of tenant A's institution — a legal transfer target. */
  let secondCampusId: string;
  /** A campus of a *different* institution in tenant A — an illegal transfer target. */
  let foreignCampusId: string;

  /** The employee HR creates during the suite (with bank details and an NID). */
  let employeeId: string;
  /** The seeded teacher's employee record — the "own salary" subject. */
  let teacherEmployeeId: string;
  let ownerEmployeeId: string;

  let structureId: string;
  let firstContractId: string;
  let documentId: string;
  let qualificationId: string;
  let lecturerDesignationId: string;

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

  beforeAll(async () => {
    app = await createTestApp();
    await truncateAll();
    tenant = await seedTenant('hra', { students: 1 });
    other = await seedTenant('hrb', { students: 1 });

    teacherEmployeeId = tenant.employeeIds[4]!;
    ownerEmployeeId = tenant.employeeIds[0]!;

    const client = testClient();
    await client.connect();
    try {
      secondCampusId = uuidv7();
      await client.query(
        `insert into campuses (id, tenant_id, institution_id, code, name_en)
         values ($1,$2,$3,'ANNEX','hra Annex Campus')`,
        [secondCampusId, tenant.tenantId, tenant.institutionId],
      );

      // A second institution in the SAME tenant, with a campus. Transferring to it must be
      // rejected: campuses are only valid within the employee's own institution.
      const secondInstitutionId = uuidv7();
      await client.query(
        `insert into institutions (id, tenant_id, code, name_en, type, medium)
         values ($1,$2,'hra-INST2','hra Second Institution','school','bangla')`,
        [secondInstitutionId, tenant.tenantId],
      );
      foreignCampusId = uuidv7();
      await client.query(
        `insert into campuses (id, tenant_id, institution_id, code, name_en)
         values ($1,$2,$3,'MAIN','hra Second Institution Campus')`,
        [foreignCampusId, tenant.tenantId, secondInstitutionId],
      );
    } finally {
      await client.end();
    }

    tokens['owner'] = await login(tenant.users['owner']!.email);
    tokens['principal'] = await login(tenant.users['principal']!.email);
    tokens['admin'] = await login(tenant.users['admin']!.email);
    tokens['teacher'] = await login(tenant.users['teacher']!.email);
    otherOwnerToken = await login(other.users['owner']!.email);
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  // ── Departments and designations ─────────────────────────────────────────────────────

  describe('departments and designations', () => {
    let scienceDeptId: string;

    it('creates a department', async () => {
      const response = await post('owner', '/api/v1/hr/departments', {
        code: 'SCI',
        nameEn: 'Science',
        nameBn: 'বিজ্ঞান',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.code).toBe('SCI');
      scienceDeptId = response.body.id;
    });

    it('rejects a duplicate department code with 409', async () => {
      const response = await post('owner', '/api/v1/hr/departments', {
        code: 'SCI',
        nameEn: 'Science Again',
      });
      expect(response.status).toBe(409);
    });

    it('supports a department hierarchy and refuses cycles', async () => {
      const child = await post('owner', '/api/v1/hr/departments', {
        code: 'PHY',
        nameEn: 'Physics',
        parentDepartmentId: scienceDeptId,
      });
      expect(child.status, JSON.stringify(child.body)).toBe(201);
      expect(child.body.parentDepartmentId).toBe(scienceDeptId);

      // Science under Physics under Science would be a cycle.
      const cycle = await patch('owner', `/api/v1/hr/departments/${scienceDeptId}`, {
        parentDepartmentId: child.body.id,
      });
      expect(cycle.status).toBe(422);
    });

    it('denies department creation to a teacher', async () => {
      const response = await post('teacher', '/api/v1/hr/departments', {
        code: 'ART',
        nameEn: 'Arts',
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('creates a designation used later by the transfer', async () => {
      const response = await post('owner', '/api/v1/hr/designations', {
        code: 'LEC',
        nameEn: 'Lecturer',
        rank: 10,
        isTeaching: true,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      lecturerDesignationId = response.body.id;
    });

    it('refuses to archive a department without a meaningful reason', async () => {
      const response = await post('owner', `/api/v1/hr/departments/${scienceDeptId}/archive`, {
        reason: 'no',
      });
      expect(response.status).toBe(422);
    });
  });

  // ── Employee records, directory, redaction ───────────────────────────────────────────

  describe('employee records', () => {
    it('denies employee creation to the administrator (no hr.employees.create)', async () => {
      const response = await post('admin', '/api/v1/hr/employees', {
        fullNameEn: 'Should Not Exist',
        phone: '01712345600',
        joiningDate: '2026-01-01',
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('creates an employee with a generated code and a hire history row', async () => {
      const response = await post('owner', '/api/v1/hr/employees', {
        fullNameEn: 'Nadia Rahman',
        fullNameBn: 'নাদিয়া রহমান',
        dateOfBirth: '1990-04-15',
        gender: 'female',
        nationalId: '1234567890',
        phone: '01712345601',
        joiningDate: '2026-01-01',
        employmentType: 'permanent',
        bankName: 'Sonali Bank',
        bankAccountNumber: '0011223344556',
        bankBranch: 'Motijheel',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.employeeCode).toMatch(/^E\d{4}\d{4}$/);
      expect(response.body.employmentStatus).toBe('active');
      employeeId = response.body.id;

      const client = testClient();
      await client.connect();
      try {
        const history = await client.query(
          `select to_status from employee_status_history where employee_id = $1`,
          [employeeId],
        );
        expect(history.rows).toEqual([{ to_status: 'active' }]);
      } finally {
        await client.end();
      }
    });

    it('shows bank details to a payroll-wide reader and redacts them for others', async () => {
      const asOwner = await get('owner', `/api/v1/hr/employees/${employeeId}`);
      expect(asOwner.status).toBe(200);
      expect(asOwner.body.bankAccountNumber).toBe('0011223344556');
      expect(asOwner.body.nationalId).toBe('1234567890');

      // The principal holds hr.employees.view but not payroll.payslips.view.all: same
      // endpoint, same row, sensitive fields server-side null.
      const asPrincipal = await get('principal', `/api/v1/hr/employees/${employeeId}`);
      expect(asPrincipal.status).toBe(200);
      expect(asPrincipal.body.fullNameEn).toBe('Nadia Rahman');
      expect(asPrincipal.body.bankAccountNumber).toBeNull();
      expect(asPrincipal.body.bankName).toBeNull();
      expect(asPrincipal.body.nationalId).toBeNull();
    });

    it('denies the directory to a teacher', async () => {
      const response = await get('teacher', '/api/v1/hr/employees');
      expect(response.status).toBe(403);
    });

    it('lists the directory with search', async () => {
      const response = await get('owner', '/api/v1/hr/employees').query({ q: 'Nadia' });
      expect(response.status).toBe(200);
      expect(response.body.meta.total).toBe(1);
      expect(response.body.data[0].id).toBe(employeeId);
    });

    it('lets an employee read and edit their own profile, but only the contact subset', async () => {
      const me = await get('teacher', '/api/v1/hr/employees/me');
      expect(me.status).toBe(200);
      expect(me.body.employee.id).toBe(teacherEmployeeId);

      const updated = await patch('teacher', '/api/v1/hr/employees/me', {
        presentAddress: '12 Green Road, Dhaka',
        version: me.body.employee.version,
      });
      expect(updated.status, JSON.stringify(updated.body)).toBe(200);
      expect(updated.body.presentAddress).toBe('12 Green Road, Dhaka');

      // A name change smuggled into the self-service endpoint is stripped by the schema,
      // leaving no changes — the request is refused rather than partially applied.
      const smuggled = await patch('teacher', '/api/v1/hr/employees/me', {
        fullNameEn: 'Renamed Teacher',
        version: updated.body.version,
      });
      expect(smuggled.status).toBe(422);
    });
  });

  // ── Tenant isolation ─────────────────────────────────────────────────────────────────

  describe('tenant isolation', () => {
    it("tenant B cannot read tenant A's employee by id", async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/hr/employees/${employeeId}`)
        .set('Authorization', `Bearer ${otherOwnerToken}`)
        .set('x-institution-id', other.institutionId);

      // 404 rather than 403: confirming the record exists elsewhere is itself a leak.
      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain('Nadia');
    });

    it("tenant B cannot borrow tenant A's institution via the x-institution-id header", async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/hr/employees')
        .set('Authorization', `Bearer ${otherOwnerToken}`)
        .set('x-institution-id', tenant.institutionId);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it("tenant B's directory contains no tenant A names", async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/hr/employees')
        .set('Authorization', `Bearer ${otherOwnerToken}`)
        .set('x-institution-id', other.institutionId);
      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).not.toContain('hra ');
      expect(JSON.stringify(response.body)).not.toContain('Nadia');
    });
  });

  // ── Contracts ────────────────────────────────────────────────────────────────────────

  describe('employment contracts', () => {
    it('rejects a contract that ends before it starts', async () => {
      const response = await post('owner', '/api/v1/hr/contracts', {
        employeeId,
        contractType: 'contract',
        startDate: '2026-06-01',
        endDate: '2026-01-01',
      });
      expect(response.status).toBe(422);
    });

    it('rejects a probation that falls outside the contract', async () => {
      const response = await post('owner', '/api/v1/hr/contracts', {
        employeeId,
        contractType: 'contract',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        probationEndDate: '2027-02-01',
      });
      expect(response.status).toBe(422);
    });

    it('creates an active contract', async () => {
      const response = await post('owner', '/api/v1/hr/contracts', {
        employeeId,
        contractType: 'contract',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        probationEndDate: '2026-03-31',
        noticePeriodDays: 60,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('active');
      firstContractId = response.body.id;
    });

    it('rejects an overlapping active contract with 409', async () => {
      const response = await post('owner', '/api/v1/hr/contracts', {
        employeeId,
        contractType: 'contract',
        startDate: '2026-06-01',
        endDate: '2027-05-31',
      });
      expect(response.status).toBe(409);
    });

    it('accepts a non-overlapping later contract and terminates it with a reason', async () => {
      const created = await post('owner', '/api/v1/hr/contracts', {
        employeeId,
        contractType: 'contract',
        startDate: '2027-01-01',
        endDate: '2027-12-31',
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);

      const terminated = await post('owner', `/api/v1/hr/contracts/${created.body.id}/terminate`, {
        effectiveDate: '2027-06-30',
        reason: 'Post discontinued in the 2027 budget',
      });
      expect(terminated.status, JSON.stringify(terminated.body)).toBe(201);
      expect(terminated.body.status).toBe('terminated');
    });

    it('denies contract management to a teacher', async () => {
      const response = await post('teacher', '/api/v1/hr/contracts', {
        employeeId,
        startDate: '2028-01-01',
      });
      expect(response.status).toBe(403);
    });
  });

  // ── Salary structures, sequencing, visibility ────────────────────────────────────────

  describe('salary', () => {
    it('denies structure creation to the principal (no payroll.structures.manage)', async () => {
      const response = await post('principal', '/api/v1/hr/salary-structures', {
        nameEn: 'Should Not Exist',
        effectiveFrom: '2026-01-01',
      });
      expect(response.status).toBe(403);
    });

    it('creates a draft structure', async () => {
      const response = await post('owner', '/api/v1/hr/salary-structures', {
        nameEn: 'Teaching Scale 2026',
        nameBn: 'শিক্ষক স্কেল ২০২৬',
        effectiveFrom: '2026-01-01',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('draft');
      structureId = response.body.id;
    });

    it('refuses to assign a draft structure', async () => {
      const response = await post('owner', '/api/v1/hr/salary-assignments', {
        employeeId: teacherEmployeeId,
        salaryStructureId: structureId,
        basic: '20000.00',
        effectiveFrom: '2026-01-01',
      });
      expect(response.status).toBe(409);
    });

    it('rejects a percentage-of-gross earning — gross would be self-referential', async () => {
      const response = await put(
        'owner',
        `/api/v1/hr/salary-structures/${structureId}/components`,
        {
          components: [
            {
              nameEn: 'Impossible Bonus',
              type: 'earning',
              calculation: 'percentage_of_gross',
              amount: '10.00',
              sequence: 1,
            },
          ],
        },
      );
      expect(response.status).toBe(422);
    });

    it('rejects money with more than two decimal places', async () => {
      const response = await post('owner', '/api/v1/hr/salary-assignments', {
        employeeId: teacherEmployeeId,
        salaryStructureId: structureId,
        basic: '20000.005',
        effectiveFrom: '2026-01-01',
      });
      expect(response.status).toBe(422);
    });

    it('replaces the component set and activates the structure', async () => {
      const response = await put(
        'owner',
        `/api/v1/hr/salary-structures/${structureId}/components`,
        {
          components: [
            {
              nameEn: 'House Rent',
              type: 'earning',
              calculation: 'percentage_of_basic',
              amount: '50.00',
              sequence: 10,
            },
            {
              nameEn: 'Medical Allowance',
              type: 'earning',
              calculation: 'fixed',
              amount: '1500.00',
              sequence: 20,
            },
            {
              nameEn: 'Transport Allowance',
              type: 'earning',
              calculation: 'fixed',
              amount: '700.55',
              sequence: 30,
            },
            {
              nameEn: 'Provident Fund',
              type: 'deduction',
              calculation: 'percentage_of_basic',
              amount: '10.00',
              sequence: 40,
            },
            {
              nameEn: 'Income Tax',
              type: 'deduction',
              calculation: 'percentage_of_gross',
              amount: '5.00',
              sequence: 50,
            },
          ],
        },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.components).toHaveLength(5);

      const activated = await post('owner', `/api/v1/hr/salary-structures/${structureId}/activate`);
      expect(activated.status, JSON.stringify(activated.body)).toBe(201);
      expect(activated.body.status).toBe('active');
    });

    it('assigns the structure to the teacher', async () => {
      const response = await post('owner', '/api/v1/hr/salary-assignments', {
        employeeId: teacherEmployeeId,
        salaryStructureId: structureId,
        basic: '20000.00',
        effectiveFrom: '2026-01-01',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.basic).toBe('20000.00');
    });

    it('computes the breakdown exactly, with percentage_of_gross evaluated after all earnings', async () => {
      const response = await get('owner', `/api/v1/hr/employees/${teacherEmployeeId}/salary`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);

      const breakdown = response.body.breakdown;
      // basic 20000.00 + 50% of basic (10000.00) + 1500.00 + 700.55 = 32200.55
      expect(breakdown.basic).toBe('20000.00');
      expect(breakdown.gross).toBe('32200.55');

      const byName = Object.fromEntries(
        breakdown.lines.map((line: { nameEn: string; amount: string }) => [
          line.nameEn,
          line.amount,
        ]),
      );
      expect(byName['House Rent']).toBe('10000.00');
      expect(byName['Medical Allowance']).toBe('1500.00');
      expect(byName['Transport Allowance']).toBe('700.55');
      expect(byName['Provident Fund']).toBe('2000.00');
      // 5% of GROSS (32200.55 → 1610.0275, half-up to 1610.03) — not 5% of basic (1000.00).
      // This is the sequencing proof: the tax line saw every earning before it computed.
      expect(byName['Income Tax']).toBe('1610.03');

      expect(breakdown.totalDeductions).toBe('3610.03');
      // 32200.55 - 3610.03, exact to the poisa.
      expect(breakdown.net).toBe('28590.52');
    });

    it('lets the employee read their own salary', async () => {
      const response = await get('teacher', '/api/v1/hr/employees/me/salary');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.breakdown.net).toBe('28590.52');
    });

    it("refuses the employee another person's salary with 404, not 403", async () => {
      const response = await get('teacher', `/api/v1/hr/employees/${ownerEmployeeId}/salary`);
      expect(response.status).toBe(404);
    });

    it('denies salary reads to a caller with no payroll permission at all', async () => {
      const response = await get('admin', `/api/v1/hr/employees/${teacherEmployeeId}/salary`);
      expect(response.status).toBe(403);
    });

    it('denies the structure list to the principal', async () => {
      const response = await get('principal', '/api/v1/hr/salary-structures');
      expect(response.status).toBe(403);
    });

    it('re-assigning closes the previous assignment instead of editing it', async () => {
      const response = await post('owner', '/api/v1/hr/salary-assignments', {
        employeeId: teacherEmployeeId,
        salaryStructureId: structureId,
        basic: '22000.00',
        effectiveFrom: '2026-03-01',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);

      const client = testClient();
      await client.connect();
      try {
        const rows = await client.query(
          `select basic, effective_from::text as effective_from, effective_to::text as effective_to
             from employee_salary_assignments
            where employee_id = $1 and archived_at is null
            order by effective_from`,
          [teacherEmployeeId],
        );
        expect(rows.rows).toHaveLength(2);
        // History preserved: the old row is closed the day before the new one begins.
        expect(rows.rows[0].effective_to).toBe('2026-02-28');
        expect(rows.rows[1].effective_to).toBeNull();
        expect(rows.rows[1].basic).toBe('22000.00');
      } finally {
        await client.end();
      }
    });

    it('rejects an assignment overlapping a closed historical range', async () => {
      const response = await post('owner', '/api/v1/hr/salary-assignments', {
        employeeId: teacherEmployeeId,
        salaryStructureId: structureId,
        basic: '21000.00',
        effectiveFrom: '2026-02-01',
        effectiveTo: '2026-02-10',
      });
      expect(response.status).toBe(409);
    });
  });

  // ── Documents ────────────────────────────────────────────────────────────────────────

  describe('documents', () => {
    const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

    it('uploads a document with an expiry date', async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/v1/hr/employees/${employeeId}/documents`)
        .set('Authorization', `Bearer ${tokens['owner']}`)
        .set('x-institution-id', tenant.institutionId)
        .field('documentType', 'police_clearance')
        .field('title', 'Police clearance certificate')
        .field('expiresAt', '2026-09-25')
        .attach('file', pdfBytes, { filename: 'clearance.pdf', contentType: 'application/pdf' });

      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.documentType).toBe('police_clearance');
      expect(response.body.expiresAt).toBe('2026-09-25');
      documentId = response.body.id;
    });

    it('rejects a disallowed file type', async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/v1/hr/employees/${employeeId}/documents`)
        .set('Authorization', `Bearer ${tokens['owner']}`)
        .set('x-institution-id', tenant.institutionId)
        .field('documentType', 'other')
        .field('title', 'A script, absolutely not')
        .attach('file', Buffer.from('#!/bin/sh\n'), {
          filename: 'run.sh',
          contentType: 'text/x-shellscript',
        });
      expect(response.status).toBe(422);
    });

    it('denies uploads to a teacher', async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/v1/hr/employees/${employeeId}/documents`)
        .set('Authorization', `Bearer ${tokens['teacher']}`)
        .set('x-institution-id', tenant.institutionId)
        .field('documentType', 'other')
        .field('title', 'Should be refused')
        .attach('file', pdfBytes, { filename: 'x.pdf', contentType: 'application/pdf' });
      expect(response.status).toBe(403);
    });

    it('surfaces the document in the expiry-alert feed', async () => {
      const response = await get('owner', '/api/v1/hr/documents/expiring').query({
        withinDays: 60,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const ids = response.body.data.map((row: { id: string }) => row.id);
      expect(ids).toContain(documentId);
      const row = response.body.data.find((item: { id: string }) => item.id === documentId);
      expect(row.employeeName).toBe('Nadia Rahman');
    });

    it('verifies a document exactly once', async () => {
      const first = await post('owner', `/api/v1/hr/documents/${documentId}/verify`);
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(first.body.verifiedAt).not.toBeNull();

      const second = await post('owner', `/api/v1/hr/documents/${documentId}/verify`);
      expect(second.status).toBe(409);
    });
  });

  // ── Qualifications: CRUD, and archived means archived, not deleted ───────────────────

  describe('qualifications', () => {
    it('adds, updates, and archives a qualification without ever deleting the row', async () => {
      const created = await post('owner', `/api/v1/hr/employees/${employeeId}/qualifications`, {
        degree: 'MSc',
        institutionName: 'University of Dhaka',
        fieldOfStudy: 'Physics',
        yearCompleted: 2012,
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      qualificationId = created.body.id;

      const updated = await patch('owner', `/api/v1/hr/qualifications/${qualificationId}`, {
        grade: 'First Class',
      });
      expect(updated.status).toBe(200);
      expect(updated.body.grade).toBe('First Class');

      const archived = await post('owner', `/api/v1/hr/qualifications/${qualificationId}/archive`, {
        reason: 'Entered against the wrong employee',
      });
      expect(archived.status).toBe(201);

      const listed = await get('owner', `/api/v1/hr/employees/${employeeId}/qualifications`);
      expect(listed.status).toBe(200);
      expect(listed.body).toEqual([]);

      // The row survives in the database with its archive metadata — never deleted.
      const client = testClient();
      await client.connect();
      try {
        const rows = await client.query(
          `select archived_at, archive_reason from employee_qualifications where id = $1`,
          [qualificationId],
        );
        expect(rows.rowCount).toBe(1);
        expect(rows.rows[0].archived_at).not.toBeNull();
        expect(rows.rows[0].archive_reason).toBe('Entered against the wrong employee');
      } finally {
        await client.end();
      }
    });
  });

  // ── Transfers ────────────────────────────────────────────────────────────────────────

  describe('transfers', () => {
    it('transfers an employee to another campus of the same institution', async () => {
      const response = await post('owner', `/api/v1/hr/employees/${teacherEmployeeId}/transfer`, {
        toCampusId: secondCampusId,
        toDesignationId: lecturerDesignationId,
        effectiveDate: '2026-07-01',
        reason: 'Annex campus needs a senior science teacher',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.employee.campusId).toBe(secondCampusId);

      const client = testClient();
      await client.connect();
      try {
        const rows = await client.query(
          `select from_campus_id, to_campus_id, reason from employee_transfers where employee_id = $1`,
          [teacherEmployeeId],
        );
        expect(rows.rowCount).toBe(1);
        expect(rows.rows[0].to_campus_id).toBe(secondCampusId);
      } finally {
        await client.end();
      }
    });

    it('refuses a transfer to the campus the employee is already on', async () => {
      const response = await post('owner', `/api/v1/hr/employees/${teacherEmployeeId}/transfer`, {
        toCampusId: secondCampusId,
        effectiveDate: '2026-07-02',
        reason: 'Same campus again, should be refused',
      });
      expect(response.status).toBe(409);
    });

    it("refuses a campus belonging to a different institution — 404, as if it didn't exist", async () => {
      const response = await post('owner', `/api/v1/hr/employees/${teacherEmployeeId}/transfer`, {
        toCampusId: foreignCampusId,
        effectiveDate: '2026-07-03',
        reason: 'Cross-institution move must be rejected',
      });
      expect(response.status).toBe(404);
    });

    it("refuses another tenant's campus the same way", async () => {
      const response = await post('owner', `/api/v1/hr/employees/${teacherEmployeeId}/transfer`, {
        toCampusId: other.campusId,
        effectiveDate: '2026-07-04',
        reason: 'Cross-tenant move must be rejected',
      });
      expect(response.status).toBe(404);
    });
  });

  // ── Separation: a status change with history, never a delete ─────────────────────────

  describe('separation', () => {
    it('refuses a separation without a reason before the handler runs', async () => {
      const response = await post('owner', `/api/v1/hr/employees/${employeeId}/status`, {
        status: 'resigned',
        effectiveDate: '2026-06-30',
      });
      expect(response.status).toBe(422);
    });

    it('refuses a separation from a caller without hr.exit.manage', async () => {
      // The principal can update employees, but separating one is exit authority.
      const response = await post('principal', `/api/v1/hr/employees/${employeeId}/status`, {
        status: 'resigned',
        effectiveDate: '2026-06-30',
        reason: 'Handed in notice at the end of term',
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('separates the employee, keeps the row, writes history, and closes contracts', async () => {
      const response = await post('owner', `/api/v1/hr/employees/${employeeId}/status`, {
        status: 'resigned',
        effectiveDate: '2026-06-30',
        reason: 'Handed in notice at the end of term',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.employmentStatus).toBe('resigned');
      expect(response.body.lastWorkingDate).toBe('2026-06-30');

      const client = testClient();
      await client.connect();
      try {
        // Never deleted: the row is still there, resigned.
        const employee = await client.query(
          `select employment_status, resignation_date from employees where id = $1`,
          [employeeId],
        );
        expect(employee.rowCount).toBe(1);
        expect(employee.rows[0].employment_status).toBe('resigned');

        const history = await client.query(
          `select from_status, to_status, reason from employee_status_history
            where employee_id = $1 and to_status = 'resigned'`,
          [employeeId],
        );
        expect(history.rowCount).toBe(1);
        expect(history.rows[0].from_status).toBe('active');
        expect(history.rows[0].reason).toBe('Handed in notice at the end of term');

        // The running contract ended on the separation date.
        const contract = await client.query(
          `select status, end_date::text as end_date from employment_contracts where id = $1`,
          [firstContractId],
        );
        expect(contract.rows[0].status).toBe('ended');
        expect(contract.rows[0].end_date).toBe('2026-06-30');
      } finally {
        await client.end();
      }
    });

    it('refuses to change the status of a separated employee', async () => {
      const response = await post('owner', `/api/v1/hr/employees/${employeeId}/status`, {
        status: 'active',
        effectiveDate: '2026-07-01',
        reason: 'Trying to quietly rewrite a separation',
      });
      expect(response.status).toBe(409);
    });

    it('archives the separated employee — soft, with the row surviving', async () => {
      const response = await post('owner', `/api/v1/hr/employees/${employeeId}/archive`, {
        reason: 'Record closed after final settlement',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);

      const client = testClient();
      await client.connect();
      try {
        const rows = await client.query(
          `select archived_at, full_name_en from employees where id = $1`,
          [employeeId],
        );
        expect(rows.rowCount).toBe(1);
        expect(rows.rows[0].archived_at).not.toBeNull();
        expect(rows.rows[0].full_name_en).toBe('Nadia Rahman');
      } finally {
        await client.end();
      }
    });

    it('refuses to archive an employee who has not been separated', async () => {
      const response = await post('owner', `/api/v1/hr/employees/${teacherEmployeeId}/archive`, {
        reason: 'Still teaching, must be refused',
      });
      expect(response.status).toBe(409);
    });
  });

  // ── Headcount and attrition ──────────────────────────────────────────────────────────

  describe('headcount report', () => {
    it('computes headcount, movement and an exact-decimal attrition rate in SQL', async () => {
      const response = await get('owner', '/api/v1/hr/reports/headcount').query({
        from: '2026-01-01',
        to: '2026-12-31',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);

      // Five seeded staff remain; Nadia was hired and resigned inside the window.
      expect(response.body.current.total).toBe(5);
      expect(response.body.movement.joiners).toBeGreaterThanOrEqual(1);
      expect(response.body.movement.separations).toBe(1);
      expect(response.body.movement.headcountAtEnd).toBeGreaterThanOrEqual(5);
      // A decimal string with two places — never a binary float.
      expect(response.body.movement.attritionRatePercent).toMatch(/^\d+\.\d{2}$/);

      const statuses = Object.fromEntries(
        response.body.current.byStatus.map((row: { status: string; total: number }) => [
          row.status,
          row.total,
        ]),
      );
      expect(statuses['active']).toBe(5);
    });

    it('denies the report to a teacher', async () => {
      const response = await get('teacher', '/api/v1/hr/reports/headcount');
      expect(response.status).toBe(403);
    });
  });

  // ── Database-level checks ────────────────────────────────────────────────────────────

  describe('row-level security coverage', () => {
    it('enforces forced RLS with a tenant_isolation policy on every HR table', async () => {
      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query<{ relname: string }>(
          `select c.relname
             from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r'
              and c.relname in (
                'employment_contracts','salary_structures','salary_components',
                'employee_salary_assignments','employee_documents','employee_qualifications',
                'employee_experience','employee_dependents','employee_status_history',
                'employee_transfers'
              )
              and (
                not c.relrowsecurity
                or not c.relforcerowsecurity
                or not exists (
                  select 1 from pg_policy p
                   where p.polrelid = c.oid and p.polname = 'tenant_isolation'
                )
              )`,
        );
        expect(rows.map((row) => row.relname)).toEqual([]);
      } finally {
        await client.end();
      }
    });
  });
});
