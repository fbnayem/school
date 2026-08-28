/**
 * Academic configuration CRUD (Phase 2 completion).
 *
 * The endpoints under test are configuration, but three of them are not merely configuration:
 *
 *  - **Periods** and **curriculum** are replaced as a *set*, because their invariants are
 *    properties of the set. The tests below assert the invariants, not the plumbing: a bell
 *    schedule with a gap, with an overlap, or with a period outside its shift is refused, and
 *    a curriculum whose mark components do not add up to full marks is refused three times
 *    over — by Zod, by the service, and by the CHECK constraint migration 0006 added for
 *    KI-009.
 *  - **Teacher assignments** decide who can see which children. `students.view.assigned` is a
 *    join against these two tables, so "at most one class teacher per section per year" is an
 *    authorization property, and it is asserted as one.
 *  - **Every parent reference** is re-checked against the caller's institution. A tenant with
 *    two schools is the normal case in this product, and the cross-institution tests below
 *    use a second institution inside the *same* tenant — the case row-level security cannot
 *    catch, because both rows legitimately belong to that tenant.
 *
 * The suite closes with tenant isolation asserted twice: once over HTTP, and once directly
 * against Postgres as the unprivileged application role, which is what an attacker with SQL
 * execution inside the API would actually have.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Client } from 'pg';
import { addDays, todayInDhaka, uuidv7 } from '@shikkha/shared';
import {
  createTestApp,
  seedTenant,
  testClient,
  truncateAll,
  TEST_APP_DATABASE_URL,
  TEST_PASSWORD,
  type SeededTenant,
} from '../helpers/test-app';

describe('academic configuration CRUD', () => {
  let app: INestApplication;
  let tenant: SeededTenant;
  let otherTenant: SeededTenant;
  const tokens: Record<string, string> = {};

  /** A second institution inside the *same* tenant, for the cross-institution attempts. */
  let other: {
    institutionId: string;
    campusId: string;
    academicYearId: string;
    classLevelId: string;
    shiftId: string;
  };

  const today = todayInDhaka();
  const yearStart = addDays(today, -180);
  const yearEnd = addDays(today, 180);
  const future = addDays(today, 45);
  const past = addDays(today, -45);

  // Ids produced by earlier cases and consumed by later ones. The suite is deliberately
  // ordered: a curriculum has to exist before a teacher can be assigned to teach from it.
  let roomId = '';
  let shiftId = '';
  let sectionBId = '';
  let futureEventId = '';
  let pastEventId = '';
  const subjectIds: string[] = [];
  let subjectAssignmentId = '';
  let sectionAssignmentId = '';

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
      .set('x-institution-id', tenant.institutionId);

  const post = (role: string, path: string, body: object = {}) =>
    request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${tokens[role]}`)
      .set('x-institution-id', tenant.institutionId)
      .send(body);

  const patch = (role: string, path: string, body: object = {}) =>
    request(app.getHttpServer())
      .patch(path)
      .set('Authorization', `Bearer ${tokens[role]}`)
      .set('x-institution-id', tenant.institutionId)
      .send(body);

  const put = (role: string, path: string, body: object = {}) =>
    request(app.getHttpServer())
      .put(path)
      .set('Authorization', `Bearer ${tokens[role]}`)
      .set('x-institution-id', tenant.institutionId)
      .send(body);

  const remove = (role: string, path: string, body: object = {}) =>
    request(app.getHttpServer())
      .delete(path)
      .set('Authorization', `Bearer ${tokens[role]}`)
      .set('x-institution-id', tenant.institutionId)
      .send(body);

  /**
   * The audit interceptor writes after the handler resolves and deliberately never fails the
   * request, so the row lands shortly after the response. Polling is the honest way to assert
   * it — a bare read would be racy and would be "fixed" later by deleting the assertion.
   */
  async function expectAuditRow(criteria: {
    resourceType: string;
    action: string;
    resourceId?: string;
  }): Promise<void> {
    const client = testClient();
    await client.connect();
    try {
      for (let attempt = 0; attempt < 25; attempt += 1) {
        const { rows } = await client.query<{ total: string }>(
          `select count(*) as total from audit_logs
           where module = 'academic' and resource_type = $1 and action = $2
             and ($3::uuid is null or resource_id = $3::uuid)`,
          [criteria.resourceType, criteria.action, criteria.resourceId ?? null],
        );
        if (Number(rows[0]!.total) > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(
        `no audit record for ${criteria.action} on ${criteria.resourceType} ${criteria.resourceId ?? ''}`,
      );
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    app = await createTestApp();
    await truncateAll();
    tenant = await seedTenant('acadcfg', { students: 2 });
    otherTenant = await seedTenant('acadrival', { students: 1 });

    const client = testClient();
    await client.connect();
    try {
      // The seeded academic year is hard-coded to 2026. Widening it around *today* is what
      // lets the calendar cases exercise both a past and a future entry without the suite
      // quietly stopping to test anything the moment the calendar year turns over.
      await client.query(`update academic_years set start_date = $1, end_date = $2 where id = $3`, [
        yearStart,
        yearEnd,
        tenant.academicYearId,
      ]);

      const institutionId = uuidv7();
      await client.query(
        `insert into institutions (id, tenant_id, code, name_en, type, medium)
         values ($1,$2,'ACAD-OTHER','Other Institution','school','bangla')`,
        [institutionId, tenant.tenantId],
      );
      const campusId = uuidv7();
      await client.query(
        `insert into campuses (id, tenant_id, institution_id, code, name_en, is_primary)
         values ($1,$2,$3,'OTHER','Other Campus',true)`,
        [campusId, tenant.tenantId, institutionId],
      );
      const academicYearId = uuidv7();
      await client.query(
        `insert into academic_years (id, tenant_id, institution_id, name, start_date, end_date, status, is_current)
         values ($1,$2,$3,'2026',$4,$5,'active',true)`,
        [academicYearId, tenant.tenantId, institutionId, yearStart, yearEnd],
      );
      const classLevelId = uuidv7();
      await client.query(
        `insert into class_levels (id, tenant_id, institution_id, code, name_en, ordinal)
         values ($1,$2,$3,'C6','Class 6',7)`,
        [classLevelId, tenant.tenantId, institutionId],
      );
      const otherShiftId = uuidv7();
      await client.query(
        `insert into shifts (id, tenant_id, institution_id, campus_id, kind, name_en, start_time, end_time)
         values ($1,$2,$3,$4,'day','Other Shift','08:00','13:00')`,
        [otherShiftId, tenant.tenantId, institutionId, campusId],
      );
      other = { institutionId, campusId, academicYearId, classLevelId, shiftId: otherShiftId };
    } finally {
      await client.end();
    }

    for (const key of ['owner', 'principal', 'admin', 'teacher']) {
      tokens[key] = await login(tenant.users[key]!.email);
    }
    tokens['rivalPrincipal'] = await login(otherTenant.users['principal']!.email);
  });

  afterAll(async () => {
    await app?.close();
  });

  // ── Rooms ─────────────────────────────────────────────────────────────────────────

  describe('rooms', () => {
    it('creates a room with both names and records it in the audit log', async () => {
      const response = await post('principal', '/api/v1/academic/rooms', {
        campusId: tenant.campusId,
        code: 'R-204',
        nameEn: 'Science Lab',
        nameBn: 'বিজ্ঞান ল্যাব',
        kind: 'lab',
        capacity: 40,
        floor: '2',
        building: 'Main',
      });

      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.nameBn).toBe('বিজ্ঞান ল্যাব');
      expect(response.body.tenantId).toBe(tenant.tenantId);
      expect(response.body.institutionId).toBe(tenant.institutionId);
      roomId = response.body.id;

      await expectAuditRow({ resourceType: 'room', action: 'create', resourceId: roomId });
    });

    it('refuses a duplicate room code on the same campus', async () => {
      const response = await post('principal', '/api/v1/academic/rooms', {
        campusId: tenant.campusId,
        code: 'R-204',
        nameEn: 'Duplicate',
      });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('CONFLICT');
    });

    it('refuses a capacity of zero', async () => {
      const response = await post('principal', '/api/v1/academic/rooms', {
        campusId: tenant.campusId,
        code: 'R-000',
        nameEn: 'Broom Cupboard',
        capacity: 0,
      });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('refuses a campus belonging to another institution in the same tenant', async () => {
      const response = await post('principal', '/api/v1/academic/rooms', {
        campusId: other.campusId,
        code: 'R-999',
        nameEn: 'Borrowed Campus',
      });
      // 404, not 403: confirming the campus exists elsewhere is itself a leak.
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('lists rooms of the institution', async () => {
      const response = await get('principal', '/api/v1/academic/rooms');
      expect(response.status).toBe(200);
      expect(response.body.map((room: { code: string }) => room.code)).toContain('R-204');
    });

    it('updates a room', async () => {
      const response = await patch('principal', `/api/v1/academic/rooms/${roomId}`, {
        capacity: 45,
        floor: '3',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.capacity).toBe(45);
      // The internal audit hint must never reach the wire.
      expect(response.body.__audit).toBeUndefined();
    });

    it('archives a room with a reason and drops it from the default list', async () => {
      const archived = await post('principal', `/api/v1/academic/rooms/${roomId}/archive`, {
        reason: 'The building is being demolished this vacation',
      });
      expect(archived.status, JSON.stringify(archived.body)).toBe(201);
      expect(archived.body.archivedAt).toBeTruthy();
      expect(archived.body.archiveReason).toContain('demolished');

      const visible = await get('principal', '/api/v1/academic/rooms');
      expect(visible.body.map((room: { id: string }) => room.id)).not.toContain(roomId);

      const withArchived = await get('principal', '/api/v1/academic/rooms', {
        includeArchived: 'true',
      });
      expect(withArchived.body.map((room: { id: string }) => room.id)).toContain(roomId);

      await expectAuditRow({ resourceType: 'room', action: 'archive', resourceId: roomId });
    });

    it('refuses to archive without a reason', async () => {
      const created = await post('principal', '/api/v1/academic/rooms', {
        campusId: tenant.campusId,
        code: 'R-301',
        nameEn: 'Spare Room',
      });
      const response = await post(
        'principal',
        `/api/v1/academic/rooms/${created.body.id}/archive`,
        {},
      );
      expect(response.status).toBe(422);
    });

    it('refuses a room write to an administrator, who may only read the structure', async () => {
      const response = await post('admin', '/api/v1/academic/rooms', {
        campusId: tenant.campusId,
        code: 'R-500',
        nameEn: 'Unauthorised Room',
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
      // Naming the missing permission would be free reconnaissance.
      expect(JSON.stringify(response.body)).not.toContain('academic.rooms.manage');
    });
  });

  // ── Shifts ────────────────────────────────────────────────────────────────────────

  describe('shifts', () => {
    it('creates a shift', async () => {
      const response = await post('principal', '/api/v1/academic/shifts', {
        campusId: tenant.campusId,
        kind: 'morning',
        nameEn: 'Morning Shift',
        nameBn: 'প্রভাতী শাখা',
        startTime: '07:30',
        endTime: '12:00',
        sortOrder: 1,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.startTime).toBe('07:30:00');
      shiftId = response.body.id;
      await expectAuditRow({ resourceType: 'shift', action: 'create', resourceId: shiftId });
    });

    it('refuses a duplicate shift name in the institution', async () => {
      const response = await post('principal', '/api/v1/academic/shifts', {
        nameEn: 'Morning Shift',
        startTime: '13:00',
        endTime: '17:00',
      });
      expect(response.status).toBe(409);
    });

    it('refuses a shift that ends before it starts', async () => {
      const response = await post('principal', '/api/v1/academic/shifts', {
        nameEn: 'Impossible Shift',
        startTime: '15:00',
        endTime: '09:00',
      });
      expect(response.status).toBe(422);
    });

    it('updates a shift under an optimistic lock', async () => {
      const response = await patch('principal', `/api/v1/academic/shifts/${shiftId}`, {
        sortOrder: 3,
        version: 1,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.version).toBe(2);
    });

    it('refuses a stale version rather than losing the other edit', async () => {
      const response = await patch('principal', `/api/v1/academic/shifts/${shiftId}`, {
        sortOrder: 9,
        version: 1,
      });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('CONFLICT');
    });

    it('refuses a shift write to an administrator', async () => {
      const response = await post('admin', '/api/v1/academic/shifts', {
        nameEn: 'Unauthorised Shift',
        startTime: '07:00',
        endTime: '11:00',
      });
      expect(response.status).toBe(403);
    });
  });

  // ── Periods ───────────────────────────────────────────────────────────────────────

  describe('periods — replace as a set', () => {
    const validSchedule = [
      { nameEn: 'Assembly', sequence: 1, startTime: '07:30', endTime: '07:45', isBreak: true },
      { nameEn: '1st Period', sequence: 2, startTime: '07:45', endTime: '08:30' },
      { nameEn: '2nd Period', sequence: 3, startTime: '08:30', endTime: '09:15' },
    ];

    it('writes the whole bell schedule', async () => {
      const response = await put('principal', '/api/v1/academic/periods', {
        shiftId,
        periods: validSchedule,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).toHaveLength(3);
      expect(response.body.map((period: { sequence: number }) => period.sequence)).toEqual([
        1, 2, 3,
      ]);
      expect(response.body[0].isBreak).toBe(true);
      await expectAuditRow({ resourceType: 'period', action: 'update' });
    });

    it('refuses overlapping periods', async () => {
      const response = await put('principal', '/api/v1/academic/periods', {
        shiftId,
        periods: [
          { nameEn: '1st Period', sequence: 1, startTime: '07:45', endTime: '08:30' },
          { nameEn: '2nd Period', sequence: 2, startTime: '08:15', endTime: '09:00' },
        ],
      });
      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body)).toContain('before');
    });

    it('refuses a schedule whose numbers are not contiguous from 1', async () => {
      const response = await put('principal', '/api/v1/academic/periods', {
        shiftId,
        periods: [
          { nameEn: '1st Period', sequence: 1, startTime: '07:45', endTime: '08:30' },
          { nameEn: '2nd Period', sequence: 2, startTime: '08:30', endTime: '09:15' },
          { nameEn: '4th Period', sequence: 4, startTime: '09:15', endTime: '10:00' },
        ],
      });
      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body)).toContain('no gaps');
    });

    it('refuses a period that ends before it starts', async () => {
      const response = await put('principal', '/api/v1/academic/periods', {
        shiftId,
        periods: [{ nameEn: 'Backwards', sequence: 1, startTime: '09:00', endTime: '08:00' }],
      });
      expect(response.status).toBe(422);
    });

    it('refuses a period that falls outside its own shift window', async () => {
      const response = await put('principal', '/api/v1/academic/periods', {
        shiftId,
        periods: [{ nameEn: 'After Hours', sequence: 1, startTime: '16:00', endTime: '17:00' }],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(JSON.stringify(response.body)).toContain('outside');
    });

    it('renumbers surviving periods without tripping the unique index', async () => {
      const before = await get('principal', `/api/v1/academic/shifts/${shiftId}/periods`);
      expect(before.status).toBe(200);
      const [first, second, third] = before.body as Array<{ id: string; nameEn: string }>;

      // The first two swap places and the third is dropped. A naive single-pass renumber
      // collides on `periods_shift_sequence_key` halfway through this.
      const response = await put('principal', '/api/v1/academic/periods', {
        shiftId,
        periods: [
          {
            id: second!.id,
            nameEn: '1st Period',
            sequence: 1,
            startTime: '07:30',
            endTime: '08:15',
          },
          {
            id: first!.id,
            nameEn: 'Assembly',
            sequence: 2,
            startTime: '08:15',
            endTime: '08:30',
            isBreak: true,
          },
        ],
      });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).toHaveLength(2);
      expect(response.body[0].id).toBe(second!.id);
      expect(response.body[1].id).toBe(first!.id);
      expect(response.body.map((p: { id: string }) => p.id)).not.toContain(third!.id);
    });

    it('refuses a shift belonging to another institution', async () => {
      const response = await put('principal', '/api/v1/academic/periods', {
        shiftId: other.shiftId,
        periods: [{ nameEn: '1st Period', sequence: 1, startTime: '08:00', endTime: '08:45' }],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(404);
    });

    it('refuses a bell-schedule write to an administrator', async () => {
      const response = await put('admin', '/api/v1/academic/periods', {
        shiftId,
        periods: [{ nameEn: '1st Period', sequence: 1, startTime: '07:45', endTime: '08:30' }],
      });
      expect(response.status).toBe(403);
    });
  });

  // ── Academic calendar ─────────────────────────────────────────────────────────────

  describe('academic calendar', () => {
    it('adds a holiday', async () => {
      const response = await post('principal', '/api/v1/academic/calendar', {
        academicYearId: tenant.academicYearId,
        titleEn: 'Victory Day',
        titleBn: 'বিজয় দিবস',
        kind: 'holiday',
        startDate: future,
        endDate: future,
        isNonTeaching: true,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      futureEventId = response.body.id;
      await expectAuditRow({
        resourceType: 'calendar_event',
        action: 'create',
        resourceId: futureEventId,
      });
    });

    it('refuses a working day that lands on an existing holiday', async () => {
      const response = await post('principal', '/api/v1/academic/calendar', {
        academicYearId: tenant.academicYearId,
        titleEn: 'Make-up Class Day',
        kind: 'working_day',
        startDate: future,
        endDate: future,
        overridesWeekend: true,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body.error.message).toContain('Victory Day');
    });

    it('refuses an entry that falls outside its academic year', async () => {
      const response = await post('principal', '/api/v1/academic/calendar', {
        academicYearId: tenant.academicYearId,
        titleEn: 'Long After The Year Ends',
        kind: 'event',
        startDate: addDays(yearEnd, 10),
        endDate: addDays(yearEnd, 11),
      });
      expect(response.status, JSON.stringify(response.body)).toBe(422);
    });

    it('filters by date range, returning anything that overlaps it', async () => {
      const created = await post('principal', '/api/v1/academic/calendar', {
        academicYearId: tenant.academicYearId,
        titleEn: 'Winter Vacation',
        kind: 'vacation',
        startDate: past,
        endDate: addDays(past, 5),
        isNonTeaching: true,
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      pastEventId = created.body.id;

      const inRange = await get('principal', '/api/v1/academic/calendar', {
        from: addDays(past, 3),
        to: addDays(past, 4),
      });
      expect(inRange.status).toBe(200);
      expect(inRange.body.map((event: { id: string }) => event.id)).toContain(pastEventId);
      expect(inRange.body.map((event: { id: string }) => event.id)).not.toContain(futureEventId);
    });

    it('updates a calendar entry', async () => {
      const response = await patch('principal', `/api/v1/academic/calendar/${futureEventId}`, {
        titleEn: 'Victory Day (observed)',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.titleEn).toBe('Victory Day (observed)');
    });

    it('refuses to remove an entry that is not in the future', async () => {
      const response = await remove('principal', `/api/v1/academic/calendar/${pastEventId}`, {
        reason: 'Recorded by mistake during setup',
      });
      // Attendance percentages for that month already depend on it.
      expect(response.status, JSON.stringify(response.body)).toBe(409);
    });

    it('refuses to remove an entry without a reason', async () => {
      const response = await remove('principal', `/api/v1/academic/calendar/${futureEventId}`, {});
      expect(response.status).toBe(422);
    });

    it('removes a future entry, as an archive rather than a delete', async () => {
      const response = await remove('principal', `/api/v1/academic/calendar/${futureEventId}`, {
        reason: 'The ministry moved the observed date this year',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.archivedAt).toBeTruthy();

      // Archived, not deleted: the row is still there for anyone reading history.
      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query<{ total: string }>(
          'select count(*) as total from calendar_events where id = $1',
          [futureEventId],
        );
        expect(Number(rows[0]!.total)).toBe(1);
      } finally {
        await client.end();
      }

      await expectAuditRow({
        resourceType: 'calendar_event',
        action: 'archive',
        resourceId: futureEventId,
      });
    });

    it('refuses a calendar write to an administrator, who may only view it', async () => {
      expect((await get('admin', '/api/v1/academic/calendar')).status).toBe(200);

      const response = await post('admin', '/api/v1/academic/calendar', {
        academicYearId: tenant.academicYearId,
        titleEn: 'Unauthorised Holiday',
        kind: 'holiday',
        startDate: addDays(today, 60),
        endDate: addDays(today, 60),
      });
      expect(response.status).toBe(403);
    });
  });

  // ── Curriculum ────────────────────────────────────────────────────────────────────

  describe('curriculum — replace as a set', () => {
    beforeAll(async () => {
      for (const subject of [
        { code: '101', nameEn: 'Bangla 1st Paper' },
        { code: '109', nameEn: 'Mathematics' },
        { code: '154', nameEn: 'ICT' },
      ]) {
        const response = await post('principal', '/api/v1/academic/subjects', subject);
        expect(response.status, JSON.stringify(response.body)).toBe(201);
        subjectIds.push(response.body.id);
      }
    });

    it('writes the curriculum for a class level and year', async () => {
      const response = await put('principal', '/api/v1/academic/curriculum', {
        academicYearId: tenant.academicYearId,
        classLevelId: tenant.classLevelId,
        subjects: [
          {
            subjectId: subjectIds[0],
            periodsPerWeek: 6,
            fullMarks: 100,
            passMarks: 33,
            markDistribution: { theory: 70, mcq: 30 },
          },
          {
            subjectId: subjectIds[1],
            periodsPerWeek: 6,
            fullMarks: 100,
            passMarks: 33,
            markDistribution: { theory: 100 },
          },
        ],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).toHaveLength(2);
      await expectAuditRow({ resourceType: 'class_subject', action: 'update' });
    });

    it('refuses mark components that do not add up to full marks', async () => {
      const response = await put('principal', '/api/v1/academic/curriculum', {
        academicYearId: tenant.academicYearId,
        classLevelId: tenant.classLevelId,
        subjects: [
          {
            subjectId: subjectIds[0],
            fullMarks: 100,
            markDistribution: { theory: 70, mcq: 20 },
          },
        ],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(JSON.stringify(response.body)).toContain('add up to 90');
    });

    it('refuses the same subject twice for the same group', async () => {
      const response = await put('principal', '/api/v1/academic/curriculum', {
        academicYearId: tenant.academicYearId,
        classLevelId: tenant.classLevelId,
        subjects: [
          { subjectId: subjectIds[0], markDistribution: { theory: 100 } },
          { subjectId: subjectIds[0], markDistribution: { theory: 100 } },
        ],
      });
      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body)).toContain('listed twice');
    });

    it('refuses pass marks above full marks', async () => {
      const response = await put('principal', '/api/v1/academic/curriculum', {
        academicYearId: tenant.academicYearId,
        classLevelId: tenant.classLevelId,
        subjects: [{ subjectId: subjectIds[0], fullMarks: 50, passMarks: 60 }],
      });
      expect(response.status).toBe(422);
    });

    it('refuses a class level belonging to another institution', async () => {
      const response = await put('principal', '/api/v1/academic/curriculum', {
        academicYearId: tenant.academicYearId,
        classLevelId: other.classLevelId,
        subjects: [{ subjectId: subjectIds[0], markDistribution: { theory: 100 } }],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(404);
    });

    /**
     * The API is not the only writer a database ever has. Migration 0006 added the CHECK
     * constraint KI-009 deferred, so a direct INSERT is refused too — this asserts the
     * constraint exists and works, not the endpoint.
     */
    it('is enforced by the database as well as the API', async () => {
      const client = testClient();
      await client.connect();
      try {
        await expect(
          client.query(
            `insert into class_subjects
               (id, tenant_id, institution_id, academic_year_id, class_level_id, subject_id,
                full_marks, pass_marks, mark_distribution)
             values ($1,$2,$3,$4,$5,$6,100,33,'{"theory": 70, "mcq": 20}'::jsonb)`,
            [
              uuidv7(),
              tenant.tenantId,
              tenant.institutionId,
              tenant.academicYearId,
              tenant.classLevelId,
              subjectIds[2],
            ],
          ),
        ).rejects.toThrow(/mark_distribution_sums/);
      } finally {
        await client.end();
      }
    });

    it('lists the curriculum with subject names attached', async () => {
      const response = await get('principal', '/api/v1/academic/curriculum', {
        academicYearId: tenant.academicYearId,
        classLevelId: tenant.classLevelId,
      });
      expect(response.status).toBe(200);
      expect(response.body.map((row: { subjectNameEn: string }) => row.subjectNameEn)).toContain(
        'Mathematics',
      );
    });

    it('refuses a curriculum write to an administrator', async () => {
      const response = await put('admin', '/api/v1/academic/curriculum', {
        academicYearId: tenant.academicYearId,
        classLevelId: tenant.classLevelId,
        subjects: [{ subjectId: subjectIds[0], markDistribution: { theory: 100 } }],
      });
      expect(response.status).toBe(403);
    });
  });

  // ── Teacher assignments ───────────────────────────────────────────────────────────

  describe('teacher assignments', () => {
    beforeAll(async () => {
      const section = await post('principal', '/api/v1/academic/sections', {
        academicYearId: tenant.academicYearId,
        classLevelId: tenant.classLevelId,
        campusId: tenant.campusId,
        nameEn: 'B',
        capacity: 50,
      });
      expect(section.status, JSON.stringify(section.body)).toBe(201);
      sectionBId = section.body.id;
    });

    it('assigns a class teacher to a section', async () => {
      const response = await post('principal', '/api/v1/academic/assignments/sections', {
        academicYearId: tenant.academicYearId,
        sectionId: sectionBId,
        employeeId: tenant.employeeIds[4],
        role: 'class_teacher',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      sectionAssignmentId = response.body.id;
      await expectAuditRow({
        resourceType: 'employee_section_assignment',
        action: 'create',
        resourceId: sectionAssignmentId,
      });
    });

    it('allows only one class teacher per section per academic year', async () => {
      const response = await post('principal', '/api/v1/academic/assignments/sections', {
        academicYearId: tenant.academicYearId,
        sectionId: sectionBId,
        employeeId: tenant.employeeIds[3],
        role: 'class_teacher',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body.error.code).toBe('CONFLICT');

      // The database index is the real guarantee, not the read-then-write above. Prove it by
      // going around the API entirely.
      const client = testClient();
      await client.connect();
      try {
        await expect(
          client.query(
            `insert into employee_section_assignments
               (id, tenant_id, institution_id, academic_year_id, employee_id, section_id, role)
             values ($1,$2,$3,$4,$5,$6,'class_teacher')`,
            [
              uuidv7(),
              tenant.tenantId,
              tenant.institutionId,
              tenant.academicYearId,
              tenant.employeeIds[3],
              sectionBId,
            ],
          ),
        ).rejects.toThrow(/employee_section_primary_key/);
      } finally {
        await client.end();
      }
    });

    it('refuses an assistant role assigned twice to the same person and section', async () => {
      const first = await post('principal', '/api/v1/academic/assignments/sections', {
        academicYearId: tenant.academicYearId,
        sectionId: sectionBId,
        employeeId: tenant.employeeIds[3],
        role: 'assistant_class_teacher',
      });
      expect(first.status, JSON.stringify(first.body)).toBe(201);

      const second = await post('principal', '/api/v1/academic/assignments/sections', {
        academicYearId: tenant.academicYearId,
        sectionId: sectionBId,
        employeeId: tenant.employeeIds[3],
        role: 'assistant_class_teacher',
      });
      expect(second.status).toBe(409);
    });

    it('refuses a section that belongs to a different academic year', async () => {
      const response = await post('principal', '/api/v1/academic/assignments/sections', {
        academicYearId: other.academicYearId,
        sectionId: sectionBId,
        employeeId: tenant.employeeIds[4],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(422);
    });

    it('refuses an employee from another institution in the same tenant', async () => {
      const foreignEmployeeId = uuidv7();
      const client = testClient();
      await client.connect();
      try {
        await client.query(
          `insert into employees (id, tenant_id, institution_id, campus_id, employee_code, full_name_en, phone, joining_date)
           values ($1,$2,$3,$4,'OTHER-EMP-1','Other School Teacher','+8801799000001','2020-01-01')`,
          [foreignEmployeeId, tenant.tenantId, other.institutionId, other.campusId],
        );
      } finally {
        await client.end();
      }

      const response = await post('principal', '/api/v1/academic/assignments/sections', {
        academicYearId: tenant.academicYearId,
        sectionId: sectionBId,
        employeeId: foreignEmployeeId,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(404);
    });

    it('refuses a subject that is not in the class’s curriculum', async () => {
      const response = await post('principal', '/api/v1/academic/assignments/subjects', {
        academicYearId: tenant.academicYearId,
        sectionId: sectionBId,
        subjectId: subjectIds[2],
        employeeId: tenant.employeeIds[4],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(422);
    });

    it('assigns a subject teacher and links the curriculum row', async () => {
      const response = await post('principal', '/api/v1/academic/assignments/subjects', {
        academicYearId: tenant.academicYearId,
        sectionId: sectionBId,
        subjectId: subjectIds[1],
        employeeId: tenant.employeeIds[4],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.classSubjectId).toBeTruthy();
      expect(response.body.isPrimary).toBe(true);
      subjectAssignmentId = response.body.id;
    });

    it('allows only one primary teacher per section and subject', async () => {
      const response = await post('principal', '/api/v1/academic/assignments/subjects', {
        academicYearId: tenant.academicYearId,
        sectionId: sectionBId,
        subjectId: subjectIds[1],
        employeeId: tenant.employeeIds[3],
        isPrimary: true,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(409);

      const secondary = await post('principal', '/api/v1/academic/assignments/subjects', {
        academicYearId: tenant.academicYearId,
        sectionId: sectionBId,
        subjectId: subjectIds[1],
        employeeId: tenant.employeeIds[3],
        isPrimary: false,
      });
      expect(secondary.status, JSON.stringify(secondary.body)).toBe(201);
    });

    it('will not drop a curriculum subject a teacher is still assigned to', async () => {
      const response = await put('principal', '/api/v1/academic/curriculum', {
        academicYearId: tenant.academicYearId,
        classLevelId: tenant.classLevelId,
        subjects: [{ subjectId: subjectIds[0], markDistribution: { theory: 100 } }],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(409);
    });

    it('lists both kinds of assignment', async () => {
      const response = await get('principal', '/api/v1/academic/assignments', {
        academicYearId: tenant.academicYearId,
        sectionId: sectionBId,
      });
      expect(response.status).toBe(200);
      expect(response.body.sectionAssignments.map((row: { id: string }) => row.id)).toContain(
        sectionAssignmentId,
      );
      expect(response.body.subjectAssignments.map((row: { id: string }) => row.id)).toContain(
        subjectAssignmentId,
      );
    });

    it('requires a reason to unassign', async () => {
      const response = await post(
        'principal',
        `/api/v1/academic/assignments/subjects/${subjectAssignmentId}/unassign`,
        {},
      );
      expect(response.status).toBe(422);
    });

    it('unassigns with a recorded reason and an audit record', async () => {
      const response = await post(
        'principal',
        `/api/v1/academic/assignments/subjects/${subjectAssignmentId}/unassign`,
        { reason: 'The teacher has moved to the morning shift' },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.archivedAt).toBeTruthy();
      expect(response.body.archiveReason).toContain('morning shift');

      await expectAuditRow({
        resourceType: 'employee_subject_assignment',
        action: 'archive',
        resourceId: subjectAssignmentId,
      });

      const remaining = await get('principal', '/api/v1/academic/assignments', {
        sectionId: sectionBId,
      });
      expect(remaining.body.subjectAssignments.map((row: { id: string }) => row.id)).not.toContain(
        subjectAssignmentId,
      );
    });

    it('refuses an assignment write to an administrator', async () => {
      const response = await post('admin', '/api/v1/academic/assignments/sections', {
        academicYearId: tenant.academicYearId,
        sectionId: sectionBId,
        employeeId: tenant.employeeIds[4],
      });
      expect(response.status).toBe(403);
    });
  });

  // ── Tenant isolation ──────────────────────────────────────────────────────────────

  describe('tenant isolation', () => {
    it("refuses another tenant's principal who borrows this institution's header", async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/academic/rooms')
        .set('Authorization', `Bearer ${tokens['rivalPrincipal']}`)
        .set('x-institution-id', tenant.institutionId);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
      expect(JSON.stringify(response.body)).not.toContain('Science Lab');
    });

    it("returns nothing from another tenant's own institution scope", async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/academic/rooms')
        .set('Authorization', `Bearer ${tokens['rivalPrincipal']}`)
        .set('x-institution-id', otherTenant.institutionId);

      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
    });

    describe('row-level security, independent of the application', () => {
      let client: Client;

      beforeAll(async () => {
        // Connects as `shikkha_app` — the same unprivileged role the API uses — so this is
        // what an attacker with SQL execution inside the application could actually do.
        client = new Client({ connectionString: TEST_APP_DATABASE_URL });
        await client.connect();
      });

      afterAll(async () => {
        await client?.end();
      });

      it('returns zero rows with no tenant context — fails closed, not open', async () => {
        for (const table of [
          'rooms',
          'periods',
          'shifts',
          'calendar_events',
          'class_subjects',
          'employee_section_assignments',
          'employee_subject_assignments',
        ]) {
          const { rows } = await client.query<{ count: string }>(`select count(*) from ${table}`);
          expect(Number(rows[0]!.count), `${table} leaked without a tenant context`).toBe(0);
        }
      });

      it("cannot read this tenant's configuration from inside the other tenant", async () => {
        await client.query('begin');
        try {
          await client.query(`select set_config('app.tenant_id', $1, true)`, [
            otherTenant.tenantId,
          ]);
          const { rows } = await client.query<{ count: string }>(
            'select count(*) from rooms where institution_id = $1',
            [tenant.institutionId],
          );
          expect(Number(rows[0]!.count)).toBe(0);
        } finally {
          await client.query('rollback');
        }
      });

      it('every table this module writes has forced row-level security', async () => {
        const { rows } = await client.query<{ relname: string }>(
          `select c.relname
             from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public'
              and c.relkind = 'r'
              and c.relname = any($1::text[])
              and (not c.relrowsecurity or not c.relforcerowsecurity)`,
          [
            [
              'rooms',
              'periods',
              'shifts',
              'calendar_events',
              'class_subjects',
              'employee_section_assignments',
              'employee_subject_assignments',
            ],
          ],
        );
        expect(rows.map((row) => row.relname)).toEqual([]);
      });
    });
  });
});
