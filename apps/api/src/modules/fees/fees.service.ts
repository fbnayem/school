/**
 * Fee service (Phase 11).
 *
 * This is where the product touches money, so a few rules are absolute and every method below
 * is written to keep them:
 *
 *  1. **No floating point, anywhere.** A monetary column is `numeric(14, 2)`, the driver hands
 *     it back as a string, and `Money.fromDecimalString` is the only thing in this file that
 *     parses one. Writes go back through `Money.toDecimalString`. There is no `Number(...)` on
 *     a money column and no arithmetic outside `Money` (ADR-004).
 *  2. **Proportional splits use `Money.allocate`.** It distributes the remainder by largest
 *     remainder, so the parts always sum back to the whole. Dividing and rounding each part
 *     independently invents or loses poisa, and an accounting system eventually notices.
 *  3. **Derived facts are derived here, never accepted from a client.** An invoice's `total`
 *     comes from its lines, its `balance` from `total - paid_total`, and its `status` from
 *     `paid_total` against `total`. The database restates all three as check constraints, so a
 *     mistake in this file fails the write rather than corrupting the ledger.
 *  4. **Nothing is deleted.** An invoice with a payment against it cannot be voided — it is
 *     credited. A payment is reversed, which archives its allocations and recomputes the
 *     affected invoices in the same transaction.
 *  5. **The financially significant mutations write their audit record inside the business
 *     transaction**, through `AuditService.recordInTransaction`. The route-level `@Audited`
 *     interceptor also records the HTTP action, but that record is written after the response
 *     and would survive a rollback; for a payment, a reversal or a void, the trail has to roll
 *     back with the money.
 */

import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  gte,
  ilike,
  inArray,
  isNull,
  like,
  lt,
  lte,
  ne,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import {
  academicYears,
  campuses,
  classLevels,
  enrollments,
  feeConcessions,
  feeHeads,
  feeStructureItems,
  feeStructures,
  invoiceLines,
  invoices,
  paymentAllocations,
  payments,
  sections,
  studentFeeAssignments,
  studentGuardians,
  students,
} from '@shikkha/db';
import {
  addDays,
  buildOffsetPage,
  calendarDate,
  compareCalendarDates,
  ConflictError,
  endOfDhakaDay,
  ForbiddenError,
  instantToDhakaDate,
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
  FEE_CONCESSION_SORT_FIELDS,
  FEE_HEAD_SORT_FIELDS,
  FEE_STRUCTURE_SORT_FIELDS,
  INVOICE_SORT_FIELDS,
  PAYMENT_SORT_FIELDS,
} from '@shikkha/validation';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { currentContext } from '../../common/context/request-context';

/** The transaction handle `runInTenant` hands to its callback. */
type Tx = Parameters<Parameters<DatabaseService['runInTenant']>[0]>[0];

type FeeHeadRow = typeof feeHeads.$inferSelect;
type FeeStructureRow = typeof feeStructures.$inferSelect;
type FeeStructureItemRow = typeof feeStructureItems.$inferSelect;
type FeeConcessionRow = typeof feeConcessions.$inferSelect;
type InvoiceRow = typeof invoices.$inferSelect;
type PaymentRow = typeof payments.$inferSelect;

/**
 * Invoices and payments are row-scoped the same way students are: the permission decides
 * *which* filter, never *whether* to filter. A guardian holding `finance.own.view` sees the
 * invoices of the children they have a live, portal-enabled link to, and nothing else.
 *
 * Declared locally rather than added to `SCOPED_RESOURCES` because this module owns the
 * mapping and the shared table is edited by every phase at once.
 */
const FINANCE_SCOPE: ScopedResourcePermissions = {
  all: 'finance.invoices.view',
  own: 'finance.own.view',
};

export interface ListFeeHeadsQuery {
  page: number;
  pageSize: number;
  sort?: string;
  q?: string;
  type?: string;
  includeArchived: boolean;
}

export interface ListFeeStructuresQuery {
  page: number;
  pageSize: number;
  sort?: string;
  q?: string;
  academicYearId?: string;
  classLevelId?: string;
  campusId?: string;
  status?: string;
  includeArchived: boolean;
}

export interface ListConcessionsQuery {
  page: number;
  pageSize: number;
  sort?: string;
  studentId?: string;
  feeHeadId?: string;
  status?: string;
  includeArchived: boolean;
}

export interface ListInvoicesQuery {
  page: number;
  pageSize: number;
  sort?: string;
  q?: string;
  studentId?: string;
  academicYearId?: string;
  sectionId?: string;
  classLevelId?: string;
  status?: string;
  outstandingOnly: boolean;
  dueFrom?: string;
  dueTo?: string;
  includeArchived: boolean;
}

export interface ListPaymentsQuery {
  page: number;
  pageSize: number;
  sort?: string;
  q?: string;
  studentId?: string;
  method?: string;
  status?: string;
  receivedFrom?: string;
  receivedTo?: string;
  includeArchived: boolean;
}

export interface GenerateInvoicesInput {
  academicYearId: string;
  sectionId?: string;
  classLevelId?: string;
  studentIds?: string[];
  billingPeriodStart: string;
  billingPeriodEnd: string;
  issueDate: string;
  dueDate: string;
  frequencies: string[];
  includeOptional: boolean;
  notes?: string;
}

export interface RecordPaymentInput {
  studentId: string;
  amount: string;
  method: string;
  reference?: string;
  receivedAt?: string;
  notes?: string;
  strategy: 'oldest_due_first' | 'proportional';
  allocations?: Array<{ invoiceId: string; amount: string }>;
}

export interface ApplyLateFinesInput {
  academicYearId: string;
  fineFeeHeadId: string;
  asOfDate?: string;
  sectionId?: string;
  classLevelId?: string;
  invoiceIds?: string[];
  reason: string;
}

/** One line of a generated invoice, before it is written. Amounts are decimal strings. */
interface PreparedLine {
  feeHeadId: string;
  description: string;
  amount: string;
  discountAmount: string;
  netAmount: string;
  concessionId: string | null;
  sortOrder: number;
}

export interface PreparedInvoice {
  studentId: string;
  studentName: string;
  feeStructureId: string;
  generationKey: string;
  subtotal: string;
  discountTotal: string;
  total: string;
  lines: PreparedLine[];
}

export interface SkippedStudent {
  studentId: string;
  studentName: string;
  reason: string;
  existingInvoiceId?: string;
}

/**
 * One row of the outstanding-dues report. `sectionId` is null when the report is rolled up to
 * the class, which is why both shapes are declared as one type rather than inferred.
 */
export interface OutstandingDuesRow {
  classLevelId: string;
  classLevelName: string;
  classOrdinal: number;
  sectionId: string | null;
  sectionName: string | null;
  studentCount: number;
  invoiceCount: number;
  billed: string;
  collected: string;
  outstanding: string;
}

@Injectable()
export class FeesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════════════
  // Fee heads
  // ══════════════════════════════════════════════════════════════════════════════════

  async listFeeHeads(
    principal: Principal,
    institutionId: string,
    query: ListFeeHeadsQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<FeeHeadRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(feeHeads.institutionId, institutionId)];
      this.applyArchiveFilter(principal, filters, feeHeads.archivedAt, query.includeArchived);
      if (query.type) filters.push(eq(feeHeads.type, query.type as FeeHeadRow['type']));
      if (query.q) {
        filters.push(
          or(ilike(feeHeads.nameEn, `%${query.q}%`), ilike(feeHeads.code, `${query.q}%`))!,
        );
      }

      const where = and(...filters);
      const orderBy = parseSort(query.sort, FEE_HEAD_SORT_FIELDS, {
        field: 'sortOrder',
        direction: 'asc',
      }).map((spec) => {
        const column = FEE_HEAD_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(feeHeads)
        .where(where)
        .orderBy(...orderBy, asc(feeHeads.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(feeHeads)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async createFeeHead(
    principal: Principal,
    institutionId: string,
    input: Record<string, unknown>,
  ): Promise<FeeHeadRow> {
    return this.db.runInTenant(async (tx) => {
      const [created] = await tx
        .insert(feeHeads)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          code: input['code'] as string,
          nameEn: input['nameEn'] as string,
          nameBn: (input['nameBn'] as string) ?? null,
          type: input['type'] as FeeHeadRow['type'],
          isRecurring: input['isRecurring'] as boolean,
          isRefundable: input['isRefundable'] as boolean,
          ledgerAccountCode: (input['ledgerAccountCode'] as string) ?? null,
          description: (input['description'] as string) ?? null,
          sortOrder: input['sortOrder'] as number,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  async updateFeeHead(
    principal: Principal,
    institutionId: string,
    id: string,
    input: Record<string, unknown>,
  ): Promise<{ feeHead: FeeHeadRow; previous: Partial<FeeHeadRow> }> {
    const version = input['version'] as number;
    const { version: _ignored, ...changes } = input;

    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(feeHeads)
        .where(
          and(
            eq(feeHeads.id, id),
            eq(feeHeads.institutionId, institutionId),
            isNull(feeHeads.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Fee head', id);

      const [updated] = await tx
        .update(feeHeads)
        .set({
          ...(changes as Partial<FeeHeadRow>),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(feeHeads.id, id), eq(feeHeads.version, version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This fee head was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      return { feeHead: updated, previous: diffOf(existing, updated, Object.keys(changes)) };
    });
  }

  async archiveFeeHead(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<FeeHeadRow> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(feeHeads)
        .where(
          and(
            eq(feeHeads.id, id),
            eq(feeHeads.institutionId, institutionId),
            isNull(feeHeads.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Fee head', id);

      // A head still on a live price list would leave the structure charging something the
      // school can no longer see or explain. Remove it from the structure first.
      const [inUse] = await tx
        .select({ id: feeStructureItems.id })
        .from(feeStructureItems)
        .where(and(eq(feeStructureItems.feeHeadId, id), isNull(feeStructureItems.archivedAt)))
        .limit(1);
      if (inUse) {
        throw new ConflictError(
          'This fee head is still used by a fee structure. Remove it from the structure first, then archive it.',
        );
      }

      const [archived] = await tx
        .update(feeHeads)
        .set({
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(eq(feeHeads.id, id))
        .returning();
      return archived!;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Fee structures
  // ══════════════════════════════════════════════════════════════════════════════════

  async listFeeStructures(
    principal: Principal,
    institutionId: string,
    query: ListFeeStructuresQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<FeeStructureRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(feeStructures.institutionId, institutionId)];
      this.applyArchiveFilter(principal, filters, feeStructures.archivedAt, query.includeArchived);
      if (query.academicYearId) {
        filters.push(eq(feeStructures.academicYearId, query.academicYearId));
      }
      if (query.classLevelId) filters.push(eq(feeStructures.classLevelId, query.classLevelId));
      if (query.campusId) filters.push(eq(feeStructures.campusId, query.campusId));
      if (query.status) {
        filters.push(eq(feeStructures.status, query.status as FeeStructureRow['status']));
      }
      if (query.q) filters.push(ilike(feeStructures.nameEn, `%${query.q}%`));

      const where = and(...filters);
      const orderBy = parseSort(query.sort, FEE_STRUCTURE_SORT_FIELDS, {
        field: 'effectiveFrom',
        direction: 'desc',
      }).map((spec) => {
        const column = FEE_STRUCTURE_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(feeStructures)
        .where(where)
        .orderBy(...orderBy, asc(feeStructures.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(feeStructures)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async getFeeStructure(
    institutionId: string,
    id: string,
  ): Promise<FeeStructureRow & { items: FeeStructureItemRow[] }> {
    return this.db.runInTenant(async (tx) => {
      const [structure] = await tx
        .select()
        .from(feeStructures)
        .where(and(eq(feeStructures.id, id), eq(feeStructures.institutionId, institutionId)))
        .limit(1);
      if (!structure) throw new NotFoundError('Fee structure', id);

      const items = await tx
        .select()
        .from(feeStructureItems)
        .where(and(eq(feeStructureItems.feeStructureId, id), isNull(feeStructureItems.archivedAt)))
        .orderBy(asc(feeStructureItems.sortOrder), asc(feeStructureItems.id));

      return { ...structure, items };
    });
  }

  async createFeeStructure(
    principal: Principal,
    institutionId: string,
    input: Record<string, unknown>,
  ): Promise<FeeStructureRow> {
    return this.db.runInTenant(async (tx) => {
      const academicYearId = input['academicYearId'] as string;
      const campusId = input['campusId'] as string;
      const classLevelId = (input['classLevelId'] as string) ?? null;

      // Each parent is checked against *this* institution, not merely against the tenant. A
      // group administrator switching schools must not be able to hang School A's price list
      // off School B's academic year.
      const [year] = await tx
        .select({ id: academicYears.id })
        .from(academicYears)
        .where(
          and(
            eq(academicYears.id, academicYearId),
            eq(academicYears.institutionId, institutionId),
            isNull(academicYears.archivedAt),
          ),
        )
        .limit(1);
      if (!year) throw new NotFoundError('Academic year', academicYearId);

      const [campus] = await tx
        .select({ id: campuses.id })
        .from(campuses)
        .where(
          and(
            eq(campuses.id, campusId),
            eq(campuses.institutionId, institutionId),
            isNull(campuses.archivedAt),
          ),
        )
        .limit(1);
      if (!campus) throw new NotFoundError('Campus', campusId);

      if (classLevelId) {
        const [classLevel] = await tx
          .select({ id: classLevels.id })
          .from(classLevels)
          .where(
            and(
              eq(classLevels.id, classLevelId),
              eq(classLevels.institutionId, institutionId),
              isNull(classLevels.archivedAt),
            ),
          )
          .limit(1);
        if (!classLevel) throw new NotFoundError('Class level', classLevelId);
      }

      const [created] = await tx
        .insert(feeStructures)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          campusId,
          academicYearId,
          classLevelId,
          academicGroupId: (input['academicGroupId'] as string) ?? null,
          nameEn: input['nameEn'] as string,
          nameBn: (input['nameBn'] as string) ?? null,
          status: 'draft',
          effectiveFrom: input['effectiveFrom'] as string,
          lateFineKind: input['lateFineKind'] as string,
          // Normalised through Money so the stored string always carries two decimals.
          lateFineValue: Money.fromDecimalString(
            (input['lateFineValue'] as string) ?? '0.00',
          ).toDecimalString(),
          lateFineGraceDays: input['lateFineGraceDays'] as number,
          lateFineMaxAmount: input['lateFineMaxAmount']
            ? Money.fromDecimalString(input['lateFineMaxAmount'] as string).toDecimalString()
            : null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  async updateFeeStructure(
    principal: Principal,
    institutionId: string,
    id: string,
    input: Record<string, unknown>,
  ): Promise<{ structure: FeeStructureRow; previous: Partial<FeeStructureRow> }> {
    const version = input['version'] as number;
    const { version: _ignored, ...changes } = input;

    if (typeof changes['lateFineValue'] === 'string') {
      changes['lateFineValue'] = Money.fromDecimalString(
        changes['lateFineValue'],
      ).toDecimalString();
    }
    if (typeof changes['lateFineMaxAmount'] === 'string') {
      changes['lateFineMaxAmount'] = Money.fromDecimalString(
        changes['lateFineMaxAmount'],
      ).toDecimalString();
    }

    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(feeStructures)
        .where(
          and(
            eq(feeStructures.id, id),
            eq(feeStructures.institutionId, institutionId),
            isNull(feeStructures.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Fee structure', id);

      const [updated] = await tx
        .update(feeStructures)
        .set({
          ...(changes as Partial<FeeStructureRow>),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(feeStructures.id, id), eq(feeStructures.version, version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This fee structure was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      return { structure: updated, previous: diffOf(existing, updated, Object.keys(changes)) };
    });
  }

  /**
   * Replace a structure's items as a complete set.
   *
   * Items that disappear from the submitted list are archived rather than deleted, so an
   * invoice raised last month still resolves the head it charged. A structure that has already
   * been invoiced against may still be edited — next month's bill changes, last month's does
   * not, because an invoice carries its own line amounts.
   */
  async replaceFeeStructureItems(
    principal: Principal,
    institutionId: string,
    structureId: string,
    incoming: Array<{
      id?: string;
      feeHeadId: string;
      amount: string;
      frequency: string;
      dueDayOfMonth?: number;
      isOptional: boolean;
      sortOrder: number;
    }>,
  ): Promise<{ structure: FeeStructureRow; items: FeeStructureItemRow[] }> {
    return this.db.runInTenant(async (tx) => {
      const [structure] = await tx
        .select()
        .from(feeStructures)
        .where(
          and(
            eq(feeStructures.id, structureId),
            eq(feeStructures.institutionId, institutionId),
            isNull(feeStructures.archivedAt),
          ),
        )
        .limit(1);
      if (!structure) throw new NotFoundError('Fee structure', structureId);

      // Every head must exist in this institution. Checked as a set rather than one at a
      // time so a 40-line price list produces one error listing what is wrong.
      const headIds = [...new Set(incoming.map((item) => item.feeHeadId))];
      if (headIds.length > 0) {
        const known = await tx
          .select({ id: feeHeads.id })
          .from(feeHeads)
          .where(
            and(
              inArray(feeHeads.id, headIds),
              eq(feeHeads.institutionId, institutionId),
              isNull(feeHeads.archivedAt),
            ),
          );
        const knownIds = new Set(known.map((row) => row.id));
        const unknown = headIds.filter((id) => !knownIds.has(id));
        if (unknown.length > 0) {
          throw new ValidationError('Some fee heads do not exist in this institution', [
            { path: 'items', message: `Unknown fee heads: ${unknown.join(', ')}` },
          ]);
        }
      }

      const existing = await tx
        .select()
        .from(feeStructureItems)
        .where(
          and(
            eq(feeStructureItems.feeStructureId, structureId),
            isNull(feeStructureItems.archivedAt),
          ),
        );

      const incomingIds = new Set(incoming.map((item) => item.id).filter(Boolean) as string[]);
      const removed = existing.filter((item) => !incomingIds.has(item.id));

      for (const item of removed) {
        await tx
          .update(feeStructureItems)
          .set({
            archivedAt: new Date(),
            archivedBy: principal.userId,
            archiveReason: 'Removed when the fee structure was edited',
            updatedBy: principal.userId,
          })
          .where(eq(feeStructureItems.id, item.id));
      }

      for (const item of incoming) {
        const amount = Money.fromDecimalString(item.amount).toDecimalString();
        if (item.id && existing.some((row) => row.id === item.id)) {
          await tx
            .update(feeStructureItems)
            .set({
              feeHeadId: item.feeHeadId,
              amount,
              frequency: item.frequency as FeeStructureItemRow['frequency'],
              dueDayOfMonth: item.dueDayOfMonth ?? null,
              isOptional: item.isOptional,
              sortOrder: item.sortOrder,
              updatedBy: principal.userId,
            })
            .where(eq(feeStructureItems.id, item.id));
        } else {
          await tx.insert(feeStructureItems).values({
            id: uuidv7(),
            tenantId: principal.tenantId!,
            institutionId,
            feeStructureId: structureId,
            feeHeadId: item.feeHeadId,
            amount,
            frequency: item.frequency as FeeStructureItemRow['frequency'],
            dueDayOfMonth: item.dueDayOfMonth ?? null,
            isOptional: item.isOptional,
            sortOrder: item.sortOrder,
            createdBy: principal.userId,
            updatedBy: principal.userId,
          });
        }
      }

      const items = await tx
        .select()
        .from(feeStructureItems)
        .where(
          and(
            eq(feeStructureItems.feeStructureId, structureId),
            isNull(feeStructureItems.archivedAt),
          ),
        )
        .orderBy(asc(feeStructureItems.sortOrder), asc(feeStructureItems.id));

      return { structure, items };
    });
  }

  async archiveFeeStructure(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<FeeStructureRow> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(feeStructures)
        .where(
          and(
            eq(feeStructures.id, id),
            eq(feeStructures.institutionId, institutionId),
            isNull(feeStructures.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Fee structure', id);

      const [archived] = await tx
        .update(feeStructures)
        .set({
          status: 'archived',
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(eq(feeStructures.id, id))
        .returning();
      return archived!;
    });
  }

  /**
   * Assign one structure to many students.
   *
   * Idempotent by construction: an existing live assignment for the same student, year and
   * start date is updated rather than duplicated, so pressing the button twice at the start of
   * the year does not produce two competing price lists for one child.
   */
  async assignFeeStructure(
    principal: Principal,
    institutionId: string,
    input: {
      feeStructureId: string;
      academicYearId: string;
      studentIds: string[];
      effectiveFrom: string;
      effectiveTo?: string;
      note?: string;
    },
  ): Promise<{ assigned: number; updated: number; skipped: SkippedStudent[] }> {
    return this.db.runInTenant(async (tx) => {
      const [structure] = await tx
        .select()
        .from(feeStructures)
        .where(
          and(
            eq(feeStructures.id, input.feeStructureId),
            eq(feeStructures.institutionId, institutionId),
            isNull(feeStructures.archivedAt),
          ),
        )
        .limit(1);
      if (!structure) throw new NotFoundError('Fee structure', input.feeStructureId);
      if (structure.academicYearId !== input.academicYearId) {
        throw new ValidationError('That structure belongs to a different academic year', [
          {
            path: 'feeStructureId',
            message: 'The structure is not part of the selected academic year',
          },
        ]);
      }

      const known = await tx
        .select({ id: students.id, name: students.fullNameEn })
        .from(students)
        .where(
          and(
            inArray(students.id, input.studentIds),
            eq(students.institutionId, institutionId),
            isNull(students.archivedAt),
          ),
        );
      const knownById = new Map(known.map((row) => [row.id, row.name]));

      const skipped: SkippedStudent[] = [];
      let assigned = 0;
      let updated = 0;

      for (const studentId of input.studentIds) {
        const name = knownById.get(studentId);
        if (!name) {
          skipped.push({
            studentId,
            studentName: 'unknown',
            reason: 'No such student in this institution',
          });
          continue;
        }

        const [existing] = await tx
          .select()
          .from(studentFeeAssignments)
          .where(
            and(
              eq(studentFeeAssignments.studentId, studentId),
              eq(studentFeeAssignments.academicYearId, input.academicYearId),
              eq(studentFeeAssignments.effectiveFrom, input.effectiveFrom),
              isNull(studentFeeAssignments.archivedAt),
            ),
          )
          .limit(1);

        if (existing) {
          await tx
            .update(studentFeeAssignments)
            .set({
              feeStructureId: input.feeStructureId,
              effectiveTo: input.effectiveTo ?? null,
              note: input.note ?? null,
              updatedBy: principal.userId,
              version: existing.version + 1,
            })
            .where(eq(studentFeeAssignments.id, existing.id));
          updated += 1;
          continue;
        }

        await tx.insert(studentFeeAssignments).values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          studentId,
          feeStructureId: input.feeStructureId,
          academicYearId: input.academicYearId,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo ?? null,
          note: input.note ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        });
        assigned += 1;
      }

      return { assigned, updated, skipped };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Concessions
  // ══════════════════════════════════════════════════════════════════════════════════

  async listConcessions(
    principal: Principal,
    institutionId: string,
    query: ListConcessionsQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<FeeConcessionRow>> {
    const scope = this.requireFinanceScope(principal);

    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [
        eq(feeConcessions.institutionId, institutionId),
        this.studentScopeFilter(principal, scope, feeConcessions.studentId),
      ];
      this.applyArchiveFilter(principal, filters, feeConcessions.archivedAt, query.includeArchived);
      if (query.studentId) filters.push(eq(feeConcessions.studentId, query.studentId));
      if (query.feeHeadId) filters.push(eq(feeConcessions.feeHeadId, query.feeHeadId));
      if (query.status) {
        filters.push(eq(feeConcessions.status, query.status as FeeConcessionRow['status']));
      }

      const where = and(...filters);
      const orderBy = parseSort(query.sort, FEE_CONCESSION_SORT_FIELDS, {
        field: 'createdAt',
        direction: 'desc',
      }).map((spec) => {
        const column = FEE_CONCESSION_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(feeConcessions)
        .where(where)
        .orderBy(...orderBy, asc(feeConcessions.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(feeConcessions)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  /** A concession is always created `pending`. Only an approver can move it. */
  async createConcession(
    principal: Principal,
    institutionId: string,
    input: {
      studentId: string;
      feeHeadId?: string;
      type: 'percentage' | 'fixed';
      value: string;
      reason: string;
      validFrom: string;
      validTo?: string;
    },
  ): Promise<FeeConcessionRow> {
    return this.db.runInTenant(async (tx) => {
      const [student] = await tx
        .select({ id: students.id })
        .from(students)
        .where(
          and(
            eq(students.id, input.studentId),
            eq(students.institutionId, institutionId),
            isNull(students.archivedAt),
          ),
        )
        .limit(1);
      if (!student) throw new NotFoundError('Student', input.studentId);

      if (input.feeHeadId) {
        const [head] = await tx
          .select({ id: feeHeads.id })
          .from(feeHeads)
          .where(
            and(
              eq(feeHeads.id, input.feeHeadId),
              eq(feeHeads.institutionId, institutionId),
              isNull(feeHeads.archivedAt),
            ),
          )
          .limit(1);
        if (!head) throw new NotFoundError('Fee head', input.feeHeadId);
      } else {
        // Postgres treats NULLs as distinct, so the partial unique index cannot catch two
        // "every head" concessions of the same kind starting on the same day. Refused here.
        const [duplicate] = await tx
          .select({ id: feeConcessions.id })
          .from(feeConcessions)
          .where(
            and(
              eq(feeConcessions.studentId, input.studentId),
              isNull(feeConcessions.feeHeadId),
              eq(feeConcessions.type, input.type),
              eq(feeConcessions.validFrom, input.validFrom),
              ne(feeConcessions.status, 'rejected'),
              isNull(feeConcessions.archivedAt),
            ),
          )
          .limit(1);
        if (duplicate) {
          throw new ConflictError(
            'This student already has a concession covering every fee head from that date.',
            { existingConcessionId: duplicate.id },
          );
        }
      }

      const [created] = await tx
        .insert(feeConcessions)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          studentId: input.studentId,
          feeHeadId: input.feeHeadId ?? null,
          type: input.type,
          value: Money.fromDecimalString(input.value).toDecimalString(),
          reason: input.reason,
          status: 'pending',
          validFrom: input.validFrom,
          validTo: input.validTo ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  /**
   * Approve or reject a concession.
   *
   * The requester cannot be the approver. That is the whole point of `finance.discounts.manage`
   * and `finance.discounts.approve` being separate permissions — a single person who can both
   * raise and grant a waiver is an unreviewed reduction in what a family pays.
   *
   * The audit record is written inside the transaction: an approval that rolled back must not
   * leave a record saying it happened.
   */
  async decideConcession(
    principal: Principal,
    institutionId: string,
    id: string,
    decision: 'approved' | 'rejected',
    reason: string,
  ): Promise<FeeConcessionRow> {
    const context = currentContext();

    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(feeConcessions)
        .where(
          and(
            eq(feeConcessions.id, id),
            eq(feeConcessions.institutionId, institutionId),
            isNull(feeConcessions.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Fee concession', id);

      if (existing.status !== 'pending') {
        throw new ConflictError(
          `This concession has already been ${existing.status}. Raise a new request instead.`,
          { currentStatus: existing.status },
        );
      }

      if (existing.createdBy && existing.createdBy === principal.userId) {
        throw new ConflictError(
          'A concession must be approved by someone other than the person who requested it.',
        );
      }

      const now = new Date();
      const [updated] = await tx
        .update(feeConcessions)
        .set({
          status: decision,
          approvedBy: decision === 'approved' ? principal.userId : null,
          approvedAt: decision === 'approved' ? now : null,
          decisionNote: reason,
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(eq(feeConcessions.id, id))
        .returning();

      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: decision === 'approved' ? 'approve' : 'reject',
        module: 'fees',
        resourceType: 'fee_concession',
        resourceId: id,
        previousValue: { status: existing.status },
        // Money as a string, never a number — an audit record read back as a float would be
        // a worse lie than no record at all.
        newValue: {
          status: decision,
          type: existing.type,
          value: existing.value,
          studentId: existing.studentId,
          feeHeadId: existing.feeHeadId,
        },
        reason,
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      return updated!;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Invoice generation
  // ══════════════════════════════════════════════════════════════════════════════════

  /**
   * Generate invoices for a section, a class or an explicit list of students.
   *
   * Preview and commit run exactly the same code with `commit` flipped, so what an accountant
   * approves on screen is what is written.
   *
   * Idempotency is enforced twice, and the second one is the one that counts: the run skips a
   * student who already has a live invoice carrying the same `generation_key`, and the partial
   * unique index on `(institution_id, generation_key)` refuses a duplicate even if two runs
   * race. Re-running a month is therefore safe rather than a double-billed family.
   */
  async generateInvoices(
    principal: Principal,
    institutionId: string,
    input: GenerateInvoicesInput,
    options: { commit: boolean },
  ): Promise<{
    committed: boolean;
    invoices: Array<PreparedInvoice & { id?: string; invoiceNumber?: string }>;
    skipped: SkippedStudent[];
    totals: { invoiceCount: number; subtotal: string; discountTotal: string; total: string };
  }> {
    const context = currentContext();

    return this.db.runInTenant(async (tx) => {
      const [year] = await tx
        .select()
        .from(academicYears)
        .where(
          and(
            eq(academicYears.id, input.academicYearId),
            eq(academicYears.institutionId, institutionId),
            isNull(academicYears.archivedAt),
          ),
        )
        .limit(1);
      if (!year) throw new NotFoundError('Academic year', input.academicYearId);

      const targets = await this.resolveTargetStudents(tx, institutionId, input);

      const prepared: Array<PreparedInvoice & { id?: string; invoiceNumber?: string }> = [];
      const skipped: SkippedStudent[] = [];

      const itemCache = new Map<string, FeeStructureItemRow[]>();
      const wanted = new Set(input.frequencies);

      // Head names are read once for the whole run so an invoice line says "Tuition
      // (monthly)" rather than a uuid. There are tens of heads per institution, not
      // thousands, so this is one query rather than one per line.
      const headRows = await tx
        .select({ id: feeHeads.id, nameEn: feeHeads.nameEn })
        .from(feeHeads)
        .where(eq(feeHeads.institutionId, institutionId));
      const headNames = new Map(headRows.map((row) => [row.id, row.nameEn]));

      for (const target of targets) {
        const structure = await this.resolveStructureFor(tx, {
          institutionId,
          academicYearId: input.academicYearId,
          studentId: target.studentId,
          classLevelId: target.classLevelId,
          academicGroupId: target.groupId,
          onDate: input.billingPeriodStart,
        });

        if (!structure) {
          skipped.push({
            studentId: target.studentId,
            studentName: target.studentName,
            reason: 'No active fee structure applies to this student for that period',
          });
          continue;
        }

        let items = itemCache.get(structure.id);
        if (!items) {
          items = await tx
            .select()
            .from(feeStructureItems)
            .where(
              and(
                eq(feeStructureItems.feeStructureId, structure.id),
                isNull(feeStructureItems.archivedAt),
              ),
            )
            .orderBy(asc(feeStructureItems.sortOrder), asc(feeStructureItems.id));
          itemCache.set(structure.id, items);
        }

        const billable = items.filter(
          (item) => wanted.has(item.frequency) && (input.includeOptional || !item.isOptional),
        );
        if (billable.length === 0) {
          skipped.push({
            studentId: target.studentId,
            studentName: target.studentName,
            reason: 'The applicable fee structure has no items at the requested frequency',
          });
          continue;
        }

        const generationKey = buildGenerationKey(
          input.academicYearId,
          target.studentId,
          input.billingPeriodStart,
          input.billingPeriodEnd,
        );

        const [duplicate] = await tx
          .select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber })
          .from(invoices)
          .where(
            and(
              eq(invoices.institutionId, institutionId),
              eq(invoices.generationKey, generationKey),
              ne(invoices.status, 'void'),
              isNull(invoices.archivedAt),
            ),
          )
          .limit(1);
        if (duplicate) {
          skipped.push({
            studentId: target.studentId,
            studentName: target.studentName,
            reason: 'Already invoiced for this billing period',
            existingInvoiceId: duplicate.id,
          });
          continue;
        }

        const concessions = await this.loadApprovedConcessions(
          tx,
          target.studentId,
          input.billingPeriodStart,
        );

        const lines: PreparedLine[] = [];
        let subtotal = Money.zero();
        let discountTotal = Money.zero();

        for (const item of billable) {
          const gross = Money.fromDecimalString(item.amount);
          const applied = applyConcessions(gross, concessions, item.feeHeadId);
          const net = gross.minus(applied.discount);

          subtotal = subtotal.plus(gross);
          discountTotal = discountTotal.plus(applied.discount);

          lines.push({
            feeHeadId: item.feeHeadId,
            description: describeItem(item, headNames.get(item.feeHeadId)),
            amount: gross.toDecimalString(),
            discountAmount: applied.discount.toDecimalString(),
            netAmount: net.toDecimalString(),
            concessionId: applied.concessionId,
            sortOrder: item.sortOrder,
          });
        }

        prepared.push({
          studentId: target.studentId,
          studentName: target.studentName,
          feeStructureId: structure.id,
          generationKey,
          subtotal: subtotal.toDecimalString(),
          discountTotal: discountTotal.toDecimalString(),
          total: subtotal.minus(discountTotal).toDecimalString(),
          lines,
        });
      }

      if (options.commit && prepared.length > 0) {
        const year4 = input.issueDate.slice(0, 4);
        let sequence = await this.currentInvoiceSequence(tx, institutionId, `INV-${year4}-`);

        for (const draft of prepared) {
          sequence += 1;
          const invoiceNumber = `INV-${year4}-${String(sequence).padStart(6, '0')}`;
          const invoiceId = uuidv7();
          const total = Money.fromDecimalString(draft.total);

          await tx.insert(invoices).values({
            id: invoiceId,
            tenantId: principal.tenantId!,
            institutionId,
            studentId: draft.studentId,
            academicYearId: input.academicYearId,
            feeStructureId: draft.feeStructureId,
            invoiceNumber,
            generationKey: draft.generationKey,
            billingPeriodStart: input.billingPeriodStart,
            billingPeriodEnd: input.billingPeriodEnd,
            issueDate: input.issueDate,
            dueDate: input.dueDate,
            subtotal: draft.subtotal,
            discountTotal: draft.discountTotal,
            fineTotal: '0.00',
            total: draft.total,
            paidTotal: '0.00',
            balance: total.toDecimalString(),
            // Derived even at creation, so a bill raised after its own due date is `overdue`
            // from the first moment rather than until something else recomputes it.
            status: deriveInvoiceStatus(total, Money.zero(), input.dueDate, todayInDhaka()),
            notes: input.notes ?? null,
            createdBy: principal.userId,
            updatedBy: principal.userId,
          });

          for (const line of draft.lines) {
            await tx.insert(invoiceLines).values({
              id: uuidv7(),
              tenantId: principal.tenantId!,
              institutionId,
              invoiceId,
              feeHeadId: line.feeHeadId,
              description: line.description,
              amount: line.amount,
              discountAmount: line.discountAmount,
              netAmount: line.netAmount,
              concessionId: line.concessionId,
              isFine: false,
              sortOrder: line.sortOrder,
              createdBy: principal.userId,
              updatedBy: principal.userId,
            });
          }

          draft.id = invoiceId;
          draft.invoiceNumber = invoiceNumber;
        }
      }

      const totals = {
        invoiceCount: prepared.length,
        subtotal: sumDecimals(prepared.map((one) => one.subtotal)),
        discountTotal: sumDecimals(prepared.map((one) => one.discountTotal)),
        total: sumDecimals(prepared.map((one) => one.total)),
      };

      if (options.commit) {
        await this.audit.recordInTransaction(tx, {
          tenantId: principal.tenantId,
          institutionId,
          actorUserId: principal.userId,
          actorRoles: principal.roles.map((role) => role.roleKey),
          action: 'create',
          module: 'fees',
          resourceType: 'invoice_generation',
          resourceId: input.academicYearId,
          resourceLabel: `${input.billingPeriodStart} to ${input.billingPeriodEnd}`,
          newValue: {
            invoiceCount: totals.invoiceCount,
            subtotal: totals.subtotal,
            discountTotal: totals.discountTotal,
            total: totals.total,
            skippedCount: skipped.length,
            invoiceIds: prepared.map((one) => one.id).filter(Boolean),
          },
          requestId: context?.requestId ?? null,
          ipAddress: context?.ipAddress ?? null,
          userAgent: context?.userAgent ?? null,
        });
      }

      return { committed: options.commit, invoices: prepared, skipped, totals };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Invoices
  // ══════════════════════════════════════════════════════════════════════════════════

  async listInvoices(
    principal: Principal,
    institutionId: string,
    query: ListInvoicesQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<InvoiceRow>> {
    const scope = this.requireFinanceScope(principal);

    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [
        eq(invoices.institutionId, institutionId),
        this.studentScopeFilter(principal, scope, invoices.studentId),
      ];
      this.applyArchiveFilter(principal, filters, invoices.archivedAt, query.includeArchived);

      if (query.studentId) filters.push(eq(invoices.studentId, query.studentId));
      if (query.academicYearId) filters.push(eq(invoices.academicYearId, query.academicYearId));
      if (query.status) filters.push(eq(invoices.status, query.status as InvoiceRow['status']));
      if (query.outstandingOnly) {
        filters.push(gt(invoices.balance, '0.00'));
        filters.push(ne(invoices.status, 'void'));
      }
      if (query.dueFrom) filters.push(gte(invoices.dueDate, query.dueFrom));
      if (query.dueTo) filters.push(lte(invoices.dueDate, query.dueTo));
      if (query.q) filters.push(ilike(invoices.invoiceNumber, `${query.q}%`));

      const enrollmentFilter = this.enrollmentFilter(query.sectionId, query.classLevelId);
      if (enrollmentFilter) filters.push(enrollmentFilter);

      const where = and(...filters);
      const orderBy = parseSort(query.sort, INVOICE_SORT_FIELDS, {
        field: 'dueDate',
        direction: 'asc',
      }).map((spec) => {
        const column = INVOICE_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(invoices)
        .where(where)
        .orderBy(...orderBy, asc(invoices.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(invoices)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  /**
   * One invoice with its lines and the payments allocated to it.
   *
   * The scope filter is the same one `listInvoices` applies. Fetching by id is a list query
   * with `where id = ?` added, not a second code path that could forget the scope — which is
   * what keeps a guardian from reading another family's bill by guessing an id.
   */
  async getInvoice(principal: Principal, institutionId: string, id: string) {
    const scope = this.requireFinanceScope(principal);

    return this.db.runInTenant(async (tx) => {
      const [invoice] = await tx
        .select()
        .from(invoices)
        .where(
          and(
            eq(invoices.id, id),
            eq(invoices.institutionId, institutionId),
            this.studentScopeFilter(principal, scope, invoices.studentId),
          ),
        )
        .limit(1);
      if (!invoice) throw new NotFoundError('Invoice', id);

      const lines = await tx
        .select()
        .from(invoiceLines)
        .where(and(eq(invoiceLines.invoiceId, id), isNull(invoiceLines.archivedAt)))
        .orderBy(asc(invoiceLines.sortOrder), asc(invoiceLines.id));

      const allocations = await tx
        .select({
          allocationId: paymentAllocations.id,
          amount: paymentAllocations.amount,
          paymentId: payments.id,
          receiptNumber: payments.receiptNumber,
          method: payments.method,
          receivedAt: payments.receivedAt,
          paymentStatus: payments.status,
        })
        .from(paymentAllocations)
        .innerJoin(payments, eq(payments.id, paymentAllocations.paymentId))
        .where(and(eq(paymentAllocations.invoiceId, id), isNull(paymentAllocations.archivedAt)))
        .orderBy(asc(payments.receivedAt));

      return { ...invoice, lines, payments: allocations };
    });
  }

  /**
   * Void an invoice.
   *
   * Refused once any payment has been allocated to it. A bill that has been paid against
   * cannot be made to have never existed — the correction is a credit, which leaves both the
   * original document and the correction visible to an auditor.
   */
  async voidInvoice(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<InvoiceRow> {
    const context = currentContext();

    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(invoices)
        .where(
          and(
            eq(invoices.id, id),
            eq(invoices.institutionId, institutionId),
            isNull(invoices.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Invoice', id);

      if (existing.status === 'void') {
        throw new ConflictError('This invoice has already been voided.');
      }

      const [allocated] = await tx
        .select({ id: paymentAllocations.id })
        .from(paymentAllocations)
        .innerJoin(payments, eq(payments.id, paymentAllocations.paymentId))
        .where(
          and(
            eq(paymentAllocations.invoiceId, id),
            isNull(paymentAllocations.archivedAt),
            eq(payments.status, 'completed'),
          ),
        )
        .limit(1);

      if (allocated) {
        throw new ConflictError(
          'A payment has been allocated to this invoice, so it cannot be voided. Reverse the payment first, or issue a credit.',
        );
      }

      const [voided] = await tx
        .update(invoices)
        .set({
          status: 'void',
          voidedReason: reason,
          voidedBy: principal.userId,
          voidedAt: new Date(),
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(eq(invoices.id, id))
        .returning();

      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'archive',
        module: 'fees',
        resourceType: 'invoice',
        resourceId: id,
        resourceLabel: existing.invoiceNumber,
        previousValue: { status: existing.status, total: existing.total },
        newValue: { status: 'void', total: existing.total, balance: existing.balance },
        reason,
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      return voided!;
    });
  }

  /**
   * Apply late fines to overdue invoices.
   *
   * Deliberately an explicit endpoint rather than something computed on read. A fine is money
   * a family owes because somebody decided they owe it; deriving it lazily would mean the
   * amount shown depended on when the page was loaded, and nobody would be accountable for it.
   *
   * Re-running for the same `asOfDate` is a no-op: the fine line carries the assessment date in
   * its description and an existing one is skipped.
   */
  async applyLateFines(
    principal: Principal,
    institutionId: string,
    input: ApplyLateFinesInput,
  ): Promise<{
    asOfDate: string;
    applied: Array<{ invoiceId: string; invoiceNumber: string; fine: string; total: string }>;
    skipped: Array<{ invoiceId: string; reason: string }>;
    totalFined: string;
  }> {
    const context = currentContext();
    const asOf = input.asOfDate ?? (todayInDhaka() as string);

    return this.db.runInTenant(async (tx) => {
      const [fineHead] = await tx
        .select()
        .from(feeHeads)
        .where(
          and(
            eq(feeHeads.id, input.fineFeeHeadId),
            eq(feeHeads.institutionId, institutionId),
            isNull(feeHeads.archivedAt),
          ),
        )
        .limit(1);
      if (!fineHead) throw new NotFoundError('Fee head', input.fineFeeHeadId);
      if (fineHead.type !== 'fine') {
        throw new ValidationError('Late fines must be charged to a fee head of type "fine"', [
          { path: 'fineFeeHeadId', message: 'Choose a fee head whose type is "fine"' },
        ]);
      }

      const filters: SQL[] = [
        eq(invoices.institutionId, institutionId),
        eq(invoices.academicYearId, input.academicYearId),
        isNull(invoices.archivedAt),
        ne(invoices.status, 'void'),
        gt(invoices.balance, '0.00'),
        lt(invoices.dueDate, asOf),
      ];
      if (input.invoiceIds && input.invoiceIds.length > 0) {
        filters.push(inArray(invoices.id, input.invoiceIds));
      }
      const enrollmentFilter = this.enrollmentFilter(input.sectionId, input.classLevelId);
      if (enrollmentFilter) filters.push(enrollmentFilter);

      const candidates = await tx
        .select()
        .from(invoices)
        .where(and(...filters))
        .orderBy(asc(invoices.dueDate), asc(invoices.invoiceNumber));

      const applied: Array<{
        invoiceId: string;
        invoiceNumber: string;
        fine: string;
        total: string;
      }> = [];
      const skipped: Array<{ invoiceId: string; reason: string }> = [];
      const structureCache = new Map<string, FeeStructureRow | null>();
      let totalFined = Money.zero();
      const description = `Late fine assessed on ${asOf}`;

      for (const invoice of candidates) {
        if (!invoice.feeStructureId) {
          skipped.push({ invoiceId: invoice.id, reason: 'No fee structure carries a fine rule' });
          continue;
        }

        let structure = structureCache.get(invoice.feeStructureId);
        if (structure === undefined) {
          const [found] = await tx
            .select()
            .from(feeStructures)
            .where(eq(feeStructures.id, invoice.feeStructureId))
            .limit(1);
          structure = found ?? null;
          structureCache.set(invoice.feeStructureId, structure);
        }

        if (!structure || structure.lateFineKind === 'none') {
          skipped.push({ invoiceId: invoice.id, reason: 'The fee structure charges no late fine' });
          continue;
        }

        const graceEnd = addDays(calendarDate(invoice.dueDate), structure.lateFineGraceDays);
        if (compareCalendarDates(calendarDate(asOf), graceEnd) <= 0) {
          skipped.push({ invoiceId: invoice.id, reason: 'Still within the grace period' });
          continue;
        }

        const [already] = await tx
          .select({ id: invoiceLines.id })
          .from(invoiceLines)
          .where(
            and(
              eq(invoiceLines.invoiceId, invoice.id),
              eq(invoiceLines.isFine, true),
              eq(invoiceLines.description, description),
              isNull(invoiceLines.archivedAt),
            ),
          )
          .limit(1);
        if (already) {
          skipped.push({ invoiceId: invoice.id, reason: 'Already fined for this date' });
          continue;
        }

        const balance = Money.fromDecimalString(invoice.balance);
        const ruleValue = Money.fromDecimalString(structure.lateFineValue);
        // A percentage is carried with two decimals, which in minor units *is* basis points:
        // "2.50" is 250 minor units and 250 basis points. No float is involved.
        let fine =
          structure.lateFineKind === 'percentage' ? balance.percentage(ruleValue.minor) : ruleValue;

        if (structure.lateFineMaxAmount) {
          fine = Money.min(fine, Money.fromDecimalString(structure.lateFineMaxAmount));
        }
        if (!fine.isPositive()) {
          skipped.push({ invoiceId: invoice.id, reason: 'The rule produced a zero fine' });
          continue;
        }

        await tx.insert(invoiceLines).values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          invoiceId: invoice.id,
          feeHeadId: fineHead.id,
          description,
          amount: fine.toDecimalString(),
          discountAmount: '0.00',
          netAmount: fine.toDecimalString(),
          isFine: true,
          sortOrder: 900,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        });

        const fineTotal = Money.fromDecimalString(invoice.fineTotal).plus(fine);
        const total = Money.fromDecimalString(invoice.subtotal)
          .minus(Money.fromDecimalString(invoice.discountTotal))
          .plus(fineTotal);
        const paid = Money.fromDecimalString(invoice.paidTotal);

        await tx
          .update(invoices)
          .set({
            fineTotal: fineTotal.toDecimalString(),
            total: total.toDecimalString(),
            balance: total.minus(paid).toDecimalString(),
            status: deriveInvoiceStatus(total, paid, invoice.dueDate, asOf),
            updatedBy: principal.userId,
            version: invoice.version + 1,
          })
          .where(eq(invoices.id, invoice.id));

        totalFined = totalFined.plus(fine);
        applied.push({
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          fine: fine.toDecimalString(),
          total: total.toDecimalString(),
        });
      }

      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'update',
        module: 'fees',
        resourceType: 'late_fine_run',
        resourceId: input.academicYearId,
        resourceLabel: `Late fines as of ${asOf}`,
        newValue: {
          asOfDate: asOf,
          fineFeeHeadId: fineHead.id,
          invoiceCount: applied.length,
          totalFined: totalFined.toDecimalString(),
          invoiceIds: applied.map((one) => one.invoiceId),
        },
        reason: input.reason,
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      return { asOfDate: asOf, applied, skipped, totalFined: totalFined.toDecimalString() };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Payments
  // ══════════════════════════════════════════════════════════════════════════════════

  async listPayments(
    principal: Principal,
    institutionId: string,
    query: ListPaymentsQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<PaymentRow>> {
    const scope = this.requireFinanceScope(principal);

    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [
        eq(payments.institutionId, institutionId),
        this.studentScopeFilter(principal, scope, payments.studentId),
      ];
      this.applyArchiveFilter(principal, filters, payments.archivedAt, query.includeArchived);

      if (query.studentId) filters.push(eq(payments.studentId, query.studentId));
      if (query.method) filters.push(eq(payments.method, query.method as PaymentRow['method']));
      if (query.status) filters.push(eq(payments.status, query.status as PaymentRow['status']));
      if (query.receivedFrom) {
        filters.push(gte(payments.receivedAt, startOfDhakaDay(calendarDate(query.receivedFrom))));
      }
      if (query.receivedTo) {
        filters.push(lt(payments.receivedAt, endOfDhakaDay(calendarDate(query.receivedTo))));
      }
      if (query.q) filters.push(ilike(payments.receiptNumber, `${query.q}%`));

      const where = and(...filters);
      const orderBy = parseSort(query.sort, PAYMENT_SORT_FIELDS, {
        field: 'receivedAt',
        direction: 'desc',
      }).map((spec) => {
        const column = PAYMENT_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(payments)
        .where(where)
        .orderBy(...orderBy, asc(payments.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(payments)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  /**
   * Record money received and allocate it to invoices.
   *
   * Three allocation modes, all of which end with the same invariant — the allocations never
   * exceed the payment and never exceed an invoice's outstanding balance:
   *
   *  - **explicit**: the client names the invoices and the amounts. They must sum to exactly
   *    the payment; a partially-explained receipt is refused rather than reconciled later.
   *  - **oldest_due_first** (the default): what a clerk taking cash at the counter means.
   *  - **proportional**: split across outstanding invoices in proportion to their balances via
   *    `Money.allocate`, so the parts sum back to the whole with no poisa invented or lost.
   *
   * Any excess beyond the outstanding total stays unallocated — an advance the next invoice
   * will pick up — and is reported so the clerk can see it.
   */
  async recordPayment(
    principal: Principal,
    institutionId: string,
    input: RecordPaymentInput,
  ): Promise<{
    payment: PaymentRow;
    allocations: Array<{ invoiceId: string; invoiceNumber: string; amount: string }>;
    unallocated: string;
  }> {
    const context = currentContext();
    const amount = Money.fromDecimalString(input.amount);
    if (!amount.isPositive()) {
      throw new ValidationError('A payment must be for a positive amount', [
        { path: 'amount', message: 'Enter an amount greater than zero' },
      ]);
    }

    return this.db.runInTenant(async (tx) => {
      const [student] = await tx
        .select({ id: students.id, name: students.fullNameEn })
        .from(students)
        .where(
          and(
            eq(students.id, input.studentId),
            eq(students.institutionId, institutionId),
            isNull(students.archivedAt),
          ),
        )
        .limit(1);
      if (!student) throw new NotFoundError('Student', input.studentId);

      const outstanding = await tx
        .select()
        .from(invoices)
        .where(
          and(
            eq(invoices.institutionId, institutionId),
            eq(invoices.studentId, input.studentId),
            ne(invoices.status, 'void'),
            isNull(invoices.archivedAt),
            gt(invoices.balance, '0.00'),
          ),
        )
        .orderBy(asc(invoices.dueDate), asc(invoices.invoiceNumber));

      const byId = new Map(outstanding.map((invoice) => [invoice.id, invoice]));
      const planned = input.allocations?.length
        ? this.planExplicitAllocation(input.allocations, amount, byId)
        : input.strategy === 'proportional'
          ? this.planProportionalAllocation(outstanding, amount)
          : this.planOldestDueFirstAllocation(outstanding, amount);

      const allocatedTotal = Money.sum(planned.map((one) => one.amount));
      if (allocatedTotal.greaterThan(amount)) {
        // Unreachable through the planners above; asserted because the failure mode is money
        // appearing from nowhere, and a crash beats a silent invention.
        throw new ConflictError('The allocations exceed the payment amount');
      }

      const year4 = input.receivedAt
        ? input.receivedAt.slice(0, 4)
        : String(todayInDhaka()).slice(0, 4);
      const sequence = (await this.currentReceiptSequence(tx, institutionId, `RCT-${year4}-`)) + 1;
      const receiptNumber = `RCT-${year4}-${String(sequence).padStart(6, '0')}`;

      const paymentId = uuidv7();
      const [payment] = await tx
        .insert(payments)
        .values({
          id: paymentId,
          tenantId: principal.tenantId!,
          institutionId,
          studentId: input.studentId,
          receiptNumber,
          amount: amount.toDecimalString(),
          method: input.method as PaymentRow['method'],
          reference: input.reference ?? null,
          receivedBy: principal.userId,
          receivedAt: input.receivedAt ? new Date(input.receivedAt) : new Date(),
          status: 'completed',
          notes: input.notes ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      const written: Array<{ invoiceId: string; invoiceNumber: string; amount: string }> = [];
      for (const allocation of planned) {
        await tx.insert(paymentAllocations).values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          paymentId,
          invoiceId: allocation.invoiceId,
          amount: allocation.amount.toDecimalString(),
          createdBy: principal.userId,
          updatedBy: principal.userId,
        });
        await this.recomputeInvoice(tx, allocation.invoiceId, principal.userId);
        written.push({
          invoiceId: allocation.invoiceId,
          invoiceNumber: byId.get(allocation.invoiceId)?.invoiceNumber ?? '',
          amount: allocation.amount.toDecimalString(),
        });
      }

      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'payment',
        module: 'fees',
        resourceType: 'payment',
        resourceId: paymentId,
        resourceLabel: receiptNumber,
        newValue: {
          studentId: input.studentId,
          amount: amount.toDecimalString(),
          method: input.method,
          reference: input.reference ?? null,
          allocations: written,
          unallocated: amount.minus(allocatedTotal).toDecimalString(),
        },
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      return {
        payment: payment!,
        allocations: written,
        unallocated: amount.minus(allocatedTotal).toDecimalString(),
      };
    });
  }

  /**
   * Reverse a payment.
   *
   * Never a delete. The receipt keeps its number and its history; the status changes, the
   * allocations are archived, and every invoice the payment touched is recomputed in the same
   * transaction — so there is no moment at which an invoice shows a balance that no longer
   * matches the payments behind it.
   */
  async reversePayment(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
    version: number,
  ): Promise<{ payment: PaymentRow; recomputedInvoiceIds: string[] }> {
    const context = currentContext();

    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.id, id),
            eq(payments.institutionId, institutionId),
            isNull(payments.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Payment', id);

      if (existing.status !== 'completed') {
        throw new ConflictError(
          `Only a completed payment can be reversed; this one is ${existing.status}.`,
          { currentStatus: existing.status },
        );
      }

      const [reversed] = await tx
        .update(payments)
        .set({
          status: 'reversed',
          reversalReason: reason,
          reversedBy: principal.userId,
          reversedAt: new Date(),
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(and(eq(payments.id, id), eq(payments.version, version)))
        .returning();

      if (!reversed) {
        throw new ConflictError(
          'This payment was changed by someone else while you were reversing it. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      const allocations = await tx
        .select()
        .from(paymentAllocations)
        .where(and(eq(paymentAllocations.paymentId, id), isNull(paymentAllocations.archivedAt)));

      const recomputedInvoiceIds: string[] = [];
      for (const allocation of allocations) {
        await tx
          .update(paymentAllocations)
          .set({
            archivedAt: new Date(),
            archivedBy: principal.userId,
            archiveReason: reason,
            updatedBy: principal.userId,
          })
          .where(eq(paymentAllocations.id, allocation.id));
        await this.recomputeInvoice(tx, allocation.invoiceId, principal.userId);
        recomputedInvoiceIds.push(allocation.invoiceId);
      }

      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'refund',
        module: 'fees',
        resourceType: 'payment',
        resourceId: id,
        resourceLabel: existing.receiptNumber,
        previousValue: { status: existing.status, amount: existing.amount },
        newValue: {
          status: 'reversed',
          amount: existing.amount,
          reversedAllocations: allocations.map((one) => ({
            invoiceId: one.invoiceId,
            amount: one.amount,
          })),
        },
        reason,
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      return { payment: reversed, recomputedInvoiceIds };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Reports
  // ══════════════════════════════════════════════════════════════════════════════════

  /**
   * Every invoice and payment for one student, in date order, with a running balance.
   *
   * The running balance is accumulated with `Money`, so a ledger of two hundred entries is
   * exact rather than approximately exact. Voided invoices appear — a family that was billed
   * in error should be able to see that it was cancelled — but contribute nothing.
   */
  async studentLedger(
    principal: Principal,
    institutionId: string,
    studentId: string,
    query: { academicYearId?: string; from?: string; to?: string },
  ) {
    const scope = this.requireFinanceScope(principal);

    return this.db.runInTenant(async (tx) => {
      const [student] = await tx
        .select({ id: students.id, name: students.fullNameEn, code: students.studentCode })
        .from(students)
        .where(
          and(
            eq(students.id, studentId),
            eq(students.institutionId, institutionId),
            this.studentScopeFilter(principal, scope, students.id),
          ),
        )
        .limit(1);
      // 404 rather than 403: confirming that a student exists in a family you are not linked
      // to is itself a leak.
      if (!student) throw new NotFoundError('Student', studentId);

      const invoiceFilters: SQL[] = [
        eq(invoices.studentId, studentId),
        eq(invoices.institutionId, institutionId),
        isNull(invoices.archivedAt),
      ];
      if (query.academicYearId) {
        invoiceFilters.push(eq(invoices.academicYearId, query.academicYearId));
      }
      if (query.from) invoiceFilters.push(gte(invoices.issueDate, query.from));
      if (query.to) invoiceFilters.push(lte(invoices.issueDate, query.to));

      const invoiceRows = await tx
        .select()
        .from(invoices)
        .where(and(...invoiceFilters))
        .orderBy(asc(invoices.issueDate), asc(invoices.createdAt));

      const paymentFilters: SQL[] = [
        eq(payments.studentId, studentId),
        eq(payments.institutionId, institutionId),
        isNull(payments.archivedAt),
      ];
      if (query.from) {
        paymentFilters.push(gte(payments.receivedAt, startOfDhakaDay(calendarDate(query.from))));
      }
      if (query.to) {
        paymentFilters.push(lt(payments.receivedAt, endOfDhakaDay(calendarDate(query.to))));
      }

      const paymentRows = await tx
        .select()
        .from(payments)
        .where(and(...paymentFilters))
        .orderBy(asc(payments.receivedAt));

      interface LedgerEntry {
        date: string;
        type: 'invoice' | 'payment';
        reference: string;
        description: string;
        charge: string;
        credit: string;
        status: string;
        sortKey: number;
        balance: string;
      }

      const entries: LedgerEntry[] = [];

      for (const invoice of invoiceRows) {
        const effective =
          invoice.status === 'void' ? Money.zero() : Money.fromDecimalString(invoice.total);
        entries.push({
          date: invoice.issueDate,
          type: 'invoice',
          reference: invoice.invoiceNumber,
          description: `Invoice ${invoice.billingPeriodStart} to ${invoice.billingPeriodEnd}`,
          charge: effective.toDecimalString(),
          credit: '0.00',
          status: invoice.status,
          sortKey: invoice.createdAt.getTime(),
          balance: '0.00',
        });
      }

      for (const payment of paymentRows) {
        const effective =
          payment.status === 'completed' ? Money.fromDecimalString(payment.amount) : Money.zero();
        entries.push({
          date: instantToDhakaDate(payment.receivedAt),
          type: 'payment',
          reference: payment.receiptNumber,
          description: `Payment by ${payment.method}`,
          charge: '0.00',
          credit: effective.toDecimalString(),
          status: payment.status,
          sortKey: payment.receivedAt.getTime(),
          balance: '0.00',
        });
      }

      entries.sort((a, b) =>
        a.date === b.date ? a.sortKey - b.sortKey : a.date < b.date ? -1 : 1,
      );

      let running = Money.zero();
      let charged = Money.zero();
      let credited = Money.zero();
      for (const entry of entries) {
        running = running.plus(Money.fromDecimalString(entry.charge));
        running = running.minus(Money.fromDecimalString(entry.credit));
        charged = charged.plus(Money.fromDecimalString(entry.charge));
        credited = credited.plus(Money.fromDecimalString(entry.credit));
        entry.balance = running.toDecimalString();
      }

      return {
        student: { id: student.id, fullNameEn: student.name, studentCode: student.code },
        currency: 'BDT',
        totalCharged: charged.toDecimalString(),
        totalPaid: credited.toDecimalString(),
        closingBalance: running.toDecimalString(),
        entries: entries.map(({ sortKey: _sortKey, ...rest }) => rest),
      };
    });
  }

  /**
   * Outstanding dues by class or section, aggregated in SQL.
   *
   * Summed by Postgres rather than by pulling every invoice into Node: an institution with
   * 3,000 students and twelve monthly invoices each has 36,000 rows, and the report is for a
   * dashboard. The sums come back as `numeric` strings and are handed on as strings.
   */
  async outstandingDues(
    institutionId: string,
    query: {
      academicYearId: string;
      classLevelId?: string;
      sectionId?: string;
      groupBy: 'class' | 'section';
      asOfDate?: string;
    },
  ) {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [
        eq(invoices.institutionId, institutionId),
        eq(invoices.academicYearId, query.academicYearId),
        ne(invoices.status, 'void'),
        isNull(invoices.archivedAt),
        eq(enrollments.academicYearId, query.academicYearId),
        eq(enrollments.status, 'active'),
        isNull(enrollments.archivedAt),
      ];
      if (query.classLevelId) filters.push(eq(enrollments.classLevelId, query.classLevelId));
      if (query.sectionId) filters.push(eq(enrollments.sectionId, query.sectionId));
      if (query.asOfDate) filters.push(lte(invoices.dueDate, query.asOfDate));

      // The aggregate columns are identical in both shapes; only the grouping differs. Written
      // as two queries rather than one with conditional columns because a `select` whose
      // fields change shape at runtime is exactly the kind of query that silently loses a
      // GROUP BY term during a later edit.
      const measures = {
        studentCount: sql<number>`count(distinct ${invoices.studentId})::int`,
        invoiceCount: sql<number>`count(distinct ${invoices.id})::int`,
        billed: sql<string>`coalesce(sum(${invoices.total}), 0)::numeric(14,2)`,
        collected: sql<string>`coalesce(sum(${invoices.paidTotal}), 0)::numeric(14,2)`,
        outstanding: sql<string>`coalesce(sum(${invoices.balance}), 0)::numeric(14,2)`,
      };

      let rows: OutstandingDuesRow[];

      if (query.groupBy === 'section') {
        rows = await tx
          .select({
            classLevelId: classLevels.id,
            classLevelName: classLevels.nameEn,
            classOrdinal: classLevels.ordinal,
            sectionId: sections.id,
            sectionName: sections.nameEn,
            ...measures,
          })
          .from(invoices)
          .innerJoin(enrollments, eq(enrollments.studentId, invoices.studentId))
          .innerJoin(sections, eq(sections.id, enrollments.sectionId))
          .innerJoin(classLevels, eq(classLevels.id, enrollments.classLevelId))
          .where(and(...filters))
          .groupBy(
            classLevels.id,
            classLevels.nameEn,
            classLevels.ordinal,
            sections.id,
            sections.nameEn,
          )
          .orderBy(asc(classLevels.ordinal), asc(sections.nameEn));
      } else {
        const grouped = await tx
          .select({
            classLevelId: classLevels.id,
            classLevelName: classLevels.nameEn,
            classOrdinal: classLevels.ordinal,
            ...measures,
          })
          .from(invoices)
          .innerJoin(enrollments, eq(enrollments.studentId, invoices.studentId))
          .innerJoin(classLevels, eq(classLevels.id, enrollments.classLevelId))
          .where(and(...filters))
          .groupBy(classLevels.id, classLevels.nameEn, classLevels.ordinal)
          .orderBy(asc(classLevels.ordinal));
        rows = grouped.map((row) => ({ ...row, sectionId: null, sectionName: null }));
      }

      const totalOutstanding = Money.sum(
        rows.map((row) => Money.fromDecimalString(row.outstanding)),
      );
      const totalBilled = Money.sum(rows.map((row) => Money.fromDecimalString(row.billed)));
      const totalCollected = Money.sum(rows.map((row) => Money.fromDecimalString(row.collected)));

      return {
        groupBy: query.groupBy,
        currency: 'BDT',
        rows,
        totals: {
          billed: totalBilled.toDecimalString(),
          collected: totalCollected.toDecimalString(),
          outstanding: totalOutstanding.toDecimalString(),
        },
      };
    });
  }

  /** What was collected between two dates, broken down by method. Aggregated in SQL. */
  async collectionSummary(
    institutionId: string,
    query: { from: string; to: string; method?: string },
  ) {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [
        eq(payments.institutionId, institutionId),
        eq(payments.status, 'completed'),
        isNull(payments.archivedAt),
        gte(payments.receivedAt, startOfDhakaDay(calendarDate(query.from))),
        lt(payments.receivedAt, endOfDhakaDay(calendarDate(query.to))),
      ];
      if (query.method) filters.push(eq(payments.method, query.method as PaymentRow['method']));

      const rows = await tx
        .select({
          method: payments.method,
          count: sql<number>`count(*)::int`,
          amount: sql<string>`coalesce(sum(${payments.amount}), 0)::numeric(14,2)`,
        })
        .from(payments)
        .where(and(...filters))
        .groupBy(payments.method)
        .orderBy(asc(payments.method));

      const total = Money.sum(rows.map((row) => Money.fromDecimalString(row.amount)));

      return {
        from: query.from,
        to: query.to,
        currency: 'BDT',
        byMethod: rows,
        totalCount: rows.reduce((sum, row) => sum + row.count, 0),
        totalAmount: total.toDecimalString(),
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Internals
  // ══════════════════════════════════════════════════════════════════════════════════

  private requireFinanceScope(principal: Principal): DataScope {
    const context = currentContext();
    const scope = resolveDataScope(principal, FINANCE_SCOPE, {
      institutionId: context?.institutionId ?? null,
      campusId: context?.campusId ?? null,
    });
    if (scope === 'none') {
      throw new ForbiddenError('finance.invoices.view', 'You cannot view financial records');
    }
    return scope;
  }

  /**
   * Translate a data scope into a predicate over a student id column.
   *
   * `all` is a tautology rather than `undefined`, so a caller can always `and(...)` the result
   * — it is impossible to build a query here that accidentally omits the scope.
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

    // A principal holding `finance.own.view` with neither a guardian nor a student record can
    // own nothing, so they see nothing. Failing closed is the only safe reading.
    if (conditions.length === 0) return sql`false`;
    return conditions.length === 1 ? conditions[0]! : or(...conditions)!;
  }

  private applyArchiveFilter(
    principal: Principal,
    filters: SQL[],
    archivedAtColumn: SQLWrapper,
    includeArchived: boolean,
  ): void {
    if (!includeArchived) {
      filters.push(isNull(archivedAtColumn));
      return;
    }
    if (!can(principal, 'finance.fees.manage')) {
      throw new ForbiddenError('finance.fees.manage', 'You cannot view archived fee records');
    }
  }

  /** Restrict to the students enrolled in a section or class in the invoice's academic year. */
  private enrollmentFilter(sectionId?: string, classLevelId?: string): SQL | null {
    const conditions: SQL[] = [];
    if (sectionId) conditions.push(eq(enrollments.sectionId, sectionId));
    if (classLevelId) conditions.push(eq(enrollments.classLevelId, classLevelId));
    if (conditions.length === 0) return null;

    return exists(
      this.db.raw
        .select({ one: sql`1` })
        .from(enrollments)
        .where(
          and(
            eq(enrollments.studentId, invoices.studentId),
            eq(enrollments.academicYearId, invoices.academicYearId),
            isNull(enrollments.archivedAt),
            ...conditions,
          ),
        ),
    );
  }

  private async resolveTargetStudents(
    tx: Tx,
    institutionId: string,
    input: GenerateInvoicesInput,
  ): Promise<
    Array<{
      studentId: string;
      studentName: string;
      classLevelId: string;
      groupId: string | null;
    }>
  > {
    const filters: SQL[] = [
      eq(enrollments.institutionId, institutionId),
      eq(enrollments.academicYearId, input.academicYearId),
      eq(enrollments.status, 'active'),
      isNull(enrollments.archivedAt),
      isNull(students.archivedAt),
    ];
    if (input.sectionId) filters.push(eq(enrollments.sectionId, input.sectionId));
    if (input.classLevelId) filters.push(eq(enrollments.classLevelId, input.classLevelId));
    if (input.studentIds && input.studentIds.length > 0) {
      filters.push(inArray(enrollments.studentId, input.studentIds));
    }

    return tx
      .select({
        studentId: students.id,
        studentName: students.fullNameEn,
        classLevelId: enrollments.classLevelId,
        groupId: enrollments.groupId,
      })
      .from(enrollments)
      .innerJoin(students, eq(students.id, enrollments.studentId))
      .where(and(...filters))
      .orderBy(asc(students.fullNameEn), asc(students.id));
  }

  /**
   * Which price list applies to a student on a date.
   *
   * An explicit assignment wins. Failing that, the most specific active structure for the
   * year — one naming the student's class beats one naming every class, and one naming their
   * group beats one naming every group.
   */
  private async resolveStructureFor(
    tx: Tx,
    input: {
      institutionId: string;
      academicYearId: string;
      studentId: string;
      classLevelId: string;
      academicGroupId: string | null;
      onDate: string;
    },
  ): Promise<FeeStructureRow | null> {
    const [assigned] = await tx
      .select({ structure: feeStructures })
      .from(studentFeeAssignments)
      .innerJoin(feeStructures, eq(feeStructures.id, studentFeeAssignments.feeStructureId))
      .where(
        and(
          eq(studentFeeAssignments.studentId, input.studentId),
          eq(studentFeeAssignments.academicYearId, input.academicYearId),
          isNull(studentFeeAssignments.archivedAt),
          lte(studentFeeAssignments.effectiveFrom, input.onDate),
          or(
            isNull(studentFeeAssignments.effectiveTo),
            gte(studentFeeAssignments.effectiveTo, input.onDate),
          )!,
          isNull(feeStructures.archivedAt),
          ne(feeStructures.status, 'archived'),
        ),
      )
      .orderBy(desc(studentFeeAssignments.effectiveFrom))
      .limit(1);

    if (assigned?.structure) return assigned.structure;

    const [fallback] = await tx
      .select()
      .from(feeStructures)
      .where(
        and(
          eq(feeStructures.institutionId, input.institutionId),
          eq(feeStructures.academicYearId, input.academicYearId),
          eq(feeStructures.status, 'active'),
          isNull(feeStructures.archivedAt),
          lte(feeStructures.effectiveFrom, input.onDate),
          or(
            isNull(feeStructures.classLevelId),
            eq(feeStructures.classLevelId, input.classLevelId),
          )!,
          input.academicGroupId
            ? or(
                isNull(feeStructures.academicGroupId),
                eq(feeStructures.academicGroupId, input.academicGroupId),
              )!
            : isNull(feeStructures.academicGroupId),
        ),
      )
      // `is null asc` puts the specific structure (a non-null class level) first.
      .orderBy(
        sql`${feeStructures.classLevelId} is null asc`,
        sql`${feeStructures.academicGroupId} is null asc`,
        desc(feeStructures.effectiveFrom),
      )
      .limit(1);

    return fallback ?? null;
  }

  /** Approved concessions in force on a date. Pending and rejected ones change nothing. */
  private async loadApprovedConcessions(
    tx: Tx,
    studentId: string,
    onDate: string,
  ): Promise<FeeConcessionRow[]> {
    return tx
      .select()
      .from(feeConcessions)
      .where(
        and(
          eq(feeConcessions.studentId, studentId),
          eq(feeConcessions.status, 'approved'),
          isNull(feeConcessions.archivedAt),
          lte(feeConcessions.validFrom, onDate),
          or(isNull(feeConcessions.validTo), gte(feeConcessions.validTo, onDate))!,
        ),
      )
      .orderBy(asc(feeConcessions.createdAt), asc(feeConcessions.id));
  }

  private planExplicitAllocation(
    requested: Array<{ invoiceId: string; amount: string }>,
    payment: Money,
    byId: Map<string, InvoiceRow>,
  ): Array<{ invoiceId: string; amount: Money }> {
    const planned: Array<{ invoiceId: string; amount: Money }> = [];
    let total = Money.zero();

    for (const one of requested) {
      const invoice = byId.get(one.invoiceId);
      if (!invoice) {
        throw new ValidationError('An allocation names an invoice that is not outstanding', [
          {
            path: 'allocations',
            message: `Invoice ${one.invoiceId} is not an outstanding invoice for this student`,
          },
        ]);
      }
      const amount = Money.fromDecimalString(one.amount);
      if (!amount.isPositive()) {
        // The database refuses a zero allocation too; catching it here attaches the failure
        // to the field rather than surfacing a check-constraint translation.
        throw new ValidationError('An allocation must be for a positive amount', [
          { path: 'allocations', message: 'Remove the invoice instead of allocating zero to it' },
        ]);
      }
      const balance = Money.fromDecimalString(invoice.balance);
      if (amount.greaterThan(balance)) {
        throw new ValidationError('An allocation exceeds what the invoice still owes', [
          {
            path: 'allocations',
            message: `Invoice ${invoice.invoiceNumber} has ${balance.toDecimalString()} outstanding, but ${amount.toDecimalString()} was allocated to it`,
          },
        ]);
      }
      total = total.plus(amount);
      planned.push({ invoiceId: one.invoiceId, amount });
    }

    // Restated against `Money` rather than trusting the schema's string arithmetic. An
    // allocation set that does not add up is a reconciliation problem for someone later.
    if (!total.equals(payment)) {
      throw new ValidationError('The allocations must add up to exactly the payment amount', [
        {
          path: 'allocations',
          message: `The allocations total ${total.toDecimalString()} but the payment is ${payment.toDecimalString()}`,
        },
      ]);
    }

    return planned;
  }

  /** Settle the oldest due invoice first, then the next, until the money runs out. */
  private planOldestDueFirstAllocation(
    outstanding: InvoiceRow[],
    payment: Money,
  ): Array<{ invoiceId: string; amount: Money }> {
    const planned: Array<{ invoiceId: string; amount: Money }> = [];
    let remaining = payment;

    for (const invoice of outstanding) {
      if (!remaining.isPositive()) break;
      const balance = Money.fromDecimalString(invoice.balance);
      if (!balance.isPositive()) continue;
      const amount = Money.min(remaining, balance);
      planned.push({ invoiceId: invoice.id, amount });
      remaining = remaining.minus(amount);
    }

    return planned;
  }

  /**
   * Split the payment across the outstanding invoices in proportion to their balances.
   *
   * `Money.allocate` distributes the remainder by largest remainder, so the parts sum back to
   * exactly the payment — which is the whole reason it exists rather than a division.
   */
  private planProportionalAllocation(
    outstanding: InvoiceRow[],
    payment: Money,
  ): Array<{ invoiceId: string; amount: Money }> {
    const live = outstanding.filter((invoice) =>
      Money.fromDecimalString(invoice.balance).isPositive(),
    );
    if (live.length === 0) return [];

    const balances = live.map((invoice) => Money.fromDecimalString(invoice.balance));
    const totalOutstanding = Money.sum(balances);

    if (payment.greaterThan(totalOutstanding)) {
      throw new ValidationError(
        'A proportional payment cannot exceed what the student currently owes',
        [
          {
            path: 'amount',
            message: `The student owes ${totalOutstanding.toDecimalString()}; allocate the excess explicitly or use the default strategy`,
          },
        ],
      );
    }

    const parts = payment.allocate(balances.map((balance) => Number(balance.minor)));
    const planned: Array<{ invoiceId: string; amount: Money }> = [];
    for (const [index, part] of parts.entries()) {
      if (!part.isPositive()) continue;
      planned.push({ invoiceId: live[index]!.id, amount: part });
    }
    return planned;
  }

  /**
   * Recompute one invoice from the payments actually allocated to it.
   *
   * Recomputed from the allocations rather than adjusted incrementally: an increment is a
   * running total that can drift, and a sum is a fact. Reversal and payment therefore share
   * one code path.
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
   * The highest invoice number already issued under a prefix.
   *
   * `max` rather than `count`, because voided and archived documents keep their numbers and a
   * count would start reissuing them. The unique index on `(institution_id, invoice_number)`
   * is the real guarantee; this only has to be right almost always, and two racing generation
   * runs collide there rather than silently sharing a number.
   */
  private async currentInvoiceSequence(
    tx: Tx,
    institutionId: string,
    prefix: string,
  ): Promise<number> {
    const [row] = await tx
      .select({ maxNumber: sql<string | null>`max(${invoices.invoiceNumber})` })
      .from(invoices)
      .where(
        and(eq(invoices.institutionId, institutionId), like(invoices.invoiceNumber, `${prefix}%`)),
      );
    return sequenceAfter(row?.maxNumber ?? null, prefix);
  }

  private async currentReceiptSequence(
    tx: Tx,
    institutionId: string,
    prefix: string,
  ): Promise<number> {
    const [row] = await tx
      .select({ maxNumber: sql<string | null>`max(${payments.receiptNumber})` })
      .from(payments)
      .where(
        and(eq(payments.institutionId, institutionId), like(payments.receiptNumber, `${prefix}%`)),
      );
    return sequenceAfter(row?.maxNumber ?? null, prefix);
  }
}

// ────────────────────────────────────────────────────────────────────────────────────
// Pure helpers. Kept outside the class because they take no dependencies and are the parts
// most worth reading on their own.
// ────────────────────────────────────────────────────────────────────────────────────

/**
 * Invoice status, derived.
 *
 * Order matters and is deliberate: a partly-paid invoice reads as `partially_paid` even after
 * its due date, because "they have paid something" is the more useful fact for a clerk on the
 * phone than "it is late", and the due date is on the same screen either way.
 */
export function deriveInvoiceStatus(
  total: Money,
  paid: Money,
  dueDate: string,
  today: string,
): 'issued' | 'partially_paid' | 'paid' | 'overdue' {
  if (paid.greaterThanOrEqual(total)) return 'paid';
  if (paid.isPositive()) return 'partially_paid';
  return compareCalendarDates(calendarDate(dueDate), calendarDate(today)) < 0
    ? 'overdue'
    : 'issued';
}

/**
 * Apply a student's concessions to one line.
 *
 * Percentages first, then fixed amounts, and every percentage is taken on the original gross
 * rather than on the running remainder — so two 10% concessions are 20%, not 19%, and the
 * order two clerks entered them in cannot change what a family pays.
 *
 * The total discount is floored at the line amount. A line can be reduced to zero; it can
 * never go negative and turn a bill into a payout.
 */
export function applyConcessions(
  gross: Money,
  concessions: FeeConcessionRow[],
  feeHeadId: string,
): { discount: Money; concessionId: string | null } {
  const relevant = concessions.filter(
    (concession) => concession.feeHeadId === null || concession.feeHeadId === feeHeadId,
  );
  if (relevant.length === 0) return { discount: Money.zero(), concessionId: null };

  let discount = Money.zero();

  for (const concession of relevant) {
    if (concession.type !== 'percentage') continue;
    // "12.50" in a two-decimal column is 1250 minor units, which is 1250 basis points.
    const basisPoints = Money.fromDecimalString(concession.value).minor;
    discount = discount.plus(gross.percentage(basisPoints));
  }

  for (const concession of relevant) {
    if (concession.type !== 'fixed') continue;
    discount = discount.plus(Money.fromDecimalString(concession.value));
  }

  if (discount.greaterThan(gross)) discount = gross;

  return {
    discount,
    concessionId: relevant.length === 1 ? relevant[0]!.id : null,
  };
}

/**
 * The idempotency key for a generated invoice.
 *
 * Deterministic in the academic year, the student and the billing period — which is exactly
 * the statement "this family has already been billed for this month".
 */
export function buildGenerationKey(
  academicYearId: string,
  studentId: string,
  periodStart: string,
  periodEnd: string,
): string {
  return `${academicYearId}:${studentId}:${periodStart}:${periodEnd}`;
}

/** Human-readable line description: the head's English name and how often it is charged. */
function describeItem(item: FeeStructureItemRow, headName: string | undefined): string {
  const label = headName ?? 'Fee';
  return item.frequency === 'one_time' ? label : `${label} (${item.frequency.replace('_', ' ')})`;
}

/** Next number after the highest one already issued under a prefix. */
function sequenceAfter(highest: string | null, prefix: string): number {
  if (!highest) return 0;
  const parsed = Number.parseInt(highest.slice(prefix.length), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sumDecimals(values: string[]): string {
  return Money.sum(values.map((value) => Money.fromDecimalString(value))).toDecimalString();
}

function diffOf<T extends Record<string, unknown>>(
  before: T,
  after: T,
  keys: string[],
): Partial<T> {
  const previous: Partial<T> = {};
  for (const key of keys) {
    const typedKey = key as keyof T;
    if (before[typedKey] !== after[typedKey]) {
      (previous as Record<string, unknown>)[key] = before[typedKey];
    }
  }
  return previous;
}

const FEE_HEAD_COLUMNS = {
  code: feeHeads.code,
  nameEn: feeHeads.nameEn,
  type: feeHeads.type,
  sortOrder: feeHeads.sortOrder,
  createdAt: feeHeads.createdAt,
} as const;

const FEE_STRUCTURE_COLUMNS = {
  nameEn: feeStructures.nameEn,
  status: feeStructures.status,
  effectiveFrom: feeStructures.effectiveFrom,
  createdAt: feeStructures.createdAt,
} as const;

const FEE_CONCESSION_COLUMNS = {
  status: feeConcessions.status,
  validFrom: feeConcessions.validFrom,
  createdAt: feeConcessions.createdAt,
} as const;

const INVOICE_COLUMNS = {
  invoiceNumber: invoices.invoiceNumber,
  issueDate: invoices.issueDate,
  dueDate: invoices.dueDate,
  total: invoices.total,
  balance: invoices.balance,
  status: invoices.status,
  createdAt: invoices.createdAt,
} as const;

const PAYMENT_COLUMNS = {
  receiptNumber: payments.receiptNumber,
  receivedAt: payments.receivedAt,
  amount: payments.amount,
  method: payments.method,
  createdAt: payments.createdAt,
} as const;
