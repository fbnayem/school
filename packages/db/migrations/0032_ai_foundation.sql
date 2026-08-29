-- =====================================================================================
-- 0032 — AI foundation: conversations, message log, usage metering and budgets (Phases 27–28)
--
-- Five tenant-scoped tables. Everything here exists to make docs/06_AI_ARCHITECTURE.md §8
-- true in the database rather than only in a service:
--
--   "A school on a fixed subscription cannot be exposed to an unbounded inference bill, so
--    the budget is enforced before the call rather than reported after it."
--
-- Four properties are enforced HERE, because each is one the application can only get wrong
-- once and never notice:
--
--   1. **ai_messages is APPEND-ONLY.** A conversation transcript is the evidence of what an
--      AI was asked and what it answered. If it can be edited, it proves nothing — and the
--      first time anyone needs it will be a dispute about a decision the AI influenced. Same
--      trigger shape as workflow_actions (0014), stock_movements (0025) and
--      depreciation_lines (0026): every role refused, the migrator exempt for retention.
--   2. **ai_usage_events is APPEND-ONLY** for the same reason and one more: it is the cost
--      ledger. An over-recorded call is corrected the way a wrong journal entry is corrected
--      — with a compensating event carrying negative tokens and a negative cost — never with
--      an UPDATE. That is why the token and cost columns here are signed.
--   3. **ai_budgets.tokens_used / cost_used are DERIVED** from ai_usage_events by an
--      after-insert trigger, exactly as stock_levels is derived from stock_movements. A
--      guard trigger refuses any other writer from touching those two columns, so the
--      running total cannot drift from the events it summarises. The *limits* on the same
--      row (token_limit, cost_limit, hard_stop) are ordinary settable columns — an
--      administrator sets the budget, the database keeps the tally.
--   4. **The tally never goes negative.** `ai_budgets_usage_non_negative` is a check
--      constraint on the derived row, so a compensating event that would credit back more
--      than was ever spent aborts the event insert itself.
--
-- READ 0031 BEFORE CHANGING THE DERIVED TRIGGER. The naive
-- `insert ... on conflict do update set used = used + excluded.used` shape is wrong for a
-- checked counter and was a live bug in inventory for a release: PostgreSQL evaluates a
-- table's CHECK constraints against the *proposed insertion tuple*, before ON CONFLICT
-- arbitration decides the DO UPDATE branch should run. The proposed tuple carries the bare
-- delta, so a negative delta fails `>= 0` even when the resulting balance would be perfectly
-- valid. `ai_usage_events_apply_budget` below therefore does the two-step that 0031
-- introduced: insert a ZERO row `on conflict do nothing`, then `update ... set used = used +
-- delta`. Zero always satisfies the check whatever the sign of the delta, `do nothing`
-- absorbs the race where two concurrent calls create the same month's budget row, and the
-- UPDATE takes a row lock so concurrent events against one month serialise and the check
-- finally sees the resulting total rather than the delta in isolation.
--
-- Cost is `numeric(14, 4)` — FOUR decimals, not two. Inference is priced in fractions of a
-- cent per thousand tokens, and a single copilot turn routinely costs less than 0.0100 of
-- the settlement currency. Rounding each call to the currency's minor unit would round most
-- calls to zero and the month's bill to nothing. Four decimals is the exact figure; the
-- application rounds to `Money` only where a number is *presented* as currency (ADR-004: no
-- floating point anywhere in either case).
--
-- `ai_conversations.subject_type` / `subject_id` are a deliberately soft reference — a
-- conversation may be about a student, an invoice, a section or nothing at all, and a real
-- foreign key would either need one nullable column per module or would stop a subject's
-- record from ever being archived. Likewise `ai_usage_events.user_id`: the usage ledger
-- outlives the user row it attributes cost to.
--
-- The RLS/grants/updated_at loop from 0002 does not re-run for tables created later, so it
-- is restated at the bottom, followed by named assertions and assert_rls_coverage().
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- Enumerations. Closed value sets: adding a purpose, a task or a finish reason changes AI
-- routing code as well as the schema. The things a school configures for itself — which
-- provider, what budget, whether tutoring is on — are columns, not enum values.
-- -------------------------------------------------------------------------------------

/**
 * What a conversation is for. This is the audience boundary, not a label: `tutor` is a
 * student-facing conversation and `insights` is a principal-facing one, and they are
 * permissioned differently.
 */
create type public.ai_conversation_purpose as enum (
  'copilot', 'tutor', 'teacher_tools', 'insights', 'knowledge_search'
);

/** Mirrors the provider wire format. `tool` is a tool result being fed back to the model. */
create type public.ai_message_role as enum ('system', 'user', 'assistant', 'tool');

/**
 * The routing dimension. Per docs/06 §4: cheap classification to a small model, document
 * understanding to a vision model, analytics reasoning to a capable one, tutoring to an
 * education-safe configuration. `embedding` is a task so that retrieval's provider calls
 * land in the same usage ledger as everything else.
 */
create type public.ai_task as enum (
  'classification', 'summarisation', 'analytics_reasoning',
  'tutoring', 'document_understanding', 'embedding'
);

/**
 * Why generation stopped. `content_filter` and `length` are recorded rather than discarded:
 * an answer truncated at the token ceiling and an answer refused by a safety filter look
 * identical in the transcript and mean completely different things.
 */
create type public.ai_finish_reason as enum ('stop', 'length', 'tool_calls', 'content_filter');

-- -------------------------------------------------------------------------------------
-- Tables
-- -------------------------------------------------------------------------------------

create table public.ai_conversations (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  title varchar(200) not null,
  purpose public.ai_conversation_purpose not null,
  started_by_user_id uuid not null,
  -- Soft reference to whatever the conversation is about ('student', 'invoice', 'section',
  -- …). Deliberately not a foreign key: see the header.
  subject_type varchar(64),
  subject_id uuid,
  -- Denormalised for the list view's ordering. Maintained by the service in the same
  -- transaction as the message it describes; it is a cache of max(ai_messages.created_at),
  -- never an input, and nothing reads it as an authority.
  last_message_at timestamp with time zone,
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
 * One turn of a conversation. APPEND-ONLY — `ai_messages_no_mutation` refuses UPDATE and
 * DELETE for every role except the migrator. The archive columns exist to satisfy the schema
 * convention and are unusable by construction, which is the point: a message is a historical
 * fact about what a model was asked and what it said.
 */
create table public.ai_messages (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  conversation_id uuid not null,
  -- Monotonic within a conversation. Ordering by created_at alone is not enough: a request
  -- and its answer are written microseconds apart inside one transaction and can share a
  -- timestamp, and a transcript whose order depends on a tie-break is not a transcript.
  seq integer not null,
  role public.ai_message_role not null,
  content text not null,
  -- Present only on `tool` messages: which tool invocation this message answers.
  tool_call_id varchar(128),
  -- Null on a user message: no provider was involved in producing it.
  provider_key varchar(32),
  model varchar(128),
  input_tokens integer default 0 not null,
  output_tokens integer default 0 not null,
  finish_reason public.ai_finish_reason,
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
 * Every provider call, whatever made it. APPEND-ONLY, and the source of truth for cost.
 *
 * `conversation_id` is nullable because retrieval ingestion embeds documents with no
 * conversation behind it, and that spend must still be metered.
 *
 * Token counts and cost are SIGNED. A provider's usage report can be corrected — a retried
 * call double-counted, a vendor credit for a failed request — and because this table admits
 * no UPDATE, the only honest correction is a compensating event, exactly as a wrong journal
 * entry is corrected by a reversing entry (0018).
 */
create table public.ai_usage_events (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  conversation_id uuid,
  task public.ai_task not null,
  provider_key varchar(32) not null,
  model varchar(128) not null,
  input_tokens integer default 0 not null,
  output_tokens integer default 0 not null,
  -- FOUR decimals. See the header: two would round almost every call to zero.
  cost numeric(14, 4) default '0.0000' not null,
  currency char(3) default 'USD' not null,
  occurred_at timestamp with time zone default now() not null,
  -- Soft reference: the ledger outlives the user row it attributes spend to.
  user_id uuid,
  purpose public.ai_conversation_purpose,
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
 * One institution's budget for one calendar month.
 *
 * `token_limit` and `cost_limit` are the administrator's settings; null means "no limit of
 * this kind". `tokens_used` and `cost_used` are DERIVED from ai_usage_events and refused to
 * every writer but the trigger. `hard_stop` decides what happens at the ceiling: true
 * refuses the call before it is made (docs/06 §8), false records the overage and warns.
 *
 * The unique index on (institution_id, year_month) is TOTAL rather than partial-on-archive,
 * because it is the ON CONFLICT arbiter of the derived trigger — a second "archived" row for
 * the same month would silently split the tally in two.
 */
create table public.ai_budgets (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  year_month char(7) not null,
  token_limit bigint,
  cost_limit numeric(14, 4),
  tokens_used bigint default 0 not null,
  cost_used numeric(14, 4) default '0.0000' not null,
  hard_stop boolean default true not null,
  currency char(3) default 'USD' not null,
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
 * One row per institution: which provider answers, per task, and what the defaults are for
 * a month nobody has explicitly budgeted.
 *
 * `task_routing` is jsonb rather than a column per task so that adding a task to the
 * `ai_task` enum does not also require a migration here. The application validates its
 * shape against the same Zod schema the HTTP API uses.
 */
create table public.ai_provider_settings (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  -- Provider *key*, never a credential. Credentials live in the deployment environment and
  -- have no column anywhere in this database.
  default_provider varchar(32) default 'mock' not null,
  task_routing jsonb default '{}'::jsonb not null,
  default_monthly_token_limit bigint,
  default_monthly_cost_limit numeric(14, 4),
  default_hard_stop boolean default true not null,
  -- Off by default. Turning AI tutoring on for children is a decision a school makes
  -- deliberately, not one it discovers has already been made for it.
  tutoring_enabled_for_students boolean default false not null,
  currency char(3) default 'USD' not null,
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
-- Foreign keys. `restrict` for institutional parents; `cascade` only from a conversation to
-- its own messages, which are genuinely owned by it. Note that nothing cascades to
-- ai_usage_events: deleting a conversation must never erase what it cost.
-- -------------------------------------------------------------------------------------

alter table public.ai_conversations
  add constraint ai_conversations_tenant_fk
    foreign key (tenant_id) references public.organizations (id) on delete restrict,
  add constraint ai_conversations_institution_fk
    foreign key (institution_id) references public.institutions (id) on delete restrict,
  add constraint ai_conversations_started_by_fk
    foreign key (started_by_user_id) references public.users (id) on delete restrict;

alter table public.ai_messages
  add constraint ai_messages_tenant_fk
    foreign key (tenant_id) references public.organizations (id) on delete restrict,
  add constraint ai_messages_institution_fk
    foreign key (institution_id) references public.institutions (id) on delete restrict,
  add constraint ai_messages_conversation_fk
    foreign key (conversation_id) references public.ai_conversations (id) on delete cascade;

alter table public.ai_usage_events
  add constraint ai_usage_events_tenant_fk
    foreign key (tenant_id) references public.organizations (id) on delete restrict,
  add constraint ai_usage_events_institution_fk
    foreign key (institution_id) references public.institutions (id) on delete restrict,
  -- `set null`, not `cascade`: an archived-and-purged conversation loses its link to the
  -- spend it caused, but the spend itself stays on the ledger.
  add constraint ai_usage_events_conversation_fk
    foreign key (conversation_id) references public.ai_conversations (id) on delete set null;

alter table public.ai_budgets
  add constraint ai_budgets_tenant_fk
    foreign key (tenant_id) references public.organizations (id) on delete restrict,
  add constraint ai_budgets_institution_fk
    foreign key (institution_id) references public.institutions (id) on delete restrict;

alter table public.ai_provider_settings
  add constraint ai_provider_settings_tenant_fk
    foreign key (tenant_id) references public.organizations (id) on delete restrict,
  add constraint ai_provider_settings_institution_fk
    foreign key (institution_id) references public.institutions (id) on delete restrict;

-- -------------------------------------------------------------------------------------
-- Indexes
-- -------------------------------------------------------------------------------------

create index if not exists ai_conversations_tenant_idx
  on public.ai_conversations (tenant_id);
-- The list view: this institution's conversations, newest activity first.
create index if not exists ai_conversations_institution_activity_idx
  on public.ai_conversations (institution_id, last_message_at desc);
-- "My conversations" — the default read for anyone without ai.settings.manage.
create index if not exists ai_conversations_owner_idx
  on public.ai_conversations (institution_id, started_by_user_id);
create index if not exists ai_conversations_purpose_idx
  on public.ai_conversations (institution_id, purpose);
create index if not exists ai_conversations_subject_idx
  on public.ai_conversations (subject_type, subject_id);

create unique index if not exists ai_messages_conversation_seq_key
  on public.ai_messages (conversation_id, seq);
create index if not exists ai_messages_tenant_idx
  on public.ai_messages (tenant_id);
create index if not exists ai_messages_conversation_idx
  on public.ai_messages (conversation_id, seq);

create index if not exists ai_usage_events_tenant_idx
  on public.ai_usage_events (tenant_id);
-- The month/user/task aggregates behind GET /ai/usage.
create index if not exists ai_usage_events_institution_occurred_idx
  on public.ai_usage_events (institution_id, occurred_at);
create index if not exists ai_usage_events_user_idx
  on public.ai_usage_events (institution_id, user_id, occurred_at);
create index if not exists ai_usage_events_task_idx
  on public.ai_usage_events (institution_id, task);
create index if not exists ai_usage_events_conversation_idx
  on public.ai_usage_events (conversation_id);

create unique index if not exists ai_budgets_institution_month_key
  on public.ai_budgets (institution_id, year_month);
create index if not exists ai_budgets_tenant_idx
  on public.ai_budgets (tenant_id);

create unique index if not exists ai_provider_settings_institution_key
  on public.ai_provider_settings (institution_id);
create index if not exists ai_provider_settings_tenant_idx
  on public.ai_provider_settings (tenant_id);

-- -------------------------------------------------------------------------------------
-- Check constraints — the invariants that belong in the database, not only in Zod.
-- -------------------------------------------------------------------------------------

alter table public.ai_conversations
  add constraint ai_conversations_title_present check (length(btrim(title)) > 0),
  -- A soft reference is either complete or absent. Half of one is a bug that shows up much
  -- later as a conversation nobody can attribute.
  add constraint ai_conversations_subject_complete check (
    (subject_type is null and subject_id is null)
    or (subject_type is not null and subject_id is not null)
  );

alter table public.ai_messages
  add constraint ai_messages_seq_positive check (seq > 0),
  -- Token counts on a message are as reported by the provider and are never negative;
  -- corrections happen on the usage ledger, not by rewriting a transcript.
  add constraint ai_messages_tokens_non_negative check (input_tokens >= 0 and output_tokens >= 0),
  -- `tool_call_id` answers an invocation, so it only means anything on a tool message.
  add constraint ai_messages_tool_call_id_scope check (
    tool_call_id is null or role = 'tool'
  ),
  -- A model attribution is all-or-nothing: a message that names a model but no provider
  -- cannot be priced, and one that names a finish reason with neither is unattributable.
  add constraint ai_messages_provider_attribution check (
    (provider_key is null and model is null and finish_reason is null)
    or (provider_key is not null and model is not null)
  );

-- Deliberately NO "the row must record something" constraint here. Token counts are signed
-- (see the table comment) and a provider occasionally reports no usage at all for a call it
-- nonetheless billed or refused. Refusing the ledger row in that case would abort a request
-- whose cost had already been incurred, which is a worse outcome than an event of zero.
alter table public.ai_usage_events
  add constraint ai_usage_events_currency_format check (currency ~ '^[A-Z]{3}$');

alter table public.ai_budgets
  add constraint ai_budgets_year_month_format check (year_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  -- The property the two-step derived trigger exists to keep reachable: a compensating
  -- event can credit spend back, but never past zero.
  add constraint ai_budgets_usage_non_negative check (tokens_used >= 0 and cost_used >= 0),
  add constraint ai_budgets_limits_non_negative check (
    (token_limit is null or token_limit >= 0) and (cost_limit is null or cost_limit >= 0)
  ),
  add constraint ai_budgets_currency_format check (currency ~ '^[A-Z]{3}$');

alter table public.ai_provider_settings
  add constraint ai_provider_settings_provider_present check (
    length(btrim(default_provider)) > 0
  ),
  add constraint ai_provider_settings_routing_is_object check (
    jsonb_typeof(task_routing) = 'object'
  ),
  add constraint ai_provider_settings_defaults_non_negative check (
    (default_monthly_token_limit is null or default_monthly_token_limit >= 0)
    and (default_monthly_cost_limit is null or default_monthly_cost_limit >= 0)
  ),
  add constraint ai_provider_settings_currency_format check (currency ~ '^[A-Z]{3}$');

-- -------------------------------------------------------------------------------------
-- Trigger 1: ai_messages is append-only.
--
-- The transcript is the evidence of what an AI was asked and what it answered. Same pattern
-- as workflow_actions (0014), stock_movements (0025) and depreciation_lines (0026): the
-- migrator is exempt so retention and change-controlled repairs remain possible; every
-- other role is refused with `insufficient_privilege`.
-- -------------------------------------------------------------------------------------

create or replace function ai_messages_reject_mutation() returns trigger
language plpgsql
as $$
begin
  if pg_has_role(current_user, 'shikkha_migrator', 'MEMBER') then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  raise exception
    'ai_messages is append-only; a transcript is evidence and is never edited. % is not permitted for role %',
    tg_op, current_user
    using errcode = 'insufficient_privilege';
end
$$;

drop trigger if exists ai_messages_no_mutation on public.ai_messages;
create trigger ai_messages_no_mutation
  before update or delete on public.ai_messages
  for each row execute function ai_messages_reject_mutation();

-- -------------------------------------------------------------------------------------
-- Trigger 2: ai_usage_events is append-only.
--
-- Identical shape, different reason: this is the cost ledger. Correct an over-recorded call
-- with a compensating event carrying negative tokens and a negative cost, never with an
-- UPDATE — the same discipline the accounting journal keeps (0018).
-- -------------------------------------------------------------------------------------

create or replace function ai_usage_events_reject_mutation() returns trigger
language plpgsql
as $$
begin
  if pg_has_role(current_user, 'shikkha_migrator', 'MEMBER') then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  raise exception
    'ai_usage_events is append-only; correct a mis-metered call with a compensating event. % is not permitted for role %',
    tg_op, current_user
    using errcode = 'insufficient_privilege';
end
$$;

drop trigger if exists ai_usage_events_no_mutation on public.ai_usage_events;
create trigger ai_usage_events_no_mutation
  before update or delete on public.ai_usage_events
  for each row execute function ai_usage_events_reject_mutation();

-- -------------------------------------------------------------------------------------
-- Trigger 3: the running month tally on ai_budgets is derived, and only the trigger below
-- may move it.
--
-- Unlike stock_levels (0025), this row is not derived in its entirety: token_limit,
-- cost_limit, hard_stop and currency are an administrator's settings and must stay
-- editable through PUT /ai/budgets/:yearMonth. So the guard is narrower than inventory's —
-- it refuses a write that CHANGES tokens_used or cost_used without the handshake, and lets
-- everything else through. An INSERT from the application is allowed only at zero, so a
-- budget cannot be created with a tally already on it.
--
-- DELETE is refused outright: a budget is an institutional record (ADR-008, never
-- hard-delete), and deleting one would take a month's metering history's summary with it.
-- -------------------------------------------------------------------------------------

create or replace function ai_budgets_guard_derived_columns() returns trigger
language plpgsql
as $$
begin
  if pg_has_role(current_user, 'shikkha_migrator', 'MEMBER') then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if coalesce(current_setting('app.ai_budget_writer', true), '') = 'on' then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    raise exception
      'ai_budgets rows are never deleted; archive the row or clear its limits instead'
      using errcode = 'insufficient_privilege';
  end if;

  if tg_op = 'INSERT' and (new.tokens_used <> 0 or new.cost_used <> 0) then
    raise exception
      'ai_budgets.tokens_used and cost_used are derived from ai_usage_events; a new budget starts at zero'
      using errcode = 'insufficient_privilege';
  end if;

  if tg_op = 'UPDATE'
     and (new.tokens_used is distinct from old.tokens_used
          or new.cost_used is distinct from old.cost_used) then
    raise exception
      'ai_budgets.tokens_used and cost_used are derived from ai_usage_events; record a usage event instead of writing the tally'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end
$$;

drop trigger if exists ai_budgets_derived_guard on public.ai_budgets;
create trigger ai_budgets_derived_guard
  before insert or update or delete on public.ai_budgets
  for each row execute function ai_budgets_guard_derived_columns();

-- -------------------------------------------------------------------------------------
-- Trigger 4: every inserted usage event lands on its month's budget row, in the same
-- transaction.
--
-- THE 0031 LESSON, restated because this is the same shape of trigger and the same trap:
-- a single `insert ... on conflict (…) do update set used = used + excluded.used` looks
-- like "add the delta to the running total" and behaves that way only for a positive delta.
-- PostgreSQL checks CHECK constraints against the proposed insertion tuple *before* ON
-- CONFLICT arbitration picks the DO UPDATE branch, so a compensating event's negative delta
-- would fail `ai_budgets_usage_non_negative` on a tuple that was never going to be stored,
-- and abort the event insert with a balance that was perfectly valid.
--
-- Two steps instead:
--   1. Insert a ZERO row `on conflict do nothing`. Zero satisfies the check whatever the
--      sign of the delta, and `do nothing` absorbs the race where a concurrent call created
--      the same month's row a moment earlier.
--   2. `update ... set tokens_used = tokens_used + delta`. The update takes a row lock, so
--      concurrent events for one institution-month serialise here, and the check sees the
--      resulting total — which is exactly what it was written to guard.
--
-- The zero row is created with NULL limits deliberately: "a month nobody has budgeted" and
-- "a month budgeted at zero" are different states, and the service resolves the former
-- against ai_provider_settings' defaults rather than silently inventing a ceiling here.
-- -------------------------------------------------------------------------------------

create or replace function ai_usage_events_apply_budget() returns trigger
language plpgsql
as $$
declare
  month char(7);
  token_delta bigint;
begin
  -- The month is derived from the event's own timestamp, in Asia/Dhaka, because that is the
  -- calendar a Bangladeshi school budgets against. Deriving it in UTC would move spend from
  -- the first six hours of a local month into the previous one.
  month := to_char(new.occurred_at at time zone 'Asia/Dhaka', 'YYYY-MM');
  token_delta := new.input_tokens::bigint + new.output_tokens::bigint;

  perform set_config('app.ai_budget_writer', 'on', true);

  -- Step 1: the budget row must exist before it can be adjusted.
  insert into public.ai_budgets
    (id, tenant_id, institution_id, year_month, tokens_used, cost_used, currency,
     created_by, updated_by)
  values
    (gen_random_uuid(), new.tenant_id, new.institution_id, month, 0, 0, new.currency,
     new.user_id, new.user_id)
  on conflict (institution_id, year_month) do nothing;

  -- Step 2: apply the signed deltas to the tally itself. This is the write that
  -- `ai_budgets_usage_non_negative` polices, and the value it now sees is the resulting
  -- total rather than the delta in isolation.
  update public.ai_budgets
     set tokens_used = tokens_used + token_delta,
         cost_used = cost_used + new.cost,
         updated_by = coalesce(new.user_id, updated_by)
   where institution_id = new.institution_id
     and year_month = month;

  perform set_config('app.ai_budget_writer', 'off', true);

  return null;
end
$$;

drop trigger if exists ai_usage_events_apply_budget_tally on public.ai_usage_events;
create trigger ai_usage_events_apply_budget_tally
  after insert on public.ai_usage_events
  for each row execute function ai_usage_events_apply_budget();

-- -------------------------------------------------------------------------------------
-- Row-level security, grants and updated_at for the new tables. The catalogue loop in 0002
-- does not re-run for tables created later, so it is restated here.
-- -------------------------------------------------------------------------------------

do $$
declare
  target text;
  ai_tables constant text[] := array[
    'ai_conversations',
    'ai_messages',
    'ai_usage_events',
    'ai_budgets',
    'ai_provider_settings'
  ];
begin
  foreach target in array ai_tables
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
  ai_tables constant text[] := array[
    'ai_conversations', 'ai_messages', 'ai_usage_events', 'ai_budgets', 'ai_provider_settings'
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
    and c.relname = any (ai_tables)
    and (
      not c.relrowsecurity
      or not c.relforcerowsecurity
      or not exists (
        select 1 from pg_policy p where p.polrelid = c.oid and p.polname = 'tenant_isolation'
      )
    );

  if offending is not null then
    raise exception
      'AI tables without forced row-level security and a tenant_isolation policy: %',
      offending;
  end if;

  -- Every one must also carry the tenant column the policy reads. A policy on a table
  -- without `tenant_id` fails at query time, not here.
  select string_agg(t.name, ', ' order by t.name)
  into offending
  from unnest(ai_tables) as t(name)
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
    raise exception 'AI tables without a tenant_id column: %', offending;
  end if;

  -- …and the institution column every one of these is scoped by in the application.
  select string_agg(t.name, ', ' order by t.name)
  into offending
  from unnest(ai_tables) as t(name)
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
    raise exception 'AI tables without an institution_id column: %', offending;
  end if;

  -- The append-only triggers. Without them the transcript is editable history and the cost
  -- ledger is a set of numbers anyone can revise.
  if not exists (
    select 1 from pg_trigger
    where tgname = 'ai_messages_no_mutation'
      and tgrelid = 'public.ai_messages'::regclass
      and not tgisinternal
  ) then
    raise exception 'ai_messages append-only trigger is missing';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'ai_usage_events_no_mutation'
      and tgrelid = 'public.ai_usage_events'::regclass
      and not tgisinternal
  ) then
    raise exception 'ai_usage_events append-only trigger is missing';
  end if;

  -- The derived-budget pair: the guard that keeps the tally out of the application's hands,
  -- and the trigger that maintains it.
  if not exists (
    select 1 from pg_trigger
    where tgname = 'ai_budgets_derived_guard'
      and tgrelid = 'public.ai_budgets'::regclass
      and not tgisinternal
  ) then
    raise exception 'ai_budgets derived-column guard trigger is missing';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'ai_usage_events_apply_budget_tally'
      and tgrelid = 'public.ai_usage_events'::regclass
      and not tgisinternal
  ) then
    raise exception 'ai_usage_events budget-tally trigger is missing';
  end if;
end
$$;

-- The 0031 property, proved rather than assumed: the two-step apply must survive a delta
-- that a single upsert's proposed tuple would have failed the check on, and must still
-- refuse a credit that would take the tally below zero. Exercised on a scratch table shaped
-- like ai_budgets so the assertion tests the ordering without inventing tenant or
-- institution rows.
do $$
declare
  institution uuid := gen_random_uuid();
  tally numeric(14, 4);
begin
  create temp table ai_budget_probe (
    institution_id uuid not null,
    year_month char(7) not null,
    cost_used numeric(14, 4) not null,
    constraint ai_budget_probe_non_negative check (cost_used >= 0),
    constraint ai_budget_probe_key unique (institution_id, year_month)
  ) on commit drop;

  insert into ai_budget_probe (institution_id, year_month, cost_used)
  values (institution, '2026-08', 0)
  on conflict (institution_id, year_month) do nothing;
  update ai_budget_probe set cost_used = cost_used + 1.0000
   where institution_id = institution and year_month = '2026-08';

  -- A compensating event: negative delta, valid resulting total. The naive upsert would
  -- have died on the bare -0.4000 in its proposed tuple.
  insert into ai_budget_probe (institution_id, year_month, cost_used)
  values (institution, '2026-08', 0)
  on conflict (institution_id, year_month) do nothing;
  update ai_budget_probe set cost_used = cost_used + (-0.4000)
   where institution_id = institution and year_month = '2026-08';

  select cost_used into tally
  from ai_budget_probe where institution_id = institution and year_month = '2026-08';

  if tally is distinct from 0.6000 then
    raise exception 'the two-step budget apply did not produce 0.6000 (got %)', tally;
  end if;

  -- …while a credit larger than everything ever spent is still refused.
  begin
    update ai_budget_probe set cost_used = cost_used + (-99.0000)
     where institution_id = institution and year_month = '2026-08';
    raise exception
      'an over-crediting update was accepted; the non-negative tally check is not doing its job';
  exception
    when check_violation then null;
  end;
end
$$;

-- The global sweep: every public table is either RLS-protected or explicitly exempt.
select assert_rls_coverage();
