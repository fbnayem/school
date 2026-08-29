'use client';

/**
 * Create / edit a fee head.
 *
 * Two forms rather than one with a `mode` flag, because `createFeeHeadSchema` and
 * `updateFeeHeadSchema` genuinely differ: create takes a `code` and cannot be given `null`,
 * update refuses a `code` change, carries the optimistic-lock `version`, and accepts `null` on
 * the optional fields — which is how a school *clears* a Bangla name rather than leaving it.
 * Collapsing them would mean one schema-shaped union and a set of casts hiding the difference.
 *
 * Both submit through `Form`, whose `onSubmit` is awaited: a 422 from the API comes back with
 * dotted field paths and lands on the field. That only works if the mutation is awaited with
 * `mutateAsync` and nothing catches in between.
 */

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { createFeeHeadSchema, FEE_HEAD_TYPES, updateFeeHeadSchema } from '@shikkha/validation';
import {
  Button,
  CheckboxField,
  Dialog,
  FieldGrid,
  FieldGridSpan,
  Form,
  FormActions,
  NumberField,
  SelectField,
  TextAreaField,
  TextField,
  useToast,
  type SelectOption,
} from '@/components/ui';
import { humanize } from '@/lib/format';
import { feesApi, type FeeHead } from './fees-api';

const TYPE_OPTIONS: SelectOption[] = FEE_HEAD_TYPES.map((type) => ({
  value: type,
  label: humanize(type),
}));

/**
 * An untouched optional text input holds `''`, and `''` is a *value* to the API — it would
 * write an empty Bangla name over a missing one. On create the field is simply absent; on
 * update it is an explicit `null`, which is the difference between "unchanged" and "cleared".
 */
const OMIT_IF_BLANK = { setValueAs: (value: string) => (value === '' ? undefined : value) };
const CLEAR_IF_BLANK = { setValueAs: (value: string) => (value === '' ? null : value) };

export function FeeHeadDialog({
  open,
  onClose,
  institutionId,
  head,
}: {
  open: boolean;
  onClose: () => void;
  institutionId: string;
  /** Absent for a new head; present to edit that one. */
  head?: FeeHead | null;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={head ? `Edit ${head.nameEn}` : 'New fee head'}
      description={
        head
          ? 'The code cannot change — invoices already reference it.'
          : 'A fee head is a charge a school can bill: tuition, transport, an exam fee.'
      }
      size="lg"
      // Unsaved input: a stray click on the backdrop must not discard a half-typed form.
      closeOnBackdropClick={false}
    >
      {head ? (
        <EditFeeHeadForm
          key={`${head.id}:${head.version}`}
          head={head}
          institutionId={institutionId}
          onDone={onClose}
        />
      ) : (
        <CreateFeeHeadForm institutionId={institutionId} onDone={onClose} />
      )}
    </Dialog>
  );
}

function CreateFeeHeadForm({
  institutionId,
  onDone,
}: {
  institutionId: string;
  onDone: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();

  // `z.input`, not `z.infer`: `type`, `isRecurring`, `isRefundable` and `sortOrder` carry
  // `.default()`, so the output type marks them required and the form would demand values the
  // user never has to give.
  const form = useForm<z.input<typeof createFeeHeadSchema>>({
    resolver: zodResolver(createFeeHeadSchema),
    defaultValues: {
      code: '',
      nameEn: '',
      nameBn: '',
      type: 'other',
      isRecurring: false,
      isRefundable: true,
      ledgerAccountCode: '',
      description: '',
      sortOrder: 0,
    },
  });

  const create = useMutation({
    mutationFn: (values: z.input<typeof createFeeHeadSchema>) =>
      feesApi.createFeeHead(institutionId, values),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ['fee-heads'] });
      toast.success('Fee head created', `${created.code} — ${created.nameEn}`);
      onDone();
    },
  });

  return (
    <Form
      form={form}
      onSubmit={async (values) => {
        await create.mutateAsync(values);
      }}
      onError={toast.error}
    >
      <FieldGrid>
        <TextField
          form={form}
          name="code"
          label="Code"
          required
          hint="Letters, numbers, hyphens and underscores. Shown on invoices."
          autoComplete="off"
        />
        <SelectField form={form} name="type" label="Type" options={TYPE_OPTIONS} required />
        <TextField form={form} name="nameEn" label="Name" required autoComplete="off" />
        <TextField
          form={form}
          name="nameBn"
          label="Name (Bangla)"
          lang="bn"
          optional
          autoComplete="off"
          registerOptions={OMIT_IF_BLANK}
        />
        <TextField
          form={form}
          name="ledgerAccountCode"
          label="Ledger account code"
          optional
          hint="The chart-of-accounts code this head posts to."
          autoComplete="off"
          registerOptions={OMIT_IF_BLANK}
        />
        <NumberField form={form} name="sortOrder" label="Sort order" min={0} max={999} />
        <FieldGridSpan>
          <TextAreaField
            form={form}
            name="description"
            label="Description"
            optional
            registerOptions={OMIT_IF_BLANK}
          />
        </FieldGridSpan>
        <CheckboxField
          form={form}
          name="isRecurring"
          label="Charged every billing period"
          hint="Tuition is recurring; an admission fee is not."
        />
        <CheckboxField form={form} name="isRefundable" label="Refundable" />
      </FieldGrid>

      <FormActions>
        <Button onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" loading={form.formState.isSubmitting}>
          Create fee head
        </Button>
      </FormActions>
    </Form>
  );
}

function EditFeeHeadForm({
  head,
  institutionId,
  onDone,
}: {
  head: FeeHead;
  institutionId: string;
  onDone: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const form = useForm<z.input<typeof updateFeeHeadSchema>>({
    resolver: zodResolver(updateFeeHeadSchema),
    defaultValues: {
      nameEn: head.nameEn,
      nameBn: head.nameBn ?? '',
      type: head.type,
      isRecurring: head.isRecurring,
      isRefundable: head.isRefundable,
      ledgerAccountCode: head.ledgerAccountCode ?? '',
      description: head.description ?? '',
      sortOrder: head.sortOrder,
      // Not rendered, but submitted: the optimistic lock. A stale version is refused by the
      // API with a 409 rather than silently overwriting a colleague's edit.
      version: head.version,
    },
  });

  const update = useMutation({
    mutationFn: (values: z.input<typeof updateFeeHeadSchema>) =>
      feesApi.updateFeeHead(institutionId, head.id, values),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ['fee-heads'] });
      toast.success('Fee head updated', saved.nameEn);
      onDone();
    },
  });

  return (
    <Form
      form={form}
      onSubmit={async (values) => {
        await update.mutateAsync(values);
      }}
      onError={toast.error}
    >
      <FieldGrid>
        <TextField form={form} name="nameEn" label="Name" required autoComplete="off" />
        <TextField
          form={form}
          name="nameBn"
          label="Name (Bangla)"
          lang="bn"
          optional
          hint="Leave blank to clear it."
          autoComplete="off"
          registerOptions={CLEAR_IF_BLANK}
        />
        <SelectField form={form} name="type" label="Type" options={TYPE_OPTIONS} required />
        <NumberField form={form} name="sortOrder" label="Sort order" min={0} max={999} />
        <TextField
          form={form}
          name="ledgerAccountCode"
          label="Ledger account code"
          optional
          autoComplete="off"
          registerOptions={CLEAR_IF_BLANK}
        />
        <FieldGridSpan>
          <TextAreaField
            form={form}
            name="description"
            label="Description"
            optional
            registerOptions={CLEAR_IF_BLANK}
          />
        </FieldGridSpan>
        <CheckboxField form={form} name="isRecurring" label="Charged every billing period" />
        <CheckboxField form={form} name="isRefundable" label="Refundable" />
      </FieldGrid>

      <FormActions>
        <Button onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" loading={form.formState.isSubmitting}>
          Save changes
        </Button>
      </FormActions>
    </Form>
  );
}
