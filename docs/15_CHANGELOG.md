# 15 — Changelog

Chronological record of what was built and, where a defect was found, what it was and what now
prevents it returning.

---

## 0.1.0 — 2026-08-29 · Platform foundation

### Added

**Monorepo** — pnpm workspaces, Turborepo, TypeScript strict, Prettier, ESLint 9 flat config.
Five packages, two applications.

**`@shikkha/shared`** — `Money` (exact currency over `bigint` poisa, largest-remainder
`allocate`), calendar/instant time handling for Asia/Dhaka, domain error taxonomy, UUIDv7,
pagination, Bangladesh primitives (mobile normalisation, NID and birth registration validation,
Bengali numerals), isomorphic byte and encoding helpers. 86 tests.

**`@shikkha/permissions`** — 203-permission catalogue, 22 system role presets, wildcard
evaluation with segment-boundary matching, institution and campus scoping, `resolveDataScope`
for row-level scoping. 69 tests including the full "who must NOT be able to do what" matrix.

**`@shikkha/validation`** — Zod schemas shared by the API's validation pipe and the web app's
form resolvers. 35 tests.

**`@shikkha/db`** — Drizzle schema (38 tables), five SQL migrations, a hand-rolled migration
runner with checksums and advisory locking, and a seeded demo tenant at four scales. 15
conformance tests that introspect the schema and fail a table that skips a convention.

**`apps/api`** — NestJS. Argon2id passwords; JWT access tokens with an exact millisecond
credentials-version claim; opaque rotating refresh tokens with reuse detection; account lockout;
three-layer tenant isolation; permission guards; append-only audit log; security event log;
boot-time route audit; storage abstraction; health probes. 105 tests.

**`apps/web`** — Next.js 15 App Router. Sign-in, role-derived dashboard, student roll with
server-side search and pagination, student detail, parent portal, academic structure, audit log.
Responsive with a card layout below `sm`; dark-mode tokens; skip link and focus-visible rings.

**Infrastructure** — Docker Compose (PostgreSQL 17 + pgvector, Redis 7, MinIO, Mailpit), GitHub
Actions CI with static, database, build and dependency-audit jobs.

**Documentation** — architecture, decision log (11 ADRs), database model, API design, security
model, test strategy, deployment, development status, known issues, and a permission matrix
generated from code so it cannot go stale.

### Fixed during development

Each was found by a test or a generated artefact, and each now has a test that fails if it
returns. Full detail in `docs/14_KNOWN_ISSUES.md`.

- **`organizations` was not covered by row-level security.** RLS was enabled by scanning for
  tables with a `tenant_id` column; `organizations` _is_ the tenant and has none, so it was
  skipped — leaving every tenant's organization row readable by any authenticated session.
  Migration 0003 adds the policy and, more importantly, an assertion that fails the migration if
  any table is neither protected nor explicitly exempted.

- **Guardian endpoints did not apply the student data scope.** A class teacher could read the
  guardians of a student in another section. Fixed by defining guardian visibility in terms of
  student visibility in exactly one place.

- **The strict auth rate limit applied to every route.** Every named throttler applies to every
  route, so the 10-per-minute login limit was imposed on the whole API. The documented
  `AUTH_RATE_LIMIT_MAX_ATTEMPTS` variable also had no effect, because the value was hardcoded in
  a decorator.

- **Framework exceptions were reported as 500.** Guard 403s fell through to the generic internal
  error branch, making authorization failures indistinguishable from crashes in both the
  response and the logs.

- **Institution-scoped grants blocked unscoped requests.** `/auth/me`, `logout` and every
  cross-institution list failed for any user whose roles were institution-scoped — which is
  nearly all of them.

- **Revoked access tokens survived for up to one second.** The revocation check compared against
  the second-resolution `iat` claim with a further second of tolerance.

- **`@shikkha/shared` could not be bundled for the browser.** It imported `node:crypto` and used
  `Buffer`. Rewritten against the Web Crypto API rather than split into subpath exports.

- **`inventory_manager` could approve its own purchase requisitions**, and `accounts_manager`
  both sides of every finance pair, via permission wildcards. Found by the generated permission
  matrix, which made the overlap visible in a way the role definitions did not.

- **`rooms` could not store a Bangla name.** Found by the schema conformance test.

- **The append-only audit trigger blocked the owner too**, contradicting the documented archival
  path. Found by `db:seed --fresh`.

- **ESLint's `consistent-type-imports` autofix broke dependency injection.** NestJS reads
  constructor parameter types at runtime; a type-only import erases them. The rule is now off
  for the API, because a single `--fix` run would otherwise reintroduce it everywhere.

### Known limitations

Nine open issues, none critical, all in `docs/14_KNOWN_ISSUES.md`. The ones that would matter
first in production: rate limiting is per instance, the S3 adapter is an interface rather than an
implementation, and there is no browser end-to-end suite.
