/**
 * RBAC matrix — the explicit "who must NOT be able to do what" suite from the brief (§50).
 *
 * These assert against the *shipped system role presets*, not against hand-written fixtures,
 * so widening a preset by accident fails a test rather than quietly granting a teacher the
 * ability to publish results.
 *
 * A failure here is release-blocking.
 */

import { describe, expect, it } from 'vitest';
import { can, type Principal } from '../src/principal';
import { ALL_PERMISSIONS, isPermission, PRIVILEGE_ESCALATING_PERMISSIONS } from '../src/catalog';
import { findSystemRole, SYSTEM_ROLES } from '../src/roles';

function asPrincipal(roleKey: string): Principal {
  const role = findSystemRole(roleKey);
  if (!role) throw new Error(`Unknown system role: ${roleKey}`);
  return {
    userId: `user-${roleKey}`,
    tenantId: 'tenant-1',
    isPlatformAdmin: false,
    roles: [
      {
        roleId: `role-${roleKey}`,
        roleKey,
        permissions: role.permissions,
        institutionIds: null,
        campusIds: null,
      },
    ],
  };
}

/** Every permission the role effectively holds, wildcards expanded. */
function held(roleKey: string): Set<string> {
  const user = asPrincipal(roleKey);
  return new Set(ALL_PERMISSIONS.filter((permission) => can(user, permission)));
}

describe('catalogue integrity', () => {
  it('has no duplicate permission strings', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const permission of ALL_PERMISSIONS) {
      if (seen.has(permission)) duplicates.push(permission);
      seen.add(permission);
    }
    expect(duplicates).toEqual([]);
  });

  it('every non-wildcard permission in every system role exists in the catalogue', () => {
    const unknown: string[] = [];
    for (const role of SYSTEM_ROLES) {
      for (const permission of role.permissions) {
        if (permission === '*' || permission.endsWith('.*')) continue;
        if (!isPermission(permission)) unknown.push(`${role.key}: ${permission}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it('every wildcard in a system role actually matches something', () => {
    const dead: string[] = [];
    for (const role of SYSTEM_ROLES) {
      for (const permission of role.permissions) {
        if (permission !== '*' && permission.endsWith('.*')) {
          const prefix = permission.slice(0, -1);
          if (!ALL_PERMISSIONS.some((p) => p.startsWith(prefix))) {
            dead.push(`${role.key}: ${permission}`);
          }
        }
      }
    }
    expect(dead).toEqual([]);
  });

  it('role keys are unique', () => {
    const keys = SYSTEM_ROLES.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('a teacher cannot', () => {
  const teacher = held('teacher');

  it('publish, approve or correct results', () => {
    expect(teacher.has('results.publish')).toBe(false);
    expect(teacher.has('results.approve')).toBe(false);
    expect(teacher.has('results.correct')).toBe(false);
    expect(teacher.has('results.unpublish')).toBe(false);
  });

  it('touch money in any form', () => {
    expect(teacher.has('finance.refund')).toBe(false);
    expect(teacher.has('finance.collect_payment')).toBe(false);
    expect(teacher.has('finance.invoices.void')).toBe(false);
    expect(teacher.has('finance.discounts.approve')).toBe(false);
    expect(teacher.has('accounting.journal.post')).toBe(false);
  });

  it('edit payroll or see anyone else payslip', () => {
    expect(teacher.has('payroll.structures.manage')).toBe(false);
    expect(teacher.has('payroll.disburse')).toBe(false);
    expect(teacher.has('payroll.payslips.view.all')).toBe(false);
    expect(teacher.has('payroll.payslips.view.own')).toBe(true);
  });

  it('view unrelated classes — only the assigned scope is granted', () => {
    expect(teacher.has('students.view.all')).toBe(false);
    expect(teacher.has('students.view.assigned')).toBe(true);
    expect(teacher.has('attendance.view.all')).toBe(false);
    expect(teacher.has('attendance.view.assigned')).toBe(true);
    expect(teacher.has('results.view.all')).toBe(false);
  });

  it('manage users or roles', () => {
    expect(teacher.has('users.create')).toBe(false);
    expect(teacher.has('users.assign_roles')).toBe(false);
    expect(teacher.has('roles.update')).toBe(false);
  });

  it('read the audit log or HR records', () => {
    expect(teacher.has('audit.view')).toBe(false);
    expect(teacher.has('hr.employees.view')).toBe(false);
    expect(teacher.has('hr.documents.view')).toBe(false);
  });
});

describe('a guardian cannot', () => {
  const guardian = held('guardian');

  it('see any student beyond their own children', () => {
    expect(guardian.has('students.view.all')).toBe(false);
    expect(guardian.has('students.view.assigned')).toBe(false);
    expect(guardian.has('students.view.own')).toBe(true);
    expect(guardian.has('guardians.view.all')).toBe(false);
  });

  it('change attendance or marks', () => {
    expect(guardian.has('attendance.mark')).toBe(false);
    expect(guardian.has('attendance.correct')).toBe(false);
    expect(guardian.has('results.enter_marks')).toBe(false);
    expect(guardian.has('results.correct')).toBe(false);
  });

  it('view teacher or HR records', () => {
    expect(guardian.has('hr.employees.view')).toBe(false);
    expect(guardian.has('hr.documents.view')).toBe(false);
    expect(guardian.has('payroll.payslips.view.all')).toBe(false);
    expect(guardian.has('payroll.payslips.view.own')).toBe(false);
  });

  it('see institution-wide finance', () => {
    expect(guardian.has('finance.invoices.view')).toBe(false);
    expect(guardian.has('finance.ledger.view')).toBe(false);
    expect(guardian.has('finance.reports.view')).toBe(false);
    expect(guardian.has('finance.own.view')).toBe(true);
  });

  it('create or grade homework', () => {
    expect(guardian.has('homework.create')).toBe(false);
    expect(guardian.has('homework.grade')).toBe(false);
    expect(guardian.has('homework.submit')).toBe(false);
  });
});

describe('an accountant cannot', () => {
  const accountant = held('accountant');

  it('change grades or attendance', () => {
    expect(accountant.has('results.enter_marks')).toBe(false);
    expect(accountant.has('results.correct')).toBe(false);
    expect(accountant.has('results.approve')).toBe(false);
    expect(accountant.has('results.publish')).toBe(false);
    expect(accountant.has('attendance.mark')).toBe(false);
    expect(accountant.has('attendance.correct')).toBe(false);
  });

  it('approve its own refunds — separation of duties', () => {
    expect(accountant.has('finance.refund')).toBe(true);
    expect(accountant.has('finance.refund.approve')).toBe(false);
    expect(accountant.has('finance.discounts.manage')).toBe(true);
    expect(accountant.has('finance.discounts.approve')).toBe(false);
  });

  it('post or reverse journals, or close a period', () => {
    expect(accountant.has('accounting.journal.create')).toBe(true);
    expect(accountant.has('accounting.journal.post')).toBe(false);
    expect(accountant.has('accounting.journal.reverse')).toBe(false);
    expect(accountant.has('accounting.period.close')).toBe(false);
  });

  it('run payroll', () => {
    expect(accountant.has('payroll.runs.create')).toBe(false);
    expect(accountant.has('payroll.runs.approve')).toBe(false);
    expect(accountant.has('payroll.disburse')).toBe(false);
  });
});

describe('a student cannot', () => {
  const student = held('student');

  it('modify official results or attendance', () => {
    expect(student.has('results.enter_marks')).toBe(false);
    expect(student.has('results.correct')).toBe(false);
    expect(student.has('attendance.mark')).toBe(false);
    expect(student.has('attendance.correct')).toBe(false);
  });

  it('see other students', () => {
    expect(student.has('students.view.all')).toBe(false);
    expect(student.has('students.view.assigned')).toBe(false);
    expect(student.has('students.view.own')).toBe(true);
    expect(student.has('results.view.all')).toBe(false);
  });

  it('reach finance beyond their own account', () => {
    expect(student.has('finance.collect_payment')).toBe(false);
    expect(student.has('finance.invoices.view')).toBe(false);
    expect(student.has('finance.own.view')).toBe(true);
  });

  it('use staff AI surfaces', () => {
    expect(student.has('ai.tutor.use')).toBe(true);
    expect(student.has('ai.copilot.use')).toBe(false);
    expect(student.has('ai.principal_insights.view')).toBe(false);
    expect(student.has('ai.teacher_tools.use')).toBe(false);
  });
});

describe('an auditor is read-only by construction', () => {
  const auditor = held('auditor');

  it('holds no permission that mutates state', () => {
    const mutating = [...auditor].filter((permission) =>
      /\.(create|update|delete|manage|archive|approve|publish|unpublish|post|reverse|close|mark|correct|collect_payment|refund|disburse|generate|send|enroll|promote|transfer|withdraw|readmit|import|assign|receive|act|impersonate|reconcile|deactivate|reset_password|assign_roles|submit|grade|schedule|build|verify|decide|review|substitute|use)$/.test(
        permission,
      ),
    );
    // `reports.export` and `audit.export` are reads that produce a file, not mutations.
    expect(mutating).toEqual([]);
  });

  it('can read the audit log, which is the point of the role', () => {
    expect(auditor.has('audit.view')).toBe(true);
    expect(auditor.has('audit.export')).toBe(true);
  });
});

describe('a receptionist and a security officer are deliberately narrow', () => {
  it('receptionist cannot alter academic or financial records', () => {
    const receptionist = held('receptionist');
    expect(receptionist.has('students.update')).toBe(false);
    expect(receptionist.has('students.create')).toBe(false);
    expect(receptionist.has('results.enter_marks')).toBe(false);
    expect(receptionist.has('finance.collect_payment')).toBe(false);
    expect(receptionist.has('attendance.mark')).toBe(false);
  });

  it('security officer sees only what is needed at the gate', () => {
    const security = held('security_officer');
    expect(security.has('students.view.all')).toBe(true);
    expect(security.has('attendance.mark')).toBe(true);
    expect(security.has('students.medical.view')).toBe(false);
    expect(security.has('results.view.all')).toBe(false);
    expect(security.has('guardians.view.all')).toBe(false);
    expect(security.has('finance.own.view')).toBe(false);
  });
});

describe('privilege escalation containment', () => {
  it('only the owner and explicitly privileged roles can grant roles', () => {
    const granters = SYSTEM_ROLES.filter((role) => held(role.key).has('users.assign_roles')).map(
      (role) => role.key,
    );
    expect(granters.sort()).toEqual(['principal', 'school_owner'].sort());
  });

  it('only the owner can edit the role definitions themselves', () => {
    const editors = SYSTEM_ROLES.filter((role) => held(role.key).has('roles.update')).map(
      (role) => role.key,
    );
    expect(editors).toEqual(['school_owner']);
  });

  it('no tenant role holds a platform permission except the owner wildcard', () => {
    const offenders = SYSTEM_ROLES.filter(
      (role) => role.key !== 'school_owner' && held(role.key).has('platform.impersonate'),
    ).map((role) => role.key);
    expect(offenders).toEqual([]);
  });

  it('every privilege-escalating permission is held by at most a handful of roles', () => {
    for (const permission of PRIVILEGE_ESCALATING_PERMISSIONS) {
      const holders = SYSTEM_ROLES.filter((role) => held(role.key).has(permission)).map(
        (role) => role.key,
      );
      expect(holders.length, `${permission} is held by ${holders.join(', ')}`).toBeLessThanOrEqual(
        4,
      );
    }
  });

  it('roles marked non-sensitive hold no privilege-escalating permission', () => {
    const violations: string[] = [];
    for (const role of SYSTEM_ROLES) {
      if (role.sensitive) continue;
      const permissions = held(role.key);
      for (const escalating of PRIVILEGE_ESCALATING_PERMISSIONS) {
        if (permissions.has(escalating)) violations.push(`${role.key} -> ${escalating}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('student and guardian roles never receive staff-only data', () => {
  const STAFF_ONLY = [
    'audit.view',
    'hr.employees.view',
    'users.view',
    'roles.view',
    'accounting.journal.view',
    'finance.ledger.view',
    'students.medical.view',
    'discipline.records.view',
  ];

  for (const roleKey of ['student', 'guardian']) {
    it(`${roleKey} holds none of them`, () => {
      const permissions = held(roleKey);
      const leaked = STAFF_ONLY.filter((permission) => permissions.has(permission));
      expect(leaked).toEqual([]);
    });
  }
});

describe('separation of duties', () => {
  /**
   * Pairs where the same person must not be able to do both halves.
   *
   * The generated permission matrix originally showed `accounts_manager` holding both
   * `finance.refund` and `finance.refund.approve` — via a `finance.*` wildcard — which let one
   * person raise and approve their own refund. That is precisely the control the pairing
   * exists to provide, so the presets were narrowed and this test pins the result.
   *
   * `school_owner` is exempt: a `*` grant is what an owner role means, and a one-person school
   * has no second pair of eyes to offer. The runtime rule that an approver may not be the
   * initiator of the same request lives in the workflow engine (Phase 25) and covers even the
   * owner — permissions alone cannot express "not this specific person".
   */
  const PAIRS: Array<[string, string]> = [
    ['finance.refund', 'finance.refund.approve'],
    ['finance.discounts.manage', 'finance.discounts.approve'],
    ['accounting.journal.create', 'accounting.journal.post'],
    ['results.submit_marks', 'results.approve'],
    ['results.enter_marks', 'results.publish'],
    ['payroll.runs.create', 'payroll.runs.approve'],
    ['inventory.purchase.request', 'inventory.purchase.approve'],
  ];

  /**
   * Pairs where holding both sides is legitimate, and the control is a runtime one.
   *
   * A principal correcting an attendance record *is* the approving authority — requiring a
   * second principal would be unworkable in a school that has one. The real control is that
   * the correction is audited with a mandatory reason, and that the workflow engine refuses to
   * let anyone approve a request they themselves raised. Listing these explicitly rather than
   * omitting them keeps the exception visible in review.
   */
  const RUNTIME_ENFORCED_PAIRS: Array<[string, string]> = [
    ['attendance.correct', 'attendance.correct.approve'],
  ];

  it('runtime-enforced pairs are a short, deliberate list', () => {
    // A growing list here means the static control is being eroded one exception at a time.
    expect(RUNTIME_ENFORCED_PAIRS.length).toBeLessThanOrEqual(2);
  });

  for (const [performs, approves] of PAIRS) {
    it(`no role except the owner holds both ${performs} and ${approves}`, () => {
      const violations = SYSTEM_ROLES.filter((role) => {
        if (role.key === 'school_owner') return false;
        const permissions = held(role.key);
        return permissions.has(performs) && permissions.has(approves);
      }).map((role) => role.key);

      expect(violations).toEqual([]);
    });
  }

  it('every pair has at least one approver besides the owner', () => {
    // A control nobody can exercise is not a control; it is a permanently blocked workflow.
    for (const [, approves] of PAIRS) {
      const approvers = SYSTEM_ROLES.filter(
        (role) => role.key !== 'school_owner' && held(role.key).has(approves),
      );
      expect(approvers.length, `${approves} has no approver besides the owner`).toBeGreaterThan(0);
    }
  });
});
