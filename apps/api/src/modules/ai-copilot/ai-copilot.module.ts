import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { AiToolsModule } from '../ai-tools/ai-tools.module';
import { StudentsModule } from '../students/students.module';
import { CommunicationModule } from '../communication/communication.module';
import { DisciplineModule } from '../discipline/discipline.module';
import { AdmissionsModule } from '../admissions/admissions.module';
import { TimetableModule } from '../timetable/timetable.module';
import { AccountingModule } from '../accounting/accounting.module';
import { AiCopilotController } from './ai-copilot.controller';
import { AiCopilotService } from './ai-copilot.service';
import { AiSuggestionService } from './ai-suggestion.service';
import { SuggestionExecutorService } from './suggestion-executor.service';

/**
 * The copilots and the suggestion-review machinery.
 *
 * This module imports more feature modules than any other in the codebase, and that is the
 * point rather than an accident. docs/06 §6 says an accepted suggestion is carried out by "a
 * normal permission-checked, audited API call" in the module that owns the record; the only
 * way to make that true without a second implementation of every one of those rules is to call
 * those modules' own services. So `SuggestionExecutorService` depends on
 * `CommunicationService`, `DisciplineService`, `AdmissionsService`, `TimetableService` and
 * `AccountingService`, and there is no table access anywhere in this module outside
 * `ai_suggestions` itself.
 *
 * The alternative — this module writing a `message_threads` row directly because it is two
 * lines shorter — is precisely how a suggestion becomes a mutation with a review screen in
 * front of it, which is the thing this phase exists to prevent.
 *
 * `StudentsModule` is imported for the same reason `AiToolsModule` imports it: `StudentsService`
 * owns the answer to "which students may this principal see", and the suggestion queue's
 * visibility filter reuses `scopeFilterSql` verbatim rather than re-deriving the scope join. A
 * second implementation's first divergence would be a leak — the students endpoint says 404
 * and the suggestion queue says 200.
 *
 * `AiModule` supplies the provider registry, the usage ledger (`assertWithinBudget` before any
 * spend) and `AiConversationService`, whose `appendRaw` keeps `seq` allocation and the
 * append-only discipline in one place. `AiToolsModule` exports the tool registry, which is the
 * only way this module reaches institutional data on the caller's behalf.
 *
 * `DatabaseModule` and `AuditModule` are `@Global()`, so `DatabaseService` and `AuditService`
 * inject directly.
 */
@Module({
  imports: [
    AiModule,
    AiToolsModule,
    StudentsModule,
    CommunicationModule,
    DisciplineModule,
    AdmissionsModule,
    TimetableModule,
    AccountingModule,
  ],
  controllers: [AiCopilotController],
  providers: [AiCopilotService, AiSuggestionService, SuggestionExecutorService],
  exports: [AiSuggestionService],
})
export class AiCopilotModule {}
