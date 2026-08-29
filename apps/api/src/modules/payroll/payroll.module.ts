import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module';
import { PayrollController } from './payroll.controller';
import { PayrollService } from './payroll.service';

/**
 * `DatabaseModule` and `AuditModule` are both `@Global()`, so `DatabaseService` and
 * `AuditService` are injected directly. `AccountingModule` is imported explicitly for its
 * exported `LedgerService`: marking a run paid posts one balanced journal entry inside the
 * payroll transaction, and nothing outside the accounting module touches the journal
 * tables directly. The HR module's salary arithmetic is reused through its exported pure
 * function `computeSalaryBreakdown` — no provider dependency, so no module import.
 */
@Module({
  imports: [AccountingModule],
  controllers: [PayrollController],
  providers: [PayrollService],
  exports: [PayrollService],
})
export class PayrollModule {}
