# 10 — Test Strategy

Tests are written alongside the code, not after it. The suites below were each written _with_
the feature they cover, and four of them found real defects during development — those are
recorded in `docs/14_KNOWN_ISSUES.md` under "Resolved", with the test that now prevents each
from returning.

---

## 1. Layers

| Layer       | Where                       | Needs      | Speed | Runs on                      |
| ----------- | --------------------------- | ---------- | ----- | ---------------------------- |
| Unit        | `packages/*/test`           | Nothing    | ~1s   | Every commit                 |
| Integration | `apps/api/test/integration` | PostgreSQL | ~5s   | Every commit                 |
| Security    | `apps/api/test/security`    | PostgreSQL | ~5s   | Every commit; blocks release |
| End-to-end  | Not yet built               | Full stack | —     | See KI-005                   |

```bash
pnpm test              # everything
pnpm test:unit         # no infrastructure needed
pnpm test:integration
pnpm test:security     # tenant isolation + RBAC
```

---

## 2. What each layer is for

### Unit — `packages/shared`, `packages/permissions`

Pure logic with no I/O, where exhaustiveness is cheap.

**`money.spec.ts`** (27) — the invariant that matters is that a split always sums back to the
whole. Tested for every installment count from 1 to 24, for negative amounts (refunds and credit
notes), for zero-weight buckets, and for determinism. A float implementation fails the
repeated-addition test immediately.

**`time.spec.ts`** (19) — `2026-02-30` must be rejected rather than silently rolling into March;
a Dhaka day starts at 18:00 UTC the previous day; adding a month to 31 January clamps to
28 February rather than spilling into March and billing twice.

**`bd.spec.ts`** (12) — every shape a parent writes a phone number in, including Bengali
numerals, normalises to one E.164 value. This is the guardian deduplication key, so a miss here
creates duplicate families.

**`bytes.spec.ts`** (16) — `randomInt` is checked for _distribution_, not just range: a modulo
implementation over 29 values skews measurably, and the test catches it.

**`principal.spec.ts` / `rbac-matrix.spec.ts`** (69) — the evaluator, and every role preset
asserted against the "who must NOT be able to do what" list from the brief. These assert against
the _shipped presets_, so widening a role by accident fails a test rather than silently granting
a teacher the ability to publish results.

### Integration — `apps/api/test/integration`

The real application, real guards, real database. Nothing stubbed, because the properties under
test live precisely in the parts a stub would replace.

**`auth.spec.ts`** (24) — rotation, reuse detection, lockout, revocation timing, enumeration
resistance, and that only a hash of a refresh token is ever stored.

### Security — `apps/api/test/security`

Release-blocking. A failure here is not a bug; it is a data breach.

**`tenant-isolation.spec.ts`** (23) — two structurally identical tenants; tenant B's fully
authenticated administrator then attempts every realistic route to tenant A's data: by id, by
list, by search, by forged institution header, by write. Then the same attempts are repeated
**directly against the database as the unprivileged application role**, which is what an attacker
with SQL execution inside the API would actually have.

**`rbac-enforcement.spec.ts`** (26) — that the HTTP surface consults the permission model. The
unit tests prove the model is right; these prove a controller did not forget its decorator, which
no unit test can see.

---

## 3. Principles

**Test the property, not the implementation.** `money.spec.ts` asserts that parts sum to the
whole for every split size, rather than asserting specific outputs of the allocation algorithm.
The algorithm can change; the invariant cannot.

**A security test attacks; it does not describe.** "Tenant B cannot read tenant A's student"
performs the read as tenant B and asserts on the response — it does not inspect a filter.

**Every fixed defect gets a test first.** Each entry under "Resolved" in the known-issues file
names the test that would fail if it returned.

**Tests use the real database.** The suites run against `shikkha_test`, migrated by the same
migrations as production. A mocked repository cannot verify a row-level security policy, and RLS
is the layer that matters most.

**Failures must be legible.** Assertions carry context (`expect(status, \`${role} reached the
audit log\`)`) so a CI failure names the role rather than reporting `expected 200 to be 403`.

---

## 4. Fixtures

`test/helpers/test-app.ts` provides:

- `createTestApp()` — the real `AppModule` against the test database.
- `truncateAll()` — runs as the migrator, which owns the tables and bypasses RLS. Exactly what a
  per-suite reset needs, and exactly what the application role must never be able to do.
- `seedTenant(prefix)` — a complete tenant: institution, campus, academic year, class, section,
  all 22 roles, five staff users with employee records, students with enrolments, guardians with
  portal links. Everything is parameterised by `prefix` so two tenants never collide on a unique
  constraint — if they did, the isolation test would fail for the wrong reason.

Argon2 cost is reduced in tests. The suites test authentication _logic_; the KDF parameters are
asserted separately, and 50 real hashes would add several seconds per run.

---

## 5. Why Vitest needs SWC here

NestJS depends on `emitDecoratorMetadata` for constructor injection, and esbuild — Vitest's
default transform — does not implement it. Without `unplugin-swc`, every guard resolves its
dependencies as `undefined` and the suite fails with "Cannot read properties of undefined", which
reads as a dependency-injection bug rather than a build configuration one. This cost real time
during development and is documented in `apps/api/vitest.config.ts` so it costs nobody else any.

Integration and security projects run single-threaded: they share one database, and parallel
truncation is a race that produces confusing intermittent failures.

---

## 6. Not yet covered

- **Browser end-to-end** (KI-005). Client routing, form wiring and the refresh-retry path are
  verified manually against the running stack, not automatically.
- **Load and performance.** The seeder supports 500 / 2,500 / 10,000 / 50,000-student scales, and
  the queries were written with `EXPLAIN` in mind — correlated subqueries rather than N+1, partial
  indexes on the hot paths — but there is no benchmark asserting a latency budget.
- **Migration rollback.** Migrations are forward-only and verified from an empty database. There
  is no test that applies migrations to a populated database from a previous release.
- **Concurrency.** Optimistic locking is implemented and unit-reachable, but there is no test that
  runs two conflicting updates simultaneously.
