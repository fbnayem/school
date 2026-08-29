'use client';

/**
 * Correct an approved mark.
 *
 * Everything about this dialog is deliberate friction, mirroring the endpoint behind it:
 *
 *  - It is reachable only for a mark whose status is `approved`. A draft or submitted mark is
 *    still editable through ordinary mark entry, and the API refuses this endpoint for one.
 *  - **A reason is mandatory** and is validated with the same `reasonSchema` the API uses. It
 *    is not a formality: after approval a mark has been signed off by someone other than the
 *    person who entered it, and changing it is the most disputed action a school system
 *    performs. The before and after values go into the audit record beside this reason, which
 *    is what makes the change defensible when a parent asks about it three months later.
 *  - It carries the row's `version`. A stale write is rejected rather than silently
 *    overwriting a colleague who saved first.
 *
 * The published result is **not** silently recomputed by this. A result is a snapshot of what
 * was published; re-publishing is the audited act that replaces it.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { correctExamMarkSchema } from '@shikkha/validation';
import { useSession } from '@/lib/session';
import {
  Button,
  CheckboxField,
  Dialog,
  Form,
  FormActions,
  TextAreaField,
  TextField,
  useToast,
} from '@/components/ui';
import { examsApi, type ExamMarkRow, type ExamSubjectRow } from './api';
import { formatMarks, paperComponents } from './shared';

export function CorrectMarkDialog({
  open,
  onClose,
  row,
  paper,
  examId,
}: {
  open: boolean;
  onClose: () => void;
  /** The mark being corrected. Null while the dialog is closed. */
  row: ExamMarkRow | null;
  paper: ExamSubjectRow;
  examId: string;
}) {
  const session = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();

  const components = paperComponents(paper.examSubject);

  const form = useForm<z.input<typeof correctExamMarkSchema>>({
    resolver: zodResolver(correctExamMarkSchema),
    // Re-created whenever the dialog is opened for a different mark, via the `key` the caller
    // puts on this component — without that, the previous row's marks would be shown against
    // the new one and then saved onto it.
    defaultValues: {
      writtenMarks: row?.mark.writtenMarks ?? null,
      mcqMarks: row?.mark.mcqMarks ?? null,
      practicalMarks: row?.mark.practicalMarks ?? null,
      continuousMarks: row?.mark.continuousMarks ?? null,
      isAbsent: row?.mark.isAbsent ?? false,
      remarks: row?.mark.remarks ?? null,
      reason: '',
      version: row?.mark.version ?? 1,
    },
  });

  const correct = useMutation({
    mutationFn: (values: z.infer<typeof correctExamMarkSchema>) =>
      examsApi.correctMark(session.institutionId!, row!.mark.id, values),
    onSuccess: () => {
      toast.success(
        'Mark corrected',
        'The change, its reason and the previous values are in the audit log. Re-publish the exam for the result to reflect it.',
      );
      void queryClient.invalidateQueries({ queryKey: ['exams', examId] });
      onClose();
    },
  });

  if (!row) return null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Correct ${row.studentNameEn}’s mark`}
      description={`${paper.subjectNameEn} · out of ${formatMarks(row.fullMarks)}. This mark was approved on ${row.mark.approvedAt ? new Date(row.mark.approvedAt).toISOString().slice(0, 10) : 'an earlier date'} and has been corrected ${row.mark.correctionCount} time${row.mark.correctionCount === 1 ? '' : 's'} already.`}
      size="md"
      // Unsaved input, including a typed reason: a stray backdrop click must not discard it.
      closeOnBackdropClick={false}
    >
      <Form
        form={form}
        onSubmit={async (values) => {
          // Awaited `mutateAsync` with no try/catch of our own, so a 422 reaches `Form` and its
          // field paths land on the right inputs.
          await correct.mutateAsync(values as z.infer<typeof correctExamMarkSchema>);
        }}
        onError={(error) => toast.error(error)}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          {components.map((component) => (
            <TextField
              key={component.key}
              form={form}
              name={component.markField}
              label={`${component.label} (out of ${formatMarks(component.fullMarks)})`}
              inputMode="decimal"
              optional
              // An empty box means "this component carries no mark", which the schema spells
              // `null`. Left as an empty string it would fail the decimal regex, and the
              // teacher would be told to fix a field they deliberately cleared.
              registerOptions={{ setValueAs: (value) => (value === '' ? null : value) }}
            />
          ))}
        </div>

        <CheckboxField
          form={form}
          name="isAbsent"
          label="This student was absent"
          hint="An absent candidate carries no marks. A zero is a mark that was earned; an absence is not."
        />

        <TextAreaField
          form={form}
          name="remarks"
          label="Remarks"
          rows={2}
          maxLength={500}
          optional
          registerOptions={{ setValueAs: (value) => (value === '' ? null : value) }}
        />

        <TextAreaField
          form={form}
          name="reason"
          label="Why is this mark being changed?"
          hint="Recorded in the audit log with the previous and new values, against your name. At least 10 characters."
          rows={3}
          required
        />

        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            variant="danger"
            loading={form.formState.isSubmitting}
            loadingLabel="Saving…"
          >
            Correct mark
          </Button>
        </FormActions>
      </Form>
    </Dialog>
  );
}
