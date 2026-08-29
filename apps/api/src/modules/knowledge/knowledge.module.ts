import { Module } from '@nestjs/common';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';
import { KNOWLEDGE_SEARCH } from '../ai-tools/ports';
import { AiModule } from '../ai/ai.module';

/**
 * `DatabaseModule`, `AuditModule` and `StorageModule` are `@Global()`, so `DatabaseService`,
 * `AuditService` and `StorageService` inject directly. `AiModule` is not global, so it is
 * imported: it exports `AiProviderRegistry` (for `embedder()` and `embeddingDimensions()`) and
 * `AiUsageService` (for `assertWithinBudget` before a call and `record` after one). This module
 * never constructs a provider adapter and never reads a credential — docs/06 §4, no
 * application logic references a vendor.
 *
 * ── The retrieval port ────────────────────────────────────────────────────────────────
 *
 * `modules/ai-tools` consumes retrieval through a narrow port so that a tool can never reach
 * this service's internals and so that neither module imports the other's implementation. The
 * binding lives HERE, on the provider side, because this is the module that knows what
 * satisfies the contract.
 *
 * It is bound under **two tokens on purpose**:
 *
 *   - the `KNOWLEDGE_SEARCH` **Symbol** exported by `modules/ai-tools/ports.ts`, which is what
 *     the tool layer actually injects;
 *   - the **string** `'KNOWLEDGE_SEARCH'`, which is the wiring contract this phase was
 *     specified against.
 *
 * A Nest token is compared by identity, so `Symbol('KNOWLEDGE_SEARCH')` and the string
 * `'KNOWLEDGE_SEARCH'` are two entirely different tokens — binding only one would leave the
 * other unresolved, and the tool layer's ports are `@Optional()`, so the failure would be a
 * retrieval tool that quietly reports "the knowledge base is not available" rather than a
 * startup error anybody would notice. Both are bound with `useExisting`, so they are the same
 * singleton and there is no second instance holding a second connection.
 *
 * If `modules/ai-tools` ever renames its Symbol, this file must be changed with it; the
 * `implements KnowledgeSearchPort` on `KnowledgeService` is what makes a signature drift a
 * compile error rather than a runtime one.
 */
@Module({
  imports: [AiModule],
  controllers: [KnowledgeController],
  providers: [
    KnowledgeService,
    { provide: KNOWLEDGE_SEARCH, useExisting: KnowledgeService },
    { provide: 'KNOWLEDGE_SEARCH', useExisting: KnowledgeService },
  ],
  exports: [KnowledgeService, KNOWLEDGE_SEARCH, 'KNOWLEDGE_SEARCH'],
})
export class KnowledgeModule {}
