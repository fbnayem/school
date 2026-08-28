/**
 * Status pill.
 *
 * Extracted into its own module rather than exported from a page: a page module in the App
 * Router carries route metadata and a `'use client'` boundary, and importing it from another
 * page drags that along. Shared UI belongs in `components`.
 *
 * Colour is not the only signal — the label always reads as words too, because roughly 1 in 12
 * men has a colour vision deficiency and "the red one" is not a usable instruction.
 */
export function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'active'
      ? 'bg-success-subtle text-success'
      : status === 'archived' || status === 'withdrawn' || status === 'transferred'
        ? 'bg-danger-subtle text-danger'
        : status === 'on_leave'
          ? 'bg-warning-subtle text-warning'
          : 'bg-surface-muted text-content-muted';

  return <span className={`badge ${tone}`}>{status.replace(/_/g, ' ')}</span>;
}
