# ShikkhaOS

An AI-native, multi-tenant School Operating System for Bangladesh.

Not a collection of modules — one institutional data model that attendance, results, fees,
communication and analytics all read from and write to. A student is one row; every module
references it.

---

## Status

Phase 1 (platform foundation) is complete and audited. Phases 2–4 (academic structure, student
records, guardians) are partially implemented and working end to end. Phases 5–36 are designed,
not built.

`docs/12_DEVELOPMENT_STATUS.md` is the source of truth and is written to be pessimistic. If
something is not marked COMPLETE there, treat it as not working.

**310 tests passing** · 0 TypeScript errors · 0 lint errors · both applications build.

---

## Quick start

Requires Node 20+, pnpm 10+, and Docker.

```bash
pnpm install
cp .env.example .env

pnpm infra:up                 # PostgreSQL 17 + pgvector, Redis 7, MinIO, Mailpit
pnpm db:migrate               # apply migrations
pnpm db:seed -- --fresh       # 960 students, 837 guardians, 24 sections

pnpm build                    # required once: the API needs the workspace packages compiled
pnpm dev                      # API on :4000, web on :3000
```

Open <http://localhost:3000>. Demo accounts are listed on the sign-in page; the password for all
of them is `ShikkhaDemo2026!`.

Sign in as several to see the same endpoints return different data:

| Account                       | Sees                                              |
| ----------------------------- | ------------------------------------------------- |
| `principal@dhakafuture.test`  | All 960 students, the audit log, every section    |
| `teacher1@dhakafuture.test`   | 40 students — only their own section              |
| `accountant@dhakafuture.test` | All students, no marks, no academic configuration |
| `parent1@dhakafuture.test`    | Their own children, nothing else                  |

That difference is not four dashboards. It is one endpoint, one permission model, and a data
scope resolved per request.

API documentation: <http://localhost:4000/api/v1/docs>

---

## Layout

```
apps/
  api/            NestJS — the only process with database credentials
  web/            Next.js 15 App Router
packages/
  shared/         Money, dates/timezone, errors, ids, encoding. Isomorphic, no I/O
  permissions/    Permission catalogue, role presets, evaluation. Pure
  validation/     Zod schemas used by both the API and the web forms
  db/             Drizzle schema, SQL migrations, seed
docs/             Architecture, decisions, security model, status
infra/            Docker compose for development
scripts/          Generators and maintenance scripts
```

`shared` depends on nothing. `permissions` and `validation` depend only on `shared`. `db` depends
on `shared`. `api` may depend on all of them; `web` may never depend on `db`.

---

## Commands

|                                |                                                                  |
| ------------------------------ | ---------------------------------------------------------------- |
| `pnpm dev`                     | API and web in watch mode                                        |
| `pnpm build`                   | Build everything                                                 |
| `pnpm typecheck`               | TypeScript across all packages                                   |
| `pnpm test`                    | All test projects                                                |
| `pnpm test:security`           | Tenant isolation and RBAC — release-blocking                     |
| `pnpm db:migrate`              | Apply pending migrations                                         |
| `pnpm db:seed`                 | Seed the demo tenant (`--scale=medium\|large\|group`, `--fresh`) |
| `pnpm db:reset`                | Drop and rebuild from migrations. Refuses non-local databases    |
| `pnpm docs:rbac`               | Regenerate the permission matrix from code                       |
| `pnpm infra:up` / `infra:down` | Development containers                                           |

---

## The parts worth reading first

**`packages/shared/src/money.ts`** — exact currency arithmetic over `bigint` poisa, with
largest-remainder `allocate()` so an installment plan always sums back to the invoice. Fees,
payroll and double-entry accounting all depend on this being right.

**`packages/permissions/src/principal.ts`** — the authorization evaluator, and the distinction it
maintains between "may they do this kind of thing" (the guard) and "to which rows" (the
repository). Conflating those two is how permission-checked endpoints leak everything.

**`packages/db/migrations/0002_roles_and_rls.sql`** — database roles, row-level security, the
append-only audit log, and assertions that fail the migration if any of it is silently disabled.

**`apps/api/src/common/route-audit.ts`** — the boot-time check that refuses to start the server
if a route declares no access requirement.

**`apps/api/test/security/tenant-isolation.spec.ts`** — two tenants, and every realistic attempt
by one to reach the other's data, at both the API and the database layer.

---

## Design decisions

Recorded with rationale in `docs/13_DECISION_LOG.md`. The load-bearing ones:

- **Drizzle over Prisma** — row-level security needs `SET LOCAL` on a plain connection, and
  finance migrations need to be readable SQL.
- **NestJS over Next.js route handlers** — every request needs authentication, tenant resolution,
  authorization and audit in that order; a guard chain applies it once, and a new controller is
  secure by default.
- **Money as integer poisa** — `numeric(14,2)` in Postgres, `bigint` in code, no float anywhere.
- **Permissions, not roles** — 203 permission strings; roles are editable data.
- **Soft archive, never delete** — report cards and ledgers are legal records.
- **UTC storage, Asia/Dhaka presentation** — with `date` and `timestamptz` kept distinct, because
  an attendance date is a calendar fact and not an instant.

---

## Bangladesh-specific handling

Not localisation applied afterwards — modelled in:

- Bangla and English names as **separate official fields**, since neither is a translation of
  the other and each appears on different documents.
- Mobile numbers normalised to E.164 across every form a parent might write one in, including
  Bengali numerals. This is the guardian deduplication key.
- Birth registration numbers as the primary child identifier, since most students have no NID.
- Morning and day shifts, near-universal in schools at capacity.
- Friday–Saturday weekends as a _configurable default_, not an assumption.
- Fourth-subject and GPA-exclusion flags on subjects, because they change GPA arithmetic.
- Lakh/crore number grouping in the interface.

---

## Contributing

1. `pnpm test` and `pnpm typecheck` must pass.
2. A new table needs `tenant_id` and a row-level security policy, or migration `0003`'s assertion
   fails.
3. A new route needs `@Public()`, `@Authenticated()` or `@RequirePermissions(...)`, or the server
   refuses to boot.
4. A new mutating route should carry `@Audited(...)`; the boot log lists any that do not.
5. Changing a role or a permission means running `pnpm docs:rbac`.
6. Money never touches a `number`.
