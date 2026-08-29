/**
 * AI governance.
 *
 * The module that makes docs/06 §6 executable. Its most important export is not a service —
 * it is the `APP_GUARD` below.
 *
 * ── Why the guard is registered here rather than in `AppModule` ────────────────────────
 *
 * Registering it here means importing this module is the whole of the wiring: a deployment
 * cannot end up with the governance endpoints reporting a policy that nothing enforces,
 * because the endpoints and the enforcement arrive together. Nest applies `APP_GUARD`
 * providers from any module globally, so the guard runs on every route in the application
 * whether or not that route's module knows this one exists.
 *
 * `AiAutonomyGuard` is written to be order-independent (see its header): it may run before or
 * after `JwtAuthGuard` and decides the same way either way.
 *
 * ── No `imports` ───────────────────────────────────────────────────────────────────────
 *
 * `DatabaseModule` and `AuditModule` are `@Global()`, so `DatabaseService` and
 * `SecurityEventService` inject directly. `ModulesContainer` and `Reflector` come from
 * `@nestjs/core` and need no import either.
 *
 * ── What is exported, and for whom ─────────────────────────────────────────────────────
 *
 * `AiGovernanceService` and `RouteInventoryService`, so a later phase can render the
 * attestation into the admin UI or a scheduled report without going back over HTTP.
 * `runAiInitiated` (in `ai-initiation.ts`) is a plain function and needs no provider — an AI
 * feature that calls another module's service directly wraps that call in it, and the guard
 * then refuses anything forbidden without that feature having to know what the list contains.
 */

import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AiGovernanceController } from './ai-governance.controller';
import { AiGovernanceService } from './ai-governance.service';
import { RouteInventoryService } from './route-inventory.service';
import { AiAutonomyGuard } from './ai-autonomy.guard';

@Module({
  controllers: [AiGovernanceController],
  providers: [
    AiGovernanceService,
    RouteInventoryService,
    { provide: APP_GUARD, useClass: AiAutonomyGuard },
  ],
  exports: [AiGovernanceService, RouteInventoryService],
})
export class AiGovernanceModule {}
