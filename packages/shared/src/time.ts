/**
 * Time handling for a Bangladesh-first product.
 *
 * Two distinct kinds of value, and conflating them is the source of nearly every
 * date bug in school software:
 *
 *  - **Instant** — a moment (login time, payment timestamp). Stored `timestamptz`, in UTC.
 *  - **CalendarDate** — a school-calendar fact with no time component (date of birth,
 *    attendance date, holiday, exam date). Stored `date`. "2026-03-15" is the same day in
 *    every timezone because it is not an instant at all.
 *
 * Bangladesh Standard Time is UTC+6 with no daylight saving, which means the offset is a
 * constant. That is *why* the conversions below can be arithmetic rather than requiring a
 * timezone database — but the CalendarDate/Instant distinction still matters, so it is
 * modelled explicitly rather than assumed away.
 */

export const DHAKA_TIMEZONE = 'Asia/Dhaka' as const;
/** UTC+6, fixed. Bangladesh has not observed DST since the 2009 experiment was abandoned. */
export const DHAKA_UTC_OFFSET_MINUTES = 360;

/** An ISO calendar date, `YYYY-MM-DD`, with no time or zone. */
export type CalendarDate = string & { readonly __brand: 'CalendarDate' };

const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export class TimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeError';
  }
}

/**
 * Validate and brand a `YYYY-MM-DD` string.
 *
 * Rejects values that parse but are not real dates — `2026-02-30` round-trips through
 * `new Date()` as 2 March, which would silently corrupt an attendance register.
 */
export function calendarDate(value: string): CalendarDate {
  const match = CALENDAR_DATE_PATTERN.exec(value);
  if (!match) {
    throw new TimeError(`Expected a YYYY-MM-DD calendar date, received ${JSON.stringify(value)}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new TimeError(`${value} is not a real calendar date`);
  }
  return value as CalendarDate;
}

export function isCalendarDate(value: unknown): value is CalendarDate {
  if (typeof value !== 'string') return false;
  try {
    calendarDate(value);
    return true;
  } catch {
    return false;
  }
}

/** The calendar date it currently is *in Dhaka*, which is what a school day means. */
export function todayInDhaka(now: Date = new Date()): CalendarDate {
  return instantToDhakaDate(now);
}

/** Which Dhaka calendar date does this instant fall on? */
export function instantToDhakaDate(instant: Date): CalendarDate {
  const shifted = new Date(instant.getTime() + DHAKA_UTC_OFFSET_MINUTES * 60_000);
  const year = shifted.getUTCFullYear().toString().padStart(4, '0');
  const month = (shifted.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = shifted.getUTCDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}` as CalendarDate;
}

/**
 * The UTC instant at which a given Dhaka wall-clock time occurs.
 * `startOfDhakaDay('2026-03-15')` is 2026-03-14T18:00:00Z.
 */
export function dhakaWallClockToInstant(date: CalendarDate, time = '00:00:00'): Date {
  const timeMatch = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!timeMatch) {
    throw new TimeError(`Expected HH:mm or HH:mm:ss, received ${JSON.stringify(time)}`);
  }
  const hours = Number(timeMatch[1]);
  const minutes = Number(timeMatch[2]);
  const seconds = Number(timeMatch[3] ?? '0');
  if (hours > 23 || minutes > 59 || seconds > 59) {
    throw new TimeError(`${time} is not a valid wall-clock time`);
  }
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const asIfUtc = Date.UTC(y, m - 1, d, hours, minutes, seconds);
  return new Date(asIfUtc - DHAKA_UTC_OFFSET_MINUTES * 60_000);
}

export function startOfDhakaDay(date: CalendarDate): Date {
  return dhakaWallClockToInstant(date, '00:00:00');
}

/** Exclusive upper bound — the start of the next day, which is the correct range end. */
export function endOfDhakaDay(date: CalendarDate): Date {
  return startOfDhakaDay(addDays(date, 1));
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return instantToDhakaDate(new Date(shifted.getTime() - DHAKA_UTC_OFFSET_MINUTES * 60_000));
}

export function addMonths(date: CalendarDate, months: number): CalendarDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const daysInTargetMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  // Clamp: 31 January + 1 month is 28/29 February, not 3 March.
  const day = Math.min(d, daysInTargetMonth);
  const result = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), day));
  return instantToDhakaDate(new Date(result.getTime() - DHAKA_UTC_OFFSET_MINUTES * 60_000));
}

/** Whole days from `a` to `b`; negative when `b` precedes `a`. */
export function daysBetween(a: CalendarDate, b: CalendarDate): number {
  const [ay, am, ad] = a.split('-').map(Number) as [number, number, number];
  const [by, bm, bd] = b.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

export function compareCalendarDates(a: CalendarDate, b: CalendarDate): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Inclusive on both ends, which is how academic terms and fee periods are described. */
export function isWithin(date: CalendarDate, start: CalendarDate, end: CalendarDate): boolean {
  return date >= start && date <= end;
}

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export function dhakaWeekday(date: CalendarDate): Weekday {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() as Weekday;
}

/**
 * The default non-teaching days for Bangladesh: Friday and Saturday.
 *
 * This is a *default*, not a rule. Institutions configure their own weekend in the academic
 * calendar — some English-medium schools follow Friday-only, and coaching centres run on
 * weekends by design. Nothing in the attendance module may assume this function's answer.
 */
export const DEFAULT_BD_WEEKEND: readonly Weekday[] = [5, 6];

export function isDefaultBdWeekend(date: CalendarDate): boolean {
  return DEFAULT_BD_WEEKEND.includes(dhakaWeekday(date));
}

/** Inclusive range of calendar dates. Guards against reversed bounds rather than looping forever. */
export function eachDay(start: CalendarDate, end: CalendarDate): CalendarDate[] {
  if (compareCalendarDates(start, end) === 1) {
    throw new TimeError(`Range start ${start} is after end ${end}`);
  }
  const out: CalendarDate[] = [];
  let cursor = start;
  while (compareCalendarDates(cursor, end) <= 0) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}

/** Age in whole years on a reference date — used for admission eligibility rules. */
export function ageInYears(dateOfBirth: CalendarDate, on: CalendarDate = todayInDhaka()): number {
  const [by, bm, bd] = dateOfBirth.split('-').map(Number) as [number, number, number];
  const [oy, om, od] = on.split('-').map(Number) as [number, number, number];
  let age = oy - by;
  if (om < bm || (om === bm && od < bd)) age -= 1;
  return age;
}

/** Format an instant for display in Dhaka local time. */
export function formatInDhaka(
  instant: Date,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
  locale: 'en-BD' | 'bn-BD' = 'en-BD',
): string {
  return new Intl.DateTimeFormat(locale === 'bn-BD' ? 'bn-BD' : 'en-GB', {
    ...options,
    timeZone: DHAKA_TIMEZONE,
  }).format(instant);
}
