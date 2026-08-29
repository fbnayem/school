'use client';

/**
 * The chart of accounts.
 *
 * `isSystem` accounts — the fees cash account, the payroll salary expense — are maintained by
 * other modules and the API refuses to archive them while anything depends on them. The archive
 * control is therefore not offered on those rows: the refusal is the API's job, but making the
 * user discover it by pressing a button is not.
 */

import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { COA_ACCOUNT_TYPES } from '@shikkha/validation';
import { useSession } from '@/lib/session';
import {
  Badge,
  BilingualName,
  Button,
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
import { accountingApi, type Account } from './accounting-api';
import { AccountDialog } from './account-dialog';

const PAGE_SIZE = 25;

const TYPE_OPTIONS: SelectOption[] = COA_ACCOUNT_TYPES.map((type) => ({
  value: type,
  label: humanize(type),
}));

const POSTABLE_OPTIONS: SelectOption[] = [{ value: 'true', label: 'Postable accounts only' }];
const ARCHIVED_OPTIONS: SelectOption[] = [{ value: 'true', label: 'Including archived' }];

export function ChartOfAccounts({ institutionId }: { institutionId: string }) {
  const session = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [postableOnly, setPostableOnly] = useState('');
  const [includeArchived, setIncludeArchived] = useState('');
  const [sort, setSort] = useState<string | undefined>();
  const [page, setPage] = useState(1);

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const archive = useConfirm<Account>();

  // Usability, not security: `accounting.coa.manage` is re-checked by the API on every write.
  const canManage = session.can('accounting.coa.manage');

  const accounts = useQuery({
    queryKey: ['accounts', { institutionId, q, type, postableOnly, includeArchived, sort, page }],
    queryFn: () =>
      accountingApi.listAccounts(institutionId, {
        q: q || undefined,
        type: type || undefined,
        // `z.coerce.boolean()` on the API makes any non-empty string true, so "off" is the
        // absent parameter rather than the string 'false'.
        postableOnly: postableOnly || undefined,
        includeArchived: includeArchived || undefined,
        sort,
        page,
        pageSize: PAGE_SIZE,
      }),
    placeholderData: keepPreviousData,
  });

  // Parent candidates for the create/edit dialog. Headers only, and one request rather than a
  // second paginated picker inside the dialog.
  const headers = useQuery({
    queryKey: ['accounts', 'headers', institutionId],
    queryFn: () => accountingApi.listAccounts(institutionId, { pageSize: 200, sort: 'code' }),
    enabled: canManage,
    staleTime: 5 * 60_000,
  });

  const archiveAccount = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      accountingApi.archiveAccount(institutionId, id, reason),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      toast.success('Account archived', `${saved.code} — ${saved.nameEn}`);
    },
  });

  const headerAccounts = (headers.data?.data ?? []).filter(
    (account) => !account.isPostable && account.archivedAt === null,
  );

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
          label: 'Search accounts by name or code',
        }}
        filters={[
          {
            id: 'type',
            label: 'Account type',
            value: type,
            onChange: (value) => {
              setType(value);
              resetPage();
            },
            options: TYPE_OPTIONS,
            placeholder: 'All types',
          },
          {
            id: 'postable',
            label: 'Postable accounts',
            value: postableOnly,
            onChange: (value) => {
              setPostableOnly(value);
              resetPage();
            },
            options: POSTABLE_OPTIONS,
            placeholder: 'Headers and leaves',
          },
          {
            id: 'archived',
            label: 'Archived accounts',
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
              New account
            </Button>
          ) : null
        }
        onReset={() => {
          setQ('');
          setType('');
          setPostableOnly('');
          setIncludeArchived('');
          resetPage();
        }}
      />

      <DataTable<Account>
        caption={`Chart of accounts, page ${accounts.data?.meta.page ?? 1} of ${accounts.data?.meta.totalPages ?? 1}`}
        rows={accounts.data?.data ?? []}
        rowKey={(row) => row.id}
        sort={sort}
        onSortChange={(value) => {
          setSort(value);
          resetPage();
        }}
        isLoading={accounts.isLoading}
        isFetching={accounts.isFetching}
        error={accounts.error}
        minWidth="48rem"
        empty={{
          title: q || type ? 'No accounts match those filters' : 'The chart is empty',
          description: canManage
            ? 'Open the accounts the school needs. Headers group and subtotal; leaves take the postings.'
            : 'A colleague who maintains the chart will set the accounts up.',
        }}
        actions={
          canManage
            ? (row) =>
                row.archivedAt ? null : (
                  <div className="flex items-center gap-1">
                    <IconButton
                      label={`Edit ${row.code} ${row.nameEn}`}
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditing(row)}
                      icon={<IconPencil />}
                    />
                    {row.isSystem ? null : (
                      <IconButton
                        label={`Archive ${row.code} ${row.nameEn}`}
                        size="sm"
                        variant="ghost"
                        onClick={() => archive.ask(row)}
                        icon={<IconArchive />}
                      />
                    )}
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
            header: 'Account',
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
            id: 'normalBalance',
            header: 'Normal balance',
            hideBelow: 'md',
            card: 'row',
            render: (row) => humanize(row.normalBalance),
          },
          {
            id: 'role',
            header: 'Role',
            card: 'row',
            render: (row) => (
              <span className="flex flex-wrap gap-1">
                <Badge tone={row.isPostable ? 'accent' : 'neutral'}>
                  {row.isPostable ? 'Postable' : 'Header'}
                </Badge>
                {row.isCashEquivalent ? <Badge tone="info">Cash</Badge> : null}
                {row.isSystem ? <Badge tone="warning">System</Badge> : null}
              </span>
            ),
          },
          {
            id: 'state',
            header: 'State',
            card: 'aside',
            render: (row) =>
              row.archivedAt ? (
                <Badge tone="danger">Archived</Badge>
              ) : (
                <Badge tone="success">Active</Badge>
              ),
          },
        ]}
      />

      <Pagination
        meta={accounts.data?.meta}
        onPageChange={setPage}
        isFetching={accounts.isFetching}
        itemNoun="account"
      />

      {canManage ? (
        <>
          <AccountDialog
            open={creating}
            onClose={() => setCreating(false)}
            institutionId={institutionId}
            headerAccounts={headerAccounts}
          />
          <AccountDialog
            open={editing !== null}
            onClose={() => setEditing(null)}
            institutionId={institutionId}
            account={editing}
            headerAccounts={headerAccounts}
          />
          <ConfirmDialog
            open={archive.isOpen}
            onClose={archive.close}
            title={`Archive ${archive.target?.code ?? ''} ${archive.target?.nameEn ?? ''}?`}
            body="Archiving retires the account from new postings. Entries already posted to it, and every report built on them, are unchanged."
            confirmLabel="Archive account"
            requireReason
            onConfirm={async (reason) => {
              await archiveAccount.mutateAsync({ id: archive.target!.id, reason });
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
