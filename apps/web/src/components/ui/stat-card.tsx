/**
 * Stat cards.
 *
 * `StatCard` is **not** reimplemented here — it is re-exported from `@/components/stat-card`,
 * which the dashboard already imports. Moving the file would have meant editing the dashboard,
 * which another agent owns in this batch, and copying it would have left two components with
 * the same name drifting apart. A re-export gives screens the single `@/components/ui` import
 * without either problem.
 *
 * `MetricCard` is a genuinely different contract, not a duplicate: `StatCard` takes a `number`
 * and groups it with `toLocaleString('en-IN')`, which is exactly wrong for money. Money is a
 * decimal string that must never be parsed into a float (ADR-004), so anything monetary is
 * formatted by `formatMoney` at the call site and handed here as an already-formatted string.
 */

import Link from 'next/link';
import { cn } from '@/lib/cn';
import { Skeleton } from './skeleton';

export { StatCard } from '@/components/stat-card';

export function MetricCard({
  label,
  /** Already formatted for display. `null` means loading — see the note below. */
  value,
  detail,
  href,
  tone = 'default',
  className,
}: {
  label: string;
  value: string | null;
  detail?: React.ReactNode;
  href?: string;
  /** Tints the figure. Use sparingly: an overdue balance, a failed run. */
  tone?: 'default' | 'success' | 'warning' | 'danger';
  className?: string;
}) {
  const content = (
    <>
      <p className="text-sm text-content-muted">{label}</p>
      {value === null ? (
        // `null` is loading, not zero. Rendering "৳0.00" while the request is in flight tells a
        // bursar the school has collected nothing today, which is alarming and wrong.
        <Skeleton className="mt-1.5 h-8 w-28" />
      ) : (
        <p
          className={cn(
            'mt-1 text-2xl font-semibold tabular-nums tracking-tight',
            tone === 'success' && 'text-success',
            tone === 'warning' && 'text-warning',
            tone === 'danger' && 'text-danger',
          )}
        >
          {value}
        </p>
      )}
      {detail ? <div className="mt-1 text-xs text-content-subtle">{detail}</div> : null}
    </>
  );

  if (href) {
    return (
      <Link href={href} className={cn('card p-4 transition-shadow hover:shadow-popover', className)}>
        {content}
      </Link>
    );
  }
  return <div className={cn('card p-4', className)}>{content}</div>;
}

/** A responsive row of stat cards. Two up on a phone, four on a desktop. */
export function StatGrid({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('grid grid-cols-2 gap-3 lg:grid-cols-4', className)}>{children}</div>
  );
}
