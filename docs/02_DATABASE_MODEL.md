# 02 — Database Model

PostgreSQL 17 with pgvector. 38 tables as of migration 0005. Schema in
`packages/db/src/schema`, migrations in `packages/db/migrations`.

---

## 1. Conventions

Applied by helpers in `schema/_shared.ts` and enforced by
`packages/db/test/schema-conformance.spec.ts`, which fails the build if a new table skips one.

| Column                        | Type                   | On                         | Why                                                                                                                            |
| ----------------------------- | ---------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `id`                          | `uuid`                 | Every table                | UUIDv7 — time-ordered, so index inserts stay sequential; not sequential integers, which leak row counts and invite enumeration |
| `tenant_id`                   | `uuid`                 | Every business table       | The RLS predicate. Four documented exemptions                                                                                  |
| `created_at` / `updated_at`   | `timestamptz`          | Every table                | `updated_at` maintained by trigger, so a bulk import moves it too                                                              |
| `archived_at` / `archived_by` | `timestamptz` / `uuid` | Business tables            | Soft archive (ADR-008)                                                                                                         |
| `version`                     | `integer`              | Concurrently edited tables | Optimistic locking; a stale write is a 409, not a lost edit                                                                    |
| `created_by` / `updated_by`   | `uuid`                 | Business tables            | Nullable — system and migration actions have no user                                                                           |

**Uniqueness is partial.** Every business unique index carries
`WHERE archived_at IS NULL`, so an archived student's roll number becomes reusable while the
record itself is preserved.

**Timestamps carry a timezone.** A naive `timestamp` loses the offset, and this product runs in
UTC+6 while its servers may be anywhere. Genuinely date-only values — date of birth, attendance
date, admission date — use `date`, because they are calendar facts rather than instants
(ADR-009). Both rules are asserted by the conformance test.

**Names are bilingual.** Any table with `name_en` must have `name_bn`. A student's legal Bangla
name and their English-transliterated name are both official and appear on different documents;
neither is derivable from the other.

---

## 2. Tenancy

```
organizations                 the tenant. `id` IS the tenant id
 └── institutions             a school; has a type and a medium of instruction
      └── campuses            a physical site
           └── sections       the group students actually sit in
```

`institutions` and `campuses` are scopes _within_ a tenant, not tenants. A group administrator
legitimately sees several institutions, so institution filtering is an authorization concern
while tenant filtering is a hard isolation concern.

`organizations` is the one table whose RLS policy keys on `id` rather than `tenant_id` — it _is_
the tenant. That asymmetry caused a real leak, fixed in migration 0003 (see KI-R001).

---

## 3. Academic structure

Everything is configuration. There is no hard-coded Bangladeshi curriculum.

| Table              | Notes                                                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `academic_years`   | Overlapping years rejected. Exactly one `is_current` per institution, by partial unique index. `weekend_days` is JSON — Friday/Saturday is a default, not an assumption |
| `terms`            | `weight_basis_points` (3333, not 33.33) contributes to the annual result. Basis points for the same reason money is not a float                                         |
| `shifts`           | Morning/day, near-universal in schools at capacity                                                                                                                      |
| `class_levels`     | `ordinal` drives promotion and sorting, decoupled from the display name so "First Year" and ordinal 11 can differ                                                       |
| `academic_groups`  | Science / Commerce / Humanities, from Class 9                                                                                                                           |
| `sections`         | Scoped to an academic year — "Class 6 A" in 2026 is a different set of students from 2027                                                                               |
| `subjects`         | `is_fourth_subject` and `exclude_from_gpa` are flags because they change GPA _arithmetic_, not display                                                                  |
| `class_subjects`   | The curriculum. Which subjects a class studies, periods per week, mark distribution. Two institutions in one tenant can differ freely                                   |
| `calendar_events`  | Holidays, exam windows, and `overrides_weekend` for a make-up Saturday                                                                                                  |
| `rooms`, `periods` | Timetable groundwork                                                                                                                                                    |

---

## 4. People

**`students` holds the person; `enrollments` holds the year-by-year placement.** This is the
most consequential decision in the schema.

A student is one row for their whole time at the school. Their class, section, roll number and
status _in each academic year_ are separate rows. That is what makes promotion, transfer,
repetition and readmission expressible without destroying history, and it is why a 2026 report
card still resolves correctly after the student moves to Class 8 in 2027.

Storing the current section on `students` would have made every historical query wrong.

| Table                          | Notes                                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `students`                     | Both names, `birth_registration_number` (the primary child identifier here — most students have no NID), medical fields gated on a separate permission                    |
| `enrollments`                  | One live enrolment per student per year. Roll number unique per section among non-cancelled rows                                                                          |
| `student_status_history`       | Append-only domain history — what a transfer certificate is printed from. Distinct from `audit_logs`, which records who changed a row                                     |
| `guardians`                    | Stored once. Phone in E.164 is the deduplication key                                                                                                                      |
| `student_guardians`            | Many-to-many both ways. **This is an authorization table** — a row is what lets a parent see a child                                                                      |
| `employees`                    | Separate from `users`: support staff may have no login, and a teacher who is also a parent is one user with two role grants and two records, not three copies of a person |
| `employee_section_assignments` | Class teacher. One primary per section per year                                                                                                                           |
| `employee_subject_assignments` | Authorises mark entry. Without a row, entry is refused regardless of permissions                                                                                          |

`student_guardians` carries three separate booleans — `is_primary`, `is_billing_contact`,
`is_emergency_contact` — because they are genuinely different responsibilities that often sit
with different people. `can_access_portal` and `has_custody` are separate again, and both are
checked at read time rather than cached in a token, so revoking either takes effect on the next
request.

---

## 5. Identity

| Table         | Notes                                                                                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`       | One tenant, except platform staff (`tenant_id IS NULL` + `is_platform_admin`). Email unique **per tenant** — the same parent may have accounts at two schools                          |
| `roles`       | Tenant-owned, editable. `permissions` is a JSON array of permission strings                                                                                                            |
| `user_roles`  | Optionally narrowed to an institution and campus. Optional validity window for an acting principal or an external auditor                                                              |
| `sessions`    | Refresh tokens as SHA-256 hashes. `family_id` groups rotations so reuse detection can revoke exactly the compromised chain                                                             |
| `auth_tokens` | Invitations, password resets, verification. One table, because the security properties are identical and three near-identical tables means three chances to forget the `used_at` check |

---

## 6. Audit

`audit_logs` is append-only: `UPDATE` and `DELETE` are revoked from the application role _and_
blocked by a trigger, so a future migration that re-grants the privilege by accident still
fails. The owner role may prune for retention (migration 0005).

`actor_user_id` is deliberately **not** a foreign key. An audit record must survive the deletion
of the user it refers to; a restrictive FK would block tenant offboarding and a cascading one
would destroy the trail.

`security_events` is separate because it has a different shape: a failed login against a
non-existent account has no user, no tenant and no resource, and that is exactly the event most
worth recording.

---

## 7. Row-Level Security

Enabled and **forced** on all 37 tenant-scoped tables. Forced matters — RLS does not apply to a
table's owner otherwise. The application connects as `shikkha_app`, which owns nothing and has
no `BYPASSRLS`.

```sql
create policy tenant_isolation on <table>
  for all
  using       (app_is_platform_admin() or tenant_id = app_current_tenant_id())
  with check  (app_is_platform_admin() or tenant_id = app_current_tenant_id());
```

`USING` gates which rows are visible; `WITH CHECK` gates what may be written, which is what
stops a tenant writing a row stamped with someone else's id.

`app_current_tenant_id()` returns NULL when the setting is absent, so the predicate evaluates to
false and returns **zero rows**. A query that forgets its context fails closed.

Migration 0003 adds `assert_rls_coverage()`, which fails the migration if any table is neither
protected nor on an explicit exempt list. A new table has to be classified deliberately.

---

## 8. Indexes

Beyond primary keys and the tenant indexes:

- **Partial unique** on every business uniqueness rule, excluding archived rows.
- **Partial** on hot filtered paths — `student_guardians` where `can_access_portal AND
archived_at IS NULL` serves the parent portal's only query.
- **Composite** on the real access patterns: `(academic_year_id, class_level_id)`,
  `(section_id, status)`, `(tenant_id, module, occurred_at)`.
- **GIN on `tsvector`** generated columns for students, employees and guardians. Generated
  rather than trigger-maintained, so there is no trigger to forget and no stale index after a
  bulk import.
- **Cleanup support**: partial indexes on `sessions.expires_at` and `auth_tokens.expires_at`
  where not yet used, so the (unwritten) cleanup job can find rows cheaply.

Bangla is indexed with the `simple` configuration because Postgres ships no Bengali stemmer.
That gives exact-token matching, which is the correct behaviour for names.

---

## 9. Money

`numeric(14,2)` in the database; a `Money` value object over `bigint` poisa in code (ADR-004).
The conformance test fails any column whose name suggests currency and whose type is `real` or
`double precision`.

No money columns exist yet beyond `plans.monthly_price` — the fee module is Phase 11 — but the
convention and the test are in place before the first one lands.

---

## 10. Migrations

Forward-only, plain SQL, applied by `packages/db/src/migrator.ts`.

- **Each file runs in its own transaction.** A failure rolls that file back and stops.
- **Checksums are recorded.** Editing an applied migration is refused: the database and the
  repository would disagree about what ran.
- **An advisory lock** serialises concurrent starters, so two API instances booting together do
  not both try to apply the same file.
- **Assertions inside migrations** fail the migration rather than shipping a silently disabled
  control — RLS coverage, `BYPASSRLS`, audit-log privileges.

drizzle-kit _authors_ DDL into `drizzle/_kit`; `migrations/` is the curated set, and it also
contains the hand-written SQL the schema DSL cannot express. `pnpm promote <name>` moves a
generated file into place with the next sequence number.

| Migration                 | Contents                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| `0001_initial_schema`     | 37 tables, 13 enums, 54 unique indexes, foreign keys                                               |
| `0002_roles_and_rls`      | Database roles, RLS, append-only audit, check constraints, full-text search, `updated_at` triggers |
| `0003_organizations_rls`  | Closes the `organizations` gap; adds `assert_rls_coverage()`                                       |
| `0004_rooms_bangla_name`  | `rooms.name_bn` — found by the conformance test                                                    |
| `0005_audit_log_archival` | Lets the owner prune the audit log while keeping it append-only for the application                |
