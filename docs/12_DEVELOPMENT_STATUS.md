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
| Last updated            | 2026-08-29                                                              |
| Phases planned          | 36                                                                      |
| Phases complete         | 20 — 1–20 and 22, 25 (backend). See the table below                     |
| Phases not started      | 21, 23, 24, 26 and the AI phases 27–36                                  |
| Automated tests passing | **1,239** (86 shared · 71 permissions · 35 validation · 18 db · 1,029 API) |
| HTTP routes             | 625 across 31 controllers, 0 of them unaudited on a mutating method     |
| Database migrations     | 27, applied cleanly from empty on a scratch database                    |
| Row-level security      | 181 of 181 tenant tables ENABLED **and** FORCED                         |
| Production build        | API and web both build without errors                                   |
| TypeScript errors       | 0                                                                       |
| **Web UI**              | **8 pages against 625 routes — the largest gap in the system**          |

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

## Phases 2–26 — backend status

Read this table as the backend claim only. Every phase marked COMPLETE has schema with forced
row-level security, migrations that apply from empty, validation, permission-checked routes,
audited mutations, and an integration spec that exercises tenant isolation from both the HTTP
layer and raw SQL as the unprivileged application role. **None of them has a UI**, which is why
the web section below is the honest bottleneck rather than a cosmetic gap.

| Phase | Module                          | Backend    | Spec                     | Notes                                                                 |
| ----- | ------------------------------- | ---------- | ------------------------ | --------------------------------------------------------------------- |
| 2     | Academic foundation             | COMPLETE   | `academic.spec.ts`       | Rooms, periods, calendar, shifts and assignments all have CRUD (0015) |
| 3     | Student Information System      | COMPLETE   | `students.spec.ts`       | Promotion, transfer, withdrawal, readmission, documents, export       |
| 4     | Guardian management             | COMPLETE   | `guardians.spec.ts`      | Portal invitation lands with the auth lifecycle (0011)                |
| 5     | Admissions                      | COMPLETE   | `admissions.spec.ts`     | Applications, seats, offers, conversion to student                    |
| 6     | Timetable                       | COMPLETE   | `timetable.spec.ts`      | Clash detection in SQL; publishing archives the previous version      |
| 7     | Attendance                      | COMPLETE   | `attendance.spec.ts`     | Corrections are a reviewed workflow, never a silent overwrite         |
| 8     | Examinations and results        | COMPLETE   | `exams.spec.ts`          | Marks → review → approve → publish, each step audited                 |
| 9     | Homework                        | COMPLETE   | `homework.spec.ts`       |                                                                       |
| 10    | LMS                             | COMPLETE   | `lms.spec.ts`            | Own permission triple + `lms.submit`; answer key never leaves         |
| 11    | Fees                            | COMPLETE   | `fees.spec.ts`           | `numeric(14,2)` throughout; invoice totals derived in the database    |
| 12    | Payment gateway                 | COMPLETE   | `payment-gateway.spec.ts`| bKash/Nagad/SSLCommerz adapters + a mock; stubs refuse loudly         |
| 13    | Accounting                      | COMPLETE   | `accounting.spec.ts`     | Balanced-entry, debit-XOR-credit and open-period checks in the DB     |
| 14    | Communication                   | COMPLETE   | `communication.spec.ts`  | Bulk send is submit → approve → send, never one click                 |
| 15    | HR                              | COMPLETE   | `hr.spec.ts`             |                                                                       |
| 16    | Payroll                         | COMPLETE   | `payroll.spec.ts`        | Gross and net derived in the DB; a posted run is immutable            |
| 17    | Library                         | COMPLETE   | `library.spec.ts`        | The assessor of a fine can never be its waiver                        |
| 18    | Transport                       | COMPLETE   | `transport.spec.ts`      | GPS provider is an adapter; the stub refuses rather than inventing    |
| 19    | Inventory and procurement       | COMPLETE   | `inventory.spec.ts`      | Stock levels derived from movements; cannot go negative (0025, 0031)  |
| 20    | Asset management                | COMPLETE   | `assets.spec.ts`         | Depreciation posts to the ledger; a posted run is immutable           |
| 21    | Leave                           | IN PROGRESS| —                        | Migration 0027 written; module not yet wired                          |
| 22    | Discipline                      | COMPLETE   | `discipline.spec.ts`     |                                                                       |
| 23    | Documents and templates         | IN PROGRESS| —                        | Migration 0028 written; module not yet wired                          |
| 24    | Report builder                  | IN PROGRESS| —                        | Migration 0029 written; module not yet wired                          |
| 25    | Workflow engine                 | COMPLETE   | `workflow.spec.ts`       | Used by admissions, attendance corrections, discipline and payroll    |
| 26    | Automation engine               | IN PROGRESS| —                        | Migration 0030 written; module not yet wired                          |

---

## Phases 27–36 — AI · `IN PROGRESS`

The architecture is settled in `docs/06_AI_ARCHITECTURE.md` and the structural decision it
turns on — `apps/ai` holds no database credentials and reaches data only by calling back into
the API with the caller's own authorization — is what the rest depends on. Implementation is
underway; nothing here is COMPLETE and nothing should be treated as working.

`audit_logs.is_ai_initiated` has existed since migration 0001 so that an AI-assisted action is
distinguishable in the trail forever, and the permission catalogue has carried the `ai.*`
vocabulary from the start, so neither is a retrofit.

---

## Web application

**This is the honest bottleneck.** The backend exposes 625 routes; the web application has
eight pages. Everything below is real and works — none of it is a placeholder — but it covers a
small fraction of what the API can do, and no amount of backend completeness compensates for
that. A school cannot use an API.

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
| Everything else    | NOT STARTED          | Attendance, exams, fees, admissions, HR, timetable, library, transport, inventory, assets, LMS, communication, accounting, payroll, discipline, workflow — API only |

Typed API clients exist ahead of their screens for academic, attendance and fees
(`src/components/*/api.ts`); the pages that consume them are not written yet.

**End-to-end tests:** none. Playwright is not set up. The integration suite drives the API
directly, so no user journey is covered through a browser.

---

## Verification commands

Every command here was run before it was written down.

```bash
pnpm infra:up                                  # Postgres 17 + pgvector, Redis, MinIO, Mailpit
pnpm db:migrate                                # 27 migrations, clean from empty
pnpm db:seed -- --fresh                        # demo tenant with students, guardians, sections
pnpm test                                      # 1,239 tests
pnpm typecheck                                 # 0 errors
pnpm lint                                      # 0 errors
pnpm build                                     # API + web
```

The integration suite migrates and runs against `shikkha_test`, which must already exist. To
run two suites at once — or to keep a run insulated from a migration being edited underneath
it — give one its own database with `TEST_DB_NAME=shikkha_test_2 pnpm test`.
