/**
 * Invitations: staff/portal users, and guardians onto the parent portal (the Phase 4 gap).
 *
 * Design decisions that carry the security weight:
 *
 *  - **One token table.** Invitation tokens live in `auth_tokens` (0001) alongside password
 *    resets — single-use (`used_at` claimed atomically), time-limited, and stored only as
 *    SHA-256 hashes via the same `hashToken` that protects refresh tokens. The raw token
 *    exists in the invitation URL and nowhere else durable.
 *
 *  - **No privilege escalation by proxy.** Granting a role through an invitation is
 *    subject to exactly the rule that governs granting it directly: the inviter must
 *    already hold, in the scope they are inviting into, every permission the invited roles
 *    would confer. An administrator without `finance.refund` cannot mint an accountant who
 *    has it — and by implication cannot mint anyone holding a permission from
 *    `PRIVILEGE_ESCALATING_PERMISSIONS` they lack themselves. The check runs against the
 *    role rows as they exist in the tenant's database, not against role *names*, so a
 *    tenant-customised role is evaluated on what it actually grants.
 *
 *  - **Re-inviting invalidates the previous token.** Otherwise every re-send widens the
 *    window instead of moving it.
 *
 *  - **Guardian invitations cannot name a role.** The accepted account is bound to the
 *    guardian record (`guardians.user_id`) and receives only the tenant's `guardian`
 *    system role. What the account can then see is decided row-by-row by
 *    `student_guardians.can_access_portal` — the invitation carries no student ids at all,
 *    so it cannot be bent toward a student the guardian is not linked to.
 */

import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  authTokens,
  guardians,
  organizations,
  roles,
  studentGuardians,
  students,
  userRoles,
  users,
} from '@shikkha/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  buildOffsetPage,
  offsetOf,
  secureToken,
  type OffsetPageRequest,
} from '@shikkha/shared';
import {
  ALL_PERMISSIONS,
  PRIVILEGE_ESCALATING_PERMISSIONS,
  can,
  grantCovers,
  type Principal,
} from '@shikkha/permissions';
import type { InviteUserInput } from '@shikkha/validation';
import { DatabaseService } from '../database/database.service';
import { PasswordService } from './password.service';
import { hashToken } from './token.service';
import { SecurityEventService } from '../audit/security-event.service';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from '../notifications/notification.service';
import { env } from '../../config/env';
import { currentContext } from '../../common/context/request-context';

export const INVITATION_TTL_HOURS = 168; // 7 days

interface UserInvitationPayload {
  kind: 'user';
  roleIds: string[];
  institutionId: string | null;
  fullNameEn: string;
  fullNameBn?: string;
  locale: string;
  invitedBy: string;
}

interface GuardianInvitationPayload {
  kind: 'guardian';
  guardianId: string;
  institutionId: string;
  locale: string;
  invitedBy: string;
}

type InvitationPayload = UserInvitationPayload | GuardianInvitationPayload;

export interface IssuedInvitation {
  id: string;
  expiresAt: Date;
  /**
   * The acceptance link, returned once to the inviter so it can be handed over in person
   * when no email/SMS channel is configured — the brief's "missing credentials never block
   * work". It is never logged and never retrievable again: only its hash is stored.
   */
  invitationUrl: string;
  deliveredVia: 'email' | 'sms';
  delivered: boolean;
}

@Injectable()
export class InvitationsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly passwords: PasswordService,
    private readonly securityEvents: SecurityEventService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  // ────────────────────────────────────────────────────────────────────────────────────
  // Staff / portal user invitations
  // ────────────────────────────────────────────────────────────────────────────────────

  async inviteUser(principal: Principal, input: InviteUserInput): Promise<IssuedInvitation> {
    const tenantId = principal.tenantId;
    if (!tenantId) {
      throw new ForbiddenError('users.invite', 'Platform staff accounts are not invited here');
    }
    const institutionId = currentContext()?.institutionId ?? null;
    const email = input.email ?? null;
    const phone = input.phone ?? null;

    const created = await this.db.runInTenant(async (tx) => {
      // Roles must exist, be live, and belong to this tenant. RLS already hides other
      // tenants' roles, so a cross-tenant role id simply "does not exist" — a 404, not a
      // 403, exactly as the isolation rules require.
      const roleRows = await tx
        .select({ id: roles.id, key: roles.key, permissions: roles.permissions })
        .from(roles)
        .where(and(inArray(roles.id, input.roleIds), isNull(roles.archivedAt)));

      if (roleRows.length !== input.roleIds.length) {
        throw new NotFoundError('Role');
      }

      await this.assertNoEscalation(principal, roleRows, institutionId);

      // A live account with the same identifier makes the invitation a mistake, not a flow.
      const identifierMatch = [
        email ? eq(users.email, email) : null,
        phone ? eq(users.phone, phone) : null,
      ].filter((c): c is NonNullable<typeof c> => c !== null);
      const [existing] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(or(...identifierMatch), isNull(users.archivedAt)))
        .limit(1);
      if (existing) {
        throw new ConflictError(
          'A user with this email or phone number already exists in this school',
        );
      }

      await this.revokePendingInvitations(tx, { email, phone });

      const payload: UserInvitationPayload = {
        kind: 'user',
        roleIds: input.roleIds,
        institutionId,
        fullNameEn: input.fullNameEn,
        fullNameBn: input.fullNameBn,
        locale: input.locale,
        invitedBy: principal.userId,
      };
      return this.insertInvitation(tx, {
        tenantId,
        email,
        phone,
        payload,
        createdBy: principal.userId,
      });
    });

    const delivery = await this.deliverInvitation({
      template: 'user_invitation',
      email,
      phone,
      locale: input.locale,
      recipientName: input.fullNameEn,
      tenantId,
      token: created.token,
    });

    return {
      id: created.id,
      expiresAt: created.expiresAt,
      invitationUrl: created.url,
      ...delivery,
    };
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Guardian portal invitations
  // ────────────────────────────────────────────────────────────────────────────────────

  async inviteGuardian(
    principal: Principal,
    guardianId: string,
    input: { email?: string; locale: 'en' | 'bn' },
  ): Promise<IssuedInvitation> {
    const tenantId = principal.tenantId;
    if (!tenantId) {
      throw new ForbiddenError('guardians.grant_access');
    }

    const created = await this.db.runInTenant(async (tx) => {
      const [guardian] = await tx
        .select()
        .from(guardians)
        .where(and(eq(guardians.id, guardianId), isNull(guardians.archivedAt)))
        .limit(1);
      // Another tenant's guardian is invisible under RLS: the same 404 as a wrong id.
      if (!guardian) throw new NotFoundError('Guardian', guardianId);

      if (guardian.userId) {
        throw new ConflictError('This guardian already has a portal account');
      }

      // The invitation is only meaningful for a guardian who would see at least one child.
      const [link] = await tx
        .select({ studentName: students.fullNameEn })
        .from(studentGuardians)
        .innerJoin(students, eq(students.id, studentGuardians.studentId))
        .where(
          and(
            eq(studentGuardians.guardianId, guardianId),
            eq(studentGuardians.canAccessPortal, true),
            isNull(studentGuardians.archivedAt),
            isNull(students.archivedAt),
          ),
        )
        .limit(1);
      if (!link) {
        throw new ConflictError(
          'This guardian is not linked to any student with portal access. Link a student first.',
        );
      }

      // The account will carry the guardian's phone as a login identifier, so it must not
      // collide with an existing user in the tenant.
      const guardianEmail = input.email ?? guardian.email ?? null;
      const identifierMatch = [
        eq(users.phone, guardian.phone),
        guardianEmail ? eq(users.email, guardianEmail) : null,
      ].filter((c): c is NonNullable<typeof c> => c !== null);
      const [existing] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(or(...identifierMatch), isNull(users.archivedAt)))
        .limit(1);
      if (existing) {
        throw new ConflictError(
          'A user account with this phone or email already exists in this school',
        );
      }

      // Re-inviting the same guardian invalidates their previous pending link.
      await tx
        .update(authTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(authTokens.purpose, 'invitation'),
            isNull(authTokens.usedAt),
            isNull(authTokens.revokedAt),
            sql`${authTokens.payload}->>'guardianId' = ${guardianId}`,
          ),
        );

      const payload: GuardianInvitationPayload = {
        kind: 'guardian',
        guardianId,
        institutionId: guardian.institutionId,
        locale: input.locale,
        invitedBy: principal.userId,
      };
      const inserted = await this.insertInvitation(tx, {
        tenantId,
        email: guardianEmail,
        phone: guardian.phone,
        payload,
        createdBy: principal.userId,
      });
      return {
        ...inserted,
        guardianName: guardian.fullNameEn,
        guardianEmail,
        guardianPhone: guardian.phone,
        studentName: link.studentName,
      };
    });

    const delivery = await this.deliverInvitation({
      template: 'guardian_invitation',
      email: created.guardianEmail,
      phone: created.guardianPhone,
      locale: input.locale,
      recipientName: created.guardianName,
      studentName: created.studentName,
      tenantId,
      token: created.token,
    });

    return {
      id: created.id,
      expiresAt: created.expiresAt,
      invitationUrl: created.url,
      ...delivery,
    };
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Acceptance — public endpoint, one transaction
  // ────────────────────────────────────────────────────────────────────────────────────

  async accept(input: {
    token: string;
    password: string;
    fullNameEn: string;
    fullNameBn?: string;
    email?: string;
  }): Promise<{ email: string; loginIdentifier: string }> {
    const tokenHash = hashToken(input.token);

    // Password policy first: it is cheap, it needs no secrets, and failing it must not
    // consume the single-use token.
    const policy = this.passwords.check(input.password, { name: input.fullNameEn });
    if (!policy.valid) {
      throw new ValidationError(
        'The password does not meet the requirements',
        policy.issues.map((message) => ({ path: 'password', message })),
      );
    }
    const passwordHash = await this.passwords.hash(input.password);

    const accepted = await this.db.runAsPlatform(async (tx) => {
      // Atomic claim: the first transaction to flip `used_at` wins; every other presenter
      // of the same token — including a replay — matches zero rows.
      const [token] = await tx
        .update(authTokens)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(authTokens.tokenHash, tokenHash),
            eq(authTokens.purpose, 'invitation'),
            isNull(authTokens.usedAt),
            isNull(authTokens.revokedAt),
            gt(authTokens.expiresAt, new Date()),
          ),
        )
        .returning();

      if (!token || !token.tenantId) {
        await this.recordRejectedToken(tx, tokenHash, 'invitation');
        // One generic answer for unknown, expired, used and revoked alike: distinguishing
        // them would tell an attacker which stolen links are still worth trying.
        throw new NotFoundError('Invitation');
      }

      const payload = token.payload as unknown as InvitationPayload;
      const tenantId = token.tenantId;

      if (payload.kind === 'guardian') {
        return this.acceptGuardian(tx, token.id, tenantId, payload, {
          email: token.email,
          phone: token.phone,
          passwordHash,
          fullNameEn: input.fullNameEn,
          fullNameBn: input.fullNameBn,
          bodyEmail: input.email,
        });
      }
      return this.acceptUser(tx, tenantId, payload, {
        email: token.email,
        phone: token.phone,
        passwordHash,
        fullNameEn: input.fullNameEn,
        fullNameBn: input.fullNameBn,
        bodyEmail: input.email,
      });
    });

    await this.securityEvents.record({
      eventType: 'invitation_accepted',
      severity: 'info',
      userId: accepted.userId,
      tenantId: accepted.tenantId,
      detail: { kind: accepted.kind, roles: accepted.roleKeys },
    });
    await this.audit.record({
      tenantId: accepted.tenantId,
      actorUserId: accepted.userId,
      actorEmail: accepted.email,
      action: 'create',
      module: 'auth',
      resourceType: 'user',
      resourceId: accepted.userId,
      resourceLabel: input.fullNameEn,
      newValue: { activatedVia: 'invitation', roles: accepted.roleKeys },
      requestId: currentContext()?.requestId ?? null,
      ipAddress: currentContext()?.ipAddress ?? null,
      userAgent: currentContext()?.userAgent ?? null,
    });

    return { email: accepted.email, loginIdentifier: accepted.loginIdentifier };
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Administration: list and revoke pending invitations
  // ────────────────────────────────────────────────────────────────────────────────────

  async list(_principal: Principal, query: { includeExpired: boolean }, page: OffsetPageRequest) {
    return this.db.runInTenant(async (tx) => {
      const filters = [
        eq(authTokens.purpose, 'invitation'),
        isNull(authTokens.usedAt),
        isNull(authTokens.revokedAt),
      ];
      if (!query.includeExpired) filters.push(gt(authTokens.expiresAt, new Date()));
      const where = and(...filters);

      const rows = await tx
        .select({
          id: authTokens.id,
          email: authTokens.email,
          phone: authTokens.phone,
          kind: sql<string>`coalesce(${authTokens.payload}->>'kind', 'user')`,
          fullNameEn: sql<string | null>`${authTokens.payload}->>'fullNameEn'`,
          expiresAt: authTokens.expiresAt,
          createdAt: authTokens.createdAt,
          createdBy: authTokens.createdBy,
        })
        .from(authTokens)
        .where(where)
        .orderBy(desc(authTokens.createdAt), asc(authTokens.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(authTokens)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async revoke(principal: Principal, id: string): Promise<{ id: string; revokedAt: Date }> {
    return this.db.runInTenant(async (tx) => {
      const [revoked] = await tx
        .update(authTokens)
        .set({ revokedAt: new Date(), updatedBy: principal.userId })
        .where(
          and(
            eq(authTokens.id, id),
            eq(authTokens.purpose, 'invitation'),
            isNull(authTokens.usedAt),
            isNull(authTokens.revokedAt),
          ),
        )
        .returning({ id: authTokens.id, revokedAt: authTokens.revokedAt });
      // Under RLS another tenant's invitation matches zero rows — the same 404 as a
      // wrong id, so revocation cannot be used to probe for other tenants' invitations.
      if (!revoked?.revokedAt) throw new NotFoundError('Invitation', id);
      return { id: revoked.id, revokedAt: revoked.revokedAt };
    });
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────────────────────────────

  private async assertNoEscalation(
    principal: Principal,
    roleRows: { id: string; key: string; permissions: unknown }[],
    institutionId: string | null,
  ): Promise<void> {
    const context = { institutionId };
    const missing = new Set<string>();

    for (const role of roleRows) {
      const grants = Array.isArray(role.permissions) ? (role.permissions as string[]) : [];
      for (const granted of grants) {
        if (granted === '*' || granted.endsWith('.*')) {
          // Expand a wildcard against the catalogue: a role granting `finance.*` confers
          // every concrete finance permission, and the inviter must hold each of them.
          for (const permission of ALL_PERMISSIONS) {
            if (grantCovers(granted, permission) && !can(principal, permission, context)) {
              missing.add(permission);
            }
          }
        } else if (!can(principal, granted, context)) {
          missing.add(granted);
        }
      }
    }

    if (missing.size === 0) return;

    const escalating = [...missing].filter((permission) =>
      (PRIVILEGE_ESCALATING_PERMISSIONS as readonly string[]).includes(permission),
    );
    await this.securityEvents.record({
      eventType: 'permission_denied',
      severity: 'warning',
      userId: principal.userId,
      tenantId: principal.tenantId,
      detail: {
        reason: 'invitation_privilege_escalation',
        missingCount: missing.size,
        missing: [...missing].slice(0, 20),
        escalating,
      },
    });
    throw new ForbiddenError(
      'users.invite',
      'You cannot invite someone with permissions you do not hold yourself',
    );
  }

  private async revokePendingInvitations(
    tx: Transaction,
    recipient: { email: string | null; phone: string | null },
  ): Promise<void> {
    const matches = [
      recipient.email ? eq(authTokens.email, recipient.email) : null,
      recipient.phone ? eq(authTokens.phone, recipient.phone) : null,
    ].filter((c): c is NonNullable<typeof c> => c !== null);
    if (matches.length === 0) return;

    await tx
      .update(authTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(authTokens.purpose, 'invitation'),
          isNull(authTokens.usedAt),
          isNull(authTokens.revokedAt),
          or(...matches),
        ),
      );
  }

  private async insertInvitation(
    tx: Transaction,
    input: {
      tenantId: string;
      email: string | null;
      phone: string | null;
      payload: InvitationPayload;
      createdBy: string;
    },
  ): Promise<{ id: string; token: string; url: string; expiresAt: Date }> {
    const token = secureToken(32);
    const expiresAt = new Date(Date.now() + INVITATION_TTL_HOURS * 3600 * 1000);
    const [row] = await tx
      .insert(authTokens)
      .values({
        tenantId: input.tenantId,
        purpose: 'invitation',
        tokenHash: hashToken(token),
        email: input.email,
        phone: input.phone,
        payload: input.payload,
        expiresAt,
        createdBy: input.createdBy,
      })
      .returning({ id: authTokens.id });

    return {
      id: row!.id,
      token,
      url: `${env().WEB_APP_URL}/accept-invitation?token=${token}`,
      expiresAt,
    };
  }

  private async acceptUser(
    tx: Transaction,
    tenantId: string,
    payload: UserInvitationPayload,
    identity: AcceptIdentity,
  ): Promise<AcceptedInvitation> {
    // Roles are re-read at acceptance: a role archived between invite and accept must not
    // come back to life through a stale invitation.
    const roleRows = await tx
      .select({ id: roles.id, key: roles.key })
      .from(roles)
      .where(
        and(
          inArray(roles.id, payload.roleIds),
          eq(roles.tenantId, tenantId),
          isNull(roles.archivedAt),
        ),
      );
    if (roleRows.length === 0) {
      throw new ConflictError(
        'The roles attached to this invitation no longer exist. Ask for a new invitation.',
      );
    }

    const user = await this.createActivatedUser(tx, tenantId, identity, payload.invitedBy);

    for (const role of roleRows) {
      await tx.insert(userRoles).values({
        tenantId,
        userId: user.id,
        roleId: role.id,
        institutionId: payload.institutionId,
        createdBy: payload.invitedBy,
      });
    }

    return {
      kind: 'user',
      userId: user.id,
      tenantId,
      email: user.email,
      loginIdentifier: identity.email ?? identity.phone ?? user.email,
      roleKeys: roleRows.map((role) => role.key),
    };
  }

  private async acceptGuardian(
    tx: Transaction,
    tokenId: string,
    tenantId: string,
    payload: GuardianInvitationPayload,
    identity: AcceptIdentity,
  ): Promise<AcceptedInvitation> {
    const [guardianRole] = await tx
      .select({ id: roles.id, key: roles.key })
      .from(roles)
      .where(and(eq(roles.tenantId, tenantId), eq(roles.key, 'guardian'), isNull(roles.archivedAt)))
      .limit(1);
    if (!guardianRole) {
      throw new ConflictError('The guardian role is not configured for this school');
    }

    const user = await this.createActivatedUser(tx, tenantId, identity, payload.invitedBy);

    // Claim the guardian record. `user_id is null` makes a double-activation race lose
    // cleanly instead of silently re-pointing the record at a second account.
    const [claimed] = await tx
      .update(guardians)
      .set({ userId: user.id, updatedBy: payload.invitedBy })
      .where(
        and(
          eq(guardians.id, payload.guardianId),
          eq(guardians.tenantId, tenantId),
          isNull(guardians.userId),
          isNull(guardians.archivedAt),
        ),
      )
      .returning({ id: guardians.id });
    if (!claimed) {
      // Token id recorded so the trail shows which invitation hit the dead guardian.
      throw new ConflictError(
        'This guardian record can no longer be activated. Ask the school for a new invitation.',
        { tokenId },
      );
    }

    // Only the guardian role — never anything an invitation body could have smuggled in,
    // because guardian invitations carry no role field anywhere.
    await tx.insert(userRoles).values({
      tenantId,
      userId: user.id,
      roleId: guardianRole.id,
      institutionId: payload.institutionId,
      createdBy: payload.invitedBy,
    });

    return {
      kind: 'guardian',
      userId: user.id,
      tenantId,
      email: user.email,
      loginIdentifier: identity.phone ?? user.email,
      roleKeys: [guardianRole.key],
    };
  }

  private async createActivatedUser(
    tx: Transaction,
    tenantId: string,
    identity: AcceptIdentity,
    invitedBy: string,
  ): Promise<{ id: string; email: string }> {
    // `users.email` is NOT NULL. A phone-only invitee without an email of their own gets a
    // deterministic non-routable placeholder; login happens by phone number either way.
    const email =
      identity.email ??
      identity.bodyEmail ??
      `${(identity.phone ?? '').replace(/\D/g, '')}@phone-only.shikkha.invalid`;

    const [duplicate] = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.tenantId, tenantId),
          or(eq(users.email, email), ...(identity.phone ? [eq(users.phone, identity.phone)] : [])),
          isNull(users.archivedAt),
        ),
      )
      .limit(1);
    if (duplicate) {
      throw new ConflictError('An account with this email or phone number already exists');
    }

    const now = new Date();
    const [user] = await tx
      .insert(users)
      .values({
        tenantId,
        email,
        phone: identity.phone,
        passwordHash: identity.passwordHash,
        fullNameEn: identity.fullNameEn,
        fullNameBn: identity.fullNameBn ?? null,
        status: 'active',
        // The channel the single-use link was delivered to is verified by construction.
        emailVerifiedAt: identity.email ? now : null,
        phoneVerifiedAt: identity.phone && !identity.email ? now : null,
        credentialsChangedAt: now,
        createdBy: invitedBy,
      })
      .returning({ id: users.id, email: users.email });

    return user!;
  }

  private async deliverInvitation(input: {
    template: 'user_invitation' | 'guardian_invitation';
    email: string | null;
    phone: string | null;
    locale: string;
    recipientName: string;
    studentName?: string;
    tenantId: string;
    token: string;
  }): Promise<{ deliveredVia: 'email' | 'sms'; delivered: boolean }> {
    const schoolName = await this.tenantName(input.tenantId);
    const channel: 'email' | 'sms' = input.email ? 'email' : 'sms';
    const to = input.email ?? input.phone ?? '';
    const result = await this.notifications.send(channel, to, input.template, {
      locale: input.locale,
      recipientName: input.recipientName,
      schoolName,
      studentName: input.studentName,
      actionUrl: `${env().WEB_APP_URL}/accept-invitation?token=${input.token}`,
      expiresInText: input.locale === 'bn' ? '৭ দিনে' : 'in 7 days',
    });
    return { deliveredVia: channel, delivered: result.delivered };
  }

  private async recordRejectedToken(
    tx: Transaction,
    tokenHash: string,
    purpose: string,
  ): Promise<void> {
    // Diagnose *why* the claim failed — for the security log only, never for the client.
    const [row] = await tx
      .select({
        id: authTokens.id,
        userId: authTokens.userId,
        tenantId: authTokens.tenantId,
        usedAt: authTokens.usedAt,
        revokedAt: authTokens.revokedAt,
        expiresAt: authTokens.expiresAt,
      })
      .from(authTokens)
      .where(and(eq(authTokens.tokenHash, tokenHash), eq(authTokens.purpose, purpose)))
      .limit(1);

    const reason = !row
      ? 'unknown_token'
      : row.usedAt
        ? 'already_used'
        : row.revokedAt
          ? 'revoked'
          : row.expiresAt <= new Date()
            ? 'expired'
            : 'race_lost';

    await this.securityEvents.record({
      eventType: purpose === 'invitation' ? 'invitation_accepted' : 'password_reset_requested',
      severity: reason === 'already_used' ? 'warning' : 'info',
      userId: row?.userId ?? null,
      tenantId: row?.tenantId ?? null,
      detail: { outcome: 'rejected', reason, purpose },
    });
  }

  private async tenantName(tenantId: string): Promise<string | undefined> {
    return this.db.runAsPlatform(async (tx) => {
      const [org] = await tx
        .select({ nameEn: organizations.nameEn })
        .from(organizations)
        .where(eq(organizations.id, tenantId))
        .limit(1);
      return org?.nameEn;
    });
  }
}

interface AcceptIdentity {
  email: string | null;
  phone: string | null;
  passwordHash: string;
  fullNameEn: string;
  fullNameBn?: string;
  bodyEmail?: string;
}

interface AcceptedInvitation {
  kind: 'user' | 'guardian';
  userId: string;
  tenantId: string;
  email: string;
  loginIdentifier: string;
  roleKeys: string[];
}

type Transaction = Parameters<Parameters<DatabaseService['runInTenant']>[0]>[0];
