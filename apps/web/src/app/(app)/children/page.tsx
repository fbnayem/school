'use client';

/**
 * Parent portal.
 *
 * There is no id in the URL and no filter to tamper with: the API derives the list entirely
 * from the signed-in guardian's links. That is what makes this the safest screen in the
 * product, and it is worth preserving — adding a `?studentId=` parameter here would reintroduce
 * exactly the class of bug the design avoids.
 */

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { EmptyState } from '@/components/empty-state';
import { ErrorNotice } from '@/components/error-notice';
import { StatusBadge } from '@/components/status-badge';

export default function ChildrenPage() {
  const children = useQuery({ queryKey: ['my-children'], queryFn: api.myChildren });

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-5 text-2xl font-semibold tracking-tight">My children</h1>

      {children.isError ? <ErrorNotice error={children.error} /> : null}

      {children.isLoading ? (
        <div className="card h-32 animate-pulse" aria-busy="true" aria-label="Loading" />
      ) : children.data && children.data.length > 0 ? (
        <ul className="space-y-3">
          {children.data.map((child) => (
            <li key={child.studentId} className="card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">{child.fullNameEn}</p>
                  {child.fullNameBn ? (
                    <p lang="bn" className="text-sm text-content-muted">
                      {child.fullNameBn}
                    </p>
                  ) : null}
                  <p className="mt-1 font-mono text-xs text-content-subtle">{child.studentCode}</p>
                </div>
                <StatusBadge status={child.status} />
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                <span className="badge bg-surface-muted text-content-muted">
                  You are the {child.relation.replace(/_/g, ' ')}
                </span>
                {child.isPrimary ? (
                  <span className="badge bg-accent-50 text-accent-800">Primary contact</span>
                ) : null}
                {child.isBillingContact ? (
                  <span className="badge bg-info-subtle text-info">Billing contact</span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          title="No children linked to your account"
          description="Contact the school office to have your account linked to your child's record."
        />
      )}
    </div>
  );
}
