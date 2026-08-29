/**
 * AI tutor (Phase 35) — the student-facing surface.
 *
 * The staff copilot and the student tutor share a transcript store and nothing else. These
 * three tables are the difference, and each of them exists because a rule that protects a
 * child belongs in the schema rather than in a service comment:
 *
 *  1. **A session is anchored.** `anchorKind` / `anchorId` name one piece of the school's own
 *     material — a course, a lesson, a homework assignment, a quiz question — and
 *     `anchorIsAssessed` is resolved once, at creation, from that record. A tutor with no
 *     anchor is a general-purpose chatbot pointed at a twelve-year-old, which is not the
 *     product.
 *  2. **`tutorTurns` is append-only** (`tutor_turns_no_mutation`), for the same reason
 *     `aiMessages` is: what a school's AI told a child is evidence, and the first time
 *     anybody needs it will be an argument about it.
 *  3. **Uncertainty carries evidence** (docs/06 §7). `groundingLevel` is a label and
 *     `groundingReasons` is a non-empty array of sentences — the database refuses an empty
 *     one. A number with no reasons cannot be argued with, and a student who cannot argue
 *     with it will either follow it blindly or ignore it entirely.
 *  4. **A safeguarding flag is closed by a person.** `tutor_flags_review_is_human` refuses
 *     a review whose `reviewedBy` is not the acting user of the connection, so no scheduled
 *     job and no service account can mark a child's disclosure as handled. Nothing else
 *     happens when a flag is raised: no message, no guardian contact, no referral. The
 *     system's whole job here is to stop and fetch an adult.
 *
 * The transcript is deliberately NOT duplicated. One `aiConversations` row per session (a
 * unique index says so) and every message in `aiMessages`, which is already append-only and
 * already metered by the usage ledger.
 *
 * Who may read a session is not expressed here at all: it is `tutor_session_visible_to()` in
 * 0036, one SQL expression the service calls and the integration suite calls directly, so
 * the rule has exactly one definition rather than three `where` clauses that drift.
 */

import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  actorColumns,
  archiveColumns,
  primaryKeyColumn,
  timestampColumns,
  versionColumn,
} from './_shared';
import { institutions, organizations } from './tenancy';
import { users } from './identity';
import { students } from './students';
import { aiConversations, aiMessages } from './ai';

// ─────────────────────────────────────────────────────────────────────────────────────
// Enumerations. Every set is genuinely closed: each one changes tutor code as well as the
// schema, and none of them is something a school configures for itself.
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * What a session is anchored to. The anchor decides two things at once: which of the
 * school's material the tutor may draw on, and whether the assessed-work rules apply.
 */
export const tutorAnchorKindEnum = pgEnum('tutor_anchor_kind', [
  'course',
  'lesson',
  'assignment',
  'quiz_question',
]);

/** Open, or finished. Finishing is a timestamp, not an opinion. */
export const tutorSessionStatusEnum = pgEnum('tutor_session_status', ['active', 'ended']);

/**
 * What happened on one turn.
 *
 * `guidance_only` is separate from `guided` on purpose: it is the countable record that the
 * tutor was asked for the answer to assessed work and gave method instead. A rule nobody can
 * count is a rule nobody can audit.
 */
export const tutorTurnOutcomeEnum = pgEnum('tutor_turn_outcome', [
  'guided',
  'guidance_only',
  'no_citation',
  'safeguarding_hold',
]);

/** How well an answer was grounded. A label, and it never travels without its reasons. */
export const tutorGroundingLevelEnum = pgEnum('tutor_grounding_level', [
  'grounded',
  'partial',
  'ungrounded',
]);

/**
 * What kind of disclosure raised a flag. A SIGNAL for a human, never a finding — the tutor
 * has no business categorising a child's situation, only saying which words made it stop.
 */
export const tutorFlagSignalEnum = pgEnum('tutor_flag_signal', [
  'self_harm',
  'abuse_or_neglect',
  'bullying',
  'violence',
  'unspecified_distress',
]);

/** Pending until a named person has read it. There is no third state and no auto-close. */
export const tutorFlagStatusEnum = pgEnum('tutor_flag_status', ['pending', 'reviewed']);

/** One citation, as stored on a turn. Shaped by what a reader needs to check the claim. */
export interface TutorCitation {
  documentId: string;
  documentTitle: string;
  chunkId: string;
  /** Cosine similarity, as reported by retrieval. Presented beside a reason, never alone. */
  score: number;
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────────────────────────────────────────────

export const tutorSessions = pgTable(
  'tutor_sessions',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    /**
     * Whose session it is. The *student* record, not the user: a session outlives a login
     * being reissued, and every visibility question is asked about the child.
     */
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'restrict' }),
    /** The transcript. Unique — two sessions sharing one would make the record unreadable. */
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => aiConversations.id, { onDelete: 'restrict' }),
    anchorKind: tutorAnchorKindEnum('anchor_kind').notNull(),
    anchorId: uuid('anchor_id').notNull(),
    /**
     * Denormalised for the list view and for the refusal message. Teacher-authored text, so
     * every path that puts it in a prompt wraps it in an untrusted-data envelope first.
     */
    anchorLabel: varchar('anchor_label', { length: 255 }).notNull(),
    /**
     * Resolved ONCE, at creation, from the anchored record. Stored rather than re-derived
     * per turn because a teacher who later marks the work ungraded must not retroactively
     * unlock the answers a child was refused last week.
     */
    anchorIsAssessed: boolean('anchor_is_assessed').notNull(),
    status: tutorSessionStatusEnum('status').notNull().default('active'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'date' }),
    endReason: varchar('end_reason', { length: 500 }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('tutor_sessions_tenant_idx').on(table.tenantId),
    index('tutor_sessions_student_idx').on(
      table.institutionId,
      table.studentId,
      table.startedAt,
    ),
    index('tutor_sessions_status_idx').on(table.institutionId, table.status),
    index('tutor_sessions_anchor_idx').on(table.anchorKind, table.anchorId),
    uniqueIndex('tutor_sessions_conversation_key').on(table.conversationId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Turns
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * One exchange, and why the answer was what it was. APPEND-ONLY.
 *
 * The message columns point into `aiMessages` rather than copying text, so there is one
 * transcript and it is the one that is already immutable.
 *
 * `providerKey` null means **no model was consulted** — a safeguarding hold, or a question
 * nothing in the school's material matched. That is a different fact from "a model answered
 * and reported zero tokens", and the columns keep the two apart.
 */
export const tutorTurns = pgTable(
  'tutor_turns',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => tutorSessions.id, { onDelete: 'cascade' }),
    /**
     * Monotonic within a session. Ordering by `createdAt` alone is not enough: the question
     * and its answer are written microseconds apart inside one transaction.
     */
    seq: integer('seq').notNull(),
    studentMessageId: uuid('student_message_id')
      .notNull()
      .references(() => aiMessages.id, { onDelete: 'restrict' }),
    tutorMessageId: uuid('tutor_message_id').references(() => aiMessages.id, {
      onDelete: 'restrict',
    }),
    outcome: tutorTurnOutcomeEnum('outcome').notNull(),
    groundingLevel: tutorGroundingLevelEnum('grounding_level').notNull(),
    /**
     * The evidence. A non-empty array of human-readable sentences — `tutor_turns_reasons_
     * present` refuses an empty one, which is how docs/06 §7 stops being a paragraph and
     * becomes a constraint.
     */
    groundingReasons: jsonb('grounding_reasons').$type<string[]>().notNull().default([]),
    /** What the answer actually rested on. Empty exactly when nothing was retrieved. */
    citations: jsonb('citations').$type<TutorCitation[]>().notNull().default([]),
    /**
     * True when the post-check found the assessed item's own answer key in the model's
     * output and replaced it with guidance. Recorded so the refusal is countable.
     */
    withheldAnswer: boolean('withheld_answer').notNull().default(false),
    providerKey: varchar('provider_key', { length: 32 }),
    model: varchar('model', { length: 128 }),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('tutor_turns_session_seq_key').on(table.sessionId, table.seq),
    index('tutor_turns_tenant_idx').on(table.tenantId),
    index('tutor_turns_session_idx').on(table.sessionId, table.seq),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Safeguarding
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A disclosure of harm, raised for a human.
 *
 * The excerpt is the child's own words, truncated, because the person who reviews this must
 * be able to act without being handed the whole session — the flag is the smallest thing
 * that answers "does an adult need to look at this today".
 *
 * Nothing else happens when a row lands here. No message is sent, no guardian is contacted,
 * no discipline record is opened, no referral is made. A system that decided by itself where
 * to report a child would be making the one decision it is least qualified to make, and the
 * fact that it would usually be right is not an argument.
 */
export const tutorSafeguardingFlags = pgTable(
  'tutor_safeguarding_flags',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => tutorSessions.id, { onDelete: 'restrict' }),
    /** One flag per turn — a retry must not put the same disclosure in the queue twice. */
    turnId: uuid('turn_id')
      .notNull()
      .references(() => tutorTurns.id, { onDelete: 'restrict' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'restrict' }),
    signal: tutorFlagSignalEnum('signal').notNull(),
    excerpt: varchar('excerpt', { length: 1000 }).notNull(),
    status: tutorFlagStatusEnum('status').notNull().default('pending'),
    raisedAt: timestamp('raised_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    /**
     * The adult who closed it. The database checks this against the connection's own
     * `app.user_id`, so it is the person who actually acted rather than a name supplied by
     * whatever wrote the row.
     */
    reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'restrict' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'date' }),
    /** What they decided and why. Required to close the flag; a checkbox is not a record. */
    reviewNote: varchar('review_note', { length: 1000 }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('tutor_flags_tenant_idx').on(table.tenantId),
    index('tutor_flags_student_idx').on(table.institutionId, table.studentId),
    uniqueIndex('tutor_flags_turn_key').on(table.turnId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Relations
// ─────────────────────────────────────────────────────────────────────────────────────

export const tutorSessionsRelations = relations(tutorSessions, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [tutorSessions.tenantId],
    references: [organizations.id],
  }),
  institution: one(institutions, {
    fields: [tutorSessions.institutionId],
    references: [institutions.id],
  }),
  student: one(students, {
    fields: [tutorSessions.studentId],
    references: [students.id],
  }),
  conversation: one(aiConversations, {
    fields: [tutorSessions.conversationId],
    references: [aiConversations.id],
  }),
  turns: many(tutorTurns),
  flags: many(tutorSafeguardingFlags),
}));

export const tutorTurnsRelations = relations(tutorTurns, ({ one }) => ({
  session: one(tutorSessions, {
    fields: [tutorTurns.sessionId],
    references: [tutorSessions.id],
  }),
  studentMessage: one(aiMessages, {
    fields: [tutorTurns.studentMessageId],
    references: [aiMessages.id],
  }),
}));

export const tutorSafeguardingFlagsRelations = relations(tutorSafeguardingFlags, ({ one }) => ({
  session: one(tutorSessions, {
    fields: [tutorSafeguardingFlags.sessionId],
    references: [tutorSessions.id],
  }),
  turn: one(tutorTurns, {
    fields: [tutorSafeguardingFlags.turnId],
    references: [tutorTurns.id],
  }),
  student: one(students, {
    fields: [tutorSafeguardingFlags.studentId],
    references: [students.id],
  }),
  reviewer: one(users, {
    fields: [tutorSafeguardingFlags.reviewedBy],
    references: [users.id],
  }),
}));
