import { Module } from '@nestjs/common';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { StudentsModule } from '../students/students.module';

/**
 * `StudentsModule` is imported for exactly one reason: `StudentsService`, whose
 * `assertVisible`, `findOne`, `requireScope` and `scopeFilterSql` are the *only* definition of
 * "which students may this caller see". This module reuses them rather than deriving a second
 * rule that would eventually disagree — a teacher who cannot fetch a student must not be able
 * to print that student's certificate, and there is one predicate that decides.
 *
 * `DatabaseModule`, `AuditModule` and `StorageModule` are all `@Global()`, so
 * `DatabaseService`, `AuditService` and `StorageService` are injected directly.
 *
 * Nothing is exported. Documents are produced *from* other modules' data; no module needs to
 * call into this one, and keeping the dependency one-directional is what stops the renderer
 * becoming a back door into records it should be reading through their owners.
 */
@Module({
  imports: [StudentsModule],
  controllers: [DocumentsController],
  providers: [DocumentsService],
})
export class DocumentsModule {}
