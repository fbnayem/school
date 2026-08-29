/**
 * The mock gateway.
 *
 * Exists so the whole payment workflow — create, redirect, callback, duplicate callback,
 * signature mismatch, failure, timeout, settlement reconciliation — is exercisable and
 * testable with **no credentials and no network**, per docs/09: "a mock provider will cover
 * the full happy path plus failure, timeout and duplicate-callback cases".
 *
 * It is not a fake success box. It implements the same contract a real adapter must, with a
 * real (deterministic) HMAC-SHA256 signature scheme, so every control the service applies to a
 * real gateway is applied identically here. The test suite computes signatures with the same
 * secret; a payload signed with anything else is rejected exactly as a forged bKash callback
 * would be.
 *
 * Scenario control: `metadata.mockScenario` at intent creation chooses what the *status API*
 * reports for that intent —
 *
 *   'succeed' → fetchStatus reports `succeeded`
 *   'fail'    → fetchStatus reports `failed`
 *   'timeout' → fetchStatus throws ExternalServiceError, simulating a gateway outage
 *   anything else → `pending` (the default; callbacks drive the outcome instead)
 *
 * The scenario is encoded into the provider intent id (`MOCK-<scenario>-<intentId>`) so the
 * adapter needs no memory and behaves identically across processes and restarts.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { ExternalServiceError, ValidationError } from '@shikkha/shared';
import type {
  PaymentProvider,
  ProviderCreateIntentRequest,
  ProviderCreateIntentResult,
  ProviderIntentStatus,
  ProviderRefundRequest,
  ProviderRefundResult,
  ProviderSettlementRecord,
} from './payment-provider.interface';

/**
 * The signing secret. Overridable so a deployment can rotate it, defaulted so development and
 * tests need no configuration. The mock provider must never be enabled for a real school —
 * which is a service-level decision, not this file's.
 */
export function mockGatewaySecret(): string {
  return process.env['PAYMENT_MOCK_SECRET'] ?? 'shikkha-mock-gateway-secret';
}

/** Compute the signature the mock gateway would attach. Exported for the test suite. */
export function signMockPayload(rawBody: string): string {
  return createHmac('sha256', mockGatewaySecret()).update(rawBody, 'utf8').digest('hex');
}

const SCENARIOS = ['succeed', 'fail', 'timeout', 'pending'] as const;
type MockScenario = (typeof SCENARIOS)[number];

function scenarioOf(metadata: Record<string, unknown>): MockScenario {
  const raw = metadata['mockScenario'];
  return typeof raw === 'string' && (SCENARIOS as readonly string[]).includes(raw)
    ? (raw as MockScenario)
    : 'pending';
}

export class MockProvider implements PaymentProvider {
  readonly key = 'mock' as const;

  async createIntent(request: ProviderCreateIntentRequest): Promise<ProviderCreateIntentResult> {
    const scenario = scenarioOf(request.metadata);
    const providerIntentId = `MOCK-${scenario}-${request.intentId}`;
    return {
      providerIntentId,
      redirectUrl: `https://mock-gateway.invalid/pay/${providerIntentId}`,
    };
  }

  verifyCallbackSignature(rawBody: string, signature: string | null): boolean {
    if (!signature) return false;
    const expected = Buffer.from(signMockPayload(rawBody), 'utf8');
    const provided = Buffer.from(signature, 'utf8');
    // timingSafeEqual throws on length mismatch, and length is not a secret here.
    if (expected.length !== provided.length) return false;
    return timingSafeEqual(expected, provided);
  }

  async fetchStatus(providerIntentId: string): Promise<ProviderIntentStatus> {
    const scenario = providerIntentId.split('-')[1] as MockScenario | undefined;
    if (scenario === 'timeout') {
      throw new ExternalServiceError('mock gateway', 'Simulated gateway timeout', {
        providerIntentId,
      });
    }
    if (scenario === 'succeed') {
      return { status: 'succeeded', providerReference: providerIntentId };
    }
    if (scenario === 'fail') {
      return {
        status: 'failed',
        providerReference: providerIntentId,
        failureCode: 'MOCK_DECLINED',
        failureMessage: 'The mock gateway declined this transaction by scenario',
      };
    }
    return { status: 'pending', providerReference: providerIntentId };
  }

  async refund(request: ProviderRefundRequest): Promise<ProviderRefundResult> {
    return { providerRefundId: `MOCKR-${request.providerIntentId}` };
  }

  /**
   * Settlement file format: one `provider_reference,amount` pair per line. A header line
   * reading `provider_reference,amount` is tolerated; blank lines are skipped; anything else
   * malformed fails the whole file — a partially-parsed settlement is a reconciliation of
   * nothing in particular.
   */
  parseSettlementFile(content: string): ProviderSettlementRecord[] {
    const records: ProviderSettlementRecord[] = [];
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!.trim();
      if (line === '') continue;
      if (index === 0 && /^provider_reference\s*,\s*amount$/i.test(line)) continue;

      const parts = line.split(',').map((part) => part.trim());
      const reference = parts[0] ?? '';
      const amount = parts[1] ?? '';
      if (parts.length !== 2 || reference === '' || !/^\d{1,12}\.\d{2}$/.test(amount)) {
        throw new ValidationError('The settlement file is malformed', [
          {
            path: `fileContent`,
            message: `Line ${index + 1} is not "provider_reference,amount" with a two-decimal amount`,
          },
        ]);
      }
      records.push({ providerReference: reference, amount });
    }
    return records;
  }
}
