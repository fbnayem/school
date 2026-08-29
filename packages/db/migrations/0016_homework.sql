-- =====================================================================================
-- 0016 — Homework and assignments (Phase 9)
--
-- Five tenant-scoped tables: the task (`assignments`), the teacher's files on it
-- (`assignment_attachments`), each student's attempts (`assignment_submissions` — a
-- resubmission is a new row with the next attempt number, never an edit), the student's
-- files (`submission_attachments`), and the marks (`submission_grades` — re-grading demotes
-- the old final row and inserts a new one, so the history of a disputed mark survives).
--
-- Nothing here is ever hard-deleted (ADR-008): withdrawing an assignment is a status change
-- plus the archive marker, and every table carries the archive columns.
--
-- Migration 0002's RLS and `set_updated_at` loops only ran over the tables that existed
-- then, so this file re-states both per table, `with check` included — omitting the write
-- half would leave cross-tenant *writes* possible while reads looked correct.
--
-- Foreign-key constraints are named `<table>_<column>_fk` (the 0007 convention) because the
-- drizzle-kit long form exceeds Postgres's 63-byte identifier limit for
-- `submission_attachments.submission_id` → `assignment_submissions`, and a silently
-- truncated constraint name is worse than a consistent short one.
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- Enumerations. Closed value sets: a new assignment type or lifecycle state changes how
-- the product filters, reports and refuses submissions — a code change, not tenant
-- configuration (see the rule in packages/db/src/schema/_shared.ts).
-- -------------------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'assignment_type') then
    create type public.assignment_type as enum (
      'homework', 'project', 'classwork', 'practical', 'reading'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'assignment_status') then
    create type public.assignment_status as enum ('draft', 'published', 'closed', 'archived');
  end if;

  if not exists (select 1 from pg_type where typname = 'assignment_submission_status') then
    create type public.assignment_submission_status as enum (
      'not_submitted', 'submitted', 'late', 'resubmitted', 'graded', 'returned'
    );
  end if;
end
$$;

-- -------------------------------------------------------------------------------------
-- Tables
-- -------------------------------------------------------------------------------------

-- The task a teacher sets for one section+subject. `assigned_on` is a calendar fact
-- (ADR-009); `due_at` is an instant, because lateness is decided by the server clock at the
-- moment of submission, never by the client.
create table if not exists public.assignments (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "institution_id" uuid not null,
  "campus_id" uuid not null,
  "academic_year_id" uuid not null,
  "section_id" uuid not null,
  "subject_id" uuid not null,
  -- Nullable: an administrator without an employee record may create on a teacher's behalf;
  -- the acting user is always recorded in created_by.
  "created_by_employee_id" uuid,
  "title" varchar(255) not null,
  "title_bn" varchar(255),
  "instructions" text,
  "type" public.assignment_type default 'homework' not null,
  "assigned_on" date not null,
  "due_at" timestamp with time zone not null,
  "max_marks" numeric(6, 2),
  "is_graded" boolean default false not null,
  "allow_late" boolean default false not null,
  "late_penalty_percent" numeric(5, 2) default '0.00' not null,
  "status" public.assignment_status default 'draft' not null,
  "published_at" timestamp with time zone,
  "closed_at" timestamp with time zone,
  "version" integer default 1 not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "archived_at" timestamp with time zone,
  "archived_by" uuid,
  "archive_reason" varchar(500),
  "created_by" uuid,
  "updated_by" uuid
);

-- A file the teacher attached to the task. The bytes live in object storage; `file_id`
-- points at the central `files` row that authorises signed-URL redemption.
create table if not exists public.assignment_attachments (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "institution_id" uuid not null,
  "assignment_id" uuid not null,
  "file_id" uuid not null,
  "storage_key" varchar(512) not null,
  "filename" varchar(255) not null,
  "mime_type" varchar(128) not null,
  "size_bytes" bigint not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "archived_at" timestamp with time zone,
  "archived_by" uuid,
  "archive_reason" varchar(500),
  "created_by" uuid,
  "updated_by" uuid
);

-- One student's attempt. `submitted_at` and `is_late` are stamped by the server; the unique
-- attempt index below is the database's own word on "one row per attempt".
create table if not exists public.assignment_submissions (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "institution_id" uuid not null,
  "assignment_id" uuid not null,
  "student_id" uuid not null,
  "submitted_at" timestamp with time zone default now() not null,
  "status" public.assignment_submission_status default 'submitted' not null,
  "text_response" text,
  "is_late" boolean default false not null,
  "attempt_number" smallint default 1 not null,
  "version" integer default 1 not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "archived_at" timestamp with time zone,
  "archived_by" uuid,
  "archive_reason" varchar(500),
  "created_by" uuid,
  "updated_by" uuid
);

-- A file the student handed in with their attempt.
create table if not exists public.submission_attachments (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "institution_id" uuid not null,
  "submission_id" uuid not null,
  "file_id" uuid not null,
  "storage_key" varchar(512) not null,
  "filename" varchar(255) not null,
  "mime_type" varchar(128) not null,
  "size_bytes" bigint not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "archived_at" timestamp with time zone,
  "archived_by" uuid,
  "archive_reason" varchar(500),
  "created_by" uuid,
  "updated_by" uuid
);

-- One grading of one submission. Re-grading demotes the previous final (`is_final = false`)
-- and inserts a new row; the partial unique index guarantees a single current grade while
-- the full history stays queryable.
create table if not exists public.submission_grades (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "institution_id" uuid not null,
  "submission_id" uuid not null,
  "marks" numeric(6, 2) not null,
  "feedback" text,
  "graded_by" uuid not null,
  "graded_at" timestamp with time zone default now() not null,
  "is_final" boolean default true not null,
  "version" integer default 1 not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "archived_at" timestamp with time zone,
  "archived_by" uuid,
  "archive_reason" varchar(500),
  "created_by" uuid,
  "updated_by" uuid
);

-- -------------------------------------------------------------------------------------
-- Foreign keys
-- -------------------------------------------------------------------------------------

alter table public.assignments
  add constraint assignments_tenant_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint assignments_institution_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint assignments_campus_id_fk
    foreign key (campus_id) references public.campuses(id) on delete restrict,
  add constraint assignments_academic_year_id_fk
    foreign key (academic_year_id) references public.academic_years(id) on delete restrict,
  add constraint assignments_section_id_fk
    foreign key (section_id) references public.sections(id) on delete restrict,
  add constraint assignments_subject_id_fk
    foreign key (subject_id) references public.subjects(id) on delete restrict,
  add constraint assignments_created_by_employee_id_fk
    foreign key (created_by_employee_id) references public.employees(id) on delete restrict;

alter table public.assignment_attachments
  add constraint assignment_attachments_tenant_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint assignment_attachments_institution_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint assignment_attachments_assignment_id_fk
    foreign key (assignment_id) references public.assignments(id) on delete cascade,
  add constraint assignment_attachments_file_id_fk
    foreign key (file_id) references public.files(id) on delete restrict;

alter table public.assignment_submissions
  add constraint assignment_submissions_tenant_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint assignment_submissions_institution_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint assignment_submissions_assignment_id_fk
    foreign key (assignment_id) references public.assignments(id) on delete restrict,
  add constraint assignment_submissions_student_id_fk
    foreign key (student_id) references public.students(id) on delete restrict;

alter table public.submission_attachments
  add constraint submission_attachments_tenant_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint submission_attachments_institution_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint submission_attachments_submission_id_fk
    foreign key (submission_id) references public.assignment_submissions(id) on delete cascade,
  add constraint submission_attachments_file_id_fk
    foreign key (file_id) references public.files(id) on delete restrict;

alter table public.submission_grades
  add constraint submission_grades_tenant_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint submission_grades_institution_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint submission_grades_submission_id_fk
    foreign key (submission_id) references public.assignment_submissions(id) on delete restrict,
  add constraint submission_grades_graded_by_fk
    foreign key (graded_by) references public.employees(id) on delete restrict;

-- -------------------------------------------------------------------------------------
-- Indexes. Unique business keys are partial over live rows (ADR-008).
-- -------------------------------------------------------------------------------------

create index if not exists assignments_tenant_idx
  on public.assignments using btree (tenant_id);
create index if not exists assignments_section_status_idx
  on public.assignments using btree (section_id, status);
create index if not exists assignments_institution_year_idx
  on public.assignments using btree (institution_id, academic_year_id);
create index if not exists assignments_subject_idx
  on public.assignments using btree (subject_id);
create index if not exists assignments_creator_idx
  on public.assignments using btree (created_by_employee_id);
create index if not exists assignments_due_idx
  on public.assignments using btree (due_at);

create index if not exists assignment_attachments_tenant_idx
  on public.assignment_attachments using btree (tenant_id);
create index if not exists assignment_attachments_assignment_idx
  on public.assignment_attachments using btree (assignment_id);

create unique index if not exists assignment_submissions_attempt_key
  on public.assignment_submissions using btree (assignment_id, student_id, attempt_number)
  where archived_at is null;
create index if not exists assignment_submissions_tenant_idx
  on public.assignment_submissions using btree (tenant_id);
create index if not exists assignment_submissions_assignment_idx
  on public.assignment_submissions using btree (assignment_id, student_id);
create index if not exists assignment_submissions_student_idx
  on public.assignment_submissions using btree (student_id);

create index if not exists submission_attachments_tenant_idx
  on public.submission_attachments using btree (tenant_id);
create index if not exists submission_attachments_submission_idx
  on public.submission_attachments using btree (submission_id);

create unique index if not exists submission_grades_final_key
  on public.submission_grades using btree (submission_id)
  where is_final and archived_at is null;
create index if not exists submission_grades_tenant_idx
  on public.submission_grades using btree (tenant_id);
create index if not exists submission_grades_submission_idx
  on public.submission_grades using btree (submission_id);

-- -------------------------------------------------------------------------------------
-- Check constraints — the invariants restated in the database, so a hand-written SQL fix
-- in production cannot quietly violate them.
-- -------------------------------------------------------------------------------------

alter table public.assignments
  add constraint assignments_max_marks_positive
    check (max_marks is null or max_marks > 0),
  add constraint assignments_graded_needs_max_marks
    check ((not is_graded) or max_marks is not null),
  add constraint assignments_late_penalty_range
    check (late_penalty_percent >= 0 and late_penalty_percent <= 100),
  -- Dhaka is fixed UTC+6 with no DST, so the conversion is stable.
  add constraint assignments_due_after_assigned
    check ((due_at at time zone 'Asia/Dhaka')::date >= assigned_on),
  add constraint assignments_published_has_timestamp
    check (status not in ('published', 'closed') or published_at is not null),
  add constraint assignments_closed_has_timestamp
    check (status <> 'closed' or closed_at is not null);

alter table public.assignment_attachments
  add constraint assignment_attachments_size_positive
    check (size_bytes > 0);

alter table public.assignment_submissions
  add constraint assignment_submissions_attempt_positive
    check (attempt_number >= 1);

alter table public.submission_attachments
  add constraint submission_attachments_size_positive
    check (size_bytes > 0);

alter table public.submission_grades
  add constraint submission_grades_marks_non_negative
    check (marks >= 0);

-- -------------------------------------------------------------------------------------
-- Row-level security, grants and the updated_at trigger, per table. Migration 0002's
-- catalogue-driven loop does not re-run for tables created later, so this migration does
-- it itself, `with check` included.
-- -------------------------------------------------------------------------------------

do $$
declare
  target text;
  homework_tables constant text[] := array[
    'assignments',
    'assignment_attachments',
    'assignment_submissions',
    'submission_attachments',
    'submission_grades'
  ];
begin
  foreach target in array homework_tables
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
      'assignments', 'assignment_attachments', 'assignment_submissions',
      'submission_attachments', 'submission_grades'
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
      'Homework tables without forced row-level security and a tenant_isolation policy: %',
      offending;
  end if;

  -- Every one of the five must also carry the tenant column the policy reads. A policy on a
  -- table without `tenant_id` would fail at query time, not here.
  select string_agg(t.name, ', ' order by t.name)
  into offending
  from unnest(array[
    'assignments', 'assignment_attachments', 'assignment_submissions',
    'submission_attachments', 'submission_grades'
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
    raise exception 'Homework tables without a tenant_id column: %', offending;
  end if;
end
$$;

-- The global sweep: every public table is either RLS-protected or explicitly exempt.
select assert_rls_coverage();
