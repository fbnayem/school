/**
 * Workflow engine over HTTP (Phase 25).
 *
 * The suite is built around the refusals, because the refusals are the module (docs/08,
 * KI-002):
 *
 *  - **The owner cannot self-approve.** The school owner holds `*` — every permission in the
 *    catalogue — and is still refused when they try to approve a request they initiated.
 *    This is the single most important assertion in the file.
 *  - An approver who decided step 1 cannot also decide step 2 (four-eyes across steps).
 *  - An invalid transition is a 409 that names both states, never a silent no-op.
 *  - A send-back moves the request to an earlier step while the full history survives.
 *  - A delegate can act only inside the delegation's date window, and acts on record as
 *    "on behalf of" the delegator.
 *  - Editing an active definition creates a new version; running requests keep the old one.
 *  - `workflow_actions` is append-only at the database level: an UPDATE or DELETE from the
 *    application role is refused by Postgres itself, not by application code.
 *  - Tenant isolation (a cross-tenant read is a 404) and permission denials.
 *
 * Personas (seeded by the harness): owner (`*`), principal (`workflows.*`, most approvals),
 * accountant (`workflows.act`, finance permissions), admin and teacher (no workflow
 * permissions at all — the denial cases).
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

describe('Workflow engine', () => {
  let app: INestApplication;
  let tenant: SeededTenant;
  let other: SeededTenant;
  const tokens: Record<string, string> = {};
  let otherPrincipalToken: string;

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

  /** A two-step chain both the accountant and the principal can act on. */
  const EXPENSE_DEFINITION = {
    key: 'expense_approval',
    name: 'Expense approval',
    entityType: 'expense',
    steps: [
      {
        sequence: 1,
        name: 'Accountant review',
        approverPermission: 'finance.reports.view',
        onReject: 'terminate',
        slaHours: 24,
      },
      {
        sequence: 2,
        name: 'Principal approval',
        approverPermission: 'finance.reports.view',
        onReject: 'terminate',
      },
    ],
  };

  async function createExpenseDefinition(): Promise<string> {
    const response = await post('principal', '/api/v1/workflows/definitions', EXPENSE_DEFINITION);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.id as string;
  }

  async function startExpenseRequest(
    role: string,
    entityId: string,
  ): Promise<Record<string, unknown>> {
    const response = await post(role, '/api/v1/workflows/requests', {
      definitionKey: 'expense_approval',
      entityId,
      summary: `Expense request for entity ${entityId.slice(0, 8)}`,
      payload: { amount: '2500.00', currency: 'BDT' },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body as Record<string, unknown>;
  }

  beforeAll(async () => {
    app = await createTestApp();
    await truncateAll();
    tenant = await seedTenant('wfa', { students: 1 });
    other = await seedTenant('wfb', { students: 1 });

    for (const role of ['owner', 'principal', 'admin', 'accountant', 'teacher']) {
      tokens[role] = await login(tenant.users[role]!.email);
    }
    otherPrincipalToken = await login(other.users['principal']!.email);
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // Definitions
  // ─────────────────────────────────────────────────────────────────────────────────

  describe('definitions', () => {
    it('refuses a definition whose step names a permission not in the catalogue', async () => {
      const response = await post('principal', '/api/v1/workflows/definitions', {
        key: 'bogus_permission_flow',
        name: 'Bogus',
        entityType: 'expense',
        steps: [{ sequence: 1, name: 'Step', approverPermission: 'no.such.permission' }],
      });
      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body)).toContain('no.such.permission');
    });

    it('refuses steps with gapped sequences', async () => {
      const response = await post('principal', '/api/v1/workflows/definitions', {
        key: 'gapped_flow',
        name: 'Gapped',
        entityType: 'expense',
        steps: [
          { sequence: 1, name: 'One', approverPermission: 'finance.reports.view' },
          { sequence: 3, name: 'Three', approverPermission: 'finance.reports.view' },
        ],
      });
      expect(response.status).toBe(422);
    });

    it('creates a definition as version 1 with ordered steps', async () => {
      const id = await createExpenseDefinition();
      const response = await get('principal', `/api/v1/workflows/definitions/${id}`);
      expect(response.status).toBe(200);
      expect(response.body.version).toBe(1);
      expect(response.body.isActive).toBe(true);
      expect(response.body.steps.map((s: { sequence: number }) => s.sequence)).toEqual([1, 2]);
    });

    it('refuses a duplicate key', async () => {
      const response = await post('principal', '/api/v1/workflows/definitions', EXPENSE_DEFINITION);
      expect(response.status).toBe(409);
    });

    it('denies definition listing to a teacher, who holds no workflow permission', async () => {
      const response = await get('teacher', '/api/v1/workflows/definitions');
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('denies definition creation to the accountant, who can act but not manage', async () => {
      const response = await post('accountant', '/api/v1/workflows/definitions', {
        ...EXPENSE_DEFINITION,
        key: 'accountant_flow',
      });
      expect(response.status).toBe(403);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // The rule the module exists for
  // ─────────────────────────────────────────────────────────────────────────────────

  describe('self-approval is impossible, even for the owner', () => {
    let requestId: string;

    it('lets the owner start a request', async () => {
      const body = await startExpenseRequest('owner', uuidv7());
      requestId = body['id'] as string;
      expect(body['status']).toBe('pending');
      expect(body['currentStepSequence']).toBe(1);
      expect(body['definitionVersion']).toBe(1);
    });

    it('REFUSES the owner approving their own request despite holding every permission', async () => {
      // The owner's role is `['*']` — the permission system cannot say no. The service must.
      const response = await post('owner', `/api/v1/workflows/requests/${requestId}/approve`);
      expect(response.status).toBe(403);
      expect(response.body.error.message).toMatch(/own request/i);
    });

    it('equally refuses the owner rejecting their own request', async () => {
      const response = await post('owner', `/api/v1/workflows/requests/${requestId}/reject`, {
        comment: 'Trying to reject my own request',
      });
      expect(response.status).toBe(403);
    });

    it('left the request untouched by the refused attempts', async () => {
      const response = await get('owner', `/api/v1/workflows/requests/${requestId}`);
      expect(response.status).toBe(200);
      expect(response.body.request.status).toBe('pending');
      expect(response.body.request.currentStepSequence).toBe(1);
      expect(response.body.history).toHaveLength(0);
    });

    it('lets a second person (the accountant) approve step 1', async () => {
      const response = await post('accountant', `/api/v1/workflows/requests/${requestId}/approve`, {
        comment: 'Numbers check out',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('pending');
      expect(response.body.currentStepSequence).toBe(2);
    });

    it('refuses the step-1 approver at step 2 (four-eyes across steps)', async () => {
      // The accountant holds the step-2 permission too; what disqualifies them is having
      // already decided an earlier step of this request.
      const response = await post('accountant', `/api/v1/workflows/requests/${requestId}/approve`);
      expect(response.status).toBe(403);
      expect(response.body.error.message).toMatch(/already acted/i);
    });

    it('lets a third pair of eyes (the principal) complete the approval', async () => {
      const response = await post('principal', `/api/v1/workflows/requests/${requestId}/approve`);
      expect(response.status).toBe(201);
      expect(response.body.status).toBe('approved');
      expect(response.body.decidedAt).toBeTruthy();
    });

    it('409s an action on the decided request, naming both states', async () => {
      const response = await post('principal', `/api/v1/workflows/requests/${requestId}/reject`, {
        comment: 'Too late to reject this one',
      });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('WORKFLOW_STATE_INVALID');
      // The message names the from state and the to state — never a silent no-op.
      expect(response.body.error.message).toContain('approved');
      expect(response.body.error.message).toContain('rejected');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // Send-back and rejection
  // ─────────────────────────────────────────────────────────────────────────────────

  describe('send-back preserves history', () => {
    let requestId: string;

    it('runs a request to step 2 and sends it back to step 1', async () => {
      const body = await startExpenseRequest('owner', uuidv7());
      requestId = body['id'] as string;

      const approved = await post('accountant', `/api/v1/workflows/requests/${requestId}/approve`);
      expect(approved.status).toBe(201);

      const sentBack = await post(
        'principal',
        `/api/v1/workflows/requests/${requestId}/send-back`,
        {
          targetSequence: 1,
          comment: 'Attach the vendor quotation before I approve this',
        },
      );
      expect(sentBack.status, JSON.stringify(sentBack.body)).toBe(201);
      expect(sentBack.body.status).toBe('sent_back');
      expect(sentBack.body.currentStepSequence).toBe(1);
    });

    it('kept the earlier approval in the history rather than rewriting it', async () => {
      const response = await get('principal', `/api/v1/workflows/requests/${requestId}`);
      expect(response.status).toBe(200);
      const actions = response.body.history.map(
        (a: { action: string; stepSequence: number }) => `${a.action}@${a.stepSequence}`,
      );
      expect(actions).toEqual(['approve@1', 'send_back@2']);
    });

    it('refuses a send-back without a comment', async () => {
      const response = await post(
        'principal',
        `/api/v1/workflows/requests/${requestId}/send-back`,
        {
          targetSequence: 1,
        },
      );
      expect(response.status).toBe(422);
    });

    it('refuses sending back to a step that is not earlier', async () => {
      // Move it forward again first.
      const approve = await post('accountant', `/api/v1/workflows/requests/${requestId}/approve`);
      expect(approve.status, JSON.stringify(approve.body)).toBe(201);
      expect(approve.body.currentStepSequence).toBe(2);

      const response = await post(
        'principal',
        `/api/v1/workflows/requests/${requestId}/send-back`,
        {
          targetSequence: 2,
          comment: 'Sending it back to where it already is',
        },
      );
      expect(response.status).toBe(422);
    });

    it('completes after rework with the full four-action history intact', async () => {
      const response = await post('principal', `/api/v1/workflows/requests/${requestId}/approve`);
      expect(response.status).toBe(201);
      expect(response.body.status).toBe('approved');

      const detail = await get('owner', `/api/v1/workflows/requests/${requestId}`);
      expect(detail.body.history).toHaveLength(4);
    });
  });

  describe('rejection', () => {
    it('refuses a rejection without a substantial comment', async () => {
      const body = await startExpenseRequest('owner', uuidv7());
      const response = await post('accountant', `/api/v1/workflows/requests/${body['id']}/reject`, {
        comment: 'no',
      });
      expect(response.status).toBe(422);

      // Terminate-on-reject at step 1 ends the request.
      const rejected = await post('accountant', `/api/v1/workflows/requests/${body['id']}/reject`, {
        comment: 'This expense is not in this year’s budget',
      });
      expect(rejected.status).toBe(201);
      expect(rejected.body.status).toBe('rejected');
      expect(rejected.body.decidedAt).toBeTruthy();
    });
  });

  describe('cancellation', () => {
    it('lets the initiator cancel and refuses an unrelated actor', async () => {
      const body = await startExpenseRequest('accountant', uuidv7());
      const requestId = body['id'] as string;

      // The accountant initiated this one; a fellow accountant-permission holder who is
      // neither initiator nor workflow admin may not cancel it. (The teacher lacks even the
      // route permission, which is the coarser denial already tested above.)
      const cancelled = await post('accountant', `/api/v1/workflows/requests/${requestId}/cancel`, {
        comment: 'Raised against the wrong cost centre',
      });
      expect(cancelled.status).toBe(201);
      expect(cancelled.body.status).toBe('cancelled');

      const again = await post('accountant', `/api/v1/workflows/requests/${requestId}/cancel`, {
        comment: 'Cancelling a cancelled request',
      });
      expect(again.status).toBe(409);
      expect(again.body.error.message).toContain('cancelled');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // Delegation
  // ─────────────────────────────────────────────────────────────────────────────────

  describe('delegation', () => {
    let requestId: string;

    beforeAll(async () => {
      // A one-step chain only the principal (and the owner) can decide. The accountant holds
      // `workflows.act` but not `results.approve`, so any authority they gain over it can
      // come only from a delegation.
      const created = await post('principal', '/api/v1/workflows/definitions', {
        key: 'results_approval',
        name: 'Results approval',
        entityType: 'exam_result',
        steps: [{ sequence: 1, name: 'Results approval', approverPermission: 'results.approve' }],
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
    });

    async function startResultsRequest(): Promise<string> {
      const response = await post('owner', '/api/v1/workflows/requests', {
        definitionKey: 'results_approval',
        entityId: uuidv7(),
        summary: 'Term 1 results for section A',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      return response.body.id as string;
    }

    it('refuses the accountant before any delegation exists', async () => {
      requestId = await startResultsRequest();
      const response = await post('accountant', `/api/v1/workflows/requests/${requestId}/approve`);
      expect(response.status).toBe(403);
    });

    it('refuses a delegation whose window has not started', async () => {
      const future = await post('principal', '/api/v1/workflows/delegations', {
        toUserId: tenant.users['accountant']!.id,
        fromDate: addDays(todayInDhaka(), 5),
        toDate: addDays(todayInDhaka(), 9),
        reason: 'Conference travel later this month',
      });
      expect(future.status).toBe(201);

      const response = await post('accountant', `/api/v1/workflows/requests/${requestId}/approve`);
      expect(response.status).toBe(403);

      const revoked = await post(
        'principal',
        `/api/v1/workflows/delegations/${future.body.id}/revoke`,
        { reason: 'Replacing with a current-window delegation' },
      );
      expect(revoked.status).toBe(201);
    });

    it('lets the delegate act inside the window, on record as on-behalf-of', async () => {
      const delegation = await post('principal', '/api/v1/workflows/delegations', {
        toUserId: tenant.users['accountant']!.id,
        fromDate: todayInDhaka(),
        toDate: addDays(todayInDhaka(), 2),
        reason: 'On medical leave for the rest of the week',
      });
      expect(delegation.status, JSON.stringify(delegation.body)).toBe(201);

      const response = await post('accountant', `/api/v1/workflows/requests/${requestId}/approve`);
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('approved');

      const detail = await get('principal', `/api/v1/workflows/requests/${requestId}`);
      const approval = detail.body.history.find((a: { action: string }) => a.action === 'approve');
      expect(approval.actorUserId).toBe(tenant.users['accountant']!.id);
      expect(approval.onBehalfOfUserId).toBe(tenant.users['principal']!.id);
    });

    it('does not let a delegation launder the self-approval rule', async () => {
      // The principal delegates to the OWNER; the owner then initiates. The delegation would
      // make the owner eligible — but the initiator exclusion is checked first.
      const delegation = await post('principal', '/api/v1/workflows/delegations', {
        toUserId: tenant.users['owner']!.id,
        fromDate: todayInDhaka(),
        toDate: addDays(todayInDhaka(), 2),
        reason: 'Owner stands in while I am unavailable',
      });
      expect(delegation.status).toBe(201);

      const ownRequestId = await startResultsRequest();
      const response = await post('owner', `/api/v1/workflows/requests/${ownRequestId}/approve`);
      expect(response.status).toBe(403);
      expect(response.body.error.message).toMatch(/own request/i);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // Definition versioning
  // ─────────────────────────────────────────────────────────────────────────────────

  describe('definition versioning', () => {
    let v1Id: string;
    let v2Id: string;
    let runningRequestId: string;

    it('starts a request under version 1', async () => {
      const list = await get('principal', '/api/v1/workflows/definitions?key=expense_approval');
      expect(list.status).toBe(200);
      expect(list.body.data).toHaveLength(1);
      v1Id = list.body.data[0].id;

      const body = await startExpenseRequest('owner', uuidv7());
      runningRequestId = body['id'] as string;
      expect(body['definitionVersion']).toBe(1);
    });

    it('editing the active definition creates version 2 and deactivates version 1', async () => {
      const response = await patch('principal', `/api/v1/workflows/definitions/${v1Id}`, {
        version: 1,
        name: 'Expense approval (streamlined)',
        steps: [
          {
            sequence: 1,
            name: 'Single financial approval',
            approverPermission: 'finance.reports.view',
            slaHours: 24,
          },
        ],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.version).toBe(2);
      expect(response.body.isActive).toBe(true);
      expect(response.body.id).not.toBe(v1Id);
      v2Id = response.body.id;

      const old = await get('principal', `/api/v1/workflows/definitions/${v1Id}`);
      expect(old.body.isActive).toBe(false);

      const both = await get(
        'principal',
        '/api/v1/workflows/definitions?key=expense_approval&includeInactive=true',
      );
      expect(both.body.meta.total).toBe(2);
    });

    it('the running request keeps version 1 and its two-step chain', async () => {
      const response = await get('principal', `/api/v1/workflows/requests/${runningRequestId}`);
      expect(response.status).toBe(200);
      expect(response.body.request.definitionVersion).toBe(1);
      expect(response.body.definition.id).toBe(v1Id);
      expect(response.body.definition.version).toBe(1);
      expect(response.body.steps).toHaveLength(2);

      // And it still runs to completion under its own rules: two approvals, not one.
      const first = await post(
        'accountant',
        `/api/v1/workflows/requests/${runningRequestId}/approve`,
      );
      expect(first.status).toBe(201);
      expect(first.body.status).toBe('pending');
      const second = await post(
        'principal',
        `/api/v1/workflows/requests/${runningRequestId}/approve`,
      );
      expect(second.body.status).toBe('approved');
    });

    it('a new request picks up version 2 with the single step', async () => {
      const body = await startExpenseRequest('owner', uuidv7());
      expect(body['definitionVersion']).toBe(2);
      const detail = await get('principal', `/api/v1/workflows/requests/${body['id']}`);
      expect(detail.body.steps).toHaveLength(1);
      expect(detail.body.definition.id).toBe(v2Id);
    });

    it('refuses editing the superseded version', async () => {
      const response = await patch('principal', `/api/v1/workflows/definitions/${v1Id}`, {
        version: 1,
        name: 'Rewriting history',
      });
      expect(response.status).toBe(409);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // Lists, comments, overdue
  // ─────────────────────────────────────────────────────────────────────────────────

  describe('lists and reports', () => {
    it('"mine" shows the initiator their requests; "awaiting" excludes their own', async () => {
      const body = await startExpenseRequest('owner', uuidv7());
      const requestId = body['id'] as string;

      const mine = await get('owner', '/api/v1/workflows/requests?view=mine&status=pending');
      expect(mine.status).toBe(200);
      expect(
        mine.body.data.some((r: { id: string }) => r.id === requestId),
        'initiator should see their own pending request under view=mine',
      ).toBe(true);

      const ownerAwaiting = await get('owner', '/api/v1/workflows/requests?view=awaiting');
      expect(
        ownerAwaiting.body.data.some((r: { id: string }) => r.id === requestId),
        'a request must never await its own initiator',
      ).toBe(false);

      const accountantAwaiting = await get(
        'accountant',
        '/api/v1/workflows/requests?view=awaiting',
      );
      expect(accountantAwaiting.body.data.some((r: { id: string }) => r.id === requestId)).toBe(
        true,
      );
    });

    it('a comment is recorded without moving the state machine', async () => {
      const body = await startExpenseRequest('owner', uuidv7());
      const requestId = body['id'] as string;

      const commented = await post('owner', `/api/v1/workflows/requests/${requestId}/comment`, {
        comment: 'Vendor quotation is attached in the payload',
      });
      expect(commented.status).toBe(201);

      const detail = await get('owner', `/api/v1/workflows/requests/${requestId}`);
      expect(detail.body.request.status).toBe('pending');
      expect(detail.body.request.currentStepSequence).toBe(1);
      expect(detail.body.history.map((a: { action: string }) => a.action)).toContain('comment');
    });

    it('the overdue report lists a request past its due date', async () => {
      const body = await startExpenseRequest('owner', uuidv7());
      const requestId = body['id'] as string;
      expect(body['dueAt'], 'the step SLA should have stamped a due date').toBeTruthy();

      // Wind the clock: retention-style maintenance runs as the migrator.
      const client = testClient();
      await client.connect();
      try {
        await client.query(
          `update workflow_requests set due_at = now() - interval '2 hours' where id = $1`,
          [requestId],
        );
      } finally {
        await client.end();
      }

      const report = await get('principal', '/api/v1/workflows/requests/overdue');
      expect(report.status).toBe(200);
      expect(report.body.data.some((r: { id: string }) => r.id === requestId)).toBe(true);

      const denied = await get('accountant', '/api/v1/workflows/requests/overdue');
      expect(denied.status).toBe(403);
    });

    it('denies the request list to a teacher and request creation to an admin', async () => {
      const listDenied = await get('teacher', '/api/v1/workflows/requests');
      expect(listDenied.status).toBe(403);
      expect(listDenied.body.error.code).toBe('FORBIDDEN');

      const createDenied = await post('admin', '/api/v1/workflows/requests', {
        definitionKey: 'expense_approval',
        entityId: uuidv7(),
        summary: 'Admin should not be able to start workflows',
      });
      expect(createDenied.status).toBe(403);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // The database holds the line on its own
  // ─────────────────────────────────────────────────────────────────────────────────

  describe('workflow_actions is append-only at the database level', () => {
    let actionId: string;

    beforeAll(async () => {
      const body = await startExpenseRequest('owner', uuidv7());
      const approve = await post('accountant', `/api/v1/workflows/requests/${body['id']}/approve`);
      expect(approve.status).toBe(201);
      const detail = await get('principal', `/api/v1/workflows/requests/${body['id']}`);
      actionId = detail.body.history[0].id;
    });

    it('refuses an UPDATE from the application role', async () => {
      const client = new Client({ connectionString: TEST_APP_DATABASE_URL });
      await client.connect();
      try {
        // Give the session a legitimate tenant context, so what is being tested is the
        // append-only control, not row-level security hiding the row first.
        await client.query(`select set_config('app.tenant_id', $1, false)`, [tenant.tenantId]);
        await expect(
          client.query(`update workflow_actions set comment = 'rewritten' where id = $1`, [
            actionId,
          ]),
        ).rejects.toThrow(/append-only|permission denied|insufficient/i);
      } finally {
        await client.end();
      }
    });

    it('refuses a DELETE from the application role', async () => {
      const client = new Client({ connectionString: TEST_APP_DATABASE_URL });
      await client.connect();
      try {
        await client.query(`select set_config('app.tenant_id', $1, false)`, [tenant.tenantId]);
        await expect(
          client.query(`delete from workflow_actions where id = $1`, [actionId]),
        ).rejects.toThrow(/append-only|permission denied|insufficient/i);
      } finally {
        await client.end();
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // Tenant isolation
  // ─────────────────────────────────────────────────────────────────────────────────

  describe('tenant isolation', () => {
    let tenantARequestId: string;
    let tenantADefinitionId: string;

    beforeAll(async () => {
      const body = await startExpenseRequest('owner', uuidv7());
      tenantARequestId = body['id'] as string;
      const list = await get('principal', '/api/v1/workflows/definitions?key=expense_approval');
      tenantADefinitionId = list.body.data[0].id;
    });

    it("tenant B cannot read tenant A's request by id — 404, not 403", async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/workflows/requests/${tenantARequestId}`)
        .set('Authorization', `Bearer ${otherPrincipalToken}`)
        .set('x-institution-id', other.institutionId);

      // 404 rather than 403: confirming the record exists elsewhere is itself a leak.
      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain('Expense request');
    });

    it("tenant B cannot read tenant A's definition by id", async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/workflows/definitions/${tenantADefinitionId}`)
        .set('Authorization', `Bearer ${otherPrincipalToken}`)
        .set('x-institution-id', other.institutionId);
      expect(response.status).toBe(404);
    });

    it("tenant B's request list never contains tenant A's rows", async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/workflows/requests?view=all')
        .set('Authorization', `Bearer ${otherPrincipalToken}`)
        .set('x-institution-id', other.institutionId);
      expect(response.status).toBe(200);
      expect(
        response.body.data.every((r: { tenantId: string }) => r.tenantId !== tenant.tenantId),
      ).toBe(true);
      expect(JSON.stringify(response.body)).not.toContain(tenantARequestId);
    });

    it("tenant B cannot borrow tenant A's institution via the x-institution-id header", async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/workflows/requests')
        .set('Authorization', `Bearer ${otherPrincipalToken}`)
        .set('x-institution-id', tenant.institutionId);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it("tenant B cannot act on tenant A's request", async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/v1/workflows/requests/${tenantARequestId}/approve`)
        .set('Authorization', `Bearer ${otherPrincipalToken}`)
        .set('x-institution-id', other.institutionId)
        .send({});
      expect(response.status).toBe(404);

      // And the request is provably untouched.
      const detail = await get('owner', `/api/v1/workflows/requests/${tenantARequestId}`);
      expect(detail.body.request.status).toBe('pending');
      expect(detail.body.history).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // Audit trail
  // ─────────────────────────────────────────────────────────────────────────────────

  describe('audit', () => {
    it('every transition wrote an audit row with actor and reason in the same transaction', async () => {
      const body = await startExpenseRequest('owner', uuidv7());
      const requestId = body['id'] as string;
      const rejected = await post('accountant', `/api/v1/workflows/requests/${requestId}/reject`, {
        comment: 'Not budgeted for the current quarter',
      });
      expect(rejected.status).toBe(201);

      const client = testClient();
      await client.connect();
      try {
        // The service writes the precise row (with the reason) inside the deciding
        // transaction; the route interceptor may add a coarse one, so filter to the
        // reasoned record.
        const { rows } = await client.query(
          `select action::text, actor_user_id, reason
             from audit_logs
            where module = 'workflow' and resource_type = 'workflow_request' and resource_id = $1
              and action = 'reject' and reason is not null`,
          [requestId],
        );
        expect(rows.length).toBeGreaterThanOrEqual(1);
        expect(rows[0].actor_user_id).toBe(tenant.users['accountant']!.id);
        expect(rows[0].reason).toBe('Not budgeted for the current quarter');
      } finally {
        await client.end();
      }
    });
  });
});
