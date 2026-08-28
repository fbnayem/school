# 11 — Deployment

Two deployables: `apps/api` (NestJS) and `apps/web` (Next.js). One PostgreSQL, one Redis, one
S3-compatible bucket.

---

## 1. Database roles

This is the part to get right, because getting it wrong silently disables tenant isolation
rather than producing an error.

| Role               | Login | Owns tables | `BYPASSRLS`                | Used by                           |
| ------------------ | ----- | ----------- | -------------------------- | --------------------------------- |
| `shikkha_migrator` | Yes   | **Yes**     | Yes (implicitly, as owner) | Migrations, seeder, retention job |
| `shikkha_app`      | Yes   | **No**      | **No**                     | The API. Nothing else             |
| `shikkha_readonly` | Yes   | No          | No                         | Analytics, read replicas          |

The API must connect as `shikkha_app`. Row-level security does not apply to a table's owner
unless forced, and a role with `BYPASSRLS` ignores every policy — either mistake makes every
tenant visible to every other.

Migration `0002` asserts both and fails if either is wrong, and the environment schema refuses
to start when `DATABASE_URL` contains `shikkha_migrator`. Both checks exist because this is the
single highest-consequence configuration mistake available.

```sql
create role shikkha_app       with login password '<strong>' nobypassrls;
create role shikkha_readonly  with login password '<strong>' nobypassrls;
grant connect on database shikkha to shikkha_app, shikkha_readonly;
```

---

## 2. Environment

Start from `.env.example`. The API **refuses to start** in production with any of:

| Setting                | Requirement                                                         |
| ---------------------- | ------------------------------------------------------------------- |
| `JWT_SECRET`           | ≥ 48 characters, not a known placeholder. `openssl rand -base64 48` |
| `COOKIE_SECURE`        | `true`                                                              |
| `CORS_ORIGINS`         | Explicit origins. No wildcard, no localhost                         |
| `STORAGE_DRIVER`       | `s3`. The local adapter is not durable                              |
| `DATABASE_URL`         | Must not name the migrator role                                     |
| `DATABASE_LOG_QUERIES` | `false`. Query logs contain student data                            |
| `ENABLE_DEMO_HINTS`    | `false`                                                             |

Shipping with a development JWT secret is a complete authentication bypass. A process that
refuses to run is the only reliable defence against a configuration mistake.

### Sizing

| Setting                         | Guidance                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `DATABASE_POOL_MAX`             | `min(20, max_connections / replicas - headroom)`. Default 10                                              |
| `DATABASE_STATEMENT_TIMEOUT_MS` | 30 s. A runaway query holds a connection and a row lock                                                   |
| `ARGON2_MEMORY_KIB`             | 19456 minimum. Raise on a server with RAM headroom — this is the main cost of an offline cracking attempt |
| `RATE_LIMIT_MAX_REQUESTS`       | 300/min per IP suits a school; a large campus behind one NAT needs more                                   |

---

## 3. Order of operations

Migrations run **before** the new application version starts, as a separate step with the
migrator credentials. Never from application startup — several replicas booting together would
race, and a failed migration would then be a crash loop rather than a failed deploy step.

```bash
pnpm install --frozen-lockfile
pnpm --filter "./packages/*" run build
pnpm build

MIGRATION_DATABASE_URL=... pnpm db:migrate    # separate step, migrator credentials

# then start
node apps/api/dist/main.js
pnpm --filter @shikkha/web start
```

`pnpm db:migrate -- --status` lists applied and pending without changing anything. The runner
takes an advisory lock, so a concurrent second attempt waits rather than colliding.

### Zero-downtime

Migrations are forward-only and must be compatible with the _previous_ application version,
because both run simultaneously during a rolling deploy. In practice: add columns nullable,
backfill separately, and make them non-nullable in a later release.

There is no automated check for this yet (see `docs/14_KNOWN_ISSUES.md`, KI-005 area).

---

## 4. Reverse proxy

The API sets `trust proxy` to **one** hop. If the deployment has a different proxy depth, change
it in `main.ts` — `trust proxy: true` would let any client forge `x-forwarded-for` and thereby
forge the IP that rate limiting and brute-force detection key on.

The proxy must terminate TLS, forward `X-Forwarded-For` and `X-Forwarded-Proto`, and allow the
`x-request-id`, `x-institution-id` and `x-campus-id` headers through.

---

## 5. Health probes

| Probe      | Endpoint               | Notes                                                                                                     |
| ---------- | ---------------------- | --------------------------------------------------------------------------------------------------------- |
| Liveness   | `/api/v1/health/live`  | No dependency checks. A liveness probe that checks the database restarts every pod during a database blip |
| Readiness  | `/api/v1/health/ready` | 503 when a dependency is down; removes the instance from the load balancer without killing it             |
| Monitoring | `/api/v1/health`       | Per-component status and latency                                                                          |

Readiness reports `degraded` when the connection pool has waiters — saturated is not down, but
it is about to be, and that gives monitoring a chance to alert before requests queue.

---

## 6. Backups

Not yet automated. What is needed:

- **Continuous archiving** (WAL-G, pgBackRest, or the managed provider's equivalent) with
  point-in-time recovery. Nightly dumps alone mean losing up to a day of fee collections.
- **Restore rehearsals.** A backup that has never been restored is a hypothesis.
- **Encryption at rest** for both database and object storage.
- **Object storage versioning**, so a deletion is recoverable.

Retention should meet the longest record-keeping obligation the institution has, which for
academic records is typically measured in decades rather than months.

---

## 7. Rollback

**Application:** deploy the previous image. The API is stateless.

**Database:** migrations are forward-only. There are no down migrations, deliberately — a
generated `down` gives false confidence that a destructive change is reversible when the data is
already gone. Recovery from a bad migration is a forward fix plus, if data was lost,
point-in-time restore.

This is why destructive changes need an explicit transition plan: add, backfill, switch reads,
stop writing, drop in a later release.

---

## 8. Scaling

**API** is stateless and scales horizontally. Two caveats:

1. Rate limiting is in-memory, so the effective limit multiplies by the replica count (KI-001).
   Redis-backed storage is the fix.
2. Connection pools multiply too. `DATABASE_POOL_MAX × replicas` must stay under Postgres
   `max_connections` with headroom; past a handful of replicas, put PgBouncer in front in
   transaction mode.

**PgBouncer note.** Transaction pooling is compatible with this design because tenant context is
set with `SET LOCAL` inside a transaction — session pooling would be required if it used plain
`SET`. That was part of the reason for choosing Drizzle over an ORM that manages its own
connection lifecycle (ADR-003).

**Database** scales vertically first. The read-heavy reporting workload can move to a replica
using `shikkha_readonly`; RLS applies there too.

---

## 9. Observability

Structured JSON logs on stdout, with the request id on every line and PII redacted at
serialisation time. Ship to any aggregator.

Not yet integrated, but architected not to require changes: Sentry (the exception filter is the
single hook point), OpenTelemetry (the request context already carries a correlation id),
Prometheus (`/health` already exposes component latency).

The deliberate choice is that none of these are coupled in. A monitoring vendor change should
not be a code change.

---

## 10. Production checklist

- [ ] `shikkha_app` created, not the owner, `nobypassrls` verified
- [ ] `JWT_SECRET` generated fresh, ≥ 48 characters, stored in a secret manager
- [ ] `COOKIE_SECURE=true`, TLS terminated, HSTS on
- [ ] `CORS_ORIGINS` lists exactly the real web origin
- [ ] `STORAGE_DRIVER=s3` with a private bucket, versioning and encryption
- [ ] Migrations applied as a separate step, `--status` clean
- [ ] `pnpm test:security` passing against a build of the deployed commit
- [ ] Continuous archiving configured **and a restore rehearsed**
- [ ] Health probes wired to the orchestrator
- [ ] Log shipping configured, redaction verified on a sample
- [ ] `trust proxy` matches the actual proxy depth
- [ ] `ENABLE_SWAGGER=false`, `ENABLE_DEMO_HINTS=false`
- [ ] Rate limits sized for the institution's NAT topology
- [ ] Database `max_connections` ≥ pool × replicas + headroom
