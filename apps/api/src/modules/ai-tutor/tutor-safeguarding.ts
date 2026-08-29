/**
 * Safeguarding signals for the student tutor (Phase 35).
 *
 * ── What this is, and what it deliberately is not ─────────────────────────────────────
 *
 * This is a **signal for a human**. It is not a classifier, not an assessment, not a
 * finding, and nothing downstream of it may treat it as one. When it fires, three things
 * happen and no more: the model is not consulted, the student is shown a supportive holding
 * message, and a row appears in a queue that a named adult has to read.
 *
 * What must NEVER follow from it: an automated message to a guardian, an automated referral
 * to anyone inside or outside the school, a discipline record, a notification to a teacher
 * chosen by the system, or an AI-generated response to the disclosure itself. A system that
 * decided by itself where to report a child would be making the single decision it is least
 * qualified to make, and the fact that it would usually be right is not an argument. The
 * routes in this module enforce that by containing no such call; the integration suite
 * enforces it by asserting that nothing else was written.
 *
 * ── Why phrase matching rather than a model ───────────────────────────────────────────
 *
 * Two reasons, and the second is the important one.
 *
 *  1. Sending a distressed child's words to a third-party inference API to ask "is this a
 *     disclosure?" is exactly the moment not to send them anywhere. The whole point of the
 *     hold is that nothing leaves the building.
 *  2. A rule you can read is a rule a designated safeguarding lead can argue with. They can
 *     look at this list, say "children here say X and you are missing it", and have it
 *     changed. Nobody can do that with a score from a model, and the person who most needs
 *     to be able to is the person with the least access to one.
 *
 * The consequence is accepted openly: this misses things. Phrasing that no list anticipates,
 * a child writing in a mix of Bangla and English, indirection, a joke that is not one. It is
 * a floor under the tutor, not a safeguarding system — the school's safeguarding system is
 * people, and this exists so that a conversation a child has at eleven at night with a piece
 * of software does not vanish into a transcript nobody reads.
 *
 * It is tuned to **over-refer**. A false positive costs an adult two minutes; a false
 * negative costs something that cannot be priced.
 */

import type { TutorFlagSignal } from '@shikkha/validation';

/** What the scan concluded, when it concluded something. */
export interface SafeguardingHit {
  signal: TutorFlagSignal;
  /**
   * The phrase that matched, for the audit trail and for the lead who tunes this list.
   * The pattern's own source, never the child's surrounding words — those are in the
   * excerpt on the flag, where they belong, once.
   */
  matched: string;
}

interface SignalRule {
  signal: TutorFlagSignal;
  patterns: RegExp[];
}

/**
 * Bangla and English, because a child in distress writes in whichever comes first and it is
 * usually not the one the school's software was demonstrated in.
 *
 * Bangla patterns cannot use `\b`: the word-boundary class is defined over ASCII word
 * characters, so `\bআত্মহত্যা\b` matches in places nobody intends and fails in places
 * everybody does. They are matched as plain substrings instead, which is correct for a
 * script with no case and no inflectional suffix stripping here.
 */
const SIGNAL_RULES: readonly SignalRule[] = [
  {
    signal: 'self_harm',
    patterns: [
      /\bkill(ing)? myself\b/i,
      /\bend (my life|it all)\b/i,
      /\b(want|wanna|going) to die\b/i,
      /\bdon'?t want to (live|be here|wake up)\b/i,
      /\b(hurt|harm|cut) (myself|my ?self)\b/i,
      /\bcutting myself\b/i,
      /\bsuicid(e|al)\b/i,
      /\bno reason to live\b/i,
      /\beveryone would be better off without me\b/i,
      /আত্মহত্যা/,
      /মরে যেতে চাই/,
      /বাঁচতে ইচ্ছে করে না/,
    ],
  },
  {
    signal: 'abuse_or_neglect',
    patterns: [
      /\b(my (father|mother|dad|mum|mom|uncle|aunt|stepfather|stepmother)|he|she|they) (hits|beats|hit|beat) me\b/i,
      /\bbeaten at home\b/i,
      /\btouch(ed|es|ing) me\b/i,
      /\bmade me touch\b/i,
      /\bnobody feeds me\b/i,
      /\bi (am|'m) not safe at home\b/i,
      /\bscared to go home\b/i,
      /\blocked me (in|out)\b/i,
      /বাড়িতে মারে/,
      /গায়ে হাত/,
      /খেতে দেয় না/,
    ],
  },
  {
    signal: 'bullying',
    patterns: [
      /\bbull(y|ies|ied|ying) me\b/i,
      /\bthey (beat|hit|kick|push) me at school\b/i,
      /\beveryone (hates|laughs at) me\b/i,
      /\bafraid to (come|go) to school\b/i,
      /\bthey took my (money|food|tiffin)\b/i,
      /র‍্যাগিং/,
      /স্কুলে যেতে ভয়/,
    ],
  },
  {
    signal: 'violence',
    patterns: [
      /\bthreatened to (kill|hurt|stab)\b/i,
      /\b(bring|bringing|brought) a (knife|blade|weapon)\b/i,
      /\bi (will|am going to) hurt (him|her|them|someone)\b/i,
      /\bgoing to (beat|stab) (him|her|them)\b/i,
      /মেরে ফেলব/,
      /ছুরি নিয়ে/,
    ],
  },
  {
    // The catch-all, last: only reached when nothing more specific matched, so a clear
    // disclosure is never filed under "distress" and softened.
    signal: 'unspecified_distress',
    patterns: [
      /\bi (am|'m) not safe\b/i,
      /\bi feel unsafe\b/i,
      /\bnobody can help me\b/i,
      /\bi (am|'m) (so )?(scared|frightened|terrified) (all the time|every day)\b/i,
      /\bi have nobody\b/i,
      /\bi can'?t take (it|this) any ?more\b/i,
      /কেউ নেই/,
      /খুব ভয় লাগে/,
    ],
  },
];

/**
 * Scan one student message.
 *
 * Rules are evaluated in order and the first hit wins, so a specific disclosure is never
 * demoted to `unspecified_distress` by the catch-all sitting below it.
 *
 * Returns `null` for the overwhelming majority of messages, which are about fractions.
 */
export function scanForSafeguarding(text: string): SafeguardingHit | null {
  // Zero-width and bidi characters are stripped before matching for the same reason the
  // untrusted-data envelope strips them: they are invisible to a human reading the
  // transcript afterwards and they break a pattern that would otherwise have fired. A child
  // has no reason to type one, so their presence is either a paste artefact or an evasion,
  // and both should be matched through rather than around.
  const normalised = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  for (const rule of SIGNAL_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(normalised)) {
        return { signal: rule.signal, matched: pattern.source };
      }
    }
  }
  return null;
}

/**
 * What the student is shown instead of an answer.
 *
 * Written to be the same every time, on purpose. A generated response here would be a
 * machine improvising with a child who has just said something serious, and the variation
 * would make it impossible to know afterwards what they were actually told. It says three
 * things and stops: I heard you, this is going to a person, here is who to reach right now.
 *
 * The national helpline is Bangladesh's government child helpline, which is free from any
 * operator. It is named rather than "contact someone" because a child at eleven at night
 * needs a number, not advice about seeking help.
 */
export const SAFEGUARDING_HOLDING_MESSAGE = [
  'Thank you for telling me. What you have said matters, and I am not the right kind of help for it.',
  '',
  'I have let a member of staff at your school know that you asked for help, so that a person can talk to you. I have not told anyone what your schoolwork is like or shared anything else about you.',
  '',
  'If you need to talk to someone right now, you can call the child helpline 1098 free from any phone in Bangladesh, at any time of day or night. If you are in immediate danger, tell an adult near you or call 999.',
  '',
  'When you are ready, I am still here for your schoolwork.',
].join('\n');

/**
 * The reasons recorded on a held turn.
 *
 * docs/06 §7 applies here as much as to an academic answer: the record says WHY the tutor
 * stopped, so the adult who reads it can disagree with the rule that stopped it.
 */
export function safeguardingReasons(hit: SafeguardingHit): string[] {
  return [
    `The message matched a safeguarding signal (${hit.signal.replace(/_/g, ' ')}), so the tutor stopped and raised it for a member of staff.`,
    'No AI model was consulted for this message: a disclosure of harm is not sent to an inference provider and is not answered by a generated reply.',
    'Nothing else happened automatically. No guardian was contacted, no referral was made and no record was opened anywhere else — a person decides all of that.',
  ];
}

/**
 * The excerpt stored on the flag, so the adult reviewing it can act without being handed the
 * whole session.
 *
 * Truncated at the column width and flattened to a single line. The child's own words,
 * unaltered otherwise: paraphrasing a disclosure before a safeguarding lead reads it would
 * be the software editing the only part of this that matters.
 */
export function safeguardingExcerpt(text: string): string {
  const flattened = text.replace(/\s+/g, ' ').trim();
  return flattened.length <= 1_000 ? flattened : `${flattened.slice(0, 997)}...`;
}
