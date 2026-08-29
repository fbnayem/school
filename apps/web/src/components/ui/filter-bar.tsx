'use client';

/**
 * FilterBar: the search box and filter selects every list screen needs.
 *
 * **The search is debounced here, and it drives a server query.** Filtering rows in the browser
 * would mean shipping every row to the browser first — slow, and a data-minimisation failure on
 * a table of children's records. The debounced value is what the caller puts in its React Query
 * key; the box itself updates on every keystroke so typing never feels laggy.
 *
 * The debounce is owned by this component rather than the caller because getting it wrong is
 * invisible: a screen that forgets it still works, just with one request per keystroke, and
 * nobody notices until the API's rate limiter does.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { Button } from './button';
import { SearchInput } from './input';
import { Select, type SelectOption } from './select';

export interface FilterBarSearch {
  /** The committed (debounced) value — normally the same state that is in the query key. */
  value: string;
  /** Called after the user stops typing. */
  onChange: (value: string) => void;
  placeholder?: string;
  /** The accessible label. Say what is searchable: "Search by name or student ID". */
  label: string;
}

export interface FilterBarSelect {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  /** The "no filter" choice, e.g. "All statuses". Always selectable. */
  placeholder: string;
}

export function FilterBar({
  search,
  filters = [],
  actions,
  onReset,
  debounceMs = 300,
  className,
}: {
  search?: FilterBarSearch;
  filters?: FilterBarSelect[];
  /** Buttons on the right — "Add student", "Export". Gate these on a permission. */
  actions?: React.ReactNode;
  /** Shown as "Clear filters" whenever anything is set. Omit to hide the control. */
  onReset?: () => void;
  debounceMs?: number;
  className?: string;
}) {
  // Ids are generated: two filter bars can coexist on one screen (a page with two tabs of
  // lists), and duplicate ids silently break every label association on the second one.
  const baseId = useId();
  const [text, setText] = useState(search?.value ?? '');

  // The last value handed to `onChange`. Comparing against it is what distinguishes "the parent
  // reset the filters" (re-seed the box) from "our own debounce just landed" (do nothing) —
  // without it, a reset would be immediately overwritten by the stale local text.
  const committed = useRef(search?.value ?? '');
  const onChangeRef = useRef(search?.onChange);
  onChangeRef.current = search?.onChange;

  const externalValue = search?.value;
  useEffect(() => {
    if (externalValue === undefined) return;
    if (externalValue !== committed.current) {
      committed.current = externalValue;
      setText(externalValue);
    }
  }, [externalValue]);

  useEffect(() => {
    if (text === committed.current) return;
    const timer = window.setTimeout(() => {
      committed.current = text;
      onChangeRef.current?.(text);
    }, debounceMs);
    return () => window.clearTimeout(timer);
  }, [text, debounceMs]);

  const anythingSet =
    (search?.value ?? '') !== '' || filters.some((filter) => filter.value !== '');

  return (
    <div className={cn('mb-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end', className)}>
      {search ? (
        <div className="min-w-0 flex-1 sm:max-w-md">
          <label htmlFor={`${baseId}-search`} className="sr-only">
            {search.label}
          </label>
          <SearchInput
            id={`${baseId}-search`}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onClear={() => setText('')}
            placeholder={search.placeholder ?? search.label}
          />
        </div>
      ) : null}

      {filters.map((filter) => (
        <div key={filter.id} className="min-w-0 sm:w-44">
          <label htmlFor={`${baseId}-${filter.id}`} className="sr-only">
            {filter.label}
          </label>
          <Select
            id={`${baseId}-${filter.id}`}
            value={filter.value}
            onChange={(event) => filter.onChange(event.target.value)}
            options={filter.options}
            placeholder={filter.placeholder}
            // The placeholder is a real choice here — "All statuses" is how you remove a filter.
            allowEmpty
          />
        </div>
      ))}

      {onReset && anythingSet ? (
        <Button variant="ghost" size="sm" onClick={onReset}>
          Clear filters
        </Button>
      ) : null}

      {actions ? <div className="flex gap-2 sm:ml-auto">{actions}</div> : null}
    </div>
  );
}
