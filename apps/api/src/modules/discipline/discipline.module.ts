import { Module } from '@nestjs/common';
import { DisciplineController } from './discipline.controller';
import { DisciplineService } from './discipline.service';

/**
 * No `imports`: `DatabaseModule` and `AuditModule` are both `@Global()`, so
 * `DatabaseService` and `AuditService` are injected directly. The module reads students,
 * enrolments and guardian links through the schema rather than through another module's
 * service, applying the same scope predicates `students.service.ts` documents.
 *
 * `DisciplineService` is exported for later phases (e.g. student profile aggregation and
 * transfer-certificate generation), which must read a student's disciplinary summary through
 * the same scope rules rather than re-deriving them.
 */
@Module({
  controllers: [DisciplineController],
  providers: [DisciplineService],
  exports: [DisciplineService],
})
export class DisciplineModule {}
