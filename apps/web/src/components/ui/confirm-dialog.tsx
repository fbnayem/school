'use client';

/**
 * ConfirmDialog: the second step in front of every archive, void, cancel and delete.
 *
 * Two things it refuses to do, both deliberate:
 *
 *  1. **It never invents a reason.** Where the API requires one — `reasonSchema`, minimum ten
 *     characters, recorded in the audit log — the dialog collects it from the person doing the
 *     thing. Sending `"archived via UI"` would satisfy the validator and destroy the only
 *     evidence of *why*, which is the entire point of the field.
 *  2. **It does not close on success by itself unless the action succeeded.** The confirm
 *     handler is awaited; a failure keeps the dialog open with the API's message and request id
 *     visible, so the user can copy the id into a support call rather than losing it to a
 *     toast that has already faded.
 *
 * The reason is validated with `reasonSchema` from `@shikkha/validation` — the same schema the
 * API validates with, so the ten-character rule cannot drift between the two.
 */

import { useEffect, useId, useState } from 'react';
import { reasonSchema } from '@shikkha/validation';
import { ErrorNotice } from '@/components/error-notice';
import { Button, type ButtonVariant } from './button';
import { Dialog } from './dialog';
import { Textarea } from './input';

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * Runs the action. Receives the typed reason when `requireReason` is set. Throw to keep the
   * dialog open and show the error; resolve to close it.
   */
  onConfirm: (reason: string) => void | Promise<void>;
  title: string;
  /** What will happen, in one or two sentences. Name the record, not "this item". */
  body?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` for anything irreversible; `primary` for a merely significant confirmation. */
  variant?: Extract<ButtonVariant, 'danger' | 'primary'>;
  /** Set when the endpoint takes a `reason` — every archive/void/cancel route does. */
  requireReason?: boolean;
  reasonLabel?: string;
  reasonHint?: string;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'danger',
  requireReason = false,
  reasonLabel = 'Reason',
  reasonHint = 'Recorded in the audit log against your name. At least 10 characters.',
}: ConfirmDialogProps) {
  const reactId = useId();
  const reasonId = `${reactId}-reason`;
  const hintId = `${reactId}-hint`;
  const errorId = `${reactId}-error`;

  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  // Reset when the dialog opens. Without this, re-opening it for a *different* record shows the
  // previous record's reason — which would then be recorded against the wrong one.
  useEffect(() => {
    if (open) {
      setReason('');
      setReasonError(null);
      setError(null);
      setPending(false);
    }
  }, [open]);

  const confirm = async () => {
    if (requireReason) {
      const parsed = reasonSchema.safeParse(reason);
      if (!parsed.success) {
        setReasonError(parsed.error.issues[0]?.message ?? 'Give a reason.');
        return;
      }
    }
    setReasonError(null);
    setError(null);
    setPending(true);
    try {
      await onConfirm(requireReason ? reasonSchema.parse(reason) : reason.trim());
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={pending ? () => undefined : onClose}
      title={title}
      size="sm"
      // A typed reason is unsaved work: a stray click on the backdrop must not discard it.
      closeOnBackdropClick={!requireReason && !pending}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            variant={variant}
            onClick={confirm}
            loading={pending}
            loadingLabel={`${confirmLabel}…`}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {body ? <div className="text-base text-content-muted">{body}</div> : null}

        {requireReason ? (
          <div className="space-y-1">
            <label htmlFor={reasonId} className="label">
              {reasonLabel}
              <span className="text-danger" aria-hidden="true">
                {' '}
                *
              </span>
            </label>
            <Textarea
              id={reasonId}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              required
              aria-describedby={reasonError ? `${hintId} ${errorId}` : hintId}
              aria-invalid={reasonError ? true : undefined}
              placeholder="Why is this being done?"
            />
            <p id={hintId} className="text-xs text-content-muted">
              {reasonHint}
            </p>
            {reasonError ? (
              <p id={errorId} role="alert" className="text-xs font-medium text-danger">
                {reasonError}
              </p>
            ) : null}
          </div>
        ) : null}

        {error ? <ErrorNotice error={error} /> : null}
      </div>
    </Dialog>
  );
}

/**
 * State for one confirm dialog driving many rows.
 *
 * A list screen needs "which row is being archived" as well as "is the dialog open", and doing
 * that with two `useState`s in every screen is how the target and the dialog get out of step —
 * the dialog opens, the target is still `null`, and the confirm button archives nothing.
 *
 * ```tsx
 * const archive = useConfirm<Room>();
 * <Button onClick={() => archive.ask(room)}>Archive</Button>
 * <ConfirmDialog
 *   open={archive.isOpen}
 *   onClose={archive.close}
 *   title={`Archive ${archive.target?.nameEn ?? ''}?`}
 *   requireReason
 *   onConfirm={(reason) => mutation.mutateAsync({ id: archive.target!.id, reason })}
 * />
 * ```
 */
export function useConfirm<T>() {
  const [target, setTarget] = useState<T | null>(null);
  return {
    target,
    isOpen: target !== null,
    ask: (value: T) => setTarget(value),
    close: () => setTarget(null),
  };
}
