/**
 * Principal and access evaluation.
 *
 * A `Principal` is the authenticated caller reduced to exactly what authorization needs —
 * no email, no name, no profile. Anything the evaluator does not need, it must not receive,
 * because a field that is present is a field someone will eventually branch on.
 *
 * Evaluation answers two separate questions, and keeping them separate is the whole design:
 *
 *  1. **Does this principal hold this permission, in this institution/campus scope?**
 *     Answerable from the token. `can()` does this.
 *  2. **Which rows may they see?** Not answerable without the database. `resolveDataScope()`
 *     returns the *filter to apply*, and the repository applies it.
 *
 * Conflating the two produces endpoints that check a permission and then return every row.
 */

import type { Permission } from './catalog';

/** One role assignment, already resolved to its permission set. */
export interface RoleGrant {
  roleId: string;
  roleKey: string;
  permissions: readonly string[];
  /**
   * Institutions this grant applies to. `null` means every institution in the tenant —
   * used for owner/chairman roles in a school group.
   */
  institutionIds: readonly string[] | null;
  /** Campuses this grant applies to. `null` means every campus of the granted institutions. */
  campusIds: readonly string[] | null;
}

export interface Principal {
  userId: string;
  /** Null only for platform staff, who exist outside any tenant. */
  tenantId: string | null;
  /**
   * Platform super admin. This is the single place a boolean flag substitutes for a
   * permission, because it is the bootstrap identity that grants the first tenant its roles.
   * It is a column on `users`, never a role name, and it is audited on every use.
   */
  isPlatformAdmin: boolean;
  roles: readonly RoleGrant[];
  /** Employee record, when the user is staff. Drives "assigned" data scopes. */
  employeeId?: string | null;
  /** Student record, when the user is a student. */
  studentId?: string | null;
  /** Guardian record, when the user is a guardian. Drives "own children" data scopes. */
  guardianId?: string | null;
}

/** Where an action is being taken. Omitted fields mean "not scoped by that dimension". */
export interface AccessContext {
  institutionId?: string | null;
  campusId?: string | null;
}

/**
 * Does a granted permission string cover a requested one?
 *
 * Grants may use a trailing wildcard (`students.*`, `finance.invoices.*`, or bare `*`).
 * Requests are always concrete — asking whether someone can do `students.*` is a category
 * error, so this function does not support it.
 *
 * The segment-boundary check matters: `student.*` must not match `students.view.all`.
 */
export function grantCovers(granted: string, requested: string): boolean {
  if (granted === '*') return true;
  if (granted === requested) return true;
  if (!granted.endsWith('.*')) return false;
  const prefix = granted.slice(0, -1); // keep the trailing dot
  return requested.startsWith(prefix);
}

/**
 * Does a grant apply in the requested scope?
 *
 * The rule: **a named scope must be covered; an unnamed scope is not the guard's problem.**
 *
 * When the request names an institution, an institution-limited grant must include it — that
 * is what stops a group administrator scoped to School A from acting on School B.
 *
 * When the request names no institution, the grant still applies. This is deliberate and was
 * not the first design: originally an institution-limited grant was refused for any unscoped
 * action, on the theory that "administer School A" should not imply "administer everything".
 * That reasoning is right for a *mutation* on an institution-owned resource, and wrong for
 * everything else — it made `/auth/me`, `logout`, and every cross-institution list fail for
 * every user whose roles are institution-scoped, which is nearly all of them.
 *
 * The correct split is by responsibility:
 *  - Routes that genuinely need one named institution declare `@InstitutionScoped()`, and the
 *    tenant guard refuses the request without the header. The scope is never ambiguous there.
 *  - Routes that legitimately span institutions get the grant, and the **repository** narrows
 *    the result set to `accessibleInstitutionIds(principal)`.
 *
 * So the guard answers "may they do this kind of thing", and the data layer answers "to which
 * rows" — which is the same separation `resolveDataScope` makes for row-level scoping.
 */
function grantAppliesToContext(grant: RoleGrant, context: AccessContext | undefined): boolean {
  if (!context) return true;

  if (grant.institutionIds !== null && context.institutionId) {
    if (!grant.institutionIds.includes(context.institutionId)) return false;
  }

  if (grant.campusIds !== null && context.campusId) {
    if (!grant.campusIds.includes(context.campusId)) return false;
  }

  return true;
}

/**
 * The core check. Returns true when any of the principal's role grants both contains the
 * permission and applies to the requested institution/campus.
 */
export function can(
  principal: Principal,
  permission: Permission | string,
  context?: AccessContext,
): boolean {
  if (principal.isPlatformAdmin) return true;
  for (const grant of principal.roles) {
    if (!grantAppliesToContext(grant, context)) continue;
    for (const granted of grant.permissions) {
      if (grantCovers(granted, permission)) return true;
    }
  }
  return false;
}

export function canAny(
  principal: Principal,
  permissions: readonly (Permission | string)[],
  context?: AccessContext,
): boolean {
  return permissions.some((permission) => can(principal, permission, context));
}

export function canAll(
  principal: Principal,
  permissions: readonly (Permission | string)[],
  context?: AccessContext,
): boolean {
  return permissions.every((permission) => can(principal, permission, context));
}

/**
 * The flattened set of concrete permissions a principal holds, for sending to the UI so it
 * can hide unavailable actions.
 *
 * This is a *convenience for rendering only*. The server re-checks on every request; a client
 * that forges this list gains nothing. Wildcards are expanded against the catalogue so the
 * client never has to implement matching logic.
 */
export function effectivePermissions(
  principal: Principal,
  allPermissions: readonly string[],
  context?: AccessContext,
): string[] {
  if (principal.isPlatformAdmin) return [...allPermissions];
  const out = new Set<string>();
  for (const grant of principal.roles) {
    if (!grantAppliesToContext(grant, context)) continue;
    for (const granted of grant.permissions) {
      if (granted === '*' || granted.endsWith('.*')) {
        for (const permission of allPermissions) {
          if (grantCovers(granted, permission)) out.add(permission);
        }
      } else {
        out.add(granted);
      }
    }
  }
  return [...out].sort();
}

/** Institutions this principal can act in, or `null` meaning every institution in the tenant. */
export function accessibleInstitutionIds(principal: Principal): string[] | null {
  if (principal.isPlatformAdmin) return null;
  const ids = new Set<string>();
  for (const grant of principal.roles) {
    if (grant.institutionIds === null) return null;
    for (const id of grant.institutionIds) ids.add(id);
  }
  return [...ids];
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Data scoping
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * How much of a resource the principal may read.
 *
 * - `all`      — every row in the accessible institutions.
 * - `assigned` — rows connected to the principal's employee record (sections they teach,
 *                classes they are class teacher of).
 * - `own`      — rows about the principal themselves, or their linked children.
 * - `none`     — no read access; the caller should raise `ForbiddenError`.
 *
 * Ordering is deliberate: the broadest matching scope wins, so a teacher who is also a
 * parent at the same school sees the full staff view rather than being narrowed to their own
 * child.
 */
export type DataScope = 'all' | 'assigned' | 'own' | 'none';

export interface ScopedResourcePermissions {
  all: Permission;
  assigned?: Permission;
  own?: Permission;
}

export function resolveDataScope(
  principal: Principal,
  permissions: ScopedResourcePermissions,
  context?: AccessContext,
): DataScope {
  if (can(principal, permissions.all, context)) return 'all';
  if (permissions.assigned && can(principal, permissions.assigned, context)) return 'assigned';
  if (permissions.own && can(principal, permissions.own, context)) return 'own';
  return 'none';
}

/** The scoped-permission triples, named once so services cannot mistype them. */
export const SCOPED_RESOURCES = {
  students: {
    all: 'students.view.all',
    assigned: 'students.view.assigned',
    own: 'students.view.own',
  },
  guardians: { all: 'guardians.view.all', own: 'guardians.view.own' },
  attendance: {
    all: 'attendance.view.all',
    assigned: 'attendance.view.assigned',
    own: 'attendance.view.own',
  },
  results: {
    all: 'results.view.all',
    assigned: 'results.view.assigned',
    own: 'results.view.own',
  },
  lms: {
    all: 'lms.view.all',
    assigned: 'lms.view.assigned',
    own: 'lms.view.own',
  },
  payslips: { all: 'payroll.payslips.view.all', own: 'payroll.payslips.view.own' },
  leaveRequests: { all: 'leave.requests.view.all', own: 'leave.requests.view.own' },
} as const satisfies Record<string, ScopedResourcePermissions>;
