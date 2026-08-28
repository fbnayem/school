import { Module } from '@nestjs/common';
import { ExamsController } from './exams.controller';
import { ExamsService } from './exams.service';

/**
 * No `imports`: `DatabaseModule` and `AuditModule` are both `@Global()`, and this module
 * consumes no other feature service. Student and section visibility is expressed here as a
 * predicate over `results.section_id` rather than by calling into `StudentsService`, so there
 * is no dependency and no cycle — the scope *rule* is mirrored from `StudentsService`, which
 * is documented at `ExamsService.assignedSectionPredicate`.
 */
@Module({
  controllers: [ExamsController],
  providers: [ExamsService],
  exports: [ExamsService],
})
export class ExamsModule {}
