/**
 * Payment gateway service (Phase 12).
 *
 * The layer between the internet and the Phase 11 fee ledger. The rules this file exists to
 * keep, in the order they matter:
 *
 *  1. **A callback is an unauthenticated request from the internet claiming money has moved.**
 *     Its signature is verified before anything else happens, the attempt is recorded whether
 *     or not the signature held, and no figure it carries is ever trusted over the intent —
 *     the amount that posts is the intent's amount, always.
 *  2. **Duplicate callbacks are a no-op returning the original result**, enforced by the
 *     `payment_callbacks.dedupe_key` UNIQUE constraint rather than by an application check
 *     alone. A double credit is worse than a missed one. A callback whose processing crashed
 *     (recorded but `processed_at` null) is the one case a retry re-processes — that is a
 *     provider retry doing its job, not a duplicate.
 *  3. **The ledger posting happens in the SAME transaction as marking the intent succeeded.**
 *     The fee-side `payments` row, its allocations, the invoice recomputation, the intent's
 *     status flip and the audit record commit together or not at all; the database's
 *     `payment_intents_success_has_payment` check restates it.
 *  4. **An abandoned payment is not a failed one.** `expired` and `failed` are distinct
 *     statuses and nothing here conflates them.
 *  5. **Reconciliation reports; humans act.** A run compares a settlement file against local
 *     intents and names every mismatch class. Its only write to an intent is
 *     `succeeded` → `reconciled` on an exact match — bookkeeping confirmation, never a
 *     correction of money.
 *  6. **Refunds take two people.** `finance.refund` requests, `finance.refund.approve`
 *     decides, and a self-approval is refused even for someone holding both. The gateway's
 *     refund API is called only from the human approval path — never autonomously.
 *
 * All the fee-module money rules apply verbatim: no floating point, `Money` is the only
 * arithmetic, derived totals are recomputed from facts, nothing is deleted.
 */

import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  ilike,
  inArray,
  isNull,
  lt,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import {
  invoices,
  paymentAllocations,
  paymentCallbacks,
  paymentIntents,
  paymentReconciliations,
  payments,
  reconciliationItems,
  studentGuardians,
  students,
} from '@shikkha/db';
import {
  buildOffsetPage,
  calendarDate,
  ConflictError,
  endOfDhakaDay,
  ForbiddenError,
  Money,
  NotFoundError,
  offsetOf,
  parseSort,
  startOfDhakaDay,
  todayInDhaka,
  uuidv7,
  ValidationError,
  type OffsetPage,
  type OffsetPageRequest,
} from '@shikkha/shared';
import {
  can,
  resolveDataScope,
  type DataScope,
  type Principal,
  type ScopedResourcePermissions,
} from '@shikkha/permissions';
import {
  gatewayCallbackSchema,
  PAYMENT_INTENT_SORT_FIELDS,
  PAYMENT_RECONCILIATION_SORT_FIELDS,
  type CreatePaymentIntentInput,
  type DecideGatewayRefundInput,
  type GatewayCallbackInput,
  type PaymentGatewayProvider,
  type RunReconciliationInput,
} from '@shikkha/validation';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { currentContext } from '../../common/context/request-context';
// A pure, exported helper of the fees module — the single definition of how an invoice's
// status derives from its figures. Importing it keeps one arithmetic, not two.
import { deriveInvoiceStatus } from '../fees/fees.service';
import { PaymentProviderRegistry } from './providers/provider-registry';
import type { PaymentProvider } from './providers/payment-provider.interface';

/** The transaction handle `runInTenant` hands to its callback. */
type Tx = Parameters<Parameters<DatabaseService['runInTenant']>[0]>[0];

type PaymentIntentRow = typeof paymentIntents.$inferSelect;
type PaymentCallbackRow = typeof paymentCallbacks.$inferSelect;
type ReconciliationRow = typeof paymentReconciliations.$inferSelect;
type ReconciliationItemRow = typeof reconciliationItems.$inferSelect;
type PaymentRow = typeof payments.$inferSelect;
type InvoiceRow = typeof invoices.$inferSelect;

/**
 * Row scoping mirrors the fee module exactly: the permission decides *which* filter, never
 * *whether* to filter. A guardian holding `finance.own.view` sees the intents of the children
 * they have a live, portal-enabled link to, and nothing else.
 */
const GATEWAY_SCOPE: ScopedResourcePermissions = {
  all: 'finance.invoices.view',
  own: 'finance.own.view',
};

/** Intent statuses a callback or poll may still move. Everything else is settled history. */
const OPEN_INTENT_STATUSES = ['created', 'redirected', 'pending'] as const;

/** How an intent's provider maps onto the fee ledger's `payment_method` enum. */
const PROVIDER_TO_METHOD: Record<PaymentGatewayProvider, PaymentRow['method']> = {
  mock: 'online',
  bkash: 'bkash',
  nagad: 'nagad',
  rocket: 'rocket',
  sslcommerz: 'online',
  bank_transfer: 'bank_transfer',
  cash: 'cash',
};

export interface ListPaymentIntentsQuery {
  page: number;
  pageSize: number;
  sort?: string;
  q?: string;
  studentId?: string;
  provider?: string;
  status?: string;
  refundStatus?: string;
  createdFrom?: string;
  createdTo?: string;
  includeArchived: boolean;
}

export interface ListReconciliationsQuery {
  page: number;
  pageSize: number;
  sort?: string;
  provider?: string;
  status?: string;
  settlementFrom?: string;
  settlementTo?: string;
  includeArchived: boolean;
}

export interface CallbackOutcome {
  received: true;
  /** Echoed to the unauthenticated caller; short machine codes only, never tenant data. */
  result: string | null;
  duplicate: boolean;
}

@Injectable()
export class PaymentGatewayService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly registry: PaymentProviderRegistry,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════════════
  // Intents
  // ══════════════════════════════════════════════════════════════════════════════════

  async createIntent(
    principal: Principal,
    institutionId: string,
    input: CreatePaymentIntentInput,
  ): Promise<PaymentIntentRow & { redirectUrl: string | null; reused: boolean }> {
    const context = currentContext();
    const amount = Money.fromDecimalString(input.amount);
    if (!amount.isPositive()) {
      throw new ValidationError('A payment intent must be for a positive amount', [
        { path: 'amount', message: 'Enter an amount greater than zero' },
      ]);
    }

    const adapter = this.registry.find(input.provider);
    if (!adapter) {
      // A real refusal, not a stub: offline channels are settled at the counter through the
      // fees module, and redirecting a browser to them is not a thing.
      throw new ValidationError('This provider cannot take an online payment', [
        {
          path: 'provider',
          message: `No online gateway adapter is registered for "${input.provider}". Record this payment at the counter instead.`,
        },
      ]);
    }

    return this.db.runInTenant(async (tx) => {
      // Idempotent create: the same key on the same institution returns the original intent.
      // The partial unique index is the hard guarantee against the race this pre-check loses.
      const [existing] = await tx
        .select()
        .from(paymentIntents)
        .where(
          and(
            eq(paymentIntents.institutionId, institutionId),
            eq(paymentIntents.idempotencyKey, input.idempotencyKey),
            isNull(paymentIntents.archivedAt),
          ),
        )
        .limit(1);
      if (existing) {
        // Gateways issue one-time redirect URLs, so a replay gets the intent without one;
        // the client polls or cancels from here.
        return { ...existing, redirectUrl: null, reused: true };
      }

      await this.assertStudentPayableBy(tx, principal, institutionId, input.studentId);

      const targets = await tx
        .select()
        .from(invoices)
        .where(
          and(
            inArray(invoices.id, input.invoiceIds),
            eq(invoices.institutionId, institutionId),
            eq(invoices.studentId, input.studentId),
            isNull(invoices.archivedAt),
          ),
        )
        .orderBy(asc(invoices.dueDate), asc(invoices.invoiceNumber));

      if (targets.length !== input.invoiceIds.length) {
        // 404-shaped: which of another family's invoice ids exist is not this caller's to learn.
        throw new NotFoundError('Invoice');
      }
      const payable = targets.filter(
        (invoice) =>
          invoice.status !== 'void' && Money.fromDecimalString(invoice.balance).isPositive(),
      );
      if (payable.length !== targets.length) {
        throw new ValidationError('Every selected invoice must still owe money', [
          { path: 'invoiceIds', message: 'Remove void and fully-paid invoices from the selection' },
        ]);
      }
      const outstanding = Money.sum(
        payable.map((invoice) => Money.fromDecimalString(invoice.balance)),
      );
      if (amount.greaterThan(outstanding)) {
        throw new ValidationError('The amount exceeds what the selected invoices owe', [
          {
            path: 'amount',
            message: `The selected invoices owe ${outstanding.toDecimalString()} in total`,
          },
        ]);
      }

      const intentId = uuidv7();
      const expiresAt = new Date(Date.now() + input.expiresInMinutes * 60_000);
      const registration = await adapter.createIntent({
        intentId,
        amount: amount.toDecimalString(),
        currency: 'BDT',
        returnUrl: input.returnUrl ?? null,
        expiresAt,
        metadata: input.metadata ?? {},
      });

      const [intent] = await tx
        .insert(paymentIntents)
        .values({
          id: intentId,
          tenantId: principal.tenantId!,
          institutionId,
          studentId: input.studentId,
          invoiceIds: payable.map((invoice) => invoice.id),
          amount: amount.toDecimalString(),
          currency: 'BDT',
          provider: input.provider,
          providerIntentId: registration.providerIntentId,
          status: registration.redirectUrl ? 'redirected' : 'created',
          idempotencyKey: input.idempotencyKey,
          returnUrl: input.returnUrl ?? null,
          expiresAt,
          metadata: input.metadata ?? {},
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'create',
        module: 'payment_gateway',
        resourceType: 'payment_intent',
        resourceId: intentId,
        resourceLabel: registration.providerIntentId,
        newValue: {
          studentId: input.studentId,
          provider: input.provider,
          amount: amount.toDecimalString(),
          invoiceIds: payable.map((invoice) => invoice.id),
          expiresAt: expiresAt.toISOString(),
        },
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      return { ...intent!, redirectUrl: registration.redirectUrl, reused: false };
    });
  }

  async listIntents(
    principal: Principal,
    institutionId: string,
    query: ListPaymentIntentsQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<PaymentIntentRow>> {
    const scope = this.requireScope(principal);

    return this.db.runInTenant(async (tx) => {
      const where = and(...this.intentFilters(principal, scope, institutionId, query));

      const orderBy = parseSort(query.sort, PAYMENT_INTENT_SORT_FIELDS, {
        field: 'createdAt',
        direction: 'desc',
      }).map((spec) => {
        const column = INTENT_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(paymentIntents)
        .where(where)
        .orderBy(...orderBy, asc(paymentIntents.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(paymentIntents)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async getIntent(
    principal: Principal,
    institutionId: string,
    id: string,
  ): Promise<PaymentIntentRow> {
    const scope = this.requireScope(principal);
    return this.db.runInTenant(async (tx) =>
      this.loadVisibleIntent(tx, principal, scope, institutionId, id),
    );
  }

  /**
   * Poll the gateway and fold what it reports into local state.
   *
   * The recovery path for lost callbacks (docs/09: "callbacks do get lost"). A success
   * reported over the trusted server-to-server status API posts the payment through exactly
   * the same code path a signed callback uses — same transaction shape, same amount rule.
   */
  async syncIntent(
    principal: Principal,
    institutionId: string,
    id: string,
  ): Promise<{ intent: PaymentIntentRow; providerStatus: string | null }> {
    const scope = this.requireScope(principal);
    const context = currentContext();

    // Read outside the mutation so a settled intent costs one query and no external call.
    const current = await this.db.runInTenant(async (tx) =>
      this.loadVisibleIntent(tx, principal, scope, institutionId, id),
    );

    if (!isOpen(current.status)) {
      return { intent: current, providerStatus: null };
    }

    // Expiry is a fact of the clock, not of the gateway: settle it before asking anyone.
    if (current.expiresAt.getTime() <= Date.now()) {
      const intent = await this.db.runInTenant(async (tx) =>
        this.markExpired(tx, current, principal.userId),
      );
      return { intent, providerStatus: null };
    }

    const adapter = this.registry.find(current.provider);
    if (!adapter || !current.providerIntentId) {
      throw new ValidationError('This provider has no status API to poll', [
        {
          path: 'id',
          message: `No online gateway adapter is registered for "${current.provider}"`,
        },
      ]);
    }

    const reported = await adapter.fetchStatus(current.providerIntentId);

    if (reported.status === 'succeeded') {
      const intent = await this.db.runInTenant(async (tx) => {
        const fresh = await this.lockOpenIntent(tx, current.id);
        if (!fresh) {
          // Someone else settled it between our read and our lock. Their result stands.
          const [row] = await tx
            .select()
            .from(paymentIntents)
            .where(eq(paymentIntents.id, current.id))
            .limit(1);
          if (!row) throw new NotFoundError('Payment intent', current.id);
          return row;
        }
        if (fresh.expiresAt.getTime() <= Date.now()) {
          return this.markExpired(tx, fresh, principal.userId);
        }
        return this.settleSucceededIntent(tx, fresh, {
          actorUserId: principal.userId,
          actorRoles: principal.roles.map((role) => role.roleKey),
          providerReference: reported.providerReference,
          via: 'status_poll',
          requestId: context?.requestId ?? null,
        });
      });
      return { intent, providerStatus: reported.status };
    }

    if (reported.status === 'failed') {
      const intent = await this.db.runInTenant(async (tx) => {
        const fresh = await this.lockOpenIntent(tx, current.id);
        if (!fresh) {
          const [row] = await tx
            .select()
            .from(paymentIntents)
            .where(eq(paymentIntents.id, current.id))
            .limit(1);
          if (!row) throw new NotFoundError('Payment intent', current.id);
          return row;
        }
        return this.markFailed(
          tx,
          fresh,
          reported.failureCode ?? null,
          reported.failureMessage ?? null,
          principal.userId,
        );
      });
      return { intent, providerStatus: reported.status };
    }

    // The gateway knows the transaction and it is still in flight.
    if (current.status === 'created' || current.status === 'redirected') {
      const intent = await this.db.runInTenant(async (tx) => {
        const [updated] = await tx
          .update(paymentIntents)
          .set({
            status: 'pending',
            updatedBy: principal.userId,
            version: current.version + 1,
          })
          .where(
            and(
              eq(paymentIntents.id, current.id),
              eq(paymentIntents.version, current.version),
              inArray(paymentIntents.status, ['created', 'redirected']),
            ),
          )
          .returning();
        return updated ?? current;
      });
      return { intent, providerStatus: reported.status };
    }

    return { intent: current, providerStatus: reported.status };
  }

  async cancelIntent(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
    version: number,
  ): Promise<PaymentIntentRow> {
    const scope = this.requireScope(principal);

    return this.db.runInTenant(async (tx) => {
      const intent = await this.loadVisibleIntent(tx, principal, scope, institutionId, id);
      if (!isOpen(intent.status)) {
        throw new ConflictError(
          `Only an open intent can be cancelled; this one is ${intent.status}.`,
          { currentStatus: intent.status },
        );
      }

      const [cancelled] = await tx
        .update(paymentIntents)
        .set({
          status: 'cancelled',
          cancelledReason: reason,
          updatedBy: principal.userId,
          version: intent.version + 1,
        })
        .where(
          and(
            eq(paymentIntents.id, id),
            eq(paymentIntents.version, version),
            inArray(paymentIntents.status, [...OPEN_INTENT_STATUSES]),
          ),
        )
        .returning();

      if (!cancelled) {
        throw new ConflictError(
          'This intent changed while you were cancelling it — a callback may have settled it. Reload and check.',
          { expectedVersion: version, currentVersion: intent.version },
        );
      }
      return cancelled;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Callbacks — the unauthenticated edge
  // ══════════════════════════════════════════════════════════════════════════════════

  /**
   * Handle one gateway callback.
   *
   * Order is the security model: (1) verify the signature over the raw body, (2) record the
   * attempt — valid or not — behind the dedupe UNIQUE constraint, (3) only then act, inside
   * the intent's tenant transaction. Responses carry machine codes only; this endpoint talks
   * to the internet and confirms nothing about any tenant.
   */
  async handleCallback(
    provider: PaymentGatewayProvider,
    rawBody: string,
    body: unknown,
    signature: string | null,
  ): Promise<CallbackOutcome> {
    const adapter = this.registry.find(provider);
    // Fail closed: no adapter means no verification scheme, means nothing is authentic.
    const signatureValid = adapter ? adapter.verifyCallbackSignature(rawBody, signature) : false;

    const rawPayload = isRecord(body) ? body : { raw: rawBody };
    const parsed = signatureValid ? gatewayCallbackSchema.safeParse(body) : null;
    const payload: GatewayCallbackInput | null = parsed?.success ? parsed.data : null;

    // The dedupe key. For a VALID callback it is the provider's event identity, so a provider
    // retry lands on the same key. For an invalid one it is salted with the signature, so a
    // forger cannot squat on the key a genuine future event will need.
    const bodyHash = sha256(rawBody);
    const dedupeKey = signatureValid
      ? `${provider}:${payload?.eventId ?? bodyHash}`.slice(0, 200)
      : `invalid:${provider}:${sha256(`${rawBody}:${signature ?? ''}`)}`.slice(0, 200);

    // Look the intent up before recording, so the record can carry its tenant. Platform read,
    // justified: a callback has no session and no tenant of its own — the intent is the only
    // thing that can tell us whose money this claims to be.
    const intent =
      signatureValid && payload
        ? await this.findIntentByProviderRef(provider, payload.providerIntentId)
        : null;

    const preResult = !signatureValid
      ? 'signature_invalid'
      : !payload
        ? 'malformed_payload'
        : !intent
          ? 'unknown_intent'
          : null;

    const { row, duplicate } = await this.recordCallback({
      tenantId: intent?.tenantId ?? null,
      intentId: intent?.id ?? null,
      provider,
      rawPayload,
      signature,
      signatureValid,
      dedupeKey,
      // Attempts that will never be processed are closed out immediately; a processable one
      // is closed inside the settlement transaction below.
      processedResult: preResult,
    });

    if (duplicate && row.processedAt) {
      // The constraint did its job: same event, already handled. Return the original result.
      return { received: true, result: row.processingResult, duplicate: true };
    }

    if (!signatureValid) {
      throw new ValidationError('The callback could not be verified', [
        { path: 'signature', message: 'The signature does not match the payload' },
      ]);
    }
    if (!payload) {
      throw new ValidationError('The callback payload is not in a recognised shape', [
        { path: '(root)', message: 'Expected providerIntentId and status' },
      ]);
    }
    if (!intent) {
      return { received: true, result: 'unknown_intent', duplicate };
    }

    let result: string;
    try {
      result = await this.db.runInTenantId(intent.tenantId!, async (tx) => {
        const fresh = await this.lockOpenIntent(tx, intent.id);

        if (!fresh) {
          // Already settled, cancelled or expired: acting again would be the double credit
          // this module exists to prevent.
          await this.closeCallback(tx, row.id, 'ignored_state');
          return 'ignored_state';
        }

        if (fresh.expiresAt.getTime() <= Date.now()) {
          await this.markExpired(tx, fresh, null);
          await this.closeCallback(tx, row.id, 'ignored_expired');
          return 'ignored_expired';
        }

        if (payload.status === 'failed') {
          await this.markFailed(
            tx,
            fresh,
            truncate(payload.failureCode, 64),
            truncate(payload.failureMessage, 500),
            null,
          );
          await this.closeCallback(tx, row.id, 'intent_failed');
          return 'intent_failed';
        }

        // Success. The amount posted is the INTENT's amount; whatever the callback body
        // claims was already recorded verbatim in raw_payload and is used for nothing.
        await this.settleSucceededIntent(tx, fresh, {
          actorUserId: null,
          actorRoles: [],
          providerReference: truncate(payload.reference, 128),
          via: 'callback',
          requestId: null,
        });
        await this.closeCallback(tx, row.id, 'payment_posted');
        return 'payment_posted';
      });
    } catch (error) {
      // The settlement transaction rolled back — payment, allocations, intent flip and audit
      // together. Leave the callback recorded but UNPROCESSED, so the provider's retry (same
      // dedupe key) re-processes instead of no-opping against a failure.
      await this.markCallbackErrored(row.id);
      throw error;
    }

    return { received: true, result, duplicate };
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Reconciliation
  // ══════════════════════════════════════════════════════════════════════════════════

  /**
   * Compare one settlement file against local intents and write the report.
   *
   * Every mismatch class is named; nothing is auto-corrected. The single status change is
   * `succeeded` → `reconciled` on an exact match. Rows that need a human are exactly the rows
   * this produces:
   *
   *  - `missing_locally`   — the gateway settled money we never posted (a lost callback, or a
   *                          reference we have never seen).
   *  - `missing_remotely`  — we posted money the gateway does not acknowledge settling.
   *  - `amount_mismatch`   — both sides know the transaction and disagree on the figure.
   */
  async runReconciliation(
    principal: Principal,
    institutionId: string,
    input: RunReconciliationInput,
  ): Promise<{ reconciliation: ReconciliationRow; items: ReconciliationItemRow[] }> {
    const context = currentContext();
    const provider = input.provider as PaymentGatewayProvider;
    const adapter = this.registry.find(provider);
    if (!adapter) {
      throw new ValidationError('No settlement-file parser is registered for this provider', [
        { path: 'provider', message: `"${input.provider}" has no gateway adapter` },
      ]);
    }

    const records = adapter.parseSettlementFile(input.fileContent);
    const seen = new Set<string>();
    for (const record of records) {
      if (seen.has(record.providerReference)) {
        throw new ValidationError('The settlement file repeats a reference', [
          {
            path: 'fileContent',
            message: `"${record.providerReference}" appears more than once`,
          },
        ]);
      }
      seen.add(record.providerReference);
    }

    return this.db.runInTenant(async (tx) => {
      const local = await tx
        .select()
        .from(paymentIntents)
        .where(
          and(
            eq(paymentIntents.institutionId, institutionId),
            eq(paymentIntents.provider, provider),
            isNull(paymentIntents.archivedAt),
            sql`${paymentIntents.providerIntentId} is not null`,
          ),
        );
      const byReference = new Map(local.map((intent) => [intent.providerIntentId!, intent]));

      const reconciliationId = uuidv7();
      interface PreparedItem {
        providerReference: string;
        amountReported: string | null;
        amountLocal: string | null;
        intentId: string | null;
        status: ReconciliationItemRow['status'];
        note: string | null;
      }
      const prepared: PreparedItem[] = [];
      let matchedTotal = Money.zero();

      for (const record of records) {
        const intent = byReference.get(record.providerReference);
        const reported = Money.fromDecimalString(record.amount);

        if (!intent) {
          prepared.push({
            providerReference: record.providerReference,
            amountReported: reported.toDecimalString(),
            amountLocal: null,
            intentId: null,
            status: 'missing_locally',
            note: 'No local intent carries this reference',
          });
          continue;
        }

        const localAmount = Money.fromDecimalString(intent.amount);
        if (!localAmount.equals(reported)) {
          prepared.push({
            providerReference: record.providerReference,
            amountReported: reported.toDecimalString(),
            amountLocal: localAmount.toDecimalString(),
            intentId: intent.id,
            status: 'amount_mismatch',
            note: `File says ${reported.toDecimalString()}, intent says ${localAmount.toDecimalString()}`,
          });
          continue;
        }

        if (intent.status !== 'succeeded' && intent.status !== 'reconciled') {
          // The gateway settled money the ledger never received — the lost-callback case the
          // spec names. The *payment* is missing locally even though the intent row exists.
          prepared.push({
            providerReference: record.providerReference,
            amountReported: reported.toDecimalString(),
            amountLocal: localAmount.toDecimalString(),
            intentId: intent.id,
            status: 'missing_locally',
            note: `Settled remotely but no local payment was posted (intent is ${intent.status}). Poll the intent to recover.`,
          });
          continue;
        }

        prepared.push({
          providerReference: record.providerReference,
          amountReported: reported.toDecimalString(),
          amountLocal: localAmount.toDecimalString(),
          intentId: intent.id,
          status: 'matched',
          note: null,
        });
        matchedTotal = matchedTotal.plus(reported);

        if (intent.status === 'succeeded') {
          // The one write reconciliation makes: confirmation, not correction.
          await tx
            .update(paymentIntents)
            .set({
              status: 'reconciled',
              updatedBy: principal.userId,
              version: intent.version + 1,
            })
            .where(and(eq(paymentIntents.id, intent.id), eq(paymentIntents.status, 'succeeded')));
        }
      }

      // Successes the file does not acknowledge. Intents reconciled by an earlier run are
      // assumed settled in an earlier file and are not re-reported.
      for (const intent of local) {
        if (intent.status !== 'succeeded') continue;
        if (seen.has(intent.providerIntentId!)) continue;
        prepared.push({
          providerReference: intent.providerIntentId!,
          amountReported: null,
          amountLocal: Money.fromDecimalString(intent.amount).toDecimalString(),
          intentId: intent.id,
          status: 'missing_remotely',
          note: 'Posted locally but absent from this settlement file',
        });
      }

      const totalReported = Money.sum(
        records.map((record) => Money.fromDecimalString(record.amount)),
      );
      const unmatchedCount = prepared.filter((item) => item.status !== 'matched').length;
      const status = unmatchedCount === 0 ? 'matched' : 'mismatched';

      const [reconciliation] = await tx
        .insert(paymentReconciliations)
        .values({
          id: reconciliationId,
          tenantId: principal.tenantId!,
          institutionId,
          provider,
          settlementDate: input.settlementDate,
          fileKey: input.fileKey ?? null,
          totalReported: totalReported.toDecimalString(),
          totalMatched: matchedTotal.toDecimalString(),
          unmatchedCount,
          status,
          runBy: principal.userId,
          runAt: new Date(),
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      const items: ReconciliationItemRow[] = [];
      for (const item of prepared) {
        const [written] = await tx
          .insert(reconciliationItems)
          .values({
            id: uuidv7(),
            tenantId: principal.tenantId!,
            institutionId,
            reconciliationId,
            providerReference: item.providerReference,
            amountReported: item.amountReported,
            amountLocal: item.amountLocal,
            intentId: item.intentId,
            status: item.status,
            note: item.note,
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning();
        items.push(written!);
      }

      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'import',
        module: 'payment_gateway',
        resourceType: 'payment_reconciliation',
        resourceId: reconciliationId,
        resourceLabel: `${provider} ${input.settlementDate}`,
        newValue: {
          provider,
          settlementDate: input.settlementDate,
          totalReported: totalReported.toDecimalString(),
          totalMatched: matchedTotal.toDecimalString(),
          unmatchedCount,
          status,
        },
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      return { reconciliation: reconciliation!, items };
    });
  }

  async listReconciliations(
    principal: Principal,
    institutionId: string,
    query: ListReconciliationsQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<ReconciliationRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(paymentReconciliations.institutionId, institutionId)];
      if (!query.includeArchived) filters.push(isNull(paymentReconciliations.archivedAt));
      if (query.provider) {
        filters.push(eq(paymentReconciliations.provider, query.provider as PaymentGatewayProvider));
      }
      if (query.status) filters.push(eq(paymentReconciliations.status, query.status));
      if (query.settlementFrom) {
        filters.push(gte(paymentReconciliations.settlementDate, query.settlementFrom));
      }
      if (query.settlementTo) {
        filters.push(lt(paymentReconciliations.settlementDate, query.settlementTo));
      }

      const where = and(...filters);
      const orderBy = parseSort(query.sort, PAYMENT_RECONCILIATION_SORT_FIELDS, {
        field: 'runAt',
        direction: 'desc',
      }).map((spec) => {
        const column = RECONCILIATION_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(paymentReconciliations)
        .where(where)
        .orderBy(...orderBy, asc(paymentReconciliations.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(paymentReconciliations)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async getReconciliation(
    principal: Principal,
    institutionId: string,
    id: string,
  ): Promise<{ reconciliation: ReconciliationRow; items: ReconciliationItemRow[] }> {
    return this.db.runInTenant(async (tx) => {
      const [reconciliation] = await tx
        .select()
        .from(paymentReconciliations)
        .where(
          and(
            eq(paymentReconciliations.id, id),
            eq(paymentReconciliations.institutionId, institutionId),
          ),
        )
        .limit(1);
      if (!reconciliation) throw new NotFoundError('Reconciliation', id);

      const items = await tx
        .select()
        .from(reconciliationItems)
        .where(eq(reconciliationItems.reconciliationId, id))
        .orderBy(asc(reconciliationItems.status), asc(reconciliationItems.providerReference));

      return { reconciliation, items };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Refunds — two people, never automatic
  // ══════════════════════════════════════════════════════════════════════════════════

  async requestRefund(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
    version: number,
  ): Promise<PaymentIntentRow> {
    const context = currentContext();

    return this.db.runInTenant(async (tx) => {
      const intent = await this.loadIntentForStaff(tx, institutionId, id);

      if (intent.status !== 'succeeded' && intent.status !== 'reconciled') {
        throw new ConflictError(
          `Only money that actually arrived can be refunded; this intent is ${intent.status}.`,
          { currentStatus: intent.status },
        );
      }
      if (intent.refundStatus !== 'none') {
        throw new ConflictError(`A refund for this intent is already ${intent.refundStatus}.`, {
          refundStatus: intent.refundStatus,
        });
      }

      const [updated] = await tx
        .update(paymentIntents)
        .set({
          refundStatus: 'requested',
          refundReason: reason,
          refundRequestedBy: principal.userId,
          refundRequestedAt: new Date(),
          updatedBy: principal.userId,
          version: intent.version + 1,
        })
        .where(and(eq(paymentIntents.id, id), eq(paymentIntents.version, version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This intent was changed by someone else while you were working. Reload and try again.',
          { expectedVersion: version, currentVersion: intent.version },
        );
      }

      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'refund',
        module: 'payment_gateway',
        resourceType: 'payment_intent',
        resourceId: id,
        resourceLabel: intent.providerIntentId,
        previousValue: { refundStatus: 'none' },
        newValue: { refundStatus: 'requested', amount: intent.amount },
        reason,
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      return updated;
    });
  }

  /**
   * Approve or reject a requested refund.
   *
   * A different permission from requesting (`finance.refund.approve` versus `finance.refund`),
   * and the requester is refused outright even when one person holds both — the same
   * separation the concession flow enforces. Approval executes the gateway refund and, in ONE
   * transaction, reverses the fee-side payment, archives its allocations, recomputes every
   * invoice it touched and closes the refund on the intent.
   */
  async decideRefund(
    principal: Principal,
    institutionId: string,
    id: string,
    input: DecideGatewayRefundInput,
  ): Promise<{ intent: PaymentIntentRow; payment: PaymentRow | null }> {
    const context = currentContext();

    // Read + human checks first; the gateway call happens outside the transaction so a
    // gateway outage leaves the database untouched.
    const intent = await this.db.runInTenant(async (tx) =>
      this.loadIntentForStaff(tx, institutionId, id),
    );

    if (intent.refundStatus !== 'requested') {
      throw new ConflictError(`This refund is ${intent.refundStatus}, not awaiting a decision.`, {
        refundStatus: intent.refundStatus,
      });
    }
    if (intent.refundRequestedBy === principal.userId) {
      throw new ConflictError(
        'You requested this refund, so someone else must decide it. Separation of duties is not optional for money.',
      );
    }

    if (input.decision === 'rejected') {
      return this.db.runInTenant(async (tx) => {
        const [updated] = await tx
          .update(paymentIntents)
          .set({
            refundStatus: 'rejected',
            refundDecidedBy: principal.userId,
            refundDecidedAt: new Date(),
            refundDecisionNote: input.reason,
            updatedBy: principal.userId,
            version: intent.version + 1,
          })
          .where(
            and(
              eq(paymentIntents.id, id),
              eq(paymentIntents.version, input.version),
              eq(paymentIntents.refundStatus, 'requested'),
            ),
          )
          .returning();
        if (!updated) {
          throw new ConflictError(
            'This refund was decided by someone else first. Reload and check.',
            { expectedVersion: input.version, currentVersion: intent.version },
          );
        }

        await this.audit.recordInTransaction(tx, {
          tenantId: principal.tenantId,
          institutionId,
          actorUserId: principal.userId,
          actorRoles: principal.roles.map((role) => role.roleKey),
          action: 'reject',
          module: 'payment_gateway',
          resourceType: 'payment_intent',
          resourceId: id,
          resourceLabel: intent.providerIntentId,
          previousValue: { refundStatus: 'requested' },
          newValue: { refundStatus: 'rejected' },
          reason: input.reason,
          requestId: context?.requestId ?? null,
          ipAddress: context?.ipAddress ?? null,
          userAgent: context?.userAgent ?? null,
        });

        return { intent: updated, payment: null };
      });
    }

    // Approved. Execute at the gateway first — this is the ONLY code path that ever calls a
    // provider's refund API, and it is reached exclusively through a human decision.
    const adapter = this.requireAdapter(intent.provider);
    const executed = await adapter.refund({
      providerIntentId: intent.providerIntentId ?? intent.id,
      amount: intent.amount,
      currency: intent.currency,
      reason: input.reason,
    });

    return this.db.runInTenant(async (tx) => {
      if (!intent.paymentId) {
        // Unrepresentable per the DB check constraint; asserted because acting on it would
        // mean refunding money the ledger never saw.
        throw new ConflictError('This intent has no posted payment to reverse');
      }
      const [payment] = await tx
        .select()
        .from(payments)
        .where(eq(payments.id, intent.paymentId))
        .limit(1);
      if (!payment) throw new NotFoundError('Payment', intent.paymentId);
      if (payment.status !== 'completed') {
        throw new ConflictError(
          `Only a completed payment can be reversed; this one is ${payment.status}.`,
          { currentStatus: payment.status },
        );
      }

      const reversalReason = `Gateway refund approved: ${input.reason}`;
      const [reversed] = await tx
        .update(payments)
        .set({
          status: 'reversed',
          reversalReason,
          reversedBy: principal.userId,
          reversedAt: new Date(),
          updatedBy: principal.userId,
          version: payment.version + 1,
        })
        .where(and(eq(payments.id, payment.id), eq(payments.version, payment.version)))
        .returning();
      if (!reversed) {
        throw new ConflictError('This payment changed while the refund was being executed.');
      }

      const allocations = await tx
        .select()
        .from(paymentAllocations)
        .where(
          and(eq(paymentAllocations.paymentId, payment.id), isNull(paymentAllocations.archivedAt)),
        );
      for (const allocation of allocations) {
        await tx
          .update(paymentAllocations)
          .set({
            archivedAt: new Date(),
            archivedBy: principal.userId,
            archiveReason: reversalReason,
            updatedBy: principal.userId,
          })
          .where(eq(paymentAllocations.id, allocation.id));
        await this.recomputeInvoice(tx, allocation.invoiceId, principal.userId);
      }

      const [updated] = await tx
        .update(paymentIntents)
        .set({
          refundStatus: 'completed',
          refundDecidedBy: principal.userId,
          refundDecidedAt: new Date(),
          refundDecisionNote: input.reason,
          refundProviderReference: executed.providerRefundId,
          updatedBy: principal.userId,
          version: intent.version + 1,
        })
        .where(
          and(
            eq(paymentIntents.id, id),
            eq(paymentIntents.version, input.version),
            eq(paymentIntents.refundStatus, 'requested'),
          ),
        )
        .returning();
      if (!updated) {
        throw new ConflictError(
          'This refund was decided by someone else first. Reload and check.',
          { expectedVersion: input.version, currentVersion: intent.version },
        );
      }

      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'refund',
        module: 'payment_gateway',
        resourceType: 'payment_intent',
        resourceId: id,
        resourceLabel: payment.receiptNumber,
        previousValue: { refundStatus: 'requested', paymentStatus: 'completed' },
        newValue: {
          refundStatus: 'completed',
          paymentStatus: 'reversed',
          amount: intent.amount,
          providerRefundId: executed.providerRefundId,
          reversedAllocations: allocations.map((one) => ({
            invoiceId: one.invoiceId,
            amount: one.amount,
          })),
        },
        reason: input.reason,
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      return { intent: updated, payment: reversed };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Private: settlement machinery
  // ══════════════════════════════════════════════════════════════════════════════════

  /**
   * Post the fee-side payment for a succeeded intent and flip the intent, in the caller's
   * transaction. The single settlement code path shared by callbacks and status polls.
   *
   * Amount rule: the figure posted is `intent.amount`, parsed once through `Money`. No caller
   * passes an amount in — the signature makes the callback-amount override bug unwritable.
   */
  private async settleSucceededIntent(
    tx: Tx,
    intent: PaymentIntentRow,
    options: {
      actorUserId: string | null;
      actorRoles: string[];
      providerReference: string | null;
      via: 'callback' | 'status_poll';
      requestId: string | null;
    },
  ): Promise<PaymentIntentRow> {
    const amount = Money.fromDecimalString(intent.amount);

    const targets = await tx
      .select()
      .from(invoices)
      .where(
        and(
          inArray(invoices.id, intent.invoiceIds),
          eq(invoices.institutionId, intent.institutionId),
          eq(invoices.studentId, intent.studentId),
          sql`${invoices.status} <> 'void'`,
          isNull(invoices.archivedAt),
        ),
      )
      .orderBy(asc(invoices.dueDate), asc(invoices.invoiceNumber));

    const year4 = String(todayInDhaka()).slice(0, 4);
    const prefix = `RCT-${year4}-`;
    const sequence = (await this.currentReceiptSequence(tx, intent.institutionId, prefix)) + 1;
    const receiptNumber = `${prefix}${String(sequence).padStart(6, '0')}`;

    const paymentId = uuidv7();
    const [payment] = await tx
      .insert(payments)
      .values({
        id: paymentId,
        tenantId: intent.tenantId,
        institutionId: intent.institutionId,
        studentId: intent.studentId,
        receiptNumber,
        amount: amount.toDecimalString(),
        currency: intent.currency,
        method: PROVIDER_TO_METHOD[intent.provider],
        reference: options.providerReference ?? intent.providerIntentId,
        // A gateway settlement has no clerk. Nullable by design for system postings.
        receivedBy: null,
        receivedAt: new Date(),
        status: 'completed',
        notes: `Gateway settlement for intent ${intent.id} via ${intent.provider}`,
        createdBy: options.actorUserId,
        updatedBy: options.actorUserId,
      })
      .returning();

    // Oldest-due-first across the intent's invoices, clamped to each live balance. Any excess
    // stays unallocated on the payment and settles the next invoice generated — the same
    // semantics as a counter payment.
    let remaining = amount;
    const written: Array<{ invoiceId: string; amount: string }> = [];
    for (const invoice of targets) {
      if (!remaining.isPositive()) break;
      const balance = Money.fromDecimalString(invoice.balance);
      if (!balance.isPositive()) continue;
      const take = Money.min(balance, remaining);
      await tx.insert(paymentAllocations).values({
        id: uuidv7(),
        tenantId: intent.tenantId,
        institutionId: intent.institutionId,
        paymentId,
        invoiceId: invoice.id,
        amount: take.toDecimalString(),
        createdBy: options.actorUserId,
        updatedBy: options.actorUserId,
      });
      await this.recomputeInvoice(tx, invoice.id, options.actorUserId);
      written.push({ invoiceId: invoice.id, amount: take.toDecimalString() });
      remaining = remaining.minus(take);
    }

    // Flip the intent — the same transaction, guarded so two concurrent settlements cannot
    // both win. The loser's payment insert rolls back with its transaction.
    const [settled] = await tx
      .update(paymentIntents)
      .set({
        status: 'succeeded',
        paymentId,
        succeededAt: new Date(),
        updatedBy: options.actorUserId,
        version: intent.version + 1,
      })
      .where(
        and(
          eq(paymentIntents.id, intent.id),
          eq(paymentIntents.version, intent.version),
          inArray(paymentIntents.status, [...OPEN_INTENT_STATUSES]),
        ),
      )
      .returning();
    if (!settled) {
      throw new ConflictError('This intent was settled concurrently; keeping the first result.');
    }

    await this.audit.recordInTransaction(tx, {
      tenantId: intent.tenantId,
      institutionId: intent.institutionId,
      actorUserId: options.actorUserId,
      actorRoles: options.actorRoles,
      action: 'payment',
      module: 'payment_gateway',
      resourceType: 'payment_intent',
      resourceId: intent.id,
      resourceLabel: receiptNumber,
      previousValue: { status: intent.status },
      newValue: {
        status: 'succeeded',
        via: options.via,
        provider: intent.provider,
        amount: amount.toDecimalString(),
        paymentId,
        receiptNumber,
        allocations: written,
        unallocated: remaining.toDecimalString(),
      },
      requestId: options.requestId,
    });

    return { ...settled, paymentId: payment!.id };
  }

  /** Lock an intent row and return it only while it is still open. Null means settled. */
  private async lockOpenIntent(tx: Tx, id: string): Promise<PaymentIntentRow | null> {
    const [row] = await tx
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.id, id))
      .limit(1)
      .for('update');
    if (!row) throw new NotFoundError('Payment intent', id);
    return isOpen(row.status) ? row : null;
  }

  private async markExpired(
    tx: Tx,
    intent: PaymentIntentRow,
    actorUserId: string | null,
  ): Promise<PaymentIntentRow> {
    const [updated] = await tx
      .update(paymentIntents)
      .set({ status: 'expired', updatedBy: actorUserId, version: intent.version + 1 })
      .where(
        and(
          eq(paymentIntents.id, intent.id),
          eq(paymentIntents.version, intent.version),
          inArray(paymentIntents.status, [...OPEN_INTENT_STATUSES]),
        ),
      )
      .returning();
    return updated ?? intent;
  }

  private async markFailed(
    tx: Tx,
    intent: PaymentIntentRow,
    failureCode: string | null,
    failureMessage: string | null,
    actorUserId: string | null,
  ): Promise<PaymentIntentRow> {
    const [updated] = await tx
      .update(paymentIntents)
      .set({
        status: 'failed',
        failureCode,
        failureMessage,
        updatedBy: actorUserId,
        version: intent.version + 1,
      })
      .where(
        and(
          eq(paymentIntents.id, intent.id),
          eq(paymentIntents.version, intent.version),
          inArray(paymentIntents.status, [...OPEN_INTENT_STATUSES]),
        ),
      )
      .returning();
    if (!updated) {
      throw new ConflictError('This intent was settled concurrently; keeping the first result.');
    }
    return updated;
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Private: callback records
  // ══════════════════════════════════════════════════════════════════════════════════

  /**
   * Record a callback attempt behind the dedupe UNIQUE constraint.
   *
   * Platform write, justified: a callback is pre-authentication traffic with no session; the
   * row it writes may belong to a tenant (when the intent is known) or to nobody (when it is
   * not), and either way the attempt must be on the record.
   */
  private async recordCallback(input: {
    tenantId: string | null;
    intentId: string | null;
    provider: PaymentGatewayProvider;
    rawPayload: Record<string, unknown>;
    signature: string | null;
    signatureValid: boolean;
    dedupeKey: string;
    processedResult: string | null;
  }): Promise<{ row: PaymentCallbackRow; duplicate: boolean }> {
    return this.db.runAsPlatform(async (tx) => {
      const now = new Date();
      const [inserted] = await tx
        .insert(paymentCallbacks)
        .values({
          id: uuidv7(),
          tenantId: input.tenantId,
          intentId: input.intentId,
          provider: input.provider,
          rawPayload: input.rawPayload,
          signature: input.signature ? input.signature.slice(0, 512) : null,
          signatureValid: input.signatureValid,
          receivedAt: now,
          processedAt: input.processedResult ? now : null,
          processingResult: input.processedResult,
          dedupeKey: input.dedupeKey,
        })
        .onConflictDoNothing({ target: paymentCallbacks.dedupeKey })
        .returning();

      if (inserted) return { row: inserted, duplicate: false };

      // The UNIQUE constraint fired: this event was delivered before. Hand back the original.
      const [existing] = await tx
        .select()
        .from(paymentCallbacks)
        .where(eq(paymentCallbacks.dedupeKey, input.dedupeKey))
        .limit(1);
      if (!existing) {
        // Insert lost the race and the winner vanished — not reachable without manual surgery.
        throw new ConflictError('Callback deduplication raced; retry the delivery.');
      }
      return { row: existing, duplicate: true };
    });
  }

  private async closeCallback(tx: Tx, callbackId: string, result: string): Promise<void> {
    await tx
      .update(paymentCallbacks)
      .set({ processedAt: new Date(), processingResult: result })
      .where(eq(paymentCallbacks.id, callbackId));
  }

  /**
   * After a settlement transaction rolled back: note the error but leave `processed_at` NULL,
   * so the provider's retry of the same dedupe key re-processes instead of no-opping.
   */
  private async markCallbackErrored(callbackId: string): Promise<void> {
    await this.db
      .runAsPlatform(async (tx) => {
        await tx
          .update(paymentCallbacks)
          .set({ processingResult: 'processing_error' })
          .where(eq(paymentCallbacks.id, callbackId));
      })
      .catch(() => undefined); // best-effort; the thrown settlement error is the real signal
  }

  /**
   * Find the live intent a callback references. Platform read, justified: the callback has no
   * tenant context, and the intent row is the only source of the tenant to run in.
   */
  private async findIntentByProviderRef(
    provider: PaymentGatewayProvider,
    providerIntentId: string,
  ): Promise<PaymentIntentRow | null> {
    return this.db.runAsPlatform(async (tx) => {
      const [row] = await tx
        .select()
        .from(paymentIntents)
        .where(
          and(
            eq(paymentIntents.provider, provider),
            eq(paymentIntents.providerIntentId, providerIntentId),
            isNull(paymentIntents.archivedAt),
          ),
        )
        .limit(1);
      return row ?? null;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Private: scoping and lookups
  // ══════════════════════════════════════════════════════════════════════════════════

  private requireScope(principal: Principal): DataScope {
    const context = currentContext();
    const scope = resolveDataScope(principal, GATEWAY_SCOPE, {
      institutionId: context?.institutionId ?? null,
      campusId: context?.campusId ?? null,
    });
    if (scope === 'none') {
      // A collector may hold `finance.collect_payment` without the broader invoice view;
      // creating and tracking their own intents must still work.
      if (can(principal, 'finance.collect_payment')) return 'all';
      throw new ForbiddenError('finance.invoices.view', 'You cannot view payment records');
    }
    return scope;
  }

  /**
   * Scope → SQL predicate over a student id column, identical in shape to the fee module's.
   * `all` is a tautology rather than `undefined` so callers always `and(...)` it — omitting
   * the scope filter by accident is unrepresentable.
   */
  private studentScopeFilter(
    principal: Principal,
    scope: DataScope,
    studentIdColumn: SQLWrapper,
  ): SQL {
    if (scope === 'all') return sql`true`;

    const conditions: SQL[] = [];
    if (principal.guardianId) {
      conditions.push(
        exists(
          this.db.raw
            .select({ one: sql`1` })
            .from(studentGuardians)
            .where(
              and(
                eq(studentGuardians.studentId, studentIdColumn),
                eq(studentGuardians.guardianId, principal.guardianId),
                // Revoking portal access takes effect on the next request, not the next login.
                eq(studentGuardians.canAccessPortal, true),
                isNull(studentGuardians.archivedAt),
              ),
            ),
        ),
      );
    }
    if (principal.studentId) {
      conditions.push(sql`${studentIdColumn} = ${principal.studentId}`);
    }

    if (conditions.length === 0) return sql`false`;
    return conditions.length === 1 ? conditions[0]! : or(...conditions)!;
  }

  /** Shared verbatim between list and single-fetch so the two can never disagree (IDOR). */
  private intentFilters(
    principal: Principal,
    scope: DataScope,
    institutionId: string,
    query: Partial<ListPaymentIntentsQuery>,
  ): SQL[] {
    const filters: SQL[] = [
      eq(paymentIntents.institutionId, institutionId),
      this.studentScopeFilter(principal, scope, paymentIntents.studentId),
    ];
    if (!query.includeArchived) {
      filters.push(isNull(paymentIntents.archivedAt));
    } else if (!can(principal, 'finance.invoices.view')) {
      throw new ForbiddenError('finance.invoices.view', 'You cannot view archived payment records');
    }
    if (query.studentId) filters.push(eq(paymentIntents.studentId, query.studentId));
    if (query.provider) {
      filters.push(eq(paymentIntents.provider, query.provider as PaymentGatewayProvider));
    }
    if (query.status) {
      filters.push(eq(paymentIntents.status, query.status as PaymentIntentRow['status']));
    }
    if (query.refundStatus) filters.push(eq(paymentIntents.refundStatus, query.refundStatus));
    if (query.createdFrom) {
      filters.push(gte(paymentIntents.createdAt, startOfDhakaDay(calendarDate(query.createdFrom))));
    }
    if (query.createdTo) {
      filters.push(lt(paymentIntents.createdAt, endOfDhakaDay(calendarDate(query.createdTo))));
    }
    if (query.q) {
      filters.push(
        or(
          ilike(paymentIntents.providerIntentId, `${query.q}%`),
          ilike(paymentIntents.idempotencyKey, `${query.q}%`),
        )!,
      );
    }
    return filters;
  }

  /**
   * Single-record fetch through the same filters the list uses. An intent outside the
   * caller's scope — another family's, another tenant's — is a 404, never a 403.
   */
  private async loadVisibleIntent(
    tx: Tx,
    principal: Principal,
    scope: DataScope,
    institutionId: string,
    id: string,
  ): Promise<PaymentIntentRow> {
    const [row] = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.id, id),
          ...this.intentFilters(principal, scope, institutionId, { includeArchived: false }),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError('Payment intent', id);
    return row;
  }

  /** Staff-path lookup (refunds): institution-bound, no own-scope — refunds are staff work. */
  private async loadIntentForStaff(
    tx: Tx,
    institutionId: string,
    id: string,
  ): Promise<PaymentIntentRow> {
    const [row] = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.id, id),
          eq(paymentIntents.institutionId, institutionId),
          isNull(paymentIntents.archivedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError('Payment intent', id);
    return row;
  }

  /**
   * Who may create an intent for this student: anyone holding `finance.collect_payment`, or a
   * guardian with a live, portal-enabled link to the student. Anyone else gets the same 404
   * they would get for a student that does not exist — confirming existence is a leak.
   */
  private async assertStudentPayableBy(
    tx: Tx,
    principal: Principal,
    institutionId: string,
    studentId: string,
  ): Promise<void> {
    const [student] = await tx
      .select({ id: students.id })
      .from(students)
      .where(
        and(
          eq(students.id, studentId),
          eq(students.institutionId, institutionId),
          isNull(students.archivedAt),
        ),
      )
      .limit(1);
    if (!student) throw new NotFoundError('Student', studentId);

    if (can(principal, 'finance.collect_payment')) return;

    if (principal.guardianId) {
      const [link] = await tx
        .select({ id: studentGuardians.id })
        .from(studentGuardians)
        .where(
          and(
            eq(studentGuardians.studentId, studentId),
            eq(studentGuardians.guardianId, principal.guardianId),
            eq(studentGuardians.canAccessPortal, true),
            isNull(studentGuardians.archivedAt),
          ),
        )
        .limit(1);
      if (link) return;
    }

    throw new NotFoundError('Student', studentId);
  }

  private requireAdapter(provider: PaymentGatewayProvider): PaymentProvider {
    const adapter = this.registry.find(provider);
    if (!adapter) {
      throw new ValidationError('No gateway adapter is registered for this provider', [
        { path: 'provider', message: `"${provider}" has no gateway adapter` },
      ]);
    }
    return adapter;
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Private: fee-ledger arithmetic (same rules as the fees module, same derivations)
  // ══════════════════════════════════════════════════════════════════════════════════

  /**
   * Recompute one invoice's paid/balance/status from its live allocations — a sum of facts,
   * never an increment. Mirrors the fee module's recompute (which is private there) and uses
   * its exported `deriveInvoiceStatus` so the status arithmetic has exactly one definition.
   */
  private async recomputeInvoice(
    tx: Tx,
    invoiceId: string,
    actorUserId: string | null,
  ): Promise<InvoiceRow> {
    const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
    if (!invoice) throw new NotFoundError('Invoice', invoiceId);

    const [aggregate] = await tx
      .select({
        paid: sql<string>`coalesce(sum(${paymentAllocations.amount}), 0)::numeric(14,2)`,
      })
      .from(paymentAllocations)
      .innerJoin(payments, eq(payments.id, paymentAllocations.paymentId))
      .where(
        and(
          eq(paymentAllocations.invoiceId, invoiceId),
          isNull(paymentAllocations.archivedAt),
          eq(payments.status, 'completed'),
          isNull(payments.archivedAt),
        ),
      );

    const paid = Money.fromDecimalString(aggregate?.paid ?? '0.00');
    const total = Money.fromDecimalString(invoice.total);
    const balance = total.minus(paid);
    const status =
      invoice.status === 'void'
        ? 'void'
        : deriveInvoiceStatus(total, paid, invoice.dueDate, todayInDhaka());

    const [updated] = await tx
      .update(invoices)
      .set({
        paidTotal: paid.toDecimalString(),
        balance: balance.toDecimalString(),
        status,
        updatedBy: actorUserId,
        version: invoice.version + 1,
      })
      .where(eq(invoices.id, invoiceId))
      .returning();

    return updated!;
  }

  /**
   * Highest receipt number under a prefix, shared with the fee module's counter payments —
   * `max` not `count`, and the unique index on `(institution_id, receipt_number)` is the real
   * guarantee against two racing settlements sharing a number.
   */
  private async currentReceiptSequence(
    tx: Tx,
    institutionId: string,
    prefix: string,
  ): Promise<number> {
    const [row] = await tx
      .select({ maxNumber: sql<string | null>`max(${payments.receiptNumber})` })
      .from(payments)
      .where(
        and(
          eq(payments.institutionId, institutionId),
          sql`${payments.receiptNumber} like ${`${prefix}%`}`,
        ),
      );
    const highest = row?.maxNumber ?? null;
    if (!highest) return 0;
    const parsed = Number.parseInt(highest.slice(prefix.length), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
}

// ────────────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────────────────────────

function isOpen(status: PaymentIntentRow['status']): boolean {
  return (OPEN_INTENT_STATUSES as readonly string[]).includes(status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function truncate(value: string | undefined, max: number): string | null {
  if (value === undefined || value === '') return null;
  return value.length > max ? value.slice(0, max) : value;
}

const INTENT_COLUMNS = {
  createdAt: paymentIntents.createdAt,
  amount: paymentIntents.amount,
  status: paymentIntents.status,
  provider: paymentIntents.provider,
  expiresAt: paymentIntents.expiresAt,
} as const;

const RECONCILIATION_COLUMNS = {
  settlementDate: paymentReconciliations.settlementDate,
  provider: paymentReconciliations.provider,
  status: paymentReconciliations.status,
  runAt: paymentReconciliations.runAt,
  createdAt: paymentReconciliations.createdAt,
} as const;
