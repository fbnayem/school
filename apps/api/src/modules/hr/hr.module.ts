import { Module } from '@nestjs/common';
import { HrController } from './hr.controller';
import { HrService } from './hr.service';

/**
 * No `imports`: `DatabaseModule`, `AuditModule` and `StorageModule` are all `@Global()`, so
 * `DatabaseService` and `StorageService` are injected directly and route-level `@Audited`
 * metadata is handled by the global audit interceptor.
 *
 * `HrService` is exported for Phase 16 (payroll), which reuses `computeSalaryBreakdown` and
 * reads salary assignments through this module rather than keeping its own copy of the
 * arithmetic.
 */
@Module({
  controllers: [HrController],
  providers: [HrService],
  exports: [HrService],
})
export class HrModule {}
