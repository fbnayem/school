# 08 — Workflow Engine

Not implemented (Phase 25). Recorded now because a decision elsewhere depends on it.

---

## 1. Why it is deferred

A workflow engine designed before there are workflows becomes a configuration language nobody
uses. It is scheduled for the point where the second module needs approvals — expenses and
results — so the abstraction is extracted from two real cases rather than guessed from none.

## 2. Why it is already load-bearing

**Approver ≠ initiator** (`docs/14_KNOWN_ISSUES.md`, KI-002).

The role presets have clean separation of duties: no role except the owner holds both halves of
a refund, discount, journal, marks, results or payroll pair, and
`packages/permissions/test/rbac-matrix.spec.ts` fails if that changes. But permissions cannot
express "not _this specific person_". A tenant that grants one user both roles — or a school
owner, who by definition holds everything — can currently self-approve.

That rule belongs here, at runtime, and it covers even the owner. It is the reason this document
exists before the code does.

## 3. Shape

```
Expense   → Accountant → Principal → Director → Payment
Results   → Teacher → Department Head → Exam Controller → Principal → Publish
Leave     → Employee → Manager → HR → Attendance → Payroll
Admission → Officer → Test → Interview → Merit → Offer
```

Definitions are data, not code: steps, conditions, approver resolution, rejection, send-back
with comments, and a full history.

## 4. Requirements

- **Every transition is audited** with actor, timestamp and reason.
- **An approver may not approve their own request**, regardless of permissions.
- **Approvers are resolved by permission, not by name**, so a staffing change does not break a
  running workflow.
- **Transitions are validated against an explicit state machine.** An invalid transition is a
  409 naming the from and to states, not a silent no-op.
- **Escalation-ready.** The schema carries due dates and escalation targets from the first
  migration, so adding a scheduler later is not a migration.

## 5. Relationship to the automation engine

The workflow engine handles _human_ approval chains. The automation engine (Phase 26) handles
_rule-triggered_ actions — three consecutive absences notifies the guardian; a fee 15 days
overdue sends a reminder.

They meet where an automation rule needs a human decision: the rule creates a workflow request
rather than acting. That is the same suggest-review-confirm shape the AI phases use, and for the
same reason.
