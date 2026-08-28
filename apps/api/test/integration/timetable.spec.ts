/**
 * Timetable integration suite (Phase 6).
 *
 * The routine is where several of the product's invariants meet, so this suite is organised
 * around the ones that would hurt if they broke rather than around the endpoints:
 *
 *  - **The three clash rules.** A section, a teacher and a room can each be in one place at a
 *    time. Each is asserted separately, because the three are enforced by three different
 *    indexes and it is entirely possible to get two right.
 *  - **A published routine is immutable.** Editing it must be refused, not silently versioned.
 *  - **Publishing archives its predecessor, in one transaction.** Two live routines for one
 *    campus is a school where half the staff are in the wrong room.
 *  - **A substitute who is already busy is not available.** The whole value of recording cover
 *    is that it is checked.
 *  - **References must be in the same institution**, and **another tenant's routine does not
 *    exist**, both at the HTTP layer and independently at the database layer.
 *
 * The fixtures are built with raw SQL through the migrator connection because `seedTenant`
 * stops at students: shifts, periods, rooms and subjects are Phase 2 configuration that the
 * timetable consumes but does not own.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Client } from 'pg';
import { addDays, calendarDate, dhakaWeekday, todayInDhaka, uuidv7 } from '@shikkha/shared';
import {
  createTestApp,
  seedTenant,
  testClient,
  truncateAll,
  TEST_APP_DATABASE_URL,
  TEST_PASSWORD,
  type SeededTenant,
} from '../helpers/test-app';

interface TimetableFixtures {
  shiftId: string;
  periodIds: string[];
  subjectIds: string[];
  roomIds: string[];
  sectionAId: string;
  sectionBId: string;
  teacher1: string;
  teacher2: string;
  teacher3: string;
  foreignInstitutionId: string;
  foreignRoomId: string;
}

/**
 * Everything a timetable references, none of which `seedTenant` creates.
 *
 * The second institution exists for exactly one test — that a room from another school in the
 * same tenant cannot be scheduled — and that test is worth the twelve lines, because foreign
 * keys are perfectly satisfied by the wrong answer.
 */
async function seedTimetableFixtures(tenant: SeededTenant): Promise<TimetableFixtures> {
  const client = testClient();
  await client.connect();
  try {
    await client.query('begin');

    const shiftId = uuidv7();
    await client.query(
      `insert into shifts (id, tenant_id, institution_id, campus_id, kind, name_en, start_time, end_time)
       values ($1,$2,$3,$4,'single','Day Shift','08:00:00','14:00:00')`,
      [shiftId, tenant.tenantId, tenant.institutionId, tenant.campusId],
    );

    const periodIds: string[] = [];
    const times = [
      ['08:00:00', '08:45:00'],
      ['08:45:00', '09:30:00'],
      ['09:30:00', '10:15:00'],
    ];
    for (let i = 0; i < times.length; i += 1) {
      const id = uuidv7();
      periodIds.push(id);
      await client.query(
        `insert into periods (id, tenant_id, institution_id, shift_id, name_en, sequence, start_time, end_time)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          id,
          tenant.tenantId,
          tenant.institutionId,
          shiftId,
          `Period ${i + 1}`,
          i + 1,
          times[i]![0],
          times[i]![1],
        ],
      );
    }

    const subjectIds: string[] = [];
    for (const [code, name] of [
      ['MATH', 'Mathematics'],
      ['ENG', 'English'],
    ]) {
      const id = uuidv7();
      subjectIds.push(id);
      await client.query(
        `insert into subjects (id, tenant_id, institution_id, code, name_en)
         values ($1,$2,$3,$4,$5)`,
        [id, tenant.tenantId, tenant.institutionId, code, name],
      );
    }

    const roomIds: string[] = [];
    for (const [code, name] of [
      ['R1', 'Room 1'],
      ['R2', 'Room 2'],
    ]) {
      const id = uuidv7();
      roomIds.push(id);
      await client.query(
        `insert into rooms (id, tenant_id, institution_id, campus_id, code, name_en)
         values ($1,$2,$3,$4,$5,$6)`,
        [id, tenant.tenantId, tenant.institutionId, tenant.campusId, code, name],
      );
    }

    const sectionBId = uuidv7();
    await client.query(
      `insert into sections (id, tenant_id, institution_id, campus_id, academic_year_id, class_level_id, name_en, capacity)
       values ($1,$2,$3,$4,$5,$6,'B',60)`,
      [
        sectionBId,
        tenant.tenantId,
        tenant.institutionId,
        tenant.campusId,
        tenant.academicYearId,
        tenant.classLevelId,
      ],
    );

    const { rows: teacherRows } = await client.query<{ id: string }>(
      `select id from employees where user_id = $1`,
      [tenant.users['teacher']!.id],
    );
    const teacher1 = teacherRows[0]!.id;

    const extraTeachers: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const id = uuidv7();
      extraTeachers.push(id);
      await client.query(
        `insert into employees (id, tenant_id, institution_id, campus_id, employee_code, full_name_en, phone, joining_date)
         values ($1,$2,$3,$4,$5,$6,$7,'2020-01-01')`,
        [
          id,
          tenant.tenantId,
          tenant.institutionId,
          tenant.campusId,
          `TT-EXTRA-${i + 1}`,
          `Timetable Teacher ${i + 1}`,
          `+8801811000${i + 1}0`,
        ],
      );
    }

    // A second school in the same tenant. Same tenant id, different institution — the case a
    // tenant_id check alone would happily let through.
    const foreignInstitutionId = uuidv7();
    await client.query(
      `insert into institutions (id, tenant_id, code, name_en, type, medium)
       values ($1,$2,'TT-OTHER','Other Institution','school','bangla')`,
      [foreignInstitutionId, tenant.tenantId],
    );
    const foreignCampusId = uuidv7();
    await client.query(
      `insert into campuses (id, tenant_id, institution_id, code, name_en, is_primary)
       values ($1,$2,$3,'OTHER','Other Campus',true)`,
      [foreignCampusId, tenant.tenantId, foreignInstitutionId],
    );
    const foreignRoomId = uuidv7();
    await client.query(
      `insert into rooms (id, tenant_id, institution_id, campus_id, code, name_en)
       values ($1,$2,$3,$4,'X1','Other School Room')`,
      [foreignRoomId, tenant.tenantId, foreignInstitutionId, foreignCampusId],
    );

    await client.query('commit');

    return {
      shiftId,
      periodIds,
      subjectIds,
      roomIds,
      sectionAId: tenant.sectionId,
      sectionBId,
      teacher1,
      teacher2: extraTeachers[0]!,
      teacher3: extraTeachers[1]!,
      foreignInstitutionId,
      foreignRoomId,
    };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

/** The first date on or after `start` that falls on `weekday` (0 = Sunday). */
function onWeekday(start: string, weekday: number): string {
  let date = calendarDate(start);
  for (let i = 0; i < 7; i += 1) {
    if (dhakaWeekday(date) === weekday) return date;
    date = addDays(date, 1);
  }
  throw new Error(`no ${weekday} within a week of ${start}`);
}

describe('Timetable', () => {
  let app: INestApplication;
  let tenant: SeededTenant;
  let otherTenant: SeededTenant;
  let fixtures: TimetableFixtures;
  const tokens: Record<string, string> = {};

  const today = todayInDhaka();
  /** Entries are scheduled on Sunday, the first teaching day of a Bangladeshi week. */
  const SUNDAY = 0;

  let draftId = '';
  let cloneId = '';

  async function login(email: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: email, password: TEST_PASSWORD });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body.accessToken as string;
  }

  const get = (role: string, path: string, institutionId = tenant.institutionId) =>
    request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${tokens[role]}`)
      .set('x-institution-id', institutionId);

  const post = (role: string, path: string, body: object = {}, institutionId?: string) =>
    request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${tokens[role]}`)
      .set('x-institution-id', institutionId ?? tenant.institutionId)
      .send(body);

  const put = (role: string, path: string, body: object = {}) =>
    request(app.getHttpServer())
      .put(path)
      .set('Authorization', `Bearer ${tokens[role]}`)
      .set('x-institution-id', tenant.institutionId)
      .send(body);

  const del = (role: string, path: string, body: object = {}) =>
    request(app.getHttpServer())
      .delete(path)
      .set('Authorization', `Bearer ${tokens[role]}`)
      .set('x-institution-id', tenant.institutionId)
      .send(body);

  const lesson = (overrides: Record<string, unknown> = {}) => ({
    dayOfWeek: SUNDAY,
    periodId: fixtures.periodIds[0],
    subjectId: fixtures.subjectIds[0],
    employeeId: fixtures.teacher1,
    roomId: fixtures.roomIds[0],
    ...overrides,
  });

  beforeAll(async () => {
    app = await createTestApp();
    await truncateAll();
    tenant = await seedTenant('tt', { students: 2 });
    otherTenant = await seedTenant('ttb', { students: 1 });
    fixtures = await seedTimetableFixtures(tenant);

    for (const key of ['owner', 'principal', 'teacher', 'accountant', 'guardian1']) {
      tokens[key] = await login(tenant.users[key]!.email);
    }
    tokens['otherPrincipal'] = await login(otherTenant.users['principal']!.email);
  });

  afterAll(async () => {
    await app?.close();
  });

  // ── Drafting and clash detection ───────────────────────────────────────────────────

  describe('drafting', () => {
    it('creates a draft timetable', async () => {
      const response = await post('principal', '/api/v1/timetables', {
        campusId: tenant.campusId,
        academicYearId: tenant.academicYearId,
        nameEn: 'Routine 2026 v1',
        effectiveFrom: today,
      });

      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('draft');
      expect(response.body.publishedAt).toBeNull();
      draftId = response.body.id as string;
    });

    it('requires the institution header', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/timetables')
        .set('Authorization', `Bearer ${tokens['principal']}`);
      expect(response.status).toBe(400);
    });

    it('accepts a week for one section', async () => {
      const response = await put('principal', `/api/v1/timetables/${draftId}/entries`, {
        sectionId: fixtures.sectionAId,
        entries: [
          lesson(),
          lesson({ periodId: fixtures.periodIds[1], subjectId: fixtures.subjectIds[1] }),
        ],
      });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.entries).toHaveLength(2);
    });

    it('refuses to put one section in two places in the same period', async () => {
      const response = await put('principal', `/api/v1/timetables/${draftId}/entries`, {
        sectionId: fixtures.sectionAId,
        entries: [
          lesson(),
          // Same day and period, but a different subject, teacher and room — so the section
          // itself is the only thing that clashes.
          lesson({
            subjectId: fixtures.subjectIds[1],
            roomId: fixtures.roomIds[1],
            employeeId: fixtures.teacher2,
          }),
        ],
      });

      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body.error.code).toBe('CONFLICT');
      expect(response.body.error.message).toContain('two lessons');
      expect(response.body.error.message).not.toContain('two classes');
    });

    it('refuses to put one teacher in two places in the same period', async () => {
      const response = await put('principal', `/api/v1/timetables/${draftId}/entries`, {
        sectionId: fixtures.sectionBId,
        // Section B is free, the room is free — the teacher is not.
        entries: [lesson({ roomId: fixtures.roomIds[1] })],
      });

      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body.error.code).toBe('CONFLICT');
      expect(response.body.error.message).toContain('scheduled to teach two classes');
      expect(response.body.error.message).not.toContain('booked by');
    });

    it('refuses to put one room in use by two sections in the same period', async () => {
      const response = await put('principal', `/api/v1/timetables/${draftId}/entries`, {
        sectionId: fixtures.sectionBId,
        // A free teacher this time, so the room is the only thing left to clash.
        entries: [lesson({ employeeId: fixtures.teacher2 })],
      });

      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body.error.code).toBe('CONFLICT');
      expect(response.body.error.message).toContain('booked by two classes');
      expect(response.body.error.message).not.toContain('scheduled to teach');
    });

    it('accepts the same slot for another section once the teacher and room differ', async () => {
      const response = await put('principal', `/api/v1/timetables/${draftId}/entries`, {
        sectionId: fixtures.sectionBId,
        entries: [lesson({ employeeId: fixtures.teacher2, roomId: fixtures.roomIds[1] })],
      });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.entries).toHaveLength(1);
    });

    it('refuses a room belonging to another institution in the same tenant', async () => {
      const response = await put('principal', `/api/v1/timetables/${draftId}/entries`, {
        sectionId: fixtures.sectionAId,
        entries: [lesson({ roomId: fixtures.foreignRoomId })],
      });

      // 404, not 403: the caller learns nothing about whether the id exists elsewhere.
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('left the section untouched when the cross-institution write was refused', async () => {
      const response = await get('principal', `/api/v1/timetables/${draftId}`);
      expect(response.status).toBe(200);
      const sectionAEntries = (response.body.entries as Array<{ sectionId: string }>).filter(
        (entry) => entry.sectionId === fixtures.sectionAId,
      );
      // The refused request archived nothing: two lessons from the successful save remain.
      expect(sectionAEntries).toHaveLength(2);
    });

    it('archives a single lesson rather than deleting it, and demands a reason', async () => {
      const before = await get('principal', `/api/v1/timetables/${draftId}`);
      const target = (before.body.entries as Array<{ id: string; sectionId: string }>).find(
        (entry) => entry.sectionId === fixtures.sectionBId,
      )!;

      const refused = await del(
        'principal',
        `/api/v1/timetables/${draftId}/entries/${target.id}`,
        {},
      );
      expect(refused.status).toBe(422);

      const removed = await del('principal', `/api/v1/timetables/${draftId}/entries/${target.id}`, {
        reason: 'Section B merged into Section A for this term',
      });
      expect(removed.status, JSON.stringify(removed.body)).toBe(200);
      expect(removed.body.archivedAt).toBeTruthy();

      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query<{ count: string }>(
          `select count(*) from timetable_entries where id = $1`,
          [target.id],
        );
        // Still there: attendance taken against last week's routine has to stay readable.
        expect(Number(rows[0]!.count)).toBe(1);
      } finally {
        await client.end();
      }

      // Put it back so the publishing tests start from a full routine.
      const restored = await put('principal', `/api/v1/timetables/${draftId}/entries`, {
        sectionId: fixtures.sectionBId,
        entries: [lesson({ employeeId: fixtures.teacher2, roomId: fixtures.roomIds[1] })],
      });
      expect(restored.status).toBe(200);
    });
  });

  // ── Publishing ─────────────────────────────────────────────────────────────────────

  describe('publishing', () => {
    it('reports a clean bill of health before publication', async () => {
      const response = await get('principal', `/api/v1/timetables/${draftId}/validate`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.isValid).toBe(true);
      expect(response.body.conflicts).toEqual([]);
      expect(response.body.entryCount).toBe(3);
    });

    it('publishes the draft', async () => {
      const response = await post('principal', `/api/v1/timetables/${draftId}/publish`, {});
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('published');
      expect(response.body.publishedAt).toBeTruthy();
      expect(response.body.supersededTimetableId).toBeNull();
    });

    it('records the publication in the audit log', async () => {
      const response = await get('owner', '/api/v1/audit-logs?module=timetable&pageSize=100');
      expect(response.status).toBe(200);
      const entry = (response.body.data as Array<{ resourceId: string; action: string }>).find(
        (row) => row.resourceId === draftId && row.action === 'publish',
      );
      expect(entry, 'publishing a timetable was not audited').toBeTruthy();
    });

    it('refuses to edit a published timetable', async () => {
      const response = await put('principal', `/api/v1/timetables/${draftId}/entries`, {
        sectionId: fixtures.sectionAId,
        entries: [lesson({ periodId: fixtures.periodIds[2] })],
      });

      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body.error.code).toBe('CONFLICT');
      expect(response.body.error.message).toContain('published timetable cannot be edited');
    });

    it('refuses to remove a lesson from a published timetable', async () => {
      const published = await get('principal', `/api/v1/timetables/${draftId}`);
      const target = (published.body.entries as Array<{ id: string }>)[0]!;

      const response = await del(
        'principal',
        `/api/v1/timetables/${draftId}/entries/${target.id}`,
        { reason: 'Trying to edit a live routine' },
      );
      expect(response.status).toBe(409);
    });

    it('refuses to publish the same timetable twice', async () => {
      const response = await post('principal', `/api/v1/timetables/${draftId}/publish`, {});
      expect(response.status).toBe(409);
      expect(response.body.error.message).toContain('already published');
    });

    it('clones a published routine into a fresh draft', async () => {
      const response = await post('principal', `/api/v1/timetables/${draftId}/clone`, {
        nameEn: 'Routine 2026 v2',
        effectiveFrom: today,
      });

      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('draft');
      expect(response.body.entriesCopied).toBe(3);
      cloneId = response.body.id as string;
    });

    it('archives the previously published routine when the clone goes live', async () => {
      const response = await post('principal', `/api/v1/timetables/${cloneId}/publish`, {});
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('published');
      expect(response.body.supersededTimetableId).toBe(draftId);

      const superseded = await get('principal', `/api/v1/timetables/${draftId}`);
      expect(superseded.status).toBe(200);
      expect(superseded.body.status).toBe('archived');
      expect(superseded.body.archivedAt).toBeTruthy();
      expect(superseded.body.archiveReason).toContain('Superseded by');

      // The archival happens inside the publish transaction and has no route of its own, so
      // it is written by the service. Without it the trail would say the old routine simply
      // vanished.
      const trail = await get('owner', '/api/v1/audit-logs?module=timetable&pageSize=100');
      const archival = (trail.body.data as Array<{ resourceId: string; action: string }>).find(
        (row) => row.resourceId === draftId && row.action === 'archive',
      );
      expect(archival, 'superseding a published timetable was not audited').toBeTruthy();
    });

    it('leaves exactly one published routine for the campus', async () => {
      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query<{ count: string }>(
          `select count(*) from timetables
           where institution_id = $1 and campus_id = $2 and status = 'published'
             and archived_at is null`,
          [tenant.institutionId, tenant.campusId],
        );
        expect(Number(rows[0]!.count)).toBe(1);
      } finally {
        await client.end();
      }
    });

    /**
     * The one clash rule no unique index can express: a double period consumes the following
     * slot too. The conflicting rows are written with raw SQL precisely because the service
     * would have refused them — this asserts that publication is a real backstop rather than
     * a formality that trusts whatever is already in the table.
     */
    it('refuses to publish a routine whose double period collides, listing every conflict', async () => {
      const created = await post('principal', '/api/v1/timetables', {
        campusId: tenant.campusId,
        academicYearId: tenant.academicYearId,
        nameEn: 'Routine 2026 v3',
        effectiveFrom: today,
      });
      expect(created.status).toBe(201);
      const spillId = created.body.id as string;

      const client = testClient();
      await client.connect();
      try {
        await client.query(
          `insert into timetable_entries
             (id, tenant_id, institution_id, timetable_id, section_id, day_of_week, period_id, subject_id, employee_id, room_id, is_double_period)
           values ($1,$2,$3,$4,$5,1,$6,$7,$8,$9,true)`,
          [
            uuidv7(),
            tenant.tenantId,
            tenant.institutionId,
            spillId,
            fixtures.sectionAId,
            fixtures.periodIds[0],
            fixtures.subjectIds[0],
            fixtures.teacher1,
            fixtures.roomIds[0],
          ],
        );
        await client.query(
          `insert into timetable_entries
             (id, tenant_id, institution_id, timetable_id, section_id, day_of_week, period_id, subject_id, employee_id, room_id, is_double_period)
           values ($1,$2,$3,$4,$5,1,$6,$7,$8,$9,false)`,
          [
            uuidv7(),
            tenant.tenantId,
            tenant.institutionId,
            spillId,
            fixtures.sectionBId,
            fixtures.periodIds[1],
            fixtures.subjectIds[1],
            fixtures.teacher1,
            fixtures.roomIds[1],
          ],
        );
      } finally {
        await client.end();
      }

      const report = await get('principal', `/api/v1/timetables/${spillId}/validate`);
      expect(report.status).toBe(200);
      expect(report.body.isValid).toBe(false);
      expect(report.body.conflicts).toHaveLength(1);
      expect(report.body.conflicts[0].kind).toBe('teacher');

      const response = await post('principal', `/api/v1/timetables/${spillId}/publish`, {});
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      // Every conflict, not just the first — that is what the issues array is for.
      expect(response.body.error.issues).toHaveLength(1);
      expect(response.body.error.issues[0].message).toContain('two classes');

      const untouched = await get('principal', `/api/v1/timetables/${spillId}`);
      expect(untouched.body.status).toBe('draft');
    });
  });

  // ── Substitutions ──────────────────────────────────────────────────────────────────

  describe('substitutions', () => {
    /** A Sunday at least a week out: after the routine takes effect, and not in the past. */
    const coverDate = onWeekday(addDays(calendarDate(todayInDhaka()), 7), SUNDAY);
    let entryId = '';
    let substitutionId = '';

    beforeAll(async () => {
      const published = await get('principal', `/api/v1/timetables/${cloneId}`);
      const entry = (published.body.entries as Array<{ id: string; employeeId: string }>).find(
        (row) => row.employeeId === fixtures.teacher1,
      )!;
      entryId = entry.id;
    });

    it('refuses a substitute who is already teaching in that period', async () => {
      // Teacher 2 has Section B in the same slot of the same published routine.
      const response = await post('principal', `/api/v1/timetables/${cloneId}/substitutions`, {
        entryId,
        substitutionDate: coverDate,
        substituteEmployeeId: fixtures.teacher2,
        reason: 'Covering while the class teacher is at a training day',
      });

      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body.error.code).toBe('CONFLICT');
      expect(response.body.error.message).toContain('already committed');
    });

    it('refuses a date that is not the lesson’s weekday', async () => {
      const response = await post('principal', `/api/v1/timetables/${cloneId}/substitutions`, {
        entryId,
        substitutionDate: addDays(calendarDate(coverDate), 1),
        substituteEmployeeId: fixtures.teacher3,
        reason: 'Covering while the class teacher is at a training day',
      });

      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('records a substitute who is free', async () => {
      const response = await post('principal', `/api/v1/timetables/${cloneId}/substitutions`, {
        entryId,
        substitutionDate: coverDate,
        substituteEmployeeId: fixtures.teacher3,
        reason: 'Covering while the class teacher is at a training day',
      });

      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.substituteEmployeeId).toBe(fixtures.teacher3);
      expect(response.body.originalEmployeeId).toBe(fixtures.teacher1);
      substitutionId = response.body.id as string;
    });

    it('audits the substitution', async () => {
      const response = await get(
        'owner',
        '/api/v1/audit-logs?module=timetable&resourceType=timetable_substitution',
      );
      expect(response.status).toBe(200);
      expect((response.body.data as unknown[]).length).toBeGreaterThan(0);
    });

    it('refuses a second substitute for the same lesson on the same date', async () => {
      const response = await post('principal', `/api/v1/timetables/${cloneId}/substitutions`, {
        entryId,
        substitutionDate: coverDate,
        substituteEmployeeId: fixtures.teacher2,
        reason: 'A second attempt at covering the same lesson',
      });
      expect(response.status).toBe(409);
    });

    it('refuses to substitute against an entry from another timetable', async () => {
      const response = await post('principal', `/api/v1/timetables/${draftId}/substitutions`, {
        entryId,
        substitutionDate: coverDate,
        substituteEmployeeId: fixtures.teacher3,
        reason: 'Wrong routine entirely, this should not be accepted',
      });
      expect(response.status).toBe(404);
    });

    it('cancels a future substitution as an archive, not a delete', async () => {
      const response = await post(
        'principal',
        `/api/v1/timetables/substitutions/${substitutionId}/cancel`,
        { reason: 'The class teacher’s training was postponed' },
      );

      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.archivedAt).toBeTruthy();

      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query<{ count: string }>(
          `select count(*) from timetable_substitutions where id = $1`,
          [substitutionId],
        );
        expect(Number(rows[0]!.count)).toBe(1);
      } finally {
        await client.end();
      }
    });
  });

  // ── Scope-aware read views ─────────────────────────────────────────────────────────

  describe('read views', () => {
    it('gives a class teacher the routine of their own section', async () => {
      const response = await get('teacher', `/api/v1/timetable/section/${fixtures.sectionAId}`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.timetable.id).toBe(cloneId);
      expect((response.body.entries as unknown[]).length).toBeGreaterThan(0);
    });

    it('hides another section’s routine from a teacher who does not take it', async () => {
      const response = await get('teacher', `/api/v1/timetable/section/${fixtures.sectionBId}`);
      // 404 rather than 403: "not yours" and "does not exist" must be indistinguishable.
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('gives a guardian their own child’s routine and nothing else', async () => {
      const mine = await get('guardian1', `/api/v1/timetable/section/${fixtures.sectionAId}`);
      expect(mine.status, JSON.stringify(mine.body)).toBe(200);

      const notMine = await get('guardian1', `/api/v1/timetable/section/${fixtures.sectionBId}`);
      expect(notMine.status).toBe(404);
    });

    it('gives a teacher their own week', async () => {
      const response = await get('teacher', `/api/v1/timetable/teacher/${fixtures.teacher1}`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.employee.id).toBe(fixtures.teacher1);
      expect(
        (response.body.entries as Array<{ employeeId: string }>).every(
          (entry) => entry.employeeId === fixtures.teacher1,
        ),
      ).toBe(true);
    });

    it('refuses one teacher browsing another teacher’s week', async () => {
      const response = await get('teacher', `/api/v1/timetable/teacher/${fixtures.teacher2}`);
      expect(response.status).toBe(404);
    });

    it('lets a coordinator read any teacher’s week', async () => {
      const response = await get('principal', `/api/v1/timetable/teacher/${fixtures.teacher2}`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.employee.id).toBe(fixtures.teacher2);
    });
  });

  // ── Permissions ────────────────────────────────────────────────────────────────────

  describe('permission enforcement', () => {
    it('refuses timetable creation to a teacher', async () => {
      const response = await post('teacher', '/api/v1/timetables', {
        campusId: tenant.campusId,
        academicYearId: tenant.academicYearId,
        nameEn: 'Teacher’s own routine',
        effectiveFrom: today,
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('refuses publication to a teacher', async () => {
      const response = await post('teacher', `/api/v1/timetables/${cloneId}/publish`, {});
      expect(response.status).toBe(403);
    });

    it('refuses substitution to a teacher without the permission', async () => {
      const response = await post('teacher', `/api/v1/timetables/${cloneId}/substitutions`, {
        entryId: '00000000-0000-4000-8000-000000000000',
        substitutionDate: today,
        substituteEmployeeId: fixtures.teacher3,
        reason: 'A teacher arranging their own cover',
      });
      expect(response.status).toBe(403);
    });

    it('refuses the whole module to a role with no timetable permission', async () => {
      const response = await get('accountant', '/api/v1/timetables');
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('never names the missing permission in the response', async () => {
      const response = await get('accountant', '/api/v1/timetables');
      expect(JSON.stringify(response.body)).not.toContain('timetable.view');
    });

    it('shows a guardian only published routines', async () => {
      const response = await get('guardian1', '/api/v1/timetables');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(
        (response.body.data as Array<{ status: string }>).every(
          (row) => row.status === 'published',
        ),
        'a draft or archived routine leaked to a guardian',
      ).toBe(true);
    });

    it('refuses a viewer without authoring rights the archived list', async () => {
      const response = await get('teacher', '/api/v1/timetables?includeArchived=true');
      expect(response.status).toBe(403);
    });
  });

  // ── Tenant isolation ───────────────────────────────────────────────────────────────

  describe('tenant isolation', () => {
    it('does not let another tenant read this tenant’s timetable by id', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/timetables/${cloneId}`)
        .set('Authorization', `Bearer ${tokens['otherPrincipal']}`)
        .set('x-institution-id', otherTenant.institutionId);

      // 404 rather than 403: confirming the record exists elsewhere is itself a leak.
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain('Routine 2026');
    });

    it('does not let another tenant list this tenant’s timetables', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/timetables')
        .set('Authorization', `Bearer ${tokens['otherPrincipal']}`)
        .set('x-institution-id', otherTenant.institutionId);

      expect(response.status).toBe(200);
      expect(response.body.meta.total).toBe(0);
      expect(response.body.data).toEqual([]);
    });

    it('refuses a borrowed institution header', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/timetables')
        .set('Authorization', `Bearer ${tokens['otherPrincipal']}`)
        .set('x-institution-id', tenant.institutionId);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    /**
     * The database half. Connecting as `shikkha_app` — the unprivileged role the API itself
     * uses — is what an attacker with SQL execution inside the application would have.
     */
    describe('row-level security, independent of the application', () => {
      let client: Client;

      beforeAll(async () => {
        client = new Client({ connectionString: TEST_APP_DATABASE_URL });
        await client.connect();
      });

      afterAll(async () => {
        await client?.end();
      });

      it('returns zero rows with no tenant context — fails closed, not open', async () => {
        for (const table of ['timetables', 'timetable_entries', 'timetable_substitutions']) {
          const { rows } = await client.query<{ count: string }>(`select count(*) from ${table}`);
          expect(Number(rows[0]!.count), `${table} leaked without a tenant context`).toBe(0);
        }
      });

      it('shows one tenant nothing of the other’s routines', async () => {
        await client.query('begin');
        await client.query(`select set_config('app.tenant_id', $1, true)`, [otherTenant.tenantId]);
        const { rows } = await client.query<{ count: string }>(`select count(*) from timetables`);
        expect(Number(rows[0]!.count)).toBe(0);
        await client.query('rollback');
      });

      it('refuses a write stamped with another tenant id', async () => {
        await client.query('begin');
        await client.query(`select set_config('app.tenant_id', $1, true)`, [otherTenant.tenantId]);
        await expect(
          client.query(
            `insert into timetables (tenant_id, institution_id, campus_id, academic_year_id, name_en, effective_from)
             values ($1,$2,$3,$4,'Cross Tenant Routine','2026-01-01')`,
            [tenant.tenantId, tenant.institutionId, tenant.campusId, tenant.academicYearId],
          ),
        ).rejects.toThrow(/row-level security/i);
        await client.query('rollback');
      });

      it('has forced row-level security on every timetable table', async () => {
        const { rows } = await client.query<{ relname: string }>(
          `select c.relname
             from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public'
              and c.relname in ('timetables', 'timetable_entries', 'timetable_substitutions')
              and (not c.relrowsecurity or not c.relforcerowsecurity)`,
        );
        expect(rows.map((row) => row.relname)).toEqual([]);
      });
    });
  });
});
