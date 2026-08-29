/**
 * AI tool argument schemas (Phases 29-30).
 *
 * These are ordinary request schemas and they live here, beside every other module's, for one
 * reason that is a security property rather than a tidiness preference: docs/06 §3 defence 3
 * says tool arguments are validated against **the same Zod schemas the HTTP API uses**, so a
 * model cannot invent a parameter shape. If the tool layer had its own private validation,
 * "the same schemas" would be a claim rather than a fact, and the two would drift.
 *
 * Three conventions here that are deliberate:
 *
 *  1. **Every argument object is `.strict()`.** An unknown key is a 422, not a silently ignored
 *     field. A model that hallucinates `includeArchived: true` or `institutionId: "<other>"`
 *     must be told it is wrong rather than have the extra key quietly dropped — a dropped key
 *     is indistinguishable from an honoured one from the model's point of view, and that is
 *     exactly how a plausible-looking but wrong answer gets produced.
 *  2. **Every range is bounded.** An unbounded `from`/`to` over attendance is a
 *     denial-of-service endpoint wearing a report's clothing, and a model asked for "this
 *     year's attendance" will happily send 1900-01-01.
 *  3. **`.describe()` on every field.** The manifest endpoint turns these schemas into JSON
 *     Schema for the model, and the description is the only thing that tells it what
 *     `sectionId` means. A field with no description is a field the model will guess at.
 *
 * Note there is no `institutionId` argument anywhere. Institution scope comes from the
 * `x-institution-id` header that the tenant guard validates against the caller's own grants;
 * accepting it as a tool argument would let a model choose which school to read.
 */

import { z } from 'zod';
import { daysBetween, type CalendarDate } from '@shikkha/shared';
import { calendarDateSchema, uuidSchema } from './common';

/**
 * The tool vocabulary, as declared in docs/06 §2.
 *
 * Exported so the registry can assert completeness against it: a tool implemented but missing
 * from here, or listed here but not implemented, is a boot-time failure rather than a 404
 * discovered by a user.
 */
export const AI_TOOL_NAMES = [
  'student.lookup',
  'attendance.summary',
  'results.summary',
  'finance.outstanding',
  'timetable.lookup',
  'knowledge.search',
] as const;

export type AiToolName = (typeof AI_TOOL_NAMES)[number];

/** A full academic year plus a little. Anything wider is an export, not a question. */
export const MAX_AI_TOOL_RANGE_DAYS = 400;

/** The most rows any tool will return. Rule 2 of docs/06 §2 is "the minimum that answers". */
export const AI_TOOL_MAX_RESULTS = 25;

/**
 * `from` <= `to`, and no wider than `MAX_AI_TOOL_RANGE_DAYS`.
 *
 * Written once and shared rather than repeated, because the failure mode of repeating it is
 * one tool quietly keeping an unbounded range after the others have been fixed.
 */
function refineBoundedRange(value: { from: string; to: string }, ctx: z.RefinementCtx): void {
  const from = value.from as CalendarDate;
  const to = value.to as CalendarDate;
  if (from > to) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['to'],
      message: 'The end of the range is before its start',
    });
    return;
  }
  if (daysBetween(from, to) > MAX_AI_TOOL_RANGE_DAYS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['to'],
      message: `Ask for at most ${MAX_AI_TOOL_RANGE_DAYS} days at a time`,
    });
  }
}

/**
 * Exactly one of two mutually exclusive selectors.
 *
 * "Neither" is refused because a tool with no subject would have to fall back to a default,
 * and a default here means "whatever the caller happens to be able to see" — which is how an
 * aggregate over the wrong population gets presented as an answer. "Both" is refused because
 * the tool would have to pick one and the model would not know which it picked.
 */
function refineExactlyOne(
  value: Record<string, unknown>,
  ctx: z.RefinementCtx,
  first: string,
  second: string,
): void {
  const given = [first, second].filter((key) => value[key] !== undefined);
  if (given.length === 1) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [first],
    message: `Give exactly one of ${first} or ${second}`,
  });
}

// -- student.lookup --------------------------------------------------------------------

export const studentLookupArgsSchema = z
  .object({
    studentId: uuidSchema
      .optional()
      .describe('The identifier of one student to look up. Use this when you already have it.'),
    q: z
      .string()
      .trim()
      .min(2, 'Search for at least 2 characters')
      .max(80)
      .optional()
      .describe(
        'A name, student code or admission number to search for. Only students the caller is ' +
          'permitted to see are searched.',
      ),
    sectionId: uuidSchema
      .optional()
      .describe('Restrict a search to one section. Ignored when studentId is given.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(AI_TOOL_MAX_RESULTS)
      .default(5)
      .describe(`How many matches to return, at most ${AI_TOOL_MAX_RESULTS}.`),
  })
  .strict()
  .superRefine((value, ctx) => refineExactlyOne(value, ctx, 'studentId', 'q'));

// -- attendance.summary ----------------------------------------------------------------

export const attendanceSummaryArgsSchema = z
  .object({
    studentId: uuidSchema.optional().describe('Summarise one student’s attendance.'),
    sectionId: uuidSchema
      .optional()
      .describe(
        'Summarise a whole section’s attendance. Returns counts only, never student names.',
      ),
    from: calendarDateSchema.describe('First day of the range, inclusive (YYYY-MM-DD).'),
    to: calendarDateSchema.describe('Last day of the range, inclusive (YYYY-MM-DD).'),
  })
  .strict()
  .superRefine((value, ctx) => {
    refineExactlyOne(value, ctx, 'studentId', 'sectionId');
    refineBoundedRange(value, ctx);
  });

// -- results.summary -------------------------------------------------------------------

export const resultsSummaryArgsSchema = z
  .object({
    studentId: uuidSchema.describe('The student whose results are being summarised.'),
    examId: uuidSchema
      .optional()
      .describe('Restrict to one exam. Omit to summarise across every exam in scope.'),
    academicYearId: uuidSchema
      .optional()
      .describe('Restrict to one academic year. Ignored when examId is given.'),
  })
  .strict();

// -- finance.outstanding ---------------------------------------------------------------

export const financeOutstandingArgsSchema = z
  .object({
    academicYearId: uuidSchema.describe('The academic year the bills belong to.'),
    studentId: uuidSchema.optional().describe('Restrict to one student.'),
    sectionId: uuidSchema.optional().describe('Restrict to one section.'),
    classLevelId: uuidSchema.optional().describe('Restrict to one class level.'),
    asOfDate: calendarDateSchema
      .optional()
      .describe('Age the debt as at this date. Defaults to today in Dhaka.'),
  })
  .strict();

// -- timetable.lookup ------------------------------------------------------------------

export const timetableLookupArgsSchema = z
  .object({
    date: calendarDateSchema.describe('The school day to look up (YYYY-MM-DD).'),
    sectionId: uuidSchema.optional().describe('The section whose periods are wanted.'),
    employeeId: uuidSchema.optional().describe('The teacher whose periods are wanted.'),
  })
  .strict()
  .superRefine((value, ctx) => refineExactlyOne(value, ctx, 'sectionId', 'employeeId'));

// -- knowledge.search ------------------------------------------------------------------

export const knowledgeSearchArgsSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(3, 'Search for at least 3 characters')
      .max(500)
      .describe('What to look for in the school’s own documents.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(5)
      .describe('How many passages to return, at most 10.'),
  })
  .strict();

// -- The invocation envelope -----------------------------------------------------------

/**
 * The tool name is a free string, not `z.enum(AI_TOOL_NAMES)`.
 *
 * An enum here would reject an unknown name with a 422 whose issue message lists every valid
 * tool — a complete map of the AI surface handed to anyone who can reach the route. The
 * registry resolves the name instead and answers 404 for both "no such tool" and "not a tool
 * you may use", which is the property the security suite asserts.
 */
export const aiToolNameParamSchema = z.object({
  name: z.string().trim().min(1).max(64),
});

export const aiToolInvokeSchema = z
  .object({
    arguments: z
      .record(z.unknown())
      .default({})
      .describe("The tool's arguments, validated against that tool's own schema."),
  })
  .strict();

export type StudentLookupArgs = z.infer<typeof studentLookupArgsSchema>;
export type AttendanceSummaryArgs = z.infer<typeof attendanceSummaryArgsSchema>;
export type ResultsSummaryArgs = z.infer<typeof resultsSummaryArgsSchema>;
export type FinanceOutstandingArgs = z.infer<typeof financeOutstandingArgsSchema>;
export type TimetableLookupArgs = z.infer<typeof timetableLookupArgsSchema>;
export type KnowledgeSearchArgs = z.infer<typeof knowledgeSearchArgsSchema>;
