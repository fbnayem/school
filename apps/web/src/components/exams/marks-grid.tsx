'use client';

/**
 * The mark-entry grid for one paper and one section.
 *
 * Why this is not a `DataTable`: every cell is an input, the row state is edited before it is
 * saved, and a save is a single transaction across the whole grid. `DataTable` renders read
 * rows; bending it into an editable grid would give us neither. The responsive rule is still
 * the house one and is implemented the same way — a real `<table>` from `sm`, a card per
 * student below it, because a 60-row × 5-column table at 375px is not usable and teachers do
 * enter marks on phones.
 *
 * Three things this screen has to make unmistakable, because they are what the lifecycle is:
 *
 *  1. **What the paper is out of.** Full marks and pass marks are shown per component and for
 *     the paper, in the header and again on each card.
 *  2. **Which rows are locked.** A submitted or approved mark is not editable here. Re-sending
 *     a submitted mark would pull it back to draft (see `ExamsService.enterMarks`), and an
 *     approved one is refused outright and needs `results.correct` with a reason. Locked rows
 *     are therefore rendered read-only and excluded from the payload entirely.
 *  3. **What is wrong, and where.** Out-of-range and malformed values are caught before the
 *     request, against the same `enterExamMarksSchema` the API parses the body with, and the
 *     message lands on the cell rather than in a banner that names no student.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { enterExamMarksSchema } from '@shikkha/validation';
import type { StudentSummary } from '@/lib/api';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/cn';
import {
  BilingualName,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  ErrorNotice,
  Input,
  useToast,
} from '@/components/ui';
import { examsApi, type ExamDetail, type ExamMarkRow, type ExamSubjectRow } from './api';
import {
  MarkStatusBadge,
  formatMarks,
  hundredths,
  paperComponents,
  type ComponentKey,
  type PaperComponent,
} from './shared';

type DraftValues = Record<ComponentKey, string>;

interface DraftRow {
  values: DraftValues;
  isAbsent: boolean;
  remarks: string;
}

const EMPTY_VALUES: DraftValues = { written: '', mcq: '', practical: '', continuous: '' };

function emptyRow(): DraftRow {
  return { values: { ...EMPTY_VALUES }, isAbsent: false, remarks: '' };
}

/** Seed a draft row from a mark the API already holds, so editing resumes where it stopped. */
function rowFromMark(mark: ExamMarkRow['mark']): DraftRow {
  return {
    values: {
      written: mark.writtenMarks ?? '',
      mcq: mark.mcqMarks ?? '',
      practical: mark.practicalMarks ?? '',
      continuous: mark.continuousMarks ?? '',
    },
    isAbsent: mark.isAbsent,
    remarks: mark.remarks ?? '',
  };
}

export function MarksGrid({
  exam,
  paper,
  sectionId,
  roster,
  rosterTotal,
  marks,
  /** Changes whenever the marks query has produced a new snapshot; reseeds the drafts. */
  marksVersion,
  canEnter,
  canSubmit,
}: {
  exam: ExamDetail;
  paper: ExamSubjectRow;
  sectionId: string;
  roster: StudentSummary[];
  rosterTotal: number;
  marks: ExamMarkRow[];
  marksVersion: number;
  canEnter: boolean;
  canSubmit: boolean;
}) {
  const session = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();

  const components = useMemo(() => paperComponents(paper.examSubject), [paper.examSubject]);
  const markByStudent = useMemo(
    () => new Map(marks.map((row) => [row.mark.studentId, row])),
    [marks],
  );

  const [drafts, setDrafts] = useState<Record<string, DraftRow>>({});
  const [cellErrors, setCellErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const seeded = useRef<string>('');

  // Reseed only when the paper, the section or the saved snapshot changes — never on a
  // background refetch, which would delete a teacher's half-typed column under their hands.
  const seedKey = `${paper.examSubject.id}:${sectionId}:${marksVersion}`;
  useEffect(() => {
    if (seeded.current === seedKey) return;
    seeded.current = seedKey;
    const next: Record<string, DraftRow> = {};
    for (const student of roster) {
      const existing = markByStudent.get(student.id);
      next[student.id] = existing ? rowFromMark(existing.mark) : emptyRow();
    }
    setDrafts(next);
    setCellErrors({});
  }, [seedKey, roster, markByStudent]);

  const isLocked = (studentId: string): boolean => {
    const status = markByStudent.get(studentId)?.mark.status;
    return status === 'submitted' || status === 'approved';
  };

  const editable = canEnter && exam.status === 'marks_entry';

  const setValue = (studentId: string, key: ComponentKey, value: string) => {
    setDrafts((current) => {
      const row = current[studentId] ?? emptyRow();
      return { ...current, [studentId]: { ...row, values: { ...row.values, [key]: value } } };
    });
    setCellErrors((current) => {
      const { [`${studentId}.${key}`]: _cleared, ...rest } = current;
      return rest;
    });
  };

  const setAbsent = (studentId: string, isAbsent: boolean) => {
    setDrafts((current) => {
      const row = current[studentId] ?? emptyRow();
      // An absent candidate carries no marks — the same rule as the check constraint and the
      // schema refinement. Clearing here means the teacher never has to undo it by hand.
      return {
        ...current,
        [studentId]: { ...row, isAbsent, values: isAbsent ? { ...EMPTY_VALUES } : row.values },
      };
    });
  };

  const setRemarks = (studentId: string, remarks: string) => {
    setDrafts((current) => {
      const row = current[studentId] ?? emptyRow();
      return { ...current, [studentId]: { ...row, remarks } };
    });
  };

  const save = useMutation({
    mutationFn: async () => {
      const errors: Record<string, string> = {};
      const rows: Array<{ studentId: string; row: DraftRow }> = [];

      for (const student of roster) {
        if (isLocked(student.id)) continue;
        const row = drafts[student.id];
        if (!row) continue;
        const hasValue = components.some((component) => row.values[component.key].trim() !== '');
        if (!hasValue && !row.isAbsent) continue;
        rows.push({ studentId: student.id, row });

        // Range: exact integer hundredths, never `Number(value) * 100`. This mirrors
        // `ExamsService.validateComponents`; the API remains the authority and re-checks it,
        // but catching it here means a teacher fixes one cell instead of losing a screenful.
        let total = 0;
        for (const component of components) {
          const raw = row.values[component.key].trim();
          if (raw === '') continue;
          const value = hundredths(raw);
          const ceiling = hundredths(component.fullMarks);
          if (value === null) {
            errors[`${student.id}.${component.key}`] = 'Enter a number with at most two decimals';
            continue;
          }
          if (ceiling !== null && value > ceiling) {
            errors[`${student.id}.${component.key}`] =
              `Enter at most ${formatMarks(component.fullMarks)}`;
            continue;
          }
          total += value;
        }
        const paperCeiling = hundredths(paper.examSubject.fullMarks);
        if (paperCeiling !== null && total > paperCeiling) {
          errors[`${student.id}.${components[0]!.key}`] =
            `The components total more than ${formatMarks(paper.examSubject.fullMarks)}`;
        }
      }

      const payload = {
        examSubjectId: paper.examSubject.id,
        marks: rows.map(({ studentId, row }) => ({
          studentId,
          ...Object.fromEntries(
            components
              .filter((component) => row.values[component.key].trim() !== '')
              .map((component) => [component.markField, row.values[component.key].trim()]),
          ),
          isAbsent: row.isAbsent,
          ...(row.remarks.trim() ? { remarks: row.remarks.trim() } : {}),
        })),
      };

      // The same schema the API parses the body with, so a rule can never hold on one side
      // only. Its issue paths are `marks.<index>.<field>`, which map straight back onto cells.
      const parsed = enterExamMarksSchema.safeParse(payload);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          const [, indexPart, field] = issue.path;
          const index = typeof indexPart === 'number' ? indexPart : Number(indexPart);
          const entry = rows[index];
          if (!entry) continue;
          const key = componentKeyForField(String(field), components);
          errors[`${entry.studentId}.${key ?? 'row'}`] = issue.message;
        }
        // An issue on a path with no cell to sit next to — a whole-array rule, say — would
        // otherwise leave `errors` empty and send an unvalidated body. Surface the schema's
        // own message instead of guessing where it belongs.
        if (Object.keys(errors).length === 0) {
          throw new Error(
            parsed.error.issues[0]?.message ?? 'These marks were rejected before sending.',
          );
        }
      }

      if (Object.keys(errors).length > 0) {
        setCellErrors(errors);
        throw new Error(
          `${Object.keys(errors).length} entr${Object.keys(errors).length === 1 ? 'y is' : 'ies are'} out of range or malformed. The highlighted cells explain why.`,
        );
      }

      if (payload.marks.length === 0) {
        throw new Error('Nothing to save yet — enter a mark, or mark a student absent.');
      }

      setCellErrors({});
      return examsApi.enterMarks(session.institutionId!, exam.id, parsed.data!);
    },
    onSuccess: (result) => {
      toast.success(
        `${result.saved} mark${result.saved === 1 ? '' : 's'} saved`,
        'They stay in draft until the paper is submitted for review.',
      );
      void queryClient.invalidateQueries({ queryKey: ['exams', exam.id, 'marks'] });
    },
    onError: (error) => toast.error(error),
  });

  const submit = useMutation({
    mutationFn: () =>
      examsApi.submitMarks(session.institutionId!, exam.id, {
        examSubjectId: paper.examSubject.id,
        sectionId,
      }),
    onSuccess: (result) => {
      setSubmitting(false);
      toast.success(
        `${result.submitted} mark${result.submitted === 1 ? '' : 's'} submitted`,
        'They are now locked to you and waiting for review.',
      );
      void queryClient.invalidateQueries({ queryKey: ['exams', exam.id, 'marks'] });
    },
  });

  if (roster.length === 0) {
    return (
      <EmptyState
        title="No active students in this section"
        description="Marks are entered against the live enrolment for the exam's academic year. If students are expected here, check their enrolment first."
      />
    );
  }

  const truncated = rosterTotal > roster.length;
  const errorCount = Object.keys(cellErrors).length;

  return (
    <div className="space-y-4">
      {truncated ? (
        <p role="status" className="rounded-md bg-warning-subtle px-3 py-2 text-sm text-warning">
          Showing the first {roster.length} of {rosterTotal} students in this section. Marks for the
          rest cannot be entered here — contact support with this section's id.
        </p>
      ) : null}

      {!editable ? (
        <p
          role="status"
          className="rounded-md bg-surface-muted px-3 py-2 text-sm text-content-muted"
        >
          {canEnter
            ? `Marks can only be entered while the exam is in mark entry. This exam is ${exam.status.replace(/_/g, ' ')}.`
            : 'You can see these marks but not change them — entering marks needs the results.enter_marks permission.'}
        </p>
      ) : null}

      {errorCount > 0 ? (
        <p
          role="alert"
          className="rounded-md bg-danger-subtle px-3 py-2 text-sm font-medium text-danger"
        >
          {errorCount} {errorCount === 1 ? 'entry needs' : 'entries need'} attention. Each is
          highlighted below with the reason.
        </p>
      ) : null}

      {save.error && errorCount === 0 ? <ErrorNotice error={save.error} /> : null}

      {/* Desktop and tablet: a real table. */}
      <div className="card hidden overflow-hidden sm:block">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[48rem] text-sm">
            <caption className="sr-only">
              Mark entry for {paper.subjectNameEn}, {paper.classLevelNameEn}. Full marks{' '}
              {formatMarks(paper.examSubject.fullMarks)}, pass marks{' '}
              {formatMarks(paper.examSubject.passMarks)}.
            </caption>
            <thead className="border-b border-line bg-surface-muted text-left">
              <tr>
                <th scope="col" className="px-3 py-2.5 font-medium text-content-muted">
                  Student
                </th>
                {components.map((component) => (
                  <th
                    key={component.key}
                    scope="col"
                    className="px-3 py-2.5 text-right font-medium text-content-muted"
                  >
                    <span className="block">{component.label}</span>
                    <span className="block text-xs font-normal">
                      out of {formatMarks(component.fullMarks)}
                      {component.passMarks ? ` · pass ${formatMarks(component.passMarks)}` : ''}
                    </span>
                  </th>
                ))}
                <th scope="col" className="px-3 py-2.5 text-center font-medium text-content-muted">
                  Absent
                </th>
                <th scope="col" className="px-3 py-2.5 font-medium text-content-muted">
                  Remarks
                </th>
                <th scope="col" className="px-3 py-2.5 font-medium text-content-muted">
                  State
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {roster.map((student) => {
                const row = drafts[student.id] ?? emptyRow();
                const existing = markByStudent.get(student.id);
                const locked = isLocked(student.id);
                return (
                  <tr key={student.id} className={cn(locked && 'bg-surface-muted/60')}>
                    <th scope="row" className="px-3 py-2 text-left font-normal">
                      <BilingualName row={student} />
                      <span className="block font-mono text-xs text-content-subtle">
                        {student.studentCode}
                      </span>
                    </th>
                    {components.map((component) => (
                      <td key={component.key} className="px-3 py-2 text-right align-top">
                        <MarkCell
                          student={student}
                          component={component}
                          value={row.values[component.key]}
                          onChange={(value) => setValue(student.id, component.key, value)}
                          disabled={!editable || locked || row.isAbsent}
                          error={cellErrors[`${student.id}.${component.key}`]}
                        />
                      </td>
                    ))}
                    <td className="px-3 py-2 text-center align-top">
                      <Checkbox
                        checked={row.isAbsent}
                        disabled={!editable || locked}
                        onChange={(event) => setAbsent(student.id, event.target.checked)}
                        aria-label={`Mark ${student.fullNameEn} absent`}
                      />
                    </td>
                    <td className="px-3 py-2 align-top">
                      <Input
                        value={row.remarks}
                        disabled={!editable || locked}
                        maxLength={500}
                        onChange={(event) => setRemarks(student.id, event.target.value)}
                        aria-label={`Remarks for ${student.fullNameEn}`}
                        className="min-w-[8rem]"
                      />
                    </td>
                    <td className="px-3 py-2 align-top">
                      {existing ? (
                        <MarkStatusBadge status={existing.mark.status} />
                      ) : (
                        <span className="text-xs text-content-subtle">Not entered</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Phone: one card per student. */}
      <ul className="space-y-3 sm:hidden">
        {roster.map((student) => {
          const row = drafts[student.id] ?? emptyRow();
          const existing = markByStudent.get(student.id);
          const locked = isLocked(student.id);
          return (
            <li key={student.id}>
              <Card as="article">
                <CardHeader
                  headingLevel="h3"
                  title={<BilingualName row={student} layout="stacked" />}
                  description={student.studentCode}
                  actions={
                    existing ? (
                      <MarkStatusBadge status={existing.mark.status} />
                    ) : (
                      <span className="text-xs text-content-subtle">Not entered</span>
                    )
                  }
                />
                <CardBody padded className="space-y-3">
                  {components.map((component) => (
                    <div key={component.key} className="flex items-start justify-between gap-3">
                      <div className="pt-1.5 text-sm">
                        <span className="font-medium">{component.label}</span>
                        <span className="block text-xs text-content-muted">
                          out of {formatMarks(component.fullMarks)}
                          {component.passMarks ? ` · pass ${formatMarks(component.passMarks)}` : ''}
                        </span>
                      </div>
                      <MarkCell
                        student={student}
                        component={component}
                        value={row.values[component.key]}
                        onChange={(value) => setValue(student.id, component.key, value)}
                        disabled={!editable || locked || row.isAbsent}
                        error={cellErrors[`${student.id}.${component.key}`]}
                      />
                    </div>
                  ))}
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={row.isAbsent}
                      disabled={!editable || locked}
                      onChange={(event) => setAbsent(student.id, event.target.checked)}
                    />
                    <span>Absent</span>
                  </label>
                  <div>
                    <label htmlFor={`remarks-${student.id}`} className="label text-xs">
                      Remarks
                    </label>
                    <Input
                      id={`remarks-${student.id}`}
                      value={row.remarks}
                      disabled={!editable || locked}
                      maxLength={500}
                      onChange={(event) => setRemarks(student.id, event.target.value)}
                    />
                  </div>
                </CardBody>
              </Card>
            </li>
          );
        })}
      </ul>

      {editable ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="primary"
            fullWidth
            className="sm:w-auto"
            loading={save.isPending}
            loadingLabel="Saving…"
            onClick={() => save.mutate()}
          >
            Save marks
          </Button>
          {canSubmit ? (
            <Button
              fullWidth
              className="sm:w-auto"
              onClick={() => setSubmitting(true)}
              disabled={save.isPending}
            >
              Submit for review
            </Button>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={submitting}
        onClose={() => setSubmitting(false)}
        title="Submit this paper for review?"
        confirmLabel="Submit"
        variant="primary"
        body={
          <>
            Submitting locks these marks to you — after this only a reviewer can move them on, and
            an approved mark can be changed only through a recorded correction. The API refuses the
            submission while any enrolled student has neither a mark nor an absence, so save your
            work first.
          </>
        }
        // No reason required: `submitExamMarksSchema` does not take one, and inventing a
        // string to satisfy a dialog would put a fiction in the audit trail.
        onConfirm={async () => {
          await submit.mutateAsync();
        }}
      />
    </div>
  );
}

function MarkCell({
  student,
  component,
  value,
  onChange,
  disabled,
  error,
}: {
  student: StudentSummary;
  component: PaperComponent;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  error?: string;
}) {
  const errorId = `mark-error-${student.id}-${component.key}`;
  return (
    <div className="inline-flex flex-col items-end gap-1">
      <Input
        // Text with a decimal keypad rather than `type="number"`: the value must stay the exact
        // decimal string the API expects, and a number input hands back a browser-normalised
        // one. Same reasoning as money.
        type="text"
        inputMode="decimal"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        aria-label={`${component.label} marks for ${student.fullNameEn}, out of ${formatMarks(component.fullMarks)}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className="w-24 text-right tabular-nums"
      />
      {error ? (
        <span id={errorId} role="alert" className="text-xs font-medium text-danger">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** Map a schema issue path such as `writtenMarks` back to the column it came from. */
function componentKeyForField(
  field: string,
  components: PaperComponent[],
): ComponentKey | undefined {
  return components.find((component) => component.markField === field)?.key;
}
