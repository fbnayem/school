import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

/**
 * Inventory and procurement (Phase 19).
 *
 * `DatabaseModule` and `AuditModule` are both `@Global()`, so `DatabaseService` and
 * `AuditService` are injected directly. `AccountingModule` is imported explicitly for its
 * exported `LedgerService`: a goods receipt posts one balanced journal entry (debit each
 * item's stock account, credit the supplier payable) inside the receipt's own transaction,
 * and nothing outside the accounting module touches the journal tables directly. The
 * workflow engine is an optional peer, not a dependency — `purchase_requisitions` carries a
 * bare `workflow_request_id` and this module never imports the workflow module.
 *
 * `InventoryService` is exported for the asset-management phase, which consumes the same
 * catalogue and stores when an asset is issued from stock.
 */
@Module({
  imports: [AccountingModule],
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
