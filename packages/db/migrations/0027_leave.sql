-- =====================================================================================
-- 0027 — Leave management (Phase 21)
--
-- Six tenant-scoped tables mirroring `packages/db/src/schema/leave.ts` exactly. This is a
-- module where a mistake is a person being paid for a day they did not work, or being
-- refused a day they were entitled to, so the invariants live in the database as well as in
-- the service:
--
--   1. **An applicant may never approve their own leave.** A trigger
--      (`leave_applications_no_self_approval`) refuses an UPDATE that lands on `approved`
--      when the decider is the person who filed it, or is the employee the leave is for.
--      Permissions cannot express "not *this* person" — a school owner holds `*` — so this
--      cannot be a permission check. The workflow engine enforces the same rule at runtime;
--      this trigger is what makes it true of raw SQL as well.
--   2. **Overlapping leave for the same holder is refused.** A DEFERRABLE INITIALLY DEFERRED
--      constraint trigger (`leave_applications_no_overlap`), not an EXCLUDE constraint over
--      `daterange`: an exclusion constraint needs `btree_gist` for the uuid equality
--      operator, and this deployment installs no extensions beyond what the base image
--      provides (the same trade already made in 0008 and 0013). Deferred, so a service that
--      rewrites an application inside one transaction passes through an intermediate state
--      without being refused, and only the COMMIT is checked.
--   3. **A balance never goes below zero unless the leave type says it may.** A trigger
--      (`leave_balances_not_overdrawn`) reads `leave_types.allow_negative_balance` and
--      refuses `used_days > entitled_days + carried_days` otherwise.
--   4. **Exactly one holder.** `leave_balances` and `leave_applications` each carry a
--      nullable `employee_id` and `student_id`; a CHECK makes "both null" and "both set"
--      equally impossible, because either is data corruption.
--   5. **Nothing is hard-deleted.** Withdrawal and cancellation are statuses; every table
--      carries `archived_at` and every uniqueness rule is partial on `archived_at is null`.
--   6. **Money is numeric(14, 2)** on `leave_encashments.amount`; days are `numeric(5, 1)`
--      so a half day is exact. No float exists anywhere in this module.
--   7. **An encashment cannot be approved by the person who requested it** — a plain CHECK,
--      because both columns are on the same row.
--
-- RLS is enabled, forced and given the standard `tenant_isolation` policy for every table,
-- and `assert_rls_coverage()` runs last so a mistake fails the migration rather than
-- shipping a silently-disabled control.
--
-- Every object created here is prefixed `leave_` or `holiday_overrides_` so it cannot
-- collide with anything in 0001–0026.
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- Enumerations. Closed sets only: adding a value changes how the service computes balances
-- or reflects attendance. The leave *types* a school invents (casual, sick, maternity,
-- study) are rows in `leave_types`, not enum members.
-- -------------------------------------------------------------------------------------

create type public.leave_applies_to as enum ('employee', 'student', 'both');

create type public.leave_accrual as enum ('annual_grant', 'monthly_accrual', 'none');

create type public.leave_gender_restriction as enum ('any', 'female', 'male');

create type public.leave_type_status as enum ('active', 'inactive');

create type public.leave_application_status as enum (
  'draft', 'submitted', 'approved', 'rejected', 'cancelled', 'withdrawn'
);

create type public.leave_half_day_period as enum ('first', 'second');

create type public.leave_encashment_status as enum ('pending', 'approved', 'rejected');

-- -------------------------------------------------------------------------------------
-- Tables
-- -------------------------------------------------------------------------------------

create table public.leave_types (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  code varchar(32) not null,
  name_en varchar(255) not null,
  name_bn varchar(255),
  applies_to public.leave_applies_to default 'employee' not null,
  is_paid boolean default true not null,
  requires_document boolean default false not null,
  max_consecutive_days integer,
  annual_quota_days numeric(5, 1) default '0.0' not null,
  carry_forward_days numeric(5, 1) default '0.0' not null,
  accrual public.leave_accrual default 'annual_grant' not null,
  gender_restriction public.leave_gender_restriction default 'any' not null,
  allow_negative_balance boolean default false not null,
  status public.leave_type_status default 'active' not null,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.leave_balances (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  leave_type_id uuid not null,
  employee_id uuid,
  student_id uuid,
  academic_year_id uuid not null,
  entitled_days numeric(5, 1) default '0.0' not null,
  used_days numeric(5, 1) default '0.0' not null,
  carried_days numeric(5, 1) default '0.0' not null,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.leave_applications (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  leave_type_id uuid not null,
  academic_year_id uuid not null,
  employee_id uuid,
  student_id uuid,
  from_date date not null,
  to_date date not null,
  days numeric(5, 1) not null,
  is_half_day boolean default false not null,
  half_day_period public.leave_half_day_period,
  reason text not null,
  contact_during_leave varchar(120),
  status public.leave_application_status default 'draft' not null,
  -- Bare uuid, no foreign key (the accounting precedent): the workflow engine is an
  -- optional peer owned by another module, and this migration must keep applying whether or
  -- not it is installed. The outcome handler, not a join, is the integration surface.
  workflow_request_id uuid,
  -- Deliberately not a foreign key: the decision record must outlive any user row.
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

create table public.leave_application_documents (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  application_id uuid not null,
  storage_key varchar(512) not null,
  file_name varchar(255) not null,
  mime_type varchar(128) not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.leave_encashments (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  employee_id uuid not null,
  leave_type_id uuid not null,
  academic_year_id uuid not null,
  days numeric(5, 1) not null,
  amount numeric(14, 2) not null,
  status public.leave_encashment_status default 'pending' not null,
  requested_by uuid not null,
  approved_by uuid,
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

create table public.holiday_overrides (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  date date not null,
  is_working_day boolean not null,
  note varchar(255),
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
-- Foreign keys. `restrict` throughout — a leave type with history, an employee with leave,
-- an academic year a balance is charged to must never become removable — and `cascade` only
-- for `leave_application_documents`, which is a genuinely owned child of its application.
-- -------------------------------------------------------------------------------------

alter table public.leave_types
  add constraint leave_types_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint leave_types_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict;

alter table public.leave_balances
  add constraint leave_balances_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint leave_balances_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint leave_balances_leave_type_id_leave_types_id_fk
    foreign key (leave_type_id) references public.leave_types(id) on delete restrict,
  add constraint leave_balances_employee_id_employees_id_fk
    foreign key (employee_id) references public.employees(id) on delete restrict,
  add constraint leave_balances_student_id_students_id_fk
    foreign key (student_id) references public.students(id) on delete restrict,
  add constraint leave_balances_academic_year_id_academic_years_id_fk
    foreign key (academic_year_id) references public.academic_years(id) on delete restrict;

alter table public.leave_applications
  add constraint leave_applications_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint leave_applications_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint leave_applications_leave_type_id_leave_types_id_fk
    foreign key (leave_type_id) references public.leave_types(id) on delete restrict,
  add constraint leave_applications_academic_year_id_academic_years_id_fk
    foreign key (academic_year_id) references public.academic_years(id) on delete restrict,
  add constraint leave_applications_employee_id_employees_id_fk
    foreign key (employee_id) references public.employees(id) on delete restrict,
  add constraint leave_applications_student_id_students_id_fk
    foreign key (student_id) references public.students(id) on delete restrict;

alter table public.leave_application_documents
  add constraint leave_application_documents_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint leave_application_documents_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  -- Kept short deliberately: the full Drizzle-style name would exceed Postgres's 63-byte
  -- identifier limit and be silently truncated.
  add constraint leave_application_documents_application_id_fk
    foreign key (application_id) references public.leave_applications(id) on delete cascade;

alter table public.leave_encashments
  add constraint leave_encashments_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint leave_encashments_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint leave_encashments_employee_id_employees_id_fk
    foreign key (employee_id) references public.employees(id) on delete restrict,
  add constraint leave_encashments_leave_type_id_leave_types_id_fk
    foreign key (leave_type_id) references public.leave_types(id) on delete restrict,
  add constraint leave_encashments_academic_year_id_academic_years_id_fk
    foreign key (academic_year_id) references public.academic_years(id) on delete restrict;

alter table public.holiday_overrides
  add constraint holiday_overrides_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint holiday_overrides_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict;

-- -------------------------------------------------------------------------------------
-- Indexes. Exactly the set declared in `packages/db/src/schema/leave.ts`.
--
-- The balance uniqueness rule needs two partial indexes rather than one composite: Postgres
-- treats NULLs as distinct, so `(leave_type_id, employee_id, academic_year_id)` would not
-- constrain student rows at all.
-- -------------------------------------------------------------------------------------

create unique index if not exists leave_types_institution_code_key
  on public.leave_types using btree (institution_id, code) where archived_at is null;
create index if not exists leave_types_tenant_idx
  on public.leave_types using btree (tenant_id);
create index if not exists leave_types_institution_status_idx
  on public.leave_types using btree (institution_id, status);

create unique index if not exists leave_balances_type_employee_year_key
  on public.leave_balances using btree (leave_type_id, employee_id, academic_year_id)
  where employee_id is not null and archived_at is null;
create unique index if not exists leave_balances_type_student_year_key
  on public.leave_balances using btree (leave_type_id, student_id, academic_year_id)
  where student_id is not null and archived_at is null;
create index if not exists leave_balances_tenant_idx
  on public.leave_balances using btree (tenant_id);
create index if not exists leave_balances_employee_idx
  on public.leave_balances using btree (employee_id);
create index if not exists leave_balances_student_idx
  on public.leave_balances using btree (student_id);
create index if not exists leave_balances_year_idx
  on public.leave_balances using btree (academic_year_id);

create index if not exists leave_applications_tenant_idx
  on public.leave_applications using btree (tenant_id);
create index if not exists leave_applications_institution_status_idx
  on public.leave_applications using btree (institution_id, status);
create index if not exists leave_applications_employee_idx
  on public.leave_applications using btree (employee_id);
create index if not exists leave_applications_student_idx
  on public.leave_applications using btree (student_id);
-- Serves the leave calendar and the overlap trigger's probe.
create index if not exists leave_applications_range_idx
  on public.leave_applications using btree (institution_id, from_date, to_date);
create index if not exists leave_applications_workflow_idx
  on public.leave_applications using btree (workflow_request_id);

create index if not exists leave_application_documents_tenant_idx
  on public.leave_application_documents using btree (tenant_id);
create index if not exists leave_application_documents_application_idx
  on public.leave_application_documents using btree (application_id);

create index if not exists leave_encashments_tenant_idx
  on public.leave_encashments using btree (tenant_id);
create index if not exists leave_encashments_employee_idx
  on public.leave_encashments using btree (employee_id);
create index if not exists leave_encashments_institution_status_idx
  on public.leave_encashments using btree (institution_id, status);
create index if not exists leave_encashments_year_idx
  on public.leave_encashments using btree (academic_year_id);

create unique index if not exists holiday_overrides_institution_date_key
  on public.holiday_overrides using btree (institution_id, date) where archived_at is null;
create index if not exists holiday_overrides_tenant_idx
  on public.holiday_overrides using btree (tenant_id);

-- -------------------------------------------------------------------------------------
-- Check constraints. The invariants that a bug in the service must not be able to violate.
-- -------------------------------------------------------------------------------------

alter table public.leave_types
  add constraint leave_types_quota_non_negative
    check (annual_quota_days >= 0 and carry_forward_days >= 0),
  add constraint leave_types_max_consecutive_positive
    check (max_consecutive_days is null or max_consecutive_days > 0);

alter table public.leave_balances
  -- Exactly one holder. `(a is null) <> (b is null)` is false when both are null and false
  -- when both are set.
  add constraint leave_balances_exactly_one_holder
    check ((employee_id is null) <> (student_id is null)),
  add constraint leave_balances_days_non_negative
    check (entitled_days >= 0 and carried_days >= 0 and used_days >= 0);

alter table public.leave_applications
  add constraint leave_applications_exactly_one_holder
    check ((employee_id is null) <> (student_id is null)),
  add constraint leave_applications_dates_ordered check (to_date >= from_date),
  -- Zero working days is not an application, it is a mistake: the whole range fell on
  -- weekends and holidays.
  add constraint leave_applications_days_positive check (days > 0),
  -- A half day is one date, names which half, and costs exactly 0.5 days.
  add constraint leave_applications_half_day_shape
    check (
      (not is_half_day and half_day_period is null)
      or (is_half_day and half_day_period is not null and from_date = to_date and days = 0.5)
    ),
  -- An approval or a rejection always records who decided it and when.
  add constraint leave_applications_decision_recorded
    check (
      status not in ('approved', 'rejected')
      or (decided_by is not null and decided_at is not null)
    );

alter table public.leave_encashments
  add constraint leave_encashments_days_positive check (days > 0),
  add constraint leave_encashments_amount_non_negative check (amount >= 0),
  add constraint leave_encashments_decision_recorded
    check (status = 'pending' or (approved_by is not null and decided_at is not null)),
  -- Invariant 7: the person who asked for the payout is never the person who granted it.
  -- Both columns are on this row, so this needs no trigger.
  add constraint leave_encashments_no_self_approval
    check (approved_by is null or approved_by <> requested_by);

-- -------------------------------------------------------------------------------------
-- Trigger: an applicant may never approve their own leave (invariant 1).
--
-- Two ways the same person can be on both sides:
--   * they filed the application themselves (`created_by`), or
--   * HR filed it for them and they are the employee it is for (`employees.user_id`).
--
-- Both are refused. There is no permission that can buy past this, which is the point: the
-- school owner holds `*` and is refused exactly like everyone else.
-- -------------------------------------------------------------------------------------

create or replace function leave_applications_assert_not_self_approved() returns trigger
language plpgsql
as $$
declare
  holder_user uuid;
begin
  if new.status <> 'approved' or new.decided_by is null then
    return new;
  end if;

  if new.decided_by = new.created_by then
    raise exception
      'leave application % cannot be approved by the person who applied for it', new.id
      using errcode = 'insufficient_privilege';
  end if;

  if new.employee_id is not null then
    select user_id into holder_user from public.employees where id = new.employee_id;
    if holder_user is not null and holder_user = new.decided_by then
      raise exception
        'leave application % cannot be approved by the employee whose leave it is', new.id
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end
$$;

drop trigger if exists leave_applications_no_self_approval on public.leave_applications;
create trigger leave_applications_no_self_approval
  before insert or update on public.leave_applications
  for each row execute function leave_applications_assert_not_self_approved();

-- -------------------------------------------------------------------------------------
-- Trigger: no overlapping leave for the same holder (invariant 2).
--
-- Only `submitted` and `approved` rows reserve a date range: a draft has not been asked for
-- yet, and rejected, cancelled and withdrawn applications are history, not a claim on the
-- calendar. Archived rows are excluded for the same reason.
--
-- `is not distinct from` compares the nullable holder columns correctly: for an employee's
-- leave both `student_id`s are null and match, and the `employee_id` comparison does the
-- discriminating (and vice versa for a student).
--
-- Deliberately not SECURITY DEFINER: it must see exactly the rows the caller can see, so an
-- application-role insert is checked within its own tenant and cannot be made to pass or
-- fail by another tenant's data.
-- -------------------------------------------------------------------------------------

create or replace function leave_applications_assert_no_overlap() returns trigger
language plpgsql
as $$
declare
  -- Scalars rather than a record: a `select ... into` that finds nothing leaves these
  -- unambiguously null, with no dependence on how plpgsql treats an unassigned record.
  offending_id uuid;
  offending_from date;
  offending_to date;
  offending_status public.leave_application_status;
begin
  -- The trigger fires on insert and update only, so `new` is always assigned.
  if new.archived_at is not null or new.status not in ('submitted', 'approved') then
    return null;
  end if;

  select o.id, o.from_date, o.to_date, o.status
    into offending_id, offending_from, offending_to, offending_status
    from public.leave_applications o
   where o.id <> new.id
     and o.archived_at is null
     and o.status in ('submitted', 'approved')
     and o.employee_id is not distinct from new.employee_id
     and o.student_id is not distinct from new.student_id
     and o.from_date <= new.to_date
     and o.to_date >= new.from_date
   limit 1;

  if offending_id is not null then
    raise exception
      'leave % (% to %) overlaps existing % leave % (% to %) for the same person',
      new.id, new.from_date, new.to_date,
      offending_status, offending_id, offending_from, offending_to
      using errcode = 'check_violation',
            constraint = 'leave_applications_no_overlap';
  end if;

  return null;
end
$$;

drop trigger if exists leave_applications_no_overlap on public.leave_applications;
create constraint trigger leave_applications_no_overlap
  after insert or update on public.leave_applications
  deferrable initially deferred
  for each row execute function leave_applications_assert_no_overlap();

-- -------------------------------------------------------------------------------------
-- Trigger: a balance never goes below zero unless the leave type permits it (invariant 3).
--
-- `allow_negative_balance` is the single sanctioned way to overdraw, and it is a property of
-- the policy, not of the request — which is why the check reads `leave_types` rather than
-- trusting a flag passed in by the caller.
-- -------------------------------------------------------------------------------------

create or replace function leave_balances_assert_not_overdrawn() returns trigger
language plpgsql
as $$
declare
  allows boolean;
begin
  if new.archived_at is not null then
    return new;
  end if;

  select allow_negative_balance into allows
    from public.leave_types where id = new.leave_type_id;

  if allows is null then
    raise exception 'leave balance names an unknown leave type %', new.leave_type_id
      using errcode = 'foreign_key_violation';
  end if;

  if not allows and new.used_days > new.entitled_days + new.carried_days then
    raise exception
      'leave balance would be overdrawn: % days used against % entitled plus % carried',
      new.used_days, new.entitled_days, new.carried_days
      using errcode = 'check_violation',
            constraint = 'leave_balances_not_overdrawn';
  end if;

  return new;
end
$$;

drop trigger if exists leave_balances_not_overdrawn on public.leave_balances;
create trigger leave_balances_not_overdrawn
  before insert or update on public.leave_balances
  for each row execute function leave_balances_assert_not_overdrawn();

-- -------------------------------------------------------------------------------------
-- Row-level security: enable + force + the standard tenant_isolation policy + grants +
-- the updated_at trigger, per table. The catalogue loop in 0002 does not re-run for tables
-- created later, so it is restated here with the same expression.
--
-- Both `using` and `with check` are required. `using` gates which rows are visible;
-- `with check` gates what may be written, and it is the half that stops one tenant writing
-- a row stamped with another tenant's id.
-- -------------------------------------------------------------------------------------

do $$
declare
  target text;
  leave_tables constant text[] := array[
    'leave_types',
    'leave_balances',
    'leave_applications',
    'leave_application_documents',
    'leave_encashments',
    'holiday_overrides'
  ];
begin
  foreach target in array leave_tables
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
      'leave_types', 'leave_balances', 'leave_applications',
      'leave_application_documents', 'leave_encashments', 'holiday_overrides'
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
      'Leave tables without forced row-level security and a tenant_isolation policy: %',
      offending;
  end if;

  select string_agg(t.name, ', ' order by t.name)
  into offending
  from unnest(array[
    'leave_types', 'leave_balances', 'leave_applications',
    'leave_application_documents', 'leave_encashments', 'holiday_overrides'
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
    raise exception 'Leave tables without a tenant_id column: %', offending;
  end if;
end
$$;

-- The global sweep: every public table is either RLS-protected or explicitly exempt.
select assert_rls_coverage();
