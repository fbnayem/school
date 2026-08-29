/**
 * Payment gateway schemas (Phase 12).
 *
 * The same two rules that shape the fee schemas apply here, plus one of this module's own:
 *
 *  - **Money crosses the wire as a decimal string** (ADR-004): `positiveMoneySchema` regexes
 *    over strings so a poisa can never be lost to a binary float on the way in.
 *  - **A client never states a derived fact.** There is no `status` on any intent input, no
 *    `signatureValid`, no reconciliation totals. All of those are computed server-side.
 *  - **A callback body is untrusted evidence, not input.** `gatewayCallbackSchema` validates
 *    only the *shape* the module needs to route the callback; the amount it may carry is
 *    recorded but never used — the intent's amount is the only figure that ever posts.
 *
 * Constants are prefixed `PAYMENT_GATEWAY_` / `PAYMENT_INTENT_` because `@shikkha/validation`
 * re-exports flat and `fees.ts` already owns the bare `PAYMENT_` prefix.
 */

import { z } from 'zod';
import {
  calendarDateSchema,
  paginationSchema,
  positiveMoneySchema,
  reasonSchema,
  searchSchema,
  sortSchema,
  uuidSchema,
} from './common';

// ── Value sets, mirrored from the database enums ─────────────────────────────────────

export const PAYMENT_GATEWAY_PROVIDERS = [
  'mock',
  'bkash',
  'nagad',
  'rocket',
  'sslcommerz',
  'bank_transfer',
  'cash',
] as const;

export type PaymentGatewayProvider = (typeof PAYMENT_GATEWAY_PROVIDERS)[number];

/**
 * The providers an online redirect-style intent can be created against. `bank_transfer` and
 * `cash` are settled at the counter through the fees module; they exist in the provider enum
 * so offline settlements can still be reconciled, not so a browser can be redirected to them.
 */
export const PAYMENT_GATEWAY_ONLINE_PROVIDERS = [
  'mock',
  'bkash',
  'nagad',
  'rocket',
  'sslcommerz',
] as const;

export const PAYMENT_INTENT_STATUSES = [
  'created',
  'redirected',
  'pending',
  'succeeded',
  'failed',
  'expired',
  'cancelled',
  'reconciled',
] as const;

export type PaymentIntentStatus = (typeof PAYMENT_INTENT_STATUSES)[number];

export const PAYMENT_INTENT_REFUND_STATUSES = [
  'none',
  'requested',
  'rejected',
  'completed',
] as const;

export const RECONCILIATION_ITEM_STATUSES = [
  'matched',
  'missing_locally',
  'missing_remotely',
  'amount_mismatch',
] as const;

export const PAYMENT_INTENT_SORT_FIELDS = [
  'createdAt',
  'amount',
  'status',
  'provider',
  'expiresAt',
] as const;

export const PAYMENT_RECONCILIATION_SORT_FIELDS = [
  'settlementDate',
  'provider',
  'status',
  'runAt',
  'createdAt',
] as const;

// ── Intents ──────────────────────────────────────────────────────────────────────────

/**
 * Create a payment intent for a set of a student's outstanding invoices.
 *
 * `idempotencyKey` is the client's replay guard: the same key on the same institution returns
 * the original intent rather than creating a second one, enforced by a partial unique index.
 * There is no `amountFromInvoices` shortcut and no `status`: the server validates the amount
 * against the invoices' live balances, and status is always derived.
 */
export const createPaymentIntentSchema = z.object({
  studentId: uuidSchema,
  invoiceIds: z.array(uuidSchema).min(1, 'Select at least one invoice').max(50),
  amount: positiveMoneySchema,
  provider: z.enum(PAYMENT_GATEWAY_ONLINE_PROVIDERS),
  /** Where the gateway sends the payer's browser afterwards. */
  returnUrl: z.string().trim().url('Enter a full URL, e.g. https://…').max(500).optional(),
  /** How long the payer has before the intent expires as abandoned. */
  expiresInMinutes: z.coerce.number().int().min(5).max(1440).default(60),
  idempotencyKey: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_:.-]+$/, 'Use letters, numbers, and _ : . - only')
    .min(8, 'Use at least 8 characters so the key cannot collide by accident')
    .max(200),
  metadata: z.record(z.unknown()).optional(),
});

export type CreatePaymentIntentInput = z.infer<typeof createPaymentIntentSchema>;

export const cancelPaymentIntentSchema = z.object({
  reason: reasonSchema,
  /** Optimistic lock, so a cancel cannot race a callback unnoticed. */
  version: z.number().int().min(1),
});

export const listPaymentIntentsSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    studentId: uuidSchema.optional(),
    provider: z.enum(PAYMENT_GATEWAY_PROVIDERS).optional(),
    status: z.enum(PAYMENT_INTENT_STATUSES).optional(),
    refundStatus: z.enum(PAYMENT_INTENT_REFUND_STATUSES).optional(),
    createdFrom: calendarDateSchema.optional(),
    createdTo: calendarDateSchema.optional(),
    includeArchived: z.coerce.boolean().default(false),
  });

export const providerParamSchema = z.object({
  provider: z.enum(PAYMENT_GATEWAY_PROVIDERS),
});

/**
 * The generic shape this module needs from a gateway callback to route it. Validated only
 * AFTER the signature is verified, and everything else in the body is retained verbatim in
 * `raw_payload`. The `amount` a callback may claim is deliberately not parsed as money here:
 * it is evidence to record, never a figure to post.
 */
export const gatewayCallbackSchema = z
  .object({
    /** The provider's delivery/event id. Drives deduplication when present. */
    eventId: z.string().trim().min(1).max(128).optional(),
    providerIntentId: z.string().trim().min(1).max(128),
    status: z.enum(['succeeded', 'failed']),
    amount: z.string().trim().max(32).optional(),
    currency: z.string().trim().max(8).optional(),
    reference: z.string().trim().max(128).optional(),
    failureCode: z.string().trim().max(64).optional(),
    failureMessage: z.string().trim().max(500).optional(),
  })
  .passthrough();

export type GatewayCallbackInput = z.infer<typeof gatewayCallbackSchema>;

// ── Reconciliation ───────────────────────────────────────────────────────────────────

/**
 * Upload and run one settlement-file reconciliation. The file content travels in the body as
 * text (settlement files are small CSVs); parsing is the provider adapter's job, comparison
 * is the service's, and acting on mismatches is a human's.
 */
export const runReconciliationSchema = z.object({
  provider: z.enum(PAYMENT_GATEWAY_PROVIDERS),
  settlementDate: calendarDateSchema,
  fileContent: z.string().min(1, 'The settlement file is empty').max(1_000_000),
  /** Storage key or original filename, kept for later inspection. */
  fileKey: z.string().trim().max(300).optional(),
});

export type RunReconciliationInput = z.infer<typeof runReconciliationSchema>;

export const listReconciliationsSchema = paginationSchema.merge(sortSchema).extend({
  provider: z.enum(PAYMENT_GATEWAY_PROVIDERS).optional(),
  status: z.enum(['matched', 'mismatched']).optional(),
  settlementFrom: calendarDateSchema.optional(),
  settlementTo: calendarDateSchema.optional(),
  includeArchived: z.coerce.boolean().default(false),
});

// ── Refunds ──────────────────────────────────────────────────────────────────────────

/** Requesting a refund. Always full-amount; always a reason; never executes anything. */
export const requestGatewayRefundSchema = z.object({
  reason: reasonSchema,
  version: z.number().int().min(1),
});

/**
 * Deciding a refund — a **different** permission from requesting it, and the service refuses
 * an approver who is also the requester even when one person holds both.
 */
export const decideGatewayRefundSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reason: reasonSchema,
  version: z.number().int().min(1),
});

export type DecideGatewayRefundInput = z.infer<typeof decideGatewayRefundSchema>;
