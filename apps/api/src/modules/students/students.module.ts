import { Module } from '@nestjs/common';
import { StudentsController } from './students.controller';
import { StudentsService } from './students.service';
import { StudentLifecycleController } from './lifecycle.controller';
import { EnrollmentService } from './enrollment.service';
import { TransfersService } from './transfers.service';
import { ImportExportService } from './import-export.service';
import { StudentDocumentsController, FilesController } from './documents.controller';
import { StudentDocumentsService } from './documents.service';

/**
 * Controller order matters: Express matches routes in registration order, and
 * `StudentsController` declares its literal paths (`export`, `import/*`) before its `:id`
 * routes for the same reason.
 */
@Module({
  controllers: [
    StudentsController,
    StudentLifecycleController,
    StudentDocumentsController,
    FilesController,
  ],
  providers: [
    StudentsService,
    EnrollmentService,
    TransfersService,
    ImportExportService,
    StudentDocumentsService,
  ],
  exports: [StudentsService],
})
export class StudentsModule {}
