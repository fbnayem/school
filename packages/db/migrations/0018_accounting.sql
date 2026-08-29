-- =====================================================================================
-- 0018 — Accounting: the double-entry ledger (Phase 13)
--
-- Eight tenant-scoped tables. This is the module where a mistake is a financial
-- misstatement, so the invariants live in the database, not only in the service:
--
--   1. **A journal line is a debit or a credit — never both, never neither** — and both
--      amounts are non-negative. Check constraints.
--   2. **An entry's lines balance.** `sum(debit) = sum(credit)` is a DEFERRABLE INITIALLY
--      DEFERRED constraint trigger: a multi-line insert inside one transaction is legal,
--      an unbalanced commit is refused — even from raw SQL that bypasses the service.
--   3. **A posted entry is immutable.** Its lines cannot be inserted, updated or deleted,
--      and the entry accepts exactly one further change: being marked `reversed` with a
--      link to the mirror entry that cancels it. The same append-only philosophy as
--      `audit_logs` (0005), including the migrator-role exemption for retention.
--   4. **Nothing posts to a closed period or a closed fiscal year.** Trigger.
--   5. **Only postable (leaf) accounts take lines.** Trigger.
--   6. **Money is numeric(14,2).** No float exists anywhere in this module.
--
-- RLS is enabled, forced and given the standard `tenant_isolation` policy for every table,
-- and `assert_rls_coverage()` runs last so a mistake fails the migration rather than
-- shipping a silently-disabled control.
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- Enumerations. Closed sets only: account types and journal statuses change reporting and
-- posting code when they change. Account names, cost centres and expense categories are
-- rows a school invents, not enum values.
-- -------------------------------------------------------------------------------------

create type public.account_type as enum ('asset', 'liability', 'equity', 'income', 'expense');

create type public.account_normal_balance as enum ('debit', 'credit');

create type public.account_status as enum ('active', 'archived');

create type public.fiscal_year_status as enum ('open', 'closed');

create type public.accounting_period_status as enum ('open', 'closed');

create type public.journal_entry_status as enum ('draft', 'posted', 'reversed');

create type public.expense_claim_status as enum (
  'draft', 'submitted', 'approved', 'rejected', 'paid'
);

-- -------------------------------------------------------------------------------------
-- Tables
-- -------------------------------------------------------------------------------------

create table public.chart_of_accounts (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  code varchar(32) not null,
  name_en varchar(128) not null,
  name_bn varchar(128),
  type public.account_type not null,
  parent_account_id uuid,
  normal_balance public.account_normal_balance not null,
  is_postable boolean default true not null,
  is_system boolean default false not null,
  is_cash_equivalent boolean default false not null,
  status public.account_status default 'active' not null,
  description varchar(500),
  sort_order smallint default 0 not null,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.fiscal_years (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  name varchar(64) not null,
  start_date date not null,
  end_date date not null,
  status public.fiscal_year_status default 'open' not null,
  closed_by uuid,
  closed_at timestamp with time zone,
  reopened_by uuid,
  reopened_at timestamp with time zone,
  reopen_reason varchar(1000),
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.accounting_periods (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  fiscal_year_id uuid not null,
  name varchar(64) not null,
  start_date date not null,
  end_date date not null,
  status public.accounting_period_status default 'open' not null,
  closed_by uuid,
  closed_at timestamp with time zone,
  reopened_by uuid,
  reopened_at timestamp with time zone,
  reopen_reason varchar(1000),
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.journal_entries (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  entry_number varchar(32) not null,
  period_id uuid not null,
  entry_date date not null,
  description varchar(500) not null,
  reference_type varchar(64),
  reference_id uuid,
  status public.journal_entry_status default 'draft' not null,
  posted_by uuid,
  posted_at timestamp with time zone,
  reversed_by_entry_id uuid,
  is_system_generated boolean default false not null,
  source_module varchar(32) default 'accounting' not null,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.journal_lines (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  entry_id uuid not null,
  account_id uuid not null,
  debit numeric(14, 2) default '0.00' not null,
  credit numeric(14, 2) default '0.00' not null,
  description varchar(255),
  cost_centre_id uuid,
  sort_order smallint default 0 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.cost_centres (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  code varchar(32) not null,
  name_en varchar(128) not null,
  name_bn varchar(128),
  parent_id uuid,
  description varchar(500),
  sort_order smallint default 0 not null,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.budgets (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  fiscal_year_id uuid not null,
  account_id uuid not null,
  cost_centre_id uuid,
  amount numeric(14, 2) not null,
  note varchar(500),
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.expense_claims (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  claim_number varchar(32) not null,
  employee_id uuid not null,
  amount numeric(14, 2) not null,
  category varchar(64) not null,
  description varchar(1000) not null,
  expense_date date not null,
  status public.expense_claim_status default 'draft' not null,
  submitted_at timestamp with time zone,
  decided_by uuid,
  decided_at timestamp with time zone,
  decision_note varchar(1000),
  paid_by uuid,
  paid_at timestamp with time zone,
  payment_journal_entry_id uuid,
  workflow_request_id uuid,
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
-- Foreign keys. `restrict` throughout for financial parents — an account with postings, a
-- period with entries, an employee with claims must never be removable — and `cascade` only
-- for journal lines, which are genuinely owned by their entry (and even then the entry
-- itself refuses deletion by trigger).
--
-- `expense_claims.workflow_request_id` deliberately has NO foreign key: the workflow engine
-- is an optional integration owned by another module, and the ledger must keep working —
-- and this migration must keep applying — whether or not it is installed.
-- -------------------------------------------------------------------------------------

alter table public.chart_of_accounts
  add constraint chart_of_accounts_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint chart_of_accounts_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint chart_of_accounts_parent_account_id_chart_of_accounts_id_fk
    foreign key (parent_account_id) references public.chart_of_accounts(id) on delete restrict;

alter table public.fiscal_years
  add constraint fiscal_years_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint fiscal_years_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict;

alter table public.accounting_periods
  add constraint accounting_periods_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint accounting_periods_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint accounting_periods_fiscal_year_id_fiscal_years_id_fk
    foreign key (fiscal_year_id) references public.fiscal_years(id) on delete restrict;

alter table public.journal_entries
  add constraint journal_entries_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint journal_entries_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint journal_entries_period_id_accounting_periods_id_fk
    foreign key (period_id) references public.accounting_periods(id) on delete restrict,
  add constraint journal_entries_reversed_by_entry_id_journal_entries_id_fk
    foreign key (reversed_by_entry_id) references public.journal_entries(id) on delete restrict;

alter table public.journal_lines
  add constraint journal_lines_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint journal_lines_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint journal_lines_entry_id_journal_entries_id_fk
    foreign key (entry_id) references public.journal_entries(id) on delete cascade,
  add constraint journal_lines_account_id_chart_of_accounts_id_fk
    foreign key (account_id) references public.chart_of_accounts(id) on delete restrict,
  add constraint journal_lines_cost_centre_id_cost_centres_id_fk
    foreign key (cost_centre_id) references public.cost_centres(id) on delete restrict;

alter table public.cost_centres
  add constraint cost_centres_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint cost_centres_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint cost_centres_parent_id_cost_centres_id_fk
    foreign key (parent_id) references public.cost_centres(id) on delete restrict;

alter table public.budgets
  add constraint budgets_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint budgets_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint budgets_fiscal_year_id_fiscal_years_id_fk
    foreign key (fiscal_year_id) references public.fiscal_years(id) on delete restrict,
  add constraint budgets_account_id_chart_of_accounts_id_fk
    foreign key (account_id) references public.chart_of_accounts(id) on delete restrict,
  add constraint budgets_cost_centre_id_cost_centres_id_fk
    foreign key (cost_centre_id) references public.cost_centres(id) on delete restrict;

alter table public.expense_claims
  add constraint expense_claims_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint expense_claims_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint expense_claims_employee_id_employees_id_fk
    foreign key (employee_id) references public.employees(id) on delete restrict,
  add constraint expense_claims_payment_journal_entry_id_journal_entries_id_fk
    foreign key (payment_journal_entry_id) references public.journal_entries(id)
    on delete restrict;

-- -------------------------------------------------------------------------------------
-- Indexes. Partial unique keys on `archived_at is null` free a code for reuse while
-- preserving the record (ADR-008). Entry and claim numbers are NOT partial: a document
-- number is never reused, archived or not.
-- -------------------------------------------------------------------------------------

create unique index if not exists chart_of_accounts_institution_code_key
  on public.chart_of_accounts using btree (institution_id, code) where archived_at is null;
create index if not exists chart_of_accounts_tenant_idx
  on public.chart_of_accounts using btree (tenant_id);
create index if not exists chart_of_accounts_institution_type_idx
  on public.chart_of_accounts using btree (institution_id, type);
create index if not exists chart_of_accounts_parent_idx
  on public.chart_of_accounts using btree (parent_account_id);

create unique index if not exists fiscal_years_institution_name_key
  on public.fiscal_years using btree (institution_id, name) where archived_at is null;
create index if not exists fiscal_years_tenant_idx
  on public.fiscal_years using btree (tenant_id);
create index if not exists fiscal_years_institution_status_idx
  on public.fiscal_years using btree (institution_id, status);

create unique index if not exists accounting_periods_year_name_key
  on public.accounting_periods using btree (fiscal_year_id, name) where archived_at is null;
create index if not exists accounting_periods_tenant_idx
  on public.accounting_periods using btree (tenant_id);
create index if not exists accounting_periods_year_idx
  on public.accounting_periods using btree (fiscal_year_id);
create index if not exists accounting_periods_institution_dates_idx
  on public.accounting_periods using btree (institution_id, start_date);

create unique index if not exists journal_entries_institution_number_key
  on public.journal_entries using btree (institution_id, entry_number);
create index if not exists journal_entries_tenant_idx
  on public.journal_entries using btree (tenant_id);
create index if not exists journal_entries_period_idx
  on public.journal_entries using btree (period_id);
create index if not exists journal_entries_institution_status_idx
  on public.journal_entries using btree (institution_id, status, entry_date);
create index if not exists journal_entries_reference_idx
  on public.journal_entries using btree (reference_type, reference_id);
create index if not exists journal_entries_date_idx
  on public.journal_entries using btree (institution_id, entry_date);

create index if not exists journal_lines_tenant_idx
  on public.journal_lines using btree (tenant_id);
create index if not exists journal_lines_entry_idx
  on public.journal_lines using btree (entry_id);
create index if not exists journal_lines_account_idx
  on public.journal_lines using btree (account_id);
create index if not exists journal_lines_cost_centre_idx
  on public.journal_lines using btree (cost_centre_id);

create unique index if not exists cost_centres_institution_code_key
  on public.cost_centres using btree (institution_id, code) where archived_at is null;
create index if not exists cost_centres_tenant_idx
  on public.cost_centres using btree (tenant_id);
create index if not exists cost_centres_parent_idx
  on public.cost_centres using btree (parent_id);

-- NULL cost centres compare as distinct here, so the "whole institution" duplicate is
-- refused by the service explicitly, the same way fee_concessions handles its NULL head.
create unique index if not exists budgets_year_account_key
  on public.budgets using btree (fiscal_year_id, account_id, cost_centre_id)
  where archived_at is null;
create index if not exists budgets_tenant_idx on public.budgets using btree (tenant_id);
create index if not exists budgets_year_idx on public.budgets using btree (fiscal_year_id);
create index if not exists budgets_account_idx on public.budgets using btree (account_id);

create unique index if not exists expense_claims_institution_number_key
  on public.expense_claims using btree (institution_id, claim_number);
create index if not exists expense_claims_tenant_idx
  on public.expense_claims using btree (tenant_id);
create index if not exists expense_claims_employee_idx
  on public.expense_claims using btree (employee_id, status);
create index if not exists expense_claims_institution_status_idx
  on public.expense_claims using btree (institution_id, status);
create index if not exists expense_claims_workflow_idx
  on public.expense_claims using btree (workflow_request_id);

-- -------------------------------------------------------------------------------------
-- Check constraints. The invariants a violation of which corrupts money, restated where
-- they cannot be argued with — even a bug in the service fails the write instead of
-- misstating the books.
-- -------------------------------------------------------------------------------------

alter table public.fiscal_years
  add constraint fiscal_years_dates_ordered check (end_date >= start_date),
  -- A closed year without a named closer and a timestamp is unauditable.
  add constraint fiscal_years_closed_recorded
    check (status <> 'closed' or (closed_by is not null and closed_at is not null));

alter table public.accounting_periods
  add constraint accounting_periods_dates_ordered check (end_date >= start_date),
  add constraint accounting_periods_closed_recorded
    check (status <> 'closed' or (closed_by is not null and closed_at is not null));

alter table public.journal_entries
  -- A posted (or reversed — which is a posted entry with a cancelled effect) entry always
  -- records when it was posted.
  add constraint journal_entries_posted_recorded
    check (status = 'draft' or posted_at is not null),
  -- A reversed entry always links the mirror entry that cancelled it.
  add constraint journal_entries_reversed_linked
    check (status <> 'reversed' or reversed_by_entry_id is not null),
  add constraint journal_entries_not_self_reversed
    check (reversed_by_entry_id is null or reversed_by_entry_id <> id);

alter table public.journal_lines
  -- Invariant 1: exactly one side of the line is non-zero. `(debit = 0) <> (credit = 0)`
  -- is false when both are zero and false when both are non-zero.
  add constraint journal_lines_debit_xor_credit check ((debit = 0) <> (credit = 0)),
  -- Invariant 2: negative amounts are forbidden; the *side* expresses the direction.
  add constraint journal_lines_amounts_non_negative check (debit >= 0 and credit >= 0);

alter table public.budgets
  add constraint budgets_amount_non_negative check (amount >= 0);

alter table public.expense_claims
  add constraint expense_claims_amount_positive check (amount > 0),
  add constraint expense_claims_submitted_recorded
    check (status = 'draft' or submitted_at is not null),
  add constraint expense_claims_decision_recorded
    check (status in ('draft', 'submitted')
           or (decided_by is not null and decided_at is not null)),
  -- A paid claim always carries the ledger entry that recorded the payout.
  add constraint expense_claims_paid_recorded
    check (status <> 'paid'
           or (paid_at is not null and payment_journal_entry_id is not null));

-- -------------------------------------------------------------------------------------
-- Trigger: an entry's lines must balance (invariant 3).
--
-- A DEFERRABLE INITIALLY DEFERRED constraint trigger, so the natural way of writing an
-- entry — insert several lines inside one transaction — is legal, and only an unbalanced
-- COMMIT is refused. The function runs with the caller's privileges under RLS, which is
-- fine: an entry's lines are always in the caller's own tenant.
-- -------------------------------------------------------------------------------------

create or replace function journal_lines_assert_balanced() returns trigger
language plpgsql
as $$
declare
  target_entry uuid;
  debit_total numeric(14, 2);
  credit_total numeric(14, 2);
begin
  target_entry := coalesce(new.entry_id, old.entry_id);

  select coalesce(sum(debit), 0), coalesce(sum(credit), 0)
    into debit_total, credit_total
    from public.journal_lines
   where entry_id = target_entry
     and archived_at is null;

  if debit_total <> credit_total then
    raise exception
      'journal entry % does not balance: debits % <> credits %',
      target_entry, debit_total, credit_total
      using errcode = 'check_violation',
            constraint = 'journal_entries_balanced';
  end if;

  return null;
end
$$;

create constraint trigger journal_entries_balanced
  after insert or update or delete on public.journal_lines
  deferrable initially deferred
  for each row execute function journal_lines_assert_balanced();

-- -------------------------------------------------------------------------------------
-- Trigger: a posted entry's lines are immutable, and lines are never hard-deleted
-- (invariant 4). The migrator role is exempt, exactly as it is for audit_logs (0005), so
-- retention and demo resets still work; the application role never is.
-- -------------------------------------------------------------------------------------

create or replace function journal_lines_guard_mutation() returns trigger
language plpgsql
as $$
declare
  parent_status public.journal_entry_status;
begin
  if pg_has_role(current_user, 'shikkha_migrator', 'MEMBER') then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  -- Hard deletes are forbidden outright: a draft's lines are archived, a posted entry's
  -- lines are permanent.
  if tg_op = 'DELETE' then
    raise exception
      'journal lines are never deleted; archive a draft line or reverse a posted entry'
      using errcode = 'insufficient_privilege';
  end if;

  -- On UPDATE check the old parent as well, so a line cannot be smuggled out of a posted
  -- entry by re-pointing its entry_id.
  if tg_op = 'UPDATE' then
    select status into parent_status
      from public.journal_entries where id = old.entry_id;
    if parent_status in ('posted', 'reversed') then
      raise exception
        'journal entry % is % and its lines are immutable; correct it with a reversing entry',
        old.entry_id, parent_status
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  select status into parent_status
    from public.journal_entries where id = new.entry_id;
  if parent_status in ('posted', 'reversed') then
    raise exception
      'journal entry % is % and its lines are immutable; correct it with a reversing entry',
      new.entry_id, parent_status
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end
$$;

create trigger journal_lines_immutable_when_posted
  before insert or update or delete on public.journal_lines
  for each row execute function journal_lines_guard_mutation();

-- -------------------------------------------------------------------------------------
-- Trigger: only postable, active leaf accounts of the same institution take lines
-- (invariant 6).
-- -------------------------------------------------------------------------------------

create or replace function journal_lines_assert_postable() returns trigger
language plpgsql
as $$
declare
  target record;
begin
  select is_postable, status, archived_at, institution_id
    into target
    from public.chart_of_accounts
   where id = new.account_id;

  if target is null then
    raise exception 'journal line names an unknown account %', new.account_id
      using errcode = 'foreign_key_violation';
  end if;

  if not target.is_postable then
    raise exception
      'account % is a header account and is not postable; post to a leaf account',
      new.account_id
      using errcode = 'check_violation',
            constraint = 'journal_lines_account_postable';
  end if;

  if target.status <> 'active' or target.archived_at is not null then
    raise exception 'account % is archived and no longer accepts postings', new.account_id
      using errcode = 'check_violation',
            constraint = 'journal_lines_account_postable';
  end if;

  if target.institution_id <> new.institution_id then
    raise exception 'account % belongs to a different institution', new.account_id
      using errcode = 'check_violation',
            constraint = 'journal_lines_account_postable';
  end if;

  return new;
end
$$;

create trigger journal_lines_postable_account
  before insert or update on public.journal_lines
  for each row execute function journal_lines_assert_postable();

-- -------------------------------------------------------------------------------------
-- Trigger: a posted journal entry is immutable and entries are never deleted
-- (invariant 4, entry side). One transition is allowed out of `posted`: to `reversed`,
-- with the link to the mirror entry set and every substantive field untouched.
-- -------------------------------------------------------------------------------------

create or replace function journal_entries_guard_mutation() returns trigger
language plpgsql
as $$
begin
  if pg_has_role(current_user, 'shikkha_migrator', 'MEMBER') then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    raise exception
      'journal entries are never deleted; a wrong entry is corrected with a reversing entry'
      using errcode = 'insufficient_privilege';
  end if;

  if old.status = 'reversed' then
    raise exception 'journal entry % is reversed and fully immutable', old.id
      using errcode = 'insufficient_privilege';
  end if;

  if old.status = 'posted' then
    -- The single legal change: marking the entry reversed and linking the mirror entry.
    if new.status = 'reversed'
       and new.reversed_by_entry_id is not null
       and new.tenant_id = old.tenant_id
       and new.institution_id = old.institution_id
       and new.entry_number = old.entry_number
       and new.period_id = old.period_id
       and new.entry_date = old.entry_date
       and new.description = old.description
       and new.reference_type is not distinct from old.reference_type
       and new.reference_id is not distinct from old.reference_id
       and new.posted_by is not distinct from old.posted_by
       and new.posted_at is not distinct from old.posted_at
       and new.is_system_generated = old.is_system_generated
       and new.source_module = old.source_module
       and new.archived_at is null
    then
      return new;
    end if;

    raise exception
      'journal entry % is posted and immutable; correct it with a reversing entry', old.id
      using errcode = 'insufficient_privilege';
  end if;

  -- Draft transitions.
  if old.status = 'draft' and new.status = 'reversed' then
    raise exception 'a draft entry cannot be reversed; it has had no effect to reverse'
      using errcode = 'check_violation';
  end if;

  if old.status = 'draft' and new.status = 'posted' then
    if new.posted_at is null then
      raise exception 'posting an entry must record when it was posted'
        using errcode = 'check_violation';
    end if;
    if not exists (
      select 1 from public.journal_lines
       where entry_id = old.id and archived_at is null
    ) then
      raise exception 'journal entry % has no lines and cannot be posted', old.id
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end
$$;

create trigger journal_entries_immutable_when_posted
  before update or delete on public.journal_entries
  for each row execute function journal_entries_guard_mutation();

-- -------------------------------------------------------------------------------------
-- Trigger: nothing enters — and nothing posts in — a closed period or a closed fiscal
-- year (invariant 5), and an entry's date must lie inside its period. Marking an old
-- entry `reversed` remains legal even in a closed period: the money movement is the
-- reversing entry, which is itself checked when it is inserted into an open period.
-- -------------------------------------------------------------------------------------

create or replace function journal_entries_assert_period_open() returns trigger
language plpgsql
as $$
declare
  target record;
  must_check boolean;
begin
  must_check :=
    tg_op = 'INSERT'
    or new.period_id is distinct from old.period_id
    or new.entry_date is distinct from old.entry_date
    or (new.status is distinct from old.status and new.status = 'posted');

  if not must_check then
    return new;
  end if;

  select p.status as period_status,
         p.start_date,
         p.end_date,
         p.archived_at as period_archived_at,
         p.institution_id as period_institution_id,
         y.status as year_status,
         y.archived_at as year_archived_at
    into target
    from public.accounting_periods p
    join public.fiscal_years y on y.id = p.fiscal_year_id
   where p.id = new.period_id;

  if target is null then
    raise exception 'journal entry names an unknown accounting period %', new.period_id
      using errcode = 'foreign_key_violation';
  end if;

  if target.period_status <> 'open' or target.period_archived_at is not null then
    raise exception 'accounting period % is closed and accepts no journal entries',
      new.period_id
      using errcode = 'check_violation',
            constraint = 'journal_entries_period_open';
  end if;

  if target.year_status <> 'open' or target.year_archived_at is not null then
    raise exception 'the fiscal year of period % is closed and accepts no journal entries',
      new.period_id
      using errcode = 'check_violation',
            constraint = 'journal_entries_period_open';
  end if;

  if new.entry_date < target.start_date or new.entry_date > target.end_date then
    raise exception 'entry date % lies outside period % (% to %)',
      new.entry_date, new.period_id, target.start_date, target.end_date
      using errcode = 'check_violation',
            constraint = 'journal_entries_period_open';
  end if;

  if target.period_institution_id <> new.institution_id then
    raise exception 'period % belongs to a different institution', new.period_id
      using errcode = 'check_violation',
            constraint = 'journal_entries_period_open';
  end if;

  return new;
end
$$;

create trigger journal_entries_period_must_be_open
  before insert or update on public.journal_entries
  for each row execute function journal_entries_assert_period_open();

-- -------------------------------------------------------------------------------------
-- Row-level security: enable + force + the standard tenant_isolation policy + grants +
-- updated_at trigger, per table. The catalogue loop in 0002 does not re-run for tables
-- created later, so it is restated here.
-- -------------------------------------------------------------------------------------

do $$
declare
  target text;
  accounting_tables constant text[] := array[
    'chart_of_accounts',
    'fiscal_years',
    'accounting_periods',
    'journal_entries',
    'journal_lines',
    'cost_centres',
    'budgets',
    'expense_claims'
  ];
begin
  foreach target in array accounting_tables
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
      'chart_of_accounts', 'fiscal_years', 'accounting_periods', 'journal_entries',
      'journal_lines', 'cost_centres', 'budgets', 'expense_claims'
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
      'Accounting tables without forced row-level security and a tenant_isolation policy: %',
      offending;
  end if;

  -- Every one of the eight must also carry the tenant column the policy reads. A policy on a
  -- table without `tenant_id` would fail at query time, not here.
  select string_agg(t.name, ', ' order by t.name)
  into offending
  from unnest(array[
    'chart_of_accounts', 'fiscal_years', 'accounting_periods', 'journal_entries',
    'journal_lines', 'cost_centres', 'budgets', 'expense_claims'
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
    raise exception 'Accounting tables without a tenant_id column: %', offending;
  end if;
end
$$;

-- The global sweep: every public table is either RLS-protected or explicitly exempt.
select assert_rls_coverage();
