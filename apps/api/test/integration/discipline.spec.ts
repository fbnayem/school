/**
 * Discipline and behaviour integration suite (Phase 22).
 *
 * This module records allegations and sanctions against children, so this file exists to
 * hold the due-process invariants, not to prove routes return 200:
 *
 *  - a severe action (suspension / expulsion recommendation) can NEVER be approved by the
 *    person who decided it, even when that person holds every permission,
 *  - a guardian sees only their own children's records, only once substantiated or actioned,
 *    and never a restricted record,
 *  - a teacher is limited to their assigned students, exactly like the students module,
 *  - notes are append-only and the DATABASE refuses UPDATE and DELETE,
 *  - the status state machine 409s on an invalid move, naming both states,
 *  - nothing hard-deletes: withdrawal is a status and the history stays,
 *  - merit points post once per record, the leaderboard publishes positive points only,
 *  - and none of it crosses a tenant boundary.
 *
 * Everything runs over HTTP through the real guards, interceptors and database, because the
 * properties under test live precisely in the parts a stub would replace.
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

const DISCIPLINE_TABLES = [
  'behaviour_categories',
  'behaviour_records',
  'disciplinary_actions',
  'behaviour_record_notes',
  'behaviour_guardian_acknowledgements',
  'merit_points_ledger',
];

describe('Discipline and behaviour', () => {
  let app: INestApplication;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
  const tokens: Record<string, string> = {};

  // A second section with one student the seeded teacher is NOT assigned to, so the
  // "assigned" scope has something real to exclude.
  let outsiderStudentId: string;
  let outsiderSectionId: string;

  // Ids captured as the suite builds up a real disciplinary history.
  let helpingCategoryId: string;
  let fightingCategoryId: string;
  let fightingRecordId: string; // R1 — negative, student[0], substantiated during the suite
  let draftRecordId: string; // R2 — teacher's private draft, then submitted
  let outsiderRecordId: string; // R3 — student outside the teacher's sections
  let restrictedRecordId: string; // R4 — confidentiality=restricted, student[0]
  let actionedRecordId: string; // R8 — visible to its guardian via an approved action only
  let suspensionActionId: string;

  const INTERNAL_NOTE = 'Internal deliberation: awaiting the other student’s account.';
  const SHARED_NOTE = 'We met the class teacher and agreed next steps together.';

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

  /** Read one record as a staff role, returning the full body (including version). */
  async function getRecord(role: string, id: string): Promise<Record<string, any>> {
    const response = await get(role, `/api/v1/discipline/records/${id}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body as Record<string, any>;
  }

  async function transition(
    role: string,
    id: string,
    status: string,
    reason = 'Decision recorded after reviewing the accounts of everyone involved.',
  ) {
    const current = await getRecord(role, id);
    return post(role, `/api/v1/discipline/records/${id}/status`, {
      status,
      reason,
      version: current.version,
    });
  }

  beforeAll(async () => {
    app = await createTestApp();
    await truncateAll();
    tenantA = await seedTenant('disa', { students: 3 });
    tenantB = await seedTenant('disb', { students: 2 });

    for (const key of ['owner', 'principal', 'teacher', 'guardian1', 'guardian2', 'guardian3']) {
      tokens[key] = await login(tenantA.users[key]!.email);
    }
    tokens['otherPrincipal'] = await login(tenantB.users['principal']!.email);

    // Seed the out-of-scope student directly, as the migrator: a second section with one
    // student the teacher has no assignment to.
    const client = testClient();
    await client.connect();
    try {
      outsiderSectionId = uuidv7();
      await client.query(
        `insert into sections (id, tenant_id, institution_id, campus_id, academic_year_id, class_level_id, name_en, capacity)
         values ($1,$2,$3,$4,$5,$6,'B',60)`,
        [
          outsiderSectionId,
          tenantA.tenantId,
          tenantA.institutionId,
          tenantA.campusId,
          tenantA.academicYearId,
          tenantA.classLevelId,
        ],
      );
      outsiderStudentId = uuidv7();
      await client.query(
        `insert into students (id, tenant_id, institution_id, student_code, admission_number, admission_date, full_name_en, date_of_birth, gender, status)
         values ($1,$2,$3,'disa-SX1','disa-AX1','2026-01-05','disa Outsider Student','2014-03-01','female','active')`,
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
          outsiderSectionId,
        ],
      );
    } finally {
      await client.end();
    }
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Categories
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('behaviour categories', () => {
    it('lets discipline staff create positive and negative categories', async () => {
      const helping = await post('principal', '/api/v1/discipline/categories', {
        code: 'HELPING',
        nameEn: 'Helping others',
        nameBn: 'অন্যকে সাহায্য',
        kind: 'positive',
        defaultSeverity: 'minor',
        defaultPoints: 5,
      });
      expect(helping.status, JSON.stringify(helping.body)).toBe(201);
      helpingCategoryId = helping.body.id;

      const fighting = await post('principal', '/api/v1/discipline/categories', {
        code: 'FIGHTING',
        nameEn: 'Fighting',
        kind: 'negative',
        defaultSeverity: 'major',
        defaultPoints: -10,
      });
      expect(fighting.status).toBe(201);
      fightingCategoryId = fighting.body.id;

      const listed = await get('principal', '/api/v1/discipline/categories');
      expect(listed.status).toBe(200);
      expect(listed.body.meta.total).toBe(2);
    });

    it('refuses points whose sign contradicts the kind', async () => {
      const response = await post('principal', '/api/v1/discipline/categories', {
        code: 'BROKEN',
        nameEn: 'Broken category',
        kind: 'positive',
        defaultPoints: -5,
      });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('a teacher cannot manage categories (permission denial)', async () => {
      const response = await post('teacher', '/api/v1/discipline/categories', {
        code: 'NOPE',
        nameEn: 'Not allowed',
        kind: 'positive',
        defaultPoints: 1,
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('a stale update is a 409, not a lost write', async () => {
      const response = await patch(
        'principal',
        `/api/v1/discipline/categories/${helpingCategoryId}`,
        { defaultPoints: 6, version: 99 },
      );
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('CONFLICT');
    });

    it('archives a category with a reason instead of deleting it', async () => {
      const created = await post('principal', '/api/v1/discipline/categories', {
        code: 'TEMPORARY',
        nameEn: 'Temporary category',
        kind: 'positive',
        defaultPoints: 1,
      });
      expect(created.status).toBe(201);

      const archived = await post(
        'principal',
        `/api/v1/discipline/categories/${created.body.id}/archive`,
        { reason: 'Created by mistake during configuration.' },
      );
      expect(archived.status, JSON.stringify(archived.body)).toBe(201);

      // Gone from the default list, but the row itself survives — never a hard delete.
      const listed = await get('principal', '/api/v1/discipline/categories', { pageSize: 100 });
      expect(listed.body.data.map((c: { id: string }) => c.id)).not.toContain(created.body.id);

      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query(
          `select archived_at, archive_reason from behaviour_categories where id = $1`,
          [created.body.id],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].archived_at).not.toBeNull();
        expect(rows[0].archive_reason).toContain('mistake');
      } finally {
        await client.end();
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Records: creation and scope
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('record creation and data scope', () => {
    it('a teacher reports an incident about an assigned student, defaults from the category', async () => {
      const response = await post('teacher', '/api/v1/discipline/records', {
        studentId: tenantA.studentIds[0],
        categoryId: fightingCategoryId,
        academicYearId: tenantA.academicYearId,
        occurredOn: '2026-02-10',
        description: 'Fought with a classmate during tiffin break in the corridor.',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('reported');
      expect(response.body.severity).toBe('major');
      expect(response.body.points).toBe(-10);
      expect(response.body.reportedByEmployeeId).toBeTruthy();
      fightingRecordId = response.body.id;
    });

    it('a teacher cannot report on a student outside their sections — 404, not 403', async () => {
      const response = await post('teacher', '/api/v1/discipline/records', {
        studentId: outsiderStudentId,
        categoryId: fightingCategoryId,
        academicYearId: tenantA.academicYearId,
        occurredOn: '2026-02-11',
        description: 'This report should never be accepted from this teacher.',
      });
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('a guardian cannot create a record (permission denial)', async () => {
      const response = await post('guardian1', '/api/v1/discipline/records', {
        studentId: tenantA.studentIds[0],
        categoryId: helpingCategoryId,
        academicYearId: tenantA.academicYearId,
        occurredOn: '2026-02-11',
        description: 'Guardians must not be able to write behaviour records.',
      });
      expect(response.status).toBe(403);
    });

    it('rejects points whose sign contradicts the category on a record', async () => {
      const response = await post('teacher', '/api/v1/discipline/records', {
        studentId: tenantA.studentIds[0],
        categoryId: helpingCategoryId,
        academicYearId: tenantA.academicYearId,
        occurredOn: '2026-02-11',
        description: 'Positive category with negative points must be refused.',
        points: -3,
      });
      expect(response.status).toBe(422);
    });

    it('staff with full scope can report on any student; the teacher then cannot see it', async () => {
      const created = await post('principal', '/api/v1/discipline/records', {
        studentId: outsiderStudentId,
        categoryId: fightingCategoryId,
        academicYearId: tenantA.academicYearId,
        occurredOn: '2026-02-12',
        description: 'Outsider-section incident reported by the principal directly.',
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      outsiderRecordId = created.body.id;

      // The teacher's list silently excludes it, and the direct fetch is a 404: an id
      // outside your scope is indistinguishable from an id that does not exist.
      const listed = await get('teacher', '/api/v1/discipline/records', { pageSize: 100 });
      expect(listed.status).toBe(200);
      expect(listed.body.data.map((r: { id: string }) => r.id)).not.toContain(outsiderRecordId);

      const fetched = await get('teacher', `/api/v1/discipline/records/${outsiderRecordId}`);
      expect(fetched.status).toBe(404);

      const asPrincipal = await get('principal', `/api/v1/discipline/records/${outsiderRecordId}`);
      expect(asPrincipal.status).toBe(200);
    });

    it('restricted records are hidden from staff without the restricted permission', async () => {
      const created = await post('principal', '/api/v1/discipline/records', {
        studentId: tenantA.studentIds[0],
        categoryId: fightingCategoryId,
        academicYearId: tenantA.academicYearId,
        occurredOn: '2026-02-13',
        description: 'A safeguarding-sensitive incident recorded as restricted.',
        confidentiality: 'restricted',
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      restrictedRecordId = created.body.id;

      // The teacher holds discipline.records.view but not the restricted gate.
      const listed = await get('teacher', '/api/v1/discipline/records', { pageSize: 100 });
      expect(listed.body.data.map((r: { id: string }) => r.id)).not.toContain(restrictedRecordId);
      const fetched = await get('teacher', `/api/v1/discipline/records/${restrictedRecordId}`);
      expect(fetched.status).toBe(404);
      expect(JSON.stringify(fetched.body)).not.toContain('safeguarding');

      const asPrincipal = await get(
        'principal',
        `/api/v1/discipline/records/${restrictedRecordId}`,
      );
      expect(asPrincipal.status).toBe(200);
    });

    it('a draft is a private working copy the reporter can later submit', async () => {
      const created = await post('teacher', '/api/v1/discipline/records', {
        studentId: tenantA.studentIds[1],
        categoryId: helpingCategoryId,
        academicYearId: tenantA.academicYearId,
        occurredOn: '2026-02-14',
        description: 'Helped a younger student who fell in the yard — draft for now.',
        submit: false,
      });
      expect(created.status).toBe(201);
      expect(created.body.status).toBe('draft');
      draftRecordId = created.body.id;

      // Another staff member does not see the unsubmitted draft.
      const principalList = await get('principal', '/api/v1/discipline/records', {
        pageSize: 100,
      });
      expect(principalList.body.data.map((r: { id: string }) => r.id)).not.toContain(draftRecordId);

      // The reporter submits it: draft → reported is the one transition a reporter may make.
      const submitted = await transition(
        'teacher',
        draftRecordId,
        'reported',
        'Completed the draft after speaking with the student.',
      );
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
      expect(submitted.body.status).toBe('reported');
    });

    it('a teacher cannot decide outcomes even on their own report', async () => {
      const response = await transition('teacher', draftRecordId, 'substantiated');
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // The state machine
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('status state machine', () => {
    it('substantiates through a valid path and posts merit points exactly once', async () => {
      const moved = await transition(
        'principal',
        fightingRecordId,
        'under_investigation',
        'Both students and the duty teacher are being interviewed.',
      );
      expect(moved.status, JSON.stringify(moved.body)).toBe(201);

      const decided = await transition(
        'principal',
        fightingRecordId,
        'substantiated',
        'Corroborated by the duty teacher and two independent accounts.',
      );
      expect(decided.status, JSON.stringify(decided.body)).toBe(201);
      expect(decided.body.status).toBe('substantiated');

      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query(
          `select points, running_total from merit_points_ledger where source_record_id = $1`,
          [fightingRecordId],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].points).toBe(-10);
        expect(rows[0].running_total).toBe(-10);
      } finally {
        await client.end();
      }
    });

    it('an invalid transition is a 409 naming both states', async () => {
      const response = await transition('principal', fightingRecordId, 'reported');
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('WORKFLOW_STATE_INVALID');
      expect(response.body.error.message).toContain('substantiated');
      expect(response.body.error.message).toContain('reported');
    });

    it('a stale version on a transition is a 409', async () => {
      const response = await post(
        'principal',
        `/api/v1/discipline/records/${draftRecordId}/status`,
        {
          status: 'under_investigation',
          reason: 'Stale-version transition must be refused, not silently applied.',
          version: 99,
        },
      );
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('CONFLICT');
    });

    it('a status transition without a reason is refused', async () => {
      const current = await getRecord('principal', draftRecordId);
      const response = await post(
        'principal',
        `/api/v1/discipline/records/${draftRecordId}/status`,
        { status: 'under_investigation', version: current.version },
      );
      expect(response.status).toBe(422);
    });

    it('every status transition lands in the audit log with actor and reason', async () => {
      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query(
          `select actor_user_id, reason, previous_value, new_value
             from audit_logs
            where module = 'discipline'
              and resource_type = 'behaviour_record'
              and resource_id = $1
              and action = 'update'
            order by occurred_at`,
          [fightingRecordId],
        );
        expect(rows.length).toBeGreaterThanOrEqual(2);
        for (const row of rows) {
          expect(row.actor_user_id).not.toBeNull();
          expect(row.reason).toBeTruthy();
        }
        const last = rows[rows.length - 1];
        expect(JSON.stringify(last.previous_value)).toContain('under_investigation');
        expect(JSON.stringify(last.new_value)).toContain('substantiated');
      } finally {
        await client.end();
      }
    });

    it('withdrawal is a status, and the record survives it', async () => {
      const created = await post('teacher', '/api/v1/discipline/records', {
        studentId: tenantA.studentIds[2],
        categoryId: fightingCategoryId,
        academicYearId: tenantA.academicYearId,
        occurredOn: '2026-02-15',
        description: 'Reported in error — will be withdrawn, never deleted.',
      });
      expect(created.status).toBe(201);

      const withdrawn = await transition(
        'principal',
        created.body.id,
        'withdrawn',
        'Reported against the wrong student; the reporter asked to withdraw.',
      );
      expect(withdrawn.status).toBe(201);
      expect(withdrawn.body.status).toBe('withdrawn');

      // Still fully readable — history is the point.
      const fetched = await getRecord('principal', created.body.id);
      expect(fetched.status).toBe('withdrawn');
      expect(fetched.statusReason).toContain('withdraw');
    });

    it('there is no DELETE route for a record', async () => {
      const response = await request(app.getHttpServer())
        .delete(`/api/v1/discipline/records/${fightingRecordId}`)
        .set('Authorization', `Bearer ${tokens['owner']}`)
        .set('x-institution-id', tenantA.institutionId);
      expect(response.status).toBe(404);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Guardian visibility — the confidentiality contract
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('guardian visibility', () => {
    it('a guardian sees a record about their own child once it is substantiated', async () => {
      const response = await get('guardian1', `/api/v1/discipline/records/${fightingRecordId}`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.status).toBe('substantiated');
    });

    it('a guardian never sees a merely-reported record', async () => {
      // draftRecordId is student[1]'s record, currently `reported` — guardian2 is that
      // student's guardian and still must not see an unproven allegation.
      const response = await get('guardian2', `/api/v1/discipline/records/${draftRecordId}`);
      expect(response.status).toBe(404);

      const listed = await get('guardian2', '/api/v1/discipline/records', { pageSize: 100 });
      expect(listed.status).toBe(200);
      expect(listed.body.data).toEqual([]);
    });

    it('another guardian gets a 404 for the same substantiated record, with no leak', async () => {
      const response = await get('guardian2', `/api/v1/discipline/records/${fightingRecordId}`);
      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain('tiffin');
    });

    it('a restricted record never reaches the guardian, even substantiated', async () => {
      const decided = await transition(
        'principal',
        restrictedRecordId,
        'substantiated',
        'Substantiated after review; remains restricted for safeguarding reasons.',
      );
      expect(decided.status, JSON.stringify(decided.body)).toBe(201);

      const response = await get('guardian1', `/api/v1/discipline/records/${restrictedRecordId}`);
      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain('safeguarding');

      const listed = await get('guardian1', '/api/v1/discipline/records', { pageSize: 100 });
      expect(listed.body.data.map((r: { id: string }) => r.id)).not.toContain(restrictedRecordId);
    });

    it('an approved action also makes a (normal) record visible to its guardian', async () => {
      const created = await post('principal', '/api/v1/discipline/records', {
        studentId: tenantA.studentIds[2],
        categoryId: fightingCategoryId,
        academicYearId: tenantA.academicYearId,
        occurredOn: '2026-02-16',
        description: 'Interim measure agreed while the matter is still being examined.',
      });
      expect(created.status).toBe(201);
      actionedRecordId = created.body.id;

      // Invisible while merely reported…
      const before = await get('guardian3', `/api/v1/discipline/records/${actionedRecordId}`);
      expect(before.status).toBe(404);

      const proposed = await post(
        'principal',
        `/api/v1/discipline/records/${actionedRecordId}/actions`,
        {
          actionType: 'parent_meeting',
          details: 'Meeting with the guardians to agree a way forward.',
          reason: 'A conversation with the family is the proportionate first step.',
        },
      );
      expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);

      const approved = await post(
        'principal',
        `/api/v1/discipline/actions/${proposed.body.id}/approve`,
        {
          reason: 'Non-severe interim measure; approving to schedule the meeting.',
          version: proposed.body.version,
        },
      );
      expect(approved.status, JSON.stringify(approved.body)).toBe(201);

      // …and visible once an action is actually in effect.
      const after = await get('guardian3', `/api/v1/discipline/records/${actionedRecordId}`);
      expect(after.status).toBe(200);
    });

    it('a guardian cannot transition a record (permission denial)', async () => {
      const response = await post(
        'guardian1',
        `/api/v1/discipline/records/${fightingRecordId}/status`,
        {
          status: 'withdrawn',
          reason: 'A guardian must never be able to decide an outcome.',
          version: 1,
        },
      );
      expect(response.status).toBe(403);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Notes — append-only, enforced by the database
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('append-only notes', () => {
    let internalNoteId: string;

    it('staff add internal and guardian-shared notes', async () => {
      const internal = await post(
        'principal',
        `/api/v1/discipline/records/${fightingRecordId}/notes`,
        { note: INTERNAL_NOTE, visibility: 'internal' },
      );
      expect(internal.status, JSON.stringify(internal.body)).toBe(201);
      internalNoteId = internal.body.id;

      const shared = await post(
        'principal',
        `/api/v1/discipline/records/${fightingRecordId}/notes`,
        { note: SHARED_NOTE, visibility: 'shared_with_guardian' },
      );
      expect(shared.status).toBe(201);
    });

    it('the guardian sees shared notes only — internal deliberation never leaks', async () => {
      const response = await get('guardian1', `/api/v1/discipline/records/${fightingRecordId}`);
      expect(response.status).toBe(200);
      const noteTexts = (response.body.notes as Array<{ note: string }>).map((n) => n.note);
      expect(noteTexts).toContain(SHARED_NOTE);
      expect(JSON.stringify(response.body)).not.toContain('deliberation');
    });

    it('the DATABASE refuses UPDATE on a note — even for the table owner', async () => {
      const client = testClient();
      await client.connect();
      try {
        await expect(
          client.query(`update behaviour_record_notes set note = 'rewritten' where id = $1`, [
            internalNoteId,
          ]),
        ).rejects.toThrow(/append-only/i);
      } finally {
        await client.end();
      }
    });

    it('the DATABASE refuses DELETE on a note — even for the table owner', async () => {
      const client = testClient();
      await client.connect();
      try {
        await expect(
          client.query(`delete from behaviour_record_notes where id = $1`, [internalNoteId]),
        ).rejects.toThrow(/append-only/i);
      } finally {
        await client.end();
      }
    });

    it('the application role cannot even attempt a note UPDATE (privilege revoked)', async () => {
      const client = new Client({ connectionString: TEST_APP_DATABASE_URL });
      await client.connect();
      try {
        await client.query('begin');
        await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantA.tenantId]);
        await expect(
          client.query(`update behaviour_record_notes set note = 'rewritten' where id = $1`, [
            internalNoteId,
          ]),
        ).rejects.toThrow(/permission denied|append-only/i);
      } finally {
        await client.query('rollback').catch(() => undefined);
        await client.end();
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Severe actions — approver must differ from decider
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('disciplinary actions and due process', () => {
    it('the owner — holding every permission — proposes a suspension', async () => {
      const response = await post(
        'owner',
        `/api/v1/discipline/records/${fightingRecordId}/actions`,
        {
          actionType: 'suspension',
          startsOn: '2030-01-10',
          endsOn: '2030-01-15',
          details: 'Five school days of suspension following the substantiated fight.',
          reason: 'The severity and the prior warnings justify a suspension.',
        },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('proposed');
      suspensionActionId = response.body.id;
    });

    it('the decider CANNOT approve their own severe action, even with every permission', async () => {
      const response = await post(
        'owner',
        `/api/v1/discipline/actions/${suspensionActionId}/approve`,
        {
          reason: 'Attempting to approve my own decision — this must be refused.',
          version: 1,
        },
      );
      expect(response.status).toBe(409);
      expect(response.body.error.message).toMatch(/someone other than/i);

      // Still merely proposed: nothing took effect.
      const record = await getRecord('owner', fightingRecordId);
      const action = (record.actions as Array<Record<string, any>>).find(
        (a) => a.id === suspensionActionId,
      );
      expect(action!.status).toBe('proposed');
      expect(action!.approvedBy).toBeNull();
    });

    it('a DIFFERENT person approves it, and the approval is recorded', async () => {
      const response = await post(
        'principal',
        `/api/v1/discipline/actions/${suspensionActionId}/approve`,
        {
          reason: 'Reviewed the evidence independently; the sanction is proportionate.',
          version: 1,
        },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      // startsOn is in the future, so the approved action is waiting, not yet active.
      expect(response.body.status).toBe('approved');
      expect(response.body.approvedBy).toBe(tenantA.users['principal']!.id);
      expect(response.body.decidedBy).toBe(tenantA.users['owner']!.id);

      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query(
          `select actor_user_id, reason from audit_logs
            where module = 'discipline' and resource_type = 'disciplinary_action'
              and resource_id = $1 and action = 'approve'`,
          [suspensionActionId],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].actor_user_id).toBe(tenantA.users['principal']!.id);
        expect(rows[0].reason).toContain('proportionate');
      } finally {
        await client.end();
      }
    });

    it('the DATABASE itself refuses a severe action whose approver equals its decider', async () => {
      const client = testClient();
      await client.connect();
      try {
        await expect(
          client.query(`update disciplinary_actions set approved_by = decided_by where id = $1`, [
            suspensionActionId,
          ]),
        ).rejects.toThrow(/severe_distinct_approver|check constraint/i);
      } finally {
        await client.end();
      }
    });

    it('an approved action cannot be approved again — 409 naming both states', async () => {
      const response = await post(
        'principal',
        `/api/v1/discipline/actions/${suspensionActionId}/approve`,
        { reason: 'Approving twice must be refused as a state error.', version: 2 },
      );
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('WORKFLOW_STATE_INVALID');
      expect(response.body.error.message).toContain('approved');
    });

    it('a non-severe action may be approved by its decider', async () => {
      const proposed = await post(
        'principal',
        `/api/v1/discipline/records/${fightingRecordId}/actions`,
        {
          actionType: 'detention',
          startsOn: '2026-08-01',
          details: 'One afternoon detention with a written reflection.',
          reason: 'A proportionate additional measure alongside the suspension.',
        },
      );
      expect(proposed.status).toBe(201);

      const approved = await post(
        'principal',
        `/api/v1/discipline/actions/${proposed.body.id}/approve`,
        { reason: 'Detention is not a severe action; self-approval is permitted.', version: 1 },
      );
      expect(approved.status, JSON.stringify(approved.body)).toBe(201);
      expect(['active', 'approved', 'completed']).toContain(approved.body.status);
    });

    it('a teacher cannot approve an action (permission denial)', async () => {
      const response = await post(
        'teacher',
        `/api/v1/discipline/actions/${suspensionActionId}/approve`,
        { reason: 'A teacher must not be able to approve sanctions.', version: 2 },
      );
      expect(response.status).toBe(403);
    });

    it('revoking requires a reason and never deletes the action', async () => {
      const missingReason = await post(
        'principal',
        `/api/v1/discipline/actions/${suspensionActionId}/revoke`,
        { version: 2 },
      );
      expect(missingReason.status).toBe(422);

      const revoked = await post(
        'principal',
        `/api/v1/discipline/actions/${suspensionActionId}/revoke`,
        { reason: 'The family appealed and the board reduced the sanction.', version: 2 },
      );
      expect(revoked.status, JSON.stringify(revoked.body)).toBe(201);
      expect(revoked.body.status).toBe('revoked');
      expect(revoked.body.revokedReason).toContain('appealed');

      // The revoked action is still on the record — marked, reasoned, never gone.
      const record = await getRecord('principal', fightingRecordId);
      const kept = (record.actions as Array<Record<string, any>>).find(
        (a) => a.id === suspensionActionId,
      );
      expect(kept).toBeTruthy();
      expect(kept!.status).toBe('revoked');

      const again = await post(
        'principal',
        `/api/v1/discipline/actions/${suspensionActionId}/revoke`,
        { reason: 'Revoking twice must be refused as a state error.', version: 3 },
      );
      expect(again.status).toBe(409);
      expect(again.body.error.message).toContain('revoked');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Guardian acknowledgement and the children summary
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('guardian acknowledgement', () => {
    it('the guardian acknowledges a visible record, exactly once', async () => {
      const first = await post(
        'guardian1',
        `/api/v1/discipline/records/${fightingRecordId}/acknowledge`,
        { comment: 'We have discussed this at home and will follow up with the school.' },
      );
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(first.body.guardianId).toBe(tenantA.guardianIds[0]);

      const second = await post(
        'guardian1',
        `/api/v1/discipline/records/${fightingRecordId}/acknowledge`,
        { comment: 'Trying to acknowledge twice.' },
      );
      expect(second.status).toBe(409);
    });

    it('another guardian cannot acknowledge a record that is not theirs — 404', async () => {
      const response = await post(
        'guardian2',
        `/api/v1/discipline/records/${fightingRecordId}/acknowledge`,
        { comment: 'This is not my child’s record.' },
      );
      expect(response.status).toBe(404);
    });

    it('staff cannot acknowledge on a family’s behalf', async () => {
      const response = await post(
        'principal',
        `/api/v1/discipline/records/${fightingRecordId}/acknowledge`,
        { comment: 'Staff acknowledging for the family must be refused.' },
      );
      // The principal holds broad view permissions but has no guardian identity.
      expect([403, 404]).toContain(response.status);
    });

    it('the my-children summary shows only the guardian’s own children and visible records', async () => {
      const response = await get('guardian1', '/api/v1/discipline/records/my-children');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).toHaveLength(1);
      const child = response.body[0];
      expect(child.studentId).toBe(tenantA.studentIds[0]);
      // Only the substantiated normal record counts; the restricted one must not even be
      // reflected in the numbers.
      expect(child.recordCount).toBe(1);
      expect(child.negativeCount).toBe(1);
      expect(child.meritPoints).toBe(-10);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Merit points: ledger, leaderboard
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('merit points', () => {
    it('substantiated positive records accumulate in the ledger as a running total', async () => {
      for (const description of [
        'Helped a classmate who was hurt on the stairs to the office.',
        'Volunteered to tutor two younger students after school hours.',
      ]) {
        const created = await post('teacher', '/api/v1/discipline/records', {
          studentId: tenantA.studentIds[1],
          categoryId: helpingCategoryId,
          academicYearId: tenantA.academicYearId,
          occurredOn: '2026-03-02',
          description,
        });
        expect(created.status).toBe(201);
        const decided = await transition(
          'principal',
          created.body.id,
          'substantiated',
          'Confirmed by the class teacher who witnessed the behaviour directly.',
        );
        expect(decided.status, JSON.stringify(decided.body)).toBe(201);
      }

      const oneMore = await post('teacher', '/api/v1/discipline/records', {
        studentId: tenantA.studentIds[2],
        categoryId: helpingCategoryId,
        academicYearId: tenantA.academicYearId,
        occurredOn: '2026-03-03',
        description: 'Returned a lost wallet to the office without being asked.',
      });
      expect(oneMore.status).toBe(201);
      const decided = await transition(
        'principal',
        oneMore.body.id,
        'substantiated',
        'Confirmed by the office assistant who received the wallet.',
      );
      expect(decided.status).toBe(201);

      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query(
          `select running_total from merit_points_ledger
            where student_id = $1 and academic_year_id = $2 and archived_at is null
            order by created_at, running_total`,
          [tenantA.studentIds[1], tenantA.academicYearId],
        );
        expect(rows.map((r) => r.running_total)).toEqual([5, 10]);
      } finally {
        await client.end();
      }
    });

    it('the DATABASE refuses a second ledger posting for the same record', async () => {
      const client = testClient();
      await client.connect();
      try {
        await expect(
          client.query(
            `insert into merit_points_ledger (tenant_id, institution_id, student_id, academic_year_id, source_record_id, points, running_total)
             values ($1,$2,$3,$4,$5,5,5)`,
            [
              tenantA.tenantId,
              tenantA.institutionId,
              tenantA.studentIds[0],
              tenantA.academicYearId,
              fightingRecordId,
            ],
          ),
        ).rejects.toThrow(/duplicate key|merit_points_ledger_source_key/i);
      } finally {
        await client.end();
      }
    });

    it('the leaderboard ranks positive points only and never publishes a negative total', async () => {
      const response = await get('principal', '/api/v1/discipline/reports/merit-leaderboard', {
        sectionId: tenantA.sectionId,
        academicYearId: tenantA.academicYearId,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);

      const entries = response.body.entries as Array<{
        rank: number;
        studentId: string;
        points: number;
      }>;
      expect(entries.length).toBe(2);
      expect(entries[0]!.studentId).toBe(tenantA.studentIds[1]);
      expect(entries[0]!.points).toBe(10);
      expect(entries[0]!.rank).toBe(1);
      expect(entries[1]!.studentId).toBe(tenantA.studentIds[2]);
      expect(entries[1]!.points).toBe(5);

      // The student with only negative points is simply absent — no negative ranking of a
      // child, ever.
      expect(entries.map((entry) => entry.studentId)).not.toContain(tenantA.studentIds[0]);
      for (const entry of entries) {
        expect(entry.points).toBeGreaterThan(0);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Trend report — SQL-computed, scope-filtered
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('incident trends', () => {
    async function visibleNonDraftCount(role: string): Promise<number> {
      const listed = await get(role, '/api/v1/discipline/records', { pageSize: 100 });
      expect(listed.status).toBe(200);
      return (listed.body.data as Array<{ status: string }>).filter(
        (r) => r.status !== 'draft' && r.status !== 'withdrawn',
      ).length;
    }

    it('the trend totals equal exactly what the caller could list', async () => {
      const expected = await visibleNonDraftCount('principal');
      const response = await get('principal', '/api/v1/discipline/reports/trends', {
        academicYearId: tenantA.academicYearId,
        groupBy: 'severity',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const total = (response.body.rows as Array<{ total: number }>).reduce(
        (sum, row) => sum + row.total,
        0,
      );
      expect(total).toBe(expected);
      expect(expected).toBeGreaterThan(0);
    });

    it('a teacher’s trend covers only their own scope — less than the principal’s', async () => {
      const principalCount = await visibleNonDraftCount('principal');
      const teacherCount = await visibleNonDraftCount('teacher');
      // The teacher cannot see the outsider-section record or the restricted one.
      expect(teacherCount).toBeLessThan(principalCount);

      const response = await get('teacher', '/api/v1/discipline/reports/trends', {
        academicYearId: tenantA.academicYearId,
        groupBy: 'month',
      });
      expect(response.status).toBe(200);
      const total = (response.body.rows as Array<{ total: number }>).reduce(
        (sum, row) => sum + row.total,
        0,
      );
      expect(total).toBe(teacherCount);
    });

    it('grouping by category joins the category vocabulary', async () => {
      const response = await get('principal', '/api/v1/discipline/reports/trends', {
        academicYearId: tenantA.academicYearId,
        groupBy: 'category',
      });
      expect(response.status).toBe(200);
      const codes = (response.body.rows as Array<{ code: string }>).map((row) => row.code);
      expect(codes).toContain('HELPING');
      expect(codes).toContain('FIGHTING');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Tenant isolation
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('tenant isolation', () => {
    it('another tenant cannot read a record by its exact id', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/discipline/records/${fightingRecordId}`)
        .set('Authorization', `Bearer ${tokens['otherPrincipal']}`)
        .set('x-institution-id', tenantB.institutionId);

      // 404, not 403: confirming a child's disciplinary record exists elsewhere is itself
      // a leak.
      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain('tiffin');
    });

    it('another tenant cannot borrow the institution header', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/discipline/records')
        .set('Authorization', `Bearer ${tokens['otherPrincipal']}`)
        .set('x-institution-id', tenantA.institutionId);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('another tenant’s own list is empty rather than leaky', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/discipline/records')
        .set('Authorization', `Bearer ${tokens['otherPrincipal']}`)
        .set('x-institution-id', tenantB.institutionId);

      expect(response.status).toBe(200);
      expect(response.body.meta.total).toBe(0);
      expect(response.body.data).toEqual([]);
    });

    it('every discipline table carries forced row-level security', async () => {
      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query<{ relname: string }>(
          `select c.relname
             from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public'
              and c.relkind = 'r'
              and c.relname = any($1)
              and (not c.relrowsecurity
                   or not c.relforcerowsecurity
                   or not exists (select 1 from pg_policy p
                                   where p.polrelid = c.oid and p.polname = 'tenant_isolation'))`,
          [DISCIPLINE_TABLES],
        );
        expect(rows.map((row) => row.relname)).toEqual([]);
      } finally {
        await client.end();
      }
    });

    it('the database refuses a record stamped with another tenant’s id', async () => {
      // Connects as `shikkha_app` — the same unprivileged role the API uses — so this is
      // what an attacker with SQL execution inside the application could actually do.
      const client = new Client({ connectionString: TEST_APP_DATABASE_URL });
      await client.connect();
      try {
        await client.query('begin');
        await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantB.tenantId]);
        await expect(
          client.query(
            `insert into behaviour_records (tenant_id, institution_id, student_id, category_id, academic_year_id,
                                            occurred_on, description, severity, points, reported_by_employee_id)
             values ($1,$2,$3,$4,$5,'2026-01-10','Cross-tenant attack row','minor',0,$6)`,
            [
              tenantA.tenantId,
              tenantA.institutionId,
              tenantA.studentIds[0],
              fightingCategoryId,
              tenantA.academicYearId,
              tenantA.employeeIds[0],
            ],
          ),
        ).rejects.toThrow(/row-level security/i);
      } finally {
        await client.query('rollback').catch(() => undefined);
        await client.end();
      }
    });
  });
});
