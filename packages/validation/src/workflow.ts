/**
 * Workflow engine schemas (Phase 25).
 *
 * Two conventions here are policy rather than validation:
 *
 *  - Every decision that stops or redirects a request — reject, send back, cancel — carries a
 *    mandatory comment of at least ten characters, mirrored by a `check` constraint in the
 *    database. An approval chain whose rejections read "no" is not a record of anything.
 *  - Step lists are validated as a whole: sequences must be exactly 1..n with no gaps, so the
 *    state machine's "next step" and "previous step" are always well defined. A definition
 *    that passes this schema cannot strand a request between steps.
 *
 * Approver permissions are validated for *shape* only; the service checks membership in the
 * permission catalogue, because the catalogue lives in `@shikkha/permissions` and this
 * package deliberately does not depend on it.
 */

import { z } from 'zod';
import {
  calendarDateSchema,
  paginationSchema,
  reasonSchema,
  searchSchema,
  sortSchema,
  uuidSchema,
} from './common';

export const WORKFLOW_REQUEST_STATUSES = [
  'draft',
  'pending',
  'approved',
  'rejected',
  'sent_back',
  'cancelled',
  'escalated',
] as const;

export const WORKFLOW_ACTIONS = [
  'approve',
  'reject',
  'send_back',
  'cancel',
  'escalate',
  'comment',
] as const;

export const WORKFLOW_APPROVER_SCOPES = ['institution', 'campus', 'department'] as const;

export const WORKFLOW_ON_REJECT = ['terminate', 'send_back', 'previous_step'] as const;

export const WORKFLOW_DEFINITION_SORT_FIELDS = ['key', 'nameEn', 'version', 'createdAt'] as const;

export const WORKFLOW_REQUEST_SORT_FIELDS = [
  'initiatedAt',
  'status',
  'dueAt',
  'createdAt',
] as const;

export const WORKFLOW_DELEGATION_SORT_FIELDS = ['fromDate', 'toDate', 'createdAt'] as const;

/** Machine key: lowercase snake, e.g. `expense_approval`. Matches the DB check constraint. */
const workflowKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,63}$/, 'Use a lowercase snake_case key, for example expense_approval');

/** Permission-string shape, e.g. `results.approve`. Catalogue membership is checked server-side. */
const permissionStringSchema = z
  .string()
  .trim()
  .min(3)
  .max(128)
  .regex(
    /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/,
    'Use a permission string such as results.approve',
  );

const entityTypeSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{1,63}$/, 'Use a lowercase snake_case entity type');

/**
 * Comments on approvals are optional; on anything that stops or redirects the request they
 * are mandatory and substantial — the same 10-character floor as `reasonSchema`, because the
 * comment *is* the reason recorded in the audit trail.
 */
const decisionCommentSchema = z
  .string()
  .trim()
  .min(10, 'Explain the decision in at least 10 characters — this is recorded permanently')
  .max(2000);

const optionalCommentSchema = z.string().trim().max(2000).optional();

// ─────────────────────────────────────────────────────────────────────────────────────
// Definitions
// ─────────────────────────────────────────────────────────────────────────────────────

export const workflowStepInputSchema = z.object({
  sequence: z.number().int().min(1).max(50),
  name: z.string().trim().min(2).max(255),
  nameBn: z.string().trim().max(255).optional(),
  approverPermission: permissionStringSchema,
  approverScope: z.enum(WORKFLOW_APPROVER_SCOPES).default('institution'),
  isOptional: z.boolean().default(false),
  slaHours: z.number().int().min(1).max(8760).optional(),
  escalationPermission: permissionStringSchema.optional(),
  onReject: z.enum(WORKFLOW_ON_REJECT).default('terminate'),
});

export type WorkflowStepInput = z.infer<typeof workflowStepInputSchema>;

function checkStepSequences(steps: readonly { sequence: number }[], ctx: z.RefinementCtx): void {
  const sequences = [...steps].map((step) => step.sequence).sort((a, b) => a - b);
  for (let i = 0; i < sequences.length; i += 1) {
    if (sequences[i] !== i + 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['steps'],
        message: 'Step sequences must be exactly 1, 2, 3, … with no gaps or duplicates',
      });
      return;
    }
  }
}

export const createWorkflowDefinitionSchema = z
  .object({
    key: workflowKeySchema,
    name: z.string().trim().min(2).max(255),
    nameBn: z.string().trim().max(255).optional(),
    entityType: entityTypeSchema,
    description: z.string().trim().max(2000).optional(),
    steps: z.array(workflowStepInputSchema).min(1).max(50),
  })
  .superRefine((data, ctx) => checkStepSequences(data.steps, ctx));

export type CreateWorkflowDefinitionInput = z.infer<typeof createWorkflowDefinitionSchema>;

/**
 * Editing an active definition creates a new version; `version` names the version the editor
 * was looking at, so an edit raced by another edit is a 409, not a silent version 3 built on
 * a version 1 nobody reviewed.
 */
export const updateWorkflowDefinitionSchema = z
  .object({
    version: z.number().int().min(1),
    name: z.string().trim().min(2).max(255).optional(),
    nameBn: z.string().trim().max(255).optional(),
    description: z.string().trim().max(2000).optional(),
    steps: z.array(workflowStepInputSchema).min(1).max(50).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.steps) checkStepSequences(data.steps, ctx);
    if (Object.keys(data).length <= 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'No changes were submitted' });
    }
  });

export type UpdateWorkflowDefinitionInput = z.infer<typeof updateWorkflowDefinitionSchema>;

export const archiveWorkflowDefinitionSchema = z.object({ reason: reasonSchema });

export const listWorkflowDefinitionsSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    key: workflowKeySchema.optional(),
    entityType: entityTypeSchema.optional(),
    includeInactive: z.coerce.boolean().default(false),
    includeArchived: z.coerce.boolean().default(false),
  });

export type ListWorkflowDefinitionsQuery = z.infer<typeof listWorkflowDefinitionsSchema>;

// ─────────────────────────────────────────────────────────────────────────────────────
// Requests
// ─────────────────────────────────────────────────────────────────────────────────────

export const createWorkflowRequestSchema = z.object({
  definitionKey: workflowKeySchema,
  /** The owning module's record id — an expense, a leave request, an application. */
  entityId: uuidSchema,
  summary: z.string().trim().min(3).max(500),
  /** Snapshot the owning module wants approvers to see. Opaque to the engine. */
  payload: z.record(z.unknown()).default({}),
});

export type CreateWorkflowRequestInput = z.infer<typeof createWorkflowRequestSchema>;

export const listWorkflowRequestsSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    /**
     * `mine` — requests I initiated; `awaiting` — requests my action can move;
     * `all` — every request I am permitted to see (`workflows.view`).
     */
    view: z.enum(['mine', 'awaiting', 'all']).default('mine'),
    status: z.enum(WORKFLOW_REQUEST_STATUSES).optional(),
    definitionKey: workflowKeySchema.optional(),
    entityType: entityTypeSchema.optional(),
  });

export type ListWorkflowRequestsQuery = z.infer<typeof listWorkflowRequestsSchema>;

export const approveWorkflowRequestSchema = z.object({
  comment: optionalCommentSchema,
});

export const rejectWorkflowRequestSchema = z.object({
  comment: decisionCommentSchema,
});

export const sendBackWorkflowRequestSchema = z.object({
  /** The earlier step the request returns to. Must be before the current step. */
  targetSequence: z.number().int().min(1).max(50),
  comment: decisionCommentSchema,
});

export const cancelWorkflowRequestSchema = z.object({
  comment: decisionCommentSchema,
});

export const commentWorkflowRequestSchema = z.object({
  comment: z.string().trim().min(1, 'An empty comment records nothing').max(2000),
});

export const listOverdueWorkflowRequestsSchema = paginationSchema.merge(sortSchema).extend({
  definitionKey: workflowKeySchema.optional(),
});

export type ListOverdueWorkflowRequestsQuery = z.infer<typeof listOverdueWorkflowRequestsSchema>;

// ─────────────────────────────────────────────────────────────────────────────────────
// Delegations
// ─────────────────────────────────────────────────────────────────────────────────────

export const createWorkflowDelegationSchema = z
  .object({
    /** Defaults to the caller. Naming someone else requires `workflows.manage`. */
    fromUserId: uuidSchema.optional(),
    toUserId: uuidSchema,
    fromDate: calendarDateSchema,
    toDate: calendarDateSchema,
    reason: reasonSchema,
  })
  .superRefine((data, ctx) => {
    if (data.toDate < data.fromDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toDate'],
        message: 'The delegation must not end before it starts',
      });
    }
    if (data.fromUserId && data.fromUserId === data.toUserId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toUserId'],
        message: 'A delegation to yourself would change nothing',
      });
    }
  });

export type CreateWorkflowDelegationInput = z.infer<typeof createWorkflowDelegationSchema>;

export const revokeWorkflowDelegationSchema = z.object({ reason: reasonSchema });

export const listWorkflowDelegationsSchema = paginationSchema.merge(sortSchema).extend({
  includeExpired: z.coerce.boolean().default(false),
  includeArchived: z.coerce.boolean().default(false),
});

export type ListWorkflowDelegationsQuery = z.infer<typeof listWorkflowDelegationsSchema>;
