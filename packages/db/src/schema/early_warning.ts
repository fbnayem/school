/**
 * Early warning (Phase 34) — risk indicators, assessments, evidence and interventions.
 *
 * The module implements docs/06_AI_ARCHITECTURE.md §7, and the whole shape follows from one
 * sentence in it: *"A number with no reasons cannot be argued with, and a teacher who cannot
 * argue with it will either follow it blindly or ignore it entirely."*
 *
 * Four things are worth knowing before reading the tables:
 *
 *  1. **No model writes a number here.** Every risk figure is a deterministic aggregate over
 *     data the school already holds — attendance marks, exam marks, homework submissions,
 *     invoices, library loans, behaviour records — computed in SQL, reproducible from the
 *     run's `asOfDate`. A model is not needed to notice that attendance fell twelve points,
 *     and one that hallucinated the figure would be worse than no feature at all. The only
 *     thing a provider contributes is `narrativeEn` / `narrativeBn`: prose over numbers that
 *     already exist.
 *  2. **Bands are derived, never typed.** `risk_evidence.band` is set by a trigger from the
 *     institution's own thresholds; the per-domain and overall bands on an assessment are
 *     recomputed from the evidence. `risk_assessments_derived_guard` refuses every other
 *     writer, so a band cannot disagree with the facts under it. There is no Drizzle-side way
 *     to set one — an insert that tries is refused by the database.
 *  3. **No assessment exists without evidence.** A deferred constraint trigger refuses, at
 *     commit, any assessment with no evidence rows. This is the §7 rule made structural.
 *  4. **`risk_evidence` is append-only** (same discipline as `ai_messages`, `stock_movements`,
 *     `workflow_actions`), and neither assessments nor runs nor interventions are ever
 *     deleted. "What did we know in March" has to be answerable in December, so a superseded
 *     assessment is archived and points at its replacement.
 *
 * Thresholds are configuration per institution rather than constants in code: a school with a
 * different attendance norm edits `risk_indicators` and the next run bands accordingly, with
 * nothing deployed. `visible_to_guardian` is on the same row for the same reason — which
 * domains a guardian may see is a school's decision, defaulted conservatively.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
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
import { institutions, organizations } from './tenancy';
import { users } from './identity';
import { students } from './students';
import { academicYears, classLevels, sections, subjects } from './academic';
import { employees } from './people';

// ─────────────────────────────────────────────────────────────────────────────────────
// Enumerations
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The five things a school watches. The domain is an audience boundary as much as a grouping:
 * `wellbeing` and `behavioural` carry information a school usually wants to deliver in person,
 * which is why the seeded indicators in both leave `visibleToGuardian` off.
 */
export const riskDomainEnum = pgEnum('risk_domain', [
  'academic',
  'attendance',
  'financial',
  'behavioural',
  'wellbeing',
]);

/**
 * The band, declared in increasing severity ON PURPOSE — PostgreSQL orders an enum by
 * declaration order, and the band triggers pick the worst evidence with `order by band desc
 * limit 1`. Reordering these values would silently invert the module.
 */
export const riskBandEnum = pgEnum('risk_band', ['none', 'low', 'medium', 'high']);

/**
 * Which way is bad: `below` for an attendance percentage, `above` for a count of missed
 * homework or a number of points dropped. One comparison serves every indicator, in
 * `risk_band_for()`, so "does this cross?" and "which band is this?" cannot disagree.
 */
export const riskIndicatorDirectionEnum = pgEnum('risk_indicator_direction', ['above', 'below']);

/** What the measured number is, so a figure is never rendered with the wrong suffix. */
export const riskMeasureUnitEnum = pgEnum('risk_measure_unit', [
  'percent',
  'points',
  'count',
  'days',
  'currency',
]);

export const riskRunScopeEnum = pgEnum('risk_run_scope', [
  'institution',
  'class_level',
  'section',
  'student',
]);

export const riskRunStatusEnum = pgEnum('risk_run_status', ['running', 'completed', 'failed']);

/**
 * Whether a model wrote the prose, and if not, why not.
 *
 * `unavailable` is the load-bearing value: when the provider cannot be reached the assessment
 * and its evidence are still produced and shown, and the narrative is absent rather than
 * invented. `risk_assessments_narrative_attribution` makes that structural — prose can only
 * exist alongside the provider and model that produced it.
 */
export const riskNarrativeStatusEnum = pgEnum('risk_narrative_status', [
  'not_requested',
  'generated',
  'unavailable',
]);

/** What a human decided to do. Every one of these is an action a person takes. */
export const riskInterventionKindEnum = pgEnum('risk_intervention_kind', [
  'class_teacher_review',
  'guardian_meeting',
  'counselling_referral',
  'academic_support_plan',
  'attendance_plan',
  'financial_support',
  'monitoring',
]);

export const riskInterventionStatusEnum = pgEnum('risk_intervention_status', [
  'open',
  'in_progress',
  'closed',
  'cancelled',
]);

// ─────────────────────────────────────────────────────────────────────────────────────
// The catalogue
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * What this institution watches, over what window, at what thresholds, and who may see it.
 *
 * `key` names a MEASUREMENT, and a measurement is a query: the service holds one per key and
 * skips a key it does not recognise. A school can therefore retune an indicator without a
 * deploy and cannot invent one — inventing one requires somebody to write the SQL that
 * measures it, which is the honest division of labour.
 *
 * `minObservations` is the uncertainty floor. An attendance rate over four sessions is not a
 * fact about a child; evidence below the floor is refused by the insert trigger rather than
 * quietly down-weighted, because a school arguing with a figure needs to know the figure was
 * allowed to exist at all.
 */
export const riskIndicators = pgTable(
  'risk_indicators',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    key: varchar('key', { length: 64 }).notNull(),
    nameEn: varchar('name_en', { length: 128 }).notNull(),
    nameBn: varchar('name_bn', { length: 128 }),
    description: varchar('description', { length: 500 }),
    domain: riskDomainEnum('domain').notNull(),
    unit: riskMeasureUnitEnum('unit').notNull(),
    direction: riskIndicatorDirectionEnum('direction').notNull(),
    /** Measured back from the run's `asOfDate`, never from `now()`: a run's clock is an input. */
    windowDays: integer('window_days').notNull(),
    /** For a trend indicator: the earlier window of equal length it is compared against. */
    baselineWindowDays: integer('baseline_window_days'),
    minObservations: integer('min_observations').notNull().default(1),
    /** Optional: some indicators have nothing useful to say below the medium band. */
    thresholdLow: numeric('threshold_low', { precision: 12, scale: 2 }),
    thresholdMedium: numeric('threshold_medium', { precision: 12, scale: 2 }).notNull(),
    thresholdHigh: numeric('threshold_high', { precision: 12, scale: 2 }).notNull(),
    isEnabled: boolean('is_enabled').notNull().default(true),
    /**
     * May a guardian see this indicator's evidence about their own child?
     *
     * Defaults to false. The evidence is about their child and they have every right to it in
     * principle, but a wellbeing signal can carry information a school wants to deliver in
     * person rather than through a portal at eleven at night. The seeded catalogue turns it on
     * for what a school already shares in a report card or an invoice, and leaves behaviour
     * and wellbeing off until a school decides otherwise in writing.
     */
    visibleToGuardian: boolean('visible_to_guardian').notNull().default(false),
    isSystem: boolean('is_system').notNull().default(false),
    sortOrder: smallint('sort_order').notNull().default(0),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    /**
     * TOTAL rather than partial-on-archive: this is the key the evidence trigger looks an
     * indicator up by, and a second archived row for the same key would make the derived band
     * depend on which row the planner happened to find.
     */
    uniqueIndex('risk_indicators_institution_key_key').on(table.institutionId, table.key),
    index('risk_indicators_tenant_idx').on(table.tenantId),
    index('risk_indicators_domain_idx').on(table.institutionId, table.domain),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Runs, assessments, evidence
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * One pass over a cohort, at one `asOfDate`.
 *
 * `asOfDate` is what makes the module reproducible: every window is measured back from it, so
 * the same scope on the same date over unchanged data produces the same bands. A run measuring
 * back from `now()` would answer differently at nine in the morning and at five in the
 * afternoon, and nobody could reconcile two reports.
 *
 * `studentsAssessed` and `evidenceRecorded` are derived by triggers and refused to every other
 * writer — the same split `aiBudgets` makes between an administrator's limits and the
 * database's tally. `studentsConsidered` is settable: how many students the run looked at is
 * not recorded by any row.
 */
export const riskAssessmentRuns = pgTable(
  'risk_assessment_runs',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    academicYearId: uuid('academic_year_id')
      .notNull()
      .references(() => academicYears.id, { onDelete: 'restrict' }),
    scope: riskRunScopeEnum('scope').notNull(),
    /** The section, class level or student. Null exactly when the scope is the institution. */
    scopeId: uuid('scope_id'),
    asOfDate: date('as_of_date').notNull(),
    status: riskRunStatusEnum('status').notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    studentsConsidered: integer('students_considered').notNull().default(0),
    studentsAssessed: integer('students_assessed').notNull().default(0),
    evidenceRecorded: integer('evidence_recorded').notNull().default(0),
    narrativesGenerated: integer('narratives_generated').notNull().default(0),
    narrativeStatus: riskNarrativeStatusEnum('narrative_status').notNull().default('not_requested'),
    /** A provider key and a model, never a credential — no column here could hold one. */
    providerKey: varchar('provider_key', { length: 32 }),
    model: varchar('model', { length: 128 }),
    failureReason: varchar('failure_reason', { length: 1000 }),
    triggeredByUserId: uuid('triggered_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('risk_assessment_runs_tenant_idx').on(table.tenantId),
    index('risk_assessment_runs_institution_started_idx').on(table.institutionId, table.startedAt),
    index('risk_assessment_runs_status_idx').on(table.institutionId, table.status),
  ],
);

/**
 * One student's standing at one moment.
 *
 * The overall band is the WORST domain band and nothing else — deliberately not a weighted
 * score across domains, because a weighted score is exactly the number §7 says a teacher
 * cannot argue with. "The worst thing we found, and here is what it was" is a claim somebody
 * can disagree with, and disagreeing is the point.
 *
 * A superseded assessment is archived and points at its replacement; the partial unique index
 * allows one live assessment per student per academic year, and the history behind it is never
 * deleted.
 */
export const riskAssessments = pgTable(
  'risk_assessments',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => riskAssessmentRuns.id, { onDelete: 'restrict' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'restrict' }),
    academicYearId: uuid('academic_year_id')
      .notNull()
      .references(() => academicYears.id, { onDelete: 'restrict' }),
    /** Denormalised from the live enrollment so the cohort report can group without re-deriving it. */
    classLevelId: uuid('class_level_id').references(() => classLevels.id, { onDelete: 'set null' }),
    sectionId: uuid('section_id').references(() => sections.id, { onDelete: 'set null' }),
    asOfDate: date('as_of_date').notNull(),
    /** Derived by `risk_evidence_apply_bands`. An application write is refused by the guard. */
    overallBand: riskBandEnum('overall_band').notNull().default('none'),
    academicBand: riskBandEnum('academic_band').notNull().default('none'),
    attendanceBand: riskBandEnum('attendance_band').notNull().default('none'),
    financialBand: riskBandEnum('financial_band').notNull().default('none'),
    behaviouralBand: riskBandEnum('behavioural_band').notNull().default('none'),
    wellbeingBand: riskBandEnum('wellbeing_band').notNull().default('none'),
    evidenceCount: integer('evidence_count').notNull().default(0),
    computedAt: timestamp('computed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    narrativeStatus: riskNarrativeStatusEnum('narrative_status').notNull().default('not_requested'),
    narrativeEn: text('narrative_en'),
    narrativeBn: text('narrative_bn'),
    narrativeProvider: varchar('narrative_provider', { length: 32 }),
    narrativeModel: varchar('narrative_model', { length: 128 }),
    supersededByAssessmentId: uuid('superseded_by_assessment_id'),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('risk_assessments_current_key')
      .on(table.studentId, table.academicYearId)
      .where(sql`${table.archivedAt} IS NULL`),
    index('risk_assessments_tenant_idx').on(table.tenantId),
    index('risk_assessments_run_idx').on(table.runId),
    index('risk_assessments_cohort_idx')
      .on(table.institutionId, table.sectionId, table.overallBand)
      .where(sql`${table.archivedAt} IS NULL`),
    index('risk_assessments_student_history_idx').on(table.studentId, table.computedAt),
  ],
);

/**
 * One fact, with its figure, its threshold and where to go and look — the "Because:" list from
 * §7, one row per bullet.
 *
 * Each row carries enough to be reproduced by hand: the value measured, the threshold crossed,
 * the period covered, how many observations were behind it, the subject where the indicator is
 * subject-specific, and `detail` — the identifiers of the underlying rows, so "four assignments
 * not submitted" is four assignment ids away from being checked rather than a claim taken on
 * trust.
 *
 * `summaryEn` / `summaryBn` are composed from those numbers deterministically, without a
 * model. They are what a teacher reads when the provider is down, which is why they are
 * `notNull` while the model's prose is nullable.
 *
 * APPEND-ONLY: a corrected measurement is a new run producing a new assessment, which is also
 * how the March figure survives to December.
 */
export const riskEvidence = pgTable(
  'risk_evidence',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    assessmentId: uuid('assessment_id')
      .notNull()
      .references(() => riskAssessments.id, { onDelete: 'restrict' }),
    /** Denormalised from the assessment: the student history query reads evidence directly. */
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'restrict' }),
    indicatorKey: varchar('indicator_key', { length: 64 }).notNull(),
    /** domain, unit, band and thresholdValue are all set by `risk_evidence_derive_band`. */
    domain: riskDomainEnum('domain').notNull(),
    unit: riskMeasureUnitEnum('unit').notNull(),
    band: riskBandEnum('band').notNull(),
    measuredValue: numeric('measured_value', { precision: 12, scale: 2 }).notNull(),
    /** The figure compared against, for a trend: the earlier attendance rate, the first mark. */
    comparisonValue: numeric('comparison_value', { precision: 12, scale: 2 }),
    thresholdValue: numeric('threshold_value', { precision: 12, scale: 2 }).notNull(),
    observationCount: integer('observation_count').notNull(),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    subjectId: uuid('subject_id').references(() => subjects.id, { onDelete: 'restrict' }),
    detail: jsonb('detail').notNull().default({}),
    summaryEn: varchar('summary_en', { length: 500 }).notNull(),
    summaryBn: varchar('summary_bn', { length: 500 }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('risk_evidence_tenant_idx').on(table.tenantId),
    index('risk_evidence_assessment_idx').on(table.assessmentId),
    index('risk_evidence_student_idx').on(table.studentId, table.createdAt),
    index('risk_evidence_indicator_idx').on(table.institutionId, table.indicatorKey),
  ],
);

/**
 * What a human decided to do about it.
 *
 * Nothing writes a row here except a person: `risk_interventions_human_only` requires
 * `openedBy` to be the user id in the current request's GUC, so a background process or a
 * service account cannot open one at all. AI may suggest an intervention — the suggestion is a
 * row with a status in `ai_suggestions`, and `sourceSuggestionId` is the soft reference back
 * to it, deliberately not a foreign key so the two modules ship independently. Accepting a
 * suggestion is a normal permission-checked, audited call to this module made by a human,
 * which is docs/06 §6 with no shortcut.
 */
export const riskInterventions = pgTable(
  'risk_interventions',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'restrict' }),
    /** Nullable: a teacher who notices something before the system does should not have to wait. */
    assessmentId: uuid('assessment_id').references(() => riskAssessments.id, {
      onDelete: 'restrict',
    }),
    kind: riskInterventionKindEnum('kind').notNull(),
    status: riskInterventionStatusEnum('status').notNull().default('open'),
    title: varchar('title', { length: 200 }).notNull(),
    details: text('details'),
    ownerEmployeeId: uuid('owner_employee_id').references(() => employees.id, {
      onDelete: 'set null',
    }),
    dueOn: date('due_on'),
    openedBy: uuid('opened_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    openedAt: timestamp('opened_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    closedBy: uuid('closed_by'),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
    outcome: varchar('outcome', { length: 1000 }),
    closeReason: varchar('close_reason', { length: 1000 }),
    /** Soft reference to `ai_suggestions.id` — see the table comment. */
    sourceSuggestionId: uuid('source_suggestion_id'),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('risk_interventions_tenant_idx').on(table.tenantId),
    index('risk_interventions_status_idx').on(table.institutionId, table.status),
    index('risk_interventions_student_idx').on(table.studentId, table.openedAt),
    index('risk_interventions_assessment_idx').on(table.assessmentId),
  ],
);

export type RiskIndicatorRow = typeof riskIndicators.$inferSelect;
export type RiskAssessmentRunRow = typeof riskAssessmentRuns.$inferSelect;
export type RiskAssessmentRow = typeof riskAssessments.$inferSelect;
export type RiskEvidenceRow = typeof riskEvidence.$inferSelect;
export type RiskInterventionRow = typeof riskInterventions.$inferSelect;
