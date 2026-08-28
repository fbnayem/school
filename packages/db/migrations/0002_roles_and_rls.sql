-- =====================================================================================
-- 0002 — Database roles, Row-Level Security, and the append-only audit log
--
-- This is the migration that makes tenant isolation a property of the database rather than a
-- property of the application's discipline. It must be reviewed carefully, because two
-- subtle mistakes here silently disable everything below:
--
--   1. RLS does not apply to a table's OWNER unless FORCE ROW LEVEL SECURITY is set.
--      The application therefore connects as `shikkha_app`, which owns nothing, and every
--      tenant-scoped table is additionally FORCEd so a future ownership change cannot
--      quietly reopen the hole.
--   2. A role with BYPASSRLS ignores every policy. `shikkha_app` must never have it.
--      There is an assertion at the bottom of this file that fails the migration if it does.
--
-- The policy predicate reads `current_setting('app.tenant_id')`, which the application sets
-- with SET LOCAL at the start of every tenant transaction (see `withTenantContext`). Outside
-- such a transaction the setting is empty and the policies return **zero rows** — a query
-- that forgets its context fails closed.
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- Roles
--
-- Created idempotently: CREATE ROLE has no IF NOT EXISTS, and in managed environments
-- (RDS, Cloud SQL, a shared dev cluster) the roles may already exist.
-- -------------------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'shikkha_app') then
    create role shikkha_app nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'shikkha_migrator') then
    create role shikkha_migrator nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'shikkha_readonly') then
    create role shikkha_readonly nologin;
  end if;
end
$$;

-- Belt and braces: strip BYPASSRLS if it was ever granted by hand.
alter role shikkha_app nobypassrls;
alter role shikkha_readonly nobypassrls;

grant usage on schema public to shikkha_app, shikkha_readonly;

-- The application may read and write business data, but never change structure.
grant select, insert, update, delete on all tables in schema public to shikkha_app;
grant usage, select on all sequences in schema public to shikkha_app;

grant select on all tables in schema public to shikkha_readonly;

-- Tables created by later migrations inherit the same grants automatically.
alter default privileges in schema public
  grant select, insert, update, delete on tables to shikkha_app;
alter default privileges in schema public
  grant usage, select on sequences to shikkha_app;
alter default privileges in schema public
  grant select on tables to shikkha_readonly;

-- -------------------------------------------------------------------------------------
-- Context helpers
--
-- `current_tenant_id()` returns NULL rather than raising when the setting is absent, so the
-- policy expression evaluates to NULL → false → no rows, instead of erroring out. Marked
-- STABLE so the planner can cache it within a statement.
-- -------------------------------------------------------------------------------------

create or replace function app_current_tenant_id() returns uuid
language sql stable
as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

create or replace function app_is_platform_admin() returns boolean
language sql stable
as $$
  select coalesce(nullif(current_setting('app.is_platform_admin', true), ''), 'off')::boolean
$$;

create or replace function app_current_user_id() returns uuid
language sql stable
as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- -------------------------------------------------------------------------------------
-- Enable RLS on every tenant-scoped table
--
-- Driven by a catalogue query rather than a hand-maintained list: any table that has a
-- `tenant_id` column gets a policy. A new table added in a later migration is covered by
-- re-running this block, and `test/schema-conformance.spec.ts` fails the build if a business
-- table lacks the column in the first place.
-- -------------------------------------------------------------------------------------

do $$
declare
  target record;
begin
  for target in
    select c.relname as table_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid
    where n.nspname = 'public'
      and c.relkind = 'r'
      and a.attname = 'tenant_id'
      and a.attnum > 0
      and not a.attisdropped
  loop
    execute format('alter table public.%I enable row level security', target.table_name);
    execute format('alter table public.%I force row level security', target.table_name);

    execute format('drop policy if exists tenant_isolation on public.%I', target.table_name);

    -- One policy covering all four commands. USING gates what existing rows are visible to
    -- SELECT/UPDATE/DELETE; WITH CHECK gates what INSERT/UPDATE may write, which is what
    -- stops a tenant from writing a row stamped with someone else's tenant_id.
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
    $p$, target.table_name);
  end loop;
end
$$;

-- -------------------------------------------------------------------------------------
-- Tables whose tenant_id is nullable need a policy that accounts for platform-owned rows.
--
-- `users` holds platform staff with tenant_id IS NULL; `sessions` and `auth_tokens` hang off
-- them. The generic policy above would make those rows invisible to everyone including the
-- platform admin path, so they are replaced with a variant that admits NULL-tenant rows only
-- when the caller is a platform admin.
-- -------------------------------------------------------------------------------------

do $$
declare
  target text;
begin
  foreach target in array array['users', 'sessions', 'auth_tokens', 'audit_logs'] loop
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
  end loop;
end
$$;

-- `security_events` is written before authentication succeeds — a failed login has no tenant
-- and no user. It is therefore insertable by the application regardless of context, but
-- readable only within a tenant or by a platform admin. Without the permissive INSERT policy,
-- brute-force attempts would go unrecorded, which defeats the purpose of the table.
alter table public.security_events enable row level security;
alter table public.security_events force row level security;
drop policy if exists tenant_isolation on public.security_events;

create policy security_events_insert on public.security_events
  for insert
  with check (true);

create policy security_events_read on public.security_events
  for select
  using (
    app_is_platform_admin()
    or (tenant_id is not null and tenant_id = app_current_tenant_id())
  );

-- -------------------------------------------------------------------------------------
-- Platform-level tables carry no tenant_id and are readable by every authenticated session
-- (they hold no tenant data), but writable only by the migrator and platform admins.
-- -------------------------------------------------------------------------------------

alter table public.plans enable row level security;
alter table public.plans force row level security;
drop policy if exists plans_read on public.plans;
create policy plans_read on public.plans for select using (true);
drop policy if exists plans_write on public.plans;
create policy plans_write on public.plans for all
  using (app_is_platform_admin()) with check (app_is_platform_admin());

alter table public.feature_flags enable row level security;
alter table public.feature_flags force row level security;
drop policy if exists feature_flags_read on public.feature_flags;
create policy feature_flags_read on public.feature_flags for select using (true);
drop policy if exists feature_flags_write on public.feature_flags;
create policy feature_flags_write on public.feature_flags for all
  using (app_is_platform_admin()) with check (app_is_platform_admin());

-- -------------------------------------------------------------------------------------
-- Append-only audit log
--
-- The application has no update or delete path for `audit_logs`, but "the application has no
-- path" is a statement about today's code. Revoking the privilege makes it a statement about
-- the database. Retention/archival runs as `shikkha_migrator`, which retains DELETE.
-- -------------------------------------------------------------------------------------

revoke update, delete on public.audit_logs from shikkha_app;
revoke update, delete on public.security_events from shikkha_app;

-- A trigger catches the case where a future migration re-grants the privilege by accident.
create or replace function audit_logs_reject_mutation() returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_logs is append-only; % is not permitted', tg_op
    using errcode = 'insufficient_privilege';
end
$$;

drop trigger if exists audit_logs_no_update on public.audit_logs;
create trigger audit_logs_no_update
  before update or delete on public.audit_logs
  for each row execute function audit_logs_reject_mutation();

-- -------------------------------------------------------------------------------------
-- Data-integrity constraints that belong in the database, not only in a Zod schema.
--
-- These are the invariants where a violation would corrupt reporting or money, so they are
-- restated here even though the application validates them too. "Never trust frontend data"
-- extends to not fully trusting the backend either.
-- -------------------------------------------------------------------------------------

alter table public.academic_years
  add constraint academic_years_dates_ordered check (end_date > start_date);

alter table public.terms
  add constraint terms_dates_ordered check (end_date >= start_date),
  add constraint terms_weight_range check (weight_basis_points between 0 and 10000);

alter table public.calendar_events
  add constraint calendar_events_dates_ordered check (end_date >= start_date);

alter table public.shifts
  add constraint shifts_times_ordered check (end_time > start_time);

alter table public.periods
  add constraint periods_times_ordered check (end_time > start_time);

alter table public.class_subjects
  add constraint class_subjects_marks_positive check (full_marks > 0),
  add constraint class_subjects_pass_within_full check (pass_marks between 0 and full_marks),
  add constraint class_subjects_periods_sane check (periods_per_week between 0 and 40);

alter table public.sections
  add constraint sections_capacity_positive check (capacity is null or capacity > 0);

alter table public.students
  -- A student born in the future, or implausibly long ago, is a data-entry error.
  add constraint students_dob_sane check (
    date_of_birth > date '1950-01-01' and date_of_birth < current_date
  ),
  add constraint students_admission_after_birth check (admission_date >= date_of_birth);

alter table public.enrollments
  add constraint enrollments_end_after_start check (ended_on is null or ended_on >= enrolled_on);

alter table public.employees
  add constraint employees_dates_ordered check (
    confirmation_date is null or joining_date is null or confirmation_date >= joining_date
  ),
  add constraint employees_last_day_after_joining check (
    last_working_date is null or last_working_date >= joining_date
  );

alter table public.files
  add constraint files_size_positive check (size_bytes >= 0);

alter table public.sessions
  add constraint sessions_expiry_after_creation check (expires_at > created_at);

alter table public.auth_tokens
  add constraint auth_tokens_expiry_after_creation check (expires_at > created_at);

alter table public.users
  add constraint users_failed_attempts_non_negative check (failed_login_attempts >= 0);

alter table public.class_levels
  add constraint class_levels_ordinal_sane check (ordinal between 0 and 30);

-- -------------------------------------------------------------------------------------
-- Full-text search support (Phase 59 groundwork).
--
-- A generated column keeps the vector in sync automatically, so there is no trigger to forget
-- and no chance of a stale index after a bulk import. Bangla text is indexed with the
-- 'simple' configuration because Postgres ships no Bengali stemmer; that gives exact-token
-- matching, which is the correct behaviour for names.
-- -------------------------------------------------------------------------------------

alter table public.students
  add column if not exists search_vector tsvector
  generated always as (
    setweight(to_tsvector('simple', coalesce(full_name_en, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(full_name_bn, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(student_code, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(admission_number, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(phone, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(father_name_en, '')), 'D') ||
    setweight(to_tsvector('simple', coalesce(mother_name_en, '')), 'D')
  ) stored;

create index if not exists students_search_idx
  on public.students using gin (search_vector);

alter table public.employees
  add column if not exists search_vector tsvector
  generated always as (
    setweight(to_tsvector('simple', coalesce(full_name_en, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(full_name_bn, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(employee_code, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(phone, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(email, '')), 'C')
  ) stored;

create index if not exists employees_search_idx
  on public.employees using gin (search_vector);

alter table public.guardians
  add column if not exists search_vector tsvector
  generated always as (
    setweight(to_tsvector('simple', coalesce(full_name_en, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(full_name_bn, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(phone, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(email, '')), 'C')
  ) stored;

create index if not exists guardians_search_idx
  on public.guardians using gin (search_vector);

-- -------------------------------------------------------------------------------------
-- updated_at maintenance
--
-- Done in a trigger rather than in the application, because a bulk UPDATE issued by an
-- import job or a maintenance script must also move the timestamp.
-- -------------------------------------------------------------------------------------

create or replace function set_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

do $$
declare
  target record;
begin
  for target in
    select c.relname as table_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid
    where n.nspname = 'public'
      and c.relkind = 'r'
      and a.attname = 'updated_at'
      and a.attnum > 0
      and not a.attisdropped
      and c.relname <> 'audit_logs'
  loop
    execute format('drop trigger if exists set_updated_at on public.%I', target.table_name);
    execute format(
      'create trigger set_updated_at before update on public.%I
         for each row execute function set_updated_at()',
      target.table_name
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
  -- 1. The application role must not be able to bypass RLS.
  if exists (select 1 from pg_roles where rolname = 'shikkha_app' and rolbypassrls) then
    raise exception 'shikkha_app has BYPASSRLS; tenant isolation would be disabled';
  end if;

  -- 2. Every table with a tenant_id must have RLS enabled AND forced.
  select string_agg(c.relname, ', ')
  into offending
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid
  where n.nspname = 'public'
    and c.relkind = 'r'
    and a.attname = 'tenant_id'
    and a.attnum > 0
    and not a.attisdropped
    and (c.relrowsecurity is false or c.relforcerowsecurity is false);

  if offending is not null then
    raise exception 'Tables with tenant_id but without forced RLS: %', offending;
  end if;

  -- 3. Every RLS-enabled table must actually carry at least one policy. An enabled table
  --    with no policy denies everything, which is safe but breaks the application loudly;
  --    catching it here is better than at 3am.
  select string_agg(c.relname, ', ')
  into offending
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relrowsecurity
    and not exists (select 1 from pg_policy p where p.polrelid = c.oid);

  if offending is not null then
    raise exception 'RLS enabled with no policy on: %', offending;
  end if;
end
$$;
