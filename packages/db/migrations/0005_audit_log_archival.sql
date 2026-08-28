-- =====================================================================================
-- 0005 — Let the owner prune the audit log, while keeping it append-only for the application
--
-- Migration 0002 made `audit_logs` append-only two ways: it revoked UPDATE and DELETE from
-- `shikkha_app`, and it added a trigger to catch a future migration that re-grants the
-- privilege by accident. The trigger, however, fires for *every* role — including the owner —
-- which contradicts the design it was written to support. `docs/07_SECURITY_MODEL.md` says
-- "retention runs as the migrator role", and there was no way for it to.
--
-- Found by `pnpm db:seed --fresh`, which removes a demo tenant's rows and was refused.
--
-- The fix keeps both controls and adds the one exception the design already assumed:
--
--   * `shikkha_app` — no UPDATE or DELETE privilege at all, and the trigger refuses as well.
--   * `shikkha_migrator` — may prune. This is the role that runs migrations, the retention job
--     and the demo reset, and it is not a role the API ever connects as.
--
-- The check is `pg_has_role(..., 'MEMBER')` rather than a name comparison so that a deployment
-- which grants the migrator role to a named DBA account still works.
-- =====================================================================================

create or replace function audit_logs_reject_mutation() returns trigger
language plpgsql
as $$
begin
  -- The owner and anything granted membership of it may prune. Everyone else is refused,
  -- regardless of what privileges a future migration may hand out.
  if pg_has_role(current_user, 'shikkha_migrator', 'MEMBER') then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  raise exception 'audit_logs is append-only; % is not permitted for role %', tg_op, current_user
    using errcode = 'insufficient_privilege';
end
$$;

-- Restated for clarity; 0002 already did this, and it is the control that matters most.
-- The trigger is defence in depth against a migration that re-grants by mistake.
revoke update, delete on public.audit_logs from shikkha_app;
revoke update, delete on public.security_events from shikkha_app;

-- -------------------------------------------------------------------------------------
-- Assertion: the application role must not be able to rewrite history.
-- -------------------------------------------------------------------------------------

do $$
begin
  if has_table_privilege('shikkha_app', 'public.audit_logs', 'UPDATE')
     or has_table_privilege('shikkha_app', 'public.audit_logs', 'DELETE') then
    raise exception 'shikkha_app can modify audit_logs; the audit trail would not be trustworthy';
  end if;
end
$$;
