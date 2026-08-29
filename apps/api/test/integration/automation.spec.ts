/**
 * Automation engine integration suite (Phase 26).
 *
 * The file is built around the refusals and the suppressions, because those are the module:
 *
 *  - **A rule never autonomously performs a sensitive action.** A rule pointed at `exam_mark`
 *    is refused unless it requires human confirmation, and when it runs it produces a
 *    SUGGESTION and changes nothing. The refusal is proved twice: through the API, and
 *    through a raw `pg` client connected as `shikkha_app` — the same unprivileged role the
 *    API uses — so `automation_rules_sensitive_needs_human` is shown to be a property of the
 *    database rather than of this service.
 *  - **Conditions are allow-listed.** An injected field (`event.x'; drop table students; --`),
 *    a prototype probe (`event.__proto__`), an unknown fact and an unknown operator are all
 *    422 before anything runs.
 *  - **Execution is idempotent.** The same `dedupeKey` writes no second event; re-running an
 *    event a rule already handled is `suppressed_duplicate`; a second absence for the same
 *    student inside the cooldown window is `suppressed_cooldown`. All three are recorded.
 *  - **`automation_events` is append-only.** UPDATE and DELETE from the application role are
 *    refused by Postgres itself, not by application code.
 *  - **A failing rule does not block the others.** Two rules on one event: the first cannot
 *    find its workflow definition and is recorded `failed`; the second still acts.
 *  - Tenant isolation (a cross-tenant read is a 404) and permission denial.
 *
 * Everything runs through the real guards, interceptors and database.
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

describe('Automation engine', () => {
  let app: INestApplication;
  let tenant: SeededTenant;
  let other: SeededTenant;
  const tokens: Record<string, string> = {};
  let otherOwnerToken: string;

  /** The absence rule, carried across the CRUD, versioning and execution tests. */
  let absenceRuleV1Id: string;
  let absenceRuleV2Id: string;
  let firstAbsenceEventId: string;

  /** The sensitive (exam mark) rule and the suggestion it raises. */
  let sensitiveRuleId: string;
  let sensitiveSuggestionId: string;

  const ABSENT_STUDENT_INDEX = 0;

  async function login(email: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: email, password: TEST_PASSWORD });
    expect(response.status, `login failed for ${email}: ${JSON.stringify(response.body)}`).toBe(
      200,
    );
    return response.body.accessToken as string;
  }

  const get = (role: string, path: string, query: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .get(path)
      .query(query)
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

  /**
   * Run a callback as the unprivileged application role inside one transaction with the
   * tenant GUC set — exactly the credentials a compromised application would hold. Rolled
   * back afterwards, so a refused write cannot leak into a later test.
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
      const pgError = error as { message: string; constraint?: string; code?: string };
      return { message: pgError.message, constraint: pgError.constraint, code: pgError.code };
    }
    throw new Error('The database accepted a write it should have refused');
  }

  /** Count rows the migrator can see for this tenant — used to prove "nothing changed". */
  async function countRows(table: string): Promise<number> {
    const client = testClient();
    await client.connect();
    try {
      const { rows } = await client.query<{ total: string }>(
        `select count(*)::text as total from public."${table}" where tenant_id = $1`,
        [tenant.tenantId],
      );
      return Number(rows[0]?.total ?? '0');
    } finally {
      await client.end();
    }
  }

  /**
   * Three consecutive absent registers for one student, so
   * `fact.student_consecutive_absences` has something real to count. Dates are in the past:
   * `attendance_sessions_not_future` refuses anything later than tomorrow.
   */
  async function seedConsecutiveAbsences(): Promise<void> {
    const client = testClient();
    await client.connect();
    try {
      await client.query('begin');
      const today = todayInDhaka();
      for (let back = 3; back >= 1; back -= 1) {
        const sessionId = uuidv7();
        await client.query(
          `insert into attendance_sessions
             (id, tenant_id, institution_id, campus_id, academic_year_id, section_id,
              attendance_date, status, submitted_at)
           values ($1,$2,$3,$4,$5,$6,$7,'submitted', now())`,
          [
            sessionId,
            tenant.tenantId,
            tenant.institutionId,
            tenant.campusId,
            tenant.academicYearId,
            tenant.sectionId,
            addDays(today, -back),
          ],
        );
        await client.query(
          `insert into student_attendance
             (id, tenant_id, institution_id, session_id, student_id, status)
           values ($1,$2,$3,$4,$5,'absent')`,
          [
            uuidv7(),
            tenant.tenantId,
            tenant.institutionId,
            sessionId,
            tenant.studentIds[ABSENT_STUDENT_INDEX],
          ],
        );
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }

  const absenceRuleBody = (name: string) => ({
    key: 'atm_absence_streak',
    name,
    nameBn: 'পরপর অনুপস্থিতি',
    description: 'Message the guardians when a student misses three registers in a row.',
    triggerKind: 'threshold',
    eventName: 'attendance.student_absent',
    conditions: {
      match: 'all',
      clauses: [{ field: 'fact.student_consecutive_absences', op: 'gte', value: 3 }],
    },
    action: {
      kind: 'notify',
      recipients: 'guardians_of_subject_student',
      subject: 'Attendance alert',
      messageEn:
        '{{studentName}} has been absent for {{student_consecutive_absences}} consecutive ' +
        'registers, most recently on {{date}}. Please contact the class teacher.',
    },
    requiresHumanConfirmation: false,
    cooldownMinutes: 60,
  });

  beforeAll(async () => {
    app = await createTestApp();
    await truncateAll();
    tenant = await seedTenant('atma');
    other = await seedTenant('atmb');

    tokens.owner = await login(tenant.users['owner']!.email);
    tokens.principal = await login(tenant.users['principal']!.email);
    tokens.teacher = await login(tenant.users['teacher']!.email);
    otherOwnerToken = await login(other.users['owner']!.email);

    await seedConsecutiveAbsences();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // Discovery and rule CRUD
  // ─────────────────────────────────────────────────────────────────────────────────

  it('publishes the vocabulary a rule may reference', async () => {
    const response = await get('owner', '/api/v1/automation/catalog');
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const eventNames = (response.body.events as { name: string }[]).map((event) => event.name);
    expect(eventNames).toContain('attendance.student_absent');
    expect(eventNames).toContain('exams.mark_recorded');

    const factNames = (response.body.facts as { name: string }[]).map((fact) => fact.name);
    expect(factNames).toContain('student_consecutive_absences');

    // The list a rule author must not be able to touch autonomously.
    expect(response.body.sensitiveTargets).toContain('exam_mark');
    expect(response.body.sensitiveTargets).toContain('payment');
  });

  it('creates a rule INACTIVE, at version 1', async () => {
    const response = await post(
      'owner',
      '/api/v1/automation/rules',
      absenceRuleBody('Three consecutive absences notify the guardian'),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.isActive).toBe(false);
    expect(response.body.version).toBe(1);
    expect(response.body.actionKind).toBe('notify');
    // `kind` is not stored twice: the column is the discriminator, the config is the rest.
    expect(response.body.actionConfig.kind).toBeUndefined();
    expect(response.body.actionConfig.recipients).toBe('guardians_of_subject_student');
    absenceRuleV1Id = response.body.id as string;
  });

  it('refuses a second rule with the same key', async () => {
    const response = await post(
      'owner',
      '/api/v1/automation/rules',
      absenceRuleBody('A duplicate key'),
    );
    expect(response.status).toBe(409);
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // Permissions
  // ─────────────────────────────────────────────────────────────────────────────────

  it('refuses rule management to a principal who may only view rules', async () => {
    const create = await post(
      'principal',
      '/api/v1/automation/rules',
      absenceRuleBody('Written by someone without automation.rules.manage'),
    );
    expect(create.status).toBe(403);

    // The same person may read them — the two permissions are genuinely different.
    const list = await get('principal', '/api/v1/automation/rules');
    expect(list.status).toBe(200);
  });

  it('refuses everything to a teacher, who holds no automation permission at all', async () => {
    expect((await get('teacher', '/api/v1/automation/rules')).status).toBe(403);
    expect((await get('teacher', '/api/v1/automation/executions')).status).toBe(403);
    expect((await post('teacher', '/api/v1/automation/events/process', {})).status).toBe(403);
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // The allow-listed evaluator
  // ─────────────────────────────────────────────────────────────────────────────────

  it('refuses an injected condition field before anything runs', async () => {
    const attempts = [
      "event.studentId'; drop table students; --",
      'event.__proto__',
      'event.payload.nested.value',
      'fact.student_consecutive_absences OR 1=1',
      '(select 1)',
    ];

    for (const field of attempts) {
      const response = await post('owner', '/api/v1/automation/rules', {
        ...absenceRuleBody('Injection attempt'),
        key: 'atm_injection_attempt',
        conditions: { match: 'all', clauses: [{ field, op: 'gte', value: 3 }] },
      });
      expect(response.status, `field ${field} was not refused`).toBe(422);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    }

    // And nothing was created by any of them.
    const list = await get('owner', '/api/v1/automation/rules', { key: 'atm_injection_attempt' });
    expect(list.body.data).toHaveLength(0);
  });

  /**
   * The counterpart to the injection test above: the regex has to refuse those five and
   * still accept the field names the events actually carry. Event payloads are camelCase —
   * they are the same JSON the rest of the API speaks — and a lowercase-only rule made most
   * of the event catalogue unreferenceable. The field existed, was documented, was emitted,
   * and was rejected at 422 the moment anyone named it in a condition.
   */
  it('accepts the camelCase field names the events actually carry', async () => {
    const response = await post('owner', '/api/v1/automation/rules', {
      ...absenceRuleBody('CamelCase event field'),
      key: 'atm_camel_case_field',
      conditions: {
        match: 'all',
        clauses: [{ field: 'event.consecutiveAbsences', op: 'gte', value: 3 }],
      },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.conditions.clauses[0].field).toBe('event.consecutiveAbsences');
  });

  it('refuses an unknown operator and an unknown fact by name', async () => {
    const badOperator = await post('owner', '/api/v1/automation/rules', {
      ...absenceRuleBody('Unknown operator'),
      key: 'atm_bad_operator',
      conditions: {
        match: 'all',
        clauses: [{ field: 'fact.student_consecutive_absences', op: 'regex', value: '.*' }],
      },
    });
    expect(badOperator.status).toBe(422);

    const unknownFact = await post('owner', '/api/v1/automation/rules', {
      ...absenceRuleBody('Unknown fact'),
      key: 'atm_unknown_fact',
      conditions: {
        match: 'all',
        clauses: [{ field: 'fact.student_bank_balance', op: 'gte', value: 3 }],
      },
    });
    expect(unknownFact.status).toBe(422);
    expect(JSON.stringify(unknownFact.body.error.issues)).toContain('student_bank_balance');

    const unknownEventField = await post('owner', '/api/v1/automation/rules', {
      ...absenceRuleBody('Unknown event field'),
      key: 'atm_unknown_field',
      conditions: {
        match: 'all',
        clauses: [{ field: 'event.secret_score', op: 'gte', value: 3 }],
      },
    });
    expect(unknownEventField.status).toBe(422);
    expect(JSON.stringify(unknownEventField.body.error.issues)).toContain('secret_score');

    const unknownPlaceholder = await post('owner', '/api/v1/automation/rules', {
      ...absenceRuleBody('Unknown placeholder'),
      key: 'atm_unknown_placeholder',
      action: {
        kind: 'flag_for_review',
        summary: 'Look at {{home_address}} for this student',
      },
    });
    expect(unknownPlaceholder.status).toBe(422);
    expect(JSON.stringify(unknownPlaceholder.body.error.issues)).toContain('home_address');
  });

  it('refuses an event payload field the event does not declare', async () => {
    const response = await post('owner', '/api/v1/automation/events', {
      eventName: 'attendance.student_absent',
      dedupeKey: 'atm-undeclared-field',
      sourceModule: 'attendance',
      payload: { studentId: tenant.studentIds[0], smuggled: 'anything' },
    });
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body.error.issues)).toContain('smuggled');
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // Versioning, dry run and activation
  // ─────────────────────────────────────────────────────────────────────────────────

  it('dry-runs a rule against a sample payload without writing anything', async () => {
    const before = await countRows('automation_executions');

    const response = await post(
      'owner',
      `/api/v1/automation/rules/${absenceRuleV1Id}/dry-run`,
      {
        payload: {
          studentId: tenant.studentIds[ABSENT_STUDENT_INDEX],
          studentName: 'Sample Student',
          date: '2026-03-02',
          consecutiveAbsences: 3,
        },
      },
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.matched).toBe(true);
    // The fact was computed for real, against the three registers seeded above.
    expect(response.body.facts.student_consecutive_absences).toBe(3);
    expect(response.body.clauses).toHaveLength(1);
    expect(response.body.clauses[0].passed).toBe(true);
    expect(response.body.wouldDo).toContain('direct message');

    expect(await countRows('automation_executions')).toBe(before);
    expect(await countRows('automation_events')).toBe(0);
  });

  it('versions a rule on edit and activates the new version', async () => {
    const { key: _key, ...editableFields } = absenceRuleBody(
      'Three consecutive absences notify the guardian (revised)',
    );
    const edited = await patch(
      'owner',
      `/api/v1/automation/rules/${absenceRuleV1Id}`,
      editableFields,
    );
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.version).toBe(2);
    expect(edited.body.id).not.toBe(absenceRuleV1Id);
    absenceRuleV2Id = edited.body.id as string;

    const activated = await post(
      'owner',
      `/api/v1/automation/rules/${absenceRuleV2Id}/activate`,
      { version: 2 },
    );
    expect(activated.status, JSON.stringify(activated.body)).toBe(201);
    expect(activated.body.isActive).toBe(true);

    // Version 1 is still readable history, and is not the one that runs.
    const v1 = await get('owner', `/api/v1/automation/rules/${absenceRuleV1Id}`);
    expect(v1.status).toBe(200);
    expect(v1.body.isActive).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // Execution, idempotency and cooldown
  // ─────────────────────────────────────────────────────────────────────────────────

  it('acts on a matching event: the guardian is messaged, once', async () => {
    const messagesBefore = await countRows('messages');

    const emitted = await post('owner', '/api/v1/automation/events', {
      eventName: 'attendance.student_absent',
      dedupeKey: 'atm-absence-day-1',
      sourceModule: 'attendance',
      payload: {
        studentId: tenant.studentIds[ABSENT_STUDENT_INDEX],
        studentName: 'Absent Student',
        sectionId: tenant.sectionId,
        date: '2026-03-02',
        consecutiveAbsences: 3,
      },
    });
    expect(emitted.status, JSON.stringify(emitted.body)).toBe(201);
    expect(emitted.body.duplicate).toBe(false);
    firstAbsenceEventId = emitted.body.event.id as string;

    const processed = await post('owner', '/api/v1/automation/events/process', {});
    expect(processed.status, JSON.stringify(processed.body)).toBe(201);
    expect(processed.body.eventsProcessed).toBe(1);
    expect(processed.body.executions).toHaveLength(1);

    const execution = processed.body.executions[0];
    expect(execution.status).toBe('acted');
    expect(execution.subjectKind).toBe('student');
    expect(execution.subjectId).toBe(tenant.studentIds[ABSENT_STUDENT_INDEX]);
    expect(execution.actionResult.recipientCount).toBe(1);
    expect(execution.actionResult.threadIds).toHaveLength(1);

    // A real message really exists, written through the communication module's own
    // append-only path — not a stub and not a canned result.
    expect(await countRows('messages')).toBe(messagesBefore + 1);
  });

  it('writes no second event for a repeated dedupe key', async () => {
    const eventsBefore = await countRows('automation_events');

    const repeat = await post('owner', '/api/v1/automation/events', {
      eventName: 'attendance.student_absent',
      dedupeKey: 'atm-absence-day-1',
      sourceModule: 'attendance',
      payload: {
        studentId: tenant.studentIds[ABSENT_STUDENT_INDEX],
        studentName: 'Absent Student',
        date: '2026-03-02',
        consecutiveAbsences: 4,
      },
    });
    expect(repeat.status, JSON.stringify(repeat.body)).toBe(201);
    expect(repeat.body.duplicate).toBe(true);
    expect(repeat.body.event.id).toBe(firstAbsenceEventId);

    expect(await countRows('automation_events')).toBe(eventsBefore);
  });

  it('refuses a duplicate dedupe key at the database level too', async () => {
    const refusal = await asAppRole(tenant.tenantId, (client) =>
      expectRefusal(
        client.query(
          `insert into automation_events
             (tenant_id, institution_id, event_name, source_module, dedupe_key)
           values ($1,$2,'attendance.student_absent','attendance','atm-absence-day-1')`,
          [tenant.tenantId, tenant.institutionId],
        ),
      ),
    );
    expect(refusal.code).toBe('23505');
    expect(refusal.message).toContain('automation_events_institution_dedupe_key');
  });

  it('records suppressed_duplicate when an event is re-run for a rule that already handled it', async () => {
    const messagesBefore = await countRows('messages');

    const reprocessed = await post('owner', '/api/v1/automation/events/process', {
      eventId: firstAbsenceEventId,
    });
    expect(reprocessed.status, JSON.stringify(reprocessed.body)).toBe(201);
    expect(reprocessed.body.executions).toHaveLength(1);
    expect(reprocessed.body.executions[0].status).toBe('suppressed_duplicate');

    // Suppressed means suppressed: nobody was messaged a second time.
    expect(await countRows('messages')).toBe(messagesBefore);
  });

  it('records suppressed_cooldown for a second absence inside the window', async () => {
    const messagesBefore = await countRows('messages');

    const emitted = await post('owner', '/api/v1/automation/events', {
      eventName: 'attendance.student_absent',
      dedupeKey: 'atm-absence-day-2',
      sourceModule: 'attendance',
      payload: {
        studentId: tenant.studentIds[ABSENT_STUDENT_INDEX],
        studentName: 'Absent Student',
        date: '2026-03-03',
        consecutiveAbsences: 4,
      },
    });
    expect(emitted.status).toBe(201);
    expect(emitted.body.duplicate).toBe(false);

    const processed = await post('owner', '/api/v1/automation/events/process', {});
    expect(processed.body.executions).toHaveLength(1);
    expect(processed.body.executions[0].status).toBe('suppressed_cooldown');
    expect(processed.body.executions[0].actionResult.cooldownMinutes).toBe(60);

    // The whole point: the guardian is not messaged five times in an hour.
    expect(await countRows('messages')).toBe(messagesBefore);
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // Append-only events, proved against Postgres
  // ─────────────────────────────────────────────────────────────────────────────────

  it('refuses UPDATE and DELETE on automation_events from the application role', async () => {
    const update = await asAppRole(tenant.tenantId, (client) =>
      expectRefusal(
        client.query(`update automation_events set payload = '{"tampered":true}'::jsonb where id = $1`, [
          firstAbsenceEventId,
        ]),
      ),
    );
    expect(update.message).toContain('append-only');

    const rename = await asAppRole(tenant.tenantId, (client) =>
      expectRefusal(
        client.query(`update automation_events set event_name = 'exams.mark_recorded' where id = $1`, [
          firstAbsenceEventId,
        ]),
      ),
    );
    expect(rename.message).toContain('append-only');

    const remove = await asAppRole(tenant.tenantId, (client) =>
      expectRefusal(
        client.query('delete from automation_events where id = $1', [firstAbsenceEventId]),
      ),
    );
    expect(remove.message.toLowerCase()).toMatch(/append-only|permission denied/);

    // And the row is exactly as it was.
    const still = await get('owner', '/api/v1/automation/events');
    const found = (still.body.data as { id: string; eventName: string }[]).find(
      (row) => row.id === firstAbsenceEventId,
    );
    expect(found?.eventName).toBe('attendance.student_absent');
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // The rule that must never act on its own
  // ─────────────────────────────────────────────────────────────────────────────────

  it('refuses a rule that would touch a sensitive resource without a human', async () => {
    const autonomous = await post('owner', '/api/v1/automation/rules', {
      key: 'atm_mark_watch_bad',
      name: 'Autonomous mark watcher',
      triggerKind: 'event',
      eventName: 'exams.mark_recorded',
      conditions: { match: 'all', clauses: [{ field: 'event.percentage', op: 'lt', value: 40 }] },
      action: {
        kind: 'notify',
        targetResource: 'exam_mark',
        recipients: 'guardians_of_subject_student',
        subject: 'Low mark',
        messageEn: 'A mark was low and this rule intends to act on it by itself.',
      },
      requiresHumanConfirmation: false,
      cooldownMinutes: 0,
    });
    expect(autonomous.status, JSON.stringify(autonomous.body)).toBe(422);
    expect(JSON.stringify(autonomous.body.error.issues)).toContain('exam_mark');
  });

  it('refuses the same rule shape at the DATABASE level, bypassing the service entirely', async () => {
    const refusal = await asAppRole(tenant.tenantId, (client) =>
      expectRefusal(
        client.query(
          `insert into automation_rules
             (tenant_id, institution_id, key, name_en, trigger_kind, event_name,
              action_kind, action_config, requires_human_confirmation)
           values ($1,$2,'atm_raw_sensitive','Raw sensitive rule','event',
                   'exams.mark_recorded','notify',
                   '{"targetResource":"exam_mark","recipients":"guardians_of_subject_student"}'::jsonb,
                   false)`,
          [tenant.tenantId, tenant.institutionId],
        ),
      ),
    );
    expect(refusal.constraint).toBe('automation_rules_sensitive_needs_human');
  });

  it('produces a SUGGESTION and changes nothing when a rule watches a sensitive resource', async () => {
    const created = await post('owner', '/api/v1/automation/rules', {
      key: 'atm_mark_early_warning',
      name: 'Low exam mark raises an early-warning suggestion',
      description: 'Marks are sensitive: the rule describes, a teacher decides.',
      triggerKind: 'event',
      eventName: 'exams.mark_recorded',
      conditions: { match: 'all', clauses: [{ field: 'event.percentage', op: 'lt', value: 40 }] },
      action: {
        kind: 'flag_for_review',
        targetResource: 'exam_mark',
        summary: '{{studentName}} scored {{percentage}}% in {{subjectName}}.',
      },
      requiresHumanConfirmation: true,
      cooldownMinutes: 0,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    sensitiveRuleId = created.body.id as string;

    const activated = await post(
      'owner',
      `/api/v1/automation/rules/${sensitiveRuleId}/activate`,
      { version: 1 },
    );
    expect(activated.status).toBe(201);

    const messagesBefore = await countRows('messages');
    const marksBefore = await countRows('exam_marks');
    const workflowRequestsBefore = await countRows('workflow_requests');

    const markId = uuidv7();
    const emitted = await post('owner', '/api/v1/automation/events', {
      eventName: 'exams.mark_recorded',
      dedupeKey: `atm-mark-${markId}`,
      sourceModule: 'exams',
      payload: {
        markId,
        studentId: tenant.studentIds[1],
        studentName: 'Struggling Student',
        examId: uuidv7(),
        subjectName: 'Mathematics',
        percentage: 32,
      },
    });
    expect(emitted.status, JSON.stringify(emitted.body)).toBe(201);

    const processed = await post('owner', '/api/v1/automation/events/process', {});
    expect(processed.status, JSON.stringify(processed.body)).toBe(201);
    expect(processed.body.executions).toHaveLength(1);

    const execution = processed.body.executions[0];
    expect(execution.status).toBe('awaiting_confirmation');
    expect(execution.actionResult.suggestion).toBe(true);
    expect(execution.workflowRequestId).toBeNull();

    // The suggestion exists…
    const suggestions = await get('owner', '/api/v1/automation/suggestions', {
      ruleId: sensitiveRuleId,
    });
    expect(suggestions.status).toBe(200);
    expect(suggestions.body.data).toHaveLength(1);
    const suggestion = suggestions.body.data[0];
    expect(suggestion.status).toBe('pending');
    expect(suggestion.subjectKind).toBe('exam_mark');
    expect(suggestion.subjectId).toBe(markId);
    expect(suggestion.summary).toContain('Struggling Student');
    expect(suggestion.summary).toContain('32');
    expect(suggestion.evidence.facts).toBeDefined();
    sensitiveSuggestionId = suggestion.id as string;

    // …and nothing else happened. No message, no mark, no approval request.
    expect(await countRows('messages')).toBe(messagesBefore);
    expect(await countRows('exam_marks')).toBe(marksBefore);
    expect(await countRows('workflow_requests')).toBe(workflowRequestsBefore);
  });

  it('records a human decision on a suggestion, and refuses a second one', async () => {
    const accepted = await post(
      'owner',
      `/api/v1/automation/suggestions/${sensitiveSuggestionId}/accept`,
      { note: 'Class teacher will speak to the student this week.', version: 1 },
    );
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    expect(accepted.body.status).toBe('accepted');
    expect(accepted.body.decidedBy).toBe(tenant.users['owner']!.id);
    expect(accepted.body.decisionNote).toContain('Class teacher');

    const again = await post(
      'owner',
      `/api/v1/automation/suggestions/${sensitiveSuggestionId}/dismiss`,
      { note: 'Trying to decide it a second time.', version: 2 },
    );
    expect(again.status).toBe(409);

    // Accepting records agreement; it does not perform the action. Nothing was created.
    expect(await countRows('exam_marks')).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // Failure isolation
  // ─────────────────────────────────────────────────────────────────────────────────

  it('records a failing rule and still runs the others', async () => {
    // Rules run in key order, so the failing one is deliberately first.
    const failing = await post('owner', '/api/v1/automation/rules', {
      key: 'atm_aaa_broken_workflow',
      name: 'Starts a workflow that does not exist',
      triggerKind: 'event',
      eventName: 'hr.document_expiring',
      conditions: { match: 'all', clauses: [{ field: 'event.daysToExpiry', op: 'lte', value: 30 }] },
      action: {
        kind: 'create_workflow_request',
        definitionKey: 'atm_no_such_definition',
        summary: 'Renew an expiring document',
      },
      requiresHumanConfirmation: false,
      cooldownMinutes: 0,
    });
    expect(failing.status, JSON.stringify(failing.body)).toBe(201);
    expect(
      (
        await post('owner', `/api/v1/automation/rules/${failing.body.id}/activate`, { version: 1 })
      ).status,
    ).toBe(201);

    const working = await post('owner', '/api/v1/automation/rules', {
      key: 'atm_zzz_document_flag',
      name: 'Document expiring within thirty days flags HR',
      triggerKind: 'event',
      eventName: 'hr.document_expiring',
      conditions: { match: 'all', clauses: [{ field: 'event.daysToExpiry', op: 'lte', value: 30 }] },
      action: {
        kind: 'flag_for_review',
        summary: '{{employeeName}} — {{documentType}} expires on {{expiresAt}}.',
      },
      requiresHumanConfirmation: false,
      cooldownMinutes: 0,
    });
    expect(working.status, JSON.stringify(working.body)).toBe(201);
    expect(
      (
        await post('owner', `/api/v1/automation/rules/${working.body.id}/activate`, { version: 1 })
      ).status,
    ).toBe(201);

    const documentId = uuidv7();
    const emitted = await post('owner', '/api/v1/automation/events', {
      eventName: 'hr.document_expiring',
      dedupeKey: `atm-doc-${documentId}`,
      sourceModule: 'hr',
      payload: {
        documentId,
        employeeId: tenant.employeeIds[0],
        employeeName: 'A Member of Staff',
        documentType: 'work_permit',
        expiresAt: '2026-09-20',
        daysToExpiry: 22,
      },
    });
    expect(emitted.status, JSON.stringify(emitted.body)).toBe(201);

    const processed = await post('owner', '/api/v1/automation/events/process', {});
    expect(processed.status, JSON.stringify(processed.body)).toBe(201);
    expect(processed.body.executions).toHaveLength(2);

    const byRule = new Map<string, Record<string, unknown>>(
      (processed.body.executions as Record<string, unknown>[]).map((execution) => [
        execution.ruleId as string,
        execution,
      ]),
    );

    const failed = byRule.get(failing.body.id as string)!;
    expect(failed.status).toBe('failed');
    expect(String(failed.error)).toContain('Active workflow definition');

    // The second rule ran anyway — that is the property under test.
    const acted = byRule.get(working.body.id as string)!;
    expect(acted.status).toBe('acted');

    const suggestions = await get('owner', '/api/v1/automation/suggestions', {
      ruleId: working.body.id,
    });
    expect(suggestions.body.data).toHaveLength(1);
    expect(suggestions.body.data[0].summary).toContain('work_permit');
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // Rule chaining — the one record a rule may create, and the hop limit on it
  // ─────────────────────────────────────────────────────────────────────────────────

  it('lets one rule feed another exactly once, and refuses a second hop', async () => {
    const source = await post('owner', '/api/v1/automation/rules', {
      key: 'atm_chain_source',
      name: 'Overdue invoice raises a follow-up',
      triggerKind: 'event',
      eventName: 'fees.invoice_overdue',
      conditions: { match: 'all', clauses: [{ field: 'event.daysOverdue', op: 'gte', value: 15 }] },
      action: { kind: 'create_record', recordKind: 'automation_event', eventName: 'automation.derived' },
      requiresHumanConfirmation: false,
      cooldownMinutes: 0,
    });
    expect(source.status, JSON.stringify(source.body)).toBe(201);
    expect(
      (await post('owner', `/api/v1/automation/rules/${source.body.id}/activate`, { version: 1 }))
        .status,
    ).toBe(201);

    const sink = await post('owner', '/api/v1/automation/rules', {
      key: 'atm_chain_sink',
      name: 'Follow-up becomes a review item',
      triggerKind: 'event',
      eventName: 'automation.derived',
      conditions: { match: 'all', clauses: [] },
      action: { kind: 'flag_for_review', summary: 'Rule {{ruleKey}} asked for a follow-up.' },
      requiresHumanConfirmation: false,
      cooldownMinutes: 0,
    });
    expect(sink.status, JSON.stringify(sink.body)).toBe(201);
    expect(
      (await post('owner', `/api/v1/automation/rules/${sink.body.id}/activate`, { version: 1 }))
        .status,
    ).toBe(201);

    // A rule triggered BY a derived event may not derive another: the chain is one hop, and
    // the refusal happens when the rule is written, not when it loops.
    const secondHop = await post('owner', '/api/v1/automation/rules', {
      key: 'atm_chain_loop',
      name: 'A rule that would loop forever',
      triggerKind: 'event',
      eventName: 'automation.derived',
      conditions: { match: 'all', clauses: [] },
      action: { kind: 'create_record', recordKind: 'automation_event', eventName: 'automation.derived' },
    });
    expect(secondHop.status).toBe(422);

    const invoiceId = uuidv7();
    const emitted = await post('owner', '/api/v1/automation/events', {
      eventName: 'fees.invoice_overdue',
      dedupeKey: `atm-invoice-${invoiceId}`,
      sourceModule: 'fees',
      payload: {
        invoiceId,
        studentId: tenant.studentIds[2],
        studentName: 'A Billed Student',
        invoiceNumber: 'ATM-INV-1',
        daysOverdue: 20,
      },
    });
    expect(emitted.status, JSON.stringify(emitted.body)).toBe(201);

    const firstPass = await post('owner', '/api/v1/automation/events/process', {});
    expect(firstPass.body.executions).toHaveLength(1);
    expect(firstPass.body.executions[0].status).toBe('acted');
    const derivedEventId = firstPass.body.executions[0].actionResult.derivedEventId as string;
    expect(derivedEventId).toBeTruthy();

    // The derived event is an ordinary pending event; the second pass consumes it.
    const secondPass = await post('owner', '/api/v1/automation/events/process', {});
    expect(secondPass.body.eventsProcessed).toBe(1);
    expect(secondPass.body.executions).toHaveLength(1);
    expect(secondPass.body.executions[0].status).toBe('acted');
    expect(secondPass.body.executions[0].eventId).toBe(derivedEventId);

    // And it stops there: nothing is left pending.
    const thirdPass = await post('owner', '/api/v1/automation/events/process', {});
    expect(thirdPass.body.eventsProcessed).toBe(0);

    const followUp = await get('owner', '/api/v1/automation/suggestions', {
      ruleId: sink.body.id,
    });
    expect(followUp.body.data).toHaveLength(1);
    expect(followUp.body.data[0].summary).toContain('atm_chain_source');
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // Scheduling is reported, never executed
  // ─────────────────────────────────────────────────────────────────────────────────

  it('reports which scheduled rules are due without running any of them', async () => {
    const created = await post('owner', '/api/v1/automation/rules', {
      key: 'atm_morning_sweep',
      name: 'Morning sweep',
      triggerKind: 'schedule',
      cronExpression: '0 7 * * *',
      timezone: 'Asia/Dhaka',
      conditions: { match: 'all', clauses: [] },
      action: { kind: 'flag_for_review', summary: 'Morning sweep placeholder review item.' },
      requiresHumanConfirmation: false,
      cooldownMinutes: 0,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(
      (
        await post('owner', `/api/v1/automation/rules/${created.body.id}/activate`, { version: 1 })
      ).status,
    ).toBe(201);

    const executionsBefore = await countRows('automation_executions');

    // 01:00 UTC is 07:00 in Dhaka.
    const due = await get('owner', '/api/v1/automation/schedule/due', {
      at: '2026-03-01T01:00:00Z',
    });
    expect(due.status, JSON.stringify(due.body)).toBe(200);
    const morning = (due.body as DueRow[]).find((row) => row.key === 'atm_morning_sweep');
    expect(morning?.due).toBe(true);
    expect(morning?.localTime).toBe('07:00');

    const notDue = await get('owner', '/api/v1/automation/schedule/due', {
      at: '2026-03-01T02:00:00Z',
    });
    const later = (notDue.body as DueRow[]).find((row) => row.key === 'atm_morning_sweep');
    expect(later?.due).toBe(false);

    // Reporting is all it does: no scheduler ran, so no execution appeared.
    expect(await countRows('automation_executions')).toBe(executionsBefore);
  });

  it('refuses a scheduled rule with no cron expression, and an event rule with one', async () => {
    const noCron = await post('owner', '/api/v1/automation/rules', {
      key: 'atm_schedule_no_cron',
      name: 'Scheduled with nothing to schedule',
      triggerKind: 'schedule',
      action: { kind: 'flag_for_review', summary: 'Nothing to see here at all.' },
    });
    expect(noCron.status).toBe(422);

    const eventWithCron = await post('owner', '/api/v1/automation/rules', {
      key: 'atm_event_with_cron',
      name: 'Event rule pretending to be scheduled',
      triggerKind: 'event',
      eventName: 'exams.mark_recorded',
      cronExpression: '0 7 * * *',
      action: { kind: 'flag_for_review', summary: 'Nothing to see here at all.' },
    });
    expect(eventWithCron.status).toBe(422);
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // Defaults, isolation and reporting
  // ─────────────────────────────────────────────────────────────────────────────────

  it('installs the default rule set inactive, and is idempotent', async () => {
    const first = await post('owner', '/api/v1/automation/rules/install-defaults');
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.created).toHaveLength(4);

    const keys = (first.body.created as { key: string }[]).map((rule) => rule.key).sort();
    expect(keys).toEqual([
      'absence_three_consecutive',
      'document_expiring_thirty_days',
      'fee_overdue_fifteen_days',
      'low_exam_mark_early_warning',
    ]);

    for (const rule of first.body.created as {
      isActive: boolean;
      isSystem: boolean;
      key: string;
      requiresHumanConfirmation: boolean;
      actionConfig: Record<string, unknown>;
    }[]) {
      expect(rule.isActive, `${rule.key} was installed active`).toBe(false);
      expect(rule.isSystem).toBe(true);
      if (rule.key === 'low_exam_mark_early_warning') {
        // The seeded rule that watches a sensitive resource is forced into the safe shape.
        expect(rule.requiresHumanConfirmation).toBe(true);
        expect(rule.actionConfig.targetResource).toBe('exam_mark');
      }
    }

    const second = await post('owner', '/api/v1/automation/rules/install-defaults');
    expect(second.status).toBe(201);
    expect(second.body.created).toHaveLength(0);
    expect(second.body.skipped).toHaveLength(4);
  });

  it('never lets one tenant see the rules of another', async () => {
    const crossTenantRead = await request(app.getHttpServer())
      .get(`/api/v1/automation/rules/${absenceRuleV2Id}`)
      .set('Authorization', `Bearer ${otherOwnerToken}`)
      .set('x-institution-id', other.institutionId);
    // 404, never 403: confirming the rule exists elsewhere is itself a leak.
    expect(crossTenantRead.status).toBe(404);

    // And the other tenant's own list is genuinely its own: it has no rules yet.
    const theirRules = await request(app.getHttpServer())
      .get('/api/v1/automation/rules')
      .set('Authorization', `Bearer ${otherOwnerToken}`)
      .set('x-institution-id', other.institutionId);
    expect(theirRules.status).toBe(200);
    expect(theirRules.body.data).toHaveLength(0);

    // Executions are scoped the same way.
    const theirExecutions = await request(app.getHttpServer())
      .get('/api/v1/automation/executions')
      .set('Authorization', `Bearer ${otherOwnerToken}`)
      .set('x-institution-id', other.institutionId);
    expect(theirExecutions.body.data).toHaveLength(0);
  });

  it('reports activity by status and by rule, suppressions and failures included', async () => {
    const report = await get('owner', '/api/v1/automation/reports/activity');
    expect(report.status, JSON.stringify(report.body)).toBe(200);

    expect(report.body.totals.acted).toBeGreaterThanOrEqual(2);
    expect(report.body.totals.suppressed_cooldown).toBe(1);
    expect(report.body.totals.suppressed_duplicate).toBe(1);
    expect(report.body.totals.failed).toBe(1);
    expect(report.body.totals.awaiting_confirmation).toBe(1);
    expect(report.body.unprocessedEvents).toBe(0);

    const absenceRow = (report.body.byRule as { key: string; suppressed: number }[]).find(
      (row) => row.key === 'atm_absence_streak',
    );
    expect(absenceRow?.suppressed).toBe(2);
  });

  it('writes an audit record for every execution that acted', async () => {
    const client = testClient();
    await client.connect();
    try {
      const { rows } = await client.query<{ total: string }>(
        `select count(*)::text as total
           from audit_logs
          where tenant_id = $1
            and module = 'automation'
            and resource_type = 'automation_execution'`,
        [tenant.tenantId],
      );
      // Two `acted` (absence notify, document flag) plus one `awaiting_confirmation`.
      expect(Number(rows[0]?.total ?? '0')).toBeGreaterThanOrEqual(3);

      // `audit_logs` records `occurred_at`, not `created_at`.
      const { rows: latest } = await client.query<{ resource_label: string }>(
        `select resource_label
           from audit_logs
          where tenant_id = $1 and resource_type = 'automation_execution'
          order by occurred_at desc
          limit 1`,
        [tenant.tenantId],
      );
      expect(latest[0]?.resource_label).toBeTruthy();
    } finally {
      await client.end();
    }
  });
});

interface DueRow {
  key: string;
  due: boolean;
  localTime: string;
}
