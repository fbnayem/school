import { Module } from '@nestjs/common';
import { WorkflowModule } from '../workflow/workflow.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CommunicationModule } from '../communication/communication.module';
import { StudentsModule } from '../students/students.module';
import { AutomationController } from './automation.controller';
import { AutomationService } from './automation.service';

/**
 * Automation engine (Phase 26).
 *
 * `DatabaseModule` and `AuditModule` are both `@Global()`, so `DatabaseService` and
 * `AuditService` inject directly — the same choice accounting, workflow and communication
 * document. Everything else this module needs already exists and is imported rather than
 * rebuilt:
 *
 *  - **`WorkflowModule`** — the human approval engine. A rule that needs a person's decision
 *    calls `WorkflowService.startWorkflow`; it never grows its own approval chain
 *    (docs/08_WORKFLOW_ENGINE.md §5).
 *  - **`CommunicationModule`** — the message path. A `notify` action opens a direct thread
 *    through `CommunicationService.createThread`, which is append-only, permission-checked,
 *    and already built on the single notification abstraction. Its own docblock anticipates
 *    exactly this caller. A rule may reach at most twenty people; anything wider is mass
 *    communication and belongs to that module's two-person approval path.
 *  - **`NotificationsModule`** — imported because the transport abstraction underneath the
 *    communication module is the one this module's actions ultimately ride on, and because
 *    depending on it explicitly is what stops a future contributor from adding a second one.
 *  - **`StudentsModule`** — for `StudentsService.assertVisible`. An emitter naming a student
 *    must be able to see that student, and the scope rule is reused rather than re-derived.
 *
 * **No scheduler is registered here, deliberately.** There is no `ScheduleModule`, no cron
 * provider and no background worker. `POST /automation/events/process` and
 * `GET /automation/schedule/due` are ordinary permission-checked endpoints, which keeps the
 * behaviour testable today and leaves *when* rules run to the deployment — a cron entry, a
 * queue worker, a Kubernetes CronJob. Rules store `cron_expression` and `timezone`; this
 * module reports on them and never executes them.
 *
 * `AutomationService` is exported so a module that raises an event of its own (attendance
 * when a register is submitted, fees when an invoice ages) can call `emitEvent` directly
 * instead of going out through HTTP.
 */
@Module({
  imports: [WorkflowModule, NotificationsModule, CommunicationModule, StudentsModule],
  controllers: [AutomationController],
  providers: [AutomationService],
  exports: [AutomationService],
})
export class AutomationModule {}
