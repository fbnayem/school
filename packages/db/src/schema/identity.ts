/**
 * Identity and access: users, roles, role assignments, sessions, invitations.
 *
 * Design notes that matter for security:
 *
 *  - A user belongs to exactly one tenant. Platform staff have `tenant_id = NULL` and the
 *    `is_platform_admin` flag; they are the only rows that cross tenants, and every action
 *    they take is audited.
 *  - Email uniqueness is *per tenant*, not global. The same parent may legitimately have an
 *    account at two different schools on the platform.
 *  - Refresh tokens are stored as SHA-256 hashes. A database read yields nothing usable.
 *  - Password reset and invitation tokens are likewise stored hashed, single-use, and
 *    time-limited.
 */

import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  actorColumns,
  archiveColumns,
  primaryKeyColumn,
  timestampColumns,
  userStatusEnum,
  versionColumn,
} from './_shared';
import { campuses, institutions, organizations } from './tenancy';

export const users = pgTable(
  'users',
  {
    id: primaryKeyColumn(),
    /**
     * Null for platform staff only. Every other row is tenant-scoped and subject to RLS.
     */
    tenantId: uuid('tenant_id').references(() => organizations.id, { onDelete: 'restrict' }),
    email: varchar('email', { length: 320 }).notNull(),
    /** E.164. Doubles as a login identifier — many Bangladeshi parents have no email. */
    phone: varchar('phone', { length: 20 }),
    /** Argon2id encoded hash. Null while a user is invited but has not set a password. */
    passwordHash: text('password_hash'),
    fullNameEn: varchar('full_name_en', { length: 255 }).notNull(),
    fullNameBn: varchar('full_name_bn', { length: 255 }),
    avatarFileId: uuid('avatar_file_id'),
    locale: varchar('locale', { length: 5 }).notNull().default('en'),
    status: userStatusEnum('status').notNull().default('invited'),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true, mode: 'date' }),
    phoneVerifiedAt: timestamp('phone_verified_at', { withTimezone: true, mode: 'date' }),
    /**
     * The one place a boolean substitutes for a permission (ADR-005). It is the bootstrap
     * identity that grants a brand-new tenant its first roles.
     */
    isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
    /** MFA-ready: columns exist from Phase 1 so enabling it later is not a migration risk. */
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    mfaSecret: text('mfa_secret'),
    mfaRecoveryCodes: jsonb('mfa_recovery_codes'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),
    lastLoginIp: inet('last_login_ip'),
    /** Brute-force containment. Reset on a successful login. */
    failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true, mode: 'date' }),
    /**
     * Bumped on password change, role change, or forced logout. Any access token issued
     * before this instant is rejected, which is how "log out everywhere" takes effect
     * without waiting for the 15-minute token TTL.
     */
    credentialsChangedAt: timestamp('credentials_changed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    preferences: jsonb('preferences')
      .notNull()
      .default(sql`'{}'::jsonb`),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    // Per-tenant uniqueness: the same parent may have accounts at two schools.
    uniqueIndex('users_tenant_email_key')
      .on(table.tenantId, table.email)
      .where(sql`${table.archivedAt} IS NULL AND ${table.tenantId} IS NOT NULL`),
    // Platform staff have no tenant, so they need their own global constraint.
    uniqueIndex('users_platform_email_key')
      .on(table.email)
      .where(sql`${table.archivedAt} IS NULL AND ${table.tenantId} IS NULL`),
    uniqueIndex('users_tenant_phone_key')
      .on(table.tenantId, table.phone)
      .where(sql`${table.phone} IS NOT NULL AND ${table.archivedAt} IS NULL`),
    index('users_tenant_idx').on(table.tenantId),
    index('users_status_idx').on(table.tenantId, table.status),
  ],
);

/**
 * Roles. Seeded from the system presets, then owned and editable by the tenant.
 *
 * `isSystem` marks a seeded preset: it can be cloned and its permissions edited, but it
 * cannot be deleted, because deleting the `guardian` role would orphan every parent account.
 */
export const roles = pgTable(
  'roles',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 64 }).notNull(),
    nameEn: varchar('name_en', { length: 128 }).notNull(),
    nameBn: varchar('name_bn', { length: 128 }),
    description: text('description'),
    /** Permission strings, possibly with trailing wildcards. Validated against the catalogue. */
    permissions: jsonb('permissions')
      .notNull()
      .default(sql`'[]'::jsonb`),
    audience: varchar('audience', { length: 16 }).notNull().default('staff'),
    isSystem: boolean('is_system').notNull().default(false),
    /** Grants of this role are always audited and confirmed in the UI. */
    isSensitive: boolean('is_sensitive').notNull().default(false),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('roles_tenant_key_key')
      .on(table.tenantId, table.key)
      .where(sql`${table.archivedAt} IS NULL`),
    index('roles_tenant_idx').on(table.tenantId),
  ],
);

/**
 * A role granted to a user, optionally narrowed to an institution and campus.
 *
 * Null `institutionId` means the grant applies tenant-wide — appropriate for an owner or
 * chairman of a school group, and deliberately awkward to set for anyone else.
 */
export const userRoles = pgTable(
  'user_roles',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id').references(() => institutions.id, {
      onDelete: 'cascade',
    }),
    campusId: uuid('campus_id').references(() => campuses.id, { onDelete: 'cascade' }),
    /** Temporary grants — an acting principal during leave, an external auditor's window. */
    validFrom: timestamp('valid_from', { withTimezone: true, mode: 'date' }),
    validUntil: timestamp('valid_until', { withTimezone: true, mode: 'date' }),
    ...timestampColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('user_roles_unique_scope_key')
      .on(table.userId, table.roleId, table.institutionId, table.campusId)
      .where(sql`${table.institutionId} IS NOT NULL AND ${table.campusId} IS NOT NULL`),
    uniqueIndex('user_roles_unique_institution_key')
      .on(table.userId, table.roleId, table.institutionId)
      .where(sql`${table.institutionId} IS NOT NULL AND ${table.campusId} IS NULL`),
    uniqueIndex('user_roles_unique_tenant_key')
      .on(table.userId, table.roleId)
      .where(sql`${table.institutionId} IS NULL`),
    index('user_roles_user_idx').on(table.userId),
    index('user_roles_tenant_idx').on(table.tenantId),
  ],
);

/**
 * A refresh-token session.
 *
 * `tokenHash` is SHA-256 of the opaque refresh token — the token itself is never stored.
 * Rotation replaces the row's hash and bumps `rotationCount`; presenting a hash that has
 * already been rotated is token *reuse*, which revokes the whole family (ADR-007).
 */
export const sessions = pgTable(
  'sessions',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id').references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 hex of the current refresh token. */
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    /** Shared by every rotation of one login, so reuse detection can revoke the family. */
    familyId: uuid('family_id').notNull(),
    rotationCount: integer('rotation_count').notNull().default(0),
    userAgent: varchar('user_agent', { length: 512 }),
    ipAddress: inet('ip_address'),
    /** Free-form device label shown in "your active sessions". */
    deviceLabel: varchar('device_label', { length: 128 }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    revokedReason: varchar('revoked_reason', { length: 64 }),
    ...timestampColumns(),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_key').on(table.tokenHash),
    index('sessions_user_idx').on(table.userId),
    index('sessions_family_idx').on(table.familyId),
    // Supports the cleanup job without scanning the table.
    index('sessions_expiry_idx')
      .on(table.expiresAt)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);

/**
 * Single-use, time-limited tokens: invitations, password resets, email/phone verification.
 *
 * One table rather than three, because the security properties are identical and three
 * near-identical tables means three chances to forget the `usedAt` check.
 */
export const authTokens = pgTable(
  'auth_tokens',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id').references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    /** 'invitation' | 'password_reset' | 'email_verification' | 'phone_verification' */
    purpose: varchar('purpose', { length: 32 }).notNull(),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    /** For invitations sent before a user row exists. */
    email: varchar('email', { length: 320 }),
    phone: varchar('phone', { length: 20 }),
    /** Roles to grant when an invitation is accepted. */
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    attempts: integer('attempts').notNull().default(0),
    ...timestampColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('auth_tokens_hash_key').on(table.tokenHash),
    index('auth_tokens_user_purpose_idx').on(table.userId, table.purpose),
    index('auth_tokens_expiry_idx')
      .on(table.expiresAt)
      .where(sql`${table.usedAt} IS NULL`),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [users.tenantId],
    references: [organizations.id],
  }),
  roles: many(userRoles),
  sessions: many(sessions),
}));

export const rolesRelations = relations(roles, ({ one, many }) => ({
  organization: one(organizations, { fields: [roles.tenantId], references: [organizations.id] }),
  assignments: many(userRoles),
}));

export const userRolesRelations = relations(userRoles, ({ one }) => ({
  user: one(users, { fields: [userRoles.userId], references: [users.id] }),
  role: one(roles, { fields: [userRoles.roleId], references: [roles.id] }),
  institution: one(institutions, {
    fields: [userRoles.institutionId],
    references: [institutions.id],
  }),
  campus: one(campuses, { fields: [userRoles.campusId], references: [campuses.id] }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));
