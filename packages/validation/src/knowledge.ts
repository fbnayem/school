/**
 * Knowledge base schemas (Phase 31, docs/06 §5).
 *
 * Three rules shape every schema in this file:
 *
 *  - **A client never states a derived fact.** There is no `status`, `chunkCount`,
 *    `tokenCount`, `contentHash`, `contentVersion` or `ingestedAt` on any input. Those are
 *    produced by the ingestion pipeline; accepting them from a client would let a caller
 *    declare a document `ready` that was never embedded.
 *  - **Everything a `POST /knowledge/documents` sends survives multipart.** That route takes
 *    either a file or a block of text, so every scalar arrives as a string and every schema
 *    here coerces rather than assuming JSON types.
 *  - **Audience visibility is explicit.** `visibleToAudiences` has no default at the API
 *    boundary even though the column has one: who may retrieve a collection is a decision
 *    somebody must make in writing, not one that happens by omission.
 *
 * Constants carry a `KNOWLEDGE_` prefix because `@shikkha/validation` re-exports flat.
 */

import { z } from 'zod';
import { paginationSchema, reasonSchema, searchSchema, sortSchema, uuidSchema } from './common';

// ── Value sets, mirrored from the database enums ─────────────────────────────────────

/**
 * The audiences a collection can be made visible to.
 *
 * Deliberately the same vocabulary as `roles.audience`, because the caller's audiences are
 * read from their own roles and compared directly. An identity mapping means there is no
 * translation step to get wrong.
 */
export const KNOWLEDGE_AUDIENCES = ['staff', 'teaching', 'student', 'guardian', 'external'] as const;

export const KNOWLEDGE_SOURCE_KINDS = ['upload', 'url', 'text'] as const;

export const KNOWLEDGE_DOCUMENT_STATUSES = [
  'pending',
  'extracting',
  'chunking',
  'embedding',
  'ready',
  'failed',
] as const;

// ── Sort allow-lists, consumed by parseSort ──────────────────────────────────────────

export const KNOWLEDGE_COLLECTION_SORT_FIELDS = ['nameEn', 'slug', 'createdAt'] as const;

export const KNOWLEDGE_DOCUMENT_SORT_FIELDS = [
  'title',
  'status',
  'ingestedAt',
  'createdAt',
] as const;

// ── Primitives ───────────────────────────────────────────────────────────────────────

const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'Use lowercase letters, numbers, hyphens and underscores')
  .min(2)
  .max(64);

/**
 * At least one audience, no duplicates.
 *
 * An empty array is refused here as well as by the database check constraint: a collection
 * nobody may search is not a safe default, it is an invisible one, and the person creating it
 * would have no way to tell.
 */
const audienceListSchema = z
  .array(z.enum(KNOWLEDGE_AUDIENCES))
  .min(1, 'Choose at least one audience that may search this collection')
  .max(KNOWLEDGE_AUDIENCES.length)
  .transform((values) => [...new Set(values)]);

// ── Collections ──────────────────────────────────────────────────────────────────────

export const createKnowledgeCollectionSchema = z.object({
  slug: slugSchema,
  nameEn: z.string().trim().min(1).max(160),
  nameBn: z.string().trim().max(160).optional(),
  description: z.string().trim().max(1000).optional(),
  visibleToAudiences: audienceListSchema,
});

export type CreateKnowledgeCollectionInput = z.infer<typeof createKnowledgeCollectionSchema>;

/**
 * The slug is absent on purpose. It is the handle the ai-tools module and any saved link use
 * to name a collection, so changing it would silently break references; a collection that
 * needs a different handle is archived and re-created.
 */
export const updateKnowledgeCollectionSchema = z
  .object({
    nameEn: z.string().trim().min(1).max(160).optional(),
    nameBn: z.string().trim().max(160).nullable().optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    visibleToAudiences: audienceListSchema.optional(),
    /** Optimistic lock. Rejecting a stale write beats silently overwriting a colleague. */
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, { message: 'No changes were submitted' });

export type UpdateKnowledgeCollectionInput = z.infer<typeof updateKnowledgeCollectionSchema>;

export const listKnowledgeCollectionsSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    /** Restrict to collections a given audience may search — a preview of what they see. */
    audience: z.enum(KNOWLEDGE_AUDIENCES).optional(),
    includeArchived: z.coerce.boolean().default(false),
  });

export const knowledgeArchiveSchema = z.object({ reason: reasonSchema });

// ── Documents ────────────────────────────────────────────────────────────────────────

/**
 * Create a document, by upload or by pasted text.
 *
 * Sent as `multipart/form-data` when a file is attached, so every field arrives as a string.
 * `sourceKind` decides which of `text`/`sourceUrl` must be present, and the refinement below
 * states that rather than leaving it to the service — the database restates it a third time
 * as `knowledge_documents_source_coherent`.
 *
 * `sourceUrl` records **where text came from**, for citation. This build does not fetch it:
 * an API that will follow an arbitrary URL from inside the school's network is a
 * server-side request forgery primitive, and adding one needs its own allow-list design. The
 * caller fetches and pastes; the URL is provenance.
 */
export const createKnowledgeDocumentSchema = z
  .object({
    collectionId: uuidSchema,
    title: z.string().trim().min(1).max(300),
    sourceKind: z.enum(KNOWLEDGE_SOURCE_KINDS),
    /** The document body, for `text` and `url` sources. Up to ~1 MB of characters. */
    text: z.string().max(1_000_000).optional(),
    sourceUrl: z.string().trim().url('Enter a full URL, including https://').max(2000).optional(),
    /** BCP-47-ish tag, `en` or `bn` in practice. Recorded, never guessed. */
    language: z.string().trim().max(16).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.sourceKind === 'upload') return; // The file itself is validated by the service.
    if (!data.text || data.text.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['text'],
        message: 'Provide the document text, or upload a file with sourceKind=upload',
      });
    }
    if (data.sourceKind === 'url' && !data.sourceUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceUrl'],
        message: 'Record the URL this text came from',
      });
    }
  });

export type CreateKnowledgeDocumentInput = z.infer<typeof createKnowledgeDocumentSchema>;

/**
 * Re-ingest an existing document.
 *
 * With no body, the stored bytes (or the stored text) are re-extracted, re-chunked and
 * re-embedded — the operation you run after changing the chunking parameters. With `text`,
 * the document's content is replaced, which is how a policy is amended: a new content
 * version, the previous version's chunks archived, the document row and its citations
 * preserved.
 */
export const reingestKnowledgeDocumentSchema = z.object({
  text: z.string().max(1_000_000).optional(),
  title: z.string().trim().min(1).max(300).optional(),
  language: z.string().trim().max(16).optional(),
});

export type ReingestKnowledgeDocumentInput = z.infer<typeof reingestKnowledgeDocumentSchema>;

export const listKnowledgeDocumentsSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    collectionId: uuidSchema.optional(),
    status: z.enum(KNOWLEDGE_DOCUMENT_STATUSES).optional(),
    includeArchived: z.coerce.boolean().default(false),
  });

// ── Search ───────────────────────────────────────────────────────────────────────────

/** The default number of chunks a retrieval returns. Enough to cite, few enough to fit. */
export const KNOWLEDGE_SEARCH_DEFAULT_LIMIT = 5;
export const KNOWLEDGE_SEARCH_MAX_LIMIT = 20;

/**
 * A retrieval request.
 *
 * `minScore` is capped below at the service's configured floor and can only be raised: a
 * caller must not be able to talk the system into returning weak matches, because docs/06 §5
 * is explicit that an answer with no citation is reported as "not found in your school's
 * documents" rather than generated, and a floor a client can lower is not a floor.
 */
export const knowledgeSearchSchema = z.object({
  query: z.string().trim().min(2, 'Enter at least two characters to search').max(2000),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(KNOWLEDGE_SEARCH_MAX_LIMIT)
    .default(KNOWLEDGE_SEARCH_DEFAULT_LIMIT),
  /** Narrow to specific collections. Omitted means every collection the caller may search. */
  collectionIds: z.array(uuidSchema).max(20).optional(),
  minScore: z.coerce.number().min(0).max(1).optional(),
});

export type KnowledgeSearchInput = z.infer<typeof knowledgeSearchSchema>;
