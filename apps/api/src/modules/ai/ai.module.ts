import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiConversationService } from './ai-conversation.service';
import { AiUsageService } from './ai-usage.service';
import { AiProviderRegistry } from './providers/registry';

/**
 * No `imports`: `DatabaseModule` and `AuditModule` are `@Global()`, so `DatabaseService` and
 * `AuditService` are injected directly.
 *
 * `AiProviderRegistry` is provided here and only here. All four adapters — the deterministic
 * credential-free mock and the three real HTTP clients — are reached through it, so there is
 * exactly one answer to "which code talks to a model" and no other module ever constructs an
 * adapter or reads `AI_PROVIDER`. That is what makes docs/06 §4's "a provider change is
 * configuration" structurally true rather than a convention people remember.
 *
 * All three providers are exported, because the AI surfaces built on this foundation depend
 * on them:
 *
 *   AiProviderRegistry   — retrieval needs `embedder()` and `embeddingDimensions()` to size
 *                          and populate the vector column; the copilot needs `forTask()`.
 *   AiUsageService       — every code path that is about to spend money calls
 *                          `assertWithinBudget` first and `record` inside its own transaction
 *                          afterwards. Bypassing it is how a school ends up with a bill
 *                          nobody budgeted for.
 *   AiConversationService — the copilot and the tutor append turns through `appendRaw` so
 *                          `seq` allocation and the append-only discipline have exactly one
 *                          implementation.
 */
@Module({
  controllers: [AiController],
  providers: [AiProviderRegistry, AiUsageService, AiConversationService],
  exports: [AiProviderRegistry, AiUsageService, AiConversationService],
})
export class AiModule {}
