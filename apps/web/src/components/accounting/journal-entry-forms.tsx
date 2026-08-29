'use client';

/**
 * Drafting and editing a manual journal entry.
 *
 * Two concrete forms rather than one generic one. `createJournalEntrySchema` and
 * `updateJournalEntrySchema` are genuinely different contracts — the second carries the
 * optimistic-lock `version` and makes every field optional — and the alternative here was a
 * component generic over `FieldValues` held together by path casts. Casts in the one place that
 * decides which account a debit lands on is a poor trade for ninety lines.
 *
 * What both forms lean on, and what neither reimplements:
 *
 *  - **Each line is a debit or a credit, never both.** `journalLineInputSchema` enforces the
 *    XOR; the database restates it as a check constraint.
 *  - **The entry must balance.** The shared schema sums both sides in integer minor units with
 *    `BigInt` and refuses an unbalanced entry with the message shown above the lines. The
 *    authoritative check is the database's deferred balance trigger — this one exists so the
 *    user is told before the round trip, in the same words.
 *
 * Neither rule is re-implemented here, so neither can drift from what the API accepts.
 */

import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import type { z } from 'zod';
import { createJournalEntrySchema, updateJournalEntrySchema } from '@shikkha/validation';
import {
  Button,
  DateField,
  Form,
  FormActions,
  MoneyField,
  SelectField,
  TextAreaField,
  TextField,
  useToast,
  type SelectOption,
} from '@/components/ui';
import { todayInDhaka } from '@/lib/format';
import {
  accountingApi,
  type Account,
  type CostCentre,
  type JournalEntryDetail,
} from './accounting-api';

/** A blank money box means "this side is not used", which the schema spells as absent. */
const OMIT_IF_BLANK = { setValueAs: (value: string) => (value === '' ? undefined : value) };

export function accountOptions(accounts: Account[]): SelectOption[] {
  return accounts.map((account) => ({
    value: account.id,
    label: `${account.code} — ${account.nameEn}`,
    hint: account.nameBn ?? undefined,
  }));
}

export function costCentreOptions(costCentres: CostCentre[]): SelectOption[] {
  return costCentres.map((centre) => ({
    value: centre.id,
    label: `${centre.code} — ${centre.nameEn}`,
    hint: centre.nameBn ?? undefined,
  }));
}

export function CreateJournalEntryForm({
  institutionId,
  accounts,
  costCentres,
}: {
  institutionId: string;
  /** Postable leaves only — the database refuses a line on a header account. */
  accounts: Account[];
  costCentres: CostCentre[];
}) {
  const toast = useToast();
  const router = useRouter();
  const queryClient = useQueryClient();

  const form = useForm<z.input<typeof createJournalEntrySchema>>({
    resolver: zodResolver(createJournalEntrySchema),
    defaultValues: {
      entryDate: todayInDhaka(),
      description: '',
      lines: [
        { accountId: '', debit: '', credit: '', description: '' },
        { accountId: '', debit: '', credit: '', description: '' },
      ],
    },
  });

  const rows = useFieldArray({ control: form.control, name: 'lines' });

  const create = useMutation({
    mutationFn: (values: z.input<typeof createJournalEntrySchema>) =>
      accountingApi.createJournalEntry(institutionId, values),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['journal-entries'] });
      toast.success('Draft created', `${result.entry.entryNumber} is a draft until it is posted.`);
      router.push(`/accounting/journals/${result.entry.id}`);
    },
  });

  const linesError = form.formState.errors.lines?.message;

  return (
    <Form
      form={form}
      onSubmit={async (values) => {
        await create.mutateAsync(values);
      }}
      onError={toast.error}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <DateField
          form={form}
          name="entryDate"
          label="Entry date"
          required
          hint="Must fall inside an open accounting period."
        />
        <TextAreaField
          form={form}
          name="description"
          label="Description"
          required
          className="sm:col-span-2"
        />
      </div>

      <JournalLinesHeading error={linesError} />

      <ol className="space-y-4">
        {rows.fields.map((field, index) => (
          <li key={field.id} className="rounded border border-line p-3 sm:p-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium text-content-muted">Line {index + 1}</h3>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => rows.remove(index)}
                disabled={rows.fields.length <= 2}
                aria-label={`Remove line ${index + 1}`}
              >
                Remove
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <SelectField
                form={form}
                name={`lines.${index}.accountId`}
                label="Account"
                options={accountOptions(accounts)}
                placeholder="Choose an account"
                required
                className="sm:col-span-2"
              />
              <MoneyField
                form={form}
                name={`lines.${index}.debit`}
                label="Debit"
                optional
                registerOptions={OMIT_IF_BLANK}
              />
              <MoneyField
                form={form}
                name={`lines.${index}.credit`}
                label="Credit"
                optional
                registerOptions={OMIT_IF_BLANK}
              />
              <TextField
                form={form}
                name={`lines.${index}.description`}
                label="Line note"
                optional
                autoComplete="off"
                registerOptions={OMIT_IF_BLANK}
              />
              {costCentres.length > 0 ? (
                <SelectField
                  form={form}
                  name={`lines.${index}.costCentreId`}
                  label="Cost centre"
                  options={costCentreOptions(costCentres)}
                  placeholder="None"
                  allowEmpty
                  optional
                  registerOptions={OMIT_IF_BLANK}
                />
              ) : null}
            </div>
          </li>
        ))}
      </ol>

      <Button
        onClick={() => rows.append({ accountId: '', debit: '', credit: '', description: '' })}
      >
        Add a line
      </Button>

      <FormActions align="between">
        <Button href="/accounting/journals">Cancel</Button>
        <Button type="submit" variant="primary" loading={form.formState.isSubmitting}>
          Save as draft
        </Button>
      </FormActions>
    </Form>
  );
}

export function EditJournalEntryForm({
  institutionId,
  entry,
  accounts,
  costCentres,
  onDone,
}: {
  institutionId: string;
  entry: JournalEntryDetail;
  accounts: Account[];
  costCentres: CostCentre[];
  onDone: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const form = useForm<z.input<typeof updateJournalEntrySchema>>({
    resolver: zodResolver(updateJournalEntrySchema),
    defaultValues: {
      entryDate: entry.entryDate,
      description: entry.description,
      // The whole set is sent back: `updateJournalEntrySchema` replaces the lines rather than
      // patching them, exactly as the API's PUT-like semantics require.
      lines: entry.lines.map((line) => ({
        accountId: line.accountId,
        debit: line.debit === '0.00' ? undefined : line.debit,
        credit: line.credit === '0.00' ? undefined : line.credit,
        description: line.description ?? undefined,
        costCentreId: line.costCentreId ?? undefined,
      })),
      version: entry.version,
    },
  });

  const rows = useFieldArray({ control: form.control, name: 'lines' });

  const update = useMutation({
    mutationFn: (values: z.input<typeof updateJournalEntrySchema>) =>
      accountingApi.updateJournalEntry(institutionId, entry.id, values),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['journal-entry', entry.id] });
      void queryClient.invalidateQueries({ queryKey: ['journal-entries'] });
      toast.success('Draft updated', entry.entryNumber);
      onDone();
    },
  });

  const linesError = form.formState.errors.lines?.message;

  return (
    <Form
      form={form}
      onSubmit={async (values) => {
        await update.mutateAsync(values);
      }}
      onError={toast.error}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <DateField form={form} name="entryDate" label="Entry date" required />
        <TextAreaField
          form={form}
          name="description"
          label="Description"
          required
          className="sm:col-span-2"
        />
      </div>

      <JournalLinesHeading error={linesError} />

      <ol className="space-y-4">
        {rows.fields.map((field, index) => (
          <li key={field.id} className="rounded border border-line p-3 sm:p-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium text-content-muted">Line {index + 1}</h3>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => rows.remove(index)}
                disabled={rows.fields.length <= 2}
                aria-label={`Remove line ${index + 1}`}
              >
                Remove
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <SelectField
                form={form}
                name={`lines.${index}.accountId`}
                label="Account"
                options={accountOptions(accounts)}
                placeholder="Choose an account"
                required
                className="sm:col-span-2"
              />
              <MoneyField
                form={form}
                name={`lines.${index}.debit`}
                label="Debit"
                optional
                registerOptions={OMIT_IF_BLANK}
              />
              <MoneyField
                form={form}
                name={`lines.${index}.credit`}
                label="Credit"
                optional
                registerOptions={OMIT_IF_BLANK}
              />
              <TextField
                form={form}
                name={`lines.${index}.description`}
                label="Line note"
                optional
                autoComplete="off"
                registerOptions={OMIT_IF_BLANK}
              />
              {costCentres.length > 0 ? (
                <SelectField
                  form={form}
                  name={`lines.${index}.costCentreId`}
                  label="Cost centre"
                  options={costCentreOptions(costCentres)}
                  placeholder="None"
                  allowEmpty
                  optional
                  registerOptions={OMIT_IF_BLANK}
                />
              ) : null}
            </div>
          </li>
        ))}
      </ol>

      <Button
        onClick={() => rows.append({ accountId: '', debit: '', credit: '', description: '' })}
      >
        Add a line
      </Button>

      <FormActions align="between">
        <Button onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" loading={form.formState.isSubmitting}>
          Save draft
        </Button>
      </FormActions>
    </Form>
  );
}

function JournalLinesHeading({ error }: { error?: string }) {
  return (
    <div className="space-y-1">
      <h2 className="text-lg font-semibold tracking-tight">Lines</h2>
      <p className="text-sm text-content-muted">
        Each line carries a debit or a credit, never both. Total debits must equal total credits
        before the entry can be saved.
      </p>
      {error ? (
        <p
          role="alert"
          className="rounded border border-danger/30 bg-danger-subtle px-3 py-2 text-sm font-medium text-danger"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
