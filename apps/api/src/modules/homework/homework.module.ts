import { Module } from '@nestjs/common';
import { HomeworkController } from './homework.controller';
import { HomeworkService } from './homework.service';

/**
 * No `imports` array: `DatabaseModule`, `AuditModule` and `StorageModule` are all
 * `@Global()`. The scope rules are mirrored from `StudentsService` rather than imported
 * (the attendance and exams modules document the same choice), so there is no dependency
 * on `StudentsModule` and no cycle.
 */
@Module({
  controllers: [HomeworkController],
  providers: [HomeworkService],
  exports: [HomeworkService],
})
export class HomeworkModule {}
