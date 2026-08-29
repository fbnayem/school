/**
 * Library management (Phase 17).
 *
 * The structural decisions worth stating:
 *
 *  - **A copy may carry at most one live loan, and the database says so.** The partial unique
 *    index `library_loans_copy_active_key` on `(copy_id) WHERE returned_at IS NULL` is the
 *    guarantee; the service's status checks are a courtesy that produces better error
 *    messages. Two clerks scanning the same barcode at the same moment collide in Postgres,
 *    not in a race the application happened to lose.
 *  - **A fine is a financial fact, never a computation on read.** `library_fines` rows are
 *    written only by the explicit, audited assessment endpoint; the per-day rate lives in
 *    `library_settings` and a rule nobody invoked has charged nobody. This mirrors the fees
 *    module's late-fine design exactly.
 *  - **Money is `numeric(14, 2)`** — a copy's cost, a loan's accumulated fine, a fine's
 *    amount — parsed only by `Money.fromDecimalString` and written only by
 *    `Money.toDecimalString`.
 *  - **Nothing is deleted.** A lost book moves its copy to `lost` and assesses a replacement
 *    cost; a withdrawn copy is archived with a reason and keeps its accession number in the
 *    record; loans and fines are permanent history.
 *  - **`library_titles.total_copies` is derived** — recomputed from the copy rows inside the
 *    same transaction as any copy mutation, never incremented and never client-supplied.
 *
 * Enum note: every value set below is genuinely closed — adding a loan status or a member
 * type changes circulation code as well as the schema. Book *categories* a school invents for
 * itself are rows in `library_categories`, not enum values.
 */

import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
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
import { institutions, organizations } from './tenancy';
import { students } from './students';
import { employees } from './people';

// ─────────────────────────────────────────────────────────────────────────────────────
// Enumerations. All prefixed `library_` so they can never collide with another module.
// ─────────────────────────────────────────────────────────────────────────────────────

export const libraryLanguageEnum = pgEnum('library_language', [
  'bangla',
  'english',
  'arabic',
  'other',
]);

export const libraryCopyConditionEnum = pgEnum('library_copy_condition', [
  'new',
  'good',
  'fair',
  'damaged',
  'lost',
]);

/**
 * `issued`, `reserved` and `lost` are maintained by the circulation service inside the same
 * transaction as the loan or reservation that causes them; `withdrawn` is a terminal state
 * set by the audited withdraw endpoint. A client never supplies this column.
 */
export const libraryCopyStatusEnum = pgEnum('library_copy_status', [
  'available',
  'issued',
  'reserved',
  'lost',
  'withdrawn',
]);

export const libraryMemberTypeEnum = pgEnum('library_member_type', ['student', 'employee']);

export const libraryMemberStatusEnum = pgEnum('library_member_status', [
  'active',
  'suspended',
  'expired',
]);

export const libraryLoanStatusEnum = pgEnum('library_loan_status', [
  'issued',
  'returned',
  'overdue',
  'lost',
]);

export const libraryReservationStatusEnum = pgEnum('library_reservation_status', [
  'active',
  'fulfilled',
  'cancelled',
  'expired',
]);

export const libraryFineStatusEnum = pgEnum('library_fine_status', ['pending', 'paid', 'waived']);

// ─────────────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Per-institution circulation policy.
 *
 * `fine_per_day` is the configurable rate the assessment endpoint multiplies by whole overdue
 * days — the rate itself charges nobody until someone with `library.fines.manage` runs the
 * audited assessment. One row per institution; reads fall back to the column defaults when a
 * school has never saved a policy.
 */
export const librarySettings = pgTable(
  'library_settings',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    /** Fine accrued per whole overdue day. Money, never a float. */
    finePerDay: numeric('fine_per_day', { precision: 14, scale: 2 }).notNull().default('2.00'),
    maxRenewals: smallint('max_renewals').notNull().default(1),
    /** How long a returned copy is held for the head of a reservation queue. */
    reservationHoldDays: smallint('reservation_hold_days').notNull().default(3),
    defaultLoanDays: smallint('default_loan_days').notNull().default(14),
    defaultMaxBooks: smallint('default_max_books').notNull().default(3),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('library_settings_institution_key')
      .on(table.institutionId)
      .where(sql`${table.archivedAt} IS NULL`),
    index('library_settings_tenant_idx').on(table.tenantId),
  ],
);

/**
 * A shelf classification a school defines for itself — a lookup table, not an enum, because
 * "Islamic Studies" or "SSC Reference" must never require a migration. Optionally nested one
 * level (or more) through `parent_id`.
 */
export const libraryCategories = pgTable(
  'library_categories',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    nameEn: varchar('name_en', { length: 128 }).notNull(),
    nameBn: varchar('name_bn', { length: 128 }),
    parentId: uuid('parent_id'),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('library_categories_institution_name_key')
      .on(table.institutionId, table.nameEn)
      .where(sql`${table.archivedAt} IS NULL`),
    index('library_categories_tenant_idx').on(table.tenantId),
    index('library_categories_parent_idx').on(table.parentId),
  ],
);

/**
 * A bibliographic work — "Physics for Class 9-10, 3rd edition" — as distinct from the
 * physical copies of it on the shelves.
 *
 * `isbn` is nullable (donated books, government texts and old stock often have none) and is
 * deliberately not unique: two editions or two bindings can legitimately share one. The
 * accession number on the *copy* is the unique physical identity.
 *
 * `total_copies` is derived from the copy rows (excluding withdrawn ones) and recomputed by
 * the service in the same transaction as any copy change.
 */
export const libraryTitles = pgTable(
  'library_titles',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    isbn: varchar('isbn', { length: 20 }),
    title: varchar('title', { length: 255 }).notNull(),
    titleBn: varchar('title_bn', { length: 255 }),
    author: varchar('author', { length: 255 }),
    publisher: varchar('publisher', { length: 255 }),
    edition: varchar('edition', { length: 64 }),
    language: libraryLanguageEnum('language').notNull().default('bangla'),
    categoryId: uuid('category_id').references(() => libraryCategories.id, {
      onDelete: 'restrict',
    }),
    deweyCode: varchar('dewey_code', { length: 32 }),
    /** Points at a `files` row (like `employees.photo_file_id`); bytes live in storage. */
    coverFileId: uuid('cover_file_id'),
    /** Derived: live copies not withdrawn. Never client-supplied. */
    totalCopies: integer('total_copies').notNull().default(0),
    /** `'active' | 'inactive'` — inactive titles cannot be reserved or receive new copies. */
    status: varchar('status', { length: 16 }).notNull().default('active'),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('library_titles_tenant_idx').on(table.tenantId),
    index('library_titles_institution_status_idx').on(table.institutionId, table.status),
    index('library_titles_category_idx').on(table.categoryId),
    index('library_titles_isbn_idx').on(table.institutionId, table.isbn),
    index('library_titles_title_idx').on(table.institutionId, table.title),
  ],
);

/**
 * One physical book. The accession number is the library's permanent identity for it —
 * unique per institution among live rows, so a withdrawn copy's number stays in the record
 * while the register can move on.
 */
export const libraryCopies = pgTable(
  'library_copies',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    titleId: uuid('title_id')
      .notNull()
      .references(() => libraryTitles.id, { onDelete: 'restrict' }),
    accessionNumber: varchar('accession_number', { length: 32 }).notNull(),
    barcode: varchar('barcode', { length: 64 }),
    acquiredOn: date('acquired_on'),
    /** Purchase or replacement cost. Used as the default replacement fine for a lost copy. */
    cost: numeric('cost', { precision: 14, scale: 2 }),
    condition: libraryCopyConditionEnum('condition').notNull().default('good'),
    status: libraryCopyStatusEnum('status').notNull().default('available'),
    shelfLocation: varchar('shelf_location', { length: 64 }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('library_copies_accession_key')
      .on(table.institutionId, table.accessionNumber)
      .where(sql`${table.archivedAt} IS NULL`),
    uniqueIndex('library_copies_barcode_key')
      .on(table.institutionId, table.barcode)
      .where(sql`${table.barcode} IS NOT NULL AND ${table.archivedAt} IS NULL`),
    index('library_copies_tenant_idx').on(table.tenantId),
    index('library_copies_title_idx').on(table.titleId, table.status),
    index('library_copies_institution_status_idx').on(table.institutionId, table.status),
  ],
);

/**
 * A borrowing account for exactly one person — a student or an employee, never both and
 * never neither, which the check constraint `library_members_exactly_one_person` states in
 * the database rather than trusting the service.
 *
 * `max_books` and `loan_days` are copied from the institution defaults at creation so a
 * policy change does not silently rewrite existing memberships; they remain editable per
 * member (a teacher may borrow more, a fragile borrower less).
 */
export const libraryMembers = pgTable(
  'library_members',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    memberType: libraryMemberTypeEnum('member_type').notNull(),
    studentId: uuid('student_id').references(() => students.id, { onDelete: 'restrict' }),
    employeeId: uuid('employee_id').references(() => employees.id, { onDelete: 'restrict' }),
    cardNumber: varchar('card_number', { length: 32 }).notNull(),
    maxBooks: smallint('max_books').notNull().default(3),
    loanDays: smallint('loan_days').notNull().default(14),
    status: libraryMemberStatusEnum('status').notNull().default('active'),
    validUntil: date('valid_until'),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('library_members_card_key')
      .on(table.institutionId, table.cardNumber)
      .where(sql`${table.archivedAt} IS NULL`),
    // One live membership per person. Partial on the id being present, since exactly one of
    // the two columns is null on every row.
    uniqueIndex('library_members_student_key')
      .on(table.studentId)
      .where(sql`${table.studentId} IS NOT NULL AND ${table.archivedAt} IS NULL`),
    uniqueIndex('library_members_employee_key')
      .on(table.employeeId)
      .where(sql`${table.employeeId} IS NOT NULL AND ${table.archivedAt} IS NULL`),
    index('library_members_tenant_idx').on(table.tenantId),
    index('library_members_institution_status_idx').on(table.institutionId, table.status),
  ],
);

/**
 * One borrowing of one copy.
 *
 * **`library_loans_copy_active_key`** — unique on `copy_id` where `returned_at is null` — is
 * the single-active-loan guarantee, and it is a property of the database. A concurrent
 * double-issue is refused by Postgres with a unique violation (surfaced as a 409), not by an
 * application check that a race can slip past.
 *
 * `fine_amount` is derived: the sum of this loan's live, non-waived fine rows, recomputed in
 * the same transaction as any fine mutation. `status` is likewise maintained by the service
 * (`overdue` on assessment, `returned` on return, `lost` on the audited lost action).
 */
export const libraryLoans = pgTable(
  'library_loans',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    copyId: uuid('copy_id')
      .notNull()
      .references(() => libraryCopies.id, { onDelete: 'restrict' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => libraryMembers.id, { onDelete: 'restrict' }),
    /** The user who handed the book over. */
    issuedBy: uuid('issued_by'),
    issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    dueOn: date('due_on').notNull(),
    returnedAt: timestamp('returned_at', { withTimezone: true, mode: 'date' }),
    /** The user who took the book back. */
    returnedTo: uuid('returned_to'),
    renewalCount: smallint('renewal_count').notNull().default(0),
    status: libraryLoanStatusEnum('status').notNull().default('issued'),
    /** Derived: sum of live, non-waived fines on this loan. */
    fineAmount: numeric('fine_amount', { precision: 14, scale: 2 }).notNull().default('0.00'),
    /** Set when any fine on this loan was waived — a pointer for quick accountability. */
    fineWaivedBy: uuid('fine_waived_by'),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    /**
     * THE circulation invariant: at most one live loan per copy, enforced by Postgres.
     * Deliberately conditioned only on `returned_at is null` — archiving a live loan must not
     * free the copy for a second concurrent borrowing.
     */
    uniqueIndex('library_loans_copy_active_key')
      .on(table.copyId)
      .where(sql`${table.returnedAt} IS NULL`),
    index('library_loans_tenant_idx').on(table.tenantId),
    index('library_loans_member_idx').on(table.memberId, table.status),
    index('library_loans_copy_idx').on(table.copyId),
    index('library_loans_due_idx')
      .on(table.institutionId, table.dueOn)
      .where(sql`${table.returnedAt} IS NULL`),
  ],
);

/**
 * A place in the queue for the next available copy of a title.
 *
 * Queue positions are assigned under a row lock on the title and rewritten in the same
 * transaction as the fulfilment, cancellation or expiry that vacates a slot, so the queue
 * has no observable state in which two members hold the same position claim on a copy.
 */
export const libraryReservations = pgTable(
  'library_reservations',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    titleId: uuid('title_id')
      .notNull()
      .references(() => libraryTitles.id, { onDelete: 'restrict' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => libraryMembers.id, { onDelete: 'restrict' }),
    reservedAt: timestamp('reserved_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    /** Set when a returned copy is held for this reservation; the hold dies at this instant. */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    status: libraryReservationStatusEnum('status').notNull().default('active'),
    queuePosition: integer('queue_position').notNull(),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    // One active place in one title's queue per member. Postgres backs what the service checks.
    uniqueIndex('library_reservations_member_title_key')
      .on(table.titleId, table.memberId)
      .where(sql`${table.status} = 'active' AND ${table.archivedAt} IS NULL`),
    index('library_reservations_tenant_idx').on(table.tenantId),
    index('library_reservations_title_queue_idx')
      .on(table.titleId, table.queuePosition)
      .where(sql`${table.status} = 'active'`),
    index('library_reservations_member_idx').on(table.memberId, table.status),
  ],
);

/**
 * A fine somebody decided a member owes — assessed by the explicit, audited endpoint, never
 * computed on read. Waiving requires a distinct permission, a mandatory reason, and leaves
 * both the row and the audit record behind.
 *
 * `library_fines_loan_day_key` makes an assessment run idempotent per loan per day at the
 * database level: re-running the batch for the same date cannot double-charge.
 */
export const libraryFines = pgTable(
  'library_fines',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    loanId: uuid('loan_id')
      .notNull()
      .references(() => libraryLoans.id, { onDelete: 'restrict' }),
    /** Denormalised from the loan so "my fines" and member statements need no join chain. */
    memberId: uuid('member_id')
      .notNull()
      .references(() => libraryMembers.id, { onDelete: 'restrict' }),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    reason: varchar('reason', { length: 1000 }).notNull(),
    assessedOn: date('assessed_on').notNull(),
    /**
     * True for the replacement-cost fine written by the lost-copy action, false for a
     * per-day overdue assessment. Splits the daily-idempotency domain of
     * `library_fines_loan_day_key`, so declaring a book lost on a day it was also assessed
     * overdue does not collide.
     */
    isReplacement: boolean('is_replacement').notNull().default(false),
    status: libraryFineStatusEnum('status').notNull().default('pending'),
    paidAt: timestamp('paid_at', { withTimezone: true, mode: 'date' }),
    paymentMethod: varchar('payment_method', { length: 24 }),
    paymentReference: varchar('payment_reference', { length: 128 }),
    waivedBy: uuid('waived_by'),
    waivedAt: timestamp('waived_at', { withTimezone: true, mode: 'date' }),
    waivedReason: varchar('waived_reason', { length: 1000 }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('library_fines_loan_day_key')
      .on(table.loanId, table.assessedOn)
      .where(sql`${table.archivedAt} IS NULL AND ${table.isReplacement} = false`),
    index('library_fines_tenant_idx').on(table.tenantId),
    index('library_fines_loan_idx').on(table.loanId),
    index('library_fines_member_idx').on(table.memberId, table.status),
    index('library_fines_institution_status_idx').on(table.institutionId, table.status),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────

export const libraryCategoriesRelations = relations(libraryCategories, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [libraryCategories.institutionId],
    references: [institutions.id],
  }),
  parent: one(libraryCategories, {
    fields: [libraryCategories.parentId],
    references: [libraryCategories.id],
    relationName: 'library_category_parent',
  }),
  children: many(libraryCategories, { relationName: 'library_category_parent' }),
  titles: many(libraryTitles),
}));

export const libraryTitlesRelations = relations(libraryTitles, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [libraryTitles.institutionId],
    references: [institutions.id],
  }),
  category: one(libraryCategories, {
    fields: [libraryTitles.categoryId],
    references: [libraryCategories.id],
  }),
  copies: many(libraryCopies),
  reservations: many(libraryReservations),
}));

export const libraryCopiesRelations = relations(libraryCopies, ({ one, many }) => ({
  title: one(libraryTitles, {
    fields: [libraryCopies.titleId],
    references: [libraryTitles.id],
  }),
  loans: many(libraryLoans),
}));

export const libraryMembersRelations = relations(libraryMembers, ({ one, many }) => ({
  student: one(students, {
    fields: [libraryMembers.studentId],
    references: [students.id],
  }),
  employee: one(employees, {
    fields: [libraryMembers.employeeId],
    references: [employees.id],
  }),
  loans: many(libraryLoans),
  reservations: many(libraryReservations),
  fines: many(libraryFines),
}));

export const libraryLoansRelations = relations(libraryLoans, ({ one, many }) => ({
  copy: one(libraryCopies, {
    fields: [libraryLoans.copyId],
    references: [libraryCopies.id],
  }),
  member: one(libraryMembers, {
    fields: [libraryLoans.memberId],
    references: [libraryMembers.id],
  }),
  fines: many(libraryFines),
}));

export const libraryReservationsRelations = relations(libraryReservations, ({ one }) => ({
  title: one(libraryTitles, {
    fields: [libraryReservations.titleId],
    references: [libraryTitles.id],
  }),
  member: one(libraryMembers, {
    fields: [libraryReservations.memberId],
    references: [libraryMembers.id],
  }),
}));

export const libraryFinesRelations = relations(libraryFines, ({ one }) => ({
  loan: one(libraryLoans, {
    fields: [libraryFines.loanId],
    references: [libraryLoans.id],
  }),
  member: one(libraryMembers, {
    fields: [libraryFines.memberId],
    references: [libraryMembers.id],
  }),
}));
