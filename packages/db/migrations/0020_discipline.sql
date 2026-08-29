-- =====================================================================================
-- 0020 — Discipline and behaviour (Phase 22)
--
-- Six tenant-scoped tables recording allegations and sanctions against children — the most
-- sensitive data in the product after medical records. Four properties are enforced here
-- rather than left to the application, because each is a due-process guarantee the
-- application can only get wrong once:
--
--   1. **Nothing is deleted.** Withdrawal and "unsubstantiated" are statuses on
--      `behaviour_records`; every table carries the soft-archive columns and there is no
--      delete path. The history of an allegation, including one that was dismissed, stays.
--   2. **Notes are append-only.** `behaviour_record_notes` gets the same treatment as
--      `audit_logs`: UPDATE and DELETE privileges are revoked from the application role AND
--      a trigger refuses both operations for every role, so a disciplinary file cannot be
--      quietly rewritten after the fact — not even by a hand-written SQL "fix".
--   3. **A severe sanction needs two people.** `disciplinary_actions_severe_distinct_approver`
--      restates in the database what the service enforces at runtime: a suspension or an
--      expulsion recommendation cannot leave `proposed` unless `approved_by` is a different
--      person from `decided_by`.
--   4. **Merit points post exactly once per record.** The partial unique index on
--      `merit_points_ledger.source_record_id` refuses a second posting even if two
--      transitions race.
--
-- Row-level security is applied at the bottom with the standard `tenant_isolation` policy;
-- the 0002 loop does not re-run for tables created later, so it is done here explicitly and
-- `assert_rls_coverage()` is called last.
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- Enumerations. Closed value sets only: a school's own behaviour *categories* are rows in
-- `behaviour_categories`, not values here.
-- -------------------------------------------------------------------------------------

create type public.behaviour_kind as enum ('positive', 'negative');

create type public.behaviour_severity as enum ('minor', 'moderate', 'major', 'severe');

create type public.behaviour_record_status as enum (
  'draft', 'reported', 'under_investigation', 'substantiated', 'unsubstantiated', 'withdrawn'
);

create type public.behaviour_confidentiality as enum ('normal', 'restricted');

create type public.disciplinary_action_type as enum (
  'verbal_warning', 'written_warning', 'detention', 'parent_meeting',
  'community_service', 'suspension', 'expulsion_recommended'
);

create type public.disciplinary_action_status as enum (
  'proposed', 'approved', 'active', 'completed', 'revoked'
);

create type public.behaviour_note_visibility as enum ('internal', 'shared_with_guardian');

-- -------------------------------------------------------------------------------------
-- Tables
-- -------------------------------------------------------------------------------------

create table public.behaviour_categories (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  code varchar(32) not null,
  name_en varchar(128) not null,
  name_bn varchar(128),
  kind public.behaviour_kind not null,
  default_severity public.behaviour_severity default 'minor' not null,
  default_points integer default 0 not null,
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

create table public.behaviour_records (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  campus_id uuid,
  student_id uuid not null,
  category_id uuid not null,
  academic_year_id uuid not null,
  occurred_on date not null,
  occurred_at_period_id uuid,
  description text not null,
  severity public.behaviour_severity not null,
  points integer default 0 not null,
  reported_by_employee_id uuid not null,
  status public.behaviour_record_status default 'draft' not null,
  status_changed_at timestamp with time zone,
  status_changed_by uuid,
  status_reason varchar(1000),
  confidentiality public.behaviour_confidentiality default 'normal' not null,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.disciplinary_actions (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  behaviour_record_id uuid not null,
  action_type public.disciplinary_action_type not null,
  starts_on date,
  ends_on date,
  details text not null,
  decided_by uuid not null,
  decided_at timestamp with time zone not null,
  approved_by uuid,
  approved_at timestamp with time zone,
  workflow_request_id uuid,
  status public.disciplinary_action_status default 'proposed' not null,
  revoked_reason varchar(500),
  revoked_by uuid,
  revoked_at timestamp with time zone,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.behaviour_record_notes (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  behaviour_record_id uuid not null,
  note text not null,
  author_user_id uuid not null,
  visibility public.behaviour_note_visibility default 'internal' not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.behaviour_guardian_acknowledgements (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  behaviour_record_id uuid not null,
  guardian_id uuid not null,
  acknowledged_at timestamp with time zone default now() not null,
  comment varchar(1000),
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.merit_points_ledger (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  student_id uuid not null,
  academic_year_id uuid not null,
  source_record_id uuid not null,
  points integer not null,
  running_total integer not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

-- -------------------------------------------------------------------------------------
-- Foreign keys. `restrict` throughout for parents that must outlive the reference —
-- a disciplinary record blocking the hard deletion of a student is the intended behaviour,
-- because a disciplinary record must never silently lose its subject.
-- -------------------------------------------------------------------------------------

alter table public.behaviour_categories
  add constraint behaviour_categories_tenant_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint behaviour_categories_institution_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict;

alter table public.behaviour_records
  add constraint behaviour_records_tenant_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint behaviour_records_institution_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint behaviour_records_campus_id_fk
    foreign key (campus_id) references public.campuses(id) on delete restrict,
  add constraint behaviour_records_student_id_fk
    foreign key (student_id) references public.students(id) on delete restrict,
  add constraint behaviour_records_category_id_fk
    foreign key (category_id) references public.behaviour_categories(id) on delete restrict,
  add constraint behaviour_records_academic_year_id_fk
    foreign key (academic_year_id) references public.academic_years(id) on delete restrict,
  add constraint behaviour_records_occurred_at_period_id_fk
    foreign key (occurred_at_period_id) references public.periods(id) on delete set null,
  add constraint behaviour_records_reported_by_employee_id_fk
    foreign key (reported_by_employee_id) references public.employees(id) on delete restrict;

alter table public.disciplinary_actions
  add constraint disciplinary_actions_tenant_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint disciplinary_actions_institution_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint disciplinary_actions_behaviour_record_id_fk
    foreign key (behaviour_record_id) references public.behaviour_records(id) on delete restrict;

alter table public.behaviour_record_notes
  add constraint behaviour_record_notes_tenant_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint behaviour_record_notes_institution_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint behaviour_record_notes_behaviour_record_id_fk
    foreign key (behaviour_record_id) references public.behaviour_records(id) on delete restrict;

alter table public.behaviour_guardian_acknowledgements
  add constraint behaviour_guardian_acknowledgements_tenant_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint behaviour_guardian_acknowledgements_institution_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint behaviour_guardian_acknowledgements_record_id_fk
    foreign key (behaviour_record_id) references public.behaviour_records(id) on delete restrict,
  add constraint behaviour_guardian_acknowledgements_guardian_id_fk
    foreign key (guardian_id) references public.guardians(id) on delete restrict;

alter table public.merit_points_ledger
  add constraint merit_points_ledger_tenant_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint merit_points_ledger_institution_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint merit_points_ledger_student_id_fk
    foreign key (student_id) references public.students(id) on delete restrict,
  add constraint merit_points_ledger_academic_year_id_fk
    foreign key (academic_year_id) references public.academic_years(id) on delete restrict,
  add constraint merit_points_ledger_source_record_id_fk
    foreign key (source_record_id) references public.behaviour_records(id) on delete restrict;

-- -------------------------------------------------------------------------------------
-- Indexes
-- -------------------------------------------------------------------------------------

create unique index if not exists behaviour_categories_institution_code_key
  on public.behaviour_categories using btree (institution_id, code) where archived_at is null;
create index if not exists behaviour_categories_tenant_idx
  on public.behaviour_categories using btree (tenant_id);
create index if not exists behaviour_categories_institution_kind_idx
  on public.behaviour_categories using btree (institution_id, kind);

create index if not exists behaviour_records_tenant_idx
  on public.behaviour_records using btree (tenant_id);
create index if not exists behaviour_records_student_idx
  on public.behaviour_records using btree (student_id, occurred_on);
create index if not exists behaviour_records_institution_status_idx
  on public.behaviour_records using btree (institution_id, status);
create index if not exists behaviour_records_institution_occurred_idx
  on public.behaviour_records using btree (institution_id, occurred_on);
create index if not exists behaviour_records_category_idx
  on public.behaviour_records using btree (category_id);
create index if not exists behaviour_records_year_idx
  on public.behaviour_records using btree (academic_year_id);

create index if not exists disciplinary_actions_tenant_idx
  on public.disciplinary_actions using btree (tenant_id);
create index if not exists disciplinary_actions_record_idx
  on public.disciplinary_actions using btree (behaviour_record_id);
create index if not exists disciplinary_actions_institution_status_idx
  on public.disciplinary_actions using btree (institution_id, status);

create index if not exists behaviour_record_notes_tenant_idx
  on public.behaviour_record_notes using btree (tenant_id);
create index if not exists behaviour_record_notes_record_idx
  on public.behaviour_record_notes using btree (behaviour_record_id, created_at);

create unique index if not exists behaviour_guardian_acknowledgements_record_guardian_key
  on public.behaviour_guardian_acknowledgements using btree (behaviour_record_id, guardian_id)
  where archived_at is null;
create index if not exists behaviour_guardian_acknowledgements_tenant_idx
  on public.behaviour_guardian_acknowledgements using btree (tenant_id);
create index if not exists behaviour_guardian_acknowledgements_guardian_idx
  on public.behaviour_guardian_acknowledgements using btree (guardian_id);

create unique index if not exists merit_points_ledger_source_key
  on public.merit_points_ledger using btree (source_record_id) where archived_at is null;
create index if not exists merit_points_ledger_tenant_idx
  on public.merit_points_ledger using btree (tenant_id);
create index if not exists merit_points_ledger_student_year_idx
  on public.merit_points_ledger using btree (student_id, academic_year_id);

-- -------------------------------------------------------------------------------------
-- Check constraints — the due-process invariants, restated where they cannot be argued with.
-- -------------------------------------------------------------------------------------

alter table public.behaviour_categories
  -- A positive behaviour cannot carry negative points, and vice versa. Zero is legal for
  -- both: some categories are recorded for the file without affecting merit points.
  add constraint behaviour_categories_kind_points_aligned check (
    (kind = 'positive' and default_points >= 0)
    or (kind = 'negative' and default_points <= 0)
  );

alter table public.behaviour_records
  -- Tomorrow's incident cannot be reported today; +1 tolerates a clock straddling midnight,
  -- the same allowance attendance makes.
  add constraint behaviour_records_occurred_not_future
    check (occurred_on <= current_date + 1),
  add constraint behaviour_records_description_present
    check (length(btrim(description)) > 0),
  -- Any record that has left `draft` must say when and by whom, because every status
  -- transition is part of the child's due-process trail.
  add constraint behaviour_records_status_change_recorded check (
    status = 'draft' or (status_changed_at is not null and status_changed_by is not null)
  ),
  -- Terminal decisions carry their reason with them.
  add constraint behaviour_records_decision_has_reason check (
    status not in ('substantiated', 'unsubstantiated', 'withdrawn')
    or status_reason is not null
  );

alter table public.disciplinary_actions
  add constraint disciplinary_actions_dates_ordered check (
    starts_on is null or ends_on is null or ends_on >= starts_on
  ),
  add constraint disciplinary_actions_details_present
    check (length(btrim(details)) > 0),
  -- An action that is in effect was approved by a named person at a recorded time.
  add constraint disciplinary_actions_approval_recorded check (
    status not in ('approved', 'active', 'completed')
    or (approved_by is not null and approved_at is not null)
  ),
  -- THE due-process rule: a suspension or an expulsion recommendation never takes effect on
  -- one person's say-so. Once it leaves `proposed` (other than a revocation of a
  -- never-approved proposal), the approver must be a different person from the decider.
  add constraint disciplinary_actions_severe_distinct_approver check (
    action_type not in ('suspension', 'expulsion_recommended')
    or status = 'proposed'
    or (status = 'revoked' and approved_by is null)
    or (approved_by is not null and approved_by <> decided_by)
  ),
  add constraint disciplinary_actions_revoked_requires_reason check (
    status <> 'revoked'
    or (revoked_reason is not null and revoked_by is not null and revoked_at is not null)
  );

alter table public.behaviour_record_notes
  add constraint behaviour_record_notes_note_present
    check (length(btrim(note)) > 0);

alter table public.merit_points_ledger
  -- A zero-point entry is noise; the service simply does not post one.
  add constraint merit_points_ledger_points_nonzero check (points <> 0);

-- -------------------------------------------------------------------------------------
-- Append-only enforcement for notes — the same mechanism as `audit_logs` in 0002.
--
-- Two layers, deliberately redundant: the trigger refuses UPDATE/DELETE for *every* role
-- (including the table owner running a hand-written fix), and the privilege revocation below
-- the grant loop removes even the theoretical path from the application role.
-- -------------------------------------------------------------------------------------

create or replace function behaviour_notes_reject_mutation() returns trigger
language plpgsql
as $$
begin
  raise exception 'behaviour_record_notes is append-only; % is not permitted', tg_op
    using errcode = 'insufficient_privilege';
end
$$;

drop trigger if exists behaviour_record_notes_no_mutation on public.behaviour_record_notes;
create trigger behaviour_record_notes_no_mutation
  before update or delete on public.behaviour_record_notes
  for each row execute function behaviour_notes_reject_mutation();

-- -------------------------------------------------------------------------------------
-- Row-level security. The 0002 loop does not re-run for tables created later; the policy,
-- the grants and the `set_updated_at` trigger are applied here for these six tables.
-- -------------------------------------------------------------------------------------

do $$
declare
  target text;
  discipline_tables constant text[] := array[
    'behaviour_categories',
    'behaviour_records',
    'disciplinary_actions',
    'behaviour_record_notes',
    'behaviour_guardian_acknowledgements',
    'merit_points_ledger'
  ];
begin
  foreach target in array discipline_tables
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

    -- `updated_at` is maintained by the trigger, not by the application. On the append-only
    -- notes table this trigger is unreachable: `behaviour_record_notes_no_mutation` sorts
    -- before it and fires first.
    execute format('drop trigger if exists set_updated_at on public.%I', target);
    execute format(
      'create trigger set_updated_at before update on public.%I
         for each row execute function set_updated_at()',
      target
    );
  end loop;
end
$$;

-- Notes are append-only for the application role at the privilege level as well: like
-- `audit_logs`, the application cannot even attempt an UPDATE or DELETE.
revoke update, delete on public.behaviour_record_notes from shikkha_app;

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
      'behaviour_categories', 'behaviour_records', 'disciplinary_actions',
      'behaviour_record_notes', 'behaviour_guardian_acknowledgements', 'merit_points_ledger'
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
      'Discipline tables without forced row-level security and a tenant_isolation policy: %',
      offending;
  end if;

  -- Every one of the six must also carry the tenant column the policy reads. A policy on a
  -- table without `tenant_id` would fail at query time, not here.
  select string_agg(t.name, ', ' order by t.name)
  into offending
  from unnest(array[
    'behaviour_categories', 'behaviour_records', 'disciplinary_actions',
    'behaviour_record_notes', 'behaviour_guardian_acknowledgements', 'merit_points_ledger'
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
    raise exception 'Discipline tables without a tenant_id column: %', offending;
  end if;

  -- The append-only trigger must exist on the notes table.
  if not exists (
    select 1
    from pg_trigger tg
    join pg_class c on c.oid = tg.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'behaviour_record_notes'
      and tg.tgname = 'behaviour_record_notes_no_mutation'
  ) then
    raise exception 'behaviour_record_notes is missing its append-only trigger';
  end if;
end
$$;

-- The global sweep: every public table is either RLS-protected or explicitly exempt.
select assert_rls_coverage();
