/**
 * AI tutor schemas (Phase 35) — the student-facing surface.
 *
 * Four rules shape every schema here, and all four are about what a student's client is NOT
 * allowed to say:
 *
 *  - **A client cannot choose the tutor's instructions.** There is no `systemPrompt`, no
 *    `persona`, no `temperature` and no token ceiling anywhere in this file. A student who
 *    could supply a system prompt could switch off the framing that keeps the tutor from
 *    doing their homework, and a student who could raise the ceiling could spend their
 *    school's inference budget a hundred times faster than the budget expects.
 *  - **A client cannot choose the anchor's meaning.** `anchorKind` and `anchorId` name a
 *    record; whether that record is *assessed* is resolved server-side from the record
 *    itself. A field like `isAssessed: false` on the request would be the whole rule handed
 *    to the person it constrains.
 *  - **A client never states a derived fact.** No `groundingLevel`, no `citations`, no
 *    `outcome`, no token counts. Those are what the server observed, not what the caller
 *    claims.
 *  - **A safeguarding flag is closed with a reason, by the person closing it.** There is no
 *    `reviewedBy` field: the acting user is the authenticated one, and the database checks
 *    it against the connection's own identity.
 *
 * Constants carry a `TUTOR_` prefix because `@shikkha/validation` re-exports flat.
 */

import { z } from 'zod';
import { paginationSchema, reasonSchema, sortSchema, uuidSchema } from './common';

// ── Value sets, mirrored from the database enums ─────────────────────────────────────

/**
 * What a session may be anchored to. All four are records the school itself created; there
 * is deliberately no "general" or "other" member, because an unanchored tutor is a
 * general-purpose chatbot pointed at a child.
 */
export const TUTOR_ANCHOR_KINDS = ['course', 'lesson', 'assignment', 'quiz_question'] as const;

export const TUTOR_SESSION_STATUSES = ['active', 'ended'] as const;

export const TUTOR_TURN_OUTCOMES = [
  'guided',
  'guidance_only',
  'no_citation',
  'safeguarding_hold',
] as const;

export const TUTOR_GROUNDING_LEVELS = ['grounded', 'partial', 'ungrounded'] as const;

export const TUTOR_FLAG_SIGNALS = [
  'self_harm',
  'abuse_or_neglect',
  'bullying',
  'violence',
  'unspecified_distress',
] as const;

export const TUTOR_FLAG_STATUSES = ['pending', 'reviewed'] as const;

// ── Sort allow-lists, consumed by parseSort ──────────────────────────────────────────

export const TUTOR_SESSION_SORT_FIELDS = ['startedAt', 'status', 'anchorLabel'] as const;
export const TUTOR_FLAG_SORT_FIELDS = ['raisedAt', 'status', 'signal'] as const;

// ── Sessions ─────────────────────────────────────────────────────────────────────────

/**
 * Start a session against one piece of the school's material.
 *
 * No title: it is derived from the anchor, so a session is always findable by what it was
 * about rather than by what a student called it at nine o'clock at night. No opening
 * message either — the first turn goes through `POST /tutor/sessions/:id/turns` like every
 * other, so the safeguarding scan, the retrieval gate and the assessed-work post-check have
 * exactly one code path rather than two that can drift.
 */
export const createTutorSessionSchema = z.object({
  anchorKind: z.enum(TUTOR_ANCHOR_KINDS),
  anchorId: uuidSchema,
});

export const listTutorSessionsSchema = paginationSchema.merge(sortSchema).extend({
  status: z.enum(TUTOR_SESSION_STATUSES).optional(),
  includeArchived: z.coerce.boolean().default(false),
});

/**
 * One turn. `question` and nothing else.
 *
 * Four thousand characters, not the copilot's twenty thousand: a student asking about one
 * homework question does not need an essay's worth of prompt, and the smaller ceiling is
 * one less way for a session to become the most expensive request in the system.
 */
export const createTutorTurnSchema = z.object({
  question: z.string().trim().min(1, 'Ask a question').max(4_000),
});

/**
 * End a session. A reason is required and recorded — a session is a school record, and
 * "finished" with no explanation is a state nobody can interpret a year later.
 */
export const endTutorSessionSchema = z.object({ reason: reasonSchema });

// ── Safeguarding ─────────────────────────────────────────────────────────────────────

export const listTutorFlagsSchema = paginationSchema.merge(sortSchema).extend({
  status: z.enum(TUTOR_FLAG_STATUSES).optional(),
  studentId: uuidSchema.optional(),
  signal: z.enum(TUTOR_FLAG_SIGNALS).optional(),
});

/**
 * Record that a person has read a flag and what they decided.
 *
 * `reason` only. There is no `reviewedBy` — the reviewer is the authenticated user and the
 * database refuses a row that says otherwise — and there is no field through which this
 * endpoint could be asked to *do* anything: contacting a family, opening a discipline
 * record or making a referral are separate, permission-checked actions taken by a person in
 * the module that owns them. Closing a flag closes a flag.
 */
export const reviewTutorFlagSchema = z.object({ reason: reasonSchema });

// ── Inferred types, for services and controllers ─────────────────────────────────────

export type TutorAnchorKind = (typeof TUTOR_ANCHOR_KINDS)[number];
export type TutorSessionStatus = (typeof TUTOR_SESSION_STATUSES)[number];
export type TutorTurnOutcome = (typeof TUTOR_TURN_OUTCOMES)[number];
export type TutorGroundingLevel = (typeof TUTOR_GROUNDING_LEVELS)[number];
export type TutorFlagSignal = (typeof TUTOR_FLAG_SIGNALS)[number];
export type TutorFlagStatus = (typeof TUTOR_FLAG_STATUSES)[number];

export type CreateTutorSessionInput = z.infer<typeof createTutorSessionSchema>;
export type ListTutorSessionsInput = z.infer<typeof listTutorSessionsSchema>;
export type CreateTutorTurnInput = z.infer<typeof createTutorTurnSchema>;
export type EndTutorSessionInput = z.infer<typeof endTutorSessionSchema>;
export type ListTutorFlagsInput = z.infer<typeof listTutorFlagsSchema>;
export type ReviewTutorFlagInput = z.infer<typeof reviewTutorFlagSchema>;
