import { Module } from '@nestjs/common';
import { AiTutorController } from './ai-tutor.controller';
import { AiTutorService } from './ai-tutor.service';
import { AiModule } from '../ai/ai.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';

/**
 * The student tutoring surface (Phase 35).
 *
 * `DatabaseModule` and `AuditModule` are `@Global()`, so `DatabaseService` and `AuditService`
 * inject directly. The two explicit imports are the point of this file:
 *
 *   `AiModule`        exports `AiUsageService` (budget before the call, usage event inside
 *                     the turn's own transaction, and the `isTutoringEnabled` switch),
 *                     `AiConversationService` (so `seq` allocation and the append-only
 *                     transcript have exactly one implementation) and `AiProviderRegistry`
 *                     (so this module never constructs an adapter and never reads a
 *                     credential — docs/06 §4).
 *   `KnowledgeModule` exports the `KNOWLEDGE_SEARCH` port. Retrieval is reused, not rebuilt:
 *                     a second retriever would be a second place to get the audience filter
 *                     subtly wrong, and the one that got it wrong would be the one serving
 *                     children.
 *
 * The port is injected **non-optionally**, unlike in `modules/ai-tools` where it is
 * `@Optional()`. A tool surface can honestly report "the knowledge base is not available";
 * this module cannot, because "answer only from the school's own material, and say so when
 * there is none" is not a feature it can degrade out of. A missing binding is a startup
 * failure, which is the right place to find out.
 *
 * Nothing is exported. Everything above this module talks to the tutor over HTTP, and there
 * is no second consumer that should be able to open a session on a student's behalf.
 */
@Module({
  imports: [AiModule, KnowledgeModule],
  controllers: [AiTutorController],
  providers: [AiTutorService],
})
export class AiTutorModule {}
