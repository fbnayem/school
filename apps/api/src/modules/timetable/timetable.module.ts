import { Module } from '@nestjs/common';
import { TimetableController, TimetableViewController } from './timetable.controller';
import { TimetableService } from './timetable.service';

/**
 * No `imports`: `DatabaseModule` and `AuditModule` are both `@Global()`, and the timetable
 * depends on no other feature service — it reads sections, periods, rooms and employees
 * directly, because those are configuration tables rather than another module's private state.
 *
 * `TimetableService` is exported because attendance (Phase 7) takes its register from the
 * published routine, and there must be exactly one implementation of "which lesson is
 * happening now, and who is actually taking it".
 */
@Module({
  controllers: [TimetableController, TimetableViewController],
  providers: [TimetableService],
  exports: [TimetableService],
})
export class TimetableModule {}
