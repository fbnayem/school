import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  ageInYears,
  calendarDate,
  compareCalendarDates,
  daysBetween,
  dhakaWeekday,
  dhakaWallClockToInstant,
  eachDay,
  endOfDhakaDay,
  instantToDhakaDate,
  isDefaultBdWeekend,
  isWithin,
  startOfDhakaDay,
  TimeError,
} from '../src/time';

describe('calendarDate validation', () => {
  it('accepts real dates', () => {
    expect(calendarDate('2026-03-15')).toBe('2026-03-15');
    expect(calendarDate('2024-02-29')).toBe('2024-02-29');
  });

  it('rejects dates that JavaScript would silently roll over', () => {
    // new Date('2026-02-30') becomes 2 March, which would corrupt an attendance register.
    expect(() => calendarDate('2026-02-30')).toThrow(TimeError);
    expect(() => calendarDate('2025-02-29')).toThrow(TimeError);
    expect(() => calendarDate('2026-13-01')).toThrow(TimeError);
    expect(() => calendarDate('2026-00-10')).toThrow(TimeError);
    expect(() => calendarDate('2026-04-31')).toThrow(TimeError);
  });

  it('rejects loose formats', () => {
    for (const bad of ['2026-3-15', '15-03-2026', '2026/03/15', '2026-03-15T00:00:00Z', '']) {
      expect(() => calendarDate(bad), bad).toThrow(TimeError);
    }
  });
});

describe('Dhaka day boundaries', () => {
  it('starts a Dhaka day at 18:00 UTC the previous day', () => {
    expect(startOfDhakaDay(calendarDate('2026-03-15')).toISOString()).toBe(
      '2026-03-14T18:00:00.000Z',
    );
  });

  it('ends a Dhaka day exclusively at the next day start', () => {
    expect(endOfDhakaDay(calendarDate('2026-03-15')).toISOString()).toBe(
      '2026-03-15T18:00:00.000Z',
    );
  });

  it('maps a late-evening UTC instant to the correct Dhaka date', () => {
    // 2026-03-14T20:00Z is already 2 a.m. on 15 March in Dhaka.
    expect(instantToDhakaDate(new Date('2026-03-14T20:00:00Z'))).toBe('2026-03-15');
    // 2026-03-15T17:59Z is still 14 March... no: it is 23:59 on 15 March.
    expect(instantToDhakaDate(new Date('2026-03-15T17:59:59Z'))).toBe('2026-03-15');
    expect(instantToDhakaDate(new Date('2026-03-15T18:00:00Z'))).toBe('2026-03-16');
  });

  it('round-trips a Dhaka wall-clock time through UTC', () => {
    const instant = dhakaWallClockToInstant(calendarDate('2026-03-15'), '08:30:00');
    expect(instant.toISOString()).toBe('2026-03-15T02:30:00.000Z');
    expect(instantToDhakaDate(instant)).toBe('2026-03-15');
  });

  it('rejects impossible wall-clock times', () => {
    expect(() => dhakaWallClockToInstant(calendarDate('2026-03-15'), '25:00')).toThrow(TimeError);
    expect(() => dhakaWallClockToInstant(calendarDate('2026-03-15'), '8:30')).toThrow(TimeError);
  });
});

describe('calendar arithmetic', () => {
  it('adds days across month and year boundaries', () => {
    expect(addDays(calendarDate('2026-01-31'), 1)).toBe('2026-02-01');
    expect(addDays(calendarDate('2026-12-31'), 1)).toBe('2027-01-01');
    expect(addDays(calendarDate('2026-03-01'), -1)).toBe('2026-02-28');
    expect(addDays(calendarDate('2024-03-01'), -1)).toBe('2024-02-29');
  });

  it('clamps month arithmetic instead of rolling over', () => {
    // A monthly fee due on the 31st must fall on the last day of a short month, not spill
    // into the next one and be billed twice.
    expect(addMonths(calendarDate('2026-01-31'), 1)).toBe('2026-02-28');
    expect(addMonths(calendarDate('2024-01-31'), 1)).toBe('2024-02-29');
    expect(addMonths(calendarDate('2026-03-31'), 1)).toBe('2026-04-30');
    expect(addMonths(calendarDate('2026-01-15'), 12)).toBe('2027-01-15');
    expect(addMonths(calendarDate('2026-01-15'), -1)).toBe('2025-12-15');
  });

  it('counts whole days between dates', () => {
    expect(daysBetween(calendarDate('2026-03-01'), calendarDate('2026-03-15'))).toBe(14);
    expect(daysBetween(calendarDate('2026-03-15'), calendarDate('2026-03-01'))).toBe(-14);
    expect(daysBetween(calendarDate('2026-03-15'), calendarDate('2026-03-15'))).toBe(0);
    expect(daysBetween(calendarDate('2024-02-28'), calendarDate('2024-03-01'))).toBe(2);
  });

  it('orders dates lexically, which matches chronologically for ISO strings', () => {
    expect(compareCalendarDates(calendarDate('2026-01-01'), calendarDate('2026-02-01'))).toBe(-1);
    expect(compareCalendarDates(calendarDate('2026-02-01'), calendarDate('2026-01-01'))).toBe(1);
    expect(compareCalendarDates(calendarDate('2026-01-01'), calendarDate('2026-01-01'))).toBe(0);
  });

  it('treats term ranges as inclusive on both ends', () => {
    const start = calendarDate('2026-01-01');
    const end = calendarDate('2026-04-30');
    expect(isWithin(start, start, end)).toBe(true);
    expect(isWithin(end, start, end)).toBe(true);
    expect(isWithin(calendarDate('2026-05-01'), start, end)).toBe(false);
  });

  it('enumerates a date range inclusively', () => {
    const days = eachDay(calendarDate('2026-03-01'), calendarDate('2026-03-05'));
    expect(days).toEqual(['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05']);
  });

  it('refuses a reversed range instead of looping forever', () => {
    expect(() => eachDay(calendarDate('2026-03-05'), calendarDate('2026-03-01'))).toThrow(
      TimeError,
    );
  });
});

describe('weekdays and the Bangladeshi weekend', () => {
  it('identifies the weekday of a known date', () => {
    // 2026-03-15 is a Sunday.
    expect(dhakaWeekday(calendarDate('2026-03-15'))).toBe(0);
    expect(dhakaWeekday(calendarDate('2026-03-13'))).toBe(5); // Friday
    expect(dhakaWeekday(calendarDate('2026-03-14'))).toBe(6); // Saturday
  });

  it('defaults the weekend to Friday and Saturday', () => {
    expect(isDefaultBdWeekend(calendarDate('2026-03-13'))).toBe(true);
    expect(isDefaultBdWeekend(calendarDate('2026-03-14'))).toBe(true);
    expect(isDefaultBdWeekend(calendarDate('2026-03-15'))).toBe(false);
  });
});

describe('ageInYears', () => {
  it('counts completed years only', () => {
    expect(ageInYears(calendarDate('2015-06-15'), calendarDate('2026-06-14'))).toBe(10);
    expect(ageInYears(calendarDate('2015-06-15'), calendarDate('2026-06-15'))).toBe(11);
    expect(ageInYears(calendarDate('2015-06-15'), calendarDate('2026-06-16'))).toBe(11);
  });

  it('handles a 29 February birthday in a non-leap year', () => {
    expect(ageInYears(calendarDate('2016-02-29'), calendarDate('2026-02-28'))).toBe(9);
    expect(ageInYears(calendarDate('2016-02-29'), calendarDate('2026-03-01'))).toBe(10);
  });
});
