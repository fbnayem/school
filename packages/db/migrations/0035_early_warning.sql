-- =====================================================================================
-- 0035 — Early warning: risk indicators, assessments, evidence and interventions (Phase 34)
--
-- This migration implements docs/06_AI_ARCHITECTURE.md §7, which is one paragraph long and
-- decides the entire shape of the module:
--
--     Academic risk: Medium
--
--     Because:
--       · Mathematics declined across three assessments (72 → 61 → 54)
--       · Attendance fell from 93% to 78% since March
--       · Four assignments not submitted
--
--     "A number with no reasons cannot be argued with, and a teacher who cannot argue with it
--      will either follow it blindly or ignore it entirely. Neither is useful."
--
-- Five properties are enforced HERE rather than in a service, because each is one the
-- application can only get wrong once and never notice:
--
--   1. **NO ASSESSMENT WITHOUT EVIDENCE.** `risk_assessments_evidence_required` is a DEFERRED
--      constraint trigger: at commit, an assessment with no `risk_evidence` row aborts the
--      transaction that created it. Deferred rather than immediate because the evidence is
--      necessarily written after the row it hangs off, and a band without its reasons is the
--      exact failure §7 describes. It is not a service invariant, because a service invariant
--      survives only as long as the next person remembers it.
--
--   2. **BANDS ARE DERIVED, NEVER TYPED.** The band of one piece of evidence is computed by
--      `risk_evidence_derive_band` from the *institution's own thresholds* at insert time; the
--      per-domain and overall bands on the assessment are recomputed by
--      `risk_evidence_apply_bands` from the evidence rows. `risk_assessments_derived_guard`
--      refuses any other writer — the application, raw SQL, a compromised process — from
--      moving a band or an evidence count. There is therefore no code path through which a
--      band can disagree with the facts under it.
--
--   3. **THRESHOLDS ARE CONFIGURATION, PER INSTITUTION.** A school with a different attendance
--      norm changes a row in `risk_indicators`; nothing is deployed. Because the band is
--      derived by the trigger from that row, the new threshold applies to the next run without
--      a single line of application code knowing what the number is.
--
--   4. **EVIDENCE IS APPEND-ONLY.** `risk_evidence_no_mutation` refuses UPDATE and DELETE for
--      every role but the migrator — the same discipline as `ai_messages` (0032),
--      `stock_movements` (0025) and `workflow_actions` (0014). Evidence is the record of what
--      the school knew about a child on a date. If it can be edited it proves nothing, and the
--      first time anyone needs it will be a dispute about a decision it influenced.
--
--   5. **RISK HISTORY IS NEVER DELETED.** DELETE is refused on assessments, runs and
--      interventions (ADR-008). A superseded assessment is ARCHIVED and points at the one that
--      replaced it, so "what did we know in March" is answerable in December.
--
-- ── What is NOT here, deliberately ──────────────────────────────────────────────────────
--
-- There is no column anywhere in this migration into which a model writes a number. Every
-- risk figure is a deterministic, reproducible aggregate over data the school already holds:
-- attendance marks, exam marks, homework submissions, invoices, library loans, behaviour
-- records. A model is not needed to notice that attendance fell twelve points, and a model
-- that hallucinated the figure would be far worse than no feature at all. The ONLY thing a
-- model contributes is prose: `narrative_en` / `narrative_bn` on an assessment, guarded by
-- `risk_assessments_narrative_attribution` so that "the provider was unavailable" can never be
-- stored as "here is what the provider said".
--
-- ── AI autonomy (docs/06 §6) ────────────────────────────────────────────────────────────
--
-- `risk_interventions` is what a HUMAN decided to do about a risk: a referral, a meeting, a
-- plan. `risk_interventions_require_human` refuses an insert whose `opened_by` is not the user
-- id in the current request's GUC, so a row cannot be attributed to a teacher by anything that
-- is not that teacher's own authenticated call. AI can suggest one; the suggestion is a row
-- with a status in another module, and `source_suggestion_id` is the soft reference to it.
--
-- ── The 0031 lesson ─────────────────────────────────────────────────────────────────────
--
-- 0031 records why `insert … on conflict do update set used = used + delta` is wrong for a
-- CHECK-constrained counter: PostgreSQL evaluates CHECK constraints against the proposed
-- insertion tuple before ON CONFLICT arbitration picks the DO UPDATE branch, so a signed delta
-- is checked in isolation rather than as a resulting balance. **No trigger in this file uses
-- that shape.** The counters here (`students_assessed`, `evidence_recorded`, `evidence_count`)
-- are maintained by a plain UPDATE against a row that is guaranteed to already exist — the run
-- is inserted before any assessment references it, and the assessment before any evidence —
-- so there is no upsert to get wrong, and the increments are always positive. Anyone adding a
-- signed adjustment here must read 0031 first.
--
-- The RLS/grants/updated_at loop from 0002 does not re-run for tables created later, so it is
-- restated at the bottom, followed by named assertions and assert_rls_coverage().
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- Enumerations. Closed value sets: adding a domain or a band changes the read model, the
-- guardian visibility rule and the cohort report as well as the schema. What a school
-- configures for itself — thresholds, windows, which indicators are on, who may see them —
-- is a column, not an enum value.
-- -------------------------------------------------------------------------------------

/**
 * The five things a school watches. The domain is an audience boundary as much as a
 * grouping: `wellbeing` carries information a school usually wants to deliver in person, and
 * `behavioural` is the discipline record's neighbour, so both default to invisible in the
 * guardian portal (see `risk_indicators.visible_to_guardian`).
 */
create type public.risk_domain as enum (
  'academic', 'attendance', 'financial', 'behavioural', 'wellbeing'
);

/**
 * The band. Declared in increasing severity ON PURPOSE: PostgreSQL orders an enum by
 * declaration order, so `order by band desc limit 1` is "the worst of these" and the derived
 * band triggers below rely on exactly that.
 *
 * `none` exists so that a measurement which crossed nothing has a name. It is never stored on
 * a piece of evidence — evidence records a crossing — but it is the default a fresh assessment
 * starts at before its evidence is applied.
 */
create type public.risk_band as enum ('none', 'low', 'medium', 'high');

/**
 * Which way is bad. `below` for attendance percentage (78% is worse than 93%); `above` for a
 * count of missed homework or a number of points dropped. It exists so that one threshold
 * comparison serves every indicator instead of each indicator carrying its own comparison
 * code — the comparison lives in `risk_band_for()` and nowhere else.
 */
create type public.risk_indicator_direction as enum ('above', 'below');

/** What the measured number is, so a figure is never rendered with the wrong suffix. */
create type public.risk_measure_unit as enum ('percent', 'points', 'count', 'days', 'currency');

/** What a run covered. `scope_id` names the section, class level or student; null for a whole institution. */
create type public.risk_run_scope as enum ('institution', 'class_level', 'section', 'student');

create type public.risk_run_status as enum ('running', 'completed', 'failed');

/**
 * Whether a model wrote the prose, and if not, why not.
 *
 * `unavailable` is the load-bearing value: when the provider cannot be reached, the assessment
 * and its evidence are still produced and shown, and the narrative is ABSENT rather than
 * invented. A check constraint below makes that structural.
 */
create type public.risk_narrative_status as enum ('not_requested', 'generated', 'unavailable');

/** What a human decided to do. Every one of these is an action a person takes, not a system does. */
create type public.risk_intervention_kind as enum (
  'class_teacher_review', 'guardian_meeting', 'counselling_referral', 'academic_support_plan',
  'attendance_plan', 'financial_support', 'monitoring'
);

create type public.risk_intervention_status as enum ('open', 'in_progress', 'closed', 'cancelled');

-- -------------------------------------------------------------------------------------
-- Tables
-- -------------------------------------------------------------------------------------

/**
 * The catalogue: what this institution watches, over what window, and at what thresholds.
 *
 * Thresholds are CONFIGURATION, per institution, not constants in code. A school whose
 * attendance norm is 85% rather than 90% says so here and the next run bands accordingly,
 * because the band is derived by a trigger that reads this row. That is the whole reason the
 * numbers live in a table.
 *
 * `key` is not free text: it names a MEASUREMENT, and a measurement is a query. The service
 * holds one query per key and skips a key it does not recognise. So a school can retune an
 * indicator without a deploy and cannot invent one, which is the honest division — inventing
 * one requires somebody to write the SQL that measures it.
 *
 * `min_observations` is the uncertainty guard: an attendance rate over four sessions is not a
 * fact about a child, it is noise. Evidence below the floor is refused by the insert trigger
 * rather than quietly weighted down, because a school arguing with a figure needs to know the
 * figure was allowed to exist.
 */
create table public.risk_indicators (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  key varchar(64) not null,
  name_en varchar(128) not null,
  name_bn varchar(128),
  description varchar(500),
  domain public.risk_domain not null,
  unit public.risk_measure_unit not null,
  direction public.risk_indicator_direction not null,
  -- The window the measurement looks back over, from the run's `as_of_date` — never from
  -- now(). A run is reproducible only if its clock is an input.
  window_days integer not null,
  -- For a trend indicator: the earlier window of the same length that the recent one is
  -- compared against. Null for a level indicator.
  baseline_window_days integer,
  min_observations integer default 1 not null,
  -- `low` is optional: some indicators have nothing useful to say below the medium band.
  threshold_low numeric(12, 2),
  threshold_medium numeric(12, 2) not null,
  threshold_high numeric(12, 2) not null,
  is_enabled boolean default true not null,
  /**
   * May a guardian see evidence from this indicator for their own child?
   *
   * Defaults to FALSE, deliberately. The evidence is about their child and they have every
   * right to it in principle — but a wellbeing or behavioural signal can carry information a
   * school would want to deliver in person, by a named person, rather than through a portal
   * at eleven at night. The seeded catalogue turns it on for the things a school already
   * tells guardians in a report card or an invoice, and leaves it off for the two domains
   * where the first the family hears of it should be a phone call.
   */
  visible_to_guardian boolean default false not null,
  is_system boolean default false not null,
  sort_order smallint default 0 not null,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

/**
 * One pass over a cohort, at one `as_of_date`.
 *
 * `as_of_date` is what makes the module reproducible: every window is measured back from it,
 * so re-running the same scope on the same date over unchanged data produces the same bands.
 * A run that measured back from `now()` would give a different answer at nine in the morning
 * and at five in the afternoon, and nobody could ever reconcile two reports.
 *
 * `students_assessed` and `evidence_recorded` are DERIVED by triggers and refused to every
 * other writer, the same split `ai_budgets` (0032) makes between an administrator's limits and
 * the database's tally. `students_considered` is settable: it is how many students the run
 * looked at, which no row records.
 */
create table public.risk_assessment_runs (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  academic_year_id uuid not null,
  scope public.risk_run_scope not null,
  scope_id uuid,
  as_of_date date not null,
  status public.risk_run_status default 'running' not null,
  started_at timestamp with time zone default now() not null,
  finished_at timestamp with time zone,
  students_considered integer default 0 not null,
  students_assessed integer default 0 not null,
  evidence_recorded integer default 0 not null,
  narratives_generated integer default 0 not null,
  narrative_status public.risk_narrative_status default 'not_requested' not null,
  -- Which model, if any, wrote the prose in this run. Names a provider key and a model, never
  -- a credential; there is no column anywhere in this database that could hold one.
  provider_key varchar(32),
  model varchar(128),
  failure_reason varchar(1000),
  triggered_by_user_id uuid not null,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

/**
 * One student's standing at one moment: an overall band, a band per domain, and a pointer to
 * the run that produced it.
 *
 * Every band on this row is derived from `risk_evidence` by a trigger. None of them may be
 * written by the application — `risk_assessments_derived_guard` refuses it — which is what
 * makes "never a bare number a human typed" a property of the database rather than a habit.
 *
 * The overall band is the WORST domain band, and nothing else. It is deliberately not a
 * weighted score across domains: a weighted score is a number a teacher cannot argue with,
 * which is the failure mode §7 exists to prevent. "The worst thing we found, and here is what
 * it was" is a claim a teacher can disagree with, and disagreeing is the point.
 *
 * A superseded assessment is ARCHIVED and points at its replacement. The partial unique index
 * below allows exactly one live assessment per student per academic year; the history behind
 * it is never deleted.
 */
create table public.risk_assessments (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  run_id uuid not null,
  student_id uuid not null,
  academic_year_id uuid not null,
  -- Denormalised from the student's live enrollment so the cohort report can group without
  -- re-deriving enrollment as of a date that has since moved on.
  class_level_id uuid,
  section_id uuid,
  as_of_date date not null,
  overall_band public.risk_band default 'none' not null,
  academic_band public.risk_band default 'none' not null,
  attendance_band public.risk_band default 'none' not null,
  financial_band public.risk_band default 'none' not null,
  behavioural_band public.risk_band default 'none' not null,
  wellbeing_band public.risk_band default 'none' not null,
  evidence_count integer default 0 not null,
  computed_at timestamp with time zone default now() not null,
  narrative_status public.risk_narrative_status default 'not_requested' not null,
  narrative_en text,
  narrative_bn text,
  narrative_provider varchar(32),
  narrative_model varchar(128),
  superseded_by_assessment_id uuid,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

/**
 * One fact, with its figure, its threshold and where to go and look.
 *
 * This is the "Because:" list from §7, one row per bullet. Each row carries enough for a
 * teacher to reproduce it by hand: the value measured, the threshold it crossed, the period it
 * covers, how many observations were behind it, the subject where the indicator is
 * subject-specific, and `detail` — the identifiers of the underlying rows, so "four
 * assignments not submitted" is four assignment ids away from being checked rather than a
 * claim to be taken on trust.
 *
 * `summary_en` / `summary_bn` are composed from those numbers by the service, deterministically
 * and without a model. They are what the teacher reads when the provider is down, which is why
 * they are `not null` and the model's prose is nullable.
 *
 * APPEND-ONLY. See the header.
 */
create table public.risk_evidence (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  assessment_id uuid not null,
  -- Denormalised from the assessment: the student history query reads evidence directly, and
  -- joining through assessments to filter by student would defeat the index that makes it fast.
  student_id uuid not null,
  indicator_key varchar(64) not null,
  -- domain, unit, band and threshold_value are all DERIVED by `risk_evidence_derive_band` from
  -- the institution's indicator row. Whatever a caller supplies for them is overwritten.
  domain public.risk_domain not null,
  unit public.risk_measure_unit not null,
  band public.risk_band not null,
  measured_value numeric(12, 2) not null,
  -- The figure being compared against, where the indicator is a trend: the earlier period's
  -- attendance rate, the first of the three marks. Null for a level indicator.
  comparison_value numeric(12, 2),
  threshold_value numeric(12, 2) not null,
  observation_count integer not null,
  period_start date not null,
  period_end date not null,
  subject_id uuid,
  detail jsonb default '{}'::jsonb not null,
  summary_en varchar(500) not null,
  summary_bn varchar(500),
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

/**
 * What a human decided to do about it.
 *
 * Nothing writes a row here except a person: `risk_interventions_require_human` requires
 * `opened_by` to be the user id in the current request's GUC. An AI may suggest an
 * intervention, and a suggestion is a row with a status in the suggestions module —
 * `source_suggestion_id` is the soft reference back to it, deliberately not a foreign key
 * because that module ships independently of this one. Accepting a suggestion is a normal
 * permission-checked, audited call to this module made by a human, which is docs/06 §6's
 * "AI suggests → human reviews → human confirms → system executes" with no shortcut.
 */
create table public.risk_interventions (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  student_id uuid not null,
  -- The assessment that prompted it, where there was one. Nullable: a teacher who notices
  -- something before the system does should not have to wait for a run to act.
  assessment_id uuid,
  kind public.risk_intervention_kind not null,
  status public.risk_intervention_status default 'open' not null,
  title varchar(200) not null,
  details text,
  owner_employee_id uuid,
  due_on date,
  opened_by uuid not null,
  opened_at timestamp with time zone default now() not null,
  closed_by uuid,
  closed_at timestamp with time zone,
  outcome varchar(1000),
  close_reason varchar(1000),
  source_suggestion_id uuid,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

-- -------------------------------------------------------------------------------------
-- Foreign keys. `restrict` throughout for institutional parents and for the student: an
-- assessment must never be silently erased by the removal of something it refers to, and
-- students are archived rather than deleted in the first place (ADR-008).
-- -------------------------------------------------------------------------------------

alter table public.risk_indicators
  add constraint risk_indicators_tenant_fk
    foreign key (tenant_id) references public.organizations (id) on delete restrict,
  add constraint risk_indicators_institution_fk
    foreign key (institution_id) references public.institutions (id) on delete restrict;

alter table public.risk_assessment_runs
  add constraint risk_assessment_runs_tenant_fk
    foreign key (tenant_id) references public.organizations (id) on delete restrict,
  add constraint risk_assessment_runs_institution_fk
    foreign key (institution_id) references public.institutions (id) on delete restrict,
  add constraint risk_assessment_runs_year_fk
    foreign key (academic_year_id) references public.academic_years (id) on delete restrict,
  add constraint risk_assessment_runs_triggered_by_fk
    foreign key (triggered_by_user_id) references public.users (id) on delete restrict;

alter table public.risk_assessments
  add constraint risk_assessments_tenant_fk
    foreign key (tenant_id) references public.organizations (id) on delete restrict,
  add constraint risk_assessments_institution_fk
    foreign key (institution_id) references public.institutions (id) on delete restrict,
  add constraint risk_assessments_run_fk
    foreign key (run_id) references public.risk_assessment_runs (id) on delete restrict,
  add constraint risk_assessments_student_fk
    foreign key (student_id) references public.students (id) on delete restrict,
  add constraint risk_assessments_year_fk
    foreign key (academic_year_id) references public.academic_years (id) on delete restrict,
  add constraint risk_assessments_class_level_fk
    foreign key (class_level_id) references public.class_levels (id) on delete set null,
  add constraint risk_assessments_section_fk
    foreign key (section_id) references public.sections (id) on delete set null,
  add constraint risk_assessments_superseded_by_fk
    foreign key (superseded_by_assessment_id) references public.risk_assessments (id) on delete restrict;

alter table public.risk_evidence
  add constraint risk_evidence_tenant_fk
    foreign key (tenant_id) references public.organizations (id) on delete restrict,
  add constraint risk_evidence_institution_fk
    foreign key (institution_id) references public.institutions (id) on delete restrict,
  -- `restrict`, not `cascade`: an assessment is never deleted, and if one ever were, taking
  -- its reasons with it is the one outcome this whole module exists to prevent.
  add constraint risk_evidence_assessment_fk
    foreign key (assessment_id) references public.risk_assessments (id) on delete restrict,
  add constraint risk_evidence_student_fk
    foreign key (student_id) references public.students (id) on delete restrict,
  add constraint risk_evidence_subject_fk
    foreign key (subject_id) references public.subjects (id) on delete restrict;

alter table public.risk_interventions
  add constraint risk_interventions_tenant_fk
    foreign key (tenant_id) references public.organizations (id) on delete restrict,
  add constraint risk_interventions_institution_fk
    foreign key (institution_id) references public.institutions (id) on delete restrict,
  add constraint risk_interventions_student_fk
    foreign key (student_id) references public.students (id) on delete restrict,
  add constraint risk_interventions_assessment_fk
    foreign key (assessment_id) references public.risk_assessments (id) on delete restrict,
  add constraint risk_interventions_owner_fk
    foreign key (owner_employee_id) references public.employees (id) on delete set null,
  add constraint risk_interventions_opened_by_fk
    foreign key (opened_by) references public.users (id) on delete restrict;

-- -------------------------------------------------------------------------------------
-- Indexes
-- -------------------------------------------------------------------------------------

/**
 * TOTAL rather than partial-on-archive, because this is the key the evidence trigger looks an
 * indicator up by. A second "archived" row for the same key would make the derivation
 * ambiguous, and the band would then depend on which row the planner happened to find.
 */
create unique index if not exists risk_indicators_institution_key_key
  on public.risk_indicators (institution_id, key);
create index if not exists risk_indicators_tenant_idx
  on public.risk_indicators (tenant_id);
create index if not exists risk_indicators_domain_idx
  on public.risk_indicators (institution_id, domain);

create index if not exists risk_assessment_runs_tenant_idx
  on public.risk_assessment_runs (tenant_id);
create index if not exists risk_assessment_runs_institution_started_idx
  on public.risk_assessment_runs (institution_id, started_at desc);
create index if not exists risk_assessment_runs_status_idx
  on public.risk_assessment_runs (institution_id, status);

/** One live assessment per student per year; superseded ones are archived, never removed. */
create unique index if not exists risk_assessments_current_key
  on public.risk_assessments (student_id, academic_year_id)
  where archived_at is null;
create index if not exists risk_assessments_tenant_idx
  on public.risk_assessments (tenant_id);
create index if not exists risk_assessments_run_idx
  on public.risk_assessments (run_id);
-- The cohort report: live assessments for an institution, grouped by section and band.
create index if not exists risk_assessments_cohort_idx
  on public.risk_assessments (institution_id, section_id, overall_band)
  where archived_at is null;
-- The history trail for one student, newest first.
create index if not exists risk_assessments_student_history_idx
  on public.risk_assessments (student_id, computed_at desc);

create index if not exists risk_evidence_tenant_idx
  on public.risk_evidence (tenant_id);
create index if not exists risk_evidence_assessment_idx
  on public.risk_evidence (assessment_id);
create index if not exists risk_evidence_student_idx
  on public.risk_evidence (student_id, created_at desc);
create index if not exists risk_evidence_indicator_idx
  on public.risk_evidence (institution_id, indicator_key);

create index if not exists risk_interventions_tenant_idx
  on public.risk_interventions (tenant_id);
create index if not exists risk_interventions_status_idx
  on public.risk_interventions (institution_id, status);
create index if not exists risk_interventions_student_idx
  on public.risk_interventions (student_id, opened_at desc);
create index if not exists risk_interventions_assessment_idx
  on public.risk_interventions (assessment_id);

-- -------------------------------------------------------------------------------------
-- Check constraints — the invariants that belong in the database, not only in Zod.
-- -------------------------------------------------------------------------------------

alter table public.risk_indicators
  add constraint risk_indicators_key_format check (key ~ '^[a-z][a-z0-9_]{2,63}$'),
  add constraint risk_indicators_name_present check (length(btrim(name_en)) > 0),
  add constraint risk_indicators_window_sane check (window_days between 1 and 3650),
  add constraint risk_indicators_baseline_sane check (
    baseline_window_days is null or baseline_window_days between 1 and 3650
  ),
  add constraint risk_indicators_min_observations_positive check (min_observations >= 1),
  /**
   * The thresholds must be ordered the way the direction says, or the band derivation is
   * nonsense: an attendance indicator whose "high" ceiling is above its "medium" one would
   * put every student in the worst band. The constraint is what makes a mis-typed
   * configuration a rejected PUT rather than a school-wide false alarm.
   */
  add constraint risk_indicators_thresholds_ordered check (
    case direction
      when 'above' then
        threshold_medium <= threshold_high
        and (threshold_low is null or threshold_low <= threshold_medium)
      when 'below' then
        threshold_medium >= threshold_high
        and (threshold_low is null or threshold_low >= threshold_medium)
    end
  );

alter table public.risk_assessment_runs
  -- A scope of `institution` names no row; every other scope must name one. Half a scope is a
  -- run nobody can reproduce.
  add constraint risk_assessment_runs_scope_complete check (
    (scope = 'institution' and scope_id is null)
    or (scope <> 'institution' and scope_id is not null)
  ),
  add constraint risk_assessment_runs_counts_non_negative check (
    students_considered >= 0 and students_assessed >= 0
    and evidence_recorded >= 0 and narratives_generated >= 0
  ),
  add constraint risk_assessment_runs_finished_when_done check (
    (status = 'running' and finished_at is null)
    or (status <> 'running' and finished_at is not null)
  ),
  -- A failed run says why. A failure with no reason is an incident nobody can act on.
  add constraint risk_assessment_runs_failure_explained check (
    status <> 'failed' or (failure_reason is not null and length(btrim(failure_reason)) > 0)
  ),
  -- Model attribution is all-or-nothing, exactly as on `ai_messages` (0032).
  add constraint risk_assessment_runs_provider_attribution check (
    (provider_key is null and model is null) or (provider_key is not null and model is not null)
  );

alter table public.risk_assessments
  add constraint risk_assessments_evidence_count_non_negative check (evidence_count >= 0),
  /**
   * THE "ABSENT RATHER THAN INVENTED" RULE, as a constraint.
   *
   * Prose exists only when a provider produced it, and then it names the provider and the
   * model that did. When the provider was unavailable the columns are null — there is no
   * representable state in which a narrative exists without an attribution, so a fabricated
   * sentence cannot be stored as though a model had written it.
   */
  add constraint risk_assessments_narrative_attribution check (
    case narrative_status
      when 'generated' then
        narrative_en is not null and length(btrim(narrative_en)) > 0
        and narrative_provider is not null and narrative_model is not null
      else
        narrative_en is null and narrative_bn is null
        and narrative_provider is null and narrative_model is null
    end
  ),
  -- A superseded assessment is an archived one. The two states cannot drift apart.
  add constraint risk_assessments_superseded_is_archived check (
    superseded_by_assessment_id is null or archived_at is not null
  ),
  add constraint risk_assessments_not_self_superseded check (
    superseded_by_assessment_id is null or superseded_by_assessment_id <> id
  );

alter table public.risk_evidence
  -- Evidence records a CROSSING. A measurement that crossed nothing is not a reason, and a
  -- list of non-reasons is how three facts a teacher needs get buried under twenty that mean
  -- nothing.
  add constraint risk_evidence_band_is_a_crossing check (band <> 'none'),
  add constraint risk_evidence_observation_count_positive check (observation_count >= 1),
  add constraint risk_evidence_period_ordered check (period_start <= period_end),
  add constraint risk_evidence_detail_is_object check (jsonb_typeof(detail) = 'object'),
  add constraint risk_evidence_summary_present check (length(btrim(summary_en)) > 0);

alter table public.risk_interventions
  add constraint risk_interventions_title_present check (length(btrim(title)) > 0),
  /**
   * A closed intervention says who closed it, when, and what happened. "Closed" with no
   * outcome is the state that makes an intervention register worthless six months later,
   * when somebody asks whether the meeting ever happened.
   */
  add constraint risk_interventions_closure_complete check (
    case
      when status in ('closed', 'cancelled') then
        closed_by is not null and closed_at is not null
        and close_reason is not null and length(btrim(close_reason)) > 0
      else closed_by is null and closed_at is null
    end
  );

-- -------------------------------------------------------------------------------------
-- The band rule, as ONE function.
--
-- Both the insert trigger and every measurement query call this. One implementation is the
-- point: a selection query that decided "does this cross?" with its own comparison would
-- eventually disagree with the trigger that decides "which band is this?", and the disagreement
-- would show up as evidence rows that vanish, or bands that do not match their reasons.
-- -------------------------------------------------------------------------------------

create or replace function public.risk_band_for(
  p_direction public.risk_indicator_direction,
  p_value numeric,
  p_threshold_low numeric,
  p_threshold_medium numeric,
  p_threshold_high numeric
) returns public.risk_band
language sql
immutable
as $$
  select case
    when p_value is null then 'none'::public.risk_band
    when p_direction = 'above' then
      case
        when p_value >= p_threshold_high then 'high'::public.risk_band
        when p_value >= p_threshold_medium then 'medium'::public.risk_band
        when p_threshold_low is not null and p_value >= p_threshold_low
          then 'low'::public.risk_band
        else 'none'::public.risk_band
      end
    else
      case
        when p_value <= p_threshold_high then 'high'::public.risk_band
        when p_value <= p_threshold_medium then 'medium'::public.risk_band
        when p_threshold_low is not null and p_value <= p_threshold_low
          then 'low'::public.risk_band
        else 'none'::public.risk_band
      end
  end;
$$;

comment on function public.risk_band_for(
  public.risk_indicator_direction, numeric, numeric, numeric, numeric
) is
'The single comparison between a measured value and an institution''s thresholds. Called by '
'risk_evidence_derive_band and by every measurement query, so "does this cross?" and "which '
'band is this?" can never disagree.';

/** The threshold a band was reached at, for the evidence row to record beside its figure. */
create or replace function public.risk_threshold_for(
  p_band public.risk_band,
  p_threshold_low numeric,
  p_threshold_medium numeric,
  p_threshold_high numeric
) returns numeric
language sql
immutable
as $$
  select case p_band
    when 'high' then p_threshold_high
    when 'medium' then p_threshold_medium
    when 'low' then p_threshold_low
    else null
  end;
$$;

-- -------------------------------------------------------------------------------------
-- Trigger 1: an evidence row's band, domain, unit and threshold are derived from the
-- institution's own indicator row — never from what the caller supplied.
--
-- This is where "thresholds are configuration, not code" becomes true. The application says
-- "this student's attendance measured 78.00 over these dates"; the DATABASE decides that 78
-- is a medium crossing for this institution, because this institution's medium threshold is
-- 80. Change the row, and the next run bands differently with no deploy.
-- -------------------------------------------------------------------------------------

create or replace function risk_evidence_derive_band() returns trigger
language plpgsql
as $$
declare
  indicator public.risk_indicators%rowtype;
begin
  select * into indicator
  from public.risk_indicators
  where institution_id = new.institution_id and key = new.indicator_key;

  if not found then
    raise exception
      'risk_evidence references indicator "%" which this institution does not have',
      new.indicator_key
      using errcode = 'foreign_key_violation';
  end if;

  if not indicator.is_enabled or indicator.archived_at is not null then
    raise exception
      'risk indicator "%" is switched off for this institution; it cannot produce evidence',
      new.indicator_key
      using errcode = 'check_violation';
  end if;

  -- The uncertainty floor. An attendance rate over four sessions is noise, and noise
  -- presented as a reason is worse than silence.
  if new.observation_count < indicator.min_observations then
    raise exception
      'indicator "%" needs at least % observations; this evidence has %',
      new.indicator_key, indicator.min_observations, new.observation_count
      using errcode = 'check_violation';
  end if;

  new.domain := indicator.domain;
  new.unit := indicator.unit;
  new.band := public.risk_band_for(
    indicator.direction, new.measured_value,
    indicator.threshold_low, indicator.threshold_medium, indicator.threshold_high
  );

  if new.band = 'none' then
    raise exception
      'indicator "%" measured % which crosses no threshold; evidence records a crossing',
      new.indicator_key, new.measured_value
      using errcode = 'check_violation';
  end if;

  new.threshold_value := public.risk_threshold_for(
    new.band, indicator.threshold_low, indicator.threshold_medium, indicator.threshold_high
  );

  return new;
end
$$;

drop trigger if exists risk_evidence_derive_band on public.risk_evidence;
create trigger risk_evidence_derive_band
  before insert on public.risk_evidence
  for each row execute function risk_evidence_derive_band();

-- -------------------------------------------------------------------------------------
-- Trigger 2: the assessment's bands are recomputed from its evidence, and the run's counters
-- follow.
--
-- The overall band is the worst domain band — `order by band desc limit 1` over the evidence,
-- which works because `risk_band` is declared in increasing severity. `limit 1` rather than
-- `max()` so the derivation does not depend on an aggregate existing for enum types.
--
-- No upsert, no signed delta, so the 0031 trap is not reachable here: the assessment exists
-- before its evidence and the run exists before its assessments, and both counters only ever
-- go up. Anyone adding a decrement must read 0031 first.
-- -------------------------------------------------------------------------------------

create or replace function risk_evidence_apply_bands() returns trigger
language plpgsql
as $$
declare
  affected_run uuid;
begin
  perform set_config('app.risk_derived_writer', 'on', true);

  update public.risk_assessments a
     set academic_band = coalesce((
           select e.band from public.risk_evidence e
            where e.assessment_id = a.id and e.domain = 'academic'
            order by e.band desc limit 1), 'none'),
         attendance_band = coalesce((
           select e.band from public.risk_evidence e
            where e.assessment_id = a.id and e.domain = 'attendance'
            order by e.band desc limit 1), 'none'),
         financial_band = coalesce((
           select e.band from public.risk_evidence e
            where e.assessment_id = a.id and e.domain = 'financial'
            order by e.band desc limit 1), 'none'),
         behavioural_band = coalesce((
           select e.band from public.risk_evidence e
            where e.assessment_id = a.id and e.domain = 'behavioural'
            order by e.band desc limit 1), 'none'),
         wellbeing_band = coalesce((
           select e.band from public.risk_evidence e
            where e.assessment_id = a.id and e.domain = 'wellbeing'
            order by e.band desc limit 1), 'none'),
         overall_band = coalesce((
           select e.band from public.risk_evidence e
            where e.assessment_id = a.id
            order by e.band desc limit 1), 'none'),
         evidence_count = (
           select count(*) from public.risk_evidence e where e.assessment_id = a.id)
   where a.id = new.assessment_id
  returning a.run_id into affected_run;

  if affected_run is not null then
    update public.risk_assessment_runs
       set evidence_recorded = evidence_recorded + 1
     where id = affected_run;
  end if;

  perform set_config('app.risk_derived_writer', 'off', true);
  return null;
end
$$;

drop trigger if exists risk_evidence_apply_bands on public.risk_evidence;
create trigger risk_evidence_apply_bands
  after insert on public.risk_evidence
  for each row execute function risk_evidence_apply_bands();

-- -------------------------------------------------------------------------------------
-- Trigger 3: evidence is append-only.
--
-- Same shape as ai_messages (0032) and stock_movements (0025): the migrator stays exempt so
-- retention and change-controlled repair remain possible; every other role is refused. A
-- corrected measurement is a NEW run producing a NEW assessment, which is also how the
-- history stays honest — the March figure is still there in December.
-- -------------------------------------------------------------------------------------

create or replace function risk_evidence_reject_mutation() returns trigger
language plpgsql
as $$
begin
  if pg_has_role(current_user, 'shikkha_migrator', 'MEMBER') then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  raise exception
    'risk_evidence is append-only; it records what the school knew about a child on a date. Re-run the assessment instead. % is not permitted for role %',
    tg_op, current_user
    using errcode = 'insufficient_privilege';
end
$$;

drop trigger if exists risk_evidence_no_mutation on public.risk_evidence;
create trigger risk_evidence_no_mutation
  before update or delete on public.risk_evidence
  for each row execute function risk_evidence_reject_mutation();

-- -------------------------------------------------------------------------------------
-- Trigger 4: the derived columns on an assessment belong to trigger 2 alone.
--
-- Narrower than a whole-row guard, for the same reason `ai_budgets_derived_guard` is: the rest
-- of the row is legitimately writable — a superseded assessment is archived, a narrative is
-- attached after the provider answers. What may not be written is a BAND, because a band that
-- the application can set is a band that can disagree with its evidence, and the entire point
-- of §7 is that it cannot.
--
-- DELETE is refused outright: a student's risk history is never deleted (ADR-008).
-- -------------------------------------------------------------------------------------

create or replace function risk_assessments_guard_derived_columns() returns trigger
language plpgsql
as $$
begin
  if pg_has_role(current_user, 'shikkha_migrator', 'MEMBER') then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if coalesce(current_setting('app.risk_derived_writer', true), '') = 'on' then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    raise exception
      'risk_assessments rows are never deleted; a superseded assessment is archived so that what the school knew in March is still answerable in December'
      using errcode = 'insufficient_privilege';
  end if;

  if tg_op = 'INSERT'
     and (new.overall_band <> 'none' or new.academic_band <> 'none'
          or new.attendance_band <> 'none' or new.financial_band <> 'none'
          or new.behavioural_band <> 'none' or new.wellbeing_band <> 'none'
          or new.evidence_count <> 0) then
    raise exception
      'risk band and evidence count are derived from risk_evidence; a new assessment starts at none/0 and its evidence sets it'
      using errcode = 'insufficient_privilege';
  end if;

  if tg_op = 'UPDATE'
     and (new.overall_band is distinct from old.overall_band
          or new.academic_band is distinct from old.academic_band
          or new.attendance_band is distinct from old.attendance_band
          or new.financial_band is distinct from old.financial_band
          or new.behavioural_band is distinct from old.behavioural_band
          or new.wellbeing_band is distinct from old.wellbeing_band
          or new.evidence_count is distinct from old.evidence_count) then
    raise exception
      'risk bands are derived from risk_evidence; record evidence instead of writing a band'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end
$$;

drop trigger if exists risk_assessments_derived_guard on public.risk_assessments;
create trigger risk_assessments_derived_guard
  before insert or update or delete on public.risk_assessments
  for each row execute function risk_assessments_guard_derived_columns();

-- -------------------------------------------------------------------------------------
-- Trigger 5: an assessment counts against its run, once.
-- -------------------------------------------------------------------------------------

create or replace function risk_assessments_count_on_run() returns trigger
language plpgsql
as $$
begin
  perform set_config('app.risk_derived_writer', 'on', true);
  update public.risk_assessment_runs
     set students_assessed = students_assessed + 1
   where id = new.run_id;
  perform set_config('app.risk_derived_writer', 'off', true);
  return null;
end
$$;

drop trigger if exists risk_assessments_count_on_run on public.risk_assessments;
create trigger risk_assessments_count_on_run
  after insert on public.risk_assessments
  for each row execute function risk_assessments_count_on_run();

-- -------------------------------------------------------------------------------------
-- Trigger 6: THE ONE THAT MATTERS. No assessment may exist without evidence.
--
-- A DEFERRED constraint trigger, so the check happens at COMMIT rather than at the INSERT that
-- necessarily precedes the evidence. If a run writes a band and then fails to write the
-- reasons for it, the whole transaction is refused — the school is never shown a score it
-- cannot argue with, and there is no code path, present or future, through which one can be
-- stored.
-- -------------------------------------------------------------------------------------

create or replace function risk_assessments_require_evidence() returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1 from public.risk_evidence e where e.assessment_id = new.id
  ) then
    raise exception
      'risk assessment % has no evidence. docs/06 §7: a number with no reasons cannot be argued with, so this module does not store one',
      new.id
      using errcode = 'check_violation';
  end if;
  return null;
end
$$;

drop trigger if exists risk_assessments_evidence_required on public.risk_assessments;
create constraint trigger risk_assessments_evidence_required
  after insert on public.risk_assessments
  deferrable initially deferred
  for each row execute function risk_assessments_require_evidence();

-- -------------------------------------------------------------------------------------
-- Trigger 7: an intervention names the human who opened it, and is never deleted.
--
-- `opened_by` must be the user id in the current request's GUC — the one `withTenantContext`
-- sets from the authenticated principal. A background process, a service account, or anything
-- else running without a user therefore cannot create an intervention at all, which is the
-- structural half of docs/06 §6: AI suggests, a human confirms, and the confirmation is that
-- human's own authenticated, permission-checked, audited call.
-- -------------------------------------------------------------------------------------

create or replace function risk_interventions_require_human() returns trigger
language plpgsql
as $$
declare
  actor uuid;
begin
  if pg_has_role(current_user, 'shikkha_migrator', 'MEMBER') then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    raise exception
      'risk_interventions rows are never deleted; archive the record instead'
      using errcode = 'insufficient_privilege';
  end if;

  actor := app_current_user_id();

  if actor is null then
    raise exception
      'an intervention is a human decision and must be opened by an authenticated user; no user is set on this session'
      using errcode = 'insufficient_privilege';
  end if;

  if tg_op = 'INSERT' and new.opened_by is distinct from actor then
    raise exception
      'risk_interventions.opened_by must be the acting user; an intervention cannot be attributed to somebody who did not open it'
      using errcode = 'insufficient_privilege';
  end if;

  if tg_op = 'UPDATE' and new.opened_by is distinct from old.opened_by then
    raise exception
      'risk_interventions.opened_by is fixed at creation'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end
$$;

drop trigger if exists risk_interventions_human_only on public.risk_interventions;
create trigger risk_interventions_human_only
  before insert or update or delete on public.risk_interventions
  for each row execute function risk_interventions_require_human();

-- -------------------------------------------------------------------------------------
-- Trigger 8: a run is never deleted, and its derived counters belong to triggers 2 and 5.
-- -------------------------------------------------------------------------------------

create or replace function risk_runs_guard_derived_columns() returns trigger
language plpgsql
as $$
begin
  if pg_has_role(current_user, 'shikkha_migrator', 'MEMBER') then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if coalesce(current_setting('app.risk_derived_writer', true), '') = 'on' then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    raise exception
      'risk_assessment_runs rows are never deleted; a run is the provenance of every assessment it produced'
      using errcode = 'insufficient_privilege';
  end if;

  if tg_op = 'INSERT' and (new.students_assessed <> 0 or new.evidence_recorded <> 0) then
    raise exception
      'risk_assessment_runs.students_assessed and evidence_recorded are derived; a new run starts at zero'
      using errcode = 'insufficient_privilege';
  end if;

  if tg_op = 'UPDATE'
     and (new.students_assessed is distinct from old.students_assessed
          or new.evidence_recorded is distinct from old.evidence_recorded) then
    raise exception
      'risk_assessment_runs.students_assessed and evidence_recorded are derived from the rows the run produced'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end
$$;

drop trigger if exists risk_runs_derived_guard on public.risk_assessment_runs;
create trigger risk_runs_derived_guard
  before insert or update or delete on public.risk_assessment_runs
  for each row execute function risk_runs_guard_derived_columns();

-- -------------------------------------------------------------------------------------
-- Row-level security, grants and updated_at for the new tables. The catalogue loop in 0002
-- does not re-run for tables created later, so it is restated here — policy copied verbatim
-- from 0032.
-- -------------------------------------------------------------------------------------

do $$
declare
  target text;
  early_warning_tables constant text[] := array[
    'risk_indicators',
    'risk_assessment_runs',
    'risk_assessments',
    'risk_evidence',
    'risk_interventions'
  ];
begin
  foreach target in array early_warning_tables
  loop
    execute format('alter table public.%I enable row level security', target);
    execute format('alter table public.%I force row level security', target);

    execute format('drop policy if exists tenant_isolation on public.%I', target);

    execute format($p$
      create policy tenant_isolation on public.%I
        for all
        using (
          app_is_platform_admin()
          or (tenant_id is not null and tenant_id = app_current_tenant_id())
        )
        with check (
          app_is_platform_admin()
          or (tenant_id is not null and tenant_id = app_current_tenant_id())
        )
    $p$, target);

    execute format('grant select, insert, update, delete on public.%I to shikkha_app', target);
    execute format('grant select on public.%I to shikkha_readonly', target);

    execute format('drop trigger if exists set_updated_at on public.%I', target);
    execute format(
      'create trigger set_updated_at before update on public.%I
         for each row execute function set_updated_at()',
      target
    );
  end loop;
end
$$;

-- -------------------------------------------------------------------------------------
-- The system indicator catalogue, for every institution that exists today.
--
-- These eight are the signals this release can actually MEASURE — each has a query behind it
-- in `apps/api/src/modules/early-warning/indicators.ts`, and the key is what binds the two.
-- An institution created after this migration gets the same eight from that service the first
-- time the catalogue is read; the two lists must be kept in step, exactly as 0030's automation
-- rules and `DEFAULT_RULES` are.
--
-- `visible_to_guardian` is the interesting column. Attendance, marks, homework, fees and
-- library items are things a school already tells a guardian in a report card or an invoice.
-- Behaviour and wellbeing are not: a guardian learning from a portal at eleven at night that
-- the school has flagged their child's wellbeing is the wrong way for that conversation to
-- start. Those two stay off until a school decides otherwise, in writing, through the settings
-- endpoint.
-- -------------------------------------------------------------------------------------

do $$
declare
  inst record;
begin
  for inst in select id, tenant_id from public.institutions loop
    insert into public.risk_indicators
      (tenant_id, institution_id, key, name_en, name_bn, description, domain, unit, direction,
       window_days, baseline_window_days, min_observations,
       threshold_low, threshold_medium, threshold_high,
       is_enabled, visible_to_guardian, is_system, sort_order)
    values
      (inst.tenant_id, inst.id, 'attendance_rate_low',
       'Attendance below the school''s norm', 'উপস্থিতির হার নির্ধারিত মানের নিচে',
       'The share of sessions attended over the window, counting a half day as half.',
       'attendance', 'percent', 'below', 60, null, 20, 90, 80, 70, true, true, true, 10),

      (inst.tenant_id, inst.id, 'attendance_rate_drop',
       'Attendance falling against the previous period', 'আগের সময়ের তুলনায় উপস্থিতি কমছে',
       'How many percentage points attendance has fallen against the preceding window of equal length.',
       'attendance', 'points', 'above', 45, 45, 15, 5, 10, 20, true, true, true, 20),

      (inst.tenant_id, inst.id, 'subject_mark_decline',
       'Marks declining in a subject', 'কোনো বিষয়ে নম্বর কমছে',
       'The fall in percentage between the first and the most recent assessment in one subject.',
       'academic', 'points', 'above', 180, null, 3, 8, 15, 25, true, true, true, 30),

      (inst.tenant_id, inst.id, 'homework_missed',
       'Homework not submitted', 'জমা না দেওয়া বাড়ির কাজ',
       'Published assignments whose due date has passed with no submission from this student.',
       'academic', 'count', 'above', 60, null, 1, 2, 4, 8, true, true, true, 40),

      (inst.tenant_id, inst.id, 'fee_overdue_days',
       'Fees overdue', 'বকেয়া ফি',
       'Days past the due date of the oldest invoice that still carries a balance.',
       'financial', 'days', 'above', 365, null, 1, 15, 30, 60, true, true, true, 50),

      (inst.tenant_id, inst.id, 'library_overdue_items',
       'Library books overdue', 'ফেরত না দেওয়া গ্রন্থাগারের বই',
       'Library copies still out past their due date.',
       'financial', 'count', 'above', 365, null, 1, 1, 3, 5, true, true, true, 60),

      (inst.tenant_id, inst.id, 'behaviour_incidents',
       'Substantiated behaviour records', 'প্রমাণিত আচরণগত রেকর্ড',
       'Behaviour records substantiated within the window. Draft and unsubstantiated records are never counted.',
       'behavioural', 'count', 'above', 90, null, 1, 1, 2, 4, true, false, true, 70),

      (inst.tenant_id, inst.id, 'absence_streak',
       'Consecutive days absent', 'টানা অনুপস্থিতির দিন',
       'The longest run of consecutive school days marked absent within the window.',
       'wellbeing', 'count', 'above', 90, null, 1, 3, 5, 10, true, false, true, 80)
    on conflict (institution_id, key) do nothing;
  end loop;
end
$$;

-- -------------------------------------------------------------------------------------
-- Assertions — fail the migration rather than ship a silently-disabled control.
-- -------------------------------------------------------------------------------------

do $$
declare
  offending text;
  early_warning_tables constant text[] := array[
    'risk_indicators', 'risk_assessment_runs', 'risk_assessments',
    'risk_evidence', 'risk_interventions'
  ];
  required_triggers constant text[][] := array[
    array['risk_evidence_derive_band', 'public.risk_evidence'],
    array['risk_evidence_apply_bands', 'public.risk_evidence'],
    array['risk_evidence_no_mutation', 'public.risk_evidence'],
    array['risk_assessments_derived_guard', 'public.risk_assessments'],
    array['risk_assessments_count_on_run', 'public.risk_assessments'],
    array['risk_assessments_evidence_required', 'public.risk_assessments'],
    array['risk_interventions_human_only', 'public.risk_interventions'],
    array['risk_runs_derived_guard', 'public.risk_assessment_runs']
  ];
  pair text[];
begin
  -- Named explicitly rather than relying only on the global sweep below, so that a typo in
  -- the loop above is a failed migration instead of a table nobody notices is unprotected.
  select string_agg(c.relname, ', ' order by c.relname)
  into offending
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relname = any (early_warning_tables)
    and (
      not c.relrowsecurity
      or not c.relforcerowsecurity
      or not exists (
        select 1 from pg_policy p where p.polrelid = c.oid and p.polname = 'tenant_isolation'
      )
    );

  if offending is not null then
    raise exception
      'Early-warning tables without forced row-level security and a tenant_isolation policy: %',
      offending;
  end if;

  select string_agg(t.name, ', ' order by t.name)
  into offending
  from unnest(early_warning_tables) as t(name)
  where not exists (
    select 1
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = t.name
      and a.attname = 'tenant_id' and a.attnum > 0 and not a.attisdropped
  );
  if offending is not null then
    raise exception 'Early-warning tables without a tenant_id column: %', offending;
  end if;

  select string_agg(t.name, ', ' order by t.name)
  into offending
  from unnest(early_warning_tables) as t(name)
  where not exists (
    select 1
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = t.name
      and a.attname = 'institution_id' and a.attnum > 0 and not a.attisdropped
  );
  if offending is not null then
    raise exception 'Early-warning tables without an institution_id column: %', offending;
  end if;

  foreach pair slice 1 in array required_triggers loop
    if not exists (
      select 1 from pg_trigger
      where tgname = pair[1] and tgrelid = pair[2]::regclass and not tgisinternal
    ) then
      raise exception 'early-warning trigger % on % is missing', pair[1], pair[2];
    end if;
  end loop;

  -- The evidence requirement must be DEFERRED, or it fires before the evidence it is waiting
  -- for could possibly have been written and no assessment could ever be created at all.
  if not exists (
    select 1 from pg_trigger
    where tgname = 'risk_assessments_evidence_required'
      and tgrelid = 'public.risk_assessments'::regclass
      and tgdeferrable and tginitdeferred
  ) then
    raise exception
      'risk_assessments_evidence_required is not a deferred constraint trigger; it would refuse every assessment';
  end if;
end
$$;

-- The band rule, proved rather than assumed — with the worked example from docs/06 §7, so the
-- thing the module promises is checked at migration time.
do $$
declare
  band public.risk_band;
begin
  -- "Attendance fell from 93% to 78%": a 15-point drop, against thresholds 5 / 10 / 20.
  band := public.risk_band_for('above', 15, 5, 10, 20);
  if band <> 'medium' then
    raise exception 'a 15-point attendance drop should band medium, got %', band;
  end if;

  -- …and the level indicator sees the same student at 78% against 90 / 80 / 70.
  band := public.risk_band_for('below', 78, 90, 80, 70);
  if band <> 'medium' then
    raise exception '78%% attendance should band medium, got %', band;
  end if;

  -- "Mathematics declined across three assessments (72 → 61 → 54)": 18 points, thresholds
  -- 8 / 15 / 25.
  band := public.risk_band_for('above', 18, 8, 15, 25);
  if band <> 'medium' then
    raise exception 'an 18-point mark decline should band medium, got %', band;
  end if;

  -- "Four assignments not submitted", thresholds 2 / 4 / 8.
  band := public.risk_band_for('above', 4, 2, 4, 8);
  if band <> 'medium' then
    raise exception 'four missed assignments should band medium, got %', band;
  end if;

  -- A student who is fine crosses nothing, and therefore produces no evidence and no
  -- assessment at all.
  band := public.risk_band_for('below', 96, 90, 80, 70);
  if band <> 'none' then
    raise exception '96%% attendance should cross nothing, got %', band;
  end if;

  -- A band with no `low` threshold configured falls straight from medium to none.
  band := public.risk_band_for('above', 1, null, 2, 4);
  if band <> 'none' then
    raise exception 'a value below the medium threshold with no low threshold should be none, got %', band;
  end if;
end
$$;

-- Every institution that existed when this ran carries the full catalogue.
do $$
declare
  offending text;
begin
  select string_agg(i.id::text, ', ')
  into offending
  from public.institutions i
  where (select count(*) from public.risk_indicators r where r.institution_id = i.id) <> 8;

  if offending is not null then
    raise exception 'institutions without the eight system risk indicators: %', offending;
  end if;
end
$$;

-- The global sweep: every public table is either RLS-protected or explicitly exempt.
select assert_rls_coverage();
