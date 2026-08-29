'use client';

/**
 * Layout for the accounting area.
 *
 * Mirrors the fees layout: mount `ToastProvider` (the root layout is another agent's file this
 * batch, and `useToast` throws without a provider), and refuse to render the ledger until an
 * institution is chosen. A set of books belongs to exactly one institution — showing a trial
 * balance without knowing whose it is would be worse than showing nothing.
 */

import { useSession } from '@/lib/session';
import { EmptyState, ToastProvider } from '@/components/ui';

export default function AccountingLayout({ children }: { children: React.ReactNode }) {
  const session = useSession();

  if (!session.institutionId) {
    return (
      <div className="mx-auto max-w-2xl">
        <EmptyState
          title="Choose an institution first"
          description="A set of books belongs to one institution. Pick the institution you are working in and the ledger will load."
        />
      </div>
    );
  }

  return <ToastProvider>{children}</ToastProvider>;
}
