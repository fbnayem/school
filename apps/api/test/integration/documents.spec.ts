/**
 * Documents and certificates integration suite (Phase 23).
 *
 * The load-bearing tests here are not "the route returns 200". They are the four promises the
 * module makes, and three of them are proved UNDER the service with a raw `pg` client
 * connected as `shikkha_app` — the same unprivileged role the API uses:
 *
 *  - **An issued document is immutable.** UPDATE of `rendered_html` and of `data_snapshot`,
 *    and DELETE, are all refused by `issued_documents_immutable`. Revocation — the one legal
 *    update — is accepted.
 *  - **Four eyes.** `document_requests_approver_not_requester` refuses `approved_by =
 *    requested_by` in raw SQL, and the service refuses it for the school owner, whose role is
 *    `*` and who therefore cannot be told no by the permission system.
 *  - **An approval cannot be skipped.** Inserting an issued document with no request for a
 *    template that requires approval is refused by `issued_documents_approval_required`.
 *  - **An active template is immutable.** `document_templates_immutable` refuses a raw UPDATE
 *    of `body_html`, so "editing" can only mean publishing a new version.
 *
 * Above the database: the renderer executes nothing (a `<script>` tag stored in a student's
 * legal name prints as text; `{{__proto__.x}}`, `{{constructor.name}}` and an unknown variable
 * are all clear errors, never silent blanks), a certificate keeps asserting what was true when
 * it was issued even after the student's record changes, a teacher cannot produce a document
 * for a student they cannot see, and the public verification endpoint leaks exactly four
 * fields.
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

/** A student certificate. Every placeholder is on the allow-list. */
const CERTIFICATE_BODY = `<section class="certificate">
  <h1>{{institution.nameEn}}</h1>
  <p class="serial">Serial {{document.serialNumber}} · Code {{document.verificationCode}}</p>
  <p>This is to certify that <strong>{{student.fullNameEn}}</strong> (roll
  {{student.rollNumber}} of class {{student.className}}, session {{student.academicYear}})
  bore a good moral character while studying at this institution.</p>
  <p>Issued on {{document.issuedOn}} for {{document.purpose}}.</p>
</section>`;

const CERTIFICATE_BODY_V2 = `${CERTIFICATE_BODY}\n<p>Revised wording, version two.</p>`;

/** No approval needed, so it can be issued in bulk. */
const CHARACTER_BODY = `<p>{{student.fullNameEn}} of {{institution.nameEn}} — {{document.serialNumber}}</p>`;

describe('Documents and certificates', () => {
  let app: INestApplication;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
  const tokens: Record<string, string> = {};

  /** Section B of tenant A: no teacher assigned, so it is outside the teacher's data scope. */
  let sectionBId: string;
  let outsiderStudentId: string;
  /** The student whose legal name contains a script tag. */
  let scriptNameStudentId: string;

  let templateV1Id: string;
  let templateV2Id: string;
  let bulkTemplateId: string;
  let hostileTemplateId: string;

  let ownerRequestId: string;
  let issuedDocumentId: string;
  let issuedSerial: string;
  let issuedCode: string;

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

  const patch = (role: string, path: string, body: object = {}) =>
    request(app.getHttpServer())
      .patch(path)
      .set('Authorization', `Bearer ${tokens[role]}`)
      .set('x-institution-id', tenantA.institutionId)
      .send(body);

  /**
   * Run as the unprivileged application role inside one transaction with the tenant GUC set —
   * exactly the credentials a compromised application would hold. Rolled back afterwards, so a
   * refused write cannot leak state into later tests.
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

  /** Await a query the database must refuse, returning the pg error for inspection. */
  async function expectRefusal(work: Promise<unknown>): Promise<{
    message: string;
    constraint?: string;
    code?: string;
  }> {
    try {
      await work;
    } catch (error) {
      return error as { message: string; constraint?: string; code?: string };
    }
    throw new Error('Expected the database to refuse this write, but it was accepted');
  }

  async function sqlOne<T>(text: string, params: unknown[] = []): Promise<T> {
    const client = testClient();
    await client.connect();
    try {
      const { rows } = await client.query<T>(text, params);
      return rows[0] as T;
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    app = await createTestApp();
    await truncateAll();
    tenantA = await seedTenant('doca', { students: 3 });
    tenantB = await seedTenant('docb', { students: 2 });

    for (const key of ['owner', 'principal', 'admin', 'teacher', 'accountant']) {
      tokens[key] = await login(tenantA.users[key]!.email);
    }
    tokens['guardian1'] = await login(tenantA.users['guardian1']!.email);
    tokens['guardian2'] = await login(tenantA.users['guardian2']!.email);
    tokens['otherPrincipal'] = await login(tenantB.users['principal']!.email);

    // A section the seeded teacher is NOT assigned to, with one student in it. This is what
    // makes the data-scope assertions meaningful: without it every seeded student is inside
    // the teacher's scope and "a teacher cannot see this student" is untestable.
    sectionBId = uuidv7();
    outsiderStudentId = uuidv7();
    const client = testClient();
    await client.connect();
    try {
      await client.query(
        `insert into sections (id, tenant_id, institution_id, campus_id, academic_year_id, class_level_id, name_en, capacity)
         values ($1,$2,$3,$4,$5,$6,'B',60)`,
        [
          sectionBId,
          tenantA.tenantId,
          tenantA.institutionId,
          tenantA.campusId,
          tenantA.academicYearId,
          tenantA.classLevelId,
        ],
      );
      await client.query(
        `insert into students (id, tenant_id, institution_id, student_code, admission_number, admission_date, full_name_en, date_of_birth, gender, status)
         values ($1,$2,$3,'doca-SB1','doca-AB1','2026-01-05','Outside Section Student','2014-03-02','female','active')`,
        [outsiderStudentId, tenantA.tenantId, tenantA.institutionId],
      );
      await client.query(
        `insert into enrollments (id, tenant_id, institution_id, campus_id, student_id, academic_year_id, class_level_id, section_id, roll_number, status, enrolled_on)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'1','active','2026-01-05')`,
        [
          uuidv7(),
          tenantA.tenantId,
          tenantA.institutionId,
          tenantA.campusId,
          outsiderStudentId,
          tenantA.academicYearId,
          tenantA.classLevelId,
          sectionBId,
        ],
      );

      // A legal name containing markup. Names like this exist because data entry is done by
      // people, and a renderer that trusts its inputs turns one of them into stored XSS.
      scriptNameStudentId = tenantA.studentIds[2]!;
      await client.query(`update students set full_name_en = $2 where id = $1`, [
        scriptNameStudentId,
        `<script>alert('xss')</script>`,
      ]);
    } finally {
      await client.end();
    }
  }, 180_000);

  afterAll(async () => {
    await app?.close();
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Template authoring — the renderer never gets a template it cannot resolve
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('template authoring', () => {
    it('creates version 1 of a transfer certificate template', async () => {
      const response = await post('principal', '/api/v1/documents/templates', {
        key: 'transfer-certificate',
        name: 'Transfer Certificate',
        nameBn: 'ছাড়পত্র',
        kind: 'transfer_certificate',
        bodyHtml: CERTIFICATE_BODY,
        headerHtml: '<header>{{institution.nameEn}} · {{institution.code}}</header>',
        requiresApproval: true,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.version).toBe(1);
      expect(response.body.isActive).toBe(true);
      expect(response.body.requiresApproval).toBe(true);
      // The declared allow-list is derived from the markup, not supplied by the client.
      expect(response.body.variables).toContain('student.fullNameEn');
      expect(response.body.variables).toContain('institution.code');
      templateV1Id = response.body.id;
    });

    it('creates a second template that needs no approval', async () => {
      const response = await post('principal', '/api/v1/documents/templates', {
        key: 'character-certificate',
        name: 'Character Certificate',
        kind: 'character_certificate',
        bodyHtml: CHARACTER_BODY,
        requiresApproval: false,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      bulkTemplateId = response.body.id;
    });

    it('REFUSES {{__proto__.x}} — a placeholder name cannot start with an underscore', async () => {
      const response = await post('principal', '/api/v1/documents/templates', {
        key: 'proto-probe',
        name: 'Proto probe',
        kind: 'custom',
        bodyHtml: '<p>{{__proto__.x}}</p>',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(JSON.stringify(response.body)).toMatch(/placeholder name/i);
    });

    it('REFUSES {{constructor.name}} — it is a name nobody registered, not a property', async () => {
      const response = await post('principal', '/api/v1/documents/templates', {
        key: 'ctor-probe',
        name: 'Constructor probe',
        kind: 'custom',
        bodyHtml: '<p>{{constructor.name}}</p>',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(JSON.stringify(response.body)).toContain('constructor.name');
    });

    it('REFUSES an unknown variable with a clear error rather than a silent blank', async () => {
      const response = await post('principal', '/api/v1/documents/templates', {
        key: 'unknown-variable',
        name: 'Unknown variable',
        kind: 'custom',
        bodyHtml: '<p>Hello {{student.favouriteColour}}</p>',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(JSON.stringify(response.body)).toContain('student.favouriteColour');
      expect(response.body.error.message).toMatch(/do not exist|does not exist/i);
    });

    it('REFUSES executable markup in a template body', async () => {
      const script = await post('principal', '/api/v1/documents/templates', {
        key: 'script-template',
        name: 'Script template',
        kind: 'custom',
        bodyHtml: '<p>hi</p><script>fetch("/steal")</script>',
      });
      expect(script.status).toBe(422);

      const handler = await post('principal', '/api/v1/documents/templates', {
        key: 'handler-template',
        name: 'Handler template',
        kind: 'custom',
        bodyHtml: '<p onclick="steal()">hi</p>',
      });
      expect(handler.status).toBe(422);
    });

    it('REFUSES a nested or stray brace', async () => {
      const response = await post('principal', '/api/v1/documents/templates', {
        key: 'brace-template',
        name: 'Brace template',
        kind: 'custom',
        bodyHtml: '<p>{{{{student.fullNameEn}}}}</p>',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(422);
    });

    it('REFUSES a template that mixes two kinds of subject', async () => {
      const response = await post('principal', '/api/v1/documents/templates', {
        key: 'mixed-subject',
        name: 'Mixed subject',
        kind: 'custom',
        bodyHtml: '<p>{{student.fullNameEn}} works for {{employee.fullNameEn}}</p>',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(JSON.stringify(response.body)).toMatch(/single subject/i);
    });

    it('refuses a duplicate template key', async () => {
      const response = await post('principal', '/api/v1/documents/templates', {
        key: 'transfer-certificate',
        name: 'Another one',
        kind: 'testimonial',
        bodyHtml: '<p>{{institution.nameEn}}</p>',
      });
      expect(response.status).toBe(409);
    });

    it('publishes the variable vocabulary so an author is not guessing', async () => {
      const response = await get('principal', '/api/v1/documents/variables');
      expect(response.status).toBe(200);
      expect(response.body.student).toContain('student.fullNameEn');
      expect(response.body.common).toContain('document.serialNumber');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Permission enforcement
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('permission enforcement', () => {
    it('refuses template authoring to a role that may only generate documents', async () => {
      const response = await post('accountant', '/api/v1/documents/templates', {
        key: 'sneaky',
        name: 'Sneaky',
        kind: 'custom',
        bodyHtml: '<p>{{institution.nameEn}}</p>',
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
      // Naming the missing permission would be free reconnaissance.
      expect(JSON.stringify(response.body)).not.toContain('documents.templates.manage');
    });

    it('refuses a guardian the issuance register and the issued-document list', async () => {
      const register = await get('guardian1', '/api/v1/documents/reports/register', {
        from: '2026-01-01',
        to: '2026-12-31',
      });
      expect(register.status).toBe(403);

      const issued = await get('guardian1', '/api/v1/documents/issued');
      expect(issued.status).toBe(403);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Versioning: an active template is immutable
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('template versioning', () => {
    it('publishes version 2 rather than editing version 1', async () => {
      const response = await patch('principal', `/api/v1/documents/templates/${templateV1Id}`, {
        expectedVersion: 1,
        bodyHtml: CERTIFICATE_BODY_V2,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.version).toBe(2);
      expect(response.body.id).not.toBe(templateV1Id);
      expect(response.body.key).toBe('transfer-certificate');
      templateV2Id = response.body.id;
    });

    it('leaves version 1 in place, deactivated', async () => {
      const response = await get('principal', `/api/v1/documents/templates/${templateV2Id}`);
      expect(response.status).toBe(200);
      const versions = response.body.versions as Array<{ version: number; isActive: boolean }>;
      expect(versions.map((v) => v.version)).toEqual([2, 1]);
      expect(versions.find((v) => v.version === 1)!.isActive).toBe(false);
      expect(versions.find((v) => v.version === 2)!.isActive).toBe(true);
    });

    it('refuses an edit against a stale version', async () => {
      const response = await patch('principal', `/api/v1/documents/templates/${templateV1Id}`, {
        expectedVersion: 1,
        bodyHtml: '<p>{{institution.nameEn}}</p>',
      });
      expect(response.status).toBe(409);
    });

    it('the DATABASE refuses a raw edit of a template body', async () => {
      const error = await asAppRole(tenantA.tenantId, (client) =>
        expectRefusal(
          client.query(`update document_templates set body_html = $2 where id = $1`, [
            templateV2Id,
            '<p>rewritten under the certificates already issued</p>',
          ]),
        ),
      );
      expect(error.message).toMatch(/immutable/i);
    });

    it('the DATABASE refuses deleting a template', async () => {
      const error = await asAppRole(tenantA.tenantId, (client) =>
        expectRefusal(
          client.query(`delete from document_templates where id = $1`, [templateV2Id]),
        ),
      );
      expect(error.message).toMatch(/never deleted/i);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Requests, and the two-person rule
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('requests and four eyes', () => {
    it('lets the owner raise a request for a student', async () => {
      const response = await post('owner', '/api/v1/documents/requests', {
        templateId: templateV2Id,
        subjectKind: 'student',
        subjectId: tenantA.studentIds[0]!,
        purpose: 'Admission to another school',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('pending_approval');
      expect(response.body.templateVersion).toBe(2);
      expect(response.body.approvedBy).toBeNull();
      ownerRequestId = response.body.id;
    });

    it('REFUSES the owner approving their own request despite holding every permission', async () => {
      // The owner's role is `['*']` — the permission system cannot say no. The service must.
      const response = await post(
        'owner',
        `/api/v1/documents/requests/${ownerRequestId}/approve`,
      );
      expect(response.status).toBe(403);
      expect(response.body.error.message).toMatch(/your own/i);
    });

    it('equally refuses the owner rejecting their own request', async () => {
      const response = await post('owner', `/api/v1/documents/requests/${ownerRequestId}/reject`, {
        reason: 'Rejecting the request I raised myself',
      });
      expect(response.status).toBe(403);
    });

    it('the DATABASE refuses approved_by = requested_by, whoever writes it', async () => {
      const error = await asAppRole(tenantA.tenantId, (client) =>
        expectRefusal(
          client.query(
            `update document_requests
                set status = 'approved', approved_by = requested_by, approved_at = now()
              where id = $1`,
            [ownerRequestId],
          ),
        ),
      );
      expect(error.constraint).toBe('document_requests_approver_not_requester');
    });

    it('refuses a teacher the approval decision', async () => {
      const response = await post(
        'teacher',
        `/api/v1/documents/requests/${ownerRequestId}/approve`,
      );
      expect(response.status).toBe(403);
    });

    it('lets a second person — the principal — approve it', async () => {
      const response = await post(
        'principal',
        `/api/v1/documents/requests/${ownerRequestId}/approve`,
        { note: 'Leaving certificate checked against the register' },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('approved');
      expect(response.body.approvedBy).toBe(tenantA.users['principal']!.id);
      expect(response.body.approvedBy).not.toBe(response.body.requestedBy);
    });

    it('refuses a request for a student the caller cannot see', async () => {
      // The teacher is class teacher of section A only; the outsider is in section B.
      const response = await post('teacher', '/api/v1/documents/requests', {
        templateId: bulkTemplateId,
        subjectKind: 'student',
        subjectId: outsiderStudentId,
        purpose: 'Character certificate for a student in another section',
      });
      expect(response.status).toBe(404);
    });

    it('lets the administrator, who sees every student, raise the same request', async () => {
      const response = await post('admin', '/api/v1/documents/requests', {
        templateId: bulkTemplateId,
        subjectKind: 'student',
        subjectId: outsiderStudentId,
        purpose: 'Character certificate for a student in another section',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      // No approval needed for this template, so it arrives approved by nobody.
      expect(response.body.status).toBe('approved');
      expect(response.body.approvedBy).toBeNull();
      expect(response.body.approvedAt).toBeTruthy();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Preview
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('preview', () => {
    it('renders a real subject without issuing anything', async () => {
      const before = await sqlOne<{ count: string }>(
        `select count(*)::text as count from issued_documents`,
      );

      const response = await post('admin', '/api/v1/documents/preview', {
        templateId: templateV2Id,
        subjectKind: 'student',
        subjectId: tenantA.studentIds[0]!,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.preview).toBe(true);
      expect(response.body.html).toContain('doca Student 1');
      expect(response.body.html).toContain('(not yet issued)');

      const after = await sqlOne<{ count: string }>(
        `select count(*)::text as count from issued_documents`,
      );
      expect(after.count).toBe(before.count);
    });

    it('refuses a preview of a student outside the caller’s data scope', async () => {
      const response = await post('teacher', '/api/v1/documents/preview', {
        templateId: templateV2Id,
        subjectKind: 'student',
        subjectId: outsiderStudentId,
      });
      expect(response.status).toBe(404);
    });

    it('the RENDERER itself refuses an unknown variable, not only the input schema', async () => {
      // Written straight to the table, bypassing every service-level check, so what is under
      // test is the substitution engine rather than the Zod schema in front of it.
      hostileTemplateId = uuidv7();
      const client = testClient();
      await client.connect();
      try {
        await client.query(
          `insert into document_templates
             (id, tenant_id, institution_id, key, name, kind, body_html, variables, requires_approval, version, is_active)
           values ($1,$2,$3,'hostile','Hostile','custom',$4,'[]'::jsonb,false,1,true)`,
          [
            hostileTemplateId,
            tenantA.tenantId,
            tenantA.institutionId,
            '<p>{{constructor.name}} — {{student.fullNameEn}}</p>',
          ],
        );
      } finally {
        await client.end();
      }

      const response = await post('admin', '/api/v1/documents/preview', {
        templateId: hostileTemplateId,
        subjectKind: 'student',
        subjectId: tenantA.studentIds[0]!,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(JSON.stringify(response.body)).toContain('constructor.name');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Issuance and immutability
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('issuance', () => {
    it('issues the approved request with a server-generated serial and code', async () => {
      const response = await post(
        'admin',
        `/api/v1/documents/requests/${ownerRequestId}/issue`,
        {},
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);

      issuedDocumentId = response.body.id;
      issuedSerial = response.body.serialNumber;
      issuedCode = response.body.verificationCode;

      expect(issuedSerial).toMatch(/^TC-\d{4}-[0-9A-Z]{8}$/);
      expect(issuedCode).toMatch(/^[0-9A-Z]{12}$/);
      expect(response.body.templateVersion).toBe(2);
      expect(response.body.renderedHtml).toContain('doca Student 1');
      expect(response.body.renderedHtml).toContain(issuedSerial);
      // The snapshot is the assertion the certificate makes, kept whole.
      expect(response.body.dataSnapshot.variables['student.fullNameEn']).toBe('doca Student 1');
      expect(response.body.dataSnapshot.templateVersion).toBe(2);
    });

    it('moved the request to issued', async () => {
      const response = await get('admin', '/api/v1/documents/requests', {
        status: 'issued',
      });
      expect(response.status).toBe(200);
      const ids = (response.body.data as Array<{ id: string }>).map((row) => row.id);
      expect(ids).toContain(ownerRequestId);
    });

    it('refuses to issue the same request twice', async () => {
      const response = await post(
        'admin',
        `/api/v1/documents/requests/${ownerRequestId}/issue`,
        {},
      );
      expect(response.status).toBe(409);
    });

    it('refuses a future issue date', async () => {
      const request2 = await post('admin', '/api/v1/documents/requests', {
        templateId: bulkTemplateId,
        subjectKind: 'student',
        subjectId: tenantA.studentIds[1]!,
        purpose: 'Character certificate, dated tomorrow',
      });
      expect(request2.status).toBe(201);

      const response = await post(
        'admin',
        `/api/v1/documents/requests/${request2.body.id}/issue`,
        { issuedOn: '2999-01-01' },
      );
      expect(response.status).toBe(422);
    });

    it('writes exactly ONE audit row for the issuance', async () => {
      // The route carries `recordedBy: 'service'`, so the interceptor stands down and the
      // in-transaction row — the one with context — is the only record.
      const row = await sqlOne<{ count: string }>(
        `select count(*)::text as count
           from audit_logs
          where module = 'documents'
            and resource_type = 'issued_document'
            and action = 'create'
            and resource_id = $1`,
        [issuedDocumentId],
      );
      expect(row.count).toBe('1');
    });

    it('records the issuance against a real occurred_at', async () => {
      const row = await sqlOne<{ occurred_at: Date | null }>(
        `select occurred_at from audit_logs
          where resource_id = $1 and module = 'documents' and action = 'create'`,
        [issuedDocumentId],
      );
      expect(row.occurred_at).toBeTruthy();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // A script tag in DATA renders inert
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('data is escaped, never executed', () => {
    it('renders a student whose legal name is a script tag as visible text', async () => {
      const created = await post('admin', '/api/v1/documents/requests', {
        templateId: bulkTemplateId,
        subjectKind: 'student',
        subjectId: scriptNameStudentId,
        purpose: 'Certificate for the student with markup in their name',
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);

      const issued = await post(
        'admin',
        `/api/v1/documents/requests/${created.body.id}/issue`,
        {},
      );
      expect(issued.status, JSON.stringify(issued.body)).toBe(201);

      const html = issued.body.renderedHtml as string;
      expect(html).not.toContain('<script>');
      expect(html).not.toContain("alert('xss')");
      expect(html).toContain('&lt;script&gt;');
      expect(html).toContain('&#39;xss&#39;');
      // The snapshot keeps the raw value; only the rendered markup is escaped.
      expect(issued.body.dataSnapshot.variables['student.fullNameEn']).toBe(
        `<script>alert('xss')</script>`,
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Immutability, proved against Postgres
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('an issued document is immutable — enforced by the database', () => {
    it('REFUSES an UPDATE of rendered_html', async () => {
      const error = await asAppRole(tenantA.tenantId, (client) =>
        expectRefusal(
          client.query(`update issued_documents set rendered_html = $2 where id = $1`, [
            issuedDocumentId,
            '<p>a different certificate entirely</p>',
          ]),
        ),
      );
      expect(error.message).toMatch(/immutable/i);
      expect(error.code).toBe('42501');
    });

    it('REFUSES an UPDATE of data_snapshot', async () => {
      const error = await asAppRole(tenantA.tenantId, (client) =>
        expectRefusal(
          client.query(
            `update issued_documents set data_snapshot = '{"variables":{}}'::jsonb where id = $1`,
            [issuedDocumentId],
          ),
        ),
      );
      expect(error.message).toMatch(/immutable|frozen/i);
    });

    it('REFUSES an UPDATE of the serial number', async () => {
      const error = await asAppRole(tenantA.tenantId, (client) =>
        expectRefusal(
          client.query(
            `update issued_documents set serial_number = 'TC-2026-FORGED1' where id = $1`,
            [issuedDocumentId],
          ),
        ),
      );
      expect(error.message).toMatch(/immutable|frozen/i);
    });

    it('REFUSES a DELETE', async () => {
      const error = await asAppRole(tenantA.tenantId, (client) =>
        expectRefusal(
          client.query(`delete from issued_documents where id = $1`, [issuedDocumentId]),
        ),
      );
      expect(error.message).toMatch(/permanent|revoke/i);
    });

    it('REFUSES a revocation with no reason', async () => {
      const error = await asAppRole(tenantA.tenantId, (client) =>
        expectRefusal(
          client.query(
            `update issued_documents set revoked_at = now(), revoked_by = $2 where id = $1`,
            [issuedDocumentId, tenantA.users['principal']!.id],
          ),
        ),
      );
      expect(error.message).toMatch(/immutable|frozen|revoc/i);
    });

    it('ACCEPTS the one legal update — a revocation with who, when and why', async () => {
      await asAppRole(tenantA.tenantId, async (client) => {
        const { rowCount } = await client.query(
          `update issued_documents
              set revoked_at = now(), revoked_by = $2, revoked_reason = 'Superseded by a corrected copy'
            where id = $1`,
          [issuedDocumentId, tenantA.users['principal']!.id],
        );
        expect(rowCount).toBe(1);
      });
      // The transaction is rolled back, so the document is still live for the tests below.
      const row = await sqlOne<{ revoked_at: Date | null }>(
        `select revoked_at from issued_documents where id = $1`,
        [issuedDocumentId],
      );
      expect(row.revoked_at).toBeNull();
    });

    it('REFUSES an issued document with no request for a template that requires approval', async () => {
      const error = await asAppRole(tenantA.tenantId, (client) =>
        expectRefusal(
          client.query(
            `insert into issued_documents
               (tenant_id, institution_id, template_id, template_version, subject_kind, subject_id,
                serial_number, issued_on, issued_by, rendered_html, verification_code)
             values ($1,$2,$3,2,'student',$4,'TC-2026-BYPASS1', current_date, $5, '<p>x</p>', 'BYPASSCODE12')`,
            [
              tenantA.tenantId,
              tenantA.institutionId,
              templateV2Id,
              tenantA.studentIds[0]!,
              tenantA.users['owner']!.id,
            ],
          ),
        ),
      );
      expect(error.constraint).toBe('issued_documents_approval_required');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Reissue after the underlying data changes
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('a certificate keeps asserting what was true when it was issued', () => {
    it('reissuing after a name change creates a NEW document and leaves the old one alone', async () => {
      const client = testClient();
      await client.connect();
      try {
        await client.query(`update students set full_name_en = $2 where id = $1`, [
          tenantA.studentIds[0]!,
          'doca Student One Corrected',
        ]);
      } finally {
        await client.end();
      }

      const created = await post('owner', '/api/v1/documents/requests', {
        templateId: templateV2Id,
        subjectKind: 'student',
        subjectId: tenantA.studentIds[0]!,
        purpose: 'Reissue after a name correction',
      });
      expect(created.status).toBe(201);

      const approved = await post(
        'principal',
        `/api/v1/documents/requests/${created.body.id}/approve`,
      );
      expect(approved.status).toBe(201);

      const reissued = await post(
        'admin',
        `/api/v1/documents/requests/${created.body.id}/issue`,
        {},
      );
      expect(reissued.status, JSON.stringify(reissued.body)).toBe(201);
      expect(reissued.body.id).not.toBe(issuedDocumentId);
      expect(reissued.body.serialNumber).not.toBe(issuedSerial);
      expect(reissued.body.dataSnapshot.variables['student.fullNameEn']).toBe(
        'doca Student One Corrected',
      );

      // The 2026 certificate still says what it said in 2026.
      const original = await sqlOne<{ snapshot: { variables: Record<string, string> } }>(
        `select data_snapshot as snapshot from issued_documents where id = $1`,
        [issuedDocumentId],
      );
      expect(original.snapshot.variables['student.fullNameEn']).toBe('doca Student 1');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Bulk issuance
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('bulk issuance for a section', () => {
    it('issues one document per actively enrolled student in the section', async () => {
      const response = await post('admin', '/api/v1/documents/issued/bulk', {
        templateId: bulkTemplateId,
        sectionId: tenantA.sectionId,
        purpose: 'End of year character certificates',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const issued = response.body.issued as Array<{ subjectId: string; serialNumber: string }>;
      expect(issued).toHaveLength(3);
      expect(new Set(issued.map((row) => row.serialNumber)).size).toBe(3);
      expect(new Set(issued.map((row) => row.subjectId))).toEqual(new Set(tenantA.studentIds));
      // The section-B student is in a different section and must not appear.
      expect(issued.map((row) => row.subjectId)).not.toContain(outsiderStudentId);
    });

    it('refuses a bulk run for a template that requires approval', async () => {
      const response = await post('admin', '/api/v1/documents/issued/bulk', {
        templateId: templateV2Id,
        sectionId: tenantA.sectionId,
        purpose: 'Trying to skip the approver',
      });
      expect(response.status).toBe(409);
      expect(response.body.error.message).toMatch(/approv/i);
    });

    it('narrows a teacher’s bulk run to the section they actually teach', async () => {
      const response = await post('teacher', '/api/v1/documents/issued/bulk', {
        templateId: bulkTemplateId,
        sectionId: sectionBId,
        purpose: 'Section B, which this teacher does not teach',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.issued).toHaveLength(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Public verification
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('public verification', () => {
    const verify = (body: object) =>
      request(app.getHttpServer()).post('/api/v1/documents/verify').send(body);

    it('answers an unauthenticated caller with exactly four facts and a status', async () => {
      const response = await verify({ code: issuedCode });
      expect(response.status, JSON.stringify(response.body)).toBe(201);

      expect(Object.keys(response.body).sort()).toEqual([
        'issuedOn',
        'kind',
        'status',
        'subjectName',
        'valid',
      ]);
      expect(response.body.valid).toBe(true);
      expect(response.body.status).toBe('issued');
      expect(response.body.kind).toBe('transfer_certificate');
      // The name the document asserted, not the corrected one on the student's record.
      expect(response.body.subjectName).toBe('doca Student 1');
    });

    it('leaks no identifier, no institution and nothing from the document body', async () => {
      const response = await verify({ code: issuedCode });
      const raw = JSON.stringify(response.body);
      expect(raw).not.toContain(issuedDocumentId);
      expect(raw).not.toContain(tenantA.studentIds[0]!);
      expect(raw).not.toContain(tenantA.institutionId);
      expect(raw).not.toContain(tenantA.tenantId);
      expect(raw).not.toContain(issuedSerial);
      expect(raw).not.toContain(issuedCode);
      expect(raw).not.toContain('doca-S1'); // the student code
      expect(raw).not.toContain('<section'); // nothing from the rendered document body
    });

    it('returns 404 for a code nobody was issued', async () => {
      const response = await verify({ code: 'ZZZZZZZZZZZZ' });
      expect(response.status).toBe(404);
    });

    it('records every check, append-only', async () => {
      const before = await sqlOne<{ count: string }>(
        `select count(*)::text as count from document_verifications where issued_document_id = $1`,
        [issuedDocumentId],
      );
      await verify({ code: issuedCode, channel: 'qr_scan' });
      const after = await sqlOne<{ count: string }>(
        `select count(*)::text as count from document_verifications where issued_document_id = $1`,
        [issuedDocumentId],
      );
      expect(Number(after.count)).toBe(Number(before.count) + 1);

      const error = await asAppRole(tenantA.tenantId, (client) =>
        expectRefusal(
          client.query(
            `update document_verifications set verifier_ip = '1.2.3.4' where issued_document_id = $1`,
            [issuedDocumentId],
          ),
        ),
      );
      expect(error.constraint).toBe('document_verifications_append_only');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Revocation
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('revocation', () => {
    it('refuses revocation to a caller who may only generate documents', async () => {
      const response = await post(
        'admin',
        `/api/v1/documents/issued/${issuedDocumentId}/revoke`,
        { reason: 'An administrator should not be able to do this' },
      );
      expect(response.status).toBe(403);
    });

    it('refuses revocation with no reason', async () => {
      const response = await post(
        'principal',
        `/api/v1/documents/issued/${issuedDocumentId}/revoke`,
        {},
      );
      expect(response.status).toBe(422);
    });

    it('revokes with a recorded reason', async () => {
      const response = await post(
        'principal',
        `/api/v1/documents/issued/${issuedDocumentId}/revoke`,
        { reason: 'Superseded by the reissued certificate after the name correction' },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.revokedAt).toBeTruthy();
      expect(response.body.revokedReason).toMatch(/Superseded/);
    });

    it('refuses a second revocation', async () => {
      const response = await post(
        'principal',
        `/api/v1/documents/issued/${issuedDocumentId}/revoke`,
        { reason: 'Trying to revoke an already revoked document' },
      );
      expect(response.status).toBe(409);
    });

    it('verifies as REVOKED, never as absent', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/documents/verify')
        .send({ code: issuedCode });
      expect(response.status).toBe(201);
      expect(response.body.valid).toBe(false);
      expect(response.body.status).toBe('revoked');
      expect(response.body.subjectName).toBe('doca Student 1');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Download, self-service and the register
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('download and self-service', () => {
    let downloadable: string;

    it('lists issued documents for a caller who may generate them', async () => {
      const response = await get('admin', '/api/v1/documents/issued', { pageSize: 50 });
      expect(response.status).toBe(200);
      const items = response.body.data as Array<{ id: string; serialNumber: string }>;
      expect(items.length).toBeGreaterThan(3);
      // The list is a summary; the document body is fetched through the signed URL.
      expect(items[0]).not.toHaveProperty('renderedHtml');
      downloadable = items[0]!.id;
    });

    it('hands out a short-lived signed URL rather than the bytes', async () => {
      const response = await get('admin', `/api/v1/documents/issued/${downloadable}/download`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.url).toContain('/api/v1/files/download?');
      expect(response.body.url).toContain('signature=');
      expect(response.body.expiresInSeconds).toBe(300);
    });

    it('serves the archived copy through the shared signed-URL route', async () => {
      const signed = await get('admin', `/api/v1/documents/issued/${downloadable}/download`);
      const url = signed.body.url as string;
      const response = await request(app.getHttpServer()).get(url);
      expect(response.status).toBe(200);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    });

    it('lets a guardian read their own child’s documents with no extra permission', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/documents/my-documents')
        .set('Authorization', `Bearer ${tokens['guardian1']}`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const subjects = (response.body as Array<{ subjectId: string }>).map(
        (row) => row.subjectId,
      );
      expect(subjects).toContain(tenantA.studentIds[0]!);
      expect(subjects).not.toContain(tenantA.studentIds[1]!);
    });

    it('shows a different guardian only their own child', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/documents/my-documents')
        .set('Authorization', `Bearer ${tokens['guardian2']}`);
      expect(response.status).toBe(200);
      const subjects = (response.body as Array<{ subjectId: string }>).map(
        (row) => row.subjectId,
      );
      expect(subjects).not.toContain(tenantA.studentIds[0]!);
      expect(subjects).toContain(tenantA.studentIds[1]!);
    });

    it('produces an issuance register that counts what was issued and what was withdrawn', async () => {
      const response = await get('admin', '/api/v1/documents/reports/register', {
        from: '2026-01-01',
        to: '2099-12-31',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.totalIssued).toBeGreaterThan(3);
      expect(response.body.totalRevoked).toBeGreaterThanOrEqual(1);
      const kinds = (response.body.byKind as Array<{ kind: string }>).map((row) => row.kind);
      expect(kinds).toContain('character_certificate');
      expect(kinds).toContain('transfer_certificate');
      const entry = (
        response.body.entries as Array<{ serialNumber: string; subjectName: string }>
      ).find((row) => row.serialNumber === issuedSerial);
      expect(entry?.subjectName).toBe('doca Student 1');
    });

    it('refuses a register whose range ends before it starts', async () => {
      const response = await get('admin', '/api/v1/documents/reports/register', {
        from: '2026-06-01',
        to: '2026-01-01',
      });
      expect(response.status).toBe(422);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Tenant isolation
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('tenant isolation', () => {
    it('returns 404 — not 403 — for another tenant’s template', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/documents/templates/${templateV2Id}`)
        .set('Authorization', `Bearer ${tokens['otherPrincipal']}`)
        .set('x-institution-id', tenantB.institutionId);
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('refuses tenant B a request against tenant A’s institution header', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/documents/issued')
        .set('Authorization', `Bearer ${tokens['otherPrincipal']}`)
        .set('x-institution-id', tenantA.institutionId);
      expect(response.status).toBe(403);
    });

    it('shows tenant B none of tenant A’s issued documents', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/documents/issued')
        .set('Authorization', `Bearer ${tokens['otherPrincipal']}`)
        .set('x-institution-id', tenantB.institutionId);
      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(0);
      expect(response.body.meta.total).toBe(0);
    });

    it('returns 404 for tenant A’s issued document by id from tenant B', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/documents/issued/${issuedDocumentId}/download`)
        .set('Authorization', `Bearer ${tokens['otherPrincipal']}`)
        .set('x-institution-id', tenantB.institutionId);
      expect(response.status).toBe(404);
    });

    it('ROW-LEVEL SECURITY hides the row from tenant B even in raw SQL', async () => {
      const visible = await asAppRole(tenantB.tenantId, async (client) => {
        const { rows } = await client.query(`select id from issued_documents where id = $1`, [
          issuedDocumentId,
        ]);
        return rows.length;
      });
      expect(visible).toBe(0);

      const own = await asAppRole(tenantA.tenantId, async (client) => {
        const { rows } = await client.query(`select id from issued_documents where id = $1`, [
          issuedDocumentId,
        ]);
        return rows.length;
      });
      expect(own).toBe(1);
    });
  });
});
