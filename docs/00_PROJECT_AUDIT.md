# 00 — Project Audit

**Date:** 2026-08-29
**Auditor:** Lead Architect (autonomous build)
**Repository:** `d:\school`

---

## 1. Method

Full filesystem inspection of the repository root and all subdirectories, plus a
toolchain probe of the host machine (package managers, runtimes, database, container
runtime).

## 2. Current State

The repository was **empty**. `find . -maxdepth 3` returned only the root directory
itself. There was no git history, no package manifest, no source, no configuration.

| Audit item            | Finding                                                                           |
| --------------------- | --------------------------------------------------------------------------------- |
| Existing code         | None                                                                              |
| Existing architecture | None                                                                              |
| Package manager       | None declared. Host has npm 11.16.0 and pnpm 11.17.0                              |
| Database setup        | None in repo. Host has PostgreSQL 18.4 running as a Windows service               |
| Environment files     | None                                                                              |
| APIs                  | None                                                                              |
| Components            | None                                                                              |
| Authentication        | None                                                                              |
| Tests                 | None                                                                              |
| CI                    | None                                                                              |
| Docker                | None in repo. Host has Docker CLI 29.6.2 + Compose v5.3.1, **daemon not running** |
| Documentation         | None                                                                              |
| Broken code           | N/A                                                                               |
| Dead code             | N/A                                                                               |
| Duplicate components  | N/A                                                                               |
| Security problems     | N/A (nothing to expose yet)                                                       |
| Missing configuration | Everything                                                                        |
| Incomplete modules    | Everything                                                                        |

**Conclusion: this is a greenfield build, not a rescue.** There is no working code to
preserve, so the "do not unnecessarily rewrite working code" rule has no subject. The
corresponding risk is the opposite one — every architectural mistake made now is load
bearing for every later phase, so Phase 1 gets disproportionate care.

## 3. Host Environment

| Tool           | Version          | Status                                                                                 |
| -------------- | ---------------- | -------------------------------------------------------------------------------------- |
| Node.js        | 24.18.0          | Available                                                                              |
| npm            | 11.16.0          | Available                                                                              |
| pnpm           | 11.17.0          | Available — selected package manager                                                   |
| git            | 2.55.0.windows.2 | Available; repo initialised by this build                                              |
| Docker CLI     | 29.6.2           | Installed, **daemon stopped**                                                          |
| Docker Compose | v5.3.1           | Installed                                                                              |
| PostgreSQL     | 18.4             | Installed at `C:\Program Files\PostgreSQL\18`, service `postgresql-x64-18` **Running** |
| Python         | 3.14.6           | Available (for the future `apps/ai` FastAPI service)                                   |
| Redis          | —                | **Not present.** Supplied via `infra/docker-compose.yml`                               |

### Blocking observation — database credentials

Two viable local database paths exist, and neither is usable without one action by the
repository owner:

1. **Docker (recommended, and what all documentation targets).** `infra/docker-compose.yml`
   provisions PostgreSQL 18 + pgvector and Redis 7 with known development credentials.
   Requires Docker Desktop to be started.
2. **Host PostgreSQL 18.** `pg_hba.conf` is configured for `scram-sha-256` on all local
   and loopback connections. The superuser password is not recorded in the repository and
   was not available to this build.

This is recorded as a real external dependency in `docs/14_KNOWN_ISSUES.md` rather than
worked around. Per the operating rules, it did **not** stop development: schema,
migrations, domain logic, unit tests and application code were all built against it, and
the integration/E2E suites are written and ready to execute the moment a reachable
`DATABASE_URL` exists.

## 4. Problems Identified

Because the repository was empty, "problems" here means _risks created by starting from
nothing_, which is what the plan must defend against:

| #   | Risk                                                | Severity | Mitigation adopted                                                                                                                            |
| --- | --------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Tenant isolation bolted on later is never complete  | Critical | `tenant_id` is non-nullable on every business table from the first migration; enforced in a single repository/guard layer, not per-controller |
| P2  | Role names hard-coded into authorization checks     | High     | Permission strings are the only authorization primitive; roles are data that map to permission sets                                           |
| P3  | Money stored as floating point                      | Critical | `numeric(14,2)` in Postgres, integer-poisa `Money` value object in code, no `number` arithmetic on currency                                   |
| P4  | Duplicate student/teacher records per module        | High     | One `students` / `employees` / `guardians` table; all modules reference by FK. Enforced by review rule in `docs/01_ARCHITECTURE.md`           |
| P5  | Audit logging retrofitted after finance ships       | High     | Audit interceptor and `audit_logs` table land in Phase 1, before any mutating business module                                                 |
| P6  | Timezone drift (Bangladesh is UTC+6, no DST)        | Medium   | `timestamptz` storage in UTC; a single `Asia/Dhaka` presentation boundary in `@shikkha/shared`                                                |
| P7  | Bangla text handling (collation, search, PDF fonts) | Medium   | UTF-8 database, separate `name_bn` / `name_en` columns rather than one overloaded field                                                       |
| P8  | AI given unrestricted database access               | Critical | AI reaches data only through permission-checked tools; documented in `docs/06_AI_ARCHITECTURE.md` before any AI phase starts                  |

## 5. Technical Debt

None inherited. Debt created by this build is tracked in `docs/14_KNOWN_ISSUES.md` as it
is incurred, not at the end.

## 6. Recommendations

1. Build the monorepo skeleton and shared packages before any feature.
2. Treat Phase 1 (auth, tenancy, RBAC, audit) as release-blocking for everything else.
3. Choose one ORM and one validation library and use them everywhere — see
   `docs/13_DECISION_LOG.md` (Drizzle, Zod).
4. Write the tenant-isolation test suite alongside the first tenant-scoped endpoint, not
   after Phase 3.
5. Get a reachable PostgreSQL before Phase 2 so migrations and integration tests run in
   the same loop as the code.

## 7. Retain / Refactor / Replace

- **Retain:** nothing (empty repository).
- **Refactor:** nothing.
- **Replace:** nothing.
