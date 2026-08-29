'use client';

/**
 * The workflow inbox: everything routed for a human decision, in one queue.
 *
 * The screen is generic because the engine is. A request carries an `entityType`, a `summary`
 * and an opaque `payload`; nothing here knows what a leave request or an expense claim is, and
 * nothing should — a per-module branch would quietly stop covering the next module that starts
 * routing work through the engine.
 *
 * The four views are the API's own, not client-side filters:
 *
 *  - **Awaiting me** (`view=awaiting`) is computed server-side by running the real eligibility
 *    check — initiator exclusion, four-eyes, step permission, delegations — over each open
 *    request. That is what makes "a user is never shown an item they cannot decide" true here
 *    rather than merely intended.
 *  - **My requests** (`view=mine`) is what I raised, so I can see where it is stuck.
 *  - **Everything** (`view=all`) and **Overdue** need `workflows.view`; the tabs are not
 *    rendered without it. The API refuses them regardless — this is the usability half.
 *
 * Tabs use `activation="manual"` and unmount their inactive panels, so switching views does not
 * fire four list queries at once.
 */

import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useSession } from '@/lib/session';
import { formatCount, formatInstant, formatRelative, humanize } from '@/lib/format';
import {
  Badge,
  DataTable,
  FilterBar,
  PageHeader,
  Pagination,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  toneForStatus,
  type DataTableColumn,
} from '@/components/ui';
import {
  workflowApi,
  type WorkflowRequest,
  type ListRequestsQuery,
} from '@/components/workflow/api';

const PAGE_SIZE = 25;

type View = ListRequestsQuery['view'] | 'overdue';

const STATUS_OPTIONS = [
  { value: 'pending', label: 'Pending' },
  { value: 'sent_back', label: 'Sent back' },
  { value: 'escalated', label: 'Escalated' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'cancelled', label: 'Cancelled' },
];

export default function ApprovalsPage() {
  const session = useSession();

  // `workflows.act` is what makes a queue of decisions meaningful; `workflows.view` is the
  // oversight permission. Neither is a security check — the API re-checks every request — but
  // rendering a tab whose every query 403s is a worse answer than not offering it.
  const canAct = session.can('workflows.act');
  const canOversee = session.can('workflows.view');

  const [view, setView] = useState<View>(canAct ? 'awaiting' : 'mine');

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Approvals"
        description="Requests routed to a person for a decision — admissions, corrections, leave, payroll, expenses. One queue, whatever raised it."
      />

      <Tabs value={view} onValueChange={(value) => setView(value as View)} activation="manual">
        <TabList label="Approval queues" className="mb-4">
          {canAct ? <Tab value="awaiting">Awaiting me</Tab> : null}
          <Tab value="mine">My requests</Tab>
          {canOversee ? <Tab value="all">Everything</Tab> : null}
          {canOversee ? <Tab value="overdue">Overdue</Tab> : null}
        </TabList>

        {canAct ? (
          <TabPanel value="awaiting">
            <RequestQueue
              view="awaiting"
              caption="Requests awaiting my decision"
              emptyTitle="Nothing is waiting on you"
              emptyDescription="Requests appear here only while you are an eligible approver for their current step."
            />
          </TabPanel>
        ) : null}

        <TabPanel value="mine">
          <RequestQueue
            view="mine"
            caption="Requests I raised"
            emptyTitle="You have not raised any requests"
            emptyDescription="Requests you start from other screens — a leave application, an expense claim — are tracked here."
          />
        </TabPanel>

        {canOversee ? (
          <TabPanel value="all">
            <RequestQueue
              view="all"
              caption="All workflow requests"
              emptyTitle="No requests match"
              emptyDescription="Nothing has been routed for approval in this institution yet, or nothing matches your filters."
            />
          </TabPanel>
        ) : null}

        {canOversee ? (
          <TabPanel value="overdue">
            <OverdueQueue />
          </TabPanel>
        ) : null}
      </Tabs>
    </div>
  );
}

/** Shared columns. `rowHref` wraps the `title` column, so its render returns plain content. */
function requestColumns(now: Date): DataTableColumn<WorkflowRequest>[] {
  return [
    {
      id: 'summary',
      header: 'Request',
      card: 'title',
      render: (row) => <span className="font-medium">{row.summary}</span>,
    },
    {
      id: 'entityType',
      header: 'Kind',
      card: 'subtitle',
      render: (row) => <span className="text-content-muted">{humanize(row.entityType)}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      card: 'aside',
      sortField: 'status',
      render: (row) => <Badge tone={toneForStatus(row.status)}>{humanize(row.status)}</Badge>,
    },
    {
      id: 'step',
      header: 'Step',
      card: 'meta',
      hideBelow: 'md',
      render: (row) => (
        <span className="tabular-nums text-content-muted">{row.currentStepSequence}</span>
      ),
    },
    {
      id: 'initiatedAt',
      header: 'Raised',
      card: 'meta',
      sortField: 'initiatedAt',
      render: (row) => (
        <span className="text-content-muted" title={formatInstant(row.initiatedAt)}>
          {formatRelative(row.initiatedAt, now)}
        </span>
      ),
    },
    {
      id: 'dueAt',
      header: 'Due',
      card: 'meta',
      sortField: 'dueAt',
      render: (row) => <DueCell dueAt={row.dueAt} now={now} />,
    },
  ];
}

/** The SLA cell. Overdue is a fact about the clock, so it is computed, never guessed at. */
function DueCell({ dueAt, now }: { dueAt: string | null; now: Date }) {
  if (!dueAt) return <span className="text-content-subtle">No SLA</span>;
  const overdue = new Date(dueAt).getTime() < now.getTime();
  return (
    <span
      className={overdue ? 'font-medium text-danger' : 'text-content-muted'}
      title={formatInstant(dueAt)}
    >
      {overdue ? 'Overdue ' : ''}
      {formatRelative(dueAt, now)}
    </span>
  );
}

function RequestQueue({
  view,
  caption,
  emptyTitle,
  emptyDescription,
}: {
  view: ListRequestsQuery['view'];
  caption: string;
  emptyTitle: string;
  emptyDescription: string;
}) {
  const session = useSession();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState<string | undefined>();
  const [page, setPage] = useState(1);

  const requests = useQuery({
    queryKey: ['workflow-requests', { view, q, status, sort, page, institutionId: session.institutionId }],
    queryFn: () =>
      workflowApi.requests(session.institutionId, {
        page,
        pageSize: PAGE_SIZE,
        view,
        q: q || undefined,
        status: status || undefined,
        sort,
      }),
    placeholderData: keepPreviousData,
  });

  // One `now` per render so every row in a table compares against the same instant — two rows
  // computed a millisecond apart could otherwise disagree about which side of a deadline
  // they fall on.
  const now = new Date();

  return (
    <>
      <FilterBar
        className="mb-4"
        search={{
          value: q,
          onChange: (value) => {
            setQ(value);
            setPage(1);
          },
          label: 'Search requests by summary',
          placeholder: 'Search by summary',
        }}
        filters={[
          {
            id: 'status',
            label: 'Status',
            value: status,
            onChange: (value) => {
              setStatus(value);
              setPage(1);
            },
            options: STATUS_OPTIONS,
            placeholder: 'Any status',
          },
        ]}
        onReset={
          q || status
            ? () => {
                setQ('');
                setStatus('');
                setPage(1);
              }
            : undefined
        }
      />

      <DataTable
        caption={caption}
        rows={requests.data?.data ?? []}
        rowKey={(row) => row.id}
        rowHref={(row) => `/approvals/${row.id}`}
        columns={requestColumns(now)}
        sort={sort}
        onSortChange={(value) => {
          setSort(value);
          setPage(1);
        }}
        isLoading={requests.isLoading}
        isFetching={requests.isFetching}
        error={requests.error}
        empty={{ title: emptyTitle, description: emptyDescription }}
        minWidth="52rem"
      />

      <Pagination
        className="mt-4"
        meta={requests.data?.meta}
        onPageChange={setPage}
        isFetching={requests.isFetching}
        itemNoun="request"
      />
    </>
  );
}

/** The SLA backlog. A separate endpoint, so a separate query — not a filter over the list. */
function OverdueQueue() {
  const session = useSession();
  const [page, setPage] = useState(1);

  const overdue = useQuery({
    queryKey: ['workflow-overdue', { page, institutionId: session.institutionId }],
    queryFn: () => workflowApi.overdue(session.institutionId, { page, pageSize: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });

  const now = new Date();
  const meta = overdue.data?.meta;

  return (
    <>
      {meta ? (
        <p className="mb-4 text-sm text-content-muted" aria-live="polite">
          {formatCount(meta.total, 'request')} past the service-level deadline of the step they
          are sitting at.
        </p>
      ) : null}

      <DataTable
        caption="Requests past their SLA deadline"
        rows={overdue.data?.data ?? []}
        rowKey={(row) => row.id}
        rowHref={(row) => `/approvals/${row.id}`}
        columns={requestColumns(now)}
        isLoading={overdue.isLoading}
        isFetching={overdue.isFetching}
        error={overdue.error}
        empty={{
          title: 'Nothing is overdue',
          description: 'Every open request is still inside the SLA of the step it is at.',
        }}
        minWidth="52rem"
      />

      <Pagination
        className="mt-4"
        meta={meta}
        onPageChange={setPage}
        isFetching={overdue.isFetching}
        itemNoun="request"
      />
    </>
  );
}
