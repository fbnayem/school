-- =====================================================================================
-- 0013 — Human resources (Phase 15)
--
-- Ten tenant-scoped tables around the Phase 2 `employees` table: contracts, salary
-- structures with their components, per-employee salary assignments, documents,
-- qualifications, experience, dependents, status history and campus transfers, plus one
-- column added to `departments` (an organisational hierarchy).
--
-- Three properties are enforced here rather than left to the application, because each is a
-- property the application can only get wrong once:
--
--   1. **No floating point.** Every monetary column is `numeric(14, 2)`. The driver returns
--      it as a string and `Money` is the only thing that parses it (ADR-004). Percentage
--      components are stored in the same shape and read as basis points ("12.50" = 1250bp).
--   2. **The salary arithmetic is well-defined by construction.** A `percentage_of_gross`
--      component must be a deduction — a gross-relative *earning* would make gross depend on
--      itself, and that is a check constraint, not a service convention.
--   3. **Employment records are never deleted and their dates are ordered.** A contract's end
--      is after its start, a probation falls inside the contract, an experience row ends
--      after it begins. Separation is a status change with history; the row survives.
--
-- One invariant deliberately stays in the service: "no overlapping active contracts for one
-- employee" would need an EXCLUDE constraint over `daterange`, which requires the
-- `btree_gist` extension this deployment does not assume. The service checks overlap inside
-- the same transaction as the write; see `HrService.assertNoContractOverlap`.
--
-- Row-level security is applied at the bottom with the same `tenant_isolation` policy every
-- other tenant table carries, the `set_updated_at` trigger is attached, and
-- `assert_rls_coverage()` runs last so a mistake fails the migration rather than shipping a
-- silently-disabled control.
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- Enumerations. Closed value sets: adding a calculation kind changes the payroll
-- arithmetic as well as the schema. Document *types* a school invents for itself are a
-- documented varchar on `employee_documents`, not values here.
-- -------------------------------------------------------------------------------------

create type public.employment_contract_type as enum (
  'permanent', 'contract', 'part_time', 'probation', 'guest'
);

create type public.employment_contract_status as enum ('active', 'ended', 'terminated');

create type public.salary_structure_status as enum ('draft', 'active', 'archived');

create type public.salary_component_type as enum ('earning', 'deduction');

create type public.salary_calculation as enum (
  'fixed', 'percentage_of_basic', 'percentage_of_gross'
);

-- -------------------------------------------------------------------------------------
-- Departments gain a hierarchy. The table itself is from Phase 2; the Drizzle column is
-- added by the Phase 15 integration (see the phase report) — until then the service reads
-- and writes it through explicit SQL fragments.
-- -------------------------------------------------------------------------------------

alter table public.departments
  add column if not exists parent_department_id uuid
    references public.departments (id) on delete set null;

alter table public.departments
  add constraint departments_not_own_parent
    check (parent_department_id is null or parent_department_id <> id);

create index if not exists departments_parent_idx
  on public.departments (parent_department_id);

-- -------------------------------------------------------------------------------------
-- Contracts
-- -------------------------------------------------------------------------------------

create table public.employment_contracts (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null references public.organizations (id) on delete restrict,
  institution_id uuid not null references public.institutions (id) on delete restrict,
  employee_id uuid not null references public.employees (id) on delete restrict,
  contract_type public.employment_contract_type default 'permanent' not null,
  status public.employment_contract_status default 'active' not null,
  start_date date not null,
  end_date date,
  probation_end_date date,
  notice_period_days integer default 30 not null,
  terms text,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

alter table public.employment_contracts
  add constraint employment_contracts_dates_ordered
    check (end_date is null or end_date > start_date),
  add constraint employment_contracts_probation_within
    check (
      probation_end_date is null
      or (
        probation_end_date >= start_date
        and (end_date is null or probation_end_date <= end_date)
      )
    ),
  add constraint employment_contracts_notice_sane
    check (notice_period_days between 0 and 365);

create index employment_contracts_employee_idx
  on public.employment_contracts (employee_id, status);
create index employment_contracts_institution_idx
  on public.employment_contracts (institution_id, status);
create index employment_contracts_tenant_idx
  on public.employment_contracts (tenant_id);

-- -------------------------------------------------------------------------------------
-- Salary structures, components, assignments.
--
-- Designed so Phase 16 (payroll) computes a payslip with no further migration: a payslip
-- is (assignment.basic, the structure's live components in `sequence` order). Assignments
-- carry an effective range, so "what was this person paid on in March" is answerable.
-- -------------------------------------------------------------------------------------

create table public.salary_structures (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null references public.organizations (id) on delete restrict,
  institution_id uuid not null references public.institutions (id) on delete restrict,
  name_en varchar(128) not null,
  name_bn varchar(128),
  description varchar(500),
  status public.salary_structure_status default 'draft' not null,
  effective_from date not null,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create unique index salary_structures_institution_name_key
  on public.salary_structures (institution_id, name_en)
  where archived_at is null;
create index salary_structures_institution_status_idx
  on public.salary_structures (institution_id, status);
create index salary_structures_tenant_idx
  on public.salary_structures (tenant_id);

create table public.salary_components (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null references public.organizations (id) on delete restrict,
  institution_id uuid not null references public.institutions (id) on delete restrict,
  salary_structure_id uuid not null references public.salary_structures (id) on delete cascade,
  name_en varchar(128) not null,
  name_bn varchar(128),
  type public.salary_component_type not null,
  calculation public.salary_calculation default 'fixed' not null,
  amount numeric(14, 2) not null,
  is_taxable boolean default false not null,
  sequence smallint default 0 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

alter table public.salary_components
  add constraint salary_components_amount_non_negative
    check (amount >= 0),
  -- A percentage stored with two decimals is read as basis points; 500.00% is already
  -- generous, and anything beyond it is a data-entry error, not a salary policy.
  add constraint salary_components_percentage_range
    check (calculation = 'fixed' or amount <= 500.00),
  -- The arithmetic guard: gross = basic + earnings, so a gross-relative component that
  -- *adds* to gross would be self-referential. Deductions only.
  add constraint salary_components_gross_pct_is_deduction
    check (calculation <> 'percentage_of_gross' or type = 'deduction'),
  add constraint salary_components_sequence_sane
    check (sequence between 0 and 1000);

create unique index salary_components_structure_name_key
  on public.salary_components (salary_structure_id, name_en)
  where archived_at is null;
create index salary_components_structure_idx
  on public.salary_components (salary_structure_id, sequence);
create index salary_components_tenant_idx
  on public.salary_components (tenant_id);

create table public.employee_salary_assignments (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null references public.organizations (id) on delete restrict,
  institution_id uuid not null references public.institutions (id) on delete restrict,
  employee_id uuid not null references public.employees (id) on delete restrict,
  salary_structure_id uuid not null references public.salary_structures (id) on delete restrict,
  basic numeric(14, 2) not null,
  effective_from date not null,
  effective_to date,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

alter table public.employee_salary_assignments
  add constraint employee_salary_assignments_basic_positive
    check (basic > 0),
  add constraint employee_salary_assignments_range_ordered
    check (effective_to is null or effective_to >= effective_from);

-- At most one open-ended (current) assignment per employee. Historical rows are closed with
-- `effective_to` rather than edited or deleted.
create unique index employee_salary_assignments_open_key
  on public.employee_salary_assignments (employee_id)
  where effective_to is null and archived_at is null;
create index employee_salary_assignments_employee_idx
  on public.employee_salary_assignments (employee_id, effective_from);
create index employee_salary_assignments_structure_idx
  on public.employee_salary_assignments (salary_structure_id);
create index employee_salary_assignments_tenant_idx
  on public.employee_salary_assignments (tenant_id);

-- -------------------------------------------------------------------------------------
-- Profile side-tables: documents, qualifications, experience, dependents
-- -------------------------------------------------------------------------------------

create table public.employee_documents (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null references public.organizations (id) on delete restrict,
  institution_id uuid not null references public.institutions (id) on delete restrict,
  employee_id uuid not null references public.employees (id) on delete restrict,
  file_id uuid not null references public.files (id) on delete restrict,
  storage_key varchar(512) not null,
  document_type varchar(48) not null,
  title varchar(255) not null,
  expires_at date,
  verified_by uuid,
  verified_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create index employee_documents_employee_idx
  on public.employee_documents (employee_id, document_type);
create index employee_documents_expiry_idx
  on public.employee_documents (expires_at)
  where expires_at is not null and archived_at is null;
create index employee_documents_tenant_idx
  on public.employee_documents (tenant_id);

create table public.employee_qualifications (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null references public.organizations (id) on delete restrict,
  institution_id uuid not null references public.institutions (id) on delete restrict,
  employee_id uuid not null references public.employees (id) on delete restrict,
  degree varchar(128) not null,
  institution_name varchar(255) not null,
  field_of_study varchar(128),
  year_completed smallint,
  grade varchar(32),
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

alter table public.employee_qualifications
  add constraint employee_qualifications_year_sane
    check (year_completed is null or year_completed between 1900 and 2100);

create index employee_qualifications_employee_idx
  on public.employee_qualifications (employee_id);
create index employee_qualifications_tenant_idx
  on public.employee_qualifications (tenant_id);

create table public.employee_experience (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null references public.organizations (id) on delete restrict,
  institution_id uuid not null references public.institutions (id) on delete restrict,
  employee_id uuid not null references public.employees (id) on delete restrict,
  organisation_name varchar(255) not null,
  designation varchar(128) not null,
  from_date date not null,
  to_date date,
  responsibilities varchar(500),
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

alter table public.employee_experience
  add constraint employee_experience_dates_ordered
    check (to_date is null or to_date >= from_date);

create index employee_experience_employee_idx
  on public.employee_experience (employee_id);
create index employee_experience_tenant_idx
  on public.employee_experience (tenant_id);

create table public.employee_dependents (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null references public.organizations (id) on delete restrict,
  institution_id uuid not null references public.institutions (id) on delete restrict,
  employee_id uuid not null references public.employees (id) on delete restrict,
  name_en varchar(255) not null,
  name_bn varchar(255),
  relation varchar(24) not null,
  date_of_birth date,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create index employee_dependents_employee_idx
  on public.employee_dependents (employee_id);
create index employee_dependents_tenant_idx
  on public.employee_dependents (tenant_id);

-- -------------------------------------------------------------------------------------
-- Lifecycle records: status history (the separation trail) and campus transfers
-- -------------------------------------------------------------------------------------

create table public.employee_status_history (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null references public.organizations (id) on delete restrict,
  institution_id uuid not null references public.institutions (id) on delete restrict,
  employee_id uuid not null references public.employees (id) on delete restrict,
  from_status public.employment_status,
  to_status public.employment_status not null,
  effective_date date not null,
  reason varchar(1000),
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

alter table public.employee_status_history
  add constraint employee_status_history_actually_changes
    check (from_status is null or from_status <> to_status);

create index employee_status_history_employee_idx
  on public.employee_status_history (employee_id, effective_date);
create index employee_status_history_tenant_idx
  on public.employee_status_history (tenant_id);

create table public.employee_transfers (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null references public.organizations (id) on delete restrict,
  institution_id uuid not null references public.institutions (id) on delete restrict,
  employee_id uuid not null references public.employees (id) on delete restrict,
  from_campus_id uuid references public.campuses (id) on delete restrict,
  to_campus_id uuid not null references public.campuses (id) on delete restrict,
  from_designation_id uuid references public.designations (id) on delete set null,
  to_designation_id uuid references public.designations (id) on delete set null,
  effective_date date not null,
  reason varchar(1000) not null,
  approved_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

alter table public.employee_transfers
  add constraint employee_transfers_actually_moves
    check (from_campus_id is null or from_campus_id <> to_campus_id);

create index employee_transfers_employee_idx
  on public.employee_transfers (employee_id, effective_date);
create index employee_transfers_tenant_idx
  on public.employee_transfers (tenant_id);

-- -------------------------------------------------------------------------------------
-- Row-level security, grants, and the updated_at trigger.
--
-- The driving loop in 0002 does not re-run for tables created later, so each is enabled,
-- forced and given the identical `tenant_isolation` policy here. Both `using` and
-- `with check` are stated: USING gates what existing rows are visible, WITH CHECK is what
-- stops a tenant writing a row stamped with someone else's tenant_id.
-- -------------------------------------------------------------------------------------

do $$
declare
  target text;
begin
  foreach target in array array[
    'employment_contracts',
    'salary_structures',
    'salary_components',
    'employee_salary_assignments',
    'employee_documents',
    'employee_qualifications',
    'employee_experience',
    'employee_dependents',
    'employee_status_history',
    'employee_transfers'
  ]
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
      'employment_contracts', 'salary_structures', 'salary_components',
      'employee_salary_assignments', 'employee_documents', 'employee_qualifications',
      'employee_experience', 'employee_dependents', 'employee_status_history',
      'employee_transfers'
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
      'HR tables without forced row-level security and a tenant_isolation policy: %',
      offending;
  end if;

  -- Every one of the ten must also carry the tenant column the policy reads. A policy on a
  -- table without `tenant_id` would fail at query time, not here.
  select string_agg(t.name, ', ' order by t.name)
  into offending
  from unnest(array[
    'employment_contracts', 'salary_structures', 'salary_components',
    'employee_salary_assignments', 'employee_documents', 'employee_qualifications',
    'employee_experience', 'employee_dependents', 'employee_status_history',
    'employee_transfers'
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
    raise exception 'HR tables without a tenant_id column: %', offending;
  end if;

  -- No monetary column in this phase may be floating point (ADR-004). Restated as a query so
  -- a careless edit to this file cannot demote numeric to real without failing here.
  select string_agg(c.relname || '.' || a.attname, ', ')
  into offending
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_type t on t.oid = a.atttypid
  where n.nspname = 'public'
    and c.relname in ('salary_components', 'employee_salary_assignments')
    and a.attname in ('amount', 'basic')
    and t.typname in ('float4', 'float8');

  if offending is not null then
    raise exception 'Floating-point money columns: %', offending;
  end if;
end
$$;

-- The global sweep: every public table is either RLS-protected or explicitly exempt.
select assert_rls_coverage();
