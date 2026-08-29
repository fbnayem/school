/**
 * The mock GPS adapter.
 *
 * Exists so the live-position endpoint — including every authorization rule the service
 * applies before an adapter is consulted — is exercisable and testable with **no
 * credentials and no network**, per docs/09: a missing GPS provider must not block the
 * transport module.
 *
 * It is not a fake-success box pretending to be a real vendor: every position it returns is
 * stamped `source: 'mock'`, so no consumer can mistake a simulation for a fix. The position
 * itself is deterministic — a hash of the registration plate picks a fixed point near Dhaka,
 * and the time of day moves the vehicle along a small, repeatable orbit around it — so two
 * requests in the same second agree, restarts change nothing, and a test can assert the
 * shape without pinning the exact values.
 *
 * Coordinates are produced as decimal strings with six decimal places, the same wire shape
 * as the `numeric(9, 6)` stop coordinates. The floating-point arithmetic here simulates a
 * physical position; it never touches money and never enters the database.
 */

import type { GpsPosition, GpsProvider, GpsVehicleRef } from './gps-provider.interface';

/** Dhaka city centre — the anchor every simulated vehicle orbits near. */
const BASE_LATITUDE = 23.8103;
const BASE_LONGITUDE = 90.4125;

/** Deterministic 32-bit hash (FNV-1a) of the registration plate. */
function hashOf(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export class MockGpsProvider implements GpsProvider {
  readonly key = 'mock' as const;

  async fetchPosition(vehicle: GpsVehicleRef): Promise<GpsPosition> {
    const seed = hashOf(vehicle.registrationNumber);
    const now = new Date();

    // A fixed home point per vehicle, within ±0.05° (~5 km) of the anchor…
    const homeLatitude = BASE_LATITUDE + ((seed % 1000) / 1000 - 0.5) * 0.1;
    const homeLongitude = BASE_LONGITUDE + ((Math.floor(seed / 1000) % 1000) / 1000 - 0.5) * 0.1;

    // …and a slow orbit around it, one revolution per hour, so the vehicle visibly "moves".
    const minuteOfHour = now.getUTCMinutes() + now.getUTCSeconds() / 60;
    const angle = (minuteOfHour / 60) * 2 * Math.PI;
    const latitude = homeLatitude + Math.sin(angle) * 0.01;
    const longitude = homeLongitude + Math.cos(angle) * 0.01;

    return {
      latitude: latitude.toFixed(6),
      longitude: longitude.toFixed(6),
      speedKmh: 20 + (seed % 25),
      headingDegrees: Math.round(((angle * 180) / Math.PI + 90) % 360),
      recordedAt: now,
      source: 'mock',
    };
  }
}
