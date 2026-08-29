/**
 * Tenant-isolated knowledge base (Phase 31, docs/06 §5).
 *
 * The retrieval corpus for the copilot and the tutor: a school's policies, handbook,
 * syllabus, notices and admission rules, chunked and embedded.
 *
 * The one decision that shapes everything here is that **the embeddings live in this
 * database**, under the same forced `tenant_isolation` policy as every other row. A separate
 * vector service would be a second tenant-isolation implementation to get right and to keep
 * right, and there is no reason to have two. See the header of `0033_knowledge_base.sql`.
 *
 * Four properties this schema carries:
 *
 *  1. **Audience visibility is data.** `knowledgeCollections.visibleToAudiences` lists the
 *     role audiences allowed to retrieve from a collection, using the same vocabulary as
 *     `roles.audience`. A staff handbook is simply not in the candidate set for a student's
 *     tutor session — the filter is in the SQL, never applied to results afterwards.
 *  2. **Chunks are append-only per document version.** A re-ingestion archives the previous
 *     version's chunks and writes new ones, so a citation issued last month still resolves to
 *     the text that was actually retrieved then.
 *  3. **The embedding dimension is fixed at 1536 in the column type**, matching the default
 *     `AI_EMBEDDING_DIMENSIONS`. A different embedding model does not need a wider column —
 *     it needs every vector re-computed, because the old ones live in a different space. That
 *     is a re-embed migration, never an `alter column`.
 *  4. **The embedding cache is scoped to an institution**, not to a content hash alone. A
 *     hash is a global fact; a cache keyed only on it would let one tenant confirm, by
 *     hashing a guess, that another tenant holds exactly that confidential text.
 */

import { relations, sql } from 'drizzle-orm';
import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  vector,
} from 'drizzle-orm/pg-core';
import {
  actorColumns,
  archiveColumns,
  primaryKeyColumn,
  timestampColumns,
  versionColumn,
} from './_shared';
import { institutions, organizations } from './tenancy';
import { files } from './files';

/**
 * The embedding dimension, as a value the application can assert against.
 *
 * It is duplicated as a literal in the column definition below and in the migration because
 * pgvector requires a literal there; this constant is what the ingestion service compares the
 * provider's reported dimension to, so a model swap fails loudly at ingest rather than
 * producing a Postgres "expected 1536 dimensions" error deep inside a batch insert.
 */
export const KNOWLEDGE_EMBEDDING_DIMENSIONS = 1536;

// ─────────────────────────────────────────────────────────────────────────────────────
// Enumerations
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Who may retrieve from a collection.
 *
 * Mirrors `roles.audience` value for value on purpose: the caller's audiences are read from
 * their own roles, so an identity mapping means there is no translation table between the two
 * vocabularies for anyone to get wrong, and no audience that has no home here.
 */
export const knowledgeAudienceEnum = pgEnum('knowledge_audience', [
  'staff',
  'teaching',
  'student',
  'guardian',
  'external',
]);

export const knowledgeSourceKindEnum = pgEnum('knowledge_source_kind', ['upload', 'url', 'text']);

/**
 * The ingestion pipeline's stages, stored rather than inferred. A document stuck in
 * `extracting` is visible as a problem; a document that is merely absent from search results
 * is indistinguishable from one nobody uploaded.
 */
export const knowledgeDocumentStatusEnum = pgEnum('knowledge_document_status', [
  'pending',
  'extracting',
  'chunking',
  'embedding',
  'ready',
  'failed',
]);

// ─────────────────────────────────────────────────────────────────────────────────────
// Tables
// ─────────────────────────────────────────────────────────────────────────────────────

export const knowledgeCollections = pgTable(
  'knowledge_collections',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    /** Stable handle used in URLs and by the ai-tools module; unique per institution. */
    slug: varchar('slug', { length: 64 }).notNull(),
    nameEn: varchar('name_en', { length: 160 }).notNull(),
    nameBn: varchar('name_bn', { length: 160 }),
    description: varchar('description', { length: 1000 }),
    /**
     * At least one audience, enforced by a check constraint. An array rather than a single
     * value because a syllabus is legitimately for teachers *and* students while a staff
     * handbook is for neither.
     */
    visibleToAudiences: knowledgeAudienceEnum('visible_to_audiences')
      .array()
      .notNull()
      .default(sql`array['staff']::public.knowledge_audience[]`),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('knowledge_collections_institution_slug_key')
      .on(table.institutionId, table.slug)
      .where(sql`${table.archivedAt} IS NULL`),
    index('knowledge_collections_tenant_idx').on(table.tenantId),
    index('knowledge_collections_audience_idx').using('gin', table.visibleToAudiences),
  ],
);

export const knowledgeDocuments = pgTable(
  'knowledge_documents',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => knowledgeCollections.id, { onDelete: 'restrict' }),
    title: varchar('title', { length: 300 }).notNull(),
    sourceKind: knowledgeSourceKindEnum('source_kind').notNull(),
    /**
     * The object-storage key produced by `StorageService.put` (tenant-prefixed there, never
     * here). Denormalised alongside `fileId` so a re-ingestion can fetch the bytes without a
     * join; `fileId` stays the authorization record and the row the orphan sweeper reads.
     */
    storageObjectKey: varchar('storage_object_key', { length: 512 }),
    fileId: uuid('file_id').references(() => files.id, { onDelete: 'set null' }),
    sourceUrl: varchar('source_url', { length: 2000 }),
    /**
     * SHA-256 of the EXTRACTED TEXT, not of the uploaded bytes: the same policy uploaded as
     * `.txt` and as `.md` is the same content to embed, and re-ingesting it should cost
     * nothing.
     */
    contentHash: varchar('content_hash', { length: 64 }).notNull(),
    byteSize: integer('byte_size'),
    language: varchar('language', { length: 16 }),
    status: knowledgeDocumentStatusEnum('status').notNull().default('pending'),
    /** Never null when `status` is `failed` — a check constraint says so. */
    failureReason: varchar('failure_reason', { length: 1000 }),
    /** Incremented on every successful re-ingestion; chunks are append-only per version. */
    contentVersion: integer('content_version').notNull().default(1),
    chunkCount: integer('chunk_count').notNull().default(0),
    tokenCount: integer('token_count').notNull().default(0),
    ingestedAt: timestamp('ingested_at', { withTimezone: true, mode: 'date' }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('knowledge_documents_tenant_idx').on(table.tenantId),
    index('knowledge_documents_collection_idx').on(table.collectionId, table.status),
    index('knowledge_documents_institution_status_idx').on(table.institutionId, table.status),
    index('knowledge_documents_content_hash_idx').on(table.institutionId, table.contentHash),
  ],
);

export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    /**
     * Denormalised from the document. Search filters by collection (that is where the
     * audience check lands) and orders by vector distance in one statement; carrying the
     * collection here keeps that a single index-qualified scan rather than a join the planner
     * has to push a vector ordering through. Safe to denormalise: a chunk never moves between
     * documents.
     */
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => knowledgeCollections.id, { onDelete: 'restrict' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: 'restrict' }),
    documentVersion: integer('document_version').notNull().default(1),
    seq: integer('seq').notNull(),
    content: text('content').notNull(),
    /** SHA-256 of `content` — the embedding cache's lookup key. */
    contentHash: varchar('content_hash', { length: 64 }).notNull(),
    /**
     * An ESTIMATE from the chunker, used only to budget chunk sizes. Authoritative token
     * counts for cost attribution come from the provider's usage response and land in
     * `ai_usage_events`, not here.
     */
    tokenCount: integer('token_count').notNull(),
    /** Null until the embedding stage completes. Paired with `embeddingModel` by a check. */
    embedding: vector('embedding', { dimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS }),
    embeddingModel: varchar('embedding_model', { length: 128 }),
    /** Citation anchors, in the coordinates of the extracted text. */
    charFrom: integer('char_from').notNull(),
    charTo: integer('char_to').notNull(),
    pageFrom: integer('page_from'),
    pageTo: integer('page_to'),
    /** "Admissions › Fees › Refunds" — so a citation can name the section, not just a span. */
    headingPath: varchar('heading_path', { length: 500 }),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('knowledge_chunks_document_version_seq_key').on(
      table.documentId,
      table.documentVersion,
      table.seq,
    ),
    index('knowledge_chunks_tenant_idx').on(table.tenantId),
    index('knowledge_chunks_live_idx')
      .on(table.institutionId, table.collectionId)
      .where(sql`${table.archivedAt} IS NULL`),
    index('knowledge_chunks_content_hash_idx').on(table.tenantId, table.contentHash),
    /**
     * HNSW over cosine distance. The tradeoff against IVFFlat is argued at length in the
     * migration; the short version is that IVFFlat's `lists` parameter has to track the row
     * count and cannot be chosen on an empty table, and every tenant's corpus starts empty.
     */
    index('knowledge_chunks_embedding_hnsw_idx').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops'),
    ),
  ],
);

export const knowledgeEmbeddingCache = pgTable(
  'knowledge_embedding_cache',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /**
     * Scoped to an institution, not to the content hash alone.
     *
     * A hash is a global fact — the same paragraph hashes identically everywhere — so a cache
     * keyed only on it would be reachable across tenants and would act as an oracle: hash a
     * guess at another school's confidential admission policy, observe a hit, and you have
     * confirmed they hold exactly that text. The provider call saved is not worth that.
     */
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    contentHash: varchar('content_hash', { length: 64 }).notNull(),
    model: varchar('model', { length: 128 }).notNull(),
    dimensions: integer('dimensions').notNull(),
    embedding: vector('embedding', { dimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS }).notNull(),
    hitCount: integer('hit_count').notNull().default(0),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('knowledge_embedding_cache_lookup_key').on(
      table.institutionId,
      table.model,
      table.contentHash,
    ),
    index('knowledge_embedding_cache_tenant_idx').on(table.tenantId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Relations
// ─────────────────────────────────────────────────────────────────────────────────────

export const knowledgeCollectionsRelations = relations(knowledgeCollections, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [knowledgeCollections.tenantId],
    references: [organizations.id],
  }),
  institution: one(institutions, {
    fields: [knowledgeCollections.institutionId],
    references: [institutions.id],
  }),
  documents: many(knowledgeDocuments),
}));

export const knowledgeDocumentsRelations = relations(knowledgeDocuments, ({ one, many }) => ({
  collection: one(knowledgeCollections, {
    fields: [knowledgeDocuments.collectionId],
    references: [knowledgeCollections.id],
  }),
  file: one(files, { fields: [knowledgeDocuments.fileId], references: [files.id] }),
  chunks: many(knowledgeChunks),
}));

export const knowledgeChunksRelations = relations(knowledgeChunks, ({ one }) => ({
  document: one(knowledgeDocuments, {
    fields: [knowledgeChunks.documentId],
    references: [knowledgeDocuments.id],
  }),
  collection: one(knowledgeCollections, {
    fields: [knowledgeChunks.collectionId],
    references: [knowledgeCollections.id],
  }),
}));
