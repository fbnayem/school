/**
 * Loads the authorization principal for a user.
 *
 * Runs on every authenticated request, so it is a single query with a join rather than a
 * user fetch followed by a roles fetch. The result deliberately contains only what
 * authorization needs — no email, no name, no profile — because a field that is present is a
 * field someone eventually branches on, and the permission evaluator must stay decidable from
 * permissions alone.
 *
 * Expired role grants are filtered in SQL, not in application code. An acting-principal grant
 * that ended yesterday must stop working today without anyone running a cleanup job.
 */

import { Injectable } from '@nestjs/common';
import { and, eq, isNull, or, gt, lte, sql } from 'drizzle-orm';
import { roles, userRoles, users } from '@shikkha/db';
import type { Principal, RoleGrant } from '@shikkha/permissions';
import { employees, guardians, students } from '@shikkha/db';
import { DatabaseService } from '../database/database.service';

export interface LoadedPrincipal {
  principal: Principal;
  status: string;
  credentialsChangedAt: Date;
  email: string;
  fullNameEn: string;
  locale: string;
  mustChangePassword: boolean;
}

@Injectable()
export class PrincipalService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Loaded with RLS relaxed, because authentication happens *before* a tenant is known —
   * the user row is what tells us which tenant this is. Scoped by primary key, so it reads
   * exactly one user's data and cannot be used to enumerate.
   */
  async loadPrincipal(userId: string): Promise<LoadedPrincipal | null> {
    return this.db.runAsPlatform(async (tx) => {
      const [user] = await tx
        .select({
          id: users.id,
          tenantId: users.tenantId,
          email: users.email,
          fullNameEn: users.fullNameEn,
          locale: users.locale,
          status: users.status,
          isPlatformAdmin: users.isPlatformAdmin,
          credentialsChangedAt: users.credentialsChangedAt,
          mustChangePassword: users.mustChangePassword,
        })
        .from(users)
        .where(and(eq(users.id, userId), isNull(users.archivedAt)))
        .limit(1);

      if (!user) return null;

      const now = new Date();
      const grants = await tx
        .select({
          roleId: roles.id,
          roleKey: roles.key,
          permissions: roles.permissions,
          institutionId: userRoles.institutionId,
          campusId: userRoles.campusId,
        })
        .from(userRoles)
        .innerJoin(roles, eq(roles.id, userRoles.roleId))
        .where(
          and(
            eq(userRoles.userId, userId),
            isNull(roles.archivedAt),
            // A grant with no validity window is always live; one with a window must contain now.
            or(isNull(userRoles.validFrom), lte(userRoles.validFrom, now)),
            or(isNull(userRoles.validUntil), gt(userRoles.validUntil, now)),
          ),
        );

      // Identity links, which drive the "assigned" and "own" data scopes.
      const [employee] = await tx
        .select({ id: employees.id })
        .from(employees)
        .where(and(eq(employees.userId, userId), isNull(employees.archivedAt)))
        .limit(1);

      const [guardian] = await tx
        .select({ id: guardians.id })
        .from(guardians)
        .where(and(eq(guardians.userId, userId), isNull(guardians.archivedAt)))
        .limit(1);

      const [student] = await tx
        .select({ id: students.id })
        .from(students)
        .where(and(eq(students.userId, userId), isNull(students.archivedAt)))
        .limit(1);

      const principal: Principal = {
        userId: user.id,
        tenantId: user.tenantId,
        isPlatformAdmin: user.isPlatformAdmin,
        roles: grants.map(toRoleGrant),
        employeeId: employee?.id ?? null,
        guardianId: guardian?.id ?? null,
        studentId: student?.id ?? null,
      };

      return {
        principal,
        status: user.status,
        credentialsChangedAt: user.credentialsChangedAt,
        email: user.email,
        fullNameEn: user.fullNameEn,
        locale: user.locale,
        mustChangePassword: user.mustChangePassword,
      };
    });
  }

  /**
   * Invalidate every outstanding access token for a user by moving `credentials_changed_at`
   * forward. Called on password change, role change, and forced logout.
   *
   * This is what makes a 15-minute access token acceptable: revocation is immediate rather
   * than eventual, without a per-request denylist lookup.
   */
  async invalidateTokens(userId: string): Promise<void> {
    await this.db.runAsPlatform(async (tx) => {
      await tx
        .update(users)
        .set({ credentialsChangedAt: sql`now()` })
        .where(eq(users.id, userId));
    });
  }
}

function toRoleGrant(row: {
  roleId: string;
  roleKey: string;
  permissions: unknown;
  institutionId: string | null;
  campusId: string | null;
}): RoleGrant {
  return {
    roleId: row.roleId,
    roleKey: row.roleKey,
    // The column is jsonb; a malformed value should deny rather than crash the request.
    permissions: Array.isArray(row.permissions) ? (row.permissions as string[]) : [],
    // Null in the database means "tenant-wide"; the evaluator expects null, not an empty array.
    institutionIds: row.institutionId ? [row.institutionId] : null,
    campusIds: row.campusId ? [row.campusId] : null,
  };
}
