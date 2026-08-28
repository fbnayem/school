# 01 — Architecture

## 1. Topology

```
                     ┌──────────────────────┐
  Browser  ────────► │  apps/web            │
  (Next.js UI)       │  Next.js App Router  │
                     │  server components   │
                     └──────────┬───────────┘
                                │ HTTP, httpOnly cookie
                                ▼
  Flutter  ─────────► ┌──────────────────────┐        ┌─────────────┐
  (future)   Bearer   │  apps/api            │ ─────► │  Redis      │
                      │  NestJS  /api/v1     │        │  cache+jobs │
                      │                      │        └─────────────┘
                      │  Guard chain:        │
                      │   Auth → Tenant      │        ┌─────────────┐
                      │   → Permission       │ ─────► │  PostgreSQL │
                      │   → Audit intercept  │        │  + pgvector │
                      └──────────┬───────────┘        └─────────────┘
                                 │ HTTP (internal)
                                 ▼
                      ┌──────────────────────┐
                      │  apps/ai  (Phase 27) │
                      │  FastAPI             │
                      │  no direct DB access │
                      └──────────────────────┘
```

`apps/ai` is deliberately given **no database credentials**. It reaches institutional data
only by calling back into `apps/api` with the caller's delegated authorization. This is the
structural reason the AI cannot bypass permissions — it is not a policy, it is a missing
connection string.

## 2. Package layout

```
apps/
  api/            NestJS HTTP API — the only process that talks to Postgres
  web/            Next.js UI
  ai/             FastAPI AI gateway (Phase 27+)
packages/
  shared/         Money, dates/timezone, errors, ids, result types. No I/O.
  permissions/    Permission catalogue, system role presets, evaluation. Pure.
  validation/     Zod schemas shared by API and web
  db/             Drizzle schema, migrations, seed, connection factory
  ui/             React design system (Phase 1 web)
docs/
infra/            docker-compose, container definitions
scripts/
```

**Dependency rule.** `shared` depends on nothing. `permissions` and `validation` depend only
on `shared`. `db` depends on `shared`. `api` may depend on all of them. `web` may depend on
`shared`, `permissions`, `validation`, `ui` — never on `db`. There are no cycles, and this is
enforced by the build graph rather than by convention.

## 3. Request lifecycle in the API

Every request passes the same chain. Ordering matters and is fixed globally:

1. **Helmet / CORS / rate limit** — before anything expensive.
2. **Correlation ID** — a request id is generated or taken from `x-request-id`, attached to
   the async-local context, and returned on every response including errors.
3. **`JwtAuthGuard`** — validates the access token, loads the user. Routes opt out with
   `@Public()`, which is the only way to be unauthenticated.
4. **`TenantGuard`** — resolves `tenant_id` **from the authenticated principal**, never from
   a header, query parameter or body field. A client cannot name its own tenant.
5. **`PermissionsGuard`** — reads `@RequirePermissions('students.view')` metadata and
   evaluates it against the principal's effective permission set. A route with no permission
   metadata and no `@Public()` is refused at boot by a startup assertion, so "forgot to add a
   guard" is a build failure rather than a hole.
6. **`ZodValidationPipe`** — body, query and params validated against shared schemas.
7. **Controller → Service → Repository.**
8. **`AuditInterceptor`** — records the action, actor, tenant, resource, before/after values
   and request metadata for routes marked `@Audited(...)`.
9. **`AllExceptionsFilter`** — maps domain errors to a stable envelope; never leaks stack
   traces.

## 4. Tenant isolation — three layers

| Layer      | Mechanism                                                                              | Catches                                  |
| ---------- | -------------------------------------------------------------------------------------- | ---------------------------------------- |
| Context    | `TenantGuard` derives tenant from the session only                                     | Client-supplied tenant spoofing          |
| Repository | `TenantScopedRepository` injects `tenant_id` into every `where` and every `insert`     | A forgotten filter in a service          |
| Database   | Postgres RLS policies keyed on `current_setting('app.tenant_id')`, set per transaction | A raw query that bypassed the repository |

The application connects as `shikkha_app`, a role that is **not** the table owner and does
**not** have `BYPASSRLS`. Migrations run as `shikkha_migrator`. If the application role were the
owner, RLS would silently not apply — that is the classic way this defence fails, so the roles
are separated in the very first migration.

## 5. The shared institutional model

One table per real-world entity. The rule that keeps this true:

> If you are about to add a column named `student_name` to a non-student table, stop. Store
> `student_id` and join.

Denormalised snapshots are permitted in exactly one situation: **immutable financial and
academic documents**. An issued invoice line stores the fee name and amount _as they were at
issue_, because reprinting last year's receipt must not reflect this year's fee revision. These
are recorded as historical facts, not as caches, and they are never written back to.

## 6. Events

Modules communicate across domain boundaries through a typed event bus rather than direct
service imports where the coupling would be inappropriate.

```
AttendanceMarked  → notification (guardian SMS)
                  → analytics (attendance percentage recompute)
                  → automation (3-consecutive-absence rule)

PaymentSucceeded  → ledger posting (Dr Cash / Cr Student Receivable)
                  → invoice settlement
                  → receipt generation
                  → notification
```

In-process `EventEmitter2` initially, with handlers written to be idempotent and to enqueue
durable work into BullMQ rather than doing it inline. That constraint is what makes the later
move to a real broker a configuration change instead of a rewrite.

## 7. Money and numbers

`numeric(14,2)` in Postgres; a `Money` value object over `bigint` poisa in code. Drizzle
returns `numeric` as a string, which is the correct lossless carrier — parsing happens only in
`Money.fromDecimalString`. See ADR-004.

## 8. Time

`timestamptz` for instants, `date` for calendar dates, UTC storage, `Asia/Dhaka` presentation.
See ADR-009.

## 9. What is deliberately not here yet

- No microservices. One API process, cleanly moduled. Premature decomposition would multiply
  the tenant-isolation surface before it is proven.
- No OpenSearch. Postgres full-text search until it demonstrably stops being enough.
- No separate read models or CQRS. Indexed queries and pagination first.
- No Kubernetes. Compose for development; the deployment target is documented in
  `docs/11_DEPLOYMENT.md`.

Each of these is a scaling decision that should be made against a measurement, not a guess.
