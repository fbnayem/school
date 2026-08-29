/**
 * Shared machinery for the three real HTTP adapters.
 *
 * Two behaviours live here because getting either wrong once is a security or a reliability
 * incident, and neither should be re-implemented per vendor:
 *
 *  1. **Loud refusal when credentials are absent.** Same discipline as
 *     `StubGpsProvider` and `StubGatewayProvider`: the adapter exists, is registered, and
 *     refuses — it never fabricates an answer. The difference from those stubs is that these
 *     adapters *are* implemented, so the moment the key is present they work.
 *
 *     The missing variable's **name** goes in the error context, never in the public message.
 *     `ExternalServiceError` is `isPublic = false` and renders as "The OpenAI service is
 *     unavailable"; the detail, the variable name and the upstream status stay in the context
 *     for the server log. Telling an anonymous caller which environment variables a
 *     deployment has not set is reconnaissance, and it is free.
 *
 *  2. **A bounded request.** Every call carries an `AbortController` deadline, because a hung
 *     upstream must not pin an API worker open, and a user is better served by a 502 than by
 *     an indefinite spinner.
 *
 * No response body from a vendor is ever passed through to a client. It is truncated into the
 * error context, where it helps an operator, and nowhere else — a provider's error text can
 * echo the prompt back, and the prompt can contain student data.
 */

import { ExternalServiceError } from '@shikkha/shared';
import { getLogger } from '../../../common/logger';
import type { AiProviderStatus } from './provider.interface';

/** How much of an upstream error body reaches the log. Enough to diagnose, not a transcript. */
const MAX_LOGGED_BODY = 500;

export abstract class HttpAiProvider {
  abstract readonly key: string;
  /** Human name used in the error, e.g. "OpenAI". */
  protected abstract readonly displayName: string;
  /** Environment variables this adapter needs before it can do anything at all. */
  protected abstract readonly requiredVariables: readonly string[];

  constructor(protected readonly timeoutMs: number) {}

  /** Which of the required variables are unset or empty. Names only — never values. */
  protected missingVariables(): string[] {
    return this.requiredVariables.filter((name) => {
      const value = process.env[name];
      return value === undefined || value.trim() === '';
    });
  }

  status(): AiProviderStatus {
    const missing = this.missingVariables();
    return {
      key: this.key,
      credentialsPresent: missing.length === 0,
      missingVariables: missing,
      worksWithoutCredentials: false,
    };
  }

  /**
   * Refuse an operation because the deployment is not configured for this provider.
   *
   * The public message names nothing. The context names the missing variables so an operator
   * reading the log knows exactly what to set, and the AI settings endpoint reports the same
   * names to an administrator who holds `ai.settings.manage` — an authenticated, permissioned
   * audience, which an error response is not.
   */
  protected refuseUnconfigured(operation: string): never {
    const missing = this.missingVariables();
    throw new ExternalServiceError(
      this.displayName,
      `Cannot ${operation}: this deployment is not configured for ${this.displayName}.`,
      {
        provider: this.key,
        missingVariables: missing,
        remedy: `Set ${missing.join(', ')} to enable ${this.displayName}, or set AI_PROVIDER=mock for the deterministic local adapter.`,
      },
    );
  }

  protected assertConfigured(operation: string): void {
    if (this.missingVariables().length > 0) this.refuseUnconfigured(operation);
  }

  /** A required credential, read at call time so a rotated key takes effect without a restart. */
  protected credential(name: string): string {
    const value = process.env[name];
    if (value === undefined || value.trim() === '') {
      // Unreachable after assertConfigured, but a `throw` beats returning '' into an
      // Authorization header, which would produce a confusing 401 from the vendor instead.
      this.refuseUnconfigured(`read the ${this.displayName} credential`);
    }
    return value.trim();
  }

  /**
   * POST JSON and parse JSON back, mapping every failure mode onto `ExternalServiceError`.
   *
   * A non-2xx, a timeout, a socket error and a malformed body all reach the caller as the
   * same 502 with a generic public message and a specific private context. That uniformity
   * is the point: no caller above this line branches on a vendor's error taxonomy.
   */
  protected async postJson<T>(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    operation: string,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = (error as { name?: string }).name === 'AbortError';
      throw new ExternalServiceError(
        this.displayName,
        aborted
          ? `Timed out after ${this.timeoutMs}ms while trying to ${operation}.`
          : `Network failure while trying to ${operation}.`,
        {
          provider: this.key,
          timedOut: aborted,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      getLogger().error(
        { provider: this.key, status: response.status, operation },
        'AI provider returned an error status',
      );
      throw new ExternalServiceError(
        this.displayName,
        `The provider refused the request while trying to ${operation}.`,
        {
          provider: this.key,
          status: response.status,
          // Truncated, and only ever into the context: a provider's error text can echo the
          // prompt back, and the prompt can contain student data.
          upstreamBody: text.slice(0, MAX_LOGGED_BODY),
        },
      );
    }

    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new ExternalServiceError(
        this.displayName,
        `The provider returned a body that is not JSON while trying to ${operation}.`,
        { provider: this.key, cause: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  /**
   * A vendor response that does not have the shape the adapter needs.
   *
   * Reported rather than coerced: silently substituting an empty string for a missing
   * completion would hand a user a blank answer that looks like the model had nothing to say.
   */
  protected malformed(operation: string, detail: string): never {
    throw new ExternalServiceError(
      this.displayName,
      `The provider's response could not be interpreted while trying to ${operation}: ${detail}`,
      { provider: this.key },
    );
  }
}
