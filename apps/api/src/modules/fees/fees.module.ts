import { Module } from '@nestjs/common';
import { FeesController } from './fees.controller';
import { FeesService } from './fees.service';

/**
 * No `imports`: `DatabaseModule` and `AuditModule` are both `@Global()`, so `DatabaseService`
 * and `AuditService` are injected directly. Nothing else is consumed — the fee module reads
 * students and enrolments through the schema rather than through another module's service,
 * because it needs *every* enrolled student in a section, not the caller's visible subset,
 * when a billing run is executed by someone with `finance.invoices.generate`.
 *
 * `FeesService` is exported for Phase 13 (accounting), which will post invoices and receipts
 * to the ledger.
 */
@Module({
  controllers: [FeesController],
  providers: [FeesService],
  exports: [FeesService],
})
export class FeesModule {}
