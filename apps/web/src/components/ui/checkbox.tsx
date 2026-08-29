'use client';

/**
 * Checkbox and Switch.
 *
 * Both are a real `<input type="checkbox">`. The visible box is the native control with an
 * accent colour applied — no hidden input plus a styled span, which is the pattern that
 * routinely loses the focus ring, the indeterminate state and Windows high-contrast mode.
 */

import { forwardRef, useEffect, useRef } from 'react';
import { cn } from '@/lib/cn';
import { mergeFieldProps, useFieldControl } from './field';

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Third state for a "select all" box when only some rows are selected. */
  indeterminate?: boolean;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { className, indeterminate, ...props },
  ref,
) {
  const merged = mergeFieldProps(useFieldControl(), props);
  const localRef = useRef<HTMLInputElement | null>(null);

  // `indeterminate` exists only as a DOM property — there is no attribute for it, so React
  // cannot set it declaratively and it has to be written after render.
  useEffect(() => {
    if (localRef.current) localRef.current.indeterminate = indeterminate ?? false;
  }, [indeterminate]);

  return (
    <input
      type="checkbox"
      ref={(node) => {
        localRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      }}
      className={cn(
        'mt-0.5 h-4 w-4 shrink-0 rounded-sm border-line-strong text-accent-600',
        'accent-accent-600 disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
      {...merged}
    />
  );
});

/**
 * A checkbox with its label to the right — the shape a standalone toggle actually needs, where
 * the `Field` label-above-control layout would look broken.
 *
 * Wrapping the input in the `<label>` means the whole row is a hit target without needing an
 * id, so this works outside a `Field` too.
 */
export const CheckboxRow = forwardRef<
  HTMLInputElement,
  CheckboxProps & { label: React.ReactNode; hint?: React.ReactNode; error?: string | null }
>(function CheckboxRow({ label, hint, error, className, ...props }, ref) {
  return (
    <div className={cn('space-y-1', className)}>
      <label className="flex cursor-pointer items-start gap-2.5">
        <Checkbox ref={ref} aria-invalid={error ? true : undefined} {...props} />
        <span className="text-base leading-tight">
          {label}
          {hint ? <span className="mt-0.5 block text-xs text-content-muted">{hint}</span> : null}
        </span>
      </label>
      {error ? (
        <p role="alert" className="pl-[1.625rem] text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
});
