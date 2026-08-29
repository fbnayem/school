-- =====================================================================================
-- 0021 — Learning Management System (Phase 10)
--
-- Eleven tenant-scoped tables: the course a teacher builds for one class level + subject
-- (`courses`), its cohort (`course_enrolments`), its ordered structure (`course_modules`,
-- `lessons`), the files and links on a lesson (`lesson_resources` — exactly one of
-- storage key / url, said by a CHECK constraint), per-student progress (`lesson_progress`),
-- and the assessments (`quizzes` → `quiz_questions` → `quiz_options`) with each student's
-- sittings (`quiz_attempts` → `quiz_answers`).
--
-- `quiz_options.is_correct` is the answer key; the service strips it from every
-- student-facing response. A submitted attempt is immutable in the service; the database's
-- own contribution is the unique (quiz, student, attempt) index and the ordering checks.
--
-- Nothing here is ever hard-deleted (ADR-008): removing content is a soft archive, and
-- every table carries the archive columns.
--
-- Migration 0002's RLS and `set_updated_at` loops only ran over the tables that existed
-- then, so this file re-states both per table, `with check` included — omitting the write
-- half would leave cross-tenant *writes* possible while reads looked correct.
--
-- Enum types are prefixed `lms_` and foreign keys use the short `<table>_<column>_fk`
-- naming (the 0016 convention) so no name here can collide with another module's.
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- Enumerations. Closed value sets: a new lifecycle state or question kind changes the
-- grading and visibility code — a code change, not tenant configuration (see the rule in
-- packages/db/src/schema/_shared.ts).
-- -------------------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'lms_course_status') then
    create type public.lms_course_status as enum ('draft', 'published', 'archived');
  end if;

  if not exists (select 1 from pg_type where typname = 'lms_resource_kind') then
    create type public.lms_resource_kind as enum ('file', 'link', 'video');
  end if;

  if not exists (select 1 from pg_type where typname = 'lms_progress_status') then
    create type public.lms_progress_status as enum ('not_started', 'in_progress', 'completed');
  end if;

  if not exists (select 1 from pg_type where typname = 'lms_quiz_status') then
    create type public.lms_quiz_status as enum ('draft', 'published', 'archived');
  end if;

  if not exists (select 1 from pg_type where typname = 'lms_question_kind') then
    create type public.lms_question_kind as enum (
      'mcq_single', 'mcq_multi', 'true_false', 'short_text'
    );
  end if;
end
$$;

-- -------------------------------------------------------------------------------------
-- Tables
-- -------------------------------------------------------------------------------------

-- The course a teacher builds for one class level + subject in one academic year. Drafts
-- are the owner's desk drawer; students see published courses only.
create table if not exists public.courses (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "institution_id" uuid not null,
  "campus_id" uuid not null,
  "academic_year_id" uuid not null,
  "class_level_id" uuid not null,
  "subject_id" uuid not null,
  -- Nullable: an administrator without an employee record may create on a teacher's behalf;
  -- the acting user is always recorded in created_by.
  "owner_employee_id" uuid,
  "title" varchar(255) not null,
  "title_bn" varchar(255),
  "description" text,
  "status" public.lms_course_status default 'draft' not null,
  "published_at" timestamp with time zone,
  "version" integer default 1 not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "archived_at" timestamp with time zone,
  "archived_by" uuid,
  "archive_reason" varchar(500),
  "created_by" uuid,
  "updated_by" uuid
);

-- A student's membership of a course — the cohort the completion report and gradebook are
-- computed over, and the gate on quiz attempts.
create table if not exists public.course_enrolments (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "institution_id" uuid not null,
  "course_id" uuid not null,
  "student_id" uuid not null,
  "enrolled_at" timestamp with time zone default now() not null,
  "completed_at" timestamp with time zone,
  "version" integer default 1 not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "archived_at" timestamp with time zone,
  "archived_by" uuid,
  "archive_reason" varchar(500),
  "created_by" uuid,
  "updated_by" uuid
);

create table if not exists public.course_modules (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "institution_id" uuid not null,
  "course_id" uuid not null,
  "title" varchar(255) not null,
  "sequence" smallint not null,
  "is_published" boolean default false not null,
  "version" integer default 1 not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "archived_at" timestamp with time zone,
  "archived_by" uuid,
  "archive_reason" varchar(500),
  "created_by" uuid,
  "updated_by" uuid
);

create table if not exists public.lessons (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "institution_id" uuid not null,
  "module_id" uuid not null,
  "title" varchar(255) not null,
  "content" text,
  "sequence" smallint not null,
  "estimated_minutes" smallint,
  "is_published" boolean default false not null,
  "version" integer default 1 not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "archived_at" timestamp with time zone,
  "archived_by" uuid,
  "archive_reason" varchar(500),
  "created_by" uuid,
  "updated_by" uuid
);

-- A file, link or video on a lesson. Exactly one of storage_key / url — a CHECK below.
-- File bytes live in object storage; file_id points at the central `files` row that
-- authorises signed-URL redemption.
create table if not exists public.lesson_resources (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "institution_id" uuid not null,
  "lesson_id" uuid not null,
  "kind" public.lms_resource_kind not null,
  "file_id" uuid,
  "storage_key" varchar(512),
  "url" varchar(2048),
  "title" varchar(255) not null,
  "mime_type" varchar(128),
  "size_bytes" bigint,
  "version" integer default 1 not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "archived_at" timestamp with time zone,
  "archived_by" uuid,
  "archive_reason" varchar(500),
  "created_by" uuid,
  "updated_by" uuid
);

create table if not exists public.lesson_progress (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "institution_id" uuid not null,
  "lesson_id" uuid not null,
  "student_id" uuid not null,
  "status" public.lms_progress_status default 'not_started' not null,
  "completed_at" timestamp with time zone,
  "seconds_spent" integer default 0 not null,
  "version" integer default 1 not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "archived_at" timestamp with time zone,
  "archived_by" uuid,
  "archive_reason" varchar(500),
  "created_by" uuid,
  "updated_by" uuid
);

-- An assessment anchored on exactly one of a course or a lesson (a CHECK below).
create table if not exists public.quizzes (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "institution_id" uuid not null,
  "course_id" uuid,
  "lesson_id" uuid,
  "title" varchar(255) not null,
  "total_marks" numeric(6, 2) not null,
  "pass_marks" numeric(6, 2) not null,
  -- Null means untimed. Enforced against the SERVER clock from started_at, never the client.
  "time_limit_minutes" smallint,
  "attempts_allowed" smallint default 1 not null,
  "shuffle_questions" boolean default false not null,
  "status" public.lms_quiz_status default 'draft' not null,
  "published_at" timestamp with time zone,
  "version" integer default 1 not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "archived_at" timestamp with time zone,
  "archived_by" uuid,
  "archive_reason" varchar(500),
  "created_by" uuid,
  "updated_by" uuid
);

create table if not exists public.quiz_questions (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "institution_id" uuid not null,
  "quiz_id" uuid not null,
  "sequence" smallint not null,
  "kind" public.lms_question_kind not null,
  "prompt" text not null,
  "marks" numeric(6, 2) not null,
  "allow_partial_credit" boolean default false not null,
  "version" integer default 1 not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "archived_at" timestamp with time zone,
  "archived_by" uuid,
  "archive_reason" varchar(500),
  "created_by" uuid,
  "updated_by" uuid
);

-- is_correct is the answer key; it must never reach a student. The service redacts it in
-- every student-facing response.
create table if not exists public.quiz_options (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "institution_id" uuid not null,
  "question_id" uuid not null,
  "sequence" smallint not null,
  "text" text not null,
  "is_correct" boolean default false not null,
  "version" integer default 1 not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "archived_at" timestamp with time zone,
  "archived_by" uuid,
  "archive_reason" varchar(500),
  "created_by" uuid,
  "updated_by" uuid
);

-- One sitting of one quiz by one student. started_at is the sole anchor for the time
-- limit; submitted_at set means the attempt is immutable.
create table if not exists public.quiz_attempts (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "institution_id" uuid not null,
  "quiz_id" uuid not null,
  "student_id" uuid not null,
  "attempt_number" smallint not null,
  "started_at" timestamp with time zone default now() not null,
  "submitted_at" timestamp with time zone,
  "score" numeric(6, 2),
  "is_graded" boolean default false not null,
  "version" integer default 1 not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "archived_at" timestamp with time zone,
  "archived_by" uuid,
  "archive_reason" varchar(500),
  "created_by" uuid,
  "updated_by" uuid
);

create table if not exists public.quiz_answers (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "institution_id" uuid not null,
  "attempt_id" uuid not null,
  "question_id" uuid not null,
  "selected_option_ids" jsonb default '[]'::jsonb not null,
  "text_answer" text,
  "marks_awarded" numeric(6, 2),
  "graded_by" uuid,
  "graded_at" timestamp with time zone,
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

alter table public.courses
  add constraint courses_tenant_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint courses_institution_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint courses_campus_id_fk
    foreign key (campus_id) references public.campuses(id) on delete restrict,
  add constraint courses_academic_year_id_fk
    foreign key (academic_year_id) references public.academic_years(id) on delete restrict,
  add constraint courses_class_level_id_fk
    foreign key (class_level_id) references public.class_levels(id) on delete restrict,
  add constraint courses_subject_id_fk
    foreign key (subject_id) references public.subjects(id) on delete restrict,
  add constraint courses_owner_employee_id_fk
    foreign key (owner_employee_id) references public.employees(id) on delete restrict;

alter table public.course_enrolments
  add constraint course_enrolments_tenant_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint course_enrolments_institution_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint course_enrolments_course_id_fk
    foreign key (course_id) references public.courses(id) on delete restrict,
  add constraint course_enrolments_student_id_fk
    foreign key (student_id) references public.students(id) on delete restrict;

alter table public.course_modules
  add constraint course_modules_tenant_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint course_modules_institution_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint course_modules_course_id_fk
    foreign key (course_id) references public.courses(id) on delete restrict;

alter table public.lessons
  add constraint lessons_tenant_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint lessons_institution_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint lessons_module_id_fk
    foreign key (module_id) references public.course_modules(id) on delete restrict;

alter table public.lesson_resources
  add constraint lesson_resources_tenant_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint lesson_resources_institution_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint lesson_resources_lesson_id_fk
    foreign key (lesson_id) references public.lessons(id) on delete restrict,
  add constraint lesson_resources_file_id_fk
    foreign key (file_id) references public.files(id) on delete restrict;

alter table public.lesson_progress
  add constraint lesson_progress_tenant_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint lesson_progress_institution_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint lesson_progress_lesson_id_fk
    foreign key (lesson_id) references public.lessons(id) on delete restrict,
  add constraint lesson_progress_student_id_fk
    foreign key (student_id) references public.students(id) on delete restrict;

alter table public.quizzes
  add constraint quizzes_tenant_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint quizzes_institution_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint quizzes_course_id_fk
    foreign key (course_id) references public.courses(id) on delete restrict,
  add constraint quizzes_lesson_id_fk
    foreign key (lesson_id) references public.lessons(id) on delete restrict;

alter table public.quiz_questions
  add constraint quiz_questions_tenant_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint quiz_questions_institution_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint quiz_questions_quiz_id_fk
    foreign key (quiz_id) references public.quizzes(id) on delete restrict;

alter table public.quiz_options
  add constraint quiz_options_tenant_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint quiz_options_institution_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint quiz_options_question_id_fk
    foreign key (question_id) references public.quiz_questions(id) on delete restrict;

alter table public.quiz_attempts
  add constraint quiz_attempts_tenant_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint quiz_attempts_institution_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint quiz_attempts_quiz_id_fk
    foreign key (quiz_id) references public.quizzes(id) on delete restrict,
  add constraint quiz_attempts_student_id_fk
    foreign key (student_id) references public.students(id) on delete restrict;

alter table public.quiz_answers
  add constraint quiz_answers_tenant_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint quiz_answers_institution_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint quiz_answers_attempt_id_fk
    foreign key (attempt_id) references public.quiz_attempts(id) on delete restrict,
  add constraint quiz_answers_question_id_fk
    foreign key (question_id) references public.quiz_questions(id) on delete restrict,
  add constraint quiz_answers_graded_by_fk
    foreign key (graded_by) references public.employees(id) on delete restrict;

-- -------------------------------------------------------------------------------------
-- Indexes. Unique business keys are partial over live rows (ADR-008).
-- -------------------------------------------------------------------------------------

create index if not exists courses_tenant_idx
  on public.courses using btree (tenant_id);
create index if not exists courses_institution_status_idx
  on public.courses using btree (institution_id, status);
create index if not exists courses_year_class_idx
  on public.courses using btree (academic_year_id, class_level_id);
create index if not exists courses_subject_idx
  on public.courses using btree (subject_id);
create index if not exists courses_owner_idx
  on public.courses using btree (owner_employee_id);

create unique index if not exists course_enrolments_course_student_key
  on public.course_enrolments using btree (course_id, student_id)
  where archived_at is null;
create index if not exists course_enrolments_tenant_idx
  on public.course_enrolments using btree (tenant_id);
create index if not exists course_enrolments_student_idx
  on public.course_enrolments using btree (student_id);
create index if not exists course_enrolments_course_idx
  on public.course_enrolments using btree (course_id);

create unique index if not exists course_modules_course_sequence_key
  on public.course_modules using btree (course_id, sequence)
  where archived_at is null;
create index if not exists course_modules_tenant_idx
  on public.course_modules using btree (tenant_id);
create index if not exists course_modules_course_idx
  on public.course_modules using btree (course_id);

create unique index if not exists lessons_module_sequence_key
  on public.lessons using btree (module_id, sequence)
  where archived_at is null;
create index if not exists lessons_tenant_idx
  on public.lessons using btree (tenant_id);
create index if not exists lessons_module_idx
  on public.lessons using btree (module_id);

create index if not exists lesson_resources_tenant_idx
  on public.lesson_resources using btree (tenant_id);
create index if not exists lesson_resources_lesson_idx
  on public.lesson_resources using btree (lesson_id);

create unique index if not exists lesson_progress_lesson_student_key
  on public.lesson_progress using btree (lesson_id, student_id)
  where archived_at is null;
create index if not exists lesson_progress_tenant_idx
  on public.lesson_progress using btree (tenant_id);
create index if not exists lesson_progress_student_idx
  on public.lesson_progress using btree (student_id);
create index if not exists lesson_progress_lesson_idx
  on public.lesson_progress using btree (lesson_id);

create index if not exists quizzes_tenant_idx
  on public.quizzes using btree (tenant_id);
create index if not exists quizzes_institution_status_idx
  on public.quizzes using btree (institution_id, status);
create index if not exists quizzes_course_idx
  on public.quizzes using btree (course_id);
create index if not exists quizzes_lesson_idx
  on public.quizzes using btree (lesson_id);

create unique index if not exists quiz_questions_quiz_sequence_key
  on public.quiz_questions using btree (quiz_id, sequence)
  where archived_at is null;
create index if not exists quiz_questions_tenant_idx
  on public.quiz_questions using btree (tenant_id);
create index if not exists quiz_questions_quiz_idx
  on public.quiz_questions using btree (quiz_id);

create unique index if not exists quiz_options_question_sequence_key
  on public.quiz_options using btree (question_id, sequence)
  where archived_at is null;
create index if not exists quiz_options_tenant_idx
  on public.quiz_options using btree (tenant_id);
create index if not exists quiz_options_question_idx
  on public.quiz_options using btree (question_id);

create unique index if not exists quiz_attempts_attempt_key
  on public.quiz_attempts using btree (quiz_id, student_id, attempt_number)
  where archived_at is null;
create index if not exists quiz_attempts_tenant_idx
  on public.quiz_attempts using btree (tenant_id);
create index if not exists quiz_attempts_quiz_student_idx
  on public.quiz_attempts using btree (quiz_id, student_id);
create index if not exists quiz_attempts_student_idx
  on public.quiz_attempts using btree (student_id);

create unique index if not exists quiz_answers_attempt_question_key
  on public.quiz_answers using btree (attempt_id, question_id)
  where archived_at is null;
create index if not exists quiz_answers_tenant_idx
  on public.quiz_answers using btree (tenant_id);
create index if not exists quiz_answers_attempt_idx
  on public.quiz_answers using btree (attempt_id);
create index if not exists quiz_answers_question_idx
  on public.quiz_answers using btree (question_id);

-- -------------------------------------------------------------------------------------
-- Check constraints — the invariants restated in the database, so a hand-written SQL fix
-- in production cannot quietly violate them.
-- -------------------------------------------------------------------------------------

alter table public.courses
  add constraint courses_published_has_timestamp
    check (status <> 'published' or published_at is not null);

alter table public.course_enrolments
  add constraint course_enrolments_completed_after_enrolled
    check (completed_at is null or completed_at >= enrolled_at);

alter table public.course_modules
  add constraint course_modules_sequence_positive
    check (sequence >= 1);

alter table public.lessons
  add constraint lessons_sequence_positive
    check (sequence >= 1),
  add constraint lessons_estimated_minutes_positive
    check (estimated_minutes is null or estimated_minutes > 0);

alter table public.lesson_resources
  -- Exactly one source: `(a is not null) <> (b is not null)` is false when both are set and
  -- false when neither is.
  add constraint lesson_resources_exactly_one_source
    check ((storage_key is not null) <> (url is not null)),
  -- The kind and the source column agree: a file carries a storage key, a link or video a URL.
  add constraint lesson_resources_kind_source_aligned
    check ((kind = 'file') = (storage_key is not null)),
  -- A stored file always carries its authorization row and its byte-level facts.
  add constraint lesson_resources_file_has_metadata
    check (kind <> 'file' or (file_id is not null and size_bytes is not null and mime_type is not null)),
  add constraint lesson_resources_size_positive
    check (size_bytes is null or size_bytes > 0);

alter table public.lesson_progress
  add constraint lesson_progress_seconds_non_negative
    check (seconds_spent >= 0),
  add constraint lesson_progress_completed_recorded
    check (status <> 'completed' or completed_at is not null);

alter table public.quizzes
  add constraint quizzes_exactly_one_anchor
    check ((course_id is not null) <> (lesson_id is not null)),
  add constraint quizzes_total_marks_positive
    check (total_marks > 0),
  add constraint quizzes_pass_within_total
    check (pass_marks >= 0 and pass_marks <= total_marks),
  add constraint quizzes_time_limit_positive
    check (time_limit_minutes is null or time_limit_minutes > 0),
  add constraint quizzes_attempts_allowed_positive
    check (attempts_allowed >= 1),
  add constraint quizzes_published_has_timestamp
    check (status <> 'published' or published_at is not null);

alter table public.quiz_questions
  add constraint quiz_questions_marks_positive
    check (marks > 0),
  add constraint quiz_questions_sequence_positive
    check (sequence >= 1);

alter table public.quiz_options
  add constraint quiz_options_sequence_positive
    check (sequence >= 1);

alter table public.quiz_attempts
  add constraint quiz_attempts_number_positive
    check (attempt_number >= 1),
  add constraint quiz_attempts_submit_after_start
    check (submitted_at is null or submitted_at >= started_at),
  add constraint quiz_attempts_score_non_negative
    check (score is null or score >= 0),
  add constraint quiz_attempts_graded_has_score
    check ((not is_graded) or score is not null),
  add constraint quiz_attempts_graded_is_submitted
    check ((not is_graded) or submitted_at is not null);

alter table public.quiz_answers
  add constraint quiz_answers_marks_non_negative
    check (marks_awarded is null or marks_awarded >= 0),
  -- A hand-graded answer always names its grader and moment; auto-grading leaves both null.
  add constraint quiz_answers_manual_grade_recorded
    check ((graded_by is null) = (graded_at is null));

-- -------------------------------------------------------------------------------------
-- Row-level security, grants and the updated_at trigger, per table. Migration 0002's
-- catalogue-driven loop does not re-run for tables created later, so this migration does
-- it itself, `with check` included.
-- -------------------------------------------------------------------------------------

do $$
declare
  target text;
  lms_tables constant text[] := array[
    'courses',
    'course_enrolments',
    'course_modules',
    'lessons',
    'lesson_resources',
    'lesson_progress',
    'quizzes',
    'quiz_questions',
    'quiz_options',
    'quiz_attempts',
    'quiz_answers'
  ];
begin
  foreach target in array lms_tables
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
      'courses', 'course_enrolments', 'course_modules', 'lessons', 'lesson_resources',
      'lesson_progress', 'quizzes', 'quiz_questions', 'quiz_options', 'quiz_attempts',
      'quiz_answers'
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
      'LMS tables without forced row-level security and a tenant_isolation policy: %',
      offending;
  end if;

  -- Every one of the eleven must also carry the tenant column the policy reads. A policy on
  -- a table without `tenant_id` would fail at query time, not here.
  select string_agg(t.name, ', ' order by t.name)
  into offending
  from unnest(array[
    'courses', 'course_enrolments', 'course_modules', 'lessons', 'lesson_resources',
    'lesson_progress', 'quizzes', 'quiz_questions', 'quiz_options', 'quiz_attempts',
    'quiz_answers'
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
    raise exception 'LMS tables without a tenant_id column: %', offending;
  end if;
end
$$;

-- The global sweep: every public table is either RLS-protected or explicitly exempt.
select assert_rls_coverage();
