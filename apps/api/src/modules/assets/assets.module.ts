import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';

/**
 * `DatabaseModule` and `AuditModule` are both `@Global()`, so `DatabaseService` and
 * `AuditService` inject directly. `AccountingModule` is imported explicitly for its
 * exported `LedgerService`: posting a depreciation run (and, when the accounts are named,
 * approving a disposal) writes one balanced journal entry through `LedgerService.post`
 * **inside the same transaction** as the register updates, so the run and its ledger
 * effect commit together or not at all — the same arrangement payroll uses to disburse.
 *
 * Employees, rooms, departments and campuses are read through the schema rather than
 * through another module's service: an assignment names one row, and the lookup needs
 * that row itself, not the caller's visible subset (fees, library and homework document
 * the same choice). The inventory module (Phase 19) is an optional peer, not a
 * dependency — `assets.source_reference` is a bare uuid and nothing here imports it.
 */
@Module({
  imports: [AccountingModule],
  controllers: [AssetsController],
  providers: [AssetsService],
  exports: [AssetsService],
})
export class AssetsModule {}
