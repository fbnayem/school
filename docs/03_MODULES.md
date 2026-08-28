# 03 — Modules

Thirty-six phases, ordered so nothing is built before the thing it depends on for correctness.
`docs/12_DEVELOPMENT_STATUS.md` records what is actually built; this file records what each
module _is_ and what it depends on.

---

## The rule that makes this one product

**Every module reads and writes the same institutional records.** There is one `students` table.
Attendance does not keep a copy of a student's name; it stores `student_id` and joins.

The test: if you are about to add a column named `student_name` to a non-student table, stop.

One exception, and it is not a cache: **immutable financial and academic documents**. An issued
invoice line stores the fee name and amount _as they were at issue_, because reprinting last
year's receipt must not reflect this year's fee revision. Those are historical facts, and they
are never written back to.

---

## Implemented

### Phase 1 — Platform foundation

Authentication, sessions, multi-tenancy, RBAC, audit, storage, configuration, health, logging,
error handling. Everything else depends on it, and nothing else is safe without it.

Data: `organizations`, `institutions`, `campuses`, `users`, `roles`, `user_roles`, `sessions`,
`auth_tokens`, `audit_logs`, `security_events`, `files`, `plans`, `subscriptions`,
`feature_flags`.

### Phase 2 — Academic foundation _(partial)_

Academic years, terms, class levels, sections, subjects, curriculum, groups, shifts, rooms,
periods, calendar, teacher assignments.

All configuration. A school running two semesters and one running three terms use the same
tables; a coaching centre with weekend classes configures its own weekend.

`employee_section_assignments` and `employee_subject_assignments` are what make
`students.view.assigned` mean something concrete — they are the joins the repository uses to
narrow a teacher's view.

### Phase 3 — Student Information System _(partial)_

The central entity. `students` is the person; `enrollments` is the year-by-year placement. That
split is what makes promotion, transfer, repetition and readmission expressible without
destroying history.

### Phase 4 — Guardian management _(partial)_

`student_guardians` is an **authorization table**, not a convenience join: a row is what lets a
parent see a child. Many-to-many both ways — one guardian with four children is one record and
four links, so updating their phone number updates it once and SMS goes out once.

---

## Planned

### Phase 5 — Admissions

Inquiry → application → documents → review → test → interview → merit → offer → payment →
enrolment. Produces students and guardians, so it depends on both. Public forms are the first
unauthenticated write surface in the product and need their own rate limiting and spam handling.

### Phase 6 — Timetable

Manual first, with teacher, room and class conflict detection. The constraint model is designed
so a solver can be added behind the same interface rather than replacing it.

### Phase 7 — Attendance

Present / absent / late / leave / excused, per student per date, optionally per period.
Consults the academic calendar before allowing a register — marking a closed day is almost
always a data-entry error, and accepting it corrupts the attendance percentage that drives the
early-warning system. Corrections are audited with a mandatory reason.

Designed for offline-first mobile sync: the natural key is (student, date, period), so a
replayed submission is idempotent.

### Phase 8 — Examinations and results

Configurable assessment components (theory / MCQ / practical / assignment / viva), grade rules,
GPA with the fourth-subject rule, subject-specific pass requirements.

Workflow: enter → submit → review → approve → publish. Approved marks lock; correction requires
an authorised workflow and an audit record.

### Phase 9–10 — Homework, assignments, LMS

Subject → chapter → lesson → content, with submissions, rubrics and progress.

### Phase 11 — Fee management

Categories, plans, discounts, scholarships, waivers, fines, installments, partial and advance
payments, credit balances, refunds, and a real student ledger. Installments use
`Money.allocate`, so a plan always sums back to the invoice.

### Phase 12 — Payment gateways

`PaymentProvider` with adapters for cash, bank, bKash, Nagad and SSLCommerz. Payment intents,
callback verification, idempotency, duplicate-callback protection, reconciliation. Mock provider
for development, so the absence of credentials never blocks the workflow around them.

### Phase 13 — Accounting

Real double-entry. Chart of accounts, journal, general ledger, AR/AP, trial balance, income
statement, balance sheet, cash flow, aging, budgets. Fee and payment events post automatically:
collecting a fee is Dr Cash / Cr Student Receivable.

Strict transactional integrity, `numeric` money, no floating point.

### Phase 14 — Communication

Templates, in-app, SMS, email, push and WhatsApp adapters. Event-driven — absence, fee due,
payment received, result published, school closure. Queued with retries, failure logging and
delivery status.

### Phase 15–16 — HR and payroll

Employee lifecycle, leave, contracts, performance. Salary structures, allowances, deductions,
loans, attendance impact, salary runs with approval, payslips, accounting integration.

### Phase 17–20 — Library, transport, inventory, assets

Operational modules. Transport defines a GPS integration interface with a mock adapter, so the
module completes without a live GPS service.

### Phase 21–22 — Leave and discipline

Configurable approval workflows. Discipline is neutral record keeping — incident, category,
reporter, evidence, action, follow-up. AI never determines punishment.

### Phase 23–24 — Documents and reports

Branded templates for ID cards, admit cards, report cards, transcripts, transfer certificates,
receipts and payslips, with QR verification. A generic report builder with access control built
into the query, not applied after it.

### Phase 25 — Workflow engine

Extracted once two modules need approvals rather than designed up front. Steps, conditions,
approvers, rejection, send-back, comments, history.

This is also where **approver ≠ initiator** is enforced (KI-002). Permissions cannot express
"not this specific person", so the static separation of duties in the role presets needs a
runtime counterpart.

### Phase 26 — Automation

Configurable rules over the event bus: three consecutive absences notifies the guardian and the
class teacher and creates a follow-up task; a fee 15 days overdue sends a reminder.

### Phases 27–36 — AI

The structural decision is in Phase 27 and everything else follows from it: **the AI service is
given no database credentials.** It reaches institutional data only by calling back into the API
with the caller's delegated authorization, through tools that each re-verify permissions.

That is not a policy the AI could violate — it is a missing connection string.

- **27** AI gateway, intent router, permission-checked tools
- **28** Provider abstraction (OpenAI / Anthropic / Gemini / local), per-task routing
- **29** Tenant-isolated RAG over policies, handbooks, syllabus and notices, using pgvector
- **30–34** Copilots: school, principal, teacher, student tutor, parent assistant
- **35** Bangla / English / Banglish, preserving context across languages
- **36** Explainable early warning — risk with reasons and evidence, never a bare score

**AI never executes a sensitive action.** Grades, attendance, admissions, refunds, payroll,
deletions and mass communications go: AI suggests → human reviews → human confirms → system
executes. The `is_ai_initiated` column exists on `audit_logs` from migration 0001 so that when
an AI-assisted action does happen, it is distinguishable in the trail forever.
