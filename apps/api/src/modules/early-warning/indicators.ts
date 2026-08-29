/**
 * The signals, and the SQL that measures them.
 *
 * ── THE DESIGN DECISION IN THIS MODULE ─────────────────────────────────────────────────
 *
 * **Every risk figure in this file is computed in SQL. No model is consulted, ever.**
 *
 * The indicators are deterministic, reproducible, auditable aggregates over data the school
 * already holds: attendance marks, exam marks, homework submissions, invoices, library loans,
 * behaviour records. A model is not needed to notice that attendance fell twelve points, and a
 * model that hallucinated the figure would be far worse than no feature at all — a teacher
 * confronting a guardian with an invented number loses the argument and the school loses the
 * family. So the numbers are queries, they read the same rows a teacher can open for
 * themselves, and every measurement carries the identifiers needed to go and check it.
 *
 * A provider appears exactly once in this module, in `early-warning.narrative.ts`, and only
 * after the numbers exist: it turns computed evidence into readable prose in English and
 * Bangla. When it is unavailable the evidence still stands and the prose is simply absent.
 *
 * ── What a school can change, and what it cannot ───────────────────────────────────────
 *
 * A `key` here names a MEASUREMENT, and a measurement is a query. Thresholds, windows, the
 * observation floor, whether an indicator is on and whether a guardian may see it are all
 * configuration on `risk_indicators`, per institution, changeable through the API with nothing
 * deployed. The query itself is code, because writing one is writing code. An institution row
 * whose key is not in `MEASUREMENTS` is skipped and reported rather than guessed at.
 *
 * ── The crossing rule lives in the database ────────────────────────────────────────────
 *
 * Every measurement is wrapped by `crossingsOnly()`, which filters with the same
 * `risk_band_for()` function the insert trigger uses to decide the band. One implementation:
 * a selection query with its own comparison would eventually disagree with the trigger, and
 * the disagreement would surface as evidence rows that silently vanish or bands that do not
 * match their reasons.
 */

import { sql, type SQL } from 'drizzle-orm';
import { addDays, calendarDate, todayInDhaka, type CalendarDate } from '@shikkha/shared';
import type { RiskDomain, RiskMeasureUnit } from './early-warning.contracts';

/** A row of `risk_indicators`, in the shape a measurement needs. */
export interface IndicatorConfig {
  key: string;
  nameEn: string;
  nameBn: string | null;
  domain: RiskDomain;
  unit: RiskMeasureUnit;
  direction: 'above' | 'below';
  windowDays: number;
  baselineWindowDays: number | null;
  minObservations: number;
  thresholdLow: string | null;
  thresholdMedium: string;
  thresholdHigh: string;
  visibleToGuardian: boolean;
}

/** One student's measurement for one indicator, straight out of the database. */
export interface MeasurementRow {
  student_id: string;
  measured_value: string;
  comparison_value: string | null;
  observation_count: number;
  period_start: string;
  period_end: string;
  subject_id: string | null;
  subject_name: string | null;
  detail: Record<string, unknown>;
}

export interface MeasurementContext {
  institutionId: string;
  academicYearId: string;
  /** The run's reference date. Every window is measured back from HERE, never from `now()`. */
  asOfDate: CalendarDate;
  studentIds: string[];
  indicator: IndicatorConfig;
}

/**
 * The seeded catalogue.
 *
 * Kept in step with the identical rows in migration 0035 — that migration seeds every
 * institution which existed when it ran, and this list is how an institution created
 * afterwards gets the same eight. The duplication is the same one `DEFAULT_RULES` and 0030
 * carry, and for the same reason: a migration cannot reach into the future.
 */
export interface IndicatorTemplate {
  key: string;
  nameEn: string;
  nameBn: string;
  description: string;
  domain: RiskDomain;
  unit: RiskMeasureUnit;
  direction: 'above' | 'below';
  windowDays: number;
  baselineWindowDays: number | null;
  minObservations: number;
  thresholdLow: string | null;
  thresholdMedium: string;
  thresholdHigh: string;
  visibleToGuardian: boolean;
  sortOrder: number;
}

export const DEFAULT_INDICATORS: readonly IndicatorTemplate[] = [
  {
    key: 'attendance_rate_low',
    nameEn: "Attendance below the school's norm",
    nameBn: 'উপস্থিতির হার নির্ধারিত মানের নিচে',
    description: 'The share of sessions attended over the window, counting a half day as half.',
    domain: 'attendance',
    unit: 'percent',
    direction: 'below',
    windowDays: 60,
    baselineWindowDays: null,
    // Twenty sessions. An attendance rate over four registers is noise, and noise presented as
    // a reason is worse than silence.
    minObservations: 20,
    thresholdLow: '90.00',
    thresholdMedium: '80.00',
    thresholdHigh: '70.00',
    visibleToGuardian: true,
    sortOrder: 10,
  },
  {
    key: 'attendance_rate_drop',
    nameEn: 'Attendance falling against the previous period',
    nameBn: 'আগের সময়ের তুলনায় উপস্থিতি কমছে',
    description:
      'How many percentage points attendance has fallen against the preceding window of equal length.',
    domain: 'attendance',
    unit: 'points',
    direction: 'above',
    windowDays: 45,
    baselineWindowDays: 45,
    minObservations: 15,
    thresholdLow: '5.00',
    thresholdMedium: '10.00',
    thresholdHigh: '20.00',
    visibleToGuardian: true,
    sortOrder: 20,
  },
  {
    key: 'subject_mark_decline',
    nameEn: 'Marks declining in a subject',
    nameBn: 'কোনো বিষয়ে নম্বর কমছে',
    description:
      'The fall in percentage between the first and the most recent assessment in one subject.',
    domain: 'academic',
    unit: 'points',
    direction: 'above',
    windowDays: 180,
    baselineWindowDays: null,
    // Three assessments, which is what makes it a trend rather than a bad afternoon.
    minObservations: 3,
    thresholdLow: '8.00',
    thresholdMedium: '15.00',
    thresholdHigh: '25.00',
    visibleToGuardian: true,
    sortOrder: 30,
  },
  {
    key: 'homework_missed',
    nameEn: 'Homework not submitted',
    nameBn: 'জমা না দেওয়া বাড়ির কাজ',
    description:
      'Published assignments whose due date has passed with no submission from this student.',
    domain: 'academic',
    unit: 'count',
    direction: 'above',
    windowDays: 60,
    baselineWindowDays: null,
    minObservations: 1,
    thresholdLow: '2.00',
    thresholdMedium: '4.00',
    thresholdHigh: '8.00',
    visibleToGuardian: true,
    sortOrder: 40,
  },
  {
    key: 'fee_overdue_days',
    nameEn: 'Fees overdue',
    nameBn: 'বকেয়া ফি',
    description: 'Days past the due date of the oldest invoice that still carries a balance.',
    domain: 'financial',
    unit: 'days',
    direction: 'above',
    windowDays: 365,
    baselineWindowDays: null,
    minObservations: 1,
    thresholdLow: '15.00',
    thresholdMedium: '30.00',
    thresholdHigh: '60.00',
    visibleToGuardian: true,
    sortOrder: 50,
  },
  {
    key: 'library_overdue_items',
    nameEn: 'Library books overdue',
    nameBn: 'ফেরত না দেওয়া গ্রন্থাগারের বই',
    description: 'Library copies still out past their due date.',
    domain: 'financial',
    unit: 'count',
    direction: 'above',
    windowDays: 365,
    baselineWindowDays: null,
    minObservations: 1,
    thresholdLow: '1.00',
    thresholdMedium: '3.00',
    thresholdHigh: '5.00',
    visibleToGuardian: true,
    sortOrder: 60,
  },
  {
    key: 'behaviour_incidents',
    nameEn: 'Substantiated behaviour records',
    nameBn: 'প্রমাণিত আচরণগত রেকর্ড',
    description:
      'Behaviour records substantiated within the window. Draft and unsubstantiated records are never counted.',
    domain: 'behavioural',
    unit: 'count',
    direction: 'above',
    windowDays: 90,
    baselineWindowDays: null,
    minObservations: 1,
    thresholdLow: '1.00',
    thresholdMedium: '2.00',
    thresholdHigh: '4.00',
    // Off. An allegation a school is still investigating is not something a guardian should
    // meet in a portal, and the discipline module has its own confidentiality rules.
    visibleToGuardian: false,
    sortOrder: 70,
  },
  {
    key: 'absence_streak',
    nameEn: 'Consecutive days absent',
    nameBn: 'টানা অনুপস্থিতির দিন',
    description: 'The longest run of consecutive school days marked absent within the window.',
    domain: 'wellbeing',
    unit: 'count',
    direction: 'above',
    windowDays: 90,
    baselineWindowDays: null,
    minObservations: 1,
    thresholdLow: '3.00',
    thresholdMedium: '5.00',
    thresholdHigh: '10.00',
    // Off. A run of absences is the signal a school phones home about; the family should hear
    // it from a person.
    visibleToGuardian: false,
    sortOrder: 80,
  },
];

/** The window an indicator looks at, ending on the run's reference date. */
export function windowOf(context: MeasurementContext): { start: CalendarDate; end: CalendarDate } {
  return {
    start: addDays(context.asOfDate, -context.indicator.windowDays),
    end: context.asOfDate,
  };
}

/**
 * Attendance, weighted.
 *
 * `present`, `late` and `excused` all count as attended and `half_day` as half. Excused is
 * deliberately not an absence: a child with a doctor's note is not a child the school has
 * lost touch with, and counting it against them would fill the medium band with families who
 * did everything right. A school that disagrees changes its thresholds, not this expression —
 * but the weighting itself is code, and it is written here once so no two indicators can
 * disagree about what "attended" means.
 */
const ATTENDED_WEIGHT = sql`
  case sa.status
    when 'present' then 1.0
    when 'late' then 1.0
    when 'excused' then 1.0
    when 'half_day' then 0.5
    else 0.0
  end`;

/**
 * Keep only the measurements that actually cross a threshold, using the database's own band
 * function — the same one the insert trigger uses.
 *
 * The observation floor is applied here too, so a student with four registers never reaches
 * the evidence table at all. The trigger enforces it a second time, because the floor is an
 * uncertainty rule and an uncertainty rule that only one layer knows about is one refactor
 * away from being gone.
 */
function crossingsOnly(inner: SQL, indicator: IndicatorConfig): SQL {
  return sql`
    select m.*
      from (${inner}) as m
     where public.risk_band_for(
             ${indicator.direction}::public.risk_indicator_direction,
             m.measured_value,
             ${indicator.thresholdLow}::numeric,
             ${indicator.thresholdMedium}::numeric,
             ${indicator.thresholdHigh}::numeric
           ) <> 'none'
       and m.observation_count >= ${indicator.minObservations}`;
}

type MeasurementBuilder = (context: MeasurementContext) => SQL;

/**
 * One query per indicator key.
 *
 * Every one returns the same column set — `student_id`, `measured_value`, `comparison_value`,
 * `observation_count`, `period_start`, `period_end`, `subject_id`, `subject_name`, `detail` —
 * so the service writes evidence one way rather than eight. `detail` is where the identifiers
 * of the underlying rows go: it is what turns "four assignments not submitted" from a claim
 * into four assignment ids a teacher can open.
 */
export const MEASUREMENTS: Readonly<Record<string, MeasurementBuilder>> = {
  /** The level: how much of the register this student has actually been in. */
  attendance_rate_low: (context) => {
    const { start, end } = windowOf(context);
    return crossingsOnly(
      sql`
        select sa.student_id::text                                   as student_id,
               round(100.0 * sum(${ATTENDED_WEIGHT}) / count(*), 2)  as measured_value,
               null::numeric                                         as comparison_value,
               count(*)::int                                         as observation_count,
               ${start}::text                                        as period_start,
               ${end}::text                                          as period_end,
               null::uuid                                            as subject_id,
               null::text                                            as subject_name,
               jsonb_build_object(
                 'sessions', count(*),
                 'absences', count(*) filter (where sa.status = 'absent'),
                 'lates', count(*) filter (where sa.status = 'late')
               )                                                     as detail
          from public.student_attendance sa
          join public.attendance_sessions ses on ses.id = sa.session_id
         where sa.institution_id = ${context.institutionId}
           and sa.student_id = any(${context.studentIds}::uuid[])
           and sa.archived_at is null
           and ses.archived_at is null
           and ses.attendance_date between ${start}::date and ${end}::date
         group by sa.student_id`,
      context.indicator,
    );
  },

  /**
   * The trend: this window against the one immediately before it, of equal length.
   *
   * `observation_count` is the SMALLER of the two windows' session counts, because a
   * comparison is only as trustworthy as its thinner half — a 15-point "drop" measured against
   * three registers in March is not a fact about a child.
   */
  attendance_rate_drop: (context) => {
    const { indicator } = context;
    const baselineLength = indicator.baselineWindowDays ?? indicator.windowDays;
    const recentStart = addDays(context.asOfDate, -indicator.windowDays);
    const baselineEnd = addDays(recentStart, -1);
    const baselineStart = addDays(baselineEnd, -baselineLength);

    return crossingsOnly(
      sql`
        with recent as (
          select sa.student_id,
                 100.0 * sum(${ATTENDED_WEIGHT}) / count(*) as rate,
                 count(*)::int                              as sessions
            from public.student_attendance sa
            join public.attendance_sessions ses on ses.id = sa.session_id
           where sa.institution_id = ${context.institutionId}
             and sa.student_id = any(${context.studentIds}::uuid[])
             and sa.archived_at is null
             and ses.archived_at is null
             and ses.attendance_date between ${recentStart}::date and ${context.asOfDate}::date
           group by sa.student_id
        ),
        baseline as (
          select sa.student_id,
                 100.0 * sum(${ATTENDED_WEIGHT}) / count(*) as rate,
                 count(*)::int                              as sessions
            from public.student_attendance sa
            join public.attendance_sessions ses on ses.id = sa.session_id
           where sa.institution_id = ${context.institutionId}
             and sa.student_id = any(${context.studentIds}::uuid[])
             and sa.archived_at is null
             and ses.archived_at is null
             and ses.attendance_date between ${baselineStart}::date and ${baselineEnd}::date
           group by sa.student_id
        )
        select r.student_id::text                        as student_id,
               round(b.rate - r.rate, 2)                 as measured_value,
               round(b.rate, 2)                          as comparison_value,
               least(r.sessions, b.sessions)             as observation_count,
               ${baselineStart}::text                    as period_start,
               ${context.asOfDate}::text                 as period_end,
               null::uuid                                as subject_id,
               null::text                                as subject_name,
               jsonb_build_object(
                 'recentRate', round(r.rate, 2),
                 'baselineRate', round(b.rate, 2),
                 'recentSessions', r.sessions,
                 'baselineSessions', b.sessions,
                 'baselineFrom', ${baselineStart}::text,
                 'baselineTo', ${baselineEnd}::text
               )                                         as detail
          from recent r
          join baseline b on b.student_id = r.student_id`,
      indicator,
    );
  },

  /**
   * Marks in one subject, first assessment against latest.
   *
   * Only `approved` marks count. A draft or submitted mark is a teacher's working number that
   * the school has not yet stood behind, and flagging a child on one would mean the flag
   * arrives before the mark does.
   *
   * The comparison is first-to-latest rather than a regression slope on purpose: "72 → 61 →
   * 54" is a sentence a teacher can check against their own mark book in ten seconds, and a
   * slope coefficient is not.
   */
  subject_mark_decline: (context) => {
    const { start, end } = windowOf(context);
    return crossingsOnly(
      sql`
        with marks as (
          select em.student_id,
                 es.subject_id,
                 em.exam_id,
                 coalesce(ex.end_date, ex.start_date)                              as taken_on,
                 round(100.0 * em.obtained_marks / nullif(es.full_marks, 0), 2)    as percentage
            from public.exam_marks em
            join public.exam_subjects es on es.id = em.exam_subject_id
            join public.exams ex on ex.id = em.exam_id
           where em.institution_id = ${context.institutionId}
             and em.student_id = any(${context.studentIds}::uuid[])
             and em.archived_at is null
             and em.is_absent = false
             and em.obtained_marks is not null
             and em.status = 'approved'
             and es.full_marks > 0
             and coalesce(ex.end_date, ex.start_date) between ${start}::date and ${end}::date
        ),
        ordered as (
          select m.*,
                 row_number() over (
                   partition by m.student_id, m.subject_id order by m.taken_on, m.exam_id
                 ) as rn_first,
                 row_number() over (
                   partition by m.student_id, m.subject_id order by m.taken_on desc, m.exam_id desc
                 ) as rn_last,
                 count(*) over (partition by m.student_id, m.subject_id) as assessments
            from marks m
        )
        select f.student_id::text                        as student_id,
               round(f.percentage - l.percentage, 2)     as measured_value,
               f.percentage                              as comparison_value,
               f.assessments::int                        as observation_count,
               f.taken_on::text                          as period_start,
               l.taken_on::text                          as period_end,
               f.subject_id                              as subject_id,
               sub.name_en                               as subject_name,
               jsonb_build_object(
                 'latestPercentage', l.percentage,
                 'firstPercentage', f.percentage,
                 'series', (
                   select jsonb_agg(
                            jsonb_build_object(
                              'examId', o.exam_id, 'takenOn', o.taken_on, 'percentage', o.percentage
                            ) order by o.taken_on, o.exam_id
                          )
                     from ordered o
                    where o.student_id = f.student_id and o.subject_id = f.subject_id
                 )
               )                                         as detail
          from ordered f
          join ordered l
            on l.student_id = f.student_id and l.subject_id = f.subject_id and l.rn_last = 1
          join public.subjects sub on sub.id = f.subject_id
         where f.rn_first = 1`,
      context.indicator,
    );
  },

  /**
   * Homework set for this student's section, due and past due, with nothing handed in.
   *
   * `observation_count` is how many assignments were SET, not how many were missed, so the
   * evidence can say "four of twelve" — a figure that means something — rather than "four",
   * which does not.
   */
  homework_missed: (context) => {
    const { start, end } = windowOf(context);
    return crossingsOnly(
      sql`
        select e.student_id::text                                              as student_id,
               count(*) filter (where sub.id is null)::numeric                 as measured_value,
               null::numeric                                                   as comparison_value,
               count(*)::int                                                   as observation_count,
               ${start}::text                                                  as period_start,
               ${end}::text                                                    as period_end,
               null::uuid                                                      as subject_id,
               null::text                                                      as subject_name,
               jsonb_build_object(
                 'assignmentsSet', count(*),
                 'assignmentsMissed', count(*) filter (where sub.id is null),
                 'assignmentIds', coalesce(
                   jsonb_agg(a.id) filter (where sub.id is null), '[]'::jsonb
                 )
               )                                                               as detail
          from public.assignments a
          join public.enrollments e
            on e.section_id = a.section_id
           and e.academic_year_id = a.academic_year_id
           and e.status = 'active'
           and e.archived_at is null
          left join public.assignment_submissions sub
            on sub.assignment_id = a.id
           and sub.student_id = e.student_id
           and sub.archived_at is null
         where a.institution_id = ${context.institutionId}
           and a.status = 'published'
           and a.archived_at is null
           and e.student_id = any(${context.studentIds}::uuid[])
           -- Due strictly before the end of the reference day: an assignment due tonight is
           -- not yet missed.
           and a.due_at >= ${start}::date
           and a.due_at < (${end}::date + 1)
         group by e.student_id`,
      context.indicator,
    );
  },

  /**
   * The oldest unpaid invoice, in days past due.
   *
   * Amounts travel in `detail` as strings and are never compared as numbers here: money is
   * `numeric` in the database and `Money` in code (ADR-004), and the indicator's own figure is
   * a count of days, which is not money at all.
   */
  fee_overdue_days: (context) => {
    const { start, end } = windowOf(context);
    return crossingsOnly(
      sql`
        select i.student_id::text                                      as student_id,
               max(${end}::date - i.due_date)::numeric                 as measured_value,
               null::numeric                                           as comparison_value,
               count(*)::int                                           as observation_count,
               min(i.due_date)::text                                   as period_start,
               ${end}::text                                            as period_end,
               null::uuid                                              as subject_id,
               null::text                                              as subject_name,
               jsonb_build_object(
                 'invoiceIds', jsonb_agg(i.id order by i.due_date),
                 'outstandingTotal', sum(i.balance)::text,
                 'currency', min(i.currency)
               )                                                       as detail
          from public.invoices i
         where i.institution_id = ${context.institutionId}
           and i.student_id = any(${context.studentIds}::uuid[])
           and i.archived_at is null
           and i.status in ('issued', 'partially_paid', 'overdue')
           and i.balance > 0
           and i.due_date < ${end}::date
           and i.due_date >= ${start}::date
         group by i.student_id`,
      context.indicator,
    );
  },

  /** Books still out past their due date. */
  library_overdue_items: (context) => {
    const { start, end } = windowOf(context);
    return crossingsOnly(
      sql`
        select m.student_id::text                          as student_id,
               count(*)::numeric                           as measured_value,
               null::numeric                               as comparison_value,
               count(*)::int                               as observation_count,
               min(l.due_on)::text                         as period_start,
               ${end}::text                                as period_end,
               null::uuid                                  as subject_id,
               null::text                                  as subject_name,
               jsonb_build_object(
                 'loanIds', jsonb_agg(l.id order by l.due_on),
                 'oldestDueOn', min(l.due_on)::text
               )                                           as detail
          from public.library_loans l
          join public.library_members m on m.id = l.member_id
         where l.institution_id = ${context.institutionId}
           and m.student_id = any(${context.studentIds}::uuid[])
           and l.archived_at is null
           and l.returned_at is null
           and l.due_on < ${end}::date
           and l.due_on >= ${start}::date
         group by m.student_id`,
      context.indicator,
    );
  },

  /**
   * Behaviour records the school has SUBSTANTIATED.
   *
   * Only that status. A draft record is one person's note, an `under_investigation` record is
   * an open question, and an `unsubstantiated` one is an allegation the school looked into and
   * did not uphold. Counting any of those towards a child's risk band would make the band a
   * record of what they were accused of. The evidence carries record ids and severities, never
   * the description — that text is a person's account of an incident and it belongs in the
   * discipline module behind its own permissions.
   */
  behaviour_incidents: (context) => {
    const { start, end } = windowOf(context);
    return crossingsOnly(
      sql`
        select br.student_id::text                        as student_id,
               count(*)::numeric                          as measured_value,
               null::numeric                              as comparison_value,
               count(*)::int                              as observation_count,
               ${start}::text                             as period_start,
               ${end}::text                               as period_end,
               null::uuid                                 as subject_id,
               null::text                                 as subject_name,
               jsonb_build_object(
                 'recordIds', jsonb_agg(br.id order by br.occurred_on),
                 'severities', jsonb_agg(distinct br.severity::text)
               )                                          as detail
          from public.behaviour_records br
         where br.institution_id = ${context.institutionId}
           and br.student_id = any(${context.studentIds}::uuid[])
           and br.archived_at is null
           and br.status = 'substantiated'
           and br.occurred_on between ${start}::date and ${end}::date
         group by br.student_id`,
      context.indicator,
    );
  },

  /**
   * The longest run of consecutive absences — gaps and islands over the register.
   *
   * Consecutive SCHOOL days, not calendar days: the run is computed over the dates on which a
   * register exists for this student, so a weekend or a public holiday does not break a streak
   * and does not extend one either. That is the number a class teacher would count by hand.
   */
  absence_streak: (context) => {
    const { start, end } = windowOf(context);
    return crossingsOnly(
      sql`
        with absent_days as (
          select distinct sa.student_id, ses.attendance_date as on_date
            from public.student_attendance sa
            join public.attendance_sessions ses on ses.id = sa.session_id
           where sa.institution_id = ${context.institutionId}
             and sa.student_id = any(${context.studentIds}::uuid[])
             and sa.archived_at is null
             and ses.archived_at is null
             and sa.status = 'absent'
             and ses.attendance_date between ${start}::date and ${end}::date
        ),
        islands as (
          select student_id,
                 on_date,
                 -- The classic gaps-and-islands key: consecutive dates share it, a break
                 -- changes it.
                 on_date - (row_number() over (partition by student_id order by on_date))::int
                   as island
            from absent_days
        ),
        streaks as (
          select student_id, count(*)::int as run_length, min(on_date) as from_date,
                 max(on_date) as to_date
            from islands
           group by student_id, island
        )
        select distinct on (s.student_id)
               s.student_id::text                        as student_id,
               s.run_length::numeric                     as measured_value,
               null::numeric                             as comparison_value,
               s.run_length                              as observation_count,
               s.from_date::text                         as period_start,
               s.to_date::text                           as period_end,
               null::uuid                                as subject_id,
               null::text                                as subject_name,
               jsonb_build_object(
                 'runLength', s.run_length,
                 'from', s.from_date::text,
                 'to', s.to_date::text
               )                                         as detail
          from streaks s
         order by s.student_id, s.run_length desc, s.from_date desc`,
      context.indicator,
    );
  },
};

// ─────────────────────────────────────────────────────────────────────────────────────
// The sentence a teacher reads
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The deterministic summary for one piece of evidence, in both languages.
 *
 * Composed from the figures, with no model involved. This is what appears under "Because:" and
 * it is what a teacher sees when the provider is unavailable — which is why it is `not null` in
 * the schema and the model's prose is not. Every number in these sentences comes from the row
 * they describe, so a sentence and its evidence cannot drift apart.
 */
export function summarise(
  indicator: IndicatorConfig,
  row: MeasurementRow,
): { en: string; bn: string } {
  const value = trimNumber(row.measured_value);
  const comparison = row.comparison_value === null ? null : trimNumber(row.comparison_value);
  const detail = row.detail ?? {};

  switch (indicator.key) {
    case 'attendance_rate_low': {
      const sessions = numberOf(detail['sessions']);
      return {
        en: `Attendance is ${value}% across ${sessions} sessions from ${row.period_start} to ${row.period_end}.`,
        bn: `${row.period_start} থেকে ${row.period_end} পর্যন্ত ${sessions}টি ক্লাসে উপস্থিতি ${value}%।`,
      };
    }
    case 'attendance_rate_drop': {
      const recent = trimNumber(String(detail['recentRate'] ?? ''));
      const from = String(detail['baselineFrom'] ?? row.period_start);
      return {
        en: `Attendance fell from ${comparison}% to ${recent}% since ${from} — a drop of ${value} points.`,
        bn: `${from} থেকে উপস্থিতি ${comparison}% থেকে কমে ${recent}% হয়েছে — ${value} পয়েন্ট হ্রাস।`,
      };
    }
    case 'subject_mark_decline': {
      const series = seriesOf(detail['series']);
      const subject = row.subject_name ?? 'This subject';
      const trail = series.length > 0 ? ` (${series.join(' → ')})` : '';
      return {
        en: `${subject} declined across ${row.observation_count} assessments${trail}.`,
        bn: `${subject} বিষয়ে ${row.observation_count}টি মূল্যায়নে নম্বর কমেছে${trail}।`,
      };
    }
    case 'homework_missed': {
      const set = numberOf(detail['assignmentsSet']);
      return {
        en: `${value} of ${set} assignments were not submitted between ${row.period_start} and ${row.period_end}.`,
        bn: `${row.period_start} থেকে ${row.period_end} পর্যন্ত ${set}টির মধ্যে ${value}টি বাড়ির কাজ জমা পড়েনি।`,
      };
    }
    case 'fee_overdue_days': {
      const invoices = row.observation_count;
      return {
        en: `${invoices} invoice(s) unpaid; the oldest is ${value} days past its due date of ${row.period_start}.`,
        bn: `${invoices}টি চালান বকেয়া; সবচেয়ে পুরোনোটি ${row.period_start} তারিখের পর ${value} দিন অতিবাহিত।`,
      };
    }
    case 'library_overdue_items':
      return {
        en: `${value} library item(s) are overdue; the oldest was due on ${row.period_start}.`,
        bn: `${value}টি গ্রন্থাগারের বই ফেরত দেওয়া হয়নি; সবচেয়ে পুরোনোটির তারিখ ছিল ${row.period_start}।`,
      };
    case 'behaviour_incidents':
      return {
        en: `${value} behaviour record(s) were substantiated between ${row.period_start} and ${row.period_end}.`,
        bn: `${row.period_start} থেকে ${row.period_end} পর্যন্ত ${value}টি আচরণগত রেকর্ড প্রমাণিত হয়েছে।`,
      };
    case 'absence_streak':
      return {
        en: `Absent ${value} school days in a row, from ${row.period_start} to ${row.period_end}.`,
        bn: `${row.period_start} থেকে ${row.period_end} পর্যন্ত টানা ${value} দিন অনুপস্থিত।`,
      };
    default:
      // Unreachable while `MEASUREMENTS` and this switch cover the same keys — the service
      // never measures a key it has no query for. Kept as a real sentence rather than a throw:
      // an indicator that measured something is evidence, and losing it because nobody wrote
      // prose for it would be the wrong trade.
      return {
        en: `${indicator.nameEn}: measured ${value} between ${row.period_start} and ${row.period_end}.`,
        bn: `${indicator.nameBn ?? indicator.nameEn}: ${row.period_start} — ${row.period_end}, পরিমাপ ${value}।`,
      };
  }
}

/** `78.00` reads as `78`; `78.50` stays `78.5`. Presentation only — the stored value is exact. */
function trimNumber(value: string): string {
  if (!/^-?\d+(\.\d+)?$/.test(value)) return value;
  return value.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function numberOf(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function seriesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (entry as { percentage?: unknown } | null)?.percentage)
    .filter((percentage): percentage is string | number => percentage != null)
    .map((percentage) => trimNumber(String(percentage)));
}

/**
 * The reference date a run defaults to.
 *
 * `todayInDhaka`, not the process clock's date: a run started at half past midnight UTC is
 * still the same school day in Bangladesh, and a run whose window silently shifted by one day
 * depending on the server's timezone would not be reproducible at all.
 */
export function defaultAsOfDate(value?: string): CalendarDate {
  return value ? calendarDate(value) : todayInDhaka();
}
