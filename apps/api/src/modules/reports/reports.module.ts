import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { StudentsModule } from '../students/students.module';

/**
 * `DatabaseModule`, `AuditModule` and `StorageModule` are all `@Global()`, so their services
 * are injected without being listed here.
 *
 * `StudentsModule` is imported for exactly one reason, and it is the most important line in
 * this module: `StudentsService.requireScope` / `scopeFilterSql` is the *only* answer in the
 * system to "which students may this caller see", and the reporting surface reuses it rather
 * than deriving a second one. A reporting module that reimplemented that predicate would be
 * a way to read rows the student list refuses, which is precisely the failure this module
 * exists to avoid.
 *
 * The dependency points one way. Nothing in the students module knows reporting exists.
 */
@Module({
  imports: [StudentsModule],
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
