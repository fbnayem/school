/**
 * Audit and security logging.
 *
 * `audit_logs` is append-only. There is no update path in the application, and the first
 * migration revokes UPDATE and DELETE on the table from the application database role, so an
 * SQL-injection foothold or a careless service cannot rewrite history. Retention is handled by
 * a privileged archival job, not by the API.
 *
 * Two tables rather than one:
 *  - `audit_logs` — business actions on business resources, with before/after values.
 *  - `security_events` — authentication and authorization events, which have a different
 *    shape (no resource), a different retention period, and are written even when there is no
 *    authenticated user (a failed login has no user).
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  inet,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { auditActionEnum, primaryKeyColumn } from './_shared';
import { organizations } from './tenancy';

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: primaryKeyColumn(),
    /** Null for platform-level actions taken outside any tenant. */
    tenantId: uuid('tenant_id').references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id'),
    campusId: uuid('campus_id'),
    /**
     * The acting user. Deliberately *not* a foreign key: an audit record must survive the
     * deletion of the user it refers to, and a restrictive FK would block tenant offboarding
     * while a cascading one would destroy the trail.
     */
    actorUserId: uuid('actor_user_id'),
    actorEmail: varchar('actor_email', { length: 320 }),
    actorRoles: jsonb('actor_roles')
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Set when a platform admin is impersonating; records who really did it. */
    impersonatorUserId: uuid('impersonator_user_id'),
    action: auditActionEnum('action').notNull(),
    module: varchar('module', { length: 64 }).notNull(),
    resourceType: varchar('resource_type', { length: 64 }).notNull(),
    resourceId: uuid('resource_id'),
    /** Human-readable label captured at the time — the resource may be renamed later. */
    resourceLabel: varchar('resource_label', { length: 255 }),
    /**
     * Before and after values, with sensitive fields already redacted by the interceptor.
     * Passwords, tokens and MFA secrets never reach this table.
     */
    previousValue: jsonb('previous_value'),
    newValue: jsonb('new_value'),
    /** Required by policy for corrections: attendance edits, mark changes, refunds. */
    reason: text('reason'),
    requestId: varchar('request_id', { length: 64 }),
    ipAddress: inet('ip_address'),
    userAgent: varchar('user_agent', { length: 512 }),
    /** True when an AI tool initiated the action on a human's behalf (Phase 27+). */
    isAiInitiated: boolean('is_ai_initiated').notNull().default(false),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('audit_logs_tenant_occurred_idx').on(table.tenantId, table.occurredAt),
    index('audit_logs_resource_idx').on(table.resourceType, table.resourceId),
    index('audit_logs_actor_idx').on(table.actorUserId, table.occurredAt),
    index('audit_logs_module_idx').on(table.tenantId, table.module, table.occurredAt),
    index('audit_logs_request_idx').on(table.requestId),
  ],
);

export const securityEvents = pgTable(
  'security_events',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id'),
    userId: uuid('user_id'),
    /**
     * The identifier that was *attempted*. Recorded even when it matches no user, because
     * a spray of failed logins against non-existent accounts is exactly what needs detecting.
     */
    attemptedIdentifier: varchar('attempted_identifier', { length: 320 }),
    /**
     * 'login_success' | 'login_failed' | 'account_locked' | 'password_reset_requested' |
     * 'password_changed' | 'token_reuse_detected' | 'permission_denied' |
     * 'cross_tenant_attempt' | 'rate_limited' | 'mfa_challenge' | 'session_revoked'
     */
    eventType: varchar('event_type', { length: 48 }).notNull(),
    severity: varchar('severity', { length: 16 }).notNull().default('info'),
    detail: jsonb('detail')
      .notNull()
      .default(sql`'{}'::jsonb`),
    requestId: varchar('request_id', { length: 64 }),
    ipAddress: inet('ip_address'),
    userAgent: varchar('user_agent', { length: 512 }),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('security_events_type_occurred_idx').on(table.eventType, table.occurredAt),
    index('security_events_identifier_idx').on(table.attemptedIdentifier, table.occurredAt),
    index('security_events_ip_idx').on(table.ipAddress, table.occurredAt),
    index('security_events_user_idx').on(table.userId, table.occurredAt),
    index('security_events_severity_idx')
      .on(table.severity, table.occurredAt)
      .where(sql`${table.severity} IN ('warning', 'critical')`),
  ],
);
