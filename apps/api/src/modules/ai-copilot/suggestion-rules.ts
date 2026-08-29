/**
 * What turns a copilot turn into a suggestion.
 *
 * The single most important thing about this file is what it does NOT do: it does not ask the
 * model whether a suggestion is warranted, and it does not read one out of the model's prose.
 * Every rule here is a deterministic function of the **tool results the copilot actually ran**
 * — permission-checked reads, each one already audited with the caller and the row count.
 *
 * That is not stylistic caution. A suggestion is a row a human is about to act on, and the two
 * things a language model is worst at are exactly the two things a suggestion needs: reporting
 * a number it was given without altering it, and knowing how sure it is. So the model writes
 * the answer the user reads, and this file decides whether anything should be proposed, on
 * what evidence, and in which confidence band. Rule 7 of this codebase — no fabricated score —
 * is not satisfied by asking the model politely; it is satisfied by there being no code path
 * through which a model-produced number can become a suggestion's confidence or evidence.
 *
 * ── Arithmetic ─────────────────────────────────────────────────────────────────────────
 *
 * Tools report percentages as two-decimal strings and money as decimal strings. Nothing here
 * parses either into a JavaScript number:
 *
 *  - a percentage becomes an integer count of hundredths, so `< 80.00` is `< 8000` and the
 *    comparison is exact at the boundary rather than "exact except at 79.995";
 *  - money is never compared numerically at all. The only question asked of an amount is "is
 *    any of it non-zero", which is answered on the digits (ADR-004: no floating point
 *    anywhere near a school's money, including in a threshold).
 *
 * ── The confidence band ────────────────────────────────────────────────────────────────
 *
 * A band, and the rule that produces it is written out below in full so that a teacher who
 * asks "why does it say high" gets an answer that is a sentence rather than a shrug. It rests
 * on two things a model cannot see and a query can: **how much data the observation is made
 * of**, and **how far it sits from the threshold**. Ten marked days at 79% and a hundred and
 * twenty at 58% are not equally strong statements, and a system that renders both as
 * "Medium — 0.72" has thrown away the only part that mattered.
 */

import type { AiConfidenceBand, AiSuggestionEvidenceEntry, AiToolName } from '@shikkha/validation';

/** One permission-checked tool call and what it returned, collected during the copilot loop. */
export interface ToolObservation {
  tool: AiToolName;
  arguments: Record<string, unknown>;
  result: unknown;
}

/**
 * A rule's verdict: something is worth proposing about this subject, on this evidence, at this
 * confidence.
 *
 * Deliberately does not carry a payload. Building the payload needs the database — which
 * guardian holds the portal account, which academic year is current, which behaviour category
 * a referral belongs to — and mixing those reads into the rules would make the rules
 * untestable and would hide a query inside what reads like a pure predicate.
 */
export interface SuggestionFinding {
  kind: 'attendance_follow_up' | 'intervention_referral' | 'fee_reminder_draft';
  studentId: string;
  evidence: AiSuggestionEvidenceEntry[];
  confidence: AiConfidenceBand;
  /** Everything the message or record body needs, already exact and already a string. */
  facts: Record<string, string | number | null>;
}

// ── Thresholds. Every one is a number a school could reasonably disagree with, which is why
//    each is named, commented and in one place rather than inline in a condition. ──────────

/** Below this, a guardian should hear from the school. 80.00%, in hundredths. */
const ATTENDANCE_FOLLOW_UP_BELOW = 8000;
/** Below this it is no longer a note home; it is a child who needs somebody to look. 60.00%. */
const ATTENDANCE_REFERRAL_BELOW = 6000;
/** Fewer marks than this and the percentage is noise. Two school weeks. */
const MIN_MARKS_FOR_FOLLOW_UP = 10;
/** A referral is a permanent record about a child, so it asks for a month of evidence. */
const MIN_MARKS_FOR_REFERRAL = 20;
/** Enough marks that the figure is stable rather than one bad fortnight. */
const MARKS_FOR_HIGH_CONFIDENCE = 40;
/** Far enough below the threshold that a few corrections would not move the verdict. 70.00%. */
const ATTENDANCE_CLEARLY_LOW = 7000;
/** A subject average this low corroborates an attendance concern. 40.00%. */
const RESULTS_CONCERN_BELOW = 4000;

// ── Exact arithmetic on the strings the tools return ───────────────────────────────────

/**
 * `"61.00"` → `6100`. Null in, null out; anything unparseable, null out.
 *
 * String arithmetic rather than `parseFloat` because the comparisons below are threshold
 * comparisons and a threshold that is wrong at its own boundary is worse than no threshold: it
 * produces a suggestion for one child at 80.00% and not for the next, for reasons nobody can
 * reconstruct. Two decimal places is the tools' documented contract (`formatHundredths`), and
 * a value with more or fewer is refused rather than rounded, because rounding here would be
 * this module quietly deciding something the tool did not say.
 */
export function hundredthsOf(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,5})\.(\d{2})$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number(match[2]);
}

/**
 * True when a decimal amount string is non-zero and positive.
 *
 * The only question this module ever asks of money. Answered on the digits so no amount is
 * ever converted to a float, not even for a comparison against zero — a rule that admits one
 * exception acquires a second one within a year.
 */
export function isPositiveAmount(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.startsWith('-')) return false;
  return /[1-9]/.test(trimmed);
}

// ── Reading a tool result without trusting its shape ───────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

export interface AttendanceReading {
  studentId: string;
  from: string;
  to: string;
  hundredths: number;
  countedMarks: number;
  absent: number;
  present: number;
  openRegistersExcluded: number;
}

/** The student variant of `attendance.summary`, or null if this observation is not one. */
export function readAttendance(observation: ToolObservation): AttendanceReading | null {
  if (observation.tool !== 'attendance.summary') return null;
  const data = asRecord(observation.result);
  const about = asRecord(data?.['about']);
  if (!data || about?.['kind'] !== 'student') return null;

  const studentId = asString(about['studentId']);
  const hundredths = hundredthsOf(asString(data['attendancePercentage']));
  const countedMarks = asInteger(data['countedMarks']);
  if (!studentId || hundredths === null || countedMarks === null) return null;

  return {
    studentId,
    from: asString(data['from']) ?? '',
    to: asString(data['to']) ?? '',
    hundredths,
    countedMarks,
    absent: asInteger(data['absent']) ?? 0,
    present: asInteger(data['present']) ?? 0,
    openRegistersExcluded: asInteger(data['openRegistersExcluded']) ?? 0,
  };
}

export interface ResultsReading {
  studentId: string;
  examsCounted: number;
  averageHundredths: number | null;
  allPublished: boolean;
}

export function readResults(observation: ToolObservation): ResultsReading | null {
  if (observation.tool !== 'results.summary') return null;
  const data = asRecord(observation.result);
  const overall = asRecord(data?.['overall']);
  const studentId = asString(data?.['studentId']);
  if (!data || !studentId) return null;

  return {
    studentId,
    examsCounted: asInteger(data['examsCounted']) ?? 0,
    averageHundredths: hundredthsOf(asString(overall?.['averagePercentage'])),
    allPublished: data['allPublished'] === true,
  };
}

export interface OutstandingReading {
  studentId: string;
  academicYearId: string;
  asOfDate: string;
  outstanding: string;
  ageing: Record<string, string>;
  invoiceCount: number;
}

/** The single-student variant of `finance.outstanding`. A school-wide total is not chaseable. */
export function readOutstanding(observation: ToolObservation): OutstandingReading | null {
  if (observation.tool !== 'finance.outstanding') return null;
  const data = asRecord(observation.result);
  const studentId = asString(observation.arguments['studentId']);
  const ageing = asRecord(data?.['ageing']);
  const outstanding = asString(data?.['outstanding']);
  if (!data || !studentId || !ageing || outstanding === null) return null;

  const buckets: Record<string, string> = {};
  for (const [key, value] of Object.entries(ageing)) {
    if (typeof value === 'string') buckets[key] = value;
  }

  return {
    studentId,
    academicYearId: asString(data['academicYearId']) ?? '',
    asOfDate: asString(data['asOfDate']) ?? '',
    outstanding,
    ageing: buckets,
    invoiceCount: asInteger(data['invoiceCount']) ?? 0,
  };
}

// ── The rules ──────────────────────────────────────────────────────────────────────────

/**
 * Everything worth proposing from one copilot turn.
 *
 * The attendance rules form a ladder rather than an overlap: below 60% is a referral, 60–80%
 * is a note home, and a child never generates both in one turn. Two cards about one child
 * saying nearly the same thing is how a review queue teaches people to skim it.
 */
export function deriveFindings(observations: readonly ToolObservation[]): SuggestionFinding[] {
  const findings: SuggestionFinding[] = [];

  const resultsByStudent = new Map<string, ResultsReading>();
  for (const observation of observations) {
    const reading = readResults(observation);
    if (reading) resultsByStudent.set(reading.studentId, reading);
  }

  const seen = new Set<string>();

  for (const observation of observations) {
    const attendance = readAttendance(observation);
    if (attendance) {
      const finding = attendanceFinding(
        attendance,
        observation,
        resultsByStudent.get(attendance.studentId) ?? null,
      );
      if (finding && !seen.has(`${finding.kind}:${finding.studentId}`)) {
        seen.add(`${finding.kind}:${finding.studentId}`);
        findings.push(finding);
      }
      continue;
    }

    const outstanding = readOutstanding(observation);
    if (outstanding) {
      const finding = feeFinding(outstanding, observation);
      if (finding && !seen.has(`${finding.kind}:${finding.studentId}`)) {
        seen.add(`${finding.kind}:${finding.studentId}`);
        findings.push(finding);
      }
    }
  }

  return findings;
}

function attendanceEvidence(
  reading: AttendanceReading,
  observation: ToolObservation,
): AiSuggestionEvidenceEntry {
  return {
    source: 'attendance.summary',
    statement:
      `Attendance is ${formatHundredths(reading.hundredths)}% over ${reading.from} to ` +
      `${reading.to}, from ${reading.countedMarks} counted marks (${reading.absent} absences).`,
    arguments: observation.arguments,
    observed: {
      attendancePercentage: formatHundredths(reading.hundredths),
      countedMarks: reading.countedMarks,
      present: reading.present,
      absent: reading.absent,
      from: reading.from,
      to: reading.to,
      // Reported, never hidden: a percentage computed while registers are still open is
      // provisional, and a reviewer is entitled to know the office may see a different number.
      openRegistersExcluded: reading.openRegistersExcluded,
    },
  };
}

function attendanceFinding(
  reading: AttendanceReading,
  observation: ToolObservation,
  results: ResultsReading | null,
): SuggestionFinding | null {
  const facts = {
    attendancePercentage: formatHundredths(reading.hundredths),
    countedMarks: reading.countedMarks,
    absent: reading.absent,
    from: reading.from,
    to: reading.to,
  };

  // A referral: severe, and made of enough data to be a statement about a term rather than a
  // fortnight.
  if (
    reading.hundredths < ATTENDANCE_REFERRAL_BELOW &&
    reading.countedMarks >= MIN_MARKS_FOR_REFERRAL
  ) {
    const evidence = [attendanceEvidence(reading, observation)];

    // Corroboration, when the same turn happened to look at results. Never fetched on purpose:
    // going and reading a child's marks because their attendance is low would be this module
    // widening its own data access, which is the behaviour the tool layer exists to prevent.
    const corroborated =
      results !== null &&
      results.examsCounted > 0 &&
      results.averageHundredths !== null &&
      results.averageHundredths < RESULTS_CONCERN_BELOW;

    if (corroborated && results) {
      evidence.push({
        source: 'results.summary',
        statement:
          `Average across ${results.examsCounted} exam(s) is ` +
          `${formatHundredths(results.averageHundredths!)}%` +
          (results.allPublished ? '.' : ', and not every result is published yet.'),
        observed: {
          examsCounted: results.examsCounted,
          averagePercentage: formatHundredths(results.averageHundredths!),
          allPublished: results.allPublished,
        },
      });
    }

    return {
      kind: 'intervention_referral',
      studentId: reading.studentId,
      evidence,
      // Two independent facts, or a term's worth of one. Anything less is a concern worth
      // raising and not yet worth putting on a child's permanent record at high confidence.
      confidence:
        corroborated || reading.countedMarks >= MARKS_FOR_HIGH_CONFIDENCE ? 'high' : 'medium',
      facts,
    };
  }

  if (
    reading.hundredths < ATTENDANCE_FOLLOW_UP_BELOW &&
    reading.countedMarks >= MIN_MARKS_FOR_FOLLOW_UP
  ) {
    return {
      kind: 'attendance_follow_up',
      studentId: reading.studentId,
      evidence: [attendanceEvidence(reading, observation)],
      confidence: attendanceFollowUpBand(reading),
      facts,
    };
  }

  return null;
}

/**
 * high   — a term's worth of marks AND clearly below 70%: a few corrections cannot move it.
 * medium — a month's worth of marks: the figure is stable but the margin is not wide.
 * low    — the minimum: real, worth a look, and easily explained by two weeks of illness.
 */
function attendanceFollowUpBand(reading: AttendanceReading): AiConfidenceBand {
  if (reading.countedMarks >= MARKS_FOR_HIGH_CONFIDENCE && reading.hundredths < ATTENDANCE_CLEARLY_LOW) {
    return 'high';
  }
  if (reading.countedMarks >= MIN_MARKS_FOR_REFERRAL) return 'medium';
  return 'low';
}

/**
 * Money that is owed and overdue.
 *
 * `notYetDue` alone produces nothing. Chasing a parent for a bill that has not fallen due is
 * how a school teaches its families to ignore its messages, and a copilot that generates one
 * has misunderstood the ageing report it just read.
 */
function feeFinding(
  reading: OutstandingReading,
  observation: ToolObservation,
): SuggestionFinding | null {
  const overdueBuckets = ['days1To30', 'days31To60', 'days61To90', 'over90Days'];
  const overdue = overdueBuckets.filter((bucket) => isPositiveAmount(reading.ageing[bucket]));
  if (overdue.length === 0 || !isPositiveAmount(reading.outstanding)) return null;

  return {
    kind: 'fee_reminder_draft',
    studentId: reading.studentId,
    evidence: [
      {
        source: 'finance.outstanding',
        statement:
          `Outstanding fees are BDT ${reading.outstanding} as at ${reading.asOfDate}, across ` +
          `${reading.invoiceCount} invoice(s); overdue in ${overdue.join(', ')}.`,
        arguments: observation.arguments,
        observed: {
          outstanding: reading.outstanding,
          invoiceCount: reading.invoiceCount,
          asOfDate: reading.asOfDate,
          ...reading.ageing,
        },
      },
    ],
    // How long it has been owed, which is the only thing about a debt that gets more certain
    // with time. A balance overdue by more than ninety days is not an administrative timing
    // difference.
    confidence: isPositiveAmount(reading.ageing['over90Days'])
      ? 'high'
      : isPositiveAmount(reading.ageing['days31To60']) ||
          isPositiveAmount(reading.ageing['days61To90'])
        ? 'medium'
        : 'low',
    facts: {
      outstanding: reading.outstanding,
      asOfDate: reading.asOfDate,
      academicYearId: reading.academicYearId,
      invoiceCount: reading.invoiceCount,
      oldestOverdueBucket: overdue[overdue.length - 1] ?? null,
    },
  };
}

/** `6100` → `"61.00"`. The inverse of `hundredthsOf`, so a stored figure round-trips exactly. */
export function formatHundredths(value: number): string {
  const whole = Math.trunc(value / 100);
  const fraction = Math.abs(value % 100);
  return `${whole}.${String(fraction).padStart(2, '0')}`;
}
