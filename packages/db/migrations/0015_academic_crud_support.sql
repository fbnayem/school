-- =====================================================================================
-- 0006 — Database-level guarantees for the academic configuration CRUD (Phase 2 completion)
--
-- The tables this migration touches — rooms, periods, shifts, calendar_events,
-- class_subjects and the two employee assignment tables — already exist and already carry
-- forced row-level security from migration 0002. Nothing here creates a table, so nothing
-- here creates a new RLS surface; the closing `assert_rls_coverage()` proves that rather
-- than asserting it in a comment.
--
-- What was missing is the other half of the contract. Until now these tables had no write
-- path, so their invariants lived only in the seed script's good behaviour. Now that an API
-- can write them, each invariant that would corrupt a timetable, an attendance percentage or
-- a result sheet is restated where it cannot be bypassed:
--
--   * `rooms.capacity` must be positive — `sections` already had this constraint, `rooms`
--     did not, and a room with capacity 0 silently makes every allocation check fail.
--   * `periods.sequence` must be a real period number. The upper bound is deliberately
--     generous: `AcademicService.replacePeriods` parks surviving rows just under it while it
--     renumbers, because `periods_shift_sequence_key` is a plain partial unique index and is
--     therefore enforced row by row during an UPDATE.
--   * `class_subjects.mark_distribution` must add up to `full_marks` — KI-009, which
--     `docs/14_KNOWN_ISSUES.md` deferred precisely because it "needs a non-trivial immutable
--     function". That function is below. The field stops being merely descriptive the moment
--     mark entry exists, and a distribution that does not sum produces a result sheet whose
--     total is wrong in a way no one notices until a board exam.
--
-- Plus the indexes the new list endpoints filter on. Every one of them backs a `where` clause
-- in `AcademicService`; none is speculative.
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- Mark distribution — the immutable helper KI-009 was waiting for.
--
-- A CHECK constraint may not contain a subquery, so summing the values of a jsonb object
-- against another column has to go through a function. It is `immutable` because it depends
-- on nothing but its argument, and it answers `null` for a non-object payload so a malformed
-- value fails the constraint rather than raising inside it.
-- -------------------------------------------------------------------------------------

create or replace function class_subject_component_sum(distribution jsonb) returns numeric
language sql
immutable
strict
as $$
  select case
           when jsonb_typeof(distribution) <> 'object' then null::numeric
           else (
             select coalesce(
               sum(case when jsonb_typeof(value) = 'number' then (value #>> '{}')::numeric end),
               0
             )
             from jsonb_each(distribution)
           )
         end
$$;

alter table public.class_subjects
  drop constraint if exists class_subjects_mark_distribution_sums;

-- `not valid` on purpose. The demo seeder generates `round(full_marks * 0.75)` /
-- `round(full_marks * 0.25)`, which is 38 + 13 = 51 for a 50-mark practical subject — so a
-- database seeded before today holds rows that break this. Refusing to migrate would make the
-- constraint impossible to introduce; grandfathering the existing rows while refusing every
-- new and updated one is the change that can actually ship.
alter table public.class_subjects
  add constraint class_subjects_mark_distribution_sums check (
    mark_distribution = '{}'::jsonb
    or class_subject_component_sum(mark_distribution) = full_marks
  ) not valid;

-- On a clean database — every CI run, every fresh install — this validates and the constraint
-- becomes a full guarantee. On a database carrying the seeded rows above it warns and moves
-- on, so the migration is not blocked by data it did not write.
do $$
begin
  alter table public.class_subjects
    validate constraint class_subjects_mark_distribution_sums;
  raise notice 'class_subjects_mark_distribution_sums validated against all existing rows';
exception when check_violation then
  raise warning 'class_subjects_mark_distribution_sums holds for new and updated rows but could not be validated against the existing ones. Correct them, then run: alter table public.class_subjects validate constraint class_subjects_mark_distribution_sums;';
end
$$;

-- -------------------------------------------------------------------------------------
-- Data-integrity constraints that belong in the database, not only in a Zod schema.
--
-- `drop constraint if exists` before each `add` so re-running this file by hand during
-- development behaves the same way the migrator's single application does.
-- -------------------------------------------------------------------------------------

alter table public.rooms
  drop constraint if exists rooms_capacity_positive;
alter table public.rooms
  add constraint rooms_capacity_positive check (capacity is null or capacity > 0);

-- 1–20 are the real period numbers a shift can hold (the Zod schema caps a shift at 20).
-- 381–400 is the staging band `replacePeriods` uses while it renumbers; see the comment on
-- `PERIOD_SEQUENCE_STAGING_TOP` in `apps/api/src/modules/academic/academic.service.ts`.
alter table public.periods
  drop constraint if exists periods_sequence_sane;
alter table public.periods
  add constraint periods_sequence_sane check ("sequence" between 1 and 400);

-- -------------------------------------------------------------------------------------
-- Indexes for the columns the new list and integrity queries filter on.
--
-- The existing unique indexes on these tables are all partial (`where archived_at is null`),
-- so they cannot serve a query that includes archived rows — which every one of these list
-- endpoints can be asked to do.
-- -------------------------------------------------------------------------------------

create index if not exists rooms_institution_idx
  on public.rooms (institution_id);
create index if not exists rooms_campus_idx
  on public.rooms (campus_id);

create index if not exists shifts_institution_idx
  on public.shifts (institution_id);

-- `replacePeriods` and `listPeriods` both read every period of one shift, archived included.
create index if not exists periods_shift_idx
  on public.periods (shift_id, "sequence");

-- The calendar is read by institution and date window; `calendar_events_lookup_idx` starts
-- with academic_year_id, which the "what is happening this month" query does not supply.
create index if not exists calendar_events_institution_date_idx
  on public.calendar_events (institution_id, start_date, end_date);

create index if not exists class_subjects_institution_idx
  on public.class_subjects (institution_id, academic_year_id);

-- Assignment lists are drawn per institution and year; the existing indexes are keyed on
-- employee or section, which does not help the "who teaches what this year" screen.
create index if not exists employee_section_institution_year_idx
  on public.employee_section_assignments (institution_id, academic_year_id);
create index if not exists employee_subject_institution_year_idx
  on public.employee_subject_assignments (institution_id, academic_year_id);

-- -------------------------------------------------------------------------------------
-- Assertions — fail the migration rather than ship a silently-disabled control.
-- -------------------------------------------------------------------------------------

-- Three things are asserted: the constraints exist, and the function the mark-distribution
-- constraint depends on actually computes what the constraint assumes. The function is
-- exercised directly rather than through a trial INSERT, because these tables are under
-- forced RLS — an insert here would be refused by the tenant policy before the CHECK was ever
-- reached, and the assertion would pass for the wrong reason.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.class_subjects'::regclass
      and conname = 'class_subjects_mark_distribution_sums'
      and contype = 'c'
  ) then
    raise exception 'class_subjects_mark_distribution_sums was not created';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.rooms'::regclass and conname = 'rooms_capacity_positive'
  ) then
    raise exception 'rooms_capacity_positive was not created';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.periods'::regclass and conname = 'periods_sequence_sane'
  ) then
    raise exception 'periods_sequence_sane was not created';
  end if;

  -- A distribution that sums correctly.
  if class_subject_component_sum('{"theory": 70, "mcq": 30}'::jsonb) <> 100 then
    raise exception 'class_subject_component_sum does not add up a valid distribution';
  end if;

  -- One that does not. If this ever returned 100 the constraint would accept a wrong total.
  if class_subject_component_sum('{"theory": 70, "mcq": 20}'::jsonb) = 100 then
    raise exception 'class_subject_component_sum accepted a distribution that does not sum';
  end if;

  -- An empty object is the column default and is allowed by the constraint's first branch.
  if class_subject_component_sum('{}'::jsonb) <> 0 then
    raise exception 'class_subject_component_sum mishandles an empty distribution';
  end if;

  -- A non-numeric component contributes nothing, so the total cannot match and the row is
  -- refused. Silently coercing "seventy" to 70 would be far worse than rejecting it.
  if class_subject_component_sum('{"theory": "seventy"}'::jsonb) <> 0 then
    raise exception 'class_subject_component_sum coerces non-numeric components';
  end if;

  -- A payload that is not an object at all must not raise inside the constraint.
  if class_subject_component_sum('[1, 2]'::jsonb) is not null then
    raise exception 'class_subject_component_sum mishandles a non-object payload';
  end if;
end
$$;

-- Every table in `public` must still be under forced row-level security. This migration adds
-- no tables, so this closes the file as a proof rather than a change.
select assert_rls_coverage();
