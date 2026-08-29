/**
 * Report builder integration suite (Phase 24).
 *
 * This module turns user input into queries, which makes it the largest attack surface in
 * the product for both SQL injection and tenant isolation. This file is therefore written as
 * an attacker's checklist rather than a happy-path tour:
 *
 *  - an unknown column, an unknown operator and an unknown sort field are each a 422 that
 *    names the field — never a 500, and never a query,
 *  - injection attempts in a column name, in a filter value and in a sort field are refused
 *    or safely parameterised, and `students` is still standing afterwards,
 *  - a class teacher's student report contains exactly their assigned students,
 *  - a cross-tenant report returns nothing, and the institution switcher refuses another
 *    tenant's institution outright,
 *  - a caller without `students.medical.view` sees medical columns in neither the picker nor
 *    the rows, and cannot filter on one either — a filter on an invisible column is an oracle,
 *  - the same for `payroll.payslips.view.all` and the salary column,
 *  - the row limit is enforced and an export of a truncated result is refused,
 *  - every export writes an audit record, in the same transaction that creates it.
 *
 * The invariants the assignment says the DATABASE enforces are proved with a raw `pg` client
 * connected as `shikkha_app` — the same unprivileged role the API uses — writing rows the
 * service would never write: a run that is both a saved definition and an ad-hoc document,
 * one that is neither, an export whose expiry precedes its creation, and any attempt to edit
 * or delete an export at all.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Client } from 'pg';
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

describe('Reports — a registry-driven query surface', () => {
  let app: INestApplication;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
  const tokens: Record<string, string> = {};

  /** A student in tenant A enrolled in a section the seeded teacher is NOT assigned to. */
  let outsiderStudentId: string;
  const OUTSIDER_CODE = 'rpta-OUT1';
  /** The seeded student carrying a medical note. */
  let medicalStudentId: string;

  /** A published, institution-visible roster the teacher is allowed to run. */
  let rosterDefinitionId: string;
  /** A private definition owned by the principal, used for the schedule tests. */
  let privateDefinitionId: string;

  /** A successful owner run over all of tenant A's students. */
  let ownerRunId: string;

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
   * Run a callback as the unprivileged application role inside one transaction with the
   * tenant GUC set — exactly the credentials a compromised application would hold. Rolled
   * back afterwards, so a refused write cannot leak state into a later test.
   */
  async function asAppRole<T>(tenantId: string, fn: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: TEST_APP_DATABASE_URL });
    await client.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      return await fn(client);
    } finally {
      await client.query('rollback').catch(() => undefined);
      await client.end();
    }
  }

  /** A students report body, so each test states only what it is actually varying. */
  const studentQuery = (overrides: Record<string, unknown> = {}) => ({
    query: {
      sourceKey: 'students',
      columns: ['studentCode', 'fullNameEn'],
      ...overrides,
    },
  });

  beforeAll(async () => {
    app = await createTestApp();
    await truncateAll();

    tenantA = await seedTenant('rpta', { students: 6 });
    tenantB = await seedTenant('rptb', { students: 3 });

    const client = testClient();
    await client.connect();
    try {
      // A second section with no teacher assignment, and one student in it. Without this the
      // "teacher sees only their assigned students" assertion would be vacuous: seedTenant
      // puts every student in the one section the teacher is class teacher of.
      const otherSectionId = uuidv7();
      await client.query(
        `insert into sections
           (id, tenant_id, institution_id, campus_id, academic_year_id, class_level_id, name_en, capacity)
         values ($1,$2,$3,$4,$5,$6,'Z',40)`,
        [
          otherSectionId,
          tenantA.tenantId,
          tenantA.institutionId,
          tenantA.campusId,
          tenantA.academicYearId,
          tenantA.classLevelId,
        ],
      );

      outsiderStudentId = uuidv7();
      await client.query(
        `insert into students
           (id, tenant_id, institution_id, student_code, admission_number, admission_date,
            full_name_en, date_of_birth, gender, status)
         values ($1,$2,$3,$4,'rpta-AOUT1','2026-01-05','rpta Outsider','2014-02-02','female','active')`,
        [outsiderStudentId, tenantA.tenantId, tenantA.institutionId, OUTSIDER_CODE],
      );
      await client.query(
        `insert into enrollments
           (id, tenant_id, institution_id, campus_id, student_id, academic_year_id,
            class_level_id, section_id, roll_number, status, enrolled_on)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'99','active','2026-01-05')`,
        [
          uuidv7(),
          tenantA.tenantId,
          tenantA.institutionId,
          tenantA.campusId,
          outsiderStudentId,
          tenantA.academicYearId,
          tenantA.classLevelId,
          otherSectionId,
        ],
      );

      // A medical note on one seeded student, so the permission test can assert on a value
      // rather than only on the presence of a key.
      medicalStudentId = tenantA.studentIds[0]!;
      await client.query(`update students set medical_conditions = 'Asthma' where id = $1`, [
        medicalStudentId,
      ]);

      // A current salary assignment, so the salary column has something to hide.
      const structureId = uuidv7();
      await client.query(
        `insert into salary_structures (id, tenant_id, institution_id, name_en, effective_from)
         values ($1,$2,$3,'rpta Standard','2026-01-01')`,
        [structureId, tenantA.tenantId, tenantA.institutionId],
      );
      await client.query(
        `insert into employee_salary_assignments
           (id, tenant_id, institution_id, employee_id, salary_structure_id, basic, effective_from)
         values ($1,$2,$3,$4,$5,'42000.00','2026-01-01')`,
        [
          uuidv7(),
          tenantA.tenantId,
          tenantA.institutionId,
          tenantA.employeeIds[0]!,
          structureId,
        ],
      );
    } finally {
      await client.end();
    }

    tokens['owner'] = await login(tenantA.users['owner']!.email);
    tokens['principal'] = await login(tenantA.users['principal']!.email);
    tokens['admin'] = await login(tenantA.users['admin']!.email);
    tokens['accountant'] = await login(tenantA.users['accountant']!.email);
    tokens['teacher'] = await login(tenantA.users['teacher']!.email);
    tokens['guardian'] = await login(tenantA.users['guardian1']!.email);
    tokens['bOwner'] = await login(tenantB.users['owner']!.email);
  });

  afterAll(async () => {
    await app?.close();
  });

  // ──────────────────────────────────────────────────────────────────────────────────
  // The registry and the column picker
  // ──────────────────────────────────────────────────────────────────────────────────

  it('lists only the sources a caller may actually query', async () => {
    const ownerSources = await get('owner', '/api/v1/reports/sources');
    expect(ownerSources.status, JSON.stringify(ownerSources.body)).toBe(200);
    const ownerKeys = (ownerSources.body.data as { key: string }[]).map((s) => s.key);
    expect(ownerKeys).toEqual(
      expect.arrayContaining([
        'students',
        'enrollments',
        'attendance',
        'exam_results',
        'invoices',
        'payments',
        'employees',
        'audit_logs',
      ]),
    );

    // A teacher has no HR, finance or audit permission, so those sources are not merely
    // unusable — they are not offered.
    const teacherSources = await get('teacher', '/api/v1/reports/sources');
    expect(teacherSources.status).toBe(200);
    const teacherKeys = (teacherSources.body.data as { key: string }[]).map((s) => s.key);
    expect(teacherKeys).toContain('students');
    expect(teacherKeys).not.toContain('employees');
    expect(teacherKeys).not.toContain('audit_logs');
    expect(teacherKeys).not.toContain('invoices');
  });

  it('never registers a source for a module that is not committed', async () => {
    const response = await get('owner', '/api/v1/reports/sources');
    const keys = (response.body.data as { key: string }[]).map((s) => s.key);
    for (const absent of ['lms', 'communication', 'inventory', 'assets', 'leave', 'documents']) {
      expect(keys).not.toContain(absent);
    }
  });

  it('omits medical columns from the picker for a caller without students.medical.view', async () => {
    const forOwner = await get('owner', '/api/v1/reports/sources/students');
    expect(forOwner.status, JSON.stringify(forOwner.body)).toBe(200);
    const ownerColumns = (forOwner.body.columns as { key: string }[]).map((c) => c.key);
    expect(ownerColumns).toContain('medicalConditions');
    expect(ownerColumns).toContain('emergencyMedicalNote');

    // The principal holds `reports.*` and `students.view.all` but not `students.medical.view`.
    const forPrincipal = await get('principal', '/api/v1/reports/sources/students');
    expect(forPrincipal.status).toBe(200);
    const principalColumns = (forPrincipal.body.columns as { key: string }[]).map((c) => c.key);
    expect(principalColumns).toContain('fullNameEn');
    expect(principalColumns).not.toContain('medicalConditions');
    expect(principalColumns).not.toContain('allergies');
    expect(principalColumns).not.toContain('specialNeeds');
    expect(principalColumns).not.toContain('emergencyMedicalNote');
  });

  it('omits the salary column from the picker without payroll.payslips.view.all', async () => {
    const forOwner = await get('owner', '/api/v1/reports/sources/employees');
    expect(forOwner.status, JSON.stringify(forOwner.body)).toBe(200);
    const ownerColumns = (forOwner.body.columns as { key: string }[]).map((c) => c.key);
    expect(ownerColumns).toContain('basicSalary');
    expect(ownerColumns).toContain('bankAccountNumber');

    const forPrincipal = await get('principal', '/api/v1/reports/sources/employees');
    expect(forPrincipal.status).toBe(200);
    const principalColumns = (forPrincipal.body.columns as { key: string }[]).map((c) => c.key);
    expect(principalColumns).toContain('employeeCode');
    expect(principalColumns).not.toContain('basicSalary');
    expect(principalColumns).not.toContain('bankAccountNumber');
    expect(principalColumns).not.toContain('nationalId');
  });

  it('refuses a source the caller has no permission for, and an unknown source key', async () => {
    const denied = await get('teacher', '/api/v1/reports/sources/employees');
    expect(denied.status).toBe(403);

    const unknown = await get('owner', '/api/v1/reports/sources/not_a_source');
    expect(unknown.status).toBe(422);
    expect(JSON.stringify(unknown.body)).toContain('not_a_source');
  });

  // ──────────────────────────────────────────────────────────────────────────────────
  // Allow-list enforcement
  // ──────────────────────────────────────────────────────────────────────────────────

  it('refuses an unknown column with a 422 that names the field', async () => {
    const response = await post(
      'owner',
      '/api/v1/reports/run',
      studentQuery({ columns: ['studentCode', 'notAColumn'] }),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(JSON.stringify(response.body)).toContain('notAColumn');
  });

  it('refuses an unknown operator, and a real operator the column does not accept', async () => {
    const invented = await post(
      'owner',
      '/api/v1/reports/run',
      studentQuery({ filters: [{ field: 'fullNameEn', operator: 'regex', value: '.*' }] }),
    );
    expect(invented.status, JSON.stringify(invented.body)).toBe(422);

    // `contains` is a perfectly good operator — on a text column. A uuid column does not
    // declare it, and the registry is what decides.
    const wrongType = await post(
      'owner',
      '/api/v1/reports/run',
      studentQuery({ filters: [{ field: 'id', operator: 'contains', value: 'abc' }] }),
    );
    expect(wrongType.status, JSON.stringify(wrongType.body)).toBe(422);
    expect(JSON.stringify(wrongType.body)).toContain('contains');
  });

  it('refuses a sort field outside the allow-list, and one the column forbids', async () => {
    const unknown = await post(
      'owner',
      '/api/v1/reports/run',
      studentQuery({ sorting: [{ field: 'notAColumn', direction: 'asc' }] }),
    );
    expect(unknown.status, JSON.stringify(unknown.body)).toBe(422);
    expect(JSON.stringify(unknown.body)).toContain('notAColumn');

    // `phone` is selectable and filterable but not declared sortable.
    const unsortable = await post(
      'owner',
      '/api/v1/reports/run',
      studentQuery({ columns: ['studentCode', 'phone'], sorting: [{ field: 'phone' }] }),
    );
    expect(unsortable.status, JSON.stringify(unsortable.body)).toBe(422);
    expect(JSON.stringify(unsortable.body)).toContain('phone');
  });

  it('refuses an aggregate the column does not declare, and grouping on a free column', async () => {
    const badAggregate = await post('owner', '/api/v1/reports/run', {
      query: {
        sourceKey: 'students',
        columns: ['gender'],
        grouping: {
          fields: ['gender'],
          aggregates: [{ field: 'fullNameEn', fn: 'sum' }],
        },
      },
    });
    expect(badAggregate.status, JSON.stringify(badAggregate.body)).toBe(422);

    // A column that is selected but not grouped would either vanish or produce a Postgres
    // error the caller cannot act on. It is refused up front.
    const strayColumn = await post('owner', '/api/v1/reports/run', {
      query: {
        sourceKey: 'students',
        columns: ['gender', 'fullNameEn'],
        grouping: { fields: ['gender'], aggregates: [{ field: 'id', fn: 'count' }] },
      },
    });
    expect(strayColumn.status, JSON.stringify(strayColumn.body)).toBe(422);
  });

  it('groups and aggregates when the registry allows it', async () => {
    const response = await post('owner', '/api/v1/reports/run', {
      query: {
        sourceKey: 'students',
        columns: ['gender'],
        grouping: { fields: ['gender'], aggregates: [{ field: 'id', fn: 'count' }] },
        sorting: [{ field: 'gender', direction: 'asc' }],
      },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const rows = response.body.rows as Record<string, unknown>[];
    const total = rows.reduce((sum, row) => sum + Number(row['count_id']), 0);
    // Six seeded students plus the outsider.
    expect(total).toBe(7);
  });

  // ──────────────────────────────────────────────────────────────────────────────────
  // Injection
  // ──────────────────────────────────────────────────────────────────────────────────

  it('refuses an injection attempt in a column name without touching the database', async () => {
    const response = await post(
      'owner',
      '/api/v1/reports/run',
      studentQuery({ columns: ['studentCode', '; drop table students; --'] }),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(422);

    // A quoted identifier is not a back door either: the key is looked up in a map, and
    // `"students"."medical_conditions"` is not a key.
    const quoted = await post(
      'owner',
      '/api/v1/reports/run',
      studentQuery({ columns: ['"students"."medical_conditions"'] }),
    );
    expect(quoted.status, JSON.stringify(quoted.body)).toBe(422);

    const client = testClient();
    await client.connect();
    try {
      const { rows } = await client.query<{ count: string }>(`select count(*) from students`);
      expect(Number(rows[0]!.count)).toBeGreaterThan(0);
    } finally {
      await client.end();
    }
  });

  it('parameterises an injection attempt in a filter value instead of executing it', async () => {
    // A legitimate search for a string that happens to contain SQL. It must return nothing
    // and must not error — a 500 here would itself be a finding.
    const dropAttempt = await post(
      'owner',
      '/api/v1/reports/run',
      studentQuery({
        filters: [
          { field: 'fullNameEn', operator: 'contains', value: "'; drop table students; --" },
        ],
      }),
    );
    expect(dropAttempt.status, JSON.stringify(dropAttempt.body)).toBe(200);
    expect(dropAttempt.body.rowCount).toBe(0);

    const tautology = await post(
      'owner',
      '/api/v1/reports/run',
      studentQuery({ filters: [{ field: 'fullNameEn', operator: 'eq', value: '1=1' }] }),
    );
    expect(tautology.status, JSON.stringify(tautology.body)).toBe(200);
    expect(tautology.body.rowCount).toBe(0);

    // The same string against a uuid column is not a search, and is refused before binding.
    const typed = await post(
      'owner',
      '/api/v1/reports/run',
      studentQuery({ filters: [{ field: 'id', operator: 'eq', value: '1=1' }] }),
    );
    expect(typed.status, JSON.stringify(typed.body)).toBe(422);

    const client = testClient();
    await client.connect();
    try {
      const { rows } = await client.query<{ count: string }>(`select count(*) from students`);
      expect(Number(rows[0]!.count)).toBeGreaterThan(0);
    } finally {
      await client.end();
    }
  });

  it('refuses an injection attempt in a sort field', async () => {
    const response = await post(
      'owner',
      '/api/v1/reports/run',
      studentQuery({
        sorting: [{ field: 'fullNameEn"; drop table students; --', direction: 'asc' }],
      }),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(422);

    const direction = await post(
      'owner',
      '/api/v1/reports/run',
      studentQuery({ sorting: [{ field: 'fullNameEn', direction: 'asc; drop table students' }] }),
    );
    expect(direction.status, JSON.stringify(direction.body)).toBe(422);
  });

  // ──────────────────────────────────────────────────────────────────────────────────
  // Data scope
  // ──────────────────────────────────────────────────────────────────────────────────

  it('runs an ad-hoc student report for a caller with students.view.all', async () => {
    const response = await post(
      'owner',
      '/api/v1/reports/run',
      studentQuery({ sorting: [{ field: 'studentCode', direction: 'asc' }] }),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.rowCount).toBe(7);
    expect(response.body.truncated).toBe(false);
    expect((response.body.columns as { key: string }[]).map((c) => c.key)).toEqual([
      'studentCode',
      'fullNameEn',
    ]);
    ownerRunId = response.body.runId as string;
    expect(ownerRunId).toBeTruthy();
  });

  it("restricts a class teacher's student report to their assigned students", async () => {
    // The teacher holds `reports.view` but not `reports.build`, so they run a saved report
    // rather than composing one — which is exactly the shape a school uses in practice.
    const created = await post('principal', '/api/v1/reports/definitions', {
      key: 'student-roster',
      name: 'Student roster',
      query: {
        sourceKey: 'students',
        columns: ['studentCode', 'fullNameEn'],
        sorting: [{ field: 'studentCode', direction: 'asc' }],
      },
      visibility: 'institution',
      status: 'published',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    rosterDefinitionId = created.body.id as string;

    const asPrincipal = await post(
      'principal',
      `/api/v1/reports/definitions/${rosterDefinitionId}/run`,
    );
    expect(asPrincipal.status, JSON.stringify(asPrincipal.body)).toBe(200);
    expect(asPrincipal.body.rowCount).toBe(7);

    const asTeacher = await post(
      'teacher',
      `/api/v1/reports/definitions/${rosterDefinitionId}/run`,
    );
    expect(asTeacher.status, JSON.stringify(asTeacher.body)).toBe(200);
    const codes = (asTeacher.body.rows as { studentCode: string }[]).map((r) => r.studentCode);
    expect(codes).toHaveLength(6);
    expect(codes).not.toContain(OUTSIDER_CODE);
    for (const code of codes) expect(code.startsWith('rpta-S')).toBe(true);
  });

  it("restricts a guardian's finance report to their own children", async () => {
    // The guardian holds `finance.own.view` but no `reports.view`, so the reporting surface
    // is closed to them entirely — a narrower scope is not the same as a smaller report.
    const response = await post('guardian', '/api/v1/reports/run', {
      query: { sourceKey: 'invoices', columns: ['invoiceNumber', 'total'] },
    });
    expect(response.status).toBe(403);
  });

  it('returns nothing across a tenant boundary, and refuses the other tenant’s institution', async () => {
    const bReport = await request(app.getHttpServer())
      .post('/api/v1/reports/run')
      .set('Authorization', `Bearer ${tokens['bOwner']}`)
      .set('x-institution-id', tenantB.institutionId)
      .send(studentQuery());
    expect(bReport.status, JSON.stringify(bReport.body)).toBe(200);
    const bCodes = (bReport.body.rows as { studentCode: string }[]).map((r) => r.studentCode);
    expect(bCodes).toHaveLength(3);
    for (const code of bCodes) expect(code.startsWith('rptb-')).toBe(true);
    expect(bCodes).not.toContain(OUTSIDER_CODE);

    // Naming another tenant's institution in the header is refused before any query runs.
    const crossHeader = await request(app.getHttpServer())
      .post('/api/v1/reports/run')
      .set('Authorization', `Bearer ${tokens['owner']}`)
      .set('x-institution-id', tenantB.institutionId)
      .send(studentQuery());
    expect(crossHeader.status).toBe(403);
  });

  it('hides tenant A’s saved reports and runs from tenant B at the database level', async () => {
    expect(rosterDefinitionId).toBeTruthy();

    // Row-level security, not a service filter: the application role sees nothing at all.
    const visibleToB = await asAppRole(tenantB.tenantId, async (client) => {
      const { rows } = await client.query<{ count: string }>(
        `select count(*) from report_definitions where id = $1`,
        [rosterDefinitionId],
      );
      return Number(rows[0]!.count);
    });
    expect(visibleToB).toBe(0);

    const runsVisibleToB = await asAppRole(tenantB.tenantId, async (client) => {
      const { rows } = await client.query<{ count: string }>(
        `select count(*) from report_runs where tenant_id = $1`,
        [tenantA.tenantId],
      );
      return Number(rows[0]!.count);
    });
    expect(runsVisibleToB).toBe(0);

    // And tenant B's own session does see its own rows, so the zero above is isolation
    // rather than an empty table.
    const visibleToA = await asAppRole(tenantA.tenantId, async (client) => {
      const { rows } = await client.query<{ count: string }>(
        `select count(*) from report_definitions where id = $1`,
        [rosterDefinitionId],
      );
      return Number(rows[0]!.count);
    });
    expect(visibleToA).toBe(1);
  });

  // ──────────────────────────────────────────────────────────────────────────────────
  // Column-level permissions
  // ──────────────────────────────────────────────────────────────────────────────────

  it('omits a medical column from the rows for a caller who may not read it', async () => {
    const asOwner = await post(
      'owner',
      '/api/v1/reports/run',
      studentQuery({ columns: ['studentCode', 'medicalConditions'] }),
    );
    expect(asOwner.status, JSON.stringify(asOwner.body)).toBe(200);
    expect(asOwner.body.omittedColumns).toEqual([]);
    const withNote = (asOwner.body.rows as Record<string, unknown>[]).filter(
      (row) => row['medicalConditions'] === 'Asthma',
    );
    expect(withNote).toHaveLength(1);

    const asPrincipal = await post(
      'principal',
      '/api/v1/reports/run',
      studentQuery({ columns: ['studentCode', 'medicalConditions'] }),
    );
    expect(asPrincipal.status, JSON.stringify(asPrincipal.body)).toBe(200);
    expect(asPrincipal.body.omittedColumns).toEqual(['medicalConditions']);
    expect((asPrincipal.body.columns as { key: string }[]).map((c) => c.key)).toEqual([
      'studentCode',
    ]);
    for (const row of asPrincipal.body.rows as Record<string, unknown>[]) {
      // Absent, not null: a null column implies the value is empty, which is a claim.
      expect(Object.prototype.hasOwnProperty.call(row, 'medicalConditions')).toBe(false);
    }
  });

  it('refuses to filter, sort or group on a column the caller may not read', async () => {
    // Filtering on an invisible column is an oracle even though it never appears in the
    // output: "does any student's medical note contain 'HIV'?" is answerable from a row count.
    const filtered = await post(
      'principal',
      '/api/v1/reports/run',
      studentQuery({
        filters: [{ field: 'medicalConditions', operator: 'contains', value: 'Asthma' }],
      }),
    );
    expect(filtered.status, JSON.stringify(filtered.body)).toBe(422);
    expect(JSON.stringify(filtered.body)).toContain('medicalConditions');

    const sorted = await post(
      'principal',
      '/api/v1/reports/run',
      studentQuery({ sorting: [{ field: 'allergies', direction: 'asc' }] }),
    );
    expect(sorted.status).toBe(422);
  });

  it('omits the salary column from the rows without payroll.payslips.view.all', async () => {
    const asOwner = await post('owner', '/api/v1/reports/run', {
      query: { sourceKey: 'employees', columns: ['employeeCode', 'basicSalary'] },
    });
    expect(asOwner.status, JSON.stringify(asOwner.body)).toBe(200);
    const salaries = (asOwner.body.rows as Record<string, unknown>[])
      .map((row) => row['basicSalary'])
      .filter((value) => value !== null && value !== undefined);
    expect(salaries).toContain('42000.00');

    const asPrincipal = await post('principal', '/api/v1/reports/run', {
      query: { sourceKey: 'employees', columns: ['employeeCode', 'basicSalary'] },
    });
    expect(asPrincipal.status, JSON.stringify(asPrincipal.body)).toBe(200);
    expect(asPrincipal.body.omittedColumns).toEqual(['basicSalary']);
    for (const row of asPrincipal.body.rows as Record<string, unknown>[]) {
      expect(Object.prototype.hasOwnProperty.call(row, 'basicSalary')).toBe(false);
    }
  });

  it('refuses a report whose every requested column is invisible to the caller', async () => {
    const response = await post(
      'principal',
      '/api/v1/reports/run',
      studentQuery({ columns: ['medicalConditions', 'allergies'] }),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(422);
  });

  // ──────────────────────────────────────────────────────────────────────────────────
  // Limits and exports
  // ──────────────────────────────────────────────────────────────────────────────────

  it('enforces the row limit and reports the result as truncated', async () => {
    const response = await post(
      'owner',
      '/api/v1/reports/run',
      studentQuery({ limit: 2, sorting: [{ field: 'studentCode', direction: 'asc' }] }),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.rowCount).toBe(2);
    expect(response.body.truncated).toBe(true);
    expect((response.body.rows as unknown[]).length).toBe(2);

    // And the run record says so, so an auditor can tell a partial answer from a complete one.
    const run = await get('owner', `/api/v1/reports/runs/${response.body.runId}`);
    expect(run.status).toBe(200);
    expect(run.body.rowCount).toBe(2);
    expect(run.body.status).toBe('succeeded');
    expect((run.body.parameters as Record<string, unknown>)['truncated']).toBe(true);

    // Exporting a truncated result is refused rather than silently handing back a file that
    // looks complete.
    const refused = await post(
      'owner',
      `/api/v1/reports/runs/${response.body.runId}/exports`,
      { format: 'csv' },
    );
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
  });

  it('exports a run, writes an audit record for it, and serves the file', async () => {
    expect(ownerRunId).toBeTruthy();

    const created = await post('owner', `/api/v1/reports/runs/${ownerRunId}/exports`, {
      format: 'csv',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const exportId = created.body.export.id as string;
    expect(created.body.rowCount).toBe(7);
    expect(created.body.basedOnRunId).toBe(ownerRunId);
    // The export gets its own run: it is a fresh disclosure, not a footnote on the old one.
    expect(created.body.runId).not.toBe(ownerRunId);

    const client = testClient();
    await client.connect();
    try {
      const { rows } = await client.query<{
        action: string;
        module: string;
        resource_type: string;
        actor_user_id: string;
        resource_id: string;
      }>(
        `select action, module, resource_type, actor_user_id, resource_id
           from audit_logs
          where module = 'reports' and resource_type = 'report_export' and resource_id = $1
          order by occurred_at desc`,
        [exportId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.action).toBe('export');
      expect(rows[0]!.actor_user_id).toBe(tenantA.users['owner']!.id);
    } finally {
      await client.end();
    }

    const download = await get('owner', `/api/v1/reports/exports/${exportId}/download`);
    expect(download.status, download.text).toBe(200);
    expect(download.headers['content-type']).toContain('text/csv');
    expect(download.text.split('\r\n')[0]).toBe('studentCode,fullNameEn');
    // Seven data rows plus the header plus the trailing newline.
    expect(download.text.trimEnd().split('\r\n')).toHaveLength(8);

    // The download is a disclosure in its own right and is audited separately.
    const auditClient = testClient();
    await auditClient.connect();
    try {
      const { rows } = await auditClient.query<{ count: string }>(
        `select count(*) from audit_logs
          where module = 'reports' and resource_type = 'report_export_download'
            and resource_id = $1`,
        [exportId],
      );
      expect(Number(rows[0]!.count)).toBe(1);
    } finally {
      await auditClient.end();
    }
  });

  it('refuses to serve an export whose download window has closed', async () => {
    expect(ownerRunId).toBeTruthy();

    const expiredId = uuidv7();
    const client = testClient();
    await client.connect();
    try {
      // The creation timestamp moves with the expiry: `report_exports_expiry_after_creation`
      // checks that expires_at > created_at, so backdating only the expiry would fail on the
      // constraint instead of testing the expiry behaviour.
      await client.query(
        `insert into report_exports
           (id, tenant_id, institution_id, run_id, format, storage_key, size_bytes, row_count,
            created_at, updated_at, expires_at)
         values ($1,$2,$3,$4,'csv',$5,10,1,
                 now() - interval '8 days', now() - interval '8 days', now() - interval '1 day')`,
        [
          expiredId,
          tenantA.tenantId,
          tenantA.institutionId,
          ownerRunId,
          `tenants/${tenantA.tenantId}/reports/${expiredId}.csv`,
        ],
      );
    } finally {
      await client.end();
    }

    const response = await get('owner', `/api/v1/reports/exports/${expiredId}/download`);
    expect(response.status, JSON.stringify(response.body)).toBe(412);
  });

  // ──────────────────────────────────────────────────────────────────────────────────
  // Permission denials
  // ──────────────────────────────────────────────────────────────────────────────────

  it('refuses the whole reporting surface to a caller with no reports permission', async () => {
    const sources = await get('guardian', '/api/v1/reports/sources');
    expect(sources.status).toBe(403);
  });

  it('separates running a saved report from composing one', async () => {
    // `reports.view` lets you run what exists; composing an ad-hoc query needs `reports.build`.
    const teacherAdHoc = await post('teacher', '/api/v1/reports/run', studentQuery());
    expect(teacherAdHoc.status).toBe(403);

    const adminAdHoc = await post('admin', '/api/v1/reports/run', studentQuery());
    expect(adminAdHoc.status).toBe(403);

    const adminSave = await post('admin', '/api/v1/reports/definitions', {
      key: 'admin-attempt',
      name: 'Admin attempt',
      query: { sourceKey: 'students', columns: ['studentCode'] },
    });
    expect(adminSave.status).toBe(403);
  });

  it('keeps a private report private until it is shared', async () => {
    const created = await post('principal', '/api/v1/reports/definitions', {
      key: 'principal-private',
      name: 'Principal only',
      query: { sourceKey: 'students', columns: ['studentCode', 'fullNameEn'] },
      visibility: 'private',
      status: 'published',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    privateDefinitionId = created.body.id as string;

    const hidden = await get('admin', `/api/v1/reports/definitions/${privateDefinitionId}`);
    expect(hidden.status).toBe(404);

    const shared = await post(
      'principal',
      `/api/v1/reports/definitions/${privateDefinitionId}/shares`,
      { userId: tenantA.users['admin']!.id },
    );
    expect(shared.status, JSON.stringify(shared.body)).toBe(201);

    const nowVisible = await get('admin', `/api/v1/reports/definitions/${privateDefinitionId}`);
    expect(nowVisible.status, JSON.stringify(nowVisible.body)).toBe(200);

    // Visible is not editable, even for someone who holds `reports.build`: sharing a
    // question does not hand over authorship of it.
    const sharedWithOwner = await post(
      'principal',
      `/api/v1/reports/definitions/${privateDefinitionId}/shares`,
      { userId: tenantA.users['owner']!.id },
    );
    expect(sharedWithOwner.status, JSON.stringify(sharedWithOwner.body)).toBe(201);

    const rejected = await request(app.getHttpServer())
      .patch(`/api/v1/reports/definitions/${privateDefinitionId}`)
      .set('Authorization', `Bearer ${tokens['owner']}`)
      .set('x-institution-id', tenantA.institutionId)
      .send({ name: 'Renamed', version: nowVisible.body.version });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(403);

    // The author can, and the optimistic lock still applies.
    const renamed = await request(app.getHttpServer())
      .patch(`/api/v1/reports/definitions/${privateDefinitionId}`)
      .set('Authorization', `Bearer ${tokens['principal']}`)
      .set('x-institution-id', tenantA.institutionId)
      .send({ name: 'Principal only (renamed)', version: nowVisible.body.version });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);

    const stale = await request(app.getHttpServer())
      .patch(`/api/v1/reports/definitions/${privateDefinitionId}`)
      .set('Authorization', `Bearer ${tokens['principal']}`)
      .set('x-institution-id', tenantA.institutionId)
      .send({ name: 'Again', version: nowVisible.body.version });
    expect(stale.status).toBe(409);
  });

  // ──────────────────────────────────────────────────────────────────────────────────
  // Schedules
  // ──────────────────────────────────────────────────────────────────────────────────

  it('schedules a report, computes its next run, and fires it on demand', async () => {
    expect(privateDefinitionId).toBeTruthy();

    const created = await post('principal', '/api/v1/reports/schedules', {
      definitionId: privateDefinitionId,
      cronExpression: '0 6 * * *',
      recipients: [tenantA.users['admin']!.id],
      format: 'csv',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const scheduleId = created.body.id as string;
    expect(created.body.nextRunAt).toBeTruthy();
    expect(new Date(created.body.nextRunAt as string).getTime()).toBeGreaterThan(Date.now());

    const fired = await post('principal', `/api/v1/reports/schedules/${scheduleId}/run`);
    expect(fired.status, JSON.stringify(fired.body)).toBe(201);
    const scheduledExportId = fired.body.export.id as string;

    // A recipient may take the file even though they did not run it — which is what makes
    // `recipients` a permission rather than a decorative list.
    const byRecipient = await get(
      'admin',
      `/api/v1/reports/exports/${scheduledExportId}/download`,
    );
    expect(byRecipient.status, byRecipient.text).toBe(200);

    // The accountant holds `reports.export` but is neither the runner, nor a recipient, nor
    // able to see a private definition.
    const byStranger = await get(
      'accountant',
      `/api/v1/reports/exports/${scheduledExportId}/download`,
    );
    expect(byStranger.status).toBe(404);
  });

  it('refuses a cron expression that could never fire, and an unsupported timezone', async () => {
    const impossible = await post('principal', '/api/v1/reports/schedules', {
      definitionId: privateDefinitionId,
      cronExpression: '0 6 32 * *',
      format: 'csv',
    });
    expect(impossible.status, JSON.stringify(impossible.body)).toBe(422);

    const zoned = await post('principal', '/api/v1/reports/schedules', {
      definitionId: privateDefinitionId,
      cronExpression: '0 6 * * *',
      timezone: 'Europe/London',
      format: 'csv',
    });
    expect(zoned.status, JSON.stringify(zoned.body)).toBe(422);
  });

  // ──────────────────────────────────────────────────────────────────────────────────
  // Invariants the DATABASE enforces
  //
  // Everything below bypasses the service entirely: a raw client as `shikkha_app`, the same
  // unprivileged role the API holds. If any of these succeeds, the control lives only in
  // TypeScript and a bug — or a compromised process — removes it.
  // ──────────────────────────────────────────────────────────────────────────────────

  it('refuses a run that is both a saved definition and an ad-hoc document', async () => {
    await expect(
      asAppRole(tenantA.tenantId, async (client) => {
        await client.query(
          `insert into report_runs
             (tenant_id, institution_id, definition_id, ad_hoc_definition, run_by, status)
           values ($1,$2,$3,$4::jsonb,$5,'running')`,
          [
            tenantA.tenantId,
            tenantA.institutionId,
            rosterDefinitionId,
            JSON.stringify({ sourceKey: 'students', columns: ['id'] }),
            tenantA.users['owner']!.id,
          ],
        );
      }),
    ).rejects.toThrow(/report_runs_definition_xor_ad_hoc/);
  });

  it('refuses a run that is neither a saved definition nor an ad-hoc document', async () => {
    await expect(
      asAppRole(tenantA.tenantId, async (client) => {
        await client.query(
          `insert into report_runs (tenant_id, institution_id, run_by, status)
           values ($1,$2,$3,'running')`,
          [tenantA.tenantId, tenantA.institutionId, tenantA.users['owner']!.id],
        );
      }),
    ).rejects.toThrow(/report_runs_definition_xor_ad_hoc/);
  });

  it('refuses a successful run that does not say how many rows it disclosed', async () => {
    await expect(
      asAppRole(tenantA.tenantId, async (client) => {
        await client.query(
          `insert into report_runs
             (tenant_id, institution_id, ad_hoc_definition, run_by, status, finished_at)
           values ($1,$2,$3::jsonb,$4,'succeeded',now())`,
          [
            tenantA.tenantId,
            tenantA.institutionId,
            JSON.stringify({ sourceKey: 'students', columns: ['id'] }),
            tenantA.users['owner']!.id,
          ],
        );
      }),
    ).rejects.toThrow(/report_runs_success_counted/);
  });

  it('refuses to reopen or rewrite a settled run', async () => {
    expect(ownerRunId).toBeTruthy();
    await expect(
      asAppRole(tenantA.tenantId, async (client) => {
        await client.query(`update report_runs set row_count = 0 where id = $1`, [ownerRunId]);
      }),
    ).rejects.toThrow(/already settled/);
  });

  it('refuses to delete a run', async () => {
    await expect(
      asAppRole(tenantA.tenantId, async (client) => {
        await client.query(`delete from report_runs where id = $1`, [ownerRunId]);
      }),
    ).rejects.toThrow(/never deleted/);
  });

  it('refuses an export whose expiry does not follow its creation', async () => {
    await expect(
      asAppRole(tenantA.tenantId, async (client) => {
        await client.query(
          `insert into report_exports
             (tenant_id, institution_id, run_id, format, storage_key, size_bytes, row_count, expires_at)
           values ($1,$2,$3,'csv',$4,10,1, now() - interval '1 hour')`,
          [
            tenantA.tenantId,
            tenantA.institutionId,
            ownerRunId,
            `tenants/${tenantA.tenantId}/reports/${uuidv7()}.csv`,
          ],
        );
      }),
    ).rejects.toThrow(/report_exports_expiry_after_creation/);
  });

  it('refuses an export against a run that never succeeded', async () => {
    await expect(
      asAppRole(tenantA.tenantId, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `insert into report_runs
             (tenant_id, institution_id, ad_hoc_definition, run_by, status)
           values ($1,$2,$3::jsonb,$4,'running')
           returning id`,
          [
            tenantA.tenantId,
            tenantA.institutionId,
            JSON.stringify({ sourceKey: 'students', columns: ['id'] }),
            tenantA.users['owner']!.id,
          ],
        );
        await client.query(
          `insert into report_exports
             (tenant_id, institution_id, run_id, format, storage_key, size_bytes, row_count, expires_at)
           values ($1,$2,$3,'csv',$4,10,1, now() + interval '1 day')`,
          [
            tenantA.tenantId,
            tenantA.institutionId,
            rows[0]!.id,
            `tenants/${tenantA.tenantId}/reports/${uuidv7()}.csv`,
          ],
        );
      }),
    ).rejects.toThrow(/has not succeeded/);
  });

  it('refuses to edit or delete an export at all', async () => {
    const exportId = await asAppRole(tenantA.tenantId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `select id from report_exports where institution_id = $1 order by created_at limit 1`,
        [tenantA.institutionId],
      );
      return rows[0]?.id ?? null;
    });
    expect(exportId).toBeTruthy();

    await expect(
      asAppRole(tenantA.tenantId, async (client) => {
        await client.query(
          `update report_exports set expires_at = now() + interval '10 years' where id = $1`,
          [exportId],
        );
      }),
    ).rejects.toThrow(/immutable/);

    await expect(
      asAppRole(tenantA.tenantId, async (client) => {
        await client.query(`delete from report_exports where id = $1`, [exportId]);
      }),
    ).rejects.toThrow(/never deleted/);
  });

  it('refuses a share that names both a role and a user, or neither', async () => {
    await expect(
      asAppRole(tenantA.tenantId, async (client) => {
        await client.query(
          `insert into report_shares (tenant_id, institution_id, definition_id, role_id, user_id)
           values ($1,$2,$3,$4,$5)`,
          [
            tenantA.tenantId,
            tenantA.institutionId,
            rosterDefinitionId,
            tenantA.roleIds['teacher'],
            tenantA.users['teacher']!.id,
          ],
        );
      }),
    ).rejects.toThrow(/report_shares_role_xor_user/);

    await expect(
      asAppRole(tenantA.tenantId, async (client) => {
        await client.query(
          `insert into report_shares (tenant_id, institution_id, definition_id)
           values ($1,$2,$3)`,
          [tenantA.tenantId, tenantA.institutionId, rosterDefinitionId],
        );
      }),
    ).rejects.toThrow(/report_shares_role_xor_user/);
  });

  it('refuses a definition document that is a scalar rather than a list', async () => {
    await expect(
      asAppRole(tenantA.tenantId, async (client) => {
        await client.query(
          `insert into report_definitions
             (tenant_id, institution_id, key, name, source_key, columns)
           values ($1,$2,'scalar-columns','Scalar','students', '"drop table students"'::jsonb)`,
          [tenantA.tenantId, tenantA.institutionId],
        );
      }),
    ).rejects.toThrow(/report_definitions_columns_is_array/);
  });

  it('refuses to point one institution’s schedule at another institution’s definition', async () => {
    // Row-level security stops the cross-*tenant* case. This is the smaller gap inside one
    // tenant: a group running several schools must not export School B's data on School A's
    // schedule. A second institution is created for the test and left in place.
    const otherInstitutionId = uuidv7();
    const client = testClient();
    await client.connect();
    try {
      await client.query(
        `insert into institutions (id, tenant_id, code, name_en, type, medium)
         values ($1,$2,'rpta-INST2','rpta Second Institution','school','bangla')`,
        [otherInstitutionId, tenantA.tenantId],
      );
    } finally {
      await client.end();
    }

    await expect(
      asAppRole(tenantA.tenantId, async (raw) => {
        await raw.query(
          `insert into report_schedules
             (tenant_id, institution_id, definition_id, cron_expression)
           values ($1,$2,$3,'0 6 * * *')`,
          [tenantA.tenantId, otherInstitutionId, rosterDefinitionId],
        );
      }),
    ).rejects.toThrow(/belongs to a different institution/);
  });
});
