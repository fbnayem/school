'use client';

/**
 * The weekly routine.
 *
 * Two audiences, two shapes, both served by the API's read surface:
 *
 *  - **A section's week** (`GET /timetable/section/:sectionId`) — what a class is doing. The
 *    service resolves *which* routine applies on the date asked about, so nothing here has to
 *    reason about effective dates or which draft superseded which.
 *  - **A teacher's week** (`GET /timetable/teacher/:employeeId`) — the same lessons sliced the
 *    other way, across every campus they teach at, with the covers they are involved in either
 *    way round. A teacher may read their own; reading someone else's needs the management
 *    permissions, and the API returns 404 rather than 403 so an employee id is not confirmed.
 *
 * Editing lives here too, but only where the API will actually accept it: a **draft**. A
 * published routine is not edited in place — it is cloned into a new draft, or covered for one
 * day with a substitution. The screen says that rather than offering an edit button that 409s.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/lib/session';
import { WEEKDAY_NAMES, formatInstantDate, formatLongDate, todayInDhaka } from '@/lib/format';
import {
  Badge,
  BilingualName,
  Button,
  Card,
  CardBody,
  CardHeader,
  DatePicker,
  DescriptionList,
  EmptyState,
  ErrorNotice,
  Field,
  LoadingBlock,
  PageHeader,
  Select,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  ToastProvider,
  toOptions,
} from '@/components/ui';
import {
  academicApi,
  timetableApi,
  type SectionRow,
  type TimetableEntry,
} from '@/components/timetable/api';
import { WeekGrid, type GridPeriod } from '@/components/timetable/week-grid';
import { SectionRoutineEditor } from '@/components/timetable/section-editor';

export default function TimetablePage() {
  return (
    <ToastProvider>
      <TimetableScreen />
    </ToastProvider>
  );
}

function TimetableScreen() {
  const session = useSession();
  const institutionId = session.institutionId;
  const [tab, setTab] = useState('section');
  const [date, setDate] = useState(todayInDhaka);

  const canManage = session.can('timetable.manage');
  const canPublish = session.can('timetable.publish');
  const employeeId = session.user?.employeeId ?? null;

  const years = useQuery({
    queryKey: ['timetable', 'years', institutionId],
    queryFn: () => academicApi.years(institutionId!),
    enabled: Boolean(institutionId),
  });

  const currentYear = years.data?.find((year) => year.isCurrent) ?? null;

  /**
   * The teaching week. `academic_years.weekendDays` is institution configuration — a madrasah
   * and an English-medium school in the same city keep different weekends — so it is read, not
   * assumed.
   */
  const days = useMemo(() => {
    const weekend = new Set(currentYear?.weekendDays ?? []);
    return WEEKDAY_NAMES.map((_, index) => index).filter((day) => !weekend.has(day));
  }, [currentYear]);

  if (!institutionId) {
    return (
      <Card padded className="mx-auto max-w-2xl">
        <p className="font-medium">Choose an institution first</p>
        <p className="mt-1 text-sm text-content-muted">
          A timetable belongs to one campus of one school, so there is nothing to show until you
          pick which school you are working in.
        </p>
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Timetable"
        description="The routine in force on the date you choose. Drafts are visible to staff who manage the timetable; everyone else sees only what has been published."
        actions={
          canPublish ? (
            <Button href="/timetable/publish" variant="primary">
              Publish a routine
            </Button>
          ) : null
        }
      />

      {years.error ? <ErrorNotice error={years.error} /> : null}

      <Card padded className="mb-5">
        <div className="max-w-xs">
          <Field
            label="Showing the routine in force on"
            hint="Changes which published routine applies, and which covers are relevant."
          >
            <DatePicker value={date} onChange={(event) => setDate(event.target.value)} />
          </Field>
        </div>
      </Card>

      <Tabs value={tab} onValueChange={setTab} activation="manual">
        <TabList label="Timetable views">
          <Tab value="section">By section</Tab>
          {/* A teacher's week needs either an employee record of your own or the management
              permissions. Neither is true for a guardian, so the tab is simply absent. */}
          {employeeId || canManage ? <Tab value="teacher">By teacher</Tab> : null}
        </TabList>

        <TabPanel value="section">
          <SectionTimetableTab
            institutionId={institutionId}
            academicYearId={currentYear?.id ?? null}
            date={date}
            days={days}
            canManage={canManage}
          />
        </TabPanel>

        {employeeId || canManage ? (
          <TabPanel value="teacher">
            <TeacherTimetableTab
              institutionId={institutionId}
              ownEmployeeId={employeeId}
              date={date}
              days={days}
              canManage={canManage}
            />
          </TabPanel>
        ) : null}
      </Tabs>
    </div>
  );
}

// ── By section ────────────────────────────────────────────────────────────────────────

function SectionTimetableTab({
  institutionId,
  academicYearId,
  date,
  days,
  canManage,
}: {
  institutionId: string;
  academicYearId: string | null;
  date: string;
  days: number[];
  canManage: boolean;
}) {
  const [sectionId, setSectionId] = useState('');
  const [timetableId, setTimetableId] = useState('');

  const sections = useQuery({
    queryKey: ['timetable', 'sections', institutionId, academicYearId],
    queryFn: () => academicApi.sections(institutionId, academicYearId ?? undefined),
    enabled: academicYearId !== null,
  });

  /**
   * The routine picker, for staff who manage timetables. Everyone else always sees the one the
   * API resolves for the date — the API refuses to show them a draft at all, because a draft
   * says a teacher is scheduled somewhere they have not agreed to be.
   */
  const timetables = useQuery({
    queryKey: ['timetable', 'list', institutionId, academicYearId],
    queryFn: () =>
      timetableApi.list(institutionId, {
        page: 1,
        pageSize: 50,
        academicYearId: academicYearId ?? undefined,
      }),
    enabled: canManage && academicYearId !== null,
  });

  const section: SectionRow | null =
    (sections.data ?? []).find((row) => row.id === sectionId) ?? null;

  const view = useQuery({
    queryKey: ['timetable', 'section-view', institutionId, sectionId, date, timetableId],
    queryFn: () =>
      timetableApi.sectionView(institutionId, sectionId, {
        date,
        ...(timetableId ? { timetableId } : {}),
      }),
    enabled: sectionId !== '',
  });

  /** The bell schedule of the section's shift; the axis the grid is laid out against. */
  const periods = useQuery({
    queryKey: ['timetable', 'periods', institutionId, section?.shiftId],
    queryFn: () => academicApi.periods(institutionId, section!.shiftId!),
    enabled: Boolean(section?.shiftId),
  });

  const periodAxis = useMemo<GridPeriod[]>(() => {
    if (periods.data && periods.data.length > 0) {
      return [...periods.data].sort((a, b) => a.sequence - b.sequence);
    }
    // A section with no shift has no bell schedule to read, so the axis is derived from the
    // periods the lessons themselves name. Still every value from the API — just fewer rows,
    // because a period nobody teaches in cannot be inferred.
    return derivePeriodAxis(view.data?.entries ?? []);
  }, [periods.data, view.data]);

  const timetable = view.data?.timetable ?? null;
  const editable = canManage && timetable?.status === 'draft';

  return (
    <div className="mt-4 space-y-4">
      <Card padded>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Section">
            <Select
              value={sectionId}
              onChange={(event) => setSectionId(event.target.value)}
              options={toOptions(sections.data ?? [], (row) => ({
                value: row.id,
                label: `${row.classLevelName} — ${row.nameEn}`,
                hint: row.nameBn ?? undefined,
              }))}
              placeholder={sections.isLoading ? 'Loading sections…' : 'Choose a section'}
            />
          </Field>

          {canManage ? (
            <Field
              label="Routine"
              hint="Leave empty to see whichever routine is in force on the chosen date."
            >
              <Select
                value={timetableId}
                onChange={(event) => setTimetableId(event.target.value)}
                allowEmpty
                placeholder="In force on this date"
                options={toOptions(timetables.data?.data ?? [], (row) => ({
                  value: row.id,
                  label: row.nameEn,
                  hint: `${row.status} · from ${row.effectiveFrom}`,
                }))}
              />
            </Field>
          ) : null}
        </div>
        {sections.error ? (
          <div className="mt-3">
            <ErrorNotice error={sections.error} />
          </div>
        ) : null}
      </Card>

      {sectionId === '' ? (
        <EmptyState
          title="Choose a section"
          description="Pick a section above to see its weekly routine."
        />
      ) : view.isLoading ? (
        <LoadingBlock label="Loading the routine" />
      ) : view.error ? (
        <ErrorNotice error={view.error} />
      ) : view.data && timetable ? (
        <>
          <Card padded>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold tracking-tight">
                  <BilingualName row={timetable} layout="stacked" />
                </h2>
                <p className="mt-1 text-sm text-content-muted">
                  {view.data.section.classLevelName} —{' '}
                  <BilingualName row={view.data.section} /> · showing{' '}
                  {formatLongDate(view.data.onDate)}
                </p>
              </div>
              <Badge tone={timetable.status === 'published' ? 'success' : 'warning'}>
                {timetable.status}
              </Badge>
            </div>

            <DescriptionList
              className="mt-4"
              columns={3}
              items={[
                { label: 'Effective from', value: formatLongDate(timetable.effectiveFrom) },
                {
                  // An instant, not a calendar date: `formatInstantDate` renders it in Dhaka.
                  // Slicing the ISO string would show the UTC day, which is the previous one for
                  // anything published after 6am Bangladesh time.
                  label: 'Published',
                  value: timetable.publishedAt ? formatInstantDate(timetable.publishedAt) : null,
                  emptyText: 'Not published',
                },
                { label: 'Lessons for this section', value: view.data.entries.length },
                { label: 'Note', value: timetable.note, span: true },
              ]}
            />

            {canManage && timetable.status !== 'draft' ? (
              <p className="mt-3 rounded border border-line bg-surface-muted px-3 py-2 text-sm text-content-muted">
                A {timetable.status} routine is not edited in place — a printed routine handed to
                the school is a fact about the past as much as a plan for the future. Clone it into
                a new draft to change it, or record a one-day substitution against it.
              </p>
            ) : null}
          </Card>

          {editable && section ? (
            <SectionRoutineEditor
              // Remounted per routine and section so the form's defaults are always the week
              // actually being edited.
              key={`${timetable.id}:${section.id}`}
              institutionId={institutionId}
              timetable={timetable}
              section={section}
              periods={periodAxis}
              days={days}
              entries={view.data.entries}
            />
          ) : (
            <WeekGrid
              days={days}
              periods={periodAxis}
              entries={view.data.entries}
              substitutions={view.data.substitutions}
              emptyTitle="No lessons scheduled"
              emptyDescription="This routine has no lessons for this section yet."
            />
          )}
        </>
      ) : null}
    </div>
  );
}

// ── By teacher ────────────────────────────────────────────────────────────────────────

function TeacherTimetableTab({
  institutionId,
  ownEmployeeId,
  date,
  days,
  canManage,
}: {
  institutionId: string;
  ownEmployeeId: string | null;
  date: string;
  days: number[];
  canManage: boolean;
}) {
  const session = useSession();
  const [employeeId, setEmployeeId] = useState(ownEmployeeId ?? '');

  /**
   * Reading a colleague's week needs the management permissions *and* a way to name them.
   * `/hr/employees` is the only staff directory and it needs `hr.employees.view` — which an
   * academic coordinator does not hold. So the picker appears only for someone who has both,
   * and everyone else sees their own week, which is what the API would give them anyway.
   */
  const canPickAnyone = canManage && session.can('hr.employees.view');

  const employees = useQuery({
    queryKey: ['timetable', 'employees', institutionId],
    queryFn: () => academicApi.employees(institutionId),
    enabled: canPickAnyone,
  });

  const view = useQuery({
    queryKey: ['timetable', 'teacher-view', institutionId, employeeId, date],
    queryFn: () => timetableApi.teacherView(institutionId, employeeId, { date }),
    enabled: employeeId !== '',
  });

  const periodAxis = useMemo<GridPeriod[]>(
    () => derivePeriodAxis(view.data?.entries ?? []),
    [view.data],
  );

  if (!ownEmployeeId && !canPickAnyone) {
    return (
      <div className="mt-4">
        <EmptyState
          title="No teacher to show"
          description="Your account is not linked to a staff record, and browsing other people's routines needs the staff-directory permission."
        />
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-4">
      {canPickAnyone ? (
        <Card padded>
          <div className="max-w-sm">
            <Field label="Teacher">
              <Select
                value={employeeId}
                onChange={(event) => setEmployeeId(event.target.value)}
                options={toOptions(employees.data?.data ?? [], (employee) => ({
                  value: employee.id,
                  label: employee.fullNameEn,
                  hint: employee.employeeCode ?? undefined,
                }))}
                placeholder={employees.isLoading ? 'Loading staff…' : 'Choose a teacher'}
              />
            </Field>
          </div>
        </Card>
      ) : null}

      {employeeId === '' ? (
        <EmptyState title="Choose a teacher" description="Pick a member of staff above." />
      ) : view.isLoading ? (
        <LoadingBlock label="Loading the week" />
      ) : view.error ? (
        <ErrorNotice error={view.error} />
      ) : view.data ? (
        <>
          <Card padded>
            <h2 className="text-lg font-semibold tracking-tight">{view.data.employee.fullNameEn}</h2>
            <p className="mt-1 text-sm text-content-muted">
              {view.data.entries.length}{' '}
              {view.data.entries.length === 1 ? 'lesson' : 'lessons'} across{' '}
              {view.data.timetables.length}{' '}
              {view.data.timetables.length === 1 ? 'routine' : 'routines'}, showing{' '}
              {formatLongDate(view.data.onDate)}.
            </p>
          </Card>

          <WeekGrid
            days={days}
            periods={periodAxis}
            entries={view.data.entries}
            showSection
            emptyTitle="No lessons this week"
            emptyDescription="This teacher has no lessons in the routine in force on this date."
          />

          {/*
            The teacher view's substitutions carry a `role` (covering or covered) but no
            substitute name — the API joins the name only on the section view — so they are
            listed here rather than pushed into the grid's cover badge, which would have nothing
            to name.
          */}
          {view.data.substitutions.length > 0 ? (
            <Card>
              <CardHeader
                title="Covers"
                description="Substitutions on or after the date above that involve this teacher, either way round."
              />
              <CardBody padded={false}>
                <ul className="divide-y divide-line">
                  {view.data.substitutions.map((substitution) => (
                    <li
                      key={substitution.id}
                      className="flex flex-wrap items-start justify-between gap-2 px-4 py-2.5 sm:px-5"
                    >
                      <div className="min-w-0">
                        <p className="font-medium">
                          {formatLongDate(substitution.substitutionDate)}
                        </p>
                        <p className="text-sm text-content-muted">{substitution.reason}</p>
                      </div>
                      <Badge tone={substitution.role === 'covering' ? 'warning' : 'info'}>
                        {substitution.role === 'covering' ? 'Covering for someone' : 'Being covered'}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * The period axis, taken from the lessons themselves.
 *
 * Used where there is no single shift to read a bell schedule from — a teacher who works across
 * two shifts, or a section not attached to one. Every value comes from the API's entry rows; the
 * only cost is that a period in which nothing at all is taught has no row, because there is
 * nothing in the response that would name it.
 */
function derivePeriodAxis(entries: TimetableEntry[]): GridPeriod[] {
  const byId = new Map<string, GridPeriod>();
  for (const entry of entries) {
    if (byId.has(entry.periodId)) continue;
    byId.set(entry.periodId, {
      id: entry.periodId,
      nameEn: entry.periodName,
      sequence: entry.periodSequence,
      startTime: entry.startTime,
      endTime: entry.endTime,
    });
  }
  return [...byId.values()].sort((a, b) => a.sequence - b.sequence);
}
