'use client';

/**
 * Text-like controls: `Input`, `Textarea`, `NumberInput`, `DatePicker`, `TimeInput`.
 *
 * `'use client'` because each one reads the `Field` context to pick up its id and ARIA wiring.
 *
 * All of them are `forwardRef` so React Hook Form's `register()` can attach its ref — without
 * that, RHF cannot focus the first invalid field after a failed submit, which is the behaviour
 * that makes a long admission form usable.
 *
 * The error styling is driven off `aria-invalid` rather than a separate `error` prop. One
 * source of truth means a control cannot end up red without being announced, or announced
 * without looking wrong.
 */

import { forwardRef } from 'react';
import { cn } from '@/lib/cn';
import { mergeFieldProps, useFieldControl } from './field';

/**
 * `aria-invalid` also accepts `'grammar'` and `'spelling'`, which are about spell-check hints
 * rather than a failed constraint — neither should paint the control red.
 */
function invalidClass(invalid: React.AriaAttributes['aria-invalid']): string | false {
  return (invalid === true || invalid === 'true') && 'input-error';
}

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(props, ref) {
  const merged = mergeFieldProps(useFieldControl(), props);
  const { className, ...rest } = merged;
  return (
    <input
      ref={ref}
      className={cn('input', invalidClass(merged['aria-invalid']), className)}
      {...rest}
    />
  );
});

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea(props, ref) {
    const merged = mergeFieldProps(useFieldControl(), props);
    const { className, rows = 3, ...rest } = merged;
    return (
      <textarea
        ref={ref}
        rows={rows}
        className={cn('input resize-y', invalidClass(merged['aria-invalid']), className)}
        {...rest}
      />
    );
  },
);

export interface NumberInputProps extends Omit<InputProps, 'type'> {
  /** Rendered inside the control, e.g. "marks", "%", "days". Decorative only. */
  suffix?: string;
}

/**
 * A numeric control.
 *
 * `inputMode="numeric"` gets the digit keypad on a phone, which is most of the value here — a
 * teacher entering 40 marks on a phone should not be fighting a QWERTY keyboard.
 *
 * The value is still a **string** in the form state. Number coercion belongs to the shared Zod
 * schema (`z.coerce.number()`), which is the same one the API validates with; parsing here
 * would mean two places that disagree about what an empty string is.
 *
 * This is never used for money — money is a decimal string handled by the fees module's
 * formatters, and `<input type="number">` would let a browser round it.
 */
export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(
  function NumberInput({ suffix, className, ...props }, ref) {
    const merged = mergeFieldProps(useFieldControl(), props);
    const control = (
      <input
        ref={ref}
        type="number"
        inputMode="numeric"
        className={cn(
          'input tabular-nums',
          invalidClass(merged['aria-invalid']),
          suffix && 'pr-12',
          className,
        )}
        {...merged}
      />
    );
    if (!suffix) return control;
    return (
      <div className="relative">
        {control}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-content-subtle"
        >
          {suffix}
        </span>
      </div>
    );
  },
);

/**
 * A date control.
 *
 * This is the platform's `<input type="date">`, and that is a considered choice rather than a
 * shortcut. It gives us, for free and correctly: the OS date picker every user already knows,
 * a real mobile date wheel, keyboard entry, locale-aware display, and screen-reader support
 * that no hand-rolled calendar in a two-week project comes close to. What a custom calendar
 * would add — a shared "academic year" range highlight, Bangla month names — is not worth
 * shipping a keyboard trap for. If we need those later, the honest move is a real date-picker
 * library, not a half-built one here.
 *
 * The value is always a `YYYY-MM-DD` calendar-date string, which is exactly what the API's
 * `calendarDateSchema` wants, so nothing converts on the way in or out.
 */
export const DatePicker = forwardRef<HTMLInputElement, Omit<InputProps, 'type'>>(
  function DatePicker(props, ref) {
    const merged = mergeFieldProps(useFieldControl(), props);
    const { className, ...rest } = merged;
    return (
      <input
        ref={ref}
        type="date"
        className={cn(
          'input',
          invalidClass(merged['aria-invalid']),
          // Safari and Chrome render the native indicator in a fixed dark colour; inverting it
          // in dark mode keeps it visible against the dark surface.
          'dark:[color-scheme:dark]',
          className,
        )}
        {...rest}
      />
    );
  },
);

/** `<input type="time">`, for the same reasons as `DatePicker`. Value is `HH:MM`. */
export const TimeInput = forwardRef<HTMLInputElement, Omit<InputProps, 'type'>>(
  function TimeInput(props, ref) {
    const merged = mergeFieldProps(useFieldControl(), props);
    const { className, ...rest } = merged;
    return (
      <input
        ref={ref}
        type="time"
        className={cn(
          'input tabular-nums',
          invalidClass(merged['aria-invalid']),
          'dark:[color-scheme:dark]',
          className,
        )}
        {...rest}
      />
    );
  },
);

/**
 * A search box with the magnifier and a clear button.
 *
 * `type="search"` gives the browser's own clear affordance on some platforms and, more
 * usefully, tells assistive technology what the field is for.
 */
export const SearchInput = forwardRef<
  HTMLInputElement,
  Omit<InputProps, 'type'> & { onClear?: () => void }
>(function SearchInput({ className, onClear, value, ...props }, ref) {
  const merged = mergeFieldProps(useFieldControl(), props);
  return (
    <div className="relative">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-content-subtle"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" strokeLinecap="round" />
        </svg>
      </span>
      <input
        ref={ref}
        type="search"
        value={value}
        className={cn('input pl-9', onClear && value ? 'pr-9' : undefined, className)}
        {...merged}
      />
      {onClear && value ? (
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear search"
          className="absolute inset-y-0 right-2 flex items-center rounded px-1 text-content-subtle hover:text-content"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
      ) : null}
    </div>
  );
});
