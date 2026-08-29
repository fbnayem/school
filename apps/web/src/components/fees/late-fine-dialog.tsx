'use client';

/**
 * Charge late fines on overdue invoices.
 *
 * A fine is money a family owes because somebody decided they owe it, so the API never computes
 * one on read — it is an explicit, reason-carrying, audited run, and this dialog is the whole of
 * that decision. Three consequences show up in the UI:
 *
 *  - **The reason is collected, never manufactured.** It is validated with `reasonSchema`, the
 *    same schema the API validates with, and it lands in the audit record next to the run.
 *  - **The fine must be charged to a fee head of type `fine`.** The API refuses anything else
 *    with a message on `fineFeeHeadId`, so the select offers only those heads — and says so when
 *    there are none, rather than presenting an empty box.
 *  - **The result is the API's.** Which invoices were fined, by how much, and why the rest were
 *    skipped are all read back from the response. Nothing is estimated before the request.
 */

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { applyLateFinesSchema } from '@shikkha/validation';
import { api } from '@/lib/api';
import {
  Button,
  DataTable,
  DateField,
  Dialog,
  EmptyState,
  FieldGrid,
  FieldGridSpan,
  Form,
  FormActions,
  MetricCard,
  SelectField,
  StatGrid,
  TextAreaField,
  formatMoney,
  useToast,
  type SelectOption,
} from '@/components/ui';
import { formatCount, formatDate, formatNumber } from '@/lib/format';
import { feesApi, type LateFineRunResult } from './fees-api';

type LateFineValues = z.input<typeof applyLateFinesSchema>;

export function LateFineDialog({
  open,
  onClose,
  institutionId,
  canViewClassLevels,
}: {
  open: boolean;
  onClose: () => void;
  institutionId: string;
  canViewClassLevels: boolean;
}) {
  const [result, setResult] = useState<LateFineRunResult | null>(null);

  return (
    <Dialog
      open={open}
      onClose={() => {
        setResult(null);
        onClose();
      }}
      title="Charge late fines"
      description="Adds a fine line to every overdue invoice the scope matches, using each invoice's own fee plan rule."
      size="lg"
      closeOnBackdropClick={false}
    >
      {result ? (
        <LateFineResult
          result={result}
          onDone={() => {
            setResult(null);
            onClose();
          }}
        />
      ) : (
        <LateFineForm
          institutionId={institutionId}
          canViewClassLevels={canViewClassLevels}
          onApplied={setResult}
          onCancel={onClose}
        />
      )}
    </Dialog>
  );
}

function LateFineForm({
  institutionId,
  canViewClassLevels,
  onApplied,
  onCancel,
}: {
  institutionId: string;
  canViewClassLevels: boolean;
  onApplied: (result: LateFineRunResult) => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const years = useQuery({
    queryKey: ['academic-years', institutionId],
    queryFn: () => api.academicYears(institutionId),
    staleTime: 5 * 60_000,
  });

  // Only heads of type `fine` are valid targets; the API rejects anything else on
  // `fineFeeHeadId`, so filtering here is agreeing with it rather than second-guessing it.
  const fineHeads = useQuery({
    queryKey: ['fee-heads', 'fine', institutionId],
    queryFn: () => feesApi.listFeeHeads(institutionId, { type: 'fine', pageSize: 200 }),
    staleTime: 5 * 60_000,
  });

  const classLevels = useQuery({
    queryKey: ['class-levels', institutionId],
    queryFn: () => feesApi.classLevels(institutionId),
    enabled: canViewClassLevels,
    staleTime: 5 * 60_000,
  });

  const form = useForm<LateFineValues>({
    resolver: zodResolver(applyLateFinesSchema),
    defaultValues: {
      academicYearId: '',
      fineFeeHeadId: '',
      asOfDate: undefined,
      classLevelId: undefined,
      reason: '',
    },
  });

  const applyFines = useMutation({
    mutationFn: (values: LateFineValues) => feesApi.applyLateFines(institutionId, values),
    onSuccess: (runResult) => {
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
      toast.success(
        'Late fines charged',
        `${formatCount(runResult.applied.length, 'invoice')} fined for ${formatMoney(runResult.totalFined)}`,
      );
      onApplied(runResult);
    },
  });

  const headOptions: SelectOption[] = (fineHeads.data?.data ?? [])
    .filter((head) => head.archivedAt === null)
    .map((head) => ({ value: head.id, label: head.nameEn, hint: head.code }));

  if (!fineHeads.isLoading && headOptions.length === 0) {
    return (
      <EmptyState
        title="No fee head of type “fine” exists"
        description="A late fine has to land on a fee head a report can find. Create one with the type “Fine” on the fee heads tab, then run this again."
      />
    );
  }

  return (
    <Form
      form={form}
      onSubmit={async (values) => {
        await applyFines.mutateAsync(values);
      }}
      onError={toast.error}
    >
      <p className="rounded border border-warning/40 bg-warning-subtle px-3 py-2 text-sm text-warning">
        This charges real money to families. Each invoice is fined according to its own fee
        plan&rsquo;s rule and grace period; invoices whose plan charges no fine are skipped.
      </p>

      <FieldGrid>
        <SelectField
          form={form}
          name="academicYearId"
          label="Academic year"
          options={(years.data ?? []).map((year) => ({
            value: year.id,
            label: year.name,
            hint: year.isCurrent ? 'current' : undefined,
          }))}
          placeholder="Choose a year"
          required
        />
        <SelectField
          form={form}
          name="fineFeeHeadId"
          label="Charge the fine to"
          options={headOptions}
          placeholder="Choose a fine fee head"
          required
        />
        <DateField
          form={form}
          name="asOfDate"
          label="Assessed as of"
          optional
          hint="Only invoices due before this date are fined. Defaults to today."
          registerOptions={{ setValueAs: (value: string) => (value === '' ? undefined : value) }}
        />
        {canViewClassLevels ? (
          <SelectField
            form={form}
            name="classLevelId"
            label="Class"
            options={(classLevels.data ?? []).map((level) => ({
              value: level.id,
              label: level.nameEn,
              hint: level.nameBn ?? undefined,
            }))}
            placeholder="Every class"
            allowEmpty
            optional
            registerOptions={{ setValueAs: (value: string) => (value === '' ? undefined : value) }}
          />
        ) : null}
        <FieldGridSpan>
          <TextAreaField
            form={form}
            name="reason"
            label="Reason"
            required
            hint="Recorded in the audit log against your name. At least 10 characters."
          />
        </FieldGridSpan>
      </FieldGrid>

      <FormActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button
          type="submit"
          variant="danger"
          loading={form.formState.isSubmitting}
          loadingLabel="Charging fines…"
        >
          Charge late fines
        </Button>
      </FormActions>
    </Form>
  );
}

function LateFineResult({
  result,
  onDone,
}: {
  result: LateFineRunResult;
  onDone: () => void;
}) {
  return (
    <div className="space-y-4">
      <StatGrid>
        <MetricCard label="Invoices fined" value={formatNumber(result.applied.length)} />
        <MetricCard label="Total charged" value={formatMoney(result.totalFined)} tone="warning" />
        <MetricCard label="Skipped" value={formatNumber(result.skipped.length)} />
        <MetricCard label="Assessed as of" value={formatDate(result.asOfDate)} />
      </StatGrid>

      <DataTable<LateFineRunResult['applied'][number]>
        caption="Invoices that were fined"
        rows={result.applied}
        rowKey={(row) => row.invoiceId}
        minWidth="30rem"
        empty={{
          title: 'No invoice was fined',
          description:
            'Nothing in this scope was overdue past its grace period, or no fee plan in it charges a late fine.',
        }}
        columns={[
          {
            id: 'invoice',
            header: 'Invoice',
            card: 'title',
            className: 'font-mono text-xs',
            render: (row) => row.invoiceNumber,
          },
          {
            id: 'fine',
            header: 'Fine',
            align: 'right',
            card: 'row',
            className: 'tabular-nums',
            render: (row) => formatMoney(row.fine),
          },
          {
            id: 'total',
            header: 'New total',
            align: 'right',
            card: 'aside',
            className: 'tabular-nums font-medium',
            render: (row) => formatMoney(row.total),
          },
        ]}
      />

      <FormActions>
        <Button variant="primary" onClick={onDone}>
          Done
        </Button>
      </FormActions>
    </div>
  );
}
