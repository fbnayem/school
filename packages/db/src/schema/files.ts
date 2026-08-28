/**
 * File storage metadata.
 *
 * The bytes live in object storage (S3 in production, local filesystem in development —
 * ADR-010). This table is the authorization record for them: nothing is served from a public
 * URL, so retrieving a file means passing the same tenant and permission checks as any other
 * resource, and then receiving a short-lived signed URL.
 *
 * `storageKey` is namespaced by tenant, which means a bug in key construction cannot produce
 * a key that collides with another tenant's object.
 */

import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { actorColumns, archiveColumns, primaryKeyColumn, timestampColumns } from './_shared';
import { institutions, organizations } from './tenancy';

export const files = pgTable(
  'files',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id').references(() => institutions.id, {
      onDelete: 'set null',
    }),
    /** `tenants/{tenantId}/{category}/{uuid}.{ext}` — tenant-prefixed by construction. */
    storageKey: varchar('storage_key', { length: 512 }).notNull(),
    storageDriver: varchar('storage_driver', { length: 16 }).notNull().default('local'),
    originalFilename: varchar('original_filename', { length: 255 }).notNull(),
    /**
     * The MIME type the server determined by inspecting the bytes, not the one the client
     * claimed. A client-supplied content type is an assertion, not a fact.
     */
    mimeType: varchar('mime_type', { length: 128 }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    /** SHA-256 of the content. Enables deduplication and detects tampering. */
    checksum: varchar('checksum', { length: 64 }).notNull(),
    /** 'student_photo' | 'student_document' | 'employee_document' | 'assignment' | … */
    category: varchar('category', { length: 48 }).notNull(),
    /** What this file is attached to, for orphan cleanup and cascade authorization. */
    ownerType: varchar('owner_type', { length: 48 }),
    ownerId: uuid('owner_id'),
    /**
     * Files containing personal or medical data. Access requires an additional permission and
     * every read is audited.
     */
    isSensitive: boolean('is_sensitive').notNull().default(false),
    metadata: jsonb('metadata')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Set once the upload completes. Rows without it are cleaned up by a scheduled job. */
    uploadedAt: timestamp('uploaded_at', { withTimezone: true, mode: 'date' }),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('files_storage_key_key').on(table.storageKey),
    index('files_tenant_idx').on(table.tenantId),
    index('files_owner_idx').on(table.ownerType, table.ownerId),
    index('files_checksum_idx').on(table.tenantId, table.checksum),
    // Finds incomplete uploads for the cleanup job.
    index('files_pending_idx')
      .on(table.createdAt)
      .where(sql`${table.uploadedAt} IS NULL`),
  ],
);

export const filesRelations = relations(files, ({ one }) => ({
  organization: one(organizations, { fields: [files.tenantId], references: [organizations.id] }),
  institution: one(institutions, {
    fields: [files.institutionId],
    references: [institutions.id],
  }),
}));
