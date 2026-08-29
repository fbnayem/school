import { Module } from '@nestjs/common';
import { StudentsModule } from '../students/students.module';
import { AiToolsController } from './ai-tools.controller';
import { ToolRegistryService } from './tool-registry.service';
import { ToolScopeService } from './tool-scope.service';
import { StudentLookupTool } from './tools/student-lookup.tool';
import { AttendanceSummaryTool } from './tools/attendance-summary.tool';
import { ResultsSummaryTool } from './tools/results-summary.tool';
import { FinanceOutstandingTool } from './tools/finance-outstanding.tool';
import { TimetableLookupTool } from './tools/timetable-lookup.tool';
import { KnowledgeSearchTool } from './tools/knowledge-search.tool';

/**
 * The AI tool surface.
 *
 * `StudentsModule` is imported — the only feature module this one depends on — because
 * `StudentsService` owns the answer to "which students may this principal see", and every
 * tool that touches a student goes through it. Other modules deliberately read the schema
 * directly instead of importing each other (see `FeesModule`'s note); this one does the
 * opposite, because here the caller's *visible subset* is the whole point rather than an
 * inconvenience. Reimplementing the scope join would be a second authorization implementation,
 * which is the one thing docs/07 says never to have.
 *
 * `DatabaseModule` and `AuditModule` are `@Global()`, so `DatabaseService`, `AuditService` and
 * `SecurityEventService` inject directly.
 *
 * ── Wiring the AI module's services in ─────────────────────────────────────────────────
 *
 * Two capabilities are consumed through optional ports (`ports.ts`) so this module compiles
 * and boots before `modules/ai` and `modules/knowledge` exist. When they land, bind them here
 * — nothing inside this module changes:
 *
 *     import { AiUsageService } from '../ai/ai-usage.service';
 *     import { KnowledgeService } from '../knowledge/knowledge.service';
 *     …
 *     providers: [
 *       …,
 *       { provide: AI_USAGE_RECORDER, useExisting: AiUsageService },
 *       { provide: KNOWLEDGE_SEARCH, useExisting: KnowledgeService },
 *     ]
 *
 * Until then `knowledge.search` refuses with a 503 that says so, and tool usage is recorded in
 * the audit log with a zero cost rather than in a ledger that does not exist yet. Neither
 * fabricates an answer, which is the property that matters.
 */
@Module({
  imports: [StudentsModule],
  controllers: [AiToolsController],
  providers: [
    ToolRegistryService,
    ToolScopeService,
    StudentLookupTool,
    AttendanceSummaryTool,
    ResultsSummaryTool,
    FinanceOutstandingTool,
    TimetableLookupTool,
    KnowledgeSearchTool,
  ],
  // Exported for the AI gateway module, which resolves the manifest server-side when it
  // assembles a prompt rather than making an HTTP round trip to itself.
  exports: [ToolRegistryService],
})
export class AiToolsModule {}
