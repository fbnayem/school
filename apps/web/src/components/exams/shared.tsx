'use client';

/**
 * Small pieces the examination screens share.
 *
 * The arithmetic helper at the bottom is the one thing here worth reading carefully.
 */

import { Badge, Select, type BadgeTone, type SelectOption } from '@/components/ui';
import { humanize } from '@/lib/format';
import type { ExamStatus, ExamSubject, ExamSubjectRow, MarkEntryStatus } from './api';

// ── Status vocabulary ────────────────────────────────────────────────────────────────

/**
 * The exam lifecycle as a tone.
 *
 * `toneForStatus` from the kit already maps `draft`, `under_review`, `published` and
 * `archived`; the three states it has no opinion about are the exam-specific ones, and a
 * guessed colour would be worse than the neutral it falls back to. So the mapping is stated
 * here in full rather than half-delegated.
 */
const EXAM_STATUS_TONE: Record<ExamStatus, BadgeTone> = {
  draft: 'neutral',
  scheduled: 'info',
  ongoing: 'accent',
  marks_entry: 'warning',
  under_review: 'warning',
  published: 'success',
  archived: 'danger',
};

export function ExamStatusBadge({ status }: { status: ExamStatus }) {
  return <Badge tone={EXAM_STATUS_TONE[status] ?? 'neutral'}>{humanize(status)}</Badge>;
}

/**
 * Where one mark sits in the enter → submit → review → approve chain.
 *
 * The whole point of the marks screens is that this is never ambiguous, so the badge is
 * rendered on every row rather than only on the exceptional ones.
 */
const MARK_STATUS_TONE: Record<MarkEntryStatus, BadgeTone> = {
  draft: 'neutral',
  submitted: 'warning',
  approved: 'success',
};

const MARK_STATUS_LABEL: Record<MarkEntryStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  approved: 'Approved',
};

export function MarkStatusBadge({ status }: { status: MarkEntryStatus }) {
  return <Badge tone={MARK_STATUS_TONE[status]}>{MARK_STATUS_LABEL[status]}</Badge>;
}

/** The exam type enum, for filters and the create form. Mirrors `EXAM_TYPES`. */
export const EXAM_TYPE_OPTIONS: SelectOption[] = [
  { value: 'class_test', label: 'Class test' },
  { value: 'midterm', label: 'Midterm' },
  { value: 'half_yearly', label: 'Half yearly' },
  { value: 'annual', label: 'Annual' },
  { value: 'model_test', label: 'Model test' },
  { value: 'board_practice', label: 'Board practice' },
];

/** The full lifecycle, for the list filter. Mirrors `EXAM_STATUSES`. */
export const EXAM_STATUS_OPTIONS: SelectOption[] = [
  { value: 'draft', label: 'Draft' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'ongoing', label: 'Ongoing' },
  { value: 'marks_entry', label: 'Mark entry' },
  { value: 'under_review', label: 'Under review' },
  { value: 'published', label: 'Published' },
];

/**
 * The statuses `exams.manage` may set directly. Mirrors `EXAM_MANAGEABLE_STATUSES`.
 *
 * `under_review` and `published` are absent here for the same reason they are absent from the
 * schema: each is a separately permissioned act with its own audit record, and offering them
 * in a generic status menu would present "may schedule an exam" as "may publish results".
 */
export const EXAM_MANAGEABLE_STATUS_OPTIONS: SelectOption[] = [
  { value: 'draft', label: 'Draft' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'ongoing', label: 'Ongoing' },
  { value: 'marks_entry', label: 'Mark entry' },
];

// ── Paper components ─────────────────────────────────────────────────────────────────

export type ComponentKey = 'written' | 'mcq' | 'practical' | 'continuous';

export interface PaperComponent {
  key: ComponentKey;
  label: string;
  /** The field name on the mark row, and on the API's validation error paths. */
  markField: 'writtenMarks' | 'mcqMarks' | 'practicalMarks' | 'continuousMarks';
  fullMarks: string;
  /** Null when the component defines no threshold of its own. */
  passMarks: string | null;
}

const COMPONENT_LABEL: Record<ComponentKey, string> = {
  written: 'Written',
  mcq: 'MCQ',
  practical: 'Practical',
  continuous: 'Continuous',
};

/**
 * The components a paper actually assesses.
 *
 * A paper may declare any subset. When it declares none, the API's convention is that the
 * whole paper is marked out of its total **in the written column** — see
 * `ExamsService.validateComponents`, which rejects a mark in any other column for such a
 * paper. Reproducing that convention here rather than inventing a "Marks" field is what keeps
 * the grid's payload acceptable to the API on the first try.
 */
export function paperComponents(paper: ExamSubject): PaperComponent[] {
  const declared: Array<[ComponentKey, string | null, string | null]> = [
    ['written', paper.writtenFullMarks, paper.writtenPassMarks],
    ['mcq', paper.mcqFullMarks, paper.mcqPassMarks],
    ['practical', paper.practicalFullMarks, paper.practicalPassMarks],
    ['continuous', paper.continuousFullMarks, paper.continuousPassMarks],
  ];

  const present = declared.filter(([, fullMarks]) => fullMarks !== null);

  if (present.length === 0) {
    return [
      {
        key: 'written',
        label: 'Marks',
        markField: 'writtenMarks',
        fullMarks: paper.fullMarks,
        passMarks: paper.passMarks,
      },
    ];
  }

  return present.map(([key, fullMarks, passMarks]) => ({
    key,
    label: COMPONENT_LABEL[key],
    markField: `${key}Marks` as PaperComponent['markField'],
    fullMarks: fullMarks!,
    passMarks,
  }));
}

/** Papers for a `Select`, grouped by class level. */
export function paperOptions(rows: ExamSubjectRow[]): SelectOption[] {
  return rows.map((row) => ({
    value: row.examSubject.id,
    label: `${row.subjectNameEn} (${row.subjectCode})`,
    hint: row.subjectNameBn ?? undefined,
    // Consecutive options sharing `group` become an <optgroup>; the API already orders
    // subjects by class-level ordinal, so the groups come out contiguous.
    group: row.classLevelNameEn,
  }));
}

// ── Marks as text ────────────────────────────────────────────────────────────────────

/**
 * A marks value for display: `"75.00"` → `"75"`, `"75.50"` → `"75.5"`.
 *
 * Pure string work, exactly like `formatMoney`. `Number(value)` would round-trip most values
 * correctly and quietly ruin the rest, and these numbers end up on a printed marksheet.
 */
export function formatMarks(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const [whole = '0', fraction = ''] = value.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : whole;
}

/** `"75.00"` out of `"100.00"` → `"75 / 100"`. */
export function formatOutOf(obtained: string | null, full: string): string {
  return `${formatMarks(obtained)} / ${formatMarks(full)}`;
}

/**
 * A decimal string as exact integer hundredths.
 *
 * The same conversion `@shikkha/validation` performs, and for the same reason:
 * `Number("33.33") * 100` is `3332.9999999999995`, so any comparison built on it is a coin
 * flip at the boundary. Splitting on the decimal point is exact.
 *
 * Returns `null` for anything that is not a plain decimal, so a half-typed cell does not
 * throw mid-keystroke.
 */
export function hundredths(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole = '0', fraction = ''] = trimmed.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0').slice(0, 2));
}

/**
 * A labelled exam picker.
 *
 * Its own component because three result screens need the identical control, and because the
 * empty case has to say something true — "no exams match" rather than an empty menu that
 * looks broken.
 */
export function ExamPicker({
  id,
  label,
  value,
  onChange,
  options,
  isLoading,
  emptyHint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  isLoading?: boolean;
  emptyHint?: string;
}) {
  return (
    <div className="w-full sm:max-w-md">
      <label htmlFor={id} className="label">
        {label}
      </label>
      <Select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        options={options}
        placeholder={isLoading ? 'Loading exams…' : (emptyHint ?? 'Choose an exam')}
        allowEmpty
        disabled={isLoading || options.length === 0}
      />
    </div>
  );
}
