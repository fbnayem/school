-- =====================================================================================
-- 0030 — Automation engine (Phase 26)
--
-- Four tenant-scoped tables. The workflow engine (0014) carries *human* approval chains;
-- this carries *rule-triggered* reactions, and docs/08_WORKFLOW_ENGINE.md §5 states the
-- relationship between them: where a rule needs a human decision, the rule creates a
-- workflow request or a suggestion rather than acting.
--
-- The properties this file — not the service — is responsible for:
--
--   1. **No rule can be stored in an autonomously-sensitive shape.** The
--      `automation_action_kind` enum contains no value that changes a grade, an attendance
--      mark, an approval, a payment, a salary or a record's existence. On top of that,
--      `automation_rules_sensitive_needs_human` refuses any rule whose action names a
--      sensitive `targetResource` unless it both requires human confirmation and uses one
--      of the two human-in-the-loop action kinds. A bug in the service cannot write a rule
--      that Postgres will let act by itself.
--   2. **`automation_events` is APPEND-ONLY** — the same mechanism as `audit_logs` (0005),
--      `workflow_actions` (0014) and `messages` (0022), with the same single-permitted-
--      transition shape the posted journal entry uses in 0018: DELETE is refused outright,
--      and the only UPDATE that survives stamps `processed_at` once, from null, with every
--      other column unchanged. DELETE is revoked from `shikkha_app` as well, so the
--      application role cannot even attempt it.
--   3. **The same event never acts twice.** `automation_events_institution_dedupe_key` is a
--      unique index, so a redelivered upstream event is refused by the database; the service
--      turns that refusal into a recorded `suppressed_duplicate` rather than a second round
--      of messages.
--   4. **A trigger shape is coherent.** A scheduled rule has a cron expression and no event
--      name; an event or threshold rule has an event name and no cron expression.
--
-- Deliberately absent: a scheduler. `cron_expression`, `timezone` and `trigger_kind =
-- 'schedule'` are carried from this first migration so that adding one later is a
-- deployment concern, not a migration.
--
-- RLS is enabled, forced and given the standard `tenant_isolation` policy for every table,
-- and `assert_rls_coverage()` runs last so a mistake fails the migration rather than
-- shipping a silently-disabled control.
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- Enumerations. Closed sets only: a new trigger kind, action kind or execution status
-- changes the evaluator as well as the schema. The rules themselves, their thresholds and
-- their message text are rows and jsonb, never enum values.
-- -------------------------------------------------------------------------------------

create type public.automation_trigger_kind as enum ('event', 'schedule', 'threshold');

-- The structural half of "a rule never autonomously performs a sensitive action": there is
-- no value here that changes a grade, an attendance mark, an approval, money or a salary.
create type public.automation_action_kind as enum (
  'notify', 'create_workflow_request', 'create_record', 'flag_for_review'
);

create type public.automation_execution_status as enum (
  'matched',
  'suppressed_cooldown',
  'suppressed_duplicate',
  'acted',
  'failed',
  'awaiting_confirmation'
);

create type public.automation_suggestion_status as enum ('pending', 'accepted', 'dismissed');

-- -------------------------------------------------------------------------------------
-- Tables
-- -------------------------------------------------------------------------------------

create table public.automation_rules (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  key varchar(64) not null,
  name_en varchar(255) not null,
  name_bn varchar(255),
  description varchar(2000),
  trigger_kind public.automation_trigger_kind not null,
  event_name varchar(64),
  cron_expression varchar(120),
  timezone varchar(64) default 'Asia/Dhaka' not null,
  conditions jsonb default '{"match":"all","clauses":[]}'::jsonb not null,
  action_kind public.automation_action_kind not null,
  action_config jsonb default '{}'::jsonb not null,
  is_active boolean default false not null,
  requires_human_confirmation boolean default false not null,
  cooldown_minutes integer default 0 not null,
  is_system boolean default false not null,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.automation_events (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  event_name varchar(64) not null,
  payload jsonb default '{}'::jsonb not null,
  occurred_at timestamp with time zone default now() not null,
  source_module varchar(32) not null,
  processed_at timestamp with time zone,
  dedupe_key varchar(200) not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  -- Present to satisfy the schema-wide conventions only. The append-only trigger refuses
  -- the UPDATE that would ever set them, exactly as it does on `workflow_actions`.
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.automation_executions (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  rule_id uuid not null,
  event_id uuid,
  matched_at timestamp with time zone default now() not null,
  status public.automation_execution_status not null,
  subject_kind varchar(32),
  subject_id uuid,
  action_result jsonb default '{}'::jsonb not null,
  error varchar(1000),
  -- No foreign key: the workflow engine is an optional peer, exactly as it is for
  -- `expense_claims.workflow_request_id` in 0018.
  workflow_request_id uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.automation_suggestions (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  rule_id uuid not null,
  execution_id uuid not null,
  subject_kind varchar(32) not null,
  subject_id uuid not null,
  summary varchar(500) not null,
  evidence jsonb default '{}'::jsonb not null,
  status public.automation_suggestion_status default 'pending' not null,
  decided_by uuid,
  decided_at timestamp with time zone,
  decision_note varchar(1000),
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
-- Foreign keys. `restrict` throughout: an execution is evidence, and evidence whose rule
-- or event can vanish underneath it is not evidence.
-- -------------------------------------------------------------------------------------

alter table public.automation_rules
  add constraint automation_rules_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint automation_rules_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict;

alter table public.automation_events
  add constraint automation_events_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint automation_events_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict;

alter table public.automation_executions
  add constraint automation_executions_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint automation_executions_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint automation_executions_rule_id_automation_rules_id_fk
    foreign key (rule_id) references public.automation_rules(id) on delete restrict,
  add constraint automation_executions_event_id_automation_events_id_fk
    foreign key (event_id) references public.automation_events(id) on delete restrict;

alter table public.automation_suggestions
  add constraint automation_suggestions_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint automation_suggestions_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint automation_suggestions_rule_id_automation_rules_id_fk
    foreign key (rule_id) references public.automation_rules(id) on delete restrict,
  add constraint automation_suggestions_execution_id_automation_executions_id_fk
    foreign key (execution_id) references public.automation_executions(id) on delete restrict;

-- -------------------------------------------------------------------------------------
-- Indexes. The rule key/version pair is NOT partial: a version number is never reused,
-- archived or not. The "exactly one active version per key" pin is, so an archived rule
-- releases its key.
-- -------------------------------------------------------------------------------------

create unique index if not exists automation_rules_institution_key_version_key
  on public.automation_rules using btree (institution_id, key, version);
create unique index if not exists automation_rules_active_key
  on public.automation_rules using btree (institution_id, key)
  where is_active and archived_at is null;
create index if not exists automation_rules_tenant_idx
  on public.automation_rules using btree (tenant_id);
create index if not exists automation_rules_event_idx
  on public.automation_rules using btree (institution_id, event_name);
create index if not exists automation_rules_trigger_idx
  on public.automation_rules using btree (institution_id, trigger_kind, is_active);

-- The idempotency guarantee. Not partial: a dedupe key is consumed forever.
create unique index if not exists automation_events_institution_dedupe_key
  on public.automation_events using btree (institution_id, dedupe_key);
create index if not exists automation_events_tenant_idx
  on public.automation_events using btree (tenant_id);
create index if not exists automation_events_pending_idx
  on public.automation_events using btree (institution_id, occurred_at)
  where processed_at is null;
create index if not exists automation_events_name_idx
  on public.automation_events using btree (institution_id, event_name, occurred_at);

create index if not exists automation_executions_tenant_idx
  on public.automation_executions using btree (tenant_id);
create index if not exists automation_executions_rule_idx
  on public.automation_executions using btree (rule_id, matched_at);
create index if not exists automation_executions_event_idx
  on public.automation_executions using btree (event_id);
create index if not exists automation_executions_institution_status_idx
  on public.automation_executions using btree (institution_id, status, matched_at);
-- Drives the per-subject cooldown lookup, the hottest read on this table.
create index if not exists automation_executions_cooldown_idx
  on public.automation_executions using btree (rule_id, subject_kind, subject_id, matched_at);

-- One suggestion per execution, so reprocessing a partially-failed batch cannot produce a
-- second copy of the same advice.
create unique index if not exists automation_suggestions_execution_key
  on public.automation_suggestions using btree (execution_id);
create index if not exists automation_suggestions_tenant_idx
  on public.automation_suggestions using btree (tenant_id);
create index if not exists automation_suggestions_institution_status_idx
  on public.automation_suggestions using btree (institution_id, status, created_at);
create index if not exists automation_suggestions_rule_idx
  on public.automation_suggestions using btree (rule_id);
create index if not exists automation_suggestions_subject_idx
  on public.automation_suggestions using btree (subject_kind, subject_id);

-- -------------------------------------------------------------------------------------
-- Check constraints. The invariants restated where they cannot be argued with.
-- -------------------------------------------------------------------------------------

alter table public.automation_rules
  add constraint automation_rules_key_format
    check (key ~ '^[a-z][a-z0-9_]{1,63}$'),
  add constraint automation_rules_version_positive check (version >= 1),
  add constraint automation_rules_cooldown_non_negative
    check (cooldown_minutes >= 0 and cooldown_minutes <= 43200),
  -- A scheduled rule has a cron expression and no event name; an event or threshold rule
  -- has an event name and no cron expression. Neither shape can be half-specified.
  add constraint automation_rules_trigger_shape
    check (
      (trigger_kind = 'schedule'
        and cron_expression is not null
        and event_name is null)
      or (trigger_kind in ('event', 'threshold')
        and event_name is not null
        and cron_expression is null)
    ),
  -- THE release-blocking rule, in the database. A rule whose action names a sensitive
  -- resource may exist — watching grades is useful — but only in the shape where a person
  -- decides: human confirmation required, and an action kind that cannot do anything but
  -- raise a suggestion or start an approval chain.
  add constraint automation_rules_sensitive_needs_human
    check (
      (action_config ->> 'targetResource') is null
      or (action_config ->> 'targetResource') <> all (array[
        'grade', 'exam_mark', 'exam_result', 'attendance', 'payment', 'refund', 'invoice',
        'salary', 'payroll', 'discipline', 'user_role', 'student_record', 'employee_record',
        'mass_communication'
      ])
      or (
        requires_human_confirmation
        and action_kind in ('flag_for_review', 'create_workflow_request')
      )
    );

alter table public.automation_events
  add constraint automation_events_dedupe_key_present
    check (length(btrim(dedupe_key)) > 3),
  add constraint automation_events_payload_is_object
    check (jsonb_typeof(payload) = 'object');

alter table public.automation_executions
  -- A failure with no explanation is an unreadable log entry.
  add constraint automation_executions_failure_explained
    check (status <> 'failed' or error is not null),
  -- Either both subject columns are set or neither is; half a subject cannot be cooled down.
  add constraint automation_executions_subject_paired
    check ((subject_kind is null) = (subject_id is null));

alter table public.automation_suggestions
  add constraint automation_suggestions_summary_present
    check (length(btrim(summary)) > 0),
  -- A decided suggestion always records who decided and when.
  add constraint automation_suggestions_decision_recorded
    check (
      status = 'pending'
      or (decided_by is not null and decided_at is not null)
    );

-- -------------------------------------------------------------------------------------
-- Trigger: `automation_events` is append-only.
--
-- DELETE is refused for every role but the migrator (whose exemption exists for retention
-- and demo resets, exactly as it does for audit_logs in 0005). UPDATE is refused too, with
-- one narrow exception modelled on the posted-journal-entry guard in 0018: stamping
-- `processed_at` once, from null, with every substantive column unchanged. `updated_at`
-- and `updated_by` are excluded from the comparison — the first is maintained by
-- `set_updated_at`, the second records who ran the processing pass.
-- -------------------------------------------------------------------------------------

create or replace function automation_events_guard_mutation() returns trigger
language plpgsql
as $$
begin
  if pg_has_role(current_user, 'shikkha_migrator', 'MEMBER') then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    raise exception
      'automation_events is append-only; DELETE is not permitted'
      using errcode = 'insufficient_privilege';
  end if;

  if old.processed_at is null
     and new.processed_at is not null
     and new.id = old.id
     and new.tenant_id = old.tenant_id
     and new.institution_id = old.institution_id
     and new.event_name = old.event_name
     and new.payload::text = old.payload::text
     and new.occurred_at = old.occurred_at
     and new.source_module = old.source_module
     and new.dedupe_key = old.dedupe_key
     and new.created_at = old.created_at
     and new.created_by is not distinct from old.created_by
     and new.archived_at is null
     and new.archived_by is null
     and new.archive_reason is null
  then
    return new;
  end if;

  raise exception
    'automation_events is append-only; the only permitted update stamps processed_at once'
    using errcode = 'insufficient_privilege';
end
$$;

drop trigger if exists automation_events_no_mutation on public.automation_events;
create trigger automation_events_no_mutation
  before update or delete on public.automation_events
  for each row execute function automation_events_guard_mutation();

-- -------------------------------------------------------------------------------------
-- Row-level security. The 0002 loop does not re-run for tables created later, so the
-- policy, the grants and the `set_updated_at` trigger are applied here for these four.
-- -------------------------------------------------------------------------------------

do $$
declare
  target text;
  automation_tables constant text[] := array[
    'automation_rules',
    'automation_events',
    'automation_executions',
    'automation_suggestions'
  ];
begin
  foreach target in array automation_tables
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

    -- `updated_at` is maintained by the trigger, not by the application. On the append-only
    -- events table this trigger fires only for the one permitted update:
    -- `automation_events_no_mutation` sorts before `set_updated_at` and refuses first.
    execute format('drop trigger if exists set_updated_at on public.%I', target);
    execute format(
      'create trigger set_updated_at before update on public.%I
         for each row execute function set_updated_at()',
      target
    );
  end loop;
end
$$;

-- Append-only at the privilege level too, like `audit_logs` and `messages`: the application
-- role cannot even attempt to delete an event. UPDATE is retained solely so the processing
-- pass can stamp `processed_at`, which the trigger above constrains to exactly that.
revoke delete on public.automation_events from shikkha_app;

-- -------------------------------------------------------------------------------------
-- System default rules (docs/08 §5), seeded as DATA for every existing institution — not
-- hard-coded logic. **All four ship INACTIVE**: a school reads them, edits the thresholds
-- and message text, and turns on the ones it wants, which is an audited act.
--
-- Institutions created after this migration get the same set from
-- `POST /automation/rules/install-defaults`, which writes these identical rows for one
-- institution and is idempotent.
--
-- The fourth rule is the shape this whole module exists to make unavoidable: it watches a
-- sensitive resource (`exam_mark`), so it requires human confirmation and can do nothing
-- but raise a suggestion — a constraint on this table, not a convention in the service.
-- -------------------------------------------------------------------------------------

do $$
declare
  inst record;
begin
  -- The seed runs inside the migration's own transaction as the migrator; the platform-admin
  -- context satisfies the freshly created policies regardless of role attributes, and being
  -- SET LOCAL it evaporates at commit.
  perform set_config('app.is_platform_admin', 'on', true);

  for inst in
    select id, tenant_id from public.institutions where archived_at is null
  loop
    if not exists (
      select 1 from public.automation_rules r
      where r.institution_id = inst.id and r.key = 'absence_three_consecutive'
    ) then
      insert into public.automation_rules
        (tenant_id, institution_id, key, name_en, name_bn, description, trigger_kind,
         event_name, conditions, action_kind, action_config, is_active,
         requires_human_confirmation, cooldown_minutes, is_system, version)
      values
        (inst.tenant_id, inst.id, 'absence_three_consecutive',
         'Three consecutive absences notify the guardian',
         'পরপর তিন দিন অনুপস্থিতিতে অভিভাবককে জানানো হয়',
         'When a student has been absent three days running, message the guardians once a day at most.',
         'threshold', 'attendance.student_absent',
         '{"match":"all","clauses":[{"field":"fact.student_consecutive_absences","op":"gte","value":3}]}'::jsonb,
         'notify',
         '{"recipients":"guardians_of_subject_student","subject":"Attendance alert","messageEn":"Our records show {{studentName}} has been absent on {{date}} and for {{consecutiveAbsences}} consecutive days. Please contact the class teacher.","messageBn":"আমাদের রেকর্ড অনুযায়ী {{studentName}} {{consecutiveAbsences}} দিন ধরে অনুপস্থিত। অনুগ্রহ করে শ্রেণিশিক্ষকের সঙ্গে যোগাযোগ করুন।"}'::jsonb,
         false, false, 1440, true, 1);
    end if;

    if not exists (
      select 1 from public.automation_rules r
      where r.institution_id = inst.id and r.key = 'fee_overdue_fifteen_days'
    ) then
      insert into public.automation_rules
        (tenant_id, institution_id, key, name_en, name_bn, description, trigger_kind,
         event_name, conditions, action_kind, action_config, is_active,
         requires_human_confirmation, cooldown_minutes, is_system, version)
      values
        (inst.tenant_id, inst.id, 'fee_overdue_fifteen_days',
         'Fee fifteen days overdue sends a reminder',
         'পনেরো দিন বকেয়া ফি-এর জন্য স্মারক পাঠানো হয়',
         'A polite reminder to the guardians of a student whose invoice is fifteen days past due, at most weekly.',
         'threshold', 'fees.invoice_overdue',
         '{"match":"all","clauses":[{"field":"fact.invoice_days_overdue","op":"gte","value":15},{"field":"fact.invoice_balance_poisha","op":"gt","value":0}]}'::jsonb,
         'notify',
         '{"recipients":"guardians_of_subject_student","subject":"Fee reminder","messageEn":"Invoice {{invoiceNumber}} for {{studentName}} is {{daysOverdue}} days past its due date. Please visit the accounts office at your convenience.","messageBn":"{{studentName}}-এর চালান {{invoiceNumber}} নির্ধারিত তারিখের {{daysOverdue}} দিন পার হয়েছে। অনুগ্রহ করে হিসাব শাখায় যোগাযোগ করুন।"}'::jsonb,
         false, false, 10080, true, 1);
    end if;

    if not exists (
      select 1 from public.automation_rules r
      where r.institution_id = inst.id and r.key = 'document_expiring_thirty_days'
    ) then
      insert into public.automation_rules
        (tenant_id, institution_id, key, name_en, name_bn, description, trigger_kind,
         event_name, conditions, action_kind, action_config, is_active,
         requires_human_confirmation, cooldown_minutes, is_system, version)
      values
        (inst.tenant_id, inst.id, 'document_expiring_thirty_days',
         'Document expiring within thirty days flags HR',
         'ত্রিশ দিনের মধ্যে মেয়াদোত্তীর্ণ নথি এইচআরকে জানানো হয়',
         'Raises a suggestion for HR when an employee document lapses within a month. HR renews it; the rule does not.',
         'threshold', 'hr.document_expiring',
         '{"match":"all","clauses":[{"field":"fact.employee_document_days_to_expiry","op":"lte","value":30}]}'::jsonb,
         'flag_for_review',
         '{"summary":"{{employeeName}} — {{documentType}} expires on {{expiresAt}} ({{daysToExpiry}} days). Renew or archive it."}'::jsonb,
         false, false, 43200, true, 1);
    end if;

    if not exists (
      select 1 from public.automation_rules r
      where r.institution_id = inst.id and r.key = 'low_exam_mark_early_warning'
    ) then
      insert into public.automation_rules
        (tenant_id, institution_id, key, name_en, name_bn, description, trigger_kind,
         event_name, conditions, action_kind, action_config, is_active,
         requires_human_confirmation, cooldown_minutes, is_system, version)
      values
        (inst.tenant_id, inst.id, 'low_exam_mark_early_warning',
         'Low exam mark raises an early-warning suggestion',
         'কম নম্বরে আগাম সতর্কতার পরামর্শ তৈরি হয়',
         'Marks are a sensitive resource: this rule may only describe what it noticed. A teacher decides what to do.',
         'event', 'exams.mark_recorded',
         '{"match":"all","clauses":[{"field":"event.percentage","op":"lt","value":40}]}'::jsonb,
         'flag_for_review',
         '{"targetResource":"exam_mark","summary":"{{studentName}} scored {{percentage}}% in {{subjectName}}. Consider an early-warning conversation."}'::jsonb,
         false, true, 0, true, 1);
    end if;
  end loop;
end
$$;

-- -------------------------------------------------------------------------------------
-- Assertions — fail the migration rather than ship a silently-disabled control.
-- -------------------------------------------------------------------------------------

do $$
declare
  offending text;
begin
  -- Named explicitly rather than relying only on the global sweep below, so that a typo in
  -- the array above is a failed migration instead of a table nobody notices is unprotected.
  select string_agg(c.relname, ', ' order by c.relname)
  into offending
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relname = any (array[
      'automation_rules', 'automation_events', 'automation_executions',
      'automation_suggestions'
    ])
    and (
      not c.relrowsecurity
      or not c.relforcerowsecurity
      or not exists (
        select 1 from pg_policy p where p.polrelid = c.oid and p.polname = 'tenant_isolation'
      )
    );

  if offending is not null then
    raise exception
      'Automation tables without forced row-level security and a tenant_isolation policy: %',
      offending;
  end if;

  -- Each must also carry the tenant column the policy reads. A policy on a table without
  -- `tenant_id` would fail at query time, not here.
  select string_agg(t.name, ', ' order by t.name)
  into offending
  from unnest(array[
    'automation_rules', 'automation_events', 'automation_executions', 'automation_suggestions'
  ]) as t(name)
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
    raise exception 'Automation tables without a tenant_id column: %', offending;
  end if;
end
$$;

do $$
begin
  -- `automation_rules` has FORCED row-level security, which applies to the table owner too,
  -- so the two seed assertions below would silently see zero rows without this. It is the
  -- same transaction-local platform context the seed block set; restating it here means a
  -- reordering of this file cannot turn an assertion into a no-op.
  perform set_config('app.is_platform_admin', 'on', true);

  -- The append-only trigger must exist on the events table.
  if not exists (
    select 1
    from pg_trigger tg
    join pg_class c on c.oid = tg.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'automation_events'
      and tg.tgname = 'automation_events_no_mutation'
  ) then
    raise exception 'automation_events is missing its append-only trigger';
  end if;

  if has_table_privilege('shikkha_app', 'public.automation_events', 'DELETE') then
    raise exception
      'shikkha_app can delete automation_events; the event log would not be trustworthy';
  end if;

  -- Every seeded rule ships inactive. A rule that starts messaging guardians the moment a
  -- release lands is exactly what this module must never do.
  if exists (
    select 1 from public.automation_rules where is_system and is_active
  ) then
    raise exception 'A system automation rule was seeded active; system rules ship inactive';
  end if;

  -- And no rule anywhere targets a sensitive resource without a human in the loop. The
  -- check constraint guarantees this going forward; this proves the seed obeys it too.
  if exists (
    select 1 from public.automation_rules
    where (action_config ->> 'targetResource') = any (array[
      'grade', 'exam_mark', 'exam_result', 'attendance', 'payment', 'refund', 'invoice',
      'salary', 'payroll', 'discipline', 'user_role', 'student_record', 'employee_record',
      'mass_communication'
    ])
      and not (
        requires_human_confirmation
        and action_kind in ('flag_for_review', 'create_workflow_request')
      )
  ) then
    raise exception 'An automation rule targets a sensitive resource with no human in the loop';
  end if;
end
$$;

-- The global sweep: every public table is either RLS-protected or explicitly exempt.
select assert_rls_coverage();
