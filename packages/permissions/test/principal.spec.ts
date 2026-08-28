import { describe, expect, it } from 'vitest';
import {
  accessibleInstitutionIds,
  can,
  canAll,
  canAny,
  effectivePermissions,
  grantCovers,
  resolveDataScope,
  SCOPED_RESOURCES,
  type Principal,
  type RoleGrant,
} from '../src/principal';
import { ALL_PERMISSIONS } from '../src/catalog';

const INST_A = '11111111-1111-7111-8111-111111111111';
const INST_B = '22222222-2222-7222-8222-222222222222';
const CAMPUS_A1 = 'aaaaaaaa-1111-7111-8111-aaaaaaaaaaaa';
const CAMPUS_A2 = 'aaaaaaaa-2222-7222-8222-aaaaaaaaaaaa';

function grant(overrides: Partial<RoleGrant> = {}): RoleGrant {
  return {
    roleId: 'role-1',
    roleKey: 'test',
    permissions: [],
    institutionIds: null,
    campusIds: null,
    ...overrides,
  };
}

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: 'user-1',
    tenantId: 'tenant-1',
    isPlatformAdmin: false,
    roles: [],
    ...overrides,
  };
}

describe('grantCovers', () => {
  it('matches exactly', () => {
    expect(grantCovers('students.view.all', 'students.view.all')).toBe(true);
    expect(grantCovers('students.view.all', 'students.view.own')).toBe(false);
  });

  it('honours the global wildcard', () => {
    expect(grantCovers('*', 'anything.at.all')).toBe(true);
  });

  it('honours a prefix wildcard at segment boundaries', () => {
    expect(grantCovers('students.*', 'students.view.all')).toBe(true);
    expect(grantCovers('finance.invoices.*', 'finance.invoices.void')).toBe(true);
    expect(grantCovers('finance.invoices.*', 'finance.collect_payment')).toBe(false);
  });

  it('does not let a prefix wildcard leak across a name boundary', () => {
    // The classic bug: `student.*` accidentally covering `students.view.all`.
    expect(grantCovers('student.*', 'students.view.all')).toBe(false);
    expect(grantCovers('finance.*', 'financex.view')).toBe(false);
  });

  it('treats a wildcard in the request as a non-match rather than a match', () => {
    expect(grantCovers('students.view.all', 'students.*')).toBe(false);
  });
});

describe('can — institution scoping', () => {
  it('grants tenant-wide when institutionIds is null', () => {
    const user = principal({
      roles: [grant({ permissions: ['students.view.all'], institutionIds: null })],
    });
    expect(can(user, 'students.view.all', { institutionId: INST_A })).toBe(true);
    expect(can(user, 'students.view.all', { institutionId: INST_B })).toBe(true);
  });

  it('refuses another institution when the grant is scoped', () => {
    const user = principal({
      roles: [grant({ permissions: ['students.view.all'], institutionIds: [INST_A] })],
    });
    expect(can(user, 'students.view.all', { institutionId: INST_A })).toBe(true);
    expect(can(user, 'students.view.all', { institutionId: INST_B })).toBe(false);
  });

  it('applies an institution-limited grant when no institution is named', () => {
    // The guard answers "may they do this kind of thing"; the repository answers "to which
    // rows". An unnamed institution is not a permission question — routes that genuinely need
    // one named institution declare @InstitutionScoped(), and the tenant guard refuses the
    // request without the header before this code is reached.
    const user = principal({
      roles: [grant({ permissions: ['institution.update'], institutionIds: [INST_A] })],
    });
    expect(can(user, 'institution.update', { institutionId: INST_A })).toBe(true);
    expect(can(user, 'institution.update', { institutionId: INST_B })).toBe(false);
    expect(can(user, 'institution.update', { institutionId: null })).toBe(true);
    expect(can(user, 'institution.update', {})).toBe(true);
  });

  it('still narrows the accessible institution list, which is what scopes the data', () => {
    const user = principal({
      roles: [grant({ permissions: ['students.view.all'], institutionIds: [INST_A] })],
    });
    // The permission passes unscoped, but the repository only ever sees institution A.
    expect(can(user, 'students.view.all')).toBe(true);
    expect(accessibleInstitutionIds(user)).toEqual([INST_A]);
  });

  it('applies campus scoping within a permitted institution', () => {
    const user = principal({
      roles: [
        grant({
          permissions: ['attendance.mark'],
          institutionIds: [INST_A],
          campusIds: [CAMPUS_A1],
        }),
      ],
    });
    expect(can(user, 'attendance.mark', { institutionId: INST_A, campusId: CAMPUS_A1 })).toBe(true);
    expect(can(user, 'attendance.mark', { institutionId: INST_A, campusId: CAMPUS_A2 })).toBe(
      false,
    );
  });

  it('combines multiple grants — the union of scopes applies', () => {
    const user = principal({
      roles: [
        grant({ roleId: 'r1', permissions: ['students.view.all'], institutionIds: [INST_A] }),
        grant({ roleId: 'r2', permissions: ['finance.invoices.view'], institutionIds: [INST_B] }),
      ],
    });
    expect(can(user, 'students.view.all', { institutionId: INST_A })).toBe(true);
    expect(can(user, 'students.view.all', { institutionId: INST_B })).toBe(false);
    expect(can(user, 'finance.invoices.view', { institutionId: INST_B })).toBe(true);
    expect(can(user, 'finance.invoices.view', { institutionId: INST_A })).toBe(false);
  });

  it('denies everything for a principal with no roles', () => {
    const user = principal();
    expect(can(user, 'students.view.all')).toBe(false);
    expect(can(user, 'academic.calendar.view')).toBe(false);
  });
});

describe('platform admin', () => {
  it('bypasses every check — the deliberate single exception', () => {
    const admin = principal({ tenantId: null, isPlatformAdmin: true });
    expect(can(admin, 'accounting.period.close')).toBe(true);
    expect(can(admin, 'platform.impersonate')).toBe(true);
    expect(can(admin, 'anything.invented', { institutionId: INST_B })).toBe(true);
  });
});

describe('canAny / canAll', () => {
  const user = principal({
    roles: [grant({ permissions: ['students.view.all', 'attendance.mark'] })],
  });

  it('canAny is a disjunction', () => {
    expect(canAny(user, ['finance.refund', 'attendance.mark'])).toBe(true);
    expect(canAny(user, ['finance.refund', 'payroll.disburse'])).toBe(false);
  });

  it('canAll is a conjunction', () => {
    expect(canAll(user, ['students.view.all', 'attendance.mark'])).toBe(true);
    expect(canAll(user, ['students.view.all', 'finance.refund'])).toBe(false);
  });

  it('canAll on an empty list is vacuously true, canAny is false', () => {
    expect(canAll(user, [])).toBe(true);
    expect(canAny(user, [])).toBe(false);
  });
});

describe('effectivePermissions', () => {
  it('expands wildcards against the catalogue for the client', () => {
    const user = principal({ roles: [grant({ permissions: ['library.*'] })] });
    const effective = effectivePermissions(user, ALL_PERMISSIONS);
    expect(effective).toContain('library.circulation.manage');
    expect(effective).toContain('library.catalog.view');
    expect(effective).not.toContain('finance.refund');
  });

  it('returns the full catalogue for a platform admin', () => {
    const admin = principal({ isPlatformAdmin: true });
    expect(effectivePermissions(admin, ALL_PERMISSIONS)).toHaveLength(ALL_PERMISSIONS.length);
  });

  it('respects institution scope when flattening', () => {
    const user = principal({
      roles: [grant({ permissions: ['students.*'], institutionIds: [INST_A] })],
    });
    expect(effectivePermissions(user, ALL_PERMISSIONS, { institutionId: INST_A })).toContain(
      'students.create',
    );
    expect(effectivePermissions(user, ALL_PERMISSIONS, { institutionId: INST_B })).toHaveLength(0);
    // With no institution named, the grant contributes its permissions.
    expect(effectivePermissions(user, ALL_PERMISSIONS)).toContain('students.create');
  });

  it('deduplicates across overlapping grants and returns a stable order', () => {
    const user = principal({
      roles: [
        grant({ roleId: 'r1', permissions: ['students.view.all', 'students.create'] }),
        grant({ roleId: 'r2', permissions: ['students.create', 'attendance.mark'] }),
      ],
    });
    const effective = effectivePermissions(user, ALL_PERMISSIONS);
    expect(effective).toEqual(['attendance.mark', 'students.create', 'students.view.all']);
  });
});

describe('accessibleInstitutionIds', () => {
  it('returns null when any grant is tenant-wide', () => {
    const user = principal({
      roles: [
        grant({ roleId: 'r1', institutionIds: [INST_A] }),
        grant({ roleId: 'r2', institutionIds: null }),
      ],
    });
    expect(accessibleInstitutionIds(user)).toBeNull();
  });

  it('unions the scoped grants', () => {
    const user = principal({
      roles: [
        grant({ roleId: 'r1', institutionIds: [INST_A] }),
        grant({ roleId: 'r2', institutionIds: [INST_B, INST_A] }),
      ],
    });
    expect(accessibleInstitutionIds(user)?.sort()).toEqual([INST_A, INST_B].sort());
  });

  it('returns an empty list for a principal with no grants', () => {
    expect(accessibleInstitutionIds(principal())).toEqual([]);
  });
});

describe('resolveDataScope', () => {
  it('gives the broadest scope the principal qualifies for', () => {
    const admin = principal({ roles: [grant({ permissions: ['students.view.all'] })] });
    const teacher = principal({ roles: [grant({ permissions: ['students.view.assigned'] })] });
    const guardian = principal({ roles: [grant({ permissions: ['students.view.own'] })] });
    const stranger = principal();

    expect(resolveDataScope(admin, SCOPED_RESOURCES.students)).toBe('all');
    expect(resolveDataScope(teacher, SCOPED_RESOURCES.students)).toBe('assigned');
    expect(resolveDataScope(guardian, SCOPED_RESOURCES.students)).toBe('own');
    expect(resolveDataScope(stranger, SCOPED_RESOURCES.students)).toBe('none');
  });

  it('a teacher who is also a parent gets the wider staff view, not the narrower one', () => {
    const teacherParent = principal({
      roles: [
        grant({ roleId: 'teacher', permissions: ['students.view.assigned'] }),
        grant({ roleId: 'guardian', permissions: ['students.view.own'] }),
      ],
    });
    expect(resolveDataScope(teacherParent, SCOPED_RESOURCES.students)).toBe('assigned');
  });

  it('falls back correctly for resources with no assigned tier', () => {
    const hr = principal({ roles: [grant({ permissions: ['payroll.payslips.view.all'] })] });
    const staff = principal({ roles: [grant({ permissions: ['payroll.payslips.view.own'] })] });
    expect(resolveDataScope(hr, SCOPED_RESOURCES.payslips)).toBe('all');
    expect(resolveDataScope(staff, SCOPED_RESOURCES.payslips)).toBe('own');
  });
});
