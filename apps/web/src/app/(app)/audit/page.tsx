'use client';

/**
 * Audit trail.
 *
 * Reads the tenant's own audit log. The endpoint is gated on `audit.view`, so this page is only
 * reachable by roles that hold it — but the navigation entry is also hidden, because offering a
 * link that returns 403 is a worse experience than not offering it.
 *
 * Before/after values are shown as formatted JSON rather than a prose diff. A diff would need
 * to know every entity's shape, and getting it subtly wrong in an audit view is worse than
 * showing the raw truth.
 */

import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api';
import { EmptyState } from '@/components/empty-state';
import { ErrorNotice } from '@/components/error-notice';

interface AuditRow {
  id: string;
  action: string;
  module: string;
  resourceType: string;
  resourceId: string | null;
  resourceLabel: string | null;
  actorEmail: string | null;
  actorRoles: string[];
  reason: string | null;
  previousValue: unknown;
  newValue: unknown;
  occurredAt: string;
  requestId: string | null;
}

export default function AuditPage() {
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);

  const logs = useQuery({
    queryKey: ['audit-logs', page],
    queryFn: () =>
      apiRequest<{
        data: AuditRow[];
        meta: {
          page: number;
          totalPages: number;
          total: number;
          hasNext: boolean;
          hasPrevious: boolean;
        };
      }>('/audit-logs', { query: { page, pageSize: 25 } }),
    placeholderData: keepPreviousData,
  });

  const rows = logs.data?.data ?? [];
  const meta = logs.data?.meta;

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-5">
        <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
        <p className="mt-1 text-sm text-content-muted">
          Every recorded action, in order. Entries cannot be edited or removed.
        </p>
      </header>

      {logs.isError ? <ErrorNotice error={logs.error} /> : null}

      {logs.isLoading ? (
        <div className="card h-64 animate-pulse" aria-busy="true" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No audited actions yet"
          description="Sensitive actions such as creating a student, correcting attendance or collecting a payment appear here as they happen."
        />
      ) : (
        <>
          <ul className="space-y-2">
            {rows.map((row) => (
              <li key={row.id} className="card">
                <button
                  type="button"
                  className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left"
                  onClick={() => setExpanded(expanded === row.id ? null : row.id)}
                  aria-expanded={expanded === row.id}
                >
                  <div className="min-w-0">
                    <p className="text-base">
                      <span className="font-medium">{humanizeAction(row.action)}</span>
                      <span className="text-content-muted">
                        {' '}
                        · {row.resourceType.replace(/_/g, ' ')}
                      </span>
                    </p>
                    <p className="mt-0.5 truncate text-sm text-content-muted">
                      {row.actorEmail ?? 'System'}
                      {row.actorRoles.length > 0 ? ` (${row.actorRoles.join(', ')})` : ''}
                    </p>
                    {row.reason ? (
                      <p className="mt-1 text-sm italic text-content-muted">“{row.reason}”</p>
                    ) : null}
                  </div>
                  <time
                    dateTime={row.occurredAt}
                    className="shrink-0 text-xs tabular-nums text-content-subtle"
                  >
                    {formatInstant(row.occurredAt)}
                  </time>
                </button>

                {expanded === row.id ? (
                  <div className="border-t border-line bg-surface-muted px-4 py-3 text-xs">
                    <dl className="grid gap-2 sm:grid-cols-2">
                      <div>
                        <dt className="text-content-subtle">Module</dt>
                        <dd className="font-mono">{row.module}</dd>
                      </div>
                      <div>
                        <dt className="text-content-subtle">Resource ID</dt>
                        <dd className="break-all font-mono">{row.resourceId ?? '—'}</dd>
                      </div>
                      <div className="sm:col-span-2">
                        <dt className="text-content-subtle">Request ID</dt>
                        <dd className="break-all font-mono">{row.requestId ?? '—'}</dd>
                      </div>
                    </dl>
                    {row.previousValue ? (
                      <JsonBlock label="Before" value={row.previousValue} />
                    ) : null}
                    {row.newValue ? <JsonBlock label="After" value={row.newValue} /> : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>

          {meta && meta.totalPages > 1 ? (
            <nav aria-label="Pagination" className="mt-4 flex items-center justify-between text-sm">
              <p className="text-content-muted">
                Page {meta.page} of {meta.totalPages} · {meta.total.toLocaleString('en-IN')} entries
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={!meta.hasPrevious}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={!meta.hasNext}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </nav>
          ) : null}
        </>
      )}
    </div>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="mt-3">
      <p className="mb-1 text-content-subtle">{label}</p>
      <pre className="overflow-x-auto rounded border border-line bg-surface p-2 font-mono text-[11px] leading-relaxed">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function humanizeAction(action: string): string {
  return action.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/** Audit timestamps are instants, so they are rendered in Dhaka local time explicitly. */
function formatInstant(value: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Dhaka',
  }).format(new Date(value));
}
