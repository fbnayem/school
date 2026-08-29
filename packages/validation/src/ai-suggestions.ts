/**
 * AI copilot and suggestion schemas (Phase 33).
 *
 * Four rules shape everything in this file, and each of them is a rule about *what a client
 * may state* rather than about formatting:
 *
 *  - **A client never states a fact the copilot is supposed to have established.** There is no
 *    `evidence`, no `confidence`, no `model` and no `providerKey` on any input here. Those are
 *    produced by the generator from the tool results it actually ran; accepting them from the
 *    wire would let anyone post a fully-formed, high-confidence, evidence-free suggestion into
 *    a reviewer's queue and have it look exactly like one the system computed.
 *  - **A `proposed_action` payload is validated against the owning module's OWN schema.**
 *    `AI_SUGGESTION_PAYLOAD_SCHEMAS` maps each suggestion kind to the schema that module's
 *    endpoint already uses, imported rather than re-declared. A second declaration would be a
 *    second definition of what that module accepts, and the first thing it would forget is a
 *    `superRefine` — the cross-field rules are exactly the ones an attacker aims at.
 *  - **Two payloads are deliberately NARROWER than the module's own.** An admission
 *    suggestion may propose `under_review`, `shortlisted` or `waitlisted` and nothing else,
 *    and an expense flag may propose only `rejected`. docs/06 §6 forbids the AI from approving
 *    an admission; it says nothing about an AI that proposes `selected` and a tired registrar
 *    who clicks accept, so the *payload shape* forbids it too. Symmetrically, an AI must never
 *    nudge a school toward approving a payment — a flag that could resolve to `approved` would
 *    be a mechanism for exactly that.
 *  - **Every decision carries a reason where the record needs one.** Dismissal requires it:
 *    a suggestion nobody explained away is one that will be raised again next week.
 *
 * Constants carry an `AI_` prefix because `@shikkha/validation` re-exports flat.
 */

import { z } from 'zod';
import { paginationSchema, reasonSchema, sortSchema, uuidSchema } from './common';
import { createMessageThreadSchema } from './communication';
import { createBehaviourRecordSchema } from './discipline';
import { createTimetableSubstitutionSchema } from './timetable';

// ── Value sets, mirrored from the database enums in 0034 ─────────────────────────────

export const AI_SUGGESTION_KINDS = [
  'attendance_follow_up',
  'fee_reminder_draft',
  'admission_shortlist_note',
  'timetable_gap_fill',
  'communication_draft',
  'expense_flag',
  'intervention_referral',
] as const;

export type AiSuggestionKind = (typeof AI_SUGGESTION_KINDS)[number];

export const AI_SUGGESTION_STATUSES = [
  'pending',
  'accepted',
  'dismissed',
  'expired',
  'superseded',
] as const;

export type AiSuggestionStatus = (typeof AI_SUGGESTION_STATUSES)[number];

/**
 * A band, never a percentage.
 *
 * docs/06 §7 asks for evidence rather than a score, and this is the half of that rule the type
 * system can carry: there is no shape here into which a model-invented `0.84` fits. The band
 * is computed from how many independent facts support the suggestion and how far the
 * observation sits from its threshold — a rule a human can read and disagree with, which is
 * more than can be said for a number a model produced about its own reliability.
 */
export const AI_CONFIDENCE_BANDS = ['low', 'medium', 'high'] as const;

export type AiConfidenceBand = (typeof AI_CONFIDENCE_BANDS)[number];

/** The four copilot surfaces. Each has its own permission and its own tool set. */
export const AI_COPILOT_SURFACES = [
  'principal_insights',
  'teacher_tools',
  'accounts',
  'admissions',
] as const;

export type AiCopilotSurface = (typeof AI_COPILOT_SURFACES)[number];

export const AI_SUGGESTION_EXECUTION_STATES = ['not_started', 'executed', 'failed'] as const;

export type AiSuggestionExecutionState = (typeof AI_SUGGESTION_EXECUTION_STATES)[number];

/** What a suggestion can be about. Mirrors `subject_type`, which is a soft reference. */
export const AI_SUGGESTION_SUBJECT_TYPES = [
  'student',
  'section',
  'admission_application',
  'timetable_entry',
  'expense_claim',
] as const;

export type AiSuggestionSubjectType = (typeof AI_SUGGESTION_SUBJECT_TYPES)[number];

export const AI_SUGGESTION_SORT_FIELDS = ['createdAt', 'expiresAt', 'kind', 'status'] as const;

// ── Evidence ─────────────────────────────────────────────────────────────────────────

/**
 * One checkable fact.
 *
 * `source` names the tool that produced it — `attendance.summary`, `finance.outstanding` — so
 * a reviewer who doubts a line can re-run exactly that call with exactly those `arguments` and
 * compare. That is what makes this evidence rather than justification: the database refuses an
 * entry that omits either half (0034, `ai_suggestion_evidence_is_wellformed`), so a suggestion
 * cannot reach a teacher carrying a conclusion and no way to check it.
 *
 * `observed` holds the figures themselves, so the card can render "61.00% since 1 April"
 * without re-deriving anything, and so a stored suggestion still says what it saw after the
 * underlying rows have moved on.
 */
export const aiSuggestionEvidenceEntrySchema = z.object({
  source: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .describe('The tool or query that produced this fact, e.g. "attendance.summary".'),
  statement: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe('The fact itself, in words a human can disagree with.'),
  /** The exact arguments the source was called with, so the check is reproducible. */
  arguments: z.record(z.unknown()).optional(),
  /** The figures behind the statement, so the card does not have to re-derive them. */
  observed: z.record(z.unknown()).optional(),
  recordedAt: z.string().datetime().optional(),
});

export type AiSuggestionEvidenceEntry = z.infer<typeof aiSuggestionEvidenceEntrySchema>;

export const aiSuggestionEvidenceSchema = z
  .array(aiSuggestionEvidenceEntrySchema)
  .min(1, 'A suggestion must carry at least one checkable fact');

// ── Proposed actions ─────────────────────────────────────────────────────────────────

/**
 * A shortlist note may move an application forward through *review*, never to a decision.
 *
 * `selected` and `rejected` are reachable through the admissions module's own endpoint by a
 * human who chose them, and they are unreachable through this one. docs/06 §6 says an AI must
 * never approve an admission; the honest reading of that is not "the AI must not press the
 * button" — a suggestion nobody scrutinises is the AI pressing the button through a person —
 * but "the AI must not be able to put that outcome in front of somebody as a pre-filled,
 * one-click payload".
 */
export const AI_ADMISSION_SUGGESTION_TARGETS = [
  'under_review',
  'shortlisted',
  'waitlisted',
] as const;

export const aiAdmissionShortlistPayloadSchema = z.object({
  status: z.enum(AI_ADMISSION_SUGGESTION_TARGETS),
  reason: reasonSchema,
});

/**
 * An expense flag can only ever resolve to a refusal.
 *
 * The kind exists because a copilot noticed a claim that does not look like the others. The
 * only action that follows from "this looks unusual" is "do not pay it until somebody has
 * explained it". An AI-drafted payload that could carry `approved` would be a mechanism for a
 * model to nudge a school into paying — which is the failure docs/06 §6 lists as "issue
 * refunds" and "create accounting entries" wearing a different hat.
 */
export const aiExpenseFlagPayloadSchema = z.object({
  decision: z.literal('rejected'),
  reason: reasonSchema,
});

/**
 * Covering a vacant period names the timetable as well as the entry.
 *
 * The module's own endpoint takes the timetable in the path and the rest in the body, and its
 * service refuses an entry that belongs to a different timetable — a client that mixes the two
 * is confused about which routine it is editing. The stored payload therefore carries both, so
 * the accept path can reproduce the call exactly rather than guessing the path segment.
 */
export const aiTimetableGapFillPayloadSchema = createTimetableSubstitutionSchema.extend({
  timetableId: uuidSchema,
});

/**
 * Kind → the schema the payload is validated against, on the way in AND at accept time.
 *
 * Three kinds share `createMessageThreadSchema` because they are the same action wearing three
 * labels: opening a thread and writing its first message. They are separate *kinds* because
 * the reviewer's question differs — "should we chase this absence", "should we chase this
 * bill", "should we send this" — and because the review queue is only useful if it can be
 * filtered by that question.
 */
export const AI_SUGGESTION_PAYLOAD_SCHEMAS = {
  attendance_follow_up: createMessageThreadSchema,
  fee_reminder_draft: createMessageThreadSchema,
  communication_draft: createMessageThreadSchema,
  intervention_referral: createBehaviourRecordSchema,
  admission_shortlist_note: aiAdmissionShortlistPayloadSchema,
  timetable_gap_fill: aiTimetableGapFillPayloadSchema,
  expense_flag: aiExpenseFlagPayloadSchema,
} as const satisfies Record<AiSuggestionKind, z.ZodTypeAny>;

/**
 * The stored envelope.
 *
 * `module` and `action` are recorded rather than inferred at accept time so the row states,
 * in its own words, which service it expects to be handed to. The accept path re-derives the
 * same pair from the kind and refuses a row where the two disagree — a suggestion written
 * under an old mapping must not be executed under a new one.
 */
export const aiSuggestionProposedActionSchema = z.object({
  module: z.string().trim().min(1).max(64),
  action: z.string().trim().min(1).max(64),
  /** The record the action is performed on, for the kinds that act on an existing row. */
  resourceId: uuidSchema.optional(),
  payload: z.record(z.unknown()),
});

export type AiSuggestionProposedAction = z.infer<typeof aiSuggestionProposedActionSchema>;

// ── The copilot turn ─────────────────────────────────────────────────────────────────

/**
 * One question to one copilot surface.
 *
 * `question` is free text a person typed, and it is the single most attacker-adjacent field in
 * this module — a guardian's phrasing reaches a teacher's copilot the same way a guardian's
 * leave request does. It is never concatenated into an instruction: it travels as a `user`
 * message, and anything the tools hand back to be quoted goes through the untrusted-data
 * envelope in `modules/ai-tools`. Neither of those is expressible in a Zod schema, which is
 * why the schema's job here is only to bound the size.
 *
 * `conversationId` continues an existing thread. Omitting it starts one, which is the common
 * case: most copilot questions are one-shot.
 */
export const askAiCopilotSchema = z.object({
  surface: z.enum(AI_COPILOT_SURFACES),
  question: z
    .string()
    .trim()
    .min(3, 'Ask a question of at least 3 characters')
    .max(2000, 'Ask a shorter question — a copilot turn is not a document'),
  conversationId: uuidSchema.optional(),
  /** What the question is about, when the client already knows. Narrows suggestion subjects. */
  subjectType: z.enum(AI_SUGGESTION_SUBJECT_TYPES).optional(),
  subjectId: uuidSchema.optional(),
}).superRefine((value, ctx) => {
  // Half a soft reference is a suggestion nobody can attribute later. The database enforces
  // the same rule on `ai_conversations`; enforcing it here turns a 500 into a 422 with a path.
  if ((value.subjectType === undefined) !== (value.subjectId === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['subjectId'],
      message: 'Give both subjectType and subjectId, or neither',
    });
  }
});

export type AskAiCopilotInput = z.infer<typeof askAiCopilotSchema>;

// ── Reading the queue ────────────────────────────────────────────────────────────────

export const listAiSuggestionsSchema = paginationSchema.merge(sortSchema).extend({
  status: z.enum(AI_SUGGESTION_STATUSES).optional(),
  kind: z.enum(AI_SUGGESTION_KINDS).optional(),
  surface: z.enum(AI_COPILOT_SURFACES).optional(),
  subjectType: z.enum(AI_SUGGESTION_SUBJECT_TYPES).optional(),
  subjectId: uuidSchema.optional(),
  /**
   * Off by default.
   *
   * A pending suggestion whose `expiresAt` has passed is not actionable — the accept path
   * refuses it — so showing it in the default queue would put a card in front of a reviewer
   * that does nothing when clicked. It stays reachable for anyone auditing what the copilot
   * proposed and nobody got to.
   */
  includeExpired: z.coerce.boolean().default(false),
});

export type ListAiSuggestionsInput = z.infer<typeof listAiSuggestionsSchema>;

// ── Deciding ─────────────────────────────────────────────────────────────────────────

/**
 * Bounded at 500 rather than reusing `reasonSchema`'s 1000, because `decision_reason` is
 * `varchar(500)`. A schema that admits a value the column refuses turns a user's careful
 * explanation into a 500 at the very end of the request.
 */
const suggestionReasonSchema = z
  .string()
  .trim()
  .min(10, 'Give a reason of at least 10 characters — this is recorded in the audit log')
  .max(500);

/**
 * Accepting.
 *
 * `version` is the optimistic lock: two people looking at the same review queue must not both
 * accept the same suggestion and send a parent two messages. A mismatch is a 409 telling the
 * second person to reload, which is the same contract every other decision endpoint here has.
 *
 * The reason is optional. Accepting means "yes, do this, for the reasons written on the card";
 * demanding a fresh justification for agreeing with evidence already recorded on the row is
 * ceremony, and ceremony is what teaches people to type "ok" into required fields.
 */
export const acceptAiSuggestionSchema = z.object({
  note: suggestionReasonSchema.optional(),
  version: z.number().int().min(1),
});

export type AcceptAiSuggestionInput = z.infer<typeof acceptAiSuggestionSchema>;

/**
 * Dismissing, which DOES require a reason.
 *
 * The asymmetry is deliberate. Why a suggestion was rejected is the only signal anyone will
 * ever have about whether the copilot is worth having — "the family already paid", "wrong
 * child", "we spoke to them yesterday" are three completely different verdicts on the system,
 * and without them the only available measure is an acceptance rate, which is a measure of how
 * agreeable staff are.
 */
export const dismissAiSuggestionSchema = z.object({
  reason: suggestionReasonSchema,
  version: z.number().int().min(1),
});

export type DismissAiSuggestionInput = z.infer<typeof dismissAiSuggestionSchema>;
