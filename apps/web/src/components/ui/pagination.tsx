'use client';

/**
 * Pagination, driven by the API's `{ page, pageSize, total, totalPages, hasNext, hasPrevious }`.
 *
 * Every number here comes from that meta object. In particular `hasNext`/`hasPrevious` are read
 * rather than derived: the API already knows, and computing `page < totalPages` in the browser
 * is a second implementation that will disagree with the first the day an endpoint caps its
 * total for performance.
 *
 * Page size is offered from a fixed list within the API's `MAX_PAGE_SIZE`, not typed by the
 * user — the API clamps it anyway, and a control that silently ignores what was entered is
 * worse than one that does not offer the choice.
 */

import type { PageMeta } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Button } from './button';

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;

export function Pagination({
  meta,
  onPageChange,
  onPageSizeChange,
  isFetching = false,
  /** What is being counted, for the summary line: "1–25 of 312 students". */
  itemNoun = 'result',
  itemNounPlural,
  className,
}: {
  meta: PageMeta | undefined;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  isFetching?: boolean;
  itemNoun?: string;
  itemNounPlural?: string;
  className?: string;
}) {
  if (!meta) return null;

  // Nothing to page through and no size to change: render nothing rather than a dead control.
  if (meta.totalPages <= 1 && !onPageSizeChange) return null;

  const first = meta.total === 0 ? 0 : (meta.page - 1) * meta.pageSize + 1;
  const last = Math.min(meta.page * meta.pageSize, meta.total);
  const noun = meta.total === 1 ? itemNoun : (itemNounPlural ?? `${itemNoun}s`);

  return (
    <nav
      aria-label="Pagination"
      className={cn(
        'mt-4 flex flex-col gap-3 text-sm sm:flex-row sm:items-center sm:justify-between',
        className,
      )}
    >
      <div className="flex items-center gap-3 text-content-muted">
        {/*
          `aria-live="polite"` so a screen reader hears the new range after paging. Without it
          the page silently swaps its contents and the only feedback is visual.
        */}
        <p aria-live="polite">
          {meta.total === 0
            ? `No ${itemNounPlural ?? `${itemNoun}s`}`
            : `${first.toLocaleString('en-IN')}–${last.toLocaleString('en-IN')} of ${meta.total.toLocaleString('en-IN')} ${noun}`}
        </p>

        {onPageSizeChange ? (
          <label className="flex items-center gap-1.5">
            <span className="sr-only sm:not-sr-only">Per page</span>
            <select
              value={meta.pageSize}
              onChange={(event) => onPageSizeChange(Number(event.target.value))}
              className="rounded border border-line bg-surface px-1.5 py-1 text-sm text-content"
            >
              {/* Keep an unusual page size (a deep link, a saved URL) selectable. */}
              {(PAGE_SIZE_OPTIONS as readonly number[]).includes(meta.pageSize)
                ? null
                : <option value={meta.pageSize}>{meta.pageSize}</option>}
              {PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {meta.totalPages > 1 ? (
        <div className="flex items-center gap-2">
          <span className="text-content-muted">
            Page {meta.page.toLocaleString('en-IN')} of {meta.totalPages.toLocaleString('en-IN')}
          </span>
          <Button
            size="sm"
            disabled={!meta.hasPrevious || isFetching}
            onClick={() => onPageChange(Math.max(1, meta.page - 1))}
          >
            Previous
          </Button>
          <Button
            size="sm"
            disabled={!meta.hasNext || isFetching}
            onClick={() => onPageChange(meta.page + 1)}
          >
            Next
          </Button>
        </div>
      ) : null}
    </nav>
  );
}
