/**
 * Primitives reused across every module's schemas.
 *
 * The Bangladesh-specific ones are the interesting part: a generic `z.string().phone()` would
 * accept numbers that cannot receive an SMS here and reject ones that can.
 */

import { z } from 'zod';
import {
  calendarDate,
  DEFAULT_PAGE_SIZE,
  isPlausibleBirthRegistrationNumber,
  isPlausibleNid,
  MAX_PAGE_SIZE,
  normalizeBdMobile,
} from '@shikkha/shared';

export const uuidSchema = z.string().uuid('Not a valid identifier');

export const idParamSchema = z.object({ id: uuidSchema });

/**
 * A Bangladeshi mobile number, normalised to E.164 on parse.
 *
 * The transform is the point: everything downstream — deduplication, SMS delivery, guardian
 * matching — assumes one canonical form, and doing it in the schema means no service has to
 * remember.
 */
export const bdPhoneSchema = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const normalized = normalizeBdMobile(value);
    if (!normalized) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Enter a valid Bangladeshi mobile number, for example 01712-345678',
      });
      return z.NEVER;
    }
    return normalized;
  });

export const optionalBdPhoneSchema = z
  .union([z.literal(''), z.string()])
  .optional()
  .transform((value, ctx) => {
    if (!value) return undefined;
    const normalized = normalizeBdMobile(value);
    if (!normalized) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Enter a valid Bangladeshi mobile number, for example 01712-345678',
      });
      return z.NEVER;
    }
    return normalized;
  });

/** A calendar date, validated for real-date-ness (2026-02-30 is rejected). */
export const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
  .superRefine((value, ctx) => {
    try {
      calendarDate(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'This is not a real date' });
    }
  });

export const nidSchema = z
  .string()
  .trim()
  .refine(isPlausibleNid, 'A National ID is 10, 13 or 17 digits');

export const birthRegistrationSchema = z
  .string()
  .trim()
  .refine(
    isPlausibleBirthRegistrationNumber,
    'A birth registration number is 17 digits beginning with the year of registration',
  );

/** Names are stored in both scripts; the English form is required, the Bangla form optional. */
export const bilingualNameSchema = z.object({
  en: z.string().trim().min(2, 'Enter at least 2 characters').max(255),
  bn: z.string().trim().max(255).optional(),
});

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export const sortSchema = z.object({
  /** `field` or `-field` for descending; validated against a per-endpoint allow-list. */
  sort: z
    .string()
    .regex(/^[-+]?[a-zA-Z0-9_,.-]+$/, 'Invalid sort expression')
    .max(200)
    .optional(),
});

export const searchSchema = z.object({
  q: z.string().trim().max(200).optional(),
});

/**
 * A required, meaningful justification.
 *
 * Attached to actions where "why" is part of the record: attendance corrections, mark changes,
 * refunds, fee waivers. The minimum length is a nudge against "fix" and "asdf" — it cannot
 * force a good reason, but it can make an empty one deliberate.
 */
export const reasonSchema = z
  .string()
  .trim()
  .min(10, 'Give a reason of at least 10 characters — this is recorded in the audit log')
  .max(1000);

/** Money on the wire is a decimal string, never a number (ADR-004). */
export const moneySchema = z
  .string()
  .regex(/^-?\d{1,12}(\.\d{1,2})?$/, 'Enter an amount with at most two decimal places');

export const positiveMoneySchema = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, 'Enter a positive amount with at most two decimal places');

export const localeSchema = z.enum(['en', 'bn']);
