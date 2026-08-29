/**
 * Knowledge base service (Phase 31, docs/06 §5).
 *
 * The rules this file keeps, in the order they matter:
 *
 *  1. **Retrieval is filtered in SQL, never afterwards.** Tenant (by RLS), institution,
 *     collection audience, document status and the archive flag are all in the `where` clause
 *     of the one statement that also orders by vector distance. A filter applied to results in
 *     JavaScript is a filter that a `limit` has already defeated: the ten nearest chunks could
 *     all be from the staff handbook, and dropping them afterwards returns nothing while the
 *     eleventh — a perfectly good match the student was allowed to see — was never fetched.
 *  2. **Below the similarity floor, retrieval returns nothing.** docs/06 §5 says an answer
 *     with no citation is reported as "not found in your school's documents" rather than
 *     generated. That is only true if this layer is willing to return an empty array, so it
 *     is. A caller may raise the floor per request and may never lower it.
 *  3. **Every result carries a citation.** Document id, document title, collection, section
 *     heading and exact character offsets — the offsets are exact because a chunk is a slice
 *     of the source text (see `chunker.ts`), not a reassembly of it.
 *  4. **The provider is consulted only for text nobody has embedded before.** Every chunk and
 *     every query is looked up in `knowledge_embedding_cache` by content hash first, so
 *     re-ingesting an unchanged document makes ZERO provider calls and costs nothing. The
 *     cache is scoped to an institution, never to the hash alone — see the schema.
 *  5. **Nothing is deleted.** A collection is archived, a document is archived, and a
 *     re-ingested document's previous chunks are archived rather than replaced, so a citation
 *     issued last month still resolves to the text that was actually retrieved.
 *  6. **The AI never writes anything here on its own.** Ingestion is invoked by a human
 *     holding `ai.knowledge_base.manage`; the model's only role is to turn text into vectors.
 *     Audit rows for the pipeline carry `isAiInitiated: true` so that "was a model involved in
 *     producing this index" stays answerable years later (docs/06 §6).
 */

import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ilike, inArray, isNull, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import {
  files,
  knowledgeChunks,
  knowledgeCollections,
  knowledgeDocuments,
  knowledgeEmbeddingCache,
  KNOWLEDGE_EMBEDDING_DIMENSIONS,
  roles,
} from '@shikkha/db';
import {
  buildOffsetPage,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  offsetOf,
  parseSort,
  uuidv7,
  ValidationError,
  type OffsetPage,
  type OffsetPageRequest,
} from '@shikkha/shared';
import { can, type Permission, type Principal } from '@shikkha/permissions';
import {
  KNOWLEDGE_AUDIENCES,
  KNOWLEDGE_COLLECTION_SORT_FIELDS,
  KNOWLEDGE_DOCUMENT_SORT_FIELDS,
  type CreateKnowledgeCollectionInput,
  type CreateKnowledgeDocumentInput,
  type KnowledgeSearchInput,
  type ReingestKnowledgeDocumentInput,
} from '@shikkha/validation';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';
// Provided by `modules/ai`, which is built in parallel. This module injects them and never
// constructs a provider itself: docs/06 §4 — no application logic references a vendor.
import { AiProviderRegistry } from '../ai/providers/registry';
import { AiUsageService } from '../ai/ai-usage.service';
import type { KnowledgeSearchChunk, KnowledgeSearchPort } from '../ai-tools/ports';
import { currentContext } from '../../common/context/request-context';
import { getLogger } from '../../common/logger';
import { knowledgeConfig } from './knowledge.config';
import { chunkText, type TextChunk } from './chunker';
import { extractText, normalizeText, detectLanguage } from './text-extraction';

/** The transaction handle `runInTenant` hands to its callback. */
type Tx = Parameters<Parameters<DatabaseService['runInTenant']>[0]>[0];

type CollectionRow = typeof knowledgeCollections.$inferSelect;
type DocumentRow = typeof knowledgeDocuments.$inferSelect;

/** The slice of a multipart upload this service needs; matches Multer's file object. */
export interface UploadedFileLike {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface ListQueryBase {
  page: number;
  pageSize: number;
  sort?: string;
  includeArchived: boolean;
}

export interface ListCollectionsQuery extends ListQueryBase {
  q?: string;
  audience?: string;
}

export interface ListDocumentsQuery extends ListQueryBase {
  q?: string;
  collectionId?: string;
  status?: string;
}

/** One retrieval hit, with everything a citation needs. */
export interface KnowledgeSearchResult {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  collectionId: string;
  collectionName: string;
  seq: number;
  excerpt: string;
  headingPath: string | null;
  charFrom: number;
  charTo: number;
  pageFrom: number | null;
  pageTo: number | null;
  score: number;
}

export interface KnowledgeSearchOutcome {
  results: KnowledgeSearchResult[];
  /** The floor actually applied, so a caller can explain an empty answer. */
  minScore: number;
  /** True when the corpus was searched and nothing cleared the floor. */
  belowFloor: boolean;
}

/**
 * The result of embedding a list of texts, aligned index-for-index with the input.
 *
 * `models` is a parallel array rather than one field on `usage`, because a batch can be part
 * cache hit and part provider call: the model that produced a vector is a property of THAT
 * vector, not of the batch that happened to assemble it.
 */
interface EmbeddedTexts {
  vectors: (number[] | null)[];
  models: (string | null)[];
  usage: EmbeddingBatchUsage;
}

/** What one embedding batch consumed, for the usage ledger. */
interface EmbeddingBatchUsage {
  providerCalls: number;
  inputTokens: number;
  model: string | null;
  providerKey: string;
  cacheHits: number;
  cacheMisses: number;
}

@Injectable()
export class KnowledgeService implements KnowledgeSearchPort {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly providers: AiProviderRegistry,
    private readonly usage: AiUsageService,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════════════
  // Collections
  // ══════════════════════════════════════════════════════════════════════════════════

  async listCollections(
    principal: Principal,
    institutionId: string,
    query: ListCollectionsQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<CollectionRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(knowledgeCollections.institutionId, institutionId)];
      this.applyArchiveFilter(
        principal,
        filters,
        knowledgeCollections.archivedAt,
        query.includeArchived,
      );
      if (query.q) filters.push(ilike(knowledgeCollections.nameEn, `%${query.q}%`));
      if (query.audience) {
        filters.push(
          sql`${knowledgeCollections.visibleToAudiences} && string_to_array(${query.audience}, ',')::public.knowledge_audience[]`,
        );
      }

      // Someone who cannot manage the knowledge base sees only the collections their own
      // audiences may search. Enumerating the *names* of a school's confidential collections
      // ("Disciplinary Procedure — Staff Only") is itself a small disclosure, and there is no
      // reason a copilot user needs the list of things they cannot retrieve from.
      if (!can(principal, 'ai.knowledge_base.manage')) {
        const audiences = await this.callerAudiences(tx, principal);
        if (audiences.length === 0) return buildOffsetPage([], 0, page);
        filters.push(
          sql`${knowledgeCollections.visibleToAudiences} && string_to_array(${audiences.join(',')}, ',')::public.knowledge_audience[]`,
        );
      }

      const where = and(...filters);
      const orderBy = parseSort(query.sort, KNOWLEDGE_COLLECTION_SORT_FIELDS, {
        field: 'nameEn',
        direction: 'asc',
      }).map((spec) => {
        const column = COLLECTION_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(knowledgeCollections)
        .where(where)
        .orderBy(...orderBy, asc(knowledgeCollections.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(knowledgeCollections)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async createCollection(
    principal: Principal,
    institutionId: string,
    input: CreateKnowledgeCollectionInput,
  ): Promise<CollectionRow> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select({ id: knowledgeCollections.id })
        .from(knowledgeCollections)
        .where(
          and(
            eq(knowledgeCollections.institutionId, institutionId),
            eq(knowledgeCollections.slug, input.slug),
            isNull(knowledgeCollections.archivedAt),
          ),
        )
        .limit(1);
      if (existing) {
        throw new ConflictError(
          'A collection with this handle already exists in this institution.',
          { slug: input.slug },
        );
      }

      const [created] = await tx
        .insert(knowledgeCollections)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          slug: input.slug,
          nameEn: input.nameEn,
          nameBn: input.nameBn ?? null,
          description: input.description ?? null,
          visibleToAudiences: input.visibleToAudiences,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  async updateCollection(
    principal: Principal,
    institutionId: string,
    id: string,
    input: Record<string, unknown>,
  ): Promise<{ collection: CollectionRow; previous: Partial<CollectionRow> }> {
    const version = input['version'] as number;
    const { version: _ignored, ...changes } = input;

    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadCollection(tx, institutionId, id);

      const [updated] = await tx
        .update(knowledgeCollections)
        .set({
          ...(changes as Partial<CollectionRow>),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(
          and(eq(knowledgeCollections.id, id), eq(knowledgeCollections.version, version)),
        )
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This collection was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      // Narrowing the audience list is a security-relevant change, so the before-state is
      // captured explicitly and reaches the audit trail through `__audit` rather than being
      // reconstructed later from two rows.
      return { collection: updated, previous: diffOf(existing, updated, Object.keys(changes)) };
    });
  }

  /**
   * Archive a collection.
   *
   * Its documents and chunks are archived with it, in the same transaction: leaving live
   * chunks pointing at an archived collection would keep the content retrievable, which is
   * the opposite of what the person clicking "archive" asked for.
   */
  async archiveCollection(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<CollectionRow & { archivedDocuments: number; archivedChunks: number }> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadCollection(tx, institutionId, id);
      const archivedAt = new Date();

      const archivedChunks = await tx
        .update(knowledgeChunks)
        .set({
          archivedAt,
          archivedBy: principal.userId,
          archiveReason: reason.slice(0, 500),
          updatedBy: principal.userId,
        })
        .where(and(eq(knowledgeChunks.collectionId, id), isNull(knowledgeChunks.archivedAt)))
        .returning({ id: knowledgeChunks.id });

      const archivedDocuments = await tx
        .update(knowledgeDocuments)
        .set({
          archivedAt,
          archivedBy: principal.userId,
          archiveReason: reason.slice(0, 500),
          updatedBy: principal.userId,
          version: sql`${knowledgeDocuments.version} + 1`,
        })
        .where(
          and(eq(knowledgeDocuments.collectionId, id), isNull(knowledgeDocuments.archivedAt)),
        )
        .returning({ id: knowledgeDocuments.id });

      const [archived] = await tx
        .update(knowledgeCollections)
        .set({
          archivedAt,
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(eq(knowledgeCollections.id, id))
        .returning();

      return {
        ...archived!,
        archivedDocuments: archivedDocuments.length,
        archivedChunks: archivedChunks.length,
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Documents
  // ══════════════════════════════════════════════════════════════════════════════════

  async listDocuments(
    principal: Principal,
    institutionId: string,
    query: ListDocumentsQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<DocumentRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(knowledgeDocuments.institutionId, institutionId)];
      this.applyArchiveFilter(
        principal,
        filters,
        knowledgeDocuments.archivedAt,
        query.includeArchived,
      );
      if (query.collectionId) {
        filters.push(eq(knowledgeDocuments.collectionId, query.collectionId));
      }
      if (query.status) {
        filters.push(sql`${knowledgeDocuments.status}::text = ${query.status}`);
      }
      if (query.q) filters.push(ilike(knowledgeDocuments.title, `%${query.q}%`));

      const visible = await this.visibleCollectionIds(tx, principal, institutionId);
      if (visible !== null) {
        if (visible.length === 0) return buildOffsetPage([], 0, page);
        filters.push(inArray(knowledgeDocuments.collectionId, visible));
      }

      const where = and(...filters);
      const orderBy = parseSort(query.sort, KNOWLEDGE_DOCUMENT_SORT_FIELDS, {
        field: 'createdAt',
        direction: 'desc',
      }).map((spec) => {
        const column = DOCUMENT_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(knowledgeDocuments)
        .where(where)
        .orderBy(...orderBy, asc(knowledgeDocuments.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(knowledgeDocuments)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  /** One document, with its live chunk inventory — enough to see the pipeline's outcome. */
  async getDocument(principal: Principal, institutionId: string, id: string) {
    return this.db.runInTenant(async (tx) => {
      const document = await this.loadDocument(tx, institutionId, id, { includeArchived: true });

      const visible = await this.visibleCollectionIds(tx, principal, institutionId);
      if (visible !== null && !visible.includes(document.collectionId)) {
        // Not a 403: telling a caller that a document they may not see exists is itself the
        // disclosure. The same answer as for an id that does not exist at all.
        throw new NotFoundError('Knowledge document', id);
      }

      const [collection] = await tx
        .select({
          id: knowledgeCollections.id,
          slug: knowledgeCollections.slug,
          nameEn: knowledgeCollections.nameEn,
          visibleToAudiences: knowledgeCollections.visibleToAudiences,
        })
        .from(knowledgeCollections)
        .where(eq(knowledgeCollections.id, document.collectionId))
        .limit(1);

      const [chunkStats] = await tx
        .select({
          liveChunks: sql<number>`count(*) filter (where ${knowledgeChunks.archivedAt} is null)::int`,
          embeddedChunks: sql<number>`count(*) filter (where ${knowledgeChunks.archivedAt} is null and ${knowledgeChunks.embedding} is not null)::int`,
          archivedChunks: sql<number>`count(*) filter (where ${knowledgeChunks.archivedAt} is not null)::int`,
        })
        .from(knowledgeChunks)
        .where(eq(knowledgeChunks.documentId, id));

      return {
        ...document,
        collection: collection ?? null,
        chunks: chunkStats ?? { liveChunks: 0, embeddedChunks: 0, archivedChunks: 0 },
      };
    });
  }

  /**
   * Ingest a new document: extract → chunk → embed → store.
   *
   * The upload is written to object storage BEFORE the transaction, exactly as a library
   * cover is: a failed transaction leaves an orphaned object with no `files` row, invisible
   * and swept by the cleanup job, which is a far better failure than a `files` row pointing at
   * bytes that were never written.
   */
  async createDocument(
    principal: Principal,
    institutionId: string,
    input: CreateKnowledgeDocumentInput,
    file: UploadedFileLike | undefined,
  ): Promise<DocumentRow> {
    const config = knowledgeConfig();
    const tenantId = principal.tenantId!;

    let text: string;
    let mimeType = 'text/plain';
    let byteSize: number;
    let storageKey: string | null = null;
    let checksum: string | null = null;

    if (input.sourceKind === 'upload') {
      if (!file || !file.buffer || file.size === 0) {
        throw new ValidationError('No file was uploaded', [
          { path: 'file', message: 'Attach the document as the "file" field' },
        ]);
      }
      if (file.size > config.KNOWLEDGE_MAX_UPLOAD_BYTES) {
        throw new ValidationError('The file is too large', [
          {
            path: 'file',
            message: `Documents may be at most ${Math.floor(config.KNOWLEDGE_MAX_UPLOAD_BYTES / (1024 * 1024))} MB`,
          },
        ]);
      }
      // Refuses PDFs and every other binary format BY NAME rather than ingesting an empty
      // document — see `text-extraction.ts` for why that distinction is the whole point.
      const extracted = extractText({
        filename: file.originalname,
        declaredMimeType: file.mimetype,
        bytes: file.buffer,
      });
      text = extracted.text;
      mimeType = extracted.mimeType;
      byteSize = file.size;

      const stored = await this.storage.put({
        tenantId,
        category: 'knowledge_document',
        filename: file.originalname,
        contentType: mimeType,
        body: file.buffer,
      });
      storageKey = stored.key;
      checksum = stored.checksum;
    } else {
      text = normalizeText(input.text ?? '');
      byteSize = Buffer.byteLength(text, 'utf8');
      if (text.length === 0) {
        throw new ValidationError('The document is empty', [
          { path: 'text', message: 'Provide the document text' },
        ]);
      }
    }

    const contentHash = sha256(text);
    const language = input.language ?? detectLanguage(text);

    const document = await this.db.runInTenant(async (tx) => {
      const collection = await this.loadCollection(tx, institutionId, input.collectionId);

      let fileId: string | null = null;
      if (storageKey && file) {
        const [fileRow] = await tx
          .insert(files)
          .values({
            tenantId,
            institutionId,
            storageKey,
            storageDriver: 'local',
            originalFilename: file.originalname.slice(0, 255),
            mimeType,
            sizeBytes: byteSize,
            checksum: checksum!,
            category: 'knowledge_document',
            ownerType: 'knowledge_document',
            isSensitive: false,
            uploadedAt: new Date(),
            createdBy: principal.userId,
          })
          .returning();
        fileId = fileRow!.id;
      }

      const [created] = await tx
        .insert(knowledgeDocuments)
        .values({
          id: uuidv7(),
          tenantId,
          institutionId,
          collectionId: collection.id,
          title: input.title,
          sourceKind: input.sourceKind,
          storageObjectKey: storageKey,
          fileId,
          sourceUrl: input.sourceUrl ?? null,
          contentHash,
          byteSize,
          language: language ?? null,
          status: 'pending',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      // Written here rather than by the interceptor so that "a human added this document"
      // survives even when the pipeline below fails: the two are separate transactions, and
      // an audit row inside the ingestion transaction would roll back with it.
      await this.recordAudit(tx, principal, institutionId, {
        action: 'create',
        resourceType: 'knowledge_document',
        resourceId: created!.id,
        resourceLabel: created!.title,
        newValue: {
          collectionId: collection.id,
          title: created!.title,
          sourceKind: created!.sourceKind,
          contentHash,
          byteSize,
        },
        isAiInitiated: false,
      });

      return created!;
    });

    return this.runPipeline(principal, institutionId, document, text);
  }

  /**
   * Re-ingest.
   *
   * With `text`, the document's content is replaced — a new content version, the previous
   * version's chunks archived, the document row and every citation that names it preserved.
   * Without it, the stored bytes are re-extracted and re-chunked, which is what you run after
   * changing the chunking parameters. Either way, unchanged text costs nothing: every chunk
   * hash that has been embedded before is served from the cache.
   */
  async reingestDocument(
    principal: Principal,
    institutionId: string,
    id: string,
    input: ReingestKnowledgeDocumentInput,
  ): Promise<DocumentRow> {
    const document = await this.db.runInTenant(async (tx) =>
      this.loadDocument(tx, institutionId, id),
    );

    let text: string;
    if (input.text !== undefined) {
      text = normalizeText(input.text);
      if (text.length === 0) {
        throw new ValidationError('The document is empty', [
          { path: 'text', message: 'Provide the replacement text' },
        ]);
      }
    } else if (document.storageObjectKey) {
      const bytes = await this.storage.get(document.storageObjectKey);
      text = extractText({
        filename: document.title,
        declaredMimeType: null,
        bytes,
      }).text;
    } else {
      // A `text` document with no stored bytes and no replacement text has nothing to
      // re-ingest. Refusing beats silently re-chunking whatever the chunks happen to hold.
      throw new ValidationError('There is nothing to re-ingest', [
        {
          path: 'text',
          message:
            'This document was created from pasted text. Send the text again to re-ingest it.',
        },
      ]);
    }

    const contentHash = sha256(text);
    const updated = await this.db.runInTenant(async (tx) => {
      const [row] = await tx
        .update(knowledgeDocuments)
        .set({
          title: input.title ?? document.title,
          language: input.language ?? detectLanguage(text) ?? document.language,
          contentHash,
          byteSize: Buffer.byteLength(text, 'utf8'),
          // A new content version even when the hash is unchanged: the chunk boundaries may
          // differ because the parameters changed, and two versions of a chunk set must never
          // share a (document_id, document_version, seq) key.
          contentVersion: document.contentVersion + 1,
          version: document.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(knowledgeDocuments.id, id))
        .returning();
      return row!;
    });

    return this.runPipeline(principal, institutionId, updated, text);
  }

  /**
   * Archive a document. Its chunks are archived in the same transaction, which is what
   * removes it from search — the search statement filters on `archived_at is null`, so an
   * archived document stops being retrievable the instant this commits.
   */
  async archiveDocument(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<DocumentRow & { archivedChunks: number }> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadDocument(tx, institutionId, id);
      const archivedAt = new Date();

      const archivedChunks = await tx
        .update(knowledgeChunks)
        .set({
          archivedAt,
          archivedBy: principal.userId,
          archiveReason: reason.slice(0, 500),
          updatedBy: principal.userId,
        })
        .where(and(eq(knowledgeChunks.documentId, id), isNull(knowledgeChunks.archivedAt)))
        .returning({ id: knowledgeChunks.id });

      const [archived] = await tx
        .update(knowledgeDocuments)
        .set({
          archivedAt,
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(eq(knowledgeDocuments.id, id))
        .returning();

      return { ...archived!, archivedChunks: archivedChunks.length };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // The pipeline: chunk → embed → store
  // ══════════════════════════════════════════════════════════════════════════════════

  private async runPipeline(
    principal: Principal,
    institutionId: string,
    document: DocumentRow,
    text: string,
  ): Promise<DocumentRow> {
    const config = knowledgeConfig();

    try {
      await this.setStatus(document.id, 'chunking');

      const chunks = chunkText(text, {
        targetTokens: config.KNOWLEDGE_CHUNK_TARGET_TOKENS,
        maxTokens: config.KNOWLEDGE_CHUNK_MAX_TOKENS,
        overlapTokens: config.KNOWLEDGE_CHUNK_OVERLAP_TOKENS,
      });
      if (chunks.length === 0) {
        throw new ValidationError('This document produced no text to index', [
          { path: 'text', message: 'The document appears to be empty once extracted' },
        ]);
      }

      await this.setStatus(document.id, 'embedding');
      const embedded = await this.embedTexts(
        principal,
        institutionId,
        chunks.map((chunk) => chunk.content),
      );

      // One transaction for the whole store step, which is what makes a failed re-ingestion
      // safe: the previous version's chunks are archived and the new ones written together,
      // so a failure anywhere in here leaves the OLD version live and still searchable rather
      // than a document that has lost its index and gained nothing.
      return await this.db.runInTenant(async (tx) => {
        // The previous version's chunks are archived, never deleted or updated: a citation
        // issued last month must still resolve to the text that was actually retrieved then.
        await tx
          .update(knowledgeChunks)
          .set({
            archivedAt: new Date(),
            archivedBy: principal.userId,
            archiveReason: `Superseded by content version ${document.contentVersion}`,
            updatedBy: principal.userId,
          })
          .where(
            and(
              eq(knowledgeChunks.documentId, document.id),
              isNull(knowledgeChunks.archivedAt),
              sql`${knowledgeChunks.documentVersion} < ${document.contentVersion}`,
            ),
          );

        await this.insertChunks(tx, principal, institutionId, document, chunks, embedded);

        const tokenCount = chunks.reduce((total, chunk) => total + chunk.tokenCount, 0);
        const [ready] = await tx
          .update(knowledgeDocuments)
          .set({
            status: 'ready',
            failureReason: null,
            chunkCount: chunks.length,
            tokenCount,
            ingestedAt: new Date(),
            version: sql`${knowledgeDocuments.version} + 1`,
            updatedBy: principal.userId,
          })
          .where(eq(knowledgeDocuments.id, document.id))
          .returning();

        // `isAiInitiated: true`. A human asked for the ingestion, but the vectors that make
        // this index searchable came out of a model, and docs/06 §6 wants that answerable
        // years later without anyone having to reconstruct which phase produced which row.
        await this.recordAudit(tx, principal, institutionId, {
          action: 'update',
          resourceType: 'knowledge_document',
          resourceId: document.id,
          resourceLabel: document.title,
          previousValue: { status: document.status, chunkCount: document.chunkCount },
          newValue: {
            status: 'ready',
            contentVersion: document.contentVersion,
            chunkCount: chunks.length,
            tokenCount,
            embeddingModel: embedded.models.find((model) => model !== null) ?? null,
            providerCalls: embedded.usage.providerCalls,
            cacheHits: embedded.usage.cacheHits,
            cacheMisses: embedded.usage.cacheMisses,
          },
          isAiInitiated: true,
        });

        return ready!;
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      getLogger().error(
        { err: error, documentId: document.id },
        'knowledge ingestion failed; the document is marked failed and stays out of search',
      );
      await this.markFailed(principal, institutionId, document, reason);
      throw error;
    }
  }

  private async setStatus(
    documentId: string,
    status: 'extracting' | 'chunking' | 'embedding',
  ): Promise<void> {
    await this.db.runInTenant(async (tx) => {
      await tx
        .update(knowledgeDocuments)
        .set({ status })
        .where(eq(knowledgeDocuments.id, documentId));
    });
  }

  /**
   * Record the failure on the document itself.
   *
   * In its own transaction, because the transaction that failed has already rolled back — and
   * a document whose status stays `embedding` forever is indistinguishable from one still in
   * flight. The reason is truncated rather than dropped: an operator needs the first line of
   * the provider's complaint, not a null.
   */
  private async markFailed(
    principal: Principal,
    institutionId: string,
    document: DocumentRow,
    reason: string,
  ): Promise<void> {
    try {
      await this.db.runInTenant(async (tx) => {
        await tx
          .update(knowledgeDocuments)
          .set({
            status: 'failed',
            failureReason: reason.slice(0, 1000),
            version: sql`${knowledgeDocuments.version} + 1`,
            updatedBy: principal.userId,
          })
          .where(eq(knowledgeDocuments.id, document.id));

        await this.recordAudit(tx, principal, institutionId, {
          action: 'update',
          resourceType: 'knowledge_document',
          resourceId: document.id,
          resourceLabel: document.title,
          previousValue: { status: document.status },
          newValue: { status: 'failed', failureReason: reason.slice(0, 1000) },
          isAiInitiated: true,
        });
      });
    } catch (error) {
      // Never mask the original failure with a bookkeeping one.
      getLogger().error({ err: error, documentId: document.id }, 'could not mark document failed');
    }
  }

  private async insertChunks(
    tx: Tx,
    principal: Principal,
    institutionId: string,
    document: DocumentRow,
    chunks: TextChunk[],
    embedded: EmbeddedTexts,
  ): Promise<void> {
    const rows = chunks.map((chunk, index) => ({
      id: uuidv7(),
      tenantId: principal.tenantId!,
      institutionId,
      collectionId: document.collectionId,
      documentId: document.id,
      documentVersion: document.contentVersion,
      seq: chunk.seq,
      content: chunk.content,
      contentHash: sha256(chunk.content),
      tokenCount: chunk.tokenCount,
      embedding: embedded.vectors[index] ?? null,
      // The model comes from the SAME source as the vector — the cache row for a hit, the
      // provider response for a miss — never from the batch summary. A fully cached
      // re-ingestion makes no provider call, so the batch has no model of its own, and
      // reading it from there wrote a non-null embedding beside a null model: exactly the
      // half-written row `knowledge_chunks_embedding_model_paired` exists to refuse.
      embeddingModel: embedded.models[index] ?? null,
      charFrom: chunk.charFrom,
      charTo: chunk.charTo,
      // Page numbers stay null: this build extracts plain text and Markdown, neither of which
      // is paginated. A future paginated extractor fills them; the citation columns exist so
      // that change is additive rather than a schema change under live data.
      pageFrom: null,
      pageTo: null,
      headingPath: chunk.headingPath,
      createdBy: principal.userId,
      updatedBy: principal.userId,
    }));

    // Inserted in batches rather than one statement: a large handbook can be thousands of
    // chunks, and a single INSERT with thousands of 1536-element vectors exceeds the
    // driver's practical parameter limit.
    for (let i = 0; i < rows.length; i += CHUNK_INSERT_BATCH) {
      await tx.insert(knowledgeChunks).values(rows.slice(i, i + CHUNK_INSERT_BATCH));
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Embedding, with the cache in front of it
  // ══════════════════════════════════════════════════════════════════════════════════

  /**
   * Embed a list of texts, consulting the cache first.
   *
   * The order of operations is the whole feature:
   *
   *   1. Deduplicate within the batch by content hash — the same boilerplate paragraph in two
   *      circulars is one vector, not two.
   *   2. Look every distinct hash up in `knowledge_embedding_cache` for this institution and
   *      this model.
   *   3. Call the provider ONLY for what is left. If nothing is left, **no call is made and
   *      no usage event is recorded** — that is what makes re-ingesting an unchanged document
   *      free, and the integration suite asserts it by counting `ai_usage_events`.
   *   4. Record the usage that did happen, then write the new vectors into the cache.
   */
  private async embedTexts(
    principal: Principal,
    institutionId: string,
    texts: string[],
  ): Promise<EmbeddedTexts> {
    const config = knowledgeConfig();
    const embedder = this.providers.embedder();
    const providerKey = embedder.key;

    const expectedDimensions = this.providers.embeddingDimensions();
    if (expectedDimensions !== KNOWLEDGE_EMBEDDING_DIMENSIONS) {
      // Fail here, before a single provider call is paid for, rather than letting Postgres
      // reject the insert after the whole document has been embedded.
      throw new InternalError(
        'The configured embedding model does not match the knowledge base column width',
        {
          configuredDimensions: expectedDimensions,
          columnDimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS,
          remedy:
            'Changing the embedding model requires a re-embed migration, not a column change.',
        },
      );
    }

    const hashes = texts.map((text) => sha256(text));
    const distinct = new Map<string, string>();
    for (let i = 0; i < texts.length; i += 1) distinct.set(hashes[i]!, texts[i]!);

    const cached = await this.readCache(institutionId, [...distinct.keys()]);
    const missing = [...distinct.entries()].filter(([hash]) => !cached.has(hash));

    // A cache holding two models' vectors is a corrupt state, not merely a slow one: cosine
    // distance between vectors from different models is a number with no meaning, and every
    // ranking computed from it would be confidently wrong. Changing the embedding model is a
    // re-embed migration that clears this table (see the schema); if one was skipped, this is
    // where it becomes visible instead of silently degrading every answer.
    const cachedModels = new Set([...cached.values()].map((entry) => entry.model));
    if (cachedModels.size > 1) {
      throw new InternalError('The embedding cache holds vectors from more than one model', {
        institutionId,
        models: [...cachedModels],
        remedy: 'Re-embed the knowledge base; a model change is a migration, not a config edit.',
      });
    }
    const cachedModel = [...cachedModels][0] ?? null;

    const usage: EmbeddingBatchUsage = {
      providerCalls: 0,
      inputTokens: 0,
      model: null,
      providerKey,
      cacheHits: distinct.size - missing.length,
      cacheMisses: missing.length,
    };

    // docs/06 §8: the budget is enforced BEFORE the call rather than reported after it. Asked
    // only when there is something to embed — a fully cached ingestion spends nothing, and
    // refusing it because last month's bill was high would be refusing a free operation.
    if (missing.length > 0) {
      await this.usage.assertWithinBudget(principal, institutionId, 'embedding');
    }

    const fresh = new Map<string, { vector: number[]; model: string }>();
    for (let i = 0; i < missing.length; i += config.KNOWLEDGE_EMBED_BATCH_SIZE) {
      const batch = missing.slice(i, i + config.KNOWLEDGE_EMBED_BATCH_SIZE);
      const response = await embedder.embed(batch.map(([, text]) => text));

      if (response.vectors.length !== batch.length) {
        throw new InternalError('The embedding provider returned the wrong number of vectors', {
          requested: batch.length,
          returned: response.vectors.length,
        });
      }
      for (let j = 0; j < batch.length; j += 1) {
        const vector = response.vectors[j]!;
        if (vector.length !== KNOWLEDGE_EMBEDDING_DIMENSIONS) {
          throw new InternalError('The embedding provider returned the wrong dimension', {
            expected: KNOWLEDGE_EMBEDDING_DIMENSIONS,
            returned: vector.length,
            model: response.model,
          });
        }
        fresh.set(batch[j]![0], { vector, model: response.model });
      }

      // The other half of the mixed-model check: a partial miss compares what the provider
      // answers with what the cache already holds, so a model swap surfaces the first time
      // anything new is embedded rather than at some unrelated moment months later.
      if (cachedModel !== null && response.model !== cachedModel) {
        throw new InternalError('The embedding model changed without a re-embed', {
          institutionId,
          cachedModel,
          configuredModel: response.model,
          remedy: 'Re-embed every document before serving retrieval with the new model.',
        });
      }

      usage.providerCalls += 1;
      usage.inputTokens += response.usage.inputTokens;
      usage.model = response.model;
    }

    if (usage.providerCalls > 0) {
      await this.recordEmbeddingUsage(principal, institutionId, usage);
      await this.writeCache(principal, institutionId, fresh);
    }

    // Bump the hit counters for what the cache served. Best-effort by design: the counters
    // are an operational statistic, and failing an ingestion because a statistic could not be
    // incremented would be absurd.
    if (cached.size > 0) {
      await this.touchCache(institutionId, [...cached.keys()]).catch((error: unknown) => {
        getLogger().warn({ err: error }, 'could not update embedding cache hit counters');
      });
    }

    const byHash = new Map([...cached, ...fresh]);
    return {
      vectors: hashes.map((hash) => byHash.get(hash)?.vector ?? null),
      models: hashes.map((hash) => byHash.get(hash)?.model ?? null),
      usage,
    };
  }

  /**
   * Cached vectors for these hashes, each carrying the model that produced it.
   *
   * The model travels with the vector rather than being assumed, because the two only mean
   * anything together: a hash identifies the *text*, and the same text embedded by two models
   * gives two vectors that must never be compared with one another.
   */
  private async readCache(
    institutionId: string,
    hashes: string[],
  ): Promise<Map<string, { vector: number[]; model: string }>> {
    if (hashes.length === 0) return new Map();
    return this.db.runInTenant(async (tx) => {
      const rows = await tx
        .select({
          contentHash: knowledgeEmbeddingCache.contentHash,
          embedding: knowledgeEmbeddingCache.embedding,
          model: knowledgeEmbeddingCache.model,
        })
        .from(knowledgeEmbeddingCache)
        .where(
          and(
            eq(knowledgeEmbeddingCache.institutionId, institutionId),
            isNull(knowledgeEmbeddingCache.archivedAt),
            inArray(knowledgeEmbeddingCache.contentHash, hashes),
          ),
        );
      return new Map(
        rows
          .filter((row) => row.embedding !== null)
          .map((row) => [row.contentHash, { vector: row.embedding!, model: row.model }]),
      );
    });
  }

  private async writeCache(
    principal: Principal,
    institutionId: string,
    vectors: Map<string, { vector: number[]; model: string }>,
  ): Promise<void> {
    if (vectors.size === 0) return;
    await this.db.runInTenant(async (tx) => {
      const rows = [...vectors.entries()].map(([contentHash, entry]) => ({
        id: uuidv7(),
        tenantId: principal.tenantId!,
        institutionId,
        contentHash,
        model: entry.model,
        dimensions: entry.vector.length,
        embedding: entry.vector,
        hitCount: 0,
        lastUsedAt: new Date(),
        createdBy: principal.userId,
        updatedBy: principal.userId,
      }));
      for (let i = 0; i < rows.length; i += CHUNK_INSERT_BATCH) {
        await tx
          .insert(knowledgeEmbeddingCache)
          .values(rows.slice(i, i + CHUNK_INSERT_BATCH))
          // Two concurrent ingestions of the same text race here; whoever loses simply keeps
          // the vector the other wrote, which is identical.
          .onConflictDoNothing();
      }
    });
  }

  private async touchCache(institutionId: string, hashes: string[]): Promise<void> {
    await this.db.runInTenant(async (tx) => {
      await tx
        .update(knowledgeEmbeddingCache)
        .set({ hitCount: sql`${knowledgeEmbeddingCache.hitCount} + 1`, lastUsedAt: new Date() })
        .where(
          and(
            eq(knowledgeEmbeddingCache.institutionId, institutionId),
            inArray(knowledgeEmbeddingCache.contentHash, hashes),
          ),
        );
    });
  }

  /**
   * Record what the provider call cost in the AI usage ledger (docs/06 §8).
   *
   * **In its own committed transaction, deliberately** — which is the opposite of what a
   * conversation turn does. `AiUsageService.record` is transaction-scoped so that a rolled-back
   * message leaves no charge behind, and that is right when the thing being paid for is the
   * thing being rolled back. Here it is not: the provider has already been called and already
   * billed by the time this runs, so a charge that rolled back with a later chunk-insert
   * failure would be a school paying for inference its budget never saw. The event is a fact
   * about money that has left; the ingestion's success or failure is a separate fact.
   */
  private async recordEmbeddingUsage(
    principal: Principal,
    institutionId: string,
    usage: EmbeddingBatchUsage,
  ): Promise<void> {
    await this.db.runInTenant(async (tx) => {
      await this.usage.record(tx, {
        tenantId: principal.tenantId!,
        institutionId,
        userId: principal.userId,
        task: 'embedding',
        purpose: 'knowledge_search',
        providerKey: usage.providerKey,
        model: usage.model!,
        inputTokens: usage.inputTokens,
        outputTokens: 0,
      });
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Search
  // ══════════════════════════════════════════════════════════════════════════════════

  /**
   * The port the ai-tools module consumes (`KNOWLEDGE_SEARCH`).
   *
   * Signature fixed by `modules/ai-tools/ports.ts`; it must not drift. This path is reached
   * only from a copilot or tutor turn, so it writes its own audit row marked AI-initiated —
   * there is no HTTP request behind it for the audit interceptor to hang off.
   */
  async search(
    principal: Principal,
    institutionId: string,
    query: string,
    limit: number,
  ): Promise<{ chunks: KnowledgeSearchChunk[] }> {
    const outcome = await this.runSearch(
      principal,
      institutionId,
      { query, limit },
      { aiInitiated: true, recordAudit: true },
    );
    return {
      chunks: outcome.results.map((result) => ({
        documentId: result.documentId,
        documentTitle: result.documentTitle,
        chunkId: result.chunkId,
        excerpt: result.excerpt,
        score: result.score,
      })),
    };
  }

  /** The HTTP surface. The route carries `@Audited({ action: 'export' })`; a search is egress. */
  async searchDetailed(
    principal: Principal,
    institutionId: string,
    input: KnowledgeSearchInput,
  ): Promise<KnowledgeSearchOutcome> {
    return this.runSearch(principal, institutionId, input, {
      aiInitiated: false,
      recordAudit: false,
    });
  }

  private async runSearch(
    principal: Principal,
    institutionId: string,
    input: { query: string; limit: number; collectionIds?: string[]; minScore?: number },
    options: { aiInitiated: boolean; recordAudit: boolean },
  ): Promise<KnowledgeSearchOutcome> {
    const config = knowledgeConfig();
    // The configured floor is a floor: a caller may raise it, never lower it. A minimum a
    // client can talk down is not a minimum.
    const minScore = Math.max(config.KNOWLEDGE_SEARCH_MIN_SCORE, input.minScore ?? 0);
    const limit = Math.max(1, input.limit);

    const audiences = await this.db.runInTenant((tx) => this.callerAudiences(tx, principal));
    if (audiences.length === 0) {
      // Fail closed. A principal whose roles carry no recognised audience retrieves nothing,
      // rather than defaulting to `staff` and reading the handbook.
      return { results: [], minScore, belowFloor: false };
    }

    const [queryVector] = (
      await this.embedTexts(principal, institutionId, [input.query])
    ).vectors;
    if (!queryVector) {
      throw new InternalError('The embedding provider returned no vector for the query');
    }

    const results = await this.db.runInTenant(async (tx) => {
      // Give the approximate index enough candidates that the tenant/audience/archive filters
      // cannot starve the result set. Harmless when the planner chooses an exact scan, which
      // is what it does for a single institution's corpus today.
      const efSearch = Math.min(
        1_000,
        Math.max(40, limit * config.KNOWLEDGE_SEARCH_OVERFETCH * 4),
      );
      await tx.execute(sql.raw(`set local hnsw.ef_search = ${Math.trunc(efSearch)}`));

      const collectionFilter =
        input.collectionIds && input.collectionIds.length > 0
          ? sql` and c.collection_id = any(string_to_array(${input.collectionIds.join(',')}, ',')::uuid[])`
          : sql``;

      // One fragment, reused three times: the ordering, the floor and the projected score all
      // need the query vector, and building it once keeps the three occurrences textually
      // identical so the planner recognises them as the same expression.
      const queryVectorSql = sql`${toVectorLiteral(queryVector)}::public.vector`;

      // EVERY filter is here, in the statement that also orders by distance. See rule 1 in the
      // file header for why doing any of this to the result set afterwards would be wrong.
      const result = await tx.execute(sql`
        select c.id::text            as chunk_id,
               c.document_id::text   as document_id,
               c.collection_id::text as collection_id,
               c.seq                 as seq,
               c.content             as content,
               c.heading_path        as heading_path,
               c.char_from           as char_from,
               c.char_to             as char_to,
               c.page_from           as page_from,
               c.page_to             as page_to,
               d.title               as document_title,
               k.name_en             as collection_name,
               (1 - (c.embedding <=> ${queryVectorSql}))::float8 as score
          from knowledge_chunks c
          join knowledge_documents d on d.id = c.document_id
          join knowledge_collections k on k.id = c.collection_id
         where c.institution_id = ${institutionId}
           and c.archived_at is null
           and c.embedding is not null
           and d.archived_at is null
           and d.status = 'ready'
           and k.archived_at is null
           and k.visible_to_audiences && string_to_array(${audiences.join(',')}, ',')::public.knowledge_audience[]
           and (1 - (c.embedding <=> ${queryVectorSql})) >= ${minScore}
           ${collectionFilter}
         order by c.embedding <=> ${queryVectorSql}
         limit ${limit}
      `);

      return result.rows.map((row) => toSearchResult(row as Record<string, unknown>));
    });

    if (options.recordAudit) {
      await this.db.runInTenant(async (tx) => {
        await this.recordAudit(tx, principal, institutionId, {
          action: 'export',
          resourceType: 'knowledge_search',
          resourceId: null,
          resourceLabel: null,
          // The query itself is recorded: a retrieval is data egress, and "which documents did
          // this account pull, and what were they looking for" is the question an investigation
          // asks. The matched text is NOT recorded — that would copy the corpus into the audit
          // table, which has a longer retention and a wider readership.
          newValue: {
            query: input.query.slice(0, 1000),
            audiences,
            minScore,
            resultCount: results.length,
            documentIds: [...new Set(results.map((result) => result.documentId))],
          },
          isAiInitiated: options.aiInitiated,
        });
      });
    }

    return { results, minScore, belowFloor: results.length === 0 };
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Helpers
  // ══════════════════════════════════════════════════════════════════════════════════

  /**
   * The audiences this caller may retrieve as.
   *
   * Read from `roles.audience` for the principal's own role grants rather than inferred from
   * their permissions, because "which kind of person is this" and "what may they do" are
   * different questions: a teacher and a principal both hold `ai.copilot.use` and are not the
   * same audience.
   *
   * Values not in the enum are dropped rather than passed to Postgres — `roles.audience` is a
   * `varchar` a tenant can edit, and an unrecognised value must reduce what the caller sees,
   * never cause a cast error that would look like an outage.
   */
  private async callerAudiences(tx: Tx, principal: Principal): Promise<string[]> {
    const roleIds = principal.roles.map((grant) => grant.roleId).filter(Boolean);
    if (roleIds.length === 0) return [];

    const rows = await tx
      .select({ audience: roles.audience })
      .from(roles)
      .where(inArray(roles.id, roleIds));

    const known = new Set<string>(KNOWLEDGE_AUDIENCES);
    return [...new Set(rows.map((row) => row.audience).filter((value) => known.has(value)))];
  }

  /**
   * The collection ids this caller may see, or `null` for "all of them".
   *
   * `null` rather than a list of every id because a knowledge-base manager legitimately sees
   * everything, and materialising that list would put a hard ceiling on how many collections
   * an institution can have before the `in (...)` becomes absurd.
   */
  private async visibleCollectionIds(
    tx: Tx,
    principal: Principal,
    institutionId: string,
  ): Promise<string[] | null> {
    if (can(principal, 'ai.knowledge_base.manage')) return null;

    const audiences = await this.callerAudiences(tx, principal);
    if (audiences.length === 0) return [];

    const rows = await tx
      .select({ id: knowledgeCollections.id })
      .from(knowledgeCollections)
      .where(
        and(
          eq(knowledgeCollections.institutionId, institutionId),
          isNull(knowledgeCollections.archivedAt),
          sql`${knowledgeCollections.visibleToAudiences} && string_to_array(${audiences.join(',')}, ',')::public.knowledge_audience[]`,
        ),
      );
    return rows.map((row) => row.id);
  }

  private applyArchiveFilter(
    principal: Principal,
    filters: SQL[],
    archivedAtColumn: SQLWrapper,
    includeArchived: boolean,
  ): void {
    if (!includeArchived) {
      filters.push(isNull(archivedAtColumn));
      return;
    }
    const permission: Permission = 'ai.knowledge_base.manage';
    if (!can(principal, permission)) {
      throw new ForbiddenError(permission, 'You cannot view archived knowledge-base records');
    }
  }

  private async loadCollection(
    tx: Tx,
    institutionId: string,
    id: string,
  ): Promise<CollectionRow> {
    const [row] = await tx
      .select()
      .from(knowledgeCollections)
      .where(
        and(
          eq(knowledgeCollections.id, id),
          eq(knowledgeCollections.institutionId, institutionId),
          isNull(knowledgeCollections.archivedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError('Knowledge collection', id);
    return row;
  }

  private async loadDocument(
    tx: Tx,
    institutionId: string,
    id: string,
    options: { includeArchived?: boolean } = {},
  ): Promise<DocumentRow> {
    const filters: SQL[] = [
      eq(knowledgeDocuments.id, id),
      eq(knowledgeDocuments.institutionId, institutionId),
    ];
    if (!options.includeArchived) filters.push(isNull(knowledgeDocuments.archivedAt));

    const [row] = await tx
      .select()
      .from(knowledgeDocuments)
      .where(and(...filters))
      .limit(1);
    if (!row) throw new NotFoundError('Knowledge document', id);
    return row;
  }

  /** One place that fills in the request-context fields every audit row needs. */
  private async recordAudit(
    tx: Tx,
    principal: Principal,
    institutionId: string,
    input: {
      action: 'create' | 'update' | 'archive' | 'export';
      resourceType: string;
      resourceId: string | null;
      resourceLabel: string | null;
      previousValue?: unknown;
      newValue?: unknown;
      reason?: string | null;
      isAiInitiated: boolean;
    },
  ): Promise<void> {
    const context = currentContext();
    await this.audit.recordInTransaction(tx, {
      tenantId: principal.tenantId,
      institutionId,
      actorUserId: principal.userId,
      actorRoles: principal.roles.map((role) => role.roleKey),
      action: input.action,
      module: 'knowledge',
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      resourceLabel: input.resourceLabel,
      previousValue: input.previousValue,
      newValue: input.newValue,
      reason: input.reason ?? null,
      requestId: context?.requestId ?? null,
      ipAddress: context?.ipAddress ?? null,
      userAgent: context?.userAgent ?? null,
      isAiInitiated: input.isAiInitiated,
    });
  }
}

// ────────────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────────────────────────

/**
 * How many rows go into one INSERT.
 *
 * A 1536-element vector is one parameter, but the row around it is a dozen more, and the
 * driver's protocol caps a statement at 65,535 parameters. 200 rows keeps every batch an
 * order of magnitude below that with room for the row to grow columns.
 */
const CHUNK_INSERT_BATCH = 200;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * pgvector's text input format.
 *
 * Built here rather than passed as a JavaScript array because the value is bound as a single
 * text parameter and cast, which keeps the statement free of any array-serialisation
 * behaviour that differs between driver versions. `Number.isFinite` is checked because a NaN
 * from a misbehaving adapter would serialise to `NaN` and be accepted by pgvector as a value
 * that then poisons every distance computation against it.
 */
function toVectorLiteral(vector: number[]): string {
  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new InternalError('The embedding contains a non-finite value', {
        detail: 'A NaN or Infinity in a vector makes every distance against it meaningless',
      });
    }
  }
  return `[${vector.join(',')}]`;
}

function toSearchResult(row: Record<string, unknown>): KnowledgeSearchResult {
  return {
    chunkId: String(row['chunk_id']),
    documentId: String(row['document_id']),
    documentTitle: String(row['document_title']),
    collectionId: String(row['collection_id']),
    collectionName: String(row['collection_name']),
    seq: Number(row['seq']),
    excerpt: String(row['content']),
    headingPath: row['heading_path'] === null ? null : String(row['heading_path']),
    charFrom: Number(row['char_from']),
    charTo: Number(row['char_to']),
    pageFrom: row['page_from'] === null ? null : Number(row['page_from']),
    pageTo: row['page_to'] === null ? null : Number(row['page_to']),
    score: Number(row['score']),
  };
}

function diffOf<T extends Record<string, unknown>>(
  before: T,
  after: T,
  keys: string[],
): Partial<T> {
  const previous: Partial<T> = {};
  for (const key of keys) {
    const typedKey = key as keyof T;
    if (JSON.stringify(before[typedKey]) !== JSON.stringify(after[typedKey])) {
      (previous as Record<string, unknown>)[key] = before[typedKey];
    }
  }
  return previous;
}

// ── Sort-column maps ─────────────────────────────────────────────────────────────────

const COLLECTION_COLUMNS = {
  nameEn: knowledgeCollections.nameEn,
  slug: knowledgeCollections.slug,
  createdAt: knowledgeCollections.createdAt,
} as const;

const DOCUMENT_COLUMNS = {
  title: knowledgeDocuments.title,
  status: knowledgeDocuments.status,
  ingestedAt: knowledgeDocuments.ingestedAt,
  createdAt: knowledgeDocuments.createdAt,
} as const;

/** Re-exported so the ai module can budget a prompt with the same estimate the chunker uses. */
export { estimateTokens } from './chunker';
