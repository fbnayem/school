import { Module } from '@nestjs/common';
import { LeaveController } from './leave.controller';
import { LeaveService } from './leave.service';
import { WorkflowModule } from '../workflow/workflow.module';
import { StudentsModule } from '../students/students.module';

/**
 * `DatabaseModule`, `AuditModule` and `StorageModule` are `@Global()`, so their services are
 * injected without an import. The two that are not global are both deliberate dependencies:
 *
 *  - **`WorkflowModule`** provides the approval chain. This module never implements one: it
 *    registers an outcome handler for the `leave_application` entity type at startup, starts
 *    a request on submission, and calls `approve` / `reject` / `cancel`. The rule that an
 *    applicant may not approve their own leave lives in the engine (and in the database),
 *    not here.
 *  - **`StudentsModule`** provides `StudentsService`, whose `assertVisible` and
 *    `scopeFilterSql` decide which students a caller may see. Guardians see their own
 *    children on the leave endpoints because that one rule says so — there is deliberately
 *    no second scoping implementation for students in this module.
 *
 * `LeaveService` is exported so payroll can read approved leave when it computes a payslip
 * without reaching into these tables directly.
 */
@Module({
  imports: [WorkflowModule, StudentsModule],
  controllers: [LeaveController],
  providers: [LeaveService],
  exports: [LeaveService],
})
export class LeaveModule {}
