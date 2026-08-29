import { Module } from '@nestjs/common';
import { AdmissionsController } from './admissions.controller';
import { AdmissionsService } from './admissions.service';
import { StudentsModule } from '../students/students.module';
import { GuardiansModule } from '../guardians/guardians.module';

/**
 * Imports StudentsModule and GuardiansModule because accepting an offer creates the real
 * student and guardian records *through those services* — duplicate detection, code
 * generation and guardian deduplication have exactly one definition each (master plan
 * invariant 7: one record per real-world entity). The dependency is one-directional:
 * students and guardians know nothing about admissions, so there is no cycle.
 */
@Module({
  imports: [StudentsModule, GuardiansModule],
  controllers: [AdmissionsController],
  providers: [AdmissionsService],
  exports: [AdmissionsService],
})
export class AdmissionsModule {}
