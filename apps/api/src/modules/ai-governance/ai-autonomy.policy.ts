/**
 * The autonomy policy: docs/06 §6 as data the code can evaluate.
 *
 * docs/06 §6 is one sentence — "change grades or attendance · approve admissions · determine
 * punishment · issue refunds · change salary · run payroll · create accounting entries ·
 * delete records · send sensitive mass communications" — followed by the rule that matters:
 *
 *     AI suggests → human reviews → human confirms → system executes,
 *     and the confirmation is a normal permission-checked, audited API call made by the human.
 *
 * A sentence in a document cannot fail a build. This file turns it into ten entries that name
 * what is forbidden, which routes each one covers, and which permission a human needs in order
 * to do it themselves. `AiAutonomyGuard` evaluates it per request;
 * `AiGovernanceService.attestation()` evaluates it against the whole router so a school's data
 * protection officer can check the list against reality instead of trusting it.
 *
 * ── The two independent signals, and why there are two ─────────────────────────────────
 *
 * **`match` is the policy.** It decides whether a route is forbidden to AI, from metadata the
 * route already declares: its `@Audited({module, resourceType, action})`, its
 * `@RequirePermissions(...)`, and its HTTP method. Nothing here is a hand-maintained list of
 * paths, because a hand-maintained list is wrong the day after it is written.
 *
 * **`smells` is not the policy.** It is a deliberately *separate and broader* detector for
 * "this route looks like it touches one of these resources", matched against the route's path,
 * its handler name, its resource type and its permission strings. Its only job is to find
 * routes the policy has **not** matched — a mutating route that smells like a refund and is
 * not covered is reported by the attestation as a gap rather than quietly counted as
 * compliance. Deriving the gap check from `match` itself would be circular and would report
 * 100% coverage forever.
 *
 * This is what catches the refund endpoint a later phase adds: if it declares
 * `finance.refund`, `match` covers it and the attestation stays green; if it declares
 * something else, `smells` fires, `match` does not, and the attestation says so.
 *
 * ── Deliberately over-broad in one direction ───────────────────────────────────────────
 *
 * Several entries cover more than the strict reading of the clause. Attendance covers taking
 * a register as well as correcting one; "delete records" covers every `archive` action,
 * because ADR-008 makes archiving *the* delete in this system and a headteacher told "the AI
 * archived a pupil" will not be comforted that the row survives; mass communication covers
 * one-to-one messages, because a message to one parent about one child is the same class of
 * harm as a broadcast and the clause's word "mass" describes the usual case rather than the
 * boundary. Every one of these errs towards refusing, which is the correct direction for a
 * control whose failure mode is an unreviewed action taken about a child.
 */

import type { Permission } from '@shikkha/permissions';
import type { AuditMetadata } from '../../common/decorators';

/**
 * One route, reduced to what the policy needs.
 *
 * Produced by `RouteInventoryService` from the Nest router at boot, and by `AiAutonomyGuard`
 * from the execution context at request time — the same shape either way, so the guard and
 * the attestation cannot disagree about what a route is.
 */
export interface RouteDescriptor {
  /** Controller class name. Part of the smell surface: `PayrollController` is a strong hint. */
  controller: string;
  /** Handler method name, e.g. `approveMarks`. */
  handler: string;
  /** Upper-case HTTP verb. */
  method: string;
  /** Route path without the global prefix, e.g. `/exams/:id/publish`. */
  path: string;
  permissions: readonly string[];
  audit: Pick<AuditMetadata, 'module' | 'resourceType' | 'action'> | null;
}

export type ForbiddenActionKey =
  | 'grades.change'
  | 'attendance.change'
  | 'admissions.approve'
  | 'discipline.punish'
  | 'finance.refund'
  | 'salary.change'
  | 'payroll.run'
  | 'accounting.entries'
  | 'records.delete'
  | 'communication.mass_sensitive';

interface RouteMatcher {
  /** `@Audited` module names. With `resourceTypes`, both must match. */
  modules?: readonly string[];
  resourceTypes?: readonly string[];
  /**
   * Controller class names, for routes that declare neither an audit module nor a useful
   * permission.
   *
   * There is exactly one such route today — the `@Public()` admission form — and it is the
   * reason this matcher exists: an unaudited public POST into the admissions pipeline is
   * invisible to every other signal here, and leaving it uncovered because it is badly
   * decorated would be the wrong way round.
   */
  controllers?: readonly string[];
  /** `@Audited` action verbs, matched on their own — used by `records.delete` for `archive`. */
  auditActions?: readonly AuditMetadata['action'][];
  /** Any intersection with the route's `@RequirePermissions(...)` matches. */
  permissions?: readonly Permission[];
  /** Any intersection with the route's HTTP verb matches. */
  httpMethods?: readonly string[];
}

export interface ForbiddenAutonomousAction {
  key: ForbiddenActionKey;
  /** The words docs/06 §6 uses, verbatim, so the two can be diffed by eye. */
  clause: string;
  /** Written for a headteacher reading docs/16, not for an engineer reading this file. */
  plainLanguage: string;
  /**
   * What a human needs in order to do this themselves.
   *
   * Not checked by the guard — `PermissionsGuard` already does that, and doing it twice in
   * two places is how the two drift apart. It is published so that the answer to "who may
   * confirm this, then?" is in the same row as "the AI may not do this".
   */
  humanConfirmation: readonly Permission[];
  match: RouteMatcher;
  smells: readonly RegExp[];
}

/**
 * The forbidden set.
 *
 * Ten entries for nine clauses: docs/06 §6's "change grades or attendance" is two different
 * modules with two different sets of people who may correct them, and merging them would make
 * the attestation's per-clause route list useless.
 */
export const FORBIDDEN_AUTONOMOUS_ACTIONS: readonly ForbiddenAutonomousAction[] = [
  {
    key: 'grades.change',
    clause: 'change grades',
    plainLanguage:
      'Enter, change, approve, publish or withdraw a mark or a result, or change the scale ' +
      'that turns a mark into a grade.',
    humanConfirmation: [
      'results.enter_marks',
      'results.submit_marks',
      'results.review',
      'results.approve',
      'results.publish',
      'results.unpublish',
      'results.correct',
    ],
    match: {
      // `homework` is here because of what the attestation found: `POST
      // /homework/submissions/:id/grade` and its bulk sibling write a mark against a child's
      // work under `homework.grade`, in a different module, with a different permission and
      // no `results.*` string anywhere near them. They are grade changes. Nothing but walking
      // the router would have shown that, which is the whole argument for the attestation.
      modules: ['exams', 'homework'],
      resourceTypes: ['exam_mark', 'exam_result', 'submission_grade'],
      permissions: [
        'homework.grade',
        'results.enter_marks',
        'results.submit_marks',
        'results.review',
        'results.approve',
        'results.publish',
        'results.unpublish',
        'results.correct',
        // A grading scale remaps every mark in the school onto a different letter. Changing
        // one changes grades without touching a single mark, which is precisely the kind of
        // indirection an autonomy rule has to name explicitly or it will be walked around.
        'exams.grading_scheme.manage',
      ],
    },
    smells: [/(^|[/_.-])(marks?|results?|grades?|grading|gpa|tabulation)([/_.-]|$)/i],
  },
  {
    key: 'attendance.change',
    clause: 'change attendance',
    plainLanguage:
      'Take a register, mark a pupil or a member of staff present or absent, or raise, approve ' +
      'or reject a correction to one.',
    humanConfirmation: [
      'attendance.mark',
      'attendance.correct',
      'attendance.correct.approve',
      'attendance.employee.mark',
    ],
    match: {
      // Every resource type in the module. A session, a mark, a correction and an employee
      // check-in are all "attendance", and enumerating them would mean the next one added is
      // silently outside the policy.
      modules: ['attendance'],
      permissions: [
        'attendance.mark',
        'attendance.correct',
        'attendance.correct.approve',
        'attendance.employee.mark',
      ],
    },
    smells: [/(^|[/_.-])(attendance|register|check-?in|check-?out)([/_.-]|$)/i],
  },
  {
    key: 'admissions.approve',
    clause: 'approve admissions',
    plainLanguage:
      'Decide an application, publish a merit list, or issue, accept, decline or expire an ' +
      'offer of a place.',
    humanConfirmation: [
      'admissions.applications.decide',
      'admissions.merit.publish',
      'admissions.enroll',
    ],
    match: {
      modules: ['admissions'],
      // The public admission form is `@Public()` with no `@Audited(...)`, so neither the
      // module signal nor the permission signal can see it. Naming the controller covers it.
      controllers: ['AdmissionsController'],
      permissions: [
        'admissions.applications.review',
        'admissions.applications.decide',
        'admissions.merit.publish',
        'admissions.enroll',
        'admissions.tests.manage',
        'admissions.interviews.manage',
      ],
    },
    smells: [/(^|[/_.-])(admissions?|offers?|merit|enroll(ment)?)([/_.-]|$)/i],
  },
  {
    key: 'discipline.punish',
    clause: 'determine punishment',
    plainLanguage:
      'Record a behaviour incident against a pupil, or create, approve or revoke a ' +
      'disciplinary action.',
    humanConfirmation: ['discipline.records.create', 'discipline.records.action'],
    match: {
      modules: ['discipline'],
      permissions: ['discipline.records.create', 'discipline.records.action'],
    },
    smells: [/(^|[/_.-])(disciplin\w*|behaviour|behavior|sanction|punish\w*)([/_.-]|$)/i],
  },
  {
    key: 'finance.refund',
    clause: 'issue refunds',
    plainLanguage:
      'Move money back to a family or forgive a charge: a refund, a payment reversal, a voided ' +
      'invoice, an approved concession, or a waived library fine.',
    humanConfirmation: ['finance.refund', 'finance.refund.approve'],
    match: {
      modules: ['fees', 'payment_gateway'],
      resourceTypes: ['payment', 'payment_intent', 'invoice', 'fee_concession'],
      permissions: [
        'finance.refund',
        'finance.refund.approve',
        'finance.collect_payment',
        'finance.invoices.void',
        'finance.discounts.approve',
        // Forgiving a library fine is forgiving a charge. It sits in a different module and
        // under a different permission, which is exactly why the clause has to be expressed
        // as a set of permissions rather than as "the fees module".
        'library.fines.waive',
      ],
    },
    smells: [/(^|[/_.-])(refunds?|reversals?|reverse|void|waive|chargebacks?)([/_.-]|$)/i],
  },
  {
    key: 'salary.change',
    clause: 'change salary',
    plainLanguage:
      "Create or change a salary structure, assign one to a member of staff, or change an " +
      'employment contract.',
    humanConfirmation: ['payroll.structures.manage', 'hr.contracts.manage'],
    match: {
      modules: ['hr'],
      resourceTypes: ['salary_structure', 'employee_salary_assignment', 'employment_contract'],
      permissions: ['payroll.structures.manage', 'hr.contracts.manage'],
    },
    smells: [/(^|[/_.-])(salar\w*|pay-?scales?|remuneration|contracts?)([/_.-]|$)/i],
  },
  {
    key: 'payroll.run',
    clause: 'run payroll',
    plainLanguage:
      'Create, calculate, submit, approve, cancel or disburse a payroll run, or adjust what ' +
      'somebody is paid in one.',
    humanConfirmation: ['payroll.runs.create', 'payroll.runs.approve', 'payroll.disburse'],
    match: {
      modules: ['payroll'],
      permissions: [
        'payroll.runs.create',
        'payroll.runs.approve',
        'payroll.disburse',
        'payroll.structures.manage',
      ],
    },
    // `loan` is deliberately NOT a smell here. The library lends books, and
    // `/library/loans/:id/return` is not a payroll event. A detector whose false positives
    // outnumber its findings is one people learn to skip past, and a skipped attestation
    // catches nothing. Staff loans and advances live in the `payroll` module and are already
    // covered by `match` above.
    smells: [/(^|[/_.-])(payroll|payslips?|disburse\w*)([/_.-]|$)/i],
  },
  {
    key: 'accounting.entries',
    clause: 'create accounting entries',
    plainLanguage:
      'Create, post or reverse a journal entry, close an accounting period, reconcile a ' +
      'statement, or change the chart of accounts or a budget.',
    humanConfirmation: [
      'accounting.journal.create',
      'accounting.journal.post',
      'accounting.journal.reverse',
      'accounting.period.close',
    ],
    match: {
      modules: ['accounting'],
      permissions: [
        'accounting.coa.manage',
        'accounting.journal.create',
        'accounting.journal.post',
        'accounting.journal.reverse',
        'accounting.budgets.manage',
        'accounting.reconcile',
        'accounting.period.close',
      ],
    },
    smells: [
      /(^|[/_.-])(journals?|ledgers?|postings?|accounting|fiscal|chart-of-accounts|reconcil\w*)([/_.-]|$)/i,
    ],
  },
  {
    key: 'records.delete',
    clause: 'delete records',
    plainLanguage:
      'Remove anything: a hard delete, or — since this system archives rather than deletes ' +
      '(ADR-008) — archiving, withdrawing, deactivating or revoking a record.',
    humanConfirmation: [
      'students.archive',
      'students.withdraw',
      'hr.employees.archive',
      'users.deactivate',
      'documents.revoke',
    ],
    match: {
      httpMethods: ['DELETE'],
      // The system's real delete. Every `archive` route in the application is covered by this
      // one line, including ones written after this file.
      auditActions: ['archive'],
      // A bulk status change can set a whole section of pupils to `withdrawn` in one call
      // under nothing stronger than `students.update`. It is a mass removal wearing an update
      // verb, and only the resource type gives it away.
      modules: ['students'],
      resourceTypes: ['bulk_status_change'],
      permissions: [
        'students.archive',
        'students.withdraw',
        'students.transfer',
        'guardians.archive',
        'hr.employees.archive',
        'users.deactivate',
        'roles.delete',
        'homework.delete',
        'documents.revoke',
        'institution.archive',
        'campus.archive',
        'finance.invoices.void',
      ],
    },
    smells: [/(^|[/_.-])(delete|remove|purge|archive|withdraw|deactivate|revoke)([/_.-]|$)/i],
  },
  {
    key: 'communication.mass_sensitive',
    clause: 'send sensitive mass communications',
    plainLanguage:
      'Send anything to families or staff: a bulk campaign, a published notice, or a message ' +
      'in a thread.',
    humanConfirmation: [
      'communication.send.bulk',
      'communication.notices.publish',
      'communication.send',
    ],
    match: {
      modules: ['communication'],
      permissions: [
        'communication.send',
        'communication.send.bulk',
        'communication.notices.publish',
        'communication.templates.manage',
      ],
    },
    // Neither `bulk` nor `send` is a smell. `bulk` matched a bulk certificate issuance and a
    // bulk pupil-status preview; `send` matched `POST /workflows/requests/:id/send-back`,
    // which returns an approval to its author and communicates with nobody. Both are the same
    // mistake: a word that describes shape rather than subject.
    smells: [/(^|[/_.-])(campaigns?|broadcasts?|announcements?|notices?|messages?|sms)([/_.-]|$)/i],
  },
];

/** HTTP verbs that change state. Anything else is a read, and a read is never refused here. */
export const MUTATING_HTTP_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

export function isMutating(route: Pick<RouteDescriptor, 'method'>): boolean {
  return MUTATING_HTTP_METHODS.includes(route.method.toUpperCase());
}

/** Every entry whose `match` covers this route. Empty means the route is open to AI. */
export function matchingActions(route: RouteDescriptor): ForbiddenAutonomousAction[] {
  return FORBIDDEN_AUTONOMOUS_ACTIONS.filter((action) => matches(action.match, route));
}

/**
 * Every entry whose `smells` fire on this route.
 *
 * Independent of `matchingActions` by construction — see the file header. Used only to find
 * gaps, never to refuse a request: refusing on a regular expression over a handler name would
 * be an unreviewable authorization rule.
 */
export function smellingActions(route: RouteDescriptor): ForbiddenAutonomousAction[] {
  const surface = [
    route.path,
    route.handler,
    route.controller,
    route.audit?.resourceType ?? '',
    route.audit?.module ?? '',
    ...route.permissions,
  ].join(' ');
  return FORBIDDEN_AUTONOMOUS_ACTIONS.filter((action) =>
    action.smells.some((pattern) => pattern.test(surface)),
  );
}

function matches(matcher: RouteMatcher, route: RouteDescriptor): boolean {
  if (matcher.httpMethods?.includes(route.method.toUpperCase())) return true;
  if (matcher.controllers?.includes(route.controller)) return true;

  if (matcher.permissions && route.permissions.length > 0) {
    if (matcher.permissions.some((permission) => route.permissions.includes(permission))) {
      return true;
    }
  }

  const audit = route.audit;
  if (audit) {
    if (matcher.auditActions?.includes(audit.action)) return true;
    if (matcher.modules?.includes(audit.module)) {
      // A module with no resource-type narrowing means the whole module. With one, both have
      // to agree — `hr` is mostly not about salary, and blocking the whole of HR because
      // salary structures live in it would make the policy meaningless by being everywhere.
      if (!matcher.resourceTypes || matcher.resourceTypes.includes(audit.resourceType)) {
        return true;
      }
    }
  }

  return false;
}
