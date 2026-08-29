/**
 * Google Gemini adapter — `generateContent` and `batchEmbedContents`.
 *
 * A real HTTP client. Without `GEMINI_API_KEY` every operation refuses loudly through
 * `HttpAiProvider.refuseUnconfigured`, with the variable name in the error context only.
 *
 * The vendor-shaped details, all confined here:
 *
 *  - **The model is part of the URL**, not the body: `/models/<model>:generateContent`.
 *  - **The assistant role is called `model`**, and there is no `system` role — a system
 *    prompt goes in the top-level `systemInstruction`.
 *  - **A tool result is a `functionResponse` part** on a `user` turn, keyed by the function's
 *    *name* rather than by an invocation id. Our `toolCallId` is minted as `<name>:<n>` by
 *    this adapter on the way out and split back to the name on the way in, so the shared
 *    `CompletionToolCall` shape stays vendor-neutral.
 *  - **Embeddings report no token usage.** The count is approximated locally and the
 *    approximation is stated rather than presented as the vendor's own figure — an
 *    under-reported cost is exactly the failure this module exists to prevent, so the
 *    estimate is deliberately the same conservative one the mock adapter documents.
 *
 * The API key travels as a header (`x-goog-api-key`) rather than the `?key=` query parameter
 * the quick-start uses: a query string reaches proxy logs, access logs and error reports,
 * and a credential in a URL is a credential in a dozen places nobody audits.
 *
 * Default models are configuration with a default; override with
 * `AI_ROUTING_<TASK>=gemini:<model>` and add the row to `MODEL_PRICES` when you do.
 */

import { HttpAiProvider } from './http-provider.base';
import type {
  AiProvider,
  AiTask,
  CompletionMessage,
  CompletionRequest,
  CompletionResponse,
  CompletionToolCall,
  EmbeddingResponse,
  InspectableAiProvider,
} from './provider.interface';

export const GEMINI_REQUIRED_VARIABLES = ['GEMINI_API_KEY'] as const;

const DEFAULT_MODELS: Record<AiTask, string> = {
  classification: 'gemini-2.5-flash',
  summarisation: 'gemini-2.5-flash',
  analytics_reasoning: 'gemini-2.5-pro',
  tutoring: 'gemini-2.5-flash',
  document_understanding: 'gemini-2.5-pro',
  embedding: 'text-embedding-004',
};

interface GenerateContentResponseBody {
  modelVersion?: string;
  candidates?: {
    finishReason?: string;
    content?: {
      parts?: { text?: string; functionCall?: { name?: string; args?: unknown } }[];
    };
  }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

interface BatchEmbedResponseBody {
  embeddings?: { values?: number[] }[];
}

export class GeminiProvider extends HttpAiProvider implements AiProvider, InspectableAiProvider {
  readonly key = 'gemini' as const;
  protected readonly displayName = 'Gemini';
  protected readonly requiredVariables = GEMINI_REQUIRED_VARIABLES;

  constructor(
    timeoutMs: number,
    private readonly modelOverride: string | undefined,
    private readonly embeddingDimensions: number,
  ) {
    super(timeoutMs);
  }

  private baseUrl(): string {
    return (
      process.env['GEMINI_BASE_URL'] ?? 'https://generativelanguage.googleapis.com/v1beta'
    ).replace(/\/+$/, '');
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.assertConfigured('generate a completion');
    const model = this.modelOverride ?? DEFAULT_MODELS[request.task];

    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');

    const body: Record<string, unknown> = {
      contents: request.messages
        .filter((message) => message.role !== 'system')
        .map((message) => toContent(message)),
      generationConfig: {
        ...(request.maxOutputTokens !== undefined
          ? { maxOutputTokens: request.maxOutputTokens }
          : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      },
    };
    if (system.length > 0) {
      body['systemInstruction'] = { parts: [{ text: system }] };
    }
    if (request.tools && request.tools.length > 0) {
      body['tools'] = [
        {
          functionDeclarations: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        },
      ];
    }

    const response = await this.postJson<GenerateContentResponseBody>(
      `${this.baseUrl()}/models/${encodeURIComponent(model)}:generateContent`,
      { 'x-goog-api-key': this.credential('GEMINI_API_KEY') },
      body,
      'generate a completion',
    );

    const candidate = response.candidates?.[0];
    if (!candidate) {
      // A response with no candidate is what a blocked prompt looks like here. Reporting it
      // as a malformed response rather than an empty answer keeps "the model said nothing"
      // and "the request was refused" distinguishable.
      this.malformed('generate a completion', 'the response contained no candidates');
    }

    const parts = candidate.content?.parts ?? [];
    const text = parts
      .filter((part) => typeof part.text === 'string')
      .map((part) => part.text ?? '')
      .join('');

    const toolCalls: CompletionToolCall[] = parts
      .filter((part) => part.functionCall?.name)
      .map((part, index) => ({
        // Minted here: this API keys a function response by name, so an id has to be
        // synthesised for the vendor-neutral shape. `toContent` splits it back off.
        id: `${part.functionCall?.name ?? ''}:${index}`,
        name: part.functionCall?.name ?? '',
        arguments:
          part.functionCall?.args &&
          typeof part.functionCall.args === 'object' &&
          !Array.isArray(part.functionCall.args)
            ? (part.functionCall.args as Record<string, unknown>)
            : {},
      }));

    return {
      text,
      toolCalls,
      usage: {
        inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      },
      model: response.modelVersion ?? model,
      // This API reports a function call as an ordinary `STOP`, so the presence of a call is
      // the only signal that the turn is not finished. Without this the caller would render a
      // tool invocation as the model's final answer and never run the tool.
      finishReason:
        toolCalls.length > 0 ? 'tool_calls' : mapFinishReason(candidate.finishReason),
    };
  }

  async embed(texts: string[]): Promise<EmbeddingResponse> {
    this.assertConfigured('generate embeddings');
    const model = this.modelOverride ?? DEFAULT_MODELS.embedding;

    const response = await this.postJson<BatchEmbedResponseBody>(
      `${this.baseUrl()}/models/${encodeURIComponent(model)}:batchEmbedContents`,
      { 'x-goog-api-key': this.credential('GEMINI_API_KEY') },
      {
        requests: texts.map((text) => ({
          model: `models/${model}`,
          content: { parts: [{ text }] },
          outputDimensionality: this.embeddingDimensions,
        })),
      },
      'generate embeddings',
    );

    const vectors = (response.embeddings ?? []).map((row) => row.values ?? []);
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
      // Estimated, not reported. See the file header: an under-reported cost is the failure
      // this module exists to prevent, so the estimate errs on the high side of a character
      // count rather than defaulting to zero.
      usage: {
        inputTokens: texts.reduce(
          (total, text) => total + (text.length === 0 ? 0 : Math.max(1, Math.ceil(text.length / 4))),
          0,
        ),
      },
      model,
      dimensions: this.embeddingDimensions,
    };
  }
}

function toContent(message: CompletionMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    // The id was minted as `<name>:<index>` on the way out; only the name means anything here.
    const name = (message.toolCallId ?? '').split(':')[0] ?? '';
    return {
      role: 'user',
      parts: [{ functionResponse: { name, response: { result: message.content } } }],
    };
  }
  return {
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.content }],
  };
}

/** Unrecognised maps to `content_filter`, as in the other two adapters and for the same reason. */
function mapFinishReason(raw: string | undefined): CompletionResponse['finishReason'] {
  switch (raw) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    default:
      return 'content_filter';
  }
}
