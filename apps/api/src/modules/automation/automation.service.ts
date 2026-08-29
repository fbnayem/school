/**
 * Automation engine service (Phase 26).
 *
 * `docs/08_WORKFLOW_ENGINE.md` §5 draws the line this file has to hold: the workflow engine
 * carries *human* approval chains, the automation engine carries *rule-triggered* reactions,
 * and **where a rule needs a human decision, the rule creates a workflow request or a
 * suggestion rather than acting.** Suggest, review, confirm — the same shape as the AI
 * phases, for the same reason.
 *
 * The load-bearing decisions:
 *
 *  - **A rule cannot autonomously perform a sensitive action, structurally.** The
 *    `automation_action_kind` enum has no value that changes a grade, an attendance mark, an
 *    approval, a payment, a salary, or deletes anything; a rule naming a sensitive
 *    `targetResource` is refused unless it requires human confirmation and can do nothing but
 *    raise a suggestion or start an approval chain — refused by Zod, refused again here, and
 *    refused a third time by `automation_rules_sensitive_needs_human` in migration 0030. A
 *    rule that requires confirmation produces a SUGGESTION and changes nothing else.
 *  - **Conditions are evaluated by an allow-listed evaluator, never by an interpreter.** A
 *    clause names a field from `EVENT_CATALOG` (the event's declared payload fields) or from
 *    `FACT_CATALOG` (facts this file computes with parameterised SQL), an operator from a
 *    closed enum, and a literal. There is no property traversal, no `eval`, no client SQL;
 *    an unknown field or operator is a 422 naming it. The same allow-list governs
 *    `{{placeholder}}` substitution in message and summary text.
 *  - **Execution is idempotent twice over.** `automation_events.dedupe_key` is unique per
 *    institution, so the same upstream event cannot enter the log twice; and a rule with a
 *    cooldown will not act again for the same *subject* inside the window, so a guardian is
 *    not messaged five times in an hour. Both suppressions are recorded, not silent.
 *  - **Every matched rule leaves an execution row** — acted, suppressed, awaiting a human, or
 *    failed. Each rule runs in its own transaction, which is what makes "a failing rule must
 *    not block other rules" true rather than aspirational: a Postgres error aborts its own
 *    transaction and nothing else, and the failure is recorded in a fresh one.
 *
 * **There is no scheduler and no background worker in this module, deliberately.**
 * `POST /automation/events/process` drains the pending queue and `GET /automation/schedule/due`
 * reports which scheduled rules are due at a given instant. Both are ordinary
 * permission-checked endpoints, which makes the behaviour testable today and keeps *when*
 * things run a deployment concern (a cron entry, a queue worker, a Kubernetes CronJob) rather
 * than a process this API has to own. `cron_expression` and `timezone` are stored and
 * reported; this module never executes them.
 *
 * Nothing here reimplements a peer. Approval chains go to `WorkflowService.startWorkflow`;
 * messages go to `CommunicationService.createThread`, which is append-only, permission-checked
 * and built on the one notification abstraction; student visibility goes to
 * `StudentsService.assertVisible`, so an emitter cannot name a student they may not see.
 */

import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import {
  attendanceSessions,
  automationEvents,
  automationExecutions,
  automationRules,
  automationSuggestions,
  employeeDocuments,
  guardians,
  invoices,
  roles,
  studentAttendance,
  studentGuardians,
  students,
  userRoles,
  users,
} from '@shikkha/db';
import {
  buildOffsetPage,
  calendarDate,
  ConflictError,
  daysBetween,
  Money,
  NotFoundError,
  offsetOf,
  parseSort,
  todayInDhaka,
  uuidv7,
  ValidationError,
  type FieldIssue,
  type OffsetPage,
  type OffsetPageRequest,
} from '@shikkha/shared';
import { grantCovers, isPermission, type Principal } from '@shikkha/permissions';
import {
  AUTOMATION_EVENT_SORT_FIELDS,
  AUTOMATION_EXECUTION_SORT_FIELDS,
  AUTOMATION_RULE_SORT_FIELDS,
  AUTOMATION_SUGGESTION_SORT_FIELDS,
  SENSITIVE_AUTOMATION_TARGETS,
  type AutomationActionInput,
  type AutomationActivityReportQuery,
  type AutomationConditionClause,
  type AutomationConditionInput,
  type CreateAutomationRuleInput,
  type EmitAutomationEventInput,
  type ListAutomationEventsQuery,
  type ListAutomationExecutionsQuery,
  type ListAutomationRulesQuery,
  type ListAutomationSuggestionsQuery,
  type ProcessAutomationEventsInput,
  type UpdateAutomationRuleInput,
} from '@shikkha/validation';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { WorkflowService } from '../workflow/workflow.service';
import { CommunicationService } from '../communication/communication.service';
import { StudentsService } from '../students/students.service';
import { currentContext } from '../../common/context/request-context';

type Tx = Parameters<Parameters<DatabaseService['runInTenant']>[0]>[0];

type RuleRow = typeof automationRules.$inferSelect;
type EventRow = typeof automationEvents.$inferSelect;
type ExecutionRow = typeof automationExecutions.$inferSelect;
type SuggestionRow = typeof automationSuggestions.$inferSelect;

type ExecutionStatus = ExecutionRow['status'];

/** Scalar shapes a declared event field may carry. Anything else is refused at emit time. */
type EventFieldType = 'uuid' | 'string' | 'number' | 'boolean';

interface EventContract {
  /** What the event is about, and therefore which facts apply and what a suggestion names. */
  subjectKind: string;
  /** The payload field carrying the subject's id. */
  subjectField: string;
  fields: Readonly<Record<string, EventFieldType>>;
}

/**
 * The event contracts. An event name outside this map cannot be emitted, cannot be named by a
 * rule, and therefore cannot be evaluated — which is what makes "unknown field is a 422"
 * meaningful rather than decorative: the set of legal fields is finite and declared.
 */
const EVENT_CATALOG: Readonly<Record<string, EventContract>> = {
  'attendance.student_absent': {
    subjectKind: 'student',
    subjectField: 'studentId',
    fields: {
      studentId: 'uuid',
      studentName: 'string',
      sectionId: 'uuid',
      date: 'string',
      consecutiveAbsences: 'number',
    },
  },
  'fees.invoice_overdue': {
    subjectKind: 'invoice',
    subjectField: 'invoiceId',
    fields: {
      invoiceId: 'uuid',
      studentId: 'uuid',
      studentName: 'string',
      invoiceNumber: 'string',
      daysOverdue: 'number',
    },
  },
  'hr.document_expiring': {
    subjectKind: 'employee_document',
    subjectField: 'documentId',
    fields: {
      documentId: 'uuid',
      employeeId: 'uuid',
      employeeName: 'string',
      documentType: 'string',
      expiresAt: 'string',
      daysToExpiry: 'number',
    },
  },
  'exams.mark_recorded': {
    subjectKind: 'exam_mark',
    subjectField: 'markId',
    fields: {
      markId: 'uuid',
      studentId: 'uuid',
      studentName: 'string',
      examId: 'uuid',
      subjectName: 'string',
      percentage: 'number',
    },
  },
  /**
   * The one event a rule may raise (`create_record`). It exists so one rule can feed another
   * without either of them acquiring the ability to write anything else, and it is capped at
   * a single hop: a rule triggered BY this event may not raise another.
   */
  'automation.derived': {
    subjectKind: 'automation_execution',
    subjectField: 'executionId',
    fields: {
      executionId: 'uuid',
      ruleKey: 'string',
      studentId: 'uuid',
      note: 'string',
    },
  },
};

/** The only event a `create_record` action may raise. The allow-list has one entry. */
const DERIVED_EVENT_NAME = 'automation.derived';

interface FactContract {
  /** The subject kind this fact can be computed for. */
  subjectKind: string;
  description: string;
}

/**
 * The queryable facts. Each is computed by `computeFacts` with a bound parameter — there is
 * no path by which a rule's text becomes SQL. A fact whose subject kind does not match the
 * triggering event's subject kind is refused when the rule is saved, not at run time.
 */
const FACT_CATALOG: Readonly<Record<string, FactContract>> = {
  student_consecutive_absences: {
    subjectKind: 'student',
    description: 'Absences in a row, counting back from the most recent register',
  },
  invoice_days_overdue: {
    subjectKind: 'invoice',
    description: 'Whole days since the invoice due date; negative before it',
  },
  invoice_balance_poisha: {
    subjectKind: 'invoice',
    description: 'Outstanding balance in poisa (minor units) — never a float',
  },
  employee_document_days_to_expiry: {
    subjectKind: 'employee_document',
    description: 'Whole days until the document expires; negative once it has',
  },
};

/**
 * How many people one `notify` execution may reach.
 *
 * Above this a rule is doing mass communication, which is a sensitive act with its own
 * two-person approval path in the communication module. The automation engine refuses rather
 * than borrowing it.
 */
const MAX_NOTIFY_RECIPIENTS = 20;

/** Registers to look back over when counting consecutive absences. */
const ABSENCE_LOOKBACK_SESSIONS = 90;

const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

const RULE_COLUMNS = {
  key: automationRules.key,
  nameEn: automationRules.nameEn,
  version: automationRules.version,
  createdAt: automationRules.createdAt,
} as const;

const EXECUTION_COLUMNS = {
  matchedAt: automationExecutions.matchedAt,
  status: automationExecutions.status,
  createdAt: automationExecutions.createdAt,
} as const;

const SUGGESTION_COLUMNS = {
  createdAt: automationSuggestions.createdAt,
  status: automationSuggestions.status,
  summary: automationSuggestions.summary,
} as const;

const EVENT_COLUMNS = {
  occurredAt: automationEvents.occurredAt,
  eventName: automationEvents.eventName,
  createdAt: automationEvents.createdAt,
} as const;

/** One clause's verdict, returned by the dry run so a rule author can see *why*. */
export interface ClauseVerdict {
  field: string;
  op: string;
  expected: unknown;
  actual: unknown;
  passed: boolean;
}

export interface RuleEvaluation {
  matched: boolean;
  match: 'all' | 'any';
  clauses: ClauseVerdict[];
  facts: Record<string, number | null>;
  subjectKind: string | null;
  subjectId: string | null;
}

export interface DryRunResult extends RuleEvaluation {
  ruleId: string;
  ruleKey: string;
  /** What the rule would have done. Nothing was done, and nothing was written. */
  wouldDo: string;
  /** True when the rule would raise a suggestion for a human instead of acting. */
  requiresHumanConfirmation: boolean;
}

export interface ProcessResult {
  eventsProcessed: number;
  executions: ExecutionRow[];
}

export interface DueScheduleRow {
  ruleId: string;
  key: string;
  nameEn: string;
  cronExpression: string;
  timezone: string;
  /** Whether the cron expression matches the instant asked about, in the rule's own zone. */
  due: boolean;
  localTime: string;
}

export interface AutomationActivityReport {
  from: string | null;
  to: string | null;
  totals: Record<ExecutionStatus, number>;
  byRule: {
    ruleId: string;
    key: string;
    nameEn: string;
    executions: number;
    acted: number;
    suppressed: number;
    failed: number;
    awaitingConfirmation: number;
  }[];
  pendingSuggestions: number;
  unprocessedEvents: number;
}

@Injectable()
export class AutomationService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly workflow: WorkflowService,
    private readonly communication: CommunicationService,
    private readonly studentsService: StudentsService,
  ) {}

  // ───────────────────────────────────────────────────────────────────────────────────
  // Catalogues — exposed so a rule author can discover what they may reference
  // ───────────────────────────────────────────────────────────────────────────────────

  describeCatalog(): {
    events: { name: string; subjectKind: string; subjectField: string; fields: string[] }[];
    facts: { name: string; subjectKind: string; description: string }[];
    sensitiveTargets: readonly string[];
  } {
    return {
      events: Object.entries(EVENT_CATALOG).map(([name, contract]) => ({
        name,
        subjectKind: contract.subjectKind,
        subjectField: contract.subjectField,
        fields: Object.keys(contract.fields),
      })),
      facts: Object.entries(FACT_CATALOG).map(([name, contract]) => ({
        name,
        subjectKind: contract.subjectKind,
        description: contract.description,
      })),
      sensitiveTargets: SENSITIVE_AUTOMATION_TARGETS,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────────────
  // Rules
  // ───────────────────────────────────────────────────────────────────────────────────

  async listRules(
    _principal: Principal,
    institutionId: string,
    query: ListAutomationRulesQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<RuleRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [
        eq(automationRules.institutionId, institutionId),
        isNull(automationRules.archivedAt),
      ];
      if (query.key) filters.push(eq(automationRules.key, query.key));
      if (query.triggerKind) filters.push(eq(automationRules.triggerKind, query.triggerKind));
      if (query.actionKind) filters.push(eq(automationRules.actionKind, query.actionKind));
      if (query.isActive !== undefined) {
        filters.push(eq(automationRules.isActive, query.isActive));
      } else if (!query.includeInactive) {
        filters.push(eq(automationRules.isActive, true));
      }
      if (query.q) filters.push(ilike(automationRules.nameEn, `%${query.q}%`));

      const where = and(...filters);
      const orderBy = parseSort(query.sort, AUTOMATION_RULE_SORT_FIELDS, {
        field: 'key',
        direction: 'asc',
      }).map((spec) => {
        const column = RULE_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(automationRules)
        .where(where)
        .orderBy(...orderBy, asc(automationRules.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(automationRules)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async getRule(_principal: Principal, institutionId: string, id: string): Promise<RuleRow> {
    return this.db.runInTenant(async (tx) => this.loadRule(tx, institutionId, id));
  }

  async createRule(
    principal: Principal,
    institutionId: string,
    input: CreateAutomationRuleInput,
  ): Promise<RuleRow> {
    this.assertRuleUnderstood(input);

    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select({ id: automationRules.id })
        .from(automationRules)
        .where(
          and(
            eq(automationRules.institutionId, institutionId),
            eq(automationRules.key, input.key),
            isNull(automationRules.archivedAt),
          ),
        )
        .limit(1);
      if (existing) {
        throw new ConflictError(
          `An automation rule with the key ${input.key} already exists. ` +
            'Edit it — that creates a new version — or archive it first.',
          { existingRuleId: existing.id },
        );
      }

      const [rule] = await tx
        .insert(automationRules)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          key: input.key,
          ...this.ruleValues(input),
          version: 1,
          isActive: false,
          isSystem: false,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      if (!rule) throw new ConflictError('The automation rule could not be created');
      return rule;
    });
  }

  /**
   * Editing a rule creates version n+1 and deactivates version n, exactly as editing a
   * workflow definition does. An execution always names the rule *row* it ran under, so the
   * history stays readable against the text that produced it.
   */
  async updateRule(
    principal: Principal,
    institutionId: string,
    id: string,
    input: UpdateAutomationRuleInput,
  ): Promise<{ rule: RuleRow; previous: RuleRow }> {
    this.assertRuleUnderstood(input);

    return this.db.runInTenant(async (tx) => {
      const previous = await this.loadRule(tx, institutionId, id);

      const [latest] = await tx
        .select({ version: automationRules.version })
        .from(automationRules)
        .where(
          and(
            eq(automationRules.institutionId, institutionId),
            eq(automationRules.key, previous.key),
          ),
        )
        .orderBy(desc(automationRules.version))
        .limit(1);

      // Deactivate the old row first: the partial unique index permits only one active
      // version of a key, and the new row inherits whether the old one was live.
      await tx
        .update(automationRules)
        .set({ isActive: false, updatedBy: principal.userId })
        .where(eq(automationRules.id, previous.id));

      const [rule] = await tx
        .insert(automationRules)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          key: previous.key,
          ...this.ruleValues(input),
          version: (latest?.version ?? previous.version) + 1,
          isActive: previous.isActive,
          isSystem: previous.isSystem,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      if (!rule) throw new ConflictError('The automation rule could not be versioned');

      return { rule, previous };
    });
  }

  async activateRule(
    principal: Principal,
    institutionId: string,
    id: string,
    version: number,
  ): Promise<RuleRow> {
    return this.db.runInTenant(async (tx) => {
      const rule = await this.loadRule(tx, institutionId, id);
      if (rule.version !== version) {
        throw new ConflictError('This rule was changed by someone else. Reload and retry.', {
          expectedVersion: version,
          currentVersion: rule.version,
        });
      }
      if (rule.isActive) return rule;

      // Only one active version per key. Standing the others down here makes activating an
      // older version an ordinary, single request rather than a two-step dance.
      await tx
        .update(automationRules)
        .set({ isActive: false, updatedBy: principal.userId })
        .where(
          and(
            eq(automationRules.institutionId, institutionId),
            eq(automationRules.key, rule.key),
            eq(automationRules.isActive, true),
          ),
        );

      const [updated] = await tx
        .update(automationRules)
        .set({ isActive: true, updatedBy: principal.userId })
        .where(eq(automationRules.id, id))
        .returning();
      if (!updated) throw new ConflictError('The automation rule could not be activated');
      return updated;
    });
  }

  async deactivateRule(
    principal: Principal,
    institutionId: string,
    id: string,
    version: number,
  ): Promise<RuleRow> {
    return this.db.runInTenant(async (tx) => {
      const rule = await this.loadRule(tx, institutionId, id);
      if (rule.version !== version) {
        throw new ConflictError('This rule was changed by someone else. Reload and retry.', {
          expectedVersion: version,
          currentVersion: rule.version,
        });
      }

      const [updated] = await tx
        .update(automationRules)
        .set({ isActive: false, updatedBy: principal.userId })
        .where(eq(automationRules.id, id))
        .returning();
      if (!updated) throw new ConflictError('The automation rule could not be deactivated');
      return updated;
    });
  }

  async archiveRule(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<RuleRow> {
    return this.db.runInTenant(async (tx) => {
      await this.loadRule(tx, institutionId, id);
      const [archived] = await tx
        .update(automationRules)
        .set({
          isActive: false,
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
        })
        .where(eq(automationRules.id, id))
        .returning();
      if (!archived) throw new ConflictError('The automation rule could not be archived');
      return archived;
    });
  }

  /**
   * Write the four default rules — the ones docs/08 §5 anticipates — for this institution,
   * INACTIVE, idempotently.
   *
   * Migration 0030 seeds the identical rows for every institution that existed when it ran;
   * this is how an institution created afterwards gets them. A key that already exists is
   * skipped and reported, never overwritten: a school's edits outrank the defaults.
   */
  async installDefaultRules(
    principal: Principal,
    institutionId: string,
  ): Promise<{ created: RuleRow[]; skipped: string[] }> {
    return this.db.runInTenant(async (tx) => {
      const created: RuleRow[] = [];
      const skipped: string[] = [];

      for (const template of DEFAULT_RULES) {
        const [existing] = await tx
          .select({ id: automationRules.id })
          .from(automationRules)
          .where(
            and(
              eq(automationRules.institutionId, institutionId),
              eq(automationRules.key, template.key),
            ),
          )
          .limit(1);
        if (existing) {
          skipped.push(template.key);
          continue;
        }

        const [rule] = await tx
          .insert(automationRules)
          .values({
            id: uuidv7(),
            tenantId: principal.tenantId!,
            institutionId,
            key: template.key,
            nameEn: template.nameEn,
            nameBn: template.nameBn,
            description: template.description,
            triggerKind: template.triggerKind,
            eventName: template.eventName,
            cronExpression: null,
            timezone: 'Asia/Dhaka',
            conditions: template.conditions,
            actionKind: template.action.kind,
            actionConfig: stripKind(template.action),
            isActive: false,
            requiresHumanConfirmation: template.requiresHumanConfirmation,
            cooldownMinutes: template.cooldownMinutes,
            isSystem: true,
            version: 1,
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning();
        if (rule) created.push(rule);
      }

      return { created, skipped };
    });
  }

  /**
   * Evaluate a rule against a sample payload and report what would have happened.
   *
   * Nothing is written: no event, no execution, no suggestion, no message. Facts are still
   * computed for real, against the real subject named in the payload, because a dry run that
   * invents its own facts tells you nothing about the rule you are about to switch on.
   */
  async dryRunRule(
    _principal: Principal,
    institutionId: string,
    id: string,
    payload: Record<string, unknown>,
  ): Promise<DryRunResult> {
    return this.db.runInTenant(async (tx) => {
      const rule = await this.loadRule(tx, institutionId, id);
      if (!rule.eventName) {
        throw new ValidationError('Only event and threshold rules can be dry-run', [
          { path: 'id', message: 'A scheduled rule has no sample payload to evaluate' },
        ]);
      }
      const contract = this.requireContract(rule.eventName);
      const fields = this.readPayload(rule.eventName, contract, payload);
      const evaluation = await this.evaluate(tx, rule, contract, fields);

      return {
        ...evaluation,
        ruleId: rule.id,
        ruleKey: rule.key,
        requiresHumanConfirmation: rule.requiresHumanConfirmation,
        wouldDo: this.describeAction(rule),
      };
    });
  }

  // ───────────────────────────────────────────────────────────────────────────────────
  // Events
  // ───────────────────────────────────────────────────────────────────────────────────

  /**
   * Record something that happened, for rules to react to.
   *
   * Internal in the sense that it is permission-checked and its event names are a closed
   * catalogue — a client cannot invent an event, and cannot attach a field the event does
   * not declare. Where the event names a student, the emitter must be able to *see* that
   * student: `StudentsService.assertVisible` is reused rather than re-derived, so a class
   * teacher cannot raise absence events about another section's children.
   *
   * A repeated `dedupe_key` returns the original event and writes nothing. The unique index
   * is the real guarantee (it also settles a race between two emitters); this check is what
   * turns the guarantee into a calm answer instead of a 500.
   */
  async emitEvent(
    principal: Principal,
    institutionId: string,
    input: EmitAutomationEventInput,
  ): Promise<{ event: EventRow; duplicate: boolean }> {
    const contract = this.requireContract(input.eventName);
    const fields = this.readPayload(input.eventName, contract, input.payload);

    const studentId = typeof fields['studentId'] === 'string' ? fields['studentId'] : null;
    if (studentId) await this.studentsService.assertVisible(principal, studentId);

    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(automationEvents)
        .where(
          and(
            eq(automationEvents.institutionId, institutionId),
            eq(automationEvents.dedupeKey, input.dedupeKey),
          ),
        )
        .limit(1);
      if (existing) return { event: existing, duplicate: true };

      const [event] = await tx
        .insert(automationEvents)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          eventName: input.eventName,
          payload: fields,
          occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
          sourceModule: input.sourceModule,
          dedupeKey: input.dedupeKey,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      if (!event) throw new ConflictError('The automation event could not be recorded');
      return { event, duplicate: false };
    });
  }

  async listEvents(
    _principal: Principal,
    institutionId: string,
    query: ListAutomationEventsQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<EventRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(automationEvents.institutionId, institutionId)];
      if (query.eventName) filters.push(eq(automationEvents.eventName, query.eventName));
      if (query.processed === true) filters.push(isNotNull(automationEvents.processedAt));
      if (query.processed === false) filters.push(isNull(automationEvents.processedAt));

      const where = and(...filters);
      const orderBy = parseSort(query.sort, AUTOMATION_EVENT_SORT_FIELDS, {
        field: 'occurredAt',
        direction: 'desc',
      }).map((spec) => {
        const column = EVENT_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(automationEvents)
        .where(where)
        .orderBy(...orderBy, asc(automationEvents.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(automationEvents)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  /**
   * Drain the pending event queue, or re-run one named event.
   *
   * Each rule runs in its **own** transaction. That is the whole mechanism behind "a failing
   * rule must not block other rules": a Postgres error aborts only the transaction it
   * happened in, and the failure row is written in a fresh one, so the next rule starts
   * clean. Stamping `processed_at` is likewise its own statement — the append-only trigger
   * on `automation_events` permits that one transition and nothing else.
   */
  async processPendingEvents(
    principal: Principal,
    institutionId: string,
    input: ProcessAutomationEventsInput,
  ): Promise<ProcessResult> {
    const pending = await this.db.runInTenant(async (tx) => {
      if (input.eventId) {
        const [one] = await tx
          .select()
          .from(automationEvents)
          .where(
            and(
              eq(automationEvents.id, input.eventId),
              eq(automationEvents.institutionId, institutionId),
            ),
          )
          .limit(1);
        if (!one) throw new NotFoundError('Automation event', input.eventId);
        return [one];
      }

      const filters: SQL[] = [
        eq(automationEvents.institutionId, institutionId),
        isNull(automationEvents.processedAt),
      ];
      if (input.eventName) filters.push(eq(automationEvents.eventName, input.eventName));

      return tx
        .select()
        .from(automationEvents)
        .where(and(...filters))
        .orderBy(asc(automationEvents.occurredAt), asc(automationEvents.id))
        .limit(input.limit);
    });

    const executions: ExecutionRow[] = [];

    for (const event of pending) {
      const contract = EVENT_CATALOG[event.eventName];
      if (!contract) {
        // Unreachable through the API — `emitEvent` refuses an unknown name — but an event
        // whose contract was withdrawn between releases must not wedge the queue.
        await this.markProcessed(principal, event);
        continue;
      }

      const rules = await this.db.runInTenant(async (tx) =>
        tx
          .select()
          .from(automationRules)
          .where(
            and(
              eq(automationRules.institutionId, institutionId),
              eq(automationRules.eventName, event.eventName),
              eq(automationRules.isActive, true),
              isNull(automationRules.archivedAt),
            ),
          )
          .orderBy(asc(automationRules.key)),
      );

      for (const rule of rules) {
        const execution = await this.runRuleSafely(principal, institutionId, rule, event, contract);
        if (execution) executions.push(execution);
      }

      if (!event.processedAt) await this.markProcessed(principal, event);
    }

    return { eventsProcessed: pending.length, executions };
  }

  /**
   * Which scheduled rules are due at a given instant, in each rule's own time zone.
   *
   * This module does not run them. The endpoint exists so that whatever *does* schedule —
   * a cron entry, a queue worker — has one permission-checked place to ask, and so the
   * matching logic is testable without a clock.
   */
  async listDueSchedules(
    _principal: Principal,
    institutionId: string,
    at: Date,
  ): Promise<DueScheduleRow[]> {
    const rules = await this.db.runInTenant(async (tx) =>
      tx
        .select()
        .from(automationRules)
        .where(
          and(
            eq(automationRules.institutionId, institutionId),
            eq(automationRules.triggerKind, 'schedule'),
            eq(automationRules.isActive, true),
            isNull(automationRules.archivedAt),
          ),
        )
        .orderBy(asc(automationRules.key)),
    );

    return rules
      .filter((rule): rule is RuleRow & { cronExpression: string } => rule.cronExpression !== null)
      .map((rule) => {
        const local = localPartsInZone(at, rule.timezone);
        return {
          ruleId: rule.id,
          key: rule.key,
          nameEn: rule.nameEn,
          cronExpression: rule.cronExpression,
          timezone: rule.timezone,
          due: cronMatches(rule.cronExpression, local),
          localTime: `${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}`,
        };
      });
  }

  // ───────────────────────────────────────────────────────────────────────────────────
  // Executions, suggestions and the activity report
  // ───────────────────────────────────────────────────────────────────────────────────

  async listExecutions(
    _principal: Principal,
    institutionId: string,
    query: ListAutomationExecutionsQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<ExecutionRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(automationExecutions.institutionId, institutionId)];
      if (query.ruleId) filters.push(eq(automationExecutions.ruleId, query.ruleId));
      if (query.eventId) filters.push(eq(automationExecutions.eventId, query.eventId));
      if (query.status) filters.push(eq(automationExecutions.status, query.status));
      if (query.subjectId) filters.push(eq(automationExecutions.subjectId, query.subjectId));

      const where = and(...filters);
      const orderBy = parseSort(query.sort, AUTOMATION_EXECUTION_SORT_FIELDS, {
        field: 'matchedAt',
        direction: 'desc',
      }).map((spec) => {
        const column = EXECUTION_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(automationExecutions)
        .where(where)
        .orderBy(...orderBy, asc(automationExecutions.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(automationExecutions)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async listSuggestions(
    _principal: Principal,
    institutionId: string,
    query: ListAutomationSuggestionsQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<SuggestionRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [
        eq(automationSuggestions.institutionId, institutionId),
        eq(automationSuggestions.status, query.status),
        isNull(automationSuggestions.archivedAt),
      ];
      if (query.ruleId) filters.push(eq(automationSuggestions.ruleId, query.ruleId));
      if (query.subjectKind) {
        filters.push(eq(automationSuggestions.subjectKind, query.subjectKind));
      }
      if (query.q) filters.push(ilike(automationSuggestions.summary, `%${query.q}%`));

      const where = and(...filters);
      const orderBy = parseSort(query.sort, AUTOMATION_SUGGESTION_SORT_FIELDS, {
        field: 'createdAt',
        direction: 'desc',
      }).map((spec) => {
        const column = SUGGESTION_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(automationSuggestions)
        .where(where)
        .orderBy(...orderBy, asc(automationSuggestions.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(automationSuggestions)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  /**
   * Accept or dismiss a suggestion.
   *
   * **Accepting records a decision; it does not perform the underlying action.** The reviewer
   * then does the thing themselves, in the module that owns it, under that module's
   * permissions and audit trail. Anything else would be the automation engine acting after
   * all, one indirection later — which is exactly what this module exists not to do, and it
   * is why there is no "and then apply it" branch below.
   */
  async decideSuggestion(
    principal: Principal,
    institutionId: string,
    id: string,
    decision: 'accepted' | 'dismissed',
    note: string,
    version: number,
  ): Promise<SuggestionRow> {
    return this.db.runInTenant(async (tx) => {
      const [suggestion] = await tx
        .select()
        .from(automationSuggestions)
        .where(
          and(
            eq(automationSuggestions.id, id),
            eq(automationSuggestions.institutionId, institutionId),
          ),
        )
        .limit(1);
      if (!suggestion || suggestion.archivedAt) throw new NotFoundError('Suggestion', id);

      if (suggestion.status !== 'pending') {
        throw new ConflictError(
          `This suggestion was already ${suggestion.status} and cannot be decided again`,
          { status: suggestion.status, decidedBy: suggestion.decidedBy },
        );
      }
      if (suggestion.version !== version) {
        throw new ConflictError('This suggestion was changed by someone else. Reload and retry.', {
          expectedVersion: version,
          currentVersion: suggestion.version,
        });
      }

      const [updated] = await tx
        .update(automationSuggestions)
        .set({
          status: decision,
          decidedBy: principal.userId,
          decidedAt: new Date(),
          decisionNote: note,
          version: suggestion.version + 1,
          updatedBy: principal.userId,
        })
        .where(
          and(
            eq(automationSuggestions.id, id),
            eq(automationSuggestions.version, version),
            eq(automationSuggestions.status, 'pending'),
          ),
        )
        .returning();
      if (!updated) {
        throw new ConflictError('This suggestion was changed by someone else. Reload and retry.', {
          expectedVersion: version,
        });
      }
      return updated;
    });
  }

  /**
   * What the automation engine did over a window: counts by status, a per-rule breakdown, and
   * the two backlogs an operator actually wants (suggestions nobody has decided, events nobody
   * has processed). Every figure comes from the execution log, which records suppressions and
   * failures as faithfully as successes.
   */
  async activityReport(
    _principal: Principal,
    institutionId: string,
    query: AutomationActivityReportQuery,
  ): Promise<AutomationActivityReport> {
    const from = query.from ? new Date(query.from) : null;
    const to = query.to ? new Date(query.to) : null;

    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(automationExecutions.institutionId, institutionId)];
      if (from) filters.push(gte(automationExecutions.matchedAt, from));
      if (to) filters.push(lte(automationExecutions.matchedAt, to));
      const where = and(...filters);

      const rows = await tx
        .select({
          ruleId: automationExecutions.ruleId,
          key: automationRules.key,
          nameEn: automationRules.nameEn,
          status: automationExecutions.status,
          total: sql<number>`count(*)::int`,
        })
        .from(automationExecutions)
        .innerJoin(automationRules, eq(automationRules.id, automationExecutions.ruleId))
        .where(where)
        .groupBy(
          automationExecutions.ruleId,
          automationRules.key,
          automationRules.nameEn,
          automationExecutions.status,
        );

      const totals: Record<ExecutionStatus, number> = {
        matched: 0,
        suppressed_cooldown: 0,
        suppressed_duplicate: 0,
        acted: 0,
        failed: 0,
        awaiting_confirmation: 0,
      };
      const byRule = new Map<string, AutomationActivityReport['byRule'][number]>();

      for (const row of rows) {
        totals[row.status] += row.total;
        const entry = byRule.get(row.ruleId) ?? {
          ruleId: row.ruleId,
          key: row.key,
          nameEn: row.nameEn,
          executions: 0,
          acted: 0,
          suppressed: 0,
          failed: 0,
          awaitingConfirmation: 0,
        };
        entry.executions += row.total;
        if (row.status === 'acted') entry.acted += row.total;
        if (row.status === 'failed') entry.failed += row.total;
        if (row.status === 'awaiting_confirmation') entry.awaitingConfirmation += row.total;
        if (row.status === 'suppressed_cooldown' || row.status === 'suppressed_duplicate') {
          entry.suppressed += row.total;
        }
        byRule.set(row.ruleId, entry);
      }

      const [pendingSuggestions] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(automationSuggestions)
        .where(
          and(
            eq(automationSuggestions.institutionId, institutionId),
            eq(automationSuggestions.status, 'pending'),
            isNull(automationSuggestions.archivedAt),
          ),
        );

      const [unprocessedEvents] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(automationEvents)
        .where(
          and(
            eq(automationEvents.institutionId, institutionId),
            isNull(automationEvents.processedAt),
          ),
        );

      return {
        from: from ? from.toISOString() : null,
        to: to ? to.toISOString() : null,
        totals,
        byRule: [...byRule.values()].sort((a, b) => a.key.localeCompare(b.key)),
        pendingSuggestions: pendingSuggestions?.total ?? 0,
        unprocessedEvents: unprocessedEvents?.total ?? 0,
      };
    });
  }

  // ───────────────────────────────────────────────────────────────────────────────────
  // Rule execution
  // ───────────────────────────────────────────────────────────────────────────────────

  private async runRuleSafely(
    principal: Principal,
    institutionId: string,
    rule: RuleRow,
    event: EventRow,
    contract: EventContract,
  ): Promise<ExecutionRow | null> {
    try {
      return await this.runRule(principal, institutionId, rule, event, contract);
    } catch (error) {
      // A rule that throws is one rule's problem. Its transaction is already gone; this
      // failure row is written in a new one, and the loop moves on to the next rule.
      const message = error instanceof Error ? error.message : 'The automation rule failed';
      const fields = (event.payload ?? {}) as Record<string, unknown>;
      const subjectId = readUuid(fields[contract.subjectField]);
      return this.recordExecution(principal, institutionId, {
        id: uuidv7(),
        rule,
        event,
        status: 'failed',
        subjectKind: subjectId ? contract.subjectKind : null,
        subjectId,
        actionResult: {},
        error: message.slice(0, 1000),
        workflowRequestId: null,
      });
    }
  }

  private async runRule(
    principal: Principal,
    institutionId: string,
    rule: RuleRow,
    event: EventRow,
    contract: EventContract,
  ): Promise<ExecutionRow | null> {
    const fields = (event.payload ?? {}) as Record<string, unknown>;
    const subjectId = readUuid(fields[contract.subjectField]);
    const subjectKind = subjectId ? contract.subjectKind : null;

    const evaluation = await this.db.runInTenant(async (tx) =>
      this.evaluate(tx, rule, contract, fields),
    );
    // Conditions that did not hold are not an execution: nothing was triggered. The dry run
    // is where a rule author inspects a non-match, clause by clause.
    if (!evaluation.matched) return null;

    const executionId = uuidv7();

    // Already ran against this event — a re-run after a rule change, or two operators
    // pressing process at the same moment. Recorded, never repeated.
    const alreadyRan = await this.db.runInTenant(async (tx) => {
      const [row] = await tx
        .select({ id: automationExecutions.id })
        .from(automationExecutions)
        .where(
          and(
            eq(automationExecutions.ruleId, rule.id),
            eq(automationExecutions.eventId, event.id),
            inArray(automationExecutions.status, ['acted', 'awaiting_confirmation']),
          ),
        )
        .limit(1);
      return row ?? null;
    });
    if (alreadyRan) {
      return this.recordExecution(principal, institutionId, {
        id: executionId,
        rule,
        event,
        status: 'suppressed_duplicate',
        subjectKind,
        subjectId,
        actionResult: { previousExecutionId: alreadyRan.id },
        error: null,
        workflowRequestId: null,
      });
    }

    if (rule.cooldownMinutes > 0 && subjectId) {
      const since = new Date(Date.now() - rule.cooldownMinutes * 60_000);
      const recent = await this.db.runInTenant(async (tx) => {
        const [row] = await tx
          .select({ id: automationExecutions.id, matchedAt: automationExecutions.matchedAt })
          .from(automationExecutions)
          .where(
            and(
              eq(automationExecutions.ruleId, rule.id),
              eq(automationExecutions.subjectId, subjectId),
              inArray(automationExecutions.status, ['acted', 'awaiting_confirmation']),
              gte(automationExecutions.matchedAt, since),
            ),
          )
          .orderBy(desc(automationExecutions.matchedAt))
          .limit(1);
        return row ?? null;
      });
      if (recent) {
        return this.recordExecution(principal, institutionId, {
          id: executionId,
          rule,
          event,
          status: 'suppressed_cooldown',
          subjectKind,
          subjectId,
          actionResult: {
            cooldownMinutes: rule.cooldownMinutes,
            previousExecutionId: recent.id,
            previousMatchedAt: recent.matchedAt.toISOString(),
          },
          error: null,
          workflowRequestId: null,
        });
      }
    }

    const action = this.actionOf(rule);
    const substitutions = { ...fields, ...evaluation.facts };

    /**
     * The human-in-the-loop branch. A rule that requires confirmation NEVER performs its
     * action — not even the harmless-looking ones — it describes what it saw and stops. This
     * is the branch a sensitive rule is forced into by the check constraint in 0030.
     */
    if (rule.requiresHumanConfirmation) {
      if (!subjectId || !subjectKind) {
        throw new ValidationError('A rule that raises a suggestion needs a subject', [
          {
            path: contract.subjectField,
            message: `The event carries no ${contract.subjectField} to raise a suggestion about`,
          },
        ]);
      }
      const summary = render(summaryTextOf(action, rule), substitutions);
      const execution = await this.recordExecution(principal, institutionId, {
        id: executionId,
        rule,
        event,
        status: 'awaiting_confirmation',
        subjectKind,
        subjectId,
        actionResult: { suggestion: true, withheldAction: action.kind },
        error: null,
        workflowRequestId: null,
        suggestion: { summary, evidence: evidenceOf(evaluation, fields) },
      });
      return execution;
    }

    switch (action.kind) {
      case 'flag_for_review': {
        if (!subjectId || !subjectKind) {
          throw new ValidationError('A rule that raises a suggestion needs a subject', [
            {
              path: contract.subjectField,
              message: `The event carries no ${contract.subjectField} to raise a suggestion about`,
            },
          ]);
        }
        return this.recordExecution(principal, institutionId, {
          id: executionId,
          rule,
          event,
          status: 'acted',
          subjectKind,
          subjectId,
          actionResult: { suggestion: true },
          error: null,
          workflowRequestId: null,
          suggestion: {
            summary: render(action.summary, substitutions),
            evidence: evidenceOf(evaluation, fields),
          },
        });
      }

      case 'notify': {
        const recipients = await this.resolveRecipients(institutionId, action, fields);
        if (recipients.length === 0) {
          throw new ValidationError('The notify rule resolved to nobody', [
            { path: 'action.recipients', message: 'No reachable recipient for this subject' },
          ]);
        }
        if (recipients.length > MAX_NOTIFY_RECIPIENTS) {
          throw new ValidationError('The notify rule resolved to too many people', [
            {
              path: 'action.recipients',
              message:
                `${recipients.length} recipients is above the automation cap of ` +
                `${MAX_NOTIFY_RECIPIENTS}. Mass communication goes through the communication ` +
                `module's approval path, not through a rule.`,
            },
          ]);
        }

        const subject = render(action.subject, substitutions).slice(0, 255);
        const body = render(action.messageEn, substitutions);
        const threadIds: string[] = [];
        for (const userId of recipients) {
          if (userId === principal.userId) continue;
          const created = await this.communication.createThread(principal, institutionId, {
            subject,
            kind: 'direct',
            participantUserIds: [userId],
            body,
          });
          threadIds.push(created.thread.id);
        }

        return this.recordExecution(principal, institutionId, {
          id: executionId,
          rule,
          event,
          status: 'acted',
          subjectKind,
          subjectId,
          actionResult: { threadIds, recipientCount: threadIds.length },
          error: null,
          workflowRequestId: null,
        });
      }

      case 'create_workflow_request': {
        if (!subjectId) {
          throw new ValidationError('A workflow request needs an entity to be about', [
            { path: contract.subjectField, message: 'The event carries no subject id' },
          ]);
        }
        const request = await this.workflow.startWorkflow(principal, institutionId, {
          definitionKey: action.definitionKey,
          entityId: subjectId,
          summary: render(action.summary, substitutions).slice(0, 500),
          payload: { ...fields, automationRuleKey: rule.key, automationExecutionId: executionId },
        });
        return this.recordExecution(principal, institutionId, {
          id: executionId,
          rule,
          event,
          status: 'acted',
          subjectKind,
          subjectId,
          actionResult: { workflowRequestId: request.id, definitionKey: action.definitionKey },
          error: null,
          workflowRequestId: request.id,
        });
      }

      case 'create_record': {
        // One hop. A rule triggered by a derived event may not derive another, so a pair of
        // rules cannot feed each other forever.
        if (event.eventName === DERIVED_EVENT_NAME) {
          throw new ValidationError('A derived event may not derive another', [
            {
              path: 'action.recordKind',
              message: `${DERIVED_EVENT_NAME} is already a derived event; chaining stops here`,
            },
          ]);
        }
        const derived = await this.db.runInTenant(async (tx) => {
          const [row] = await tx
            .insert(automationEvents)
            .values({
              id: uuidv7(),
              tenantId: principal.tenantId!,
              institutionId,
              eventName: DERIVED_EVENT_NAME,
              payload: {
                executionId,
                ruleKey: rule.key,
                ...(typeof fields['studentId'] === 'string'
                  ? { studentId: fields['studentId'] }
                  : {}),
                note: `Derived by automation rule ${rule.key}`,
              },
              occurredAt: new Date(),
              sourceModule: 'automation',
              dedupeKey: `derived:${rule.key}:${event.id}`,
              createdBy: principal.userId,
              updatedBy: principal.userId,
            })
            .returning();
          return row ?? null;
        });
        if (!derived) throw new ConflictError('The derived automation event could not be created');

        return this.recordExecution(principal, institutionId, {
          id: executionId,
          rule,
          event,
          status: 'acted',
          subjectKind,
          subjectId,
          actionResult: { derivedEventId: derived.id, eventName: DERIVED_EVENT_NAME },
          error: null,
          workflowRequestId: null,
        });
      }
    }
  }

  /**
   * Write one execution row, its suggestion when it has one, and its audit record — all in
   * one transaction, so an execution that committed always has both and one that rolled back
   * has neither.
   *
   * The audit row is `automation_execution`, a genuinely different event from the
   * `automation_event`/`update` record the processing *route* carries, so both rows are
   * correct and the route must not be marked `recordedBy: 'service'`.
   */
  private async recordExecution(
    principal: Principal,
    institutionId: string,
    input: {
      id: string;
      rule: RuleRow;
      event: EventRow | null;
      status: ExecutionStatus;
      subjectKind: string | null;
      subjectId: string | null;
      actionResult: Record<string, unknown>;
      error: string | null;
      workflowRequestId: string | null;
      suggestion?: { summary: string; evidence: Record<string, unknown> };
    },
  ): Promise<ExecutionRow> {
    const context = currentContext();
    return this.db.runInTenant(async (tx) => {
      const [execution] = await tx
        .insert(automationExecutions)
        .values({
          id: input.id,
          tenantId: principal.tenantId!,
          institutionId,
          ruleId: input.rule.id,
          eventId: input.event?.id ?? null,
          matchedAt: new Date(),
          status: input.status,
          subjectKind: input.subjectKind,
          subjectId: input.subjectId,
          actionResult: input.actionResult,
          error: input.error,
          workflowRequestId: input.workflowRequestId,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      if (!execution) throw new ConflictError('The automation execution could not be recorded');

      if (input.suggestion && input.subjectKind && input.subjectId) {
        await tx.insert(automationSuggestions).values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          ruleId: input.rule.id,
          executionId: execution.id,
          subjectKind: input.subjectKind,
          subjectId: input.subjectId,
          summary: input.suggestion.summary.slice(0, 500),
          evidence: input.suggestion.evidence,
          status: 'pending',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        });
      }

      if (input.status === 'acted' || input.status === 'awaiting_confirmation') {
        await this.audit.recordInTransaction(tx, {
          tenantId: principal.tenantId,
          institutionId,
          actorUserId: principal.userId,
          actorRoles: principal.roles.map((role) => role.roleKey),
          action: 'create',
          module: 'automation',
          resourceType: 'automation_execution',
          resourceId: execution.id,
          resourceLabel: input.rule.key,
          newValue: {
            ruleKey: input.rule.key,
            ruleVersion: input.rule.version,
            actionKind: input.rule.actionKind,
            status: input.status,
            subjectKind: input.subjectKind,
            subjectId: input.subjectId,
            eventId: input.event?.id ?? null,
            actionResult: input.actionResult,
          },
          requestId: context?.requestId ?? null,
          ipAddress: context?.ipAddress ?? null,
          userAgent: context?.userAgent ?? null,
        });
      }

      return execution;
    });
  }

  /** The one UPDATE `automation_events` permits: stamp `processed_at`, once. */
  private async markProcessed(principal: Principal, event: EventRow): Promise<void> {
    await this.db.runInTenant(async (tx) => {
      await tx
        .update(automationEvents)
        .set({ processedAt: new Date(), updatedBy: principal.userId })
        .where(and(eq(automationEvents.id, event.id), isNull(automationEvents.processedAt)));
    });
  }

  // ───────────────────────────────────────────────────────────────────────────────────
  // The evaluator
  // ───────────────────────────────────────────────────────────────────────────────────

  private async evaluate(
    tx: Tx,
    rule: RuleRow,
    contract: EventContract,
    fields: Record<string, unknown>,
  ): Promise<RuleEvaluation> {
    const conditions = rule.conditions as AutomationConditionInput;
    const clauses = Array.isArray(conditions?.clauses) ? conditions.clauses : [];
    const match: 'all' | 'any' = conditions?.match === 'any' ? 'any' : 'all';

    const subjectId = readUuid(fields[contract.subjectField]);
    const subjectKind = subjectId ? contract.subjectKind : null;

    const factNames = new Set<string>();
    for (const clause of clauses) {
      const parsed = splitField(clause.field);
      if (parsed.scope === 'fact') factNames.add(parsed.name);
    }
    const facts = await this.computeFacts(tx, factNames, contract.subjectKind, subjectId);

    const verdicts: ClauseVerdict[] = clauses.map((clause) => {
      const parsed = splitField(clause.field);
      const actual =
        parsed.scope === 'fact' ? (facts[parsed.name] ?? null) : (fields[parsed.name] ?? null);
      return {
        field: clause.field,
        op: clause.op,
        expected: clause.value ?? null,
        actual,
        passed: compare(actual, clause),
      };
    });

    const matched =
      verdicts.length === 0
        ? true
        : match === 'any'
          ? verdicts.some((v) => v.passed)
          : verdicts.every((v) => v.passed);

    return { matched, match, clauses: verdicts, facts, subjectKind, subjectId };
  }

  /**
   * Compute the requested facts for one subject.
   *
   * Every branch is a parameterised query against a table this module only reads. Nothing a
   * rule author writes reaches SQL: the *name* selects a branch, and the only value bound is
   * the subject id.
   */
  private async computeFacts(
    tx: Tx,
    names: ReadonlySet<string>,
    subjectKind: string,
    subjectId: string | null,
  ): Promise<Record<string, number | null>> {
    const out: Record<string, number | null> = {};
    if (names.size === 0) return out;

    for (const name of names) {
      const contract = FACT_CATALOG[name];
      // Unreachable: `assertRuleUnderstood` refuses an unknown fact when the rule is saved.
      if (!contract || contract.subjectKind !== subjectKind || !subjectId) {
        out[name] = null;
        continue;
      }

      switch (name) {
        case 'student_consecutive_absences': {
          const rows = await tx
            .select({ status: studentAttendance.status })
            .from(studentAttendance)
            .innerJoin(
              attendanceSessions,
              eq(attendanceSessions.id, studentAttendance.sessionId),
            )
            .where(
              and(
                eq(studentAttendance.studentId, subjectId),
                isNull(studentAttendance.archivedAt),
                isNull(attendanceSessions.archivedAt),
              ),
            )
            .orderBy(desc(attendanceSessions.attendanceDate), desc(studentAttendance.id))
            .limit(ABSENCE_LOOKBACK_SESSIONS);

          let streak = 0;
          for (const row of rows) {
            if (row.status !== 'absent') break;
            streak += 1;
          }
          out[name] = streak;
          break;
        }

        case 'invoice_days_overdue': {
          const [invoice] = await tx
            .select({ dueDate: invoices.dueDate, status: invoices.status })
            .from(invoices)
            .where(and(eq(invoices.id, subjectId), isNull(invoices.archivedAt)))
            .limit(1);
          out[name] =
            invoice && invoice.status !== 'paid' && invoice.status !== 'void'
              ? daysBetween(calendarDate(invoice.dueDate), todayInDhaka())
              : null;
          break;
        }

        case 'invoice_balance_poisha': {
          const [invoice] = await tx
            .select({ balance: invoices.balance })
            .from(invoices)
            .where(and(eq(invoices.id, subjectId), isNull(invoices.archivedAt)))
            .limit(1);
          // Parsed through Money, never through parseFloat: the balance is a decimal string
          // in the database and stays exact as an integer count of poisa (ADR-004).
          out[name] = invoice ? Number(Money.fromDecimalString(invoice.balance).minor) : null;
          break;
        }

        case 'employee_document_days_to_expiry': {
          const [document] = await tx
            .select({ expiresAt: employeeDocuments.expiresAt })
            .from(employeeDocuments)
            .where(
              and(eq(employeeDocuments.id, subjectId), isNull(employeeDocuments.archivedAt)),
            )
            .limit(1);
          out[name] = document?.expiresAt
            ? daysBetween(todayInDhaka(), calendarDate(document.expiresAt))
            : null;
          break;
        }

        default:
          out[name] = null;
      }
    }

    return out;
  }

  // ───────────────────────────────────────────────────────────────────────────────────
  // Recipients
  // ───────────────────────────────────────────────────────────────────────────────────

  private async resolveRecipients(
    institutionId: string,
    action: Extract<AutomationActionInput, { kind: 'notify' }>,
    fields: Record<string, unknown>,
  ): Promise<string[]> {
    return this.db.runInTenant(async (tx) => {
      if (action.recipients === 'guardians_of_subject_student') {
        const studentId = readUuid(fields['studentId']);
        if (!studentId) {
          throw new ValidationError('This rule notifies guardians but names no student', [
            { path: 'payload.studentId', message: 'The event carries no studentId' },
          ]);
        }
        const rows = await tx
          .select({ userId: guardians.userId })
          .from(studentGuardians)
          .innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
          .innerJoin(users, eq(users.id, guardians.userId))
          .innerJoin(students, eq(students.id, studentGuardians.studentId))
          .where(
            and(
              eq(studentGuardians.studentId, studentId),
              eq(studentGuardians.canAccessPortal, true),
              eq(students.institutionId, institutionId),
              eq(users.status, 'active'),
              isNull(studentGuardians.archivedAt),
              isNull(guardians.archivedAt),
              isNull(users.archivedAt),
            ),
          );
        return unique(rows.map((row) => row.userId).filter(isNonEmptyString));
      }

      // `permission_holders`: resolved from role grants at run time, never from a stored
      // list, so a staffing change is picked up without touching the rule.
      const permission = action.permission;
      if (!permission) {
        throw new ValidationError('This rule notifies permission holders but names none', [
          { path: 'action.permission', message: 'No permission was configured' },
        ]);
      }
      const rows = await tx
        .select({ userId: userRoles.userId, permissions: roles.permissions })
        .from(userRoles)
        .innerJoin(roles, eq(roles.id, userRoles.roleId))
        .innerJoin(users, eq(users.id, userRoles.userId))
        .where(
          and(
            eq(users.status, 'active'),
            isNull(users.archivedAt),
            isNull(roles.archivedAt),
            // A null `institution_id` on a grant means tenant-wide — an owner or a group
            // chairman. Excluding those would silently miss exactly the people a rule most
            // often means to reach.
            or(
              isNull(userRoles.institutionId),
              eq(userRoles.institutionId, institutionId),
            ) as SQL,
          ),
        );

      const holders = rows
        .filter((row) => {
          const granted = Array.isArray(row.permissions) ? (row.permissions as string[]) : [];
          return granted.some((entry) => grantCovers(entry, permission));
        })
        .map((row) => row.userId);
      return unique(holders);
    });
  }

  // ───────────────────────────────────────────────────────────────────────────────────
  // Validation the schema cannot do — catalogue membership and cross-field coherence
  // ───────────────────────────────────────────────────────────────────────────────────

  /**
   * Refuse a rule the engine could not honestly run.
   *
   * This is where an injection attempt lands. The Zod schema already refused anything that is
   * not `event.<identifier>` or `fact.<identifier>`; here the identifier must additionally
   * *exist* in the catalogue for this rule's event, and every `{{placeholder}}` must name a
   * field the engine can actually substitute. Both failures are a 422 that names the offending
   * token, which is the only useful thing to tell a rule author.
   */
  private assertRuleUnderstood(
    input: CreateAutomationRuleInput | UpdateAutomationRuleInput,
  ): void {
    const issues: FieldIssue[] = [];
    const contract = input.eventName ? EVENT_CATALOG[input.eventName] : undefined;

    if (input.eventName && !contract) {
      issues.push({
        path: 'eventName',
        message:
          `${input.eventName} is not an event this system raises. Known events: ` +
          `${Object.keys(EVENT_CATALOG).join(', ')}`,
      });
    }

    const allowedFacts = new Set(
      Object.entries(FACT_CATALOG)
        .filter(([, fact]) => !contract || fact.subjectKind === contract.subjectKind)
        .map(([name]) => name),
    );

    input.conditions.clauses.forEach((clause, position) => {
      const parsed = splitField(clause.field);
      if (parsed.scope === 'event') {
        if (!contract) {
          issues.push({
            path: `conditions.clauses.${position}.field`,
            message: 'A rule with no event cannot read event fields',
          });
        } else if (!(parsed.name in contract.fields)) {
          issues.push({
            path: `conditions.clauses.${position}.field`,
            message:
              `${input.eventName} carries no field named ${parsed.name}. ` +
              `Available: ${Object.keys(contract.fields).join(', ')}`,
          });
        }
      } else if (!allowedFacts.has(parsed.name)) {
        issues.push({
          path: `conditions.clauses.${position}.field`,
          message:
            `${parsed.name} is not a fact this engine can compute for a ` +
            `${contract?.subjectKind ?? 'subject'}. Available: ` +
            `${[...allowedFacts].join(', ') || 'none for this subject'}`,
        });
      }
    });

    const substitutable = new Set<string>([
      ...(contract ? Object.keys(contract.fields) : []),
      ...allowedFacts,
    ]);
    for (const [field, text] of textFieldsOf(input.action)) {
      for (const placeholder of placeholdersIn(text)) {
        if (!substitutable.has(placeholder)) {
          issues.push({
            path: `action.${field}`,
            message:
              `{{${placeholder}}} is not a field or fact this rule can substitute. ` +
              `Available: ${[...substitutable].join(', ') || 'none'}`,
          });
        }
      }
    }

    if (input.action.kind === 'notify' && input.action.recipients === 'permission_holders') {
      if (!input.action.permission || !isPermission(input.action.permission)) {
        issues.push({
          path: 'action.permission',
          message: `${input.action.permission ?? '(none)'} is not a permission in the catalogue`,
        });
      }
    }

    if (input.action.kind === 'create_record') {
      if (input.action.eventName !== DERIVED_EVENT_NAME) {
        issues.push({
          path: 'action.eventName',
          message:
            `A rule may only raise ${DERIVED_EVENT_NAME}. Creating any other record is a ` +
            `job for the module that owns it, with that module's permissions.`,
        });
      }
      if (input.eventName === DERIVED_EVENT_NAME) {
        issues.push({
          path: 'action.recordKind',
          message: `A rule triggered by ${DERIVED_EVENT_NAME} may not derive another event`,
        });
      }
    }

    // The release-blocking rule, restated in the service between Zod and the check
    // constraint. Three refusals for one property is not redundancy: they fail at three
    // different distances from the caller.
    const target = input.action.targetResource;
    if (
      target &&
      (SENSITIVE_AUTOMATION_TARGETS as readonly string[]).includes(target) &&
      !(
        input.requiresHumanConfirmation &&
        (input.action.kind === 'flag_for_review' ||
          input.action.kind === 'create_workflow_request')
      )
    ) {
      issues.push({
        path: 'action.targetResource',
        message:
          `${target} is a sensitive resource. A rule may notice it, but only a person may ` +
          `change it: set requiresHumanConfirmation and raise a suggestion or a workflow request.`,
      });
    }

    if (issues.length > 0) {
      throw new ValidationError('This automation rule cannot be evaluated as written', issues);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────────────
  // Small helpers
  // ───────────────────────────────────────────────────────────────────────────────────

  private ruleValues(input: CreateAutomationRuleInput | UpdateAutomationRuleInput) {
    return {
      nameEn: input.name,
      nameBn: input.nameBn ?? null,
      description: input.description ?? null,
      triggerKind: input.triggerKind,
      eventName: input.eventName ?? null,
      cronExpression: input.cronExpression ?? null,
      timezone: input.timezone,
      conditions: input.conditions,
      actionKind: input.action.kind,
      actionConfig: stripKind(input.action),
      requiresHumanConfirmation: input.requiresHumanConfirmation,
      cooldownMinutes: input.cooldownMinutes,
    };
  }

  private async loadRule(tx: Tx, institutionId: string, id: string): Promise<RuleRow> {
    const [rule] = await tx
      .select()
      .from(automationRules)
      .where(and(eq(automationRules.id, id), eq(automationRules.institutionId, institutionId)))
      .limit(1);
    // A rule in another tenant is invisible under RLS and one in another institution is a
    // 404 here — never a 403, which would confirm it exists.
    if (!rule || rule.archivedAt) throw new NotFoundError('Automation rule', id);
    return rule;
  }

  private requireContract(eventName: string): EventContract {
    const contract = EVENT_CATALOG[eventName];
    if (!contract) {
      throw new ValidationError('That is not an event this system raises', [
        {
          path: 'eventName',
          message: `Known events: ${Object.keys(EVENT_CATALOG).join(', ')}`,
        },
      ]);
    }
    return contract;
  }

  /**
   * Project a submitted payload onto the event's declared fields.
   *
   * Unknown keys are refused rather than dropped: silently ignoring a field a caller believed
   * they were sending is how a rule quietly stops matching. Types are checked too, so
   * `percentage: "forty"` fails here rather than comparing as a string later.
   */
  private readPayload(
    eventName: string,
    contract: EventContract,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    const issues: FieldIssue[] = [];
    const out: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(payload)) {
      const declared = contract.fields[key];
      if (!declared) {
        issues.push({
          path: `payload.${key}`,
          message:
            `${eventName} declares no field named ${key}. ` +
            `Declared: ${Object.keys(contract.fields).join(', ')}`,
        });
        continue;
      }
      if (value === null || value === undefined) continue;
      if (declared === 'number' && typeof value !== 'number') {
        issues.push({ path: `payload.${key}`, message: `${key} must be a number` });
        continue;
      }
      if (declared === 'boolean' && typeof value !== 'boolean') {
        issues.push({ path: `payload.${key}`, message: `${key} must be true or false` });
        continue;
      }
      if ((declared === 'string' || declared === 'uuid') && typeof value !== 'string') {
        issues.push({ path: `payload.${key}`, message: `${key} must be a string` });
        continue;
      }
      if (declared === 'uuid' && !readUuid(value)) {
        issues.push({ path: `payload.${key}`, message: `${key} must be an identifier` });
        continue;
      }
      if (typeof value === 'string' && value.length > 500) {
        issues.push({ path: `payload.${key}`, message: `${key} is longer than 500 characters` });
        continue;
      }
      out[key] = value;
    }

    if (issues.length > 0) {
      throw new ValidationError('This event payload does not match its declared shape', issues);
    }
    return out;
  }

  private actionOf(rule: RuleRow): AutomationActionInput {
    const config = (rule.actionConfig ?? {}) as Record<string, unknown>;
    return { ...config, kind: rule.actionKind } as AutomationActionInput;
  }

  private describeAction(rule: RuleRow): string {
    const action = this.actionOf(rule);
    if (rule.requiresHumanConfirmation) {
      return `raise a suggestion for a human (the configured ${action.kind} action is withheld)`;
    }
    switch (action.kind) {
      case 'notify':
        return `send a direct message to ${action.recipients.replace(/_/g, ' ')}`;
      case 'create_workflow_request':
        return `start the ${action.definitionKey} approval workflow`;
      case 'create_record':
        return `raise a derived ${DERIVED_EVENT_NAME} event`;
      case 'flag_for_review':
        return 'raise a suggestion for a human';
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Pure helpers. Kept out of the class because none of them touch the database, and a pure
// function is testable and reviewable in a way a private method is not.
// ─────────────────────────────────────────────────────────────────────────────────────

function stripKind(action: AutomationActionInput): Record<string, unknown> {
  const { kind: _kind, ...rest } = action;
  return Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
}

function splitField(field: string): { scope: 'event' | 'fact'; name: string } {
  const separator = field.indexOf('.');
  const scope = field.slice(0, separator);
  return { scope: scope === 'fact' ? 'fact' : 'event', name: field.slice(separator + 1) };
}

/** The comparison table. Deliberately total: an unusable pair is `false`, never a throw. */
function compare(actual: unknown, clause: AutomationConditionClause): boolean {
  const expected = clause.value;

  if (clause.op === 'exists') return actual !== null && actual !== undefined;
  if (actual === null || actual === undefined) return false;

  if (clause.op === 'in' || clause.op === 'not_in') {
    const list = Array.isArray(expected) ? expected : [];
    const hit = list.some((entry) => looseEquals(actual, entry));
    return clause.op === 'in' ? hit : !hit;
  }

  if (clause.op === 'eq') return looseEquals(actual, expected);
  if (clause.op === 'ne') return !looseEquals(actual, expected);

  const left = asNumber(actual);
  const right = asNumber(expected);
  if (left === null || right === null) return false;
  switch (clause.op) {
    case 'gt':
      return left > right;
    case 'gte':
      return left >= right;
    case 'lt':
      return left < right;
    case 'lte':
      return left <= right;
    default:
      return false;
  }
}

function looseEquals(actual: unknown, expected: unknown): boolean {
  if (typeof actual === 'number' || typeof expected === 'number') {
    const left = asNumber(actual);
    const right = asNumber(expected);
    if (left !== null && right !== null) return left === right;
  }
  if (typeof actual === 'boolean' || typeof expected === 'boolean') {
    return String(actual) === String(expected);
  }
  return String(actual) === String(expected);
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Substitute `{{name}}` from an already-allow-listed map.
 *
 * A placeholder with no value renders as `—` rather than the literal braces: a guardian
 * should never receive a message containing `{{studentName}}`.
 */
function render(template: string, values: Record<string, unknown>): string {
  return template.replace(PLACEHOLDER_PATTERN, (_match, name: string) => {
    const value = values[name];
    if (value === null || value === undefined || value === '') return '—';
    return String(value);
  });
}

function placeholdersIn(template: string): string[] {
  const found: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1];
    if (name) found.push(name);
  }
  return found;
}

/** Every free-text field of an action, so placeholders can be validated in one sweep. */
function textFieldsOf(action: AutomationActionInput): [string, string][] {
  switch (action.kind) {
    case 'notify':
      return [
        ['subject', action.subject],
        ['messageEn', action.messageEn],
        ...(action.messageBn ? ([['messageBn', action.messageBn]] as [string, string][]) : []),
      ];
    case 'create_workflow_request':
      return [['summary', action.summary]];
    case 'flag_for_review':
      return [['summary', action.summary]];
    case 'create_record':
      return [];
  }
}

function summaryTextOf(action: AutomationActionInput, rule: RuleRow): string {
  if (action.kind === 'flag_for_review' || action.kind === 'create_workflow_request') {
    return action.summary;
  }
  return `${rule.nameEn} matched. The configured ${action.kind} action was withheld pending review.`;
}

function evidenceOf(
  evaluation: RuleEvaluation,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return {
    match: evaluation.match,
    clauses: evaluation.clauses,
    facts: evaluation.facts,
    event: fields,
  };
}

function readUuid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)
    ? value
    : null;
}

function isNonEmptyString(value: string | null): value is string {
  return typeof value === 'string' && value.length > 0;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** The wall-clock parts of an instant in a named zone, via `Intl` rather than by hand. */
function localPartsInZone(
  at: Date,
  timeZone: string,
): { minute: number; hour: number; dayOfMonth: number; month: number; weekday: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    }).formatToParts(at);
  } catch {
    // An unrecognised zone must not take the endpoint down; UTC is the honest fallback and
    // the response still reports which zone the rule asked for.
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    }).formatToParts(at);
  }

  const find = (type: string): string => parts.find((part) => part.type === type)?.value ?? '0';
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const hour = Number(find('hour')) % 24;
  return {
    minute: Number(find('minute')),
    hour,
    dayOfMonth: Number(find('day')),
    month: Number(find('month')),
    weekday: Math.max(0, weekdays.indexOf(find('weekday'))),
  };
}

/**
 * Does a five-field cron expression match this wall-clock instant?
 *
 * Supports the wildcard, step values (a field followed by a slash and a number), lists,
 * ranges and plain numbers — the subset a school timetable actually needs. Anything it
 * cannot parse matches nothing, which fails closed: a rule with a malformed expression is
 * never reported due.
 */
function cronMatches(
  expression: string,
  local: { minute: number; hour: number; dayOfMonth: number; month: number; weekday: number },
): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, dayOfMonth, month, weekday] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  return (
    cronFieldMatches(minute, local.minute, 0, 59) &&
    cronFieldMatches(hour, local.hour, 0, 23) &&
    cronFieldMatches(dayOfMonth, local.dayOfMonth, 1, 31) &&
    cronFieldMatches(month, local.month, 1, 12) &&
    cronFieldMatches(weekday, local.weekday % 7, 0, 6)
  );
}

function cronFieldMatches(field: string, value: number, min: number, max: number): boolean {
  for (const part of field.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return false;

    let low = min;
    let high = max;
    if (range !== undefined && range !== '*' && range !== '?') {
      const bounds = range.split('-');
      const start = Number(bounds[0]);
      const end = bounds.length > 1 ? Number(bounds[1]) : start;
      if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
      low = start;
      high = end;
    }
    if (value < low || value > high) continue;
    if ((value - low) % step === 0) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────────────
// The default rule set (docs/08 §5). The same four rows migration 0030 seeds, kept here so
// `install-defaults` can give them to an institution created after that migration ran.
// All four ship INACTIVE.
// ─────────────────────────────────────────────────────────────────────────────────────

interface DefaultRule {
  key: string;
  nameEn: string;
  nameBn: string;
  description: string;
  triggerKind: RuleRow['triggerKind'];
  eventName: string;
  conditions: AutomationConditionInput;
  action: AutomationActionInput;
  requiresHumanConfirmation: boolean;
  cooldownMinutes: number;
}

const DEFAULT_RULES: readonly DefaultRule[] = [
  {
    key: 'absence_three_consecutive',
    nameEn: 'Three consecutive absences notify the guardian',
    nameBn: 'পরপর তিন দিন অনুপস্থিতিতে অভিভাবককে জানানো হয়',
    description:
      'When a student has been absent three days running, message the guardians once a day at most.',
    triggerKind: 'threshold',
    eventName: 'attendance.student_absent',
    conditions: {
      match: 'all',
      clauses: [{ field: 'fact.student_consecutive_absences', op: 'gte', value: 3 }],
    },
    action: {
      kind: 'notify',
      recipients: 'guardians_of_subject_student',
      subject: 'Attendance alert',
      messageEn:
        'Our records show {{studentName}} has been absent on {{date}} and for ' +
        '{{consecutiveAbsences}} consecutive days. Please contact the class teacher.',
      messageBn:
        'আমাদের রেকর্ড অনুযায়ী {{studentName}} {{consecutiveAbsences}} দিন ধরে অনুপস্থিত। ' +
        'অনুগ্রহ করে শ্রেণিশিক্ষকের সঙ্গে যোগাযোগ করুন।',
    },
    requiresHumanConfirmation: false,
    cooldownMinutes: 1440,
  },
  {
    key: 'fee_overdue_fifteen_days',
    nameEn: 'Fee fifteen days overdue sends a reminder',
    nameBn: 'পনেরো দিন বকেয়া ফি-এর জন্য স্মারক পাঠানো হয়',
    description:
      'A polite reminder to the guardians of a student whose invoice is fifteen days past due, at most weekly.',
    triggerKind: 'threshold',
    eventName: 'fees.invoice_overdue',
    conditions: {
      match: 'all',
      clauses: [
        { field: 'fact.invoice_days_overdue', op: 'gte', value: 15 },
        { field: 'fact.invoice_balance_poisha', op: 'gt', value: 0 },
      ],
    },
    action: {
      kind: 'notify',
      recipients: 'guardians_of_subject_student',
      subject: 'Fee reminder',
      messageEn:
        'Invoice {{invoiceNumber}} for {{studentName}} is {{daysOverdue}} days past its due ' +
        'date. Please visit the accounts office at your convenience.',
      messageBn:
        '{{studentName}}-এর চালান {{invoiceNumber}} নির্ধারিত তারিখের {{daysOverdue}} দিন পার ' +
        'হয়েছে। অনুগ্রহ করে হিসাব শাখায় যোগাযোগ করুন।',
    },
    requiresHumanConfirmation: false,
    cooldownMinutes: 10_080,
  },
  {
    key: 'document_expiring_thirty_days',
    nameEn: 'Document expiring within thirty days flags HR',
    nameBn: 'ত্রিশ দিনের মধ্যে মেয়াদোত্তীর্ণ নথি এইচআরকে জানানো হয়',
    description:
      'Raises a suggestion for HR when an employee document lapses within a month. HR renews it; the rule does not.',
    triggerKind: 'threshold',
    eventName: 'hr.document_expiring',
    conditions: {
      match: 'all',
      clauses: [{ field: 'fact.employee_document_days_to_expiry', op: 'lte', value: 30 }],
    },
    action: {
      kind: 'flag_for_review',
      summary:
        '{{employeeName}} — {{documentType}} expires on {{expiresAt}} ({{daysToExpiry}} days). ' +
        'Renew or archive it.',
    },
    requiresHumanConfirmation: false,
    cooldownMinutes: 43_200,
  },
  {
    key: 'low_exam_mark_early_warning',
    nameEn: 'Low exam mark raises an early-warning suggestion',
    nameBn: 'কম নম্বরে আগাম সতর্কতার পরামর্শ তৈরি হয়',
    description:
      'Marks are a sensitive resource: this rule may only describe what it noticed. A teacher decides what to do.',
    triggerKind: 'event',
    eventName: 'exams.mark_recorded',
    conditions: {
      match: 'all',
      clauses: [{ field: 'event.percentage', op: 'lt', value: 40 }],
    },
    action: {
      kind: 'flag_for_review',
      targetResource: 'exam_mark',
      summary:
        '{{studentName}} scored {{percentage}}% in {{subjectName}}. Consider an early-warning ' +
        'conversation.',
    },
    requiresHumanConfirmation: true,
    cooldownMinutes: 0,
  },
];

/** Re-exported so the controller can advertise what a rule may reference. */
export { EVENT_CATALOG, FACT_CATALOG };

