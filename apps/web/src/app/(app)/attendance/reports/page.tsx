'use client';

/**
 * Attendance reports.
 *
 * Every figure on this screen is computed by Postgres and rendered as it arrives. In particular
 * the attendance percentage is a two-decimal **string** produced by the database, under a rule
 * the browser has no business restating: `late` counts as attended, `half_day` as half, and
 * `excused` is authorised absence that counts neither way. Re-deriving that from the five
 * counts here would give a second number that disagrees with the API's the first time the rule
 * changes — and a school reading two different attendance percentages for the same child is a
 * support call nobody can close.
 *
 * The three reports have different permissions and different shapes:
 *
 *  - **Per student** is open to any of the three scoped view permissions, so a guardian sees
 *    their own children and a class teacher sees their sections. The service's scope filter
 *    decides; the caller never says who they are asking about.
 *  - **Per section, daily** and **Consecutive absences** need `attendance.reports.view`, so the
 *    tabs are absent without it rather than present and refused.
 *
 * The date range is bounded by the API at 400 days. The pickers are constrained to match, so
 * the refusal arrives as a disabled date rather than as a 422 after a slow query.
 */

import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useSession } from '@/lib/session';
import { addDays, formatLongDate, todayInDhaka } from '@/lib/format';
import {
  BilingualName,
  Card,
  DataTable,
  DatePicker,
  ErrorNotice,
  Field,
  NumberInput,
  PageHeader,
  Pagination,
  Select,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  formatPercent,
} from '@/components/ui';
import { attendanceApi } from '@/components/attendance/api';
import { RegisterStatusBadge } from '@/components/attendance/marks';
import { useAttendanceScope } from '@/components/attendance/use-attendance-scope';

const PAGE_SIZE = 25;

/** The API refuses a wider window; the pickers enforce the same bound. */
const MAX_RANGE_DAYS = 400;

export default function AttendanceReportsPage() {
  const session = useSession();
  const scope = useAttendanceScope();

  const today = todayInDhaka();
  const [from, setFrom] = useState(() => addDays(today, -29));
  const [to, setTo] = useState(today);
  const [sectionId, setSectionId] = useState('');
  const [tab, setTab] = useState('students');

  const canViewReports = session.can('attendance.reports.view');

  if (!scope.institutionId) {
    return (
      <Card padded className="mx-auto max-w-2xl">
        <p className="font-medium">Choose an institution first</p>
        <p className="mt-1 text-sm text-content-muted">
          Attendance figures belong to one school&rsquo;s registers and academic year.
        </p>
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Attendance reports"
        breadcrumbs={[{ label: 'Attendance', href: '/attendance' }, { label: 'Reports' }]}
        description="Totals and percentages over a date range, computed by the API. Nothing on this page is calculated in the browser."
      />

      {scope.error ? <ErrorNotice error={scope.error} /> : null}

      <Card padded className="mb-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="From" hint={`At most ${MAX_RANGE_DAYS} days at a time.`}>
            <DatePicker
              value={from}
              max={to}
              onChange={(event) => setFrom(event.target.value)}
            />
          </Field>
          <Field label="To">
            <DatePicker
              value={to}
              min={from}
              max={today}
              onChange={(event) => setTo(event.target.value)}
            />
          </Field>
          <Field label="Section" hint="Leave empty for every section in your scope.">
            <Select
              value={sectionId}
              onChange={(event) => setSectionId(event.target.value)}
              options={scope.sectionOptions}
              placeholder="All sections"
              allowEmpty
            />
          </Field>
        </div>
        <p className="mt-3 text-sm text-content-muted">
          Showing {formatLongDate(from)} to {formatLongDate(to)}.
        </p>
      </Card>

      <Tabs value={tab} onValueChange={setTab} activation="manual">
        <TabList label="Attendance reports">
          <Tab value="students">Per student</Tab>
          {/* `attendance.reports.view` gates both aggregate reports at the API. Without it the
              tab is not rendered — the alternative is a tab that always shows a 403. */}
          {canViewReports ? <Tab value="sections">Per section, daily</Tab> : null}
          {canViewReports ? <Tab value="absences">Consecutive absences</Tab> : null}
        </TabList>

        <TabPanel value="students">
          <StudentSummaryReport
            institutionId={scope.institutionId}
            from={from}
            to={to}
            sectionId={sectionId}
          />
        </TabPanel>

        {canViewReports ? (
          <TabPanel value="sections">
            <SectionDailyReport
              institutionId={scope.institutionId}
              from={from}
              to={to}
              sectionId={sectionId}
            />
          </TabPanel>
        ) : null}

        {canViewReports ? (
          <TabPanel value="absences">
            <ConsecutiveAbsenceReport
              institutionId={scope.institutionId}
              from={from}
              to={to}
              sectionId={sectionId}
            />
          </TabPanel>
        ) : null}
      </Tabs>
    </div>
  );
}

// ── Per student ───────────────────────────────────────────────────────────────────────

function StudentSummaryReport({
  institutionId,
  from,
  to,
  sectionId,
}: {
  institutionId: string;
  from: string;
  to: string;
  sectionId: string;
}) {
  const [page, setPage] = useState(1);

  const summary = useQuery({
    queryKey: ['attendance', 'report', 'student', { institutionId, from, to, sectionId, page }],
    queryFn: () =>
      attendanceApi.studentSummary(institutionId, {
        page,
        pageSize: PAGE_SIZE,
        from,
        to,
        sectionId: sectionId || undefined,
      }),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="mt-4">
      <DataTable
        caption={`Attendance per student, ${formatLongDate(from)} to ${formatLongDate(to)}`}
        rows={summary.data?.data ?? []}
        rowKey={(row) => row.studentId}
        isLoading={summary.isLoading}
        isFetching={summary.isFetching}
        error={summary.error}
        minWidth="56rem"
        empty={{
          title: 'No attendance recorded in this range',
          description:
            'No register in your scope has marks between these dates. Try a wider range, or check that the registers have been submitted.',
        }}
        columns={[
          {
            id: 'student',
            header: 'Student',
            card: 'title',
            render: (row) => <BilingualName row={row} />,
          },
          {
            id: 'code',
            header: 'Student ID',
            card: 'meta',
            className: 'font-mono text-xs text-content-muted',
            hideBelow: 'lg',
            render: (row) => row.studentCode,
          },
          {
            id: 'percentage',
            header: 'Attendance',
            align: 'right',
            card: 'aside',
            className: 'tabular-nums font-medium',
            // Straight from Postgres. `formatPercent` only trims trailing zeros from the
            // string — it never parses it into a float.
            render: (row) => formatPercent(row.attendancePercentage),
          },
          {
            id: 'sessions',
            header: 'Registers',
            align: 'right',
            className: 'tabular-nums',
            card: 'row',
            render: (row) => row.totalSessions,
          },
          {
            id: 'present',
            header: 'Present',
            align: 'right',
            className: 'tabular-nums',
            card: 'row',
            render: (row) => row.present,
          },
          {
            id: 'absent',
            header: 'Absent',
            align: 'right',
            className: 'tabular-nums',
            card: 'row',
            render: (row) => row.absent,
          },
          {
            id: 'late',
            header: 'Late',
            align: 'right',
            className: 'tabular-nums',
            card: 'row',
            render: (row) => row.late,
          },
          {
            id: 'excused',
            header: 'Excused',
            align: 'right',
            className: 'tabular-nums',
            card: 'row',
            hideBelow: 'md',
            render: (row) => row.excused,
          },
          {
            id: 'halfDay',
            header: 'Half day',
            align: 'right',
            className: 'tabular-nums',
            card: 'row',
            hideBelow: 'md',
            render: (row) => row.halfDay,
          },
        ]}
      />

      <Pagination
        meta={summary.data?.meta}
        onPageChange={setPage}
        isFetching={summary.isFetching}
        itemNoun="student"
      />
    </div>
  );
}

// ── Per section, daily ────────────────────────────────────────────────────────────────

function SectionDailyReport({
  institutionId,
  from,
  to,
  sectionId,
}: {
  institutionId: string;
  from: string;
  to: string;
  sectionId: string;
}) {
  const daily = useQuery({
    queryKey: ['attendance', 'report', 'section-daily', { institutionId, from, to, sectionId }],
    queryFn: () =>
      attendanceApi.sectionDaily(institutionId, {
        from,
        to,
        sectionId: sectionId || undefined,
      }),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="mt-4">
      <p className="mb-3 text-sm text-content-muted">
        One row per register. &ldquo;Marked&rdquo; is how many students have a mark on it at all,
        which is how a half-taken register shows up. This endpoint is not paged; narrow the date
        range if the list is long.
      </p>
      <DataTable
        caption={`Daily attendance per section, ${formatLongDate(from)} to ${formatLongDate(to)}`}
        rows={daily.data ?? []}
        rowKey={(row) => row.sessionId}
        isLoading={daily.isLoading}
        isFetching={daily.isFetching}
        error={daily.error}
        minWidth="52rem"
        empty={{
          title: 'No registers in this range',
          description:
            'No attendance register exists between these dates for the sections in your scope.',
        }}
        columns={[
          {
            id: 'date',
            header: 'Date',
            card: 'title',
            className: 'tabular-nums',
            render: (row) => formatLongDate(row.attendanceDate),
          },
          {
            id: 'section',
            header: 'Section',
            card: 'subtitle',
            render: (row) => (
              <BilingualName row={{ nameEn: row.sectionNameEn, nameBn: row.sectionNameBn }} />
            ),
          },
          {
            id: 'kind',
            header: 'Register',
            card: 'meta',
            hideBelow: 'lg',
            render: (row) => (row.periodId ? 'Period' : 'Daily'),
          },
          {
            id: 'status',
            header: 'State',
            card: 'aside',
            render: (row) => <RegisterStatusBadge status={row.status} />,
          },
          {
            id: 'marked',
            header: 'Marked',
            align: 'right',
            className: 'tabular-nums',
            card: 'row',
            render: (row) => row.marked,
          },
          {
            id: 'present',
            header: 'Present',
            align: 'right',
            className: 'tabular-nums',
            card: 'row',
            render: (row) => row.present,
          },
          {
            id: 'absent',
            header: 'Absent',
            align: 'right',
            className: 'tabular-nums',
            card: 'row',
            render: (row) => row.absent,
          },
          {
            id: 'late',
            header: 'Late',
            align: 'right',
            className: 'tabular-nums',
            card: 'row',
            render: (row) => row.late,
          },
          {
            id: 'excused',
            header: 'Excused',
            align: 'right',
            className: 'tabular-nums',
            card: 'row',
            hideBelow: 'md',
            render: (row) => row.excused,
          },
          {
            id: 'halfDay',
            header: 'Half day',
            align: 'right',
            className: 'tabular-nums',
            card: 'row',
            hideBelow: 'md',
            render: (row) => row.halfDay,
          },
        ]}
      />
    </div>
  );
}

// ── Consecutive absences ──────────────────────────────────────────────────────────────

function ConsecutiveAbsenceReport({
  institutionId,
  from,
  to,
  sectionId,
}: {
  institutionId: string;
  from: string;
  to: string;
  sectionId: string;
}) {
  const [minDays, setMinDays] = useState(3);

  const runs = useQuery({
    queryKey: [
      'attendance',
      'report',
      'consecutive',
      { institutionId, from, to, sectionId, minDays },
    ],
    queryFn: () =>
      attendanceApi.consecutiveAbsences(institutionId, {
        from,
        to,
        sectionId: sectionId || undefined,
        minDays,
      }),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="mt-4">
      <div className="mb-3 flex flex-wrap items-end gap-4">
        <Field
          label="At least this many consecutive days"
          hint="Consecutive school days, not calendar days — a weekend does not reset a run."
          className="max-w-xs"
        >
          <NumberInput
            value={minDays}
            min={2}
            max={60}
            suffix="days"
            onChange={(event) => {
              const next = Number(event.target.value);
              // The API bounds this at 2–60; keeping the state inside the bound means the query
              // key never carries a value the endpoint will reject.
              if (Number.isFinite(next) && next >= 2 && next <= 60) setMinDays(next);
            }}
          />
        </Field>
      </div>

      <p className="mb-3 text-sm text-content-muted">
        This report only reports. Nothing here notifies a guardian &mdash; contacting families is
        a separate, deliberate act.
      </p>

      <DataTable
        caption={`Runs of consecutive absence, ${formatLongDate(from)} to ${formatLongDate(to)}`}
        rows={runs.data ?? []}
        rowKey={(row) => `${row.studentId}:${row.sectionId}:${row.startedOn}`}
        isLoading={runs.isLoading}
        isFetching={runs.isFetching}
        error={runs.error}
        minWidth="44rem"
        empty={{
          title: 'No runs of absence found',
          description: `No student in your scope was absent for ${minDays} or more consecutive school days in this range.`,
        }}
        columns={[
          {
            id: 'student',
            header: 'Student',
            card: 'title',
            render: (row) => row.fullNameEn,
          },
          {
            id: 'code',
            header: 'Student ID',
            card: 'meta',
            className: 'font-mono text-xs text-content-muted',
            render: (row) => row.studentCode,
          },
          {
            id: 'section',
            header: 'Section',
            card: 'subtitle',
            render: (row) => row.sectionNameEn,
          },
          {
            id: 'days',
            header: 'Days',
            align: 'right',
            className: 'tabular-nums font-medium',
            card: 'aside',
            render: (row) => row.consecutiveDays,
          },
          {
            id: 'started',
            header: 'From',
            card: 'row',
            className: 'tabular-nums',
            render: (row) => formatLongDate(row.startedOn),
          },
          {
            id: 'ended',
            header: 'To',
            card: 'row',
            className: 'tabular-nums',
            render: (row) => formatLongDate(row.endedOn),
          },
        ]}
      />
    </div>
  );
}
