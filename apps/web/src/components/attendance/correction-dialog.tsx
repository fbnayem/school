'use client';

/**
 * Request a correction to a mark on a submitted register.
 *
 * This dialog never changes a mark. It creates a row in `attendance_corrections` carrying the
 * before value, the after value and a mandatory reason, and — unless the requester also holds
 * `attendance.correct.approve`, in which case the API applies it in the same transaction and
 * says so — the mark stays exactly as it was until somebody else decides. The wording below is
 * chosen so the requester knows which of those two happened; the API returns `applied` for
 * precisely that purpose.
 *
 * The reason is validated by `requestAttendanceCorrectionSchema` — the same schema the API uses,
 * and the same ten-character minimum the database's check constraint enforces. There is nowhere
 * in this file that can manufacture one.
 */

import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import {
  requestAttendanceCorrectionSchema,
  type RequestAttendanceCorrectionInput,
} from '@shikkha/validation';
import {
  Button,
  Dialog,
  Form,
  FormActions,
  NumberField,
  RadioField,
  TextAreaField,
  useToast,
} from '@/components/ui';
import { formatLongDate } from '@/lib/format';
import { attendanceApi } from './api';
import { MARK_RADIO_OPTIONS, MarkBadge, acceptsMinutesLate } from './marks';

type CorrectionValues = z.input<typeof requestAttendanceCorrectionSchema>;

/** The minimum a caller must know about the mark being corrected. */
export interface CorrectionTarget {
  markId: string;
  studentName: string;
  studentCode: string;
  currentStatus: string;
  currentMinutesLate: number | null;
  attendanceDate: string;
}

export function CorrectionRequestDialog({
  institutionId,
  target,
  onClose,
}: {
  institutionId: string;
  /** `null` closes the dialog. Pair it with `useConfirm`-style row state in the caller. */
  target: CorrectionTarget | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const form = useForm<CorrectionValues>({
    resolver: zodResolver(requestAttendanceCorrectionSchema),
    defaultValues: { status: 'present', minutesLate: null, reason: '' },
  });

  const status = useWatch({ control: form.control, name: 'status' });

  const request = useMutation({
    mutationFn: (body: RequestAttendanceCorrectionInput) =>
      attendanceApi.requestCorrection(institutionId, target!.markId, body),
    onSuccess: async (result) => {
      if (result.applied) {
        toast.success(
          'Correction applied',
          'You hold approval authority, so the change was recorded immediately and logged against your name.',
        );
      } else {
        toast.success(
          'Correction sent for review',
          'The mark is unchanged until an approver decides. You will see it in the corrections queue.',
        );
      }
      await queryClient.invalidateQueries({ queryKey: ['attendance'] });
      onClose();
    },
  });

  return (
    <Dialog
      open={target !== null}
      onClose={onClose}
      title="Request a correction"
      description={
        target
          ? `${target.studentName} · ${target.studentCode} · register of ${formatLongDate(target.attendanceDate)}`
          : undefined
      }
      // The reason is unsaved work worth ten characters of typing; a stray backdrop click must
      // not discard it.
      closeOnBackdropClick={false}
    >
      {target ? (
        <Form
          form={form}
          onError={(error) => toast.error(error)}
          onSubmit={async (values) => {
            await request.mutateAsync({
              status: values.status,
              // Refused by the schema on any status other than late or half day, so it is only
              // sent when it applies.
              ...(acceptsMinutesLate(values.status) && typeof values.minutesLate === 'number'
                ? { minutesLate: values.minutesLate }
                : {}),
              reason: values.reason,
            });
          }}
        >
          <p className="flex flex-wrap items-center gap-2 text-sm text-content-muted">
            Currently recorded as <MarkBadge status={target.currentStatus} />
            {target.currentMinutesLate !== null ? (
              <span className="tabular-nums">({target.currentMinutesLate} min late)</span>
            ) : null}
          </p>

          <RadioField
            form={form}
            name="status"
            label="Change the mark to"
            required
            options={MARK_RADIO_OPTIONS}
          />

          {acceptsMinutesLate(status) ? (
            <NumberField
              form={form}
              name="minutesLate"
              label="Minutes late"
              optional
              min={0}
              max={600}
              suffix="min"
              registerOptions={{
                setValueAs: (value: unknown) =>
                  value === '' || value === null || value === undefined ? null : Number(value),
              }}
            />
          ) : null}

          <TextAreaField
            form={form}
            name="reason"
            label="Reason for the correction"
            required
            rows={3}
            hint="Recorded permanently against this mark and in the audit log. At least 10 characters."
            placeholder="Why was the original mark wrong?"
          />

          <FormActions>
            <Button onClick={onClose} disabled={request.isPending}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={request.isPending}
              loadingLabel="Sending…"
            >
              Request correction
            </Button>
          </FormActions>
        </Form>
      ) : null}
    </Dialog>
  );
}
