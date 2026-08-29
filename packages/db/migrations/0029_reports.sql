-- =====================================================================================
-- 0029 — Reporting: a generic query surface over entities that already exist (Phase 24)
--
-- Five tenant-scoped tables. This is the module with the largest blast radius in the
-- product, because it is the one that turns user input into a query, so the shape of these
-- tables is chosen to make the dangerous thing impossible rather than merely discouraged:
--
--   * **Nothing here stores SQL.** `source_key` names a `ReportSource` in the application's
--     registry, and `columns` / `filters` / `grouping` / `sorting` are jsonb documents of
--     *keys* that must appear in that source's allow-lists. A key outside the allow-list is
--     a 422 and never reaches a query. Registering a new source needs no migration.
--   * **A run is either a saved definition or the one-off document that produced it, never
--     both and never neither** — `report_runs_definition_xor_ad_hoc`. "What exactly did this
--     export contain?" is therefore always answerable from the row.
--   * **A settled run is immutable and an export is append-only.** Triggers, not
--     conventions, with the same migrator exemption `audit_logs` (0005) and `journal_lines`
--     (0018) carry so retention and demo resets still work.
--   * **An export's expiry is strictly after its creation** — `report_exports_expiry_after_creation`.
--     Backdating an expiry to resurrect a download is refused by the database.
--
-- RLS is enabled, forced and given the standard `tenant_isolation` policy for every table,
-- and `assert_rls_coverage()` runs last so a mistake fails the migration rather than
-- shipping a silently-disabled control.
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- Enumerations. Closed sets only: a new visibility mode changes the authorization code and
-- a new export format changes the serialiser. The reports a school invents are rows.
-- -------------------------------------------------------------------------------------

create type public.report_visibility as enum ('private', 'role', 'institution');

create type public.report_definition_status as enum ('draft', 'published', 'archived');

create type public.report_run_status as enum ('running', 'succeeded', 'failed');

create type public.report_export_format as enum ('csv', 'json');

-- -------------------------------------------------------------------------------------
-- Tables
-- -------------------------------------------------------------------------------------

create table public.report_definitions (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  key varchar(64) not null,
  name varchar(128) not null,
  name_bn varchar(128),
  source_key varchar(64) not null,
  columns jsonb default '[]'::jsonb not null,
  filters jsonb default '[]'::jsonb not null,
  grouping jsonb,
  sorting jsonb default '[]'::jsonb not null,
  is_system boolean default false not null,
  visibility public.report_visibility default 'private' not null,
  status public.report_definition_status default 'draft' not null,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.report_shares (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  definition_id uuid not null,
  role_id uuid,
  user_id uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.report_runs (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  definition_id uuid,
  ad_hoc_definition jsonb,
  run_by uuid not null,
  started_at timestamp with time zone default now() not null,
  finished_at timestamp with time zone,
  row_count integer,
  duration_ms integer,
  status public.report_run_status default 'running' not null,
  error varchar(1000),
  parameters jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.report_exports (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  run_id uuid not null,
  format public.report_export_format not null,
  storage_key varchar(512) not null,
  size_bytes integer not null,
  row_count integer not null,
  expires_at timestamp with time zone not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.report_schedules (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  definition_id uuid not null,
  cron_expression varchar(120) not null,
  timezone varchar(64) default 'Asia/Dhaka' not null,
  recipients jsonb default '[]'::jsonb not null,
  format public.report_export_format default 'csv' not null,
  is_active boolean default true not null,
  last_run_at timestamp with time zone,
  next_run_at timestamp with time zone,
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
-- Foreign keys. `on delete restrict` everywhere a record must survive; `cascade` only from
-- a definition to the shares that decorate it, which have no meaning without it.
-- -------------------------------------------------------------------------------------

alter table public.report_definitions
  add constraint report_definitions_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint report_definitions_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict;

alter table public.report_shares
  add constraint report_shares_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint report_shares_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint report_shares_definition_id_report_definitions_id_fk
    foreign key (definition_id) references public.report_definitions(id) on delete cascade,
  add constraint report_shares_role_id_roles_id_fk
    foreign key (role_id) references public.roles(id) on delete cascade,
  add constraint report_shares_user_id_users_id_fk
    foreign key (user_id) references public.users(id) on delete cascade;

alter table public.report_runs
  add constraint report_runs_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint report_runs_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint report_runs_definition_id_report_definitions_id_fk
    foreign key (definition_id) references public.report_definitions(id) on delete restrict,
  add constraint report_runs_run_by_users_id_fk
    foreign key (run_by) references public.users(id) on delete restrict;

alter table public.report_exports
  add constraint report_exports_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint report_exports_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint report_exports_run_id_report_runs_id_fk
    foreign key (run_id) references public.report_runs(id) on delete restrict;

alter table public.report_schedules
  add constraint report_schedules_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint report_schedules_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint report_schedules_definition_id_report_definitions_id_fk
    foreign key (definition_id) references public.report_definitions(id) on delete restrict;

-- -------------------------------------------------------------------------------------
-- Indexes. Partial unique keys on `archived_at is null` free a key for reuse while
-- preserving the record (ADR-008). A storage key is globally unique, archived or not: it
-- names a file, and two rows naming one file is a deletion bug waiting to happen.
-- -------------------------------------------------------------------------------------

create unique index if not exists report_definitions_institution_key_key
  on public.report_definitions using btree (institution_id, key) where archived_at is null;
create index if not exists report_definitions_tenant_idx
  on public.report_definitions using btree (tenant_id);
create index if not exists report_definitions_institution_source_idx
  on public.report_definitions using btree (institution_id, source_key);
create index if not exists report_definitions_author_idx
  on public.report_definitions using btree (created_by);
create index if not exists report_definitions_visibility_idx
  on public.report_definitions using btree (institution_id, visibility);

create unique index if not exists report_shares_definition_role_key
  on public.report_shares using btree (definition_id, role_id)
  where role_id is not null and archived_at is null;
create unique index if not exists report_shares_definition_user_key
  on public.report_shares using btree (definition_id, user_id)
  where user_id is not null and archived_at is null;
create index if not exists report_shares_tenant_idx
  on public.report_shares using btree (tenant_id);
create index if not exists report_shares_definition_idx
  on public.report_shares using btree (definition_id);
create index if not exists report_shares_user_idx on public.report_shares using btree (user_id);
create index if not exists report_shares_role_idx on public.report_shares using btree (role_id);

create index if not exists report_runs_tenant_idx on public.report_runs using btree (tenant_id);
create index if not exists report_runs_definition_idx
  on public.report_runs using btree (definition_id, started_at);
create index if not exists report_runs_actor_idx
  on public.report_runs using btree (run_by, started_at);
create index if not exists report_runs_institution_status_idx
  on public.report_runs using btree (institution_id, status);

create unique index if not exists report_exports_storage_key_key
  on public.report_exports using btree (storage_key);
create index if not exists report_exports_tenant_idx
  on public.report_exports using btree (tenant_id);
create index if not exists report_exports_run_idx on public.report_exports using btree (run_id);
create index if not exists report_exports_expiry_idx
  on public.report_exports using btree (institution_id, expires_at);

create unique index if not exists report_schedules_definition_cron_key
  on public.report_schedules using btree (definition_id, cron_expression)
  where archived_at is null;
create index if not exists report_schedules_tenant_idx
  on public.report_schedules using btree (tenant_id);
create index if not exists report_schedules_due_idx
  on public.report_schedules using btree (is_active, next_run_at);
create index if not exists report_schedules_institution_idx
  on public.report_schedules using btree (institution_id);

-- -------------------------------------------------------------------------------------
-- Check constraints. The invariants that make a disclosure record trustworthy, restated
-- where a bug in the service cannot argue with them.
-- -------------------------------------------------------------------------------------

alter table public.report_definitions
  -- The four documents are arrays / objects, never scalars: a jsonb column will happily
  -- accept `"drop table students"` as a valid JSON string otherwise.
  add constraint report_definitions_columns_is_array
    check (jsonb_typeof(columns) = 'array'),
  add constraint report_definitions_filters_is_array
    check (jsonb_typeof(filters) = 'array'),
  add constraint report_definitions_sorting_is_array
    check (jsonb_typeof(sorting) = 'array'),
  add constraint report_definitions_grouping_is_object
    check (grouping is null or jsonb_typeof(grouping) = 'object'),
  add constraint report_definitions_key_shape
    check (key ~ '^[a-z][a-z0-9_-]{0,63}$'),
  add constraint report_definitions_source_key_shape
    check (source_key ~ '^[a-z][a-z0-9_]{0,63}$');

alter table public.report_shares
  -- A share names a role or a user. Both would be ambiguous; neither would be a grant to
  -- nobody that still reads as a grant.
  add constraint report_shares_role_xor_user
    check ((role_id is null) <> (user_id is null));

alter table public.report_runs
  add constraint report_runs_definition_xor_ad_hoc
    check ((definition_id is null) <> (ad_hoc_definition is null)),
  -- A settled run always records when it settled.
  add constraint report_runs_finished_recorded
    check (status = 'running' or finished_at is not null),
  -- A failure without a reason is not a record of anything.
  add constraint report_runs_error_recorded
    check (status <> 'failed' or error is not null),
  -- A successful run always states how much data it disclosed.
  add constraint report_runs_success_counted
    check (status <> 'succeeded' or row_count is not null),
  add constraint report_runs_row_count_non_negative
    check (row_count is null or row_count >= 0),
  add constraint report_runs_duration_non_negative
    check (duration_ms is null or duration_ms >= 0),
  add constraint report_runs_parameters_is_object
    check (jsonb_typeof(parameters) = 'object');

alter table public.report_exports
  add constraint report_exports_size_non_negative check (size_bytes >= 0),
  add constraint report_exports_row_count_non_negative check (row_count >= 0),
  -- An expiry at or before creation would be a download that was never valid, which is a
  -- more suspicious thing to find in the table than an honest one that lapsed.
  add constraint report_exports_expiry_after_creation check (expires_at > created_at);

alter table public.report_schedules
  add constraint report_schedules_recipients_is_array
    check (jsonb_typeof(recipients) = 'array'),
  -- Five whitespace-separated fields. The application parses the expression properly; this
  -- refuses the shapes that are not even worth parsing.
  add constraint report_schedules_cron_shape
    check (cron_expression ~ '^[0-9*,/-]+( +[0-9*,/-]+){4}$'),
  -- Only the zone the platform actually serves, because `next_run_at` is computed with the
  -- fixed +06:00 offset. Storing a zone the scheduler cannot compute would be worse than
  -- refusing it.
  add constraint report_schedules_timezone_supported check (timezone = 'Asia/Dhaka');

-- -------------------------------------------------------------------------------------
-- Trigger: a settled run is immutable.
--
-- A run row is the evidence that a bulk disclosure happened. Once it has settled — a row
-- count, a duration, a status — rewriting it would rewrite the trail. The only legal
-- transition is `running` → `succeeded` / `failed`, which the service performs once.
-- -------------------------------------------------------------------------------------

create or replace function report_runs_guard_transition() returns trigger
language plpgsql
as $$
begin
  if pg_has_role(current_user, 'shikkha_migrator', 'MEMBER') then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    raise exception 'report runs are never deleted; they are the record that data left the building'
      using errcode = 'insufficient_privilege';
  end if;

  if old.status <> 'running' then
    raise exception 'report run % has already settled as % and cannot be changed', old.id, old.status
      using errcode = 'insufficient_privilege';
  end if;

  if new.status = 'running' and new.finished_at is null then
    return new;
  end if;

  -- Settling is the one permitted update, and it may not rewrite what was asked for or who
  -- asked. Otherwise "the run recorded 12 rows" could be revised after the fact.
  if new.definition_id is distinct from old.definition_id
     or new.ad_hoc_definition is distinct from old.ad_hoc_definition
     or new.run_by is distinct from old.run_by
     or new.started_at is distinct from old.started_at
     or new.tenant_id is distinct from old.tenant_id
     or new.institution_id is distinct from old.institution_id then
    raise exception 'a report run''s subject, actor and start time are fixed once it is created'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end
$$;

create trigger report_runs_settled_once
  before update or delete on public.report_runs
  for each row execute function report_runs_guard_transition();

-- -------------------------------------------------------------------------------------
-- Trigger: an export row is append-only.
--
-- The file behind it expires and may be swept from storage, but the record that it existed
-- — who, what, how many rows, how big — never does. Same shape and same migrator exemption
-- as the audit log (0005) and posted journal lines (0018).
-- -------------------------------------------------------------------------------------

create or replace function report_exports_guard_mutation() returns trigger
language plpgsql
as $$
begin
  if pg_has_role(current_user, 'shikkha_migrator', 'MEMBER') then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    raise exception 'report exports are never deleted; a bulk data export is a permanent record'
      using errcode = 'insufficient_privilege';
  end if;

  raise exception 'report exports are immutable; produce a new export instead of editing one'
    using errcode = 'insufficient_privilege';
end
$$;

create trigger report_exports_immutable
  before update or delete on public.report_exports
  for each row execute function report_exports_guard_mutation();

-- -------------------------------------------------------------------------------------
-- Trigger: a share, a run and a schedule stay inside their definition's institution.
--
-- Row-level security already stops a cross-*tenant* reference. This closes the smaller gap
-- inside one tenant: a group running three schools must not be able to point School A's
-- schedule at School B's definition and export B's data under A's scope.
-- -------------------------------------------------------------------------------------

create or replace function report_assert_definition_institution() returns trigger
language plpgsql
as $$
declare
  owner_institution uuid;
  owner_tenant uuid;
begin
  select d.institution_id, d.tenant_id
    into owner_institution, owner_tenant
    from public.report_definitions d
   where d.id = new.definition_id;

  if owner_institution is null then
    raise exception 'report definition % was not found', new.definition_id
      using errcode = 'foreign_key_violation';
  end if;

  if owner_institution <> new.institution_id or owner_tenant <> new.tenant_id then
    raise exception 'report definition % belongs to a different institution', new.definition_id
      using errcode = 'check_violation',
            constraint = 'report_definition_institution_match';
  end if;

  return new;
end
$$;

create trigger report_shares_definition_institution
  before insert or update on public.report_shares
  for each row execute function report_assert_definition_institution();

create trigger report_schedules_definition_institution
  before insert or update on public.report_schedules
  for each row execute function report_assert_definition_institution();

-- The run table's definition_id is nullable (ad-hoc runs), so it needs its own wrapper
-- rather than the shared function.
create or replace function report_runs_assert_definition_institution() returns trigger
language plpgsql
as $$
declare
  owner_institution uuid;
  owner_tenant uuid;
begin
  if new.definition_id is null then
    return new;
  end if;

  select d.institution_id, d.tenant_id
    into owner_institution, owner_tenant
    from public.report_definitions d
   where d.id = new.definition_id;

  if owner_institution is null then
    raise exception 'report definition % was not found', new.definition_id
      using errcode = 'foreign_key_violation';
  end if;

  if owner_institution <> new.institution_id or owner_tenant <> new.tenant_id then
    raise exception 'report definition % belongs to a different institution', new.definition_id
      using errcode = 'check_violation',
            constraint = 'report_definition_institution_match';
  end if;

  return new;
end
$$;

create trigger report_runs_definition_institution
  before insert on public.report_runs
  for each row execute function report_runs_assert_definition_institution();

-- The export's institution must match its run's, for the same reason.
create or replace function report_exports_assert_run_institution() returns trigger
language plpgsql
as $$
declare
  owner_institution uuid;
  owner_tenant uuid;
  owner_status public.report_run_status;
begin
  select r.institution_id, r.tenant_id, r.status
    into owner_institution, owner_tenant, owner_status
    from public.report_runs r
   where r.id = new.run_id;

  if owner_institution is null then
    raise exception 'report run % was not found', new.run_id
      using errcode = 'foreign_key_violation';
  end if;

  if owner_institution <> new.institution_id or owner_tenant <> new.tenant_id then
    raise exception 'report run % belongs to a different institution', new.run_id
      using errcode = 'check_violation',
            constraint = 'report_export_run_institution_match';
  end if;

  -- Exporting a run that never succeeded would produce a file with no provenance.
  if owner_status <> 'succeeded' then
    raise exception 'report run % has not succeeded and cannot be exported', new.run_id
      using errcode = 'check_violation',
            constraint = 'report_export_run_succeeded';
  end if;

  return new;
end
$$;

create trigger report_exports_run_institution
  before insert on public.report_exports
  for each row execute function report_exports_assert_run_institution();

-- -------------------------------------------------------------------------------------
-- Row-level security: enable + force + the standard tenant_isolation policy + grants +
-- updated_at trigger, per table. The catalogue loop in 0002 does not re-run for tables
-- created later, so it is restated here.
-- -------------------------------------------------------------------------------------

do $$
declare
  target text;
  report_tables constant text[] := array[
    'report_definitions',
    'report_shares',
    'report_runs',
    'report_exports',
    'report_schedules'
  ];
begin
  foreach target in array report_tables
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
-- Assertions — fail the migration rather than ship a silently-disabled control.
-- -------------------------------------------------------------------------------------

do $$
declare
  offending text;
begin
  select string_agg(c.relname, ', ' order by c.relname)
  into offending
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relname = any (array[
      'report_definitions', 'report_shares', 'report_runs', 'report_exports',
      'report_schedules'
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
      'Reporting tables without forced row-level security and a tenant_isolation policy: %',
      offending;
  end if;

  select string_agg(t.name, ', ' order by t.name)
  into offending
  from unnest(array[
    'report_definitions', 'report_shares', 'report_runs', 'report_exports', 'report_schedules'
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
    raise exception 'Reporting tables without a tenant_id column: %', offending;
  end if;
end
$$;

-- The global sweep: every public table is either RLS-protected or explicitly exempt.
select assert_rls_coverage();
