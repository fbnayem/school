/**
 * DescriptionList: the label/value grid every detail screen is made of.
 *
 * A real `<dl>`/`<dt>`/`<dd>`, not a grid of divs. That is what lets a screen reader announce
 * "Date of birth, definition, 12 March 2014" instead of two unrelated strings, and it is free.
 *
 * `null`/`undefined`/`''` renders as "Not recorded" rather than an empty cell. An empty cell is
 * ambiguous — the reader cannot tell whether the value is missing or the screen is broken — and
 * for a field like "Allergies" that ambiguity is a safety problem.
 *
 * Server-compatible: no hooks.
 */

import { cn } from '@/lib/cn';

export interface DescriptionItem {
  label: React.ReactNode;
  value: React.ReactNode;
  /** Full width — an address, a note, a reason. */
  span?: boolean;
  /** Overrides "Not recorded" when a blank means something specific ("None", "Unlimited"). */
  emptyText?: string;
}

export function DescriptionList({
  items,
  columns = 2,
  className,
}: {
  items: DescriptionItem[];
  columns?: 1 | 2 | 3;
  className?: string;
}) {
  return (
    <dl
      className={cn(
        'grid gap-x-6 gap-y-3',
        columns === 1 ? '' : columns === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-3',
        className,
      )}
    >
      {items.map((item, index) => (
        <DescriptionItemRow key={index} item={item} />
      ))}
    </dl>
  );
}

function DescriptionItemRow({ item }: { item: DescriptionItem }) {
  const isEmpty =
    item.value === null ||
    item.value === undefined ||
    item.value === '' ||
    item.value === false;

  return (
    <div className={item.span ? 'sm:col-span-full' : undefined}>
      <dt className="text-xs text-content-subtle">{item.label}</dt>
      <dd className="mt-0.5 text-base text-content">
        {isEmpty ? (
          <span className="text-content-subtle">{item.emptyText ?? 'Not recorded'}</span>
        ) : (
          item.value
        )}
      </dd>
    </div>
  );
}
