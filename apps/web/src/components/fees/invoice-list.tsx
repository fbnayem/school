'use client';

/**
 * The invoice register.
 *
 * Ageing is the reason this table exists rather than a plain list: a bursar's question is never
 * "how many invoices are there", it is "what is overdue and by how long". The bucket is derived
 * from two facts the API returned — `dueDate` and `balance` — and from today's date in Dhaka.
 * No money is added, subtracted or compared as a number anywhere here: `toMinor` turns a
 * decimal string into integer poisa purely so `> 0` is answerable without a float (ADR-004).
 *
 * There is deliberately **no student column**. `GET /fees/invoices` returns invoice rows and
 * does not join the student, and inventing a name — or firing one request per row to find
 * twenty-five of them — would be worse than the honest omission. The student is on the invoice
 * detail screen, which does have the ledger to look them up in.
 */

import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { INVOICE_STATUSES } from '@shikkha/validation';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import {
  Badge,
  Button,
  DataTable,
  FilterBar,
  Pagination,
  formatMoney,
  toMinor,
  toneForStatus,
  type SelectOption,
} from '@/components/ui';
import { daysBetween, formatDate, humanize, todayInDhaka } from '@/lib/format';
import { feesApi, type Invoice } from './fees-api';
import { LateFineDialog } from './late-fine-dialog';

const PAGE_SIZE = 25;

const STATUS_OPTIONS: SelectOption[] = INVOICE_STATUSES.map((status) => ({
  value: status,
  label: humanize(status),
}));

const OUTSTANDING_OPTIONS: SelectOption[] = [
  { value: 'true', label: 'Only with a balance' },
];

/** Days past due, or `null` when nothing is owed. Dates only — no money arithmetic. */
function daysOverdue(invoice: Invoice, today: string): number | null {
  if (invoice.status === 'void') return null;
  if (toMinor(invoice.balance) <= 0n) return null;
  const days = daysBetween(invoice.dueDate, today);
  return days > 0 ? days : null;
}

function AgeingCell({ invoice, today }: { invoice: Invoice; today: string }) {
  const days = daysOverdue(invoice, today);
  if (days === null) return <span className="text-content-subtle">—</span>;
  const bucket = days <= 30 ? '1–30 days' : days <= 60 ? '31–60 days' : days <= 90 ? '61–90 days' : 'Over 90 days';
  return (
    <Badge tone={days > 60 ? 'danger' : 'warning'} dot>
      {bucket}
    </Badge>
  );
}

export function InvoiceList({
  institutionId,
  /**
   * `GET /academic/years` needs `academic.years.view`, which the Accounts Manager preset does
   * not hold. Without it the year filter is not rendered at all rather than rendered broken —
   * the API is the security boundary and re-checks regardless; this is a usability rule.
   */
  canViewAcademicYears,
  canViewClassLevels,
}: {
  institutionId: string;
  canViewAcademicYears: boolean;
  canViewClassLevels: boolean;
}) {
  const session = useSession();
  const [fining, setFining] = useState(false);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [outstandingOnly, setOutstandingOnly] = useState('');
  const [academicYearId, setAcademicYearId] = useState('');
  const [sort, setSort] = useState<string | undefined>();
  const [page, setPage] = useState(1);

  const today = todayInDhaka();

  const years = useQuery({
    queryKey: ['academic-years', institutionId],
    queryFn: () => api.academicYears(institutionId),
    enabled: canViewAcademicYears,
    staleTime: 5 * 60_000,
  });

  const invoices = useQuery({
    queryKey: [
      'invoices',
      { institutionId, q, status, outstandingOnly, academicYearId, sort, page },
    ],
    queryFn: () =>
      feesApi.listInvoices(institutionId, {
        q: q || undefined,
        status: status || undefined,
        outstandingOnly: outstandingOnly || undefined,
        academicYearId: academicYearId || undefined,
        sort,
        page,
        pageSize: PAGE_SIZE,
      }),
    placeholderData: keepPreviousData,
  });

  const resetPage = () => setPage(1);

  return (
    <>
      <FilterBar
        search={{
          value: q,
          onChange: (value) => {
            setQ(value);
            resetPage();
          },
          label: 'Search by invoice number',
          placeholder: 'Invoice number, e.g. INV-2026',
        }}
        filters={[
          {
            id: 'status',
            label: 'Invoice status',
            value: status,
            onChange: (value) => {
              setStatus(value);
              resetPage();
            },
            options: STATUS_OPTIONS,
            placeholder: 'Any status',
          },
          {
            id: 'outstanding',
            label: 'Balance',
            value: outstandingOnly,
            onChange: (value) => {
              setOutstandingOnly(value);
              resetPage();
            },
            options: OUTSTANDING_OPTIONS,
            placeholder: 'Paid and unpaid',
          },
          ...(canViewAcademicYears
            ? [
                {
                  id: 'year',
                  label: 'Academic year',
                  value: academicYearId,
                  onChange: (value: string) => {
                    setAcademicYearId(value);
                    resetPage();
                  },
                  options: (years.data ?? []).map((year) => ({
                    value: year.id,
                    label: year.name,
                    hint: year.isCurrent ? 'current' : undefined,
                  })),
                  placeholder: 'All years',
                },
              ]
            : []),
        ]}
        actions={
          // `POST /fees/invoices/late-fines` requires *both* permissions, and the run is scoped
          // to an academic year the caller has to be able to name. Missing any of the three, the
          // control is absent rather than present and doomed.
          canViewAcademicYears &&
          session.can('finance.fees.manage') &&
          session.can('finance.invoices.generate') ? (
            <Button onClick={() => setFining(true)}>Charge late fines</Button>
          ) : null
        }
        onReset={() => {
          setQ('');
          setStatus('');
          setOutstandingOnly('');
          setAcademicYearId('');
          resetPage();
        }}
      />

      <DataTable<Invoice>
        caption={`Invoices, page ${invoices.data?.meta.page ?? 1} of ${invoices.data?.meta.totalPages ?? 1}`}
        rows={invoices.data?.data ?? []}
        rowKey={(row) => row.id}
        rowHref={(row) => `/fees/invoices/${row.id}`}
        sort={sort}
        onSortChange={(value) => {
          setSort(value);
          resetPage();
        }}
        isLoading={invoices.isLoading}
        isFetching={invoices.isFetching}
        error={invoices.error}
        minWidth="52rem"
        empty={{
          title: q || status || outstandingOnly ? 'No invoices match those filters' : 'No invoices yet',
          description:
            q || status || outstandingOnly
              ? 'Clear the filters, or check the invoice number you searched for.'
              : 'Invoices appear here once a billing run has been generated.',
        }}
        columns={[
          {
            id: 'invoiceNumber',
            header: 'Invoice',
            sortField: 'invoiceNumber',
            card: 'title',
            className: 'font-mono text-xs',
            render: (row) => row.invoiceNumber,
          },
          {
            id: 'issueDate',
            header: 'Issued',
            sortField: 'issueDate',
            hideBelow: 'lg',
            card: 'hidden',
            className: 'tabular-nums text-content-muted',
            render: (row) => formatDate(row.issueDate),
          },
          {
            id: 'dueDate',
            header: 'Due',
            sortField: 'dueDate',
            card: 'subtitle',
            className: 'tabular-nums',
            render: (row) => formatDate(row.dueDate),
          },
          {
            id: 'ageing',
            header: 'Ageing',
            card: 'meta',
            render: (row) => <AgeingCell invoice={row} today={today} />,
          },
          {
            id: 'total',
            header: 'Total',
            sortField: 'total',
            align: 'right',
            hideBelow: 'md',
            card: 'row',
            className: 'tabular-nums',
            render: (row) => formatMoney(row.total),
          },
          {
            id: 'paidTotal',
            header: 'Paid',
            align: 'right',
            hideBelow: 'lg',
            card: 'hidden',
            className: 'tabular-nums text-content-muted',
            render: (row) => formatMoney(row.paidTotal),
          },
          {
            id: 'balance',
            header: 'Balance',
            sortField: 'balance',
            align: 'right',
            card: 'row',
            className: 'tabular-nums font-medium',
            render: (row) => formatMoney(row.balance),
          },
          {
            id: 'status',
            header: 'Status',
            sortField: 'status',
            card: 'aside',
            render: (row) => <Badge tone={toneForStatus(row.status)}>{humanize(row.status)}</Badge>,
          },
        ]}
      />

      <Pagination
        meta={invoices.data?.meta}
        onPageChange={setPage}
        isFetching={invoices.isFetching}
        itemNoun="invoice"
      />

      <LateFineDialog
        open={fining}
        onClose={() => setFining(false)}
        institutionId={institutionId}
        canViewClassLevels={canViewClassLevels}
      />
    </>
  );
}
