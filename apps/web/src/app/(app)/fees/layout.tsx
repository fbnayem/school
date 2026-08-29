'use client';

/**
 * Layout for the fees area.
 *
 * Two things happen here so that no fee screen has to repeat them.
 *
 *  1. **`ToastProvider` is mounted.** `useToast` throws without one, and the root layout is
 *     owned elsewhere in this batch. Mounting it per-area is not a workaround: a toast is
 *     scoped to the work the user is doing, and an area-level provider unmounts its queue when
 *     they leave, which is the behaviour we want anyway.
 *  2. **The institution scope is asserted once.** Every `/fees` route is `@InstitutionScoped()`
 *     on the API and 400s without the `x-institution-id` header. A group administrator running
 *     three schools has no safe default, so rather than guessing we say so and stop — the
 *     alternative is four screens each showing their own "Bad Request" for the same reason.
 */

import { useSession } from '@/lib/session';
import { EmptyState, ToastProvider } from '@/components/ui';

export default function FeesLayout({ children }: { children: React.ReactNode }) {
  const session = useSession();

  if (!session.institutionId) {
    return (
      <div className="mx-auto max-w-2xl">
        <EmptyState
          title="Choose an institution first"
          description="Fees, invoices and payments belong to one school. Pick the institution you are working in and this area will load."
        />
      </div>
    );
  }

  return <ToastProvider>{children}</ToastProvider>;
}
