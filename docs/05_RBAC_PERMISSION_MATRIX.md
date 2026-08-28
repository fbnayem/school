# 05 — RBAC and Permission Matrix

> **Generated file.** Produced by `scripts/generate-rbac-matrix.ts` from
> `packages/permissions`. Do not edit by hand — run `pnpm docs:rbac` after changing a role
> or the permission catalogue.

Permissions: **203** · System roles: **22**

## How authorization works

Permission strings are the only authorization vocabulary in the system (ADR-005). Guards
check permissions; nothing checks a role name. Roles are rows in the `roles` table carrying
a set of permission strings, so a school can create "Senior Coordinator" without a code
change.

A grant may use a trailing wildcard (`students.*`, or bare `*` for the owner). Requests are
always concrete. Wildcards match at segment boundaries only, so `student.*` does **not**
cover `students.view.all`.

### Scoped permissions

Where a resource means something different depending on whose records are involved, the
distinction is in the permission rather than left to each service:

| Suffix | Meaning |
| --- | --- |
| `.all` | Every record in the accessible institutions |
| `.assigned` | Only records connected to the employee — sections they teach |
| `.own` | Only the caller’s own records, or their linked children |

The guard decides *which* filter applies; the repository applies it. A guard cannot answer
"is this row one of their students" without a database join, so conflating the two produces
endpoints that check a permission and then return every row.

## System roles

| Role | Key | Audience | Sensitive | Permissions | Description |
| --- | --- | --- | --- | --- | --- |
| School Owner | `school_owner` | staff | Yes | 203 | Full control of the organization, including billing and role management. Typically one or two people. |
| Chairman | `chairman` | staff | Yes | 46 | Governing-body oversight. Sees everything and approves high-value actions, but does not do day-to-day data entry. |
| Principal | `principal` | staff | Yes | 103 | Head of the institution. Broad operational authority across academics and staff. |
| Vice Principal | `vice_principal` | staff | No | 37 | Deputises for the principal on academics and discipline; no finance authority. |
| Head Teacher | `head_teacher` | teaching | No | 38 | Leads a department or section. Reviews marks before they reach the controller. |
| Administrator | `administrator` | staff | No | 31 | Day-to-day office administration: records, users, documents. No marks entry, no payments. |
| Academic Coordinator | `academic_coordinator` | teaching | No | 38 | Owns the academic calendar, timetable and curriculum configuration. |
| Admission Officer | `admission_officer` | staff | No | 29 | Runs the admission funnel from inquiry to enrolment. |
| Accountant | `accountant` | staff | Yes | 28 | Collects fees and keeps the books. Cannot approve its own refunds and cannot touch marks. |
| Accounts Manager | `accounts_manager` | staff | Yes | 33 | Supervises accounting. Approves refunds and posts journals. |
| HR Manager | `hr_manager` | staff | Yes | 30 | Employee lifecycle, leave policy and payroll preparation. |
| Examination Controller | `examination_controller` | staff | Yes | 27 | Owns exams end to end, including approval and publication of results. |
| Teacher | `teacher` | teaching | No | 34 | Subject teacher. Sees only the students in sections they are assigned to, and cannot publish results. |
| Class Teacher | `class_teacher` | teaching | No | 40 | Teacher with pastoral responsibility for one section: attendance corrections, guardian contact, leave approval. |
| Librarian | `librarian` | staff | No | 12 | Library catalogue and circulation. |
| Transport Manager | `transport_manager` | staff | No | 13 | Routes, vehicles, drivers and student transport assignments. |
| Inventory Manager | `inventory_manager` | staff | No | 15 | Stock, procurement and assets. |
| Receptionist | `receptionist` | staff | No | 13 | Front desk. Can look up a student and log an inquiry, but cannot change academic or financial records. |
| Security Officer | `security_officer` | staff | No | 9 | Gate entry and exit. Deliberately narrow — enough to identify a student at the gate, nothing more. |
| Student | `student` | student | No | 12 | Sees only their own records. |
| Guardian | `guardian` | guardian | No | 13 | Parent or guardian. Sees only the children explicitly linked to them, and only those. |
| Auditor | `auditor` | external | Yes | 27 | Read-only across finance and records, including the audit log. Cannot change anything, by construction. |

## Permission matrix

A tick means the shipped preset grants the permission. Tenants may edit these, so this is
the starting point, not a guarantee about a live deployment.

Column keys: `SCOW` School Owner · `CH` Chairman · `PR` Principal · `VIPR` Vice Principal · `HETE` Head Teacher · `AD` Administrator · `ACCO` Academic Coordinator · `ADOF` Admission Officer · `AC` Accountant · `ACMA` Accounts Manager · `HRMA` HR Manager · `EXCO` Examination Controller · `TE` Teacher · `CLTE` Class Teacher · `LI` Librarian · `TRMA` Transport Manager · `INMA` Inventory Manager · `RE` Receptionist · `SEOF` Security Officer · `ST` Student · `GU` Guardian · `AU` Auditor

### Platform

| Permission | SCOW | CH | PR | VIPR | HETE | AD | ACCO | ADOF | AC | ACMA | HRMA | EXCO | TE | CLTE | LI | TRMA | INMA | RE | SEOF | ST | GU | AU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `platform.tenants.manage` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `platform.plans.manage` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `platform.impersonate` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |

### Organization

| Permission | SCOW | CH | PR | VIPR | HETE | AD | ACCO | ADOF | AC | ACMA | HRMA | EXCO | TE | CLTE | LI | TRMA | INMA | RE | SEOF | ST | GU | AU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `organization.view` | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ● |
| `organization.update` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `organization.billing.view` | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |

### Institution

| Permission | SCOW | CH | PR | VIPR | HETE | AD | ACCO | ADOF | AC | ACMA | HRMA | EXCO | TE | CLTE | LI | TRMA | INMA | RE | SEOF | ST | GU | AU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `institution.view` | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● |  |  | ● |
| `institution.create` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `institution.update` | ● |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `institution.archive` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |

### Campus

| Permission | SCOW | CH | PR | VIPR | HETE | AD | ACCO | ADOF | AC | ACMA | HRMA | EXCO | TE | CLTE | LI | TRMA | INMA | RE | SEOF | ST | GU | AU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `campus.view` | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● |  |  | ● |
| `campus.create` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `campus.update` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `campus.archive` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |

### Settings

| Permission | SCOW | CH | PR | VIPR | HETE | AD | ACCO | ADOF | AC | ACMA | HRMA | EXCO | TE | CLTE | LI | TRMA | INMA | RE | SEOF | ST | GU | AU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `settings.view` | ● | ● | ● |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ● |
| `settings.update` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `settings.feature_flags.manage` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |

### User

| Permission | SCOW | CH | PR | VIPR | HETE | AD | ACCO | ADOF | AC | ACMA | HRMA | EXCO | TE | CLTE | LI | TRMA | INMA | RE | SEOF | ST | GU | AU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `users.view` | ● |  | ● |  |  | ● |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |
| `users.create` | ● |  |  |  |  | ● |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |
| `users.update` | ● |  |  |  |  | ● |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |
| `users.deactivate` | ● |  |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |
| `users.invite` | ● |  | ● |  |  | ● |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |
| `users.reset_password` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `users.assign_roles` | ● |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |

### Role

| Permission | SCOW | CH | PR | VIPR | HETE | AD | ACCO | ADOF | AC | ACMA | HRMA | EXCO | TE | CLTE | LI | TRMA | INMA | RE | SEOF | ST | GU | AU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `roles.view` | ● |  | ● |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `roles.create` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `roles.update` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `roles.delete` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |

### Audit

| Permission | SCOW | CH | PR | VIPR | HETE | AD | ACCO | ADOF | AC | ACMA | HRMA | EXCO | TE | CLTE | LI | TRMA | INMA | RE | SEOF | ST | GU | AU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `audit.view` | ● | ● | ● |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  | ● |
| `audit.export` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ● |

### Academic

| Permission | SCOW | CH | PR | VIPR | HETE | AD | ACCO | ADOF | AC | ACMA | HRMA | EXCO | TE | CLTE | LI | TRMA | INMA | RE | SEOF | ST | GU | AU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `academic.years.view` | ● | ● | ● | ● | ● | ● | ● | ● | ● |  |  | ● | ● | ● |  |  |  |  |  |  |  | ● |
| `academic.years.manage` | ● | ● | ● |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `academic.terms.manage` | ● | ● | ● |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `academic.classes.view` | ● | ● | ● | ● | ● | ● | ● | ● | ● |  |  | ● | ● | ● |  |  |  | ● |  |  |  | ● |
| `academic.classes.manage` | ● | ● | ● | ● |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `academic.sections.view` | ● | ● | ● | ● | ● | ● | ● | ● | ● |  |  | ● | ● | ● |  |  |  | ● |  |  |  | ● |
| `academic.sections.manage` | ● | ● | ● | ● |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `academic.subjects.view` | ● | ● | ● | ● | ● | ● | ● | ● |  |  |  | ● | ● | ● |  |  |  |  |  |  |  |  |
| `academic.subjects.manage` | ● | ● | ● |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `academic.calendar.view` | ● | ● | ● | ● | ● | ● | ● | ● |  |  |  | ● | ● | ● |  |  |  |  |  | ● | ● |  |
| `academic.calendar.manage` | ● | ● | ● |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `academic.shifts.manage` | ● | ● | ● |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `academic.rooms.manage` | ● | ● | ● |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `academic.assignments.manage` | ● | ● | ● | ● | ● |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |

### Student

| Permission | SCOW | CH | PR | VIPR | HETE | AD | ACCO | ADOF | AC | ACMA | HRMA | EXCO | TE | CLTE | LI | TRMA | INMA | RE | SEOF | ST | GU | AU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `students.view.all` | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● |  | ● |  |  | ● | ● |  | ● | ● |  |  | ● |
| `students.view.assigned` | ● |  |  |  |  |  |  |  |  |  |  |  | ● | ● |  |  |  |  |  |  |  |  |
| `students.view.own` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ● | ● |  |
| `students.create` | ● |  | ● |  |  | ● |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `students.update` | ● |  | ● | ● |  | ● |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |
| `students.archive` | ● |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `students.import` | ● |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `students.export` | ● |  | ● |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `students.promote` | ● |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `students.transfer` | ● |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `students.withdraw` | ● |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `students.readmit` | ● |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `students.medical.view` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `students.documents.view` | ● |  | ● |  |  | ● |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `students.documents.manage` | ● |  |  |  |  | ● |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |

### Guardian

| Permission | SCOW | CH | PR | VIPR | HETE | AD | ACCO | ADOF | AC | ACMA | HRMA | EXCO | TE | CLTE | LI | TRMA | INMA | RE | SEOF | ST | GU | AU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `guardians.view.all` | ● | ● | ● | ● |  | ● |  | ● | ● |  |  |  |  | ● |  | ● |  | ● |  |  |  |  |
| `guardians.view.own` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ● |  |
| `guardians.create` | ● |  |  |  |  | ● |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `guardians.update` | ● |  | ● |  |  | ● |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `guardians.archive` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `guardians.link_student` | ● |  |  |  |  | ● |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `guardians.grant_access` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |

### Admission

| Permission | SCOW | CH | PR | VIPR | HETE | AD | ACCO | ADOF | AC | ACMA | HRMA | EXCO | TE | CLTE | LI | TRMA | INMA | RE | SEOF | ST | GU | AU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `admissions.inquiries.view` | ● |  | ● |  |  |  |  | ● |  |  |  |  |  |  |  |  |  | ● |  |  |  |  |
| `admissions.inquiries.manage` | ● |  | ● |  |  |  |  | ● |  |  |  |  |  |  |  |  |  | ● |  |  |  |  |
| `admissions.applications.view` | ● |  | ● |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `admissions.applications.review` | ● |  | ● |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `admissions.applications.decide` | ● |  | ● |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `admissions.cycles.manage` | ● |  | ● |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `admissions.tests.manage` | ● |  | ● |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `admissions.interviews.manage` | ● |  | ● |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `admissions.merit.publish` | ● |  | ● |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `admissions.enroll` | ● |  | ● |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |

### Timetable

| Permission | SCOW | CH | PR | VIPR | HETE | AD | ACCO | ADOF | AC | ACMA | HRMA | EXCO | TE | CLTE | LI | TRMA | INMA | RE | SEOF | ST | GU | AU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `timetable.view` | ● |  | ● | ● | ● |  | ● |  |  |  |  | ● | ● | ● |  |  |  |  |  | ● | ● |  |
| `timetable.manage` | ● |  | ● | ● |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `timetable.publish` | ● |  | ● |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `timetable.generate` | ● |  | ● |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `timetable.substitute` | ● |  | ● | ● | ● |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |

### Attendance

| Permission | SCOW | CH | PR | VIPR | HETE | AD | ACCO | ADOF | AC | ACMA | HRMA | EXCO | TE | CLTE | LI | TRMA | INMA | RE | SEOF | ST | GU | AU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `attendance.view.all` | ● | ● | ● | ● | ● | ● | ● |  |  |  |  |  |  |  |  |  |  | ● | ● |  |  | ● |
| `attendance.view.assigned` | ● |  |  |  |  |  |  |  |  |  |  |  | ● | ● |  |  |  |  |  |  |  |  |
| `attendance.view.own` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ● | ● |  |
| `attendance.mark` | ● |  |  |  | ● |  |  |  |  |  |  |  | ● | ● |  |  |  |  | ● |  |  |  |
| `attendance.correct` | ● |  | ● | ● | ● |  |  |  |  |  |  |  | ● | ● |  |  |  |  |  |  |  |  |
| `attendance.correct.approve` | ● |  | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `attendance.reports.view` | ● | ● | ● | ● | ● | ● | ● |  |  |  |  |  |  | ● |  |  |  |  |  |  |  | ● |
| `attendance.employee.view` | ● |  | ● |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |
| `attendance.employee.mark` | ● |  |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |

### Exam

| Permission | SCOW | CH | PR | VIPR | HETE | AD | ACCO | ADOF | AC | ACMA | HRMA | EXCO | TE | CLTE | LI | TRMA | INMA | RE | SEOF | ST | GU | AU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `exams.view` | ● |  | ● | ● | ● |  | ● |  |  |  |  | ● | ● | ● |  |  |  |  |  |  |  |  |
| `exams.manage` | ● |  | ● |  |  |  | ● |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |
| `exams.schedule.manage` | ● |  | ● | ● |  |  | ● |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |
| `exams.grading_scheme.manage` | ● |  | ● |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |
| `results.enter_marks` | ● |  |  |  | ● |  |  |  |  |  |  |  | ● | ● |  |  |  |  |  |  |  |  |
| `results.submit_marks` | ● |  |  |  | ● |  |  |  |  |  |  |  | ● | ● |  |  |  |  |  |  |  |  |
| `results.review` | ● |  | ● | ● | ● |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |
| `results.approve` | ● |  | ● |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |
| `results.publish` | ● |  | ● |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |
| `results.unpublish` | ● |  | ● |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |
| `results.correct` | ● |  |  |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |
| `results.view.all` | ● | ● | ● | ● | ● |  | ● |  |  |  |  | ● |  |  |  |  |  |  |  |  |  | ● |
| `results.view.assigned` | ● |  |  |  |  |  |  |  |  |  |  |  | ● | ● |  |  |  |  |  |  |  |  |
| `results.view.own` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ● | ● |  |
| `results.reports.view` | ● | ● | ● | ● | ● |  | ● |  |  |  |  | ● |  | ● |  |  |  |  |  |  |  | ● |

### Homework

| Permission | SCOW | CH | PR | VIPR | HETE | AD | ACCO | ADOF | AC | ACMA | HRMA | EXCO | TE | CLTE | LI | TRMA | INMA | RE | SEOF | ST | GU | AU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `homework.view` | ● |  | ● | ● | ● |  | ● |  |  |  |  |  | ● | ● |  |  |  |  |  | ● | ● |  |
| `homework.create` | ● |  |  |  | ● |  |  |  |  |  |  |  | ● | ● |  |  |  |  |  |  |  |  |
| `homework.update` | ● |  |  |  | ● |  |  |  |  |  |  |  | ● | ● |  |  |  |  |  |  |  |  |
| `homework.delete` | ● |  |  |  | ● |  |  |  |  |  |  |  | ● | ● |  |  |  |  |  |  |  |  |
| `homework.grade` | ● |  |  |  | ● |  |  |  |  |  |  |  | ● | ● |  |  |  |  |  |  |  |  |
| `homework.submit` | ● |  |  |  | ● |  |  |  |  |  |  |  |  | ● |  |  |  |  |  | ● |  |  |

### Lms

| Permission | SCOW | CH | PR | VIPR | HETE | AD | ACCO | ADOF | AC | ACMA | HRMA | EXCO | TE | CLTE | LI | TRMA | INMA | RE | SEOF | ST | GU | AU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `lms.view` | ● |  | ● |  | ● |  | ● |  |  |  |  |  | ● | ● |  |  |  |  |  | ● | ● |  |
| `lms.manage` | ● |  |  |  | ● |  | ● |  |  |  |  |  | ● | ● |  |  |  |  |  |  |  |  |
| `lms.publish` | ● |  | ● |  | ● |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `lms.progress.view` | ● |  |  |  | ● |  | ● |  |  |  |  |  | ● | ● |  |  |  |  |  |  |  |  |

### Fee

| Permission | SCOW | CH | PR | VIPR | HETE | AD | ACCO | ADOF | AC | ACMA | HRMA | EXCO | TE | CLTE | LI | TRMA | INMA | RE | SEOF | ST | GU | AU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `finance.fees.view` | ● | ● | ● |  |  |  |  |  | ● | ● |  |  |  |  |  |  |  |  |  |  |  | ● |
| `finance.fees.manage` | ● |  |  |  |  |  |  |  | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |
| `finance.plans.manage` | ● |  |  |  |  |  |  |  | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |
| `finance.invoices.view` | ● | ● | ● |  |  |  |  | ● | ● | ● |  |  |  |  |  |  |  |  |  |  |  | ● |
| `finance.invoices.generate` | ● |  |  |  |  |  |  |  | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |
| `finance.invoices.void` | ● |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |
| `finance.discounts.manage` | ● |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `finance.discounts.approve` | ● |  | ● |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |
| `finance.collect_payment` | ● |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `finance.refund` | ● |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `finance.refund.approve` | ● | ● |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |
| `finance.ledger.view` | ● | ● | ● |  |  |  |  |  | ● | ● |  |  |  |  |  |  |  |  |  |  |  | ● |
| `finance.reports.view` | ● | ● | ● |  |  |  |  |  | ● | ● |  |  |  |  |  |  |  |  |  |  |  | ● |
| `finance.own.view` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ● | ● |  |

### Accounting

| Permission | SCOW | CH | PR | VIPR | HETE | AD | ACCO | ADOF | AC | ACMA | HRMA | EXCO | TE | CLTE | LI | TRMA | INMA | RE | SEOF | ST | GU | AU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `accounting.coa.view` | ● | ● |  |  |  |  |  |  | ● | ● |  |  |  |  |  |  |  |  |  |  |  | ● |
| `accounting.coa.manage` | ● |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |
| `accounting.journal.view` | ● | ● |  |  |  |  |  |  | ● | ● |  |  |  |  |  |  |  |  |  |  |  | ● |
| `accounting.journal.create` | ● |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `accounting.journal.post` | ● | ● |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |
| `accounting.journal.reverse` | ● |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |
| `accounting.reports.view` | ● | ● | ● |  |  |  |  |  | ● | ● |  |  |  |  |  |  |  |  |  |  |  | ● |
| `accounting.budgets.manage` | ● |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |
| `accounting.reconcile` | ● |  |  |  |  |  |  |  | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |
| `accounting.period.close` | ● | ● |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |

### Communication

| Permission | SCOW | CH | PR | VIPR | HETE | AD | ACCO | ADOF | AC | ACMA | HRMA | EXCO | TE | CLTE | LI | TRMA | INMA | RE | SEOF | ST | GU | AU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `communication.templates.manage` | ● |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `communication.send` | ● |  | ● | ● | ● | ● |  | ● |  |  |  | ● | ● | ● |  | ● |  | ● |  |  |  |  |
| `communication.send.bulk` | ● |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `communication.notices.publish` | ● |  | ● | ● |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `communication.delivery.view` | ● |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |

### Hr

| Permission | SCOW | CH | PR | VIPR | HETE | AD | ACCO | ADOF | AC | ACMA | HRMA | EXCO | TE | CLTE | LI | TRMA | INMA | RE | SEOF | ST | GU | AU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `hr.employees.view` | ● | ● | ● |  |  |  |  |  |  |  | ● |  |  |  | ● |  |  |  |  |  |  | ● |
| `hr.employees.create` | ● |  |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |
| `hr.employees.update` | ● |  | ● |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |
| `hr.employees.archive` | ● |  |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |
| `hr.documents.view` | ● |  |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |
| `hr.contracts.manage` | ● |  | ● |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |
| `hr.performance.manage` | ● |  | ● |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |
| `hr.exit.manage` | ● |  |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |

### Payroll

| Permission | SCOW | CH | PR | VIPR | HETE | AD | ACCO | ADOF | AC | ACMA | HRMA | EXCO | TE | CLTE | LI | TRMA | INMA | RE | SEOF | ST | GU | AU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `payroll.structures.manage` | ● |  |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |
| `payroll.runs.view` | ● | ● |  |  |  |  |  |  |  | ● | ● |  |  |  |  |  |  |  |  |  |  | ● |
| `payroll.runs.create` | ● |  |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |
| `payroll.runs.approve` | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `payroll.payslips.view.all` | ● |  |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |
| `payroll.payslips.view.own` | ● |  |  |  |  |  |  |  |  |  |  |  | ● | ● | ● | ● | ● | ● | ● |  |  |  |
| `payroll.disburse` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |

### Leave

| Permission | SCOW | CH | PR | VIPR | HETE | AD | ACCO | ADOF | AC | ACMA | HRMA | EXCO | TE | CLTE | LI | TRMA | INMA | RE | SEOF | ST | GU | AU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `leave.requests.view.all` | ● |  | ● | ● |  |  |  |  |  |  | ● |  |  | ● |  |  |  |  |  |  |  |  |
| `leave.requests.view.own` | ● |  |  |  |  |  |  |  |  |  | ● |  | ● |  | ● | ● | ● | ● | ● |  | ● |  |
| `leave.requests.create` | ● |  |  |  |  |  |  |  |  |  | ● |  | ● | ● | ● | ● | ● | ● | ● |  | ● |  |
| `leave.requests.approve` | ● |  | ● | ● |  |  |  |  |  |  | ● |  |  | ● |  |  |  |  |  |  |  |  |
| `leave.policies.manage` | ● |  |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |

### Library

| Permission | SCOW | CH | PR | VIPR | HETE | AD | ACCO | ADOF | AC | ACMA | HRMA | EXCO | TE | CLTE | LI | TRMA | INMA | RE | SEOF | ST | GU | AU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `library.catalog.view` | ● |  | ● |  |  |  |  |  |  |  |  |  |  |  | ● |  |  |  |  | ● |  |  |
| `library.catalog.manage` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |
| `library.circulation.manage` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |
| `library.fines.manage` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |

### Transport

| Permission | SCOW | CH | PR | VIPR | HETE | AD | ACCO | ADOF | AC | ACMA | HRMA | EXCO | TE | CLTE | LI | TRMA | INMA | RE | SEOF | ST | GU | AU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `transport.view` | ● |  | ● |  |  |  |  |  |  |  |  |  |  |  |  | ● |  |  | ● |  | ● |  |
| `transport.routes.manage` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |
| `transport.vehicles.manage` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |
| `transport.assignments.manage` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |

### Inventory

| Permission | SCOW | CH | PR | VIPR | HETE | AD | ACCO | ADOF | AC | ACMA | HRMA | EXCO | TE | CLTE | LI | TRMA | INMA | RE | SEOF | ST | GU | AU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `inventory.view` | ● |  |  |  |  |  |  |  | ● | ● |  |  |  |  |  |  | ● |  |  |  |  | ● |
| `inventory.manage` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |
| `inventory.purchase.request` | ● |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  | ● |  |  |  |  |  |
| `inventory.purchase.approve` | ● |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |
| `inventory.receive` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |

### Asset

| Permission | SCOW | CH | PR | VIPR | HETE | AD | ACCO | ADOF | AC | ACMA | HRMA | EXCO | TE | CLTE | LI | TRMA | INMA | RE | SEOF | ST | GU | AU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `assets.view` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ● |  |  |  |  | ● |
| `assets.manage` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |
| `assets.assign` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |
| `assets.maintenance.manage` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |

### Discipline

| Permission | SCOW | CH | PR | VIPR | HETE | AD | ACCO | ADOF | AC | ACMA | HRMA | EXCO | TE | CLTE | LI | TRMA | INMA | RE | SEOF | ST | GU | AU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `discipline.records.view` | ● |  | ● | ● | ● |  |  |  |  |  |  |  | ● | ● |  |  |  |  |  |  |  |  |
| `discipline.records.create` | ● |  | ● | ● | ● |  |  |  |  |  |  |  | ● | ● |  |  |  |  |  |  |  |  |
| `discipline.records.action` | ● |  | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |

### Document

| Permission | SCOW | CH | PR | VIPR | HETE | AD | ACCO | ADOF | AC | ACMA | HRMA | EXCO | TE | CLTE | LI | TRMA | INMA | RE | SEOF | ST | GU | AU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `documents.templates.manage` | ● |  | ● |  |  |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |
| `documents.generate` | ● |  | ● |  |  | ● |  | ● | ● | ● | ● | ● | ● | ● |  |  |  |  |  |  |  |  |
| `documents.verify` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ● | ● |  |

### Report

| Permission | SCOW | CH | PR | VIPR | HETE | AD | ACCO | ADOF | AC | ACMA | HRMA | EXCO | TE | CLTE | LI | TRMA | INMA | RE | SEOF | ST | GU | AU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reports.view` | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● |  |  |  |  | ● |
| `reports.build` | ● | ● | ● |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |
| `reports.export` | ● | ● | ● | ● |  | ● | ● |  | ● | ● | ● | ● |  |  |  |  |  |  |  |  |  | ● |
| `reports.schedule` | ● | ● | ● |  |  |  |  |  |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |

### Workflow

| Permission | SCOW | CH | PR | VIPR | HETE | AD | ACCO | ADOF | AC | ACMA | HRMA | EXCO | TE | CLTE | LI | TRMA | INMA | RE | SEOF | ST | GU | AU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `workflows.view` | ● |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `workflows.manage` | ● |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `workflows.act` | ● | ● | ● | ● | ● |  |  |  | ● | ● | ● | ● |  |  |  |  | ● |  |  |  |  |  |

### Automation

| Permission | SCOW | CH | PR | VIPR | HETE | AD | ACCO | ADOF | AC | ACMA | HRMA | EXCO | TE | CLTE | LI | TRMA | INMA | RE | SEOF | ST | GU | AU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `automation.rules.view` | ● |  | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `automation.rules.manage` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |

### Ai

| Permission | SCOW | CH | PR | VIPR | HETE | AD | ACCO | ADOF | AC | ACMA | HRMA | EXCO | TE | CLTE | LI | TRMA | INMA | RE | SEOF | ST | GU | AU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ai.copilot.use` | ● | ● | ● | ● | ● |  | ● |  |  | ● |  | ● | ● | ● |  |  |  |  |  |  |  |  |
| `ai.tutor.use` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ● |  |  |
| `ai.teacher_tools.use` | ● |  | ● |  | ● |  | ● |  |  |  |  |  | ● | ● |  |  |  |  |  |  |  |  |
| `ai.principal_insights.view` | ● | ● | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `ai.knowledge_base.manage` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `ai.settings.manage` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `ai.usage.view` | ● |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |

## Separation of duties

These pairings are deliberate and are asserted by `packages/permissions/test/rbac-matrix.spec.ts`.
Weakening one should mean changing the test with an explanation, not quietly widening a preset.

| Action | Performed by | Approved by |
| --- | --- | --- |
| Refund | `school_owner`, `accountant` | `school_owner`, `chairman`, `accounts_manager` |
| Discount | `school_owner`, `accountant` | `school_owner`, `principal`, `accounts_manager` |
| Journal entry | `school_owner`, `accountant` | `school_owner`, `chairman`, `accounts_manager` |
| Marks | `school_owner`, `head_teacher`, `teacher`, `class_teacher` | `school_owner`, `principal`, `examination_controller` |
| Results publication | `school_owner`, `head_teacher`, `teacher`, `class_teacher` | `school_owner`, `principal`, `examination_controller` |
| Payroll run | `school_owner`, `hr_manager` | `school_owner`, `chairman` |
| Attendance correction | `school_owner`, `principal`, `vice_principal`, `head_teacher`, `teacher`, `class_teacher` | `school_owner`, `principal`, `vice_principal` |

## Privilege-escalating permissions

These can create or widen access, or move money without a second pair of eyes. They may only
be granted by a principal who already holds them, which stops a mid-level administrator from
writing themselves a role that can issue refunds.

| Permission | Held by |
| --- | --- |
| `roles.create` | `school_owner` |
| `roles.update` | `school_owner` |
| `roles.delete` | `school_owner` |
| `users.assign_roles` | `school_owner`, `principal` |
| `platform.tenants.manage` | `school_owner` |
| `platform.plans.manage` | `school_owner` |
| `platform.impersonate` | `school_owner` |
| `finance.refund` | `school_owner`, `accountant` |
| `finance.refund.approve` | `school_owner`, `chairman`, `accounts_manager` |
| `accounting.journal.post` | `school_owner`, `chairman`, `accounts_manager` |
| `accounting.journal.reverse` | `school_owner`, `accounts_manager` |
| `accounting.period.close` | `school_owner`, `chairman`, `accounts_manager` |
| `payroll.runs.approve` | `school_owner`, `chairman` |
| `payroll.disburse` | `school_owner` |
| `results.publish` | `school_owner`, `principal`, `examination_controller` |
| `results.correct` | `school_owner`, `examination_controller` |

## Always-audited permissions

Exercising any of these writes an immutable audit record regardless of what the route
declares, so a new endpoint cannot ship unaudited.

- `roles.create`
- `roles.update`
- `roles.delete`
- `users.assign_roles`
- `platform.tenants.manage`
- `platform.plans.manage`
- `platform.impersonate`
- `finance.refund`
- `finance.refund.approve`
- `accounting.journal.post`
- `accounting.journal.reverse`
- `accounting.period.close`
- `payroll.runs.approve`
- `payroll.disburse`
- `results.publish`
- `results.correct`
- `students.archive`
- `students.transfer`
- `students.withdraw`
- `attendance.correct`
- `attendance.correct.approve`
- `results.approve`
- `results.enter_marks`
- `finance.collect_payment`
- `finance.invoices.void`
- `finance.discounts.approve`
- `users.deactivate`
- `users.reset_password`
- `hr.employees.archive`
- `ai.settings.manage`

---

Generated 2026-08-28 from `packages/permissions`.
