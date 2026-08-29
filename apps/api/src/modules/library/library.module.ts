import { Module } from '@nestjs/common';
import { LibraryController } from './library.controller';
import { LibraryService } from './library.service';

/**
 * No `imports` array: `DatabaseModule`, `AuditModule` and `StorageModule` are all
 * `@Global()`, so `DatabaseService`, `AuditService` and `StorageService` inject directly.
 * Students and employees are read through the schema rather than through another module's
 * service — a membership card names one person, and the lookup needs the row itself, not the
 * caller's visible subset (the fees and homework modules document the same choice).
 */
@Module({
  controllers: [LibraryController],
  providers: [LibraryService],
  exports: [LibraryService],
})
export class LibraryModule {}
