/**
 * Badge.
 *
 * Colour is never the only signal — every badge carries a word. Around one man in twelve has a
 * colour vision deficiency, and "the amber one" is not an instruction anyone can follow.
 *
 * Server-compatible: no hooks, no handlers.
 */

import { cn } from '@/lib/cn';

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent';

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: 'bg-surface-muted text-content-muted',
  success: 'bg-success-subtle text-success',
  warning: 'bg-warning-subtle text-warning',
  danger: 'bg-danger-subtle text-danger',
  info: 'bg-info-subtle text-info',
  accent: 'bg-accent-50 text-accent-800',
};

export function Badge({
  tone = 'neutral',
  children,
  className,
  /** A leading dot, for a dense table where the word alone is easy to skim past. */
  dot = false,
}: {
  tone?: BadgeTone;
  children: React.ReactNode;
  className?: string;
  dot?: boolean;
}) {
  return (
    <span className={cn('badge gap-1', TONE_CLASS[tone], className)}>
      {dot ? (
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
      ) : null}
      {children}
    </span>
  );
}

/**
 * The tone for a status value, shared so two screens cannot disagree about whether `suspended`
 * is a warning or a failure.
 *
 * The vocabulary is the union of the status enums across the API's modules — statuses that do
 * not appear here fall back to neutral, which is the honest rendering of "we have no opinion"
 * rather than a guessed colour.
 */
export function toneForStatus(status: string): BadgeTone {
  switch (status) {
    case 'active':
    case 'approved':
    case 'published':
    case 'paid':
    case 'present':
    case 'completed':
    case 'posted':
    case 'issued':
    case 'confirmed':
    case 'passed':
    case 'reconciled':
      return 'success';
    case 'pending':
    case 'draft':
    case 'submitted':
    case 'on_leave':
    case 'partial':
    case 'partially_paid':
    case 'late':
    case 'overdue':
    case 'under_review':
    case 'reserved':
      return 'warning';
    case 'archived':
    case 'cancelled':
    case 'rejected':
    case 'void':
    case 'voided':
    case 'failed':
    case 'absent':
    case 'withdrawn':
    case 'transferred':
    case 'expelled':
    case 'suspended':
    case 'expired':
    case 'lost':
      return 'danger';
    case 'scheduled':
    case 'in_progress':
    case 'processing':
    case 'excused':
      return 'info';
    default:
      return 'neutral';
  }
}
