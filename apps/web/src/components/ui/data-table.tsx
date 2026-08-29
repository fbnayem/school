'use client';

/**
 * DataTable.
 *
 * The responsive behaviour is not a second approach — it is the pattern from
 * `app/(app)/students/page.tsx` lifted into one component: a real `<table>` from `sm` up, and a
 * list of cards below it. A four-column table at 375px is technically responsive and
 * practically unusable, and teachers do this on phones.
 *
 * ## Sorting drives the API, never the array
 *
 * `onSortChange` hands back a `sort` string in the API's format (`field`, or `-field` for
 * descending) for the caller to put in its query key. Sorting `rows` here would sort **one
 * page** — reordering 25 of 4,000 students and presenting the result as "sorted by name". The
 * first row would not be the first student, and nobody would notice until a fee report was
 * built on that assumption. `parseSort` on the API validates the field against a per-endpoint
 * allow-list, so an unknown `sortField` is dropped there rather than reaching SQL.
 *
 * ## What it does not do
 *
 * No row selection, no column resizing, no client-side filtering. Each of those is a real
 * feature with a real API behind it; a half-built version that only works on the current page
 * is worse than its absence.
 */

import Link from 'next/link';
import { EmptyState } from '@/components/empty-state';
import { ErrorNotice } from '@/components/error-notice';
import { cn } from '@/lib/cn';

/** Where a column goes when the table becomes a card below `sm`. */
export type CardSlot = 'title' | 'subtitle' | 'meta' | 'aside' | 'row' | 'hidden';

export interface DataTableColumn<Row> {
  /** Stable key. Also used as the React key for the cell. */
  id: string;
  header: React.ReactNode;
  render: (row: Row) => React.ReactNode;
  /**
   * The API's sort field name. Present ⇒ the header becomes a sort button. Must be a field the
   * endpoint's allow-list accepts, or the API silently falls back to its default order.
   */
  sortField?: string;
  align?: 'left' | 'right';
  /** Applied to the `<td>`; use for `tabular-nums`, `font-mono`, width hints. */
  className?: string;
  headerClassName?: string;
  /**
   * Card placement below `sm`. Default `row` — a labelled label/value line. `title` is also the
   * cell that becomes the link when `rowHref` is set.
   */
  card?: CardSlot;
  /** Drop the column from the table on narrower desktops rather than squeezing every column. */
  hideBelow?: 'md' | 'lg';
}

/** Literal class strings so Tailwind's content scanner can see them. */
const HIDE_BELOW_CLASS: Record<'md' | 'lg', string> = {
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
};

export interface DataTableProps<Row> {
  /**
   * Describes the table for assistive technology, e.g. "Students, page 2 of 7". Required: an
   * unlabelled table in a screen with three tables is unnavigable.
   */
  caption: string;
  columns: DataTableColumn<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  /**
   * Makes each row navigable. The `title` column's content is wrapped in the link, so its
   * `render` should return plain content — returning a `<Link>` would nest two anchors.
   */
  rowHref?: (row: Row) => string;
  /** Row-level buttons, rendered outside the row link so they stay independently clickable. */
  actions?: (row: Row) => React.ReactNode;

  /** The current API `sort` value, e.g. `-admissionDate`. */
  sort?: string | undefined;
  onSortChange?: (sort: string | undefined) => void;

  isLoading?: boolean;
  /** A background refetch: the previous page stays visible and dims slightly. */
  isFetching?: boolean;
  error?: unknown;

  empty?: { title: string; description: string; action?: React.ReactNode };
  skeletonRows?: number;
  /** Minimum table width before horizontal scroll kicks in. Default `40rem`, as students. */
  minWidth?: string;
  className?: string;
}

export function DataTable<Row>({
  caption,
  columns,
  rows,
  rowKey,
  rowHref,
  actions,
  sort,
  onSortChange,
  isLoading = false,
  isFetching = false,
  error,
  empty,
  skeletonRows = 8,
  minWidth = '40rem',
  className,
}: DataTableProps<Row>) {
  if (error) return <ErrorNotice error={error} />;
  if (isLoading) {
    return <TableSkeleton rows={skeletonRows} columns={columns.length} label={caption} />;
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        title={empty?.title ?? 'Nothing to show'}
        description={
          empty?.description ?? 'There are no records here yet, or none match your filters.'
        }
        action={empty?.action}
      />
    );
  }

  // `card: 'hidden'` hides a column on the phone card only — the table still shows every column.
  const titleColumn = columns.find((column) => column.card === 'title') ?? columns[0];

  return (
    <div className={cn(isFetching && 'opacity-70 transition-opacity', className)}>
      {/* Desktop and tablet: a table. */}
      <div className="card hidden overflow-hidden sm:block">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ minWidth }}>
            <caption className="sr-only">{caption}</caption>
            <thead className="border-b border-line bg-surface-muted text-left">
              <tr>
                {columns.map((column) => (
                  <HeaderCell
                    key={column.id}
                    column={column}
                    sort={sort}
                    onSortChange={onSortChange}
                  />
                ))}
                {actions ? (
                  <th scope="col" className="px-4 py-2.5">
                    <span className="sr-only">Actions</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((row) => {
                const href = rowHref?.(row);
                return (
                  <tr key={rowKey(row)} className="hover:bg-surface-muted">
                    {columns.map((column) => {
                      const content = column.render(row);
                      return (
                        <td
                          key={column.id}
                          className={cn(
                            'px-4 py-2.5 align-top',
                            column.align === 'right' && 'text-right',
                            column.hideBelow && HIDE_BELOW_CLASS[column.hideBelow],
                            column.className,
                          )}
                        >
                          {href && column === titleColumn ? (
                            <Link
                              href={href}
                              className="font-medium text-accent-700 hover:underline"
                            >
                              {content}
                            </Link>
                          ) : (
                            content
                          )}
                        </td>
                      );
                    })}
                    {actions ? (
                      <td className="px-4 py-2.5 text-right align-top">
                        <div className="flex justify-end gap-1.5">{actions(row)}</div>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Phone: cards. */}
      <ul className="space-y-2 sm:hidden">
        {rows.map((row) => (
          <CardRow
            key={rowKey(row)}
            row={row}
            columns={columns}
            titleColumn={titleColumn}
            href={rowHref?.(row)}
            actions={actions}
          />
        ))}
      </ul>
    </div>
  );
}

function HeaderCell<Row>({
  column,
  sort,
  onSortChange,
}: {
  column: DataTableColumn<Row>;
  sort: string | undefined;
  onSortChange: ((sort: string | undefined) => void) | undefined;
}) {
  const sortable = Boolean(column.sortField && onSortChange);
  const active = column.sortField
    ? sort === column.sortField
      ? 'asc'
      : sort === `-${column.sortField}`
        ? 'desc'
        : null
    : null;

  const baseClass = cn(
    'px-4 py-2.5 font-medium text-content-muted',
    column.align === 'right' && 'text-right',
    column.hideBelow && HIDE_BELOW_CLASS[column.hideBelow],
    column.headerClassName,
  );

  if (!sortable) {
    return (
      <th scope="col" className={baseClass}>
        {column.header}
      </th>
    );
  }

  // Three states: ascending → descending → the endpoint's own default order. The third state
  // matters because the default is usually the most useful one (newest first, roll order), and
  // without it a user who sorts by name can never get back to it without reloading.
  const next =
    active === 'asc' ? `-${column.sortField}` : active === 'desc' ? undefined : column.sortField;

  return (
    <th
      scope="col"
      // `aria-sort` is what makes a screen reader announce "sorted ascending" on the column
      // header. It belongs on the `th`, not on the button inside it.
      aria-sort={active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : 'none'}
      className={cn(baseClass, 'p-0')}
    >
      <button
        type="button"
        onClick={() => onSortChange?.(next)}
        className={cn(
          'flex w-full items-center gap-1 px-4 py-2.5 font-medium hover:text-content',
          column.align === 'right' && 'justify-end',
          active && 'text-content',
        )}
      >
        {column.header}
        <SortGlyph direction={active} />
        <span className="sr-only">
          {active === 'asc'
            ? ', sorted ascending. Activate to sort descending.'
            : active === 'desc'
              ? ', sorted descending. Activate to clear sorting.'
              : ', not sorted. Activate to sort ascending.'}
        </span>
      </button>
    </th>
  );
}

function SortGlyph({ direction }: { direction: 'asc' | 'desc' | null }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn('shrink-0', direction ? 'opacity-100' : 'opacity-30')}
    >
      {direction === 'desc' ? <path d="m6 9 6 6 6-6" /> : <path d="m6 15 6-6 6 6" />}
    </svg>
  );
}

function CardRow<Row>({
  row,
  columns,
  titleColumn,
  href,
  actions,
}: {
  row: Row;
  columns: DataTableColumn<Row>[];
  titleColumn: DataTableColumn<Row> | undefined;
  href: string | undefined;
  actions: ((row: Row) => React.ReactNode) | undefined;
}) {
  const slotOf = (column: DataTableColumn<Row>): CardSlot =>
    column.card ?? (column === titleColumn ? 'title' : 'row');

  const title = columns.find((column) => slotOf(column) === 'title');
  const subtitles = columns.filter((column) => slotOf(column) === 'subtitle');
  const metas = columns.filter((column) => slotOf(column) === 'meta');
  const asides = columns.filter((column) => slotOf(column) === 'aside');
  const detailRows = columns.filter((column) => slotOf(column) === 'row');

  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {title ? <p className="truncate font-medium">{title.render(row)}</p> : null}
          {subtitles.map((column) => (
            <p key={column.id} className="truncate text-sm text-content-muted">
              {column.render(row)}
            </p>
          ))}
          {metas.map((column) => (
            <p key={column.id} className="mt-1 text-xs text-content-subtle">
              {column.render(row)}
            </p>
          ))}
        </div>
        {asides.length > 0 ? (
          <div className="flex shrink-0 flex-col items-end gap-1">
            {asides.map((column) => (
              <div key={column.id}>{column.render(row)}</div>
            ))}
          </div>
        ) : null}
      </div>

      {detailRows.length > 0 ? (
        <dl className="mt-2.5 space-y-1 border-t border-line pt-2.5 text-sm">
          {detailRows.map((column) => (
            <div key={column.id} className="flex justify-between gap-3">
              <dt className="text-content-subtle">{column.header}</dt>
              <dd className="text-right text-content">{column.render(row)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </>
  );

  return (
    <li>
      {href ? (
        <Link href={href} className="card block p-3.5">
          {body}
        </Link>
      ) : (
        <div className="card p-3.5">{body}</div>
      )}
      {/*
        Actions sit outside the link. A button inside an anchor is invalid HTML and, more to the
        point, tapping "Archive" would also navigate — on a phone that is a destructive action
        one thumb-slip away.
      */}
      {actions ? (
        <div className="mt-1.5 flex justify-end gap-2 px-1">{actions(row)}</div>
      ) : null}
    </li>
  );
}

/** Matches the table's row rhythm so the layout does not jump when the data lands. */
export function TableSkeleton({
  rows = 8,
  columns = 4,
  label = 'Loading',
}: {
  rows?: number;
  columns?: number;
  label?: string;
}) {
  return (
    <div className="card divide-y divide-line" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="flex animate-pulse items-center gap-4 px-4 py-3">
          <div className="h-4 w-1/3 rounded bg-surface-muted" />
          {Array.from({ length: Math.max(0, columns - 2) }).map((__, cellIndex) => (
            <div key={cellIndex} className="hidden h-4 w-24 rounded bg-surface-muted sm:block" />
          ))}
          <div className="ml-auto h-4 w-16 rounded bg-surface-muted" />
        </div>
      ))}
    </div>
  );
}
