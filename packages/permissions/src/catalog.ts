/**
 * The permission catalogue.
 *
 * This is the *only* authorization vocabulary in the system. Guards check permission
 * strings; nothing checks a role name (ADR-005). Roles are rows in the database that carry a
 * set of these strings, so a school can invent "Senior Coordinator" without a code change.
 *
 * Naming: `resource.action`. Where a resource has a genuinely different meaning depending on
 * whose records are being touched, the distinction is encoded in the permission itself rather
 * than left to each service to remember:
 *
 *   students.view.all       — every student in scope
 *   students.view.assigned  — only students in sections this employee teaches
 *   students.view.own       — only the guardian's own linked children
 *
 * A guard can only answer "does this principal hold this permission". It cannot answer
 * "is *this row* one of their assigned students" — that needs a database join, so it lives in
 * the repository layer. `resolveDataScope` below is what tells the repository which of the
 * three filters to apply.
 */

export const PERMISSION_CATALOG = {
  // ── Platform ──────────────────────────────────────────────────────────────────────
  platform: ['platform.tenants.manage', 'platform.plans.manage', 'platform.impersonate'],

  // ── Tenant administration ─────────────────────────────────────────────────────────
  organization: ['organization.view', 'organization.update', 'organization.billing.view'],
  institution: [
    'institution.view',
    'institution.create',
    'institution.update',
    'institution.archive',
  ],
  campus: ['campus.view', 'campus.create', 'campus.update', 'campus.archive'],
  settings: ['settings.view', 'settings.update', 'settings.feature_flags.manage'],

  // ── Identity and access ───────────────────────────────────────────────────────────
  user: [
    'users.view',
    'users.create',
    'users.update',
    'users.deactivate',
    'users.invite',
    'users.reset_password',
    'users.assign_roles',
  ],
  role: ['roles.view', 'roles.create', 'roles.update', 'roles.delete'],
  audit: ['audit.view', 'audit.export'],

  // ── Academic structure ────────────────────────────────────────────────────────────
  academic: [
    'academic.years.view',
    'academic.years.manage',
    'academic.terms.manage',
    'academic.classes.view',
    'academic.classes.manage',
    'academic.sections.view',
    'academic.sections.manage',
    'academic.subjects.view',
    'academic.subjects.manage',
    'academic.calendar.view',
    'academic.calendar.manage',
    'academic.shifts.manage',
    'academic.rooms.manage',
    'academic.assignments.manage',
  ],

  // ── Students ──────────────────────────────────────────────────────────────────────
  student: [
    'students.view.all',
    'students.view.assigned',
    'students.view.own',
    'students.create',
    'students.update',
    'students.archive',
    'students.import',
    'students.export',
    'students.promote',
    'students.transfer',
    'students.withdraw',
    'students.readmit',
    'students.medical.view',
    'students.documents.view',
    'students.documents.manage',
  ],

  // ── Guardians ─────────────────────────────────────────────────────────────────────
  guardian: [
    'guardians.view.all',
    'guardians.view.own',
    'guardians.create',
    'guardians.update',
    'guardians.archive',
    'guardians.link_student',
    'guardians.grant_access',
  ],

  // ── Admissions ────────────────────────────────────────────────────────────────────
  admission: [
    'admissions.inquiries.view',
    'admissions.inquiries.manage',
    'admissions.applications.view',
    'admissions.applications.review',
    'admissions.applications.decide',
    'admissions.cycles.manage',
    'admissions.tests.manage',
    'admissions.interviews.manage',
    'admissions.merit.publish',
    'admissions.enroll',
  ],

  // ── Timetable ─────────────────────────────────────────────────────────────────────
  timetable: [
    'timetable.view',
    'timetable.manage',
    'timetable.publish',
    'timetable.generate',
    'timetable.substitute',
  ],

  // ── Attendance ────────────────────────────────────────────────────────────────────
  attendance: [
    'attendance.view.all',
    'attendance.view.assigned',
    'attendance.view.own',
    'attendance.mark',
    'attendance.correct',
    'attendance.correct.approve',
    'attendance.reports.view',
    'attendance.employee.view',
    'attendance.employee.mark',
  ],

  // ── Examinations and results ──────────────────────────────────────────────────────
  exam: [
    'exams.view',
    'exams.manage',
    'exams.schedule.manage',
    'exams.grading_scheme.manage',
    'results.enter_marks',
    'results.submit_marks',
    'results.review',
    'results.approve',
    'results.publish',
    'results.unpublish',
    'results.correct',
    'results.view.all',
    'results.view.assigned',
    'results.view.own',
    'results.reports.view',
  ],

  // ── Homework and LMS ──────────────────────────────────────────────────────────────
  homework: [
    'homework.view',
    'homework.create',
    'homework.update',
    'homework.delete',
    'homework.grade',
    'homework.submit',
  ],
  lms: [
    // `lms.view` is the flat "may see learning content at all" gate every audience holds.
    // Which courses they then see is a row-scope question, and the triple below answers it:
    // the module previously borrowed `students.view.{all,assigned,own}`, which meant a role
    // could be given access to student records and silently inherit course visibility with it.
    'lms.view',
    'lms.view.all',
    'lms.view.assigned',
    'lms.view.own',
    'lms.manage',
    'lms.publish',
    'lms.progress.view',
    // Starting an attempt, submitting one, and marking a lesson complete are the learner's
    // own actions. They rode on `lms.view` because no string existed for them, which made a
    // read permission carry a write. The service still pins every one of these to the
    // caller's own student identity, but the permission now says what it is.
    'lms.submit',
  ],

  // ── Fees and payments ─────────────────────────────────────────────────────────────
  fee: [
    'finance.fees.view',
    'finance.fees.manage',
    'finance.plans.manage',
    'finance.invoices.view',
    'finance.invoices.generate',
    'finance.invoices.void',
    'finance.discounts.manage',
    'finance.discounts.approve',
    'finance.collect_payment',
    'finance.refund',
    'finance.refund.approve',
    'finance.ledger.view',
    'finance.reports.view',
    'finance.own.view',
  ],

  // ── Accounting ────────────────────────────────────────────────────────────────────
  accounting: [
    'accounting.coa.view',
    'accounting.coa.manage',
    'accounting.journal.view',
    'accounting.journal.create',
    'accounting.journal.post',
    'accounting.journal.reverse',
    'accounting.reports.view',
    'accounting.budgets.manage',
    'accounting.reconcile',
    'accounting.period.close',
  ],

  // ── Communication ─────────────────────────────────────────────────────────────────
  communication: [
    'communication.templates.manage',
    'communication.send',
    'communication.send.bulk',
    'communication.notices.publish',
    'communication.delivery.view',
  ],

  // ── HR and payroll ────────────────────────────────────────────────────────────────
  hr: [
    'hr.employees.view',
    'hr.employees.create',
    'hr.employees.update',
    'hr.employees.archive',
    'hr.documents.view',
    'hr.contracts.manage',
    'hr.performance.manage',
    'hr.exit.manage',
  ],
  payroll: [
    'payroll.structures.manage',
    'payroll.runs.view',
    'payroll.runs.create',
    'payroll.runs.approve',
    'payroll.payslips.view.all',
    'payroll.payslips.view.own',
    'payroll.disburse',
  ],
  leave: [
    'leave.requests.view.all',
    'leave.requests.view.own',
    'leave.requests.create',
    'leave.requests.approve',
    'leave.policies.manage',
    // Adjusting an entitlement is a policy act, not an approval one: it changes how much
    // leave someone has rather than deciding one application. It rode on
    // `leave.policies.manage`, which conflated "may design the leave scheme" with "may hand
    // this employee four more days".
    'leave.balances.adjust',
    // Encashment turns leave into money, so it gets the same two-person split as everything
    // else that does. These rode on `leave.requests.{create,approve}`, which meant anyone who
    // could approve a day off could approve a payment.
    'leave.encashment.request',
    'leave.encashment.approve',
    // The liability report values outstanding leave against salary. It rode on
    // `leave.requests.view.all`, so seeing the team's leave calendar carried seeing what the
    // institution owes in taka.
    'leave.reports.view',
    // A holiday override is a leave fact as much as a calendar one. It rode on
    // `academic.calendar.*`, which gave the academic office authority over payroll-affecting
    // days and gave HR none.
    'leave.holidays.view',
    'leave.holidays.manage',
  ],

  // ── Operations ────────────────────────────────────────────────────────────────────
  library: [
    'library.catalog.view',
    'library.catalog.manage',
    'library.circulation.manage',
    'library.fines.manage',
    // Forgiving a charge is not the same duty as raising one, and the library controller has
    // carried a comment saying so since the module was written. The service already refuses
    // to let a fine's assessor be its waiver; this makes the separation a grant as well as a
    // data rule, so it holds for someone who never assessed anything.
    'library.fines.waive',
  ],
  transport: [
    'transport.view',
    'transport.routes.manage',
    'transport.vehicles.manage',
    'transport.assignments.manage',
  ],
  inventory: [
    'inventory.view',
    'inventory.manage',
    'inventory.purchase.request',
    'inventory.purchase.approve',
    'inventory.receive',
  ],
  asset: ['assets.view', 'assets.manage', 'assets.assign', 'assets.maintenance.manage'],
  discipline: ['discipline.records.view', 'discipline.records.create', 'discipline.records.action'],

  // ── Cross-cutting ─────────────────────────────────────────────────────────────────
  document: [
    'documents.templates.manage',
    'documents.generate',
    'documents.verify',
    // Deciding a document request is a separate duty from authoring the template it will be
    // rendered from. It rode on `documents.templates.manage`, which is why only the principal
    // and the owner could decide one — defensible by accident rather than by design.
    'documents.requests.approve',
    // Withdrawing an issued certificate is heavier than issuing one: somebody is holding a
    // document that is about to stop verifying.
    'documents.revoke',
    // The issuance register is a report over who was given what. It rode on
    // `documents.generate`, so the ability to print one certificate carried the ability to
    // read every certificate ever issued.
    'documents.register.view',
  ],
  report: ['reports.view', 'reports.build', 'reports.export', 'reports.schedule'],
  workflow: ['workflows.view', 'workflows.manage', 'workflows.act'],
  automation: [
    'automation.rules.view',
    'automation.rules.manage',
    // Four duties that all rode on `automation.rules.manage` — a grant that means "may
    // rewrite what the system does automatically" and should not be the price of any of them.
    'automation.events.emit',
    'automation.events.process',
    // The sharpest of the four: an HR clerk should be able to dismiss a document-expiry
    // suggestion without also being able to edit automation rules.
    'automation.suggestions.decide',
    // Execution history is a log, and reading a log is not reading a configuration.
    'automation.executions.view',
  ],

  // ── AI ────────────────────────────────────────────────────────────────────────────
  ai: [
    'ai.copilot.use',
    'ai.tutor.use',
    'ai.teacher_tools.use',
    'ai.principal_insights.view',
    'ai.knowledge_base.manage',
    'ai.settings.manage',
    'ai.usage.view',
    // Reading somebody else's transcript is not an administrative setting. A conversation
    // holds whatever its user pasted in, which in a school is usually about a child, and
    // `ai.settings.manage` — "may choose the vendor and the budget" — was the closest string
    // that existed when the module was written. It is the wrong shape for this: the person
    // who configures the AI is not automatically the person who may read what staff typed
    // into it.
    'ai.conversations.view.all',
    // Choosing the vendor and setting the ceiling are different decisions, and separating
    // them gives AI spending the same split accounting already has between
    // `accounting.journal.create` and `accounting.journal.post`.
    'ai.budgets.manage',
  ],
} as const;

type CatalogShape = typeof PERMISSION_CATALOG;

/** Every valid permission string, as a union. A typo is a compile error, not a silent deny. */
export type Permission = CatalogShape[keyof CatalogShape][number];

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(
  PERMISSION_CATALOG,
).flat() as readonly Permission[];

const PERMISSION_LOOKUP: ReadonlySet<string> = new Set(ALL_PERMISSIONS);

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && PERMISSION_LOOKUP.has(value);
}

/**
 * Permissions that must never be granted to a custom tenant role through the UI.
 *
 * These either escalate privilege (assigning roles, editing roles) or move money without a
 * second pair of eyes. They can still be granted, but only by a principal who already holds
 * them, which stops a mid-level administrator from quietly writing themselves a role that
 * can issue refunds.
 */
export const PRIVILEGE_ESCALATING_PERMISSIONS: readonly Permission[] = [
  'roles.create',
  'roles.update',
  'roles.delete',
  'users.assign_roles',
  'platform.tenants.manage',
  'platform.plans.manage',
  'platform.impersonate',
  'finance.refund',
  'finance.refund.approve',
  'accounting.journal.post',
  'accounting.journal.reverse',
  'accounting.period.close',
  'payroll.runs.approve',
  'payroll.disburse',
  'results.publish',
  'results.correct',
];

/**
 * Permissions whose exercise is always audited, regardless of what the route declares.
 * The audit interceptor consults this so a new endpoint cannot accidentally ship unaudited.
 */
export const ALWAYS_AUDITED_PERMISSIONS: readonly Permission[] = [
  ...PRIVILEGE_ESCALATING_PERMISSIONS,
  'students.archive',
  'students.transfer',
  'students.withdraw',
  'attendance.correct',
  'attendance.correct.approve',
  'results.approve',
  'results.enter_marks',
  'finance.collect_payment',
  'finance.invoices.void',
  'finance.discounts.approve',
  'users.deactivate',
  'users.reset_password',
  'hr.employees.archive',
  'ai.settings.manage',
];
