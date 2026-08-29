'use client';

/**
 * The bridge from React Hook Form to `Field`.
 *
 * The goal is one line per input at the call site:
 *
 * ```tsx
 * const form = useForm<z.input<typeof createRoomSchema>>({
 *   resolver: zodResolver(createRoomSchema),          // the SAME schema the API validates with
 *   defaultValues: { code: '', nameEn: '' },
 * });
 *
 * <Form form={form} onSubmit={(values) => mutation.mutateAsync(values)}>
 *   <TextField form={form} name="nameEn" label="Room name" required />
 *   <TextField form={form} name="nameBn" label="Room name (Bangla)" lang="bn" optional />
 *   <NumberField form={form} name="capacity" label="Capacity" optional />
 *   <FormActions><Button type="submit" variant="primary">Create room</Button></FormActions>
 * </Form>
 * ```
 *
 * `Form` wires the 422 path automatically: when the submit handler throws an `ApiError` with
 * field issues, they are applied to the matching fields via `setError`. That path is the whole
 * reason the API returns dotted field paths, and it only stays working if it is in one place —
 * a per-screen `catch` block is a per-screen opportunity to forget it.
 */

import {
  type FieldPath,
  type FieldValues,
  type RegisterOptions,
  type UseFormReturn,
} from 'react-hook-form';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Checkbox } from './checkbox';
import { Field, FormError } from './field';
import { DatePicker, Input, NumberInput, Textarea, TimeInput, type InputProps } from './input';
import { RadioGroup, type RadioOption } from './radio-group';
import { Select, type SelectOption } from './select';

// ── Server errors → form errors ───────────────────────────────────────────────────────

/**
 * Apply an `ApiError`'s field issues to a form.
 *
 * The API's paths are dotted with array indices (`guardians.0.phone`) — exactly React Hook
 * Form's path syntax — so they map across without translation. A path of `(root)` is a
 * whole-submission problem and lands on `root`.
 *
 * Returns `false` when the error was not a validation failure, which is the caller's cue to
 * surface it some other way (a toast, an `ErrorNotice`). A 409 "this room code is already in
 * use" is a real answer the user needs to see, and silently swallowing it here would be worse
 * than not handling it at all.
 */
export function applyApiFieldErrors<TValues extends FieldValues>(
  error: unknown,
  form: UseFormReturn<TValues>,
): boolean {
  if (!(error instanceof ApiError)) return false;

  const issues = error.fieldErrors();
  const paths = Object.keys(issues);

  // Not a 422, or a 422 with no field detail: there is nothing to attach to a field, so the
  // message goes to the form root where the submit button is.
  if (!error.isValidation || paths.length === 0) {
    form.setError('root.server', { type: 'server', message: error.message });
    return error.isValidation;
  }

  let focused = false;
  for (const path of paths) {
    const message = issues[path];
    if (!message) continue;
    if (path === '(root)' || path === 'root') {
      form.setError('root.server', { type: 'server', message });
      continue;
    }
    // The cast is unavoidable: the path is a runtime string from the wire, and `FieldPath`
    // is a compile-time union. An unrecognised path still registers an error — it just has no
    // field to render next to, which is why the root message below is kept as a backstop.
    form.setError(
      path as FieldPath<TValues>,
      { type: 'server', message },
      // Focus the first offending field so the user is taken to the problem rather than left
      // to hunt for the red text on a long admission form.
      { shouldFocus: !focused },
    );
    focused = true;
  }
  return true;
}

/** The root-level message, if any — rendered by `Form`, or by hand for a custom layout. */
export function formRootError<TValues extends FieldValues>(
  form: UseFormReturn<TValues>,
): string | undefined {
  const root = form.formState.errors.root;
  if (!root) return undefined;
  if (typeof root.message === 'string' && root.message) return root.message;
  // `setError('root.server')` nests under `root`, so the message is one level down.
  const nested = root as unknown as Record<string, { message?: string }>;
  return nested['server']?.message;
}

// ── Form shell ────────────────────────────────────────────────────────────────────────

export interface FormProps<TValues extends FieldValues> {
  form: UseFormReturn<TValues>;
  /** Receives validated values. Throwing an `ApiError` here populates the fields. */
  onSubmit: (values: TValues) => void | Promise<void>;
  children: React.ReactNode;
  className?: string;
  /** Called when the thrown error was not a validation failure — show a toast, usually. */
  onError?: (error: unknown) => void;
}

export function Form<TValues extends FieldValues>({
  form,
  onSubmit,
  children,
  className,
  onError,
}: FormProps<TValues>) {
  const rootError = formRootError(form);

  return (
    <form
      // `noValidate` turns off the browser's own bubble validation. It fires before the Zod
      // resolver, shows a message we did not write in a style we cannot match, and is not
      // announced the way our `role="alert"` errors are. The constraints are still on the
      // inputs for assistive technology; only the browser's UI is suppressed.
      noValidate
      className={cn('space-y-4', className)}
      onSubmit={form.handleSubmit(async (values) => {
        // Clear a previous server error, otherwise a stale "already in use" sits above a form
        // the user has since corrected.
        form.clearErrors('root');
        try {
          await onSubmit(values);
        } catch (error) {
          const handled = applyApiFieldErrors(error, form);
          if (!handled) onError?.(error);
        }
      })}
    >
      {rootError ? <FormError>{rootError}</FormError> : null}
      {children}
    </form>
  );
}

/** The button row. Right-aligned on a desktop, full-width stacked on a phone. */
export function FormActions({
  children,
  className,
  align = 'end',
}: {
  children: React.ReactNode;
  className?: string;
  align?: 'start' | 'end' | 'between';
}) {
  return (
    <div
      className={cn(
        'flex flex-col-reverse gap-2 border-t border-line pt-4 sm:flex-row sm:items-center',
        align === 'end' ? 'sm:justify-end' : align === 'between' ? 'sm:justify-between' : '',
        // Full-bleed buttons on a phone: a 44px tap target across the width beats two small
        // ones side by side, and the destructive one is never adjacent to the safe one.
        '[&>*]:w-full sm:[&>*]:w-auto',
        className,
      )}
    >
      {children}
    </div>
  );
}

// ── Field bridges ─────────────────────────────────────────────────────────────────────

interface BridgeProps<TValues extends FieldValues> {
  form: UseFormReturn<TValues>;
  name: FieldPath<TValues>;
  label: React.ReactNode;
  hint?: React.ReactNode;
  required?: boolean;
  optional?: boolean;
  hideLabel?: boolean;
  className?: string;
  /** Passed through to `register` — `valueAsNumber`, `setValueAs`, and friends. */
  registerOptions?: RegisterOptions<TValues, FieldPath<TValues>>;
}

/**
 * The current message for a field.
 *
 * `getFieldState` is given `formState` explicitly on purpose: React Hook Form uses a Proxy to
 * track which parts of the form state a component reads, and passing it here is what subscribes
 * this component to re-render when that field's error changes. Reading
 * `form.formState.errors[name]` by hand works for a flat field and silently fails for
 * `guardians.0.phone`.
 */
function fieldMessage<TValues extends FieldValues>(
  form: UseFormReturn<TValues>,
  name: FieldPath<TValues>,
): string | undefined {
  const state = form.getFieldState(name, form.formState);
  const message = state.error?.message;
  return typeof message === 'string' ? message : undefined;
}

type NativeInputProps = Omit<
  InputProps,
  'name' | 'form' | 'required' | 'id' | 'aria-invalid' | 'aria-describedby'
>;

export function TextField<TValues extends FieldValues>({
  form,
  name,
  label,
  hint,
  required,
  optional,
  hideLabel,
  className,
  registerOptions,
  ...input
}: BridgeProps<TValues> & NativeInputProps) {
  return (
    <Field
      label={label}
      hint={hint}
      error={fieldMessage(form, name)}
      required={required}
      optional={optional}
      hideLabel={hideLabel}
      className={className}
    >
      {/* `register` is spread last so its `onChange`/`onBlur`/`ref` are never clobbered by a
          caller's props — losing the ref costs focus-on-error, which fails silently. */}
      <Input {...input} {...form.register(name, registerOptions)} />
    </Field>
  );
}

export function TextAreaField<TValues extends FieldValues>({
  form,
  name,
  label,
  hint,
  required,
  optional,
  hideLabel,
  className,
  registerOptions,
  ...textarea
}: BridgeProps<TValues> &
  Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'name' | 'form' | 'required' | 'id'>) {
  return (
    <Field
      label={label}
      hint={hint}
      error={fieldMessage(form, name)}
      required={required}
      optional={optional}
      hideLabel={hideLabel}
      className={className}
    >
      <Textarea {...textarea} {...form.register(name, registerOptions)} />
    </Field>
  );
}

/**
 * A whole-number field.
 *
 * The registered value stays a string unless `registerOptions.valueAsNumber` is set. Most
 * schemas in `@shikkha/validation` use `z.coerce.number()`, which takes the string happily; a
 * schema written as plain `z.number()` needs `registerOptions={{ valueAsNumber: true }}`.
 * Guessing per field is how a form ends up sending `"12"` where the API wants `12`.
 */
export function NumberField<TValues extends FieldValues>({
  form,
  name,
  label,
  hint,
  required,
  optional,
  hideLabel,
  className,
  registerOptions,
  suffix,
  ...input
}: BridgeProps<TValues> & NativeInputProps & { suffix?: string }) {
  return (
    <Field
      label={label}
      hint={hint}
      error={fieldMessage(form, name)}
      required={required}
      optional={optional}
      hideLabel={hideLabel}
      className={className}
    >
      <NumberInput suffix={suffix} {...input} {...form.register(name, registerOptions)} />
    </Field>
  );
}

/**
 * A money field.
 *
 * `type="text"` with `inputMode="decimal"`, not `type="number"`. A number input hands us a
 * `Number` — and `0.1 + 0.2` is why a fee ledger must never see one. The value stays the exact
 * decimal string the user typed, is validated by the shared `moneySchema` regex, and goes back
 * to the API as a string (ADR-004). Format it for display with `formatMoney`, never here.
 */
export function MoneyField<TValues extends FieldValues>({
  form,
  name,
  label,
  hint,
  required,
  optional,
  hideLabel,
  className,
  registerOptions,
  ...input
}: BridgeProps<TValues> & NativeInputProps) {
  return (
    <Field
      label={label}
      hint={hint}
      error={fieldMessage(form, name)}
      required={required}
      optional={optional}
      hideLabel={hideLabel}
      className={className}
    >
      {(control) => (
        <div className="relative">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-content-subtle"
          >
            ৳
          </span>
          <Input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            className="pl-7 text-right tabular-nums"
            {...control}
            {...input}
            {...form.register(name, registerOptions)}
          />
        </div>
      )}
    </Field>
  );
}

export function DateField<TValues extends FieldValues>({
  form,
  name,
  label,
  hint,
  required,
  optional,
  hideLabel,
  className,
  registerOptions,
  ...input
}: BridgeProps<TValues> & Omit<NativeInputProps, 'type'>) {
  return (
    <Field
      label={label}
      hint={hint}
      error={fieldMessage(form, name)}
      required={required}
      optional={optional}
      hideLabel={hideLabel}
      className={className}
    >
      <DatePicker {...input} {...form.register(name, registerOptions)} />
    </Field>
  );
}

export function TimeField<TValues extends FieldValues>({
  form,
  name,
  label,
  hint,
  required,
  optional,
  hideLabel,
  className,
  registerOptions,
  ...input
}: BridgeProps<TValues> & Omit<NativeInputProps, 'type'>) {
  return (
    <Field
      label={label}
      hint={hint}
      error={fieldMessage(form, name)}
      required={required}
      optional={optional}
      hideLabel={hideLabel}
      className={className}
    >
      <TimeInput {...input} {...form.register(name, registerOptions)} />
    </Field>
  );
}

export function SelectField<TValues extends FieldValues>({
  form,
  name,
  label,
  hint,
  required,
  optional,
  hideLabel,
  className,
  registerOptions,
  options,
  placeholder,
  allowEmpty,
  ...select
}: BridgeProps<TValues> &
  Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'name' | 'form' | 'required' | 'id'> & {
    options: SelectOption[];
    placeholder?: string;
    allowEmpty?: boolean;
  }) {
  return (
    <Field
      label={label}
      hint={hint}
      error={fieldMessage(form, name)}
      required={required}
      optional={optional}
      hideLabel={hideLabel}
      className={className}
    >
      <Select
        options={options}
        placeholder={placeholder}
        allowEmpty={allowEmpty}
        {...select}
        {...form.register(name, registerOptions)}
      />
    </Field>
  );
}

/** A single checkbox bound to a boolean field. The label sits to the right of the box. */
export function CheckboxField<TValues extends FieldValues>({
  form,
  name,
  label,
  hint,
  className,
  registerOptions,
  ...input
}: Omit<BridgeProps<TValues>, 'required' | 'optional' | 'hideLabel'> &
  Omit<NativeInputProps, 'type'>) {
  return (
    <Field
      label={label}
      hint={hint}
      error={fieldMessage(form, name)}
      className={className}
      layout="inline"
    >
      <Checkbox {...input} {...form.register(name, registerOptions)} />
    </Field>
  );
}

/** A radio group bound to a string field. */
export function RadioField<TValues extends FieldValues>({
  form,
  name,
  label,
  hint,
  required,
  className,
  registerOptions,
  options,
  orientation,
}: Omit<BridgeProps<TValues>, 'optional' | 'hideLabel'> & {
  options: RadioOption[];
  orientation?: 'vertical' | 'inline';
}) {
  const { ref, ...registration } = form.register(name, registerOptions);
  return (
    <RadioGroup
      {...registration}
      inputRef={ref}
      label={label}
      hint={hint}
      required={required}
      className={className}
      options={options}
      orientation={orientation}
      error={fieldMessage(form, name)}
    />
  );
}
