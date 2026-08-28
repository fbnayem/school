import { describe, expect, it } from 'vitest';
import {
  asciiDigitsToBengali,
  bengaliDigitsToAscii,
  formatBdMobile,
  isBdMobile,
  isPlausibleBirthRegistrationNumber,
  isPlausibleNid,
  normalizeBdMobile,
  normalizeNid,
} from '../src/bd';

describe('normalizeBdMobile', () => {
  it('normalises every shape a parent might write the same number in', () => {
    const expected = '+8801712345678';
    for (const input of [
      '01712345678',
      '+8801712345678',
      '8801712345678',
      '01712-345678',
      '01712 345678',
      '(017) 1234-5678',
      '1712345678',
      '০১৭১২৩৪৫৬৭৮',
    ]) {
      expect(normalizeBdMobile(input), input).toBe(expected);
    }
  });

  it('accepts every live operator prefix', () => {
    for (const prefix of ['013', '014', '015', '016', '017', '018', '019']) {
      expect(normalizeBdMobile(`${prefix}12345678`), prefix).toBe(`+880${prefix.slice(1)}12345678`);
    }
  });

  it('rejects numbers that are not BD mobiles', () => {
    for (const bad of [
      '',
      '0171234567', // one digit short
      '017123456789', // one digit long
      '01012345678', // 010 is not an allocated mobile prefix
      '01212345678', // 012 is not allocated
      '029123456', // Dhaka landline
      '+919712345678', // Indian number
      'not a phone',
    ]) {
      expect(normalizeBdMobile(bad), bad).toBeNull();
      expect(isBdMobile(bad), bad).toBe(false);
    }
  });

  it('formats back to the local display form used on receipts', () => {
    expect(formatBdMobile('+8801712345678')).toBe('01712-345678');
  });

  it('leaves an unrecognised value alone when formatting', () => {
    expect(formatBdMobile('+14155550123')).toBe('+14155550123');
  });
});

describe('Bengali numerals', () => {
  it('converts Bengali digits to ASCII', () => {
    expect(bengaliDigitsToAscii('০১২৩৪৫৬৭৮৯')).toBe('0123456789');
  });

  it('leaves non-digit characters untouched', () => {
    expect(bengaliDigitsToAscii('ক্লাস ৮')).toBe('ক্লাস 8');
  });

  it('round-trips', () => {
    expect(bengaliDigitsToAscii(asciiDigitsToBengali('2026-03-15'))).toBe('2026-03-15');
  });
});

describe('national identifiers', () => {
  it('accepts the three NID lengths still in circulation', () => {
    expect(isPlausibleNid('1234567890')).toBe(true);
    expect(isPlausibleNid('1234567890123')).toBe(true);
    expect(isPlausibleNid('12345678901234567')).toBe(true);
  });

  it('rejects other lengths', () => {
    expect(isPlausibleNid('12345')).toBe(false);
    expect(isPlausibleNid('123456789012')).toBe(false);
  });

  it('strips separators and Bengali digits when normalising', () => {
    expect(normalizeNid('1234 5678 90')).toBe('1234567890');
    expect(normalizeNid('১২৩৪৫৬৭৮৯০')).toBe('1234567890');
    expect(normalizeNid('123')).toBeNull();
  });

  it('validates birth registration numbers by length and plausible year', () => {
    expect(isPlausibleBirthRegistrationNumber('20150612345678901')).toBe(true);
    expect(isPlausibleBirthRegistrationNumber('29990612345678901')).toBe(false);
    expect(isPlausibleBirthRegistrationNumber('1234567890123456')).toBe(false);
  });
});
