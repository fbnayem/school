/**
 * The adapter registry.
 *
 * One place answers "which code speaks for this provider". `rocket`, `bank_transfer` and
 * `cash` deliberately have **no** adapter: Rocket has no integration planned for this phase,
 * and the offline channels are settled at the counter through the fees module — an intent
 * against them would be a redirect to nowhere. The service turns an unregistered provider
 * into a `ValidationError` at intent creation, which is a real refusal, not a stub.
 */

import { Injectable } from '@nestjs/common';
import type { PaymentGatewayProvider } from '@shikkha/validation';
import type { PaymentProvider } from './payment-provider.interface';
import { MockProvider } from './mock.provider';
import { BkashProvider } from './bkash.provider';
import { NagadProvider } from './nagad.provider';
import { SslcommerzProvider } from './sslcommerz.provider';

@Injectable()
export class PaymentProviderRegistry {
  private readonly providers: ReadonlyMap<PaymentGatewayProvider, PaymentProvider>;

  constructor() {
    const adapters: PaymentProvider[] = [
      new MockProvider(),
      new BkashProvider(),
      new NagadProvider(),
      new SslcommerzProvider(),
    ];
    this.providers = new Map(adapters.map((adapter) => [adapter.key, adapter]));
  }

  /** The adapter for a provider, or null when none is registered. */
  find(provider: PaymentGatewayProvider): PaymentProvider | null {
    return this.providers.get(provider) ?? null;
  }
}
