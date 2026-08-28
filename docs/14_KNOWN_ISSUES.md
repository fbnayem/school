# 14 — Known Issues and Limitations

Recorded as they are found, not collected at the end. An issue disappears from this file only
when it is fixed, never because it became inconvenient.

Severity: **Critical** (blocks release) · **High** (blocks a phase) · **Medium** · **Low**

---

## Open

### KI-001 · Medium · Rate limiting is per instance

`ThrottlerModule` uses in-memory storage, so the limit applies per API process. Two replicas
means an attacker gets twice the allowance.

**Impact.** The account lockout is unaffected — it is in the database — so credential stuffing
against a _single_ account is still contained. What degrades is the defence against one password
sprayed across many accounts from one IP.

**Fix.** Redis-backed throttler storage. Redis is already a dependency and `RedisService` already
exposes `incrementWithExpiry`, which is the primitive needed. Deferred because single-instance
deployment is the near-term target.

---

### KI-002 · Medium · Approver-may-not-be-initiator is not yet enforced

`docs/05_RBAC_PERMISSION_MATRIX.md` shows clean separation of duties across the role presets —
no role except the owner holds both halves of a refund, discount, journal, marks, results or
payroll pair. But permissions cannot express "not _this specific person_". A tenant that grants
one user both roles, or a `school_owner`, can currently self-approve.

**Fix.** The workflow engine (Phase 25) must reject an approval whose approver is the request's
initiator, regardless of permissions. Until then, the mitigation is that every such action is
audited with an actor and, where policy requires, a mandatory reason.

`attendance.correct` / `attendance.correct.approve` is a deliberate exception and is recorded as
such in `packages/permissions/test/rbac-matrix.spec.ts`: a principal correcting attendance _is_
the approving authority, and requiring a second principal is unworkable in a school with one.

---

### KI-003 · Medium · S3 storage adapter is an interface, not an implementation

`StorageService` throws `ExternalServiceError` when `STORAGE_DRIVER=s3`. The local adapter is a
real implementation with signed, expiring URLs and path-traversal protection, so the
authorization semantics are exercised in development — but there is no production storage.

**Why it fails loudly rather than falling back.** A silent fallback to local disk would appear to
work and then lose every uploaded document on the next deploy.

**Fix.** Implement `S3StorageProvider` against `@aws-sdk/client-s3`. The MinIO service in the
development compose file is already configured to test it. The environment schema refuses to
start in production with `STORAGE_DRIVER=local`, so this cannot ship unnoticed.

---

### KI-004 · Low · Institution selector has no UI

A user whose roles span several institutions has no way to switch between them. `SessionProvider`
resolves a single institution automatically and persists the choice, but with two or more it
stays null and institution-scoped screens show a "choose an institution" empty state.

**Impact.** Single-institution tenants — every seeded and expected early customer — are
unaffected.

**Fix.** A picker in the header, writing through `session.setInstitutionId`. The plumbing is done.

---

### KI-005 · Low · No end-to-end browser tests

Critical flows are covered by API integration tests against a real database, and the web app is
verified manually against the running stack. There is no Playwright suite, so a regression in
client-side routing, form wiring or the refresh-retry path would not be caught automatically.

**Fix.** Playwright, starting with the flows the brief names: admission, attendance, exam, fee,
payroll. Attendance and fees do not exist yet, so the suite would currently cover login →
dashboard → student list → student detail, and the parent portal.

---

### KI-006 · Low · UI chrome is English-only

The _data_ model is bilingual throughout — separate `name_en` and `name_bn` columns, both
rendered, with `lang="bn"` set so fonts and line height are correct. The interface strings are
not translated.

**Why this order.** Retrofitting bilingual _data_ would mean migrating every table; retrofitting
bilingual _chrome_ is a string-extraction exercise. The expensive half is done.

**Fix.** `next-intl` or equivalent, with the locale taken from `users.locale`, which is already
populated and returned by `/auth/me`.

---

### KI-007 · Low · Audit log has no retention or archival job

`audit_logs` grows without bound. At a realistic write rate this is not a problem for years, but
it is not a plan.

**Fix.** A scheduled job running as `shikkha_migrator` (the only role with DELETE) that moves
rows older than the tenant's configured retention into cold storage. The application role cannot
do this, by design.

---

### KI-008 · Low · Expired sessions and auth tokens are not cleaned up

`sessions` and `auth_tokens` accumulate expired rows. Both have partial indexes on their expiry
columns specifically so a cleanup job can find them cheaply; the job does not exist.

**Impact.** Storage only. Expired rows are never accepted — expiry is checked on use.

---

### KI-009 · Low · `class_subjects.mark_distribution` is validated only in the application

The Zod schema requires components to sum to `full_marks`, and the API enforces it. A direct
database write could store an inconsistent distribution.

**Why not a check constraint.** It needs to sum the values of a `jsonb` object against another
column, which Postgres can express only through a non-trivial immutable function. Deferred until
the examination module (Phase 8) makes the field load-bearing.

---

## External dependencies not yet configured

None of these block development — each has a working local substitute (rule 62) — but each is
required before the corresponding feature can go live.

| Integration                | Needed for                                    | Status                              |
| -------------------------- | --------------------------------------------- | ----------------------------------- |
| SMS gateway                | Attendance and fee notifications to guardians | Adapter interface not yet written   |
| Email provider             | Invitations, password reset                   | Mailpit catches mail locally        |
| S3-compatible storage      | Documents, photos                             | See KI-003. MinIO available locally |
| bKash / Nagad / SSLCommerz | Online fee payment                            | Phase 12; not started               |
| AI provider key            | Phases 27–36                                  | Not started                         |

---

## Resolved

These are recorded because each was found by a test that now protects against its return.

### KI-R001 · Critical · `organizations` was not covered by row-level security · **Fixed**

Migration 0002 enabled RLS by scanning for tables with a `tenant_id` column. `organizations`
_is_ the tenant, so its primary key is the tenant id and it has no such column — the scan skipped
it, leaving every tenant's organization row readable by any authenticated session.

Fixed in migration `0003_organizations_rls.sql`, which adds a policy keyed on `id` and, more
importantly, adds `assert_rls_coverage()` — an assertion that fails the migration if any table is
neither RLS-protected nor on an explicit exempt list. A new table now has to be classified
deliberately.

Covered by: `tenant-isolation.spec.ts` → "every table with a tenant_id has forced row-level
security" and "sees only its own organization row".

---

### KI-R002 · High · Guardian endpoints did not apply the student data scope · **Fixed**

`GET /guardians/students/:id` checked `guardians.view.all` but never checked whether the _student_
was visible to the caller. Cross-tenant reads returned an empty list with status 200 (RLS held, so
no data leaked) — but within a tenant, a class teacher could read the guardians of a student in
another section.

Fixed by extracting `StudentsService.assertVisible` and calling it from the guardian read, link
and unlink paths, so guardian visibility is defined in terms of student visibility in exactly one
place.

Covered by: `tenant-isolation.spec.ts` and `rbac-enforcement.spec.ts` → "a guardian cannot read
another family's guardian list".

---

### KI-R003 · High · The strict auth rate limit applied to every route · **Fixed**

Two named throttlers were registered, on the assumption that routes opt into one. Every named
throttler applies to every route, so the 10-requests-per-minute login limit was silently imposed
on the whole API — a teacher would hit 429 after ten page loads. Separately,
`@Throttle({ limit: 10 })` hardcoded the value at class-definition time, so the documented
`AUTH_RATE_LIMIT_MAX_ATTEMPTS` variable had no effect at all.

Fixed by a single throttler plus `RateLimitGuard`, which resolves the limit per request from
configuration and applies the stricter one only to routes marked `@AuthRateLimit()`.

Covered by: `auth.spec.ts` → the brute-force suite, which needs ~30 login attempts and would fail
if the global limit still applied.

---

### KI-R004 · High · Framework exceptions were reported as 500 · **Fixed**

`AllExceptionsFilter` converted an `HttpException` into a plain object with the right fields, but
`toErrorResponse` gates on `instanceof DomainError` — so every guard's 403 fell through to the
generic 500 branch. Authorization failures were indistinguishable from crashes, in the response
_and_ in the logs.

Fixed by introducing `TransportError`, a real `DomainError` subclass, so there is exactly one code
path that produces an error response.

Covered by: every 403 and 422 assertion in the security and integration suites.

---

### KI-R005 · High · Institution-scoped grants blocked unscoped requests · **Fixed**

The permission evaluator refused an institution-limited grant for any request that did not name an
institution, reasoning that "administer School A" should not imply "administer everything". That
reasoning is right for a mutation on an institution-owned resource and wrong for everything else:
it made `/auth/me`, `logout` and every cross-institution list fail for every user whose roles are
institution-scoped — which is nearly all of them.

Fixed by scoping the rule to named scopes only. Routes that genuinely need one institution declare
`@InstitutionScoped()` and the tenant guard requires the header; routes that span institutions get
the grant and the repository narrows the rows.

Covered by: `principal.spec.ts` → "applies an institution-limited grant when no institution is
named" and "still narrows the accessible institution list".

---

### KI-R006 · Medium · Revoked access tokens survived for up to one second · **Fixed**

`JwtAuthGuard` compared `credentials_changed_at` against the JWT `iat` claim, which has
one-second resolution, with a one-second tolerance on top. A token issued milliseconds before a
password change therefore looked newer than the change and kept working.

Fixed with an explicit `cav` claim carrying the credentials version in epoch milliseconds, so the
comparison is exact and there is no tolerance to tune.

Covered by: `auth.spec.ts` → "logout-all revokes every session and invalidates outstanding access
tokens" and "changes the password and ends every existing session".

---

### KI-R007 · Medium · `@shikkha/shared` could not be bundled for the browser · **Fixed**

The package imported `node:crypto` and used `Buffer`, so importing any shared schema into the web
app failed the build outright. The obvious fix — a subpath export splitting server-only code — was
rejected in favour of making the package genuinely isomorphic: `bytes.ts` implements the same
primitives on the Web Crypto API, which is standard in browsers and global in Node 18+.

Covered by: `bytes.spec.ts`, including a check that the base64url output matches Node's `Buffer`
byte for byte, so tokens issued before the change still decode.

---

### KI-R008 · Medium · `inventory_manager` could approve its own purchase requisitions · **Fixed**

An `inventory.*` wildcard granted both `inventory.purchase.request` and
`inventory.purchase.approve`. The same wildcard pattern gave `accounts_manager` both sides of
every finance pair, and gave the oversight-only `chairman` the ability to create the journals it
then posts.

Found by the generated permission matrix, which made the overlap visible in a way the role
definitions did not. Fixed by enumerating the permissions for those three roles.

Covered by: `rbac-matrix.spec.ts` → the separation-of-duties suite.
