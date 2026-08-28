-- =====================================================================================
-- 0009 — Fee management (Phase 11)
--
-- Nine tenant-scoped tables that between them hold every taka the school ever asks for and
-- every taka it ever receives. Three properties are enforced here rather than left to the
-- application, because each is a property the application can only get wrong once:
--
--   1. **No floating point.** Every monetary column is `numeric(14, 2)`. The driver returns it
--      as a string and `Money` is the only thing that parses it (ADR-004).
--   2. **The invoice arithmetic is a database constraint, not a convention.**
--      `total = subtotal - discount_total + fine_total` and `balance = total - paid_total` are
--      check constraints. A service that recomputes a balance incorrectly fails loudly on the
--      write instead of quietly reporting the wrong dues for a term.
--   3. **Invoice generation is idempotent in the database.** `invoices.generation_key` carries
--      a deterministic key for a (year, student, billing period) and a partial unique index
--      refuses a second live invoice for it. Re-running a generation for a section is
--      therefore safe even if two clerks press the button simultaneously — the second run
--      collides rather than double-billing a family. Voided invoices are excluded from the
--      index, which is what allows a legitimate "void and re-issue".
--
-- Row-level security is applied at the bottom, with the same policy every other tenant table
-- carries. The driving loop in 0002 does not re-run for tables created later, so the policy,
-- the grants and the `set_updated_at` trigger are (re)applied here for these nine tables
-- explicitly, and `assert_rls_coverage()` is called last so a mistake fails the migration
-- rather than shipping a silently-disabled control.
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- Enumerations. Closed value sets: adding a payment method or an invoice status changes the
-- money code as well as the schema. A school's own fee *categories* are rows in `fee_heads`,
-- not values here.
-- -------------------------------------------------------------------------------------

create type public.fee_head_type as enum (
  'tuition', 'admission', 'exam', 'transport', 'library',
  'lab', 'development', 'hostel', 'fine', 'other'
);

create type public.fee_frequency as enum (
  'one_time', 'monthly', 'quarterly', 'half_yearly', 'annual'
);

create type public.fee_structure_status as enum ('draft', 'active', 'archived');

create type public.fee_concession_type as enum ('percentage', 'fixed');

create type public.fee_concession_status as enum ('pending', 'approved', 'rejected');

create type public.invoice_status as enum (
  'draft', 'issued', 'partially_paid', 'paid', 'overdue', 'void'
);

create type public.payment_method as enum (
  'cash', 'bank_transfer', 'cheque', 'bkash', 'nagad', 'rocket', 'card', 'online'
);

create type public.payment_status as enum ('pending', 'completed', 'failed', 'reversed');

-- -------------------------------------------------------------------------------------
-- Configuration: heads, structures, structure items, assignments, concessions
-- -------------------------------------------------------------------------------------

create table public.fee_heads (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  code varchar(32) not null,
  name_en varchar(128) not null,
  name_bn varchar(128),
  type public.fee_head_type default 'other' not null,
  is_recurring boolean default false not null,
  is_refundable boolean default true not null,
  ledger_account_code varchar(32),
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

create table public.fee_structures (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  campus_id uuid not null,
  academic_year_id uuid not null,
  class_level_id uuid,
  academic_group_id uuid,
  name_en varchar(128) not null,
  name_bn varchar(128),
  status public.fee_structure_status default 'draft' not null,
  effective_from date not null,
  late_fine_kind varchar(16) default 'none' not null,
  late_fine_value numeric(14, 2) default '0.00' not null,
  late_fine_grace_days smallint default 0 not null,
  late_fine_max_amount numeric(14, 2),
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.fee_structure_items (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  fee_structure_id uuid not null,
  fee_head_id uuid not null,
  amount numeric(14, 2) not null,
  frequency public.fee_frequency default 'monthly' not null,
  due_day_of_month smallint,
  is_optional boolean default false not null,
  sort_order smallint default 0 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.student_fee_assignments (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  student_id uuid not null,
  fee_structure_id uuid not null,
  academic_year_id uuid not null,
  effective_from date not null,
  effective_to date,
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

create table public.fee_concessions (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  student_id uuid not null,
  fee_head_id uuid,
  type public.fee_concession_type not null,
  value numeric(14, 2) not null,
  reason varchar(1000) not null,
  status public.fee_concession_status default 'pending' not null,
  approved_by uuid,
  approved_at timestamp with time zone,
  decision_note varchar(1000),
  valid_from date not null,
  valid_to date,
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
-- Billing: invoices, lines, payments, allocations
-- -------------------------------------------------------------------------------------

create table public.invoices (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  student_id uuid not null,
  academic_year_id uuid not null,
  fee_structure_id uuid,
  invoice_number varchar(32) not null,
  generation_key varchar(200),
  billing_period_start date not null,
  billing_period_end date not null,
  issue_date date not null,
  due_date date not null,
  subtotal numeric(14, 2) default '0.00' not null,
  discount_total numeric(14, 2) default '0.00' not null,
  fine_total numeric(14, 2) default '0.00' not null,
  total numeric(14, 2) default '0.00' not null,
  paid_total numeric(14, 2) default '0.00' not null,
  balance numeric(14, 2) default '0.00' not null,
  currency varchar(3) default 'BDT' not null,
  status public.invoice_status default 'issued' not null,
  notes varchar(1000),
  voided_reason varchar(1000),
  voided_by uuid,
  voided_at timestamp with time zone,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.invoice_lines (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  invoice_id uuid not null,
  fee_head_id uuid not null,
  description varchar(255) not null,
  amount numeric(14, 2) not null,
  discount_amount numeric(14, 2) default '0.00' not null,
  net_amount numeric(14, 2) not null,
  concession_id uuid,
  is_fine boolean default false not null,
  sort_order smallint default 0 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.payments (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  student_id uuid not null,
  receipt_number varchar(32) not null,
  amount numeric(14, 2) not null,
  currency varchar(3) default 'BDT' not null,
  method public.payment_method not null,
  reference varchar(128),
  received_by uuid,
  received_at timestamp with time zone default now() not null,
  status public.payment_status default 'completed' not null,
  notes varchar(1000),
  reversal_reason varchar(1000),
  reversed_by uuid,
  reversed_at timestamp with time zone,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.payment_allocations (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  payment_id uuid not null,
  invoice_id uuid not null,
  amount numeric(14, 2) not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

-- -------------------------------------------------------------------------------------
-- Foreign keys. `restrict` for tenancy, identity and financial parents — a fee head that has
-- been invoiced must not be removable — and `cascade` only for rows genuinely owned by their
-- parent (a structure's items, an invoice's lines, a payment's allocations).
-- -------------------------------------------------------------------------------------

alter table public.fee_heads
  add constraint fee_heads_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint fee_heads_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict;

alter table public.fee_structures
  add constraint fee_structures_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint fee_structures_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint fee_structures_campus_id_campuses_id_fk
    foreign key (campus_id) references public.campuses(id) on delete restrict,
  add constraint fee_structures_academic_year_id_academic_years_id_fk
    foreign key (academic_year_id) references public.academic_years(id) on delete restrict,
  add constraint fee_structures_class_level_id_class_levels_id_fk
    foreign key (class_level_id) references public.class_levels(id) on delete restrict,
  add constraint fee_structures_academic_group_id_academic_groups_id_fk
    foreign key (academic_group_id) references public.academic_groups(id) on delete restrict;

alter table public.fee_structure_items
  add constraint fee_structure_items_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint fee_structure_items_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint fee_structure_items_fee_structure_id_fee_structures_id_fk
    foreign key (fee_structure_id) references public.fee_structures(id) on delete cascade,
  add constraint fee_structure_items_fee_head_id_fee_heads_id_fk
    foreign key (fee_head_id) references public.fee_heads(id) on delete restrict;

alter table public.student_fee_assignments
  add constraint student_fee_assignments_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint student_fee_assignments_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint student_fee_assignments_student_id_students_id_fk
    foreign key (student_id) references public.students(id) on delete restrict,
  add constraint student_fee_assignments_fee_structure_id_fee_structures_id_fk
    foreign key (fee_structure_id) references public.fee_structures(id) on delete restrict,
  add constraint student_fee_assignments_academic_year_id_academic_years_id_fk
    foreign key (academic_year_id) references public.academic_years(id) on delete restrict;

alter table public.fee_concessions
  add constraint fee_concessions_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint fee_concessions_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint fee_concessions_student_id_students_id_fk
    foreign key (student_id) references public.students(id) on delete restrict,
  add constraint fee_concessions_fee_head_id_fee_heads_id_fk
    foreign key (fee_head_id) references public.fee_heads(id) on delete restrict;

alter table public.invoices
  add constraint invoices_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint invoices_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint invoices_student_id_students_id_fk
    foreign key (student_id) references public.students(id) on delete restrict,
  add constraint invoices_academic_year_id_academic_years_id_fk
    foreign key (academic_year_id) references public.academic_years(id) on delete restrict,
  add constraint invoices_fee_structure_id_fee_structures_id_fk
    foreign key (fee_structure_id) references public.fee_structures(id) on delete restrict;

alter table public.invoice_lines
  add constraint invoice_lines_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint invoice_lines_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint invoice_lines_invoice_id_invoices_id_fk
    foreign key (invoice_id) references public.invoices(id) on delete cascade,
  add constraint invoice_lines_fee_head_id_fee_heads_id_fk
    foreign key (fee_head_id) references public.fee_heads(id) on delete restrict,
  add constraint invoice_lines_concession_id_fee_concessions_id_fk
    foreign key (concession_id) references public.fee_concessions(id) on delete set null;

alter table public.payments
  add constraint payments_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint payments_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint payments_student_id_students_id_fk
    foreign key (student_id) references public.students(id) on delete restrict;

alter table public.payment_allocations
  add constraint payment_allocations_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint payment_allocations_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint payment_allocations_payment_id_payments_id_fk
    foreign key (payment_id) references public.payments(id) on delete cascade,
  add constraint payment_allocations_invoice_id_invoices_id_fk
    foreign key (invoice_id) references public.invoices(id) on delete restrict;

-- -------------------------------------------------------------------------------------
-- Indexes. Every foreign key the module filters or joins on has one, plus the mandatory
-- `<table>_tenant_idx`. Uniqueness on business keys is partial on `archived_at is null`, so an
-- archived fee head's code becomes reusable while the record itself is preserved (ADR-008).
-- -------------------------------------------------------------------------------------

create unique index if not exists fee_heads_institution_code_key
  on public.fee_heads using btree (institution_id, code) where archived_at is null;
create index if not exists fee_heads_tenant_idx on public.fee_heads using btree (tenant_id);
create index if not exists fee_heads_institution_type_idx
  on public.fee_heads using btree (institution_id, type);

create unique index if not exists fee_structures_year_name_key
  on public.fee_structures using btree (academic_year_id, name_en) where archived_at is null;
create index if not exists fee_structures_tenant_idx
  on public.fee_structures using btree (tenant_id);
create index if not exists fee_structures_year_class_idx
  on public.fee_structures using btree (academic_year_id, class_level_id);
create index if not exists fee_structures_institution_status_idx
  on public.fee_structures using btree (institution_id, status);
create index if not exists fee_structures_campus_idx
  on public.fee_structures using btree (campus_id);

create unique index if not exists fee_structure_items_head_key
  on public.fee_structure_items using btree (fee_structure_id, fee_head_id, frequency)
  where archived_at is null;
create index if not exists fee_structure_items_tenant_idx
  on public.fee_structure_items using btree (tenant_id);
create index if not exists fee_structure_items_structure_idx
  on public.fee_structure_items using btree (fee_structure_id);
create index if not exists fee_structure_items_head_idx
  on public.fee_structure_items using btree (fee_head_id);

create unique index if not exists student_fee_assignments_period_key
  on public.student_fee_assignments using btree (student_id, academic_year_id, effective_from)
  where archived_at is null;
create index if not exists student_fee_assignments_tenant_idx
  on public.student_fee_assignments using btree (tenant_id);
create index if not exists student_fee_assignments_student_idx
  on public.student_fee_assignments using btree (student_id, academic_year_id);
create index if not exists student_fee_assignments_structure_idx
  on public.student_fee_assignments using btree (fee_structure_id);

-- Postgres treats NULLs as distinct, so this does not stop two "all heads" concessions
-- starting on the same day. The service refuses that case explicitly; the index covers the
-- per-head case, which is the one a double-click produces.
create unique index if not exists fee_concessions_student_head_key
  on public.fee_concessions using btree (student_id, fee_head_id, valid_from)
  where status <> 'rejected' and archived_at is null;
create index if not exists fee_concessions_tenant_idx
  on public.fee_concessions using btree (tenant_id);
create index if not exists fee_concessions_student_idx
  on public.fee_concessions using btree (student_id, status);
create index if not exists fee_concessions_head_idx
  on public.fee_concessions using btree (fee_head_id);
create index if not exists fee_concessions_institution_status_idx
  on public.fee_concessions using btree (institution_id, status);

create unique index if not exists invoices_institution_number_key
  on public.invoices using btree (institution_id, invoice_number);

-- The idempotency control. A second generation run for the same academic year, student and
-- billing period produces the same key and is refused by the database, not merely skipped by
-- the service. Voided invoices drop out of the index so a corrected re-issue is possible.
create unique index if not exists invoices_generation_key
  on public.invoices using btree (institution_id, generation_key)
  where generation_key is not null and status <> 'void' and archived_at is null;

create index if not exists invoices_tenant_idx on public.invoices using btree (tenant_id);
create index if not exists invoices_student_idx
  on public.invoices using btree (student_id, due_date);
create index if not exists invoices_institution_status_idx
  on public.invoices using btree (institution_id, status, due_date);
create index if not exists invoices_year_idx on public.invoices using btree (academic_year_id);
create index if not exists invoices_structure_idx
  on public.invoices using btree (fee_structure_id);

create index if not exists invoice_lines_tenant_idx
  on public.invoice_lines using btree (tenant_id);
create index if not exists invoice_lines_invoice_idx
  on public.invoice_lines using btree (invoice_id);
create index if not exists invoice_lines_head_idx
  on public.invoice_lines using btree (fee_head_id);
create index if not exists invoice_lines_concession_idx
  on public.invoice_lines using btree (concession_id);

create unique index if not exists payments_institution_receipt_key
  on public.payments using btree (institution_id, receipt_number);
create index if not exists payments_tenant_idx on public.payments using btree (tenant_id);
create index if not exists payments_student_idx
  on public.payments using btree (student_id, received_at);
create index if not exists payments_institution_received_idx
  on public.payments using btree (institution_id, received_at, method);
create index if not exists payments_status_idx
  on public.payments using btree (institution_id, status);

create unique index if not exists payment_allocations_unique_key
  on public.payment_allocations using btree (payment_id, invoice_id) where archived_at is null;
create index if not exists payment_allocations_tenant_idx
  on public.payment_allocations using btree (tenant_id);
create index if not exists payment_allocations_invoice_idx
  on public.payment_allocations using btree (invoice_id);
create index if not exists payment_allocations_payment_idx
  on public.payment_allocations using btree (payment_id);

-- -------------------------------------------------------------------------------------
-- Data-integrity constraints that belong in the database, not only in a Zod schema.
--
-- These are the invariants where a violation would corrupt money, so they are restated here
-- even though the application computes them with `Money`. "Never trust frontend data" extends
-- to not fully trusting the backend either: if a service ever derives a balance incorrectly,
-- the write fails rather than the ledger drifting.
-- -------------------------------------------------------------------------------------

alter table public.fee_structures
  add constraint fee_structures_late_fine_kind_known
    check (late_fine_kind in ('none', 'fixed', 'percentage')),
  add constraint fee_structures_late_fine_value_non_negative check (late_fine_value >= 0),
  add constraint fee_structures_late_fine_grace_sane
    check (late_fine_grace_days between 0 and 365),
  add constraint fee_structures_late_fine_cap_non_negative
    check (late_fine_max_amount is null or late_fine_max_amount >= 0),
  -- A percentage rule is expressed with two decimals and read as basis points, so it cannot
  -- exceed 100.00 without meaning something nobody intended.
  add constraint fee_structures_late_fine_percentage_range
    check (late_fine_kind <> 'percentage' or late_fine_value <= 100);

alter table public.fee_structure_items
  add constraint fee_structure_items_amount_non_negative check (amount >= 0),
  add constraint fee_structure_items_due_day_sane
    check (due_day_of_month is null or due_day_of_month between 1 and 31);

alter table public.student_fee_assignments
  add constraint student_fee_assignments_dates_ordered
    check (effective_to is null or effective_to >= effective_from);

alter table public.fee_concessions
  add constraint fee_concessions_value_non_negative check (value >= 0),
  add constraint fee_concessions_percentage_range
    check (type <> 'percentage' or value <= 100),
  add constraint fee_concessions_dates_ordered
    check (valid_to is null or valid_to >= valid_from),
  -- An approved concession without a named approver and a timestamp is unauditable, and this
  -- is the row that reduces what a family pays.
  add constraint fee_concessions_approval_recorded
    check (status <> 'approved' or (approved_by is not null and approved_at is not null));

alter table public.invoices
  add constraint invoices_period_ordered check (billing_period_end >= billing_period_start),
  add constraint invoices_due_after_issue check (due_date >= issue_date),
  add constraint invoices_amounts_non_negative
    check (subtotal >= 0 and discount_total >= 0 and fine_total >= 0
           and total >= 0 and paid_total >= 0),
  -- A discount can never exceed what was charged: the per-line floor is restated here as a
  -- whole-invoice guarantee.
  add constraint invoices_discount_within_subtotal check (discount_total <= subtotal),
  add constraint invoices_total_is_derived
    check (total = subtotal - discount_total + fine_total),
  add constraint invoices_balance_is_derived check (balance = total - paid_total),
  add constraint invoices_void_requires_reason
    check (status <> 'void' or voided_reason is not null),
  add constraint invoices_currency_known check (currency in ('BDT', 'USD'));

alter table public.invoice_lines
  add constraint invoice_lines_amount_non_negative check (amount >= 0),
  -- The non-negative floor on a concession, enforced where it cannot be argued with.
  add constraint invoice_lines_discount_within_amount
    check (discount_amount >= 0 and discount_amount <= amount),
  add constraint invoice_lines_net_is_derived check (net_amount = amount - discount_amount);

alter table public.payments
  add constraint payments_amount_positive check (amount > 0),
  add constraint payments_currency_known check (currency in ('BDT', 'USD')),
  add constraint payments_reversal_requires_reason
    check (status <> 'reversed' or reversal_reason is not null);

alter table public.payment_allocations
  add constraint payment_allocations_amount_positive check (amount > 0);

-- -------------------------------------------------------------------------------------
-- Row-level security.
--
-- The scan in 0002 only covered the tables that existed then. These nine are enabled, forced
-- and given the identical `tenant_isolation` policy here. Both `using` and `with check` are
-- present: `using` gates which rows are visible, `with check` is what stops a session from
-- writing a row stamped with another tenant's id.
-- -------------------------------------------------------------------------------------

do $$
declare
  target text;
  fee_tables constant text[] := array[
    'fee_heads',
    'fee_structures',
    'fee_structure_items',
    'student_fee_assignments',
    'fee_concessions',
    'invoices',
    'invoice_lines',
    'payments',
    'payment_allocations'
  ];
begin
  foreach target in array fee_tables
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
      'fee_heads', 'fee_structures', 'fee_structure_items', 'student_fee_assignments',
      'fee_concessions', 'invoices', 'invoice_lines', 'payments', 'payment_allocations'
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
      'Fee tables without forced row-level security and a tenant_isolation policy: %',
      offending;
  end if;

  -- Every one of the nine must also carry the tenant column the policy reads. A policy on a
  -- table without `tenant_id` would fail at query time, not here.
  select string_agg(t.name, ', ' order by t.name)
  into offending
  from unnest(array[
    'fee_heads', 'fee_structures', 'fee_structure_items', 'student_fee_assignments',
    'fee_concessions', 'invoices', 'invoice_lines', 'payments', 'payment_allocations'
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
    raise exception 'Fee tables without a tenant_id column: %', offending;
  end if;
end
$$;

-- The global sweep: every public table is either RLS-protected or explicitly exempt.
select assert_rls_coverage();
