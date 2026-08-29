/**
 * AI environment configuration.
 *
 * Written in the same idiom as `src/config/env.ts` — a Zod schema, a readable failure, and
 * production checks that refuse a dangerous combination — but kept in the AI module rather
 * than merged into the global schema for one reason: it is read **per call**, not once at
 * boot.
 *
 * That mirrors `GpsProviderRegistry`, and for the same reason: a deployment (or a test) that
 * changes `AI_PROVIDER` or a routing override should take effect without a process restart,
 * and parsing a dozen strings is free next to an HTTPS round trip to a model. `assertAiConfig()`
 * still runs at module init, so a *malformed* configuration is a startup crash exactly like
 * every other misconfiguration in this codebase, rather than a 500 the first time a teacher
 * opens the copilot.
 *
 * There is no credential *in* the parsed shape beyond the raw keys themselves, and nothing
 * that reads this object ever puts it in a response, a log line or an audit row. See
 * `AiController.providers` for the one endpoint that reports on credentials, and note that
 * it reports only presence.
 */

import { z } from 'zod';
import type { AiTask } from './providers/provider.interface';
import { AI_TASK_LIST } from './providers/provider.interface';

/** The adapters that exist. `mock` needs no credentials and is the default in dev and test. */
export const AI_PROVIDER_KEYS = ['mock', 'openai', 'anthropic', 'gemini'] as const;
export type AiProviderKey = (typeof AI_PROVIDER_KEYS)[number];

/**
 * A routing value: a provider key, optionally with a model override — `openai` or
 * `openai:gpt-4o-mini`. The model is the only vendor-specific string a deployment ever
 * needs to write, and it belongs in configuration rather than in code.
 */
const routingValue = z
  .string()
  .trim()
  .regex(
    /^(mock|openai|anthropic|gemini)(:[A-Za-z0-9._@/-]{1,128})?$/,
    'Use a provider key, optionally with a model — for example "openai" or "openai:gpt-4o-mini"',
  );

const optionalSecret = z
  .string()
  .trim()
  .optional()
  // An empty variable and an unset one mean the same thing: not configured. Treating "" as
  // a valid key would produce a 401 from the vendor instead of our own loud refusal.
  .transform((value) => (value && value.length > 0 ? value : undefined));

/**
 * Per-task routing variables. Named from the task so adding a task to `AiTask` makes the
 * variable name obvious without a lookup table anyone has to remember to update.
 */
export function routingVariableName(task: AiTask): string {
  return `AI_ROUTING_${task.toUpperCase()}`;
}

const routingShape = Object.fromEntries(
  AI_TASK_LIST.map((task) => [routingVariableName(task), routingValue.optional()]),
) as Record<string, z.ZodOptional<typeof routingValue>>;

export const aiEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    /** The provider used for any task with no explicit routing override. */
    AI_PROVIDER: z.enum(AI_PROVIDER_KEYS).default('mock'),

    OPENAI_API_KEY: optionalSecret,
    OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
    ANTHROPIC_API_KEY: optionalSecret,
    ANTHROPIC_BASE_URL: z.string().url().default('https://api.anthropic.com/v1'),
    GEMINI_API_KEY: optionalSecret,
    GEMINI_BASE_URL: z.string().url().default('https://generativelanguage.googleapis.com/v1beta'),

    /** Overrides the embedding provider's own default model. */
    AI_EMBEDDING_MODEL: z.string().trim().min(1).max(128).optional(),
    /**
     * The width of an embedding vector. The retrieval schema is sized from this, so changing
     * it invalidates every stored embedding — which is why it is configuration with a
     * documented default rather than something derived at runtime from the first response.
     */
    AI_EMBEDDING_DIMENSIONS: z.coerce.number().int().min(16).max(8_192).default(1_536),

    /** The per-call output ceiling. A tenant cannot raise it; see `appendAiMessageSchema`. */
    AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(64).max(32_768).default(2_048),

    /**
     * How long to wait for a provider before giving up. A hung upstream must not hold an API
     * worker open indefinitely, and a user is better served by a 502 than by a spinner.
     */
    AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(60_000),

    ...routingShape,
  })
  .superRefine((config, ctx) => {
    const reject = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });

    // A routing override that names a provider whose credentials are absent is not rejected
    // here — the adapter refuses loudly at call time, naming the variable, which is a far
    // more useful error than a boot failure in an unrelated deployment. But a *typo* in the
    // provider name is caught by `routingValue` above, and that is the failure worth having
    // at boot: it would otherwise fall through to the default and be invisible on the bill.

    if (config.NODE_ENV !== 'production') return;

    if (config.AI_EMBEDDING_DIMENSIONS !== 1_536 && !config.AI_EMBEDDING_MODEL) {
      reject(
        'AI_EMBEDDING_MODEL',
        'must be set when AI_EMBEDDING_DIMENSIONS is not the default — a mismatch between the configured width and the model\'s real width corrupts every stored embedding silently',
      );
    }
  });

export type AiConfig = z.infer<typeof aiEnvSchema>;

/** Parse the AI environment, throwing the same shape of readable error `loadEnv` throws. */
export function loadAiConfig(source: NodeJS.ProcessEnv = process.env): AiConfig {
  const parsed = aiEnvSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new Error(`Invalid AI configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}

/**
 * Called from `AiModule.onModuleInit`. A malformed AI configuration is a startup crash,
 * consistent with every other misconfiguration here — the per-call reads below assume it
 * already parsed once.
 */
export function assertAiConfig(): AiConfig {
  return loadAiConfig();
}

/** The resolved routing decision for one task. */
export interface AiRouting {
  provider: AiProviderKey;
  /** A deployment's model override, or undefined to use the adapter's default for the task. */
  model?: string;
}

export function resolveRouting(config: AiConfig, task: AiTask): AiRouting {
  const raw = (config as unknown as Record<string, string | undefined>)[
    routingVariableName(task)
  ];
  if (!raw) return { provider: config.AI_PROVIDER };

  const separator = raw.indexOf(':');
  if (separator === -1) return { provider: raw as AiProviderKey };
  return {
    provider: raw.slice(0, separator) as AiProviderKey,
    model: raw.slice(separator + 1),
  };
}

/**
 * The embedding provider and model.
 *
 * Separate from `resolveRouting('embedding')` only in that `AI_EMBEDDING_MODEL` wins over a
 * model named in the routing string — retrieval's stored vectors are sized to one specific
 * model, so that variable is the single place a deployment states which one.
 */
export function resolveEmbeddingRouting(config: AiConfig): AiRouting {
  const routed = resolveRouting(config, 'embedding');
  const model = config.AI_EMBEDDING_MODEL ?? routed.model;
  return model ? { provider: routed.provider, model } : { provider: routed.provider };
}
