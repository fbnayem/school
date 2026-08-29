'use client';

/**
 * Field: the label + control + hint + error wrapper.
 *
 * Doing this wiring by hand at forty call sites is how accessibility rots — the first thirty
 * get `htmlFor`, the last ten do not, and nobody notices because the screen looks identical.
 * So `Field` owns all of it:
 *
 *  - generates one id and puts it on the label's `htmlFor` and the control's `id`
 *  - builds `aria-describedby` from whichever of hint and error actually rendered
 *  - sets `aria-invalid` when there is an error
 *  - marks the error `role="alert"` so it is announced, not merely coloured red (rule 5:
 *    colour alone excludes roughly one in twelve men, and every screen-reader user)
 *
 * Controls pick this up through context, so `<Field label="Name"><Input /></Field>` is fully
 * wired with no props threaded by the caller. A control that is not from this kit — a
 * third-party editor, a composite widget — uses the render-prop form and gets the same
 * attributes as an object.
 */

import { createContext, useContext, useId } from 'react';
import { cn } from '@/lib/cn';

export interface FieldControlProps {
  id: string;
  'aria-describedby': string | undefined;
  'aria-invalid': true | undefined;
  required: boolean | undefined;
}

const FieldControlContext = createContext<FieldControlProps | null>(null);

/**
 * Read the wiring for the control inside a `Field`.
 *
 * Returns `null` outside a Field, which is deliberate: a bare `<Input id="x" />` used without a
 * Field must still work, so every control merges this with its own props rather than requiring
 * it.
 */
export function useFieldControl(): FieldControlProps | null {
  return useContext(FieldControlContext);
}

interface WiredControlProps {
  id?: string | undefined;
  'aria-describedby'?: string | undefined;
  /** Matches React's own type, which allows `'grammar'` and `'spelling'` as well as booleans. */
  'aria-invalid'?: React.AriaAttributes['aria-invalid'];
  required?: boolean | undefined;
}

/**
 * Merge Field-supplied wiring with a control's own props. Explicit props always win — a caller
 * who passes their own `id` or `aria-describedby` means it.
 */
export function mergeFieldProps<T extends WiredControlProps>(
  field: FieldControlProps | null,
  props: T,
): T {
  if (!field) return props;
  return {
    ...props,
    id: props.id ?? field.id,
    'aria-describedby':
      // Both can be present: a control with its own description inside a Field that also has a
      // hint. `aria-describedby` is a token list, so they concatenate rather than replace.
      [field['aria-describedby'], props['aria-describedby']].filter(Boolean).join(' ') ||
      undefined,
    'aria-invalid': props['aria-invalid'] ?? field['aria-invalid'],
    required: props.required ?? field.required,
    // The spread produces `T` plus the four overridden keys, all of which are already in `T`'s
    // constraint; TypeScript cannot see that a generic spread stays assignable to `T`.
  } as T;
}

export interface FieldProps {
  label: React.ReactNode;
  /** Shown under the control, before any error. Explain the rule, not the obvious. */
  hint?: React.ReactNode;
  /** The message from validation, or from `ApiError.fieldErrors()`. */
  error?: string | null | undefined;
  required?: boolean;
  /**
   * Adds a muted "Optional" next to the label. Preferred over marking everything required with
   * an asterisk on forms where most fields are required — the marker should flag the exception.
   */
  optional?: boolean;
  /** Visually hide the label. It still exists for assistive technology. */
  hideLabel?: boolean;
  className?: string;
  /** A control, or a function receiving the generated id and ARIA attributes. */
  children: React.ReactNode | ((control: FieldControlProps) => React.ReactNode);
  /**
   * Renders the label after the control, for a checkbox or a switch where the label sits to the
   * right of the box.
   */
  layout?: 'stacked' | 'inline';
}

export function Field({
  label,
  hint,
  error,
  required,
  optional,
  hideLabel,
  className,
  children,
  layout = 'stacked',
}: FieldProps) {
  const reactId = useId();
  const id = `${reactId}-control`;
  const hintId = `${reactId}-hint`;
  const errorId = `${reactId}-error`;

  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  const control: FieldControlProps = {
    id,
    'aria-describedby': describedBy || undefined,
    'aria-invalid': error ? true : undefined,
    required: required || undefined,
  };

  const rendered =
    typeof children === 'function' ? (
      children(control)
    ) : (
      <FieldControlContext.Provider value={control}>{children}</FieldControlContext.Provider>
    );

  const labelNode = (
    <label htmlFor={id} className={cn('label', hideLabel && 'sr-only')}>
      {label}
      {required ? (
        <>
          {' '}
          <span className="text-danger" aria-hidden="true">
            *
          </span>
          {/* The asterisk is decorative; the requirement itself is on the control. */}
        </>
      ) : null}
      {optional ? <span className="ml-1 font-normal text-content-subtle">(optional)</span> : null}
    </label>
  );

  if (layout === 'inline') {
    return (
      <div className={cn('space-y-1', className)}>
        <div className="flex items-start gap-2">
          {rendered}
          {labelNode}
        </div>
        <FieldMessages hint={hint} hintId={hintId} error={error} errorId={errorId} indent />
      </div>
    );
  }

  return (
    <div className={cn('space-y-1', className)}>
      {labelNode}
      {rendered}
      <FieldMessages hint={hint} hintId={hintId} error={error} errorId={errorId} />
    </div>
  );
}

function FieldMessages({
  hint,
  hintId,
  error,
  errorId,
  indent,
}: {
  hint: React.ReactNode;
  hintId: string;
  error: string | null | undefined;
  errorId: string;
  indent?: boolean;
}) {
  if (!hint && !error) return null;
  return (
    <div className={cn(indent && 'pl-6')}>
      {hint ? (
        <p id={hintId} className="text-xs text-content-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        // `role="alert"` announces the message when it appears — after a failed submit the user
        // hears what is wrong instead of discovering it by tabbing back through the form.
        <p id={errorId} role="alert" className="mt-0.5 text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A form-level error — the 422 that has no field path, or the 409 that is about the whole
 * submission. Sits above the buttons where the eye lands after pressing Save.
 */
export function FormError({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <p
      role="alert"
      className="rounded border border-danger/30 bg-danger-subtle px-3 py-2 text-sm text-danger"
    >
      {children}
    </p>
  );
}

/** Groups related fields into a two-column grid that collapses to one column on a phone. */
export function FieldGrid({
  children,
  columns = 2,
  className,
}: {
  children: React.ReactNode;
  columns?: 1 | 2 | 3;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'grid gap-4',
        columns === 1 ? 'sm:grid-cols-1' : columns === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-3',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Full-width cell inside a `FieldGrid` — an address, a note, a reason. */
export function FieldGridSpan({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn('sm:col-span-full', className)}>{children}</div>;
}
