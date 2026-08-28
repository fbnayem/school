-- =====================================================================================
-- 0003 — Close the `organizations` RLS gap, and make the gap impossible to reintroduce
--
-- Migration 0002 enabled RLS by scanning for tables with a `tenant_id` column. That is the
-- right rule for 36 of 38 tables and the wrong rule for exactly one: `organizations` IS the
-- tenant, so its primary key is the tenant id and it has no `tenant_id` column. The scan
-- skipped it, leaving every tenant's organization row — name, contact email, settings,
-- suspension reason — readable by any authenticated session.
--
-- Two fixes, because patching only the symptom would leave the next such table exposed:
--
--   1. A policy on `organizations` keyed on `id` rather than `tenant_id`.
--   2. An explicit allowlist of tables that are legitimately unprotected, plus an assertion
--      that fails the migration if any table is neither RLS-protected nor allowlisted. A new
--      table now has to be classified deliberately; forgetting is a failed migration rather
--      than a silent leak.
-- =====================================================================================

alter table public.organizations enable row level security;
alter table public.organizations force row level security;

drop policy if exists tenant_isolation on public.organizations;

-- A tenant sees exactly its own row. Platform admins see all, which is how the tenant list in
-- the platform console works.
create policy tenant_isolation on public.organizations
  for all
  using (
    app_is_platform_admin()
    or id = app_current_tenant_id()
  )
  with check (
    -- Creating an organization is a platform action by definition: the tenant context cannot
    -- yet name a tenant that does not exist. This is why `withPlatformContext` exists.
    app_is_platform_admin()
    or id = app_current_tenant_id()
  );

-- -------------------------------------------------------------------------------------
-- The migration bookkeeping table holds no tenant data, but the application has no business
-- writing to it either. Only the migrator does.
-- -------------------------------------------------------------------------------------

revoke all on public._migrations from shikkha_app, shikkha_readonly;

-- -------------------------------------------------------------------------------------
-- Structural assertion: every public table is either RLS-protected or explicitly exempt.
-- -------------------------------------------------------------------------------------

create or replace function assert_rls_coverage() returns void
language plpgsql
as $$
declare
  -- Tables that legitimately hold no tenant-scoped data. Adding to this list is a deliberate,
  -- reviewable act; the default for a new table is "must be protected".
  exempt constant text[] := array['_migrations'];
  offending text;
begin
  select string_agg(c.relname, ', ' order by c.relname)
  into offending
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and not (c.relrowsecurity and c.relforcerowsecurity)
    and c.relname <> all (exempt);

  if offending is not null then
    raise exception
      'Tables without forced row-level security: %. Either add a policy or add the table to the exempt list in assert_rls_coverage() with a written justification.',
      offending;
  end if;

  -- An RLS-enabled table with no policy denies everything. Safe, but it breaks the
  -- application in a way that is hard to diagnose at runtime.
  select string_agg(c.relname, ', ' order by c.relname)
  into offending
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relrowsecurity
    and not exists (select 1 from pg_policy p where p.polrelid = c.oid);

  if offending is not null then
    raise exception 'RLS enabled but no policy defined on: %', offending;
  end if;

  if exists (select 1 from pg_roles where rolname = 'shikkha_app' and (rolbypassrls or rolsuper)) then
    raise exception 'shikkha_app is superuser or has BYPASSRLS; row-level security would not apply to it';
  end if;
end
$$;

select assert_rls_coverage();
