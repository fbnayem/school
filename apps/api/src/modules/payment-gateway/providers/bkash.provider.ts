/**
 * bKash adapter — stub until merchant credentials exist and the live integration is built.
 *
 * Refuses every operation with an `ExternalServiceError` naming the missing credential (see
 * `stub-provider.base.ts` for why loud beats silent). The credential names follow bKash's
 * tokenized checkout API: an app key/secret pair plus the merchant portal username/password
 * used to obtain grant tokens.
 */

import { StubGatewayProvider } from './stub-provider.base';

export class BkashProvider extends StubGatewayProvider {
  readonly key = 'bkash' as const;
  protected readonly displayName = 'bKash';
  protected readonly requiredCredentials = [
    'BKASH_APP_KEY',
    'BKASH_APP_SECRET',
    'BKASH_USERNAME',
    'BKASH_PASSWORD',
    'BKASH_BASE_URL',
  ] as const;
}
