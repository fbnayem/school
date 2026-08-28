# 13 — Decision Log

Architecture Decision Records. Newest last. Every entry records context, decision,
rationale, and consequences.

---

## ADR-001 — Monorepo with pnpm workspaces + Turborepo

**Context.** Web app, API, a future Python AI service, and a large body of shared domain
logic (permissions, validation schemas, money/date primitives) that must not drift between
client and server.

**Decision.** Single repository, pnpm workspaces for linking, Turborepo for task
orchestration and caching.

**Rationale.** Shared Zod schemas used by both React Hook Form and the API server are the
single highest-leverage duplication killer in this system; a monorepo makes them a normal
import. pnpm's isolated `node_modules` prevents phantom dependencies. Turbo gives
build/lint/typecheck/test a dependency graph so CI does not rebuild the world.

**Consequences.** Contributors must use pnpm. Cross-package type changes require build
ordering, encoded in `turbo.json`.

---

## ADR-002 — NestJS for the API, not Next.js route handlers

**Context.** The brief permits a Next.js full-stack architecture "if materially simpler in
the earliest phase".

**Decision.** A dedicated NestJS application at `apps/api`, with `apps/web` (Next.js) as a
consumer over HTTP.

**Rationale.** Authorization in this product is not incidental — every request needs
authentication, tenant resolution, permission evaluation, and audit capture, in that order,
uniformly. Nest's guard/interceptor pipeline expresses that as composable cross-cutting
concerns applied globally, so a new controller is secure by default and must explicitly opt
out. Next.js route handlers make each handler responsible for remembering the chain, which
is precisely the failure mode that produces IDOR and tenant leakage. The brief also requires
Flutter mobile apps against the same API; a separate HTTP surface with OpenAPI is the honest
shape for that. The extra boilerplate is a real cost, accepted.

**Consequences.** Two deployables. Web must forward auth cookies to the API. Not
"materially simpler" in week one; materially safer by Phase 3.

---

## ADR-003 — Drizzle ORM over Prisma

**Context.** The brief requires choosing one and documenting why.

**Decision.** Drizzle ORM with drizzle-kit SQL migrations.

**Rationale.**

1. **Row-Level Security.** Tenant isolation is defence-in-depth: application guard plus
   Postgres RLS. Drizzle runs on a plain `pg` connection where `SET LOCAL app.tenant_id`
   inside a transaction works naturally. Prisma's query engine pools connections in a way
   that makes per-transaction session variables awkward.
2. **Postgres-native features.** `numeric` money, partial and expression indexes,
   `tsvector` full-text search, and `pgvector` for Phase 29 RAG are all first-class in
   Drizzle's schema DSL and plain-SQL migrations. Several need escape hatches in Prisma.
3. **Migrations are readable SQL.** Finance and academic-records migrations must be
   reviewable by a human before they touch a school's ledger.
4. **No separate engine binary**, which matters for the Windows dev host and slim
   containers.

**Trade-off accepted.** Drizzle's relational query builder is less ergonomic than Prisma's
`include` for deep graphs, and nested writes must be written as explicit transactions —
arguably correct for an accounting system anyway.

**Consequences.** All schema lives in `packages/db/src/schema`. No schema change outside a
generated migration.

---

## ADR-004 — Money as integer poisa in code, `numeric(14,2)` in the database

**Context.** Fees, payments, refunds, payroll, and double-entry accounting. Floating point
is disqualifying.

**Decision.** Database: `numeric(14,2)`. Application code: a `Money` value object wrapping a
`bigint` count of **poisa** (1 BDT = 100 poisa), with an explicit `allocate()` for splitting
amounts without losing or inventing units.

**Rationale.** `numeric` is exact in Postgres and sums correctly in SQL aggregates.
JavaScript `number` is not safe for currency, so the boundary converts to `bigint`
immediately on read. Proportional splits (installments, discounts across line items) must use
largest-remainder allocation or the ledger will not balance.

**Consequences.** No arithmetic on money outside `@shikkha/shared`'s `Money`. Drizzle returns
`numeric` as `string`, which is the correct lossless carrier; parsing happens in one place.

---

## ADR-005 — Permission strings are the authorization primitive; roles are data

**Context.** The brief lists 24 roles and warns against hard-coding access around role names.

**Decision.** A frozen catalogue of `resource.action` permission strings in
`@shikkha/permissions`. Roles are rows in `roles` carrying a permission array. System roles
are seeded presets; tenants may create custom roles. Guards check permissions only. The single
exception is the platform super-admin flag, which is a boolean column on the user, not a role
name.

**Rationale.** Role proliferation is guaranteed in this market — a "Head Teacher" in one
school is an "Academic Coordinator" in another. Checking `students.view` is stable across that;
checking `role === 'HEAD_TEACHER'` is not.

**Consequences.** Permission catalogue changes require re-seeding system roles. The catalogue
is exhaustively typed, so a typo is a compile error rather than a silent deny.

---

## ADR-006 — Zod as the single validation library

**Decision.** Zod on both sides: React Hook Form resolvers in `apps/web`, and a global
validation pipe in `apps/api`. Schemas live in `@shikkha/validation` and are imported by both.

**Rationale.** "Never trust frontend data" plus "use shared schemas when possible" is only
achievable if both sides speak the same schema language. Zod v3 rather than v4, for ecosystem
compatibility with `drizzle-zod` at time of writing.

**Consequences.** Database constraints still restate the important invariants — shared schemas
are a convenience layer, never the last line of defence.

---

## ADR-007 — Argon2id passwords; opaque, rotating refresh tokens

**Decision.** `argon2id` at the OWASP baseline (19 MiB memory, 2 iterations, parallelism 1).
Access tokens are short-lived JWTs (15 minutes). Refresh tokens are opaque 256-bit random
values, stored **hashed** in `sessions`, rotated on every use, with reuse detection that
revokes the entire session family.

**Rationale.** Argon2id is the current OWASP first choice. JWT refresh tokens cannot be
revoked; school staff get terminated and devices get lost, so "log out everywhere" must
actually work. Storing only the hash means a database read does not yield usable tokens.

**Consequences.** Refresh costs a database round trip every 15 minutes — acceptable. The
session table needs an index on the token hash and periodic cleanup of expired rows.

---

## ADR-008 — Soft archive, never hard delete, for institutional records

**Decision.** Business tables carry `archived_at` and `archived_by`. Academic and financial
records are never deleted through the API. Uniqueness is enforced with partial indexes
(`WHERE archived_at IS NULL`) so an archived roll number can be reissued.

**Rationale.** Report cards, transcripts and ledgers are legal records. "Never normal-delete
institutional academic records" is a hard requirement.

**Consequences.** Every list query must exclude archived rows; this is centralised rather than
repeated per module.

---

## ADR-009 — UTC in the database, Asia/Dhaka at the presentation boundary

**Decision.** Instants stored as `timestamptz` in UTC. Genuinely date-only values (date of
birth, attendance date, holiday) stored as `date`. Presentation converts at one boundary using
`Asia/Dhaka` (UTC+6, no DST).

**Rationale.** An attendance record for 2026-03-15 is a school-calendar fact, not an instant;
storing it as a timestamp creates off-by-one-day bugs at midnight boundaries. Bangladesh has no
DST, which removes the hardest class of these bugs but not the date/instant confusion.

**Consequences.** `@shikkha/shared` exposes the only sanctioned conversion helpers.

---

## ADR-010 — Local filesystem storage adapter behind an S3-shaped interface

**Decision.** A `StorageProvider` interface (`put`, `get`, `delete`, `signedUrl`, `stat`) with a
`LocalStorageProvider` for development and an `S3StorageProvider` for production, selected by
`STORAGE_DRIVER`.

**Rationale.** A missing S3 credential must not stop development. The local adapter signs URLs
with an HMAC and a short expiry so the authorization semantics are exercised in development,
not just the happy path.

**Consequences.** The local adapter is explicitly not production-grade and refuses to load when
`NODE_ENV=production`.

---

## ADR-011 — Tenant isolation enforced at three layers

**Decision.** (1) A request-scoped tenant context resolved from the authenticated session, never
from a client-supplied header or body field. (2) A repository layer that injects `tenant_id`
into every query and every insert. (3) Postgres Row-Level Security policies on tenant-scoped
tables, with the application connecting as a non-superuser role that RLS actually applies to.

**Rationale.** The brief calls tenant leakage release-blocking. A single layer fails to one
forgotten `where` clause. RLS turns that class of bug from a data breach into an empty result
set.

**Consequences.** The application database role must not be the table owner and must not have
`BYPASSRLS`. Migrations run as a separate owner role. This is set up in the first migration so it
is never retrofitted.
