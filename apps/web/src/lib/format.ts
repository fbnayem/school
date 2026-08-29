/**
 * General display formatting: dates, times, counts, names, enum labels.
 *
 * Three deliberate omissions, each for a reason worth stating once here rather than
 * rediscovering at a call site:
 *
 *  1. **No money helpers.** Money is a decimal string on the wire (ADR-004) and must never be
 *     parsed into a float. The one implementation lives in `@/components/fees/format` and is
 *     re-exported from `@/components/ui` so a screen still writes one import. Adding a second
 *     `formatMoney` here is how a rounding bug gets into a fee receipt.
 *  2. **No `Date` arithmetic on calendar dates.** A `YYYY-MM-DD` from the API is a calendar
 *     date, not an instant. `new Date('2026-03-01')` parses as UTC midnight and renders as
 *     28 February in a browser west of Greenwich — and as the *previous day* for any user who
 *     has their machine set to a non-Dhaka timezone while looking at a Bangladeshi school's
 *     attendance register. Calendar dates are formatted by splitting the string.
 *  3. **No locale switching.** UI chrome is English in this release. Bangla *data* is rendered
 *     wherever the API provides it — see `pickBilingual` and the `BilingualName` component.
 */

/** The timezone every instant in this product is read in. Schools are all in Bangladesh. */
export const DHAKA = 'Asia/Dhaka';

// ── Calendar dates (`YYYY-MM-DD`) ─────────────────────────────────────────────────────

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `"2026-03-01"` → `"01/03/2026"`. Pure string work; no timezone involved. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '';
  const match = CALENDAR_DATE.exec(value);
  if (!match) return value;
  const [, year, month, day] = match;
  return `${day}/${month}/${year}`;
}

const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** `"2026-03-01"` → `"1 Mar 2026"`. For headings and detail screens where digits read poorly. */
export function formatLongDate(value: string | null | undefined): string {
  if (!value) return '';
  const match = CALENDAR_DATE.exec(value);
  if (!match) return value;
  const [, year, month, day] = match;
  const monthName = MONTHS_SHORT[Number(month) - 1];
  if (!monthName) return value;
  return `${Number(day)} ${monthName} ${year}`;
}

/** `"2026-03-01" … "2026-03-05"` → `"1–5 Mar 2026"`, collapsing whatever the two share. */
export function formatDateRange(from: string, to: string): string {
  const a = CALENDAR_DATE.exec(from);
  const b = CALENDAR_DATE.exec(to);
  if (!a || !b) return `${formatLongDate(from)} – ${formatLongDate(to)}`;
  if (from === to) return formatLongDate(from);
  const sameYear = a[1] === b[1];
  const sameMonth = sameYear && a[2] === b[2];
  if (sameMonth) return `${Number(a[3])}–${formatLongDate(to)}`;
  if (sameYear) {
    const monthName = MONTHS_SHORT[Number(a[2]) - 1] ?? a[2];
    return `${Number(a[3])} ${monthName} – ${formatLongDate(to)}`;
  }
  return `${formatLongDate(from)} – ${formatLongDate(to)}`;
}

/** Today in Dhaka as `YYYY-MM-DD`. `en-CA` is the locale that formats ISO-style. */
export function todayInDhaka(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: DHAKA }).format(new Date());
}

/**
 * Shift a calendar date by whole days without constructing a local `Date`.
 *
 * `Date.UTC` is used purely as a calendar arithmetic engine — the value never touches a
 * timezone-sensitive formatter, so the DST-free UTC line is exactly what we want here.
 */
export function addDays(value: string, days: number): string {
  const match = CALENDAR_DATE.exec(value);
  if (!match) return value;
  const [, year, month, day] = match;
  const shifted = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day) + days));
  return shifted.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`, positive when `to` is later. Both are calendar dates. */
export function daysBetween(from: string, to: string): number {
  const a = CALENDAR_DATE.exec(from);
  const b = CALENDAR_DATE.exec(to);
  if (!a || !b) return 0;
  const start = Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]));
  const end = Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3]));
  return Math.round((end - start) / 86_400_000);
}

// ── Instants (ISO timestamps) ─────────────────────────────────────────────────────────

/** `"2026-03-01T04:12:00Z"` → `"1 Mar 2026, 10:12"` in Dhaka. */
export function formatInstant(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: DHAKA,
  }).format(date);
}

/** Date part of an instant, in Dhaka. Use when the time of day is noise. */
export function formatInstantDate(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: DHAKA }).format(date);
}

/**
 * "3 hours ago", "in 2 days". Coarse by design — a precise relative time in an audit log
 * invites people to reason about ordering from a rounded string instead of the timestamp.
 */
export function formatRelative(value: string | null | undefined, now: Date = new Date()): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const absolute = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (absolute < 45) return formatter.format(Math.round(seconds), 'second');
  if (absolute < 3600) return formatter.format(Math.round(seconds / 60), 'minute');
  if (absolute < 86_400) return formatter.format(Math.round(seconds / 3600), 'hour');
  if (absolute < 2_592_000) return formatter.format(Math.round(seconds / 86_400), 'day');
  if (absolute < 31_536_000) return formatter.format(Math.round(seconds / 2_592_000), 'month');
  return formatter.format(Math.round(seconds / 31_536_000), 'year');
}

// ── Clock times (`HH:MM` or `HH:MM:SS`) ───────────────────────────────────────────────

const CLOCK_TIME = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** `"08:05:00"` → `"8:05 am"`. Period and shift times are wall clock, never instants. */
export function formatTime(value: string | null | undefined): string {
  if (!value) return '';
  const match = CLOCK_TIME.exec(value);
  if (!match) return value;
  const hours = Number(match[1]);
  const minutes = match[2];
  const suffix = hours < 12 ? 'am' : 'pm';
  const display = hours % 12 === 0 ? 12 : hours % 12;
  return `${display}:${minutes} ${suffix}`;
}

/** `"08:00:00"`–`"08:45:00"` → `"8:00 – 8:45 am"`, dropping the repeated meridiem. */
export function formatTimeRange(from: string, to: string): string {
  const a = formatTime(from);
  const b = formatTime(to);
  if (!a || !b) return `${a}${b ? ` – ${b}` : ''}`;
  const suffixA = a.slice(-2);
  const suffixB = b.slice(-2);
  return suffixA === suffixB ? `${a.slice(0, -3)} – ${b}` : `${a} – ${b}`;
}

/** Sunday = 0, matching the API's `dayOfWeek` and the academic year's `weekendDays`. */
export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export function formatWeekday(day: number, style: 'long' | 'short' = 'long'): string {
  const name = WEEKDAY_NAMES[day];
  if (!name) return String(day);
  return style === 'short' ? name.slice(0, 3) : name;
}

// ── Numbers ───────────────────────────────────────────────────────────────────────────

/**
 * en-IN grouping: `1234567` → `12,34,567`.
 *
 * The Indian numbering system is how numbers are read in Bangladesh — a total rendered as
 * `1,234,567` is not wrong so much as foreign, and staff double-check foreign-looking totals.
 */
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  return value.toLocaleString('en-IN');
}

/** `formatCount(1, 'student')` → `"1 student"`; `formatCount(0, 'student')` → `"0 students"`. */
export function formatCount(value: number, singular: string, plural?: string): string {
  const word = value === 1 ? singular : (plural ?? `${singular}s`);
  return `${formatNumber(value)} ${word}`;
}

/**
 * A ratio as a whole-number percentage, for counts only — never for money.
 *
 * Percentages the API computed and returned as decimal strings are formatted by
 * `formatPercent` in the fees module instead; this one is for "18 of 42 present".
 */
export function formatRatioPercent(part: number, total: number, decimals = 0): string {
  if (!total) return '—';
  return `${((part / total) * 100).toFixed(decimals)}%`;
}

/** Bytes for a file listing: `1536` → `"1.5 KB"`. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'] as const;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unitIndex]}`;
}

// ── Text and names ────────────────────────────────────────────────────────────────────

/**
 * `"on_leave"` → `"On leave"`.
 *
 * Enum values arrive as snake_case from the API. Rendering them raw is the single most common
 * way an admin screen looks unfinished, and mapping every enum by hand in every screen is how
 * two screens end up disagreeing about what `part_time` is called.
 */
export function humanize(value: string | null | undefined): string {
  if (!value) return '';
  const spaced = value.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/** `"class teacher"` → `"Class Teacher"`. For proper nouns and role titles, not sentences. */
export function titleCase(value: string | null | undefined): string {
  if (!value) return '';
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

/** Up to two initials for an avatar placeholder. Works for Bangla script too. */
export function initials(name: string | null | undefined): string {
  if (!name) return '';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

/** Trim to a length on a word boundary, with an ellipsis. Never mid-grapheme. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** A record that carries both scripts, in either of the two naming conventions the API uses. */
export interface Bilingual {
  nameEn?: string | null;
  nameBn?: string | null;
  fullNameEn?: string | null;
  fullNameBn?: string | null;
  titleEn?: string | null;
  titleBn?: string | null;
}

/**
 * Pull the English and Bangla forms out of a row whatever the field naming is.
 *
 * Rows use `nameEn`/`nameBn`, `fullNameEn`/`fullNameBn` or `titleEn`/`titleBn` depending on the
 * module. Screens should not each write that fallback chain — get it wrong once and a Bangla
 * name silently stops rendering, which nobody reports because the English one is still there.
 */
export function pickBilingual(row: Bilingual): { en: string; bn: string | null } {
  const en = row.fullNameEn ?? row.nameEn ?? row.titleEn ?? '';
  const bn = row.fullNameBn ?? row.nameBn ?? row.titleBn ?? null;
  return { en, bn: bn && bn.trim() !== '' ? bn : null };
}

/** A masked identifier for display: `"1234567890123"` → `"•••• 0123"`. NIDs, account numbers. */
export function maskTail(value: string | null | undefined, visible = 4): string {
  if (!value) return '';
  if (value.length <= visible) return value;
  return `•••• ${value.slice(-visible)}`;
}
