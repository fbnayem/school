/**
 * Payment gateway endpoints (Phase 12).
 *
 * Every authenticated route is `@InstitutionScoped()`, exactly as the fee module: money
 * belongs to an institution and a group administrator has no safe default. The one route that
 * is not is the point of this file:
 *
 * **The callback route is `@Public()`.** It is a request from the open internet claiming that
 * money has moved, so its handling is ordered accordingly —
 *
 *   1. it is rate-limited with the strict credential-endpoint limit (`@AuthRateLimit()`),
 *      because volume is the only lever an anonymous abuser has;
 *   2. the signature is verified over the raw request body *before anything else happens* —
 *      the body is deliberately NOT run through a validation pipe here, because validating
 *      (and thereby trusting the shape of) an unverified payload would invert the security
 *      order; the service parses it only after the signature holds;
 *   3. nothing the body claims — least of all an amount — is ever trusted over the stored
 *      intent; the service posts the intent's amount, always;
 *   4. a provider's retry is a no-op returning the original result, enforced by the
 *      `payment_callbacks.dedupe_key` UNIQUE constraint;
 *   5. the response carries machine codes only (`received`/`result`/`duplicate`) and never a
 *      tenant id, student id, amount or anything else a probe could learn from.
 *
 * The permission split mirrors the fee module's separation of duties:
 *
 *   finance.collect_payment   — staff create and track intents for any student
 *   finance.own.view          — a guardian creates and tracks intents for their own children,
 *                               and nobody else's (the service scopes rows; out-of-scope is 404)
 *   finance.invoices.view     — back-office read across the institution
 *   finance.refund            — *request* a gateway refund
 *   finance.refund.approve    — *decide* one (a different person; the service refuses a
 *                               self-approval even for someone holding both)
 *   accounting.reconcile      — run a settlement-file reconciliation
 *   finance.reports.view      — read reconciliation reports
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { z } from 'zod';
import { normalizeOffsetPage } from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import {
  cancelPaymentIntentSchema,
  createPaymentIntentSchema,
  decideGatewayRefundSchema,
  idParamSchema,
  listPaymentIntentsSchema,
  listReconciliationsSchema,
  providerParamSchema,
  requestGatewayRefundSchema,
  runReconciliationSchema,
  type PaymentGatewayProvider,
} from '@shikkha/validation';
import { PaymentGatewayService } from './payment-gateway.service';
import {
  Audited,
  CurrentUser,
  InstitutionScoped,
  Public,
  RequirePermissions,
} from '../../common/decorators';
import { AuthRateLimit } from '../../common/guards/rate-limit.guard';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { currentContext } from '../../common/context/request-context';

/** The header a gateway (and the mock provider's tests) carry the callback signature in. */
export const GATEWAY_SIGNATURE_HEADER = 'x-gateway-signature';

@ApiTags('payments')
@Controller('payments')
@InstitutionScoped()
export class PaymentGatewayController {
  constructor(private readonly gateway: PaymentGatewayService) {}

  // ── Intents ─────────────────────────────────────────────────────────────────────────

  /**
   * Create a payment intent. Staff (`finance.collect_payment`) may create one for any student
   * of the institution; a guardian (`finance.own.view`) only for a child they have a live,
   * portal-enabled link to — the service enforces that and answers anything else with the same
   * 404 a nonexistent student gets.
   */
  @Post('intents')
  @RequirePermissions('finance.collect_payment', 'finance.own.view', { mode: 'any' })
  @Audited({
    module: 'payment_gateway',
    resourceType: 'payment_intent',
    action: 'create',
    resourceIdFrom: 'response:id',
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Create a payment intent and obtain the gateway redirect URL' })
  async createIntent(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createPaymentIntentSchema)) body: z.infer<typeof createPaymentIntentSchema>,
  ) {
    return this.gateway.createIntent(principal, requireInstitution(), body);
  }

  @Get('intents')
  @RequirePermissions('finance.invoices.view', 'finance.collect_payment', 'finance.own.view', {
    mode: 'any',
  })
  @ApiOperation({ summary: 'List payment intents within the caller’s data scope' })
  async listIntents(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listPaymentIntentsSchema)) query: z.infer<typeof listPaymentIntentsSchema>,
  ) {
    return this.gateway.listIntents(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Get('intents/:id')
  @RequirePermissions('finance.invoices.view', 'finance.collect_payment', 'finance.own.view', {
    mode: 'any',
  })
  @ApiOperation({ summary: 'Fetch one payment intent' })
  async getIntent(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.gateway.getIntent(principal, requireInstitution(), params.id);
  }

  /**
   * Poll the gateway's status API and fold the answer into local state — the recovery path
   * for a lost callback (docs/09: "callbacks do get lost"). A reported success posts the
   * payment through exactly the same settlement path a signed callback uses.
   */
  @Post('intents/:id/sync')
  @RequirePermissions('finance.invoices.view', 'finance.collect_payment', 'finance.own.view', {
    mode: 'any',
  })
  @Audited({
    module: 'payment_gateway',
    resourceType: 'payment_intent',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Poll the gateway for this intent’s status and apply the result' })
  async syncIntent(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.gateway.syncIntent(principal, requireInstitution(), params.id);
  }

  @Post('intents/:id/cancel')
  @RequirePermissions('finance.invoices.view', 'finance.collect_payment', 'finance.own.view', {
    mode: 'any',
  })
  @Audited({
    module: 'payment_gateway',
    resourceType: 'payment_intent',
    action: 'update',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Cancel an open payment intent' })
  async cancelIntent(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(cancelPaymentIntentSchema)) body: z.infer<typeof cancelPaymentIntentSchema>,
  ) {
    return this.gateway.cancelIntent(
      principal,
      requireInstitution(),
      params.id,
      body.reason,
      body.version,
    );
  }

  // ── The public callback — the unauthenticated edge ──────────────────────────────────

  /**
   * Receive one gateway callback. See the file header for the security order; two mechanical
   * notes belong here:
   *
   * **No validation pipe on the body.** `gatewayCallbackSchema` is applied by the service
   * *after* the signature verifies. A pipe here would reject a forged-but-malformed payload
   * before the attempt was recorded, and recording hostile traffic is a feature.
   *
   * **The raw body.** Signature schemes sign bytes, so the service is handed the exact string
   * from the wire when the runtime provides it (`request.rawBody`, populated when the app is
   * bootstrapped with `rawBody: true`). Where it is not populated, the parsed body is
   * re-serialised: `JSON.parse` preserves key order and `JSON.stringify` emits the compact
   * form, so for the compact-JSON bodies gateways (and the mock provider's tests) send, the
   * round trip is byte-identical. Verification stays strict either way — a payload whose
   * signature does not match is recorded and refused. Enabling `rawBody` at bootstrap is the
   * production-hardening step, and it requires no change here.
   *
   * Responds 200 rather than 201: providers treat any 2xx as delivered, and this endpoint
   * creates nothing the caller may know about.
   */
  @Post('callback/:provider')
  @Public()
  @AuthRateLimit()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Receive a payment gateway callback (signed, idempotent)' })
  async gatewayCallback(
    @Param(zodParam(providerParamSchema)) params: { provider: PaymentGatewayProvider },
    @Req() request: RawBodyRequest<Request>,
    @Headers(GATEWAY_SIGNATURE_HEADER) signatureHeader: string | undefined,
  ) {
    const rawBody =
      request.rawBody instanceof Buffer && request.rawBody.length > 0
        ? request.rawBody.toString('utf8')
        : JSON.stringify(request.body ?? {});
    const signature =
      typeof signatureHeader === 'string' && signatureHeader.trim() !== ''
        ? signatureHeader.trim()
        : null;

    // Machine codes only ({ received, result, duplicate }) — never tenant data.
    return this.gateway.handleCallback(params.provider, rawBody, request.body, signature);
  }

  // ── Reconciliation ──────────────────────────────────────────────────────────────────

  /**
   * Run one settlement-file reconciliation. It reports every mismatch class and corrects
   * nothing; the one status change it may make is `succeeded` → `reconciled` on an exact
   * match. Audited as an `import` — the service writes the detailed record in-transaction.
   */
  @Post('reconciliations')
  @RequirePermissions('accounting.reconcile')
  @Audited({
    module: 'payment_gateway',
    resourceType: 'payment_reconciliation',
    action: 'import',
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Reconcile a provider settlement file against local intents' })
  async runReconciliation(
    @CurrentUser() principal: Principal,
    @Body(zodBody(runReconciliationSchema)) body: z.infer<typeof runReconciliationSchema>,
  ) {
    return this.gateway.runReconciliation(principal, requireInstitution(), body);
  }

  @Get('reconciliations')
  @RequirePermissions('finance.reports.view', 'accounting.reconcile', { mode: 'any' })
  @ApiOperation({ summary: 'List reconciliation runs' })
  async listReconciliations(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listReconciliationsSchema)) query: z.infer<typeof listReconciliationsSchema>,
  ) {
    return this.gateway.listReconciliations(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Get('reconciliations/:id')
  @RequirePermissions('finance.reports.view', 'accounting.reconcile', { mode: 'any' })
  @ApiOperation({ summary: 'Fetch one reconciliation run with its items' })
  async getReconciliation(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.gateway.getReconciliation(principal, requireInstitution(), params.id);
  }

  // ── Refunds — two people, never automatic ───────────────────────────────────────────

  /** Requesting a refund records the request and executes nothing. */
  @Post('intents/:id/refund-request')
  @RequirePermissions('finance.refund')
  @Audited({
    module: 'payment_gateway',
    resourceType: 'payment_intent',
    action: 'refund',
    resourceIdFrom: 'param:id',
    requiresReason: true,
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Request a refund of a succeeded gateway payment' })
  async requestRefund(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(requestGatewayRefundSchema)) body: z.infer<typeof requestGatewayRefundSchema>,
  ) {
    return this.gateway.requestRefund(
      principal,
      requireInstitution(),
      params.id,
      body.reason,
      body.version,
    );
  }

  /**
   * Deciding a refund — a **different** permission from requesting it, and the service
   * additionally refuses a decider who is also the requester, even when one person holds
   * both. Approval is the only code path in the platform that calls a gateway's refund API.
   *
   * The route-level audit action is recorded as `approve` for both outcomes; the record the
   * service writes inside the transaction carries the actual decision.
   */
  @Post('intents/:id/refund-decision')
  @RequirePermissions('finance.refund.approve')
  @Audited({
    module: 'payment_gateway',
    resourceType: 'payment_intent',
    action: 'approve',
    resourceIdFrom: 'param:id',
    requiresReason: true,
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Approve or reject a requested refund' })
  async decideRefund(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(decideGatewayRefundSchema)) body: z.infer<typeof decideGatewayRefundSchema>,
  ) {
    return this.gateway.decideRefund(principal, requireInstitution(), params.id, body);
  }
}

/**
 * `@InstitutionScoped()` makes the tenant guard require and validate the header; this is the
 * belt-and-braces read, because `currentContext()` returns `string | null` and a service that
 * received `null` would silently query across institutions.
 */
function requireInstitution(): string {
  const institutionId = currentContext()?.institutionId;
  if (!institutionId) {
    throw new BadRequestException(
      'Send the x-institution-id header to indicate which institution these payments belong to.',
    );
  }
  return institutionId;
}
