'use client';

/**
 * Collect a payment.
 *
 * The highest-consequence screen in the fees area, so the sequence is deliberate:
 *
 *  1. **Choose the student, then see what they owe.** The outstanding invoices come from the
 *     API filtered to that student — the clerk is looking at the same rows the allocation will
 *     settle, not a summary of them.
 *  2. **Confirm before sending.** The amount is echoed back formatted, with the student's name
 *     and code, because "৳12,000" and "৳1,200" are one keystroke apart and the confirmation is
 *     the last place that difference is cheap.
 *  3. **Nothing is shown as taken until the API says it was.** There is no optimistic update
 *     and no local receipt number: the receipt panel below renders `record.data`, which only
 *     exists once the server has committed the payment, its allocations and its audit record in
 *     one transaction. If the request fails, the dialog stays open with the API's message and
 *     request id, and the form still holds everything the clerk typed.
 *
 * Allocation is by strategy — oldest due first, or proportional — which is what the API
 * implements and what a counter payment means. The response says exactly which invoices were
 * settled and by how much, and that is what the receipt shows. No money is added up here: the
 * split was computed by `Money.allocate` on the server (ADR-004).
 */

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { FEE_PAYMENT_METHODS, recordPaymentSchema } from '@shikkha/validation';
import { api, type StudentSummary } from '@/lib/api';
import { useSession } from '@/lib/session';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  ConfirmDialog,
  DataTable,
  DescriptionList,
  EmptyState,
  ErrorNotice,
  FieldGrid,
  FieldGridSpan,
  Form,
  FormActions,
  LoadingBlock,
  MetricCard,
  MoneyField,
  PageHeader,
  RadioField,
  SelectField,
  StatGrid,
  TextAreaField,
  TextField,
  applyApiFieldErrors,
  formatMoney,
  toneForStatus,
  useToast,
  type SelectOption,
} from '@/components/ui';
import { formatDate, formatInstant, formatNumber, humanize } from '@/lib/format';
import { StudentPicker } from '@/components/fees/student-picker';
import { feesApi, type Invoice, type RecordPaymentResult } from '@/components/fees/fees-api';

type PaymentValues = z.input<typeof recordPaymentSchema>;

const METHOD_OPTIONS: SelectOption[] = FEE_PAYMENT_METHODS.map((method) => ({
  value: method,
  label: humanize(method),
}));

export default function CollectPaymentPage() {
  return (
    <Suspense fallback={<LoadingBlock label="Loading the payment counter" />}>
      <CollectPaymentScreen />
    </Suspense>
  );
}

function CollectPaymentScreen() {
  const session = useSession();
  const institutionId = session.institutionId!;
  const toast = useToast();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const initialStudentId = searchParams.get('studentId');

  const [student, setStudent] = useState<StudentSummary | null>(null);
  const [pending, setPending] = useState<PaymentValues | null>(null);
  const [receipt, setReceipt] = useState<RecordPaymentResult | null>(null);

  const canFindStudents = session.canAny(
    'students.view.all',
    'students.view.assigned',
    'students.view.own',
  );
  const canSeeLedger = session.canAny(
    'finance.ledger.view',
    'finance.invoices.view',
    'finance.own.view',
  );

  const form = useForm<PaymentValues>({
    resolver: zodResolver(recordPaymentSchema),
    defaultValues: {
      studentId: '',
      amount: '',
      method: 'cash',
      reference: '',
      notes: '',
      strategy: 'oldest_due_first',
    },
  });

  // Arriving from an invoice with `?studentId=`: look the student up once so the counter opens
  // on the right family. Seeded once — clearing the picker afterwards must not re-seed it.
  const seeded = useRef(false);
  const prefill = useQuery({
    queryKey: ['student', initialStudentId],
    queryFn: () => api.student(initialStudentId!),
    enabled: Boolean(initialStudentId) && canFindStudents,
  });
  useEffect(() => {
    if (seeded.current || !prefill.data) return;
    seeded.current = true;
    setStudent(prefill.data);
  }, [prefill.data]);

  // `studentId` has no input of its own — the picker is the control — so the form value is
  // kept in step here. Zod still validates it, and its message renders under the picker.
  useEffect(() => {
    form.setValue('studentId', student?.id ?? '', { shouldValidate: form.formState.isSubmitted });
  }, [student, form]);

  const outstanding = useQuery({
    queryKey: ['invoices', 'outstanding-for-student', institutionId, student?.id],
    queryFn: () =>
      feesApi.listInvoices(institutionId, {
        studentId: student!.id,
        outstandingOnly: 'true',
        sort: 'dueDate',
        pageSize: 50,
      }),
    enabled: Boolean(student) && canSeeLedger,
  });

  const ledger = useQuery({
    queryKey: ['student-ledger', institutionId, student?.id, 'all-years'],
    queryFn: () => feesApi.studentLedger(institutionId, student!.id, {}),
    enabled: Boolean(student) && canSeeLedger,
  });

  const record = useMutation({
    mutationFn: (values: PaymentValues) => feesApi.recordPayment(institutionId, values),
    onSuccess: (result) => {
      setReceipt(result);
      setPending(null);
      form.reset({
        studentId: student?.id ?? '',
        amount: '',
        method: 'cash',
        reference: '',
        notes: '',
        strategy: 'oldest_due_first',
      });
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
      void queryClient.invalidateQueries({ queryKey: ['student-ledger'] });
      toast.success('Payment recorded', `Receipt ${result.payment.receiptNumber}`);
    },
  });

  if (!session.can('finance.collect_payment')) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="Collect payment" />
        <EmptyState
          title="You cannot record payments"
          description="Taking money needs finance.collect_payment. Ask your school administrator to check your role."
        />
      </div>
    );
  }

  if (!canFindStudents) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="Collect payment" />
        <EmptyState
          title="Student lookup is not available to your role"
          description="A payment is recorded against a named student, and finding one needs a students.view permission. Ask your school administrator to check your role."
        />
      </div>
    );
  }

  const studentIdError = form.formState.errors.studentId?.message;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        breadcrumbs={[{ label: 'Fees', href: '/fees' }, { label: 'Collect payment' }]}
        title="Collect payment"
        description="Record money received at the counter. The receipt number is issued by the server when the payment commits."
      />

      {receipt ? (
        <Receipt
          receipt={receipt}
          studentName={student?.fullNameEn ?? ''}
          onDone={() => setReceipt(null)}
        />
      ) : null}

      <Card className="mb-5" padded>
        <StudentPicker institutionId={institutionId} value={student} onChange={setStudent} />
        {studentIdError ? (
          <p role="alert" className="mt-2 text-sm font-medium text-danger">
            {studentIdError}
          </p>
        ) : null}
        {prefill.isError ? (
          <div className="mt-3">
            <ErrorNotice error={prefill.error} />
          </div>
        ) : null}
      </Card>

      {student && canSeeLedger ? (
        <>
          <StatGrid className="mb-5">
            <MetricCard
              label="Charged to date"
              value={ledger.data ? formatMoney(ledger.data.totalCharged) : null}
            />
            <MetricCard
              label="Paid to date"
              value={ledger.data ? formatMoney(ledger.data.totalPaid) : null}
              tone="success"
            />
            <MetricCard
              label="Currently owes"
              value={ledger.data ? formatMoney(ledger.data.closingBalance) : null}
              tone="danger"
            />
            <MetricCard
              label="Open invoices"
              value={outstanding.data ? formatNumber(outstanding.data.meta.total) : null}
              detail="With a balance"
            />
          </StatGrid>

          <section className="mb-5">
            <h2 className="mb-3 text-lg font-semibold tracking-tight">
              Invoices this payment will settle
            </h2>
            <DataTable<Invoice>
              caption={`Outstanding invoices for ${student.fullNameEn}`}
              rows={outstanding.data?.data ?? []}
              rowKey={(row) => row.id}
              rowHref={(row) => `/fees/invoices/${row.id}`}
              isLoading={outstanding.isLoading}
              isFetching={outstanding.isFetching}
              error={outstanding.error}
              minWidth="38rem"
              empty={{
                title: 'Nothing outstanding',
                description:
                  'This student has no invoice with a balance. A payment recorded now is held as an advance and picked up by the next invoice.',
              }}
              columns={[
                {
                  id: 'invoiceNumber',
                  header: 'Invoice',
                  card: 'title',
                  className: 'font-mono text-xs',
                  render: (row) => row.invoiceNumber,
                },
                {
                  id: 'dueDate',
                  header: 'Due',
                  card: 'subtitle',
                  className: 'tabular-nums',
                  render: (row) => formatDate(row.dueDate),
                },
                {
                  id: 'status',
                  header: 'Status',
                  card: 'meta',
                  render: (row) => (
                    <Badge tone={toneForStatus(row.status)}>{humanize(row.status)}</Badge>
                  ),
                },
                {
                  id: 'total',
                  header: 'Total',
                  align: 'right',
                  card: 'row',
                  className: 'tabular-nums text-content-muted',
                  render: (row) => formatMoney(row.total),
                },
                {
                  id: 'balance',
                  header: 'Balance',
                  align: 'right',
                  card: 'aside',
                  className: 'tabular-nums font-medium',
                  render: (row) => formatMoney(row.balance),
                },
              ]}
            />
          </section>
        </>
      ) : null}

      <Card>
        <CardHeader
          title="Payment"
          description="The amount is recorded exactly as typed and never rounded in the browser."
        />
        <CardBody>
          <Form
            form={form}
            // Submitting opens the confirmation; the API is only called from the dialog.
            onSubmit={(values) => setPending(values)}
            onError={toast.error}
          >
            <FieldGrid>
              <MoneyField
                form={form}
                name="amount"
                label="Amount received"
                required
                hint="Taka and poisa, e.g. 2500 or 2500.50"
              />
              <SelectField
                form={form}
                name="method"
                label="Method"
                options={METHOD_OPTIONS}
                required
              />
              <TextField
                form={form}
                name="reference"
                label="Reference"
                optional
                hint="bKash transaction id, cheque number, bank slip."
                autoComplete="off"
                registerOptions={{ setValueAs: (value: string) => (value === '' ? undefined : value) }}
              />
              <FieldGridSpan>
                <RadioField
                  form={form}
                  name="strategy"
                  label="How should this be applied?"
                  options={[
                    {
                      value: 'oldest_due_first',
                      label: 'Settle the oldest due invoice first',
                      hint: 'What a counter payment usually means. Anything left over is held as an advance.',
                    },
                    {
                      value: 'proportional',
                      label: 'Split across every open invoice in proportion to its balance',
                      hint: 'The server splits it so the parts add back to exactly the amount received.',
                    },
                  ]}
                />
              </FieldGridSpan>
              <FieldGridSpan>
                <TextAreaField
                  form={form}
                  name="notes"
                  label="Notes"
                  optional
                  registerOptions={{
                    setValueAs: (value: string) => (value === '' ? undefined : value),
                  }}
                />
              </FieldGridSpan>
            </FieldGrid>

            <FormActions>
              <Button href="/fees">Cancel</Button>
              <Button type="submit" variant="primary" disabled={!student}>
                Review payment
              </Button>
            </FormActions>
          </Form>
        </CardBody>
      </Card>

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        variant="primary"
        title="Record this payment?"
        confirmLabel="Record payment"
        body={
          pending ? (
            <div className="space-y-2">
              <p>
                <strong className="text-content">{formatMoney(pending.amount)}</strong> from{' '}
                <strong className="text-content">{student?.fullNameEn}</strong> (
                {student?.studentCode}) by {humanize(pending.method)}.
              </p>
              <p>
                A receipt number is issued and the allocation is written in the same transaction.
                Correcting this afterwards means reversing the receipt, which is a separate,
                audited act.
              </p>
            </div>
          ) : null
        }
        onConfirm={async () => {
          try {
            await record.mutateAsync(pending!);
          } catch (error) {
            // A 422 belongs on the field that caused it, not in the dialog. `applyApiFieldErrors`
            // returns true when it attached one, in which case the dialog steps aside.
            if (applyApiFieldErrors(error, form)) setPending(null);
            throw error;
          }
        }}
      />
    </div>
  );
}

/**
 * The receipt, rendered only from what the API returned. There is no locally-generated number
 * and no locally-computed split — `allocations` and `unallocated` are the server's answer.
 */
function Receipt({
  receipt,
  studentName,
  onDone,
}: {
  receipt: RecordPaymentResult;
  studentName: string;
  onDone: () => void;
}) {
  return (
    <Card className="mb-5 border-success/40">
      <CardHeader
        title={`Receipt ${receipt.payment.receiptNumber}`}
        description={`Recorded against ${studentName || 'this student'}.`}
        actions={<Badge tone="success">{humanize(receipt.payment.status)}</Badge>}
      />
      <CardBody>
        <DescriptionList
          columns={3}
          items={[
            { label: 'Amount received', value: formatMoney(receipt.payment.amount) },
            { label: 'Method', value: humanize(receipt.payment.method) },
            { label: 'Received at', value: formatInstant(receipt.payment.receivedAt) },
            { label: 'Reference', value: receipt.payment.reference },
            {
              label: 'Held as advance',
              value: formatMoney(receipt.unallocated),
              emptyText: '—',
            },
          ]}
        />

        <h3 className="mb-2 mt-5 text-base font-semibold">Applied to</h3>
        {receipt.allocations.length === 0 ? (
          <p className="text-sm text-content-muted">
            Nothing was outstanding, so the whole amount is held as an advance against the next
            invoice.
          </p>
        ) : (
          <ul className="divide-y divide-line rounded border border-line">
            {receipt.allocations.map((allocation) => (
              <li
                key={allocation.invoiceId}
                className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <Link
                  href={`/fees/invoices/${allocation.invoiceId}`}
                  className="font-mono text-xs text-accent-700 hover:underline"
                >
                  {allocation.invoiceNumber}
                </Link>
                <span className="tabular-nums font-medium">{formatMoney(allocation.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
      <CardFooter>
        <Button onClick={onDone}>Record another payment</Button>
        <Button href="/fees">Back to fees</Button>
      </CardFooter>
    </Card>
  );
}
