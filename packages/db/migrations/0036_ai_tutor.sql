-- =====================================================================================
-- 0036 — AI tutor: the student-facing surface (Phase 35)
--
-- Three tenant-scoped tables. They exist because a student conversation is not a staff
-- conversation with a different permission on it, and pretending otherwise would put the
-- rules a child needs into a service comment instead of into the database.
--
-- The transcript itself is NOT duplicated here. A tutor session owns exactly one
-- `ai_conversations` row and its turns live in `ai_messages`, which is already append-only
-- and already metered (0032). What these tables add is the part the copilot has no concept
-- of: what the session is anchored to, whether that anchor is assessed work, what evidence
-- an answer rested on, and whether a child said something that a human has to read.
--
-- Five properties are enforced HERE rather than only in the service, because each is one an
-- application can get wrong once and never notice:
--
--   1. **A tutor turn is append-only.** `tutor_turns_no_mutation` refuses UPDATE and DELETE
--      for every role except the migrator, the same shape as `ai_messages` (0032),
--      `workflow_actions` (0014) and `stock_movements` (0025). What a school's AI told a
--      twelve-year-old is evidence; the first time anyone needs it will be an argument
--      about it.
--   2. **Uncertainty is never a bare score** (docs/06 §7). `tutor_turns_reasons_present`
--      refuses a turn whose `grounding_reasons` array is empty. A number with no reasons
--      cannot be argued with, and a student who cannot argue with it will either follow it
--      blindly or ignore it entirely — so the database will not store one.
--   3. **A "grounded" claim carries a citation.** `tutor_turns_grounded_has_citation`
--      refuses `grounding_level = 'grounded'` with an empty `citations` array, and
--      `tutor_turns_no_citation_is_empty` refuses the opposite lie. An answer with no
--      citation must SAY it has none (docs/06 §5), and the two states are kept
--      structurally distinct rather than by convention.
--   4. **A safeguarding flag is closed by a person, in a session, or not at all.**
--      `tutor_flags_review_is_human` refuses an UPDATE that moves a flag to `reviewed`
--      unless `reviewed_by` equals the connection's own `app.user_id` GUC. A background
--      job, a migration script and a compromised service account all run with no user in
--      that setting, so none of them can mark a child's disclosure as dealt with. The
--      same trigger refuses a reviewed flag being reopened to `pending` — a review is a
--      record of what a named adult decided, not a toggle.
--   5. **Who may read a session is one SQL expression**, `tutor_session_visible_to()`,
--      rather than a `where` clause the application assembles differently in three places.
--      The service calls it; the integration suite calls it directly as `shikkha_app`.
--      There is exactly one definition of the rule and it is executable.
--
-- ── The tension in property 5, stated rather than glossed over ────────────────────────
--
-- A child's tutor session feels private, and it is not. It is a school record: their linked
-- guardian can read it and so can the teachers of their sections. That is deliberate, and it
-- is the honest promise — a school that told a parent "we cannot show you what our AI said
-- to your child" would be describing a system nobody should have built. What the rule buys
-- is the other half: NOBODY ELSE. Not another student, not a member of staff with no
-- teaching relationship to the child, not an administrator browsing. The visibility function
-- below is the whole of it.
--
-- Pastoral staff reviewing a safeguarding flag see the FLAG — its signal and the excerpt
-- that raised it — and not the session. That is not an oversight. "Somebody said something
-- worrying" is the thing a designated safeguarding lead needs; a transcript of every maths
-- question the child asked that week is not, and giving it to them would quietly make
-- `discipline.records.view` into a licence to read children's conversations.
--
-- No derived counter appears anywhere in this migration. Read 0031 for why: a checked
-- counter maintained with `insert ... on conflict do update set n = n + delta` is evaluated
-- against the PROPOSED tuple before ON CONFLICT arbitration, so a negative delta fails a
-- `>= 0` check that the resulting balance would have satisfied. A turn count on a session
-- would have been exactly that shape for no gain — `count(*)` over an indexed foreign key
-- answers it — so there is nothing here to get wrong.
--
-- The RLS/grants/updated_at loop from 0002 does not re-run for tables created later, so it
-- is restated at the bottom, followed by named assertions and assert_rls_coverage().
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- Enumerations. Closed value sets: each one changes tutor code as well as the schema.
-- -------------------------------------------------------------------------------------

/**
 * What a session is anchored to.
 *
 * A tutor with no anchor is a general-purpose chatbot pointed at a child, which is not the
 * product. Every session names one piece of the school's own material, and the anchor is
 * what decides both which corpus is searched and whether the assessed-work rules apply.
 */
create type public.tutor_anchor_kind as enum ('course', 'lesson', 'assignment', 'quiz_question');

/** A session is open or it is finished. Finishing is a fact with a timestamp, not a flag. */
create type public.tutor_session_status as enum ('active', 'ended');

/**
 * What happened on one turn.
 *
 *  `guided`             — an ordinary tutoring answer, grounded in retrieved material.
 *  `guidance_only`      — the student asked for the answer to assessed work, or the model
 *                         produced something that contained it, and the tutor gave method
 *                         instead. The distinction from `guided` is what makes the rule
 *                         auditable after the fact.
 *  `no_citation`        — nothing in the school's material matched, so nothing was generated.
 *  `safeguarding_hold`  — the student disclosed harm. No model was consulted at all.
 */
create type public.tutor_turn_outcome as enum (
  'guided', 'guidance_only', 'no_citation', 'safeguarding_hold'
);

/**
 * How well an answer was grounded. A LABEL, and it never travels without its reasons —
 * see `tutor_turns_reasons_present`.
 */
create type public.tutor_grounding_level as enum ('grounded', 'partial', 'ungrounded');

/**
 * What kind of disclosure raised a flag. A SIGNAL for a human, never a finding: the tutor
 * has no business categorising a child's situation, only saying which words made it stop
 * and ask for an adult.
 */
create type public.tutor_flag_signal as enum (
  'self_harm', 'abuse_or_neglect', 'bullying', 'violence', 'unspecified_distress'
);

/** Pending until a named person has read it. There is no third state and no auto-close. */
create type public.tutor_flag_status as enum ('pending', 'reviewed');

-- -------------------------------------------------------------------------------------
-- Tables
-- -------------------------------------------------------------------------------------

/**
 * One tutoring session: one student, one anchor, one conversation.
 *
 * `conversation_id` is unique — the transcript store is `ai_conversations` / `ai_messages`
 * and this row is the tutor-specific facts about it. Two sessions sharing a conversation
 * would make "what was this child told, and about what" unanswerable.
 *
 * `anchor_is_assessed` is resolved ONCE, at session creation, from the anchored record
 * itself (a quiz question is always assessed; a homework assignment is assessed when its
 * `is_graded` is set). It is stored rather than re-derived per turn because a teacher who
 * later marks the work ungraded must not retroactively unlock the answers a child was
 * refused last week — and because the refusal has to be explicable from this row alone.
 */
create table public.tutor_sessions (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  student_id uuid not null,
  conversation_id uuid not null,
  anchor_kind public.tutor_anchor_kind not null,
  anchor_id uuid not null,
  -- Denormalised for the list view and for the refusal message. Teacher-authored text, so
  -- everything that reads it into a prompt wraps it in an untrusted-data envelope first.
  anchor_label varchar(255) not null,
  anchor_is_assessed boolean not null,
  status public.tutor_session_status default 'active' not null,
  started_at timestamp with time zone default now() not null,
  ended_at timestamp with time zone,
  end_reason varchar(500),
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
 * One exchange: the student's message, the tutor's answer, and why the answer was what it
 * was. APPEND-ONLY.
 *
 * The two message columns point into `ai_messages` rather than copying the text, so there
 * is one transcript and it is the one that is already append-only and already metered.
 * `tutor_message_id` is nullable for exactly one reason: a turn is written even when the
 * exchange produced no assistant message at all, which today cannot happen but would
 * otherwise be a lost record if it ever did.
 *
 * `grounding_reasons` is the load-bearing column. docs/06 §7: risk and confidence are
 * reported with evidence, never as a bare score. The check below refuses an empty array, so
 * "medium confidence" with nothing behind it cannot be stored, let alone shown to a child.
 */
create table public.tutor_turns (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  session_id uuid not null,
  -- Monotonic within a session. Ordering by created_at alone is not enough: the student's
  -- message and the tutor's answer are written microseconds apart inside one transaction.
  seq integer not null,
  student_message_id uuid not null,
  tutor_message_id uuid,
  outcome public.tutor_turn_outcome not null,
  grounding_level public.tutor_grounding_level not null,
  -- An array of human-readable sentences. Never a score on its own.
  grounding_reasons jsonb default '[]'::jsonb not null,
  -- [{ documentId, documentTitle, chunkId, score }] — what the answer actually rested on.
  citations jsonb default '[]'::jsonb not null,
  -- True when a post-check found the assessed item's own answer key in the model's output
  -- and replaced it with guidance. Recorded so the refusal is countable, not just felt.
  withheld_answer boolean default false not null,
  -- Null on a turn that consulted no model — a safeguarding hold, or a question nothing in
  -- the school's material matched. Zero tokens and "no provider was called" are different
  -- facts and the columns keep them different.
  provider_key varchar(32),
  model varchar(128),
  input_tokens integer default 0 not null,
  output_tokens integer default 0 not null,
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
 * A disclosure of harm, raised for a human.
 *
 * The excerpt is the child's own words, truncated. It is here rather than only in the
 * transcript because the person who reviews this must be able to act on it without being
 * given the whole session (see the header): the flag is the smallest thing that answers
 * "does an adult need to look at this today".
 *
 * Nothing else happens when a row lands here. No message is sent, no guardian is contacted,
 * no discipline record is opened, no referral is made. A system that decided by itself that
 * a child should be reported somewhere would be making the single decision it is least
 * qualified to make, and the fact that it would usually be right is not an argument.
 */
create table public.tutor_safeguarding_flags (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  session_id uuid not null,
  turn_id uuid not null,
  student_id uuid not null,
  signal public.tutor_flag_signal not null,
  excerpt varchar(1000) not null,
  status public.tutor_flag_status default 'pending' not null,
  raised_at timestamp with time zone default now() not null,
  reviewed_by uuid,
  reviewed_at timestamp with time zone,
  -- What the adult decided and why. Required to close the flag; the route also enforces it
  -- through `requiresReason`, and this constraint is what makes that true of raw SQL too.
  review_note varchar(1000),
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
-- Foreign keys. `restrict` for institutional parents; `cascade` only from a session to its
-- own turns, which are genuinely owned by it. A flag cascades from nothing: a safeguarding
-- record must not disappear because something upstream of it was removed.
-- -------------------------------------------------------------------------------------

alter table public.tutor_sessions
  add constraint tutor_sessions_tenant_fk
    foreign key (tenant_id) references public.organizations (id) on delete restrict,
  add constraint tutor_sessions_institution_fk
    foreign key (institution_id) references public.institutions (id) on delete restrict,
  add constraint tutor_sessions_student_fk
    foreign key (student_id) references public.students (id) on delete restrict,
  add constraint tutor_sessions_conversation_fk
    foreign key (conversation_id) references public.ai_conversations (id) on delete restrict;

alter table public.tutor_turns
  add constraint tutor_turns_tenant_fk
    foreign key (tenant_id) references public.organizations (id) on delete restrict,
  add constraint tutor_turns_institution_fk
    foreign key (institution_id) references public.institutions (id) on delete restrict,
  add constraint tutor_turns_session_fk
    foreign key (session_id) references public.tutor_sessions (id) on delete cascade,
  add constraint tutor_turns_student_message_fk
    foreign key (student_message_id) references public.ai_messages (id) on delete restrict,
  add constraint tutor_turns_tutor_message_fk
    foreign key (tutor_message_id) references public.ai_messages (id) on delete restrict;

alter table public.tutor_safeguarding_flags
  add constraint tutor_flags_tenant_fk
    foreign key (tenant_id) references public.organizations (id) on delete restrict,
  add constraint tutor_flags_institution_fk
    foreign key (institution_id) references public.institutions (id) on delete restrict,
  add constraint tutor_flags_session_fk
    foreign key (session_id) references public.tutor_sessions (id) on delete restrict,
  add constraint tutor_flags_turn_fk
    foreign key (turn_id) references public.tutor_turns (id) on delete restrict,
  add constraint tutor_flags_student_fk
    foreign key (student_id) references public.students (id) on delete restrict,
  add constraint tutor_flags_reviewer_fk
    foreign key (reviewed_by) references public.users (id) on delete restrict;

-- -------------------------------------------------------------------------------------
-- Indexes
-- -------------------------------------------------------------------------------------

create index if not exists tutor_sessions_tenant_idx
  on public.tutor_sessions (tenant_id);
-- "My sessions", newest first — the student's own list, and the guardian's and teacher's
-- view of one child.
create index if not exists tutor_sessions_student_idx
  on public.tutor_sessions (institution_id, student_id, started_at desc);
create index if not exists tutor_sessions_status_idx
  on public.tutor_sessions (institution_id, status);
create index if not exists tutor_sessions_anchor_idx
  on public.tutor_sessions (anchor_kind, anchor_id);
-- One conversation, one session. See the table comment.
create unique index if not exists tutor_sessions_conversation_key
  on public.tutor_sessions (conversation_id);

create unique index if not exists tutor_turns_session_seq_key
  on public.tutor_turns (session_id, seq);
create index if not exists tutor_turns_tenant_idx
  on public.tutor_turns (tenant_id);
create index if not exists tutor_turns_session_idx
  on public.tutor_turns (session_id, seq);

create index if not exists tutor_flags_tenant_idx
  on public.tutor_safeguarding_flags (tenant_id);
-- The pastoral queue: this institution's open flags, oldest first, because the oldest
-- unread disclosure is the one that matters most.
create index if not exists tutor_flags_pending_idx
  on public.tutor_safeguarding_flags (institution_id, raised_at)
  where status = 'pending';
create index if not exists tutor_flags_student_idx
  on public.tutor_safeguarding_flags (institution_id, student_id);
-- One flag per turn. A retry that raised a second flag for the same sentence would put the
-- same disclosure in the queue twice and make the count meaningless.
create unique index if not exists tutor_flags_turn_key
  on public.tutor_safeguarding_flags (turn_id);

-- -------------------------------------------------------------------------------------
-- Check constraints — the invariants that belong in the database, not only in Zod.
-- -------------------------------------------------------------------------------------

alter table public.tutor_sessions
  add constraint tutor_sessions_anchor_label_present check (length(btrim(anchor_label)) > 0),
  -- "Ended" is a timestamp, not an opinion. The two cannot disagree.
  add constraint tutor_sessions_ended_consistent check (
    (status = 'ended') = (ended_at is not null)
  );

alter table public.tutor_turns
  add constraint tutor_turns_seq_positive check (seq > 0),
  add constraint tutor_turns_tokens_non_negative check (
    input_tokens >= 0 and output_tokens >= 0
  ),
  -- A model attribution is all-or-nothing, exactly as on `ai_messages`: a turn that names a
  -- model but no provider cannot be priced.
  add constraint tutor_turns_provider_attribution check (
    (provider_key is null and model is null)
    or (provider_key is not null and model is not null)
  ),
  -- THE RULE. docs/06 §7: never a bare score. A confidence label with no reasons behind it
  -- is refused by the database, so no code path can ship one by forgetting.
  add constraint tutor_turns_reasons_present check (
    jsonb_typeof(grounding_reasons) = 'array' and jsonb_array_length(grounding_reasons) >= 1
  ),
  add constraint tutor_turns_citations_is_array check (jsonb_typeof(citations) = 'array'),
  -- "Grounded" is a claim about evidence. Without a citation it is a claim about nothing.
  add constraint tutor_turns_grounded_has_citation check (
    grounding_level <> 'grounded' or jsonb_array_length(citations) >= 1
  ),
  -- …and the mirror image: a turn that reported "your school's documents do not answer this"
  -- must not be carrying citations it did not use.
  add constraint tutor_turns_no_citation_is_empty check (
    outcome <> 'no_citation' or jsonb_array_length(citations) = 0
  ),
  -- A safeguarding hold consults no model, by design. The columns say so, so a future
  -- change that quietly starts sending a distressed child's words to a vendor breaks here.
  add constraint tutor_turns_hold_calls_no_provider check (
    outcome <> 'safeguarding_hold'
    or (provider_key is null and input_tokens = 0 and output_tokens = 0)
  );

alter table public.tutor_safeguarding_flags
  add constraint tutor_flags_excerpt_present check (length(btrim(excerpt)) > 0),
  -- A closed flag names the adult who closed it, when, and what they decided. All three or
  -- none — a review with no note is a checkbox, and a checkbox is not a safeguarding record.
  add constraint tutor_flags_review_complete check (
    (status = 'pending'
      and reviewed_by is null and reviewed_at is null and review_note is null)
    or (status = 'reviewed'
      and reviewed_by is not null and reviewed_at is not null
      and review_note is not null and length(btrim(review_note)) > 0)
  );

-- -------------------------------------------------------------------------------------
-- Trigger 1: tutor_turns is append-only.
--
-- Same shape as `ai_messages` (0032): the migrator is exempt so retention and
-- change-controlled repairs remain possible; every other role is refused with
-- `insufficient_privilege`. What a school's AI told a child is not editable history.
-- -------------------------------------------------------------------------------------

create or replace function tutor_turns_reject_mutation() returns trigger
language plpgsql
as $$
begin
  if pg_has_role(current_user, 'shikkha_migrator', 'MEMBER') then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  raise exception
    'tutor_turns is append-only; what a tutor told a student is evidence and is never edited. % is not permitted for role %',
    tg_op, current_user
    using errcode = 'insufficient_privilege';
end
$$;

drop trigger if exists tutor_turns_no_mutation on public.tutor_turns;
create trigger tutor_turns_no_mutation
  before update or delete on public.tutor_turns
  for each row execute function tutor_turns_reject_mutation();

-- -------------------------------------------------------------------------------------
-- Trigger 2: a safeguarding flag is closed by a person, and stays closed.
--
-- The check constraint above already refuses a review with no reviewer, no timestamp or no
-- note. This trigger adds the part a constraint cannot see: the reviewer must be the
-- connection's OWN authenticated user, read from the `app.user_id` GUC that
-- `withTenantContext` sets on every request transaction.
--
-- That is what makes "a human decision" structural rather than procedural. A scheduled job,
-- a data-repair script and a service account all run with no user in that setting, so none
-- of them can mark a child's disclosure as handled — not by accident, and not by an
-- attacker who has reached the application's own database credentials. There is no flag or
-- GUC to switch it off: an escape hatch here would be used once during an incident and
-- would then stay.
--
-- Reopening is refused for the same reason a posted journal entry is not un-posted: the row
-- records what a named adult decided at a named time. If more happened afterwards, that is
-- another flag or a pastoral record elsewhere, not an edit to this one.
-- -------------------------------------------------------------------------------------

create or replace function tutor_flags_guard_review() returns trigger
language plpgsql
as $$
begin
  if pg_has_role(current_user, 'shikkha_migrator', 'MEMBER') then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    raise exception
      'a safeguarding flag is never deleted; review it, or archive it with a reason'
      using errcode = 'insufficient_privilege';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'pending' then
      raise exception
        'a safeguarding flag is raised as pending; only a person can review one'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  if old.status = 'reviewed' and new.status = 'pending' then
    raise exception
      'a reviewed safeguarding flag records what a named adult decided; it is not reopened by an update'
      using errcode = 'insufficient_privilege';
  end if;

  if new.status = 'reviewed' and old.status = 'pending' then
    if app_current_user_id() is null then
      raise exception
        'a safeguarding flag can only be reviewed by an authenticated user; no app.user_id is set on this connection'
        using errcode = 'insufficient_privilege';
    end if;
    if new.reviewed_by is distinct from app_current_user_id() then
      raise exception
        'a safeguarding flag records the reviewer who actually acted; reviewed_by must be the acting user'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end
$$;

drop trigger if exists tutor_flags_review_is_human on public.tutor_safeguarding_flags;
create trigger tutor_flags_review_is_human
  before insert or update or delete on public.tutor_safeguarding_flags
  for each row execute function tutor_flags_guard_review();

-- -------------------------------------------------------------------------------------
-- The visibility rule, as one executable expression.
--
-- A student's tutor session is visible to:
--
--   · the student themselves,
--   · a guardian with a live, portal-enabled link to that student,
--   · a teacher assigned to a section the student is actively enrolled in — as class
--     teacher (`employee_section_assignments`) or as a subject teacher of that section
--     (`employee_subject_assignments`),
--
-- and to nobody else. Not another student. Not staff with no teaching relationship. Not an
-- administrator who happens to hold a broad permission somewhere else in the product.
--
-- SECURITY INVOKER, deliberately: the function runs with the caller's own row-level
-- security, so every table it consults is already filtered by the tenant policy. A caller
-- whose `app.tenant_id` names another tenant sees no student, no guardian link and no
-- assignment, and the function returns false — the cross-tenant answer falls out of RLS
-- rather than out of a condition somebody has to remember to write. STABLE so the planner
-- may cache it within a statement.
--
-- Archived and revoked rows are excluded everywhere: revoking a guardian's portal access,
-- or ending a teacher's assignment, takes effect on the next request.
-- -------------------------------------------------------------------------------------

create or replace function tutor_session_visible_to(p_session_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security invoker
as $$
  select exists (
    select 1
    from public.tutor_sessions s
    join public.students st on st.id = s.student_id
    where s.id = p_session_id
      and p_user_id is not null
      and (
        -- The student's own session.
        st.user_id = p_user_id

        -- A linked guardian who still has portal access.
        or exists (
          select 1
          from public.student_guardians sg
          join public.guardians g on g.id = sg.guardian_id
          where sg.student_id = s.student_id
            and sg.can_access_portal
            and sg.archived_at is null
            and g.archived_at is null
            and g.user_id = p_user_id
        )

        -- A teacher of one of the sections this student is actively enrolled in.
        or exists (
          select 1
          from public.enrollments e
          join public.employees emp on emp.user_id = p_user_id
          where e.student_id = s.student_id
            and e.status = 'active'
            and e.archived_at is null
            and emp.archived_at is null
            and (
              exists (
                select 1
                from public.employee_section_assignments esa
                where esa.employee_id = emp.id
                  and esa.section_id = e.section_id
                  and esa.archived_at is null
              )
              or exists (
                select 1
                from public.employee_subject_assignments esu
                where esu.employee_id = emp.id
                  and esu.section_id = e.section_id
                  and esu.archived_at is null
              )
            )
        )
      )
  )
$$;

comment on function tutor_session_visible_to(uuid, uuid) is
  'The single definition of who may read a tutor session: the student, their portal-enabled linked guardian, and the teachers of their sections. Nobody else.';

-- -------------------------------------------------------------------------------------
-- Row-level security, grants and updated_at for the new tables. The catalogue loop in 0002
-- does not re-run for tables created later, so it is restated here. The policy body is
-- copied verbatim from 0032.
-- -------------------------------------------------------------------------------------

do $$
declare
  target text;
  tutor_tables constant text[] := array[
    'tutor_sessions',
    'tutor_turns',
    'tutor_safeguarding_flags'
  ];
begin
  foreach target in array tutor_tables
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

    -- Default privileges cover tables created by the migrator, but restating the grant makes
    -- this migration correct even if the default privileges were altered between releases.
    execute format('grant select, insert, update, delete on public.%I to shikkha_app', target);
    execute format('grant select on public.%I to shikkha_readonly', target);

    -- `updated_at` is maintained by the trigger, not by the application, so a hand-written
    -- SQL fix in production still leaves an honest timestamp behind.
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
  tutor_tables constant text[] := array[
    'tutor_sessions', 'tutor_turns', 'tutor_safeguarding_flags'
  ];
begin
  -- Named explicitly rather than relying only on the global sweep below, so that a typo in
  -- the loop above is a failed migration instead of a table nobody notices is unprotected.
  select string_agg(c.relname, ', ' order by c.relname)
  into offending
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relname = any (tutor_tables)
    and (
      not c.relrowsecurity
      or not c.relforcerowsecurity
      or not exists (
        select 1 from pg_policy p where p.polrelid = c.oid and p.polname = 'tenant_isolation'
      )
    );

  if offending is not null then
    raise exception
      'Tutor tables without forced row-level security and a tenant_isolation policy: %',
      offending;
  end if;

  -- Every one must also carry the tenant column the policy reads. A policy on a table
  -- without `tenant_id` fails at query time, not here.
  select string_agg(t.name, ', ' order by t.name)
  into offending
  from unnest(tutor_tables) as t(name)
  where not exists (
    select 1
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = t.name
      and a.attname = 'tenant_id'
      and a.attnum > 0
      and not a.attisdropped
  );

  if offending is not null then
    raise exception 'Tutor tables without a tenant_id column: %', offending;
  end if;

  -- …and the institution column every one of these is scoped by in the application.
  select string_agg(t.name, ', ' order by t.name)
  into offending
  from unnest(tutor_tables) as t(name)
  where not exists (
    select 1
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = t.name
      and a.attname = 'institution_id'
      and a.attnum > 0
      and not a.attisdropped
  );

  if offending is not null then
    raise exception 'Tutor tables without an institution_id column: %', offending;
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'tutor_turns_no_mutation'
      and tgrelid = 'public.tutor_turns'::regclass
      and not tgisinternal
  ) then
    raise exception 'tutor_turns append-only trigger is missing';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'tutor_flags_review_is_human'
      and tgrelid = 'public.tutor_safeguarding_flags'::regclass
      and not tgisinternal
  ) then
    raise exception 'tutor_safeguarding_flags human-review trigger is missing';
  end if;

  -- The visibility rule has exactly one definition and the application depends on it by
  -- name. Losing it would not break a query — it would break a *deployment*, at the first
  -- request, which is a worse place to find out.
  if to_regprocedure('public.tutor_session_visible_to(uuid, uuid)') is null then
    raise exception 'tutor_session_visible_to(uuid, uuid) is missing';
  end if;
end
$$;

-- The uncertainty rule, proved rather than assumed. `tutor_turns_reasons_present` is the
-- constraint that stops docs/06 §7 from being a paragraph nobody enforces, so the migration
-- refuses to finish unless a bare score really is rejected. Exercised on a scratch table
-- shaped like the real one, so the assertion needs no tenant, institution or session rows.
do $$
declare
  accepted boolean := false;
begin
  create temp table tutor_turn_probe (
    grounding_level public.tutor_grounding_level not null,
    grounding_reasons jsonb not null,
    citations jsonb not null,
    constraint tutor_turn_probe_reasons check (
      jsonb_typeof(grounding_reasons) = 'array' and jsonb_array_length(grounding_reasons) >= 1
    ),
    constraint tutor_turn_probe_grounded check (
      grounding_level <> 'grounded' or jsonb_array_length(citations) >= 1
    )
  ) on commit drop;

  -- A label with reasons and a citation behind it: the shape a real turn has.
  insert into tutor_turn_probe values (
    'grounded',
    '["Answered from 2 passages of the Class 6 science notes (best match 0.72)."]'::jsonb,
    '[{"chunkId": "00000000-0000-0000-0000-000000000000"}]'::jsonb
  );

  -- A bare score: a level, no reasons. This is the thing that must not be storable.
  begin
    insert into tutor_turn_probe values ('partial', '[]'::jsonb, '[]'::jsonb);
    accepted := true;
  exception
    when check_violation then null;
  end;

  if accepted then
    raise exception
      'a confidence level with no reasons was accepted; docs/06 §7 is not being enforced';
  end if;

  -- …and a "grounded" claim with nothing cited is refused too.
  accepted := false;
  begin
    insert into tutor_turn_probe values ('grounded', '["because I said so"]'::jsonb, '[]'::jsonb);
    accepted := true;
  exception
    when check_violation then null;
  end;

  if accepted then
    raise exception 'a grounded answer with no citation was accepted';
  end if;
end
$$;

-- The global sweep: every public table is either RLS-protected or explicitly exempt.
select assert_rls_coverage();
