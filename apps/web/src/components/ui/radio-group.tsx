'use client';

/**
 * RadioGroup.
 *
 * Native radios inside a `<fieldset>`/`<legend>`, which is what gives a screen reader "Gender,
 * group, Male, 1 of 3" — the group name, the position, and the count — with no ARIA at all.
 * The `role="radiogroup"` + roving-tabindex version of this exists because people want custom
 * visuals; it also reimplements arrow-key navigation that the browser already does correctly.
 *
 * Because the group is one field with many inputs, `Field` cannot put its generated id on a
 * single control. So `RadioGroup` renders its own legend and takes `label`/`error` directly:
 * use it standalone, not wrapped in a `Field`.
 */

import { useId } from 'react';
import { cn } from '@/lib/cn';

export interface RadioOption {
  value: string;
  label: React.ReactNode;
  /** A line of explanation under the label — what this choice means for the record. */
  hint?: React.ReactNode;
  disabled?: boolean;
}

export interface RadioGroupProps {
  /** Must match across all inputs in the group; supply the form field's name. */
  name: string;
  label: React.ReactNode;
  options: RadioOption[];
  value?: string;
  defaultValue?: string;
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
  onBlur?: React.FocusEventHandler<HTMLInputElement>;
  hint?: React.ReactNode;
  error?: string | null;
  required?: boolean;
  disabled?: boolean;
  /** `inline` puts the choices on one row where they are short (Yes / No). */
  orientation?: 'vertical' | 'inline';
  className?: string;
  /** React Hook Form's `register()` attaches its ref here. */
  inputRef?: React.Ref<HTMLInputElement>;
}

export function RadioGroup({
  name,
  label,
  options,
  value,
  defaultValue,
  onChange,
  onBlur,
  hint,
  error,
  required,
  disabled,
  orientation = 'vertical',
  className,
  inputRef,
}: RadioGroupProps) {
  const reactId = useId();
  const hintId = `${reactId}-hint`;
  const errorId = `${reactId}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <fieldset className={cn('space-y-1', className)} disabled={disabled}>
      <legend className="label">
        {label}
        {required ? (
          <span className="text-danger" aria-hidden="true">
            {' '}
            *
          </span>
        ) : null}
      </legend>

      <div
        className={cn(
          'pt-0.5',
          orientation === 'inline' ? 'flex flex-wrap gap-x-5 gap-y-2' : 'space-y-2',
        )}
      >
        {options.map((option, index) => (
          <label
            key={option.value}
            className={cn(
              'flex items-start gap-2.5',
              option.disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
            )}
          >
            <input
              // Only the first input carries the ref: RHF focuses it when the group is the
              // first invalid field, and focusing any member of a radio group is equivalent.
              ref={index === 0 ? inputRef : undefined}
              type="radio"
              name={name}
              value={option.value}
              checked={value === undefined ? undefined : value === option.value}
              defaultChecked={value === undefined ? defaultValue === option.value : undefined}
              onChange={onChange}
              onBlur={onBlur}
              disabled={option.disabled}
              required={required}
              aria-describedby={describedBy || undefined}
              aria-invalid={error ? true : undefined}
              className="mt-0.5 h-4 w-4 shrink-0 border-line-strong accent-accent-600"
            />
            <span className="text-base leading-tight">
              {option.label}
              {option.hint ? (
                <span className="mt-0.5 block text-xs text-content-muted">{option.hint}</span>
              ) : null}
            </span>
          </label>
        ))}
      </div>

      {hint ? (
        <p id={hintId} className="text-xs text-content-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
