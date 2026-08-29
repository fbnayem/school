'use client';

/**
 * Dialog: a modal, written rather than installed.
 *
 * What it does, all of which is required for a modal to be usable without a mouse:
 *
 *  - **Focus moves in on open** — to the first focusable control, or to the panel itself when
 *    there is none, so the screen reader starts reading the dialog rather than the page behind.
 *  - **Focus is trapped** — Tab and Shift+Tab cycle within the panel.
 *  - **Escape closes**, and so does a click on the backdrop (opt-out for a form with unsaved
 *    input, where a stray click should not throw the work away).
 *  - **Focus is restored** to the element that opened it. Without this, closing a dialog from
 *    a row action dumps the keyboard user back at the top of the document and they have to tab
 *    through the whole table again.
 *  - **The background does not scroll** while it is open.
 *  - **It is labelled by its title**, via a generated id.
 *
 * What a library (Radix, Headless UI, `<dialog>` + polyfill) would have given us that this does
 * not — worth knowing before someone assumes it is covered:
 *
 *  - `inert`/`aria-hidden` on the rest of the document, so a screen reader's virtual cursor
 *    cannot leave the dialog by arrowing rather than tabbing. Our trap only holds for Tab.
 *  - Robust iOS scroll locking (`overflow: hidden` on `body` is defeated by Safari's rubber
 *    banding in some versions).
 *  - Focus sentinels that survive a focusable element being removed while focused.
 *  - Coordinated stacking for three-deep nesting, and animation-aware unmounting.
 *
 * We are two levels deep at most and every dialog here is a form or a confirmation, so the gap
 * is acceptable. If the product grows a dialog that opens a dialog that opens a popover, that
 * is the moment to reach for the library rather than extend this.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';
import { IconButton } from './button';

/** Elements that can hold focus. Excludes anything a user cannot actually reach. */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * How many dialogs are currently open.
 *
 * Module-level rather than per-component because scroll lock is a document-wide effect: the
 * inner of two nested dialogs closing must not unlock the page while the outer is still up.
 */
let openDialogCount = 0;
let restoreBodyStyle: { overflow: string; paddingRight: string } | null = null;

function lockBodyScroll() {
  openDialogCount += 1;
  if (openDialogCount > 1) return;
  const { body } = document;
  restoreBodyStyle = { overflow: body.style.overflow, paddingRight: body.style.paddingRight };
  // Compensating for the scrollbar's width stops the page shifting sideways as it locks, which
  // otherwise makes every dialog open with a visible jolt.
  const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
  if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`;
  body.style.overflow = 'hidden';
}

function unlockBodyScroll() {
  openDialogCount = Math.max(0, openDialogCount - 1);
  if (openDialogCount > 0 || !restoreBodyStyle) return;
  document.body.style.overflow = restoreBodyStyle.overflow;
  document.body.style.paddingRight = restoreBodyStyle.paddingRight;
  restoreBodyStyle = null;
}

export type DialogSize = 'sm' | 'md' | 'lg';

const SIZE_CLASS: Record<DialogSize, string> = {
  sm: 'sm:max-w-sm',
  md: 'sm:max-w-lg',
  lg: 'sm:max-w-3xl',
};

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  /** A sentence under the title. Wired to `aria-describedby`, so keep it meaningful. */
  description?: React.ReactNode;
  children?: React.ReactNode;
  /** The button row, pinned below the scrollable body. */
  footer?: React.ReactNode;
  size?: DialogSize;
  /**
   * Set `false` on a dialog holding unsaved input: a mis-aimed click outside should not discard
   * what someone spent two minutes typing. Escape still closes.
   */
  closeOnBackdropClick?: boolean;
  /** Hides the × button. The dialog must then be closable some other way. */
  hideCloseButton?: boolean;
  className?: string;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  closeOnBackdropClick = true,
  hideCloseButton = false,
  className,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const reactId = useId();
  const titleId = `${reactId}-title`;
  const descriptionId = `${reactId}-description`;

  // `createPortal` needs a DOM node, which does not exist during the server render. Mounting is
  // tracked rather than checking `typeof window` so the first client render matches the server's
  // (nothing), and React does not report a hydration mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Held in a ref so the keydown listener does not need re-attaching when the parent re-renders
  // with a new closure — a re-attach on every keystroke in a dialog form is a real cost.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    previouslyFocused.current = document.activeElement as HTMLElement | null;
    lockBodyScroll();

    // Deferred a frame: the panel's children must be in the DOM before we can find the first
    // focusable one inside them.
    const focusTimer = window.setTimeout(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const first = panel.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panel).focus();
    }, 0);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const panel = panelRef.current;
      if (!panel) return;
      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        // `offsetParent === null` catches `display: none`; a hidden control in the tab order is
        // a focus black hole the user cannot see or escape.
        (element) => element.offsetParent !== null || element === document.activeElement,
      );
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;

      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    // Capture phase: a keystroke inside an input must reach this before the input's own handler
    // can stop it, or Escape stops working in a field with autocomplete.
    document.addEventListener('keydown', onKeyDown, true);

    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKeyDown, true);
      unlockBodyScroll();
      // Restore focus to the trigger. Guarded because the trigger may itself have been removed
      // — a row's delete button vanishing with the row it deleted.
      const target = previouslyFocused.current;
      if (target && document.contains(target)) target.focus();
    };
  }, [open]);

  const onBackdropMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      // `mousedown` on the backdrop itself, not a click: a drag that starts inside the panel and
      // ends on the backdrop (selecting text past the edge) would otherwise close the dialog.
      if (!closeOnBackdropClick) return;
      if (event.target === event.currentTarget) onClose();
    },
    [closeOnBackdropClick, onClose],
  );

  if (!open || !mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-slate-900/50 p-0 sm:items-center sm:p-4"
      onMouseDown={onBackdropMouseDown}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        // Focusable as a fallback target so the dialog can receive focus when it holds no
        // controls at all; -1 keeps it out of the tab sequence.
        tabIndex={-1}
        className={cn(
          // Bottom sheet on a phone, centred panel from `sm` up. A centred 400px box on a
          // 375px screen leaves the confirm button under the thumb of nobody.
          'flex max-h-[92vh] w-full flex-col rounded-t-lg bg-surface-raised shadow-popover',
          'sm:max-h-[85vh] sm:rounded-lg',
          SIZE_CLASS[size],
          className,
        )}
      >
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-lg font-semibold tracking-tight">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="mt-1 text-sm text-content-muted">
                {description}
              </p>
            ) : null}
          </div>
          {hideCloseButton ? null : (
            <IconButton
              variant="ghost"
              size="sm"
              label="Close dialog"
              onClick={onClose}
              className="-mr-1.5 -mt-1"
              icon={
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="m6 6 12 12M18 6 6 18" />
                </svg>
              }
            />
          )}
        </div>

        {children ? <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div> : null}

        {footer ? (
          <div className="flex flex-col-reverse gap-2 border-t border-line px-5 py-3.5 sm:flex-row sm:justify-end [&>*]:w-full sm:[&>*]:w-auto">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
