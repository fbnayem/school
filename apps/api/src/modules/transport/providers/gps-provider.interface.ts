/**
 * The GPS abstraction (Phase 18, per docs/09_INTEGRATIONS.md "GPS (transport)").
 *
 * A `GpsProvider` is deliberately dumb: it reports where one vehicle is and knows nothing
 * about tenants, routes, students or permissions — every authorization decision about who
 * may *see* a position happens in the service before an adapter is ever consulted.
 *
 * docs/09 is explicit that a missing GPS provider must not block this module, and that the
 * useful parts — routes, stops, student assignments, transport fees — do not depend on live
 * position data at all. Two adapters exist accordingly: a working MOCK that produces
 * deterministic, clearly-labelled positions with no credentials and no network, and a stub
 * for the live integration that refuses loudly, naming the missing credential, rather than
 * ever returning a coordinate it invented.
 *
 * Coordinates cross this boundary as decimal strings — the same wire shape as the
 * `numeric(9, 6)` stop coordinates — never as floats.
 */

export interface GpsVehicleRef {
  /** Our vehicle id, so an adapter with a device registry can look the unit up. */
  vehicleId: string;
  /** The BRTA plate, the identifier most tracking vendors key devices by. */
  registrationNumber: string;
}

export interface GpsPosition {
  /** Decimal string, at most six decimal places. Never a float. */
  latitude: string;
  /** Decimal string, at most six decimal places. Never a float. */
  longitude: string;
  /** Kilometres per hour, when the device reports it. */
  speedKmh: number | null;
  /** Degrees clockwise from north, when the device reports it. */
  headingDegrees: number | null;
  /** When the fix was taken. */
  recordedAt: Date;
  /**
   * Which adapter produced this fix. `'mock'` positions are simulated and every consumer —
   * including the UI — can and must say so.
   */
  source: string;
}

export interface GpsProvider {
  /** `'mock'` or `'live'`. */
  readonly key: string;

  /**
   * The current position of one vehicle. Throws `ExternalServiceError` when the provider
   * cannot answer — it never fabricates a fix.
   */
  fetchPosition(vehicle: GpsVehicleRef): Promise<GpsPosition>;
}
