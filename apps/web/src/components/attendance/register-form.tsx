'use client';

/**
 * Taking a register.
 *
 * One form, one submit, one transaction. `POST /attendance/sessions/:id/marks` writes the whole
 * class at once — sending sixty individual mutations would give sixty chances to leave the
 * register half-taken, and the API deliberately does not offer that shape.
 *
 * ## Why every student starts on "Present"
 *
 * `submitAttendanceSchema` requires a status on every entry in `marks`; there is no "unmarked"
 * value in the API's vocabulary, and inventing one here would mean either sending a status the
 * teacher never chose or dropping students out of the payload entirely. So an untaken register
 * opens with every student on Present — the way a paper register works, where the teacher calls
 * the roll and marks the exceptions — and the screen says so, loudly, above the list. A student
 * who already has a mark keeps it; nothing is ever silently overwritten.
 *
 * ## Locked and submitted registers
 *
 * A submitted register is read-only: a change to it is a *correction*, which is a different act
 * with a different permission and a mandatory reason. A locked one is read-only to everybody.
 * Both states render the roster with its marks and explain themselves rather than presenting a
 * form that would 409. The API enforces all of this; the explanation is so the user is not left
 * guessing why the radios have gone.
 */

import { useMemo, useRef } from 'react';
import { useForm, useWatch, type Control, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { submitAttendanceSchema, type SubmitAttendanceInput } from '@shikkha/validation';
import {
  BilingualName,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Form,
  NumberField,
  RadioField,
  TextField,
  useToast,
} from '@/components/ui';
import { formatInstant } from '@/lib/format';
import { attendanceApi, type AttendanceSession, type RosterRow } from './api';
import {
  MARK_RADIO_OPTIONS_PLAIN,
  MarkBadge,
  acceptsMinutesLate,
  lockExplanation,
} from './marks';

type RegisterValues = z.input<typeof submitAttendanceSchema>;

export function RegisterForm({
  institutionId,
  session,
  roster,
  canMark,
  renderRowAction,
}: {
  institutionId: string;
  session: AttendanceSession;
  roster: RosterRow[];
  /**
   * Whether to render the editable form at all. Gated on `attendance.mark` by the caller: a
   * control the user cannot use is not rendered rather than rendered-and-disabled. The API
   * re-checks the permission (and the section assignment) on every request regardless.
   */
  canMark: boolean;
  /** Per-student action for a read-only register — "Request a correction". */
  renderRowAction?: (row: RosterRow) => React.ReactNode;
}) {
  const editable = canMark && session.status === 'open';

  if (!editable) {
    return (
      <ReadOnlyRegister session={session} roster={roster} renderRowAction={renderRowAction} />
    );
  }

  return (
    <EditableRegister
      // Remounted whenever the register moves on: a fresh version means fresh defaults, and
      // stale `defaultValues` would resubmit the version we no longer hold and 409.
      key={`${session.id}:${session.version}`}
      institutionId={institutionId}
      session={session}
      roster={roster}
    />
  );
}

// ── The editable register ─────────────────────────────────────────────────────────────

function EditableRegister({
  institutionId,
  session,
  roster,
}: {
  institutionId: string;
  session: AttendanceSession;
  roster: RosterRow[];
}) {
  const toast = useToast();
  const queryClient = useQueryClient();

  /**
   * Which button was pressed. A ref rather than state because it is read during the submit that
   * the click itself triggers — a `setState` would not have landed yet.
   */
  const finalizeRef = useRef(true);

  const untaken = useMemo(() => roster.filter((row) => row.status === null).length, [roster]);

  const form = useForm<RegisterValues>({
    resolver: zodResolver(submitAttendanceSchema),
    defaultValues: {
      version: session.version,
      finalize: true,
      marks: roster.map((row) => ({
        studentId: row.studentId,
        // An existing mark is kept exactly as recorded; only a student with no mark at all
        // starts on Present. See the file header for why there is no third state.
        status: row.status ?? 'present',
        minutesLate: row.minutesLate ?? null,
        remarks: row.remarks ?? '',
      })),
    },
  });

  const save = useMutation({
    mutationFn: (body: SubmitAttendanceInput) =>
      attendanceApi.submitMarks(institutionId, session.id, body),
    onSuccess: async (result) => {
      toast.success(
        result.session.status === 'submitted' ? 'Register submitted' : 'Progress saved',
        `${result.markedCount} ${result.markedCount === 1 ? 'student' : 'students'} recorded.`,
      );
      await queryClient.invalidateQueries({ queryKey: ['attendance'] });
    },
  });

  return (
    <Card>
      <CardHeader
        title="Take the register"
        description={
          untaken === roster.length
            ? 'This register has not been taken yet. Everyone starts as Present — change the students who are not, then submit.'
            : `${roster.length - untaken} of ${roster.length} already have a mark. Adjust what has changed and save.`
        }
      />
      <CardBody padded={false}>
        <Form
          form={form}
          onError={(error) => toast.error(error)}
          onSubmit={async (values) => {
            // `mutateAsync`, awaited, and no try/catch: the rejection has to reach `Form`, which
            // is what turns a 422 into a message on the offending student's row. The `await`
            // rather than a returned promise is deliberate — `onSubmit` is typed
            // `void | Promise<void>`, and returning `Promise<T>` does not satisfy it.
            await save.mutateAsync({
              version: values.version,
              finalize: finalizeRef.current,
              marks: values.marks.map((mark) => ({
                studentId: mark.studentId,
                status: mark.status,
                // `minutesLate` is only accepted alongside `late`/`half_day`; the API refuses it
                // on any other status rather than ignoring it.
                ...(acceptsMinutesLate(mark.status) && typeof mark.minutesLate === 'number'
                  ? { minutesLate: mark.minutesLate }
                  : {}),
                ...(mark.remarks ? { remarks: mark.remarks } : {}),
              })),
            });
          }}
        >
          <ul className="divide-y divide-line">
            {roster.map((row, index) => (
              <RegisterRow
                key={row.studentId}
                row={row}
                index={index}
                form={form}
                control={form.control}
              />
            ))}
          </ul>

          <CardFooter className="mt-0">
            <p className="mr-auto text-sm text-content-muted">
              Submitting signs the register off. After that a change needs a correction, which an
              approver reviews.
            </p>
            <Button
              type="submit"
              loading={save.isPending && !finalizeRef.current}
              loadingLabel="Saving…"
              onClick={() => {
                finalizeRef.current = false;
              }}
            >
              Save progress
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={save.isPending && finalizeRef.current}
              loadingLabel="Submitting…"
              onClick={() => {
                finalizeRef.current = true;
              }}
            >
              Submit register
            </Button>
          </CardFooter>
        </Form>
      </CardBody>
    </Card>
  );
}

function RegisterRow({
  row,
  index,
  form,
  control,
}: {
  row: RosterRow;
  index: number;
  form: UseFormReturn<RegisterValues>;
  control: Control<RegisterValues>;
}) {
  // Watching one row's status rather than the whole array: on a class of sixty, watching `marks`
  // re-renders every row on every tap, which is felt on the low-end Android phones staff use.
  const status = useWatch({ control, name: `marks.${index}.status` });

  return (
    <li className="px-4 py-3 sm:px-5">
      <RadioField
        form={form}
        name={`marks.${index}.status`}
        orientation="inline"
        options={MARK_RADIO_OPTIONS_PLAIN}
        registerOptions={{
          onChange: (event: { target: { value: string } }) => {
            // Moving off `late`/`half_day` must clear the delay, or the schema refuses the whole
            // register with "minutes late only applies to a student marked late or half day".
            if (!acceptsMinutesLate(event.target.value)) {
              form.setValue(`marks.${index}.minutesLate`, null);
            }
          },
        }}
        label={
          <span className="flex flex-wrap items-baseline gap-x-2">
            {row.rollNumber ? (
              <span className="font-mono text-xs text-content-subtle">Roll {row.rollNumber}</span>
            ) : null}
            <span className="text-base font-medium text-content">
              <BilingualName row={row} />
            </span>
            <span className="font-mono text-xs text-content-subtle">{row.studentCode}</span>
            {row.status === null ? (
              <span className="text-xs text-warning">No mark yet</span>
            ) : null}
          </span>
        }
      />

      {acceptsMinutesLate(status) ? (
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <NumberField
            form={form}
            name={`marks.${index}.minutesLate`}
            label="Minutes late"
            optional
            min={0}
            max={600}
            suffix="min"
            registerOptions={{
              // An empty box must become `null`, not `0`: `Number('')` is `0`, and a student
              // recorded as "late by zero minutes" is a punctuality report that lies.
              setValueAs: (value: unknown) =>
                value === '' || value === null || value === undefined ? null : Number(value),
            }}
          />
          <TextField
            form={form}
            name={`marks.${index}.remarks`}
            label="Remark"
            optional
            maxLength={500}
            placeholder="Optional note kept on the record"
          />
        </div>
      ) : null}
    </li>
  );
}

// ── The read-only register ────────────────────────────────────────────────────────────

function ReadOnlyRegister({
  session,
  roster,
  renderRowAction,
}: {
  session: AttendanceSession;
  roster: RosterRow[];
  renderRowAction?: (row: RosterRow) => React.ReactNode;
}) {
  const explanation = lockExplanation(session.status);

  return (
    <Card>
      <CardHeader
        title="Register"
        description={
          explanation ??
          'You do not have permission to record attendance, so this register is shown as recorded.'
        }
      />
      {session.status === 'locked' ? (
        <div className="border-b border-line bg-warning-subtle px-4 py-3 text-sm text-warning sm:px-5">
          <p className="font-medium">
            Locked{session.lockedAt ? ` on ${formatInstant(session.lockedAt)}` : ''}.
          </p>
          <p className="mt-0.5">
            Nothing changes a locked register — not even an approved correction. Reopening it is a
            deliberate act by an administrator, not something this screen can do.
          </p>
        </div>
      ) : null}
      <CardBody padded={false}>
        <ul className="divide-y divide-line">
          {roster.map((row) => (
            <li
              key={row.studentId}
              className="flex flex-wrap items-start gap-x-3 gap-y-1.5 px-4 py-2.5 sm:px-5"
            >
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline gap-x-2">
                  {row.rollNumber ? (
                    <span className="font-mono text-xs text-content-subtle">
                      Roll {row.rollNumber}
                    </span>
                  ) : null}
                  <span className="font-medium">
                    <BilingualName row={row} />
                  </span>
                  <span className="font-mono text-xs text-content-subtle">{row.studentCode}</span>
                </p>
                {row.remarks ? (
                  <p className="mt-0.5 text-sm text-content-muted">{row.remarks}</p>
                ) : null}
                {row.lastCorrectedAt ? (
                  <p className="mt-0.5 text-xs text-content-subtle">
                    Corrected {formatInstant(row.lastCorrectedAt)}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {row.minutesLate !== null ? (
                  <span className="text-xs tabular-nums text-content-muted">
                    {row.minutesLate} min late
                  </span>
                ) : null}
                <MarkBadge status={row.status} />
                {renderRowAction ? renderRowAction(row) : null}
              </div>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
