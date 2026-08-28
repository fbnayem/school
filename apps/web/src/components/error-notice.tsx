'use client';

import { ApiError } from '@/lib/api';

/**
 * Error display.
 *
 * Shows the API's user-facing message and the request id, because the id is what turns "it
 * broke" into a support ticket someone can actually resolve. Stack traces and internal detail
 * never reach here — the API strips them before the response leaves the server.
 */
export function ErrorNotice({ error }: { error: unknown }) {
  const apiError = error instanceof ApiError ? error : null;

  const message = apiError
    ? apiError.message
    : 'Could not reach the server. Check your connection and try again.';

  return (
    <div
      role="alert"
      className="rounded border border-danger/30 bg-danger-subtle px-4 py-3 text-sm text-danger"
    >
      <p className="font-medium">{message}</p>
      {apiError?.requestId ? (
        <p className="mt-1 font-mono text-xs opacity-75">Reference: {apiError.requestId}</p>
      ) : null}
      {apiError?.status === 403 ? (
        <p className="mt-1.5 text-xs opacity-90">
          If you believe you should have access, ask your school administrator to check your role.
        </p>
      ) : null}
    </div>
  );
}
