'use client';

/**
 * Edit the charges on a fee plan.
 *
 * The endpoint is a `PUT` and the schema is `replaceFeeStructureItemsSchema`: items are
 * submitted as a **complete set**, and this form matches that exactly rather than sending a
 * patch. The reason is in the schema's own comment and it is worth restating at the UI: with a
 * partial update, "did they mean to remove the transport fee, or did the client simply not send
 * it?" is unanswerable — and the answer is the difference between a family being billed and not
 * being billed. Removing a row here removes the charge; that is the whole contract.
 *
 * The "same head twice at the same frequency" rule is enforced by the shared schema, so the
 * message the user sees is the message the API would have given.
 */

import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { FEE_FREQUENCIES, replaceFeeStructureItemsSchema } from '@shikkha/validation';
import {
  Button,
  CheckboxField,
  Form,
  FormActions,
  MoneyField,
  NumberField,
  SelectField,
  useToast,
  type SelectOption,
} from '@/components/ui';
import { humanize } from '@/lib/format';
import { feesApi, type FeeHead, type FeeStructureItem } from './fees-api';

type ItemsValues = z.input<typeof replaceFeeStructureItemsSchema>;

const FREQUENCY_OPTIONS: SelectOption[] = FEE_FREQUENCIES.map((frequency) => ({
  value: frequency,
  label: humanize(frequency),
}));

export function FeePlanItemsForm({
  institutionId,
  structureId,
  items,
  heads,
  onDone,
}: {
  institutionId: string;
  structureId: string;
  items: FeeStructureItem[];
  /** Every fee head the plan can charge to. Archived heads are excluded by the caller. */
  heads: FeeHead[];
  onDone: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const form = useForm<ItemsValues>({
    resolver: zodResolver(replaceFeeStructureItemsSchema),
    defaultValues: {
      items: items.map((item) => ({
        id: item.id,
        feeHeadId: item.feeHeadId,
        amount: item.amount,
        frequency: item.frequency,
        dueDayOfMonth: item.dueDayOfMonth ?? undefined,
        isOptional: item.isOptional,
        sortOrder: item.sortOrder,
      })),
    },
  });

  const rows = useFieldArray({ control: form.control, name: 'items' });

  const save = useMutation({
    mutationFn: (values: ItemsValues) =>
      feesApi.replaceFeeStructureItems(institutionId, structureId, values),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['fee-structure', structureId] });
      toast.success(
        'Charges saved',
        `${result.items.length} ${result.items.length === 1 ? 'charge' : 'charges'} on this plan.`,
      );
      onDone();
    },
  });

  const headOptions: SelectOption[] = heads.map((head) => ({
    value: head.id,
    label: head.nameEn,
    hint: head.nameBn ?? head.code,
  }));

  // `items` carries the duplicate-head message from the schema's superRefine, which has no
  // single input to attach to — so it is rendered above the rows.
  const itemsError = form.formState.errors.items?.message;

  return (
    <Form
      form={form}
      onSubmit={async (values) => {
        await save.mutateAsync(values);
      }}
      onError={toast.error}
    >
      {itemsError ? (
        <p role="alert" className="rounded border border-danger/30 bg-danger-subtle px-3 py-2 text-sm font-medium text-danger">
          {itemsError}
        </p>
      ) : null}

      {rows.fields.length === 0 ? (
        <p className="rounded border border-dashed border-line px-4 py-6 text-center text-sm text-content-muted">
          This plan charges nothing. Add a line for each fee head the plan should bill.
        </p>
      ) : null}

      <ol className="space-y-4">
        {rows.fields.map((field, index) => (
          <li key={field.id} className="rounded border border-line p-3 sm:p-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium text-content-muted">Charge {index + 1}</h3>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => rows.remove(index)}
                aria-label={`Remove charge ${index + 1}`}
              >
                Remove
              </Button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <SelectField
                form={form}
                name={`items.${index}.feeHeadId`}
                label="Fee head"
                options={headOptions}
                placeholder="Choose a fee head"
                required
              />
              <MoneyField
                form={form}
                name={`items.${index}.amount`}
                label="Amount"
                required
              />
              <SelectField
                form={form}
                name={`items.${index}.frequency`}
                label="Charged"
                options={FREQUENCY_OPTIONS}
                required
              />
              <NumberField
                form={form}
                name={`items.${index}.dueDayOfMonth`}
                label="Due day of month"
                optional
                min={1}
                max={31}
                hint="Leave blank to use the run's due date."
                registerOptions={{ setValueAs: (v: string) => (v === '' ? undefined : v) }}
              />
              <NumberField
                form={form}
                name={`items.${index}.sortOrder`}
                label="Sort order"
                min={0}
                max={999}
              />
              <CheckboxField
                form={form}
                name={`items.${index}.isOptional`}
                label="Opt-in charge"
                hint="Billed only when a run asks for optional items."
              />
            </div>
          </li>
        ))}
      </ol>

      <Button
        onClick={() =>
          rows.append({
            feeHeadId: '',
            amount: '',
            frequency: 'monthly',
            isOptional: false,
            sortOrder: rows.fields.length * 10,
          })
        }
      >
        Add a charge
      </Button>

      <FormActions align="between">
        <Button onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" loading={form.formState.isSubmitting}>
          Save charges
        </Button>
      </FormActions>
    </Form>
  );
}
