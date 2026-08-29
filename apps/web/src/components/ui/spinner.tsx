/**
 * Spinner.
 *
 * Purely decorative: `aria-hidden`, no role, no label. Announcing progress is the job of the
 * thing that owns the operation — `Button` renders an `sr-only` status next to it, a page uses
 * `aria-busy` on the region. A spinner that announces itself produces "loading, loading,
 * loading" as three spinners mount, which is worse than silence.
 */

import { cn } from '@/lib/cn';

const SIZE: Record<'xs' | 'sm' | 'md' | 'lg', string> = {
  xs: 'h-3.5 w-3.5 border-[1.5px]',
  sm: 'h-4 w-4 border-2',
  md: 'h-5 w-5 border-2',
  lg: 'h-8 w-8 border-[3px]',
};

export function Spinner({
  size = 'sm',
  className,
}: {
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        // `border-current` inherits the button's text colour, so one spinner works on a filled
        // primary button and on a ghost button without a colour prop.
        'inline-block shrink-0 animate-spin rounded-full border-current border-r-transparent',
        SIZE[size],
        className,
      )}
    />
  );
}

/** A centred spinner for a panel that is loading its first data. */
export function LoadingBlock({ label = 'Loading' }: { label?: string }) {
  return (
    <div
      className="flex items-center justify-center gap-2 px-6 py-12 text-sm text-content-muted"
      aria-busy="true"
      aria-label={label}
    >
      <Spinner size="md" />
      <span>{label}…</span>
    </div>
  );
}
