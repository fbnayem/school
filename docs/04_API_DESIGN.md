# 04 — API Design

Base path `/api/v1`. Interactive documentation at `/api/v1/docs` in non-production
environments.

---

## 1. Every request

```
Rate limit  →  Authenticate  →  Resolve tenant  →  Authorize  →  Validate  →  Handle  →  Audit
```

The order is fixed globally in `AppModule` and is not per-route. A new controller inherits the
whole chain, and a route that declares no access requirement **prevents the server from
starting**.

### Headers

| Header                        | Direction | Purpose                                                                                            |
| ----------------------------- | --------- | -------------------------------------------------------------------------------------------------- |
| `Authorization: Bearer <jwt>` | In        | Mobile and server-to-server. Browsers use the httpOnly cookie instead                              |
| `x-institution-id`            | In        | Institution scope. Required by institution-scoped endpoints, validated against the caller's grants |
| `x-campus-id`                 | In        | Optional narrower scope                                                                            |
| `x-request-id`                | In / Out  | Accepted if it matches `[A-Za-z0-9_.:-]{1,64}`; otherwise generated. Always returned               |

The tenant is **never** a header. It comes from the authenticated session, so a client cannot
name its own tenant.

---

## 2. Responses

A single resource returns the object. A collection returns `data` plus `meta`:

```json
{
  "data": [ ... ],
  "meta": {
    "page": 1, "pageSize": 25, "total": 960,
    "totalPages": 39, "hasNext": true, "hasPrevious": false
  }
}
```

Page size is clamped server-side to 200 (`MAX_PAGE_SIZE`), so a crafted URL cannot request the
whole roll.

### Errors

One envelope, always:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The submitted data is not valid",
    "issues": [
      { "path": "guardians.0.phone", "message": "Enter a valid Bangladeshi mobile number" }
    ],
    "requestId": "01a049c6-531a-707c-81de-e138ce05724f"
  }
}
```

`code` is stable and machine-readable, so clients branch on it rather than string-matching the
message. `issues` paths are dotted with array indices so a form library can map an error back to
the field that produced it, including inside repeatable sections.

`requestId` is the whole point of the envelope: it is what turns "it broke" into a support
ticket someone can resolve.

| Status | Code                | When                                                                 |
| ------ | ------------------- | -------------------------------------------------------------------- |
| 400    | `VALIDATION_FAILED` | Malformed request shape                                              |
| 401    | `UNAUTHENTICATED`   | Missing, invalid or superseded token                                 |
| 403    | `FORBIDDEN`         | Authenticated but not permitted. Never names the missing permission  |
| 404    | `NOT_FOUND`         | Absent — **or** present in another tenant                            |
| 409    | `CONFLICT`          | Uniqueness, optimistic-lock mismatch, or a state precondition        |
| 422    | `VALIDATION_FAILED` | Well-formed but invalid, with field issues                           |
| 429    | `RATE_LIMITED`      |                                                                      |
| 500    | `INTERNAL_ERROR`    | Message replaced entirely; detail is in the log under the request id |

Cross-tenant reads return **404, not 403**. Confirming a record exists elsewhere is itself a
leak.

Postgres errors are translated centrally: a unique violation becomes a 409 with a message
derived from the constraint name, so a new module gets correct behaviour without remembering to
handle it.

---

## 3. Route declarations

Every route states its access requirement. This is checked at boot.

```ts
@Get()
@RequirePermissions('students.view.all', 'students.view.assigned', 'students.view.own',
                    { mode: 'any' })
async list(@CurrentUser() principal: Principal, @Query(zodQuery(schema)) query) { ... }
```

| Decorator                  | Meaning                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `@Public()`                | No authentication. Login, refresh, health, and the future public admission form                      |
| `@Authenticated()`         | Any authenticated user. Self-service only: own profile, own session, own password                    |
| `@RequirePermissions(...)` | Default `all`; pass `{ mode: 'any' }` for a disjunction                                              |
| `@InstitutionScoped()`     | The tenant guard requires and validates `x-institution-id`                                           |
| `@Audited({...})`          | Writes an immutable audit record. `requiresReason: true` refuses the request without a justification |

**Why `any` mode on the student list.** A principal, a teacher and a parent hit the same
endpoint. The _widest_ permission the caller holds determines what they see, and the service
resolves that into a SQL filter. That is what keeps the mobile clients simple: one endpoint, and
the server decides.

---

## 4. Endpoints

### Authentication

| Method | Path                    | Access                                                           |
| ------ | ----------------------- | ---------------------------------------------------------------- |
| POST   | `/auth/login`           | Public. Email **or** Bangladeshi mobile                          |
| POST   | `/auth/refresh`         | Public. Rotates; reuse revokes the session family                |
| POST   | `/auth/logout`          | Authenticated                                                    |
| POST   | `/auth/logout-all`      | Authenticated. Invalidates outstanding access tokens immediately |
| GET    | `/auth/me`              | Authenticated. User, roles, effective permissions                |
| POST   | `/auth/change-password` | Authenticated. Ends every other session                          |

### Students

| Method | Path                    | Permission                                       |
| ------ | ----------------------- | ------------------------------------------------ |
| GET    | `/students`             | `students.view.{all,assigned,own}` (any)         |
| GET    | `/students/:id`         | Same, with the same scope filter                 |
| POST   | `/students`             | `students.create` · institution-scoped · audited |
| PATCH  | `/students/:id`         | `students.update` · audited · optimistic lock    |
| POST   | `/students/:id/archive` | `students.archive` · audited · reason required   |

### Guardians

| Method | Path                                         | Permission                                           |
| ------ | -------------------------------------------- | ---------------------------------------------------- |
| GET    | `/guardians/my-children`                     | `students.view.own`                                  |
| GET    | `/guardians`                                 | `guardians.view.{all,own}` (any)                     |
| POST   | `/guardians`                                 | `guardians.create` · audited                         |
| GET    | `/guardians/students/:id`                    | `guardians.view.{all,own}` (any)                     |
| POST   | `/guardians/students/:id/link`               | `guardians.link_student` · audited                   |
| POST   | `/guardians/students/:id/unlink/:guardianId` | `guardians.link_student` · audited · reason required |

### Academic

All institution-scoped.

| Method     | Path                              | Permission                                                |
| ---------- | --------------------------------- | --------------------------------------------------------- |
| GET / POST | `/academic/years`                 | `academic.years.view` / `.manage`                         |
| POST       | `/academic/years/:id/set-current` | `academic.years.manage` · audited                         |
| GET        | `/academic/years/:id/terms`       | `academic.years.view`                                     |
| PUT        | `/academic/terms`                 | `academic.terms.manage` · audited. Replaces the whole set |
| GET / POST | `/academic/class-levels`          | `academic.classes.view` / `.manage`                       |
| GET / POST | `/academic/sections`              | `academic.sections.view` / `.manage`                      |
| GET / POST | `/academic/subjects`              | `academic.subjects.view` / `.manage`                      |

### Audit and health

| Method | Path            | Access                                           |
| ------ | --------------- | ------------------------------------------------ |
| GET    | `/audit-logs`   | `audit.view`                                     |
| GET    | `/health/live`  | Public. No dependency checks                     |
| GET    | `/health/ready` | Public. Fails with 503 when a dependency is down |
| GET    | `/health`       | Public. Per-component detail                     |

---

## 5. Design notes

**Terms are replaced as a set.** `PUT /academic/terms` rather than per-term CRUD, because the
invariants — weights summing to 100%, no overlapping ranges — are properties of the _set_.
Editing one at a time means passing through invalid intermediate states, and there is no
sensible way to reject a single edit that leaves the total at 90%.

**Archive and status change are separate endpoints from update.** Collapsing them into a
generic PATCH would make "a clerk corrected a spelling" and "a student was withdrawn from the
school" indistinguishable in the audit log — exactly the distinction an auditor is looking for.

**Three health endpoints, not one.** A liveness probe that checks the database restarts every
pod during a brief database blip, turning a 30-second degradation into a full outage. Liveness
checks the process; readiness checks dependencies.

**`my-children` has no parameter.** The result derives entirely from the caller's identity, so
there is no id for a parent to tamper with. That is what makes it the safest endpoint in the
product, and it is worth preserving.

---

## 6. Rate limiting

One global limit plus a stricter one on credential endpoints, both resolved per request from
configuration so operations can tune them without a deploy.

Registering two _named_ throttlers does not scope them — every named throttler applies to every
route, which silently imposed the login limit on the whole API. `RateLimitGuard` exists because
of that (KI-R003).

Tracking is by client IP from `request.ip`, which Express populates from `x-forwarded-for` only
because `trust proxy` is set to the real proxy depth. Reading the header directly would let any
client forge its own address.

---

## 7. Versioning

`/api/v1` from the start, so v2 can coexist rather than requiring a flag day. Within v1:

- Adding a field or an optional parameter is not breaking.
- Removing or renaming a field, or narrowing a type, is. It needs v2.
- The error `code` values are part of the contract.

---

## 8. Not yet built

`POST /students/:id/enroll`, promotion and transfer, import and export, document upload, user
invitations, password reset, and the institution/campus CRUD surface. The permission catalogue
already covers them, so adding an endpoint does not mean adding a permission model.
