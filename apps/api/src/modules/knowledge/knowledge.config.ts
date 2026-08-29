/**
 * Knowledge-base tuning parameters.
 *
 * These live here rather than in `config/env.ts` because they are this module's dials and
 * nothing else reads them; `config/env.ts` holds the variables the whole process cannot start
 * without. The parsing style is the same — Zod, once, with a readable failure — so a typo in
 * `KNOWLEDGE_CHUNK_MAX_TOKENS` is a startup error and not an odd retrieval quality complaint
 * three weeks later.
 *
 * Every default below is argued in a comment. They are the values the integration suite runs
 * against, so changing one and not the other is a visible change.
 */

import { z } from 'zod';

const schema = z.object({
  /**
   * The size a chunk aims for.
   *
   * A retrieval chunk has two jobs that pull in opposite directions: it must be small enough
   * that its embedding represents one idea (a 2000-token chunk embeds to the average of a
   * whole chapter and matches nothing precisely), and large enough that the passage answers a
   * question on its own without the reader needing the paragraph before it. Roughly 350
   * tokens is two to four paragraphs of a school policy — one clause of the fee rules, one
   * section of the code of conduct.
   */
  KNOWLEDGE_CHUNK_TARGET_TOKENS: z.coerce.number().int().min(64).max(2_000).default(350),
  /**
   * The hard ceiling. A block larger than this is split even mid-sentence, because a chunk
   * that exceeds the embedding model's context is silently truncated by the provider — and a
   * silently truncated chunk indexes text it does not contain, which is worse than a clumsy
   * split.
   */
  KNOWLEDGE_CHUNK_MAX_TOKENS: z.coerce.number().int().min(128).max(4_000).default(512),
  /**
   * How much of the previous chunk is repeated at the start of the next one.
   *
   * Overlap exists because the answer to a question is often the sentence either side of a
   * chunk boundary — "…refunds are not payable" / "…except where the student withdraws before
   * the term begins". Roughly one paragraph of overlap costs ~17% more storage and provider
   * calls and buys back the boundary cases. Zero disables it.
   */
  KNOWLEDGE_CHUNK_OVERLAP_TOKENS: z.coerce.number().int().min(0).max(1_000).default(60),
  /**
   * The similarity floor. **Below this, retrieval returns nothing at all.**
   *
   * docs/06 §5 is explicit: an answer with no citation is reported as "not found in your
   * school's documents" rather than generated. That guarantee is only real if the retrieval
   * layer is willing to return an empty result, so this floor is the mechanism that makes it
   * real rather than aspirational.
   *
   * 0.30 cosine similarity. With a modern embedding model, unrelated text pairs score around
   * 0.0–0.2 and a passage that genuinely answers the question scores 0.4 and up; 0.30 sits in
   * the gap and is deliberately placed on the conservative side of it. The two failure modes
   * are not symmetric: a missed citation produces "not found in your school's documents",
   * which is honest and actionable, while a spurious one produces a confidently wrong answer
   * attributed to the school's own handbook.
   *
   * A caller may raise it per request (`minScore`) but never lower it — a floor a client can
   * lower is not a floor.
   */
  KNOWLEDGE_SEARCH_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.3),
  /**
   * How many candidates the vector scan asks for, as a multiple of the requested limit.
   *
   * An approximate index applies the tenant, institution, collection, audience and archive
   * filters to the candidates it returns, so asking for exactly `limit` rows can yield fewer.
   * Over-fetching absorbs that. It costs nothing on an exact scan, which is what the planner
   * chooses for a single institution's corpus today.
   */
  KNOWLEDGE_SEARCH_OVERFETCH: z.coerce.number().int().min(1).max(20).default(4),
  /**
   * How many chunks are sent to the provider in one embedding call. Batching is the single
   * biggest cost lever in ingestion: 200 chunks in 4 calls instead of 200.
   */
  KNOWLEDGE_EMBED_BATCH_SIZE: z.coerce.number().int().min(1).max(512).default(64),
  /** Upload ceiling. A handbook is a few hundred kilobytes of text; 5 MB is generous. */
  KNOWLEDGE_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .default(5 * 1024 * 1024),
});

export type KnowledgeConfig = z.infer<typeof schema>;

let cached: KnowledgeConfig | null = null;

export function knowledgeConfig(): KnowledgeConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid knowledge-base configuration: ${detail}`);
  }
  if (parsed.data.KNOWLEDGE_CHUNK_OVERLAP_TOKENS >= parsed.data.KNOWLEDGE_CHUNK_TARGET_TOKENS) {
    // Overlap at or above the target means every chunk repeats the whole of the previous one
    // and the loop that advances through the document never advances.
    throw new Error(
      'KNOWLEDGE_CHUNK_OVERLAP_TOKENS must be smaller than KNOWLEDGE_CHUNK_TARGET_TOKENS',
    );
  }
  if (parsed.data.KNOWLEDGE_CHUNK_MAX_TOKENS < parsed.data.KNOWLEDGE_CHUNK_TARGET_TOKENS) {
    throw new Error(
      'KNOWLEDGE_CHUNK_MAX_TOKENS must be at least KNOWLEDGE_CHUNK_TARGET_TOKENS',
    );
  }
  cached = parsed.data;
  return cached;
}

/** Mirrors `resetEnvCache()`; the integration suite sets variables after the module loads. */
export function resetKnowledgeConfigCache(): void {
  cached = null;
}
