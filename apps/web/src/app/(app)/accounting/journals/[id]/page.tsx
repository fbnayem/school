'use client';

/**
 * One journal entry.
 *
 * The immutability rule is the shape of this screen. A **posted** entry cannot be edited — not
 * by this UI, not by the service, and not by raw SQL, because the database refuses an insert,
 * update or delete against a posted entry's lines. So no edit control is rendered for one, and
 * the panel says why: the correction is a mirrored reversing entry, which leaves both the
 * original and the correction visible to an auditor. Offering an edit that would 409 would be
 * teaching the user something false about how the ledger works.
 *
 * Posting is likewise a different permission from drafting, and the service refuses a poster who
 * is also the drafter even when one person holds both. The dialog says so before it is used, so
 * the refusal is understood as a control rather than met as a bug.
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
  PageHeader,
  SkeletonCard,
  formatMoney,
  toneForStatus,
  useToast,
} from '@/components/ui';
import { formatDate, formatInstant, humanize } from '@/lib/format';
import {
  accountingApi,
  type JournalEntryLine,
} from '@/components/accounting/accounting-api';
import { EditJournalEntryForm } from '@/components/accounting/journal-entry-forms';

export default function JournalEntryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const session = useSession();
  const institutionId = session.institutionId!;
  const toast = useToast();
  const queryClient = useQueryClient();

  const [posting, setPosting] = useState(false);
  const [reversing, setReversing] = useState(false);
  const [editing, setEditing] = useState(false);

  const canSeeChart = session.can('accounting.coa.view');

  const entry = useQuery({
    queryKey: ['journal-entry', id],
    queryFn: () => accountingApi.getJournalEntry(institutionId, id),
  });

  // Only fetched when the edit form can actually be opened — a read-only viewer has no use for
  // two hundred accounts.
  const canEditDrafts = session.can('accounting.journal.create') && canSeeChart;
  const accounts = useQuery({
    queryKey: ['accounts', 'postable', institutionId],
    queryFn: () =>
      accountingApi.listAccounts(institutionId, {
        postableOnly: 'true',
        pageSize: 200,
        sort: 'code',
      }),
    enabled: canEditDrafts && editing,
    staleTime: 5 * 60_000,
  });
  const costCentres = useQuery({
    queryKey: ['cost-centres', institutionId],
    queryFn: () => accountingApi.listCostCentres(institutionId, { pageSize: 200, sort: 'code' }),
    enabled: canEditDrafts && editing,
    staleTime: 5 * 60_000,
  });

  const post = useMutation({
    mutationFn: (version: number) => accountingApi.postJournalEntry(institutionId, id, version),
    onSuccess: (posted) => {
      void queryClient.invalidateQueries({ queryKey: ['journal-entry', id] });
      void queryClient.invalidateQueries({ queryKey: ['journal-entries'] });
      void queryClient.invalidateQueries({ queryKey: ['trial-balance'] });
      void queryClient.invalidateQueries({ queryKey: ['general-ledger'] });
      toast.success('Entry posted', `${posted.entryNumber} is now immutable.`);
    },
  });

  const reverse = useMutation({
    mutationFn: ({ reason, version }: { reason: string; version: number }) =>
      accountingApi.reverseJournalEntry(institutionId, id, { reason, version }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['journal-entry', id] });
      void queryClient.invalidateQueries({ queryKey: ['journal-entries'] });
      void queryClient.invalidateQueries({ queryKey: ['trial-balance'] });
      void queryClient.invalidateQueries({ queryKey: ['general-ledger'] });
      toast.success(
        'Entry reversed',
        `${result.reversal.entryNumber} mirrors ${result.original.entryNumber}.`,
      );
    },
  });

  if (entry.isError) {
    return (
      <div className="mx-auto max-w-4xl">
        <ErrorNotice error={entry.error} />
        <Button href="/accounting/journals" className="mt-4">
          Back to the journal
        </Button>
      </div>
    );
  }

  if (entry.isLoading || !entry.data) {
    return (
      <div className="mx-auto max-w-4xl">
        <SkeletonCard lines={8} label="Loading journal entry" />
      </div>
    );
  }

  const row = entry.data;
  const isDraft = row.status === 'draft';
  const isPosted = row.status === 'posted';

  // A system-generated entry belongs to the module that produced it — fees, payroll — and the
  // service refuses a manual edit outright, so no edit control is offered for one.
  const showEdit = isDraft && !row.isSystemGenerated && canEditDrafts;
  const showPost = isDraft && session.can('accounting.journal.post');
  const showReverse = isPosted && session.can('accounting.journal.reverse');

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        breadcrumbs={[
          { label: 'Accounting', href: '/accounting' },
          { label: 'Journal', href: '/accounting/journals' },
          { label: row.entryNumber },
        ]}
        title={row.entryNumber}
        description={row.description}
        meta={
          <>
            <Badge tone={toneForStatus(row.status)}>{humanize(row.status)}</Badge>
            <span>{formatDate(row.entryDate)}</span>
            <span>{humanize(row.sourceModule)}</span>
            {row.isSystemGenerated ? <Badge tone="info">Automatic</Badge> : null}
          </>
        }
        actions={
          <>
            {showEdit && !editing ? (
              <Button onClick={() => setEditing(true)}>Edit draft</Button>
            ) : null}
            {showPost ? (
              <Button variant="primary" onClick={() => setPosting(true)}>
                Post entry
              </Button>
            ) : null}
            {showReverse ? (
              <Button variant="danger" onClick={() => setReversing(true)}>
                Reverse entry
              </Button>
            ) : null}
          </>
        }
      />

      {isPosted ? (
        <p className="mb-5 rounded border border-line bg-surface-muted px-4 py-3 text-sm text-content-muted">
          This entry is posted, and a posted entry is immutable — its lines cannot be inserted,
          updated or deleted, and the database enforces that, not just this screen. Correct it
          with a reversing entry: the mirror cancels it account for account, and both documents
          stay on the record.
        </p>
      ) : null}

      {row.status === 'reversed' ? (
        <p className="mb-5 rounded border border-danger/30 bg-danger-subtle px-4 py-3 text-sm text-danger">
          This entry has been reversed. Its effect on every account it touched has been cancelled
          by a mirrored entry.
        </p>
      ) : null}

      <Card className="mb-5">
        <CardHeader title="Entry details" />
        <CardBody>
          <DescriptionList
            items={[
              { label: 'Entry date', value: formatDate(row.entryDate) },
              { label: 'Status', value: humanize(row.status) },
              { label: 'Source module', value: humanize(row.sourceModule) },
              { label: 'Reference', value: row.referenceType ? humanize(row.referenceType) : null },
              { label: 'Posted at', value: row.postedAt ? formatInstant(row.postedAt) : null, emptyText: 'Not posted' },
              {
                label: 'Created',
                value: formatInstant(row.createdAt),
              },
              { label: 'Description', value: row.description, span: true },
            ]}
          />
        </CardBody>
      </Card>

      {editing && showEdit ? (
        <Card padded className="mb-5">
          {accounts.isLoading ? (
            <SkeletonCard lines={6} label="Loading the chart of accounts" />
          ) : (
            <EditJournalEntryForm
              institutionId={institutionId}
              entry={row}
              accounts={accounts.data?.data ?? []}
              costCentres={costCentres.data?.data ?? []}
              onDone={() => setEditing(false)}
            />
          )}
        </Card>
      ) : (
        <section>
          <h2 className="mb-3 text-lg font-semibold tracking-tight">Lines</h2>
          <p className="mb-3 text-sm text-content-muted">
            Each line carries a debit or a credit, never both. The entry balances — total debits
            equal total credits — and the database refuses a commit where they do not.
          </p>
          <DataTable<JournalEntryLine>
            caption={`Lines of journal entry ${row.entryNumber}`}
            rows={row.lines}
            rowKey={(line) => line.id}
            minWidth="42rem"
            empty={{
              title: 'This entry has no lines',
              description:
                'Nothing was recorded against any account. A draft in this state cannot be posted.',
            }}
            columns={[
              {
                id: 'account',
                header: 'Account',
                card: 'title',
                render: (line) => `${line.accountCode} — ${line.accountName}`,
              },
              {
                id: 'description',
                header: 'Note',
                hideBelow: 'md',
                card: 'row',
                render: (line) => (
                  <span className="text-content-muted">{line.description ?? '—'}</span>
                ),
              },
              {
                id: 'debit',
                header: 'Debit',
                align: 'right',
                card: 'row',
                className: 'tabular-nums',
                render: (line) => formatMoney(line.debit),
              },
              {
                id: 'credit',
                header: 'Credit',
                align: 'right',
                card: 'aside',
                className: 'tabular-nums',
                render: (line) => formatMoney(line.credit),
              },
            ]}
          />
        </section>
      )}

      <ConfirmDialog
        open={posting}
        onClose={() => setPosting(false)}
        variant="primary"
        title={`Post ${row.entryNumber}?`}
        confirmLabel="Post entry"
        body={
          <div className="space-y-2">
            <p>
              Posting moves every line onto its account and makes the entry immutable. From then
              on it can only be cancelled by a reversing entry.
            </p>
            <p>
              An entry must be posted by someone other than the person who drafted it. If you
              drafted this one, the API will refuse — that is the control working, not a fault.
            </p>
          </div>
        }
        onConfirm={async () => {
          await post.mutateAsync(row.version);
        }}
      />

      <ConfirmDialog
        open={reversing}
        onClose={() => setReversing(false)}
        title={`Reverse ${row.entryNumber}?`}
        confirmLabel="Reverse entry"
        body="A new entry is created that mirrors this one — every debit becomes a credit and back — so the pair nets to zero on every account. Both stay visible. The reversing entry is dated today and must fall in an open period."
        requireReason
        reasonLabel="Why is this entry being reversed?"
        onConfirm={async (reason) => {
          await reverse.mutateAsync({ reason, version: row.version });
        }}
      />
    </div>
  );
}
