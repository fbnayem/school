/**
 * Nagad adapter — stub until merchant credentials exist and the live integration is built.
 *
 * Refuses every operation with an `ExternalServiceError` naming the missing credential.
 * Nagad's merchant API signs requests with an RSA key pair, hence the public/private key
 * variables alongside the merchant id.
 */

import { StubGatewayProvider } from './stub-provider.base';

export class NagadProvider extends StubGatewayProvider {
  readonly key = 'nagad' as const;
  protected readonly displayName = 'Nagad';
  protected readonly requiredCredentials = [
    'NAGAD_MERCHANT_ID',
    'NAGAD_MERCHANT_PRIVATE_KEY',
    'NAGAD_GATEWAY_PUBLIC_KEY',
    'NAGAD_BASE_URL',
  ] as const;
}
