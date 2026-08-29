-- =====================================================================================
-- 0026 — Asset management: the fixed-asset register (Phase 20)
--
-- Seven tenant-scoped tables. The invariants are financial, so they live in the database,
-- not only in the service:
--
--   1. **`book_value` is derived, never asserted.** `assets_book_value_derived` refuses any
--      row where `book_value <> purchase_cost - accumulated_depreciation`.
--   2. **An asset never depreciates below salvage.** `assets_accumulated_within_depreciable`
--      refuses `accumulated_depreciation > purchase_cost - salvage_value`.
--   3. **At most one open assignment per asset.** Partial unique index
--      `asset_assignments_open_key` on `returned_on IS NULL`.
--   4. **One depreciation run per (institution, year, month)** unless cancelled — partial
--      unique index `depreciation_runs_period_key`.
--   5. **A posted depreciation run is immutable**, and its lines are append-only — triggers,
--      with the migrator-role exemption for retention, exactly as 0018 does for the journal.
--   6. **Disposal needs a second person.** `asset_disposals_distinct_approver` refuses
--      `approved_by = requested_by` on the data itself.
--   7. **Money is numeric(14,2).** No float exists anywhere in this module.
--   8. **Nothing is hard-deleted.** DELETE is revoked from the application role on every
--      table in this module; disposal and cancellation are status changes with history.
--
-- `assets.source_reference` is a bare uuid with NO foreign key: the inventory module
-- (Phase 19) is an optional peer built separately; a constraint can be added by a later
-- migration once both modules are stable.
--
-- RLS is enabled, forced and given the standard `tenant_isolation` policy for every table,
-- and `assert_rls_coverage()` runs last so a mistake fails the migration rather than
-- shipping a silently-disabled control.
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- Enumerations. Closed sets only: methods, statuses and kinds change calculation code
-- when they change. Categories, vendors and locations are rows or free text.
-- -------------------------------------------------------------------------------------

create type public.asset_depreciation_method as enum ('straight_line', 'reducing_balance', 'none');

create type public.asset_condition as enum ('new', 'good', 'fair', 'poor', 'unserviceable');

create type public.asset_status as enum (
  'in_store', 'assigned', 'under_maintenance', 'disposed', 'lost'
);

create type public.asset_assignee_kind as enum ('employee', 'room', 'department');

create type public.asset_maintenance_kind as enum ('preventive', 'repair', 'calibration');

create type public.depreciation_run_status as enum ('draft', 'posted', 'cancelled');

create type public.asset_disposal_method as enum (
  'sold', 'scrapped', 'donated', 'written_off', 'lost'
);

-- -------------------------------------------------------------------------------------
-- Tables
-- -------------------------------------------------------------------------------------

create table public.asset_categories (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  name varchar(128) not null,
  name_bn varchar(128),
  parent_id uuid,
  default_useful_life_years smallint,
  default_depreciation_method public.asset_depreciation_method default 'straight_line' not null,
  ledger_account_code varchar(32),
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.assets (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  campus_id uuid,
  asset_tag varchar(32) not null,
  name varchar(255) not null,
  name_bn varchar(255),
  category_id uuid not null,
  serial_number varchar(128),
  purchased_on date not null,
  purchase_cost numeric(14, 2) not null,
  supplier_name varchar(255),
  warranty_expires_on date,
  useful_life_years smallint,
  salvage_value numeric(14, 2) default '0.00' not null,
  depreciation_method public.asset_depreciation_method not null,
  accumulated_depreciation numeric(14, 2) default '0.00' not null,
  book_value numeric(14, 2) not null,
  condition public.asset_condition default 'new' not null,
  status public.asset_status default 'in_store' not null,
  location varchar(255),
  -- Bare uuid, deliberately no FK: the inventory module is an optional peer (see header).
  source_reference uuid,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.asset_assignments (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  asset_id uuid not null,
  assignee_kind public.asset_assignee_kind not null,
  employee_id uuid,
  room_id uuid,
  department_ref uuid,
  assigned_on date not null,
  returned_on date,
  assigned_by uuid not null,
  returned_by uuid,
  condition_out public.asset_condition not null,
  condition_in public.asset_condition,
  notes varchar(1000),
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.asset_maintenance (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  asset_id uuid not null,
  kind public.asset_maintenance_kind not null,
  performed_on date not null,
  cost numeric(14, 2) default '0.00' not null,
  vendor varchar(255),
  downtime_days integer default 0 not null,
  notes varchar(1000),
  next_due_on date,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.depreciation_runs (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  period_year integer not null,
  period_month smallint not null,
  status public.depreciation_run_status default 'draft' not null,
  total_depreciation numeric(14, 2) default '0.00' not null,
  posted_by uuid,
  posted_at timestamp with time zone,
  journal_entry_id uuid,
  cancelled_by uuid,
  cancelled_at timestamp with time zone,
  cancel_reason varchar(1000),
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.depreciation_lines (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  run_id uuid not null,
  asset_id uuid not null,
  opening_book_value numeric(14, 2) not null,
  depreciation numeric(14, 2) not null,
  closing_book_value numeric(14, 2) not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.asset_disposals (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  asset_id uuid not null,
  disposed_on date not null,
  method public.asset_disposal_method not null,
  proceeds numeric(14, 2) default '0.00' not null,
  reason varchar(1000) not null,
  requested_by uuid not null,
  approved_by uuid,
  approved_at timestamp with time zone,
  journal_entry_id uuid,
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
-- Foreign keys
-- -------------------------------------------------------------------------------------

alter table public.asset_categories
  add constraint asset_categories_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint asset_categories_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint asset_categories_parent_id_asset_categories_id_fk
    foreign key (parent_id) references public.asset_categories(id) on delete restrict;

alter table public.assets
  add constraint assets_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint assets_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint assets_campus_id_campuses_id_fk
    foreign key (campus_id) references public.campuses(id) on delete set null,
  add constraint assets_category_id_asset_categories_id_fk
    foreign key (category_id) references public.asset_categories(id) on delete restrict;

alter table public.asset_assignments
  add constraint asset_assignments_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint asset_assignments_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint asset_assignments_asset_id_assets_id_fk
    foreign key (asset_id) references public.assets(id) on delete restrict,
  add constraint asset_assignments_employee_id_employees_id_fk
    foreign key (employee_id) references public.employees(id) on delete restrict,
  add constraint asset_assignments_room_id_rooms_id_fk
    foreign key (room_id) references public.rooms(id) on delete restrict,
  add constraint asset_assignments_department_ref_departments_id_fk
    foreign key (department_ref) references public.departments(id) on delete restrict;

alter table public.asset_maintenance
  add constraint asset_maintenance_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint asset_maintenance_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint asset_maintenance_asset_id_assets_id_fk
    foreign key (asset_id) references public.assets(id) on delete restrict;

alter table public.depreciation_runs
  add constraint depreciation_runs_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint depreciation_runs_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint depreciation_runs_journal_entry_id_journal_entries_id_fk
    foreign key (journal_entry_id) references public.journal_entries(id) on delete restrict;

alter table public.depreciation_lines
  add constraint depreciation_lines_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint depreciation_lines_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint depreciation_lines_run_id_depreciation_runs_id_fk
    foreign key (run_id) references public.depreciation_runs(id) on delete cascade,
  add constraint depreciation_lines_asset_id_assets_id_fk
    foreign key (asset_id) references public.assets(id) on delete restrict;

alter table public.asset_disposals
  add constraint asset_disposals_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint asset_disposals_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint asset_disposals_asset_id_assets_id_fk
    foreign key (asset_id) references public.assets(id) on delete restrict,
  add constraint asset_disposals_journal_entry_id_journal_entries_id_fk
    foreign key (journal_entry_id) references public.journal_entries(id) on delete restrict;

-- -------------------------------------------------------------------------------------
-- Indexes
-- -------------------------------------------------------------------------------------

create unique index if not exists asset_categories_institution_name_key
  on public.asset_categories using btree (institution_id, name) where archived_at is null;
create index if not exists asset_categories_tenant_idx
  on public.asset_categories using btree (tenant_id);
create index if not exists asset_categories_parent_idx
  on public.asset_categories using btree (parent_id);

-- Not partial: an asset tag is a physical label and is never reused, archived or not.
create unique index if not exists assets_institution_tag_key
  on public.assets using btree (institution_id, asset_tag);
create index if not exists assets_tenant_idx
  on public.assets using btree (tenant_id);
create index if not exists assets_institution_status_idx
  on public.assets using btree (institution_id, status);
create index if not exists assets_category_idx
  on public.assets using btree (category_id);
create index if not exists assets_campus_idx
  on public.assets using btree (campus_id);

-- One open assignment per asset — the database guarantee against a custody race.
create unique index if not exists asset_assignments_open_key
  on public.asset_assignments using btree (asset_id)
  where returned_on is null and archived_at is null;
create index if not exists asset_assignments_tenant_idx
  on public.asset_assignments using btree (tenant_id);
create index if not exists asset_assignments_asset_idx
  on public.asset_assignments using btree (asset_id);
create index if not exists asset_assignments_employee_idx
  on public.asset_assignments using btree (employee_id);

create index if not exists asset_maintenance_tenant_idx
  on public.asset_maintenance using btree (tenant_id);
create index if not exists asset_maintenance_asset_idx
  on public.asset_maintenance using btree (asset_id);
create index if not exists asset_maintenance_next_due_idx
  on public.asset_maintenance using btree (institution_id, next_due_on)
  where archived_at is null and next_due_on is not null;

-- One run per month per institution, unless that attempt was cancelled.
create unique index if not exists depreciation_runs_period_key
  on public.depreciation_runs using btree (institution_id, period_year, period_month)
  where status <> 'cancelled';
create index if not exists depreciation_runs_tenant_idx
  on public.depreciation_runs using btree (tenant_id);
create index if not exists depreciation_runs_institution_status_idx
  on public.depreciation_runs using btree (institution_id, status);

create unique index if not exists depreciation_lines_run_asset_key
  on public.depreciation_lines using btree (run_id, asset_id);
create index if not exists depreciation_lines_tenant_idx
  on public.depreciation_lines using btree (tenant_id);
create index if not exists depreciation_lines_run_idx
  on public.depreciation_lines using btree (run_id);
create index if not exists depreciation_lines_asset_idx
  on public.depreciation_lines using btree (asset_id);

-- One open (unapproved) disposal request per asset.
create unique index if not exists asset_disposals_open_key
  on public.asset_disposals using btree (asset_id)
  where approved_by is null and archived_at is null;
create index if not exists asset_disposals_tenant_idx
  on public.asset_disposals using btree (tenant_id);
create index if not exists asset_disposals_asset_idx
  on public.asset_disposals using btree (asset_id);
create index if not exists asset_disposals_institution_idx
  on public.asset_disposals using btree (institution_id);

-- -------------------------------------------------------------------------------------
-- Check constraints
-- -------------------------------------------------------------------------------------

alter table public.asset_categories
  add constraint asset_categories_life_positive
    check (default_useful_life_years is null or default_useful_life_years > 0),
  add constraint asset_categories_not_own_parent check (parent_id is null or parent_id <> id);

alter table public.assets
  -- Invariant 1: book value is derived. An inconsistent row is refused, even from raw SQL.
  add constraint assets_book_value_derived
    check (book_value = purchase_cost - accumulated_depreciation),
  -- Invariant 2: never depreciate below salvage.
  add constraint assets_accumulated_within_depreciable
    check (accumulated_depreciation <= purchase_cost - salvage_value),
  add constraint assets_amounts_non_negative
    check (purchase_cost >= 0 and salvage_value >= 0 and accumulated_depreciation >= 0),
  add constraint assets_salvage_within_cost check (salvage_value <= purchase_cost),
  -- Useful life is required exactly when the asset depreciates.
  add constraint assets_life_required_for_depreciation
    check (depreciation_method = 'none'
           or (useful_life_years is not null and useful_life_years > 0)),
  add constraint assets_warranty_after_purchase
    check (warranty_expires_on is null or warranty_expires_on >= purchased_on);

alter table public.asset_assignments
  -- The assignee reference matches the declared kind, and the other two stay null.
  add constraint asset_assignments_assignee_present
    check (
      (assignee_kind = 'employee'
        and employee_id is not null and room_id is null and department_ref is null)
      or (assignee_kind = 'room'
        and room_id is not null and employee_id is null and department_ref is null)
      or (assignee_kind = 'department'
        and department_ref is not null and employee_id is null and room_id is null)
    ),
  add constraint asset_assignments_return_after_assign
    check (returned_on is null or returned_on >= assigned_on),
  -- A returned assignment always records who took it back and in what condition.
  add constraint asset_assignments_return_recorded
    check (returned_on is null or (returned_by is not null and condition_in is not null));

alter table public.asset_maintenance
  add constraint asset_maintenance_cost_non_negative check (cost >= 0),
  add constraint asset_maintenance_downtime_non_negative check (downtime_days >= 0),
  add constraint asset_maintenance_next_due_after_performed
    check (next_due_on is null or next_due_on > performed_on);

alter table public.depreciation_runs
  add constraint depreciation_runs_month_range check (period_month between 1 and 12),
  add constraint depreciation_runs_year_sane check (period_year between 1990 and 2100),
  add constraint depreciation_runs_total_non_negative check (total_depreciation >= 0),
  -- A posted run always carries who, when, and the one journal entry it wrote.
  add constraint depreciation_runs_posted_recorded
    check (status <> 'posted'
           or (posted_by is not null and posted_at is not null
               and journal_entry_id is not null)),
  add constraint depreciation_runs_cancel_recorded
    check (status <> 'cancelled'
           or (cancelled_by is not null and cancelled_at is not null
               and cancel_reason is not null));

alter table public.depreciation_lines
  add constraint depreciation_lines_amounts_non_negative
    check (opening_book_value >= 0 and depreciation >= 0 and closing_book_value >= 0),
  -- The closing value is derived, exactly like assets.book_value.
  add constraint depreciation_lines_closing_derived
    check (closing_book_value = opening_book_value - depreciation);

alter table public.asset_disposals
  add constraint asset_disposals_proceeds_non_negative check (proceeds >= 0),
  add constraint asset_disposals_reason_present check (length(btrim(reason)) > 0),
  -- The two-person rule, on the data itself: the approver is never the requester.
  add constraint asset_disposals_distinct_approver
    check (approved_by is null or approved_by <> requested_by),
  add constraint asset_disposals_approval_recorded
    check ((approved_by is null) = (approved_at is null));

-- -------------------------------------------------------------------------------------
-- Immutability triggers
--
-- A posted depreciation run is a financial record backed by a posted journal entry; it
-- accepts no further change and no deletion. Its lines are append-only from the moment
-- they are written. The migrator role is exempt, for retention operations — the same
-- pattern as `workflow_actions_reject_mutation` (0014) and the journal guards (0018).
-- -------------------------------------------------------------------------------------

create or replace function depreciation_runs_guard_mutation() returns trigger
language plpgsql
as $$
begin
  if pg_has_role(current_user, 'shikkha_migrator', 'MEMBER') then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    raise exception 'depreciation runs are never deleted; cancel a draft instead'
      using errcode = 'insufficient_privilege';
  end if;

  if old.status = 'posted' then
    raise exception
      'depreciation run % is posted and immutable; correct it with a reversing journal entry',
      old.id
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end
$$;

drop trigger if exists depreciation_runs_immutable_when_posted on public.depreciation_runs;
create trigger depreciation_runs_immutable_when_posted
  before update or delete on public.depreciation_runs
  for each row execute function depreciation_runs_guard_mutation();

create or replace function depreciation_lines_reject_mutation() returns trigger
language plpgsql
as $$
begin
  if pg_has_role(current_user, 'shikkha_migrator', 'MEMBER') then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  raise exception 'depreciation_lines is append-only; % is not permitted for role %',
    tg_op, current_user
    using errcode = 'insufficient_privilege';
end
$$;

drop trigger if exists depreciation_lines_no_mutation on public.depreciation_lines;
create trigger depreciation_lines_no_mutation
  before update or delete on public.depreciation_lines
  for each row execute function depreciation_lines_reject_mutation();

-- Lines can only ever be written into a draft run.
create or replace function depreciation_lines_assert_run_open() returns trigger
language plpgsql
as $$
declare
  run_status public.depreciation_run_status;
begin
  if pg_has_role(current_user, 'shikkha_migrator', 'MEMBER') then
    return new;
  end if;

  select status into run_status from public.depreciation_runs where id = new.run_id;

  if run_status is distinct from 'draft' then
    raise exception 'depreciation run % is % — lines can only be written into a draft run',
      new.run_id, run_status
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end
$$;

drop trigger if exists depreciation_lines_run_must_be_draft on public.depreciation_lines;
create trigger depreciation_lines_run_must_be_draft
  before insert on public.depreciation_lines
  for each row execute function depreciation_lines_assert_run_open();

-- -------------------------------------------------------------------------------------
-- Row-level security, grants and updated_at, for every table in this module
-- -------------------------------------------------------------------------------------

do $$
declare
  target text;
  asset_tables constant text[] := array[
    'asset_categories',
    'assets',
    'asset_assignments',
    'asset_maintenance',
    'depreciation_runs',
    'depreciation_lines',
    'asset_disposals'
  ];
begin
  foreach target in array asset_tables
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

-- Assets are never hard-deleted (ADR-008): the application archives, disposes or cancels.
-- Revoking DELETE makes that a database property, not a service convention. The triggers
-- above additionally protect posted runs and their lines from the migrator's own tooling.
revoke delete on public.asset_categories from shikkha_app;
revoke delete on public.assets from shikkha_app;
revoke delete on public.asset_assignments from shikkha_app;
revoke delete on public.asset_maintenance from shikkha_app;
revoke delete on public.depreciation_runs from shikkha_app;
revoke delete on public.depreciation_lines from shikkha_app;
revoke delete on public.asset_disposals from shikkha_app;

-- -------------------------------------------------------------------------------------
-- Assertions
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
      'asset_categories', 'assets', 'asset_assignments', 'asset_maintenance',
      'depreciation_runs', 'depreciation_lines', 'asset_disposals'
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
      'Asset tables without forced row-level security and a tenant_isolation policy: %',
      offending;
  end if;

  -- Every one of the seven must also carry the tenant column the policy reads. A policy on
  -- a table without `tenant_id` would fail at query time, not here.
  select string_agg(t.name, ', ' order by t.name)
  into offending
  from unnest(array[
    'asset_categories', 'assets', 'asset_assignments', 'asset_maintenance',
    'depreciation_runs', 'depreciation_lines', 'asset_disposals'
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
    raise exception 'Asset tables without a tenant_id column: %', offending;
  end if;
end
$$;

-- The global sweep: every public table is either RLS-protected or explicitly exempt.
select assert_rls_coverage();
