-- =====================================================================================
-- 0010 — Student lifecycle: constraints and indexes for enrolment, promotion, transfer,
--         withdrawal, readmission, documents and status history
--
-- Phase 3 completion adds no new tables: `students`, `enrollments`, `student_documents`,
-- `student_status_history` and `files` were all designed for the full lifecycle in 0001, and
-- they already carry forced row-level security from 0002. What the lifecycle features need
-- from the database is narrower and easy to state:
--
--   * The invariants the service relies on must be true in SQL, not only in TypeScript.
--     Promotion's idempotency rests entirely on `enrollments_student_year_key` (one
--     non-cancelled enrolment per student per academic year); this migration *asserts* that
--     index still exists rather than trusting that no intermediate migration dropped it,
--     because a promotion run against a database without it would silently double-enrol.
--   * An enrolment that ended before it began, or a document that expired before it was
--     issued, is corrupt data no matter which client wrote it. Restated as CHECK constraints
--     in the spirit of 0002: "never trust frontend data extends to not fully trusting the
--     backend either".
--   * Capacity checks and seat-freeing count `status = 'active' and archived_at is null`
--     rows per section on every enrolment, withdrawal, transfer and promotion. That predicate
--     gets a partial index so a bulk promotion of a large school is not a sequential scan
--     per student.
--
-- Everything here is hand-written lower-case SQL in the style of 0002–0006.
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- Check constraints. Named `<table>_<meaning>`, and phrased to hold for every row the
-- seeders and the application have ever written (no existing row has `ended_on` set).
-- -------------------------------------------------------------------------------------

-- An enrolment cannot end before it began. `ended_on` is null while the enrolment is live.
alter table public.enrollments
  add constraint enrollments_dates_ordered
  check (ended_on is null or ended_on >= enrolled_on);

-- A closed enrolment must say when it closed. Every non-terminal status is exempt; the
-- terminal ones are exactly the states the lifecycle services write together with `ended_on`,
-- except `cancelled`, which records an enrolment that never took effect and has no end date.
alter table public.enrollments
  add constraint enrollments_terminal_has_end_date
  check (
    status in ('active', 'cancelled')
    or ended_on is not null
  );

-- A document cannot expire before it was issued. Both fields are optional — a birth
-- certificate has no expiry — so the rule only binds when both are present.
alter table public.student_documents
  add constraint student_documents_dates_ordered
  check (expires_on is null or issued_on is null or expires_on >= issued_on);

-- Status history is printed on transfer certificates; a plainly impossible date would follow
-- the student for the rest of their career. Same band as `students_dob_sane` in 0002.
alter table public.student_status_history
  add constraint student_status_history_effective_sane
  check (effective_date > date '1950-01-01');

-- -------------------------------------------------------------------------------------
-- Indexes.
-- -------------------------------------------------------------------------------------

-- The seat-count predicate, verbatim. Capacity enforcement runs it once per enrolment write
-- and bulk promotion runs it per student; the partial index keeps that a range scan.
create index if not exists enrollments_section_active_idx
  on public.enrollments (section_id)
  where status = 'active' and archived_at is null;

-- Joining a student's documents to their file rows, and finding the document that owns a
-- storage object during signed-URL redemption.
create index if not exists student_documents_file_idx
  on public.student_documents (file_id);

-- An inter-institution transfer writes history on both sides; each institution reads its own
-- side ("everyone who transferred in/out this year") by institution and date.
create index if not exists student_status_history_institution_idx
  on public.student_status_history (institution_id, effective_date);

-- -------------------------------------------------------------------------------------
-- Assertions. The lifecycle services lean on two partial unique indexes created in 0001;
-- if either is ever dropped, promotion idempotency and roll uniqueness silently vanish.
-- Fail the migration rather than discover it in production data.
-- -------------------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'enrollments'
      and indexname = 'enrollments_student_year_key'
  ) then
    raise exception
      'enrollments_student_year_key is missing; promotion idempotency and double-enrolment protection depend on it';
  end if;

  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'enrollments'
      and indexname = 'enrollments_section_roll_key'
  ) then
    raise exception
      'enrollments_section_roll_key is missing; roll numbers would no longer be unique within a section';
  end if;
end
$$;

-- No new tables were created, so RLS coverage should be unchanged — but the assertion is the
-- contract every migration ends with, and it is what catches a table added by mistake.
select assert_rls_coverage();
