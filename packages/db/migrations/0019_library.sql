-- =====================================================================================
-- 0019 — Library (Phase 17)
--
-- Eight tenant-scoped tables covering catalogue, membership, circulation, reservations and
-- fines. Three properties are enforced here rather than left to the application, because each
-- is a property the application can only get wrong once:
--
--   1. **One live loan per copy.** `library_loans_copy_active_key` is a partial unique index
--      on `(copy_id) where returned_at is null`. Two clerks issuing the same physical book at
--      the same moment collide in Postgres — a unique violation surfaced as a 409 — not in an
--      application check a race can slip past.
--   2. **No floating point.** Every monetary column (`library_copies.cost`,
--      `library_loans.fine_amount`, `library_fines.amount`, `library_settings.fine_per_day`)
--      is `numeric(14, 2)`; the driver returns it as a string and `Money` is the only parser
--      (ADR-004).
--   3. **Fines are explicit, accountable facts.** A fine row can only exist with a positive
--      amount and a reason; a waived fine must name who waived it and why; an assessment run
--      is idempotent per loan per day via `library_fines_loan_day_key`. Nothing accrues by
--      itself — the per-day rate in `library_settings` charges nobody until the audited
--      assessment endpoint writes rows.
--
-- Row-level security is applied at the bottom with the same `tenant_isolation` policy every
-- other tenant table carries. The driving loop in 0002 does not re-run for tables created
-- later, so the policy, grants and `set_updated_at` trigger are applied here explicitly, and
-- `assert_rls_coverage()` is called last so a mistake fails the migration rather than
-- shipping a silently-disabled control.
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- Enumerations. Closed value sets — a new loan status changes circulation code as well as
-- the schema. A school's own book *categories* are rows in `library_categories`, not values
-- here. All names carry the `library_` prefix so collision with another module is impossible.
-- -------------------------------------------------------------------------------------

create type public.library_language as enum ('bangla', 'english', 'arabic', 'other');

create type public.library_copy_condition as enum ('new', 'good', 'fair', 'damaged', 'lost');

create type public.library_copy_status as enum (
  'available', 'issued', 'reserved', 'lost', 'withdrawn'
);

create type public.library_member_type as enum ('student', 'employee');

create type public.library_member_status as enum ('active', 'suspended', 'expired');

create type public.library_loan_status as enum ('issued', 'returned', 'overdue', 'lost');

create type public.library_reservation_status as enum (
  'active', 'fulfilled', 'cancelled', 'expired'
);

create type public.library_fine_status as enum ('pending', 'paid', 'waived');

-- -------------------------------------------------------------------------------------
-- Tables
-- -------------------------------------------------------------------------------------

create table public.library_settings (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  fine_per_day numeric(14, 2) default '2.00' not null,
  max_renewals smallint default 1 not null,
  reservation_hold_days smallint default 3 not null,
  default_loan_days smallint default 14 not null,
  default_max_books smallint default 3 not null,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.library_categories (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  name_en varchar(128) not null,
  name_bn varchar(128),
  parent_id uuid,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.library_titles (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  isbn varchar(20),
  title varchar(255) not null,
  title_bn varchar(255),
  author varchar(255),
  publisher varchar(255),
  edition varchar(64),
  language public.library_language default 'bangla' not null,
  category_id uuid,
  dewey_code varchar(32),
  cover_file_id uuid,
  total_copies integer default 0 not null,
  status varchar(16) default 'active' not null,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.library_copies (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  title_id uuid not null,
  accession_number varchar(32) not null,
  barcode varchar(64),
  acquired_on date,
  cost numeric(14, 2),
  condition public.library_copy_condition default 'good' not null,
  status public.library_copy_status default 'available' not null,
  shelf_location varchar(64),
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.library_members (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  member_type public.library_member_type not null,
  student_id uuid,
  employee_id uuid,
  card_number varchar(32) not null,
  max_books smallint default 3 not null,
  loan_days smallint default 14 not null,
  status public.library_member_status default 'active' not null,
  valid_until date,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.library_loans (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  copy_id uuid not null,
  member_id uuid not null,
  issued_by uuid,
  issued_at timestamp with time zone default now() not null,
  due_on date not null,
  returned_at timestamp with time zone,
  returned_to uuid,
  renewal_count smallint default 0 not null,
  status public.library_loan_status default 'issued' not null,
  fine_amount numeric(14, 2) default '0.00' not null,
  fine_waived_by uuid,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.library_reservations (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  title_id uuid not null,
  member_id uuid not null,
  reserved_at timestamp with time zone default now() not null,
  expires_at timestamp with time zone,
  status public.library_reservation_status default 'active' not null,
  queue_position integer not null,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.library_fines (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  loan_id uuid not null,
  member_id uuid not null,
  amount numeric(14, 2) not null,
  reason varchar(1000) not null,
  assessed_on date not null,
  is_replacement boolean default false not null,
  status public.library_fine_status default 'pending' not null,
  paid_at timestamp with time zone,
  payment_method varchar(24),
  payment_reference varchar(128),
  waived_by uuid,
  waived_at timestamp with time zone,
  waived_reason varchar(1000),
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
-- Foreign keys. `restrict` throughout: a title with copies, a copy with loans, a loan with
-- fines and a member with history must never be removable. Nothing here is owned-and-cascaded
-- — circulation rows are institutional records in their own right.
-- -------------------------------------------------------------------------------------

alter table public.library_settings
  add constraint library_settings_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint library_settings_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict;

alter table public.library_categories
  add constraint library_categories_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint library_categories_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint library_categories_parent_id_library_categories_id_fk
    foreign key (parent_id) references public.library_categories(id) on delete restrict;

alter table public.library_titles
  add constraint library_titles_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint library_titles_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint library_titles_category_id_library_categories_id_fk
    foreign key (category_id) references public.library_categories(id) on delete restrict,
  add constraint library_titles_cover_file_id_files_id_fk
    foreign key (cover_file_id) references public.files(id) on delete set null;

alter table public.library_copies
  add constraint library_copies_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint library_copies_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint library_copies_title_id_library_titles_id_fk
    foreign key (title_id) references public.library_titles(id) on delete restrict;

alter table public.library_members
  add constraint library_members_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint library_members_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint library_members_student_id_students_id_fk
    foreign key (student_id) references public.students(id) on delete restrict,
  add constraint library_members_employee_id_employees_id_fk
    foreign key (employee_id) references public.employees(id) on delete restrict;

alter table public.library_loans
  add constraint library_loans_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint library_loans_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint library_loans_copy_id_library_copies_id_fk
    foreign key (copy_id) references public.library_copies(id) on delete restrict,
  add constraint library_loans_member_id_library_members_id_fk
    foreign key (member_id) references public.library_members(id) on delete restrict;

alter table public.library_reservations
  add constraint library_reservations_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint library_reservations_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint library_reservations_title_id_library_titles_id_fk
    foreign key (title_id) references public.library_titles(id) on delete restrict,
  add constraint library_reservations_member_id_library_members_id_fk
    foreign key (member_id) references public.library_members(id) on delete restrict;

alter table public.library_fines
  add constraint library_fines_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint library_fines_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint library_fines_loan_id_library_loans_id_fk
    foreign key (loan_id) references public.library_loans(id) on delete restrict,
  add constraint library_fines_member_id_library_members_id_fk
    foreign key (member_id) references public.library_members(id) on delete restrict;

-- -------------------------------------------------------------------------------------
-- Indexes. The mandatory `<table>_tenant_idx` on every table; uniqueness on business keys is
-- partial on `archived_at is null` (ADR-008), so a withdrawn copy's accession number is
-- preserved in the record while remaining reusable if the register is ever renumbered.
-- -------------------------------------------------------------------------------------

create unique index if not exists library_settings_institution_key
  on public.library_settings using btree (institution_id) where archived_at is null;
create index if not exists library_settings_tenant_idx
  on public.library_settings using btree (tenant_id);

create unique index if not exists library_categories_institution_name_key
  on public.library_categories using btree (institution_id, name_en) where archived_at is null;
create index if not exists library_categories_tenant_idx
  on public.library_categories using btree (tenant_id);
create index if not exists library_categories_parent_idx
  on public.library_categories using btree (parent_id);

create index if not exists library_titles_tenant_idx
  on public.library_titles using btree (tenant_id);
create index if not exists library_titles_institution_status_idx
  on public.library_titles using btree (institution_id, status);
create index if not exists library_titles_category_idx
  on public.library_titles using btree (category_id);
create index if not exists library_titles_isbn_idx
  on public.library_titles using btree (institution_id, isbn);
create index if not exists library_titles_title_idx
  on public.library_titles using btree (institution_id, title);

create unique index if not exists library_copies_accession_key
  on public.library_copies using btree (institution_id, accession_number)
  where archived_at is null;
create unique index if not exists library_copies_barcode_key
  on public.library_copies using btree (institution_id, barcode)
  where barcode is not null and archived_at is null;
create index if not exists library_copies_tenant_idx
  on public.library_copies using btree (tenant_id);
create index if not exists library_copies_title_idx
  on public.library_copies using btree (title_id, status);
create index if not exists library_copies_institution_status_idx
  on public.library_copies using btree (institution_id, status);

create unique index if not exists library_members_card_key
  on public.library_members using btree (institution_id, card_number)
  where archived_at is null;
create unique index if not exists library_members_student_key
  on public.library_members using btree (student_id)
  where student_id is not null and archived_at is null;
create unique index if not exists library_members_employee_key
  on public.library_members using btree (employee_id)
  where employee_id is not null and archived_at is null;
create index if not exists library_members_tenant_idx
  on public.library_members using btree (tenant_id);
create index if not exists library_members_institution_status_idx
  on public.library_members using btree (institution_id, status);

-- THE circulation control: at most one live loan per copy, guaranteed by Postgres. It is
-- deliberately conditioned only on `returned_at is null` — archiving a live loan must not
-- free the copy for a second concurrent borrowing.
create unique index if not exists library_loans_copy_active_key
  on public.library_loans using btree (copy_id) where returned_at is null;

create index if not exists library_loans_tenant_idx
  on public.library_loans using btree (tenant_id);
create index if not exists library_loans_member_idx
  on public.library_loans using btree (member_id, status);
create index if not exists library_loans_copy_idx
  on public.library_loans using btree (copy_id);
create index if not exists library_loans_due_idx
  on public.library_loans using btree (institution_id, due_on) where returned_at is null;

create unique index if not exists library_reservations_member_title_key
  on public.library_reservations using btree (title_id, member_id)
  where status = 'active' and archived_at is null;
create index if not exists library_reservations_tenant_idx
  on public.library_reservations using btree (tenant_id);
create index if not exists library_reservations_title_queue_idx
  on public.library_reservations using btree (title_id, queue_position)
  where status = 'active';
create index if not exists library_reservations_member_idx
  on public.library_reservations using btree (member_id, status);

-- One overdue assessment per loan per day: the batch endpoint is idempotent in the database,
-- not merely skipped by the service. Replacement-cost fines (a book declared lost) live
-- outside this key so a same-day loss does not collide with the morning's assessment run.
create unique index if not exists library_fines_loan_day_key
  on public.library_fines using btree (loan_id, assessed_on)
  where archived_at is null and not is_replacement;
create index if not exists library_fines_tenant_idx
  on public.library_fines using btree (tenant_id);
create index if not exists library_fines_loan_idx
  on public.library_fines using btree (loan_id);
create index if not exists library_fines_member_idx
  on public.library_fines using btree (member_id, status);
create index if not exists library_fines_institution_status_idx
  on public.library_fines using btree (institution_id, status);

-- -------------------------------------------------------------------------------------
-- Data-integrity constraints that belong in the database, not only in a Zod schema. The
-- monetary and accountability invariants are restated here so a service bug fails the write
-- rather than corrupting a record somebody later has to explain to a parent.
-- -------------------------------------------------------------------------------------

alter table public.library_settings
  add constraint library_settings_fine_per_day_non_negative check (fine_per_day >= 0),
  add constraint library_settings_limits_sane
    check (max_renewals between 0 and 20
           and reservation_hold_days between 1 and 60
           and default_loan_days between 1 and 365
           and default_max_books between 1 and 50);

alter table public.library_titles
  add constraint library_titles_status_known check (status in ('active', 'inactive')),
  add constraint library_titles_total_copies_non_negative check (total_copies >= 0);

alter table public.library_copies
  add constraint library_copies_cost_non_negative check (cost is null or cost >= 0);

alter table public.library_members
  -- Exactly one person behind every card: a student member has a student and no employee,
  -- an employee member the reverse. There is no third case.
  add constraint library_members_exactly_one_person
    check (
      (member_type = 'student' and student_id is not null and employee_id is null)
      or (member_type = 'employee' and employee_id is not null and student_id is null)
    ),
  add constraint library_members_limits_sane
    check (max_books between 1 and 50 and loan_days between 1 and 365);

alter table public.library_loans
  add constraint library_loans_fine_non_negative check (fine_amount >= 0),
  add constraint library_loans_renewals_sane check (renewal_count between 0 and 20),
  add constraint library_loans_returned_has_time
    check (status <> 'returned' or returned_at is not null),
  add constraint library_loans_return_after_issue
    check (returned_at is null or returned_at >= issued_at);

alter table public.library_reservations
  add constraint library_reservations_queue_positive check (queue_position >= 1);

alter table public.library_fines
  add constraint library_fines_amount_positive check (amount > 0),
  -- A waived fine without a named waiver and a written reason is an unaccountable reduction
  -- in what somebody owes.
  add constraint library_fines_waive_recorded
    check (status <> 'waived' or (waived_by is not null and waived_reason is not null)),
  add constraint library_fines_paid_recorded
    check (status <> 'paid' or paid_at is not null);

-- -------------------------------------------------------------------------------------
-- Row-level security.
--
-- The scan in 0002 only covered the tables that existed then. These eight are enabled,
-- forced and given the identical `tenant_isolation` policy here. Both `using` and
-- `with check` are present: `using` gates which rows are visible, `with check` is what stops
-- a session from writing a row stamped with another tenant's id.
-- -------------------------------------------------------------------------------------

do $$
declare
  target text;
  library_tables constant text[] := array[
    'library_settings',
    'library_categories',
    'library_titles',
    'library_copies',
    'library_members',
    'library_loans',
    'library_reservations',
    'library_fines'
  ];
begin
  foreach target in array library_tables
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
      'library_settings', 'library_categories', 'library_titles', 'library_copies',
      'library_members', 'library_loans', 'library_reservations', 'library_fines'
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
      'Library tables without forced row-level security and a tenant_isolation policy: %',
      offending;
  end if;

  -- Every one of the eight must also carry the tenant column the policy reads. A policy on a
  -- table without `tenant_id` would fail at query time, not here.
  select string_agg(t.name, ', ' order by t.name)
  into offending
  from unnest(array[
    'library_settings', 'library_categories', 'library_titles', 'library_copies',
    'library_members', 'library_loans', 'library_reservations', 'library_fines'
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
    raise exception 'Library tables without a tenant_id column: %', offending;
  end if;
end
$$;

-- The global sweep: every public table is either RLS-protected or explicitly exempt.
select assert_rls_coverage();
