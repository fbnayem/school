# 12 — Development Status

**This file is the source of truth for what actually works.** It is written to be pessimistic:
if something is not marked COMPLETE here, treat it as not working, regardless of what any other
document says.

Statuses: `NOT STARTED` · `PLANNING` · `IN PROGRESS` · `BLOCKED` · `TESTING` · `COMPLETE`

A feature is COMPLETE only when API, database, validation, authorization, tenant isolation,
error handling, audit logging, unit tests, integration tests and documentation are all in place.
UI alone is never completion.

---

## Summary

|                         |                                                                        |
| ----------------------- | ---------------------------------------------------------------------- |
| Last updated            | 2026-08-29                                                             |
| Phases planned          | 36                                                                     |
| Phases complete         | 1 (Platform Foundation)                                                |
| Phases partial          | 3 (Academic Foundation, SIS, Guardians)                                |
| Automated tests passing | **310** (86 shared · 69 permissions · 35 validation · 15 db · 105 API) |
| Tenant-isolation tests  | 23 passing — no known leakage                                          |
| RBAC enforcement tests  | 26 passing                                                             |
| Database migrations     | 3, applied cleanly from empty                                          |
| Production build        | API and web both build without errors                                  |
| TypeScript errors       | 0                                                                      |

---

## Phase 1 — Platform Foundation · `COMPLETE`

| Feature                             | Status            | Notes                                                                               |
| ----------------------------------- | ----------------- | ----------------------------------------------------------------------------------- |
| Monorepo (pnpm + Turborepo)         | COMPLETE          | 5 packages, 2 apps                                                                  |
| Environment configuration           | COMPLETE          | Zod-validated; refuses to start with development values when `NODE_ENV=production`  |
| Structured logging                  | COMPLETE          | pino, request-id correlation, PII redaction                                         |
| Error handling                      | COMPLETE          | One exception filter, stable envelope, no stack traces to clients                   |
| Health checks                       | COMPLETE          | `/health/live`, `/health/ready`, `/health` — database, Redis, storage               |
| Authentication                      | COMPLETE          | Argon2id, JWT access tokens, rotating opaque refresh tokens                         |
| Refresh-token reuse detection       | COMPLETE          | Revokes the session family; recorded as a critical security event                   |
| Session revocation                  | COMPLETE          | Millisecond-precision credentials version; "log out everywhere" is immediate        |
| Account lockout                     | COMPLETE          | Configurable threshold and duration; audited                                        |
| Rate limiting                       | COMPLETE          | Global plus a stricter credential-endpoint limit, both configurable at runtime      |
| Multi-tenancy                       | COMPLETE          | Three layers: request context, repository, Postgres RLS                             |
| Row-Level Security                  | COMPLETE          | Forced on all 37 tenant tables; assertions fail the migration if coverage regresses |
| Organization / Institution / Campus | COMPLETE          | Schema, constraints, RLS                                                            |
| RBAC                                | COMPLETE          | 203 permissions, 22 system roles, wildcard evaluation, scoped data access           |
| Boot-time route audit               | COMPLETE          | Refuses to start if a route declares no access requirement                          |
| Audit logging                       | COMPLETE          | Append-only, enforced by grants and a trigger; redaction of sensitive fields        |
| Security event log                  | COMPLETE          | Login failures, lockouts, token reuse, permission denials, cross-tenant attempts    |
| File storage abstraction            | COMPLETE          | Local adapter with real signed URLs; S3 adapter interface present, unimplemented    |
| Feature flags                       | COMPLETE (schema) | Tables and resolution order defined; no admin UI                                    |
| Subscription / plan foundation      | COMPLETE (schema) | Tables and limit fields; no billing integration                                     |
| Localization                        | PARTIAL           | Bilingual data model throughout; UI strings are English-only                        |
| Asia/Dhaka timezone handling        | COMPLETE          | UTC storage, single presentation boundary, 19 tests                                 |
| Docker development environment      | COMPLETE          | Postgres 17 + pgvector, Redis 7, MinIO, Mailpit                                     |
| Testing infrastructure              | COMPLETE          | Unit / integration / security projects; real database, nothing stubbed              |
| MFA                                 | NOT STARTED       | Columns exist so enabling it is not a migration risk                                |
| User invitations                    | NOT STARTED       | `auth_tokens` table exists; no endpoint                                             |
| Password reset                      | NOT STARTED       | `auth_tokens` table exists; no endpoint                                             |

**Phase 1 audit result:** passed. Tenant isolation verified at the application layer _and_
independently at the database layer with the unprivileged role. See
`apps/api/test/security/tenant-isolation.spec.ts`.

---

## Phase 2 — Academic Foundation · `IN PROGRESS`

| Feature                       | Status                   | Notes                                                                    |
| ----------------------------- | ------------------------ | ------------------------------------------------------------------------ |
| Academic years                | COMPLETE                 | Overlap prevention, single-current invariant enforced in one transaction |
| Terms                         | COMPLETE                 | Replaced as a set; weights must total 100%, ranges must not overlap      |
| Class levels                  | COMPLETE                 | Ordinal-driven, decoupled from display name                              |
| Sections                      | COMPLETE                 | Capacity enforced at enrolment; live counts without N+1                  |
| Subjects                      | COMPLETE                 | Fourth-subject and GPA-exclusion flags modelled                          |
| Curriculum (`class_subjects`) | COMPLETE (schema + seed) | Mark distribution validated to sum to full marks; no CRUD endpoint yet   |
| Academic groups               | COMPLETE (schema + seed) | Science / Commerce / Humanities                                          |
| Shifts                        | COMPLETE (schema + seed) | Morning/day; no CRUD endpoint yet                                        |
| Rooms                         | SCHEMA ONLY              | No endpoint                                                              |
| Periods                       | SCHEMA ONLY              | No endpoint                                                              |
| Academic calendar             | SCHEMA ONLY              | Table, constraints and seed data; no endpoint                            |
| Teacher assignments           | COMPLETE (schema + seed) | Drives the `assigned` data scope; no CRUD endpoint yet                   |

**Blocking Phase 2 completion:** CRUD endpoints for rooms, periods, calendar, shifts and
teacher assignments; an editing UI.

---

## Phase 3 — Student Information System · `IN PROGRESS`

| Feature                           | Status           | Notes                                                                          |
| --------------------------------- | ---------------- | ------------------------------------------------------------------------------ |
| Student create                    | COMPLETE         | Auto-generated codes, duplicate detection, optional same-transaction enrolment |
| Student read (list)               | COMPLETE         | Permission-scoped, paginated, full-text search, sortable                       |
| Student read (one)                | COMPLETE         | Same scope filter as the list — no separate IDOR-prone path                    |
| Student update                    | COMPLETE         | Optimistic locking; audit records only changed fields                          |
| Student archive                   | COMPLETE         | Mandatory reason; refuses while enrolment is active                            |
| Medical data protection           | COMPLETE         | Redacted server-side without `students.medical.view`                           |
| Enrolment                         | PARTIAL          | Created with a student; no standalone endpoint                                 |
| Status history                    | COMPLETE (write) | Written on admission; no read endpoint                                         |
| Promotion / transfer / withdrawal | NOT STARTED      | Schema supports them                                                           |
| Import / export                   | NOT STARTED      |                                                                                |
| Documents                         | SCHEMA ONLY      |                                                                                |
| Bulk operations                   | NOT STARTED      |                                                                                |

---

## Phase 4 — Guardian Management · `IN PROGRESS`

| Feature                       | Status      | Notes                                                                 |
| ----------------------------- | ----------- | --------------------------------------------------------------------- |
| Guardian create               | COMPLETE    | Phone-based deduplication                                             |
| Guardian list                 | COMPLETE    | Scoped; a guardian sees co-guardians of their own children            |
| Link to student               | COMPLETE    | Audited; primary/billing exclusivity handled transactionally          |
| Unlink                        | COMPLETE    | Mandatory reason; refuses to leave a student with no guardian         |
| `my-children` portal endpoint | COMPLETE    | Derived entirely from the caller's identity — no tamperable parameter |
| Guardian portal invitation    | NOT STARTED |                                                                       |

---

## Phases 5–36 · `NOT STARTED`

Admissions, timetable, attendance, examinations, homework, LMS, fees, payments, accounting,
communication, HR, payroll, library, transport, inventory, assets, leave, discipline,
documents, reports, workflow engine, automation, and the AI phases (27–36) are designed in
`docs/00_MASTER_PLAN.md` and have schema-level groundwork where it affected Phase 1–4 decisions
(the permission catalogue covers all of them, the audit taxonomy covers all of them). No
implementation.

---

## Web application

| Screen             | Status               | Notes                                                                                          |
| ------------------ | -------------------- | ---------------------------------------------------------------------------------------------- |
| Sign in            | COMPLETE             | Shared Zod schema, field-level errors, request id on failure                                   |
| Dashboard          | COMPLETE             | Role-derived: guardian, teacher and administrator views                                        |
| Student list       | COMPLETE             | Debounced server search, pagination, card layout below `sm`                                    |
| Student detail     | COMPLETE             | Medical section marked restricted when present                                                 |
| Parent portal      | COMPLETE             |                                                                                                |
| Academic structure | COMPLETE (read-only) | Editing deliberately absent rather than inert                                                  |
| Audit log          | COMPLETE             | Expandable entries with before/after values                                                    |
| Responsive         | COMPLETE             | Sidebar becomes a slide-over; tables become cards                                              |
| Accessibility      | PARTIAL              | Skip link, focus-visible rings, ARIA on interactive elements, table captions. No formal audit. |
| Dark mode          | COMPLETE (tokens)    | Defined in tokens; no toggle                                                                   |
| Bangla UI strings  | NOT STARTED          | Data is bilingual; chrome is English                                                           |

---

## Verification commands

```bash
pnpm infra:up            # Postgres + Redis
pnpm db:migrate          # 5 migrations
pnpm db:seed -- --fresh  # 960 students, 837 guardians, 24 sections
pnpm test                # 310 tests
pnpm typecheck           # 0 errors
pnpm lint                # 0 errors
pnpm build               # API + web
```
