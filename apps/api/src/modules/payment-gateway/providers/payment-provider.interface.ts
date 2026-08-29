/**
 * The gateway abstraction (Phase 12, per docs/09_INTEGRATIONS.md "Payments").
 *
 * A `PaymentProvider` is deliberately dumb: it speaks to one gateway and knows nothing about
 * tenants, invoices, permissions or the ledger. Everything monetary crosses this boundary as a
 * decimal string — the same wire shape as everywhere else (ADR-004) — and the service is the
 * only place `Money` arithmetic happens.
 *
 * The security-relevant method is `verifyCallbackSignature`. It takes the **raw request body
 * string**, not a parsed object: signature schemes sign bytes, and re-serialising a parsed
 * object can reorder keys and turn a valid signature into an invalid one (or, worse, be
 * gamed into the reverse). The controller hands the exact string that was signed.
 */

import type { PaymentGatewayProvider } from '@shikkha/validation';

export interface ProviderCreateIntentRequest {
  /** Our intent id — providers echo it back so callbacks can be routed. */
  intentId: string;
  /** Decimal string, two places. */
  amount: string;
  currency: string;
  returnUrl: string | null;
  expiresAt: Date;
  /** Free-form request metadata. The mock provider reads its scenario switch from here. */
  metadata: Record<string, unknown>;
}

export interface ProviderCreateIntentResult {
  /** The gateway's identifier for this transaction. What its callbacks will reference. */
  providerIntentId: string;
  /** Where to send the payer's browser. Null for gateways that do not redirect. */
  redirectUrl: string | null;
}

/** What a provider's own status API reports. Local truth is derived from this, never equal to it. */
export interface ProviderIntentStatus {
  status: 'pending' | 'succeeded' | 'failed';
  /** The provider's transaction reference, when it reports one. */
  providerReference: string | null;
  failureCode?: string | null;
  failureMessage?: string | null;
}

export interface ProviderRefundRequest {
  providerIntentId: string;
  /** Decimal string; always the full intent amount in this phase. */
  amount: string;
  currency: string;
  reason: string;
}

export interface ProviderRefundResult {
  providerRefundId: string;
}

/** One row of a provider's settlement file: a reference and the amount it settled. */
export interface ProviderSettlementRecord {
  providerReference: string;
  /** Decimal string, two places. */
  amount: string;
}

export interface PaymentProvider {
  readonly key: PaymentGatewayProvider;

  /** Register the intent with the gateway and obtain the redirect target. */
  createIntent(request: ProviderCreateIntentRequest): Promise<ProviderCreateIntentResult>;

  /**
   * Verify a callback's signature over the raw body string. Pure and synchronous — it must be
   * callable before anything else happens to the request.
   */
  verifyCallbackSignature(rawBody: string, signature: string | null): boolean;

  /** Ask the gateway what it thinks happened. The poll path for lost callbacks. */
  fetchStatus(providerIntentId: string): Promise<ProviderIntentStatus>;

  /** Execute a refund the humans have already approved. Never called autonomously. */
  refund(request: ProviderRefundRequest): Promise<ProviderRefundResult>;

  /** Parse a settlement file into rows. Throws a domain error on a malformed file. */
  parseSettlementFile(content: string): ProviderSettlementRecord[];
}
