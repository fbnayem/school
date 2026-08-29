/**
 * Automation engine schemas (Phase 26).
 *
 * Three things in this file are policy rather than validation, and they are the reason the
 * automation engine is safe to hand a school:
 *
 *  1. **Conditions are an allow-listed clause list, never an expression.** A clause is a
 *     `field`, an `op` from a closed enum, and a literal `value`. `field` must match
 *     `event.<name>` or `fact.<name>` with a strict identifier — which alone refuses
 *     `event.__proto__`, `event.a.b`, and anything carrying a quote, a semicolon or a space.
 *     Membership of the *catalogue* is checked server-side (the service owns the fact SQL and
 *     the event contracts), exactly as the workflow schemas validate a permission string's
 *     shape here and its catalogue membership there. There is no code path that evaluates a
 *     string, and no clause value ever reaches SQL as anything but a bound parameter.
 *  2. **The action is a discriminated union.** `actionKind` is not a free field a caller can
 *     pair with an arbitrary config blob; each kind has exactly the configuration it needs
 *     and nothing else survives parsing (the Zod pipe strips unknown keys, so a rule cannot
 *     smuggle an extra instruction into `action_config`).
 *  3. **A sensitive target forces a human into the loop.** `SENSITIVE_AUTOMATION_TARGETS`
 *     lists the resources a rule may never change on its own. Naming one in
 *     `targetResource` requires `requiresHumanConfirmation` and one of the two
 *     human-in-the-loop actions — refused here, refused again by the service, and refused a
 *     third time by a check constraint in migration 0030.
 *
 * Constants carry an `AUTOMATION_` prefix because `@shikkha/validation` re-exports flat.
 */

import { z } from 'zod';
import { paginationSchema, reasonSchema, searchSchema, sortSchema, uuidSchema } from './common';

// ── Value sets, mirrored from the database enums ─────────────────────────────────────

export const AUTOMATION_TRIGGER_KINDS = ['event', 'schedule', 'threshold'] as const;

export const AUTOMATION_ACTION_KINDS = [
  'notify',
  'create_workflow_request',
  'create_record',
  'flag_for_review',
] as const;

export const AUTOMATION_EXECUTION_STATUSES = [
  'matched',
  'suppressed_cooldown',
  'suppressed_duplicate',
  'acted',
  'failed',
  'awaiting_confirmation',
] as const;

export const AUTOMATION_SUGGESTION_STATUSES = ['pending', 'accepted', 'dismissed'] as const;

/**
 * Resources a rule may never change by itself.
 *
 * Naming one of these as an action's `targetResource` is legal — a rule that watches grades
 * is a useful rule — but only in the shape where a person decides. Both the service and
 * `automation_rules_sensitive_needs_human` in migration 0030 restate this list.
 */
export const SENSITIVE_AUTOMATION_TARGETS = [
  'grade',
  'exam_mark',
  'exam_result',
  'attendance',
  'payment',
  'refund',
  'invoice',
  'salary',
  'payroll',
  'discipline',
  'user_role',
  'student_record',
  'employee_record',
  'mass_communication',
] as const;

export type SensitiveAutomationTarget = (typeof SENSITIVE_AUTOMATION_TARGETS)[number];

/** The two action kinds that put a person between the rule and the consequence. */
export const HUMAN_IN_THE_LOOP_ACTION_KINDS = [
  'flag_for_review',
  'create_workflow_request',
] as const;

export const AUTOMATION_CONDITION_OPERATORS = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'not_in',
  'exists',
] as const;

export type AutomationConditionOperator = (typeof AUTOMATION_CONDITION_OPERATORS)[number];

export const AUTOMATION_RULE_SORT_FIELDS = ['key', 'nameEn', 'version', 'createdAt'] as const;

export const AUTOMATION_EXECUTION_SORT_FIELDS = ['matchedAt', 'status', 'createdAt'] as const;

export const AUTOMATION_SUGGESTION_SORT_FIELDS = ['createdAt', 'status', 'summary'] as const;

export const AUTOMATION_EVENT_SORT_FIELDS = ['occurredAt', 'eventName', 'createdAt'] as const;

/** Recipient selectors a `notify` rule may use. Not a free query — a closed set. */
export const AUTOMATION_RECIPIENT_SELECTORS = [
  'guardians_of_subject_student',
  'permission_holders',
] as const;

/** Record kinds `create_record` may create. Nothing sensitive is, or will casually become, one. */
export const AUTOMATION_RECORD_KINDS = ['automation_event'] as const;

// ── Primitives ───────────────────────────────────────────────────────────────────────

/** Machine key: lowercase snake, e.g. `absence_three_consecutive`. Matches the DB check. */
const automationKeySchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{1,63}$/,
    'Use a lowercase snake_case key, for example absence_three_consecutive',
  );

/**
 * An event name, e.g. `attendance.student_absent`. Two lowercase snake segments. The
 * catalogue of names the engine actually understands is owned by the service.
 */
const automationEventNameSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/,
    'Use an event name such as attendance.student_absent',
  )
  .max(64);

/**
 * A condition field. The regex is doing real security work: one dot, a leading lowercase
 * letter, and nothing after it but letters, digits and underscores. `event.__proto__`
 * (leading underscore), `fact.a.b` (second dot), `event.x; drop table y` and
 * `event.x' or '1'='1` are all refused before the service sees them, and the service then
 * refuses anything not in its catalogue — that catalogue check, not this regex, is what
 * makes an unknown-but-well-formed name like `event.constructor` harmless.
 *
 * Letters after the first are deliberately not restricted to lowercase. Event payload keys
 * are camelCase, because they are the same JSON the rest of the API speaks —
 * `event.daysOverdue`, `event.daysToExpiry`, `event.consecutiveAbsences`. A lowercase-only
 * rule made every one of those unreferenceable, so most of the event catalogue could not be
 * used in a condition at all: the field existed, was documented, was emitted, and was
 * rejected at 422 the moment anyone named it. Fact names stay snake_case by convention
 * (`fact.invoice_days_overdue`) because they are a server-side catalogue rather than a
 * payload, and both shapes pass.
 */
const automationConditionFieldSchema = z
  .string()
  .trim()
  .regex(
    /^(event|fact)\.[a-z][A-Za-z0-9_]{0,62}$/,
    'A condition field is event.<name> or fact.<name>, starting with a lowercase letter',
  );

const conditionLiteralSchema = z.union([
  z.string().max(200),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

const conditionListSchema = z.array(z.union([z.string().max(200), z.number().finite()])).max(50);

export const automationConditionClauseSchema = z
  .object({
    field: automationConditionFieldSchema,
    op: z.enum(AUTOMATION_CONDITION_OPERATORS),
    value: z.union([conditionLiteralSchema, conditionListSchema]).optional(),
  })
  .superRefine((clause, ctx) => {
    const needsList = clause.op === 'in' || clause.op === 'not_in';
    if (needsList && !Array.isArray(clause.value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `The ${clause.op} operator needs a list of values`,
      });
    }
    if (!needsList && Array.isArray(clause.value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `The ${clause.op} operator takes a single value, not a list`,
      });
    }
    if (clause.op !== 'exists' && clause.value === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `The ${clause.op} operator needs a value to compare against`,
      });
    }
  });

export type AutomationConditionClause = z.infer<typeof automationConditionClauseSchema>;

export const automationConditionSchema = z.object({
  match: z.enum(['all', 'any']).default('all'),
  clauses: z.array(automationConditionClauseSchema).max(20).default([]),
});

export type AutomationConditionInput = z.infer<typeof automationConditionSchema>;

/**
 * The resource an action would touch, when it touches one at all. Free-form on purpose — a
 * school may watch something the catalogue does not name — but a value inside
 * `SENSITIVE_AUTOMATION_TARGETS` triggers the human-in-the-loop requirement below.
 */
const targetResourceSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{1,47}$/, 'Use a lowercase snake_case resource name')
  .optional();

/** Message text with `{{placeholder}}` substitution from allow-listed payload fields only. */
const messageBodySchema = z.string().trim().min(10).max(2000);

const permissionStringSchema = z
  .string()
  .trim()
  .min(3)
  .max(128)
  .regex(
    /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/,
    'Use a permission string such as hr.documents.view',
  );

// ── Actions ──────────────────────────────────────────────────────────────────────────

const notifyActionSchema = z.object({
  kind: z.literal('notify'),
  targetResource: targetResourceSchema,
  recipients: z.enum(AUTOMATION_RECIPIENT_SELECTORS),
  /** Required when `recipients` is `permission_holders`; ignored otherwise. */
  permission: permissionStringSchema.optional(),
  subject: z.string().trim().min(3).max(255),
  messageEn: messageBodySchema,
  messageBn: messageBodySchema.optional(),
});

const createWorkflowRequestActionSchema = z.object({
  kind: z.literal('create_workflow_request'),
  targetResource: targetResourceSchema,
  /** The workflow definition key to start. Must resolve to an active definition at run time. */
  definitionKey: automationKeySchema,
  summary: z.string().trim().min(3).max(500),
});

const createRecordActionSchema = z.object({
  kind: z.literal('create_record'),
  targetResource: targetResourceSchema,
  /** Only `automation_event` is allow-listed; the enum is the allow-list. */
  recordKind: z.enum(AUTOMATION_RECORD_KINDS),
  /** The derived event to raise. Derived events may not themselves derive. */
  eventName: automationEventNameSchema,
});

const flagForReviewActionSchema = z.object({
  kind: z.literal('flag_for_review'),
  targetResource: targetResourceSchema,
  summary: z.string().trim().min(3).max(500),
});

export const automationActionSchema = z.discriminatedUnion('kind', [
  notifyActionSchema,
  createWorkflowRequestActionSchema,
  createRecordActionSchema,
  flagForReviewActionSchema,
]);

export type AutomationActionInput = z.infer<typeof automationActionSchema>;

// ── Rules ────────────────────────────────────────────────────────────────────────────

const ruleBodyShape = {
  name: z.string().trim().min(2).max(255),
  nameBn: z.string().trim().max(255).optional(),
  description: z.string().trim().max(2000).optional(),
  triggerKind: z.enum(AUTOMATION_TRIGGER_KINDS),
  eventName: automationEventNameSchema.optional(),
  /**
   * Standard five-field cron. Stored and reported; **never executed by this module** — see
   * the automation module docblock. The shape is validated so a rule that a scheduler will
   * later read cannot be stored malformed.
   */
  cronExpression: z
    .string()
    .trim()
    .max(120)
    .regex(
      /^[\d*/,\-A-Za-z?]+(\s+[\d*/,\-A-Za-z?]+){4}$/,
      'Use a five-field cron expression, for example 0 7 * * *',
    )
    .optional(),
  timezone: z
    .string()
    .trim()
    .max(64)
    .regex(/^[A-Za-z][A-Za-z0-9_+\-/]{1,63}$/, 'Use an IANA time zone such as Asia/Dhaka')
    .default('Asia/Dhaka'),
  conditions: automationConditionSchema.default({ match: 'all', clauses: [] }),
  action: automationActionSchema,
  requiresHumanConfirmation: z.boolean().default(false),
  cooldownMinutes: z.number().int().min(0).max(43_200).default(0),
};

/**
 * The cross-field rules every rule body obeys, in one place so create and update cannot
 * drift apart:
 *
 *  - a `schedule` rule carries a cron expression and no event name; an `event` or
 *    `threshold` rule carries an event name and no cron expression,
 *  - `permission_holders` recipients need the permission they hold,
 *  - a sensitive `targetResource` forces `requiresHumanConfirmation` and a human-in-the-loop
 *    action kind.
 */
function checkRuleBody(
  data: {
    triggerKind: (typeof AUTOMATION_TRIGGER_KINDS)[number];
    eventName?: string | undefined;
    cronExpression?: string | undefined;
    action: AutomationActionInput;
    requiresHumanConfirmation: boolean;
  },
  ctx: z.RefinementCtx,
): void {
  if (data.triggerKind === 'schedule') {
    if (!data.cronExpression) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cronExpression'],
        message: 'A scheduled rule needs a cron expression',
      });
    }
    if (data.eventName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['eventName'],
        message: 'A scheduled rule is not driven by an event name',
      });
    }
  } else {
    if (!data.eventName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['eventName'],
        message: `A ${data.triggerKind} rule needs the event name it reacts to`,
      });
    }
    if (data.cronExpression) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cronExpression'],
        message: 'Only a scheduled rule carries a cron expression',
      });
    }
  }

  if (
    data.action.kind === 'notify' &&
    data.action.recipients === 'permission_holders' &&
    !data.action.permission
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['action', 'permission'],
      message: 'Name the permission whose holders should be notified',
    });
  }

  const target = data.action.targetResource;
  if (target && (SENSITIVE_AUTOMATION_TARGETS as readonly string[]).includes(target)) {
    if (!data.requiresHumanConfirmation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requiresHumanConfirmation'],
        message: `${target} is a sensitive resource: this rule must require human confirmation`,
      });
    }
    if (!(HUMAN_IN_THE_LOOP_ACTION_KINDS as readonly string[]).includes(data.action.kind)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['action', 'kind'],
        message: `A rule targeting ${target} may only raise a suggestion or a workflow request`,
      });
    }
  }
}

export const createAutomationRuleSchema = z
  .object({ key: automationKeySchema, ...ruleBodyShape })
  .superRefine(checkRuleBody);

export type CreateAutomationRuleInput = z.infer<typeof createAutomationRuleSchema>;

/**
 * Editing an active rule creates version n+1; the key is immutable, so it is absent here for
 * the same reason a workflow definition's key is.
 */
export const updateAutomationRuleSchema = z.object(ruleBodyShape).superRefine(checkRuleBody);

export type UpdateAutomationRuleInput = z.infer<typeof updateAutomationRuleSchema>;

export const listAutomationRulesSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    key: automationKeySchema.optional(),
    triggerKind: z.enum(AUTOMATION_TRIGGER_KINDS).optional(),
    actionKind: z.enum(AUTOMATION_ACTION_KINDS).optional(),
    isActive: z.coerce.boolean().optional(),
    includeInactive: z.coerce.boolean().default(true),
  });

export type ListAutomationRulesQuery = z.infer<typeof listAutomationRulesSchema>;

export const activateAutomationRuleSchema = z.object({
  version: z.number().int().min(1),
});

export type ActivateAutomationRuleInput = z.infer<typeof activateAutomationRuleSchema>;

export const deactivateAutomationRuleSchema = z.object({
  version: z.number().int().min(1),
  reason: reasonSchema,
});

export type DeactivateAutomationRuleInput = z.infer<typeof deactivateAutomationRuleSchema>;

export const archiveAutomationRuleSchema = z.object({ reason: reasonSchema });

/**
 * Evaluate a rule against a sample payload without acting and without writing anything.
 * Returns the resolved facts, the clause-by-clause verdict, and what *would* have happened.
 */
export const dryRunAutomationRuleSchema = z.object({
  payload: z.record(z.unknown()).default({}),
});

export type DryRunAutomationRuleInput = z.infer<typeof dryRunAutomationRuleSchema>;

// ── Events ───────────────────────────────────────────────────────────────────────────

export const emitAutomationEventSchema = z.object({
  eventName: automationEventNameSchema,
  /**
   * The idempotency key. Supplied by the emitter because only the emitter knows what "the
   * same event" means — one absence for one student on one date, not one HTTP call.
   */
  dedupeKey: z.string().trim().min(4).max(200),
  sourceModule: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{1,31}$/, 'Use a lowercase module name such as attendance')
    .default('automation'),
  occurredAt: z
    .string()
    .datetime({ offset: true, message: 'Use an ISO-8601 timestamp with a timezone offset' })
    .optional(),
  payload: z.record(z.unknown()).default({}),
});

export type EmitAutomationEventInput = z.infer<typeof emitAutomationEventSchema>;

export const listAutomationEventsSchema = paginationSchema.merge(sortSchema).extend({
  eventName: automationEventNameSchema.optional(),
  processed: z.coerce.boolean().optional(),
});

export type ListAutomationEventsQuery = z.infer<typeof listAutomationEventsSchema>;

export const processAutomationEventsSchema = z.object({
  /** How many pending events to drain in this call. Explicit, because there is no worker. */
  limit: z.number().int().min(1).max(200).default(50),
  eventName: automationEventNameSchema.optional(),
  /**
   * Re-run the rules for one named event, processed or not.
   *
   * The operator case is "I fixed a rule, run it against yesterday's absences". It is safe
   * precisely because it is idempotent: a rule that already produced an execution for this
   * event is recorded `suppressed_duplicate` and does nothing a second time, while a rule
   * added since the first pass runs normally.
   */
  eventId: uuidSchema.optional(),
});

export type ProcessAutomationEventsInput = z.infer<typeof processAutomationEventsSchema>;

export const listDueAutomationSchedulesSchema = z.object({
  /**
   * The instant to test the cron expressions against. Defaults to now; supplying it is what
   * lets an operator (and a test) ask "what would have been due at 07:00".
   */
  at: z
    .string()
    .datetime({ offset: true, message: 'Use an ISO-8601 timestamp with a timezone offset' })
    .optional(),
});

export type ListDueAutomationSchedulesQuery = z.infer<typeof listDueAutomationSchedulesSchema>;

// ── Executions, suggestions and the activity report ──────────────────────────────────

export const listAutomationExecutionsSchema = paginationSchema.merge(sortSchema).extend({
  ruleId: uuidSchema.optional(),
  eventId: uuidSchema.optional(),
  status: z.enum(AUTOMATION_EXECUTION_STATUSES).optional(),
  subjectId: uuidSchema.optional(),
});

export type ListAutomationExecutionsQuery = z.infer<typeof listAutomationExecutionsSchema>;

export const listAutomationSuggestionsSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    ruleId: uuidSchema.optional(),
    status: z.enum(AUTOMATION_SUGGESTION_STATUSES).default('pending'),
    subjectKind: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]{1,31}$/)
      .optional(),
  });

export type ListAutomationSuggestionsQuery = z.infer<typeof listAutomationSuggestionsSchema>;

/**
 * Accepting a suggestion records the decision — it does not perform the underlying action.
 * The reviewer then does the thing themselves, through the module that owns it, with that
 * module's own permissions and audit trail. Anything else would be the automation engine
 * acting after all, one indirection later.
 */
export const decideAutomationSuggestionSchema = z.object({
  note: reasonSchema,
  version: z.number().int().min(1),
});

export type DecideAutomationSuggestionInput = z.infer<typeof decideAutomationSuggestionSchema>;

export const automationActivityReportSchema = z.object({
  from: z
    .string()
    .datetime({ offset: true, message: 'Use an ISO-8601 timestamp with a timezone offset' })
    .optional(),
  to: z
    .string()
    .datetime({ offset: true, message: 'Use an ISO-8601 timestamp with a timezone offset' })
    .optional(),
});

export type AutomationActivityReportQuery = z.infer<typeof automationActivityReportSchema>;
