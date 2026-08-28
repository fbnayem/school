# 07 — Security Model

The system holds children's names, dates of birth, addresses, guardians' phone numbers, medical
notes, and their families' financial records. That is the threat model: not abstract compliance,
but the concrete consequence of any of it reaching someone it should not.

---

## 1. Trust boundaries

```
Untrusted ─────────────────────────────────────────────────────────────────
  Browser · Flutter app · anything holding a token
    ↓ HTTPS, httpOnly cookies or bearer token
Semi-trusted ──────────────────────────────────────────────────────────────
  apps/web   — renders; enforces nothing. Hides buttons only.
    ↓ HTTP
Trusted ───────────────────────────────────────────────────────────────────
  apps/api   — the only process with database credentials.
               Every request: authenticate → resolve tenant → authorize → audit.
    ↓ postgres, as shikkha_app (not owner, no BYPASSRLS)
Enforced ──────────────────────────────────────────────────────────────────
  PostgreSQL — row-level security. Fails closed with no tenant context.
```

`apps/ai` (Phase 27) sits in the untrusted band by construction: it is given **no database
credentials at all** and reaches data only by calling back into the API with the caller's
delegated authorization. That is not a policy the AI could violate; it is a missing connection
string.

---

## 2. Authentication

| Control                | Implementation                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| Password hashing       | Argon2id, 19 MiB / t=2 / p=1 (OWASP baseline), parameters configurable                                       |
| Password policy        | 12 characters minimum, denylist, no email or name substring. Length over composition rules, per NIST 800-63B |
| Access tokens          | HS256 JWT, 15 minutes, issuer and audience verified                                                          |
| Refresh tokens         | 256-bit opaque, stored **hashed** (SHA-256), rotated on every use                                            |
| Reuse detection        | A rotated-away token revokes the entire session family and logs a critical event                             |
| Revocation             | `cav` claim (credentials version, milliseconds) compared per request — exact, no tolerance                   |
| Account lockout        | Configurable threshold and duration, audited                                                                 |
| Enumeration resistance | Identical response for wrong password and unknown account; a dummy verification burns comparable time        |
| Identifier             | Email **or** Bangladeshi mobile, normalised to E.164 before lookup                                           |

**Why refresh tokens are opaque rather than JWTs.** A JWT cannot be revoked. School staff get
terminated and devices get lost; "log out everywhere" has to actually work. A database lookup
every 15 minutes is the price, and it is cheap.

**Why status is checked after the password.** Refusing a suspended account before verifying the
password would confirm the account exists to anyone who guesses an email address.

---

## 3. Authorization

Three questions, answered in three different places, deliberately:

| Question                      | Answered by        | Mechanism                                                                                                        |
| ----------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Who is this?                  | `JwtAuthGuard`     | Token validation + credentials version + account status                                                          |
| Which tenant and institution? | `TenantGuard`      | Tenant from the **session**, never a header. Institution from a header, validated against the principal's grants |
| May they do this?             | `PermissionsGuard` | `@RequirePermissions(...)` against the permission catalogue                                                      |
| Which **rows**?               | The service        | `resolveDataScope` returns `all` / `assigned` / `own`; the repository applies it as SQL                          |

The fourth is the one that gets skipped. A guard cannot answer "is this row one of their
students" without a database join, so an endpoint that checks a permission and then returns every
row passes every guard and leaks everything. `SCOPED_RESOURCES` and `resolveDataScope` exist to
make the correct thing the easy thing.

### Routes cannot forget

`assertRoutesProtected` walks every registered handler at boot and **refuses to start** if one
declares neither `@Public()`, `@Authenticated()`, nor `@RequirePermissions(...)`. The common way
an authorization hole ships is not a wrong check but a missing one; this makes that a startup
crash in every environment.

It also prints the public route list on every boot. The public surface is the attack surface, and
it should be short enough to read in the logs.

---

## 4. Tenant isolation

Three independent layers. Any one of them failing alone does not produce a breach.

| Layer                                                            | Catches                                  |
| ---------------------------------------------------------------- | ---------------------------------------- |
| `TenantGuard` derives the tenant from the session                | A client naming someone else's tenant    |
| `runInTenant` opens a transaction with `SET LOCAL app.tenant_id` | A service that forgot a `where` clause   |
| Postgres RLS policies, forced, on 37 tables                      | A raw query that bypassed the repository |

The application connects as `shikkha_app`: **not** the table owner and **without** `BYPASSRLS`.
Both matter — RLS does not apply to a table's owner unless forced, and a role with `BYPASSRLS`
ignores every policy. Migration 0002 asserts both and fails if either is wrong.

**Fail closed.** Outside a tenant transaction the setting is empty and the policies return zero
rows. A query that forgets its context returns nothing rather than everything, which surfaces as
missing data rather than as a breach.

Verified independently of the application, connecting as the same unprivileged role:

```
No tenant context      → 0 rows from every table
Tenant B, A's row by PK → 0 rows
Tenant B writes A's id  → ERROR: new row violates row-level security policy
Tenant B updates A's row→ 0 rows affected
```

---

## 5. Input handling

| Risk               | Control                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| SQL injection      | Drizzle parameterises everything. Sort fields are matched against an allow-list, never interpolated                             |
| Mass assignment    | Zod `parse` returns the parsed value with unknown keys stripped, so an injected `isPlatformAdmin: true` never reaches an insert |
| XSS                | React escapes by default; no `dangerouslySetInnerHTML`. API sets a `default-src 'none'` CSP                                     |
| CSRF               | `SameSite=Lax` cookies; the API accepts only JSON, and a cross-site form post cannot set `Content-Type: application/json`       |
| Path traversal     | Storage keys are generated internally and re-validated after resolution against the storage root                                |
| Unsafe uploads     | MIME determined from content, not the client's claim; extension allow-listed; size bounded                                      |
| Oversized payloads | Body limit; page size clamped server-side (`MAX_PAGE_SIZE`)                                                                     |
| Open redirect      | The login `next` parameter must start with `/` and not `//`                                                                     |
| Log injection      | An inbound `x-request-id` is accepted only if it matches `[A-Za-z0-9_.:-]{1,64}`                                                |

---

## 6. What never leaves the server

**In responses.** `SerializationInterceptor` strips `passwordHash`, `tokenHash`, `mfaSecret`,
`searchVector` and the internal `__audit` hint from every response tree, wherever they appear. A
service that accidentally returns a whole user row is then a bug rather than a credential leak.

**In logs.** pino redacts credentials _and_ personal data — national IDs, birth registration
numbers, bank accounts, medical fields. A log aggregator is a far softer target than the database.

**In the audit trail.** Passwords, tokens and MFA secrets are replaced with `[redacted]` before
the record is written. The audit log is read by administrators and auditors, exported, and
retained for years.

**In error messages.** Stack traces, SQL fragments and upstream provider errors never reach a
client. The response carries a stable code, a safe message, and a request id; the detail is in
the log under that id.

Authorization failures never name the missing permission — that is free reconnaissance.
Cross-tenant reads return 404, not 403, because confirming a record exists elsewhere is itself a
leak.

---

## 7. Audit and detection

Two tables, because they answer different questions.

**`audit_logs`** — what changed, who changed it, before and after. Append-only: `UPDATE` and
`DELETE` are revoked from the application role _and_ blocked by a trigger, so a future migration
that re-grants the privilege by accident still fails. Retention runs as the migrator role.

**`security_events`** — who tried, and did it work. Written even with no authenticated user,
which is the point: a failed login against a non-existent account has no user, no tenant and no
resource, and is exactly the event worth recording. Its RLS policy permits unconditional INSERT
and tenant-scoped SELECT.

Recorded: login success and failure, account lockout, password change, token reuse, permission
denial, cross-tenant attempt, rate limiting, session revocation.

`ALWAYS_AUDITED_PERMISSIONS` means a new endpoint using a sensitive permission is audited whether
or not its author remembered the decorator.

---

## 8. Configuration safety

The API **refuses to start** when `NODE_ENV=production` and any of these hold:

- `JWT_SECRET` is a known development placeholder, or shorter than 48 characters
- `COOKIE_SECURE` is false
- `CORS_ORIGINS` contains a wildcard or `localhost`
- `STORAGE_DRIVER` is `local` (not durable; loses documents on redeploy)
- `DATABASE_URL` points at the migrator role (RLS would not apply)
- `DATABASE_LOG_QUERIES` is true (query logs contain student data)
- `ENABLE_DEMO_HINTS` is true

Shipping with `JWT_SECRET=dev-secret` is a complete authentication bypass. The only reliable
defence against a configuration mistake is a process that will not run.

---

## 9. Verification

| Suite                                           | What it proves                                                         | Count |
| ----------------------------------------------- | ---------------------------------------------------------------------- | ----- |
| `test/security/tenant-isolation.spec.ts`        | No cross-tenant read or write, at both the API and the database layer  | 23    |
| `test/security/rbac-enforcement.spec.ts`        | The HTTP surface consults the permission model                         | 26    |
| `test/integration/auth.spec.ts`                 | Rotation, reuse detection, lockout, revocation, enumeration resistance | 24    |
| `packages/permissions/test/rbac-matrix.spec.ts` | Role presets and separation of duties                                  | 69    |

Run: `pnpm test:security`. A failure is release-blocking, not a bug.

---

## 10. Not yet addressed

Tracked in `docs/14_KNOWN_ISSUES.md`. The security-relevant ones: rate limiting is per instance
(KI-001), approver-may-not-be-initiator is not enforced at runtime (KI-002), and there is no MFA
implementation despite the schema being ready.
