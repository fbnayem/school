/**
 * Knowledge base endpoints (Phase 31, docs/06 §5).
 *
 * Every route is `@InstitutionScoped()`: a collection, a document and its embeddings belong
 * to one institution, and a group administrator running three schools has no safe default.
 * The header is required by the tenant guard rather than guessed here.
 *
 * The permission split:
 *
 *   ai.knowledge_base.manage — create, edit and archive collections; ingest, re-ingest and
 *                              archive documents. Everything that changes the corpus.
 *   ai.copilot.use           — read the catalogue and retrieve from it.
 *   ai.tutor.use             — retrieve, and nothing else.
 *
 * ── One deliberate widening, stated in writing ────────────────────────────────────────
 *
 * `POST /search` accepts `ai.copilot.use` **or** `ai.tutor.use`, rather than `ai.copilot.use`
 * alone. Retrieval with citations is the tutor's whole reason to exist (docs/06 §5), and the
 * `student` system role holds `ai.tutor.use` and not `ai.copilot.use` — so requiring the
 * copilot permission would make a student's tutor unable to cite the syllabus it is meant to
 * teach from. Both strings already exist in `packages/permissions/src/catalog.ts`; nothing
 * new was invented. The widening costs nothing in confidentiality because visibility is
 * enforced on the data: the service filters candidate chunks by the caller's own role
 * audiences inside the SQL, so a student holding `ai.tutor.use` still cannot retrieve a
 * staff-only collection, and the integration suite proves that through the API and again
 * through raw SQL as the unprivileged application role.
 *
 * ── Route order ───────────────────────────────────────────────────────────────────────
 *
 * Nest matches in declaration order, so `collections`, `documents` and `search` are declared
 * before any `:id` route that would otherwise swallow them.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { normalizeOffsetPage } from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import {
  createKnowledgeCollectionSchema,
  createKnowledgeDocumentSchema,
  idParamSchema,
  knowledgeArchiveSchema,
  knowledgeSearchSchema,
  listKnowledgeCollectionsSchema,
  listKnowledgeDocumentsSchema,
  reingestKnowledgeDocumentSchema,
  updateKnowledgeCollectionSchema,
} from '@shikkha/validation';
import { KnowledgeService, type UploadedFileLike } from './knowledge.service';
import { Audited, CurrentUser, InstitutionScoped, RequirePermissions } from '../../common/decorators';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { currentContext } from '../../common/context/request-context';

/**
 * The transport-level upload ceiling.
 *
 * A fixed literal rather than the configured `KNOWLEDGE_MAX_UPLOAD_BYTES`, because a decorator
 * argument is evaluated when this class is defined — at import time, before the process has
 * finished loading its configuration — so reading configuration here would freeze whatever the
 * environment happened to hold at import. It is deliberately far above any sane configured
 * limit so that the *service* is what refuses an oversized upload, with a message naming the
 * actual limit in megabytes; multer's own rejection is a bare 413 with no such explanation.
 */
const MULTIPART_HARD_CAP_BYTES = 32 * 1024 * 1024;

@ApiTags('knowledge')
@Controller('knowledge')
@InstitutionScoped()
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  // ── Collections ─────────────────────────────────────────────────────────────────────

  @Get('collections')
  @RequirePermissions('ai.copilot.use')
  @ApiOperation({ summary: 'List knowledge collections this caller may search' })
  async listCollections(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listKnowledgeCollectionsSchema))
    query: z.infer<typeof listKnowledgeCollectionsSchema>,
  ) {
    return this.knowledge.listCollections(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Post('collections')
  @RequirePermissions('ai.knowledge_base.manage')
  @Audited({
    module: 'knowledge',
    resourceType: 'knowledge_collection',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create a collection and declare which audiences may search it' })
  async createCollection(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createKnowledgeCollectionSchema))
    body: z.infer<typeof createKnowledgeCollectionSchema>,
  ) {
    return this.knowledge.createCollection(principal, requireInstitution(), body);
  }

  @Patch('collections/:id')
  @RequirePermissions('ai.knowledge_base.manage')
  @Audited({
    module: 'knowledge',
    resourceType: 'knowledge_collection',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update a collection, including its audience visibility' })
  async updateCollection(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateKnowledgeCollectionSchema))
    body: z.infer<typeof updateKnowledgeCollectionSchema>,
  ) {
    const result = await this.knowledge.updateCollection(
      principal,
      requireInstitution(),
      params.id,
      body,
    );
    // `__audit` is read by the audit interceptor and stripped from the HTTP response, so the
    // trail records what actually changed. Narrowing an audience list is the change here that
    // most needs a before-state on the record.
    return { ...result.collection, __audit: { previousValue: result.previous, newValue: body } };
  }

  /** Archiving takes the collection's documents and chunks out of search with it. */
  @Post('collections/:id/archive')
  @RequirePermissions('ai.knowledge_base.manage')
  @Audited({
    module: 'knowledge',
    resourceType: 'knowledge_collection',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive a collection and everything indexed under it' })
  async archiveCollection(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(knowledgeArchiveSchema)) body: { reason: string },
  ) {
    return this.knowledge.archiveCollection(
      principal,
      requireInstitution(),
      params.id,
      body.reason,
    );
  }

  // ── Documents ───────────────────────────────────────────────────────────────────────

  @Get('documents')
  @RequirePermissions('ai.copilot.use')
  @ApiOperation({ summary: 'List ingested documents and their pipeline status' })
  async listDocuments(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listKnowledgeDocumentsSchema))
    query: z.infer<typeof listKnowledgeDocumentsSchema>,
  ) {
    return this.knowledge.listDocuments(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  /**
   * Ingest a document: extract → chunk → embed → store.
   *
   * Accepts multipart (a `.txt`/`.md` file in the `file` field) or a JSON body carrying the
   * text. The pipeline runs inline rather than on a queue, so the response says whether the
   * document is `ready` or `failed` and why — a background job would return `pending` and
   * leave an administrator refreshing a page to find out whether their handbook is searchable.
   *
   * `recordedBy: 'service'`: the service writes the audit row inside the transaction that
   * inserts the document, and a second row for the pipeline's outcome. Without this the
   * interceptor would add a third, with a null previous value.
   */
  @Post('documents')
  @RequirePermissions('ai.knowledge_base.manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MULTIPART_HARD_CAP_BYTES } }))
  @ApiConsumes('multipart/form-data', 'application/json')
  @Audited({
    module: 'knowledge',
    resourceType: 'knowledge_document',
    action: 'create',
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Ingest a document into a collection' })
  async createDocument(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createKnowledgeDocumentSchema))
    body: z.infer<typeof createKnowledgeDocumentSchema>,
    @UploadedFile() file: UploadedFileLike | undefined,
  ) {
    return this.knowledge.createDocument(principal, requireInstitution(), body, file);
  }

  @Get('documents/:id')
  @RequirePermissions('ai.copilot.use')
  @ApiOperation({ summary: 'One document with its chunk inventory and failure reason if any' })
  async getDocument(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.knowledge.getDocument(principal, requireInstitution(), params.id);
  }

  /**
   * Re-ingest. Unchanged text costs nothing: every chunk hash already in the embedding cache
   * is served from it and the provider is never called.
   */
  @Post('documents/:id/reingest')
  @RequirePermissions('ai.knowledge_base.manage')
  @Audited({
    module: 'knowledge',
    resourceType: 'knowledge_document',
    action: 'update',
    resourceIdFrom: 'param:id',
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Re-extract, re-chunk and re-embed a document' })
  async reingestDocument(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(reingestKnowledgeDocumentSchema))
    body: z.infer<typeof reingestKnowledgeDocumentSchema>,
  ) {
    return this.knowledge.reingestDocument(principal, requireInstitution(), params.id, body);
  }

  /** Archive, never delete — and archiving removes it from every future retrieval. */
  @Post('documents/:id/archive')
  @RequirePermissions('ai.knowledge_base.manage')
  @Audited({
    module: 'knowledge',
    resourceType: 'knowledge_document',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive a document and take its chunks out of search' })
  async archiveDocument(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(knowledgeArchiveSchema)) body: { reason: string },
  ) {
    return this.knowledge.archiveDocument(principal, requireInstitution(), params.id, body.reason);
  }

  // ── Search ──────────────────────────────────────────────────────────────────────────

  /**
   * Retrieve with citations.
   *
   * Audited as an **export**, because that is what it is: a search reads the school's own
   * documents and hands the text to whoever asked. "Which account pulled which documents, and
   * what were they looking for" is a question an investigation asks, and it cannot be answered
   * later from a log nobody wrote.
   *
   * An empty `results` array with `belowFloor: true` is a real answer, not a failure: nothing
   * in this school's documents was similar enough to cite, and docs/06 §5 says that is
   * reported rather than generated around.
   */
  @Post('search')
  @RequirePermissions('ai.copilot.use', 'ai.tutor.use', { mode: 'any' })
  @Audited({ module: 'knowledge', resourceType: 'knowledge_search', action: 'export' })
  @ApiOperation({ summary: 'Semantic search over this institution’s documents, with citations' })
  async search(
    @CurrentUser() principal: Principal,
    @Body(zodBody(knowledgeSearchSchema)) body: z.infer<typeof knowledgeSearchSchema>,
  ) {
    return this.knowledge.searchDetailed(principal, requireInstitution(), body);
  }
}

/**
 * `@InstitutionScoped()` and this helper are belt and braces: the tenant guard refuses the
 * request without the header, and this re-reads it because `currentContext()` is typed
 * `string | null` and a service should not have to handle a case the guard already excluded.
 */
function requireInstitution(): string {
  const institutionId = currentContext()?.institutionId;
  if (!institutionId) {
    throw new BadRequestException(
      'Send the x-institution-id header to indicate which institution this knowledge base belongs to.',
    );
  }
  return institutionId;
}
