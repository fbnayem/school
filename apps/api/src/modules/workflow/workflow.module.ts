import { Module } from '@nestjs/common';
import { WorkflowController } from './workflow.controller';
import { WorkflowService } from './workflow.service';

/**
 * No `imports`: `DatabaseModule` and `AuditModule` are both `@Global()`, so
 * `DatabaseService` and `AuditService` are injected directly.
 *
 * `WorkflowService` is exported because the engine is generic on purpose: any module that
 * needs a human approval chain imports this module, calls
 * `workflow.registerOutcomeHandler(...)` once at startup for its entity type, and starts
 * requests with `workflow.startWorkflow(...)` — no coupling beyond that pair. The automation
 * engine (Phase 26) will use the same surface when a rule needs a human decision.
 */
@Module({
  controllers: [WorkflowController],
  providers: [WorkflowService],
  exports: [WorkflowService],
})
export class WorkflowModule {}
