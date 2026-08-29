/**
 * Carrying out an accepted suggestion — through the owning module's own service, never around
 * it.
 *
 * Every branch below is one call into the module that owns the record. Nothing here writes to
 * `message_threads`, `behaviour_records`, `admission_applications`, `timetable_substitutions`
 * or `expense_claims` directly, and that is the property the whole phase rests on: the owning
 * service's validation runs (a behaviour record still needs the reporter to be an employee
 * with the student in their teaching scope), its own refusals run (an expense claim still
 * cannot be decided by the person who filed it), and its state machine still refuses an
 * impossible transition. A suggestion is a *shortcut to the form*, not a bypass of it.
 *
 * ── The audit row the owning module would have written ─────────────────────────────────
 *
 * Most of these modules write their audit record in the `AuditInterceptor`, from the route
 * metadata, rather than inside the service. Reaching the service directly therefore skips it,
 * and the action would be invisible in that module's trail — a message thread that exists with
 * nothing in `audit_logs` saying who opened it. So this file writes the equivalent record
 * itself, in the owning module's vocabulary (`module: 'communication'`, `resourceType:
 * 'message_thread'`, `action: 'create'`), with `isAiInitiated: true`.
 *
 * `accounting.decideExpenseClaim` is the exception: it audits inside its own transaction, so
 * duplicating it here would put two rows in the accounting trail for one decision, the second
 * with a null previous value — exactly the double-write `recordedBy: 'service'` exists to
 * prevent elsewhere. `OWNING_SERVICE_WRITES_ITS_OWN_AUDIT` below records which is which.
 *
 * ── Why the payload is re-validated ────────────────────────────────────────────────────
 *
 * It was validated when the suggestion was written, and `ai_suggestions_content_immutable`
 * means it cannot have changed since. Re-validating costs a microsecond and covers the one
 * writer the trigger exempts — the migrator — plus every future path that inserts a row from
 * somewhere this module cannot see. A payload that fails here is a 422 naming the field, which
 * is a far better outcome than handing a malformed object to another module's service and
 * reading the resulting stack trace three days later.
 */

import { Injectable } from '@nestjs/common';
import { ValidationError } from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import {
  AI_SUGGESTION_PAYLOAD_SCHEMAS,
  type AiSuggestionKind,
  type AiSuggestionProposedAction,
  type CreateBehaviourRecordInput,
  type CreateMessageThreadInput,
} from '@shikkha/validation';
import { AuditService } from '../audit/audit.service';
import { CommunicationService } from '../communication/communication.service';
import { DisciplineService } from '../discipline/discipline.service';
import { AdmissionsService } from '../admissions/admissions.service';
import { TimetableService } from '../timetable/timetable.service';
import { AccountingService } from '../accounting/accounting.service';
import { currentContext } from '../../common/context/request-context';
import { toFieldIssues } from '../../common/pipes/zod-validation.pipe';
import { contractFor } from './suggestion-contracts';

export interface ExecutionOutcome {
  resourceType: string;
  resourceId: string;
  /** A short human-readable label for the audit trail and the API response. */
  resourceLabel: string;
}

/**
 * Which owning services audit themselves.
 *
 * A map rather than a flag on the contract table because it is a fact about the *current
 * implementation* of another module, not about the suggestion. If accounting ever moves its
 * audit into the interceptor, this is the one line that changes; if it were part of the
 * contract, the change would look like a change to the permission model.
 */
const OWNING_SERVICE_WRITES_ITS_OWN_AUDIT: Readonly<Record<AiSuggestionKind, boolean>> = {
  attendance_follow_up: false,
  fee_reminder_draft: false,
  communication_draft: false,
  intervention_referral: false,
  admission_shortlist_note: false,
  timetable_gap_fill: false,
  expense_flag: true,
};

@Injectable()
export class SuggestionExecutorService {
  constructor(
    private readonly audit: AuditService,
    private readonly communication: CommunicationService,
    private readonly discipline: DisciplineService,
    private readonly admissions: AdmissionsService,
    private readonly timetable: TimetableService,
    private readonly accounting: AccountingService,
  ) {}

  async execute(
    principal: Principal,
    institutionId: string,
    kind: AiSuggestionKind,
    proposedAction: AiSuggestionProposedAction,
    suggestionId: string,
  ): Promise<ExecutionOutcome> {
    const contract = contractFor(kind);
    const payload = this.parsePayload(kind, proposedAction.payload);

    const outcome = await this.dispatch(
      principal,
      institutionId,
      kind,
      proposedAction,
      payload,
    );

    if (!OWNING_SERVICE_WRITES_ITS_OWN_AUDIT[kind]) {
      await this.recordOwningModuleAudit(
        principal,
        institutionId,
        contract.module,
        contract.auditAction,
        outcome,
        suggestionId,
      );
    }

    return outcome;
  }

  /** The dispatch table. One branch, one owning service, no direct table access anywhere. */
  private async dispatch(
    principal: Principal,
    institutionId: string,
    kind: AiSuggestionKind,
    proposedAction: AiSuggestionProposedAction,
    payload: unknown,
  ): Promise<ExecutionOutcome> {
    switch (kind) {
      case 'attendance_follow_up':
      case 'fee_reminder_draft':
      case 'communication_draft': {
        const { thread } = await this.communication.createThread(
          principal,
          institutionId,
          payload as CreateMessageThreadInput,
        );
        return {
          resourceType: 'message_thread',
          resourceId: thread.id,
          resourceLabel: thread.subject,
        };
      }

      case 'intervention_referral': {
        const record = await this.discipline.createRecord(
          principal,
          institutionId,
          payload as CreateBehaviourRecordInput,
        );
        // The module gives a behaviour record no human-facing number, so the id is the label.
        // Inventing one here would put a reference in the audit trail that appears nowhere in
        // the discipline screens a reader would go looking in.
        return {
          resourceType: 'behaviour_record',
          resourceId: record.id,
          resourceLabel: record.id,
        };
      }

      case 'admission_shortlist_note': {
        const input = payload as { status: 'under_review' | 'shortlisted' | 'waitlisted'; reason: string };
        const { application } = await this.admissions.transition(
          principal,
          this.requireResourceId(proposedAction),
          input.status,
          input.reason,
        );
        return {
          resourceType: 'admission_application',
          resourceId: application.id,
          resourceLabel: application.applicationNumber,
        };
      }

      case 'timetable_gap_fill': {
        const input = payload as {
          timetableId: string;
          entryId: string;
          substitutionDate: string;
          substituteEmployeeId: string;
          reason: string;
        };
        const substitution = await this.timetable.createSubstitution(
          principal,
          institutionId,
          input.timetableId,
          {
            entryId: input.entryId,
            substitutionDate: input.substitutionDate,
            substituteEmployeeId: input.substituteEmployeeId,
            reason: input.reason,
          },
        );
        return {
          resourceType: 'timetable_substitution',
          resourceId: substitution.id,
          resourceLabel: `Cover on ${input.substitutionDate}`,
        };
      }

      case 'expense_flag': {
        const input = payload as { decision: 'rejected'; reason: string };
        const claim = await this.accounting.decideExpenseClaim(
          principal,
          institutionId,
          this.requireResourceId(proposedAction),
          // The payload schema admits only `rejected`; the literal is repeated here so that a
          // future widening of the schema is a compile error rather than a silently
          // AI-suggested approval of a payment.
          'rejected',
          input.reason,
        );
        return {
          resourceType: 'expense_claim',
          resourceId: claim.id,
          resourceLabel: claim.claimNumber,
        };
      }
    }
  }

  private parsePayload(kind: AiSuggestionKind, payload: unknown): unknown {
    const parsed = AI_SUGGESTION_PAYLOAD_SCHEMAS[kind].safeParse(payload);
    if (!parsed.success) {
      throw new ValidationError(
        'This suggestion\'s proposed action is not a payload the owning module accepts',
        toFieldIssues(parsed.error),
      );
    }
    return parsed.data;
  }

  private requireResourceId(proposedAction: AiSuggestionProposedAction): string {
    if (!proposedAction.resourceId) {
      // Unreachable through the generator, which fills it in for every kind whose contract
      // says `requiresResourceId`. Reachable through a hand-written row, and a 422 naming the
      // field beats a query with `undefined` in its where clause.
      throw new ValidationError('This suggestion names no record to act on', [
        { path: 'proposedAction.resourceId', message: 'Required for this kind of suggestion' },
      ]);
    }
    return proposedAction.resourceId;
  }

  /**
   * The record the owning module's route interceptor would have written.
   *
   * `isAiInitiated: true`, because it was: a model drafted this and a person confirmed it.
   * docs/06 §6 keeps that flag on the column precisely so the question "how was this decided"
   * is still answerable years later, and a thread opened from a copilot suggestion that looks
   * identical in the trail to one a clerk typed is the exact ambiguity it exists to remove.
   * `newValue` carries the suggestion id, so the trail leads from the action back to the
   * evidence it was taken on.
   */
  private async recordOwningModuleAudit(
    principal: Principal,
    institutionId: string,
    module: string,
    auditAction: 'create' | 'update',
    outcome: ExecutionOutcome,
    suggestionId: string,
  ): Promise<void> {
    const context = currentContext();
    await this.audit.record({
      tenantId: principal.tenantId,
      institutionId,
      campusId: context?.campusId ?? null,
      actorUserId: principal.userId,
      actorRoles: principal.roles.map((role) => role.roleKey),
      action: auditAction,
      module,
      resourceType: outcome.resourceType,
      resourceId: outcome.resourceId,
      resourceLabel: outcome.resourceLabel,
      previousValue: null,
      newValue: { createdFromAiSuggestionId: suggestionId },
      reason: null,
      requestId: context?.requestId ?? null,
      ipAddress: context?.ipAddress ?? null,
      userAgent: context?.userAgent ?? null,
      isAiInitiated: true,
    });
  }
}
