'use client';

/**
 * Attendance corrections.
 *
 * A submitted register is an institutional record: it is never edited silently and never
 * deleted (ADR-008). Changing a mark on one is a *reviewed workflow* — a request carrying a
 * mandatory reason, then a decision by somebody who is not the requester — and this screen is
 * built to make that visible rather than to hide it behind an edit button.
 *
 * Two things the API enforces and this screen therefore does not offer:
 *
 *  - **You cannot decide your own request.** `decideCorrection` refuses it outright, so the
 *    approve/reject buttons are not rendered on a row the signed-in user raised. (A requester
 *    who *already* holds approval authority never reaches the queue: the API applies their
 *    correction in the same transaction and records it as approved on creation.)
 *  - **A locked register accepts nothing**, approved or otherwise. The correction request flow
 *    only offers registers in the `submitted` state, which is the only state a correction can
 *    be raised against — an open register is simply edited.
 */

import { useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/lib/session';
import {
  formatInstant,
  formatLongDate,
  formatRelative,
  humanize,
  todayInDhaka,
} from '@/lib/format';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  DataTable,
  DatePicker,
  ErrorNotice,
  Field,
  FilterBar,
  IconButton,
  LoadingBlock,
  PageHeader,
  Pagination,
  Select,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  ToastProvider,
  toOptions,
  useToast,
} from '@/components/ui';
import {
  attendanceApi,
  type AttendanceCorrection,
  type AttendanceCorrectionStatus,
  type RosterRow,
} from '@/components/attendance/api';
import {
  CORRECTION_STATUS_OPTIONS,
  MarkBadge,
  RegisterStatusBadge,
} from '@/components/attendance/marks';
import { RegisterForm } from '@/components/attendance/register-form';
import {
  CorrectionRequestDialog,
  type CorrectionTarget,
} from '@/components/attendance/correction-dialog';
import { useAttendanceScope } from '@/components/attendance/use-attendance-scope';

const PAGE_SIZE = 25;

export default function AttendanceCorrectionsPage() {
  return (
    <ToastProvider>
      <CorrectionsScreen />
    </ToastProvider>
  );
}

function CorrectionsScreen() {
  const session = useSession();
  const scope = useAttendanceScope();
  const [tab, setTab] = useState('queue');

  const canCorrect = session.can('attendance.correct');
  const canApprove = session.can('attendance.correct.approve');

  if (!scope.institutionId) {
    return (
      <Card padded className="mx-auto max-w-2xl">
        <p className="font-medium">Choose an institution first</p>
        <p className="mt-1 text-sm text-content-muted">
          Corrections belong to one school&rsquo;s registers, so there is nothing to show until
          you pick which school you are working in.
        </p>
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Attendance corrections"
        breadcrumbs={[{ label: 'Attendance', href: '/attendance' }, { label: 'Corrections' }]}
        description={
          canApprove
            ? 'Every change to a submitted mark passes through here. Approving one applies it and writes the reason to the audit log in the same transaction.'
            : 'Every change to a submitted mark passes through here. Your request leaves the mark untouched until an approver decides.'
        }
      />

      {scope.error ? <ErrorNotice error={scope.error} /> : null}

      <Tabs value={tab} onValueChange={setTab} activation="manual">
        <TabList label="Corrections">
          <Tab value="queue">Queue</Tab>
          {/* Raising a request needs `attendance.correct`; without it the tab is absent, not
              present-and-empty. The API refuses the POST either way. */}
          {canCorrect ? <Tab value="request">Request a change</Tab> : null}
        </TabList>

        <TabPanel value="queue">
          <CorrectionQueue
            institutionId={scope.institutionId}
            sectionOptions={scope.sectionOptions}
            canApprove={canApprove}
            currentUserId={session.user?.id ?? null}
          />
        </TabPanel>

        {canCorrect ? (
          <TabPanel value="request">
            <RequestCorrectionFlow
              institutionId={scope.institutionId}
              sectionOptions={scope.sectionOptions}
            />
          </TabPanel>
        ) : null}
      </Tabs>
    </div>
  );
}

// ── The approver's queue ──────────────────────────────────────────────────────────────

function CorrectionQueue({
  institutionId,
  sectionOptions,
  canApprove,
  currentUserId,
}: {
  institutionId: string;
  sectionOptions: { value: string; label: string; hint?: string }[];
  canApprove: boolean;
  currentUserId: string | null;
}) {
  const [status, setStatus] = useState<string>('pending');
  const [sectionId, setSectionId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState<string | undefined>();
  const [page, setPage] = useState(1);
  const [decision, setDecision] = useState<{
    correction: AttendanceCorrection;
    kind: 'approve' | 'reject';
  } | null>(null);

  const corrections = useQuery({
    queryKey: [
      'attendance',
      'corrections',
      { institutionId, status, sectionId, from, to, sort, page },
    ],
    queryFn: () =>
      attendanceApi.corrections(institutionId, {
        page,
        pageSize: PAGE_SIZE,
        sort,
        status: (status || undefined) as AttendanceCorrectionStatus | undefined,
        sectionId: sectionId || undefined,
        from: from || undefined,
        to: to || undefined,
      }),
    placeholderData: keepPreviousData,
  });

  const resetPage = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    // Page 7 of the old result set is an empty page 7 of the new one.
    setPage(1);
  };

  return (
    <div className="mt-4">
      <FilterBar
        filters={[
          {
            id: 'status',
            label: 'Filter by decision state',
            value: status,
            onChange: resetPage(setStatus),
            options: CORRECTION_STATUS_OPTIONS,
            placeholder: 'Any state',
          },
          {
            id: 'section',
            label: 'Filter by section',
            value: sectionId,
            onChange: resetPage(setSectionId),
            options: sectionOptions,
            placeholder: 'All sections',
          },
        ]}
        onReset={() => {
          setStatus('');
          setSectionId('');
          setFrom('');
          setTo('');
          setPage(1);
        }}
      />

      <div className="mb-4 grid max-w-md gap-3 sm:grid-cols-2">
        <Field label="Registers from">
          <DatePicker value={from} max={to || undefined} onChange={(event) => resetPage(setFrom)(event.target.value)} />
        </Field>
        <Field label="Registers to">
          <DatePicker value={to} min={from || undefined} onChange={(event) => resetPage(setTo)(event.target.value)} />
        </Field>
      </div>

      <DataTable
        caption="Attendance corrections"
        rows={corrections.data?.data ?? []}
        rowKey={(row) => row.id}
        sort={sort}
        onSortChange={resetPage(setSort)}
        isLoading={corrections.isLoading}
        isFetching={corrections.isFetching}
        error={corrections.error}
        minWidth="52rem"
        empty={{
          title: status === 'pending' ? 'Nothing awaiting a decision' : 'No corrections found',
          description:
            status === 'pending'
              ? 'Every correction raised on a register in your scope has been decided.'
              : 'No correction matches these filters. Corrections are raised from a submitted register.',
        }}
        columns={[
          {
            id: 'student',
            header: 'Student',
            card: 'title',
            render: (row) => row.studentNameEn,
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
            id: 'date',
            header: 'Register',
            card: 'subtitle',
            render: (row) => formatLongDate(row.attendanceDate),
          },
          {
            id: 'change',
            header: 'Change',
            card: 'row',
            render: (row) => (
              <span className="flex flex-wrap items-center gap-1.5">
                <MarkBadge status={row.previousStatus} />
                <span aria-hidden="true" className="text-content-subtle">
                  →
                </span>
                <span className="sr-only">changed to</span>
                <MarkBadge status={row.newStatus} />
                {row.newMinutesLate !== null ? (
                  <span className="text-xs tabular-nums text-content-muted">
                    {row.newMinutesLate} min
                  </span>
                ) : null}
              </span>
            ),
          },
          {
            id: 'reason',
            header: 'Reason',
            card: 'row',
            hideBelow: 'md',
            render: (row) => <span className="text-content-muted">{row.reason}</span>,
          },
          {
            id: 'requested',
            header: 'Requested',
            sortField: 'requestedAt',
            card: 'row',
            render: (row) => (
              <span title={formatInstant(row.requestedAt)}>{formatRelative(row.requestedAt)}</span>
            ),
          },
          {
            id: 'status',
            header: 'State',
            sortField: 'status',
            card: 'aside',
            render: (row) => <DecisionState correction={row} />,
          },
        ]}
        actions={(row) => {
          // Not rendered rather than rendered-and-403: the API refuses a decision from the
          // person who raised the request, and refuses any decision at all without
          // `attendance.correct.approve`.
          if (!canApprove || row.status !== 'pending') return null;
          if (currentUserId && row.requestedBy === currentUserId) {
            return (
              <span className="text-xs text-content-subtle">Needs another approver</span>
            );
          }
          return (
            <>
              <Button size="sm" onClick={() => setDecision({ correction: row, kind: 'reject' })}>
                Reject
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => setDecision({ correction: row, kind: 'approve' })}
              >
                Approve
              </Button>
            </>
          );
        }}
      />

      <Pagination
        meta={corrections.data?.meta}
        onPageChange={setPage}
        isFetching={corrections.isFetching}
        itemNoun="correction"
      />

      <DecisionDialog
        institutionId={institutionId}
        decision={decision}
        onClose={() => setDecision(null)}
      />
    </div>
  );
}

function DecisionState({ correction }: { correction: AttendanceCorrection }) {
  if (correction.status === 'pending') {
    return <span className="badge bg-warning-subtle text-warning">Awaiting a decision</span>;
  }
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <span
        className={
          correction.status === 'approved'
            ? 'badge bg-success-subtle text-success'
            : 'badge bg-danger-subtle text-danger'
        }
      >
        {humanize(correction.status)}
      </span>
      {correction.approvedAt ? (
        <span className="text-xs text-content-subtle">{formatRelative(correction.approvedAt)}</span>
      ) : null}
    </span>
  );
}

function DecisionDialog({
  institutionId,
  decision,
  onClose,
}: {
  institutionId: string;
  decision: { correction: AttendanceCorrection; kind: 'approve' | 'reject' } | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const decide = useMutation({
    mutationFn: (input: { reason: string; version: number }) =>
      attendanceApi.decideCorrection(
        institutionId,
        decision!.correction.id,
        decision!.kind,
        input,
      ),
    onSuccess: async () => {
      toast.success(
        decision?.kind === 'approve' ? 'Correction approved' : 'Correction rejected',
        decision?.kind === 'approve'
          ? 'The mark has been changed and the reason recorded against it.'
          : 'The mark is unchanged. The requester can see your note on the request.',
      );
      await queryClient.invalidateQueries({ queryKey: ['attendance'] });
    },
  });

  const approving = decision?.kind === 'approve';

  return (
    <ConfirmDialog
      open={decision !== null}
      onClose={onClose}
      title={approving ? 'Approve this correction?' : 'Reject this correction?'}
      variant={approving ? 'primary' : 'danger'}
      confirmLabel={approving ? 'Approve and apply' : 'Reject'}
      requireReason
      reasonLabel="Decision note"
      reasonHint="Stored on the correction and in the audit log against your name. At least 10 characters."
      body={
        decision ? (
          <>
            <p>
              {decision.correction.studentNameEn} ({decision.correction.studentCode}), register of{' '}
              {formatLongDate(decision.correction.attendanceDate)}:{' '}
              {decision.correction.previousStatus.replace(/_/g, ' ')} →{' '}
              {decision.correction.newStatus.replace(/_/g, ' ')}.
            </p>
            <p className="mt-2 italic">&ldquo;{decision.correction.reason}&rdquo;</p>
            <p className="mt-2">
              {approving
                ? 'Approving changes the mark and writes the change, its reason and your name to the audit log in one transaction.'
                : 'Rejecting leaves the mark exactly as it is. The request stays on the record with your note.'}
            </p>
          </>
        ) : null
      }
      onConfirm={async (reason) => {
        await decide.mutateAsync({ reason, version: decision!.correction.version });
      }}
    />
  );
}

// ── Raising a request ─────────────────────────────────────────────────────────────────

/**
 * A correction is always raised against one mark on one submitted register, so the flow is:
 * pick the section, pick the date, pick the register, then pick the student. Every step reads
 * from the API — there is no way to type a mark id in by hand, and no way to raise a request
 * against a register that is not in the one state that accepts them.
 */
function RequestCorrectionFlow({
  institutionId,
  sectionOptions,
}: {
  institutionId: string;
  sectionOptions: { value: string; label: string; hint?: string }[];
}) {
  const [sectionId, setSectionId] = useState('');
  const [date, setDate] = useState(todayInDhaka);
  const [chosenSessionId, setChosenSessionId] = useState<string | null>(null);
  const [target, setTarget] = useState<CorrectionTarget | null>(null);

  const registers = useQuery({
    queryKey: ['attendance', 'sessions', { institutionId, sectionId, date }],
    queryFn: () =>
      attendanceApi.sessions(institutionId, { sectionId, from: date, to: date, pageSize: 50 }),
    enabled: sectionId !== '',
  });

  const correctable = useMemo(
    () => (registers.data?.data ?? []).filter((row) => row.status === 'submitted'),
    [registers.data],
  );

  const activeSession =
    correctable.find((row) => row.id === chosenSessionId) ?? correctable[0] ?? null;

  const roster = useQuery({
    queryKey: ['attendance', 'roster', activeSession?.id],
    queryFn: () => attendanceApi.roster(institutionId, activeSession!.id),
    enabled: Boolean(activeSession),
  });

  return (
    <div className="mt-4 space-y-4">
      <Card>
        <CardHeader
          title="Find the register"
          description="Only a submitted register accepts corrections. An open one is edited directly; a locked one accepts nothing at all."
        />
        <CardBody>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Section">
              <Select
                value={sectionId}
                onChange={(event) => {
                  setSectionId(event.target.value);
                  setChosenSessionId(null);
                }}
                options={sectionOptions}
                placeholder="Choose a section"
              />
            </Field>
            <Field label="Date">
              <DatePicker
                value={date}
                max={todayInDhaka()}
                onChange={(event) => {
                  setDate(event.target.value);
                  setChosenSessionId(null);
                }}
              />
            </Field>
            <Field label="Register">
              <Select
                value={activeSession?.id ?? ''}
                onChange={(event) => setChosenSessionId(event.target.value)}
                disabled={correctable.length === 0}
                placeholder={
                  sectionId === ''
                    ? 'Choose a section first'
                    : registers.isLoading
                      ? 'Loading…'
                      : 'No submitted register'
                }
                options={toOptions(correctable, (row) => ({
                  value: row.id,
                  label: row.periodId ? 'Period register' : 'Daily register',
                  hint: formatLongDate(row.attendanceDate),
                }))}
              />
            </Field>
          </div>

          {registers.error ? (
            <div className="mt-3">
              <ErrorNotice error={registers.error} />
            </div>
          ) : null}

          {sectionId !== '' && !registers.isLoading && correctable.length === 0 ? (
            <p role="status" className="mt-3 text-sm text-content-muted">
              No submitted register for this section on {formatLongDate(date)}
              {(registers.data?.data.length ?? 0) > 0 ? (
                <>
                  {' '}
                  — the registers that exist are{' '}
                  {registers.data!.data.map((row) => (
                    <span key={row.id} className="mr-1 inline-block">
                      <RegisterStatusBadge status={row.status} />
                    </span>
                  ))}
                </>
              ) : (
                '.'
              )}
            </p>
          ) : null}
        </CardBody>
      </Card>

      {activeSession ? (
        roster.isLoading ? (
          <LoadingBlock label="Loading the register" />
        ) : roster.error ? (
          <ErrorNotice error={roster.error} />
        ) : roster.data ? (
          <RegisterForm
            institutionId={institutionId}
            session={roster.data.session}
            roster={roster.data.roster}
            // Always read-only here: this tab exists to raise a correction, never to edit.
            canMark={false}
            renderRowAction={(row: RosterRow) =>
              row.markId ? (
                <IconButton
                  size="sm"
                  label={`Request a correction for ${row.fullNameEn}`}
                  icon={<IconPencil />}
                  onClick={() =>
                    setTarget({
                      markId: row.markId!,
                      studentName: row.fullNameEn,
                      studentCode: row.studentCode,
                      currentStatus: row.status ?? '',
                      currentMinutesLate: row.minutesLate,
                      attendanceDate: roster.data.session.attendanceDate,
                    })
                  }
                />
              ) : null
            }
          />
        ) : null
      ) : null}

      <CorrectionRequestDialog
        institutionId={institutionId}
        target={target}
        onClose={() => setTarget(null)}
      />
    </div>
  );
}

function IconPencil() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}
