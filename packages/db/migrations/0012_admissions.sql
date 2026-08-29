-- =====================================================================================
-- 0012 — Admissions (Phase 5)
--
-- Nine tenant-scoped tables that carry an applicant from a public form submission to an
-- enrolled student. Three properties are enforced here rather than left to the application:
--
--   1. **Applicants are not students.** The admissions tables reference `students` only
--      through `admission_applications.student_id`, stamped once when an offer is accepted
--      and the real records are created. Nothing here duplicates the student model.
--   2. **Money is `numeric(14, 2)`.** The application fee and the offer's `fee_due` follow
--      ADR-004: the driver returns them as strings and `Money` is the only parser.
--   3. **Workflow facts are check constraints.** An accepted offer without `accepted_at`, a
--      declined offer without `declined_at`, a test whose pass mark exceeds its total, or an
--      absent candidate with marks are all contradictions the database refuses, so a service
--      bug fails loudly on the write instead of corrupting the intake record.
--
-- Row-level security is applied at the bottom with the same `tenant_isolation` policy every
-- other tenant table carries. The driving loop in 0002 does not re-run for tables created
-- later, so the policy, the grants and the `set_updated_at` trigger are applied here for
-- these nine tables explicitly, and `assert_rls_coverage()` is called last so a mistake
-- fails the migration rather than shipping a silently-disabled control.
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- Enumerations. Closed sets: adding an application status changes the state machine in the
-- service as well as the schema, so these are enums rather than lookup tables.
-- -------------------------------------------------------------------------------------

create type public.admission_session_status as enum ('draft', 'open', 'closed', 'completed');

create type public.admission_application_status as enum (
  'submitted', 'under_review', 'shortlisted', 'test_scheduled', 'tested', 'interviewed',
  'selected', 'waitlisted', 'rejected', 'offered', 'accepted', 'declined', 'enrolled',
  'withdrawn'
);

create type public.admission_application_source as enum ('online', 'counter');

create type public.admission_offer_status as enum (
  'pending', 'accepted', 'declined', 'expired', 'withdrawn'
);

-- -------------------------------------------------------------------------------------
-- Sessions, applications, documents
-- -------------------------------------------------------------------------------------

create table public.admission_sessions (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  campus_id uuid,
  academic_year_id uuid not null,
  name_en varchar(128) not null,
  name_bn varchar(128),
  application_start_date date not null,
  application_end_date date not null,
  application_fee numeric(14, 2) default '0.00' not null,
  -- [{ "classLevelId": "<uuid>", "seats": 120 }, ...] — the class levels this cycle is open
  -- for. Seat enforcement locks this row (SELECT ... FOR UPDATE) and counts acceptances.
  class_capacity jsonb default '[]'::jsonb not null,
  status public.admission_session_status default 'draft' not null,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.admission_applications (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  session_id uuid not null,
  class_level_id uuid not null,
  application_number varchar(32) not null,
  applicant_name_en varchar(255) not null,
  applicant_name_bn varchar(255),
  date_of_birth date not null,
  gender public.gender not null,
  birth_registration_number varchar(20),
  photo_file_id uuid,
  previous_school_name varchar(255),
  previous_class_completed varchar(64),
  previous_result_gpa numeric(4, 2),
  guardian_name_en varchar(255) not null,
  guardian_name_bn varchar(255),
  guardian_relation public.guardian_relation not null,
  guardian_phone varchar(20) not null,
  guardian_email varchar(320),
  guardian_nid varchar(20),
  present_address varchar(1000),
  quota varchar(32),
  status public.admission_application_status default 'submitted' not null,
  status_changed_at timestamp with time zone,
  status_reason varchar(1000),
  submitted_at timestamp with time zone default now() not null,
  source public.admission_application_source default 'online' not null,
  student_id uuid,
  metadata jsonb default '{}'::jsonb not null,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.admission_application_documents (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  application_id uuid not null,
  storage_key varchar(512) not null,
  document_type varchar(48) not null,
  title varchar(255) not null,
  verified_by uuid,
  verified_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

-- -------------------------------------------------------------------------------------
-- Tests, results, interviews
-- -------------------------------------------------------------------------------------

create table public.admission_tests (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  session_id uuid not null,
  class_level_id uuid,
  name_en varchar(128) not null,
  name_bn varchar(128),
  test_date date not null,
  start_time time,
  total_marks numeric(6, 2) not null,
  pass_marks numeric(6, 2) not null,
  venue varchar(255),
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.admission_test_results (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  test_id uuid not null,
  application_id uuid not null,
  marks_obtained numeric(6, 2),
  is_absent boolean default false not null,
  entered_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.admission_interviews (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  application_id uuid not null,
  panel_name varchar(128),
  scheduled_at timestamp with time zone not null,
  interviewer_employee_id uuid,
  score numeric(5, 2),
  remarks varchar(1000),
  scored_at timestamp with time zone,
  scored_by uuid,
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
-- Merit lists, entries, offers
-- -------------------------------------------------------------------------------------

create table public.admission_merit_lists (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  session_id uuid not null,
  class_level_id uuid not null,
  name_en varchar(128) not null,
  name_bn varchar(128),
  -- The exact weights and tie-break rule the ranking used, recorded so the list is
  -- reproducible from its own row. Generation never publishes; published_at is a separate,
  -- separately-audited act.
  criteria jsonb default '{}'::jsonb not null,
  generated_at timestamp with time zone default now() not null,
  generated_by uuid,
  published_at timestamp with time zone,
  published_by uuid,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.admission_merit_entries (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  merit_list_id uuid not null,
  application_id uuid not null,
  rank integer not null,
  aggregate_score numeric(9, 4) not null,
  components jsonb default '{}'::jsonb not null,
  is_waitlisted boolean default false not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.admission_offers (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  application_id uuid not null,
  offered_at timestamp with time zone default now() not null,
  expires_at timestamp with time zone not null,
  accepted_at timestamp with time zone,
  declined_at timestamp with time zone,
  fee_due numeric(14, 2) default '0.00' not null,
  status public.admission_offer_status default 'pending' not null,
  notes varchar(1000),
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
-- Foreign keys. `restrict` for tenancy anchors and for anything that is itself an academic
-- record (an application, once tested or ranked, must not be removable); `cascade` only for
-- rows genuinely owned by their parent (a session's tests, a test's results, a list's
-- entries, an application's documents); `set null` for optional back-references.
-- -------------------------------------------------------------------------------------

alter table public.admission_sessions
  add constraint admission_sessions_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint admission_sessions_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint admission_sessions_campus_id_campuses_id_fk
    foreign key (campus_id) references public.campuses(id) on delete restrict,
  add constraint admission_sessions_academic_year_id_academic_years_id_fk
    foreign key (academic_year_id) references public.academic_years(id) on delete restrict;

alter table public.admission_applications
  add constraint admission_applications_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint admission_applications_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint admission_applications_session_id_admission_sessions_id_fk
    foreign key (session_id) references public.admission_sessions(id) on delete restrict,
  add constraint admission_applications_class_level_id_class_levels_id_fk
    foreign key (class_level_id) references public.class_levels(id) on delete restrict,
  add constraint admission_applications_student_id_students_id_fk
    foreign key (student_id) references public.students(id) on delete set null;

alter table public.admission_application_documents
  add constraint admission_application_documents_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint admission_application_documents_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint admission_application_documents_application_id_fk
    foreign key (application_id) references public.admission_applications(id) on delete cascade;

alter table public.admission_tests
  add constraint admission_tests_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint admission_tests_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint admission_tests_session_id_admission_sessions_id_fk
    foreign key (session_id) references public.admission_sessions(id) on delete cascade,
  add constraint admission_tests_class_level_id_class_levels_id_fk
    foreign key (class_level_id) references public.class_levels(id) on delete restrict;

alter table public.admission_test_results
  add constraint admission_test_results_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint admission_test_results_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint admission_test_results_test_id_admission_tests_id_fk
    foreign key (test_id) references public.admission_tests(id) on delete cascade,
  add constraint admission_test_results_application_id_fk
    foreign key (application_id) references public.admission_applications(id) on delete restrict;

alter table public.admission_interviews
  add constraint admission_interviews_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint admission_interviews_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint admission_interviews_application_id_fk
    foreign key (application_id) references public.admission_applications(id) on delete restrict,
  add constraint admission_interviews_interviewer_employee_id_employees_id_fk
    foreign key (interviewer_employee_id) references public.employees(id) on delete set null;

alter table public.admission_merit_lists
  add constraint admission_merit_lists_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint admission_merit_lists_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint admission_merit_lists_session_id_admission_sessions_id_fk
    foreign key (session_id) references public.admission_sessions(id) on delete restrict,
  add constraint admission_merit_lists_class_level_id_class_levels_id_fk
    foreign key (class_level_id) references public.class_levels(id) on delete restrict;

alter table public.admission_merit_entries
  add constraint admission_merit_entries_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint admission_merit_entries_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint admission_merit_entries_merit_list_id_fk
    foreign key (merit_list_id) references public.admission_merit_lists(id) on delete cascade,
  add constraint admission_merit_entries_application_id_fk
    foreign key (application_id) references public.admission_applications(id) on delete restrict;

alter table public.admission_offers
  add constraint admission_offers_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint admission_offers_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint admission_offers_application_id_fk
    foreign key (application_id) references public.admission_applications(id) on delete restrict;

-- -------------------------------------------------------------------------------------
-- Indexes. Every foreign key the module filters or joins on has one, plus the mandatory
-- `<table>_tenant_idx`. Business-key uniqueness is partial on `archived_at is null`
-- (ADR-008: archives free the key, records are preserved).
-- -------------------------------------------------------------------------------------

create unique index if not exists admission_sessions_institution_name_key
  on public.admission_sessions using btree (institution_id, name_en)
  where archived_at is null;
create index if not exists admission_sessions_tenant_idx
  on public.admission_sessions using btree (tenant_id);
create index if not exists admission_sessions_institution_status_idx
  on public.admission_sessions using btree (institution_id, status);
create index if not exists admission_sessions_year_idx
  on public.admission_sessions using btree (academic_year_id);
create index if not exists admission_sessions_campus_idx
  on public.admission_sessions using btree (campus_id);

create unique index if not exists admission_applications_number_key
  on public.admission_applications using btree (institution_id, application_number)
  where archived_at is null;
-- One live application per child per session. A withdrawn application frees the slot so the
-- family can genuinely re-apply within the same cycle.
create unique index if not exists admission_applications_dedupe_key
  on public.admission_applications using btree (session_id, applicant_name_en, date_of_birth)
  where status <> 'withdrawn' and archived_at is null;
create index if not exists admission_applications_tenant_idx
  on public.admission_applications using btree (tenant_id);
create index if not exists admission_applications_session_status_idx
  on public.admission_applications using btree (session_id, status);
create index if not exists admission_applications_session_class_idx
  on public.admission_applications using btree (session_id, class_level_id);
create index if not exists admission_applications_guardian_phone_idx
  on public.admission_applications using btree (tenant_id, guardian_phone);
create index if not exists admission_applications_student_idx
  on public.admission_applications using btree (student_id);

create index if not exists admission_application_documents_application_idx
  on public.admission_application_documents using btree (application_id, document_type);
create index if not exists admission_application_documents_tenant_idx
  on public.admission_application_documents using btree (tenant_id);

create unique index if not exists admission_tests_session_name_key
  on public.admission_tests using btree (session_id, name_en)
  where archived_at is null;
create index if not exists admission_tests_tenant_idx
  on public.admission_tests using btree (tenant_id);
create index if not exists admission_tests_session_idx
  on public.admission_tests using btree (session_id, test_date);
create index if not exists admission_tests_class_idx
  on public.admission_tests using btree (class_level_id);

create unique index if not exists admission_test_results_unique_key
  on public.admission_test_results using btree (test_id, application_id)
  where archived_at is null;
create index if not exists admission_test_results_application_idx
  on public.admission_test_results using btree (application_id);
create index if not exists admission_test_results_tenant_idx
  on public.admission_test_results using btree (tenant_id);

create unique index if not exists admission_interviews_application_key
  on public.admission_interviews using btree (application_id)
  where archived_at is null;
create index if not exists admission_interviews_tenant_idx
  on public.admission_interviews using btree (tenant_id);
create index if not exists admission_interviews_schedule_idx
  on public.admission_interviews using btree (scheduled_at);
create index if not exists admission_interviews_interviewer_idx
  on public.admission_interviews using btree (interviewer_employee_id);

create unique index if not exists admission_merit_lists_name_key
  on public.admission_merit_lists using btree (session_id, class_level_id, name_en)
  where archived_at is null;
create index if not exists admission_merit_lists_tenant_idx
  on public.admission_merit_lists using btree (tenant_id);
create index if not exists admission_merit_lists_session_idx
  on public.admission_merit_lists using btree (session_id, class_level_id);

create unique index if not exists admission_merit_entries_application_key
  on public.admission_merit_entries using btree (merit_list_id, application_id)
  where archived_at is null;
create unique index if not exists admission_merit_entries_rank_key
  on public.admission_merit_entries using btree (merit_list_id, rank)
  where archived_at is null;
create index if not exists admission_merit_entries_tenant_idx
  on public.admission_merit_entries using btree (tenant_id);
create index if not exists admission_merit_entries_application_idx
  on public.admission_merit_entries using btree (application_id);

-- At most one live (pending or accepted) offer per application; a re-offer after a decline
-- or expiry is a new row, preserving what was offered and when.
create unique index if not exists admission_offers_live_key
  on public.admission_offers using btree (application_id)
  where status in ('pending', 'accepted') and archived_at is null;
create index if not exists admission_offers_tenant_idx
  on public.admission_offers using btree (tenant_id);
create index if not exists admission_offers_application_idx
  on public.admission_offers using btree (application_id);
create index if not exists admission_offers_expiry_idx
  on public.admission_offers using btree (expires_at)
  where status = 'pending';

-- -------------------------------------------------------------------------------------
-- Data-integrity constraints that belong in the database, not only in a Zod schema.
-- A violation of any of these would corrupt the intake record or money, so they are
-- restated here even though the application validates them.
-- -------------------------------------------------------------------------------------

alter table public.admission_sessions
  add constraint admission_sessions_window_ordered
    check (application_end_date >= application_start_date),
  add constraint admission_sessions_fee_non_negative check (application_fee >= 0);

alter table public.admission_applications
  add constraint admission_applications_dob_sane
    check (date_of_birth > date '1950-01-01' and date_of_birth < current_date),
  add constraint admission_applications_gpa_range
    check (previous_result_gpa is null or (previous_result_gpa >= 0 and previous_result_gpa <= 5)),
  -- An enrolled application without the student it produced is a broken funnel record.
  add constraint admission_applications_enrolled_has_student
    check (status <> 'enrolled' or student_id is not null);

alter table public.admission_tests
  add constraint admission_tests_total_positive check (total_marks > 0),
  add constraint admission_tests_pass_within_total
    check (pass_marks >= 0 and pass_marks <= total_marks);

alter table public.admission_test_results
  add constraint admission_test_results_marks_non_negative
    check (marks_obtained is null or marks_obtained >= 0),
  -- A zero is a mark that was earned; an absence is not. Both cannot be recorded at once.
  add constraint admission_test_results_absent_has_no_marks
    check (not is_absent or marks_obtained is null);

alter table public.admission_interviews
  add constraint admission_interviews_score_range
    check (score is null or (score >= 0 and score <= 100)),
  add constraint admission_interviews_scored_recorded
    check (score is null or (scored_at is not null and scored_by is not null));

alter table public.admission_merit_entries
  add constraint admission_merit_entries_rank_positive check (rank >= 1),
  add constraint admission_merit_entries_score_non_negative check (aggregate_score >= 0);

alter table public.admission_offers
  add constraint admission_offers_expiry_after_offer check (expires_at > offered_at),
  add constraint admission_offers_fee_non_negative check (fee_due >= 0),
  add constraint admission_offers_accept_recorded
    check (status <> 'accepted' or accepted_at is not null),
  add constraint admission_offers_decline_recorded
    check (status <> 'declined' or declined_at is not null);

-- -------------------------------------------------------------------------------------
-- Full-text search on applicants. Generated in SQL, not in the Drizzle schema — a generated
-- column has no insertable form. 'simple' config: exact tokens are correct for names.
-- -------------------------------------------------------------------------------------

alter table public.admission_applications
  add column if not exists search_vector tsvector
  generated always as (
    setweight(to_tsvector('simple', coalesce(applicant_name_en, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(applicant_name_bn, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(application_number, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(guardian_name_en, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(guardian_phone, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(previous_school_name, '')), 'D')
  ) stored;

create index if not exists admission_applications_search_idx
  on public.admission_applications using gin (search_vector);

-- -------------------------------------------------------------------------------------
-- Row-level security.
--
-- The scan in 0002 only covered the tables that existed then. These nine are enabled,
-- forced and given the identical `tenant_isolation` policy here. Both `using` and
-- `with check` are present: `using` gates which rows are visible, `with check` is what
-- stops a session from writing a row stamped with another tenant's id.
-- -------------------------------------------------------------------------------------

do $$
declare
  target text;
  admission_tables constant text[] := array[
    'admission_sessions',
    'admission_applications',
    'admission_application_documents',
    'admission_tests',
    'admission_test_results',
    'admission_interviews',
    'admission_merit_lists',
    'admission_merit_entries',
    'admission_offers'
  ];
begin
  foreach target in array admission_tables
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

    -- Default privileges cover tables created by the migrator, but restating the grant
    -- keeps this migration correct even if default privileges change between releases.
    execute format('grant select, insert, update, delete on public.%I to shikkha_app', target);
    execute format('grant select on public.%I to shikkha_readonly', target);

    -- `updated_at` is maintained by the trigger, not the application, so a hand-written
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
      'admission_sessions', 'admission_applications', 'admission_application_documents',
      'admission_tests', 'admission_test_results', 'admission_interviews',
      'admission_merit_lists', 'admission_merit_entries', 'admission_offers'
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
      'Admission tables without forced row-level security and a tenant_isolation policy: %',
      offending;
  end if;

  -- Every one of the nine must also carry the tenant column the policy reads. A policy on a
  -- table without `tenant_id` would fail at query time, not here.
  select string_agg(t.name, ', ' order by t.name)
  into offending
  from unnest(array[
    'admission_sessions', 'admission_applications', 'admission_application_documents',
    'admission_tests', 'admission_test_results', 'admission_interviews',
    'admission_merit_lists', 'admission_merit_entries', 'admission_offers'
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
    raise exception 'Admission tables without a tenant_id column: %', offending;
  end if;
end
$$;

-- The global sweep: every public table is either RLS-protected or explicitly exempt.
select assert_rls_coverage();
