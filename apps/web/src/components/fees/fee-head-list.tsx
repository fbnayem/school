'use client';

/**
 * Fee heads — the catalogue of things a school can charge for.
 *
 * Note what is sent for the boolean filters: `'true'` or **nothing**. The API parses them with
 * `z.coerce.boolean()`, and `Boolean('false')` is `true` — sending the string `'false'` would
 * turn "hide archived" into "show archived". `apiRequest` drops `undefined` from the query
 * string, so omitting the parameter is how "off" is expressed.
 */

import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FEE_HEAD_TYPES } from '@shikkha/validation';
import { useSession } from '@/lib/session';
import {
  Badge,
  Button,
  BilingualName,
  ConfirmDialog,
  DataTable,
  FilterBar,
  IconButton,
  Pagination,
  useConfirm,
  useToast,
  type SelectOption,
} from '@/components/ui';
import { humanize } from '@/lib/format';
import { feesApi, type FeeHead } from './fees-api';
import { FeeHeadDialog } from './fee-head-dialog';

const PAGE_SIZE = 25;

const TYPE_OPTIONS: SelectOption[] = FEE_HEAD_TYPES.map((type) => ({
  value: type,
  label: humanize(type),
}));

const ARCHIVED_OPTIONS: SelectOption[] = [{ value: 'true', label: 'Including archived' }];

export function FeeHeadList({ institutionId }: { institutionId: string }) {
  const session = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [includeArchived, setIncludeArchived] = useState('');
  const [sort, setSort] = useState<string | undefined>();
  const [page, setPage] = useState(1);

  const [editing, setEditing] = useState<FeeHead | null>(null);
  const [creating, setCreating] = useState(false);
  const archive = useConfirm<FeeHead>();

  // Rendering the manage controls behind the permission is a usability rule, not a security
  // one — `finance.fees.manage` is re-checked by the API on every one of these routes.
  const canManage = session.can('finance.fees.manage');

  const heads = useQuery({
    queryKey: ['fee-heads', { institutionId, q, type, includeArchived, sort, page }],
    queryFn: () =>
      feesApi.listFeeHeads(institutionId, {
        q: q || undefined,
        type: type || undefined,
        includeArchived: includeArchived || undefined,
        sort,
        page,
        pageSize: PAGE_SIZE,
      }),
    placeholderData: keepPreviousData,
  });

  const archiveHead = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      feesApi.archiveFeeHead(institutionId, id, reason),
    onSuccess: (head) => {
      void queryClient.invalidateQueries({ queryKey: ['fee-heads'] });
      toast.success('Fee head archived', head.nameEn);
    },
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
          label: 'Search fee heads by name or code',
        }}
        filters={[
          {
            id: 'type',
            label: 'Fee type',
            value: type,
            onChange: (value) => {
              setType(value);
              resetPage();
            },
            options: TYPE_OPTIONS,
            placeholder: 'All types',
          },
          {
            id: 'archived',
            label: 'Archived fee heads',
            value: includeArchived,
            onChange: (value) => {
              setIncludeArchived(value);
              resetPage();
            },
            options: ARCHIVED_OPTIONS,
            placeholder: 'Active only',
          },
        ]}
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              New fee head
            </Button>
          ) : null
        }
        onReset={() => {
          setQ('');
          setType('');
          setIncludeArchived('');
          resetPage();
        }}
      />

      <DataTable<FeeHead>
        caption={`Fee heads, page ${heads.data?.meta.page ?? 1} of ${heads.data?.meta.totalPages ?? 1}`}
        rows={heads.data?.data ?? []}
        rowKey={(row) => row.id}
        sort={sort}
        onSortChange={(value) => {
          setSort(value);
          resetPage();
        }}
        isLoading={heads.isLoading}
        isFetching={heads.isFetching}
        error={heads.error}
        minWidth="46rem"
        empty={{
          title: q || type ? 'No fee heads match those filters' : 'No fee heads yet',
          description: canManage
            ? 'Create a fee head for each charge the school raises — tuition, transport, exam fees.'
            : 'A colleague with permission to maintain fees will set these up.',
        }}
        actions={
          canManage
            ? (row) =>
                row.archivedAt ? null : (
                  <div className="flex items-center gap-1">
                    <IconButton
                      label={`Edit ${row.nameEn}`}
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditing(row)}
                      icon={<IconPencil />}
                    />
                    <IconButton
                      label={`Archive ${row.nameEn}`}
                      size="sm"
                      variant="ghost"
                      onClick={() => archive.ask(row)}
                      icon={<IconArchive />}
                    />
                  </div>
                )
            : undefined
        }
        columns={[
          {
            id: 'code',
            header: 'Code',
            sortField: 'code',
            className: 'font-mono text-xs',
            card: 'subtitle',
            render: (row) => row.code,
          },
          {
            id: 'name',
            header: 'Name',
            sortField: 'nameEn',
            card: 'title',
            render: (row) => <BilingualName row={row} />,
          },
          {
            id: 'type',
            header: 'Type',
            sortField: 'type',
            card: 'meta',
            render: (row) => <Badge>{humanize(row.type)}</Badge>,
          },
          {
            id: 'billing',
            header: 'Billing',
            card: 'row',
            render: (row) => (
              <span className="text-content-muted">
                {row.isRecurring ? 'Every period' : 'One time'}
                {row.isRefundable ? '' : ' · non-refundable'}
              </span>
            ),
          },
          {
            id: 'ledger',
            header: 'Ledger code',
            hideBelow: 'lg',
            card: 'hidden',
            className: 'font-mono text-xs text-content-muted',
            render: (row) => row.ledgerAccountCode ?? '—',
          },
          {
            id: 'state',
            header: 'State',
            card: 'aside',
            render: (row) =>
              row.archivedAt ? <Badge tone="danger">Archived</Badge> : <Badge tone="success">Active</Badge>,
          },
        ]}
      />

      <Pagination
        meta={heads.data?.meta}
        onPageChange={setPage}
        isFetching={heads.isFetching}
        itemNoun="fee head"
      />

      {canManage ? (
        <>
          <FeeHeadDialog
            open={creating}
            onClose={() => setCreating(false)}
            institutionId={institutionId}
          />
          <FeeHeadDialog
            open={editing !== null}
            onClose={() => setEditing(null)}
            institutionId={institutionId}
            head={editing}
          />
          <ConfirmDialog
            open={archive.isOpen}
            onClose={archive.close}
            title={`Archive ${archive.target?.nameEn ?? 'this fee head'}?`}
            body="Archiving hides the head from new fee plans. Invoices already raised against it are untouched, and it can be shown again with the “Including archived” filter."
            confirmLabel="Archive fee head"
            requireReason
            onConfirm={async (reason) => {
              await archiveHead.mutateAsync({ id: archive.target!.id, reason });
            }}
          />
        </>
      ) : null}
    </>
  );
}

function IconPencil() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-4 w-4" aria-hidden="true">
      <path d="M4 20h4l10-10-4-4L4 16v4Z" strokeLinejoin="round" />
      <path d="m14 6 4 4" />
    </svg>
  );
}

function IconArchive() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-4 w-4" aria-hidden="true">
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />
    </svg>
  );
}
