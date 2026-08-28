-- =====================================================================================
-- 0006 — Timetable: the weekly routine, its entries, and one-day substitutions
--
-- The routine is the document the whole school day is organised around, so the interesting
-- part of this migration is not the three tables — it is the six unique indexes that make
-- the timetable's invariants true in the database rather than only in a service:
--
--   * one *published* timetable per (institution, campus, academic year, term), which is what
--     makes "publishing archives the previous one" an enforceable claim rather than a habit;
--   * a section, a teacher and a room may each appear once per (timetable, weekday, period),
--     because a class in two rooms at once is not a display bug, it is 45 children in a
--     corridor;
--   * a substitute teacher may cover one period per date, and one entry may be covered once.
--
-- The service checks all of these first, so a coordinator sees "Ms Rahman already teaches
-- Class 7 in period 2 on Sunday" instead of a constraint name. The indexes are what hold when
-- two coordinators press Save in the same second.
--
-- Everything is written by hand and in lower case, in the style of 0002–0005, rather than
-- promoted from drizzle-kit: the RLS policies, the `set_updated_at` triggers and the check
-- constraints cannot be expressed in the schema DSL, and mixing generated and hand-written
-- SQL in one file is what `scripts/promote-migration.ts` warns against.
-- =====================================================================================

create table if not exists public.timetables (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "institution_id" uuid not null,
  "campus_id" uuid not null,
  "academic_year_id" uuid not null,
  "term_id" uuid,
  "name_en" varchar(128) not null,
  "name_bn" varchar(128),
  "status" varchar(16) default 'draft' not null,
  "effective_from" date not null,
  "published_at" timestamp with time zone,
  "published_by" uuid,
  "note" varchar(500),
  "version" integer default 1 not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "archived_at" timestamp with time zone,
  "archived_by" uuid,
  "archive_reason" varchar(500),
  "created_by" uuid,
  "updated_by" uuid,
  constraint "timetables_tenant_id_organizations_id_fk"
    foreign key ("tenant_id") references public.organizations("id") on delete restrict,
  constraint "timetables_institution_id_institutions_id_fk"
    foreign key ("institution_id") references public.institutions("id") on delete restrict,
  constraint "timetables_campus_id_campuses_id_fk"
    foreign key ("campus_id") references public.campuses("id") on delete restrict,
  constraint "timetables_academic_year_id_academic_years_id_fk"
    foreign key ("academic_year_id") references public.academic_years("id") on delete restrict,
  constraint "timetables_term_id_terms_id_fk"
    foreign key ("term_id") references public.terms("id") on delete restrict,
  -- Data-integrity constraints that belong in the database, not only in a Zod schema.
  --
  -- `status` is a varchar rather than a Postgres enum so that adding a workflow state later
  -- is a one-line migration instead of a coordinated type change; this check is what keeps
  -- the value set closed in the meantime.
  constraint "timetables_status_valid"
    check (status in ('draft', 'published', 'archived')),
  -- A published timetable without a publication timestamp cannot be audited, and "when did
  -- this routine come into force" is the first question asked after a scheduling dispute.
  constraint "timetables_published_has_timestamp"
    check (status <> 'published' or published_at is not null)
);

create table if not exists public.timetable_entries (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "institution_id" uuid not null,
  "timetable_id" uuid not null,
  "section_id" uuid not null,
  "day_of_week" smallint not null,
  "period_id" uuid not null,
  "subject_id" uuid not null,
  "employee_id" uuid,
  "room_id" uuid,
  "is_double_period" boolean default false not null,
  "note" varchar(255),
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "archived_at" timestamp with time zone,
  "archived_by" uuid,
  "archive_reason" varchar(500),
  "created_by" uuid,
  "updated_by" uuid,
  constraint "timetable_entries_tenant_id_organizations_id_fk"
    foreign key ("tenant_id") references public.organizations("id") on delete restrict,
  constraint "timetable_entries_institution_id_institutions_id_fk"
    foreign key ("institution_id") references public.institutions("id") on delete restrict,
  -- Cascade: an entry has no meaning without its timetable. Every other reference is
  -- `restrict`, because deleting a room out from under a live routine must fail loudly.
  constraint "timetable_entries_timetable_id_timetables_id_fk"
    foreign key ("timetable_id") references public.timetables("id") on delete cascade,
  constraint "timetable_entries_section_id_sections_id_fk"
    foreign key ("section_id") references public.sections("id") on delete restrict,
  constraint "timetable_entries_period_id_periods_id_fk"
    foreign key ("period_id") references public.periods("id") on delete restrict,
  constraint "timetable_entries_subject_id_subjects_id_fk"
    foreign key ("subject_id") references public.subjects("id") on delete restrict,
  constraint "timetable_entries_employee_id_employees_id_fk"
    foreign key ("employee_id") references public.employees("id") on delete restrict,
  constraint "timetable_entries_room_id_rooms_id_fk"
    foreign key ("room_id") references public.rooms("id") on delete restrict,
  -- 0 = Sunday, matching `dhakaWeekday` and `academic_years.weekend_days`. Which of those
  -- days are non-teaching is institution configuration and is deliberately not asserted here.
  constraint "timetable_entries_day_range"
    check (day_of_week between 0 and 6)
);

create table if not exists public.timetable_substitutions (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "institution_id" uuid not null,
  "entry_id" uuid not null,
  "substitution_date" date not null,
  "period_id" uuid not null,
  "substitute_employee_id" uuid not null,
  "original_employee_id" uuid,
  "reason" varchar(500) not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "archived_at" timestamp with time zone,
  "archived_by" uuid,
  "archive_reason" varchar(500),
  "created_by" uuid,
  "updated_by" uuid,
  constraint "timetable_substitutions_tenant_id_organizations_id_fk"
    foreign key ("tenant_id") references public.organizations("id") on delete restrict,
  constraint "timetable_substitutions_institution_id_institutions_id_fk"
    foreign key ("institution_id") references public.institutions("id") on delete restrict,
  constraint "timetable_substitutions_entry_id_timetable_entries_id_fk"
    foreign key ("entry_id") references public.timetable_entries("id") on delete cascade,
  constraint "timetable_substitutions_period_id_periods_id_fk"
    foreign key ("period_id") references public.periods("id") on delete restrict,
  constraint "timetable_substitutions_substitute_employee_id_employees_id_fk"
    foreign key ("substitute_employee_id") references public.employees("id") on delete restrict,
  constraint "timetable_substitutions_original_employee_id_employees_id_fk"
    foreign key ("original_employee_id") references public.employees("id") on delete restrict,
  -- A substitution is a staffing decision that is read back weeks later; "cover" is not an
  -- explanation. The same minimum is enforced by `reasonSchema` on the wire.
  constraint "timetable_substitutions_reason_present"
    check (length(btrim(reason)) >= 10),
  -- Covering yourself is a data-entry slip, never an intention.
  constraint "timetable_substitutions_not_self"
    check (original_employee_id is null or original_employee_id <> substitute_employee_id)
);

-- -------------------------------------------------------------------------------------
-- Indexes
--
-- The unique ones are the timetable's invariants; the plain ones exist because every
-- foreign key here is filtered on by at least one screen (a teacher's routine, a room's
-- occupancy, "what does Class 7 have on Sunday").
-- -------------------------------------------------------------------------------------

create unique index if not exists "timetables_published_scope_key"
  on public.timetables using btree ("institution_id", "campus_id", "academic_year_id", "term_id")
  where status = 'published' and term_id is not null and archived_at is null;

-- A second index for the null-term case: Postgres treats NULLs as distinct, so the index
-- above would happily allow any number of published year-long routines for one campus.
create unique index if not exists "timetables_published_scope_noterm_key"
  on public.timetables using btree ("institution_id", "campus_id", "academic_year_id")
  where status = 'published' and term_id is null and archived_at is null;

create unique index if not exists "timetables_institution_name_key"
  on public.timetables using btree ("institution_id", "academic_year_id", "name_en")
  where archived_at is null;

create index if not exists "timetables_tenant_idx"
  on public.timetables using btree ("tenant_id");
create index if not exists "timetables_scope_idx"
  on public.timetables using btree ("institution_id", "academic_year_id", "status");
create index if not exists "timetables_campus_idx"
  on public.timetables using btree ("campus_id");
create index if not exists "timetables_term_idx"
  on public.timetables using btree ("term_id");

-- The three clash rules. Partial on `archived_at` so that archiving an entry frees its slot
-- for reuse while the archived row is preserved (ADR-008: no hard deletes).
create unique index if not exists "timetable_entries_section_slot_key"
  on public.timetable_entries using btree ("timetable_id", "section_id", "day_of_week", "period_id")
  where archived_at is null;

create unique index if not exists "timetable_entries_teacher_slot_key"
  on public.timetable_entries using btree ("timetable_id", "employee_id", "day_of_week", "period_id")
  where employee_id is not null and archived_at is null;

create unique index if not exists "timetable_entries_room_slot_key"
  on public.timetable_entries using btree ("timetable_id", "room_id", "day_of_week", "period_id")
  where room_id is not null and archived_at is null;

create index if not exists "timetable_entries_tenant_idx"
  on public.timetable_entries using btree ("tenant_id");
create index if not exists "timetable_entries_timetable_idx"
  on public.timetable_entries using btree ("timetable_id", "day_of_week");
create index if not exists "timetable_entries_section_idx"
  on public.timetable_entries using btree ("section_id");
create index if not exists "timetable_entries_employee_idx"
  on public.timetable_entries using btree ("employee_id");
create index if not exists "timetable_entries_room_idx"
  on public.timetable_entries using btree ("room_id");
create index if not exists "timetable_entries_period_idx"
  on public.timetable_entries using btree ("period_id");
create index if not exists "timetable_entries_subject_idx"
  on public.timetable_entries using btree ("subject_id");

create unique index if not exists "timetable_substitutions_entry_date_key"
  on public.timetable_substitutions using btree ("entry_id", "substitution_date")
  where archived_at is null;

-- One substitute, one period, one date. This is why `period_id` is denormalised onto the
-- substitution: without the copy the rule would need a join, and a unique index cannot join.
create unique index if not exists "timetable_substitutions_teacher_slot_key"
  on public.timetable_substitutions using btree ("substitute_employee_id", "substitution_date", "period_id")
  where archived_at is null;

create index if not exists "timetable_substitutions_tenant_idx"
  on public.timetable_substitutions using btree ("tenant_id");
create index if not exists "timetable_substitutions_date_idx"
  on public.timetable_substitutions using btree ("institution_id", "substitution_date");
create index if not exists "timetable_substitutions_entry_idx"
  on public.timetable_substitutions using btree ("entry_id");
create index if not exists "timetable_substitutions_employee_idx"
  on public.timetable_substitutions using btree ("substitute_employee_id", "substitution_date");
create index if not exists "timetable_substitutions_period_idx"
  on public.timetable_substitutions using btree ("period_id");

-- -------------------------------------------------------------------------------------
-- Row-level security
--
-- The catalogue-driven loop in 0002 ran once and does not re-run for tables created later,
-- so each new table gets the identical policy explicitly. `with check` is not optional: it
-- is the half that stops a tenant writing a row stamped with someone else's tenant_id, and
-- omitting it fails silently — the write succeeds and the row is then invisible.
-- -------------------------------------------------------------------------------------

alter table public.timetables enable row level security;
alter table public.timetables force row level security;

drop policy if exists tenant_isolation on public.timetables;

create policy tenant_isolation on public.timetables
  for all
  using (
    app_is_platform_admin()
    or (tenant_id is not null and tenant_id = app_current_tenant_id())
  )
  with check (
    app_is_platform_admin()
    or (tenant_id is not null and tenant_id = app_current_tenant_id())
  );

alter table public.timetable_entries enable row level security;
alter table public.timetable_entries force row level security;

drop policy if exists tenant_isolation on public.timetable_entries;

create policy tenant_isolation on public.timetable_entries
  for all
  using (
    app_is_platform_admin()
    or (tenant_id is not null and tenant_id = app_current_tenant_id())
  )
  with check (
    app_is_platform_admin()
    or (tenant_id is not null and tenant_id = app_current_tenant_id())
  );

alter table public.timetable_substitutions enable row level security;
alter table public.timetable_substitutions force row level security;

drop policy if exists tenant_isolation on public.timetable_substitutions;

create policy tenant_isolation on public.timetable_substitutions
  for all
  using (
    app_is_platform_admin()
    or (tenant_id is not null and tenant_id = app_current_tenant_id())
  )
  with check (
    app_is_platform_admin()
    or (tenant_id is not null and tenant_id = app_current_tenant_id())
  );

-- Grants are inherited from the `alter default privileges` statements in 0002, so the
-- application role can already read and write these tables. Restated as an assertion below
-- rather than re-granted, so that a future change to those defaults is caught here.

-- -------------------------------------------------------------------------------------
-- `updated_at` maintenance
--
-- Same story as the RLS loop: the trigger-attaching loop in 0002 does not re-run, and an
-- `updated_at` that only moves when the application remembers to set it is worse than none.
-- -------------------------------------------------------------------------------------

drop trigger if exists set_updated_at on public.timetables;
create trigger set_updated_at before update on public.timetables
  for each row execute function set_updated_at();

drop trigger if exists set_updated_at on public.timetable_entries;
create trigger set_updated_at before update on public.timetable_entries
  for each row execute function set_updated_at();

drop trigger if exists set_updated_at on public.timetable_substitutions;
create trigger set_updated_at before update on public.timetable_substitutions
  for each row execute function set_updated_at();

-- -------------------------------------------------------------------------------------
-- Assertions — fail the migration rather than ship a silently-disabled control.
-- -------------------------------------------------------------------------------------

do $$
declare
  offending text;
  missing text;
begin
  -- Every table added here must have RLS enabled AND forced. `assert_rls_coverage()` below
  -- checks the whole schema; this checks the three tables by name, so a typo in a table name
  -- above cannot make the broader assertion pass vacuously.
  select string_agg(t.name, ', ' order by t.name)
  into offending
  from (values ('timetables'), ('timetable_entries'), ('timetable_substitutions')) as t(name)
  join pg_class c on c.relname = t.name
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  where not (c.relrowsecurity and c.relforcerowsecurity);

  if offending is not null then
    raise exception 'Timetable tables without forced row-level security: %', offending;
  end if;

  select string_agg(t.name, ', ' order by t.name)
  into missing
  from (values ('timetables'), ('timetable_entries'), ('timetable_substitutions')) as t(name)
  where not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    where c.relname = t.name
      -- Listed one at a time: `has_table_privilege` with a comma-separated list returns true
      -- when *any* of them is held, which would pass on read-only access.
      and has_table_privilege('shikkha_app', c.oid, 'SELECT')
      and has_table_privilege('shikkha_app', c.oid, 'INSERT')
      and has_table_privilege('shikkha_app', c.oid, 'UPDATE')
      and has_table_privilege('shikkha_app', c.oid, 'DELETE')
  );

  if missing is not null then
    raise exception
      'shikkha_app lacks read/write on: %. The default privileges from 0002 did not apply.',
      missing;
  end if;
end
$$;

select assert_rls_coverage();
