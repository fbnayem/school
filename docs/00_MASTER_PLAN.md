# 00 — Master Plan

**Product:** ShikkhaOS — an AI-native, multi-tenant School Operating System for Bangladesh.

---

## 1. What this is

Not a collection of modules. One institutional data model, with every capability reading
from and writing to the same students, employees, guardians, academic structure and ledger.

The consequence that matters: attendance is not "the attendance module's data". It is a
fact about a student in a section on a date, which the analytics dashboard, the risk model,
the guardian's phone, and the principal's copilot all read from the same place.

## 2. Target institutions

Bangla-medium, English-version and English-medium schools; single or multi-campus; school
groups. The data model is deliberately general enough for colleges, madrasahs and coaching
centres without a rewrite: an `institution` has a `type`, and academic structure
(year → term → class → section) is configured per institution rather than hard-coded to one
national curriculum.

## 3. Tenancy hierarchy

```
Platform
└── Organization        (the customer — a school group, or a single school's owning entity)
    └── Institution     (a school; has a type and a curriculum configuration)
        └── Campus      (a physical site)
            └── Academic Year
                └── Term
                    └── Shift        (morning / day — common in Bangladesh)
                        └── Class    (Class 6, Class 9 …)
                            └── Section  (A, B, Rose, Tulip …)
```

`organization_id` is the tenant boundary and is called `tenant_id` throughout the schema.
Institution and campus are _scopes within_ a tenant, not tenants themselves — a group admin
legitimately sees several institutions, so institution scoping is a permission concern, while
tenant scoping is a hard isolation concern.

## 4. Build order and rationale

Phases are ordered so that nothing is built before the thing it depends on for correctness.

| Phase | Module                                                                   | Depends on     | Why here                                                          |
| ----- | ------------------------------------------------------------------------ | -------------- | ----------------------------------------------------------------- |
| 1     | Platform foundation: auth, tenancy, RBAC, audit, storage, config, health | —              | Everything else is unsafe without it                              |
| 2     | Academic foundation: years, terms, classes, sections, subjects, teachers | 1              | Students cannot enrol into structure that does not exist          |
| 3     | Student Information System                                               | 2              | The central entity                                                |
| 4     | Guardian management                                                      | 3              | Guardians are defined by their link to students                   |
| 5     | Admissions                                                               | 3, 4           | Produces students and guardians                                   |
| 6     | Timetable                                                                | 2              | Needs subjects, teachers, rooms, periods                          |
| 7     | Attendance                                                               | 3, 6           | Needs enrolment and periods                                       |
| 8     | Examinations and results                                                 | 2, 3           | Needs assessment configuration                                    |
| 9     | Homework and assignments                                                 | 3, 6           |                                                                   |
| 10    | LMS                                                                      | 2, 9           |                                                                   |
| 11    | Fee management                                                           | 3              | Needs enrolled students to bill                                   |
| 12    | Payment gateway abstraction                                              | 11             | Needs invoices to pay                                             |
| 13    | Accounting                                                               | 11, 12         | Fee and payment events post to the ledger                         |
| 14    | Communication centre                                                     | 3, 4, 7, 8, 11 | Notifies about events those modules emit                          |
| 15    | HR                                                                       | 1              | Employees exist from Phase 2 but full lifecycle here              |
| 16    | Payroll                                                                  | 15, 13         | Needs salary structure and a ledger to post to                    |
| 17    | Library                                                                  | 3, 15          |                                                                   |
| 18    | Transport                                                                | 3, 11          |                                                                   |
| 19    | Inventory and procurement                                                | 13             |                                                                   |
| 20    | Asset management                                                         | 19             |                                                                   |
| 21    | Leave                                                                    | 7, 15, 25      | Needs the workflow engine for approvals                           |
| 22    | Discipline                                                               | 3              |                                                                   |
| 23    | Document and template generation                                         | 3, 8, 11, 16   | Renders data those modules own                                    |
| 24    | Report builder                                                           | most           | Generic query surface over existing entities                      |
| 25    | Workflow engine                                                          | 1              | Extracted once two modules need approvals                         |
| 26    | Automation engine                                                        | 14, 25         | Event-driven rules                                                |
| 27–36 | AI foundation, provider abstraction, RAG, copilots, early warning        | 1–26           | AI reads the institutional model through permission-checked tools |

## 5. Non-negotiable invariants

These are checked at every module completion audit, not just once.

1. **Tenant isolation.** No query reaches a row outside the caller's tenant. Enforced in the
   repository layer and again by Postgres RLS. Cross-tenant access is a release blocker.
2. **Permission checks are server-side.** The UI hides what a user cannot do; the API refuses
   it. Both, always.
3. **No floating-point money.** Anywhere.
4. **No hard deletes** of academic or financial records.
5. **Audit before mutation ships.** A sensitive mutation without an audit record is
   incomplete, not "to be added".
6. **AI never executes a sensitive action autonomously.** Suggest → human review → human
   confirm → system executes.
7. **One record per real-world entity.** No module keeps its own copy of a student.

## 6. Definition of "complete" for a module

A module is complete only when API, database, validation, authorization, tenant isolation,
error handling, audit logging, unit tests, integration tests, the responsive UI, and the docs
are all in place. UI alone is not completion. This is tracked per feature in
`docs/12_DEVELOPMENT_STATUS.md`, which is the source of truth for what actually works — not
this plan.

## 7. Current position

See `docs/12_DEVELOPMENT_STATUS.md`. That file is written to be pessimistic; if something is
not marked COMPLETE there, treat it as not working.
