/**
 * OpenAI adapter — Chat Completions and Embeddings.
 *
 * A real HTTP client, not a stub: with `OPENAI_API_KEY` set it works, and without it every
 * operation refuses loudly through `HttpAiProvider.refuseUnconfigured`, naming the missing
 * variable in the error *context* and never in the message a client sees.
 *
 * Everything vendor-shaped is confined to this file. The wire format differences that matter:
 * a system prompt is an ordinary message with `role: 'system'`; a tool result is a message
 * with `role: 'tool'` carrying the `tool_call_id` it answers; tool arguments arrive as a JSON
 * *string* rather than an object and are parsed here; and usage is reported as
 * `prompt_tokens` / `completion_tokens`.
 *
 * The default models below are **configuration with a default**, not a claim about what is
 * current — a deployment overrides any of them with `AI_ROUTING_<TASK>=openai:<model>`, and
 * whoever changes one should also add its row to `MODEL_PRICES` in `ai-pricing.ts`.
 */

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

export const OPENAI_REQUIRED_VARIABLES = ['OPENAI_API_KEY'] as const;

/** Cheap work to a small model, reasoning to a capable one — docs/06 §4. */
const DEFAULT_MODELS: Record<AiTask, string> = {
  classification: 'gpt-4o-mini',
  summarisation: 'gpt-4o-mini',
  analytics_reasoning: 'gpt-4o',
  tutoring: 'gpt-4o-mini',
  document_understanding: 'gpt-4o',
  embedding: 'text-embedding-3-small',
};

interface ChatCompletionResponseBody {
  model?: string;
  choices?: {
    finish_reason?: string;
    message?: {
      content?: string | null;
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface EmbeddingResponseBody {
  model?: string;
  data?: { embedding?: number[] }[];
  usage?: { prompt_tokens?: number };
}

export class OpenAiProvider extends HttpAiProvider implements AiProvider, InspectableAiProvider {
  readonly key = 'openai' as const;
  protected readonly displayName = 'OpenAI';
  protected readonly requiredVariables = OPENAI_REQUIRED_VARIABLES;

  constructor(
    timeoutMs: number,
    /** A deployment's model override; falls back to the per-task default above. */
    private readonly modelOverride: string | undefined,
    private readonly embeddingDimensions: number,
  ) {
    super(timeoutMs);
  }

  private baseUrl(): string {
    return (process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.assertConfigured('generate a completion');
    const model = this.modelOverride ?? DEFAULT_MODELS[request.task];

    const body: Record<string, unknown> = {
      model,
      messages: request.messages.map((message) =>
        message.role === 'tool'
          ? { role: 'tool', tool_call_id: message.toolCallId ?? '', content: message.content }
          : { role: message.role, content: message.content },
      ),
    };
    if (request.maxOutputTokens !== undefined) body['max_tokens'] = request.maxOutputTokens;
    if (request.temperature !== undefined) body['temperature'] = request.temperature;
    if (request.tools && request.tools.length > 0) {
      body['tools'] = request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
      body['tool_choice'] = 'auto';
    }

    const response = await this.postJson<ChatCompletionResponseBody>(
      `${this.baseUrl()}/chat/completions`,
      { authorization: `Bearer ${this.credential('OPENAI_API_KEY')}` },
      body,
      'generate a completion',
    );

    const choice = response.choices?.[0];
    if (!choice) this.malformed('generate a completion', 'the response contained no choices');

    return {
      text: choice.message?.content ?? '',
      toolCalls: parseToolCalls(choice.message?.tool_calls),
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
      model: response.model ?? model,
      finishReason: mapFinishReason(choice.finish_reason),
    };
  }

  async embed(texts: string[]): Promise<EmbeddingResponse> {
    this.assertConfigured('generate embeddings');
    const model = this.modelOverride ?? DEFAULT_MODELS.embedding;

    const response = await this.postJson<EmbeddingResponseBody>(
      `${this.baseUrl()}/embeddings`,
      { authorization: `Bearer ${this.credential('OPENAI_API_KEY')}` },
      // `dimensions` is honoured by the v3 embedding models and ignored by older ones. Sending
      // it keeps the vectors the width the retrieval schema was built for; a mismatch is
      // caught below rather than stored and discovered later as unexplained bad ranking.
      { model, input: texts, dimensions: this.embeddingDimensions },
      'generate embeddings',
    );

    const vectors = (response.data ?? []).map((row) => row.embedding ?? []);
    if (vectors.length !== texts.length) {
      this.malformed(
        'generate embeddings',
        `expected ${texts.length} vectors, received ${vectors.length}`,
      );
    }
    const wrongWidth = vectors.find((vector) => vector.length !== this.embeddingDimensions);
    if (wrongWidth) {
      this.malformed(
        'generate embeddings',
        `expected ${this.embeddingDimensions}-dimensional vectors, received ${wrongWidth.length}`,
      );
    }

    return {
      vectors,
      usage: { inputTokens: response.usage?.prompt_tokens ?? 0 },
      model: response.model ?? model,
      dimensions: this.embeddingDimensions,
    };
  }
}

function parseToolCalls(
  raw: { id?: string; function?: { name?: string; arguments?: string } }[] | undefined,
): CompletionToolCall[] {
  if (!raw) return [];
  const calls: CompletionToolCall[] = [];
  for (const call of raw) {
    const name = call.function?.name;
    if (!name) continue;
    let args: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(call.function?.arguments ?? '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      // A model can emit arguments that are not valid JSON. An empty object is passed on and
      // the caller's Zod schema rejects it — which is the same path a well-formed but wrong
      // argument set takes, so there is one failure mode rather than two.
      args = {};
    }
    calls.push({ id: call.id ?? '', name, arguments: args });
  }
  return calls;
}

/**
 * Anything unrecognised maps to `content_filter` rather than `stop`.
 *
 * A new refusal reason from the vendor read as a clean stop would present a truncated or
 * refused answer to a teacher as a complete one. Erring toward "something intervened" is the
 * honest default.
 */
function mapFinishReason(raw: string | undefined): CompletionResponse['finishReason'] {
  switch (raw) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    default:
      return 'content_filter';
  }
}
