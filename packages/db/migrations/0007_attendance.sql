-- =====================================================================================
-- 0007 — Attendance (Phase 7)
--
-- Attendance is the highest-volume institutional record the product holds and the one a
-- school is most often asked to prove years later: stipend eligibility, board form-fill-up
-- eligibility and the early-warning system all read it. So the schema is built around two
-- facts rather than around convenience.
--
--   1. A submitted register is a record, not a form. Marks on a submitted session are never
--      edited in place; `attendance_corrections` carries the before value, the after value,
--      a mandatory reason and an approver, and nothing here is ever hard-deleted (ADR-008).
--   2. The register's date is a calendar fact. `attendance_date` is `date`, not `timestamptz`.
--      "2026-03-15" is the same school day everywhere, and storing it as an instant is how
--      attendance percentages silently drift by one day at the Dhaka/UTC boundary (ADR-009).
--
-- Migration 0002's RLS and `set_updated_at` loops only ran over the tables that existed then,
-- so this file re-states both per table. Omitting the `with check` half of the policy would
-- leave cross-tenant *writes* possible while reads looked correct, which is the failure mode
-- the isolation suite exists to catch; it is spelled out for each table below.
--
-- Foreign-key constraints are named `<table>_<column>_fk` rather than drizzle-kit's
-- `<table>_<column>_<reftable>_<refcolumn>_fk`, because the latter exceeds Postgres's 63-byte
-- identifier limit for `attendance_corrections.student_attendance_id` and a silently truncated
-- constraint name is worse than a consistent short one. This file is hand-written throughout.
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- Enumerations. Each of these value sets is closed: adding "half day" changes how the
-- product computes an attendance percentage and a payslip, which is a code change, not a
-- tenant configuration change (see the rule in packages/db/src/schema/_shared.ts).
-- -------------------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'attendance_session_status') then
    create type public.attendance_session_status as enum ('open', 'submitted', 'locked');
  end if;

  if not exists (select 1 from pg_type where typname = 'student_attendance_status') then
    create type public.student_attendance_status as enum (
      'present', 'absent', 'late', 'excused', 'half_day'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'attendance_correction_status') then
    create type public.attendance_correction_status as enum ('pending', 'approved', 'rejected');
  end if;

  if not exists (select 1 from pg_type where typname = 'employee_attendance_status') then
    create type public.employee_attendance_status as enum (
      'present', 'absent', 'late', 'on_leave', 'half_day'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'employee_attendance_source') then
    create type public.employee_attendance_source as enum ('manual', 'device');
  end if;
end
$$;

-- -------------------------------------------------------------------------------------
-- Tables
-- -------------------------------------------------------------------------------------

-- One register: a section, on a date, optionally for one period and subject. `period_id`
-- null means daily attendance; non-null means the period-wise register a secondary school
-- takes. Both may exist for the same section on the same date, which is why uniqueness is
-- two partial indexes rather than one.
create table if not exists public.attendance_sessions (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "institution_id" uuid not null,
  "campus_id" uuid not null,
  "academic_year_id" uuid not null,
  "section_id" uuid not null,
  "period_id" uuid,
  "subject_id" uuid,
  "attendance_date" date not null,
  "taken_by_employee_id" uuid,
  "taken_by_user_id" uuid,
  "taken_at" timestamp with time zone,
  "status" "public"."attendance_session_status" default 'open' not null,
  "submitted_at" timestamp with time zone,
  "locked_at" timestamp with time zone,
  "locked_by" uuid,
  "notes" varchar(500),
  "version" integer default 1 not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "archived_at" timestamp with time zone,
  "archived_by" uuid,
  "archive_reason" varchar(500),
  "created_by" uuid,
  "updated_by" uuid,
  constraint attendance_sessions_tenant_id_fk foreign key ("tenant_id")
    references public.organizations("id") on delete restrict,
  constraint attendance_sessions_institution_id_fk foreign key ("institution_id")
    references public.institutions("id") on delete restrict,
  constraint attendance_sessions_campus_id_fk foreign key ("campus_id")
    references public.campuses("id") on delete restrict,
  constraint attendance_sessions_academic_year_id_fk foreign key ("academic_year_id")
    references public.academic_years("id") on delete restrict,
  constraint attendance_sessions_section_id_fk foreign key ("section_id")
    references public.sections("id") on delete restrict,
  constraint attendance_sessions_period_id_fk foreign key ("period_id")
    references public.periods("id") on delete restrict,
  constraint attendance_sessions_subject_id_fk foreign key ("subject_id")
    references public.subjects("id") on delete restrict,
  constraint attendance_sessions_taken_by_employee_id_fk foreign key ("taken_by_employee_id")
    references public.employees("id") on delete set null
);

-- One student's mark in one register. `enrollment_id` is stored rather than resolved at read
-- time: a student who moves section mid-year must keep the marks earned in the section they
-- were actually sitting in.
create table if not exists public.student_attendance (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "institution_id" uuid not null,
  "session_id" uuid not null,
  "student_id" uuid not null,
  "enrollment_id" uuid,
  "status" "public"."student_attendance_status" not null,
  "minutes_late" smallint,
  "remarks" varchar(500),
  "marked_at" timestamp with time zone,
  "marked_by" uuid,
  "last_corrected_at" timestamp with time zone,
  "version" integer default 1 not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "archived_at" timestamp with time zone,
  "archived_by" uuid,
  "archive_reason" varchar(500),
  "created_by" uuid,
  "updated_by" uuid,
  constraint student_attendance_tenant_id_fk foreign key ("tenant_id")
    references public.organizations("id") on delete restrict,
  constraint student_attendance_institution_id_fk foreign key ("institution_id")
    references public.institutions("id") on delete restrict,
  -- `restrict`, not `cascade`: deleting a register must not silently take thirty academic
  -- records with it. Sessions are archived, never deleted.
  constraint student_attendance_session_id_fk foreign key ("session_id")
    references public.attendance_sessions("id") on delete restrict,
  constraint student_attendance_student_id_fk foreign key ("student_id")
    references public.students("id") on delete restrict,
  constraint student_attendance_enrollment_id_fk foreign key ("enrollment_id")
    references public.enrollments("id") on delete set null
);

-- Every requested change to a submitted mark. Inserted `pending`, moved once to `approved`
-- or `rejected`, never removed. `reason` is `not null` in the database and not only in Zod:
-- an unexplained change to an academic record is what this table exists to prevent.
create table if not exists public.attendance_corrections (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "institution_id" uuid not null,
  "student_attendance_id" uuid not null,
  "session_id" uuid not null,
  "student_id" uuid not null,
  "previous_status" "public"."student_attendance_status" not null,
  "new_status" "public"."student_attendance_status" not null,
  "previous_minutes_late" smallint,
  "new_minutes_late" smallint,
  "reason" text not null,
  "requested_by" uuid not null,
  "requested_by_employee_id" uuid,
  "requested_at" timestamp with time zone default now() not null,
  "status" "public"."attendance_correction_status" default 'pending' not null,
  "approved_by" uuid,
  "approved_at" timestamp with time zone,
  "decision_note" varchar(1000),
  "version" integer default 1 not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "archived_at" timestamp with time zone,
  "archived_by" uuid,
  "archive_reason" varchar(500),
  "created_by" uuid,
  "updated_by" uuid,
  constraint attendance_corrections_tenant_id_fk foreign key ("tenant_id")
    references public.organizations("id") on delete restrict,
  constraint attendance_corrections_institution_id_fk foreign key ("institution_id")
    references public.institutions("id") on delete restrict,
  constraint attendance_corrections_mark_id_fk foreign key ("student_attendance_id")
    references public.student_attendance("id") on delete restrict,
  constraint attendance_corrections_session_id_fk foreign key ("session_id")
    references public.attendance_sessions("id") on delete restrict,
  constraint attendance_corrections_student_id_fk foreign key ("student_id")
    references public.students("id") on delete restrict,
  constraint attendance_corrections_requested_by_employee_id_fk foreign key ("requested_by_employee_id")
    references public.employees("id") on delete set null
);

-- Staff presence. Separate from the student register because it is payroll input rather than
-- an academic record, and because `attendance.employee.mark` is held by HR — a class teacher
-- who marks thirty students must not thereby be able to mark their colleagues.
create table if not exists public.employee_attendance (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "institution_id" uuid not null,
  "campus_id" uuid,
  "employee_id" uuid not null,
  "attendance_date" date not null,
  "check_in_at" timestamp with time zone,
  "check_out_at" timestamp with time zone,
  "status" "public"."employee_attendance_status" default 'present' not null,
  "source" "public"."employee_attendance_source" default 'manual' not null,
  "device_reference" varchar(64),
  "minutes_late" smallint,
  "worked_minutes" integer,
  "remarks" varchar(500),
  "version" integer default 1 not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "archived_at" timestamp with time zone,
  "archived_by" uuid,
  "archive_reason" varchar(500),
  "created_by" uuid,
  "updated_by" uuid,
  constraint employee_attendance_tenant_id_fk foreign key ("tenant_id")
    references public.organizations("id") on delete restrict,
  constraint employee_attendance_institution_id_fk foreign key ("institution_id")
    references public.institutions("id") on delete restrict,
  constraint employee_attendance_campus_id_fk foreign key ("campus_id")
    references public.campuses("id") on delete set null,
  constraint employee_attendance_employee_id_fk foreign key ("employee_id")
    references public.employees("id") on delete restrict
);

-- -------------------------------------------------------------------------------------
-- Indexes.
--
-- Uniqueness is partial on `archived_at is null` throughout, so an archived register does not
-- permanently block the section/date slot it occupied. Every foreign key the application
-- filters or joins on gets an index; without them each of the report queries below degrades
-- to a sequential scan over the largest table in the product.
-- -------------------------------------------------------------------------------------

create unique index if not exists attendance_sessions_period_key
  on public.attendance_sessions using btree ("section_id", "attendance_date", "period_id")
  where "period_id" is not null and "archived_at" is null;

create unique index if not exists attendance_sessions_daily_key
  on public.attendance_sessions using btree ("section_id", "attendance_date")
  where "period_id" is null and "archived_at" is null;

create index if not exists attendance_sessions_tenant_idx
  on public.attendance_sessions using btree ("tenant_id");
create index if not exists attendance_sessions_section_date_idx
  on public.attendance_sessions using btree ("section_id", "attendance_date");
create index if not exists attendance_sessions_institution_date_idx
  on public.attendance_sessions using btree ("institution_id", "attendance_date");
create index if not exists attendance_sessions_year_idx
  on public.attendance_sessions using btree ("academic_year_id");
create index if not exists attendance_sessions_campus_idx
  on public.attendance_sessions using btree ("campus_id");
create index if not exists attendance_sessions_period_idx
  on public.attendance_sessions using btree ("period_id");
create index if not exists attendance_sessions_subject_idx
  on public.attendance_sessions using btree ("subject_id");
create index if not exists attendance_sessions_taken_by_idx
  on public.attendance_sessions using btree ("taken_by_employee_id");

create unique index if not exists student_attendance_session_student_key
  on public.student_attendance using btree ("session_id", "student_id")
  where "archived_at" is null;

create index if not exists student_attendance_tenant_idx
  on public.student_attendance using btree ("tenant_id");
create index if not exists student_attendance_session_idx
  on public.student_attendance using btree ("session_id");
create index if not exists student_attendance_student_status_idx
  on public.student_attendance using btree ("student_id", "status");
create index if not exists student_attendance_enrollment_idx
  on public.student_attendance using btree ("enrollment_id");

create index if not exists attendance_corrections_tenant_idx
  on public.attendance_corrections using btree ("tenant_id");
create index if not exists attendance_corrections_status_idx
  on public.attendance_corrections using btree ("institution_id", "status");
create index if not exists attendance_corrections_mark_idx
  on public.attendance_corrections using btree ("student_attendance_id");
create index if not exists attendance_corrections_session_idx
  on public.attendance_corrections using btree ("session_id");
create index if not exists attendance_corrections_student_idx
  on public.attendance_corrections using btree ("student_id");
create index if not exists attendance_corrections_requested_by_idx
  on public.attendance_corrections using btree ("requested_by_employee_id");

create unique index if not exists employee_attendance_employee_date_key
  on public.employee_attendance using btree ("employee_id", "attendance_date")
  where "archived_at" is null;

create index if not exists employee_attendance_tenant_idx
  on public.employee_attendance using btree ("tenant_id");
create index if not exists employee_attendance_institution_date_idx
  on public.employee_attendance using btree ("institution_id", "attendance_date");
create index if not exists employee_attendance_employee_idx
  on public.employee_attendance using btree ("employee_id");
create index if not exists employee_attendance_campus_idx
  on public.employee_attendance using btree ("campus_id");

-- -------------------------------------------------------------------------------------
-- Row-level security.
--
-- Migration 0002's driving loop ran once, over the tables that existed then. It is restated
-- here per table rather than re-run, so this file states exactly what it protects.
--
-- `using` gates which existing rows SELECT/UPDATE/DELETE can see. `with check` gates what
-- INSERT/UPDATE may write, and is what stops a session from writing a row stamped with
-- another tenant's id. Both halves are required; omitting `with check` produces a table that
-- reads correctly and accepts cross-tenant writes silently.
-- -------------------------------------------------------------------------------------

alter table public.attendance_sessions enable row level security;
alter table public.attendance_sessions force row level security;
drop policy if exists tenant_isolation on public.attendance_sessions;
create policy tenant_isolation on public.attendance_sessions
  for all
  using (
    app_is_platform_admin()
    or (tenant_id is not null and tenant_id = app_current_tenant_id())
  )
  with check (
    app_is_platform_admin()
    or (tenant_id is not null and tenant_id = app_current_tenant_id())
  );

alter table public.student_attendance enable row level security;
alter table public.student_attendance force row level security;
drop policy if exists tenant_isolation on public.student_attendance;
create policy tenant_isolation on public.student_attendance
  for all
  using (
    app_is_platform_admin()
    or (tenant_id is not null and tenant_id = app_current_tenant_id())
  )
  with check (
    app_is_platform_admin()
    or (tenant_id is not null and tenant_id = app_current_tenant_id())
  );

alter table public.attendance_corrections enable row level security;
alter table public.attendance_corrections force row level security;
drop policy if exists tenant_isolation on public.attendance_corrections;
create policy tenant_isolation on public.attendance_corrections
  for all
  using (
    app_is_platform_admin()
    or (tenant_id is not null and tenant_id = app_current_tenant_id())
  )
  with check (
    app_is_platform_admin()
    or (tenant_id is not null and tenant_id = app_current_tenant_id())
  );

alter table public.employee_attendance enable row level security;
alter table public.employee_attendance force row level security;
drop policy if exists tenant_isolation on public.employee_attendance;
create policy tenant_isolation on public.employee_attendance
  for all
  using (
    app_is_platform_admin()
    or (tenant_id is not null and tenant_id = app_current_tenant_id())
  )
  with check (
    app_is_platform_admin()
    or (tenant_id is not null and tenant_id = app_current_tenant_id())
  );

-- -------------------------------------------------------------------------------------
-- `updated_at` maintenance. Same story as the RLS loop: 0002's loop does not re-run, so the
-- trigger is attached here per table. Without it, an optimistic-lock conflict message would
-- quote a timestamp that never changed.
-- -------------------------------------------------------------------------------------

drop trigger if exists set_updated_at on public.attendance_sessions;
create trigger set_updated_at before update on public.attendance_sessions
  for each row execute function set_updated_at();

drop trigger if exists set_updated_at on public.student_attendance;
create trigger set_updated_at before update on public.student_attendance
  for each row execute function set_updated_at();

drop trigger if exists set_updated_at on public.attendance_corrections;
create trigger set_updated_at before update on public.attendance_corrections
  for each row execute function set_updated_at();

drop trigger if exists set_updated_at on public.employee_attendance;
create trigger set_updated_at before update on public.employee_attendance
  for each row execute function set_updated_at();

-- -------------------------------------------------------------------------------------
-- Data-integrity constraints that belong in the database, not only in a Zod schema.
--
-- The application enforces all of these and more (holidays, enrolment windows, the Dhaka
-- "today"). These are the subset where a violation would corrupt an attendance percentage
-- that someone's stipend depends on, so they are restated where nothing can bypass them.
-- -------------------------------------------------------------------------------------

alter table public.attendance_sessions
  -- A register for next Tuesday is always a data-entry error. `current_date` is the server's
  -- UTC day and Dhaka is UTC+6, so between 00:00 and 06:00 Dhaka time "today" is already
  -- tomorrow in UTC; the constraint allows one day of slack and the service enforces the
  -- exact Dhaka-calendar rule with `todayInDhaka()`.
  add constraint attendance_sessions_not_future check (attendance_date <= current_date + 1),
  add constraint attendance_sessions_submitted_has_time check (
    status = 'open' or submitted_at is not null
  ),
  add constraint attendance_sessions_locked_has_time check (
    status <> 'locked' or locked_at is not null
  ),
  -- A subject-wise register without a period is a daily register that has been mislabelled.
  add constraint attendance_sessions_subject_needs_period check (
    subject_id is null or period_id is not null
  );

alter table public.student_attendance
  add constraint student_attendance_minutes_late_sane check (
    minutes_late is null or minutes_late between 0 and 600
  ),
  -- Minutes late on a student who was not late is a contradiction that would inflate every
  -- punctuality report built on this column.
  add constraint student_attendance_minutes_need_late check (
    minutes_late is null or status in ('late', 'half_day')
  );

alter table public.attendance_corrections
  -- Mirrors `reasonSchema` (min 10 characters). A correction whose reason is "fix" is not a
  -- record of anything.
  add constraint attendance_corrections_reason_present check (
    char_length(btrim(reason)) >= 10
  ),
  -- A correction that changes nothing is noise in the trail that hides the real ones.
  add constraint attendance_corrections_changes_something check (
    previous_status <> new_status
    or previous_minutes_late is distinct from new_minutes_late
  ),
  add constraint attendance_corrections_decision_recorded check (
    (status = 'pending' and approved_at is null and approved_by is null)
    or (status <> 'pending' and approved_at is not null)
  ),
  add constraint attendance_corrections_minutes_sane check (
    (previous_minutes_late is null or previous_minutes_late between 0 and 600)
    and (new_minutes_late is null or new_minutes_late between 0 and 600)
  );

alter table public.employee_attendance
  add constraint employee_attendance_not_future check (attendance_date <= current_date + 1),
  add constraint employee_attendance_checkout_after_checkin check (
    check_out_at is null or check_in_at is null or check_out_at >= check_in_at
  ),
  add constraint employee_attendance_minutes_late_sane check (
    minutes_late is null or minutes_late between 0 and 1440
  ),
  add constraint employee_attendance_worked_minutes_sane check (
    worked_minutes is null or worked_minutes between 0 and 1440
  );

-- -------------------------------------------------------------------------------------
-- Assertion — fail the migration rather than ship four unprotected tables.
--
-- `assert_rls_coverage()` (0003) checks every table in `public`, not only ones with a
-- `tenant_id`, and refuses if any lacks forced RLS or has RLS with no policy.
-- -------------------------------------------------------------------------------------

select assert_rls_coverage();
