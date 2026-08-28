/**
 * Shared schema tests.
 *
 * These schemas are the contract between the web forms and the API, so a gap here appears in
 * two places at once. The cases below are the ones that matter in this domain: phone
 * normalisation (the guardian deduplication key), real-date validation, cross-field rules that
 * a single-field validator cannot express, and set-level invariants like term weights.
 */

import { describe, expect, it } from 'vitest';
import {
  bdPhoneSchema,
  calendarDateSchema,
  changePasswordSchema,
  createAcademicYearSchema,
  createClassSubjectSchema,
  createStudentSchema,
  linkGuardianSchema,
  loginSchema,
  moneySchema,
  paginationSchema,
  replaceTermsSchema,
} from '../src';

describe('bdPhoneSchema', () => {
  it('normalises every written form to one E.164 value', () => {
    for (const input of ['01712345678', '+8801712345678', '01712-345678', '০১৭১২৩৪৫৬৭৮']) {
      expect(bdPhoneSchema.parse(input), input).toBe('+8801712345678');
    }
  });

  it('rejects numbers that cannot receive an SMS in Bangladesh', () => {
    for (const bad of ['0171234567', '01012345678', '+919712345678', 'not a number']) {
      expect(bdPhoneSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('explains what a valid number looks like', () => {
    const result = bdPhoneSchema.safeParse('123');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.message).toMatch(/01712-345678/);
    }
  });
});

describe('calendarDateSchema', () => {
  it('accepts real dates', () => {
    expect(calendarDateSchema.parse('2026-03-15')).toBe('2026-03-15');
    expect(calendarDateSchema.parse('2024-02-29')).toBe('2024-02-29');
  });

  it('rejects dates that would silently roll over', () => {
    // `new Date('2026-02-30')` becomes 2 March, which would corrupt an attendance register.
    for (const bad of ['2026-02-30', '2025-02-29', '2026-13-01', '2026-04-31']) {
      expect(calendarDateSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('rejects loose formats', () => {
    for (const bad of ['2026-3-15', '15/03/2026', '2026-03-15T00:00:00Z']) {
      expect(calendarDateSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('createStudentSchema', () => {
  const valid = {
    admissionDate: '2026-01-05',
    fullNameEn: 'Rahim Ahmed',
    dateOfBirth: '2015-06-10',
    gender: 'male' as const,
  };

  it('accepts the minimum a school actually has at admission', () => {
    // Paperwork arrives later. Requiring a birth registration number here means clerks type
    // placeholders, which is worse than an honest null.
    expect(createStudentSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects an admission date before the date of birth', () => {
    const result = createStudentSchema.safeParse({
      ...valid,
      admissionDate: '2014-01-05',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('admissionDate'))).toBe(true);
    }
  });

  it('flags an implausible age, pointing at the date of birth', () => {
    const tooYoung = createStudentSchema.safeParse({ ...valid, dateOfBirth: '2025-06-10' });
    expect(tooYoung.success).toBe(false);
    if (!tooYoung.success) {
      expect(tooYoung.error.issues.some((i) => i.path.includes('dateOfBirth'))).toBe(true);
    }
  });

  it('accepts an over-age student, which real registers contain', () => {
    // A 17-year-old in Class 6 is unusual but real; refusing it would force a false record.
    expect(createStudentSchema.safeParse({ ...valid, dateOfBirth: '2009-06-10' }).success).toBe(
      true,
    );
  });

  it('normalises the phone number when one is given', () => {
    const result = createStudentSchema.parse({ ...valid, phone: '01712-345678' });
    expect(result.phone).toBe('+8801712345678');
  });

  it('strips unknown keys, so a forged field cannot reach an insert', () => {
    const result = createStudentSchema.parse({
      ...valid,
      status: 'graduated',
      tenantId: 'someone-elses-tenant',
      version: 99,
    } as Record<string, unknown>);
    expect(result).not.toHaveProperty('tenantId');
    expect(result).not.toHaveProperty('status');
    expect(result).not.toHaveProperty('version');
  });
});

describe('replaceTermsSchema', () => {
  const term = (name: string, sequence: number, start: string, end: string, weight: number) => ({
    nameEn: name,
    sequence,
    startDate: start,
    endDate: end,
    weightBasisPoints: weight,
  });

  const academicYearId = '01a049c3-e8ae-70d9-a6c4-ae65b75d6cae';

  it('accepts a set whose weights total 100%', () => {
    const result = replaceTermsSchema.safeParse({
      academicYearId,
      terms: [
        term('First', 1, '2026-01-01', '2026-04-30', 3000),
        term('Second', 2, '2026-05-01', '2026-08-31', 3000),
        term('Annual', 3, '2026-09-01', '2026-12-31', 4000),
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects weights that do not total 100%, and says what they total', () => {
    const result = replaceTermsSchema.safeParse({
      academicYearId,
      terms: [
        term('First', 1, '2026-01-01', '2026-04-30', 3000),
        term('Second', 2, '2026-05-01', '2026-12-31', 6000),
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.message).toMatch(/90\.00%/);
    }
  });

  it('rejects overlapping terms', () => {
    // Overlapping terms make "which term is this exam in?" ambiguous, and every mark entered
    // afterwards inherits that ambiguity.
    const result = replaceTermsSchema.safeParse({
      academicYearId,
      terms: [
        term('First', 1, '2026-01-01', '2026-06-30', 5000),
        term('Second', 2, '2026-06-01', '2026-12-31', 5000),
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /starts before/.test(i.message))).toBe(true);
    }
  });

  it('rejects duplicate sequence numbers', () => {
    const result = replaceTermsSchema.safeParse({
      academicYearId,
      terms: [
        term('First', 1, '2026-01-01', '2026-06-30', 5000),
        term('Second', 1, '2026-07-01', '2026-12-31', 5000),
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe('createClassSubjectSchema', () => {
  const base = {
    academicYearId: '01a049c3-e8ae-70d9-a6c4-ae65b75d6cae',
    classLevelId: '01a049c3-e8ae-70d9-a6c4-ae65b75d6caf',
    subjectId: '01a049c3-e8ae-70d9-a6c4-ae65b75d6cb0',
  };

  it('accepts components that sum to full marks', () => {
    expect(
      createClassSubjectSchema.safeParse({
        ...base,
        fullMarks: 100,
        passMarks: 33,
        markDistribution: { theory: 70, mcq: 30 },
      }).success,
    ).toBe(true);
  });

  it('rejects components that do not sum, and reports both figures', () => {
    const result = createClassSubjectSchema.safeParse({
      ...base,
      fullMarks: 100,
      markDistribution: { theory: 70, mcq: 20 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.message).toMatch(/add up to 90.*full marks are 100/);
    }
  });

  it('rejects pass marks above full marks', () => {
    const result = createClassSubjectSchema.safeParse({ ...base, fullMarks: 50, passMarks: 60 });
    expect(result.success).toBe(false);
  });
});

describe('createAcademicYearSchema', () => {
  it('rejects an end date before the start', () => {
    expect(
      createAcademicYearSchema.safeParse({
        name: '2026',
        startDate: '2026-12-31',
        endDate: '2026-01-01',
      }).success,
    ).toBe(false);
  });

  it('rejects a span of more than two calendar years, which is almost always a typo', () => {
    expect(
      createAcademicYearSchema.safeParse({
        name: '2026',
        startDate: '2026-01-01',
        endDate: '2030-12-31',
      }).success,
    ).toBe(false);
  });

  it('accepts a straddling session such as 2026-27', () => {
    expect(
      createAcademicYearSchema.safeParse({
        name: '2026-27',
        startDate: '2026-07-01',
        endDate: '2027-06-30',
      }).success,
    ).toBe(true);
  });
});

describe('linkGuardianSchema', () => {
  const guardianId = '01a049c3-e8ae-70d9-a6c4-ae65b75d6cae';

  it('requires a description when the relationship is "other"', () => {
    expect(linkGuardianSchema.safeParse({ guardianId, relation: 'other' }).success).toBe(false);
    expect(
      linkGuardianSchema.safeParse({ guardianId, relation: 'other', relationOther: 'Neighbour' })
        .success,
    ).toBe(true);
  });

  it('refuses a billing contact who cannot see the portal', () => {
    // They would be chased for an invoice they cannot open, which produces support calls
    // rather than payments.
    const result = linkGuardianSchema.safeParse({
      guardianId,
      relation: 'father',
      isBillingContact: true,
      canAccessPortal: false,
    });
    expect(result.success).toBe(false);
  });

  it('defaults to portal access and custody, which is the common case', () => {
    const result = linkGuardianSchema.parse({ guardianId, relation: 'mother' });
    expect(result.canAccessPortal).toBe(true);
    expect(result.hasCustody).toBe(true);
    expect(result.isPrimary).toBe(false);
  });
});

describe('changePasswordSchema', () => {
  const strong = 'AVeryLongNewPassword2026';

  it('requires the confirmation to match', () => {
    expect(
      changePasswordSchema.safeParse({
        currentPassword: 'old',
        newPassword: strong,
        confirmPassword: 'different',
      }).success,
    ).toBe(false);
  });

  it('requires the new password to differ from the current one', () => {
    expect(
      changePasswordSchema.safeParse({
        currentPassword: strong,
        newPassword: strong,
        confirmPassword: strong,
      }).success,
    ).toBe(false);
  });

  it('enforces the length floor', () => {
    expect(
      changePasswordSchema.safeParse({
        currentPassword: 'old',
        newPassword: 'Short1!',
        confirmPassword: 'Short1!',
      }).success,
    ).toBe(false);
  });
});

describe('paginationSchema', () => {
  it('clamps the page size so a crafted URL cannot request the whole roll', () => {
    expect(paginationSchema.safeParse({ pageSize: 100_000 }).success).toBe(false);
    expect(paginationSchema.parse({ pageSize: 200 }).pageSize).toBe(200);
  });

  it('coerces query-string values, which arrive as strings', () => {
    expect(paginationSchema.parse({ page: '3', pageSize: '50' })).toEqual({
      page: 3,
      pageSize: 50,
    });
  });

  it('applies sensible defaults', () => {
    expect(paginationSchema.parse({})).toEqual({ page: 1, pageSize: 25 });
  });
});

describe('moneySchema', () => {
  it('accepts decimal strings with at most two places', () => {
    for (const value of ['0', '0.00', '1500.50', '-250.75', '999999999999.99']) {
      expect(moneySchema.safeParse(value).success, value).toBe(true);
    }
  });

  it('rejects anything a currency amount should never be', () => {
    for (const value of ['1500.505', '1,500.00', '1500.5.0', 'abc', '']) {
      expect(moneySchema.safeParse(value).success, value).toBe(false);
    }
  });
});

describe('loginSchema', () => {
  it('accepts an email address or a phone number without distinguishing them', () => {
    // A specific "not a valid email" message would tell an attacker which identifiers exist.
    expect(loginSchema.safeParse({ identifier: 'a@b.test', password: 'x' }).success).toBe(true);
    expect(loginSchema.safeParse({ identifier: '01712345678', password: 'x' }).success).toBe(true);
  });

  it('rejects a tenant slug that is not URL-safe', () => {
    expect(
      loginSchema.safeParse({ identifier: 'a@b.test', password: 'x', tenantSlug: 'Bad Slug!' })
        .success,
    ).toBe(false);
  });
});
