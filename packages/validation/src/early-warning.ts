/**
 * Early-warning schemas (Phase 34).
 *
 * Four rules shape every schema in this file, and each one exists because the alternative is a
 * way the module could lie about a child:
 *
 *  - **A client never states a risk.** There is no `band`, `overallBand`, `domain`, `unit` or
 *    `thresholdValue` on any input here. A band is derived by the database from the
 *    institution's own thresholds and the evidence under it (migration 0035), so there is no
 *    field through which a score could be asserted rather than computed. The same rule the AI
 *    foundation applies to `tokensUsed`.
 *  - **A client never states a narrative.** Prose comes from a provider or it is absent. There
 *    is no `narrativeEn` input, because "a plausible invented sentence about a child is worse
 *    than an outage".
 *  - **Thresholds are configuration and are validated as a set.** `updateRiskIndicatorSchema`
 *    checks the ordering the database also checks, so a mis-typed ceiling is a 422 naming the
 *    field rather than a constraint violation naming a constraint.
 *  - **Decisions carry reasons.** Closing an intervention requires one: the register is read
 *    six months later by somebody asking whether the meeting ever happened.
 *
 * Measured figures cross the wire as **two-decimal strings**, mirroring the `numeric(12, 2)`
 * columns, never as floats (ADR-004). A threshold of "82.50" percent is a legitimate setting
 * and a float would eventually render it as 82.49999.
 *
 * Constants carry a `RISK_` prefix because `@shikkha/validation` re-exports flat.
 */

import { z } from 'zod';
import {
  calendarDateSchema,
  paginationSchema,
  reasonSchema,
  sortSchema,
  uuidSchema,
} from './common';

// ── Value sets, mirrored from the database enums ─────────────────────────────────────

export const RISK_DOMAINS = [
  'academic',
  'attendance',
  'financial',
  'behavioural',
  'wellbeing',
] as const;

/** Increasing severity. The order is meaningful: the overall band is the worst domain band. */
export const RISK_BANDS = ['none', 'low', 'medium', 'high'] as const;

export const RISK_INDICATOR_DIRECTIONS = ['above', 'below'] as const;

export const RISK_MEASURE_UNITS = ['percent', 'points', 'count', 'days', 'currency'] as const;

export const RISK_RUN_SCOPES = ['institution', 'class_level', 'section', 'student'] as const;

export const RISK_RUN_STATUSES = ['running', 'completed', 'failed'] as const;

export const RISK_NARRATIVE_STATUSES = ['not_requested', 'generated', 'unavailable'] as const;

/** Every one of these is an action a person takes. None of them is something a model does. */
export const RISK_INTERVENTION_KINDS = [
  'class_teacher_review',
  'guardian_meeting',
  'counselling_referral',
  'academic_support_plan',
  'attendance_plan',
  'financial_support',
  'monitoring',
] as const;

export const RISK_INTERVENTION_STATUSES = ['open', 'in_progress', 'closed', 'cancelled'] as const;

/** Sort allow-list for the assessment list, consumed by `parseSort`. */
export const RISK_ASSESSMENT_SORT_FIELDS = ['computedAt', 'overallBand', 'asOfDate'] as const;

// ── Primitives ───────────────────────────────────────────────────────────────────────

/**
 * A measured figure or a threshold: at most two decimals, as a string.
 *
 * Signed, because a threshold can legitimately be negative — a mark trend measured as a
 * *change* is negative when marks improve, and an institution that wanted to flag improvement
 * would set a negative threshold rather than be told the schema forbids it.
 */
export const riskMeasureSchema = z
  .string()
  .trim()
  .regex(/^-?\d{1,10}(\.\d{1,2})?$/, 'Enter a number with at most two decimal places');

export const riskIndicatorKeySchema = z
  .string()
  .trim()
  .regex(
    /^[a-z][a-z0-9_]{2,63}$/,
    'An indicator key is lower-case letters, digits and underscores',
  );

export const riskIndicatorKeyParamSchema = z.object({ key: riskIndicatorKeySchema });

/** `/assessments/:studentId` and `/students/:id/history` name different things; both are here. */
export const riskStudentParamSchema = z.object({ studentId: uuidSchema });

// ── The catalogue ────────────────────────────────────────────────────────────────────

export const listRiskIndicatorsSchema = z.object({
  domain: z.enum(RISK_DOMAINS).optional(),
  /** Disabled indicators are hidden by default; a settings screen asks for them explicitly. */
  includeDisabled: z.coerce.boolean().default(false),
});

/**
 * Retune one indicator for this institution.
 *
 * `domain`, `unit` and `direction` are deliberately **absent**: they are properties of the
 * measurement, not settings. A school can decide that 85% is its attendance floor; it cannot
 * decide that attendance is measured in days or that a higher percentage is worse, because the
 * query behind the key does not work that way and the evidence would then be nonsense.
 *
 * A PUT, because the whole configuration is replaced — sending half a threshold set and
 * inheriting the rest is how an institution ends up with `medium` above `high`.
 */
export const updateRiskIndicatorSchema = z
  .object({
    nameEn: z.string().trim().min(1).max(128).optional(),
    nameBn: z.string().trim().max(128).nullish(),
    description: z.string().trim().max(500).nullish(),
    windowDays: z.coerce.number().int().min(1).max(3650),
    baselineWindowDays: z.coerce.number().int().min(1).max(3650).nullish(),
    minObservations: z.coerce.number().int().min(1).max(10_000),
    thresholdLow: riskMeasureSchema.nullish(),
    thresholdMedium: riskMeasureSchema,
    thresholdHigh: riskMeasureSchema,
    isEnabled: z.boolean(),
    /**
     * Whether a guardian may see this indicator's evidence about their own child.
     *
     * A school's decision, taken deliberately: the seeded default is off for the behavioural
     * and wellbeing indicators, because a guardian learning from a portal at eleven at night
     * that the school has flagged their child's wellbeing is the wrong way for that
     * conversation to begin.
     */
    visibleToGuardian: z.boolean(),
  })
  .superRefine((value, ctx) => {
    // The ordering is checked here AND by a CHECK constraint. Two statements of one rule on
    // purpose: this one names the field a person typed into, the database one is what still
    // holds when somebody writes SQL by hand.
    const low = value.thresholdLow == null ? null : Number(value.thresholdLow);
    const medium = Number(value.thresholdMedium);
    const high = Number(value.thresholdHigh);

    // Direction is not in the body, so the schema checks the ordering is *monotonic* in one
    // direction or the other; the service checks it matches the indicator's own direction,
    // where it knows which way is bad.
    const ascending = medium <= high && (low === null || low <= medium);
    const descending = medium >= high && (low === null || low >= medium);
    if (!ascending && !descending) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['thresholdMedium'],
        message:
          'Thresholds must step consistently: low, then medium, then high, all rising or all falling',
      });
    }
  });

// ── Runs ─────────────────────────────────────────────────────────────────────────────

/**
 * Start a run.
 *
 * `asOfDate` is an input rather than a clock reading, and that is the single decision that
 * makes the module reproducible: every window is measured back from it, so the same scope on
 * the same date over unchanged data produces the same bands. It defaults to today in the
 * service, where the school's own calendar is known.
 */
export const createRiskRunSchema = z
  .object({
    scope: z.enum(RISK_RUN_SCOPES).default('institution'),
    /** The section, class level or student. Required for every scope but `institution`. */
    scopeId: uuidSchema.optional(),
    academicYearId: uuidSchema.optional(),
    asOfDate: calendarDateSchema.optional(),
    /**
     * Ask a provider to write the prose. The numbers and the evidence are produced either way
     * — this only decides whether a model is asked to read them out.
     */
    generateNarrative: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (value.scope === 'institution' && value.scopeId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scopeId'],
        message: 'An institution-wide run covers everyone; do not name a section or a student',
      });
    }
    if (value.scope !== 'institution' && value.scopeId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scopeId'],
        message: 'Name the section, class level or student this run covers',
      });
    }
  });

export const listRiskRunsSchema = paginationSchema.extend({
  status: z.enum(RISK_RUN_STATUSES).optional(),
  scope: z.enum(RISK_RUN_SCOPES).optional(),
});

// ── Assessments ──────────────────────────────────────────────────────────────────────

export const listRiskAssessmentsSchema = paginationSchema.merge(sortSchema).extend({
  /** Filter to a band or worse: `medium` returns medium and high. */
  minBand: z.enum(RISK_BANDS).optional(),
  domain: z.enum(RISK_DOMAINS).optional(),
  sectionId: uuidSchema.optional(),
  classLevelId: uuidSchema.optional(),
  runId: uuidSchema.optional(),
  /** Superseded assessments are archived, not deleted; this is how you read the old ones. */
  includeArchived: z.coerce.boolean().default(false),
});

export const riskStudentHistorySchema = paginationSchema.extend({
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
});

export const riskCohortReportSchema = z.object({
  groupBy: z.enum(['section', 'class_level']).default('section'),
  runId: uuidSchema.optional(),
});

// ── Interventions ────────────────────────────────────────────────────────────────────

/**
 * Open an intervention. A HUMAN action, always.
 *
 * There is no field here through which the caller could claim to be somebody else: the acting
 * user is taken from the authenticated principal, and a database trigger refuses an insert
 * whose `openedBy` is not the user id on the session. `sourceSuggestionId` records that an AI
 * suggestion prompted this — never that an AI created it. The suggestion is a row with a
 * status; this row is the human's decision about it.
 */
export const createRiskInterventionSchema = z.object({
  studentId: uuidSchema,
  /** The assessment that prompted it, where there was one. */
  assessmentId: uuidSchema.optional(),
  kind: z.enum(RISK_INTERVENTION_KINDS),
  title: z.string().trim().min(3, 'Say what is being done').max(200),
  details: z.string().trim().max(4000).optional(),
  ownerEmployeeId: uuidSchema.optional(),
  dueOn: calendarDateSchema.optional(),
  /** Soft reference to an `ai_suggestions` row, when a suggestion is what prompted this. */
  sourceSuggestionId: uuidSchema.optional(),
});

/**
 * Update an open intervention.
 *
 * `status` here may only move between the two open states. Closing is its own endpoint because
 * it requires an outcome and a reason, and an update that could close by omission is how a
 * register fills up with closed rows nobody can account for.
 */
export const updateRiskInterventionSchema = z.object({
  status: z.enum(['open', 'in_progress']).optional(),
  kind: z.enum(RISK_INTERVENTION_KINDS).optional(),
  title: z.string().trim().min(3).max(200).optional(),
  details: z.string().trim().max(4000).nullish(),
  ownerEmployeeId: uuidSchema.nullish(),
  dueOn: calendarDateSchema.nullish(),
  version: z.number().int().min(1),
});

export const closeRiskInterventionSchema = z.object({
  /** `cancelled` for one that never happened; `closed` for one that did. */
  status: z.enum(['closed', 'cancelled']).default('closed'),
  outcome: z
    .string()
    .trim()
    .min(3, 'Say what happened — this is what somebody reads six months from now')
    .max(1000),
  reason: reasonSchema,
  version: z.number().int().min(1),
});

export const listRiskInterventionsSchema = paginationSchema.extend({
  status: z.enum(RISK_INTERVENTION_STATUSES).optional(),
  studentId: uuidSchema.optional(),
});

// ── Inferred types ───────────────────────────────────────────────────────────────────

export type ListRiskIndicatorsInput = z.infer<typeof listRiskIndicatorsSchema>;
export type UpdateRiskIndicatorInput = z.infer<typeof updateRiskIndicatorSchema>;
export type CreateRiskRunInput = z.infer<typeof createRiskRunSchema>;
export type ListRiskRunsInput = z.infer<typeof listRiskRunsSchema>;
export type ListRiskAssessmentsInput = z.infer<typeof listRiskAssessmentsSchema>;
export type RiskStudentHistoryInput = z.infer<typeof riskStudentHistorySchema>;
export type RiskCohortReportInput = z.infer<typeof riskCohortReportSchema>;
export type CreateRiskInterventionInput = z.infer<typeof createRiskInterventionSchema>;
export type UpdateRiskInterventionInput = z.infer<typeof updateRiskInterventionSchema>;
export type CloseRiskInterventionInput = z.infer<typeof closeRiskInterventionSchema>;
export type ListRiskInterventionsInput = z.infer<typeof listRiskInterventionsSchema>;
export type RiskBand = (typeof RISK_BANDS)[number];
export type RiskDomain = (typeof RISK_DOMAINS)[number];
export type RiskMeasureUnit = (typeof RISK_MEASURE_UNITS)[number];
