import { Module } from '@nestjs/common';
import { AccountingController } from './accounting.controller';
import { AccountingService, LedgerService } from './accounting.service';

/**
 * No `imports`: `DatabaseModule` and `AuditModule` are both `@Global()`, so
 * `DatabaseService` and `AuditService` are injected directly. The workflow engine is an
 * optional peer, not a dependency — expense claims carry a bare `workflow_request_id` and
 * this module never imports the workflow module.
 *
 * Two providers are exported, for two different callers:
 *
 *  - **`LedgerService`** is the posting engine. Any module whose actions have a ledger
 *    effect (fees, payroll, inventory) imports `AccountingModule` and calls
 *    `LedgerService.post` / `LedgerService.reverse` **inside its own transaction**, so the
 *    business write and its journal entry commit together or not at all. Nothing outside
 *    this module touches the journal tables directly.
 *  - **`AccountingService`** carries the expense-claim workflow callbacks
 *    (`attachExpenseClaimWorkflow`, `onExpenseClaimWorkflowDecision`) that the workflow
 *    module — if installed — invokes; the dependency points that way, never back.
 */
@Module({
  controllers: [AccountingController],
  providers: [AccountingService, LedgerService],
  exports: [LedgerService, AccountingService],
})
export class AccountingModule {}
