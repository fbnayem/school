/**
 * `knowledge.search` — retrieval over the school's own documents, with citations.
 *
 * This module owns none of the retrieval. Ingestion, chunking, embedding and the pgvector
 * search live in the knowledge module, and reaching them through a narrow port (`ports.ts`)
 * keeps the tool surface compiling and bootable while that module is built in parallel.
 *
 * The refusal path is the part worth reading. When the port is not bound, this tool answers
 * **503**, loudly, naming nothing about the deployment in the public message. What it must
 * never do is return `{ chunks: [] }`: an empty result is indistinguishable from "your school
 * has no policy on this", the model reports that as fact, and a parent is told the school has
 * no anti-bullying policy because a provider was unconfigured. docs/06 §5 says an answer with
 * no citation is reported as "not found in your school's documents" — which is only a safe
 * thing to say when a search actually ran.
 *
 * Every excerpt comes back wrapped as untrusted data. A school's knowledge base is a pile of
 * PDFs somebody emailed them; treating its contents as trusted instruction text would make
 * document upload a prompt-injection vector with no attacker interaction at all.
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import { TransportError } from '@shikkha/shared';
import {
  knowledgeSearchArgsSchema,
  type KnowledgeSearchArgs,
  type AiToolName,
} from '@shikkha/validation';
import type { Permission } from '@shikkha/permissions';
import { KNOWLEDGE_SEARCH, type KnowledgeSearchPort } from '../ports';
import { untrusted } from '../untrusted-text';
import { getLogger } from '../../../common/logger';
import type { AiTool, AiToolCitation, AiToolContext, AiToolResult } from './tool.types';

interface KnowledgePassage {
  documentId: string;
  /** Wrapped: a document title is whatever the uploader typed or the file was called. */
  documentTitle: string | null;
  chunkId: string;
  /** Wrapped: this is the body of a file the school uploaded. */
  excerpt: string | null;
  /** The retriever's similarity score, passed through unchanged. */
  score: number;
}

@Injectable()
export class KnowledgeSearchTool implements AiTool<KnowledgeSearchArgs> {
  readonly name: AiToolName = 'knowledge.search';
  readonly description =
    "Search the school's own uploaded documents — policies, handbooks, syllabus, notices, " +
    'admission rules — and return matching passages with citations. Quote only what the ' +
    'passages say and cite the document each claim came from; if nothing relevant comes ' +
    'back, say the answer was not found in the school’s documents rather than answering from ' +
    'general knowledge.';
  readonly schema = knowledgeSearchArgsSchema;
  /**
   * Either grounds. Someone who maintains the knowledge base must be able to test it, and
   * anyone with a copilot needs to be able to ask it a question — the documents are the
   * school's own policies, not privileged records.
   */
  readonly permissions: readonly Permission[] = ['ai.knowledge_base.manage', 'ai.copilot.use'];
  /** The search phrase originates in a person's question. */
  readonly freeTextArguments = ['query'] as const;

  constructor(
    @Optional()
    @Inject(KNOWLEDGE_SEARCH)
    private readonly knowledge: KnowledgeSearchPort | null = null,
  ) {}

  async execute(
    context: AiToolContext,
    args: KnowledgeSearchArgs,
  ): Promise<AiToolResult<{ passages: KnowledgePassage[] }>> {
    // Read into a local so the `never` return of `refuse()` narrows it: narrowing on `this.x`
    // across a method call is not something to rely on.
    const knowledge = this.knowledge;
    if (!knowledge) this.refuse();

    const { chunks } = await knowledge.search(
      context.principal,
      context.institutionId,
      args.query,
      args.limit,
    );

    const passages: KnowledgePassage[] = chunks.map((chunk) => ({
      documentId: chunk.documentId,
      documentTitle: untrusted('knowledge.documentTitle', chunk.documentTitle),
      chunkId: chunk.chunkId,
      excerpt: untrusted('knowledge.excerpt', chunk.excerpt),
      score: chunk.score,
    }));

    const citations: AiToolCitation[] = chunks.map((chunk) => ({
      documentId: chunk.documentId,
      documentTitle: chunk.documentTitle,
      chunkId: chunk.chunkId,
    }));

    // No `usage` is reported. The embedding of the query is the knowledge module's call and
    // its cost belongs to that module's own usage row; claiming it here would double-count it
    // against the tenant's budget.
    return { data: { passages }, rowCount: passages.length, citations };
  }

  /**
   * Refuse, in the shape `docs/09` and `StubGpsProvider` established: loud, specific in the
   * log, generic in the response.
   *
   * The public message names no environment variable and no provider — that is information
   * disclosure, and an unauthenticated probe of which integrations a tenant has enabled is
   * reconnaissance. The operator-facing detail goes to the log against the request id.
   */
  private refuse(): never {
    getLogger().error(
      { port: 'KNOWLEDGE_SEARCH', tool: this.name },
      'knowledge.search was invoked but no KnowledgeSearchPort is bound — refusing rather ' +
        'than returning an empty result that reads as "your school has no such document"',
    );
    throw new TransportError(
      503,
      'EXTERNAL_SERVICE_ERROR',
      'Document search is not available for this school yet. No answer was produced — do not ' +
        'treat this as "nothing found".',
      // Public: the message says nothing about the deployment and everything the caller needs.
      true,
    );
  }
}
