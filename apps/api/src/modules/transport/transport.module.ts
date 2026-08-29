import { Module } from '@nestjs/common';
import { TransportController } from './transport.controller';
import { TransportService } from './transport.service';
import { GpsProviderRegistry } from './providers/gps-provider.registry';

/**
 * No `imports`: `DatabaseModule` is `@Global()`, so `DatabaseService` is injected directly.
 *
 * `GpsProviderRegistry` is provided here and only here: both GPS adapters — the
 * deterministic mock and the loud-failure stub for the unbuilt live integration — are
 * reached through the registry, so there is exactly one answer to "which code reports
 * vehicle positions" and no other module ever talks to a GPS adapter.
 *
 * `TransportService` is exported for the fees module: `faresForBillingPeriod(tx, ...)` is
 * the documented integration surface through which invoice generation reads each student's
 * monthly transport fare inside its own transaction. Transport never writes into a fee
 * table; the fees module never reads a transport table directly.
 */
@Module({
  controllers: [TransportController],
  providers: [TransportService, GpsProviderRegistry],
  exports: [TransportService],
})
export class TransportModule {}
