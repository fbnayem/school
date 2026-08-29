/**
 * Discipline and behaviour schemas (Phase 22).
 *
 * The shape of these schemas is itself a due-process control:
 *
 *  - **A client never states a derived or decided fact.** There is no `status` on the create
 *    schema (a record starts as a draft or a report, nothing else), no `approvedBy`, no
 *    `runningTotal`. Statuses move only through the dedicated transition endpoints, which
 *    demand a reason that lands in the audit log.
 *  - **Every decision carries a reason.** Transitions, approvals and revocations all embed
 *    `reasonSchema` — the route-level `requiresReason` interceptor refuses the request before
 *    the handler runs, and the reason is recorded with actor and timestamp.
 *  - **There is deliberately no auto-classify input anywhere.** Category, severity and points
 *    are chosen by a named human; AI never creates, decides or escalates a disciplinary
 *    matter.
 *
 * Constants carry the `BEHAVIOUR_`/`DISCIPLINARY_` prefix because `@shikkha/validation`
 * re-exports flat.
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

const code = (max: number) =>
  z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]+$/, 'Use letters, numbers, hyphens and underscores only')
    .min(1)
    .max(max);

const nameEn = z.string().trim().min(1).max(128);
const nameBn = z.string().trim().max(128).optional();

// ── Value sets, mirrored from the database enums ─────────────────────────────────────

export const BEHAVIOUR_KINDS = ['positive', 'negative'] as const;

export const BEHAVIOUR_SEVERITIES = ['minor', 'moderate', 'major', 'severe'] as const;

export const BEHAVIOUR_RECORD_STATUSES = [
  'draft',
  'reported',
  'under_investigation',
  'substantiated',
  'unsubstantiated',
  'withdrawn',
] as const;

export const BEHAVIOUR_CONFIDENTIALITY_LEVELS = ['normal', 'restricted'] as const;

export const DISCIPLINARY_ACTION_TYPES = [
  'verbal_warning',
  'written_warning',
  'detention',
  'parent_meeting',
  'community_service',
  'suspension',
  'expulsion_recommended',
] as const;

/** The action types that require an approver different from the decider. */
export const DISCIPLINARY_SEVERE_ACTION_TYPES = ['suspension', 'expulsion_recommended'] as const;

export const DISCIPLINARY_ACTION_STATUSES = [
  'proposed',
  'approved',
  'active',
  'completed',
  'revoked',
] as const;

export const BEHAVIOUR_NOTE_VISIBILITIES = ['internal', 'shared_with_guardian'] as const;

export const BEHAVIOUR_CATEGORY_SORT_FIELDS = [
  'code',
  'nameEn',
  'kind',
  'defaultSeverity',
  'sortOrder',
  'createdAt',
] as const;

export const BEHAVIOUR_RECORD_SORT_FIELDS = [
  'occurredOn',
  'severity',
  'status',
  'createdAt',
] as const;

// ── Behaviour categories ─────────────────────────────────────────────────────────────

export const createBehaviourCategorySchema = z
  .object({
    code: code(32),
    nameEn,
    nameBn,
    kind: z.enum(BEHAVIOUR_KINDS),
    defaultSeverity: z.enum(BEHAVIOUR_SEVERITIES).default('minor'),
    /** May be negative for a negative behaviour. The sign must match the kind. */
    defaultPoints: z.coerce.number().int().min(-1000).max(1000).default(0),
    description: z.string().trim().max(500).optional(),
    sortOrder: z.coerce.number().int().min(0).max(999).default(0),
  })
  .superRefine((data, ctx) => {
    if (data.kind === 'positive' && data.defaultPoints < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultPoints'],
        message: 'A positive behaviour cannot carry negative points',
      });
    }
    if (data.kind === 'negative' && data.defaultPoints > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultPoints'],
        message: 'A negative behaviour cannot carry positive points',
      });
    }
  });

export type CreateBehaviourCategoryInput = z.infer<typeof createBehaviourCategorySchema>;

export const updateBehaviourCategorySchema = z
  .object({
    nameEn: nameEn.optional(),
    nameBn: z.string().trim().max(128).nullable().optional(),
    defaultSeverity: z.enum(BEHAVIOUR_SEVERITIES).optional(),
    defaultPoints: z.coerce.number().int().min(-1000).max(1000).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    sortOrder: z.coerce.number().int().min(0).max(999).optional(),
    /** Optimistic lock. Rejecting a stale write beats silently overwriting a colleague. */
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, {
    message: 'No changes were submitted',
  });

export type UpdateBehaviourCategoryInput = z.infer<typeof updateBehaviourCategorySchema>;

export const listBehaviourCategoriesSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    kind: z.enum(BEHAVIOUR_KINDS).optional(),
    includeArchived: z.coerce.boolean().default(false),
  });

export const archiveBehaviourCategorySchema = z.object({ reason: reasonSchema });

// ── Behaviour records ────────────────────────────────────────────────────────────────

/**
 * Reporting an incident (or a commendation).
 *
 * There is no `status` field: `submit: true` (the default) creates the record as `reported`;
 * `submit: false` keeps a private `draft` the reporter can complete later. Severity and
 * points default from the category when omitted; when supplied, the service still refuses a
 * sign that contradicts the category's kind.
 */
export const createBehaviourRecordSchema = z.object({
  studentId: uuidSchema,
  categoryId: uuidSchema,
  academicYearId: uuidSchema,
  occurredOn: calendarDateSchema,
  occurredAtPeriodId: uuidSchema.optional(),
  description: z
    .string()
    .trim()
    .min(10, 'Describe what happened in at least 10 characters — this is a permanent record')
    .max(4000),
  severity: z.enum(BEHAVIOUR_SEVERITIES).optional(),
  points: z.coerce.number().int().min(-1000).max(1000).optional(),
  confidentiality: z.enum(BEHAVIOUR_CONFIDENTIALITY_LEVELS).default('normal'),
  submit: z.boolean().default(true),
});

export type CreateBehaviourRecordInput = z.infer<typeof createBehaviourRecordSchema>;

export const listBehaviourRecordsSchema = paginationSchema.merge(sortSchema).extend({
  studentId: uuidSchema.optional(),
  categoryId: uuidSchema.optional(),
  academicYearId: uuidSchema.optional(),
  status: z.enum(BEHAVIOUR_RECORD_STATUSES).optional(),
  severity: z.enum(BEHAVIOUR_SEVERITIES).optional(),
  kind: z.enum(BEHAVIOUR_KINDS).optional(),
  occurredFrom: calendarDateSchema.optional(),
  occurredTo: calendarDateSchema.optional(),
});

/**
 * A status transition. The valid moves are an explicit state machine in the service; an
 * invalid one is a 409 naming both states. The reason is mandatory — it becomes part of the
 * record (`status_reason`) and of the audit trail.
 */
export const transitionBehaviourRecordSchema = z.object({
  status: z.enum(BEHAVIOUR_RECORD_STATUSES),
  reason: reasonSchema,
  /** Optimistic lock, so two people cannot decide the same record at once. */
  version: z.number().int().min(1),
});

export type TransitionBehaviourRecordInput = z.infer<typeof transitionBehaviourRecordSchema>;

// ── Notes ────────────────────────────────────────────────────────────────────────────

/** Append-only. There is no update or delete schema, because there is no update or delete. */
export const addBehaviourNoteSchema = z.object({
  note: z.string().trim().min(3).max(4000),
  visibility: z.enum(BEHAVIOUR_NOTE_VISIBILITIES).default('internal'),
});

export type AddBehaviourNoteInput = z.infer<typeof addBehaviourNoteSchema>;

// ── Disciplinary actions ─────────────────────────────────────────────────────────────

/**
 * Proposing an action. It is created `proposed` and takes effect only when approved — for a
 * severe action, by a *different* person. There is no way to state an approver here.
 */
export const proposeDisciplinaryActionSchema = z
  .object({
    actionType: z.enum(DISCIPLINARY_ACTION_TYPES),
    startsOn: calendarDateSchema.optional(),
    endsOn: calendarDateSchema.optional(),
    details: z
      .string()
      .trim()
      .min(10, 'Describe the action in at least 10 characters — this is a permanent record')
      .max(4000),
    reason: reasonSchema,
  })
  .superRefine((data, ctx) => {
    if (data.startsOn && data.endsOn && data.endsOn < data.startsOn) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endsOn'],
        message: 'The action cannot end before it starts',
      });
    }
    if ((data.actionType === 'suspension' || data.actionType === 'detention') && !data.startsOn) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['startsOn'],
        message: 'A suspension or detention must state when it starts',
      });
    }
  });

export type ProposeDisciplinaryActionInput = z.infer<typeof proposeDisciplinaryActionSchema>;

export const approveDisciplinaryActionSchema = z.object({
  reason: reasonSchema,
  version: z.number().int().min(1),
});

export const revokeDisciplinaryActionSchema = z.object({
  reason: reasonSchema,
  version: z.number().int().min(1),
});

// ── Guardian acknowledgement ─────────────────────────────────────────────────────────

export const acknowledgeBehaviourRecordSchema = z.object({
  comment: z.string().trim().max(1000).optional(),
});

export type AcknowledgeBehaviourRecordInput = z.infer<typeof acknowledgeBehaviourRecordSchema>;

// ── Reports ──────────────────────────────────────────────────────────────────────────

export const myChildrenBehaviourQuerySchema = z.object({
  academicYearId: uuidSchema.optional(),
});

/**
 * The merit leaderboard is built from POSITIVE ledger entries only. There is deliberately no
 * flag to include negative totals: the product never publishes a negative ranking of
 * children.
 */
export const meritLeaderboardQuerySchema = z.object({
  sectionId: uuidSchema,
  academicYearId: uuidSchema,
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const behaviourTrendQuerySchema = z
  .object({
    academicYearId: uuidSchema,
    occurredFrom: calendarDateSchema.optional(),
    occurredTo: calendarDateSchema.optional(),
    groupBy: z.enum(['month', 'category', 'severity']).default('month'),
  })
  .refine(
    (data) => !data.occurredFrom || !data.occurredTo || data.occurredTo >= data.occurredFrom,
    { message: 'The end of the range cannot be before its start', path: ['occurredTo'] },
  );

export type BehaviourTrendQuery = z.infer<typeof behaviourTrendQuerySchema>;
