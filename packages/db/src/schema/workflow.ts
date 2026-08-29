/**
 * Workflow engine (Phase 25).
 *
 * Human approval chains as data: a *definition* (versioned, per institution) describes the
 * steps; a *request* is one entity moving through one frozen version of a definition; an
 * *action* is one human decision on one request. Three design points carry the module:
 *
 *  1. **Approvers are resolved by permission, never by name** (`docs/08_WORKFLOW_ENGINE.md`).
 *     A step stores `approver_permission`, and the set of people who can act is computed at
 *     decision time, so a staffing change does not break a running workflow. The complement —
 *     "not *this* person" — cannot be expressed as a permission at all, which is why the
 *     approver-is-not-the-initiator rule (KI-002) lives in the service, at runtime, and
 *     covers even the school owner.
 *  2. **Definitions are versioned and immutable once active.** Editing an active definition
 *     inserts a new row with `version + 1`; running requests carry `definition_id` +
 *     `definition_version` and keep resolving their steps against the version they started
 *     under. The unique key is (institution, key, version); a second partial index pins
 *     "exactly one active version per key".
 *  3. **`workflow_actions` is append-only, exactly like `audit_logs`.** History is the
 *     product: a send-back preserves every earlier decision, and the migration installs the
 *     same reject-mutation trigger the audit log uses. The `archived_at`/`updated_at` columns
 *     exist only to satisfy the schema-wide conventions; the database refuses the UPDATE that
 *     would ever set them for any role but the migrator.
 *
 * Escalation is schema-ready from this first migration (`due_at`, `sla_hours`,
 * `escalation_permission`, the `escalate` action and `escalated` status) so adding a
 * scheduler later is a code change, not a migration — a requirement stated in docs/08.
 */

import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  actorColumns,
  archiveColumns,
  primaryKeyColumn,
  timestampColumns,
  versionColumn,
} from './_shared';
import { campuses, institutions, organizations } from './tenancy';
import { users } from './identity';

/**
 * How far a step's approver search reaches. Closed set: adding a scope changes the resolver's
 * code, so this is an enum rather than a lookup table.
 */
export const workflowApproverScopeEnum = pgEnum('workflow_approver_scope', [
  'institution',
  'campus',
  'department',
]);

/** What a rejection at this step does to the request. */
export const workflowOnRejectEnum = pgEnum('workflow_on_reject', [
  'terminate',
  'send_back',
  'previous_step',
]);

/**
 * Request lifecycle. `draft` and `escalated` are part of the state machine from day one so
 * that the scheduler (later) and a draft-then-submit client (later) are code changes, not
 * migrations; nothing in Phase 25 creates them via the HTTP API.
 */
export const workflowRequestStatusEnum = pgEnum('workflow_request_status', [
  'draft',
  'pending',
  'approved',
  'rejected',
  'sent_back',
  'cancelled',
  'escalated',
]);

/** One human decision. `escalate` is reserved for the Phase 26 scheduler. */
export const workflowActionEnum = pgEnum('workflow_action', [
  'approve',
  'reject',
  'send_back',
  'cancel',
  'escalate',
  'comment',
]);

export const workflowDefinitions = pgTable(
  'workflow_definitions',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    /** Stable machine key other modules start workflows by, e.g. 'expense_approval'. */
    key: varchar('key', { length: 64 }).notNull(),
    nameEn: varchar('name_en', { length: 255 }).notNull(),
    nameBn: varchar('name_bn', { length: 255 }),
    /** What kind of entity travels through this workflow, e.g. 'expense', 'leave_request'. */
    entityType: varchar('entity_type', { length: 64 }).notNull(),
    /**
     * The definition version, not an optimistic lock. Editing an active definition inserts
     * version + 1 and deactivates this row; the row itself is immutable once active.
     */
    version: integer('version').notNull().default(1),
    isActive: boolean('is_active').notNull().default(true),
    /** Seeded by the platform as a sensible default; a school may still version it. */
    isSystem: boolean('is_system').notNull().default(false),
    description: text('description'),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('workflow_definitions_key_version_key')
      .on(table.institutionId, table.key, table.version)
      .where(sql`${table.archivedAt} IS NULL`),
    // Exactly one active version per key, so `startWorkflow(key)` is never ambiguous.
    uniqueIndex('workflow_definitions_active_key')
      .on(table.institutionId, table.key)
      .where(sql`${table.isActive} AND ${table.archivedAt} IS NULL`),
    index('workflow_definitions_tenant_idx').on(table.tenantId),
    index('workflow_definitions_entity_idx').on(table.institutionId, table.entityType),
  ],
);

export const workflowSteps = pgTable(
  'workflow_steps',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    definitionId: uuid('definition_id')
      .notNull()
      .references(() => workflowDefinitions.id, { onDelete: 'cascade' }),
    /** 1-based position in the chain. Consecutive within a definition version. */
    sequence: integer('sequence').notNull(),
    nameEn: varchar('name_en', { length: 255 }).notNull(),
    nameBn: varchar('name_bn', { length: 255 }),
    /**
     * The permission an approver must hold — never a user id. Resolution happens at decision
     * time so a staffing change cannot strand a running request.
     */
    approverPermission: varchar('approver_permission', { length: 128 }).notNull(),
    approverScope: workflowApproverScopeEnum('approver_scope').notNull().default('institution'),
    /** An optional step with no eligible approver is skipped rather than stalling the chain. */
    isOptional: boolean('is_optional').notNull().default(false),
    /** Hours until the request at this step is overdue. Null means no SLA. */
    slaHours: integer('sla_hours'),
    /** Who an overdue request escalates to — by permission, like approvers. */
    escalationPermission: varchar('escalation_permission', { length: 128 }),
    onReject: workflowOnRejectEnum('on_reject').notNull().default('terminate'),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('workflow_steps_sequence_key')
      .on(table.definitionId, table.sequence)
      .where(sql`${table.archivedAt} IS NULL`),
    index('workflow_steps_definition_idx').on(table.definitionId),
    index('workflow_steps_tenant_idx').on(table.tenantId),
  ],
);

export const workflowRequests = pgTable(
  'workflow_requests',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    campusId: uuid('campus_id').references(() => campuses.id, { onDelete: 'set null' }),
    /**
     * `restrict`, not `cascade`: a running or decided request is an institutional record and
     * must survive its definition being archived (archiving is soft anyway).
     */
    definitionId: uuid('definition_id')
      .notNull()
      .references(() => workflowDefinitions.id, { onDelete: 'restrict' }),
    /** Frozen at creation. The request keeps this version even after the definition evolves. */
    definitionVersion: integer('definition_version').notNull(),
    entityType: varchar('entity_type', { length: 64 }).notNull(),
    /** The owning module's record id. The workflow engine never dereferences it itself. */
    entityId: uuid('entity_id').notNull(),
    initiatedBy: uuid('initiated_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    initiatedAt: timestamp('initiated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    currentStepSequence: integer('current_step_sequence').notNull().default(1),
    status: workflowRequestStatusEnum('status').notNull().default('pending'),
    /** When the current step breaches its SLA. Carried from the first migration (docs/08). */
    dueAt: timestamp('due_at', { withTimezone: true, mode: 'date' }),
    /** Snapshot the owning module wants approvers to see. Opaque to the engine. */
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    summary: varchar('summary', { length: 500 }).notNull(),
    /** Set once, when the request reaches a terminal status. */
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    /** Optimistic lock for concurrent decisions on the same request. */
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    // One open request per entity: two simultaneous approval chains over the same expense
    // would produce two contradictory verdicts.
    uniqueIndex('workflow_requests_open_entity_key')
      .on(table.entityType, table.entityId)
      .where(
        sql`${table.status} IN ('draft', 'pending', 'sent_back', 'escalated') AND ${table.archivedAt} IS NULL`,
      ),
    index('workflow_requests_tenant_idx').on(table.tenantId),
    index('workflow_requests_institution_status_idx').on(table.institutionId, table.status),
    index('workflow_requests_definition_idx').on(table.definitionId),
    index('workflow_requests_entity_idx').on(table.entityType, table.entityId),
    index('workflow_requests_initiator_idx').on(table.initiatedBy),
    // Serves the overdue report without scanning decided requests.
    index('workflow_requests_due_idx')
      .on(table.dueAt)
      .where(sql`${table.status} IN ('pending', 'sent_back', 'escalated')`),
  ],
);

/**
 * One human decision on one request. Append-only: the migration revokes UPDATE/DELETE from
 * the application role and installs the audit-log reject trigger, so history is never
 * rewritten — a send-back adds a row, it does not erase the approval it reverses.
 */
export const workflowActions = pgTable(
  'workflow_actions',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    requestId: uuid('request_id')
      .notNull()
      .references(() => workflowRequests.id, { onDelete: 'restrict' }),
    stepSequence: integer('step_sequence').notNull(),
    /** The person who clicked. When acting under a delegation, this is the delegate. */
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** The delegator, when the action was taken under an active delegation window. */
    onBehalfOfUserId: uuid('on_behalf_of_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    action: workflowActionEnum('action').notNull(),
    comment: text('comment'),
    actedAt: timestamp('acted_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    // Convention columns only: the reject-mutation trigger means no role but the migrator can
    // ever set updated_at/archived_at on this table.
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('workflow_actions_tenant_idx').on(table.tenantId),
    index('workflow_actions_request_idx').on(table.requestId, table.actedAt),
    index('workflow_actions_actor_idx').on(table.actorUserId),
  ],
);

/**
 * "While I am away, X approves in my place." A delegation substitutes the delegate into the
 * approver set only within its window, and only where the delegator would have been eligible
 * — it never launders the initiator-cannot-approve or four-eyes rules, which are checked
 * against both the delegator and the delegate.
 */
export const workflowDelegations = pgTable(
  'workflow_delegations',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    fromUserId: uuid('from_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    toUserId: uuid('to_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** School-calendar facts, inclusive on both ends: leave is booked in dates, not instants. */
    fromDate: date('from_date').notNull(),
    toDate: date('to_date').notNull(),
    reason: varchar('reason', { length: 500 }).notNull(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('workflow_delegations_tenant_idx').on(table.tenantId),
    index('workflow_delegations_from_idx').on(table.fromUserId, table.fromDate, table.toDate),
    index('workflow_delegations_to_idx').on(table.toUserId),
  ],
);

export const workflowDefinitionsRelations = relations(workflowDefinitions, ({ many }) => ({
  steps: many(workflowSteps),
  requests: many(workflowRequests),
}));

export const workflowStepsRelations = relations(workflowSteps, ({ one }) => ({
  definition: one(workflowDefinitions, {
    fields: [workflowSteps.definitionId],
    references: [workflowDefinitions.id],
  }),
}));

export const workflowRequestsRelations = relations(workflowRequests, ({ one, many }) => ({
  definition: one(workflowDefinitions, {
    fields: [workflowRequests.definitionId],
    references: [workflowDefinitions.id],
  }),
  actions: many(workflowActions),
}));

export const workflowActionsRelations = relations(workflowActions, ({ one }) => ({
  request: one(workflowRequests, {
    fields: [workflowActions.requestId],
    references: [workflowRequests.id],
  }),
}));
