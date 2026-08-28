import { Module } from '@nestjs/common';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';

/**
 * No `imports`: `DatabaseModule` and `AuditModule` are both `@Global()`, and attendance
 * resolves its data scope from `employee_section_assignments` / `student_guardians` directly
 * rather than through `StudentsService` — the register is keyed on a section, not on a
 * student, so there is nothing to delegate and no dependency to create.
 *
 * Exported because Phase 8 (results) and Phase 12 (automation) both read attendance.
 */
@Module({
  controllers: [AttendanceController],
  providers: [AttendanceService],
  exports: [AttendanceService],
})
export class AttendanceModule {}
