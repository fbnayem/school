/**
 * Base for the real-gateway stubs (bKash, Nagad, SSLCommerz).
 *
 * docs/09 is explicit that a missing provider must never block the module, and that a silent
 * fallback is worse than a loud failure. These adapters therefore exist, are registered, and
 * **refuse every operation loudly**, naming the first missing credential — a 502 with the
 * detail in the server log, never a pretend success and never a hard-coded result.
 *
 * When the merchant credentials are eventually supplied, the loud failure remains until the
 * live integration is actually implemented and certified: credentials alone must not flip a
 * stub into something that silently swallows real money callbacks.
 */

import { ExternalServiceError } from '@shikkha/shared';
import type { PaymentGatewayProvider } from '@shikkha/validation';
import type {
  PaymentProvider,
  ProviderCreateIntentRequest,
  ProviderCreateIntentResult,
  ProviderIntentStatus,
  ProviderRefundRequest,
  ProviderRefundResult,
  ProviderSettlementRecord,
} from './payment-provider.interface';

export abstract class StubGatewayProvider implements PaymentProvider {
  abstract readonly key: PaymentGatewayProvider;
  /** Human name used in the error, e.g. "bKash". */
  protected abstract readonly displayName: string;
  /** Environment variables the live adapter will require. */
  protected abstract readonly requiredCredentials: readonly string[];

  /**
   * The one behaviour a stub has. Every method funnels here, so a stub can never partially
   * work: it names the first missing credential, or states that the live integration is not
   * yet enabled even though credentials are present.
   */
  protected refuse(operation: string): never {
    const missing = this.requiredCredentials.find(
      (name) => !process.env[name] || process.env[name] === '',
    );
    if (missing) {
      throw new ExternalServiceError(
        this.displayName,
        `Cannot ${operation}: the ${missing} credential is not configured. ` +
          `Set ${this.requiredCredentials.join(', ')} to enable the ${this.displayName} gateway ` +
          `(see docs/09_INTEGRATIONS.md, "Credentials required before production").`,
        { provider: this.key, missingCredential: missing },
      );
    }
    throw new ExternalServiceError(
      this.displayName,
      `Cannot ${operation}: credentials are present but the live ${this.displayName} ` +
        `integration is not implemented in this build. Refusing loudly rather than pretending.`,
      { provider: this.key },
    );
  }

  async createIntent(_request: ProviderCreateIntentRequest): Promise<ProviderCreateIntentResult> {
    this.refuse('create a payment intent');
  }

  verifyCallbackSignature(_rawBody: string, _signature: string | null): boolean {
    // Fail closed: with no credentials there is no key to verify against, so no callback from
    // this provider can ever be treated as authentic. The attempt is still recorded upstream.
    return false;
  }

  async fetchStatus(_providerIntentId: string): Promise<ProviderIntentStatus> {
    this.refuse('fetch a payment status');
  }

  async refund(_request: ProviderRefundRequest): Promise<ProviderRefundResult> {
    this.refuse('execute a refund');
  }

  parseSettlementFile(_content: string): ProviderSettlementRecord[] {
    this.refuse('parse a settlement file');
  }
}
