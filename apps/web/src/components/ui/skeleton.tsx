/**
 * Skeletons.
 *
 * Every skeleton is `aria-hidden` and lives inside a container marked `aria-busy="true"` with a
 * label. A screen reader user does not benefit from twelve announced grey rectangles; they
 * benefit from one "Loading students".
 *
 * Server-compatible: no hooks.
 */

import { cn } from '@/lib/cn';

export function Skeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn('animate-pulse rounded bg-surface-muted', className)} />
  );
}

/** Several lines of placeholder text, last line short, the way a paragraph actually ends. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)} aria-hidden="true">
      {Array.from({ length: lines }).map((_, index) => (
        <Skeleton
          key={index}
          className={cn('h-3.5', index === lines - 1 ? 'w-2/3' : 'w-full')}
        />
      ))}
    </div>
  );
}

/** A card-shaped placeholder for a panel that has not loaded yet. */
export function SkeletonCard({
  lines = 3,
  label = 'Loading',
  className,
}: {
  lines?: number;
  label?: string;
  className?: string;
}) {
  return (
    <div className={cn('card p-4 sm:p-5', className)} aria-busy="true" aria-label={label}>
      <Skeleton className="mb-3 h-4 w-1/3" />
      <SkeletonText lines={lines} />
    </div>
  );
}
