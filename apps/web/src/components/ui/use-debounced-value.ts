'use client';

import { useEffect, useState } from 'react';

/**
 * A value that settles after the user stops changing it.
 *
 * 300ms by default: long enough that a normal typing burst is one request, short enough that
 * the result still feels immediate. Above roughly 400ms it reads as lag, below about 150ms a
 * ten-character search fires ten queries.
 *
 * This exists so a list screen can put the debounced value straight into its query key and let
 * React Query do the rest — no `useEffect` chain, no manual cancellation.
 */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
