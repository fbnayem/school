-- =====================================================================================
-- 0014 — Workflow engine (Phase 25)
--
-- Human approval chains as data. A definition (versioned per institution) lists steps; a
-- request is one entity moving through one frozen version; an action is one human decision.
-- Two properties of docs/08_WORKFLOW_ENGINE.md are enforced *here*, in the database, rather
-- than only in the service:
--
--   1. `workflow_actions` is append-only, exactly like `audit_logs`. History is the product:
--      a send-back adds a row, it never erases the decision it reverses. UPDATE and DELETE
--      are revoked from `shikkha_app`, and the same reject-mutation trigger pattern as
--      migration 0005 refuses them for every role except the migrator (which runs retention).
--   2. Escalation is schema-ready from this first migration: `due_at`, `sla_hours`,
--      `escalation_permission`, the `escalate` action and the `escalated` status all exist
--      now, so adding a scheduler later is a code change, not a migration.
--
-- The rule the module exists for — an approver may not approve their own request, even the
-- school owner (KI-002) — cannot be expressed as a permission or as a table constraint over
-- data the database can see (the actor is request-scoped), so it lives in the service; the
-- integration suite proves it with an actor who holds every permission.
--
-- Approvers are stored as *permissions*, never as user ids, so a staffing change cannot
-- strand a running request. Foreign keys are named `<table>_<column>_fk` (0007's convention,
-- for the 63-byte identifier limit). This file is hand-written throughout.
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- Enumerations. Each set is closed: adding a request status or a rejection behaviour
-- changes the state machine, which is a code change, not tenant configuration.
-- -------------------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'workflow_approver_scope') then
    create type public.workflow_approver_scope as enum ('institution', 'campus', 'department');
  end if;

  if not exists (select 1 from pg_type where typname = 'workflow_on_reject') then
    create type public.workflow_on_reject as enum ('terminate', 'send_back', 'previous_step');
  end if;

  if not exists (select 1 from pg_type where typname = 'workflow_request_status') then
    create type public.workflow_request_status as enum (
      'draft', 'pending', 'approved', 'rejected', 'sent_back', 'cancelled', 'escalated'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'workflow_action') then
    create type public.workflow_action as enum (
      'approve', 'reject', 'send_back', 'cancel', 'escalate', 'comment'
    );
  end if;
end
$$;

-- -------------------------------------------------------------------------------------
-- Tables
-- -------------------------------------------------------------------------------------

-- A versioned approval chain. The unique key is (institution, key, version); a second
-- partial index below pins "exactly one active version per key". An active definition is
-- immutable — the service inserts version + 1 and deactivates the old row — so a running
-- request's (definition_id, definition_version) pair keeps resolving the steps it started
-- under.
create table if not exists public.workflow_definitions (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "institution_id" uuid not null,
  "key" varchar(64) not null,
  "name_en" varchar(255) not null,
  "name_bn" varchar(255),
  "entity_type" varchar(64) not null,
  "version" integer default 1 not null,
  "is_active" boolean default true not null,
  "is_system" boolean default false not null,
  "description" text,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "archived_at" timestamp with time zone,
  "archived_by" uuid,
  "archive_reason" varchar(500),
  "created_by" uuid,
  "updated_by" uuid,
  constraint workflow_definitions_tenant_id_fk foreign key ("tenant_id")
    references public.organizations("id") on delete restrict,
  constraint workflow_definitions_institution_id_fk foreign key ("institution_id")
    references public.institutions("id") on delete restrict
);

-- One step of one definition version. `approver_permission` is a permission string, never a
-- name; `escalation_permission` and `sla_hours` are carried now so the scheduler is a later
-- code change. An optional step with no eligible approver is skipped rather than stalling.
create table if not exists public.workflow_steps (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "definition_id" uuid not null,
  "sequence" integer not null,
  "name_en" varchar(255) not null,
  "name_bn" varchar(255),
  "approver_permission" varchar(128) not null,
  "approver_scope" "public"."workflow_approver_scope" default 'institution' not null,
  "is_optional" boolean default false not null,
  "sla_hours" integer,
  "escalation_permission" varchar(128),
  "on_reject" "public"."workflow_on_reject" default 'terminate' not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "archived_at" timestamp with time zone,
  "archived_by" uuid,
  "archive_reason" varchar(500),
  "created_by" uuid,
  "updated_by" uuid,
  constraint workflow_steps_tenant_id_fk foreign key ("tenant_id")
    references public.organizations("id") on delete restrict,
  -- `cascade` is safe because definitions are archived, never hard-deleted (ADR-008); the
  -- only DELETE path runs as the migrator.
  constraint workflow_steps_definition_id_fk foreign key ("definition_id")
    references public.workflow_definitions("id") on delete cascade
);

-- One entity's journey through one frozen definition version.
create table if not exists public.workflow_requests (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "institution_id" uuid not null,
  "campus_id" uuid,
  "definition_id" uuid not null,
  "definition_version" integer not null,
  "entity_type" varchar(64) not null,
  "entity_id" uuid not null,
  "initiated_by" uuid not null,
  "initiated_at" timestamp with time zone default now() not null,
  "current_step_sequence" integer default 1 not null,
  "status" "public"."workflow_request_status" default 'pending' not null,
  "due_at" timestamp with time zone,
  "payload" jsonb default '{}'::jsonb not null,
  "summary" varchar(500) not null,
  "decided_at" timestamp with time zone,
  "version" integer default 1 not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "archived_at" timestamp with time zone,
  "archived_by" uuid,
  "archive_reason" varchar(500),
  "created_by" uuid,
  "updated_by" uuid,
  constraint workflow_requests_tenant_id_fk foreign key ("tenant_id")
    references public.organizations("id") on delete restrict,
  constraint workflow_requests_institution_id_fk foreign key ("institution_id")
    references public.institutions("id") on delete restrict,
  constraint workflow_requests_campus_id_fk foreign key ("campus_id")
    references public.campuses("id") on delete set null,
  -- `restrict`: a decided request is an institutional record and must survive its
  -- definition being archived.
  constraint workflow_requests_definition_id_fk foreign key ("definition_id")
    references public.workflow_definitions("id") on delete restrict,
  constraint workflow_requests_initiated_by_fk foreign key ("initiated_by")
    references public.users("id") on delete restrict
);

-- One human decision on one request. Append-only — see the trigger below.
create table if not exists public.workflow_actions (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "request_id" uuid not null,
  "step_sequence" integer not null,
  "actor_user_id" uuid not null,
  "on_behalf_of_user_id" uuid,
  "action" "public"."workflow_action" not null,
  "comment" text,
  "acted_at" timestamp with time zone default now() not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "archived_at" timestamp with time zone,
  "archived_by" uuid,
  "archive_reason" varchar(500),
  "created_by" uuid,
  "updated_by" uuid,
  constraint workflow_actions_tenant_id_fk foreign key ("tenant_id")
    references public.organizations("id") on delete restrict,
  constraint workflow_actions_request_id_fk foreign key ("request_id")
    references public.workflow_requests("id") on delete restrict,
  constraint workflow_actions_actor_user_id_fk foreign key ("actor_user_id")
    references public.users("id") on delete restrict,
  constraint workflow_actions_on_behalf_of_user_id_fk foreign key ("on_behalf_of_user_id")
    references public.users("id") on delete restrict
);

-- "While I am on leave, X approves in my place." A delegation substitutes the delegate only
-- within its window and only where the delegator would have been eligible; the service still
-- applies the initiator and four-eyes exclusions to *both* parties.
create table if not exists public.workflow_delegations (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "from_user_id" uuid not null,
  "to_user_id" uuid not null,
  "from_date" date not null,
  "to_date" date not null,
  "reason" varchar(500) not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "archived_at" timestamp with time zone,
  "archived_by" uuid,
  "archive_reason" varchar(500),
  "created_by" uuid,
  "updated_by" uuid,
  constraint workflow_delegations_tenant_id_fk foreign key ("tenant_id")
    references public.organizations("id") on delete restrict,
  constraint workflow_delegations_from_user_id_fk foreign key ("from_user_id")
    references public.users("id") on delete cascade,
  constraint workflow_delegations_to_user_id_fk foreign key ("to_user_id")
    references public.users("id") on delete cascade
);

-- -------------------------------------------------------------------------------------
-- Indexes. Uniqueness is partial on `archived_at is null` so archived rows free their keys.
-- Every foreign key the service filters or joins on gets an index.
-- -------------------------------------------------------------------------------------

create unique index if not exists workflow_definitions_key_version_key
  on public.workflow_definitions using btree ("institution_id", "key", "version")
  where "archived_at" is null;

-- Exactly one active version per key, so starting a workflow by key is never ambiguous.
create unique index if not exists workflow_definitions_active_key
  on public.workflow_definitions using btree ("institution_id", "key")
  where "is_active" and "archived_at" is null;

create index if not exists workflow_definitions_tenant_idx
  on public.workflow_definitions using btree ("tenant_id");
create index if not exists workflow_definitions_entity_idx
  on public.workflow_definitions using btree ("institution_id", "entity_type");

create unique index if not exists workflow_steps_sequence_key
  on public.workflow_steps using btree ("definition_id", "sequence")
  where "archived_at" is null;

create index if not exists workflow_steps_definition_idx
  on public.workflow_steps using btree ("definition_id");
create index if not exists workflow_steps_tenant_idx
  on public.workflow_steps using btree ("tenant_id");

-- One open request per entity: two simultaneous chains over the same expense would produce
-- two contradictory verdicts.
create unique index if not exists workflow_requests_open_entity_key
  on public.workflow_requests using btree ("entity_type", "entity_id")
  where "status" in ('draft', 'pending', 'sent_back', 'escalated') and "archived_at" is null;

create index if not exists workflow_requests_tenant_idx
  on public.workflow_requests using btree ("tenant_id");
create index if not exists workflow_requests_institution_status_idx
  on public.workflow_requests using btree ("institution_id", "status");
create index if not exists workflow_requests_definition_idx
  on public.workflow_requests using btree ("definition_id");
create index if not exists workflow_requests_entity_idx
  on public.workflow_requests using btree ("entity_type", "entity_id");
create index if not exists workflow_requests_initiator_idx
  on public.workflow_requests using btree ("initiated_by");
create index if not exists workflow_requests_campus_idx
  on public.workflow_requests using btree ("campus_id");

-- Serves the overdue report without scanning decided requests.
create index if not exists workflow_requests_due_idx
  on public.workflow_requests using btree ("due_at")
  where "status" in ('pending', 'sent_back', 'escalated');

create index if not exists workflow_actions_tenant_idx
  on public.workflow_actions using btree ("tenant_id");
create index if not exists workflow_actions_request_idx
  on public.workflow_actions using btree ("request_id", "acted_at");
create index if not exists workflow_actions_actor_idx
  on public.workflow_actions using btree ("actor_user_id");
create index if not exists workflow_actions_on_behalf_idx
  on public.workflow_actions using btree ("on_behalf_of_user_id");

create index if not exists workflow_delegations_tenant_idx
  on public.workflow_delegations using btree ("tenant_id");
create index if not exists workflow_delegations_from_idx
  on public.workflow_delegations using btree ("from_user_id", "from_date", "to_date");
create index if not exists workflow_delegations_to_idx
  on public.workflow_delegations using btree ("to_user_id");

-- -------------------------------------------------------------------------------------
-- updated_at triggers. `workflow_actions` deliberately gets none: it is append-only and the
-- reject-mutation trigger below refuses the UPDATE that would fire it.
-- -------------------------------------------------------------------------------------

drop trigger if exists set_updated_at on public.workflow_definitions;
create trigger set_updated_at before update on public.workflow_definitions
  for each row execute function set_updated_at();

drop trigger if exists set_updated_at on public.workflow_steps;
create trigger set_updated_at before update on public.workflow_steps
  for each row execute function set_updated_at();

drop trigger if exists set_updated_at on public.workflow_requests;
create trigger set_updated_at before update on public.workflow_requests
  for each row execute function set_updated_at();

drop trigger if exists set_updated_at on public.workflow_delegations;
create trigger set_updated_at before update on public.workflow_delegations
  for each row execute function set_updated_at();

-- -------------------------------------------------------------------------------------
-- workflow_actions is append-only, the same two ways audit_logs is (0002/0005): the
-- privilege is revoked from the application role, and a trigger refuses the mutation for
-- every role except the migrator (which runs retention and the demo reset).
-- -------------------------------------------------------------------------------------

revoke update, delete on public.workflow_actions from shikkha_app;

create or replace function workflow_actions_reject_mutation() returns trigger
language plpgsql
as $$
begin
  if pg_has_role(current_user, 'shikkha_migrator', 'MEMBER') then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  raise exception 'workflow_actions is append-only; % is not permitted for role %',
    tg_op, current_user
    using errcode = 'insufficient_privilege';
end
$$;

drop trigger if exists workflow_actions_no_mutation on public.workflow_actions;
create trigger workflow_actions_no_mutation
  before update or delete on public.workflow_actions
  for each row execute function workflow_actions_reject_mutation();

-- -------------------------------------------------------------------------------------
-- Data-integrity constraints that belong in the database, not only in Zod. Each is one a
-- violation of which would corrupt an approval record someone later relies on.
-- -------------------------------------------------------------------------------------

alter table public.workflow_definitions
  add constraint workflow_definitions_version_positive check (version >= 1),
  add constraint workflow_definitions_key_shape check (key ~ '^[a-z][a-z0-9_]{1,63}$');

alter table public.workflow_steps
  add constraint workflow_steps_sequence_positive check (sequence >= 1),
  add constraint workflow_steps_sla_positive check (sla_hours is null or sla_hours between 1 and 8760),
  add constraint workflow_steps_permission_present check (
    char_length(btrim(approver_permission)) > 0
  );

alter table public.workflow_requests
  add constraint workflow_requests_step_positive check (current_step_sequence >= 1),
  add constraint workflow_requests_version_positive check (definition_version >= 1),
  add constraint workflow_requests_summary_present check (char_length(btrim(summary)) > 0),
  -- A terminal status without a decision time (or the reverse) is a request whose history
  -- cannot be reconstructed.
  add constraint workflow_requests_decided_recorded check (
    (status in ('approved', 'rejected', 'cancelled')) = (decided_at is not null)
  );

alter table public.workflow_actions
  -- Mirrors reasonSchema: a rejection or send-back with no explanation is not a record of a
  -- decision. Mandatory in SQL so a non-HTTP caller cannot skip it either.
  add constraint workflow_actions_decision_explained check (
    action not in ('reject', 'send_back') or char_length(btrim(coalesce(comment, ''))) >= 10
  ),
  add constraint workflow_actions_comment_present check (
    action <> 'comment' or char_length(btrim(coalesce(comment, ''))) > 0
  ),
  add constraint workflow_actions_step_positive check (step_sequence >= 1),
  -- Acting on your own behalf "on behalf of" yourself would let a delegate loop hide the
  -- real actor.
  add constraint workflow_actions_delegate_distinct check (
    on_behalf_of_user_id is null or on_behalf_of_user_id <> actor_user_id
  );

alter table public.workflow_delegations
  add constraint workflow_delegations_dates_ordered check (to_date >= from_date),
  add constraint workflow_delegations_not_self check (from_user_id <> to_user_id),
  add constraint workflow_delegations_reason_present check (char_length(btrim(reason)) >= 10);

-- -------------------------------------------------------------------------------------
-- Row-level security. Restated per table (0002's loop ran once, over the tables that
-- existed then). `using` gates what SELECT/UPDATE/DELETE can see; `with check` gates what
-- INSERT/UPDATE may write — both halves are required, or cross-tenant writes succeed
-- silently while reads look correct.
-- -------------------------------------------------------------------------------------

alter table public.workflow_definitions enable row level security;
alter table public.workflow_definitions force row level security;
drop policy if exists tenant_isolation on public.workflow_definitions;
create policy tenant_isolation on public.workflow_definitions
  for all
  using (
    app_is_platform_admin()
    or (tenant_id is not null and tenant_id = app_current_tenant_id())
  )
  with check (
    app_is_platform_admin()
    or (tenant_id is not null and tenant_id = app_current_tenant_id())
  );

alter table public.workflow_steps enable row level security;
alter table public.workflow_steps force row level security;
drop policy if exists tenant_isolation on public.workflow_steps;
create policy tenant_isolation on public.workflow_steps
  for all
  using (
    app_is_platform_admin()
    or (tenant_id is not null and tenant_id = app_current_tenant_id())
  )
  with check (
    app_is_platform_admin()
    or (tenant_id is not null and tenant_id = app_current_tenant_id())
  );

alter table public.workflow_requests enable row level security;
alter table public.workflow_requests force row level security;
drop policy if exists tenant_isolation on public.workflow_requests;
create policy tenant_isolation on public.workflow_requests
  for all
  using (
    app_is_platform_admin()
    or (tenant_id is not null and tenant_id = app_current_tenant_id())
  )
  with check (
    app_is_platform_admin()
    or (tenant_id is not null and tenant_id = app_current_tenant_id())
  );

alter table public.workflow_actions enable row level security;
alter table public.workflow_actions force row level security;
drop policy if exists tenant_isolation on public.workflow_actions;
create policy tenant_isolation on public.workflow_actions
  for all
  using (
    app_is_platform_admin()
    or (tenant_id is not null and tenant_id = app_current_tenant_id())
  )
  with check (
    app_is_platform_admin()
    or (tenant_id is not null and tenant_id = app_current_tenant_id())
  );

alter table public.workflow_delegations enable row level security;
alter table public.workflow_delegations force row level security;
drop policy if exists tenant_isolation on public.workflow_delegations;
create policy tenant_isolation on public.workflow_delegations
  for all
  using (
    app_is_platform_admin()
    or (tenant_id is not null and tenant_id = app_current_tenant_id())
  )
  with check (
    app_is_platform_admin()
    or (tenant_id is not null and tenant_id = app_current_tenant_id())
  );

-- -------------------------------------------------------------------------------------
-- System default definitions (docs/08 §3), seeded as DATA for every existing institution —
-- not hard-coded logic. Approvers are permission strings from the catalogue, chosen so the
-- role presets produce the documented chains (Accountant → Principal → Director, etc.); a
-- school edits them like any other definition, which creates version 2 and leaves these
-- rows as the immutable version 1.
--
-- Institutions created after this migration are seeded by tenant provisioning; the service
-- returns a clear 404 ("no active definition") rather than guessing when a key is missing.
-- -------------------------------------------------------------------------------------

do $$
declare
  inst record;
  def_id uuid;
begin
  -- The seed runs inside the migration's own transaction as the migrator; the platform-admin
  -- context satisfies the freshly created policies regardless of role attributes, and being
  -- SET LOCAL it evaporates at commit.
  perform set_config('app.is_platform_admin', 'on', true);

  for inst in
    select id, tenant_id from public.institutions where archived_at is null
  loop
    if not exists (
      select 1 from public.workflow_definitions d
      where d.institution_id = inst.id and d.key = 'expense_approval'
    ) then
      def_id := gen_random_uuid();
      insert into public.workflow_definitions
        (id, tenant_id, institution_id, key, name_en, name_bn, entity_type, version, is_active, is_system, description)
      values
        (def_id, inst.tenant_id, inst.id, 'expense_approval', 'Expense approval',
         'ব্যয় অনুমোদন', 'expense', 1, true, true,
         'Expense → Accountant → Principal → Financial sign-off → Payment');
      insert into public.workflow_steps
        (tenant_id, definition_id, sequence, name_en, approver_permission, approver_scope, is_optional, sla_hours, escalation_permission, on_reject)
      values
        (inst.tenant_id, def_id, 1, 'Accountant review', 'accounting.journal.create', 'institution', false, 48, 'workflows.manage', 'send_back'),
        (inst.tenant_id, def_id, 2, 'Principal approval', 'finance.discounts.approve', 'institution', false, 72, 'workflows.manage', 'previous_step'),
        (inst.tenant_id, def_id, 3, 'Financial sign-off', 'accounting.journal.post', 'institution', false, 72, 'workflows.manage', 'terminate');
    end if;

    if not exists (
      select 1 from public.workflow_definitions d
      where d.institution_id = inst.id and d.key = 'results_approval'
    ) then
      def_id := gen_random_uuid();
      insert into public.workflow_definitions
        (id, tenant_id, institution_id, key, name_en, name_bn, entity_type, version, is_active, is_system, description)
      values
        (def_id, inst.tenant_id, inst.id, 'results_approval', 'Results approval',
         'ফলাফল অনুমোদন', 'exam_result', 1, true, true,
         'Results → Review → Approval → Publication sign-off → Publish');
      insert into public.workflow_steps
        (tenant_id, definition_id, sequence, name_en, approver_permission, approver_scope, is_optional, sla_hours, escalation_permission, on_reject)
      values
        (inst.tenant_id, def_id, 1, 'Marks review', 'results.review', 'institution', false, 72, 'workflows.manage', 'send_back'),
        (inst.tenant_id, def_id, 2, 'Results approval', 'results.approve', 'institution', false, 72, 'workflows.manage', 'previous_step'),
        (inst.tenant_id, def_id, 3, 'Publication sign-off', 'results.publish', 'institution', false, 48, 'workflows.manage', 'previous_step');
    end if;

    if not exists (
      select 1 from public.workflow_definitions d
      where d.institution_id = inst.id and d.key = 'leave_approval'
    ) then
      def_id := gen_random_uuid();
      insert into public.workflow_definitions
        (id, tenant_id, institution_id, key, name_en, name_bn, entity_type, version, is_active, is_system, description)
      values
        (def_id, inst.tenant_id, inst.id, 'leave_approval', 'Leave approval',
         'ছুটি অনুমোদন', 'leave_request', 1, true, true,
         'Leave → Supervisor → HR → Attendance → Payroll');
      insert into public.workflow_steps
        (tenant_id, definition_id, sequence, name_en, approver_permission, approver_scope, is_optional, sla_hours, escalation_permission, on_reject)
      values
        (inst.tenant_id, def_id, 1, 'Supervisor approval', 'leave.requests.approve', 'institution', false, 48, 'workflows.manage', 'terminate'),
        (inst.tenant_id, def_id, 2, 'HR confirmation', 'leave.policies.manage', 'institution', false, 48, 'workflows.manage', 'previous_step');
    end if;

    if not exists (
      select 1 from public.workflow_definitions d
      where d.institution_id = inst.id and d.key = 'admission_approval'
    ) then
      def_id := gen_random_uuid();
      insert into public.workflow_definitions
        (id, tenant_id, institution_id, key, name_en, name_bn, entity_type, version, is_active, is_system, description)
      values
        (def_id, inst.tenant_id, inst.id, 'admission_approval', 'Admission approval',
         'ভর্তি অনুমোদন', 'admission_application', 1, true, true,
         'Admission → Officer → Test → Interview → Merit → Offer');
      insert into public.workflow_steps
        (tenant_id, definition_id, sequence, name_en, approver_permission, approver_scope, is_optional, sla_hours, escalation_permission, on_reject)
      values
        (inst.tenant_id, def_id, 1, 'Application review', 'admissions.applications.review', 'institution', false, 72, 'workflows.manage', 'send_back'),
        (inst.tenant_id, def_id, 2, 'Admission decision', 'admissions.applications.decide', 'institution', false, 72, 'workflows.manage', 'terminate'),
        (inst.tenant_id, def_id, 3, 'Merit and offer sign-off', 'admissions.merit.publish', 'institution', false, 72, 'workflows.manage', 'previous_step');
    end if;
  end loop;
end
$$;

-- -------------------------------------------------------------------------------------
-- Assertions — fail the migration rather than ship a silently disabled control.
-- -------------------------------------------------------------------------------------

do $$
begin
  if has_table_privilege('shikkha_app', 'public.workflow_actions', 'UPDATE')
     or has_table_privilege('shikkha_app', 'public.workflow_actions', 'DELETE') then
    raise exception
      'shikkha_app can modify workflow_actions; the approval history would not be trustworthy';
  end if;
end
$$;

select assert_rls_coverage();
