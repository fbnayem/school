'use client';

/**
 * Draft a manual journal entry.
 *
 * It is a **draft**: nothing reaches an account balance until somebody with
 * `accounting.journal.post` posts it, and the API refuses a poster who is also the drafter. So
 * this screen never offers to post what it just created — the separation of duties is the point
 * of the two permissions, and a "save and post" button would be an invitation to look for a way
 * around it.
 */

import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/lib/session';
import { Card, CardBody, CardHeader, EmptyState, PageHeader, SkeletonCard } from '@/components/ui';
import { accountingApi } from '@/components/accounting/accounting-api';
import { CreateJournalEntryForm } from '@/components/accounting/journal-entry-forms';

export default function NewJournalEntryPage() {
  const session = useSession();
  const institutionId = session.institutionId!;

  const canCreate = session.can('accounting.journal.create');
  // Cost centres are an optional dimension. Reading them needs `accounting.coa.view`, which a
  // drafting role may not hold — in which case the line editor simply omits the field rather
  // than showing an empty select nobody can fill.
  const canSeeCostCentres = session.can('accounting.coa.view');

  const accounts = useQuery({
    queryKey: ['accounts', 'postable', institutionId],
    queryFn: () =>
      accountingApi.listAccounts(institutionId, {
        postableOnly: 'true',
        pageSize: 200,
        sort: 'code',
      }),
    enabled: canCreate && canSeeCostCentres,
    staleTime: 5 * 60_000,
  });

  const costCentres = useQuery({
    queryKey: ['cost-centres', institutionId],
    queryFn: () => accountingApi.listCostCentres(institutionId, { pageSize: 200, sort: 'code' }),
    enabled: canCreate && canSeeCostCentres,
    staleTime: 5 * 60_000,
  });

  if (!canCreate) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="Draft a journal entry" />
        <EmptyState
          title="You cannot draft journal entries"
          description="Drafting needs accounting.journal.create. Ask your school administrator to check your role."
        />
      </div>
    );
  }

  if (!canSeeCostCentres) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="Draft a journal entry" />
        <EmptyState
          title="The chart of accounts is not visible to your role"
          description="Every line names an account, and reading the chart needs accounting.coa.view. Ask your school administrator to check your role."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        breadcrumbs={[
          { label: 'Accounting', href: '/accounting' },
          { label: 'Journal', href: '/accounting/journals' },
          { label: 'New entry' },
        ]}
        title="Draft a journal entry"
        description="Saved as a draft. Someone else posts it — the drafter cannot."
      />

      <Card>
        <CardHeader title="Entry" />
        <CardBody>
          {accounts.isLoading ? (
            <SkeletonCard lines={6} label="Loading the chart of accounts" />
          ) : (
            <CreateJournalEntryForm
              institutionId={institutionId}
              accounts={accounts.data?.data ?? []}
              costCentres={costCentres.data?.data ?? []}
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
