'use client';

/**
 * The journal.
 *
 * Entries arrive from two places and the table says which: `accounting` for something a person
 * drafted, and `fees`, `payroll` and the rest for entries other modules posted automatically
 * through `LedgerService`. A system-generated entry is never editable by hand, and showing where
 * it came from is what stops someone hunting for an edit button that does not exist.
 */

import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { JOURNAL_ENTRY_STATUSES } from '@shikkha/validation';
import { useSession } from '@/lib/session';
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  FilterBar,
  PageHeader,
  Pagination,
  toneForStatus,
  type SelectOption,
} from '@/components/ui';
import { formatDate, humanize } from '@/lib/format';
import { accountingApi, type JournalEntry } from '@/components/accounting/accounting-api';

const PAGE_SIZE = 25;

const STATUS_OPTIONS: SelectOption[] = JOURNAL_ENTRY_STATUSES.map((status) => ({
  value: status,
  label: humanize(status),
}));

export default function JournalEntriesPage() {
  const session = useSession();
  const institutionId = session.institutionId!;

  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [fiscalYearId, setFiscalYearId] = useState('');
  const [sort, setSort] = useState<string | undefined>();
  const [page, setPage] = useState(1);

  const canView = session.can('accounting.journal.view');

  const fiscalYears = useQuery({
    queryKey: ['fiscal-years', institutionId],
    queryFn: () => accountingApi.listFiscalYears(institutionId, { pageSize: 50, sort: '-startDate' }),
    enabled: canView,
    staleTime: 5 * 60_000,
  });

  const entries = useQuery({
    queryKey: ['journal-entries', { institutionId, q, status, fiscalYearId, sort, page }],
    queryFn: () =>
      accountingApi.listJournalEntries(institutionId, {
        q: q || undefined,
        status: status || undefined,
        fiscalYearId: fiscalYearId || undefined,
        sort,
        page,
        pageSize: PAGE_SIZE,
      }),
    enabled: canView,
    placeholderData: keepPreviousData,
  });

  if (!canView) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="Journal" />
        <EmptyState
          title="The journal is not visible to your role"
          description="Reading journal entries needs accounting.journal.view. Ask your school administrator to check your role."
        />
      </div>
    );
  }

  const resetPage = () => setPage(1);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        breadcrumbs={[{ label: 'Accounting', href: '/accounting' }, { label: 'Journal' }]}
        title="Journal entries"
        description="Every movement in the ledger, drafted by hand or posted by another module."
        actions={
          // Drafting and posting are deliberately different permissions — the accountant drafts,
          // the accounts manager posts — so only the drafting permission opens this door.
          session.can('accounting.journal.create') ? (
            <Button variant="primary" href="/accounting/journals/new">
              Draft an entry
            </Button>
          ) : null
        }
      />

      <FilterBar
        search={{
          value: q,
          onChange: (value) => {
            setQ(value);
            resetPage();
          },
          label: 'Search by entry number',
          placeholder: 'Entry number, e.g. JE-2026',
        }}
        filters={[
          {
            id: 'status',
            label: 'Entry status',
            value: status,
            onChange: (value) => {
              setStatus(value);
              resetPage();
            },
            options: STATUS_OPTIONS,
            placeholder: 'Any status',
          },
          {
            id: 'fiscalYear',
            label: 'Fiscal year',
            value: fiscalYearId,
            onChange: (value) => {
              setFiscalYearId(value);
              resetPage();
            },
            options: (fiscalYears.data?.data ?? []).map((year) => ({
              value: year.id,
              label: year.name,
              hint: year.status === 'closed' ? 'closed' : undefined,
            })),
            placeholder: 'All fiscal years',
          },
        ]}
        onReset={() => {
          setQ('');
          setStatus('');
          setFiscalYearId('');
          resetPage();
        }}
      />

      <DataTable<JournalEntry>
        caption={`Journal entries, page ${entries.data?.meta.page ?? 1} of ${entries.data?.meta.totalPages ?? 1}`}
        rows={entries.data?.data ?? []}
        rowKey={(row) => row.id}
        rowHref={(row) => `/accounting/journals/${row.id}`}
        sort={sort}
        onSortChange={(value) => {
          setSort(value);
          resetPage();
        }}
        isLoading={entries.isLoading}
        isFetching={entries.isFetching}
        error={entries.error}
        minWidth="48rem"
        empty={{
          title: q || status ? 'No entries match those filters' : 'The journal is empty',
          description:
            'Nothing has been posted yet. Entries appear here as soon as they are drafted, whether by hand or by another module.',
        }}
        columns={[
          {
            id: 'entryNumber',
            header: 'Entry',
            sortField: 'entryNumber',
            card: 'title',
            className: 'font-mono text-xs',
            render: (row) => row.entryNumber,
          },
          {
            id: 'entryDate',
            header: 'Date',
            sortField: 'entryDate',
            card: 'subtitle',
            className: 'tabular-nums',
            render: (row) => formatDate(row.entryDate),
          },
          {
            id: 'description',
            header: 'Description',
            card: 'row',
            render: (row) => <span className="text-content-muted">{row.description}</span>,
          },
          {
            id: 'source',
            header: 'Source',
            hideBelow: 'md',
            card: 'meta',
            render: (row) => (
              <span className="flex flex-wrap gap-1">
                <Badge>{humanize(row.sourceModule)}</Badge>
                {row.isSystemGenerated ? <Badge tone="info">Automatic</Badge> : null}
              </span>
            ),
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
        meta={entries.data?.meta}
        onPageChange={setPage}
        isFetching={entries.isFetching}
        itemNoun="journal entry"
        itemNounPlural="journal entries"
      />
    </div>
  );
}
