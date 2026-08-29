/**
 * Injection ports for the parts of the AI layer this module does not own.
 *
 * Phases 29-30 (the tool surface) and the knowledge base / gateway phases are built in
 * parallel, so this module compiles and boots on its own and picks up the others when they
 * are bound. Every port here is `@Optional()` at the injection site, and every tool that
 * depends on one refuses **loudly** when it is missing — never a fabricated answer, which for
 * a retrieval tool would mean a hallucinated school policy quoted back to a parent as if it
 * were in the handbook.
 *
 * These are narrow deliberately. A port that exposed the whole knowledge service would make
 * the tool layer depend on that module's internals and would give a future tool a way to
 * reach data without going through a permission check.
 */

import type { Principal } from '@shikkha/permissions';

// ── Knowledge base retrieval ───────────────────────────────────────────────────────────

export const KNOWLEDGE_SEARCH = Symbol('KNOWLEDGE_SEARCH');

export interface KnowledgeSearchChunk {
  documentId: string;
  documentTitle: string;
  chunkId: string;
  excerpt: string;
  score: number;
}

/**
 * The knowledge module's retrieval entry point.
 *
 * The `principal` is passed rather than assumed: retrieval is tenant-isolated by RLS (docs/06
 * §5 — the embeddings live in the same database precisely so the same policies apply), but a
 * document may additionally be restricted to staff, and only the implementation knows that.
 */
export interface KnowledgeSearchPort {
  search(
    principal: Principal,
    institutionId: string,
    query: string,
    limit: number,
  ): Promise<{ chunks: KnowledgeSearchChunk[] }>;
}

// ── Usage and cost accounting ──────────────────────────────────────────────────────────

export const AI_USAGE_RECORDER = Symbol('AI_USAGE_RECORDER');

/**
 * What one tool invocation consumed.
 *
 * `costAmount` is a **decimal string with four places**, matching the `numeric(14,4)` the AI
 * usage log stores. Four places rather than two because inference is priced in fractions of a
 * cent and a per-call cost rounded to 0.01 is a per-call cost of zero. It is never a
 * JavaScript number anywhere on this path: a float accumulated over a month of calls drifts,
 * and the number it drifts away from is a school's bill.
 */
export interface AiToolUsage {
  promptTokens: number;
  completionTokens: number;
  embeddingTokens: number;
  costAmount: string;
  costCurrency: 'USD' | 'BDT';
  provider: string | null;
  model: string | null;
}

/**
 * Most tools are pure database reads and consume no inference at all.
 *
 * They still report a usage record rather than omitting one, because docs/06 §2 rule 3 says
 * every tool call is logged *with its token cost* — and "no row" and "a row saying zero" are
 * different answers to "what did this user's copilot cost us last month".
 */
export const ZERO_AI_TOOL_USAGE: AiToolUsage = {
  promptTokens: 0,
  completionTokens: 0,
  embeddingTokens: 0,
  costAmount: '0.0000',
  costCurrency: 'USD',
  provider: null,
  model: null,
};

export interface AiToolUsageRecord {
  principal: Principal;
  institutionId: string;
  toolName: string;
  usage: AiToolUsage;
  /** Wall-clock duration of the tool call, for the cost dashboard's latency column. */
  durationMs: number;
}

/**
 * The AI module's usage ledger.
 *
 * Bound to `AiUsageService` by the orchestrator once `modules/ai` lands (see the wiring note
 * in `ai-tools.module.ts`). When it is not bound, the invocation is still recorded in the
 * audit log with its cost — the audit row is the record that must never be missing, and the
 * usage ledger is the aggregate view on top of it.
 */
export interface AiUsagePort {
  recordToolUsage(record: AiToolUsageRecord): Promise<void>;
}
