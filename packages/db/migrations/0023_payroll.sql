-- =====================================================================================
-- 0023 — Payroll (Phase 16)
--
-- Six tenant-scoped tables. Payroll is money, so the invariants live in the database, not
-- only in the service:
--
--   1. **A payslip's lines and its totals agree.** sum(earning lines) = gross and
--      sum(deduction lines) = total_deductions are a DEFERRABLE INITIALLY DEFERRED
--      constraint trigger; net = gross - total_deductions and gross = basic +
--      total_earnings are check constraints. An inconsistent payslip is refused even from
--      raw SQL that bypasses the service entirely.
--   2. **One live run per (institution, year, month).** Partial unique index; a cancelled
--      run frees the month for a fresh one.
--   3. **An approved run is immutable.** A trigger allows exactly two transitions out of
--      `approved` — to `paid` and to `cancelled` — with every substantive column
--      untouched. Payslips and lines of an approved or paid run are frozen (except the
--      payment fields on the slip, which is how marking the run paid works), adjustments
--      against such a run are refused, and nothing in this module is ever hard-deleted.
--   4. **The approver differs from the calculator.** Check constraint.
--   5. **Money is numeric(14, 2).** No float exists anywhere in this module.
--
-- RLS is enabled, forced and given the standard `tenant_isolation` policy for every table,
-- and `assert_rls_coverage()` runs last so a mistake fails the migration rather than
-- shipping a silently-disabled control.
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- Enumerations. Closed sets only: a new run status or line kind changes the payroll
-- arithmetic as well as the schema. Adjustment names and loan purposes are varchars.
-- -------------------------------------------------------------------------------------

create type public.payroll_run_status as enum (
  'draft', 'calculated', 'under_review', 'approved', 'paid', 'cancelled'
);

create type public.payslip_payment_status as enum ('pending', 'paid', 'failed');

create type public.payroll_line_kind as enum ('earning', 'deduction');

create type public.loan_advance_status as enum ('active', 'settled', 'cancelled');

-- -------------------------------------------------------------------------------------
-- Tables
-- -------------------------------------------------------------------------------------

create table public.payroll_runs (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  period_year smallint not null,
  period_month smallint not null,
  name varchar(128) not null,
  status public.payroll_run_status default 'draft' not null,
  calculated_by uuid,
  calculated_at timestamp with time zone,
  approved_by uuid,
  approved_at timestamp with time zone,
  paid_by uuid,
  paid_at timestamp with time zone,
  cancelled_by uuid,
  cancelled_at timestamp with time zone,
  cancel_reason varchar(1000),
  total_gross numeric(14, 2) default '0.00' not null,
  total_deductions numeric(14, 2) default '0.00' not null,
  total_net numeric(14, 2) default '0.00' not null,
  employee_count integer default 0 not null,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.payslips (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  run_id uuid not null,
  employee_id uuid not null,
  salary_structure_id uuid,
  salary_assignment_id uuid,
  basic numeric(14, 2) default '0.00' not null,
  total_earnings numeric(14, 2) default '0.00' not null,
  gross numeric(14, 2) default '0.00' not null,
  total_deductions numeric(14, 2) default '0.00' not null,
  net numeric(14, 2) default '0.00' not null,
  unpaid_leave_days smallint default 0 not null,
  payment_status public.payslip_payment_status default 'pending' not null,
  paid_at timestamp with time zone,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.loan_advances (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  employee_id uuid not null,
  principal numeric(14, 2) not null,
  instalment numeric(14, 2) not null,
  remaining numeric(14, 2) not null,
  start_year smallint not null,
  start_month smallint not null,
  status public.loan_advance_status default 'active' not null,
  notes varchar(500),
  cancel_reason varchar(1000),
  settled_at timestamp with time zone,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.payslip_lines (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  payslip_id uuid not null,
  component_id uuid,
  loan_advance_id uuid,
  name varchar(128) not null,
  kind public.payroll_line_kind not null,
  amount numeric(14, 2) not null,
  sequence smallint default 0 not null,
  is_statutory boolean default false not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.payroll_adjustments (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  run_id uuid not null,
  employee_id uuid not null,
  kind public.payroll_line_kind not null,
  name varchar(128) not null,
  amount numeric(14, 2) not null,
  reason varchar(1000) not null,
  approved_by uuid,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.payroll_journal_links (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  run_id uuid not null,
  journal_entry_id uuid not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

-- -------------------------------------------------------------------------------------
-- Foreign keys. `restrict` throughout for financial parents; `cascade` only for
-- payslip_lines, which are genuinely owned by their payslip (the same policy as
-- journal_lines by their entry).
-- -------------------------------------------------------------------------------------

alter table public.payroll_runs
  add constraint payroll_runs_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint payroll_runs_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict;

alter table public.payslips
  add constraint payslips_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint payslips_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint payslips_run_id_payroll_runs_id_fk
    foreign key (run_id) references public.payroll_runs(id) on delete restrict,
  add constraint payslips_employee_id_employees_id_fk
    foreign key (employee_id) references public.employees(id) on delete restrict,
  add constraint payslips_salary_structure_id_salary_structures_id_fk
    foreign key (salary_structure_id) references public.salary_structures(id) on delete restrict,
  add constraint payslips_salary_assignment_id_employee_salary_assignments_id_fk
    foreign key (salary_assignment_id) references public.employee_salary_assignments(id)
      on delete restrict;

alter table public.loan_advances
  add constraint loan_advances_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint loan_advances_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint loan_advances_employee_id_employees_id_fk
    foreign key (employee_id) references public.employees(id) on delete restrict;

alter table public.payslip_lines
  add constraint payslip_lines_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint payslip_lines_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint payslip_lines_payslip_id_payslips_id_fk
    foreign key (payslip_id) references public.payslips(id) on delete cascade,
  add constraint payslip_lines_component_id_salary_components_id_fk
    foreign key (component_id) references public.salary_components(id) on delete restrict,
  add constraint payslip_lines_loan_advance_id_loan_advances_id_fk
    foreign key (loan_advance_id) references public.loan_advances(id) on delete restrict;

alter table public.payroll_adjustments
  add constraint payroll_adjustments_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint payroll_adjustments_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint payroll_adjustments_run_id_payroll_runs_id_fk
    foreign key (run_id) references public.payroll_runs(id) on delete restrict,
  add constraint payroll_adjustments_employee_id_employees_id_fk
    foreign key (employee_id) references public.employees(id) on delete restrict;

alter table public.payroll_journal_links
  add constraint payroll_journal_links_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint payroll_journal_links_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint payroll_journal_links_run_id_payroll_runs_id_fk
    foreign key (run_id) references public.payroll_runs(id) on delete restrict,
  add constraint payroll_journal_links_journal_entry_id_journal_entries_id_fk
    foreign key (journal_entry_id) references public.journal_entries(id) on delete restrict;

-- -------------------------------------------------------------------------------------
-- Indexes
-- -------------------------------------------------------------------------------------

-- One live run per month (invariant 2). A cancelled run frees the month.
create unique index if not exists payroll_runs_institution_period_key
  on public.payroll_runs using btree (institution_id, period_year, period_month)
  where status <> 'cancelled' and archived_at is null;
create index if not exists payroll_runs_tenant_idx
  on public.payroll_runs using btree (tenant_id);
create index if not exists payroll_runs_institution_status_idx
  on public.payroll_runs using btree (institution_id, status);

create unique index if not exists payslips_run_employee_key
  on public.payslips using btree (run_id, employee_id) where archived_at is null;
create index if not exists payslips_tenant_idx
  on public.payslips using btree (tenant_id);
create index if not exists payslips_run_idx
  on public.payslips using btree (run_id);
create index if not exists payslips_employee_idx
  on public.payslips using btree (employee_id);

create index if not exists payslip_lines_payslip_idx
  on public.payslip_lines using btree (payslip_id, sequence);
create index if not exists payslip_lines_tenant_idx
  on public.payslip_lines using btree (tenant_id);
create index if not exists payslip_lines_loan_idx
  on public.payslip_lines using btree (loan_advance_id);

create index if not exists payroll_adjustments_run_idx
  on public.payroll_adjustments using btree (run_id, employee_id);
create index if not exists payroll_adjustments_tenant_idx
  on public.payroll_adjustments using btree (tenant_id);
create index if not exists payroll_adjustments_employee_idx
  on public.payroll_adjustments using btree (employee_id);

create index if not exists loan_advances_tenant_idx
  on public.loan_advances using btree (tenant_id);
create index if not exists loan_advances_employee_idx
  on public.loan_advances using btree (employee_id, status);
create index if not exists loan_advances_institution_status_idx
  on public.loan_advances using btree (institution_id, status);

-- Never partial: a run pays out exactly once, for the life of the record.
create unique index if not exists payroll_journal_links_run_key
  on public.payroll_journal_links using btree (run_id);
create index if not exists payroll_journal_links_tenant_idx
  on public.payroll_journal_links using btree (tenant_id);
create index if not exists payroll_journal_links_entry_idx
  on public.payroll_journal_links using btree (journal_entry_id);

-- -------------------------------------------------------------------------------------
-- Check constraints
-- -------------------------------------------------------------------------------------

alter table public.payroll_runs
  add constraint payroll_runs_month_range check (period_month between 1 and 12),
  add constraint payroll_runs_year_sane check (period_year between 2000 and 2100),
  add constraint payroll_runs_totals_non_negative
    check (total_gross >= 0 and total_deductions >= 0),
  -- Net is a derived fact, never an independently editable figure.
  add constraint payroll_runs_net_is_derived
    check (total_net = total_gross - total_deductions),
  add constraint payroll_runs_employee_count_non_negative check (employee_count >= 0),
  -- Every state past `draft` carries the record of who computed it and when.
  add constraint payroll_runs_calculated_recorded
    check (status in ('draft', 'cancelled')
           or (calculated_by is not null and calculated_at is not null)),
  add constraint payroll_runs_approved_recorded
    check (status not in ('approved', 'paid')
           or (approved_by is not null and approved_at is not null)),
  add constraint payroll_runs_paid_recorded
    check (status <> 'paid' or (paid_at is not null and paid_by is not null)),
  add constraint payroll_runs_cancel_requires_reason
    check (status <> 'cancelled'
           or (cancel_reason is not null and cancelled_by is not null and cancelled_at is not null)),
  -- Separation of duties (invariant 4): whoever calculated a run cannot approve it.
  add constraint payroll_runs_approver_differs
    check (approved_by is null or calculated_by is null or approved_by <> calculated_by);

alter table public.payslips
  add constraint payslips_amounts_non_negative
    check (basic >= 0 and total_earnings >= 0 and gross >= 0 and total_deductions >= 0),
  add constraint payslips_gross_is_derived check (gross = basic + total_earnings),
  add constraint payslips_net_is_derived check (net = gross - total_deductions),
  add constraint payslips_unpaid_days_sane
    check (unpaid_leave_days >= 0 and unpaid_leave_days <= 31),
  add constraint payslips_paid_recorded
    check (payment_status <> 'paid' or paid_at is not null);

alter table public.payslip_lines
  add constraint payslip_lines_amount_non_negative check (amount >= 0),
  -- An instalment recovers money; a loan can never appear as an earning.
  add constraint payslip_lines_loan_is_deduction
    check (loan_advance_id is null or kind = 'deduction');

alter table public.payroll_adjustments
  add constraint payroll_adjustments_amount_positive check (amount > 0);

alter table public.loan_advances
  add constraint loan_advances_amounts_positive check (principal > 0 and instalment > 0),
  add constraint loan_advances_instalment_within_principal check (instalment <= principal),
  add constraint loan_advances_remaining_range
    check (remaining >= 0 and remaining <= principal),
  add constraint loan_advances_month_range check (start_month between 1 and 12),
  add constraint loan_advances_year_sane check (start_year between 2000 and 2100),
  -- A fully recovered loan is `settled`, never a zero-balance `active` row.
  add constraint loan_advances_active_has_balance
    check (status <> 'active' or remaining > 0),
  add constraint loan_advances_settled_when_zero
    check (status <> 'settled' or remaining = 0),
  add constraint loan_advances_cancel_requires_reason
    check (status <> 'cancelled' or cancel_reason is not null);

-- -------------------------------------------------------------------------------------
-- Deferred constraint trigger: a payslip's lines and its totals agree (invariant 1).
-- Deferred so the slip and its lines can be written in any order inside one transaction;
-- an inconsistent COMMIT is refused, even from raw SQL. Archived slips are exempt — they
-- are the historical record of a superseded calculation, frozen as they were.
-- -------------------------------------------------------------------------------------

create or replace function payroll_payslips_assert_consistent() returns trigger
language plpgsql
as $$
declare
  target_payslip uuid;
  slip record;
  earning_total numeric(14, 2);
  deduction_total numeric(14, 2);
begin
  if tg_table_name = 'payslip_lines' then
    target_payslip := coalesce(new.payslip_id, old.payslip_id);
  else
    target_payslip := coalesce(new.id, old.id);
  end if;

  select id, gross, total_deductions, archived_at
    into slip
    from public.payslips
   where id = target_payslip;

  if slip is null or slip.archived_at is not null then
    return null;
  end if;

  select
      coalesce(sum(amount) filter (where kind = 'earning'), 0),
      coalesce(sum(amount) filter (where kind = 'deduction'), 0)
    into earning_total, deduction_total
    from public.payslip_lines
   where payslip_id = target_payslip
     and archived_at is null;

  if earning_total <> slip.gross then
    raise exception
      'payslip % is inconsistent: earning lines sum to % but gross is %',
      target_payslip, earning_total, slip.gross
      using errcode = 'check_violation',
            constraint = 'payslips_lines_match_gross';
  end if;

  if deduction_total <> slip.total_deductions then
    raise exception
      'payslip % is inconsistent: deduction lines sum to % but total_deductions is %',
      target_payslip, deduction_total, slip.total_deductions
      using errcode = 'check_violation',
            constraint = 'payslips_lines_match_deductions';
  end if;

  return null;
end
$$;

create constraint trigger payslips_totals_balanced
  after insert or update or delete on public.payslip_lines
  deferrable initially deferred
  for each row execute function payroll_payslips_assert_consistent();

create constraint trigger payslips_totals_balanced_self
  after insert or update on public.payslips
  deferrable initially deferred
  for each row execute function payroll_payslips_assert_consistent();

-- -------------------------------------------------------------------------------------
-- Trigger: an approved payroll run is immutable, and runs are never deleted
-- (invariant 3, run side). Exactly two transitions leave `approved` — to `paid` with the
-- payment fields set, and to `cancelled` with a reason — and both leave every substantive
-- column untouched. `paid` and `cancelled` are terminal.
-- -------------------------------------------------------------------------------------

create or replace function payroll_runs_guard_mutation() returns trigger
language plpgsql
as $$
begin
  if pg_has_role(current_user, 'shikkha_migrator', 'MEMBER') then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    raise exception
      'payroll runs are never deleted; cancel a run with a reason instead'
      using errcode = 'insufficient_privilege';
  end if;

  if old.status = 'paid' then
    raise exception 'payroll run % is paid and fully immutable', old.id
      using errcode = 'insufficient_privilege';
  end if;

  if old.status = 'cancelled' then
    raise exception 'payroll run % is cancelled and fully immutable', old.id
      using errcode = 'insufficient_privilege';
  end if;

  if old.status = 'approved' then
    if new.status in ('paid', 'cancelled')
       and new.tenant_id = old.tenant_id
       and new.institution_id = old.institution_id
       and new.period_year = old.period_year
       and new.period_month = old.period_month
       and new.name = old.name
       and new.total_gross = old.total_gross
       and new.total_deductions = old.total_deductions
       and new.total_net = old.total_net
       and new.employee_count = old.employee_count
       and new.calculated_by is not distinct from old.calculated_by
       and new.calculated_at is not distinct from old.calculated_at
       and new.approved_by is not distinct from old.approved_by
       and new.approved_at is not distinct from old.approved_at
       and new.archived_at is null
    then
      return new;
    end if;

    raise exception
      'payroll run % is approved and immutable; corrections go into the next run''s adjustments, or cancel the run with a reason',
      old.id
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end
$$;

create trigger payroll_runs_immutable
  before update or delete on public.payroll_runs
  for each row execute function payroll_runs_guard_mutation();

-- -------------------------------------------------------------------------------------
-- Trigger: payslips of an approved or paid run are frozen (invariant 3, slip side).
-- The single exception: the payment fields (payment_status, paid_at) may change while the
-- run pays out — every money column and the slip's identity must stay exactly as approved.
-- Payslips are never deleted; a recalculation archives them.
-- -------------------------------------------------------------------------------------

create or replace function payroll_payslips_guard_mutation() returns trigger
language plpgsql
as $$
declare
  run_status public.payroll_run_status;
begin
  if pg_has_role(current_user, 'shikkha_migrator', 'MEMBER') then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    raise exception
      'payslips are never deleted; a recalculation archives the previous set'
      using errcode = 'insufficient_privilege';
  end if;

  if tg_op = 'INSERT' then
    select status into run_status from public.payroll_runs where id = new.run_id;
    if run_status in ('approved', 'paid') then
      raise exception
        'payroll run % is % and accepts no new payslips', new.run_id, run_status
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  -- UPDATE: check the old parent as well, so a slip cannot be smuggled out of an
  -- approved run by re-pointing its run_id.
  select status into run_status from public.payroll_runs where id = old.run_id;
  if run_status in ('approved', 'paid') then
    if new.run_id = old.run_id
       and new.tenant_id = old.tenant_id
       and new.institution_id = old.institution_id
       and new.employee_id = old.employee_id
       and new.salary_structure_id is not distinct from old.salary_structure_id
       and new.salary_assignment_id is not distinct from old.salary_assignment_id
       and new.basic = old.basic
       and new.total_earnings = old.total_earnings
       and new.gross = old.gross
       and new.total_deductions = old.total_deductions
       and new.net = old.net
       and new.unpaid_leave_days = old.unpaid_leave_days
       and new.archived_at is not distinct from old.archived_at
    then
      return new;
    end if;

    raise exception
      'payslip % belongs to an % payroll run and is immutable apart from its payment status',
      old.id, run_status
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end
$$;

create trigger payslips_locked_when_run_closed
  before insert or update or delete on public.payslips
  for each row execute function payroll_payslips_guard_mutation();

-- -------------------------------------------------------------------------------------
-- Trigger: lines of a payslip in an approved or paid run never change at all, and lines
-- are never deleted from any run.
-- -------------------------------------------------------------------------------------

create or replace function payroll_payslip_lines_guard_mutation() returns trigger
language plpgsql
as $$
declare
  run_status public.payroll_run_status;
  target_payslip uuid;
begin
  if pg_has_role(current_user, 'shikkha_migrator', 'MEMBER') then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    raise exception
      'payslip lines are never deleted; a recalculation archives the previous set'
      using errcode = 'insufficient_privilege';
  end if;

  -- On UPDATE check the old parent as well, so a line cannot be smuggled out of an
  -- approved run's payslip by re-pointing its payslip_id.
  if tg_op = 'UPDATE' then
    select r.status into run_status
      from public.payroll_runs r
      join public.payslips p on p.run_id = r.id
     where p.id = old.payslip_id;
    if run_status in ('approved', 'paid') then
      raise exception
        'payslip % belongs to an % payroll run and its lines are immutable',
        old.payslip_id, run_status
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  target_payslip := new.payslip_id;
  select r.status into run_status
    from public.payroll_runs r
    join public.payslips p on p.run_id = r.id
   where p.id = target_payslip;
  if run_status in ('approved', 'paid') then
    raise exception
      'payslip % belongs to an % payroll run and its lines are immutable',
      target_payslip, run_status
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end
$$;

create trigger payslip_lines_locked_when_run_closed
  before insert or update or delete on public.payslip_lines
  for each row execute function payroll_payslip_lines_guard_mutation();

-- -------------------------------------------------------------------------------------
-- Trigger: adjustments against an approved or paid run are refused. Corrections go into
-- the next run — that is the rule this trigger makes physical.
-- -------------------------------------------------------------------------------------

create or replace function payroll_adjustments_guard_mutation() returns trigger
language plpgsql
as $$
declare
  run_status public.payroll_run_status;
begin
  if pg_has_role(current_user, 'shikkha_migrator', 'MEMBER') then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    raise exception
      'payroll adjustments are never deleted; archive one with a reason instead'
      using errcode = 'insufficient_privilege';
  end if;

  select status into run_status
    from public.payroll_runs
   where id = coalesce(new.run_id, old.run_id);

  if run_status in ('approved', 'paid') then
    raise exception
      'payroll run % is % and its adjustments are frozen; record the correction in the next run',
      coalesce(new.run_id, old.run_id), run_status
      using errcode = 'insufficient_privilege';
  end if;

  -- An UPDATE must also check the old parent, so an adjustment cannot be re-pointed
  -- out of (or into) a closed run.
  if tg_op = 'UPDATE' and new.run_id <> old.run_id then
    select status into run_status from public.payroll_runs where id = old.run_id;
    if run_status in ('approved', 'paid') then
      raise exception
        'payroll run % is % and its adjustments are frozen', old.run_id, run_status
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end
$$;

create trigger payroll_adjustments_locked_when_run_closed
  before insert or update or delete on public.payroll_adjustments
  for each row execute function payroll_adjustments_guard_mutation();

-- -------------------------------------------------------------------------------------
-- Row-level security, grants and updated_at maintenance. The catalogue loop in 0002 does
-- not re-run for tables created later, so this migration restates it.
-- -------------------------------------------------------------------------------------

do $$
declare
  target text;
  payroll_tables constant text[] := array[
    'payroll_runs',
    'payslips',
    'payslip_lines',
    'payroll_adjustments',
    'loan_advances',
    'payroll_journal_links'
  ];
begin
  foreach target in array payroll_tables
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
      'payroll_runs', 'payslips', 'payslip_lines', 'payroll_adjustments',
      'loan_advances', 'payroll_journal_links'
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
      'Payroll tables without forced row-level security and a tenant_isolation policy: %',
      offending;
  end if;

  -- Every one of the six must also carry the tenant column the policy reads. A policy on a
  -- table without `tenant_id` would fail at query time, not here.
  select string_agg(t.name, ', ' order by t.name)
  into offending
  from unnest(array[
    'payroll_runs', 'payslips', 'payslip_lines', 'payroll_adjustments',
    'loan_advances', 'payroll_journal_links'
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
    raise exception 'Payroll tables without a tenant_id column: %', offending;
  end if;
end
$$;

-- The global sweep: every public table is either RLS-protected or explicitly exempt.
select assert_rls_coverage();
