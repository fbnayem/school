/**
 * Column conventions shared by every table.
 *
 * Applying these consistently is what makes tenant isolation, soft archiving and optimistic
 * locking properties of the *schema* rather than habits individual developers have to
 * remember. A table that skips `tenantColumns` will not pass the schema conformance test in
 * `test/schema-conformance.spec.ts`.
 */

import { sql } from 'drizzle-orm';
import { integer, pgEnum, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@shikkha/shared';

/**
 * Primary key. UUIDv7 generated in the application (ADR: see `packages/shared/src/ids.ts`)
 * so it is time-ordered for index locality without leaking row counts.
 *
 * A database-side default is also set, so a row inserted by a migration or a DBA still gets
 * a valid key. `gen_random_uuid()` (v4) is used there because `uuidv7()` is only built in from
 * PostgreSQL 18 and the container image may be older; application inserts always supply v7.
 */
export const primaryKeyColumn = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7())
    .default(sql`gen_random_uuid()`);

/** Audit timestamps present on every table. */
export const timestampColumns = () => ({
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

/**
 * Soft archive. Institutional records are never hard-deleted (ADR-008).
 *
 * `archivedAt` is nullable and every uniqueness constraint on a business table is a partial
 * index `WHERE archived_at IS NULL`, so an archived student's roll number becomes reusable
 * while the record itself is preserved.
 */
export const archiveColumns = () => ({
  archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'date' }),
  archivedBy: uuid('archived_by'),
  archiveReason: varchar('archive_reason', { length: 500 }),
});

/**
 * Optimistic locking.
 *
 * Two teachers correcting the same attendance record, or two clerks editing one student, must
 * not silently overwrite each other. Updates carry the version they read; a mismatch is a 409
 * rather than a lost write.
 */
export const versionColumn = () => integer('version').notNull().default(1);

/** Who did it. Nullable because system and migration actions have no user. */
export const actorColumns = () => ({
  createdBy: uuid('created_by'),
  updatedBy: uuid('updated_by'),
});

// ─────────────────────────────────────────────────────────────────────────────────────
// Enumerations
//
// Postgres enums are used where the value set is genuinely closed and changes require a
// migration anyway. Where a school must be able to add its own values (fee categories,
// document types, incident categories), a lookup table is used instead — an enum would make
// a tenant-level configuration change a schema change.
// ─────────────────────────────────────────────────────────────────────────────────────

export const institutionTypeEnum = pgEnum('institution_type', [
  'school',
  'college',
  'school_and_college',
  'madrasah',
  'coaching_center',
  'training_institute',
  'university',
]);

export const instructionMediumEnum = pgEnum('instruction_medium', [
  'bangla',
  'english_version',
  'english_medium',
]);

export const shiftKindEnum = pgEnum('shift_kind', ['morning', 'day', 'evening', 'single']);

export const genderEnum = pgEnum('gender', ['male', 'female', 'other', 'undisclosed']);

export const bloodGroupEnum = pgEnum('blood_group', [
  'A+',
  'A-',
  'B+',
  'B-',
  'AB+',
  'AB-',
  'O+',
  'O-',
]);

export const religionEnum = pgEnum('religion', [
  'islam',
  'hinduism',
  'buddhism',
  'christianity',
  'other',
]);

export const studentStatusEnum = pgEnum('student_status', [
  'active',
  'on_leave',
  'transferred',
  'withdrawn',
  'graduated',
  'alumni',
  'archived',
]);

export const enrollmentStatusEnum = pgEnum('enrollment_status', [
  'active',
  'completed',
  'promoted',
  'repeated',
  'transferred_out',
  'withdrawn',
  'cancelled',
]);

export const guardianRelationEnum = pgEnum('guardian_relation', [
  'father',
  'mother',
  'brother',
  'sister',
  'uncle',
  'aunt',
  'grandfather',
  'grandmother',
  'legal_guardian',
  'other',
]);

export const employmentStatusEnum = pgEnum('employment_status', [
  'active',
  'probation',
  'on_leave',
  'suspended',
  'resigned',
  'terminated',
  'retired',
]);

export const userStatusEnum = pgEnum('user_status', [
  'invited',
  'active',
  'suspended',
  'deactivated',
]);

export const academicYearStatusEnum = pgEnum('academic_year_status', [
  'planning',
  'active',
  'completed',
  'archived',
]);

export const auditActionEnum = pgEnum('audit_action', [
  'create',
  'update',
  'archive',
  'restore',
  'approve',
  'reject',
  'publish',
  'unpublish',
  'login',
  'logout',
  'login_failed',
  'password_reset',
  'permission_change',
  'export',
  'import',
  'payment',
  'refund',
  'ai_action',
  'impersonate',
]);
