-- =====================================================================================
-- 0008 — Examinations and results
--
-- Seven tenant-scoped tables for Phase 8: `grading_scales`, `grade_bands`, `exams`,
-- `exam_subjects`, `exam_schedules`, `exam_marks` and `results`.
--
-- Hand-written rather than promoted from drizzle-kit, because the DDL is only half of what
-- this migration has to do. Migration 0002's RLS and trigger loops ran once, over the tables
-- that existed then; they do not re-run. A new tenant table is therefore unprotected until a
-- migration protects it explicitly, and 0003's `assert_rls_coverage()` — re-run at the bottom
-- of this file — is what makes forgetting a build failure rather than a data breach.
--
-- Three decisions worth stating, because each is load-bearing for how results behave:
--
--   * Marks and grade points are `numeric`, never `real` or `double precision`. A GPA is not
--     money, but the same argument applies: 33.3 + 33.3 + 33.4 must be 100.0 on a marksheet a
--     parent reads, and binary floating point cannot promise that. The application does its
--     arithmetic over integer hundredths and hands the database exact decimal strings.
--   * Grade bands are half-open, `[min_percentage, max_percentage)`, except the topmost band
--     which includes 100. A valid scale therefore satisfies `first.min = 0`,
--     `last.max = 100`, `next.min = previous.max` — properties that are checkable, unlike
--     "80-100, 70-79" where 79.5 belongs to nothing.
--   * Overlap is enforced by a deferred constraint trigger rather than an exclusion
--     constraint. An exclusion constraint over `(grading_scale_id, numrange(...))` would need
--     `btree_gist` for the uuid equality operator, and this deployment installs no extensions
--     beyond what the base image provides; requiring superuser at migration time in
--     production to get a constraint is a worse trade than a trigger. Deferred, so that
--     replacing a band set inside one transaction passes through an invalid intermediate
--     state without being refused.
--
-- Marks are never hard-deleted (ADR-008): every table here carries `archived_at`,
-- `archived_by` and `archive_reason`, and every uniqueness constraint is partial on
-- `archived_at is null`.
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- Enumerations
--
-- Guarded with `if not exists`, since `create type` has no such clause of its own and a
-- half-applied migration must be re-runnable up to the point it failed.
-- -------------------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'exam_type' and n.nspname = 'public') then
    create type public.exam_type as enum (
      'class_test', 'midterm', 'half_yearly', 'annual', 'model_test', 'board_practice'
    );
  end if;

  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'exam_status' and n.nspname = 'public') then
    create type public.exam_status as enum (
      'draft', 'scheduled', 'ongoing', 'marks_entry', 'under_review', 'published', 'archived'
    );
  end if;

  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'mark_entry_status' and n.nspname = 'public') then
    create type public.mark_entry_status as enum ('draft', 'submitted', 'approved');
  end if;
end
$$;

-- -------------------------------------------------------------------------------------
-- Tables
-- -------------------------------------------------------------------------------------

create table if not exists public.grading_scales (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "institution_id" uuid not null,
  "code" varchar(32) not null,
  "name_en" varchar(128) not null,
  "name_bn" varchar(128),
  "description" text,
  "is_default" boolean default false not null,
  "version" integer default 1 not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "archived_at" timestamp with time zone,
  "archived_by" uuid,
  "archive_reason" varchar(500),
  "created_by" uuid,
  "updated_by" uuid
);

create table if not exists public.grade_bands (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "institution_id" uuid not null,
  "grading_scale_id" uuid not null,
  "grade" varchar(8) not null,
  "grade_bn" varchar(16),
  "min_percentage" numeric(5, 2) not null,
  "max_percentage" numeric(5, 2) not null,
  "grade_point" numeric(3, 2) not null,
  "is_passing" boolean default true not null,
  "sort_order" smallint default 0 not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "archived_at" timestamp with time zone,
  "archived_by" uuid,
  "archive_reason" varchar(500),
  "created_by" uuid,
  "updated_by" uuid
);

create table if not exists public.exams (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "institution_id" uuid not null,
  "campus_id" uuid,
  "academic_year_id" uuid not null,
  "term_id" uuid,
  "code" varchar(32) not null,
  "name_en" varchar(128) not null,
  "name_bn" varchar(128),
  "type" "public"."exam_type" default 'class_test' not null,
  "grading_scale_id" uuid not null,
  "weightage_basis_points" integer default 10000 not null,
  "status" "public"."exam_status" default 'draft' not null,
  "start_date" date,
  "end_date" date,
  "instructions" text,
  "results_published_at" timestamp with time zone,
  "results_published_by" uuid,
  "version" integer default 1 not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "archived_at" timestamp with time zone,
  "archived_by" uuid,
  "archive_reason" varchar(500),
  "created_by" uuid,
  "updated_by" uuid
);

create table if not exists public.exam_subjects (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "institution_id" uuid not null,
  "exam_id" uuid not null,
  "class_level_id" uuid not null,
  "subject_id" uuid not null,
  "group_id" uuid,
  "class_subject_id" uuid,
  "full_marks" numeric(6, 2) not null,
  "pass_marks" numeric(6, 2) not null,
  "written_full_marks" numeric(6, 2),
  "written_pass_marks" numeric(6, 2),
  "mcq_full_marks" numeric(6, 2),
  "mcq_pass_marks" numeric(6, 2),
  "practical_full_marks" numeric(6, 2),
  "practical_pass_marks" numeric(6, 2),
  "continuous_full_marks" numeric(6, 2),
  "continuous_pass_marks" numeric(6, 2),
  "is_optional" boolean default false not null,
  "sort_order" smallint default 0 not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "archived_at" timestamp with time zone,
  "archived_by" uuid,
  "archive_reason" varchar(500),
  "created_by" uuid,
  "updated_by" uuid
);

create table if not exists public.exam_schedules (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "institution_id" uuid not null,
  "exam_subject_id" uuid not null,
  "section_id" uuid,
  "room_id" uuid,
  "invigilator_employee_id" uuid,
  "exam_date" date not null,
  "start_time" time not null,
  "end_time" time not null,
  "notes" varchar(500),
  "version" integer default 1 not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "archived_at" timestamp with time zone,
  "archived_by" uuid,
  "archive_reason" varchar(500),
  "created_by" uuid,
  "updated_by" uuid
);

create table if not exists public.exam_marks (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "institution_id" uuid not null,
  "exam_id" uuid not null,
  "exam_subject_id" uuid not null,
  "student_id" uuid not null,
  "enrollment_id" uuid,
  "section_id" uuid not null,
  "written_marks" numeric(6, 2),
  "mcq_marks" numeric(6, 2),
  "practical_marks" numeric(6, 2),
  "continuous_marks" numeric(6, 2),
  "obtained_marks" numeric(6, 2),
  "is_absent" boolean default false not null,
  "status" "public"."mark_entry_status" default 'draft' not null,
  "remarks" varchar(500),
  "entered_by" uuid,
  "entered_at" timestamp with time zone,
  "submitted_by" uuid,
  "submitted_at" timestamp with time zone,
  "reviewed_by" uuid,
  "reviewed_at" timestamp with time zone,
  "approved_by" uuid,
  "approved_at" timestamp with time zone,
  "correction_count" smallint default 0 not null,
  "version" integer default 1 not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "archived_at" timestamp with time zone,
  "archived_by" uuid,
  "archive_reason" varchar(500),
  "created_by" uuid,
  "updated_by" uuid
);

create table if not exists public.results (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "institution_id" uuid not null,
  "exam_id" uuid not null,
  "student_id" uuid not null,
  "enrollment_id" uuid,
  "academic_year_id" uuid not null,
  "class_level_id" uuid not null,
  "section_id" uuid not null,
  "total_marks" numeric(8, 2) default '0.00' not null,
  "obtained_marks" numeric(8, 2) default '0.00' not null,
  "percentage" numeric(5, 2) default '0.00' not null,
  "gpa" numeric(3, 2) default '0.00' not null,
  "grade" varchar(8) default 'F' not null,
  "gpa_subject_count" smallint default 0 not null,
  "failed_subject_count" smallint default 0 not null,
  "is_passed" boolean default false not null,
  "position_in_section" integer,
  "position_in_class" integer,
  "subject_breakdown" jsonb default '[]'::jsonb not null,
  "computed_at" timestamp with time zone default now() not null,
  "published_at" timestamp with time zone,
  "published_by" uuid,
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
--
-- `restrict` for tenancy, identity and academic parents — an academic year with results
-- against it must not be deletable. `cascade` only for rows that are genuinely owned by their
-- parent: a grading scale's bands, and an exam's subject configuration. Marks and results are
-- never cascaded away, because they are the record.
--
-- Names follow drizzle-kit's convention, so a future `pnpm --filter @shikkha/db run generate`
-- sees no spurious diff against this hand-written DDL.
-- -------------------------------------------------------------------------------------

alter table public.grading_scales
  add constraint "grading_scales_tenant_id_organizations_id_fk"
    foreign key ("tenant_id") references public.organizations("id") on delete restrict,
  add constraint "grading_scales_institution_id_institutions_id_fk"
    foreign key ("institution_id") references public.institutions("id") on delete restrict;

alter table public.grade_bands
  add constraint "grade_bands_tenant_id_organizations_id_fk"
    foreign key ("tenant_id") references public.organizations("id") on delete restrict,
  add constraint "grade_bands_institution_id_institutions_id_fk"
    foreign key ("institution_id") references public.institutions("id") on delete restrict,
  add constraint "grade_bands_grading_scale_id_grading_scales_id_fk"
    foreign key ("grading_scale_id") references public.grading_scales("id") on delete cascade;

alter table public.exams
  add constraint "exams_tenant_id_organizations_id_fk"
    foreign key ("tenant_id") references public.organizations("id") on delete restrict,
  add constraint "exams_institution_id_institutions_id_fk"
    foreign key ("institution_id") references public.institutions("id") on delete restrict,
  add constraint "exams_campus_id_campuses_id_fk"
    foreign key ("campus_id") references public.campuses("id") on delete restrict,
  add constraint "exams_academic_year_id_academic_years_id_fk"
    foreign key ("academic_year_id") references public.academic_years("id") on delete restrict,
  add constraint "exams_term_id_terms_id_fk"
    foreign key ("term_id") references public.terms("id") on delete restrict,
  add constraint "exams_grading_scale_id_grading_scales_id_fk"
    foreign key ("grading_scale_id") references public.grading_scales("id") on delete restrict;

alter table public.exam_subjects
  add constraint "exam_subjects_tenant_id_organizations_id_fk"
    foreign key ("tenant_id") references public.organizations("id") on delete restrict,
  add constraint "exam_subjects_institution_id_institutions_id_fk"
    foreign key ("institution_id") references public.institutions("id") on delete restrict,
  add constraint "exam_subjects_exam_id_exams_id_fk"
    foreign key ("exam_id") references public.exams("id") on delete cascade,
  add constraint "exam_subjects_class_level_id_class_levels_id_fk"
    foreign key ("class_level_id") references public.class_levels("id") on delete restrict,
  add constraint "exam_subjects_subject_id_subjects_id_fk"
    foreign key ("subject_id") references public.subjects("id") on delete restrict,
  add constraint "exam_subjects_group_id_academic_groups_id_fk"
    foreign key ("group_id") references public.academic_groups("id") on delete restrict,
  add constraint "exam_subjects_class_subject_id_class_subjects_id_fk"
    foreign key ("class_subject_id") references public.class_subjects("id") on delete set null;

alter table public.exam_schedules
  add constraint "exam_schedules_tenant_id_organizations_id_fk"
    foreign key ("tenant_id") references public.organizations("id") on delete restrict,
  add constraint "exam_schedules_institution_id_institutions_id_fk"
    foreign key ("institution_id") references public.institutions("id") on delete restrict,
  add constraint "exam_schedules_exam_subject_id_exam_subjects_id_fk"
    foreign key ("exam_subject_id") references public.exam_subjects("id") on delete cascade,
  add constraint "exam_schedules_section_id_sections_id_fk"
    foreign key ("section_id") references public.sections("id") on delete restrict,
  add constraint "exam_schedules_room_id_rooms_id_fk"
    foreign key ("room_id") references public.rooms("id") on delete restrict,
  add constraint "exam_schedules_invigilator_employee_id_employees_id_fk"
    foreign key ("invigilator_employee_id") references public.employees("id") on delete restrict;

alter table public.exam_marks
  add constraint "exam_marks_tenant_id_organizations_id_fk"
    foreign key ("tenant_id") references public.organizations("id") on delete restrict,
  add constraint "exam_marks_institution_id_institutions_id_fk"
    foreign key ("institution_id") references public.institutions("id") on delete restrict,
  add constraint "exam_marks_exam_id_exams_id_fk"
    foreign key ("exam_id") references public.exams("id") on delete restrict,
  add constraint "exam_marks_exam_subject_id_exam_subjects_id_fk"
    foreign key ("exam_subject_id") references public.exam_subjects("id") on delete restrict,
  add constraint "exam_marks_student_id_students_id_fk"
    foreign key ("student_id") references public.students("id") on delete restrict,
  add constraint "exam_marks_enrollment_id_enrollments_id_fk"
    foreign key ("enrollment_id") references public.enrollments("id") on delete restrict,
  add constraint "exam_marks_section_id_sections_id_fk"
    foreign key ("section_id") references public.sections("id") on delete restrict;

alter table public.results
  add constraint "results_tenant_id_organizations_id_fk"
    foreign key ("tenant_id") references public.organizations("id") on delete restrict,
  add constraint "results_institution_id_institutions_id_fk"
    foreign key ("institution_id") references public.institutions("id") on delete restrict,
  add constraint "results_exam_id_exams_id_fk"
    foreign key ("exam_id") references public.exams("id") on delete restrict,
  add constraint "results_student_id_students_id_fk"
    foreign key ("student_id") references public.students("id") on delete restrict,
  add constraint "results_enrollment_id_enrollments_id_fk"
    foreign key ("enrollment_id") references public.enrollments("id") on delete restrict,
  add constraint "results_academic_year_id_academic_years_id_fk"
    foreign key ("academic_year_id") references public.academic_years("id") on delete restrict,
  add constraint "results_class_level_id_class_levels_id_fk"
    foreign key ("class_level_id") references public.class_levels("id") on delete restrict,
  add constraint "results_section_id_sections_id_fk"
    foreign key ("section_id") references public.sections("id") on delete restrict;

-- -------------------------------------------------------------------------------------
-- Indexes
--
-- Every foreign key the application filters or joins on gets one. The tenant index is not
-- optional: without it, every tenant-scoped query on a school with ten years of marks is a
-- sequential scan, and `schema-conformance.spec.ts` fails the build for its absence.
-- Uniqueness is partial on `archived_at is null`, so an archived exam's code is reusable
-- while its record is preserved.
-- -------------------------------------------------------------------------------------

create unique index if not exists "grading_scales_institution_code_key"
  on public.grading_scales using btree ("institution_id", "code")
  where "grading_scales"."archived_at" is null;
create unique index if not exists "grading_scales_default_key"
  on public.grading_scales using btree ("institution_id")
  where "grading_scales"."is_default" and "grading_scales"."archived_at" is null;
create index if not exists "grading_scales_tenant_idx"
  on public.grading_scales using btree ("tenant_id");
create index if not exists "grading_scales_institution_idx"
  on public.grading_scales using btree ("institution_id");

create unique index if not exists "grade_bands_scale_grade_key"
  on public.grade_bands using btree ("grading_scale_id", "grade")
  where "grade_bands"."archived_at" is null;
create index if not exists "grade_bands_tenant_idx"
  on public.grade_bands using btree ("tenant_id");
create index if not exists "grade_bands_scale_idx"
  on public.grade_bands using btree ("grading_scale_id");

create unique index if not exists "exams_institution_code_key"
  on public.exams using btree ("institution_id", "code")
  where "exams"."archived_at" is null;
create index if not exists "exams_tenant_idx" on public.exams using btree ("tenant_id");
create index if not exists "exams_year_status_idx"
  on public.exams using btree ("academic_year_id", "status");
create index if not exists "exams_institution_idx" on public.exams using btree ("institution_id");
create index if not exists "exams_term_idx" on public.exams using btree ("term_id");
create index if not exists "exams_grading_scale_idx"
  on public.exams using btree ("grading_scale_id");
create index if not exists "exams_campus_idx" on public.exams using btree ("campus_id");

create unique index if not exists "exam_subjects_unique_key"
  on public.exam_subjects using btree ("exam_id", "class_level_id", "subject_id", "group_id")
  where "exam_subjects"."group_id" is not null and "exam_subjects"."archived_at" is null;
create unique index if not exists "exam_subjects_unique_nogroup_key"
  on public.exam_subjects using btree ("exam_id", "class_level_id", "subject_id")
  where "exam_subjects"."group_id" is null and "exam_subjects"."archived_at" is null;
create index if not exists "exam_subjects_tenant_idx"
  on public.exam_subjects using btree ("tenant_id");
create index if not exists "exam_subjects_exam_class_idx"
  on public.exam_subjects using btree ("exam_id", "class_level_id");
create index if not exists "exam_subjects_subject_idx"
  on public.exam_subjects using btree ("subject_id");
create index if not exists "exam_subjects_class_subject_idx"
  on public.exam_subjects using btree ("class_subject_id");

create unique index if not exists "exam_schedules_subject_section_key"
  on public.exam_schedules using btree ("exam_subject_id", "section_id")
  where "exam_schedules"."section_id" is not null and "exam_schedules"."archived_at" is null;
create unique index if not exists "exam_schedules_subject_key"
  on public.exam_schedules using btree ("exam_subject_id")
  where "exam_schedules"."section_id" is null and "exam_schedules"."archived_at" is null;
create index if not exists "exam_schedules_tenant_idx"
  on public.exam_schedules using btree ("tenant_id");
create index if not exists "exam_schedules_exam_subject_idx"
  on public.exam_schedules using btree ("exam_subject_id");
create index if not exists "exam_schedules_room_idx"
  on public.exam_schedules using btree ("room_id", "exam_date");
create index if not exists "exam_schedules_invigilator_idx"
  on public.exam_schedules using btree ("invigilator_employee_id", "exam_date");
create index if not exists "exam_schedules_section_idx"
  on public.exam_schedules using btree ("section_id");

create unique index if not exists "exam_marks_subject_student_key"
  on public.exam_marks using btree ("exam_subject_id", "student_id")
  where "exam_marks"."archived_at" is null;
create index if not exists "exam_marks_tenant_idx" on public.exam_marks using btree ("tenant_id");
create index if not exists "exam_marks_exam_status_idx"
  on public.exam_marks using btree ("exam_id", "status");
create index if not exists "exam_marks_exam_student_idx"
  on public.exam_marks using btree ("exam_id", "student_id");
create index if not exists "exam_marks_exam_subject_idx"
  on public.exam_marks using btree ("exam_subject_id", "section_id");
create index if not exists "exam_marks_student_idx"
  on public.exam_marks using btree ("student_id");
create index if not exists "exam_marks_section_idx"
  on public.exam_marks using btree ("section_id");
create index if not exists "exam_marks_enrollment_idx"
  on public.exam_marks using btree ("enrollment_id");

create unique index if not exists "results_exam_student_key"
  on public.results using btree ("exam_id", "student_id")
  where "results"."archived_at" is null;
create index if not exists "results_tenant_idx" on public.results using btree ("tenant_id");
create index if not exists "results_exam_section_idx"
  on public.results using btree ("exam_id", "section_id");
create index if not exists "results_exam_class_idx"
  on public.results using btree ("exam_id", "class_level_id");
create index if not exists "results_student_idx" on public.results using btree ("student_id");
create index if not exists "results_published_idx"
  on public.results using btree ("exam_id", "published_at");
create index if not exists "results_enrollment_idx"
  on public.results using btree ("enrollment_id");
create index if not exists "results_year_idx" on public.results using btree ("academic_year_id");

-- -------------------------------------------------------------------------------------
-- Data-integrity constraints that belong in the database, not only in a Zod schema.
--
-- These are the invariants where a violation would corrupt a marksheet, so they are restated
-- here even though the application validates them too. "Never trust frontend data" extends to
-- not fully trusting the backend either.
-- -------------------------------------------------------------------------------------

alter table public.grade_bands
  add constraint grade_bands_percentage_range
    check (min_percentage >= 0 and max_percentage <= 100 and max_percentage > min_percentage),
  -- 10.00 rather than 5.00: the NCTB scale tops out at 5, but an English-medium school running
  -- a 4.0 or a 10-point scale is configuration, not a schema change.
  add constraint grade_bands_point_range check (grade_point >= 0 and grade_point <= 10);

alter table public.exams
  add constraint exams_weightage_range
    check (weightage_basis_points between 0 and 10000),
  add constraint exams_dates_ordered
    check (start_date is null or end_date is null or end_date >= start_date),
  -- A published exam without a publication timestamp would make "when did the parents see
  -- this?" unanswerable, which is the first question asked when a result is disputed.
  add constraint exams_published_has_timestamp
    check (status <> 'published' or results_published_at is not null);

alter table public.exam_subjects
  add constraint exam_subjects_marks_positive check (full_marks > 0),
  add constraint exam_subjects_pass_within_full check (pass_marks between 0 and full_marks),
  add constraint exam_subjects_component_written
    check (written_full_marks is null
           or (written_full_marks > 0
               and (written_pass_marks is null
                    or written_pass_marks between 0 and written_full_marks))),
  add constraint exam_subjects_component_mcq
    check (mcq_full_marks is null
           or (mcq_full_marks > 0
               and (mcq_pass_marks is null or mcq_pass_marks between 0 and mcq_full_marks))),
  add constraint exam_subjects_component_practical
    check (practical_full_marks is null
           or (practical_full_marks > 0
               and (practical_pass_marks is null
                    or practical_pass_marks between 0 and practical_full_marks))),
  add constraint exam_subjects_component_continuous
    check (continuous_full_marks is null
           or (continuous_full_marks > 0
               and (continuous_pass_marks is null
                    or continuous_pass_marks between 0 and continuous_full_marks))),
  -- Either the paper has no component breakdown at all, or the components account for exactly
  -- the full marks. A breakdown that adds up to something else silently changes what a
  -- percentage means.
  add constraint exam_subjects_components_sum
    check (
      coalesce(written_full_marks, 0) + coalesce(mcq_full_marks, 0)
        + coalesce(practical_full_marks, 0) + coalesce(continuous_full_marks, 0) = 0
      or coalesce(written_full_marks, 0) + coalesce(mcq_full_marks, 0)
        + coalesce(practical_full_marks, 0) + coalesce(continuous_full_marks, 0) = full_marks
    );

alter table public.exam_schedules
  add constraint exam_schedules_time_ordered check (end_time > start_time);

alter table public.exam_marks
  add constraint exam_marks_non_negative
    check (
      coalesce(written_marks, 0) >= 0 and coalesce(mcq_marks, 0) >= 0
      and coalesce(practical_marks, 0) >= 0 and coalesce(continuous_marks, 0) >= 0
      and coalesce(obtained_marks, 0) >= 0
    ),
  -- An absence is not a zero. Allowing both on one row would let a marksheet claim a student
  -- who did not sit the paper scored 12.
  add constraint exam_marks_absent_carries_no_marks
    check (
      not is_absent
      or (written_marks is null and mcq_marks is null and practical_marks is null
          and continuous_marks is null and obtained_marks is null)
    ),
  add constraint exam_marks_correction_count_sane check (correction_count >= 0);

alter table public.results
  add constraint results_marks_sane
    check (total_marks >= 0 and obtained_marks >= 0 and obtained_marks <= total_marks),
  add constraint results_percentage_range check (percentage between 0 and 100),
  add constraint results_gpa_range check (gpa >= 0 and gpa <= 10),
  add constraint results_counts_non_negative
    check (gpa_subject_count >= 0 and failed_subject_count >= 0),
  add constraint results_positions_positive
    check (
      (position_in_section is null or position_in_section > 0)
      and (position_in_class is null or position_in_class > 0)
    );

-- -------------------------------------------------------------------------------------
-- Grade band coverage
--
-- The bands of one scale must not overlap. Checked at commit rather than per statement, so
-- that "replace the whole band set" — which archives the old rows and inserts the new ones in
-- one transaction — is not refused for an intermediate state that no one can observe.
--
-- The function is intentionally not SECURITY DEFINER: it must see exactly the rows the caller
-- can see, so an application-role insert is checked within its own tenant and cannot be made
-- to fail (or pass) by another tenant's data.
-- -------------------------------------------------------------------------------------

create or replace function grade_bands_assert_no_overlap() returns trigger
language plpgsql
as $$
declare
  scale_id uuid;
  offending text;
begin
  -- The trigger fires only on insert and update, so `new` is always assigned. Reading `old`
  -- here — even inside a coalesce — would raise "record old is not assigned yet" on an insert.
  scale_id := new.grading_scale_id;

  select string_agg(distinct a.grade || '/' || b.grade, ', ')
  into offending
  from public.grade_bands a
  join public.grade_bands b
    on b.grading_scale_id = a.grading_scale_id
   and b.id <> a.id
   and b.archived_at is null
   and numrange(b.min_percentage, b.max_percentage, '[)')
       && numrange(a.min_percentage, a.max_percentage, '[)')
  where a.grading_scale_id = scale_id
    and a.archived_at is null;

  if offending is not null then
    raise exception
      'Grade bands overlap on this scale (%). Bands are half-open [min, max) and must not intersect.',
      offending
      using errcode = 'check_violation';
  end if;

  return null;
end
$$;

drop trigger if exists grade_bands_no_overlap on public.grade_bands;
create constraint trigger grade_bands_no_overlap
  after insert or update on public.grade_bands
  deferrable initially deferred
  for each row execute function grade_bands_assert_no_overlap();

-- -------------------------------------------------------------------------------------
-- Row-level security
--
-- The loop in 0002 that enabled and forced RLS on every table with a `tenant_id` ran once and
-- does not re-run for tables created afterwards. Each of the seven tables below therefore
-- gets the policy explicitly, with the *same* expression 0002 used.
--
-- Both `using` and `with check` are required. `using` gates which existing rows are visible to
-- SELECT/UPDATE/DELETE; `with check` gates what INSERT/UPDATE may write, and it is the half
-- that stops one tenant writing a row stamped with another tenant's id. Omitting it does not
-- fail loudly — it succeeds, quietly, in the wrong tenant.
-- -------------------------------------------------------------------------------------

do $$
declare
  target text;
  protected_tables constant text[] := array[
    'grading_scales', 'grade_bands', 'exams', 'exam_subjects',
    'exam_schedules', 'exam_marks', 'results'
  ];
begin
  foreach target in array protected_tables
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

    -- The default privileges set in 0002 already cover tables created by the migrator, but
    -- restating them costs nothing and makes this migration self-contained if a deployment's
    -- default privileges were ever reset.
    execute format(
      'grant select, insert, update, delete on public.%I to shikkha_app', target);
    execute format('grant select on public.%I to shikkha_readonly', target);

    -- `updated_at` is maintained by the database, not by every call site, for the same reason
    -- the tenant filter is: a property that depends on remembering is not a property.
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
  select string_agg(c.relname, ', ' order by c.relname)
  into offending
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relname in (
      'grading_scales', 'grade_bands', 'exams', 'exam_subjects',
      'exam_schedules', 'exam_marks', 'results'
    )
    and (c.relrowsecurity is false or c.relforcerowsecurity is false);

  if offending is not null then
    raise exception 'Examination tables without forced row-level security: %', offending;
  end if;

  -- A policy that gates reads but not writes is the failure mode that looks like success:
  -- every isolation test passes on SELECT while INSERT happily stamps another tenant's id.
  select string_agg(c.relname, ', ' order by c.relname)
  into offending
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_policy p on p.polrelid = c.oid and p.polname = 'tenant_isolation'
  where n.nspname = 'public'
    and c.relname in (
      'grading_scales', 'grade_bands', 'exams', 'exam_subjects',
      'exam_schedules', 'exam_marks', 'results'
    )
    and p.polwithcheck is null;

  if offending is not null then
    raise exception 'tenant_isolation has no WITH CHECK on: %', offending;
  end if;

  -- Every one of these tables must be reachable by the application role, or the module fails
  -- at runtime with a permission error that looks like a bug in the service.
  select string_agg(t.name, ', ' order by t.name)
  into offending
  from unnest(array[
    'grading_scales', 'grade_bands', 'exams', 'exam_subjects',
    'exam_schedules', 'exam_marks', 'results'
  ]) as t(name)
  where not has_table_privilege('shikkha_app', 'public.' || t.name, 'SELECT');

  if offending is not null then
    raise exception 'shikkha_app cannot read: %', offending;
  end if;
end
$$;

-- The repository-wide check, re-run so this migration cannot be the one that leaves a table
-- unprotected. It covers every public table, not only the ones added here.
select assert_rls_coverage();
