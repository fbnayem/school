-- =====================================================================================
-- 0034 — AI suggestions: the row that makes "AI suggests, a human confirms" structural
--        (Phase 33 — the copilots)
--
-- docs/06_AI_ARCHITECTURE.md §6 lists what an AI must never do on its own: change grades or
-- attendance, approve admissions, determine punishment, issue refunds, change salary, run
-- payroll, create accounting entries, delete records, send sensitive mass communications.
-- For every one of them the rule is the same sentence:
--
--   "AI suggests → human reviews → human confirms → system executes."
--
-- A sentence in a document is a hope. This table is the mechanism. A copilot's output is a
-- ROW WITH A STATUS — never a mutation, and never a message that some later job replays —
-- and the confirmation is a normal permission-checked, audited API call made by a person.
--
-- Six properties are enforced HERE rather than in the service, because each is one the
-- application can get wrong exactly once and never notice:
--
--   1. **A suggestion's content is frozen at birth.** `ai_suggestions_content_immutable`
--      refuses any UPDATE that changes the title, the body, the evidence, the proposed
--      action, the confidence band, the subject or the permission accepting it requires.
--      A human who clicks "accept" is accepting what they READ; if the body could be
--      rewritten between the render and the click — by a later copilot turn, by a bug, by a
--      compromised application — then the audit trail records a consent that was never given.
--      Only the *decision* columns and the archive columns move after insert.
--   2. **Evidence is structural, not decorative.** `evidence` must be a non-empty JSON array
--      whose every entry names its `source` (the tool or query that produced the fact) and
--      states the fact. docs/06 §7: uncertainty is reported with evidence, never as a bare
--      score, because "a number with no reasons cannot be argued with, and a teacher who
--      cannot argue with it will either follow it blindly or ignore it entirely". A
--      suggestion carrying no checkable reason is unrepresentable in this schema.
--   3. **Confidence is a BAND, not a percentage.** `low` / `medium` / `high`. A language
--      model cannot calibrate a probability — 84% out of a model is a number with the shape
--      of evidence and none of the substance, and it survives every later retelling as if it
--      had been measured. A band cannot be mistaken for a measurement, and it forces the
--      reader down to the evidence rows, which is where the argument actually is.
--   4. **The decision fields are consistent by construction.** Pending implies no decider;
--      accepted or dismissed implies both a decider and a timestamp — a CHECK, because it is
--      a property of a single row. That a decided suggestion never returns to pending is a
--      property of a *transition*, so it is a trigger.
--   5. **Nothing is ever hard-deleted** (ADR-008). A suggestion is the record of what an AI
--      proposed and what a human did about it; the first time anyone needs it will be an
--      argument about a decision it influenced.
--   6. **At most one pending suggestion per (kind, subject).** A partial unique index. A
--      copilot asked the same question twice must not leave two identical pending rows about
--      one child for a teacher to decide twice — and a reviewer who has dismissed one should
--      not see it reappear as a fresh row on the next turn.
--
-- `expires_at` is NOT NULL and has no default that means "never". A suggestion rests on facts
-- that were true when it was generated: an outstanding balance, an attendance percentage, a
-- vacant period next Tuesday. Those move. Accepting a two-month-old fee reminder sends a
-- parent a figure the ledger stopped agreeing with in April, and the parent is right and the
-- school is wrong. So the row carries the date past which it must not be acted on, and the
-- accept path refuses after it rather than trusting a screen to have hidden it.
--
-- `proposed_action` is the exact payload the owning module's own endpoint would receive, and
-- NOTHING else — no free prose, no second copy of the reasoning. The accept path validates it
-- against that module's own Zod schema and hands it to that module's own service, so the
-- module's validation, its permission checks and its audit row all still run. That is what
-- keeps this table from becoming a side door into every other module.
--
-- `subject_type` / `subject_id` are a soft reference for the same reason
-- `ai_conversations.subject_type` is (0032): a suggestion can be about a student, an invoice,
-- an application, a section or an expense claim, and a real foreign key would need one
-- nullable column per module and would stop a subject from ever being archived.
--
-- The RLS/grants/updated_at loop from 0002 does not re-run for tables created later, so it is
-- restated at the bottom, followed by named assertions and assert_rls_coverage().
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- Enumerations. Every one of these is genuinely closed: adding a kind adds an accept
-- handler, an action permission and a validated payload schema in the same release.
-- -------------------------------------------------------------------------------------

/**
 * What is being suggested.
 *
 * Each value names an action that already has an owner elsewhere in the system. There is
 * deliberately no `grade_change`, no `attendance_correction`, no `refund` and no `payroll_run`
 * — docs/06 §6 forbids the AI from proposing those as an executable payload at all, and a kind
 * that cannot be executed is a kind that should not exist.
 */
create type public.ai_suggestion_kind as enum (
  'attendance_follow_up',
  'fee_reminder_draft',
  'admission_shortlist_note',
  'timetable_gap_fill',
  'communication_draft',
  'expense_flag',
  'intervention_referral'
);

/**
 * Where a suggestion is in its life.
 *
 * `expired` is reached by the passage of time, `superseded` by a later suggestion about the
 * same subject replacing it. Both are system transitions and neither names a decider, which
 * is why the decision CHECK below treats them differently from `accepted` and `dismissed`.
 */
create type public.ai_suggestion_status as enum (
  'pending', 'accepted', 'dismissed', 'expired', 'superseded'
);

/**
 * How sure the suggestion is — a band, never a number. See property 3 in the header.
 *
 * The band is computed by the application from *how much evidence there is and how far the
 * observation is from the threshold*, not asked of the model. A model asked for its own
 * confidence reports its fluency, which is uncorrelated with whether the school's attendance
 * register says what it thinks it says.
 */
create type public.ai_confidence_band as enum ('low', 'medium', 'high');

/** Which copilot produced the suggestion. Each surface has its own permission and tool set. */
create type public.ai_copilot_surface as enum (
  'principal_insights', 'teacher_tools', 'accounts', 'admissions'
);

/**
 * Whether the accepted action actually happened.
 *
 * Separate from `status` because "a human agreed" and "the owning module carried it out" are
 * two different facts, and collapsing them would hide the case that matters: a suggestion
 * accepted by a person whose action the owning module then refused, because the student had
 * been transferred out or the claim had already been paid. That row must be visible, not
 * silently indistinguishable from a completed one.
 */
create type public.ai_suggestion_execution as enum ('not_started', 'executed', 'failed');

-- -------------------------------------------------------------------------------------
-- The evidence well-formedness test.
--
-- A function rather than an inline CHECK expression because a CHECK cannot contain a
-- subquery, and testing every element of an array needs one. IMMUTABLE and free of any table
-- reference, which is what makes it legal in a constraint.
-- -------------------------------------------------------------------------------------

create or replace function public.ai_suggestion_evidence_is_wellformed(evidence jsonb)
returns boolean
language sql
immutable
strict
as $$
  select jsonb_typeof(evidence) = 'array'
     and jsonb_array_length(evidence) >= 1
     and not exists (
       select 1
       from jsonb_array_elements(evidence) as entry
       where jsonb_typeof(entry) <> 'object'
          -- Where the fact came from: a tool name ('attendance.summary'), so a reviewer can
          -- re-run it and a spec can assert the figure is still the same one.
          or nullif(btrim(coalesce(entry ->> 'source', '')), '') is null
          -- What the fact IS, in words a human can disagree with.
          or nullif(btrim(coalesce(entry ->> 'statement', '')), '') is null
     );
$$;

comment on function public.ai_suggestion_evidence_is_wellformed(jsonb) is
  'Every evidence entry must name its source and state its fact: docs/06 §7 forbids a bare score.';

-- -------------------------------------------------------------------------------------
-- The table
-- -------------------------------------------------------------------------------------

create table public.ai_suggestions (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,

  kind public.ai_suggestion_kind not null,
  status public.ai_suggestion_status default 'pending' not null,
  surface public.ai_copilot_surface not null,

  -- What the suggestion is about. Soft reference — see the header.
  subject_type varchar(64) not null,
  subject_id uuid not null,

  /**
   * The person the suggestion is about, when it is about a person at all.
   *
   * Recorded so the accept path can refuse a self-decision: the member of staff whose expense
   * claim was flagged must not be the one who accepts the flag, and a guardian must not accept
   * a referral about their own child. The owning modules enforce their own versions of this
   * rule too (`decideExpenseClaim` already refuses the filer); this column is what lets the
   * refusal happen *before* the action is attempted, on a suggestion of any kind.
   */
  about_user_id uuid,

  -- The suggestion itself. Bangla where the copilot could produce it; a school that reads
  -- notices in Bangla should not have an assistant that only speaks English, and a null here
  -- is an honest "no Bangla version" rather than an English string in a Bangla field.
  title_en varchar(200) not null,
  title_bn varchar(200),
  body_en text not null,
  body_bn text,

  /**
   * The FACTS the suggestion rests on: a JSON array of
   *   { source, statement, arguments?, observed?, recordedAt? }
   * Structured rather than prose so the UI can render "because …" as a list and a human can
   * check each line independently — `source` names the tool that produced it, so re-running
   * that tool is a one-click verification rather than an act of faith.
   */
  evidence jsonb not null,

  confidence public.ai_confidence_band not null,

  /**
   * The exact, validated payload the owning module's endpoint would receive if a human
   * accepts, and nothing else:
   *   { module, action, resourceId?, payload: { … } }
   */
  proposed_action jsonb not null,

  /**
   * The permission accepting this suggestion requires — the permission of the ACTION, not of
   * the copilot.
   *
   * Written onto the row at generation time and re-derived from the kind at accept time; they
   * must agree or the accept is refused. Two independent statements of the same rule, because
   * the failure mode of one statement is that a suggestion generated under an old mapping is
   * accepted under a new one without anybody noticing the permission changed.
   */
  action_permission varchar(120) not null,

  -- Provenance: which conversation, which model, which vendor. Nullable conversation because
  -- a suggestion outlives the transcript that produced it (0032 purges on the same principle).
  generated_by_conversation_id uuid,
  model varchar(128),
  provider_key varchar(32),

  /**
   * The instant past which this must not be acted on. NOT NULL, and there is no sentinel that
   * means "never" — see the header. A stale suggestion is not merely unhelpful; acting on it
   * sends a parent a figure that stopped being true weeks ago.
   */
  expires_at timestamp with time zone not null,

  -- The decision.
  decided_by_user_id uuid,
  decided_at timestamp with time zone,
  decision_reason varchar(500),

  -- What happened when the decision was carried out.
  execution_state public.ai_suggestion_execution default 'not_started' not null,
  executed_at timestamp with time zone,
  executed_resource_type varchar(64),
  executed_resource_id uuid,
  execution_error varchar(1000),

  -- Set when a later suggestion about the same subject replaced this one.
  superseded_by_id uuid,

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
-- Foreign keys. `restrict` for institutional parents; `set null` for the two references
-- whose target may legitimately go away before the suggestion does.
-- -------------------------------------------------------------------------------------

alter table public.ai_suggestions
  add constraint ai_suggestions_tenant_fk
    foreign key (tenant_id) references public.organizations (id) on delete restrict,
  add constraint ai_suggestions_institution_fk
    foreign key (institution_id) references public.institutions (id) on delete restrict,
  -- The suggestion is evidence in its own right and outlives its transcript.
  add constraint ai_suggestions_conversation_fk
    foreign key (generated_by_conversation_id)
    references public.ai_conversations (id) on delete set null,
  add constraint ai_suggestions_decided_by_fk
    foreign key (decided_by_user_id) references public.users (id) on delete restrict,
  add constraint ai_suggestions_about_user_fk
    foreign key (about_user_id) references public.users (id) on delete restrict,
  add constraint ai_suggestions_superseded_by_fk
    foreign key (superseded_by_id) references public.ai_suggestions (id) on delete set null;

-- -------------------------------------------------------------------------------------
-- Indexes
-- -------------------------------------------------------------------------------------

create index if not exists ai_suggestions_tenant_idx
  on public.ai_suggestions (tenant_id);

-- The review queue: this institution's suggestions, newest first, filtered by status.
create index if not exists ai_suggestions_institution_status_idx
  on public.ai_suggestions (institution_id, status, created_at desc);

-- "What has the copilot said about this child / this claim / this application?"
create index if not exists ai_suggestions_subject_idx
  on public.ai_suggestions (institution_id, subject_type, subject_id);

create index if not exists ai_suggestions_kind_idx
  on public.ai_suggestions (institution_id, kind, status);

create index if not exists ai_suggestions_conversation_idx
  on public.ai_suggestions (generated_by_conversation_id);

-- The expiry sweep only ever looks at pending rows, so the index only holds pending rows.
create index if not exists ai_suggestions_pending_expiry_idx
  on public.ai_suggestions (institution_id, expires_at)
  where status = 'pending';

/**
 * At most one PENDING suggestion per (kind, subject).
 *
 * Partial on `status = 'pending'` rather than total, because the history matters: a dismissed
 * fee reminder from March and a fresh one in April are two different events and both belong in
 * the record. What must not happen is a copilot asked the same question three times leaving
 * three identical undecided rows about one child, each of which a teacher has to read and
 * decide. The generator absorbs the conflict and reports the suggestion that already exists.
 */
create unique index if not exists ai_suggestions_pending_subject_key
  on public.ai_suggestions (institution_id, kind, subject_type, subject_id)
  where status = 'pending';

-- -------------------------------------------------------------------------------------
-- Check constraints — the invariants that belong in the database rather than only in Zod.
-- -------------------------------------------------------------------------------------

alter table public.ai_suggestions
  add constraint ai_suggestions_title_present check (length(btrim(title_en)) > 0),
  add constraint ai_suggestions_body_present check (length(btrim(body_en)) > 0),
  -- A Bangla field that exists must say something. An empty string here would render as a
  -- blank card to a Bangla reader while the row claims to be bilingual.
  add constraint ai_suggestions_bangla_non_empty check (
    (title_bn is null or length(btrim(title_bn)) > 0)
    and (body_bn is null or length(btrim(body_bn)) > 0)
  ),
  add constraint ai_suggestions_subject_present check (length(btrim(subject_type)) > 0),
  add constraint ai_suggestions_action_permission_present check (
    length(btrim(action_permission)) > 0
  ),

  -- docs/06 §7, in the schema: a suggestion with no checkable reason cannot be stored.
  add constraint ai_suggestions_evidence_wellformed check (
    public.ai_suggestion_evidence_is_wellformed(evidence)
  ),

  -- The proposed action is an envelope around one module's own payload. Anything else — a
  -- bare string, an array, a payload that is not an object — is a shape no accept handler
  -- could hand to a service, and it is better refused at write time than discovered by the
  -- reviewer who clicked accept.
  add constraint ai_suggestions_proposed_action_shape check (
    jsonb_typeof(proposed_action) = 'object'
    and proposed_action ? 'module'
    and proposed_action ? 'action'
    and proposed_action ? 'payload'
    and jsonb_typeof(proposed_action -> 'payload') = 'object'
  ),

  add constraint ai_suggestions_expiry_after_creation check (expires_at > created_at),

  /**
   * Decision consistency, as a property of one row (property 4 in the header).
   *
   *   pending            → no decider, no timestamp, no reason
   *   accepted/dismissed → a decider AND a timestamp
   *   expired/superseded → neither is required; nobody decided, time did
   *
   * A CHECK rather than a trigger because it constrains a single tuple, which means it is
   * enforced on every INSERT and UPDATE including those made by the migrator.
   */
  add constraint ai_suggestions_decision_consistent check (
    (status = 'pending'
      and decided_by_user_id is null
      and decided_at is null
      and decision_reason is null)
    or (status in ('accepted', 'dismissed')
      and decided_by_user_id is not null
      and decided_at is not null)
    or status in ('expired', 'superseded')
  ),

  /**
   * Execution consistency.
   *
   * An execution outcome can only exist on an ACCEPTED suggestion — a dismissed or expired
   * suggestion that claims to have been carried out is either a bug or an attack, and neither
   * should be storable. `failed` must carry the reason it failed, because the whole point of
   * distinguishing it from `executed` is that somebody has to go and finish the job by hand.
   */
  add constraint ai_suggestions_execution_consistent check (
    (execution_state = 'not_started'
      and executed_at is null
      and executed_resource_type is null
      and executed_resource_id is null
      and execution_error is null)
    or (execution_state = 'executed'
      and status = 'accepted'
      and executed_at is not null
      and execution_error is null)
    or (execution_state = 'failed'
      and status = 'accepted'
      and executed_at is not null
      and length(btrim(coalesce(execution_error, ''))) > 0)
  ),

  -- A replacement pointer only means anything on a superseded row, and a row cannot supersede
  -- itself.
  add constraint ai_suggestions_superseded_consistent check (
    (superseded_by_id is null or status = 'superseded')
    and (superseded_by_id is null or superseded_by_id <> id)
  );

-- -------------------------------------------------------------------------------------
-- Trigger 1: the content of a suggestion is frozen at insert, and no row is ever deleted.
--
-- THIS IS THE POINT OF THE MIGRATION. A human who accepts a suggestion is accepting the words
-- they read and the evidence they checked. If the body, the evidence or — worst — the proposed
-- action could be rewritten after the fact, then "a human confirmed it" records a consent
-- nobody gave, and the audit trail is worse than useless because it is confidently wrong.
--
-- The rewrite does not have to be malicious to be fatal: a later copilot turn "refreshing" a
-- suggestion in place, or an ORM `.set()` that includes an unchanged-looking field, produces
-- the same outcome. So the freeze is a database rule, refused for every role but the migrator,
-- rather than a convention in a service that a future author has to know about.
--
-- What may still move: the decision columns, the execution outcome, the supersession pointer,
-- the version, and the archive columns. Those are the record of what happened *to* the
-- suggestion, which is exactly what must stay writable.
--
-- Same shape as ai_messages_no_mutation (0032), workflow_actions (0014) and stock_movements
-- (0025): the migrator is exempt so retention and change-controlled repair stay possible.
-- -------------------------------------------------------------------------------------

create or replace function ai_suggestions_reject_content_mutation() returns trigger
language plpgsql
as $$
begin
  if pg_has_role(current_user, 'shikkha_migrator', 'MEMBER') then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    raise exception
      'ai_suggestions rows are never deleted; a suggestion is the record of what an AI proposed and what a person did about it. Archive it instead'
      using errcode = 'insufficient_privilege';
  end if;

  if new.id is distinct from old.id
     or new.tenant_id is distinct from old.tenant_id
     or new.institution_id is distinct from old.institution_id
     or new.kind is distinct from old.kind
     or new.surface is distinct from old.surface
     or new.subject_type is distinct from old.subject_type
     or new.subject_id is distinct from old.subject_id
     or new.about_user_id is distinct from old.about_user_id
     or new.title_en is distinct from old.title_en
     or new.title_bn is distinct from old.title_bn
     or new.body_en is distinct from old.body_en
     or new.body_bn is distinct from old.body_bn
     or new.evidence is distinct from old.evidence
     or new.confidence is distinct from old.confidence
     or new.proposed_action is distinct from old.proposed_action
     or new.action_permission is distinct from old.action_permission
     or new.generated_by_conversation_id is distinct from old.generated_by_conversation_id
     or new.model is distinct from old.model
     or new.provider_key is distinct from old.provider_key
     or new.expires_at is distinct from old.expires_at
     or new.created_at is distinct from old.created_at
  then
    raise exception
      'the content of an ai_suggestion is immutable: a person who accepts one is accepting what they read. Only the decision, execution and archive columns may change'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end
$$;

drop trigger if exists ai_suggestions_content_immutable on public.ai_suggestions;
create trigger ai_suggestions_content_immutable
  before update or delete on public.ai_suggestions
  for each row execute function ai_suggestions_reject_content_mutation();

-- -------------------------------------------------------------------------------------
-- Trigger 2: the status transition rule.
--
-- The CHECK above already makes each individual state internally consistent. What a CHECK
-- cannot see is the state the row was in a moment ago, and two of the rules that matter are
-- about exactly that:
--
--   · a decided suggestion NEVER returns to pending — otherwise "accept" is reversible by
--     anyone who can write the row, and the decision record is a suggestion rather than a
--     fact;
--   · `accepted` and `dismissed` are terminal — a suggestion a person accepted cannot later
--     be reported as expired, which would erase the accountability for the action taken.
--
-- `expired` may still move to `superseded`: time ran out, and then a fresher suggestion about
-- the same subject replaced it. That is a system transition in both halves and takes nothing
-- away from anyone.
-- -------------------------------------------------------------------------------------

create or replace function ai_suggestions_guard_status_transition() returns trigger
language plpgsql
as $$
begin
  if pg_has_role(current_user, 'shikkha_migrator', 'MEMBER') then
    return new;
  end if;

  if new.status = old.status then
    return new;
  end if;

  if new.status = 'pending' then
    raise exception
      'an ai_suggestion that has been decided (%) can never return to pending', old.status
      using errcode = 'check_violation';
  end if;

  if old.status in ('accepted', 'dismissed') then
    raise exception
      'ai_suggestion status % is final and cannot become %', old.status, new.status
      using errcode = 'check_violation';
  end if;

  if old.status = 'superseded' then
    raise exception
      'a superseded ai_suggestion cannot be decided; decide the suggestion that replaced it'
      using errcode = 'check_violation';
  end if;

  -- Remaining legal moves: pending → anything, expired → superseded.
  if old.status = 'expired' and new.status <> 'superseded' then
    raise exception
      'an expired ai_suggestion can only be superseded, not %', new.status
      using errcode = 'check_violation';
  end if;

  return new;
end
$$;

drop trigger if exists ai_suggestions_status_transition on public.ai_suggestions;
create trigger ai_suggestions_status_transition
  before update on public.ai_suggestions
  for each row execute function ai_suggestions_guard_status_transition();

-- -------------------------------------------------------------------------------------
-- Row-level security, grants and updated_at. The catalogue loop in 0002 does not re-run for
-- tables created later, so it is restated here — the policy body is copied verbatim from
-- 0032 so that every AI table answers the tenant question with the same expression.
-- -------------------------------------------------------------------------------------

do $$
declare
  target text;
  suggestion_tables constant text[] := array['ai_suggestions'];
begin
  foreach target in array suggestion_tables
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

    -- Default privileges cover tables created by the migrator; restating the grant makes this
    -- migration correct even if the defaults were altered between releases.
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
-- Assertions — fail the migration rather than ship a silently-disabled control.
-- -------------------------------------------------------------------------------------

do $$
declare
  offending text;
  suggestion_tables constant text[] := array['ai_suggestions'];
begin
  select string_agg(c.relname, ', ' order by c.relname)
  into offending
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relname = any (suggestion_tables)
    and (
      not c.relrowsecurity
      or not c.relforcerowsecurity
      or not exists (
        select 1 from pg_policy p where p.polrelid = c.oid and p.polname = 'tenant_isolation'
      )
    );

  if offending is not null then
    raise exception
      'AI suggestion tables without forced row-level security and a tenant_isolation policy: %',
      offending;
  end if;

  -- The two columns the policy and every service query depend on.
  select string_agg(t.name || '.' || col.name, ', ' order by t.name, col.name)
  into offending
  from unnest(suggestion_tables) as t(name)
  cross join unnest(array['tenant_id', 'institution_id']) as col(name)
  where not exists (
    select 1
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = t.name
      and a.attname = col.name
      and a.attnum > 0
      and not a.attisdropped
  );

  if offending is not null then
    raise exception 'AI suggestion tables missing a required tenancy column: %', offending;
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'ai_suggestions_content_immutable'
      and tgrelid = 'public.ai_suggestions'::regclass
      and not tgisinternal
  ) then
    raise exception 'the ai_suggestions content-immutability trigger is missing';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'ai_suggestions_status_transition'
      and tgrelid = 'public.ai_suggestions'::regclass
      and not tgisinternal
  ) then
    raise exception 'the ai_suggestions status-transition trigger is missing';
  end if;

  -- The partial unique index is what stops a repeated copilot turn from piling up identical
  -- undecided rows about one child. Named explicitly so a rename is a failed migration.
  if not exists (
    select 1 from pg_class where relname = 'ai_suggestions_pending_subject_key'
  ) then
    raise exception 'the one-pending-suggestion-per-subject index is missing';
  end if;
end
$$;

/**
 * The evidence rule, proved rather than assumed.
 *
 * docs/06 §7 is the requirement this migration exists to make unbreakable: uncertainty is
 * reported WITH EVIDENCE, never as a bare score. If this constraint were ever dropped or
 * weakened, the first symptom would be a suggestion card in front of a teacher that says
 * "Medium confidence" and nothing else — and by then it would be in production.
 *
 * Run on a scratch table shaped like the real one so no tenant or institution row has to be
 * invented, and so the assertion tests the FUNCTION rather than the fixture.
 */
do $$
begin
  create temp table ai_evidence_probe (
    evidence jsonb not null
      constraint ai_evidence_probe_wellformed
      check (public.ai_suggestion_evidence_is_wellformed(evidence))
  ) on commit drop;

  -- Accepted: an array of entries that each name a source and state a fact.
  insert into ai_evidence_probe (evidence)
  values ('[{"source":"attendance.summary","statement":"Attendance is 61.00% since April"}]'::jsonb);

  -- Refused: no evidence at all. This is the bare-score case.
  begin
    insert into ai_evidence_probe (evidence) values ('[]'::jsonb);
    raise exception 'an evidence-free suggestion was accepted; docs/06 §7 is not enforced';
  exception
    when check_violation then null;
  end;

  -- Refused: a reason with no source. A statement nobody can check is prose, not evidence.
  begin
    insert into ai_evidence_probe (evidence)
    values ('[{"statement":"The student seems to be struggling"}]'::jsonb);
    raise exception 'an unsourced evidence entry was accepted';
  exception
    when check_violation then null;
  end;

  -- Refused: a source with nothing said about it.
  begin
    insert into ai_evidence_probe (evidence)
    values ('[{"source":"attendance.summary","statement":"   "}]'::jsonb);
    raise exception 'an evidence entry with an empty statement was accepted';
  exception
    when check_violation then null;
  end;

  -- Refused: an object where an array belongs. A single fact is still a list of one.
  begin
    insert into ai_evidence_probe (evidence)
    values ('{"source":"attendance.summary","statement":"x"}'::jsonb);
    raise exception 'a non-array evidence value was accepted';
  exception
    when check_violation then null;
  end;
end
$$;

-- The global sweep: every public table is either RLS-protected or explicitly exempt.
select assert_rls_coverage();
