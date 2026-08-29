import { Module } from '@nestjs/common';
import { PaymentGatewayController } from './payment-gateway.controller';
import { PaymentGatewayService } from './payment-gateway.service';
import { PaymentProviderRegistry } from './providers/provider-registry';

/**
 * No `imports`: `DatabaseModule` and `AuditModule` are both `@Global()`, so `DatabaseService`
 * and `AuditService` are injected directly. The fee ledger is reached through the schema and
 * through the fees module's exported pure helper (`deriveInvoiceStatus`), not through
 * `FeesService` — the settlement path must post to *exactly* the tables and derivations the
 * fee module owns, inside this module's own transaction, and a service call could not span it.
 *
 * `PaymentProviderRegistry` is provided here and only here: every gateway adapter — the mock
 * included — is reached through the registry so there is exactly one answer to "which code
 * speaks for this provider". The registry is not exported; no other module talks to a gateway.
 *
 * `PaymentGatewayService` is exported for Phase 13 (accounting), which will post gateway
 * settlements and refunds to the ledger.
 */
@Module({
  controllers: [PaymentGatewayController],
  providers: [PaymentGatewayService, PaymentProviderRegistry],
  exports: [PaymentGatewayService],
})
export class PaymentGatewayModule {}
