/**
 * `finance.outstanding` — what is owed, and how old it is.
 *
 * The permission story here is the one docs/06 §2 gestures at and does not spell out. The
 * declared permission is `finance.reports.view`, which is the officer's view: totals across a
 * class, a section or the whole institution. But a guardian legitimately asks "how much do I
 * owe" and holds `finance.own.view`, not `finance.reports.view`. Making them two tools would
 * mean two manifests and two chances to get the scoping wrong, so it is one tool that accepts
 * either permission and then **enforces the difference on the data**:
 *
 *   - with `finance.reports.view` the query runs over the institution, narrowed by whatever
 *     class or section filters were passed;
 *   - without it, the query is restricted to the exact set of student ids the caller can see
 *     through the students module — for a guardian, their own linked children with portal
 *     access, and nothing else. Not "and also filter by studentId if they passed one": the
 *     restriction is applied whether or not an argument was given, so omitting `studentId`
 *     widens the answer to their own children rather than to the school.
 *
 * A caller in the second group who names a student they cannot see gets an empty result with
 * `restrictedToOwnRecords: true`, not a 403 — the flag tells the model to say "for your
 * children" rather than "for the school", which is the difference between a helpful answer and
 * a wrong one.
 *
 * Money is `Money` throughout: the buckets are summed by Postgres as `numeric(14,2)` and
 * parsed with `Money.fromDecimalString`, so nothing on this path is ever a float.
 */

import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { enrollments, invoices } from '@shikkha/db';
import { Money, todayInDhaka, type CalendarDate } from '@shikkha/shared';
import {
  financeOutstandingArgsSchema,
  type FinanceOutstandingArgs,
  type AiToolName,
} from '@shikkha/validation';
import { can, type Permission } from '@shikkha/permissions';
import { DatabaseService } from '../../database/database.service';
import { ToolScopeService } from '../tool-scope.service';
import type { AiTool, AiToolContext, AiToolResult } from './tool.types';

/** How many students a non-officer caller may aggregate over. A guardian has a handful. */
const OWN_RECORDS_LIMIT = 200;

interface AgeingBuckets {
  notYetDue: string;
  days1To30: string;
  days31To60: string;
  days61To90: string;
  over90Days: string;
}

interface FinanceOutstandingData {
  academicYearId: string;
  asOfDate: string;
  currency: 'BDT';
  restrictedToOwnRecords: boolean;
  studentCount: number;
  invoiceCount: number;
  billed: string;
  collected: string;
  outstanding: string;
  ageing: AgeingBuckets;
}

@Injectable()
export class FinanceOutstandingTool implements AiTool<FinanceOutstandingArgs> {
  readonly name: AiToolName = 'finance.outstanding';
  readonly description =
    'Outstanding fee totals for an academic year, with ageing buckets (not yet due, 1-30, ' +
    '31-60, 61-90 and over 90 days overdue) as at a date. Optionally narrowed to one student, ' +
    'section or class level. Amounts are decimal strings in BDT. A caller who may only see ' +
    'their own family’s finances always gets their own children’s totals and nothing wider; ' +
    'when restrictedToOwnRecords is true, describe the answer as "your" rather than "the ' +
    'school’s".';
  readonly schema = financeOutstandingArgsSchema;
  readonly permissions: readonly Permission[] = ['finance.reports.view', 'finance.own.view'];
  /** Ids and a date only. */
  readonly freeTextArguments = [] as const;

  constructor(
    private readonly db: DatabaseService,
    private readonly scope: ToolScopeService,
  ) {}

  async execute(
    context: AiToolContext,
    args: FinanceOutstandingArgs,
  ): Promise<AiToolResult<FinanceOutstandingData>> {
    const { principal, institutionId } = context;
    const asOfDate = (args.asOfDate as CalendarDate | undefined) ?? todayInDhaka();

    const isOfficer = can(principal, 'finance.reports.view');

    // The restricted set is computed before anything else so there is exactly one place where
    // "which students" is decided, and it is the students module's own scope filter.
    let restrictedIds: string[] | null = null;
    if (!isOfficer) {
      const visible = await this.scope.visibleStudentIds(
        principal,
        {
          academicYearId: args.academicYearId,
          ...(args.sectionId ? { sectionId: args.sectionId } : {}),
          ...(args.classLevelId ? { classLevelId: args.classLevelId } : {}),
        },
        OWN_RECORDS_LIMIT,
      );
      restrictedIds = args.studentId
        ? visible.ids.filter((id) => id === args.studentId)
        : visible.ids;
    } else if (args.studentId) {
      // An officer still goes through the students scope for a single named student, so the
      // narrowest of their two permissions wins rather than the widest.
      await this.scope.assertVisibleStudent(principal, args.studentId);
    }

    if (restrictedIds !== null && restrictedIds.length === 0) {
      // Nothing this caller may see. An empty aggregate rather than a 404, because "you owe
      // nothing" and "that is not your child" must look the same from outside.
      return {
        data: emptyResult(args.academicYearId, asOfDate, true),
        rowCount: 0,
      };
    }

    const filters: SQL[] = [
      eq(invoices.institutionId, institutionId),
      eq(invoices.academicYearId, args.academicYearId),
      // A void invoice is a document that was cancelled; counting its balance as a debt is how
      // a school ends up chasing money nobody owes.
      ne(invoices.status, 'void'),
      isNull(invoices.archivedAt),
    ];
    if (args.studentId) filters.push(eq(invoices.studentId, args.studentId));
    if (restrictedIds !== null) filters.push(inArray(invoices.studentId, restrictedIds));

    // The enrolment join exists only to make the class and section filters possible, so it is
    // added only when one of them was asked for — an unconditional join would multiply an
    // invoice by every enrolment the student has ever held and double-count the debt.
    const needsEnrollment = Boolean(args.sectionId ?? args.classLevelId);
    if (needsEnrollment) {
      filters.push(
        eq(enrollments.academicYearId, args.academicYearId),
        eq(enrollments.status, 'active'),
        isNull(enrollments.archivedAt),
      );
      if (args.sectionId) filters.push(eq(enrollments.sectionId, args.sectionId));
      if (args.classLevelId) filters.push(eq(enrollments.classLevelId, args.classLevelId));
    }

    return this.db.runInTenant(async (tx) => {
      const overdueDays = sql`(${asOfDate}::date - ${invoices.dueDate})`;
      const measures = {
        studentCount: sql<number>`count(distinct ${invoices.studentId})::int`,
        invoiceCount: sql<number>`count(distinct ${invoices.id})::int`,
        billed: sql<string>`coalesce(sum(${invoices.total}), 0)::numeric(14,2)`,
        collected: sql<string>`coalesce(sum(${invoices.paidTotal}), 0)::numeric(14,2)`,
        outstanding: sql<string>`coalesce(sum(${invoices.balance}), 0)::numeric(14,2)`,
        notYetDue: bucket(sql`${overdueDays} <= 0`),
        days1To30: bucket(sql`${overdueDays} between 1 and 30`),
        days31To60: bucket(sql`${overdueDays} between 31 and 60`),
        days61To90: bucket(sql`${overdueDays} between 61 and 90`),
        over90Days: bucket(sql`${overdueDays} > 90`),
      };

      const base = tx.select(measures).from(invoices);
      const query = needsEnrollment
        ? base.innerJoin(enrollments, eq(enrollments.studentId, invoices.studentId))
        : base;

      const [row] = await query.where(and(...filters));

      if (!row) {
        return { data: emptyResult(args.academicYearId, asOfDate, !isOfficer), rowCount: 0 };
      }

      // Parsed through Money and rendered back, so a bucket that Postgres returned as
      // "1200.00" and one it returned as "1200" become the same string on the wire.
      const asMoney = (value: string) => Money.fromDecimalString(value, 'BDT').toDecimalString();

      return {
        data: {
          academicYearId: args.academicYearId,
          asOfDate,
          currency: 'BDT' as const,
          restrictedToOwnRecords: !isOfficer,
          studentCount: row.studentCount,
          invoiceCount: row.invoiceCount,
          billed: asMoney(row.billed),
          collected: asMoney(row.collected),
          outstanding: asMoney(row.outstanding),
          ageing: {
            notYetDue: asMoney(row.notYetDue),
            days1To30: asMoney(row.days1To30),
            days31To60: asMoney(row.days31To60),
            days61To90: asMoney(row.days61To90),
            over90Days: asMoney(row.over90Days),
          },
        },
        rowCount: row.invoiceCount,
      };
    });
  }
}

/** `sum(balance) filter (where <age predicate>)`, as a `numeric(14,2)` string. */
function bucket(predicate: SQL): SQL<string> {
  return sql<string>`coalesce(sum(${invoices.balance}) filter (where ${predicate}), 0)::numeric(14,2)`;
}

function emptyResult(
  academicYearId: string,
  asOfDate: string,
  restricted: boolean,
): FinanceOutstandingData {
  const zero = Money.zero('BDT').toDecimalString();
  return {
    academicYearId,
    asOfDate,
    currency: 'BDT',
    restrictedToOwnRecords: restricted,
    studentCount: 0,
    invoiceCount: 0,
    billed: zero,
    collected: zero,
    outstanding: zero,
    ageing: {
      notYetDue: zero,
      days1To30: zero,
      days31To60: zero,
      days61To90: zero,
      over90Days: zero,
    },
  };
}
