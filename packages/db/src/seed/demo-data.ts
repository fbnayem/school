/**
 * Demo tenant generator.
 *
 * Produces a realistic Bangladeshi school so that every screen, report and query can be
 * exercised against data that has the right *shape* — not just the right types. The details
 * that matter and are easy to get wrong in fake data:
 *
 *  - Bangla and English names that are genuinely different strings, not transliterations of
 *    one another, so bilingual rendering bugs are visible.
 *  - Morning and day shifts, because most Bangladeshi schools at capacity run both and the
 *    timetable and attendance modules must handle a student who exists in only one.
 *  - Guardians shared between siblings, so the "one guardian, several children" path is
 *    covered rather than a tidy one-to-one that hides the bug.
 *  - Attendance that is mostly present with a realistic absence pattern, including a handful
 *    of chronically absent students, so the early-warning module has something to find.
 *
 * All names are invented. No real personal data.
 */

import { calendarDate, uuidv7, type CalendarDate } from '@shikkha/shared';

/**
 * Deterministic pseudo-random generator.
 *
 * Seeded so `db:seed` produces the same data every run: a test that asserts "Class 6 Section A
 * has 42 students" must not become flaky because the seeder rolled differently. `Math.random`
 * would make the demo environment unreproducible across machines.
 */
export class SeededRandom {
  private state: number;

  constructor(seed = 20260829) {
    this.state = seed >>> 0;
  }

  /** xorshift32 — small, fast, and good enough for generating names and attendance. */
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 0xffffffff;
  }

  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)]!;
  }

  /** True with the given probability. */
  chance(probability: number): boolean {
    return this.next() < probability;
  }

  shuffle<T>(items: T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
}

// Name pools. Paired so a generated person's Bangla and English names correspond.
const MALE_FIRST_NAMES: ReadonlyArray<[string, string]> = [
  ['Rahim', 'রহিম'],
  ['Karim', 'করিম'],
  ['Sabbir', 'সাব্বির'],
  ['Tanvir', 'তানভীর'],
  ['Nayeem', 'নাঈম'],
  ['Arif', 'আরিফ'],
  ['Shahriar', 'শাহরিয়ার'],
  ['Rifat', 'রিফাত'],
  ['Sakib', 'সাকিব'],
  ['Mahin', 'মাহিন'],
  ['Fahim', 'ফাহিম'],
  ['Rakib', 'রাকিব'],
  ['Imran', 'ইমরান'],
  ['Jubayer', 'জুবায়ের'],
  ['Nafis', 'নাফিস'],
  ['Tahsin', 'তাহসিন'],
  ['Abir', 'আবির'],
  ['Sadman', 'সাদমান'],
  ['Rayhan', 'রায়হান'],
  ['Ashik', 'আশিক'],
];

const FEMALE_FIRST_NAMES: ReadonlyArray<[string, string]> = [
  ['Fatema', 'ফাতেমা'],
  ['Ayesha', 'আয়েশা'],
  ['Nusrat', 'নুসরাত'],
  ['Tasnim', 'তাসনিম'],
  ['Sumaiya', 'সুমাইয়া'],
  ['Jarin', 'জারিন'],
  ['Mim', 'মিম'],
  ['Sadia', 'সাদিয়া'],
  ['Rumana', 'রুমানা'],
  ['Farhana', 'ফারহানা'],
  ['Israt', 'ইসরাত'],
  ['Anika', 'আনিকা'],
  ['Lamia', 'লামিয়া'],
  ['Samia', 'সামিয়া'],
  ['Marufa', 'মারুফা'],
  ['Nabila', 'নাবিলা'],
  ['Zannat', 'জান্নাত'],
  ['Ruponti', 'রূপন্তী'],
  ['Sharmin', 'শারমিন'],
  ['Tanjina', 'তানজিনা'],
];

const SURNAMES: ReadonlyArray<[string, string]> = [
  ['Ahmed', 'আহমেদ'],
  ['Hossain', 'হোসেন'],
  ['Islam', 'ইসলাম'],
  ['Rahman', 'রহমান'],
  ['Chowdhury', 'চৌধুরী'],
  ['Khan', 'খান'],
  ['Sarker', 'সরকার'],
  ['Molla', 'মোল্লা'],
  ['Bhuiyan', 'ভূঁইয়া'],
  ['Talukder', 'তালুকদার'],
  ['Mia', 'মিয়া'],
  ['Uddin', 'উদ্দিন'],
];

const OCCUPATIONS = [
  'Business',
  'Government service',
  'Private service',
  'Teacher',
  'Farmer',
  'Doctor',
  'Engineer',
  'Shopkeeper',
  'Driver',
  'Homemaker',
  'Garment worker',
  'Bank officer',
];

const DHAKA_AREAS = [
  'Mirpur',
  'Uttara',
  'Dhanmondi',
  'Mohammadpur',
  'Bashundhara',
  'Banasree',
  'Jatrabari',
  'Gulshan',
  'Badda',
  'Savar',
];

export interface GeneratedPerson {
  fullNameEn: string;
  fullNameBn: string;
  gender: 'male' | 'female';
}

export function generatePerson(rng: SeededRandom, gender?: 'male' | 'female'): GeneratedPerson {
  const resolvedGender = gender ?? (rng.chance(0.5) ? 'male' : 'female');
  const [firstEn, firstBn] = rng.pick(
    resolvedGender === 'male' ? MALE_FIRST_NAMES : FEMALE_FIRST_NAMES,
  );
  const [lastEn, lastBn] = rng.pick(SURNAMES);
  return {
    fullNameEn: `${firstEn} ${lastEn}`,
    fullNameBn: `${firstBn} ${lastBn}`,
    gender: resolvedGender,
  };
}

/**
 * A Bangladeshi mobile number in E.164, guaranteed unique within a run.
 *
 * Uses the 013–019 prefixes that are actually allocated, so `normalizeBdMobile` accepts them
 * and the guardian-deduplication path is genuinely exercised.
 */
export function generatePhone(rng: SeededRandom, used: Set<string>): string {
  const prefixes = ['13', '14', '15', '16', '17', '18', '19'];
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const prefix = rng.pick(prefixes);
    const rest = String(rng.int(10_000_000, 99_999_999));
    const phone = `+8801${prefix}${rest}`;
    if (!used.has(phone)) {
      used.add(phone);
      return phone;
    }
  }
  throw new Error('Exhausted the phone number space while seeding');
}

/** A 17-digit birth registration number whose first four digits are the birth year. */
export function generateBirthRegistration(rng: SeededRandom, birthYear: number): string {
  const rest = Array.from({ length: 13 }, () => rng.int(0, 9)).join('');
  return `${birthYear}${rest}`;
}

export function generateAddress(rng: SeededRandom): string {
  return `House ${rng.int(1, 120)}, Road ${rng.int(1, 30)}, ${rng.pick(DHAKA_AREAS)}, Dhaka`;
}

export function generateOccupation(rng: SeededRandom): string {
  return rng.pick(OCCUPATIONS);
}

/**
 * A date of birth appropriate to a class level.
 *
 * Class 1 students are around 6, Class 10 around 15, with a year of spread either way —
 * because real registers contain over-age students, and reports that assume a tight age band
 * are wrong in ways that only show up with realistic data.
 */
export function generateDateOfBirth(
  rng: SeededRandom,
  classOrdinal: number,
  academicYear: number,
): CalendarDate {
  const typicalAge = classOrdinal + 5;
  const age = typicalAge + rng.int(-1, 1);
  const birthYear = academicYear - age;
  const month = rng.int(1, 12);
  // Capped at 28 so February never produces an invalid date.
  const day = rng.int(1, 28);
  return calendarDate(
    `${birthYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  );
}

/**
 * The NCTB class structure a typical Bangla-medium school runs, from Play through Class 10.
 * Ordinals drive promotion, so they are contiguous.
 */
export const CLASS_LEVELS: ReadonlyArray<{
  code: string;
  nameEn: string;
  nameBn: string;
  ordinal: number;
  hasGroups: boolean;
}> = [
  { code: 'PLAY', nameEn: 'Play', nameBn: 'প্লে', ordinal: 0, hasGroups: false },
  { code: 'NUR', nameEn: 'Nursery', nameBn: 'নার্সারি', ordinal: 1, hasGroups: false },
  { code: 'C1', nameEn: 'Class 1', nameBn: 'প্রথম শ্রেণি', ordinal: 2, hasGroups: false },
  { code: 'C2', nameEn: 'Class 2', nameBn: 'দ্বিতীয় শ্রেণি', ordinal: 3, hasGroups: false },
  { code: 'C3', nameEn: 'Class 3', nameBn: 'তৃতীয় শ্রেণি', ordinal: 4, hasGroups: false },
  { code: 'C4', nameEn: 'Class 4', nameBn: 'চতুর্থ শ্রেণি', ordinal: 5, hasGroups: false },
  { code: 'C5', nameEn: 'Class 5', nameBn: 'পঞ্চম শ্রেণি', ordinal: 6, hasGroups: false },
  { code: 'C6', nameEn: 'Class 6', nameBn: 'ষষ্ঠ শ্রেণি', ordinal: 7, hasGroups: false },
  { code: 'C7', nameEn: 'Class 7', nameBn: 'সপ্তম শ্রেণি', ordinal: 8, hasGroups: false },
  { code: 'C8', nameEn: 'Class 8', nameBn: 'অষ্টম শ্রেণি', ordinal: 9, hasGroups: false },
  // Groups (Science / Commerce / Humanities) begin at Class 9 in the national curriculum.
  { code: 'C9', nameEn: 'Class 9', nameBn: 'নবম শ্রেণি', ordinal: 10, hasGroups: true },
  { code: 'C10', nameEn: 'Class 10', nameBn: 'দশম শ্রেণি', ordinal: 11, hasGroups: true },
];

export const ACADEMIC_GROUPS: ReadonlyArray<{ code: string; nameEn: string; nameBn: string }> = [
  { code: 'SCI', nameEn: 'Science', nameBn: 'বিজ্ঞান' },
  { code: 'COM', nameEn: 'Business Studies', nameBn: 'ব্যবসায় শিক্ষা' },
  { code: 'HUM', nameEn: 'Humanities', nameBn: 'মানবিক' },
];

/**
 * Subjects with their real NCTB codes.
 *
 * `isFourthSubject` is set on Higher Mathematics and Agriculture because those are the usual
 * fourth-subject choices, and the fourth-subject rule materially changes GPA arithmetic —
 * seeding it wrong would make the results module look correct while producing wrong GPAs.
 */
export const SUBJECTS: ReadonlyArray<{
  code: string;
  nameEn: string;
  nameBn: string;
  shortName: string;
  kind: 'compulsory' | 'optional' | 'additional' | 'co_curricular';
  isFourthSubject: boolean;
  excludeFromGpa: boolean;
  hasPractical: boolean;
  fullMarks: number;
  passMarks: number;
  periodsPerWeek: number;
}> = [
  {
    code: '101',
    nameEn: 'Bangla 1st Paper',
    nameBn: 'বাংলা ১ম পত্র',
    shortName: 'BAN1',
    kind: 'compulsory',
    isFourthSubject: false,
    excludeFromGpa: false,
    hasPractical: false,
    fullMarks: 100,
    passMarks: 33,
    periodsPerWeek: 5,
  },
  {
    code: '102',
    nameEn: 'Bangla 2nd Paper',
    nameBn: 'বাংলা ২য় পত্র',
    shortName: 'BAN2',
    kind: 'compulsory',
    isFourthSubject: false,
    excludeFromGpa: false,
    hasPractical: false,
    fullMarks: 100,
    passMarks: 33,
    periodsPerWeek: 4,
  },
  {
    code: '107',
    nameEn: 'English 1st Paper',
    nameBn: 'ইংরেজি ১ম পত্র',
    shortName: 'ENG1',
    kind: 'compulsory',
    isFourthSubject: false,
    excludeFromGpa: false,
    hasPractical: false,
    fullMarks: 100,
    passMarks: 33,
    periodsPerWeek: 5,
  },
  {
    code: '108',
    nameEn: 'English 2nd Paper',
    nameBn: 'ইংরেজি ২য় পত্র',
    shortName: 'ENG2',
    kind: 'compulsory',
    isFourthSubject: false,
    excludeFromGpa: false,
    hasPractical: false,
    fullMarks: 100,
    passMarks: 33,
    periodsPerWeek: 4,
  },
  {
    code: '109',
    nameEn: 'Mathematics',
    nameBn: 'গণিত',
    shortName: 'MATH',
    kind: 'compulsory',
    isFourthSubject: false,
    excludeFromGpa: false,
    hasPractical: false,
    fullMarks: 100,
    passMarks: 33,
    periodsPerWeek: 6,
  },
  {
    code: '127',
    nameEn: 'Science',
    nameBn: 'বিজ্ঞান',
    shortName: 'SCI',
    kind: 'compulsory',
    isFourthSubject: false,
    excludeFromGpa: false,
    hasPractical: true,
    fullMarks: 100,
    passMarks: 33,
    periodsPerWeek: 5,
  },
  {
    code: '150',
    nameEn: 'Bangladesh and Global Studies',
    nameBn: 'বাংলাদেশ ও বিশ্বপরিচয়',
    shortName: 'BGS',
    kind: 'compulsory',
    isFourthSubject: false,
    excludeFromGpa: false,
    hasPractical: false,
    fullMarks: 100,
    passMarks: 33,
    periodsPerWeek: 4,
  },
  {
    code: '111',
    nameEn: 'Religion and Moral Education',
    nameBn: 'ধর্ম ও নৈতিক শিক্ষা',
    shortName: 'REL',
    kind: 'compulsory',
    isFourthSubject: false,
    excludeFromGpa: false,
    hasPractical: false,
    fullMarks: 100,
    passMarks: 33,
    periodsPerWeek: 3,
  },
  {
    code: '154',
    nameEn: 'Information and Communication Technology',
    nameBn: 'তথ্য ও যোগাযোগ প্রযুক্তি',
    shortName: 'ICT',
    kind: 'compulsory',
    isFourthSubject: false,
    excludeFromGpa: false,
    hasPractical: true,
    fullMarks: 50,
    passMarks: 17,
    periodsPerWeek: 2,
  },
  {
    code: '126',
    nameEn: 'Higher Mathematics',
    nameBn: 'উচ্চতর গণিত',
    shortName: 'HMATH',
    kind: 'optional',
    isFourthSubject: true,
    excludeFromGpa: false,
    hasPractical: true,
    fullMarks: 100,
    passMarks: 33,
    periodsPerWeek: 4,
  },
  {
    code: '134',
    nameEn: 'Agriculture Studies',
    nameBn: 'কৃষিশিক্ষা',
    shortName: 'AGR',
    kind: 'optional',
    isFourthSubject: true,
    excludeFromGpa: false,
    hasPractical: true,
    fullMarks: 100,
    passMarks: 33,
    periodsPerWeek: 3,
  },
  {
    code: '147',
    nameEn: 'Physical Education',
    nameBn: 'শারীরিক শিক্ষা',
    shortName: 'PE',
    kind: 'co_curricular',
    isFourthSubject: false,
    excludeFromGpa: true,
    hasPractical: false,
    fullMarks: 50,
    passMarks: 17,
    periodsPerWeek: 1,
  },
];

export const DESIGNATIONS: ReadonlyArray<{
  code: string;
  nameEn: string;
  nameBn: string;
  rank: number;
  isTeaching: boolean;
}> = [
  { code: 'PRIN', nameEn: 'Principal', nameBn: 'অধ্যক্ষ', rank: 100, isTeaching: false },
  { code: 'VPRIN', nameEn: 'Vice Principal', nameBn: 'উপাধ্যক্ষ', rank: 90, isTeaching: false },
  { code: 'HEAD', nameEn: 'Head Teacher', nameBn: 'প্রধান শিক্ষক', rank: 80, isTeaching: true },
  {
    code: 'ASTHEAD',
    nameEn: 'Assistant Head Teacher',
    nameBn: 'সহকারী প্রধান শিক্ষক',
    rank: 70,
    isTeaching: true,
  },
  { code: 'SRTCH', nameEn: 'Senior Teacher', nameBn: 'সিনিয়র শিক্ষক', rank: 60, isTeaching: true },
  { code: 'TCH', nameEn: 'Assistant Teacher', nameBn: 'সহকারী শিক্ষক', rank: 50, isTeaching: true },
  { code: 'ACCT', nameEn: 'Accountant', nameBn: 'হিসাবরক্ষক', rank: 40, isTeaching: false },
  {
    code: 'OFFASST',
    nameEn: 'Office Assistant',
    nameBn: 'অফিস সহকারী',
    rank: 20,
    isTeaching: false,
  },
  { code: 'LIB', nameEn: 'Librarian', nameBn: 'গ্রন্থাগারিক', rank: 35, isTeaching: false },
];

export const DEPARTMENTS: ReadonlyArray<{ code: string; nameEn: string; nameBn: string }> = [
  { code: 'SCI', nameEn: 'Science', nameBn: 'বিজ্ঞান' },
  { code: 'ARTS', nameEn: 'Arts', nameBn: 'কলা' },
  { code: 'LANG', nameEn: 'Languages', nameBn: 'ভাষা' },
  { code: 'MATH', nameEn: 'Mathematics', nameBn: 'গণিত' },
  { code: 'ADMIN', nameEn: 'Administration', nameBn: 'প্রশাসন' },
];

export interface SeedScale {
  label: string;
  /** Sections per class level. Two shifts × this many sections per shift. */
  sectionsPerClass: number;
  studentsPerSection: number;
  /** Days of attendance history to generate. */
  attendanceDays: number;
}

/**
 * Scales matching the brief's performance targets. `small` is the default because a developer
 * running `db:seed` wants a usable environment in seconds, not a 50,000-student load test.
 */
export const SEED_SCALES: Record<string, SeedScale> = {
  small: {
    label: 'Small school (~500 students)',
    sectionsPerClass: 1,
    studentsPerSection: 40,
    attendanceDays: 20,
  },
  medium: {
    label: 'Medium school (~2,500 students)',
    sectionsPerClass: 2,
    studentsPerSection: 52,
    attendanceDays: 40,
  },
  large: {
    label: 'Large school (~10,000 students)',
    sectionsPerClass: 4,
    studentsPerSection: 55,
    attendanceDays: 60,
  },
  group: {
    label: 'School group (~50,000 students)',
    sectionsPerClass: 8,
    studentsPerSection: 55,
    attendanceDays: 90,
  },
};

export function newId(): string {
  return uuidv7();
}
