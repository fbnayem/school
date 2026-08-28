/**
 * Fee management (Phase 11).
 *
 * The money model in one paragraph: **nothing here is a float, and nothing here is deleted.**
 * Every monetary column is `numeric(14, 2)`, which the `pg` driver hands back as a string; the
 * application parses it with `Money.fromDecimalString` and writes it back with
 * `Money.toDecimalString`. Percentages that are not money — a concession of "12.50%" — are
 * stored in the same `numeric(14, 2)` shape and read as basis points, because 12.50 in a
 * two-decimal column is exactly 1250 minor units, which is exactly 1250 basis points.
 *
 * The structural decisions worth stating:
 *
 *  - **`fee_structures` is the price list, `student_fee_assignments` is who pays it, and
 *    `invoices` is what was actually billed.** An invoice is never recomputed from the
 *    structure after the fact: it carries its own lines with their own amounts, so changing
 *    next year's tuition does not silently rewrite last year's bill.
 *  - **`invoices.generation_key` is the idempotency key**, enforced by a partial unique index
 *    rather than by a service remembering to check. Re-running generation for the same student
 *    and billing period is a no-op at the database level, not merely at the application level.
 *  - **`invoices.status` is derived** from `paid_total` against `total`, recomputed by the
 *    service inside the same transaction as any payment or reversal. No client ever sets it.
 *  - **Payments are never deleted and invoices with payments are never voided.** A payment is
 *    reversed (a status change plus an audited reason, with its allocations archived and the
 *    affected invoices recomputed); an invoice that has been paid against is credited, not
 *    voided.
 *
 * Enum note: the `pgEnum` declarations for this module live in this file rather than in
 * `_shared.ts`. Every value set below is genuinely closed — adding a payment method or an
 * invoice status changes the money code as well as the schema, so it should require a
 * migration. Fee *categories* a school invents for itself are not an enum: they are rows in
 * `fee_heads`, with `fee_head_type` only classifying them for reporting.
 */

import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  numeric,
  pgEnum,
  pgTable,
  smallint,
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
import { campuses, institutions, organizations } from './tenancy';
import { academicGroups, academicYears, classLevels } from './academic';
import { students } from './students';

// ─────────────────────────────────────────────────────────────────────────────────────
// Enumerations
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * What kind of charge a fee head is. This classifies for reporting and for the Phase 13
 * ledger mapping; the *name* of the head is free text a school chooses.
 */
export const feeHeadTypeEnum = pgEnum('fee_head_type', [
  'tuition',
  'admission',
  'exam',
  'transport',
  'library',
  'lab',
  'development',
  'hostel',
  'fine',
  'other',
]);

/** How often a structure item is billed. Drives which items a generation run picks up. */
export const feeFrequencyEnum = pgEnum('fee_frequency', [
  'one_time',
  'monthly',
  'quarterly',
  'half_yearly',
  'annual',
]);

export const feeStructureStatusEnum = pgEnum('fee_structure_status', [
  'draft',
  'active',
  'archived',
]);

export const feeConcessionTypeEnum = pgEnum('fee_concession_type', ['percentage', 'fixed']);

/**
 * A concession only affects an invoice once it is `approved`. Requesting and approving are
 * separate permissions (`finance.discounts.manage` and `finance.discounts.approve`), so this
 * column is the record of a separation of duties, not a workflow convenience.
 */
export const feeConcessionStatusEnum = pgEnum('fee_concession_status', [
  'pending',
  'approved',
  'rejected',
]);

/**
 * Derived, never client-supplied. `draft` exists for a generation preview that was never
 * committed; the service only ever persists `issued` and above.
 */
export const invoiceStatusEnum = pgEnum('invoice_status', [
  'draft',
  'issued',
  'partially_paid',
  'paid',
  'overdue',
  'void',
]);

/** The mobile financial services are first-class here because in Bangladesh they are. */
export const paymentMethodEnum = pgEnum('payment_method', [
  'cash',
  'bank_transfer',
  'cheque',
  'bkash',
  'nagad',
  'rocket',
  'card',
  'online',
]);

export const paymentStatusEnum = pgEnum('payment_status', [
  'pending',
  'completed',
  'failed',
  'reversed',
]);

// ─────────────────────────────────────────────────────────────────────────────────────
// Configuration: heads, structures, items
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A billable line of charge: "Tuition", "Transport", "Board registration".
 *
 * A row rather than an enum value, because a school inventing "Science club fee" must not
 * need a migration. `ledger_account_code` is the hook Phase 13 uses to post an invoice to a
 * chart of accounts; it is nullable because fee collection works perfectly well before
 * accounting is configured.
 */
export const feeHeads = pgTable(
  'fee_heads',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    code: varchar('code', { length: 32 }).notNull(),
    nameEn: varchar('name_en', { length: 128 }).notNull(),
    nameBn: varchar('name_bn', { length: 128 }),
    type: feeHeadTypeEnum('type').notNull().default('other'),
    /** Charged every billing period rather than once — tuition versus an admission fee. */
    isRecurring: boolean('is_recurring').notNull().default(false),
    /** Whether money collected against this head may be refunded at all. */
    isRefundable: boolean('is_refundable').notNull().default(true),
    /** Reserved for Phase 13 (accounting): the account this head posts to. */
    ledgerAccountCode: varchar('ledger_account_code', { length: 32 }),
    description: varchar('description', { length: 500 }),
    sortOrder: smallint('sort_order').notNull().default(0),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('fee_heads_institution_code_key')
      .on(table.institutionId, table.code)
      .where(sql`${table.archivedAt} IS NULL`),
    index('fee_heads_tenant_idx').on(table.tenantId),
    index('fee_heads_institution_type_idx').on(table.institutionId, table.type),
  ],
);

/**
 * A price list for one academic year, optionally narrowed to a class level and a group.
 *
 * The late-fine rule lives here rather than in a separate table because it is a property of
 * the price list a school publishes, and because a fine is only ever *applied* by an explicit,
 * audited endpoint — never computed on read. A rule nobody invoked has charged nobody.
 */
export const feeStructures = pgTable(
  'fee_structures',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    campusId: uuid('campus_id')
      .notNull()
      .references(() => campuses.id, { onDelete: 'restrict' }),
    academicYearId: uuid('academic_year_id')
      .notNull()
      .references(() => academicYears.id, { onDelete: 'restrict' }),
    /** Null means the structure applies to every class in the year. */
    classLevelId: uuid('class_level_id').references(() => classLevels.id, {
      onDelete: 'restrict',
    }),
    /** Null means every group; set for a Science-only laboratory charge, for example. */
    academicGroupId: uuid('academic_group_id').references(() => academicGroups.id, {
      onDelete: 'restrict',
    }),
    nameEn: varchar('name_en', { length: 128 }).notNull(),
    nameBn: varchar('name_bn', { length: 128 }),
    status: feeStructureStatusEnum('status').notNull().default('draft'),
    effectiveFrom: date('effective_from').notNull(),

    /**
     * Late-fine rule. `'none' | 'fixed' | 'percentage'`.
     *
     * A varchar with a documented union rather than an enum: a school adding "percentage per
     * week" later is a policy change, and this is the one field here likely to grow.
     */
    lateFineKind: varchar('late_fine_kind', { length: 16 }).notNull().default('none'),
    /**
     * For `fixed`, an amount in the invoice currency. For `percentage`, a percentage carried
     * with two decimals — read as basis points, so `2.50` is 250bp.
     */
    lateFineValue: numeric('late_fine_value', { precision: 14, scale: 2 })
      .notNull()
      .default('0.00'),
    /** Days after the due date before a fine may be charged at all. */
    lateFineGraceDays: smallint('late_fine_grace_days').notNull().default(0),
    /** Optional ceiling, so a percentage rule on a large invoice cannot run away. */
    lateFineMaxAmount: numeric('late_fine_max_amount', { precision: 14, scale: 2 }),

    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('fee_structures_year_name_key')
      .on(table.academicYearId, table.nameEn)
      .where(sql`${table.archivedAt} IS NULL`),
    index('fee_structures_tenant_idx').on(table.tenantId),
    index('fee_structures_year_class_idx').on(table.academicYearId, table.classLevelId),
    index('fee_structures_institution_status_idx').on(table.institutionId, table.status),
    index('fee_structures_campus_idx').on(table.campusId),
  ],
);

/**
 * One charge within a structure: a head, an amount, and how often it is billed.
 *
 * Owned by its structure (`on delete cascade` in the FK, though the application archives
 * rather than deletes), because items are replaced as a set: editing a price list submits the
 * whole list and the service archives what is no longer in it.
 */
export const feeStructureItems = pgTable(
  'fee_structure_items',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    feeStructureId: uuid('fee_structure_id')
      .notNull()
      .references(() => feeStructures.id, { onDelete: 'cascade' }),
    feeHeadId: uuid('fee_head_id')
      .notNull()
      .references(() => feeHeads.id, { onDelete: 'restrict' }),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    frequency: feeFrequencyEnum('frequency').notNull().default('monthly'),
    /** 1–31, or null to fall back to the generation run's due date. */
    dueDayOfMonth: smallint('due_day_of_month'),
    /** Opt-in charges — transport, hostel — excluded from generation unless asked for. */
    isOptional: boolean('is_optional').notNull().default(false),
    sortOrder: smallint('sort_order').notNull().default(0),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('fee_structure_items_head_key')
      .on(table.feeStructureId, table.feeHeadId, table.frequency)
      .where(sql`${table.archivedAt} IS NULL`),
    index('fee_structure_items_tenant_idx').on(table.tenantId),
    index('fee_structure_items_structure_idx').on(table.feeStructureId),
    index('fee_structure_items_head_idx').on(table.feeHeadId),
  ],
);

/**
 * Which structure applies to a student, and from when.
 *
 * Dated rather than a single column on `students` because a student who moves from the day
 * shift to the morning shift in July must be billed the old price list until June and the new
 * one afterwards, and last year's invoices must still explain themselves.
 */
export const studentFeeAssignments = pgTable(
  'student_fee_assignments',
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
    feeStructureId: uuid('fee_structure_id')
      .notNull()
      .references(() => feeStructures.id, { onDelete: 'restrict' }),
    academicYearId: uuid('academic_year_id')
      .notNull()
      .references(() => academicYears.id, { onDelete: 'restrict' }),
    effectiveFrom: date('effective_from').notNull(),
    /** Null while the assignment is open-ended. */
    effectiveTo: date('effective_to'),
    note: varchar('note', { length: 500 }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('student_fee_assignments_period_key')
      .on(table.studentId, table.academicYearId, table.effectiveFrom)
      .where(sql`${table.archivedAt} IS NULL`),
    index('student_fee_assignments_tenant_idx').on(table.tenantId),
    index('student_fee_assignments_student_idx').on(table.studentId, table.academicYearId),
    index('student_fee_assignments_structure_idx').on(table.feeStructureId),
  ],
);

/**
 * A discount or waiver for one student, optionally limited to one fee head.
 *
 * `fee_head_id` null means "every head" — a sibling discount or a merit scholarship. Two
 * concessions can therefore apply to one line, and the order is fixed by the service:
 * percentages first, then fixed amounts, with the total discount floored so a line can never
 * go negative.
 */
export const feeConcessions = pgTable(
  'fee_concessions',
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
    /** Null applies the concession to every head on the invoice. */
    feeHeadId: uuid('fee_head_id').references(() => feeHeads.id, { onDelete: 'restrict' }),
    type: feeConcessionTypeEnum('type').notNull(),
    /**
     * For `fixed`, an amount. For `percentage`, a percentage with two decimals — read as
     * basis points (`12.50` is 1250bp), so no float is ever involved in applying it.
     */
    value: numeric('value', { precision: 14, scale: 2 }).notNull(),
    reason: varchar('reason', { length: 1000 }).notNull(),
    status: feeConcessionStatusEnum('status').notNull().default('pending'),
    approvedBy: uuid('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true, mode: 'date' }),
    /** What the approver or rejecter wrote. Kept even after a later status change. */
    decisionNote: varchar('decision_note', { length: 1000 }),
    validFrom: date('valid_from').notNull(),
    validTo: date('valid_to'),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    // One live concession per student, head and start date. Postgres treats NULLs as
    // distinct, so several "all heads" concessions starting on the same day are still
    // possible; the service refuses those explicitly, since the index cannot.
    uniqueIndex('fee_concessions_student_head_key')
      .on(table.studentId, table.feeHeadId, table.validFrom)
      .where(sql`${table.status} <> 'rejected' AND ${table.archivedAt} IS NULL`),
    index('fee_concessions_tenant_idx').on(table.tenantId),
    index('fee_concessions_student_idx').on(table.studentId, table.status),
    index('fee_concessions_head_idx').on(table.feeHeadId),
    index('fee_concessions_institution_status_idx').on(table.institutionId, table.status),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Billing: invoices, lines, payments, allocations
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A bill issued to one student for one billing period.
 *
 * `generation_key` is what makes invoice generation idempotent, and it is enforced by a
 * partial unique index rather than only by the service. The key is derived deterministically
 * from the academic year, the student and the billing period, so a second run for the same
 * inputs cannot create a second invoice even if two clerks press the button at once. Voided
 * invoices are excluded from the index, which is what allows "void and re-issue" to work.
 *
 * `subtotal`, `discount_total`, `fine_total`, `total`, `paid_total` and `balance` are all
 * `numeric(14, 2)` and all maintained by the service through `Money`. `status` is derived from
 * `paid_total` against `total` and is never accepted from a client.
 */
export const invoices = pgTable(
  'invoices',
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
    academicYearId: uuid('academic_year_id')
      .notNull()
      .references(() => academicYears.id, { onDelete: 'restrict' }),
    /** The price list this bill came from. Also where the late-fine rule is read from. */
    feeStructureId: uuid('fee_structure_id').references(() => feeStructures.id, {
      onDelete: 'restrict',
    }),

    invoiceNumber: varchar('invoice_number', { length: 32 }).notNull(),
    /** Idempotency key for generation. Null for an invoice raised by hand. */
    generationKey: varchar('generation_key', { length: 200 }),

    billingPeriodStart: date('billing_period_start').notNull(),
    billingPeriodEnd: date('billing_period_end').notNull(),
    issueDate: date('issue_date').notNull(),
    dueDate: date('due_date').notNull(),

    subtotal: numeric('subtotal', { precision: 14, scale: 2 }).notNull().default('0.00'),
    discountTotal: numeric('discount_total', { precision: 14, scale: 2 })
      .notNull()
      .default('0.00'),
    fineTotal: numeric('fine_total', { precision: 14, scale: 2 }).notNull().default('0.00'),
    total: numeric('total', { precision: 14, scale: 2 }).notNull().default('0.00'),
    paidTotal: numeric('paid_total', { precision: 14, scale: 2 }).notNull().default('0.00'),
    balance: numeric('balance', { precision: 14, scale: 2 }).notNull().default('0.00'),
    currency: varchar('currency', { length: 3 }).notNull().default('BDT'),

    status: invoiceStatusEnum('status').notNull().default('issued'),
    notes: varchar('notes', { length: 1000 }),

    /** Voiding is refused once any payment has been allocated; credit it instead. */
    voidedReason: varchar('voided_reason', { length: 1000 }),
    voidedBy: uuid('voided_by'),
    voidedAt: timestamp('voided_at', { withTimezone: true, mode: 'date' }),

    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('invoices_institution_number_key').on(table.institutionId, table.invoiceNumber),
    uniqueIndex('invoices_generation_key').on(table.institutionId, table.generationKey).where(sql`
        ${table.generationKey} IS NOT NULL
        AND ${table.status} <> 'void'
        AND ${table.archivedAt} IS NULL
      `),
    index('invoices_tenant_idx').on(table.tenantId),
    index('invoices_student_idx').on(table.studentId, table.dueDate),
    index('invoices_institution_status_idx').on(table.institutionId, table.status, table.dueDate),
    index('invoices_year_idx').on(table.academicYearId),
    index('invoices_structure_idx').on(table.feeStructureId),
  ],
);

/**
 * One charged head on one invoice, with the discount that was applied to it.
 *
 * `net_amount` is stored rather than derived on read for the same reason the amounts are
 * copied off the structure: an invoice is a document, and a document that changes when the
 * configuration behind it changes is not a document.
 */
export const invoiceLines = pgTable(
  'invoice_lines',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    feeHeadId: uuid('fee_head_id')
      .notNull()
      .references(() => feeHeads.id, { onDelete: 'restrict' }),
    description: varchar('description', { length: 255 }).notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    discountAmount: numeric('discount_amount', { precision: 14, scale: 2 })
      .notNull()
      .default('0.00'),
    netAmount: numeric('net_amount', { precision: 14, scale: 2 }).notNull(),
    /** Which concession produced the discount, where exactly one did. For explainability. */
    concessionId: uuid('concession_id').references(() => feeConcessions.id, {
      onDelete: 'set null',
    }),
    /** True for a line added by the late-fine endpoint rather than by generation. */
    isFine: boolean('is_fine').notNull().default(false),
    sortOrder: smallint('sort_order').notNull().default(0),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('invoice_lines_tenant_idx').on(table.tenantId),
    index('invoice_lines_invoice_idx').on(table.invoiceId),
    index('invoice_lines_head_idx').on(table.feeHeadId),
    index('invoice_lines_concession_idx').on(table.concessionId),
  ],
);

/**
 * Money received from a student, independent of which invoices it settles.
 *
 * Kept separate from allocation because a parent hands over one amount for three outstanding
 * months, and because a payment can legitimately exceed what is currently due — the excess is
 * simply unallocated and settles the next invoice generated.
 *
 * A payment is never deleted. `reversed` plus a reason is the only way to undo one, and the
 * reversal archives its allocations and recomputes the affected invoices in the same
 * transaction.
 */
export const payments = pgTable(
  'payments',
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
    receiptNumber: varchar('receipt_number', { length: 32 }).notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('BDT'),
    method: paymentMethodEnum('method').notNull(),
    /** bKash transaction id, cheque number, bank slip reference. */
    reference: varchar('reference', { length: 128 }),
    /** The user who took the money. Nullable only for imports and system postings. */
    receivedBy: uuid('received_by'),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    status: paymentStatusEnum('status').notNull().default('completed'),
    notes: varchar('notes', { length: 1000 }),

    reversalReason: varchar('reversal_reason', { length: 1000 }),
    reversedBy: uuid('reversed_by'),
    reversedAt: timestamp('reversed_at', { withTimezone: true, mode: 'date' }),

    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('payments_institution_receipt_key').on(table.institutionId, table.receiptNumber),
    index('payments_tenant_idx').on(table.tenantId),
    index('payments_student_idx').on(table.studentId, table.receivedAt),
    index('payments_institution_received_idx').on(
      table.institutionId,
      table.receivedAt,
      table.method,
    ),
    index('payments_status_idx').on(table.institutionId, table.status),
  ],
);

/**
 * How much of a payment settled which invoice.
 *
 * The sum of a completed payment's live allocations is at most the payment amount, and an
 * invoice's `paid_total` is the sum of the live allocations pointing at it. Reversal archives
 * the rows rather than deleting them, so the trail of "this receipt once settled that
 * invoice" survives.
 */
export const paymentAllocations = pgTable(
  'payment_allocations',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'restrict' }),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('payment_allocations_unique_key')
      .on(table.paymentId, table.invoiceId)
      .where(sql`${table.archivedAt} IS NULL`),
    index('payment_allocations_tenant_idx').on(table.tenantId),
    index('payment_allocations_invoice_idx').on(table.invoiceId),
    index('payment_allocations_payment_idx').on(table.paymentId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────

export const feeHeadsRelations = relations(feeHeads, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [feeHeads.institutionId],
    references: [institutions.id],
  }),
  structureItems: many(feeStructureItems),
  invoiceLines: many(invoiceLines),
}));

export const feeStructuresRelations = relations(feeStructures, ({ one, many }) => ({
  academicYear: one(academicYears, {
    fields: [feeStructures.academicYearId],
    references: [academicYears.id],
  }),
  classLevel: one(classLevels, {
    fields: [feeStructures.classLevelId],
    references: [classLevels.id],
  }),
  items: many(feeStructureItems),
  assignments: many(studentFeeAssignments),
}));

export const feeStructureItemsRelations = relations(feeStructureItems, ({ one }) => ({
  structure: one(feeStructures, {
    fields: [feeStructureItems.feeStructureId],
    references: [feeStructures.id],
  }),
  feeHead: one(feeHeads, {
    fields: [feeStructureItems.feeHeadId],
    references: [feeHeads.id],
  }),
}));

export const studentFeeAssignmentsRelations = relations(studentFeeAssignments, ({ one }) => ({
  student: one(students, {
    fields: [studentFeeAssignments.studentId],
    references: [students.id],
  }),
  structure: one(feeStructures, {
    fields: [studentFeeAssignments.feeStructureId],
    references: [feeStructures.id],
  }),
}));

export const feeConcessionsRelations = relations(feeConcessions, ({ one }) => ({
  student: one(students, { fields: [feeConcessions.studentId], references: [students.id] }),
  feeHead: one(feeHeads, { fields: [feeConcessions.feeHeadId], references: [feeHeads.id] }),
}));

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  student: one(students, { fields: [invoices.studentId], references: [students.id] }),
  academicYear: one(academicYears, {
    fields: [invoices.academicYearId],
    references: [academicYears.id],
  }),
  structure: one(feeStructures, {
    fields: [invoices.feeStructureId],
    references: [feeStructures.id],
  }),
  lines: many(invoiceLines),
  allocations: many(paymentAllocations),
}));

export const invoiceLinesRelations = relations(invoiceLines, ({ one }) => ({
  invoice: one(invoices, { fields: [invoiceLines.invoiceId], references: [invoices.id] }),
  feeHead: one(feeHeads, { fields: [invoiceLines.feeHeadId], references: [feeHeads.id] }),
}));

export const paymentsRelations = relations(payments, ({ one, many }) => ({
  student: one(students, { fields: [payments.studentId], references: [students.id] }),
  allocations: many(paymentAllocations),
}));

export const paymentAllocationsRelations = relations(paymentAllocations, ({ one }) => ({
  payment: one(payments, { fields: [paymentAllocations.paymentId], references: [payments.id] }),
  invoice: one(invoices, { fields: [paymentAllocations.invoiceId], references: [invoices.id] }),
}));
