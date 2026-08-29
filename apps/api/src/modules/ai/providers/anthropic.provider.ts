/**
 * Anthropic adapter — the Messages API.
 *
 * A real HTTP client. Without `ANTHROPIC_API_KEY` every operation refuses loudly through
 * `HttpAiProvider.refuseUnconfigured`, with the variable name in the error context and never
 * in the message a client sees.
 *
 * The wire format differs from OpenAI's in four ways that all live here:
 *
 *  - **The system prompt is a top-level `system` field**, not a message. Every `system`
 *    message in the request is concatenated into it, in order.
 *  - **`max_tokens` is required.** There is no "as much as you like"; the adapter falls back
 *    to the deployment's `AI_MAX_OUTPUT_TOKENS` when the caller does not say.
 *  - **A tool result is a `user` message** whose content is a `tool_result` block referencing
 *    the `tool_use_id` it answers — not a distinct role.
 *  - **The reply is a list of content blocks**, mixing `text` and `tool_use`; the text parts
 *    are joined and the tool uses are lifted out.
 *
 * There is no embeddings endpoint on this API. `embed()` therefore refuses — loudly, and with
 * a remedy naming the variable to point retrieval at a provider that does have one. Silently
 * falling back to another vendor's embedder would put two incompatible vector spaces in one
 * `pgvector` column, and nothing would notice until retrieval quietly stopped working.
 *
 * The default models below are configuration with a default, not a claim about what is
 * current: override with `AI_ROUTING_<TASK>=anthropic:<model>`, and add the row to
 * `MODEL_PRICES` when you do.
 */

import { ExternalServiceError } from '@shikkha/shared';
import { HttpAiProvider } from './http-provider.base';
import type {
  AiProvider,
  AiTask,
  CompletionRequest,
  CompletionResponse,
  CompletionToolCall,
  EmbeddingResponse,
  InspectableAiProvider,
} from './provider.interface';

export const ANTHROPIC_REQUIRED_VARIABLES = ['ANTHROPIC_API_KEY'] as const;

/** The API version header this adapter's request and response shapes were written against. */
const API_VERSION = '2023-06-01';

const DEFAULT_MODELS: Record<AiTask, string> = {
  classification: 'claude-haiku-4-5',
  summarisation: 'claude-haiku-4-5',
  analytics_reasoning: 'claude-sonnet-4-5',
  tutoring: 'claude-haiku-4-5',
  document_understanding: 'claude-sonnet-4-5',
  // Present only to satisfy the map. `embed()` refuses; see the file header.
  embedding: 'claude-haiku-4-5',
};

interface MessagesResponseBody {
  model?: string;
  stop_reason?: string;
  content?: {
    type?: string;
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
  }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class AnthropicProvider
  extends HttpAiProvider
  implements AiProvider, InspectableAiProvider
{
  readonly key = 'anthropic' as const;
  protected readonly displayName = 'Anthropic';
  protected readonly requiredVariables = ANTHROPIC_REQUIRED_VARIABLES;

  constructor(
    timeoutMs: number,
    private readonly modelOverride: string | undefined,
    private readonly defaultMaxOutputTokens: number,
  ) {
    super(timeoutMs);
  }

  private baseUrl(): string {
    return (process.env['ANTHROPIC_BASE_URL'] ?? 'https://api.anthropic.com/v1').replace(
      /\/+$/,
      '',
    );
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.assertConfigured('generate a completion');
    const model = this.modelOverride ?? DEFAULT_MODELS[request.task];

    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');

    const messages = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) =>
        message.role === 'tool'
          ? {
              role: 'user' as const,
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: message.toolCallId ?? '',
                  content: message.content,
                },
              ],
            }
          : { role: message.role as 'user' | 'assistant', content: message.content },
      );

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: request.maxOutputTokens ?? this.defaultMaxOutputTokens,
    };
    if (system.length > 0) body['system'] = system;
    if (request.temperature !== undefined) body['temperature'] = request.temperature;
    if (request.tools && request.tools.length > 0) {
      body['tools'] = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
    }

    const response = await this.postJson<MessagesResponseBody>(
      `${this.baseUrl()}/messages`,
      {
        'x-api-key': this.credential('ANTHROPIC_API_KEY'),
        'anthropic-version': API_VERSION,
      },
      body,
      'generate a completion',
    );

    const blocks = response.content;
    if (!Array.isArray(blocks)) {
      this.malformed('generate a completion', 'the response carried no content blocks');
    }

    const text = blocks
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text ?? '')
      .join('');

    const toolCalls: CompletionToolCall[] = blocks
      .filter((block) => block.type === 'tool_use' && typeof block.name === 'string')
      .map((block) => ({
        id: block.id ?? '',
        name: block.name ?? '',
        arguments:
          block.input && typeof block.input === 'object' && !Array.isArray(block.input)
            ? (block.input as Record<string, unknown>)
            : {},
      }));

    return {
      text,
      toolCalls,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
      model: response.model ?? model,
      finishReason: mapStopReason(response.stop_reason),
    };
  }

  /**
   * Refused, always, whatever the credentials say.
   *
   * This API has no embeddings endpoint. Quietly borrowing another vendor's embedder would
   * write vectors from a second, incompatible vector space into the same `pgvector` column,
   * and retrieval would degrade with nothing anywhere reporting a fault.
   */
  async embed(_texts: string[]): Promise<EmbeddingResponse> {
    throw new ExternalServiceError(
      this.displayName,
      'Cannot generate embeddings: this provider has no embeddings endpoint.',
      {
        provider: this.key,
        remedy:
          'Point embeddings at a provider that has one — AI_ROUTING_EMBEDDING=openai or AI_ROUTING_EMBEDDING=gemini — or AI_ROUTING_EMBEDDING=mock for the deterministic local adapter.',
      },
    );
  }
}

/**
 * Anything unrecognised maps to `content_filter` rather than `stop`, for the same reason as
 * in the OpenAI adapter: a new refusal reason read as a clean stop would present a refused
 * answer as a complete one.
 */
function mapStopReason(raw: string | undefined): CompletionResponse['finishReason'] {
  switch (raw) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    default:
      return 'content_filter';
  }
}
