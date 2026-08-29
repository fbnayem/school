/**
 * Kind → the action it stands for, and the permission that action needs.
 *
 * THIS TABLE IS THE POINT OF PHASE 33. docs/06 §6 says AI suggests and a human confirms, and
 * the confirmation is "a normal permission-checked, audited API call made by the human". The
 * trap in implementing that is to check `ai.copilot.use` on the accept route — the permission
 * to *use the assistant* — which would mean anyone who may open a copilot may also send a
 * parent a fee demand, file a behaviour record about a child, cover a period with a colleague
 * who did not agree to it, and refuse an expense claim. The assistant would have acquired
 * every authority in the school by being the thing that suggested the action.
 *
 * So each kind names the permission of the ACTION, and the accept route checks that one:
 *
 *   attendance_follow_up      communication.send
 *   fee_reminder_draft        communication.send
 *   communication_draft       communication.send
 *   intervention_referral     discipline.records.create
 *   admission_shortlist_note  admissions.applications.review
 *   timetable_gap_fill        timetable.substitute
 *   expense_flag              accounting.journal.post
 *
 * Each of those is the permission the owning module's own endpoint already requires for the
 * same call, read out of that controller rather than chosen here — see the per-entry notes.
 * The owning service checks it again when the accept path calls it, so this table is the
 * *early* refusal, not the only one. That ordering matters: a caller who lacks the permission
 * is refused before the suggestion is claimed, so a 403 leaves the suggestion pending for
 * somebody who can actually act on it.
 *
 * `actionPermission` is also written onto the suggestion row at generation time and compared
 * with this table at accept time. Two independent statements of one rule, because the failure
 * mode of a single statement is a suggestion generated under an old mapping being accepted
 * under a new one with nobody noticing the permission moved.
 *
 * ── Kinds with no generator yet ────────────────────────────────────────────────────────
 *
 * Four of the seven — `communication_draft`, `admission_shortlist_note`, `timetable_gap_fill`
 * and `expense_flag` — have a complete accept path and no rule that produces one, because
 * producing one honestly requires facts no permission-checked tool currently returns:
 * admissions has no tool, the timetable tool reports the routine but not who is absent, and
 * the accounts tool reports fees rather than spending. A generator that invented those facts
 * would be exactly the thing this batch exists to prevent, so there is none. What is built for
 * them is the half that must never be improvised later under time pressure: the permission,
 * the payload schema and the executor.
 */

import type { Permission } from '@shikkha/permissions';
import type { AiSuggestionKind, AiSuggestionSubjectType } from '@shikkha/validation';

export interface SuggestionActionContract {
  kind: AiSuggestionKind;
  /** Recorded in `proposed_action.module` and re-checked against it at accept time. */
  module: string;
  /** Recorded in `proposed_action.action`. Names the service call, not the HTTP verb. */
  action: string;
  /**
   * The permission the ACTION requires — never the copilot's.
   *
   * Exactly one string, deliberately. A disjunction here would be a place for a second, wider
   * permission to be added later "so the workflow is not blocked", and the row could no longer
   * state in its own words what accepting it costs.
   */
  actionPermission: Permission;
  subjectType: AiSuggestionSubjectType;
  /** True when the action operates on an existing record named by `proposedAction.resourceId`. */
  requiresResourceId: boolean;
  /** What the owning module creates or changes, recorded on the suggestion after execution. */
  executedResourceType: string;
  /**
   * The verb for the audit row written on the owning module's behalf.
   *
   * `create` where the action produces a record, `update` where it moves one. Naming a
   * transition `create` would make that module's own trail lie about what happened to a
   * child's application, which is precisely the trail somebody will read years later.
   */
  auditAction: 'create' | 'update';
  /** One line for the capabilities endpoint, written for the person reading it. */
  describes: string;
}

export const SUGGESTION_ACTION_CONTRACTS: Readonly<
  Record<AiSuggestionKind, SuggestionActionContract>
> = {
  /**
   * Contact the guardian about an absence pattern.
   *
   * `communication.send` is what `POST /communication/threads` requires, and the service
   * re-checks it: `createThread` treats a caller without it as a guardian or student and
   * refuses to let them reach anyone outside their own family.
   */
  attendance_follow_up: {
    kind: 'attendance_follow_up',
    module: 'communication',
    action: 'thread.create',
    actionPermission: 'communication.send',
    subjectType: 'student',
    requiresResourceId: false,
    executedResourceType: 'message_thread',
    auditAction: 'create',
    describes: 'Open a thread with the guardian about an attendance pattern',
  },

  /**
   * Chase an overdue balance.
   *
   * Deliberately NOT `finance.*`. Accepting this sends a message; it does not touch the
   * ledger, does not waive, does not collect and does not void. Requiring a finance permission
   * would misdescribe what happens and would hand the accounts office a messaging capability
   * through a side door.
   */
  fee_reminder_draft: {
    kind: 'fee_reminder_draft',
    module: 'communication',
    action: 'thread.create',
    actionPermission: 'communication.send',
    subjectType: 'student',
    requiresResourceId: false,
    executedResourceType: 'message_thread',
    auditAction: 'create',
    describes: 'Open a thread with the billing contact about an overdue balance',
  },

  /** Any other drafted message the copilot produced for a person to review and send. */
  communication_draft: {
    kind: 'communication_draft',
    module: 'communication',
    action: 'thread.create',
    actionPermission: 'communication.send',
    subjectType: 'student',
    requiresResourceId: false,
    executedResourceType: 'message_thread',
    auditAction: 'create',
    describes: 'Open a thread with a drafted message',
  },

  /**
   * Refer a child for pastoral intervention.
   *
   * `discipline.records.create` is what `POST /discipline/records` requires. The service adds
   * two conditions this table cannot express and must not duplicate: the reporter needs an
   * employee record, and the student must be inside the reporter's own teaching scope. Both
   * run when the accept path calls it.
   */
  intervention_referral: {
    kind: 'intervention_referral',
    module: 'discipline',
    action: 'record.create',
    actionPermission: 'discipline.records.create',
    subjectType: 'student',
    requiresResourceId: false,
    executedResourceType: 'behaviour_record',
    auditAction: 'create',
    describes: 'File a pastoral referral for a student who is falling behind',
  },

  /**
   * Move an application through review with a note.
   *
   * The admissions controller admits `admissions.applications.review` OR
   * `admissions.applications.decide` on this route; this table requires the first, which is
   * the narrower reading and the one that matches what the payload can express — the payload
   * schema admits only `under_review`, `shortlisted` and `waitlisted`, so a `decide`-only
   * holder is not being denied anything they could have proposed here anyway.
   */
  admission_shortlist_note: {
    kind: 'admission_shortlist_note',
    module: 'admissions',
    action: 'application.transition',
    actionPermission: 'admissions.applications.review',
    subjectType: 'admission_application',
    requiresResourceId: true,
    executedResourceType: 'admission_application',
    auditAction: 'update',
    describes: 'Move an application through review against the published criteria',
  },

  /**
   * Cover a vacant period.
   *
   * `timetable.substitute` is what `POST /timetables/:id/substitutions` requires — not
   * `timetable.manage`, which is permission to change the routine itself. A cover is a
   * one-day arrangement, and conflating the two would mean anyone who may arrange cover may
   * also rewrite the published timetable.
   */
  timetable_gap_fill: {
    kind: 'timetable_gap_fill',
    module: 'timetable',
    action: 'substitution.create',
    actionPermission: 'timetable.substitute',
    subjectType: 'timetable_entry',
    requiresResourceId: true,
    executedResourceType: 'timetable_substitution',
    auditAction: 'create',
    describes: 'Arrange cover for a vacant period',
  },

  /**
   * Refuse an expense claim that does not look like the others.
   *
   * `accounting.journal.post` is what `POST /accounting/expense-claims/:id/decision` requires.
   * The catalogue has no expense-claim permission of its own, and the accounting controller
   * records the same gap: the journal permissions govern, with `create` filing a claim and
   * `post` deciding it. An accountant holds `create` and not `post`, which is exactly the
   * separation this suggestion needs — the person who files does not decide.
   */
  expense_flag: {
    kind: 'expense_flag',
    module: 'accounting',
    action: 'expense_claim.decide',
    actionPermission: 'accounting.journal.post',
    subjectType: 'expense_claim',
    requiresResourceId: true,
    executedResourceType: 'expense_claim',
    auditAction: 'update',
    describes: 'Refuse an expense claim that does not match the others',
  },
};

export function contractFor(kind: AiSuggestionKind): SuggestionActionContract {
  return SUGGESTION_ACTION_CONTRACTS[kind];
}

/**
 * The permission required to SEE a suggestion whose subject is not a person the caller can
 * already be scoped against.
 *
 * Student and section subjects are scoped on the data — the caller sees a suggestion about a
 * child exactly when they could open that child's record, which reuses `StudentsService`'s own
 * filter and therefore cannot disagree with it. The other three subject types have no such
 * per-row scope, so they fail closed on a domain read permission instead:
 *
 *   admission_application  admissions.applications.view
 *   expense_claim          accounting.journal.view   (the claim body names a colleague and a sum)
 *   timetable_entry        timetable.view
 *
 * Without this, a teacher with `ai.copilot.use` would see a card reading "Refuse Mr Rahman's
 * ৳48,000 travel claim" in their own review queue. The suggestion body is a disclosure in its
 * own right, and hiding it behind the accept permission alone would be hiding the button and
 * leaving the sentence.
 */
export const SUBJECT_VIEW_PERMISSIONS: Readonly<
  Partial<Record<AiSuggestionSubjectType, Permission>>
> = {
  admission_application: 'admissions.applications.view',
  expense_claim: 'accounting.journal.view',
  timetable_entry: 'timetable.view',
};
