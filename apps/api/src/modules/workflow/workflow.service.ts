/**
 * Workflow engine service (Phase 25).
 *
 * The rule this module exists for (docs/08_WORKFLOW_ENGINE.md, KI-002): **an approver may not
 * approve their own request, regardless of permissions.** Permissions cannot express "not
 * *this* person" — a school owner holds every permission by definition — so the rule is
 * enforced here, at runtime, in `assertMayDecide`, *before* any permission is consulted.
 * The integration suite proves it with an actor who holds `*`.
 *
 * Other load-bearing decisions:
 *
 *  - **Approvers are resolved by permission, never by name.** A step stores a permission
 *    string; the set of people who may act is computed at decision time from `user_roles`,
 *    so a staffing change does not break a running workflow.
 *  - **Four-eyes across steps.** Anyone who made a decisive action (approve / reject /
 *    send back) at an earlier step is excluded from later steps of the same request.
 *  - **Transitions run through one explicit state machine.** An invalid transition is a 409
 *    naming both states (`WorkflowStateError`), never a silent no-op.
 *  - **Every transition writes its audit record inside the same transaction** as the state
 *    change, with actor, timestamp and reason. A decision that rolled back leaves no record;
 *    a decision that committed cannot lack one.
 *  - **Definitions are immutable once active.** Editing inserts version + 1 and deactivates
 *    the old row; running requests keep resolving steps against the version they started
 *    under, because steps hang off the *row* (`definition_id`), not the key.
 *  - **Delegation substitutes, it does not launder.** A delegate acts only inside the
 *    delegation's date window, only where the delegator would have been eligible, and both
 *    delegate and delegator are subject to the initiator and four-eyes exclusions.
 */

import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  ilike,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  employees,
  roles,
  userRoles,
  users,
  workflowActions,
  workflowDefinitions,
  workflowDelegations,
  workflowRequests,
  workflowSteps,
} from '@shikkha/db';
import {
  buildOffsetPage,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  offsetOf,
  parseSort,
  todayInDhaka,
  uuidv7,
  ValidationError,
  WorkflowStateError,
  type FieldIssue,
  type OffsetPage,
  type OffsetPageRequest,
} from '@shikkha/shared';
import { can, grantCovers, isPermission, type Principal } from '@shikkha/permissions';
import {
  WORKFLOW_DEFINITION_SORT_FIELDS,
  WORKFLOW_DELEGATION_SORT_FIELDS,
  WORKFLOW_REQUEST_SORT_FIELDS,
  type CreateWorkflowDefinitionInput,
  type CreateWorkflowDelegationInput,
  type CreateWorkflowRequestInput,
  type ListOverdueWorkflowRequestsQuery,
  type ListWorkflowDefinitionsQuery,
  type ListWorkflowDelegationsQuery,
  type ListWorkflowRequestsQuery,
  type UpdateWorkflowDefinitionInput,
  type WorkflowStepInput,
} from '@shikkha/validation';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { currentContext } from '../../common/context/request-context';

type Transaction = Parameters<Parameters<DatabaseService['runInTenant']>[0]>[0];

type DefinitionRow = typeof workflowDefinitions.$inferSelect;
type StepRow = typeof workflowSteps.$inferSelect;
type RequestRow = typeof workflowRequests.$inferSelect;
type ActionRow = typeof workflowActions.$inferSelect;
type DelegationRow = typeof workflowDelegations.$inferSelect;

type RequestStatus = RequestRow['status'];

/** Statuses in which a human decision can still move the request. */
const ACTIONABLE_STATUSES: readonly RequestStatus[] = ['pending', 'sent_back', 'escalated'];

/**
 * The explicit state machine. A transition absent from this table is a 409 that names both
 * states — never a silent no-op. `pending → pending` is the step advance of a multi-step
 * approval; `escalated` and `draft` are wired now so the scheduler and a draft-then-submit
 * client are code changes, not migrations.
 */
const REQUEST_TRANSITIONS: Record<RequestStatus, readonly RequestStatus[]> = {
  draft: ['pending', 'cancelled'],
  pending: ['pending', 'approved', 'rejected', 'sent_back', 'cancelled', 'escalated'],
  sent_back: ['pending', 'approved', 'rejected', 'sent_back', 'cancelled'],
  escalated: ['pending', 'approved', 'rejected', 'sent_back', 'cancelled'],
  approved: [],
  rejected: [],
  cancelled: [],
};

/** Actions that consume a person's "one pair of eyes" on a request. Comments do not. */
const DECISIVE_ACTIONS: readonly ActionRow['action'][] = ['approve', 'reject', 'send_back'];

export interface WorkflowOutcome {
  requestId: string;
  tenantId: string;
  institutionId: string;
  definitionKey: string;
  entityType: string;
  entityId: string;
  status: 'approved' | 'rejected';
  payload: Record<string, unknown>;
}

/**
 * The callback contract for the module that owns the entity travelling through a workflow.
 *
 * Register one handler per entity type (typically in the owning module's `onModuleInit`).
 * `onOutcome` runs **inside the deciding transaction**, so the owning module's side effect —
 * marking the leave approved, posting the expense — commits or rolls back atomically with
 * the workflow decision. A throwing handler therefore vetoes the decision, which is the
 * correct failure mode: an approval whose consequence could not be recorded did not happen.
 */
export interface WorkflowOutcomeHandler {
  entityType: string;
  onOutcome(tx: Transaction, outcome: WorkflowOutcome): Promise<void>;
}

interface ActingRights {
  /** The delegator when the action is taken under a delegation; null when acting directly. */
  onBehalfOfUserId: string | null;
}

@Injectable()
export class WorkflowService {
  private readonly outcomeHandlers = new Map<string, WorkflowOutcomeHandler>();

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Register the owning module's callback for an entity type. Other modules import
   * `WorkflowService` (the module exports it) and call this once at startup; starting a
   * workflow is then `startWorkflow(...)` with no further coupling.
   */
  registerOutcomeHandler(handler: WorkflowOutcomeHandler): void {
    if (this.outcomeHandlers.has(handler.entityType)) {
      throw new InternalError(
        `A workflow outcome handler for entity type "${handler.entityType}" is already registered`,
      );
    }
    this.outcomeHandlers.set(handler.entityType, handler);
  }

  // ───────────────────────────────────────────────────────────────────────────────────
  // Definitions
  // ───────────────────────────────────────────────────────────────────────────────────

  async listDefinitions(
    principal: Principal,
    query: ListWorkflowDefinitionsQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<DefinitionRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [];

      if (!query.includeArchived) {
        filters.push(isNull(workflowDefinitions.archivedAt));
      } else if (!can(principal, 'workflows.manage')) {
        throw new ForbiddenError('workflows.manage', 'You cannot view archived definitions');
      }
      if (!query.includeInactive) filters.push(eq(workflowDefinitions.isActive, true));

      const institutionId = currentContext()?.institutionId;
      if (institutionId) filters.push(eq(workflowDefinitions.institutionId, institutionId));
      if (query.key) filters.push(eq(workflowDefinitions.key, query.key));
      if (query.entityType) filters.push(eq(workflowDefinitions.entityType, query.entityType));
      if (query.q) filters.push(ilike(workflowDefinitions.nameEn, `%${query.q}%`));

      const where = and(...filters);
      const orderBy = parseSort(query.sort, WORKFLOW_DEFINITION_SORT_FIELDS, {
        field: 'key',
        direction: 'asc',
      }).map((spec) => {
        const column = DEFINITION_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(workflowDefinitions)
        .where(where)
        .orderBy(...orderBy, asc(workflowDefinitions.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(workflowDefinitions)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async getDefinition(
    principal: Principal,
    id: string,
  ): Promise<DefinitionRow & { steps: StepRow[] }> {
    return this.db.runInTenant(async (tx) => {
      const [definition] = await tx
        .select()
        .from(workflowDefinitions)
        .where(eq(workflowDefinitions.id, id))
        .limit(1);
      if (!definition) throw new NotFoundError('Workflow definition', id);
      if (definition.archivedAt && !can(principal, 'workflows.manage')) {
        throw new NotFoundError('Workflow definition', id);
      }
      const steps = await this.loadSteps(tx, definition.id);
      return { ...definition, steps };
    });
  }

  async createDefinition(
    principal: Principal,
    institutionId: string,
    input: CreateWorkflowDefinitionInput,
  ): Promise<DefinitionRow & { steps: StepRow[] }> {
    this.assertStepPermissionsExist(input.steps);

    return this.db.runInTenant(async (tx) => {
      const tenantId = principal.tenantId!;

      const [existing] = await tx
        .select({ id: workflowDefinitions.id })
        .from(workflowDefinitions)
        .where(
          and(
            eq(workflowDefinitions.institutionId, institutionId),
            eq(workflowDefinitions.key, input.key),
            isNull(workflowDefinitions.archivedAt),
          ),
        )
        .limit(1);
      if (existing) {
        throw new ConflictError(
          `A workflow definition with the key "${input.key}" already exists. ` +
            `Edit it to create a new version instead of creating a duplicate.`,
          { existingDefinitionId: existing.id },
        );
      }

      const definitionId = uuidv7();
      const [definition] = await tx
        .insert(workflowDefinitions)
        .values({
          id: definitionId,
          tenantId,
          institutionId,
          key: input.key,
          nameEn: input.name,
          nameBn: input.nameBn ?? null,
          entityType: input.entityType,
          description: input.description ?? null,
          version: 1,
          isActive: true,
          isSystem: false,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      if (!definition) throw new ConflictError('The workflow definition could not be created');

      const steps = await this.insertSteps(tx, principal, definition, input.steps);
      return { ...definition, steps };
    });
  }

  /**
   * Edit a definition. An **active definition is immutable**: this inserts a new row with
   * `version + 1` carrying the edits, and deactivates the old row in the same transaction.
   * Requests already running keep their `definition_id`, so their steps never change under
   * them. Only the active version can be edited — editing a superseded version would fork
   * the history.
   */
  async updateDefinition(
    principal: Principal,
    id: string,
    input: UpdateWorkflowDefinitionInput,
  ): Promise<{
    definition: DefinitionRow & { steps: StepRow[] };
    previous: { id: string; version: number };
  }> {
    if (input.steps) this.assertStepPermissionsExist(input.steps);

    return this.db.runInTenant(async (tx) => {
      const [current] = await tx
        .select()
        .from(workflowDefinitions)
        .where(and(eq(workflowDefinitions.id, id), isNull(workflowDefinitions.archivedAt)))
        .limit(1);
      if (!current) throw new NotFoundError('Workflow definition', id);

      if (!current.isActive) {
        throw new ConflictError(
          'Only the active version of a workflow definition can be edited. ' +
            'This version has been superseded; edit the active one.',
          { definitionId: id, version: current.version },
        );
      }
      if (input.version !== current.version) {
        throw new ConflictError(
          'This definition was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: input.version, currentVersion: current.version },
        );
      }

      const currentSteps = await this.loadSteps(tx, current.id);

      // Deactivate first so the "one active version per key" partial unique index cannot
      // refuse the insert that follows.
      const [deactivated] = await tx
        .update(workflowDefinitions)
        .set({ isActive: false, updatedBy: principal.userId })
        .where(and(eq(workflowDefinitions.id, current.id), eq(workflowDefinitions.isActive, true)))
        .returning();
      if (!deactivated) {
        throw new ConflictError(
          'This definition was changed by someone else while you were editing. Reload and try again.',
        );
      }

      const newId = uuidv7();
      const [created] = await tx
        .insert(workflowDefinitions)
        .values({
          id: newId,
          tenantId: current.tenantId,
          institutionId: current.institutionId,
          key: current.key,
          nameEn: input.name ?? current.nameEn,
          nameBn: input.nameBn ?? current.nameBn,
          entityType: current.entityType,
          description: input.description ?? current.description,
          version: current.version + 1,
          isActive: true,
          isSystem: current.isSystem,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      if (!created) throw new ConflictError('The new definition version could not be created');

      const stepInputs: WorkflowStepInput[] =
        input.steps ??
        currentSteps.map((step) => ({
          sequence: step.sequence,
          name: step.nameEn,
          nameBn: step.nameBn ?? undefined,
          approverPermission: step.approverPermission,
          approverScope: step.approverScope,
          isOptional: step.isOptional,
          slaHours: step.slaHours ?? undefined,
          escalationPermission: step.escalationPermission ?? undefined,
          onReject: step.onReject,
        }));

      const steps = await this.insertSteps(tx, principal, created, stepInputs);
      return {
        definition: { ...created, steps },
        previous: { id: current.id, version: current.version },
      };
    });
  }

  async archiveDefinition(
    principal: Principal,
    id: string,
    reason: string,
  ): Promise<DefinitionRow> {
    return this.db.runInTenant(async (tx) => {
      const [current] = await tx
        .select()
        .from(workflowDefinitions)
        .where(and(eq(workflowDefinitions.id, id), isNull(workflowDefinitions.archivedAt)))
        .limit(1);
      if (!current) throw new NotFoundError('Workflow definition', id);

      const [archived] = await tx
        .update(workflowDefinitions)
        .set({
          isActive: false,
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
        })
        .where(eq(workflowDefinitions.id, id))
        .returning();
      if (!archived) throw new ConflictError('The workflow definition could not be archived');
      return archived;
    });
  }

  // ───────────────────────────────────────────────────────────────────────────────────
  // Requests
  // ───────────────────────────────────────────────────────────────────────────────────

  /**
   * The generic entry point other modules call: start a workflow for an entity without
   * coupling to the engine's tables. The definition is resolved by key (active version
   * only), the entity type comes from the definition, and the caller gets the created
   * request back. Combine with `registerOutcomeHandler` for the full round trip.
   */
  async startWorkflow(
    principal: Principal,
    institutionId: string,
    input: CreateWorkflowRequestInput,
  ): Promise<RequestRow> {
    return this.db.runInTenant(async (tx) => {
      const tenantId = principal.tenantId!;

      const [definition] = await tx
        .select()
        .from(workflowDefinitions)
        .where(
          and(
            eq(workflowDefinitions.institutionId, institutionId),
            eq(workflowDefinitions.key, input.definitionKey),
            eq(workflowDefinitions.isActive, true),
            isNull(workflowDefinitions.archivedAt),
          ),
        )
        .limit(1);
      if (!definition) {
        throw new NotFoundError('Active workflow definition', input.definitionKey);
      }

      const steps = await this.loadSteps(tx, definition.id);
      const firstStep = steps[0];
      if (!firstStep) {
        throw new InternalError(
          `Workflow definition ${definition.id} has no steps; it cannot accept requests`,
        );
      }

      const [open] = await tx
        .select({ id: workflowRequests.id })
        .from(workflowRequests)
        .where(
          and(
            eq(workflowRequests.entityType, definition.entityType),
            eq(workflowRequests.entityId, input.entityId),
            inArray(workflowRequests.status, [...ACTIONABLE_STATUSES, 'draft']),
            isNull(workflowRequests.archivedAt),
          ),
        )
        .limit(1);
      if (open) {
        throw new ConflictError(
          'An approval request for this record is already in progress. ' +
            'Wait for it to be decided, or cancel it first.',
          { existingRequestId: open.id },
        );
      }

      const now = new Date();
      const [request] = await tx
        .insert(workflowRequests)
        .values({
          id: uuidv7(),
          tenantId,
          institutionId,
          campusId: currentContext()?.campusId ?? null,
          definitionId: definition.id,
          definitionVersion: definition.version,
          entityType: definition.entityType,
          entityId: input.entityId,
          initiatedBy: principal.userId,
          initiatedAt: now,
          currentStepSequence: firstStep.sequence,
          status: 'pending',
          dueAt: this.dueAtFor(firstStep, now),
          payload: input.payload ?? {},
          summary: input.summary,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      if (!request) throw new ConflictError('The workflow request could not be created');
      return request;
    });
  }

  async listRequests(
    principal: Principal,
    query: ListWorkflowRequestsQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<RequestRow>> {
    if (query.view === 'all' && !can(principal, 'workflows.view')) {
      throw new ForbiddenError('workflows.view', 'You cannot view all workflow requests');
    }

    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [isNull(workflowRequests.archivedAt)];

      const institutionId = currentContext()?.institutionId;
      if (institutionId) filters.push(eq(workflowRequests.institutionId, institutionId));
      if (query.status) filters.push(eq(workflowRequests.status, query.status));
      if (query.entityType) filters.push(eq(workflowRequests.entityType, query.entityType));
      if (query.definitionKey) filters.push(this.definitionKeyFilter(query.definitionKey));
      if (query.q) filters.push(ilike(workflowRequests.summary, `%${query.q}%`));

      if (query.view === 'mine') {
        filters.push(eq(workflowRequests.initiatedBy, principal.userId));
      }

      if (query.view === 'awaiting') {
        return this.listAwaiting(tx, principal, filters, page);
      }

      const where = and(...filters);
      const orderBy = this.requestOrder(query.sort);

      const rows = await tx
        .select()
        .from(workflowRequests)
        .where(where)
        .orderBy(...orderBy, asc(workflowRequests.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(workflowRequests)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  /**
   * Requests past their `due_at`. The scheduler that will *act* on these (escalation) is
   * Phase 26; this report exists now so a principal can see the backlog without one.
   */
  async listOverdue(
    principal: Principal,
    query: ListOverdueWorkflowRequestsQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<RequestRow>> {
    if (!can(principal, 'workflows.view')) {
      throw new ForbiddenError('workflows.view', 'You cannot view the overdue report');
    }

    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [
        isNull(workflowRequests.archivedAt),
        inArray(workflowRequests.status, [...ACTIONABLE_STATUSES]),
        lt(workflowRequests.dueAt, new Date()),
      ];
      const institutionId = currentContext()?.institutionId;
      if (institutionId) filters.push(eq(workflowRequests.institutionId, institutionId));
      if (query.definitionKey) filters.push(this.definitionKeyFilter(query.definitionKey));

      const where = and(...filters);
      const rows = await tx
        .select()
        .from(workflowRequests)
        .where(where)
        .orderBy(asc(workflowRequests.dueAt), asc(workflowRequests.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(workflowRequests)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  /** One request with its definition, step list and full, never-rewritten history. */
  async getRequest(
    principal: Principal,
    id: string,
  ): Promise<{
    request: RequestRow;
    definition: { id: string; key: string; nameEn: string; version: number };
    steps: StepRow[];
    history: ActionRow[];
  }> {
    return this.db.runInTenant(async (tx) => {
      const request = await this.loadRequest(tx, id);
      await this.assertVisible(tx, principal, request);

      const [definition] = await tx
        .select()
        .from(workflowDefinitions)
        .where(eq(workflowDefinitions.id, request.definitionId))
        .limit(1);
      if (!definition) throw new InternalError(`Definition ${request.definitionId} is missing`);

      const steps = await this.loadSteps(tx, request.definitionId);
      const history = await tx
        .select()
        .from(workflowActions)
        .where(eq(workflowActions.requestId, request.id))
        .orderBy(asc(workflowActions.actedAt), asc(workflowActions.id));

      return {
        request,
        definition: {
          id: definition.id,
          key: definition.key,
          nameEn: definition.nameEn,
          version: definition.version,
        },
        steps,
        history,
      };
    });
  }

  async approve(
    principal: Principal,
    requestId: string,
    input: { comment?: string },
  ): Promise<RequestRow> {
    return this.db.runInTenant(async (tx) => {
      const request = await this.loadRequest(tx, requestId);
      this.assertActionable(request, 'approved');
      const steps = await this.loadSteps(tx, request.definitionId);
      const step = this.currentStep(request, steps);
      const acting = await this.assertMayDecide(tx, principal, request, step);

      // Skip optional later steps that have nobody eligible to act, so a definition with an
      // optional "department head" step still completes in a school that has none.
      let next: StepRow | null = null;
      for (const candidate of steps.filter((s) => s.sequence > step.sequence)) {
        if (candidate.isOptional) {
          const eligible = await this.eligibleApprovers(tx, request, candidate);
          if (eligible.size === 0) continue;
        }
        next = candidate;
        break;
      }

      const now = new Date();
      await this.recordAction(tx, principal, request, {
        stepSequence: step.sequence,
        action: 'approve',
        comment: input.comment ?? null,
        onBehalfOfUserId: acting.onBehalfOfUserId,
        actedAt: now,
      });

      const targetStatus: RequestStatus = next ? 'pending' : 'approved';
      const updated = await this.transition(tx, principal, request, {
        status: targetStatus,
        currentStepSequence: next ? next.sequence : step.sequence,
        dueAt: next ? this.dueAtFor(next, now) : null,
        decidedAt: next ? null : now,
      });

      await this.auditTransition(tx, principal, request, updated, 'approve', input.comment);

      if (!next) await this.notifyOutcome(tx, updated, 'approved');
      return updated;
    });
  }

  async reject(
    principal: Principal,
    requestId: string,
    input: { comment: string },
  ): Promise<RequestRow> {
    return this.db.runInTenant(async (tx) => {
      const request = await this.loadRequest(tx, requestId);
      this.assertActionable(request, 'rejected');
      const steps = await this.loadSteps(tx, request.definitionId);
      const step = this.currentStep(request, steps);
      const acting = await this.assertMayDecide(tx, principal, request, step);

      const now = new Date();
      await this.recordAction(tx, principal, request, {
        stepSequence: step.sequence,
        action: 'reject',
        comment: input.comment,
        onBehalfOfUserId: acting.onBehalfOfUserId,
        actedAt: now,
      });

      const earlier = steps.filter((s) => s.sequence < step.sequence);
      const previousStep = earlier.length > 0 ? earlier[earlier.length - 1]! : null;
      const firstStep = steps[0]!;

      let updated: RequestRow;
      if (step.onReject === 'send_back') {
        // Back to the beginning for rework; every earlier approval stays in the history.
        updated = await this.transition(tx, principal, request, {
          status: 'sent_back',
          currentStepSequence: firstStep.sequence,
          dueAt: this.dueAtFor(firstStep, now),
          decidedAt: null,
        });
      } else if (step.onReject === 'previous_step' && previousStep) {
        updated = await this.transition(tx, principal, request, {
          status: 'sent_back',
          currentStepSequence: previousStep.sequence,
          dueAt: this.dueAtFor(previousStep, now),
          decidedAt: null,
        });
      } else {
        // 'terminate', or 'previous_step' at the first step (there is no previous step).
        updated = await this.transition(tx, principal, request, {
          status: 'rejected',
          currentStepSequence: step.sequence,
          dueAt: null,
          decidedAt: now,
        });
      }

      await this.auditTransition(tx, principal, request, updated, 'reject', input.comment);

      if (updated.status === 'rejected') await this.notifyOutcome(tx, updated, 'rejected');
      return updated;
    });
  }

  /**
   * Return the request to a named earlier step. The history is preserved — this appends a
   * `send_back` action; it never rewrites or removes the decisions taken since that step.
   */
  async sendBack(
    principal: Principal,
    requestId: string,
    input: { targetSequence: number; comment: string },
  ): Promise<RequestRow> {
    return this.db.runInTenant(async (tx) => {
      const request = await this.loadRequest(tx, requestId);
      this.assertActionable(request, 'sent_back');
      const steps = await this.loadSteps(tx, request.definitionId);
      const step = this.currentStep(request, steps);
      const acting = await this.assertMayDecide(tx, principal, request, step);

      const target = steps.find((s) => s.sequence === input.targetSequence);
      if (!target || target.sequence >= step.sequence) {
        throw new ValidationError('The request can only be sent back to an earlier step', [
          {
            path: 'targetSequence',
            message: `Choose a step before the current one (step ${step.sequence})`,
          },
        ]);
      }

      const now = new Date();
      await this.recordAction(tx, principal, request, {
        stepSequence: step.sequence,
        action: 'send_back',
        comment: input.comment,
        onBehalfOfUserId: acting.onBehalfOfUserId,
        actedAt: now,
      });

      const updated = await this.transition(tx, principal, request, {
        status: 'sent_back',
        currentStepSequence: target.sequence,
        dueAt: this.dueAtFor(target, now),
        decidedAt: null,
      });

      await this.auditTransition(tx, principal, request, updated, 'update', input.comment);
      return updated;
    });
  }

  /** Cancellation belongs to the initiator (withdrawing their own request) or an admin. */
  async cancel(
    principal: Principal,
    requestId: string,
    input: { comment: string },
  ): Promise<RequestRow> {
    return this.db.runInTenant(async (tx) => {
      const request = await this.loadRequest(tx, requestId);

      if (request.initiatedBy !== principal.userId && !can(principal, 'workflows.manage')) {
        throw new ForbiddenError(
          'workflows.manage',
          'Only the person who raised a request, or a workflow administrator, can cancel it',
        );
      }
      this.assertTransition(request.status, 'cancelled');

      const now = new Date();
      await this.recordAction(tx, principal, request, {
        stepSequence: request.currentStepSequence,
        action: 'cancel',
        comment: input.comment,
        onBehalfOfUserId: null,
        actedAt: now,
      });

      const updated = await this.transition(tx, principal, request, {
        status: 'cancelled',
        currentStepSequence: request.currentStepSequence,
        dueAt: null,
        decidedAt: now,
      });

      await this.auditTransition(tx, principal, request, updated, 'update', input.comment);
      return updated;
    });
  }

  /** A comment is conversation, not a decision: it never moves the state machine. */
  async comment(
    principal: Principal,
    requestId: string,
    input: { comment: string },
  ): Promise<ActionRow> {
    return this.db.runInTenant(async (tx) => {
      const request = await this.loadRequest(tx, requestId);
      await this.assertVisible(tx, principal, request);

      const [action] = await tx
        .insert(workflowActions)
        .values({
          id: uuidv7(),
          tenantId: request.tenantId,
          requestId: request.id,
          stepSequence: request.currentStepSequence,
          actorUserId: principal.userId,
          onBehalfOfUserId: null,
          action: 'comment',
          comment: input.comment,
          actedAt: new Date(),
          createdBy: principal.userId,
        })
        .returning();
      if (!action) throw new ConflictError('The comment could not be recorded');
      return action;
    });
  }

  // ───────────────────────────────────────────────────────────────────────────────────
  // Delegations
  // ───────────────────────────────────────────────────────────────────────────────────

  async listDelegations(
    principal: Principal,
    query: ListWorkflowDelegationsQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<DelegationRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [];

      if (!query.includeArchived) {
        filters.push(isNull(workflowDelegations.archivedAt));
      } else if (!can(principal, 'workflows.manage')) {
        throw new ForbiddenError('workflows.manage', 'You cannot view revoked delegations');
      }
      if (!query.includeExpired) {
        filters.push(gte(workflowDelegations.toDate, todayInDhaka()));
      }
      if (!can(principal, 'workflows.manage')) {
        // Without the admin permission you see only delegations you are a party to.
        filters.push(
          or(
            eq(workflowDelegations.fromUserId, principal.userId),
            eq(workflowDelegations.toUserId, principal.userId),
          )!,
        );
      }

      const where = filters.length > 0 ? and(...filters) : undefined;
      const orderBy = parseSort(query.sort, WORKFLOW_DELEGATION_SORT_FIELDS, {
        field: 'fromDate',
        direction: 'desc',
      }).map((spec) => {
        const column = DELEGATION_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(workflowDelegations)
        .where(where)
        .orderBy(...orderBy, asc(workflowDelegations.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(workflowDelegations)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async createDelegation(
    principal: Principal,
    input: CreateWorkflowDelegationInput,
  ): Promise<DelegationRow> {
    const fromUserId = input.fromUserId ?? principal.userId;
    if (fromUserId !== principal.userId && !can(principal, 'workflows.manage')) {
      throw new ForbiddenError(
        'workflows.manage',
        'You can only delegate your own approval authority',
      );
    }
    if (fromUserId === input.toUserId) {
      throw new ValidationError('A delegation to yourself would change nothing', [
        { path: 'toUserId', message: 'Choose a different person' },
      ]);
    }

    return this.db.runInTenant(async (tx) => {
      // RLS scopes this lookup to the tenant, so a foreign user id resolves to "not found"
      // rather than confirming its existence elsewhere.
      const [delegate] = await tx
        .select({ id: users.id, status: users.status })
        .from(users)
        .where(and(eq(users.id, input.toUserId), isNull(users.archivedAt)))
        .limit(1);
      if (!delegate) throw new NotFoundError('User', input.toUserId);
      if (delegate.status !== 'active') {
        throw new ValidationError('The delegate must be an active user', [
          { path: 'toUserId', message: 'This account is not active' },
        ]);
      }

      const [delegation] = await tx
        .insert(workflowDelegations)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          fromUserId,
          toUserId: input.toUserId,
          fromDate: input.fromDate,
          toDate: input.toDate,
          reason: input.reason,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      if (!delegation) throw new ConflictError('The delegation could not be created');
      return delegation;
    });
  }

  async revokeDelegation(principal: Principal, id: string, reason: string): Promise<DelegationRow> {
    return this.db.runInTenant(async (tx) => {
      const [delegation] = await tx
        .select()
        .from(workflowDelegations)
        .where(and(eq(workflowDelegations.id, id), isNull(workflowDelegations.archivedAt)))
        .limit(1);
      if (!delegation) throw new NotFoundError('Workflow delegation', id);

      if (delegation.fromUserId !== principal.userId && !can(principal, 'workflows.manage')) {
        // 404, not 403: a delegation you are not a party to should not be confirmed to exist.
        throw new NotFoundError('Workflow delegation', id);
      }

      const [revoked] = await tx
        .update(workflowDelegations)
        .set({
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
        })
        .where(eq(workflowDelegations.id, id))
        .returning();
      if (!revoked) throw new ConflictError('The delegation could not be revoked');
      return revoked;
    });
  }

  // ───────────────────────────────────────────────────────────────────────────────────
  // Approver resolution
  // ───────────────────────────────────────────────────────────────────────────────────

  /**
   * The users who may decide the given step of the given request: everyone holding the
   * step's `approver_permission` within the request's institution (narrowed by campus or
   * department when the step says so), **minus the initiator**, **minus anyone who already
   * made a decisive action at an earlier step** (four-eyes across steps). Delegates are not
   * expanded here — delegation is checked per-actor in `assertMayDecide`, where the acting
   * person is known.
   */
  private async eligibleApprovers(
    tx: Transaction,
    request: RequestRow,
    step: StepRow,
  ): Promise<Set<string>> {
    const candidates = await this.candidateApprovers(tx, request, step);
    candidates.delete(request.initiatedBy);
    const prior = await this.priorDecisiveActors(tx, request.id, step.sequence);
    for (const actor of prior) candidates.delete(actor);
    return candidates;
  }

  /** Everyone holding the step's permission within the request's scope. By permission, never by name. */
  private async candidateApprovers(
    tx: Transaction,
    request: RequestRow,
    step: StepRow,
  ): Promise<Set<string>> {
    const now = new Date();
    const rows = await tx
      .select({
        userId: userRoles.userId,
        permissions: roles.permissions,
        grantCampusId: userRoles.campusId,
      })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .innerJoin(users, eq(userRoles.userId, users.id))
      .where(
        and(
          eq(users.status, 'active'),
          isNull(users.archivedAt),
          isNull(roles.archivedAt),
          or(isNull(userRoles.institutionId), eq(userRoles.institutionId, request.institutionId)),
          or(isNull(userRoles.validFrom), lte(userRoles.validFrom, now)),
          or(isNull(userRoles.validUntil), gte(userRoles.validUntil, now)),
        ),
      );

    const holders = new Set<string>();
    for (const row of rows) {
      if (step.approverScope === 'campus' && request.campusId) {
        if (row.grantCampusId && row.grantCampusId !== request.campusId) continue;
      }
      const grants = Array.isArray(row.permissions) ? (row.permissions as unknown[]) : [];
      const covers = grants.some(
        (granted) => typeof granted === 'string' && grantCovers(granted, step.approverPermission),
      );
      if (covers) holders.add(row.userId);
    }

    if (step.approverScope === 'department' && holders.size > 0) {
      const departmentId = await this.departmentOfUser(tx, request.initiatedBy);
      // No department on the initiator means the narrowing has nothing to narrow by; the
      // step then behaves as institution-scoped rather than silently matching nobody.
      if (departmentId) {
        const employeeRows = await tx
          .select({ userId: employees.userId, departmentId: employees.departmentId })
          .from(employees)
          .where(and(inArray(employees.userId, [...holders]), isNull(employees.archivedAt)));
        const byUser = new Map(employeeRows.map((row) => [row.userId, row.departmentId]));
        for (const holder of [...holders]) {
          if (byUser.get(holder) !== departmentId) holders.delete(holder);
        }
      }
    }

    return holders;
  }

  private async departmentOfUser(tx: Transaction, userId: string): Promise<string | null> {
    const [row] = await tx
      .select({ departmentId: employees.departmentId })
      .from(employees)
      .where(and(eq(employees.userId, userId), isNull(employees.archivedAt)))
      .limit(1);
    return row?.departmentId ?? null;
  }

  /** User ids that made a decisive action (approve/reject/send back) before `beforeSequence`. */
  private async priorDecisiveActors(
    tx: Transaction,
    requestId: string,
    beforeSequence: number,
  ): Promise<Set<string>> {
    const rows = await tx
      .select({
        actorUserId: workflowActions.actorUserId,
        onBehalfOfUserId: workflowActions.onBehalfOfUserId,
      })
      .from(workflowActions)
      .where(
        and(
          eq(workflowActions.requestId, requestId),
          inArray(workflowActions.action, [...DECISIVE_ACTIONS]),
          lt(workflowActions.stepSequence, beforeSequence),
        ),
      );
    const actors = new Set<string>();
    for (const row of rows) {
      actors.add(row.actorUserId);
      // A delegator whose delegate acted has spent their pair of eyes too — otherwise a
      // delegation would be a way around the four-eyes rule.
      if (row.onBehalfOfUserId) actors.add(row.onBehalfOfUserId);
    }
    return actors;
  }

  /**
   * May this principal decide the current step? Throws otherwise. The check order is the
   * security design:
   *
   *  1. **Initiator exclusion (KI-002), before any permission is consulted.** Permissions
   *     cannot express "not this person"; the school owner holds `*` and is still refused.
   *  2. **Four-eyes across steps**: a decisive action at an earlier step disqualifies.
   *  3. Direct eligibility by the step's permission within its scope.
   *  4. Delegation: a delegate acts only inside the window, only for a delegator who would
   *     themselves be eligible — and rules 1 and 2 have already been applied to the
   *     delegate, and are applied to the delegator here.
   */
  private async assertMayDecide(
    tx: Transaction,
    principal: Principal,
    request: RequestRow,
    step: StepRow,
  ): Promise<ActingRights> {
    if (request.initiatedBy === principal.userId) {
      throw new ForbiddenError(
        undefined,
        'You may not decide your own request. Approvals require a second person, ' +
          'regardless of the permissions you hold.',
      );
    }

    const prior = await this.priorDecisiveActors(tx, request.id, step.sequence);
    if (prior.has(principal.userId)) {
      throw new ForbiddenError(
        undefined,
        'You have already acted on this request at an earlier step; a different approver ' +
          'must decide this one.',
      );
    }

    if (await this.isDirectlyEligible(tx, principal, request, step)) {
      return { onBehalfOfUserId: null };
    }

    // Not directly eligible — an active delegation from an eligible approver still allows it.
    const today = todayInDhaka();
    const delegations = await tx
      .select()
      .from(workflowDelegations)
      .where(
        and(
          eq(workflowDelegations.toUserId, principal.userId),
          isNull(workflowDelegations.archivedAt),
          lte(workflowDelegations.fromDate, today),
          gte(workflowDelegations.toDate, today),
        ),
      );

    if (delegations.length > 0) {
      const candidates = await this.candidateApprovers(tx, request, step);
      for (const delegation of delegations) {
        if (delegation.fromUserId === request.initiatedBy) continue;
        if (prior.has(delegation.fromUserId)) continue;
        if (candidates.has(delegation.fromUserId)) {
          return { onBehalfOfUserId: delegation.fromUserId };
        }
      }
    }

    throw new ForbiddenError(
      step.approverPermission,
      'You are not an eligible approver for this step',
    );
  }

  private async isDirectlyEligible(
    tx: Transaction,
    principal: Principal,
    request: RequestRow,
    step: StepRow,
  ): Promise<boolean> {
    if (principal.isPlatformAdmin) return true;

    const context = {
      institutionId: request.institutionId,
      campusId: step.approverScope === 'campus' ? (request.campusId ?? undefined) : undefined,
    };
    if (!can(principal, step.approverPermission, context)) return false;

    if (step.approverScope === 'department') {
      const initiatorDepartment = await this.departmentOfUser(tx, request.initiatedBy);
      if (initiatorDepartment) {
        const actorDepartment = await this.departmentOfUser(tx, principal.userId);
        if (actorDepartment !== initiatorDepartment) return false;
      }
    }
    return true;
  }

  // ───────────────────────────────────────────────────────────────────────────────────
  // Internals
  // ───────────────────────────────────────────────────────────────────────────────────

  private async loadRequest(tx: Transaction, id: string): Promise<RequestRow> {
    const [request] = await tx
      .select()
      .from(workflowRequests)
      .where(and(eq(workflowRequests.id, id), isNull(workflowRequests.archivedAt)))
      .limit(1);
    if (!request) throw new NotFoundError('Workflow request', id);
    return request;
  }

  private async loadSteps(tx: Transaction, definitionId: string): Promise<StepRow[]> {
    return tx
      .select()
      .from(workflowSteps)
      .where(and(eq(workflowSteps.definitionId, definitionId), isNull(workflowSteps.archivedAt)))
      .orderBy(asc(workflowSteps.sequence));
  }

  private currentStep(request: RequestRow, steps: StepRow[]): StepRow {
    const step = steps.find((s) => s.sequence === request.currentStepSequence);
    if (!step) {
      throw new InternalError(
        `Request ${request.id} points at step ${request.currentStepSequence}, ` +
          `which does not exist on definition ${request.definitionId}`,
      );
    }
    return step;
  }

  /** State-machine gate for the decision endpoints, thrown before any eligibility work. */
  private assertActionable(request: RequestRow, attempted: RequestStatus): void {
    if (!ACTIONABLE_STATUSES.includes(request.status)) {
      throw new WorkflowStateError(request.status, attempted, 'workflow request');
    }
  }

  private assertTransition(from: RequestStatus, to: RequestStatus): void {
    if (!REQUEST_TRANSITIONS[from]?.includes(to)) {
      throw new WorkflowStateError(from, to, 'workflow request');
    }
  }

  /**
   * Apply a state change under the optimistic lock. The version predicate means two
   * concurrent decisions cannot both apply: the second sees zero rows and gets a 409.
   */
  private async transition(
    tx: Transaction,
    principal: Principal,
    request: RequestRow,
    change: {
      status: RequestStatus;
      currentStepSequence: number;
      dueAt: Date | null;
      decidedAt: Date | null;
    },
  ): Promise<RequestRow> {
    this.assertTransition(request.status, change.status);

    const [updated] = await tx
      .update(workflowRequests)
      .set({
        status: change.status,
        currentStepSequence: change.currentStepSequence,
        dueAt: change.dueAt,
        decidedAt: change.decidedAt,
        version: request.version + 1,
        updatedBy: principal.userId,
      })
      .where(
        and(eq(workflowRequests.id, request.id), eq(workflowRequests.version, request.version)),
      )
      .returning();

    if (!updated) {
      throw new ConflictError(
        'This request was decided by someone else while you were acting. Reload and try again.',
        { expectedVersion: request.version },
      );
    }
    return updated;
  }

  private async recordAction(
    tx: Transaction,
    principal: Principal,
    request: RequestRow,
    action: {
      stepSequence: number;
      action: ActionRow['action'];
      comment: string | null;
      onBehalfOfUserId: string | null;
      actedAt: Date;
    },
  ): Promise<void> {
    await tx.insert(workflowActions).values({
      id: uuidv7(),
      tenantId: request.tenantId,
      requestId: request.id,
      stepSequence: action.stepSequence,
      actorUserId: principal.userId,
      onBehalfOfUserId: action.onBehalfOfUserId,
      action: action.action,
      comment: action.comment,
      actedAt: action.actedAt,
      createdBy: principal.userId,
    });
  }

  /**
   * The audit record for a transition, written inside the deciding transaction: the state
   * change and its trail commit or roll back together (docs/00 §5 — a sensitive mutation
   * without an audit record is incomplete).
   */
  private async auditTransition(
    tx: Transaction,
    principal: Principal,
    before: RequestRow,
    after: RequestRow,
    action: 'approve' | 'reject' | 'update',
    reason: string | undefined,
  ): Promise<void> {
    const context = currentContext();
    await this.audit.recordInTransaction(tx, {
      tenantId: before.tenantId,
      institutionId: before.institutionId,
      campusId: before.campusId,
      actorUserId: principal.userId,
      actorRoles: principal.roles.map((role) => role.roleKey),
      action,
      module: 'workflow',
      resourceType: 'workflow_request',
      resourceId: before.id,
      resourceLabel: before.summary,
      previousValue: { status: before.status, step: before.currentStepSequence },
      newValue: { status: after.status, step: after.currentStepSequence },
      reason: reason ?? null,
      requestId: context?.requestId ?? null,
      ipAddress: context?.ipAddress ?? null,
      userAgent: context?.userAgent ?? null,
    });
  }

  /** Hand a terminal outcome to the owning module, inside the deciding transaction. */
  private async notifyOutcome(
    tx: Transaction,
    request: RequestRow,
    status: 'approved' | 'rejected',
  ): Promise<void> {
    const handler = this.outcomeHandlers.get(request.entityType);
    if (!handler) return;

    const [definition] = await tx
      .select({ key: workflowDefinitions.key })
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.id, request.definitionId))
      .limit(1);

    await handler.onOutcome(tx, {
      requestId: request.id,
      tenantId: request.tenantId,
      institutionId: request.institutionId,
      definitionKey: definition?.key ?? '',
      entityType: request.entityType,
      entityId: request.entityId,
      status,
      payload: (request.payload ?? {}) as Record<string, unknown>,
    });
  }

  /**
   * Who may read a request: `workflows.view`, the initiator, anyone who has acted on it,
   * or an eligible approver of its current step. Everyone else gets a 404 — within or
   * across tenants, confirming the record exists is itself a leak.
   */
  private async assertVisible(
    tx: Transaction,
    principal: Principal,
    request: RequestRow,
  ): Promise<void> {
    if (can(principal, 'workflows.view', { institutionId: request.institutionId })) return;
    if (request.initiatedBy === principal.userId) return;

    const [acted] = await tx
      .select({ id: workflowActions.id })
      .from(workflowActions)
      .where(
        and(
          eq(workflowActions.requestId, request.id),
          eq(workflowActions.actorUserId, principal.userId),
        ),
      )
      .limit(1);
    if (acted) return;

    if (
      ACTIONABLE_STATUSES.includes(request.status) &&
      can(principal, 'workflows.act', { institutionId: request.institutionId })
    ) {
      const steps = await this.loadSteps(tx, request.definitionId);
      const step = steps.find((s) => s.sequence === request.currentStepSequence);
      if (step && (await this.mayDecide(tx, principal, request, step))) return;
    }

    throw new NotFoundError('Workflow request', request.id);
  }

  /** Non-throwing form of `assertMayDecide`, for visibility checks and the awaiting list. */
  private async mayDecide(
    tx: Transaction,
    principal: Principal,
    request: RequestRow,
    step: StepRow,
  ): Promise<boolean> {
    try {
      await this.assertMayDecide(tx, principal, request, step);
      return true;
    } catch (error) {
      if (error instanceof ForbiddenError) return false;
      throw error;
    }
  }

  /**
   * "Awaiting my action": actionable requests whose current step this principal could
   * decide right now. Eligibility involves permission matching that SQL cannot express, so
   * a bounded window is fetched and filtered here; the window comfortably covers any real
   * school's open approvals.
   */
  private async listAwaiting(
    tx: Transaction,
    principal: Principal,
    filters: SQL[],
    page: OffsetPageRequest,
  ): Promise<OffsetPage<RequestRow>> {
    const where = and(...filters, inArray(workflowRequests.status, [...ACTIONABLE_STATUSES]));

    const window = await tx
      .select()
      .from(workflowRequests)
      .where(where)
      .orderBy(asc(workflowRequests.initiatedAt), asc(workflowRequests.id))
      .limit(500);

    const stepsByDefinition = new Map<string, StepRow[]>();
    const eligible: RequestRow[] = [];
    for (const request of window) {
      let steps = stepsByDefinition.get(request.definitionId);
      if (!steps) {
        steps = await this.loadSteps(tx, request.definitionId);
        stepsByDefinition.set(request.definitionId, steps);
      }
      const step = steps.find((s) => s.sequence === request.currentStepSequence);
      if (!step) continue;
      if (await this.mayDecide(tx, principal, request, step)) eligible.push(request);
    }

    const start = offsetOf(page);
    return buildOffsetPage(eligible.slice(start, start + page.pageSize), eligible.length, page);
  }

  private async insertSteps(
    tx: Transaction,
    principal: Principal,
    definition: DefinitionRow,
    inputs: readonly WorkflowStepInput[],
  ): Promise<StepRow[]> {
    const rows = await tx
      .insert(workflowSteps)
      .values(
        inputs.map((step) => ({
          id: uuidv7(),
          tenantId: definition.tenantId,
          definitionId: definition.id,
          sequence: step.sequence,
          nameEn: step.name,
          nameBn: step.nameBn ?? null,
          approverPermission: step.approverPermission,
          approverScope: step.approverScope,
          isOptional: step.isOptional,
          slaHours: step.slaHours ?? null,
          escalationPermission: step.escalationPermission ?? null,
          onReject: step.onReject,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })),
      )
      .returning();
    return rows.sort((a, b) => a.sequence - b.sequence);
  }

  /**
   * A step naming a permission the catalogue does not contain would resolve to zero
   * approvers forever — a workflow that can be started but never decided. Refuse at
   * definition time, with the offending steps named.
   */
  private assertStepPermissionsExist(steps: readonly WorkflowStepInput[]): void {
    const issues: FieldIssue[] = [];
    steps.forEach((step, index) => {
      if (!isPermission(step.approverPermission)) {
        issues.push({
          path: `steps.${index}.approverPermission`,
          message: `"${step.approverPermission}" is not a permission in the catalogue`,
        });
      }
      if (step.escalationPermission && !isPermission(step.escalationPermission)) {
        issues.push({
          path: `steps.${index}.escalationPermission`,
          message: `"${step.escalationPermission}" is not a permission in the catalogue`,
        });
      }
    });
    if (issues.length > 0) {
      throw new ValidationError('One or more steps name an unknown permission', issues);
    }
  }

  private dueAtFor(step: StepRow, from: Date): Date | null {
    if (!step.slaHours) return null;
    return new Date(from.getTime() + step.slaHours * 3_600_000);
  }

  private definitionKeyFilter(key: string): SQL {
    return exists(
      this.db.raw
        .select({ one: sql`1` })
        .from(workflowDefinitions)
        .where(
          and(
            eq(workflowDefinitions.id, workflowRequests.definitionId),
            eq(workflowDefinitions.key, key),
          ),
        ),
    );
  }

  private requestOrder(sort: string | undefined) {
    return parseSort(sort, WORKFLOW_REQUEST_SORT_FIELDS, {
      field: 'initiatedAt',
      direction: 'desc',
    }).map((spec) => {
      const column = REQUEST_COLUMNS[spec.field];
      return spec.direction === 'desc' ? desc(column) : asc(column);
    });
  }
}

const DEFINITION_COLUMNS = {
  key: workflowDefinitions.key,
  nameEn: workflowDefinitions.nameEn,
  version: workflowDefinitions.version,
  createdAt: workflowDefinitions.createdAt,
} as const;

const REQUEST_COLUMNS = {
  initiatedAt: workflowRequests.initiatedAt,
  status: workflowRequests.status,
  dueAt: workflowRequests.dueAt,
  createdAt: workflowRequests.createdAt,
} as const;

const DELEGATION_COLUMNS = {
  fromDate: workflowDelegations.fromDate,
  toDate: workflowDelegations.toDate,
  createdAt: workflowDelegations.createdAt,
} as const;
