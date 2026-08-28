/**
 * Bangladesh-specific domain primitives.
 *
 * These encode real national formats rather than generic international ones, because the
 * generic versions accept data that is wrong here and reject data that is right.
 */

/**
 * Normalise a Bangladeshi mobile number to E.164 (`+8801XXXXXXXXX`).
 *
 * Schools receive numbers in every shape a parent might write one: `01712345678`,
 * `+8801712345678`, `8801712345678`, `01712-345678`, `০১৭১২৩৪৫৬৭৮`. All of these are the
 * same person, and storing them un-normalised means duplicate guardian records and failed
 * SMS delivery.
 *
 * Returns null for anything that is not a valid BD mobile number. Operator prefixes are
 * 013–019 (Grameenphone 017/013, Robi 018, Banglalink 019/014, Teletalk 015, Airtel 016).
 */
export function normalizeBdMobile(input: string): string | null {
  if (!input) return null;
  const ascii = bengaliDigitsToAscii(input);
  const digits = ascii.replace(/[^\d+]/g, '');

  let national: string;
  if (digits.startsWith('+880')) national = digits.slice(4);
  else if (digits.startsWith('880')) national = digits.slice(3);
  else if (digits.startsWith('0')) national = digits.slice(1);
  else national = digits;

  // National significant number is 10 digits and starts with 1, then a 3-9 operator digit.
  if (!/^1[3-9]\d{8}$/.test(national)) return null;
  return `+880${national}`;
}

export function isBdMobile(input: string): boolean {
  return normalizeBdMobile(input) !== null;
}

/** Display form used on receipts and screens: `01712-345678`. */
export function formatBdMobile(e164: string): string {
  const national = e164.startsWith('+880') ? e164.slice(4) : e164;
  if (!/^1[3-9]\d{8}$/.test(national)) return e164;
  return `0${national.slice(0, 4)}-${national.slice(4)}`;
}

const BENGALI_ZERO = 0x09e6;

/** Bengali numerals (০১২৩৪৫৬৭৮৯) to ASCII. Parents and clerks type both. */
export function bengaliDigitsToAscii(input: string): string {
  let out = '';
  for (const char of input) {
    const code = char.codePointAt(0)!;
    if (code >= BENGALI_ZERO && code <= BENGALI_ZERO + 9) {
      out += String(code - BENGALI_ZERO);
    } else {
      out += char;
    }
  }
  return out;
}

export function asciiDigitsToBengali(input: string): string {
  return input.replace(/\d/g, (d) => String.fromCodePoint(BENGALI_ZERO + Number(d)));
}

/**
 * National ID. Historically 13 or 17 digits; the current smart card NID is 10 digits.
 * All three remain in circulation, so all three are accepted.
 *
 * There is no public checksum algorithm for the NID, so this validates shape only — it is a
 * data-entry guard, not proof of identity. Verification against the Election Commission
 * database is a separate integration.
 */
export function isPlausibleNid(input: string): boolean {
  const digits = bengaliDigitsToAscii(input).replace(/\D/g, '');
  return digits.length === 10 || digits.length === 13 || digits.length === 17;
}

export function normalizeNid(input: string): string | null {
  const digits = bengaliDigitsToAscii(input).replace(/\D/g, '');
  return isPlausibleNid(digits) ? digits : null;
}

/**
 * Birth Registration Number — 17 digits, where the first four are the year of registration.
 * This is the primary identity document for school-age children, most of whom have no NID.
 */
export function isPlausibleBirthRegistrationNumber(input: string): boolean {
  const digits = bengaliDigitsToAscii(input).replace(/\D/g, '');
  if (digits.length !== 17) return false;
  const year = Number(digits.slice(0, 4));
  return year >= 1900 && year <= new Date().getUTCFullYear();
}

/** The eight administrative divisions, as of the 2015 creation of Mymensingh. */
export const BD_DIVISIONS = [
  'Barishal',
  'Chattogram',
  'Dhaka',
  'Khulna',
  'Mymensingh',
  'Rajshahi',
  'Rangpur',
  'Sylhet',
] as const;

export type BdDivision = (typeof BD_DIVISIONS)[number];

/**
 * The national education boards. Institutions register with exactly one, and it determines
 * result formats, exam calendars and roll/registration number schemes.
 */
export const BD_EDUCATION_BOARDS = [
  'Dhaka',
  'Rajshahi',
  'Chattogram',
  'Khulna',
  'Barishal',
  'Sylhet',
  'Comilla',
  'Dinajpur',
  'Mymensingh',
  'Madrasah',
  'Technical',
  'BOU',
] as const;

export type BdEducationBoard = (typeof BD_EDUCATION_BOARDS)[number];

/**
 * A bilingual string. Bangla and English are not translations of one another here — a
 * student's legal Bangla name and their English-transliterated name are both official, appear
 * on different documents, and must both be stored. One overloaded `name` column loses that.
 */
export interface BilingualText {
  bn: string | null;
  en: string;
}

export function displayName(text: BilingualText, locale: 'bn' | 'en'): string {
  if (locale === 'bn' && text.bn) return text.bn;
  return text.en;
}
