/**
 * Payment gateway abstraction (Phase 12).
 *
 * The fee module (Phase 11) owns the money: `invoices`, `payments` and `payment_allocations`
 * are the ledger. This module is the layer *in front* of that ledger for money arriving over
 * the internet, and its tables record intent, evidence and comparison — never a balance:
 *
 *  - **`payment_intents`** — "we asked a gateway to collect this amount for these invoices".
 *    Created before the payer is redirected, so an abandoned payment (`expired`) is
 *    distinguishable from a failed one (`failed`). The amount is fixed at creation and is the
 *    ONLY amount the module will ever post: a callback's claimed amount is recorded as
 *    evidence but never trusted over the intent.
 *  - **`payment_callbacks`** — every callback the internet ever sent us, verified or not,
 *    processed or not. Append-only in practice; the `dedupe_key` UNIQUE index is what makes a
 *    provider's retry a database-level no-op rather than a double credit.
 *  - **`payment_reconciliations`** / **`reconciliation_items`** — the comparison of a
 *    provider's settlement file against local intents. A reconciliation run *reports* every
 *    mismatch class; it never moves money. The single status change it may make is
 *    `succeeded` → `reconciled` on an exact match, which confirms bookkeeping rather than
 *    altering it.
 *
 * Enum note: the value sets below are genuinely closed — adding a gateway provider or an
 * intent status changes signature verification and settlement parsing code, so it should
 * require a migration. They are therefore `pgEnum`s, per the rule documented in `fees.ts`.
 */

import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  actorColumns,
  archiveColumns,
  primaryKeyColumn,
  timestampColumns,
  versionColumn,
} from './_shared';
import { institutions, organizations } from './tenancy';
import { students } from './students';
import { payments } from './fees';

// ─────────────────────────────────────────────────────────────────────────────────────
// Enumerations
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Which channel an intent goes through. The mobile financial services are first-class because
 * in Bangladesh they are. `bank_transfer` and `cash` exist so an offline settlement can still
 * be reconciled through the same tables, but no online adapter is registered for them — the
 * service refuses to create a redirect-style intent against an offline channel.
 */
export const paymentGatewayProviderEnum = pgEnum('payment_gateway_provider', [
  'mock',
  'bkash',
  'nagad',
  'rocket',
  'sslcommerz',
  'bank_transfer',
  'cash',
]);

/**
 * Intent lifecycle. Derived by the service, never client-supplied.
 *
 * `expired` and `failed` are deliberately distinct: an abandoned checkout (nobody ever paid)
 * and a refused one (somebody tried and the gateway said no) are different facts, and a
 * collections clerk chasing a family needs to know which one happened.
 * `reconciled` means the succeeded intent was later confirmed against a settlement file.
 */
export const paymentIntentStatusEnum = pgEnum('payment_intent_status', [
  'created',
  'redirected',
  'pending',
  'succeeded',
  'failed',
  'expired',
  'cancelled',
  'reconciled',
]);

/** One row of a reconciliation report. Every mismatch class is named, none is auto-fixed. */
export const reconciliationItemStatusEnum = pgEnum('reconciliation_item_status', [
  'matched',
  'missing_locally',
  'missing_remotely',
  'amount_mismatch',
]);

// ─────────────────────────────────────────────────────────────────────────────────────
// Payment intents
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A request for a gateway to collect money for a set of invoices.
 *
 * `idempotency_key` is unique per institution (partial, live rows only), enforced by the
 * database rather than by the service remembering to check — two identical "pay now" clicks
 * produce one intent. `amount` is `numeric(14, 2)` and is the authoritative figure for the
 * eventual ledger posting; nothing a callback carries can change it.
 *
 * `payment_id` links to the fee-side `payments` row once the intent succeeds. The check
 * constraint in the migration makes "succeeded without a payment" unrepresentable, which is
 * the schema-level statement of "the ledger posting happens in the same transaction".
 *
 * The refund columns are a separation-of-duties record: `finance.refund` requests, a
 * *different* holder of `finance.refund.approve` decides, and the service refuses a
 * self-approval outright. Refunds are never automatic.
 */
export const paymentIntents = pgTable(
  'payment_intents',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'restrict' }),

    /** The invoices this intent is meant to settle, oldest-due-first at posting time. */
    invoiceIds: jsonb('invoice_ids').$type<string[]>().notNull(),

    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('BDT'),

    provider: paymentGatewayProviderEnum('provider').notNull(),
    /** The gateway's own identifier for this transaction; what callbacks reference. */
    providerIntentId: varchar('provider_intent_id', { length: 128 }),
    status: paymentIntentStatusEnum('status').notNull().default('created'),

    /** Client-supplied replay guard, unique per institution among live rows. */
    idempotencyKey: varchar('idempotency_key', { length: 200 }).notNull(),
    returnUrl: varchar('return_url', { length: 500 }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),

    /** The fee-side payment posted when the intent succeeded. Same transaction, always. */
    paymentId: uuid('payment_id').references(() => payments.id, { onDelete: 'restrict' }),
    succeededAt: timestamp('succeeded_at', { withTimezone: true, mode: 'date' }),

    failureCode: varchar('failure_code', { length: 64 }),
    failureMessage: varchar('failure_message', { length: 500 }),
    cancelledReason: varchar('cancelled_reason', { length: 500 }),

    /** `'none' | 'requested' | 'rejected' | 'completed'` — documented union, likely to grow. */
    refundStatus: varchar('refund_status', { length: 16 }).notNull().default('none'),
    refundReason: varchar('refund_reason', { length: 1000 }),
    refundRequestedBy: uuid('refund_requested_by'),
    refundRequestedAt: timestamp('refund_requested_at', { withTimezone: true, mode: 'date' }),
    refundDecidedBy: uuid('refund_decided_by'),
    refundDecidedAt: timestamp('refund_decided_at', { withTimezone: true, mode: 'date' }),
    refundDecisionNote: varchar('refund_decision_note', { length: 1000 }),
    /** The gateway's reference for the executed refund. */
    refundProviderReference: varchar('refund_provider_reference', { length: 128 }),

    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('payment_intents_idempotency_key')
      .on(table.institutionId, table.idempotencyKey)
      .where(sql`${table.archivedAt} IS NULL`),
    // Callback lookup path: one live intent per gateway reference.
    uniqueIndex('payment_intents_provider_ref_key')
      .on(table.provider, table.providerIntentId)
      .where(sql`${table.providerIntentId} IS NOT NULL AND ${table.archivedAt} IS NULL`),
    index('payment_intents_tenant_idx').on(table.tenantId),
    index('payment_intents_institution_status_idx').on(
      table.institutionId,
      table.status,
      table.provider,
    ),
    index('payment_intents_student_idx').on(table.studentId, table.createdAt),
    index('payment_intents_payment_idx').on(table.paymentId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Callbacks
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Every callback ever received, valid or not.
 *
 * A callback is an unauthenticated request from the internet claiming money has moved, so the
 * record is written *before* the claim is acted on and regardless of whether the signature
 * held — an attack that never verifies is exactly the traffic worth being able to read later.
 *
 * `tenant_id` is nullable, uniquely in this module: a callback naming no known intent belongs
 * to no tenant, and inventing one would be a lie. Such rows are written under the platform
 * context and are visible to no tenant.
 *
 * `dedupe_key` is globally UNIQUE. Providers retry; the constraint — not an application-level
 * check — is what makes the second delivery a no-op that returns the original result. A
 * double credit is worse than a missed one.
 */
export const paymentCallbacks = pgTable(
  'payment_callbacks',
  {
    id: primaryKeyColumn(),
    /** Null when the callback referenced no known intent. */
    tenantId: uuid('tenant_id').references(() => organizations.id, { onDelete: 'restrict' }),
    intentId: uuid('intent_id').references(() => paymentIntents.id, { onDelete: 'set null' }),
    provider: paymentGatewayProviderEnum('provider').notNull(),

    rawPayload: jsonb('raw_payload').$type<Record<string, unknown>>().notNull(),
    signature: varchar('signature', { length: 512 }),
    signatureValid: boolean('signature_valid').notNull(),

    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
    /**
     * Short machine code for what processing did: `payment_posted`, `intent_failed`,
     * `ignored_expired`, `ignored_state`, `signature_invalid`, `malformed_payload`,
     * `unknown_intent`, `processing_error`. Never carries tenant data — it is echoed to the
     * unauthenticated caller.
     */
    processingResult: varchar('processing_result', { length: 200 }),

    /** Provider + event id (or payload hash). The idempotency boundary. */
    dedupeKey: varchar('dedupe_key', { length: 200 }).notNull(),

    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('payment_callbacks_dedupe_key').on(table.dedupeKey),
    index('payment_callbacks_tenant_idx').on(table.tenantId),
    index('payment_callbacks_intent_idx').on(table.intentId),
    index('payment_callbacks_received_idx').on(table.provider, table.receivedAt),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Reconciliation
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * One run of "compare the provider's settlement file against our intents".
 *
 * Totals are `numeric(14, 2)` maintained through `Money`. `status` is
 * `'matched' | 'mismatched'` — a varchar with a documented union rather than an enum, since a
 * school's operations team is the likeliest source of a new run outcome (e.g. partial files).
 * The run never corrects money: it produces this report and a human acts on it.
 */
export const paymentReconciliations = pgTable(
  'payment_reconciliations',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    provider: paymentGatewayProviderEnum('provider').notNull(),

    settlementDate: date('settlement_date').notNull(),
    /** Storage key or filename of the settlement file, for later inspection. */
    fileKey: varchar('file_key', { length: 300 }),

    totalReported: numeric('total_reported', { precision: 14, scale: 2 }).notNull().default('0.00'),
    totalMatched: numeric('total_matched', { precision: 14, scale: 2 }).notNull().default('0.00'),
    unmatchedCount: integer('unmatched_count').notNull().default(0),

    /** `'matched' | 'mismatched'` — derived from `unmatched_count`, never client-supplied. */
    status: varchar('status', { length: 16 }).notNull(),

    runBy: uuid('run_by'),
    runAt: timestamp('run_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),

    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('payment_reconciliations_tenant_idx').on(table.tenantId),
    index('payment_reconciliations_institution_idx').on(
      table.institutionId,
      table.provider,
      table.settlementDate,
    ),
  ],
);

/**
 * One compared row of a reconciliation.
 *
 * `amount_reported` is what the file said; `amount_local` is what the intent said. Both are
 * kept so an `amount_mismatch` row explains itself without re-opening the file. Pure child
 * rows of their run (cascade on the FK, no version column), like `invoice_lines`.
 */
export const reconciliationItems = pgTable(
  'reconciliation_items',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    reconciliationId: uuid('reconciliation_id')
      .notNull()
      .references(() => paymentReconciliations.id, { onDelete: 'cascade' }),

    providerReference: varchar('provider_reference', { length: 128 }).notNull(),
    /** What the settlement file reported. Null for `missing_remotely`. */
    amountReported: numeric('amount_reported', { precision: 14, scale: 2 }),
    /** What the local intent says. Null for `missing_locally` with no local intent at all. */
    amountLocal: numeric('amount_local', { precision: 14, scale: 2 }),

    /** Null when no local intent carries the reference. */
    intentId: uuid('intent_id').references(() => paymentIntents.id, { onDelete: 'set null' }),
    status: reconciliationItemStatusEnum('status').notNull(),
    note: varchar('note', { length: 500 }),

    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('reconciliation_items_tenant_idx').on(table.tenantId),
    index('reconciliation_items_run_idx').on(table.reconciliationId, table.status),
    index('reconciliation_items_intent_idx').on(table.intentId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────

export const paymentIntentsRelations = relations(paymentIntents, ({ one, many }) => ({
  student: one(students, { fields: [paymentIntents.studentId], references: [students.id] }),
  payment: one(payments, { fields: [paymentIntents.paymentId], references: [payments.id] }),
  callbacks: many(paymentCallbacks),
}));

export const paymentCallbacksRelations = relations(paymentCallbacks, ({ one }) => ({
  intent: one(paymentIntents, {
    fields: [paymentCallbacks.intentId],
    references: [paymentIntents.id],
  }),
}));

export const paymentReconciliationsRelations = relations(paymentReconciliations, ({ many }) => ({
  items: many(reconciliationItems),
}));

export const reconciliationItemsRelations = relations(reconciliationItems, ({ one }) => ({
  reconciliation: one(paymentReconciliations, {
    fields: [reconciliationItems.reconciliationId],
    references: [paymentReconciliations.id],
  }),
  intent: one(paymentIntents, {
    fields: [reconciliationItems.intentId],
    references: [paymentIntents.id],
  }),
}));
