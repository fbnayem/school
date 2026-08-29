'use client';

/**
 * The weekly routine, as a grid.
 *
 * Days across, periods down, one lesson per cell. Two things about it are decided by the data
 * model rather than by taste:
 *
 *  - **The day axis is the school's teaching week, not Monday–Friday.** `academic_years`
 *    carries `weekendDays` and nothing in the API assumes Friday and Saturday are non-teaching
 *    — a madrasah and an English-medium school in the same city disagree. The caller passes the
 *    days; this component never guesses.
 *  - **A double period is shown as a flag, not as a merged cell.** The API stores
 *    `isDoublePeriod` on the lesson and expands it into two occupied slots only when it checks
 *    for clashes. Drawing a rowspan here would imply the second slot has a lesson row of its
 *    own, which it does not, and would silently hide a clash the API had already accepted.
 *
 * Below `sm` the grid becomes one list per day, the same trade the rest of the product makes:
 * a seven-column table at 375px is technically responsive and practically unusable, and this is
 * the screen a teacher checks on a phone on the way to class.
 */

import { Badge, BilingualName, Card, CardBody, CardHeader, EmptyState } from '@/components/ui';
import { formatLongDate, formatTimeRange, formatWeekday } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { Substitution } from './api';

/**
 * What a cell renders.
 *
 * Narrower than the API's `TimetableEntry` on purpose. `TimetableEntry` (the labelled shape the
 * read routes return) is structurally assignable to this, and so is a lesson the draft editor
 * is holding in form state before it has ever been saved — whose labels come from the same
 * `/academic` lookups the pickers are built from, not from invented strings.
 */
export interface GridEntry {
  id: string;
  dayOfWeek: number;
  periodId: string;
  subjectName: string;
  subjectNameBn: string | null;
  sectionLabel: string;
  teacherName: string | null;
  roomLabel: string | null;
  isDoublePeriod: boolean;
  note: string | null;
}

/** The period axis. Only `id` and a label are needed; times are shown where present. */
export interface GridPeriod {
  id: string;
  nameEn: string;
  sequence: number;
  startTime: string;
  endTime: string;
  isBreak?: boolean;
}

export interface WeekGridProps {
  /** Weekday numbers, 0 = Sunday, in the order they should appear. */
  days: number[];
  periods: GridPeriod[];
  entries: GridEntry[];
  /** Covers falling on or after the view date, keyed to their entry by the API. */
  substitutions?: Substitution[];
  /** Shown in each cell when one grid holds several sections (a teacher's week). */
  showSection?: boolean;
  /**
   * Makes every cell a button. Present only when the caller has the manage permission *and* the
   * timetable is a draft — the API refuses an edit to a published routine, so offering one
   * would be a button that always fails.
   */
  onSelectCell?: (dayOfWeek: number, period: GridPeriod, entry: GridEntry | null) => void;
  emptyTitle?: string;
  emptyDescription?: string;
}

export function WeekGrid({
  days,
  periods,
  entries,
  substitutions = [],
  showSection = false,
  onSelectCell,
  emptyTitle = 'No lessons in this routine yet',
  emptyDescription = 'Nothing has been scheduled for this section.',
}: WeekGridProps) {
  if (periods.length === 0) {
    return (
      <EmptyState
        title="No bell schedule"
        description="This routine has no periods to lay lessons out against. A shift's periods are set up in Academic structure."
      />
    );
  }

  if (entries.length === 0 && !onSelectCell) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }

  const at = (day: number, periodId: string) =>
    entries.find((entry) => entry.dayOfWeek === day && entry.periodId === periodId) ?? null;

  const coversFor = (entryId: string) =>
    substitutions.filter((substitution) => substitution.entryId === entryId);

  return (
    <>
      {/* Tablet and up: the grid. */}
      <div className="card hidden overflow-hidden sm:block">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[48rem] table-fixed text-sm">
            <caption className="sr-only">
              Weekly routine, periods down the side and days across the top
            </caption>
            <thead className="border-b border-line bg-surface-muted text-left">
              <tr>
                <th scope="col" className="w-32 px-3 py-2.5 font-medium text-content-muted">
                  Period
                </th>
                {days.map((day) => (
                  <th
                    key={day}
                    scope="col"
                    className="px-3 py-2.5 font-medium text-content-muted"
                  >
                    {formatWeekday(day)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {periods.map((period) => (
                <tr key={period.id} className="align-top">
                  <th scope="row" className="px-3 py-2 text-left font-medium">
                    <span className="block">{period.nameEn}</span>
                    <span className="block text-xs font-normal tabular-nums text-content-subtle">
                      {formatTimeRange(period.startTime, period.endTime)}
                    </span>
                  </th>
                  {days.map((day) => {
                    const entry = at(day, period.id);
                    return (
                      <td key={day} className="p-1.5">
                        <GridCell
                          entry={entry}
                          covers={entry ? coversFor(entry.id) : []}
                          showSection={showSection}
                          isBreak={period.isBreak ?? false}
                          onSelect={
                            onSelectCell ? () => onSelectCell(day, period, entry) : undefined
                          }
                          label={`${formatWeekday(day)}, ${period.nameEn}`}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Phone: one card per day. */}
      <div className="space-y-3 sm:hidden">
        {days.map((day) => {
          const dayEntries = periods
            .map((period) => ({ period, entry: at(day, period.id) }))
            .filter((slot) => slot.entry !== null || Boolean(onSelectCell));

          return (
            <Card key={day} as="section">
              <CardHeader title={formatWeekday(day)} headingLevel="h3" />
              <CardBody padded={false}>
                {dayEntries.length === 0 ? (
                  <p className="px-4 py-3 text-sm text-content-muted">No lessons.</p>
                ) : (
                  <ul className="divide-y divide-line">
                    {dayEntries.map(({ period, entry }) => (
                      <li key={period.id} className="px-3 py-2">
                        <p className="text-xs tabular-nums text-content-subtle">
                          {period.nameEn} · {formatTimeRange(period.startTime, period.endTime)}
                        </p>
                        <div className="mt-1">
                          <GridCell
                            entry={entry}
                            covers={entry ? coversFor(entry.id) : []}
                            showSection={showSection}
                            isBreak={period.isBreak ?? false}
                            onSelect={
                              onSelectCell ? () => onSelectCell(day, period, entry) : undefined
                            }
                            label={`${formatWeekday(day)}, ${period.nameEn}`}
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>
          );
        })}
      </div>
    </>
  );
}

function GridCell({
  entry,
  covers,
  showSection,
  isBreak,
  onSelect,
  label,
}: {
  entry: GridEntry | null;
  covers: Substitution[];
  showSection: boolean;
  isBreak: boolean;
  onSelect?: () => void;
  /** Says which slot this is, so an icon-free empty cell still has an accessible name. */
  label: string;
}) {
  const body = entry ? (
    <>
      <span className="block font-medium">
        <BilingualName row={{ nameEn: entry.subjectName, nameBn: entry.subjectNameBn }} />
      </span>
      {showSection ? (
        <span className="block text-xs text-content-muted">{entry.sectionLabel}</span>
      ) : null}
      <span className="block text-xs text-content-muted">
        {entry.teacherName ?? 'No teacher assigned'}
      </span>
      {entry.roomLabel ? (
        <span className="block text-xs text-content-subtle">{entry.roomLabel}</span>
      ) : null}
      <span className="mt-1 flex flex-wrap gap-1">
        {entry.isDoublePeriod ? (
          <Badge tone="info">Double — continues into the next period</Badge>
        ) : null}
        {covers.map((cover) => (
          <Badge key={cover.id} tone="warning">
            Covered by {cover.substituteName} on {formatLongDate(cover.substitutionDate)}
          </Badge>
        ))}
      </span>
      {entry.note ? (
        <span className="mt-1 block text-xs text-content-subtle">{entry.note}</span>
      ) : null}
    </>
  ) : (
    <span className="text-xs text-content-subtle">{isBreak ? 'Break' : 'Free'}</span>
  );

  if (!onSelect) {
    return (
      <div
        className={cn(
          'rounded border px-2 py-1.5',
          entry ? 'border-line bg-surface' : 'border-dashed border-line bg-transparent',
        )}
      >
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'w-full rounded border px-2 py-1.5 text-left hover:border-accent-400 hover:bg-accent-50',
        entry ? 'border-line bg-surface' : 'border-dashed border-line bg-transparent',
      )}
    >
      <span className="sr-only">
        {entry ? `Edit the lesson in ${label}` : `Add a lesson to ${label}`}
      </span>
      {body}
    </button>
  );
}
