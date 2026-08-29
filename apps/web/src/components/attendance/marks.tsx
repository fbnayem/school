/**
 * The register's vocabulary, in one place.
 *
 * `ATTENDANCE_MARK_STATUSES` is imported from `@shikkha/validation` rather than retyped: it is
 * the same tuple the API validates against and the database constrains, so a status this file
 * knows about is a status the API will accept. Adding a sixth mark upstream then shows up here
 * as a missing label at compile time instead of as a blank badge at runtime.
 *
 * The tone map is spelled out rather than delegated to `toneForStatus`, which has no opinion on
 * `half_day` and would fall back to neutral — a half day rendered in the same grey as "no mark
 * recorded" is the one case where a teacher scanning a register cannot tell the difference.
 */

import { ATTENDANCE_MARK_STATUSES, type AttendanceMarkStatus } from '@shikkha/validation';
import { Badge, type BadgeTone, type RadioOption, type SelectOption } from '@/components/ui';

export const MARK_STATUSES: readonly AttendanceMarkStatus[] = ATTENDANCE_MARK_STATUSES;

/** The statuses that carry an arrival delay. The API rejects `minutesLate` on any other. */
export const LATE_STATUSES: readonly AttendanceMarkStatus[] = ['late', 'half_day'];

export function acceptsMinutesLate(status: string | null | undefined): boolean {
  return status === 'late' || status === 'half_day';
}

const MARK_LABEL: Record<AttendanceMarkStatus, string> = {
  present: 'Present',
  absent: 'Absent',
  late: 'Late',
  excused: 'Excused',
  half_day: 'Half day',
};

/** What each mark means for the attendance percentage the API computes. Shown as radio hints. */
const MARK_HINT: Record<AttendanceMarkStatus, string> = {
  present: 'Counts as attended',
  absent: 'Counts against attendance',
  late: 'Counts as attended',
  excused: 'Authorised; not counted either way',
  half_day: 'Counts as half attended',
};

const MARK_TONE: Record<AttendanceMarkStatus, BadgeTone> = {
  present: 'success',
  absent: 'danger',
  late: 'warning',
  excused: 'info',
  half_day: 'accent',
};

export function markLabel(status: string | null | undefined): string {
  if (!status) return 'Not marked';
  return MARK_LABEL[status as AttendanceMarkStatus] ?? status.replace(/_/g, ' ');
}

export function markTone(status: string | null | undefined): BadgeTone {
  if (!status) return 'neutral';
  return MARK_TONE[status as AttendanceMarkStatus] ?? 'neutral';
}

/** A one-word badge. Colour is never the only signal — the word is always there too. */
export function MarkBadge({ status }: { status: string | null | undefined }) {
  return <Badge tone={markTone(status)}>{markLabel(status)}</Badge>;
}

/** Radio choices for taking a register. Hints explain what the mark does to the percentage. */
export const MARK_RADIO_OPTIONS: RadioOption[] = MARK_STATUSES.map((status) => ({
  value: status,
  label: MARK_LABEL[status],
  hint: MARK_HINT[status],
}));

/** The same choices without hints, for a compact dialog where the column is narrow. */
export const MARK_RADIO_OPTIONS_PLAIN: RadioOption[] = MARK_STATUSES.map((status) => ({
  value: status,
  label: MARK_LABEL[status],
}));

export const MARK_SELECT_OPTIONS: SelectOption[] = MARK_STATUSES.map((status) => ({
  value: status,
  label: MARK_LABEL[status],
}));

const SESSION_TONE: Record<string, BadgeTone> = {
  open: 'info',
  submitted: 'success',
  locked: 'accent',
};

const SESSION_LABEL: Record<string, string> = {
  open: 'Open',
  submitted: 'Submitted',
  locked: 'Locked',
};

/**
 * The register's own state. `null` means no register exists for that section and date yet —
 * which is a different thing from an empty one, and the badge says so rather than showing
 * nothing.
 */
export function RegisterStatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <Badge tone="neutral">Not opened</Badge>;
  return (
    <Badge tone={SESSION_TONE[status] ?? 'neutral'}>{SESSION_LABEL[status] ?? status}</Badge>
  );
}

export const SESSION_STATUS_OPTIONS: SelectOption[] = [
  { value: 'open', label: 'Open — still being taken' },
  { value: 'submitted', label: 'Submitted — signed off' },
  { value: 'locked', label: 'Locked — closed for reporting' },
];

export const CORRECTION_STATUS_OPTIONS: SelectOption[] = [
  { value: 'pending', label: 'Awaiting a decision' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

/**
 * Why a register cannot be edited, in the words a teacher needs.
 *
 * `null` means it is editable. The API is the boundary and re-checks all of this; this string
 * exists so the screen can explain itself instead of producing a 409 the user cannot act on.
 */
export function lockExplanation(status: AttendanceMarkStatus | string): string | null {
  if (status === 'locked') {
    return 'This register is locked for the reporting period. Marks cannot be changed, and corrections cannot be applied to it.';
  }
  if (status === 'submitted') {
    return 'This register has been submitted. Marks are no longer edited directly — request a correction, which an approver reviews before it is applied.';
  }
  return null;
}
