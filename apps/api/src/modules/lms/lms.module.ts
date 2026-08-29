import { Module } from '@nestjs/common';
import { LmsController } from './lms.controller';
import { LmsService } from './lms.service';

/**
 * No `imports` array: `DatabaseModule`, `AuditModule` and `StorageModule` are all
 * `@Global()`, so `DatabaseService`, `AuditService` and `StorageService` inject directly.
 * The teacher-assignment and student-enrolment rules are mirrored from `StudentsService`
 * as SQL predicates rather than imported (the homework and attendance modules document the
 * same choice), so there is no dependency on `StudentsModule` and no cycle.
 */
@Module({
  controllers: [LmsController],
  providers: [LmsService],
  exports: [LmsService],
})
export class LmsModule {}
