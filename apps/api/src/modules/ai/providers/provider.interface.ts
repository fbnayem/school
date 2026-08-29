/**
 * The AI provider abstraction (docs/06_AI_ARCHITECTURE.md §4).
 *
 * "No application logic references a vendor. A provider change is configuration."
 *
 * That sentence is only true if this interface is the *whole* surface. Nothing above it may
 * know that OpenAI calls a system prompt a `system` message and Anthropic passes it as a
 * top-level `system` field, that Gemini names roles `user`/`model`, or that each of the
 * three reports token usage under a different key. All of that lives in an adapter.
 *
 * Two things are deliberately absent:
 *
 *  - **Credentials.** An adapter reads its own key from the environment. Nothing passes one
 *    across this boundary, and nothing stores one in the database, so there is no code path
 *    through which a key could reach a response body or an audit row.
 *  - **Anything tenant-shaped.** A provider takes messages and returns text. Every
 *    authorization decision — who may ask, whose data the answer may draw on, whether the
 *    budget allows the call at all — happens before an adapter is ever consulted. Per
 *    docs/06 §1 that is structural: the model cannot talk its way past a check it is never
 *    offered.
 *
 * These signatures are a contract shared with the retrieval and copilot modules. Changing
 * one is a coordinated change, not a local one.
 */

export interface CompletionMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Present only on role: 'tool' — the invocation this message answers. */
  toolCallId?: string;
}

export interface CompletionToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments, derived from the Zod schema of the tool. */
  parameters: Record<string, unknown>;
}

export interface CompletionRequest {
  task: AiTask;
  messages: CompletionMessage[];
  tools?: CompletionToolSpec[];
  maxOutputTokens?: number;
  temperature?: number;
}

export interface CompletionToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface CompletionResponse {
  text: string;
  toolCalls: CompletionToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  model: string;
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter';
}

export interface EmbeddingResponse {
  vectors: number[][];
  usage: { inputTokens: number };
  model: string;
  dimensions: number;
}

export interface AiProvider {
  readonly key: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  embed(texts: string[]): Promise<EmbeddingResponse>;
}

/** Per-task routing: cheap classification to a small model, reasoning to a capable one. */
export type AiTask =
  | 'classification'
  | 'summarisation'
  | 'analytics_reasoning'
  | 'tutoring'
  | 'document_understanding'
  | 'embedding';

/** Every task, in a form a loop or a Zod enum can consume. */
export const AI_TASK_LIST: readonly AiTask[] = [
  'classification',
  'summarisation',
  'analytics_reasoning',
  'tutoring',
  'document_understanding',
  'embedding',
];

/**
 * What a provider adapter reports about its own readiness, for `GET /ai/providers`.
 *
 * `credentialsPresent` is a boolean and nothing more. The endpoint that surfaces this must
 * never expose a key, a prefix of one, a length, or a masked form — a masked key still
 * narrows a search space, and there is no operational question a masked key answers that
 * "configured: yes/no" plus the variable's *name* does not.
 */
export interface AiProviderStatus {
  key: string;
  /** True when every environment variable this adapter needs is set and non-empty. */
  credentialsPresent: boolean;
  /** The names of the variables that are missing. Names only — never values. */
  missingVariables: string[];
  /** Whether this adapter can serve a request with no credentials at all (only `mock`). */
  worksWithoutCredentials: boolean;
}

/** A provider adapter that can report whether it is configured. Every adapter implements it. */
export interface InspectableAiProvider extends AiProvider {
  status(): AiProviderStatus;
}
