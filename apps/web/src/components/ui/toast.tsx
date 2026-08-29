'use client';

/**
 * Toasts.
 *
 * For the outcome of an action the user just took — "Payment recorded", "Could not publish the
 * timetable". Not for loading, not for validation (that belongs on the field), and never for
 * anything the user must read: a toast that carries the only copy of an important message is a
 * message you have decided some users will miss.
 *
 * Accessibility notes worth keeping:
 *
 *  - The region is a **persistent live region**, mounted empty from the start. A live region
 *    that is added to the DOM at the same moment as its content is frequently not announced at
 *    all — the screen reader has nothing registered to watch.
 *  - Success and info are `polite` (they wait for a pause); errors carry `role="alert"`, which
 *    is assertive, because an action that failed is worth interrupting for.
 *  - Auto-dismiss **pauses on hover and on focus**. A request id that disappears while it is
 *    being copied into a support ticket is worse than no request id.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';

export type ToastVariant = 'success' | 'error' | 'info';

export interface ToastOptions {
  title: string;
  /** A second line. For an error this is where the request id goes. */
  description?: string;
  variant?: ToastVariant;
  /** Milliseconds before auto-dismiss. `0` means it stays until dismissed. */
  duration?: number;
}

interface ToastRecord extends Required<Omit<ToastOptions, 'description'>> {
  id: string;
  description?: string;
}

interface ToastApi {
  toast: (options: ToastOptions) => string;
  success: (title: string, description?: string) => string;
  info: (title: string, description?: string) => string;
  /**
   * Report a failure. Given an `ApiError` it shows the API's own message and, on a second line,
   * the request id — the thing that turns "it broke" into a ticket support can resolve.
   */
  error: (error: unknown, title?: string) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const DEFAULT_DURATION: Record<ToastVariant, number> = {
  success: 5000,
  info: 6000,
  // Longer, because it usually carries a request id and a next step.
  error: 12000,
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback((options: ToastOptions) => {
    counter.current += 1;
    const id = `toast-${counter.current}`;
    const variant = options.variant ?? 'info';
    setToasts((current) => {
      const next: ToastRecord = {
        id,
        title: options.title,
        description: options.description,
        variant,
        duration: options.duration ?? DEFAULT_DURATION[variant],
      };
      // Cap the stack. Six toasts on screen is not information, it is wallpaper — and on a
      // phone they would cover the content the user is trying to act on.
      return [...current, next].slice(-4);
    });
    return id;
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      toast: push,
      success: (title, description) => push({ title, description, variant: 'success' }),
      info: (title, description) => push({ title, description, variant: 'info' }),
      error: (error, title) => {
        const apiError = error instanceof ApiError ? error : null;
        return push({
          title: title ?? (apiError ? apiError.message : 'Something went wrong'),
          description: apiError
            ? apiError.requestId
              ? `Reference: ${apiError.requestId}`
              : undefined
            : 'Could not reach the server. Check your connection and try again.',
          variant: 'error',
        });
      },
      dismiss,
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/*
        Mounted unconditionally and empty, so assistive technology is watching it before the
        first toast arrives. `pointer-events-none` on the wrapper lets clicks pass through the
        empty space; each toast turns them back on for itself.
      */}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:inset-x-auto sm:right-0 sm:items-end"
      >
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) {
    // Loud rather than silent. A no-op fallback would mean an error toast that never appears,
    // and a user who believes a failed save succeeded.
    throw new Error('useToast must be used inside a ToastProvider');
  }
  return context;
}

const VARIANT_CLASS: Record<ToastVariant, string> = {
  success: 'border-success/30 bg-success-subtle text-success',
  error: 'border-danger/30 bg-danger-subtle text-danger',
  info: 'border-info/30 bg-info-subtle text-info',
};

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: ToastRecord;
  onDismiss: (id: string) => void;
}) {
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (toast.duration <= 0 || paused) return;
    const timer = window.setTimeout(() => onDismiss(toast.id), toast.duration);
    return () => window.clearTimeout(timer);
    // Re-running on `paused` restarts the full duration rather than resuming the remainder.
    // Generous by design: someone who hovered was reading it.
  }, [toast.duration, toast.id, paused, onDismiss]);

  return (
    <div
      // Errors interrupt; the others wait for a pause in whatever is being read.
      role={toast.variant === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className={cn(
        'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-md border px-3.5 py-3 shadow-popover',
        VARIANT_CLASS[toast.variant],
      )}
    >
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium">{toast.title}</p>
        {toast.description ? (
          <p className="mt-0.5 break-words font-mono text-xs opacity-80">{toast.description}</p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
        className="-mr-1 -mt-0.5 rounded p-1 opacity-70 transition-opacity hover:opacity-100"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
  );
}
