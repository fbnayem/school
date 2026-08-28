/**
 * Tenancy: organization → institution → campus.
 *
 * `organizations.id` is the tenant boundary and is referenced as `tenant_id` by every
 * business table in the system. Institution and campus are *scopes within* a tenant, not
 * tenants themselves — a school group's owner legitimately sees several institutions, so
 * institution filtering is an authorization concern, while tenant filtering is a hard
 * isolation concern enforced by RLS.
 */

import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
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
  institutionTypeEnum,
  instructionMediumEnum,
  primaryKeyColumn,
  timestampColumns,
  versionColumn,
} from './_shared';

/**
 * The tenant. One row per paying customer, whether that is a single school or a group
 * operating twenty of them.
 */
export const organizations = pgTable(
  'organizations',
  {
    id: primaryKeyColumn(),
    /** URL-safe identifier used for tenant-specific login pages and subdomains. */
    slug: varchar('slug', { length: 63 }).notNull(),
    nameEn: varchar('name_en', { length: 255 }).notNull(),
    nameBn: varchar('name_bn', { length: 255 }),
    contactEmail: varchar('contact_email', { length: 320 }).notNull(),
    contactPhone: varchar('contact_phone', { length: 20 }),
    /** IANA timezone. Defaulted to Dhaka but stored, not assumed, so the model travels. */
    timezone: varchar('timezone', { length: 64 }).notNull().default('Asia/Dhaka'),
    defaultLocale: varchar('default_locale', { length: 5 }).notNull().default('en'),
    currency: varchar('currency', { length: 3 }).notNull().default('BDT'),
    /** Tenant-wide settings. Schema-validated in the application, not by the database. */
    settings: jsonb('settings')
      .notNull()
      .default(sql`'{}'::jsonb`),
    isActive: boolean('is_active').notNull().default(true),
    /** Set when a trial or subscription lapses; blocks login without destroying data. */
    suspendedAt: timestamp('suspended_at', { withTimezone: true, mode: 'date' }),
    suspensionReason: varchar('suspension_reason', { length: 500 }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('organizations_slug_key')
      .on(table.slug)
      .where(sql`${table.archivedAt} IS NULL`),
    index('organizations_active_idx').on(table.isActive),
  ],
);

/**
 * A school. Has a type and a medium of instruction, because Bangla-medium, English-version
 * and English-medium are genuinely different products sharing one platform.
 */
export const institutions = pgTable(
  'institutions',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    code: varchar('code', { length: 32 }).notNull(),
    nameEn: varchar('name_en', { length: 255 }).notNull(),
    nameBn: varchar('name_bn', { length: 255 }),
    type: institutionTypeEnum('type').notNull().default('school'),
    medium: instructionMediumEnum('medium').notNull().default('bangla'),
    /** EIIN — the Ministry of Education's institution identifier. Unique nationally. */
    eiin: varchar('eiin', { length: 12 }),
    /** Education board the institution is registered with, when applicable. */
    educationBoard: varchar('education_board', { length: 32 }),
    establishedYear: integer('established_year'),
    addressLine1: varchar('address_line1', { length: 255 }),
    addressLine2: varchar('address_line2', { length: 255 }),
    district: varchar('district', { length: 64 }),
    division: varchar('division', { length: 32 }),
    postcode: varchar('postcode', { length: 10 }),
    phone: varchar('phone', { length: 20 }),
    email: varchar('email', { length: 320 }),
    website: varchar('website', { length: 255 }),
    logoFileId: uuid('logo_file_id'),
    settings: jsonb('settings')
      .notNull()
      .default(sql`'{}'::jsonb`),
    isActive: boolean('is_active').notNull().default(true),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('institutions_tenant_code_key')
      .on(table.tenantId, table.code)
      .where(sql`${table.archivedAt} IS NULL`),
    index('institutions_tenant_idx').on(table.tenantId),
    // EIIN is nationally unique, but only among live institutions.
    uniqueIndex('institutions_eiin_key')
      .on(table.eiin)
      .where(sql`${table.eiin} IS NOT NULL AND ${table.archivedAt} IS NULL`),
  ],
);

/** A physical site. Single-campus schools get exactly one, created automatically. */
export const campuses = pgTable(
  'campuses',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    code: varchar('code', { length: 32 }).notNull(),
    nameEn: varchar('name_en', { length: 255 }).notNull(),
    nameBn: varchar('name_bn', { length: 255 }),
    /** Exactly one campus per institution carries this; enforced by a partial unique index. */
    isPrimary: boolean('is_primary').notNull().default(false),
    addressLine1: varchar('address_line1', { length: 255 }),
    district: varchar('district', { length: 64 }),
    division: varchar('division', { length: 32 }),
    phone: varchar('phone', { length: 20 }),
    /** Coordinates for transport routing. Nullable — most schools will not fill these in. */
    latitude: varchar('latitude', { length: 24 }),
    longitude: varchar('longitude', { length: 24 }),
    isActive: boolean('is_active').notNull().default(true),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('campuses_institution_code_key')
      .on(table.institutionId, table.code)
      .where(sql`${table.archivedAt} IS NULL`),
    uniqueIndex('campuses_primary_key')
      .on(table.institutionId)
      .where(sql`${table.isPrimary} AND ${table.archivedAt} IS NULL`),
    index('campuses_tenant_idx').on(table.tenantId),
    index('campuses_institution_idx').on(table.institutionId),
  ],
);

/**
 * Subscription plans, defined by the platform rather than per tenant.
 * Limits are enforced in the application; they live here so a plan change does not need a deploy.
 */
export const plans = pgTable(
  'plans',
  {
    id: primaryKeyColumn(),
    key: varchar('key', { length: 64 }).notNull(),
    nameEn: varchar('name_en', { length: 128 }).notNull(),
    nameBn: varchar('name_bn', { length: 128 }),
    description: text('description'),
    /** Monthly price in the platform currency. `numeric` — never a float (ADR-004). */
    monthlyPrice: varchar('monthly_price', { length: 20 }).notNull().default('0.00'),
    /** Hard caps. Null means unlimited. */
    maxStudents: integer('max_students'),
    maxInstitutions: integer('max_institutions'),
    maxStaff: integer('max_staff'),
    maxStorageMb: integer('max_storage_mb'),
    /** Feature keys included in this plan. Checked by the feature-flag service. */
    features: jsonb('features')
      .notNull()
      .default(sql`'[]'::jsonb`),
    isPublic: boolean('is_public').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestampColumns(),
    ...archiveColumns(),
  },
  (table) => [uniqueIndex('plans_key_key').on(table.key)],
);

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'restrict' }),
    status: varchar('status', { length: 32 }).notNull().default('trialing'),
    startsAt: timestamp('starts_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    endsAt: timestamp('ends_at', { withTimezone: true, mode: 'date' }),
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true, mode: 'date' }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
    /** Per-tenant overrides on top of the plan, for negotiated deals. */
    limitOverrides: jsonb('limit_overrides')
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...timestampColumns(),
    ...actorColumns(),
  },
  (table) => [
    // One live subscription per tenant. A tenant may have historical rows.
    uniqueIndex('subscriptions_tenant_active_key')
      .on(table.tenantId)
      .where(sql`${table.status} IN ('trialing', 'active', 'past_due')`),
    index('subscriptions_tenant_idx').on(table.tenantId),
  ],
);

/**
 * Feature flags.
 *
 * Resolution order, most specific first: institution override → tenant override → plan
 * feature list → global default. Resolved in the application so the precedence is testable.
 */
export const featureFlags = pgTable(
  'feature_flags',
  {
    id: primaryKeyColumn(),
    key: varchar('key', { length: 96 }).notNull(),
    description: text('description'),
    /** Default when no tenant or institution override exists. */
    defaultEnabled: boolean('default_enabled').notNull().default(false),
    ...timestampColumns(),
  },
  (table) => [uniqueIndex('feature_flags_key_key').on(table.key)],
);

export const featureFlagOverrides = pgTable(
  'feature_flag_overrides',
  {
    id: primaryKeyColumn(),
    flagKey: varchar('flag_key', { length: 96 }).notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Null means the override applies to the whole tenant. */
    institutionId: uuid('institution_id').references(() => institutions.id, {
      onDelete: 'cascade',
    }),
    enabled: boolean('enabled').notNull(),
    note: varchar('note', { length: 500 }),
    ...timestampColumns(),
    ...actorColumns(),
  },
  (table) => [
    // A tenant-wide override and an institution override can coexist; two of the same cannot.
    uniqueIndex('feature_flag_overrides_scope_key')
      .on(table.flagKey, table.tenantId, table.institutionId)
      .where(sql`${table.institutionId} IS NOT NULL`),
    uniqueIndex('feature_flag_overrides_tenant_key')
      .on(table.flagKey, table.tenantId)
      .where(sql`${table.institutionId} IS NULL`),
    index('feature_flag_overrides_tenant_idx').on(table.tenantId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────

export const organizationsRelations = relations(organizations, ({ many }) => ({
  institutions: many(institutions),
  campuses: many(campuses),
  subscriptions: many(subscriptions),
}));

export const institutionsRelations = relations(institutions, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [institutions.tenantId],
    references: [organizations.id],
  }),
  campuses: many(campuses),
}));

export const campusesRelations = relations(campuses, ({ one }) => ({
  organization: one(organizations, {
    fields: [campuses.tenantId],
    references: [organizations.id],
  }),
  institution: one(institutions, {
    fields: [campuses.institutionId],
    references: [institutions.id],
  }),
}));

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
  organization: one(organizations, {
    fields: [subscriptions.tenantId],
    references: [organizations.id],
  }),
  plan: one(plans, { fields: [subscriptions.planId], references: [plans.id] }),
}));
