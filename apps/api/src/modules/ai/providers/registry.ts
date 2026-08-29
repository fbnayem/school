/**
 * The AI adapter registry.
 *
 * One place answers "which code talks to a model". Everything above it — the conversation
 * service, retrieval, the copilot, the teacher tools — asks for a task and receives a
 * provider, and no module anywhere else constructs an adapter or reads `AI_PROVIDER`. That is
 * what makes docs/06 §4's "a provider change is configuration" true rather than aspirational.
 *
 * Configuration is read **per call**, not captured at construction, mirroring
 * `GpsProviderRegistry`: a deployment (or a test) that changes `AI_PROVIDER` or a routing
 * override takes effect without a restart, and parsing a dozen strings costs nothing next to
 * an HTTPS round trip. `AiModule` calls `assertAiConfig()` at init so a *malformed*
 * configuration is still a startup crash.
 *
 * `mock` is the default, and it is a real credential-free adapter rather than a stub: the
 * whole module is exercisable and testable without a vendor account (rule 7). The safety
 * property that makes that acceptable is that a mock answer is never mistakable for a real
 * one — every mock completion is stamped `[mock:<task>]`, and the usage ledger records
 * `provider_key = 'mock'` on every row it produced.
 */

import { Injectable, type OnModuleInit } from '@nestjs/common';
import { getLogger } from '../../../common/logger';
import {
  assertAiConfig,
  loadAiConfig,
  resolveEmbeddingRouting,
  resolveRouting,
  type AiConfig,
  type AiProviderKey,
  type AiRouting,
} from '../ai.config';
import { AnthropicProvider } from './anthropic.provider';
import { GeminiProvider } from './gemini.provider';
import { MockAiProvider } from './mock.provider';
import { OpenAiProvider } from './openai.provider';
import type {
  AiProvider,
  AiProviderStatus,
  AiTask,
  InspectableAiProvider,
} from './provider.interface';

@Injectable()
export class AiProviderRegistry implements OnModuleInit {
  onModuleInit(): void {
    const config = assertAiConfig();
    if (config.NODE_ENV === 'production' && config.AI_PROVIDER === 'mock') {
      // Not a startup refusal: a school that does not use AI at all must still be able to
      // deploy, and failing boot would make an unused module able to take the whole API down.
      // A warning plus the `[mock:…]` stamp on every generated answer is the same trade-off
      // the transport module makes for simulated GPS positions.
      getLogger().warn(
        'AI_PROVIDER=mock in production: every AI answer will be simulated and stamped as such. Set AI_PROVIDER and the matching credential to use a real model.',
      );
    }
  }

  /** The provider configured for this task, per AI_ROUTING_* env config. */
  forTask(task: AiTask): AiProvider {
    const config = loadAiConfig();
    return this.build(resolveRouting(config, task), config);
  }

  /** The embedding provider. Separate accessor because RAG needs it without a task. */
  embedder(): AiProvider {
    const config = loadAiConfig();
    return this.build(resolveEmbeddingRouting(config), config);
  }

  /** Dimensions of the configured embedding model — the RAG schema is sized from this. */
  embeddingDimensions(): number {
    return loadAiConfig().AI_EMBEDDING_DIMENSIONS;
  }

  /**
   * Which provider key would answer each task, for the settings screen.
   *
   * Keys only. This is the shape `GET /ai/providers` reports alongside credential
   * *presence*, and there is deliberately no accessor anywhere on this class that returns a
   * credential.
   */
  routingTable(tasks: readonly AiTask[]): Record<string, { provider: AiProviderKey; model?: string }> {
    const config = loadAiConfig();
    const table: Record<string, { provider: AiProviderKey; model?: string }> = {};
    for (const task of tasks) {
      table[task] = resolveRouting(config, task);
    }
    return table;
  }

  /**
   * Every adapter's readiness. `credentialsPresent` is a boolean and `missingVariables` is a
   * list of *names*: no value, no prefix, no masked form, no length. A masked key still
   * narrows a search space, and there is no operational question it answers that a name and
   * a yes/no do not.
   */
  statuses(): AiProviderStatus[] {
    const config = loadAiConfig();
    const keys: AiProviderKey[] = ['mock', 'openai', 'anthropic', 'gemini'];
    return keys.map((key) => this.build({ provider: key }, config).status());
  }

  /**
   * Adapters are constructed per call rather than held as singletons.
   *
   * They are stateless — no connection pool, no session — so construction is a few field
   * assignments, and building fresh means a routing change or a rotated key takes effect
   * immediately rather than at the next deploy.
   */
  private build(routing: AiRouting, config: AiConfig): InspectableAiProvider {
    switch (routing.provider) {
      case 'openai':
        return new OpenAiProvider(
          config.AI_REQUEST_TIMEOUT_MS,
          routing.model,
          config.AI_EMBEDDING_DIMENSIONS,
        );
      case 'anthropic':
        return new AnthropicProvider(
          config.AI_REQUEST_TIMEOUT_MS,
          routing.model,
          config.AI_MAX_OUTPUT_TOKENS,
        );
      case 'gemini':
        return new GeminiProvider(
          config.AI_REQUEST_TIMEOUT_MS,
          routing.model,
          config.AI_EMBEDDING_DIMENSIONS,
        );
      case 'mock':
      default:
        // A model override is deliberately ignored here: the mock's output is a function of
        // its input, not of a model name, and reporting a vendor's model id on a simulated
        // answer would put a row in the usage ledger that looks like a real call to that
        // model. It reports `mock-completion-1` / `mock-embedding-1`, which are priced rows
        // in `MODEL_PRICES` like any other.
        return new MockAiProvider(config.AI_EMBEDDING_DIMENSIONS);
    }
  }
}
