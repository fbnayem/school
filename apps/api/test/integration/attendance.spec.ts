/**
 * Attendance over HTTP (Phase 7).
 *
 * The register is the highest-volume academic record the product holds and the one whose
 * corruption is hardest to notice, so this suite asserts the *refusals* rather than the happy
 * path: a teacher marking a section they do not teach, a mark on a holiday, a mark for a
 * student who was not enrolled, a change to a submitted register with no reason, a guardian
 * seeing another family's child, and one tenant reading another's register by id.
 *
 * Dates are derived from `todayInDhaka()` rather than hard-coded, and the seeded academic year
 * is widened to match, so the suite does not start failing on a particular calendar day. It
 * does assume the seeded enrolment date (2026-01-05) is in the past, which is the same
 * assumption every other suite in this repository makes.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { addDays, dhakaWeekday, todayInDhaka, uuidv7, type CalendarDate } from '@shikkha/shared';
import {
  createTestApp,
  seedTenant,
  testClient,
  truncateAll,
  TEST_PASSWORD,
  type SeededTenant,
} from '../helpers/test-app';

/**
 * The most recent `count` days on which the school is open, oldest first.
 *
 * Walking back from yesterday rather than from today keeps every date strictly in the past,
 * which is what the "no attendance in the future" rule requires.
 */
function recentSchoolDays(count: number): string[] {
  const out: string[] = [];
  let cursor: CalendarDate = addDays(todayInDhaka(), -1);
  while (out.length < count) {
    const weekday = dhakaWeekday(cursor);
    // The seeded academic year uses the default Bangladeshi weekend, Friday and Saturday.
    if (weekday !== 5 && weekday !== 6) out.push(cursor);
    cursor = addDays(cursor, -1);
  }
  return out.reverse();
}

function mostRecentFriday(): string {
  let cursor: CalendarDate = addDays(todayInDhaka(), -1);
  while (dhakaWeekday(cursor) !== 5) cursor = addDays(cursor, -1);
  return cursor;
}

describe('Attendance', () => {
  let app: INestApplication;
  let tenant: SeededTenant;
  let other: SeededTenant;
  const tokens: Record<string, string> = {};
  let otherAdminToken: string;

  /** Six consecutive *school* days, oldest first. Registers are opened for all of them. */
  let days: string[];
  let holidayDay: string;
  let weekendDay: string;

  /** A second section, with no teacher assigned to it, and a student enrolled only there. */
  let unassignedSectionId: string;
  let outsiderStudentId: string;

  /** Session ids keyed by date, filled in as the registers are opened. */
  const sessionIds: Record<string, string> = {};

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

  beforeAll(async () => {
    app = await createTestApp();
    await truncateAll();
    tenant = await seedTenant('attend', { students: 3 });
    other = await seedTenant('attendother', { students: 2 });

    const schoolDays = recentSchoolDays(8);
    holidayDay = schoolDays[0]!;
    days = schoolDays.slice(2);
    weekendDay = mostRecentFriday();

    const client = testClient();
    await client.connect();
    try {
      // Widen the seeded academic year around today so the range checks under test are the
      // ones about holidays and the future, not "outside the academic year".
      for (const seeded of [tenant, other]) {
        await client.query(
          `update academic_years set start_date = $1, end_date = $2 where id = $3`,
          [addDays(todayInDhaka(), -400), addDays(todayInDhaka(), 400), seeded.academicYearId],
        );
      }

      // A second section in the same institution that the seeded teacher is NOT assigned to.
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

      outsiderStudentId = uuidv7();
      await client.query(
        `insert into students (id, tenant_id, institution_id, student_code, admission_number, admission_date, full_name_en, date_of_birth, gender, status)
         values ($1,$2,$3,'attend-OUT','attend-OUTA','2026-01-05','attend Outsider','2014-05-10','male','active')`,
        [outsiderStudentId, tenant.tenantId, tenant.institutionId],
      );
      await client.query(
        `insert into enrollments (id, tenant_id, institution_id, campus_id, student_id, academic_year_id, class_level_id, section_id, roll_number, status, enrolled_on)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'1','active','2026-01-05')`,
        [
          uuidv7(),
          tenant.tenantId,
          tenant.institutionId,
          tenant.campusId,
          outsiderStudentId,
          tenant.academicYearId,
          tenant.classLevelId,
          unassignedSectionId,
        ],
      );

      // A declared school closure. The register for this day must be refused.
      await client.query(
        `insert into calendar_events (id, tenant_id, institution_id, academic_year_id, title_en, kind, start_date, end_date, is_non_teaching)
         values ($1,$2,$3,$4,'Shaheed Dibosh','holiday',$5,$5,true)`,
        [uuidv7(), tenant.tenantId, tenant.institutionId, tenant.academicYearId, holidayDay],
      );
    } finally {
      await client.end();
    }

    for (const key of ['owner', 'principal', 'admin', 'accountant', 'teacher', 'guardian1']) {
      tokens[key] = await login(tenant.users[key]!.email);
    }
    otherAdminToken = await login(other.users['admin']!.email);
  });

  afterAll(async () => {
    await app?.close();
  });

  // ── Opening a register ──────────────────────────────────────────────────────────────

  describe('opening a register', () => {
    it('lets the class teacher open one for their own section', async () => {
      for (const day of days) {
        const response = await post('teacher', '/api/v1/attendance/sessions', {
          sectionId: tenant.sectionId,
          attendanceDate: day,
        });
        expect(response.status, JSON.stringify(response.body)).toBe(201);
        expect(response.body.status).toBe('open');
        expect(response.body.attendanceDate).toBe(day);
        sessionIds[day] = response.body.id as string;
      }
      expect(Object.keys(sessionIds)).toHaveLength(days.length);
    });

    it('is idempotent — a second tap returns the same register, not a duplicate', async () => {
      const response = await post('teacher', '/api/v1/attendance/sessions', {
        sectionId: tenant.sectionId,
        attendanceDate: days[0],
      });
      expect(response.status).toBe(201);
      expect(response.body.id).toBe(sessionIds[days[0]!]);
    });

    it('refuses a section the teacher is not assigned to, with 404 rather than 403', async () => {
      const response = await post('teacher', '/api/v1/attendance/sessions', {
        sectionId: unassignedSectionId,
        attendanceDate: days[0],
      });
      // 404: confirming the section exists is itself a small leak, and a teacher probing
      // section ids must not learn which of them are real.
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('refuses a date in the future', async () => {
      const response = await post('teacher', '/api/v1/attendance/sessions', {
        sectionId: tenant.sectionId,
        attendanceDate: addDays(todayInDhaka(), 3),
      });
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(response.body)).toMatch(/future/i);
    });

    it('refuses a day the academic calendar marks as non-teaching', async () => {
      const response = await post('teacher', '/api/v1/attendance/sessions', {
        sectionId: tenant.sectionId,
        attendanceDate: holidayDay,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(response.body)).toContain('Shaheed Dibosh');
    });

    it('refuses a day the institution has configured as its weekend', async () => {
      const response = await post('teacher', '/api/v1/attendance/sessions', {
        sectionId: tenant.sectionId,
        attendanceDate: weekendDay,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('is refused to a role without attendance.mark', async () => {
      // The administrator can read every register in the school and take none of them.
      const response = await post('admin', '/api/v1/attendance/sessions', {
        sectionId: tenant.sectionId,
        attendanceDate: days[0],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
      // Naming the permission would tell an attacker exactly what to go looking for.
      expect(JSON.stringify(response.body)).not.toContain('attendance.mark');
    });

    it('is refused to a guardian', async () => {
      const response = await post('guardian1', '/api/v1/attendance/sessions', {
        sectionId: tenant.sectionId,
        attendanceDate: days[0],
      });
      expect(response.status).toBe(403);
    });
  });

  // ── Marking ─────────────────────────────────────────────────────────────────────────

  describe('recording marks', () => {
    it('returns a roster of everyone enrolled in the section on that date', async () => {
      const response = await get(
        'teacher',
        `/api/v1/attendance/sessions/${sessionIds[days[0]!]}/roster`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.roster).toHaveLength(3);
      // The student enrolled only in the unassigned section must not appear.
      const ids = response.body.roster.map((row: { studentId: string }) => row.studentId);
      expect(ids).not.toContain(outsiderStudentId);
      expect(response.body.roster[0].status).toBeNull();
    });

    it('refuses a student who was not enrolled in that section on that date', async () => {
      const response = await post(
        'teacher',
        `/api/v1/attendance/sessions/${sessionIds[days[0]!]}/marks`,
        {
          version: 1,
          marks: [{ studentId: outsiderStudentId, status: 'present' }],
        },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(response.body)).toMatch(/not enrolled/i);
    });

    it('writes the whole register in one call', async () => {
      // student 1: present, present, absent, late, half day, present  → 4.5 of 6 → 75.00%
      // student 2: absent every day                                   → a run of 6
      // student 3: present every day
      const patternForStudent1 = ['present', 'present', 'absent', 'late', 'half_day', 'present'];

      for (const [index, day] of days.entries()) {
        const status = patternForStudent1[index]!;
        const response = await post(
          'teacher',
          `/api/v1/attendance/sessions/${sessionIds[day]!}/marks`,
          {
            version: 1,
            marks: [
              {
                studentId: tenant.studentIds[0],
                status,
                ...(status === 'late' ? { minutesLate: 12 } : {}),
              },
              { studentId: tenant.studentIds[1], status: 'absent' },
              { studentId: tenant.studentIds[2], status: 'present' },
            ],
          },
        );
        expect(response.status, JSON.stringify(response.body)).toBe(201);
        expect(response.body.session.status).toBe('submitted');
        expect(response.body.markedCount).toBe(3);
      }
    });

    it('refuses a second submission of a register that is already submitted', async () => {
      const response = await post(
        'teacher',
        `/api/v1/attendance/sessions/${sessionIds[days[0]!]}/marks`,
        {
          version: 2,
          marks: [{ studentId: tenant.studentIds[0], status: 'absent' }],
        },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body.error.code).toBe('CONFLICT');
      expect(JSON.stringify(response.body)).toMatch(/correction/i);
    });

    it('shows the recorded marks on the roster', async () => {
      const response = await get(
        'teacher',
        `/api/v1/attendance/sessions/${sessionIds[days[3]!]}/roster`,
      );
      expect(response.status).toBe(200);
      const first = response.body.roster.find(
        (row: { studentId: string }) => row.studentId === tenant.studentIds[0],
      );
      expect(first.status).toBe('late');
      expect(first.minutesLate).toBe(12);
    });
  });

  // ── Corrections ─────────────────────────────────────────────────────────────────────

  describe('corrections', () => {
    let markId: string;
    let correctionId: string;
    let correctionVersion: number;

    beforeAll(async () => {
      const roster = await get(
        'teacher',
        `/api/v1/attendance/sessions/${sessionIds[days[5]!]}/roster`,
      );
      markId = roster.body.roster.find(
        (row: { studentId: string }) => row.studentId === tenant.studentIds[0],
      ).markId;
      expect(markId).toBeTruthy();
    });

    it('refuses a correction with no reason', async () => {
      const response = await post('teacher', `/api/v1/attendance/marks/${markId}/corrections`, {
        status: 'absent',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('refuses a correction from a role without attendance.correct', async () => {
      const response = await post('accountant', `/api/v1/attendance/marks/${markId}/corrections`, {
        status: 'absent',
        reason: 'The student was in the sick room all morning.',
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('records a pending correction without touching the mark', async () => {
      const response = await post('teacher', `/api/v1/attendance/marks/${markId}/corrections`, {
        status: 'absent',
        reason: 'The student left after assembly and was marked in error.',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.applied).toBe(false);
      expect(response.body.correction.status).toBe('pending');
      expect(response.body.correction.previousStatus).toBe('present');
      expect(response.body.correction.newStatus).toBe('absent');
      correctionId = response.body.correction.id as string;
      correctionVersion = response.body.correction.version as number;

      // The register still says what it said. A request is not a change.
      const roster = await get(
        'teacher',
        `/api/v1/attendance/sessions/${sessionIds[days[5]!]}/roster`,
      );
      const mark = roster.body.roster.find(
        (row: { studentId: string }) => row.studentId === tenant.studentIds[0],
      );
      expect(mark.status).toBe('present');
    });

    it('refuses a second pending correction for the same mark', async () => {
      const response = await post('teacher', `/api/v1/attendance/marks/${markId}/corrections`, {
        status: 'excused',
        reason: 'Another request for exactly the same mark.',
      });
      expect(response.status).toBe(409);
    });

    it('refuses the decision to a role without attendance.correct.approve', async () => {
      const response = await post(
        'teacher',
        `/api/v1/attendance/corrections/${correctionId}/approve`,
        { reason: 'Approving my own request, which should not be possible.', version: 1 },
      );
      expect(response.status).toBe(403);
    });

    it('applies the mark, the correction and the audit record together on approval', async () => {
      const response = await post(
        'principal',
        `/api/v1/attendance/corrections/${correctionId}/approve`,
        {
          reason: 'Confirmed with the class teacher and the gate register.',
          version: correctionVersion,
        },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.correction.status).toBe('approved');
      expect(response.body.mark.status).toBe('absent');

      const roster = await get(
        'teacher',
        `/api/v1/attendance/sessions/${sessionIds[days[5]!]}/roster`,
      );
      const mark = roster.body.roster.find(
        (row: { studentId: string }) => row.studentId === tenant.studentIds[0],
      );
      expect(mark.status).toBe('absent');
      expect(mark.lastCorrectedAt).toBeTruthy();

      // The audit row is written inside the same transaction as the mark change, so its
      // absence would mean an academic record changed with no surviving explanation.
      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query<{ reason: string; previous_value: unknown }>(
          `select reason, previous_value, new_value
             from audit_logs
            where module = 'attendance'
              and resource_type = 'student_attendance'
              and resource_id = $1`,
          [markId],
        );
        expect(rows.length, 'no audit record for the applied correction').toBeGreaterThan(0);
        expect(rows[0]!.reason).toContain('left after assembly');
      } finally {
        await client.end();
      }
    });

    it('refuses to decide a correction that has already been decided', async () => {
      const response = await post(
        'principal',
        `/api/v1/attendance/corrections/${correctionId}/reject`,
        { reason: 'Trying to decide the same correction twice.', version: 100 },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(409);
    });

    it('applies immediately when the requester holds approval authority', async () => {
      const roster = await get(
        'teacher',
        `/api/v1/attendance/sessions/${sessionIds[days[4]!]}/roster`,
      );
      const ownerMarkId = roster.body.roster.find(
        (row: { studentId: string }) => row.studentId === tenant.studentIds[2],
      ).markId;

      // The owner may both request and approve, so a second round trip would only be theatre.
      const response = await post('owner', `/api/v1/attendance/marks/${ownerMarkId}/corrections`, {
        status: 'excused',
        reason: 'Medical certificate produced the following morning.',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.applied).toBe(true);
      expect(response.body.correction.status).toBe('approved');
      expect(response.body.mark.status).toBe('excused');
    });

    it('lists corrections for a supervisor', async () => {
      const response = await get('principal', '/api/v1/attendance/corrections');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.meta.total).toBeGreaterThanOrEqual(2);
    });
  });

  // ── Locking ─────────────────────────────────────────────────────────────────────────

  describe('locking a register', () => {
    it('closes it and refuses further corrections', async () => {
      const sessionId = sessionIds[days[0]!]!;
      const locked = await post('principal', `/api/v1/attendance/sessions/${sessionId}/lock`, {
        reason: 'The March reporting period is closed.',
        version: 2,
      });
      expect(locked.status, JSON.stringify(locked.body)).toBe(201);
      expect(locked.body.session.status).toBe('locked');

      const roster = await get('teacher', `/api/v1/attendance/sessions/${sessionId}/roster`);
      const markId = roster.body.roster[0].markId as string;

      const correction = await post('teacher', `/api/v1/attendance/marks/${markId}/corrections`, {
        status: 'excused',
        reason: 'Too late — the register has already been locked.',
      });
      expect(correction.status, JSON.stringify(correction.body)).toBe(409);
      expect(correction.body.error.code).toBe('IMMUTABLE_RECORD');
    });
  });

  // ── Reports ─────────────────────────────────────────────────────────────────────────

  describe('reports', () => {
    const range = () => ({ from: days[0]!, to: days[days.length - 1]! });

    it('computes per-student totals and percentage in SQL', async () => {
      const response = await get('principal', '/api/v1/attendance/reports/student-summary').query({
        ...range(),
        studentId: tenant.studentIds[2],
      });

      expect(response.status, JSON.stringify(response.body)).toBe(200);

      const row = response.body.data[0];
      expect(row.studentId).toBe(tenant.studentIds[2]);
      expect(row.totalSessions).toBe(6);
      // Five days present, one excused after the owner's correction. `excused` is authorised
      // but absent, so it does not count towards the percentage.
      expect(row.present).toBe(5);
      expect(row.excused).toBe(1);
      expect(row.attendancePercentage).toBe('83.33');
      expect(row.attendanceBasisPoints).toBe(8333);
    });

    it('counts a half day as half and a late arrival as attended', async () => {
      const response = await get('principal', '/api/v1/attendance/reports/student-summary').query({
        ...range(),
        studentId: tenant.studentIds[0],
      });

      expect(response.status).toBe(200);

      const row = response.body.data[0];
      // present, present, absent, late, half_day, present — then the approved correction turned
      // the last `present` into `absent`. Attended = 2 present + 1 late + 0.5 half = 3.5 of 6.
      expect(row.totalSessions).toBe(6);
      expect(row.present).toBe(2);
      expect(row.late).toBe(1);
      expect(row.halfDay).toBe(1);
      expect(row.absent).toBe(2);
      expect(row.attendancePercentage).toBe('58.33');
    });

    it('gives a section-by-day summary to a reports reader', async () => {
      const response = await get('principal', '/api/v1/attendance/reports/section-daily').query(
        range(),
      );

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).toHaveLength(6);
      for (const row of response.body) {
        expect(row.marked).toBe(3);
        expect(row.present + row.absent + row.late + row.excused + row.halfDay).toBe(3);
      }
    });

    it('finds runs of consecutive absences across the weekend', async () => {
      // The six register days span at least one Friday–Saturday weekend, so a run that counted
      // calendar days rather than school days would break here and report 3 + 3, not 6.
      const spansWeekend = (() => {
        const first = new Date(`${days[0]!}T00:00:00Z`).getTime();
        const last = new Date(`${days[days.length - 1]!}T00:00:00Z`).getTime();
        return (last - first) / 86_400_000 > days.length - 1;
      })();
      expect(spansWeekend, 'the chosen register days do not straddle a weekend').toBe(true);

      const response = await get(
        'principal',
        '/api/v1/attendance/reports/consecutive-absences',
      ).query({ ...range(), minDays: 3 });

      expect(response.status, JSON.stringify(response.body)).toBe(200);

      const run = response.body.find(
        (row: { studentId: string }) => row.studentId === tenant.studentIds[1],
      );
      expect(run, 'the student absent every day was not reported').toBeTruthy();
      expect(run.consecutiveDays).toBe(6);
      expect(run.startedOn).toBe(days[0]);
      expect(run.endedOn).toBe(days[days.length - 1]);
    });

    it('is refused to a role without attendance.reports.view', async () => {
      const response = await get(
        'accountant',
        '/api/v1/attendance/reports/consecutive-absences',
      ).query({ ...range() });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });
  });

  // ── Data scope ──────────────────────────────────────────────────────────────────────

  describe('data scope', () => {
    it('shows a guardian only their own children', async () => {
      const response = await get('guardian1', '/api/v1/attendance/reports/student-summary').query({
        from: days[0]!,
        to: days[days.length - 1]!,
      });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.meta.total).toBe(1);
      expect(response.body.data[0].studentId).toBe(tenant.studentIds[0]);
    });

    it('does not let a guardian read another family’s child by id', async () => {
      const response = await get('guardian1', '/api/v1/attendance/reports/student-summary').query({
        from: days[0]!,
        to: days[days.length - 1]!,
        studentId: tenant.studentIds[1],
      });

      expect(response.status).toBe(200);
      // An empty page rather than someone else's figures.
      expect(response.body.meta.total).toBe(0);
      expect(response.body.data).toEqual([]);
    });

    it('does not let a guardian open a register list', async () => {
      const response = await get('guardian1', '/api/v1/attendance/sessions');
      expect(response.status).toBe(200);
      // The `own` scope names children, not sections; a register is the whole class.
      expect(response.body.meta.total).toBe(0);
    });

    it('shows a teacher only the sections they are assigned to', async () => {
      const response = await get('teacher', '/api/v1/attendance/sessions');
      expect(response.status).toBe(200);
      expect(response.body.meta.total).toBe(6);
      for (const row of response.body.data) {
        expect(row.sectionId).toBe(tenant.sectionId);
      }
    });
  });

  // ── Employee attendance ─────────────────────────────────────────────────────────────

  describe('employee attendance', () => {
    it('records a check-in and a check-out', async () => {
      const employeeId = tenant.employeeIds[0]!;

      const checkIn = await post('owner', '/api/v1/attendance/employees/check-in', {
        employeeId,
        attendanceDate: days[days.length - 1],
      });
      expect(checkIn.status, JSON.stringify(checkIn.body)).toBe(201);
      expect(checkIn.body.checkInAt).toBeTruthy();
      expect(checkIn.body.status).toBe('present');

      const duplicate = await post('owner', '/api/v1/attendance/employees/check-in', {
        employeeId,
        attendanceDate: days[days.length - 1],
      });
      expect(duplicate.status).toBe(409);

      const checkOut = await post('owner', '/api/v1/attendance/employees/check-out', {
        employeeId,
        attendanceDate: days[days.length - 1],
      });
      expect(checkOut.status, JSON.stringify(checkOut.body)).toBe(201);
      expect(checkOut.body.checkOutAt).toBeTruthy();
      expect(checkOut.body.workedMinutes).toBeGreaterThanOrEqual(0);
    });

    it('is refused to a class teacher', async () => {
      // Marking thirty students must not imply the authority to mark a colleague.
      const response = await post('teacher', '/api/v1/attendance/employees/check-in', {
        employeeId: tenant.employeeIds[0],
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('is refused a check-out with no check-in', async () => {
      const response = await post('owner', '/api/v1/attendance/employees/check-out', {
        employeeId: tenant.employeeIds[1],
        attendanceDate: days[0],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(422);
    });
  });

  // ── Tenant isolation ────────────────────────────────────────────────────────────────

  describe('tenant isolation', () => {
    const otherGet = (path: string) =>
      request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${otherAdminToken}`)
        .set('x-institution-id', other.institutionId);

    it('does not let another tenant read a register by its exact id', async () => {
      const response = await otherGet(`/api/v1/attendance/sessions/${sessionIds[days[0]!]}/roster`);
      // 404 rather than 403: confirming the register exists elsewhere is itself a leak.
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain('attend Student');
    });

    it('does not let another tenant reach a mark by id', async () => {
      const roster = await get(
        'teacher',
        `/api/v1/attendance/sessions/${sessionIds[days[2]!]}/roster`,
      );
      const markId = roster.body.roster[0].markId as string;

      const response = await request(app.getHttpServer())
        .post(`/api/v1/attendance/marks/${markId}/corrections`)
        .set('Authorization', `Bearer ${otherAdminToken}`)
        .set('x-institution-id', other.institutionId)
        .send({ status: 'absent', reason: 'Reaching across the tenant boundary on purpose.' });

      expect([403, 404]).toContain(response.status);
    });

    it('returns no rows from another tenant in a summary', async () => {
      const response = await otherGet('/api/v1/attendance/reports/student-summary').query({
        from: days[0]!,
        to: days[days.length - 1]!,
      });

      expect(response.status).toBe(200);
      expect(response.body.meta.total).toBe(0);
      expect(response.body.data).toEqual([]);
    });

    it('refuses a borrowed x-institution-id header', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/attendance/sessions')
        .set('Authorization', `Bearer ${otherAdminToken}`)
        .set('x-institution-id', tenant.institutionId);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('enforces forced row-level security on every attendance table', async () => {
      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query<{ relname: string }>(
          `select c.relname
             from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r'
              and c.relname in ('attendance_sessions','student_attendance','attendance_corrections','employee_attendance')
              and (not c.relrowsecurity or not c.relforcerowsecurity)`,
        );
        expect(rows.map((row) => row.relname)).toEqual([]);
      } finally {
        await client.end();
      }
    });
  });
});
