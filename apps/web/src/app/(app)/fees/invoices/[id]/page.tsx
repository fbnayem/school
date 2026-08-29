'use client';

/**
 * One invoice: what was charged, what was discounted, what has been paid against it, and what
 * is still owed.
 *
 * Every figure on this screen is a string the API computed. `total`, `balance` and `paidTotal`
 * are derived on the server from the lines and the allocations and restated as database check
 * constraints; re-deriving any of them here would produce a second answer that is right until
 * the day it isn't (ADR-004).
 *
 * The student's name comes from the fee ledger rather than `/students/:id`. The ledger route
 * accepts exactly the permissions that let you read this invoice — including a guardian's
 * `finance.own.view` — so the name renders for every caller who is allowed to be here, and the
 * same request supplies the student's position across the whole year, which is the context a
 * bursar looking at one bill actually wants.
 */

import { use, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/lib/session';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  DataTable,
  DescriptionList,
  ErrorNotice,
  MetricCard,
  PageHeader,
  SkeletonCard,
  StatGrid,
  formatMoney,
  toMinor,
  toneForStatus,
  useToast,
} from '@/components/ui';
import { formatDate, formatDateRange, formatInstant, humanize } from '@/lib/format';
import { feesApi, type InvoiceAllocation, type InvoiceLine } from '@/components/fees/fees-api';

export default function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const session = useSession();
  const institutionId = session.institutionId!;
  const toast = useToast();
  const queryClient = useQueryClient();
  const [voiding, setVoiding] = useState(false);

  const invoice = useQuery({
    queryKey: ['invoice', institutionId, id],
    queryFn: () => feesApi.getInvoice(institutionId, id),
  });

  const studentId = invoice.data?.studentId;
  const ledger = useQuery({
    queryKey: ['student-ledger', institutionId, studentId, invoice.data?.academicYearId],
    queryFn: () =>
      feesApi.studentLedger(institutionId, studentId!, {
        academicYearId: invoice.data?.academicYearId,
      }),
    enabled: Boolean(studentId),
  });

  const voidInvoice = useMutation({
    mutationFn: (reason: string) => feesApi.voidInvoice(institutionId, id, reason),
    onSuccess: (voided) => {
      void queryClient.invalidateQueries({ queryKey: ['invoice', institutionId, id] });
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
      toast.success('Invoice voided', `${voided.invoiceNumber} no longer carries a balance.`);
    },
  });

  if (invoice.isError) {
    return (
      <div className="mx-auto max-w-4xl">
        <ErrorNotice error={invoice.error} />
        <Button href="/fees" className="mt-4">
          Back to fees
        </Button>
      </div>
    );
  }

  if (invoice.isLoading || !invoice.data) {
    return (
      <div className="mx-auto max-w-4xl">
        <SkeletonCard lines={8} label="Loading invoice" />
      </div>
    );
  }

  const row = invoice.data;
  const hasPayments = row.payments.length > 0;
  const settled = toMinor(row.balance) <= 0n;

  // The API refuses to void an invoice that has been paid against — the correction for that is
  // a credit, so both documents stay visible to an auditor. Offering the button anyway would
  // produce a guaranteed 409, so it is not offered.
  const canVoid = session.can('finance.invoices.void') && row.status !== 'void' && !hasPayments;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        breadcrumbs={[{ label: 'Fees', href: '/fees' }, { label: row.invoiceNumber }]}
        title={row.invoiceNumber}
        description={ledger.data ? `Billed to ${ledger.data.student.fullNameEn}` : undefined}
        meta={
          <>
            <Badge tone={toneForStatus(row.status)}>{humanize(row.status)}</Badge>
            <span>Due {formatDate(row.dueDate)}</span>
            {ledger.data ? (
              <span className="font-mono text-xs">{ledger.data.student.studentCode}</span>
            ) : null}
          </>
        }
        actions={
          <>
            {session.can('finance.collect_payment') && !settled && row.status !== 'void' ? (
              <Button variant="primary" href={`/fees/collect?studentId=${row.studentId}`}>
                Collect payment
              </Button>
            ) : null}
            {canVoid ? (
              <Button variant="danger" onClick={() => setVoiding(true)}>
                Void invoice
              </Button>
            ) : null}
          </>
        }
      />

      <StatGrid className="mb-5">
        <MetricCard label="Invoice total" value={formatMoney(row.total)} />
        <MetricCard label="Discounts" value={formatMoney(row.discountTotal)} />
        <MetricCard label="Paid" value={formatMoney(row.paidTotal)} tone="success" />
        <MetricCard
          label="Balance"
          value={formatMoney(row.balance)}
          tone={settled ? 'default' : 'danger'}
          detail={settled ? 'Nothing outstanding' : 'Outstanding'}
        />
      </StatGrid>

      <Card className="mb-5">
        <CardHeader title="Invoice details" />
        <CardBody>
          <DescriptionList
            items={[
              {
                label: 'Billing period',
                value: formatDateRange(row.billingPeriodStart, row.billingPeriodEnd),
              },
              { label: 'Issued', value: formatDate(row.issueDate) },
              { label: 'Due', value: formatDate(row.dueDate) },
              { label: 'Currency', value: row.currency },
              { label: 'Late fines charged', value: formatMoney(row.fineTotal) },
              { label: 'Subtotal before discount', value: formatMoney(row.subtotal) },
              { label: 'Notes', value: row.notes, span: true },
              ...(row.status === 'void'
                ? [{ label: 'Voided because', value: row.voidedReason, span: true }]
                : []),
            ]}
          />
        </CardBody>
      </Card>

      <section className="mb-5">
        <h2 className="mb-3 text-lg font-semibold tracking-tight">Charges</h2>
        <DataTable<InvoiceLine>
          caption={`Charges on invoice ${row.invoiceNumber}`}
          rows={row.lines}
          rowKey={(line) => line.id}
          minWidth="38rem"
          empty={{
            title: 'This invoice has no lines',
            description: 'Nothing was charged. The invoice total is zero.',
          }}
          columns={[
            {
              id: 'description',
              header: 'Charge',
              card: 'title',
              render: (line) => (
                <span className="flex items-center gap-2">
                  {line.description}
                  {line.isFine ? <Badge tone="warning">Late fine</Badge> : null}
                </span>
              ),
            },
            {
              id: 'amount',
              header: 'Amount',
              align: 'right',
              card: 'row',
              className: 'tabular-nums',
              render: (line) => formatMoney(line.amount),
            },
            {
              id: 'discount',
              header: 'Discount',
              align: 'right',
              card: 'row',
              className: 'tabular-nums text-content-muted',
              render: (line) => formatMoney(line.discountAmount),
            },
            {
              id: 'net',
              header: 'Net',
              align: 'right',
              card: 'aside',
              className: 'tabular-nums font-medium',
              render: (line) => formatMoney(line.netAmount),
            },
          ]}
        />
      </section>

      <section className="mb-5">
        <h2 className="mb-3 text-lg font-semibold tracking-tight">Payments applied</h2>
        <DataTable<InvoiceAllocation>
          caption={`Payments allocated to invoice ${row.invoiceNumber}`}
          rows={row.payments}
          rowKey={(allocation) => allocation.allocationId}
          minWidth="38rem"
          empty={{
            title: 'No payments yet',
            description:
              'Nothing has been received against this invoice. A receipt recorded for this student will appear here once it is allocated.',
          }}
          columns={[
            {
              id: 'receipt',
              header: 'Receipt',
              card: 'title',
              className: 'font-mono text-xs',
              render: (allocation) => allocation.receiptNumber,
            },
            {
              id: 'receivedAt',
              header: 'Received',
              card: 'subtitle',
              render: (allocation) => formatInstant(allocation.receivedAt),
            },
            {
              id: 'method',
              header: 'Method',
              card: 'meta',
              render: (allocation) => humanize(allocation.method),
            },
            {
              id: 'status',
              header: 'Status',
              card: 'aside',
              render: (allocation) => (
                <Badge tone={toneForStatus(allocation.paymentStatus)}>
                  {humanize(allocation.paymentStatus)}
                </Badge>
              ),
            },
            {
              id: 'amount',
              header: 'Applied',
              align: 'right',
              card: 'row',
              className: 'tabular-nums font-medium',
              render: (allocation) => formatMoney(allocation.amount),
            },
          ]}
        />
      </section>

      {ledger.data ? (
        <Card>
          <CardHeader
            title={`${ledger.data.student.fullNameEn} — position for this year`}
            description="Every invoice and receipt for this student in the invoice's academic year."
          />
          <CardBody>
            <DescriptionList
              columns={3}
              items={[
                { label: 'Charged', value: formatMoney(ledger.data.totalCharged) },
                { label: 'Paid', value: formatMoney(ledger.data.totalPaid) },
                { label: 'Closing balance', value: formatMoney(ledger.data.closingBalance) },
              ]}
            />
          </CardBody>
        </Card>
      ) : ledger.isError ? (
        <ErrorNotice error={ledger.error} />
      ) : null}

      {session.can('finance.invoices.void') && row.status !== 'void' && hasPayments ? (
        <p className="mt-4 text-sm text-content-muted">
          This invoice cannot be voided: money has already been allocated to it. Reverse the
          receipt first, or raise a credit so both documents stay on the record.
        </p>
      ) : null}

      <ConfirmDialog
        open={voiding}
        onClose={() => setVoiding(false)}
        title={`Void ${row.invoiceNumber}?`}
        body="Voiding cancels the bill and clears its balance. The invoice stays visible with its reason, and the number is never reused."
        confirmLabel="Void invoice"
        requireReason
        reasonLabel="Why is this invoice being voided?"
        onConfirm={async (reason) => {
          await voidInvoice.mutateAsync(reason);
        }}
      />
    </div>
  );
}
