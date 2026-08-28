import { Module } from '@nestjs/common';
import { GuardiansController } from './guardians.controller';
import { GuardiansService } from './guardians.service';
import { StudentsModule } from '../students/students.module';

/**
 * Imports StudentsModule because guardian visibility is defined in terms of student
 * visibility — see `GuardiansService`. The dependency is one-directional: students know
 * nothing about guardians, so there is no cycle.
 */
@Module({
  imports: [StudentsModule],
  controllers: [GuardiansController],
  providers: [GuardiansService],
  exports: [GuardiansService],
})
export class GuardiansModule {}
