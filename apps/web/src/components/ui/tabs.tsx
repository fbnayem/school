'use client';

/**
 * Tabs, following the WAI-ARIA tabs pattern.
 *
 * The part people leave out is the keyboard model, so it is spelled out here:
 *
 *  - Only the selected tab is in the tab sequence (roving `tabindex`). Tab enters the tab list
 *    once and the next Tab leaves it for the panel — not through six tabs one at a time.
 *  - Arrow keys move between tabs and wrap around; Home and End jump to the ends.
 *  - `activation="automatic"` (the default) selects as focus moves, which is right for cheap
 *    panels. Use `"manual"` — select on Enter/Space — when a panel fires a network request, so
 *    arrowing past four tabs does not fire four queries.
 *
 * Inactive panels are **unmounted**, not hidden. A hidden panel's `useQuery` still runs, still
 * refetches, and still shows its own error somewhere the user cannot see it.
 */

import { createContext, useContext, useId, useRef } from 'react';
import { cn } from '@/lib/cn';

interface TabsContextValue {
  value: string;
  onValueChange: (value: string) => void;
  baseId: string;
  activation: 'automatic' | 'manual';
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabs(component: string): TabsContextValue {
  const context = useContext(TabsContext);
  if (!context) throw new Error(`<${component}> must be used inside <Tabs>`);
  return context;
}

export function Tabs({
  value,
  onValueChange,
  activation = 'automatic',
  children,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  activation?: 'automatic' | 'manual';
  children: React.ReactNode;
  className?: string;
}) {
  const baseId = useId();
  return (
    <TabsContext.Provider value={{ value, onValueChange, baseId, activation }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabList({
  children,
  label,
  className,
}: {
  children: React.ReactNode;
  /** Names the group for a screen reader: "Student record, tab list". Required for a reason. */
  label: string;
  className?: string;
}) {
  const { onValueChange, activation } = useTabs('TabList');
  const listRef = useRef<HTMLDivElement | null>(null);

  const move = (direction: -1 | 1 | 'first' | 'last') => {
    const list = listRef.current;
    if (!list) return;
    const tabs = [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])')];
    if (tabs.length === 0) return;
    const currentIndex = tabs.findIndex((tab) => tab === document.activeElement);
    let nextIndex: number;
    if (direction === 'first') nextIndex = 0;
    else if (direction === 'last') nextIndex = tabs.length - 1;
    else nextIndex = (Math.max(0, currentIndex) + direction + tabs.length) % tabs.length;

    const next = tabs[nextIndex];
    if (!next) return;
    next.focus();
    // Automatic activation: selection follows focus, as the pattern prescribes for panels that
    // are cheap to render.
    if (activation === 'automatic') {
      const nextValue = next.dataset['value'];
      if (nextValue) onValueChange(nextValue);
    }
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      onKeyDown={(event) => {
        switch (event.key) {
          case 'ArrowRight':
            event.preventDefault();
            move(1);
            break;
          case 'ArrowLeft':
            event.preventDefault();
            move(-1);
            break;
          case 'Home':
            event.preventDefault();
            move('first');
            break;
          case 'End':
            event.preventDefault();
            move('last');
            break;
          default:
            break;
        }
      }}
      className={cn(
        // Horizontally scrollable on a phone: six tabs do not fit at 375px, and wrapping them
        // onto three rows pushes the content below the fold.
        'flex gap-1 overflow-x-auto border-b border-line',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Tab({
  value,
  children,
  disabled,
  /** A count beside the label — "Invoices 12". Reads as part of the tab's accessible name. */
  count,
  className,
}: {
  value: string;
  children: React.ReactNode;
  disabled?: boolean;
  count?: number;
  className?: string;
}) {
  const tabs = useTabs('Tab');
  const selected = tabs.value === value;

  return (
    <button
      type="button"
      role="tab"
      id={`${tabs.baseId}-tab-${value}`}
      data-value={value}
      aria-selected={selected}
      aria-controls={`${tabs.baseId}-panel-${value}`}
      // Roving tabindex: exactly one tab is reachable with Tab.
      tabIndex={selected ? 0 : -1}
      disabled={disabled}
      onClick={() => tabs.onValueChange(value)}
      className={cn(
        'flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-base font-medium transition-colors',
        selected
          ? 'border-accent-600 text-accent-700'
          : 'border-transparent text-content-muted hover:border-line-strong hover:text-content',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    >
      {children}
      {count !== undefined ? (
        <span
          className={cn(
            'rounded-sm px-1.5 py-0.5 text-xs tabular-nums',
            selected ? 'bg-accent-50 text-accent-800' : 'bg-surface-muted text-content-muted',
          )}
        >
          {count.toLocaleString('en-IN')}
        </span>
      ) : null}
    </button>
  );
}

export function TabPanel({
  value,
  children,
  className,
}: {
  value: string;
  children: React.ReactNode;
  className?: string;
}) {
  const tabs = useTabs('TabPanel');
  if (tabs.value !== value) return null;

  return (
    <div
      role="tabpanel"
      id={`${tabs.baseId}-panel-${value}`}
      aria-labelledby={`${tabs.baseId}-tab-${value}`}
      // Focusable so that tabbing out of the tab list lands in the panel even when its first
      // element is plain text. The pattern requires this whenever the panel holds no control.
      tabIndex={0}
      className={cn('pt-4 focus-visible:outline-none', className)}
    >
      {children}
    </div>
  );
}
