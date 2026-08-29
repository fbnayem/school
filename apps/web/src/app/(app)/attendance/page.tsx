'use client';

/**
 * Today's registers.
 *
 * The screen answers two questions in order, because that is the order a class teacher asks
 * them at 8:05 in the morning:
 *
 *  1. *Which of my sections still need taking?* — the overview list, one row per section the
 *     caller is assigned to, with the state of that section's daily register on the chosen date.
 *  2. *Take that one.* — the register itself, pre-filled from the API with any marks already
 *     recorded.
 *
 * Everything on this page is a real API value. The register state comes from
 * `GET /attendance/sessions`; the roster and its marks from `GET /attendance/sessions/:id/roster`
 * — one query that returns every student enrolled in the section *on that date*, so a student
 * who joined yesterday appears without anyone reopening the register.
 *
 * `ToastProvider` is mounted here rather than in the app shell because the shell is owned by
 * another agent this batch and concurrent edits to it collide. It belongs one level up; see the
 * handover note.
 */

import { useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import {
  openAttendanceSessionSchema,
  type OpenAttendanceSessionInput,
} from '@shikkha/validation';
import { useSession } from '@/lib/session';
import { formatLongDate, formatTimeRange, todayInDhaka } from '@/lib/format';
import { academicApi } from '@/components/academic/api';
import {
  BilingualName,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  DatePicker,
  Dialog,
  ErrorNotice,
  Field,
  Form,
  FormActions,
  IconButton,
  LoadingBlock,
  PageHeader,
  SectionHeading,
  Select,
  SelectField,
  TextAreaField,
  ToastProvider,
  toOptions,
  useToast,
} from '@/components/ui';
import { attendanceApi, type AttendanceSession, type RosterRow } from '@/components/attendance/api';
import { RegisterStatusBadge, lockExplanation } from '@/components/attendance/marks';
import { RegisterForm } from '@/components/attendance/register-form';
import {
  CorrectionRequestDialog,
  type CorrectionTarget,
} from '@/components/attendance/correction-dialog';
import { useAttendanceScope } from '@/components/attendance/use-attendance-scope';

export default function AttendancePage() {
  return (
    <ToastProvider>
      <AttendanceScreen />
    </ToastProvider>
  );
}

function AttendanceScreen() {
  const session = useSession();
  const scope = useAttendanceScope();
  const institutionId = scope.institutionId;

  const [date, setDate] = useState(todayInDhaka);
  const [sectionId, setSectionId] = useState<string | null>(null);
  const [chosenSessionId, setChosenSessionId] = useState<string | null>(null);
  const [openingRegister, setOpeningRegister] = useState(false);
  const [correctionTarget, setCorrectionTarget] = useState<CorrectionTarget | null>(null);
  const [lockTarget, setLockTarget] = useState<AttendanceSession | null>(null);

  // Presentation only. The API re-checks every one of these on every request, and refuses a
  // register for a section the caller is not assigned to regardless of what is rendered here.
  const canMark = session.can('attendance.mark');
  const canApprove = session.can('attendance.correct.approve');
  const canCorrect = session.can('attendance.correct');

  const registers = useQuery({
    queryKey: ['attendance', 'sessions', { institutionId, date }],
    // 100 covers a large school's sections for one day; `Paged` meta is checked below so a
    // school that exceeds it is told rather than silently shown a truncated list.
    queryFn: () => attendanceApi.sessions(institutionId!, { from: date, to: date, pageSize: 100 }),
    enabled: Boolean(institutionId),
    placeholderData: keepPreviousData,
  });

  // Wrapped so its identity is stable between renders — the two `useMemo`s below depend on it,
  // and a fresh `[]` from the `??` on every render would defeat both of them.
  const registerRows = useMemo(() => registers.data?.data ?? [], [registers.data]);

  /** The daily register (no period) for each section on this date. */
  const dailyBySection = useMemo(() => {
    const map = new Map<string, AttendanceSession>();
    for (const row of registerRows) {
      if (row.periodId === null) map.set(row.sectionId, row);
    }
    return map;
  }, [registerRows]);

  const section = scope.sections.find((row) => row.id === sectionId) ?? null;

  const sectionRegisters = useMemo(
    () => registerRows.filter((row) => row.sectionId === sectionId),
    [registerRows, sectionId],
  );

  const activeSession =
    sectionRegisters.find((row) => row.id === chosenSessionId) ??
    sectionRegisters.find((row) => row.periodId === null) ??
    sectionRegisters[0] ??
    null;

  const roster = useQuery({
    queryKey: ['attendance', 'roster', activeSession?.id],
    queryFn: () => attendanceApi.roster(institutionId!, activeSession!.id),
    enabled: Boolean(institutionId) && Boolean(activeSession),
  });

  /** The bell schedule, for naming period registers and for opening one. */
  const periods = useQuery({
    queryKey: ['attendance', 'periods', institutionId, section?.shiftId],
    queryFn: () => academicApi.periods(institutionId!, section!.shiftId!),
    enabled: Boolean(institutionId) && Boolean(section?.shiftId),
  });

  const periodName = (periodId: string | null) => {
    if (!periodId) return 'Daily register';
    const period = periods.data?.find((row) => row.id === periodId);
    return period ? `${period.nameEn} · ${formatTimeRange(period.startTime, period.endTime)}` : 'Period register';
  };

  const selectSection = (id: string | null) => {
    setSectionId(id);
    setChosenSessionId(null);
  };

  if (!institutionId) {
    return (
      <ChooseInstitution />
    );
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeaderRow date={date} onDateChange={setDate} canViewReports={session.can('attendance.reports.view')} canSeeCorrections={session.canAny('attendance.view.all', 'attendance.view.assigned')} />

      {scope.error ? <ErrorNotice error={scope.error} /> : null}

      <SectionHeading
        title={`Registers on ${formatLongDate(date)}`}
        description={
          scope.isNarrowedToAssignments
            ? 'The sections you are the class teacher of, or teach a subject in.'
            : 'Every section in this institution.'
        }
      />

      <DataTable
        caption={`Sections and their daily register on ${formatLongDate(date)}`}
        rows={scope.sections}
        rowKey={(row) => row.id}
        isLoading={scope.isLoading || registers.isLoading}
        isFetching={registers.isFetching}
        error={registers.error}
        empty={{
          title: 'No sections to take attendance for',
          description: scope.isNarrowedToAssignments
            ? 'You are not currently assigned as the class teacher or a subject teacher of any section. Your academic coordinator sets those assignments.'
            : 'No sections exist in the current academic year yet.',
        }}
        columns={[
          {
            id: 'section',
            header: 'Section',
            card: 'title',
            render: (row) => (
              <span>
                {row.classLevelName} — <BilingualName row={row} />
              </span>
            ),
          },
          {
            id: 'enrolled',
            header: 'Students',
            align: 'right',
            className: 'tabular-nums',
            render: (row) => row.enrolledCount,
          },
          {
            id: 'register',
            header: 'Daily register',
            card: 'aside',
            render: (row) => <RegisterStatusBadge status={dailyBySection.get(row.id)?.status} />,
          },
        ]}
        actions={(row) => (
          <Button
            size="sm"
            variant={row.id === sectionId ? 'primary' : 'secondary'}
            onClick={() => selectSection(row.id)}
          >
            {dailyBySection.has(row.id) ? 'Open register' : 'View section'}
          </Button>
        )}
      />

      {registers.data && registers.data.meta.hasNext ? (
        <p role="status" className="mt-2 text-sm text-warning">
          More than {registers.data.meta.pageSize} registers exist for this date; the list above is
          the first page. Filter by section from a section row to see the rest.
        </p>
      ) : null}

      {section ? (
        <div className="mt-8 space-y-4">
          <SectionHeading
            title={
              <span>
                {section.classLevelName} — <BilingualName row={section} />
              </span>
            }
            description={`Registers for ${formatLongDate(date)}.`}
            actions={
              <Button size="sm" variant="ghost" onClick={() => selectSection(null)}>
                Close
              </Button>
            }
          />

          <Card padded>
            <div className="flex flex-wrap items-end gap-3">
              {sectionRegisters.length > 0 ? (
                <Field label="Register" className="min-w-0 flex-1 sm:max-w-sm">
                  <Select
                    value={activeSession?.id ?? ''}
                    onChange={(event) => setChosenSessionId(event.target.value)}
                    options={toOptions(sectionRegisters, (row) => ({
                      value: row.id,
                      label: periodName(row.periodId),
                      hint: row.status,
                    }))}
                  />
                </Field>
              ) : (
                <p className="text-sm text-content-muted">
                  No register has been opened for this section on {formatLongDate(date)}.
                </p>
              )}

              {/* Only a holder of `attendance.mark` can open a register, so nobody else is shown
                  the control. The API refuses it anyway, and also refuses a future date, a
                  holiday and a configured weekend. */}
              {canMark ? (
                <Button variant="primary" onClick={() => setOpeningRegister(true)}>
                  Open a register
                </Button>
              ) : null}

              {activeSession && activeSession.status === 'submitted' && canApprove ? (
                <Button variant="danger" onClick={() => setLockTarget(activeSession)}>
                  Lock register
                </Button>
              ) : null}
            </div>

            {activeSession ? (
              <RegisterNotice session={activeSession} />
            ) : null}
          </Card>

          {activeSession ? (
            roster.isLoading ? (
              <LoadingBlock label="Loading the roster" />
            ) : roster.error ? (
              <ErrorNotice error={roster.error} />
            ) : roster.data ? (
              <RegisterForm
                institutionId={institutionId}
                session={roster.data.session}
                roster={roster.data.roster}
                canMark={canMark}
                renderRowAction={
                  // A correction only exists for a mark that exists, and only on a register that
                  // has been submitted — an open one is simply edited, and a locked one refuses
                  // corrections outright. All three rules are the API's; this just avoids
                  // offering a button that would be refused.
                  canCorrect && roster.data.session.status === 'submitted'
                    ? (row: RosterRow) =>
                        row.markId ? (
                          <IconButton
                            size="sm"
                            label={`Request a correction for ${row.fullNameEn}`}
                            icon={<IconPencil />}
                            onClick={() =>
                              setCorrectionTarget({
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
                    : undefined
                }
              />
            ) : null
          ) : null}
        </div>
      ) : null}

      {section && canMark ? (
        <OpenRegisterDialog
          open={openingRegister}
          onClose={() => setOpeningRegister(false)}
          institutionId={institutionId}
          sectionId={section.id}
          sectionLabel={`${section.classLevelName} — ${section.nameEn}`}
          date={date}
          classLevelId={section.classLevelId}
          academicYearId={section.academicYearId}
          shiftId={section.shiftId}
          onOpened={(created) => {
            setChosenSessionId(created.id);
            setOpeningRegister(false);
          }}
        />
      ) : null}

      <CorrectionRequestDialog
        institutionId={institutionId}
        target={correctionTarget}
        onClose={() => setCorrectionTarget(null)}
      />

      <LockRegisterDialog
        institutionId={institutionId}
        target={lockTarget}
        onClose={() => setLockTarget(null)}
      />
    </div>
  );
}

// ── Pieces ────────────────────────────────────────────────────────────────────────────

function PageHeaderRow({
  date,
  onDateChange,
  canViewReports,
  canSeeCorrections,
}: {
  date: string;
  onDateChange: (value: string) => void;
  canViewReports: boolean;
  canSeeCorrections: boolean;
}) {
  return (
    <>
      <PageHeader
        title="Attendance"
        description="Take the daily register for a section, or review one that has already been taken."
        actions={
          <>
            {/* Both links are gated on the permission the destination screen needs, so a link
                never leads to a screen that refuses the reader. */}
            {canSeeCorrections ? (
              <Button href="/attendance/corrections" size="sm">
                Corrections
              </Button>
            ) : null}
            {canViewReports ? (
              <Button href="/attendance/reports" size="sm">
                Reports
              </Button>
            ) : null}
          </>
        }
      />

      <div className="mb-5 max-w-xs">
        <Field
          label="Date"
          hint="A register cannot be opened for a future date, a holiday or a non-teaching day."
        >
          <DatePicker
            value={date}
            max={todayInDhaka()}
            onChange={(event) => onDateChange(event.target.value)}
          />
        </Field>
      </div>
    </>
  );
}

function RegisterNotice({ session }: { session: AttendanceSession }) {
  const explanation = lockExplanation(session.status);
  if (!explanation) return null;
  return (
    <p
      className="mt-3 rounded border border-line bg-surface-muted px-3 py-2 text-sm text-content-muted"
      role="status"
    >
      {explanation}
    </p>
  );
}

function ChooseInstitution() {
  return (
    <div className="mx-auto max-w-2xl">
      <Card padded>
        <p className="font-medium">Choose an institution first</p>
        <p className="mt-1 text-sm text-content-muted">
          A register belongs to one school&rsquo;s calendar, sections and academic year, so
          attendance cannot be shown until you pick which school you are working in.
        </p>
      </Card>
    </div>
  );
}

// ── Opening a register ────────────────────────────────────────────────────────────────

type OpenRegisterValues = z.input<typeof openAttendanceSessionSchema>;

/**
 * `POST /attendance/sessions` is idempotent — opening a register that already exists returns
 * the existing one — so this dialog is safe to submit twice. A period register additionally
 * carries the subject being taught; a subject without a period is refused by the schema,
 * because "Maths attendance for the whole day" is not something the timetable can express.
 */
function OpenRegisterDialog({
  open,
  onClose,
  institutionId,
  sectionId,
  sectionLabel,
  date,
  classLevelId,
  academicYearId,
  shiftId,
  onOpened,
}: {
  open: boolean;
  onClose: () => void;
  institutionId: string;
  sectionId: string;
  sectionLabel: string;
  date: string;
  classLevelId: string;
  academicYearId: string;
  shiftId: string | null;
  onOpened: (session: AttendanceSession) => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const periods = useQuery({
    queryKey: ['attendance', 'periods', institutionId, shiftId],
    queryFn: () => academicApi.periods(institutionId, shiftId!),
    enabled: open && shiftId !== null,
  });

  const curriculum = useQuery({
    queryKey: ['attendance', 'curriculum', institutionId, academicYearId, classLevelId],
    queryFn: () => academicApi.curriculum(institutionId, { academicYearId, classLevelId }),
    enabled: open,
  });

  const form = useForm<OpenRegisterValues>({
    resolver: zodResolver(openAttendanceSessionSchema),
    defaultValues: {
      sectionId,
      attendanceDate: date,
      periodId: undefined,
      subjectId: undefined,
      notes: undefined,
    },
  });

  const create = useMutation({
    mutationFn: (body: OpenAttendanceSessionInput) =>
      attendanceApi.openSession(institutionId, body),
    onSuccess: async (created) => {
      toast.success('Register ready', `${sectionLabel}, ${formatLongDate(date)}.`);
      await queryClient.invalidateQueries({ queryKey: ['attendance'] });
      onOpened(created);
    },
  });

  // An empty `<select>` sends `''`, which `uuidSchema.optional()` rejects as a malformed uuid
  // rather than treating as absent. Mapping it to `undefined` at registration is what makes
  // "no period — this is the daily register" expressible.
  const optionalUuid = {
    setValueAs: (value: unknown) => (value === '' || value === null ? undefined : String(value)),
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Open a register"
      description={`${sectionLabel} · ${formatLongDate(date)}`}
      closeOnBackdropClick={false}
    >
      <Form
        form={form}
        onError={(error) => toast.error(error)}
        onSubmit={async (values) => {
          await create.mutateAsync({
            sectionId: values.sectionId,
            attendanceDate: values.attendanceDate,
            ...(values.periodId ? { periodId: values.periodId } : {}),
            ...(values.subjectId ? { subjectId: values.subjectId } : {}),
            ...(values.notes ? { notes: values.notes } : {}),
          });
        }}
      >
        {shiftId === null ? (
          <p className="text-sm text-content-muted">
            This section is not attached to a shift, so there is no bell schedule to take a
            period-wise register against. The daily register will be opened.
          </p>
        ) : (
          <SelectField
            form={form}
            name="periodId"
            label="Period"
            optional
            allowEmpty
            placeholder="Daily register (no period)"
            registerOptions={optionalUuid}
            options={toOptions(periods.data ?? [], (period) => ({
              value: period.id,
              label: period.nameEn,
              hint: formatTimeRange(period.startTime, period.endTime),
              // A break is in the bell schedule but nobody takes a register in it.
              disabled: period.isBreak,
            }))}
            hint={
              periods.isLoading
                ? 'Loading the bell schedule…'
                : 'Leave empty for the one register that covers the whole day.'
            }
          />
        )}

        <SelectField
          form={form}
          name="subjectId"
          label="Subject"
          optional
          allowEmpty
          placeholder="No subject"
          registerOptions={optionalUuid}
          options={toOptions(curriculum.data ?? [], (row) => ({
            value: row.subjectId,
            label: row.subjectNameEn,
            hint: row.subjectNameBn ?? row.subjectCode,
          }))}
          hint="Only for a period register — a subject without a period is refused."
        />

        <TextAreaField
          form={form}
          name="notes"
          label="Note"
          optional
          rows={2}
          maxLength={500}
          placeholder="Anything about this register the school should keep"
        />

        <FormActions>
          <Button onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={create.isPending}
            loadingLabel="Opening…"
          >
            Open register
          </Button>
        </FormActions>
      </Form>
    </Dialog>
  );
}

// ── Locking ───────────────────────────────────────────────────────────────────────────

function LockRegisterDialog({
  institutionId,
  target,
  onClose,
}: {
  institutionId: string;
  target: AttendanceSession | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const lock = useMutation({
    mutationFn: (input: { reason: string; version: number }) =>
      attendanceApi.lockSession(institutionId, target!.id, input),
    onSuccess: async () => {
      toast.success('Register locked', 'It is now closed for the reporting period.');
      await queryClient.invalidateQueries({ queryKey: ['attendance'] });
    },
  });

  return (
    <ConfirmDialog
      open={target !== null}
      onClose={onClose}
      title="Lock this register?"
      variant="danger"
      confirmLabel="Lock register"
      requireReason
      reasonLabel="Why is this register being locked?"
      body={
        target ? (
          <>
            <p>
              The register for {formatLongDate(target.attendanceDate)} will be closed for the
              reporting period. After that nothing changes it — not a correction, not an
              approver, not this screen.
            </p>
            <p className="mt-2">
              Any correction still awaiting a decision on this register must be approved or
              rejected first; the API refuses the lock otherwise, so none is silently discarded.
            </p>
          </>
        ) : null
      }
      // Awaited: a failure keeps the dialog open with the API's message and request id visible.
      onConfirm={async (reason) => {
        await lock.mutateAsync({ reason, version: target!.version });
      }}
    />
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
