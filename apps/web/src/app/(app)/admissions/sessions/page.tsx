'use client';

/**
 * Admission sessions and their seats.
 *
 * The seat numbers are not derived here. `classCapacity` is what the school configured, and
 * `seatsRemaining`, `accepted` and `enrolled` come from the session's funnel report, which is
 * a `GROUP BY` over the applications in SQL. Counting them in the browser would mean fetching
 * every application, and would disagree with the count the API enforces under its row lock the
 * moment two people worked at once.
 *
 * One session's breakdown is loaded at a time — the funnel is a per-session endpoint, and
 * firing one request per row of the list would be a request storm for a number most of which
 * nobody is looking at.
 */

import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/lib/session';
import { formatDateRange, formatNumber, humanize } from '@/lib/format';
import { academicApi } from '@/components/academic/api';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  DataTable,
  ErrorNotice,
  MetricCard,
  PageHeader,
  Pagination,
  SectionHeading,
  Select,
  StatGrid,
  toneForStatus,
  useToast,
  formatMoney,
} from '@/components/ui';
import {
  admissionsApi,
  type AdmissionFunnel,
  type AdmissionSession,
} from '@/components/admissions/api';
import { SessionFormDialog } from '@/components/admissions/session-form';

const PAGE_SIZE = 25;

/** The moves `SESSION_TRANSITIONS` allows, mirrored so a dead button is never rendered. */
const SESSION_TRANSITIONS: Record<AdmissionSession['status'], Array<'open' | 'closed' | 'completed'>> =
  {
    draft: ['open'],
    open: ['closed'],
    closed: ['open', 'completed'],
    completed: [],
  };

const TRANSITION_COPY: Record<
  'open' | 'closed' | 'completed',
  { label: string; title: string; body: string }
> = {
  open: {
    label: 'Open for applications',
    title: 'Open this session for applications',
    body: 'Families will be able to apply, and the office can record counter applications against it.',
  },
  closed: {
    label: 'Close applications',
    title: 'Close this session to new applications',
    body: 'No new applications will be accepted. Applications already in the funnel continue to move, and the session can be reopened.',
  },
  completed: {
    label: 'Mark complete',
    title: 'Mark this session complete',
    body: 'A completed session can no longer be edited or reopened. Do this once every seat has been settled.',
  },
};

export default function AdmissionSessionsPage() {
  const session = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const institutionId = session.institutionId;

  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [statusChange, setStatusChange] = useState<{
    row: AdmissionSession;
    target: 'open' | 'closed' | 'completed';
  } | null>(null);

  const canManage = session.can('admissions.cycles.manage');
  const canViewApplications = session.can('admissions.applications.view');
  const canReadClassLevels = session.can('academic.classes.view');

  const sessions = useQuery({
    queryKey: ['admission-sessions', { page, institutionId }],
    queryFn: () => admissionsApi.sessions(institutionId!, { page, pageSize: PAGE_SIZE }),
    placeholderData: keepPreviousData,
    enabled: Boolean(institutionId),
  });

  // Memoised so the identity is stable: the selection effect below depends on it, and a
  // fresh array on every render would re-run the effect on every render.
  const rows = useMemo(() => sessions.data?.data ?? [], [sessions.data]);

  // Select the first session once the list arrives, so the seat panel is never an empty frame
  // waiting for a click that a keyboard user has no obvious reason to make.
  useEffect(() => {
    if (selectedId === null && rows.length > 0) setSelectedId(rows[0]!.id);
  }, [rows, selectedId]);

  const classLevels = useQuery({
    queryKey: ['class-levels', institutionId],
    queryFn: () => academicApi.classLevels(institutionId!),
    enabled: Boolean(institutionId) && canReadClassLevels,
  });

  const funnel = useQuery({
    queryKey: ['admission-funnel', selectedId, institutionId],
    queryFn: () => admissionsApi.funnel(institutionId!, selectedId!),
    enabled: Boolean(institutionId) && Boolean(selectedId) && canViewApplications,
  });

  const changeStatus = useMutation({
    mutationFn: (input: { id: string; status: 'open' | 'closed' | 'completed'; reason: string }) =>
      admissionsApi.changeSessionStatus(institutionId!, input.id, {
        status: input.status,
        reason: input.reason,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admission-sessions'] });
      toast.success('Session status changed');
    },
  });

  const selected = rows.find((row) => row.id === selectedId) ?? null;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        breadcrumbs={[{ label: 'Admissions', href: '/admissions' }, { label: 'Sessions' }]}
        title="Admission sessions"
        description="Each intake cycle, the window it accepts applications in, and how many of its seats are gone."
        actions={
          canManage && institutionId ? (
            <Button variant="primary" onClick={() => setFormOpen(true)}>
              New session
            </Button>
          ) : null
        }
      />

      <DataTable
        caption="Admission sessions"
        rows={rows}
        rowKey={(row) => row.id}
        isLoading={sessions.isLoading}
        isFetching={sessions.isFetching}
        error={sessions.error}
        empty={{
          title: 'No admission sessions yet',
          description:
            'A session is one intake cycle: its application window, its fee, and the seats it opens per class.',
        }}
        columns={[
          {
            id: 'name',
            header: 'Session',
            card: 'title',
            render: (row) => (
              <button
                type="button"
                onClick={() => setSelectedId(row.id)}
                aria-pressed={row.id === selectedId}
                className="text-left font-medium text-accent-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
              >
                {row.nameEn}
                {row.nameBn ? (
                  <span lang="bn" className="ml-2 font-normal text-content-muted">
                    {row.nameBn}
                  </span>
                ) : null}
              </button>
            ),
          },
          {
            id: 'window',
            header: 'Application window',
            card: 'subtitle',
            className: 'tabular-nums text-content-muted',
            render: (row) => formatDateRange(row.applicationStartDate, row.applicationEndDate),
          },
          {
            id: 'seats',
            header: 'Seats configured',
            align: 'right',
            card: 'meta',
            className: 'tabular-nums',
            // A total of the seat counts the school configured on this session row — not an
            // independent count of anything. The taken/remaining figures come from the funnel.
            render: (row) =>
              formatNumber(row.classCapacity.reduce((total, entry) => total + entry.seats, 0)),
          },
          {
            id: 'fee',
            header: 'Form fee',
            align: 'right',
            card: 'meta',
            hideBelow: 'md',
            className: 'tabular-nums',
            render: (row) => formatMoney(row.applicationFee),
          },
          {
            id: 'status',
            header: 'Status',
            card: 'aside',
            render: (row) => <Badge tone={toneForStatus(row.status)}>{humanize(row.status)}</Badge>,
          },
        ]}
        actions={
          canManage
            ? (row) => {
                const targets = SESSION_TRANSITIONS[row.status];
                if (targets.length === 0) return null;
                return (
                  <div className="flex flex-wrap gap-2">
                    {targets.map((target) => (
                      <Button
                        key={target}
                        size="sm"
                        onClick={() => setStatusChange({ row, target })}
                      >
                        {TRANSITION_COPY[target].label}
                      </Button>
                    ))}
                  </div>
                );
              }
            : undefined
        }
        minWidth="52rem"
      />

      <Pagination
        className="mt-4"
        meta={sessions.data?.meta}
        onPageChange={setPage}
        isFetching={sessions.isFetching}
        itemNoun="session"
      />

      {rows.length > 0 ? (
        <section className="mt-6" aria-labelledby="seats-heading">
          <SectionHeading
            title="Seats taken and available"
            description="From the session's funnel report, counted in SQL."
            actions={
              rows.length > 1 ? (
                <div className="w-64">
                  <label htmlFor="session-picker" className="sr-only">
                    Choose a session to show seats for
                  </label>
                  <Select
                    id="session-picker"
                    value={selectedId ?? ''}
                    onChange={(event) => setSelectedId(event.target.value)}
                    options={rows.map((row) => ({ value: row.id, label: row.nameEn }))}
                  />
                </div>
              ) : null
            }
          />
          <span id="seats-heading" className="sr-only">
            Seats taken and available
          </span>

          {!canViewApplications ? (
            <Card padded>
              <p className="text-sm text-content-muted">
                Seat counts come from the admissions funnel report, which needs the permission to
                view applications.
              </p>
            </Card>
          ) : funnel.isError ? (
            <ErrorNotice error={funnel.error} />
          ) : (
            <SeatsPanel
              funnel={funnel.data ?? null}
              isLoading={funnel.isLoading}
              classLevelNames={
                canReadClassLevels
                  ? new Map((classLevels.data ?? []).map((level) => [level.id, level.nameEn]))
                  : null
              }
              sessionName={selected?.nameEn ?? ''}
            />
          )}
        </section>
      ) : null}

      {institutionId ? (
        <SessionFormDialog
          open={formOpen}
          onClose={() => setFormOpen(false)}
          institutionId={institutionId}
        />
      ) : null}

      <ConfirmDialog
        open={statusChange !== null}
        onClose={() => setStatusChange(null)}
        variant={statusChange?.target === 'completed' ? 'danger' : 'primary'}
        requireReason
        reasonLabel="Why now?"
        title={statusChange ? TRANSITION_COPY[statusChange.target].title : ''}
        confirmLabel={statusChange ? TRANSITION_COPY[statusChange.target].label : 'Confirm'}
        body={statusChange ? TRANSITION_COPY[statusChange.target].body : null}
        onConfirm={async (reason) => {
          if (!statusChange) return;
          await changeStatus.mutateAsync({
            id: statusChange.row.id,
            status: statusChange.target,
            reason,
          });
          setStatusChange(null);
        }}
      />
    </div>
  );
}

function SeatsPanel({
  funnel,
  isLoading,
  classLevelNames,
  sessionName,
}: {
  funnel: AdmissionFunnel | null;
  isLoading: boolean;
  classLevelNames: Map<string, string> | null;
  sessionName: string;
}) {
  const totals = funnel
    ? funnel.classLevels.reduce(
        (accumulator, row) => ({
          seats: accumulator.seats + row.seats,
          accepted: accumulator.accepted + row.accepted,
          enrolled: accumulator.enrolled + row.enrolled,
          remaining: accumulator.remaining + row.seatsRemaining,
        }),
        { seats: 0, accepted: 0, enrolled: 0, remaining: 0 },
      )
    : null;

  return (
    <div className="space-y-4">
      <StatGrid>
        <MetricCard
          label="Applications"
          value={funnel ? formatNumber(funnel.totalApplications) : null}
          detail={sessionName}
        />
        <MetricCard label="Seats configured" value={totals ? formatNumber(totals.seats) : null} />
        <MetricCard
          label="Accepted or enrolled"
          value={totals ? formatNumber(totals.accepted + totals.enrolled) : null}
        />
        <MetricCard
          label="Seats remaining"
          value={totals ? formatNumber(totals.remaining) : null}
          tone={totals && totals.remaining === 0 ? 'warning' : 'default'}
        />
      </StatGrid>

      <Card>
        <CardHeader
          title="By class level"
          headingLevel="h3"
          description="Remaining seats count acceptances and enrolments, not live offers — an offer holds a seat until it is accepted or lapses."
        />
        <CardBody padded={false}>
          {classLevelNames === null ? (
            <div className="px-4 py-4 sm:px-5">
              <p className="text-sm text-content-muted">
                The per-class breakdown names each class level, which needs the permission to view
                the academic structure.
              </p>
            </div>
          ) : (
            <DataTable
              caption={`Seats by class level for ${sessionName}`}
              rows={funnel?.classLevels ?? []}
              rowKey={(row) => row.classLevelId}
              isLoading={isLoading}
              empty={{
                title: 'No classes configured',
                description: 'This session has no class levels with seats against them yet.',
              }}
              columns={[
                {
                  id: 'class',
                  header: 'Class',
                  card: 'title',
                  render: (row) => classLevelNames.get(row.classLevelId) ?? 'Unknown class level',
                },
                {
                  id: 'seats',
                  header: 'Seats',
                  align: 'right',
                  card: 'meta',
                  className: 'tabular-nums',
                  render: (row) => formatNumber(row.seats),
                },
                {
                  id: 'applications',
                  header: 'Applications',
                  align: 'right',
                  card: 'meta',
                  className: 'tabular-nums text-content-muted',
                  render: (row) => formatNumber(row.applications),
                },
                {
                  id: 'offered',
                  header: 'Offered',
                  align: 'right',
                  card: 'meta',
                  hideBelow: 'md',
                  className: 'tabular-nums text-content-muted',
                  render: (row) => formatNumber(row.offered),
                },
                {
                  id: 'accepted',
                  header: 'Accepted',
                  align: 'right',
                  card: 'meta',
                  className: 'tabular-nums text-content-muted',
                  render: (row) => formatNumber(row.accepted),
                },
                {
                  id: 'enrolled',
                  header: 'Enrolled',
                  align: 'right',
                  card: 'meta',
                  className: 'tabular-nums text-content-muted',
                  render: (row) => formatNumber(row.enrolled),
                },
                {
                  id: 'waitlisted',
                  header: 'Waitlisted',
                  align: 'right',
                  card: 'meta',
                  hideBelow: 'lg',
                  className: 'tabular-nums text-content-muted',
                  render: (row) => formatNumber(row.waitlisted),
                },
                {
                  id: 'remaining',
                  header: 'Remaining',
                  align: 'right',
                  card: 'aside',
                  className: 'tabular-nums',
                  render: (row) => (
                    <span className={row.seatsRemaining === 0 ? 'font-medium text-warning' : ''}>
                      {formatNumber(row.seatsRemaining)}
                    </span>
                  ),
                },
              ]}
              minWidth="56rem"
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
