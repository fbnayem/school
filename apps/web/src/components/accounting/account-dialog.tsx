'use client';

/**
 * Create / edit an account in the chart.
 *
 * Two forms, because the two schemas differ in a way that matters: `type`, `normalBalance` and
 * `isPostable` are settable at creation and **absent from `updateAccountSchema`**. That is not
 * an oversight in the API — retyping an account that already carries postings would silently
 * restate every report built on it, so the chart is corrected by opening a new account and
 * archiving the old one. The edit form says so rather than offering fields the API would ignore.
 */

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import {
  COA_ACCOUNT_TYPES,
  COA_NORMAL_BALANCES,
  createAccountSchema,
  updateAccountSchema,
} from '@shikkha/validation';
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
import { accountingApi, type Account } from './accounting-api';

const TYPE_OPTIONS: SelectOption[] = COA_ACCOUNT_TYPES.map((type) => ({
  value: type,
  label: humanize(type),
}));

const BALANCE_OPTIONS: SelectOption[] = COA_NORMAL_BALANCES.map((side) => ({
  value: side,
  label: humanize(side),
  hint: side === 'debit' ? 'assets and expenses' : 'liabilities, equity and income',
}));

const OMIT_IF_BLANK = { setValueAs: (value: string) => (value === '' ? undefined : value) };
const CLEAR_IF_BLANK = { setValueAs: (value: string) => (value === '' ? null : value) };

export function AccountDialog({
  open,
  onClose,
  institutionId,
  account,
  /** Candidate parents: header accounts only — the API refuses a leaf as a parent. */
  headerAccounts,
}: {
  open: boolean;
  onClose: () => void;
  institutionId: string;
  account?: Account | null;
  headerAccounts: Account[];
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={account ? `Edit ${account.code} ${account.nameEn}` : 'New account'}
      description={
        account
          ? 'The code, the type and the normal balance are fixed once an account exists — reports are built on them.'
          : 'An account is either a header that groups and subtotals, or a leaf that takes journal lines.'
      }
      size="lg"
      closeOnBackdropClick={false}
    >
      {account ? (
        <EditAccountForm
          key={`${account.id}:${account.version}`}
          account={account}
          institutionId={institutionId}
          headerAccounts={headerAccounts}
          onDone={onClose}
        />
      ) : (
        <CreateAccountForm
          institutionId={institutionId}
          headerAccounts={headerAccounts}
          onDone={onClose}
        />
      )}
    </Dialog>
  );
}

function parentOptions(headerAccounts: Account[]): SelectOption[] {
  return headerAccounts.map((header) => ({
    value: header.id,
    label: `${header.code} — ${header.nameEn}`,
    hint: humanize(header.type),
    group: humanize(header.type),
  }));
}

function CreateAccountForm({
  institutionId,
  headerAccounts,
  onDone,
}: {
  institutionId: string;
  headerAccounts: Account[];
  onDone: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const form = useForm<z.input<typeof createAccountSchema>>({
    resolver: zodResolver(createAccountSchema),
    defaultValues: {
      code: '',
      nameEn: '',
      nameBn: '',
      type: 'asset',
      normalBalance: 'debit',
      parentAccountId: undefined,
      isPostable: true,
      isCashEquivalent: false,
      description: '',
      sortOrder: 0,
    },
  });

  const create = useMutation({
    mutationFn: (values: z.input<typeof createAccountSchema>) =>
      accountingApi.createAccount(institutionId, values),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      toast.success('Account created', `${created.code} — ${created.nameEn}`);
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
          label="Account code"
          required
          hint="How the account is referred to everywhere else — 1100, CASH-BANK."
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
        <SelectField
          form={form}
          name="normalBalance"
          label="Normal balance"
          options={BALANCE_OPTIONS}
          required
          hint="Which side increases the account. Contra accounts invert it, which is why it is stored rather than derived."
        />
        <SelectField
          form={form}
          name="parentAccountId"
          label="Parent"
          options={parentOptions(headerAccounts)}
          placeholder="Top level"
          allowEmpty
          optional
          hint="Must be a header account of the same type."
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
          name="isPostable"
          label="Journal lines can be posted to it"
          hint="Turn this off for a header account that only groups and subtotals."
        />
        <CheckboxField
          form={form}
          name="isCashEquivalent"
          label="Cash or bank"
          hint="Defines what the cash-flow statement treats as cash."
        />
      </FieldGrid>

      <FormActions>
        <Button onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" loading={form.formState.isSubmitting}>
          Create account
        </Button>
      </FormActions>
    </Form>
  );
}

function EditAccountForm({
  account,
  institutionId,
  headerAccounts,
  onDone,
}: {
  account: Account;
  institutionId: string;
  headerAccounts: Account[];
  onDone: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const form = useForm<z.input<typeof updateAccountSchema>>({
    resolver: zodResolver(updateAccountSchema),
    defaultValues: {
      nameEn: account.nameEn,
      nameBn: account.nameBn ?? '',
      parentAccountId: account.parentAccountId ?? '',
      isCashEquivalent: account.isCashEquivalent,
      description: account.description ?? '',
      sortOrder: account.sortOrder,
      version: account.version,
    },
  });

  const update = useMutation({
    mutationFn: (values: z.input<typeof updateAccountSchema>) =>
      accountingApi.updateAccount(institutionId, account.id, values),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      toast.success('Account updated', `${saved.code} — ${saved.nameEn}`);
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
      <p className="rounded border border-line bg-surface-muted px-3 py-2 text-sm text-content-muted">
        {account.code} is {humanize(account.type)} with a {account.normalBalance} normal balance,
        and {account.isPostable ? 'takes journal lines' : 'is a header that takes no postings'}.
        Those cannot change: every posted entry and every report already depends on them.
      </p>

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
        <SelectField
          form={form}
          name="parentAccountId"
          label="Parent"
          options={parentOptions(headerAccounts.filter((header) => header.id !== account.id))}
          placeholder="Top level"
          allowEmpty
          optional
          registerOptions={CLEAR_IF_BLANK}
        />
        <NumberField form={form} name="sortOrder" label="Sort order" min={0} max={999} />
        <FieldGridSpan>
          <TextAreaField
            form={form}
            name="description"
            label="Description"
            optional
            registerOptions={CLEAR_IF_BLANK}
          />
        </FieldGridSpan>
        <CheckboxField form={form} name="isCashEquivalent" label="Cash or bank" />
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
