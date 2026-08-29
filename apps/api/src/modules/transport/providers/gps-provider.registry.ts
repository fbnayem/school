/**
 * The GPS adapter registry.
 *
 * One place answers "which code reports vehicle positions". `GPS_PROVIDER=mock` selects the
 * deterministic simulator (development, tests, demos — every position it emits is stamped
 * `source: 'mock'`); anything else, including the variable being unset, selects the stub
 * that refuses loudly naming its missing credential. Failing loud-by-default means a
 * production deployment that forgot to configure tracking shows parents an honest error,
 * never a fabricated bus location.
 *
 * The environment is read per call, not at construction, so a deployment (or a test) that
 * changes `GPS_PROVIDER` does not need a process restart to take effect.
 */

import { Injectable } from '@nestjs/common';
import type { GpsProvider } from './gps-provider.interface';
import { MockGpsProvider } from './mock-gps.provider';
import { StubGpsProvider } from './stub-gps.provider';

@Injectable()
export class GpsProviderRegistry {
  private readonly mock = new MockGpsProvider();
  private readonly stub = new StubGpsProvider();

  /** The adapter currently in force. Never null: the stub is the answer of last resort. */
  active(): GpsProvider {
    const configured = (process.env['GPS_PROVIDER'] ?? '').trim().toLowerCase();
    if (configured === 'mock') return this.mock;
    return this.stub;
  }
}
