/**
 * SSLCommerz adapter — stub until merchant credentials exist and the live integration is
 * built. Refuses every operation with an `ExternalServiceError` naming the missing
 * credential. SSLCommerz authenticates with a store id and password.
 */

import { StubGatewayProvider } from './stub-provider.base';

export class SslcommerzProvider extends StubGatewayProvider {
  readonly key = 'sslcommerz' as const;
  protected readonly displayName = 'SSLCommerz';
  protected readonly requiredCredentials = [
    'SSLCOMMERZ_STORE_ID',
    'SSLCOMMERZ_STORE_PASSWORD',
    'SSLCOMMERZ_BASE_URL',
  ] as const;
}
