'use client';

/**
 * Select.
 *
 * A native `<select>`, not a custom listbox. On a phone that means the OS picker — a wheel a
 * teacher can use one-handed — and on the desktop it means type-ahead, keyboard navigation and
 * screen-reader support that already work. A custom dropdown would buy styling consistency and
 * cost all of that.
 *
 * `placeholder` renders as a disabled first option rather than as CSS trickery, so the control
 * still reports a real value and "no selection" is representable.
 */

import { forwardRef } from 'react';
import { cn } from '@/lib/cn';
import { mergeFieldProps, useFieldControl } from './field';

export interface SelectOption {
  value: string;
  label: string;
  /** Rendered after the label in muted type — a Bangla name, a code, a count. */
  hint?: string;
  disabled?: boolean;
  /** Options sharing a group name are wrapped in an `<optgroup>`. */
  group?: string;
}

export interface SelectProps
  extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  options: SelectOption[];
  /** The empty choice. Omit it on a select that must always have a value. */
  placeholder?: string;
  /** Allows the placeholder to be re-selected — for filters, where "Any" is a real choice. */
  allowEmpty?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { options, placeholder, allowEmpty = false, className, ...props },
  ref,
) {
  const merged = mergeFieldProps(useFieldControl(), props);
  const invalid = merged['aria-invalid'] === true || merged['aria-invalid'] === 'true';

  // Preserve the caller's order; `optgroup` only kicks in when a group is actually set.
  const groups: Array<{ name: string | null; items: SelectOption[] }> = [];
  for (const option of options) {
    const name = option.group ?? null;
    const last = groups[groups.length - 1];
    if (last && last.name === name) last.items.push(option);
    else groups.push({ name, items: [option] });
  }

  return (
    <select
      ref={ref}
      className={cn(
        'input appearance-none bg-[length:1rem] bg-[right_0.6rem_center] bg-no-repeat pr-9',
        // The chevron is an inline SVG data URI on the background so the control keeps the
        // native select's behaviour while losing the platform's inconsistent arrow. `%23` is a
        // literal `#`; `currentColor` is not available to a background image, so the stroke is
        // a mid-grey that reads acceptably on both the light and the dark surface.
        "bg-[url(\"data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2' stroke-linecap='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")]",
        invalid && 'input-error',
        className,
      )}
      {...merged}
    >
      {placeholder !== undefined ? (
        <option value="" disabled={!allowEmpty}>
          {placeholder}
        </option>
      ) : null}
      {groups.map((group, index) =>
        group.name === null ? (
          group.items.map((option) => <NativeOption key={option.value} option={option} />)
        ) : (
          <optgroup key={`${group.name}-${index}`} label={group.name}>
            {group.items.map((option) => (
              <NativeOption key={option.value} option={option} />
            ))}
          </optgroup>
        ),
      )}
    </select>
  );
});

function NativeOption({ option }: { option: SelectOption }) {
  return (
    <option value={option.value} disabled={option.disabled}>
      {/* A native option cannot carry markup, so the hint is appended as text rather than
          styled — including a Bangla name, which the font stack renders correctly here. */}
      {option.hint ? `${option.label} — ${option.hint}` : option.label}
    </option>
  );
}

/** Build options from any row list. Keeps the `map` out of forty screens. */
export function toOptions<T>(
  rows: readonly T[],
  map: (row: T) => SelectOption,
): SelectOption[] {
  return rows.map(map);
}
