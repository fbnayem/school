/**
 * The live-GPS stub.
 *
 * docs/09 is explicit that a missing provider must never block the module, and that a
 * silent fallback is worse than a loud failure. This adapter therefore exists, is
 * registered, and **refuses every operation loudly**, naming the first missing credential —
 * a 502 with the detail in the server log, never a pretend success and never a fabricated
 * coordinate shown to a parent as their child's location.
 *
 * When the tracking-vendor credentials are eventually supplied, the loud failure remains
 * until the live integration is actually implemented and certified: credentials alone must
 * not flip a stub into something that silently invents positions.
 */

import { ExternalServiceError } from '@shikkha/shared';
import type { GpsPosition, GpsProvider, GpsVehicleRef } from './gps-provider.interface';

/** Environment variables the live adapter will require. */
export const GPS_REQUIRED_CREDENTIALS = ['GPS_PROVIDER_URL', 'GPS_PROVIDER_API_KEY'] as const;

export class StubGpsProvider implements GpsProvider {
  readonly key = 'live' as const;

  async fetchPosition(_vehicle: GpsVehicleRef): Promise<GpsPosition> {
    this.refuse('fetch a vehicle position');
  }

  /**
   * The one behaviour a stub has: it names the first missing credential, or states that the
   * live integration is not yet enabled even though credentials are present. It never
   * returns fake coordinates.
   */
  protected refuse(operation: string): never {
    const missing = GPS_REQUIRED_CREDENTIALS.find(
      (name) => !process.env[name] || process.env[name] === '',
    );
    if (missing) {
      throw new ExternalServiceError(
        'GPS tracking',
        `Cannot ${operation}: the ${missing} credential is not configured. ` +
          `Set ${GPS_REQUIRED_CREDENTIALS.join(', ')} to enable the live GPS provider, or set ` +
          `GPS_PROVIDER=mock for simulated positions ` +
          `(see docs/09_INTEGRATIONS.md, "GPS (transport)").`,
        { provider: this.key, missingCredential: missing },
      );
    }
    throw new ExternalServiceError(
      'GPS tracking',
      `Cannot ${operation}: credentials are present but the live GPS integration is not ` +
        `implemented in this build. Refusing loudly rather than pretending.`,
      { provider: this.key },
    );
  }
}
