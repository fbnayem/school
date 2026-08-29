/**
 * Typed API surface for the workflow inbox (`/approvals`).
 *
 * The engine is deliberately generic: a request is "an entity of some type travelling through
 * one frozen version of a definition", and the engine never dereferences `entityId`. So this
 * client is generic too — there is no per-module special case here, and none is wanted. What
 * an approver sees about the thing being approved is `summary` plus the `payload` snapshot the
 * owning module chose to attach.
 *
 * Two rules from `apps/api/src/modules/workflow/workflow.service.ts` shape the screens above
 * this file, and are restated where they are used:
 *
 *  - An initiator may never decide their own request, whatever permissions they hold
 *    (`assertMayDecide`, KI-002). It is not a permission failure, so it must not be presented
 *    as one.
 *  - Anyone who took a decisive action (approve / reject / send back) at an earlier step is
 *    excluded from later steps of the same request (four eyes).
 */

import type { z } from 'zod';
import type {
  approveWorkflowRequestSchema,
  cancelWorkflowRequestSchema,
  commentWorkflowRequestSchema,
  rejectWorkflowRequestSchema,
  sendBackWorkflowRequestSchema,
} from '@shikkha/validation';
import { apiRequest, type Paged } from '@/lib/api';

// ── Row shapes (as the service selects them) ─────────────────────────────────────────

export type WorkflowRequestStatus =
  | 'draft'
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'sent_back'
  | 'cancelled'
  | 'escalated';

export type WorkflowActionKind =
  | 'approve'
  | 'reject'
  | 'send_back'
  | 'cancel'
  | 'escalate'
  | 'comment';

/**
 * The statuses in which a human decision can still move a request. Mirrors
 * `ACTIONABLE_STATUSES` in the service — an item outside this set has been decided, and the
 * decision controls must not be rendered for it.
 */
export const ACTIONABLE_STATUSES: readonly WorkflowRequestStatus[] = [
  'pending',
  'sent_back',
  'escalated',
];

/** Actions that consume a person's "one pair of eyes" on a request. Comments do not. */
export const DECISIVE_ACTIONS: readonly WorkflowActionKind[] = ['approve', 'reject', 'send_back'];

export interface WorkflowRequest {
  id: string;
  institutionId: string;
  campusId: string | null;
  definitionId: string;
  definitionVersion: number;
  entityType: string;
  entityId: string;
  initiatedBy: string;
  initiatedAt: string;
  currentStepSequence: number;
  status: WorkflowRequestStatus;
  /** When the current step breaches its SLA. Null when the step has no SLA. */
  dueAt: string | null;
  /** The snapshot the owning module attached. Opaque to the engine, and to this client. */
  payload: Record<string, unknown>;
  summary: string;
  decidedAt: string | null;
  version: number;
}

export interface WorkflowStep {
  id: string;
  definitionId: string;
  sequence: number;
  nameEn: string;
  nameBn: string | null;
  /** The permission an approver must hold at this step — never a user id. */
  approverPermission: string;
  approverScope: 'institution' | 'campus' | 'department';
  isOptional: boolean;
  slaHours: number | null;
  escalationPermission: string | null;
  onReject: 'terminate' | 'send_back' | 'previous_step';
}

export interface WorkflowActionRecord {
  id: string;
  requestId: string;
  stepSequence: number;
  /** The person who clicked. Under a delegation this is the delegate. */
  actorUserId: string;
  /** The delegator, when the action was taken under an active delegation window. */
  onBehalfOfUserId: string | null;
  action: WorkflowActionKind;
  comment: string | null;
  actedAt: string;
}

export interface WorkflowRequestDetail {
  request: WorkflowRequest;
  definition: { id: string; key: string; nameEn: string; version: number };
  steps: WorkflowStep[];
  /** Append-only, oldest first. A send-back never erases the decisions it reverses. */
  history: WorkflowActionRecord[];
}

export interface WorkflowDefinition {
  id: string;
  key: string;
  nameEn: string;
  nameBn: string | null;
  entityType: string;
  version: number;
  isActive: boolean;
  isSystem: boolean;
  description: string | null;
}

export interface ListRequestsQuery {
  page: number;
  pageSize: number;
  /** `mine` — I raised it; `awaiting` — my action can move it; `all` — everything I may see. */
  view: 'mine' | 'awaiting' | 'all';
  status?: string;
  entityType?: string;
  definitionKey?: string;
  q?: string;
  sort?: string;
}

// ── Client ───────────────────────────────────────────────────────────────────────────

export const workflowApi = {
  requests: (institutionId: string | null, query: ListRequestsQuery) =>
    apiRequest<Paged<WorkflowRequest>>('/workflows/requests', {
      institutionId,
      query: {
        page: query.page,
        pageSize: query.pageSize,
        view: query.view,
        status: query.status,
        entityType: query.entityType,
        definitionKey: query.definitionKey,
        q: query.q,
        sort: query.sort,
      },
    }),

  /** Past `due_at` and still actionable. Requires `workflows.view`. */
  overdue: (
    institutionId: string | null,
    query: { page: number; pageSize: number; definitionKey?: string },
  ) => apiRequest<Paged<WorkflowRequest>>('/workflows/requests/overdue', { institutionId, query }),

  request: (institutionId: string | null, id: string) =>
    apiRequest<WorkflowRequestDetail>(`/workflows/requests/${id}`, { institutionId }),

  approve: (
    institutionId: string | null,
    id: string,
    body: z.input<typeof approveWorkflowRequestSchema>,
  ) =>
    apiRequest<WorkflowRequest>(`/workflows/requests/${id}/approve`, {
      method: 'POST',
      body,
      institutionId,
    }),

  reject: (
    institutionId: string | null,
    id: string,
    body: z.input<typeof rejectWorkflowRequestSchema>,
  ) =>
    apiRequest<WorkflowRequest>(`/workflows/requests/${id}/reject`, {
      method: 'POST',
      body,
      institutionId,
    }),

  sendBack: (
    institutionId: string | null,
    id: string,
    body: z.input<typeof sendBackWorkflowRequestSchema>,
  ) =>
    apiRequest<WorkflowRequest>(`/workflows/requests/${id}/send-back`, {
      method: 'POST',
      body,
      institutionId,
    }),

  cancel: (
    institutionId: string | null,
    id: string,
    body: z.input<typeof cancelWorkflowRequestSchema>,
  ) =>
    apiRequest<WorkflowRequest>(`/workflows/requests/${id}/cancel`, {
      method: 'POST',
      body,
      institutionId,
    }),

  comment: (
    institutionId: string | null,
    id: string,
    body: z.input<typeof commentWorkflowRequestSchema>,
  ) =>
    apiRequest<WorkflowActionRecord>(`/workflows/requests/${id}/comment`, {
      method: 'POST',
      body,
      institutionId,
    }),

  /**
   * Definition names, used to label rows in the queue. Requires `workflows.view`, which an
   * approver holding only `workflows.act` does not have — every screen that calls this must
   * work without it, falling back to the entity type.
   */
  definitions: (institutionId: string | null, query: { page: number; pageSize: number } = {
    page: 1,
    pageSize: 100,
  }) => apiRequest<Paged<WorkflowDefinition>>('/workflows/definitions', { institutionId, query }),
};
