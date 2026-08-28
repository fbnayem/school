/**
 * Academic structure service (Phase 2).
 *
 * The interesting logic is not CRUD — it is the invariants that CRUD would otherwise break:
 *
 *  - Exactly one academic year per institution is `isCurrent`. Setting a new one must unset
 *    the old one *in the same transaction*, or the partial unique index rejects the write and
 *    the user sees a constraint error instead of the operation working.
 *  - Terms are validated as a set (weights sum to 100%, no overlaps), so they are replaced
 *    wholesale rather than edited one at a time.
 *  - A section cannot be archived while students are enrolled in it.
 */

import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { academicYears, classLevels, enrollments, sections, subjects, terms } from '@shikkha/db';
import {
  ConflictError,
  NotFoundError,
  uuidv7,
  ValidationError,
  calendarDate,
  isWithin,
} from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class AcademicService {
  constructor(private readonly db: DatabaseService) {}

  // ── Academic years ──────────────────────────────────────────────────────────────────

  async listAcademicYears(institutionId: string) {
    return this.db.runInTenant(async (tx) =>
      tx
        .select()
        .from(academicYears)
        .where(
          and(eq(academicYears.institutionId, institutionId), isNull(academicYears.archivedAt)),
        )
        .orderBy(asc(academicYears.startDate)),
    );
  }

  async createAcademicYear(
    principal: Principal,
    institutionId: string,
    input: {
      name: string;
      startDate: string;
      endDate: string;
      isCurrent: boolean;
      weekendDays: number[];
    },
  ) {
    return this.db.runInTenant(async (tx) => {
      await this.assertNoOverlappingYear(tx, institutionId, input.startDate, input.endDate, null);

      if (input.isCurrent) {
        // Cleared inside the same transaction as the insert. Doing it in two statements
        // outside a transaction would leave a window with either two current years or none.
        await tx
          .update(academicYears)
          .set({ isCurrent: false, updatedBy: principal.userId })
          .where(
            and(eq(academicYears.institutionId, institutionId), eq(academicYears.isCurrent, true)),
          );
      }

      const [created] = await tx
        .insert(academicYears)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          name: input.name,
          startDate: input.startDate,
          endDate: input.endDate,
          isCurrent: input.isCurrent,
          weekendDays: input.weekendDays,
          status: input.isCurrent ? 'active' : 'planning',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      return created!;
    });
  }

  async setCurrentAcademicYear(principal: Principal, institutionId: string, yearId: string) {
    return this.db.runInTenant(async (tx) => {
      const [target] = await tx
        .select()
        .from(academicYears)
        .where(
          and(
            eq(academicYears.id, yearId),
            eq(academicYears.institutionId, institutionId),
            isNull(academicYears.archivedAt),
          ),
        )
        .limit(1);
      if (!target) throw new NotFoundError('Academic year', yearId);

      if (target.status === 'archived') {
        throw new ConflictError('An archived academic year cannot be made current');
      }

      await tx
        .update(academicYears)
        .set({ isCurrent: false, updatedBy: principal.userId })
        .where(
          and(
            eq(academicYears.institutionId, institutionId),
            eq(academicYears.isCurrent, true),
            ne(academicYears.id, yearId),
          ),
        );

      const [updated] = await tx
        .update(academicYears)
        .set({ isCurrent: true, status: 'active', updatedBy: principal.userId })
        .where(eq(academicYears.id, yearId))
        .returning();

      return updated!;
    });
  }

  // ── Terms ───────────────────────────────────────────────────────────────────────────

  async listTerms(academicYearId: string) {
    return this.db.runInTenant(async (tx) =>
      tx
        .select()
        .from(terms)
        .where(and(eq(terms.academicYearId, academicYearId), isNull(terms.archivedAt)))
        .orderBy(asc(terms.sequence)),
    );
  }

  /**
   * Replace the whole term set for a year.
   *
   * Wholesale rather than incremental because the invariants — weights summing to 100%, no
   * overlapping date ranges — are properties of the set. Editing one term at a time means
   * passing through invalid intermediate states, and there is no sensible way to reject a
   * single edit that leaves the total at 90%.
   */
  async replaceTerms(
    principal: Principal,
    institutionId: string,
    academicYearId: string,
    incoming: Array<{
      id?: string;
      nameEn: string;
      nameBn?: string;
      sequence: number;
      startDate: string;
      endDate: string;
      weightBasisPoints: number;
    }>,
  ) {
    return this.db.runInTenant(async (tx) => {
      const [year] = await tx
        .select()
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

      // Terms outside their own academic year would silently break result aggregation.
      for (const term of incoming) {
        if (
          !isWithin(
            calendarDate(term.startDate),
            calendarDate(year.startDate),
            calendarDate(year.endDate),
          ) ||
          !isWithin(
            calendarDate(term.endDate),
            calendarDate(year.startDate),
            calendarDate(year.endDate),
          )
        ) {
          throw new ValidationError(
            `"${term.nameEn}" falls outside the academic year (${year.startDate} to ${year.endDate})`,
            [{ path: 'terms', message: 'Term dates must lie within the academic year' }],
          );
        }
      }

      const existing = await tx
        .select({ id: terms.id, isClosed: terms.isClosed })
        .from(terms)
        .where(and(eq(terms.academicYearId, academicYearId), isNull(terms.archivedAt)));

      const incomingIds = new Set(incoming.map((term) => term.id).filter(Boolean));
      const removed = existing.filter((term) => !incomingIds.has(term.id));

      // A closed term has marks entered against it. Removing it would orphan them.
      const closedRemoval = removed.find((term) => term.isClosed);
      if (closedRemoval) {
        throw new ConflictError(
          'A term that has been closed cannot be removed. Reopen it first if this is intentional.',
        );
      }

      for (const term of removed) {
        await tx
          .update(terms)
          .set({ archivedAt: new Date(), archivedBy: principal.userId })
          .where(eq(terms.id, term.id));
      }

      const results = [];
      for (const term of incoming) {
        if (term.id) {
          const [updated] = await tx
            .update(terms)
            .set({
              nameEn: term.nameEn,
              nameBn: term.nameBn ?? null,
              sequence: term.sequence,
              startDate: term.startDate,
              endDate: term.endDate,
              weightBasisPoints: term.weightBasisPoints,
              updatedBy: principal.userId,
            })
            .where(eq(terms.id, term.id))
            .returning();
          if (updated) results.push(updated);
        } else {
          const [created] = await tx
            .insert(terms)
            .values({
              id: uuidv7(),
              tenantId: principal.tenantId!,
              institutionId,
              academicYearId,
              nameEn: term.nameEn,
              nameBn: term.nameBn ?? null,
              sequence: term.sequence,
              startDate: term.startDate,
              endDate: term.endDate,
              weightBasisPoints: term.weightBasisPoints,
              createdBy: principal.userId,
              updatedBy: principal.userId,
            })
            .returning();
          if (created) results.push(created);
        }
      }

      return results.sort((a, b) => a.sequence - b.sequence);
    });
  }

  // ── Class levels ────────────────────────────────────────────────────────────────────

  async listClassLevels(institutionId: string) {
    return this.db.runInTenant(async (tx) =>
      tx
        .select()
        .from(classLevels)
        .where(and(eq(classLevels.institutionId, institutionId), isNull(classLevels.archivedAt)))
        .orderBy(asc(classLevels.ordinal)),
    );
  }

  async createClassLevel(
    principal: Principal,
    institutionId: string,
    input: {
      code: string;
      nameEn: string;
      nameBn?: string;
      ordinal: number;
      hasGroups: boolean;
    },
  ) {
    return this.db.runInTenant(async (tx) => {
      const [created] = await tx
        .insert(classLevels)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          code: input.code,
          nameEn: input.nameEn,
          nameBn: input.nameBn ?? null,
          ordinal: input.ordinal,
          hasGroups: input.hasGroups,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  // ── Sections ────────────────────────────────────────────────────────────────────────

  /**
   * Sections with their live enrolment count.
   *
   * The count is a correlated subquery rather than a separate round trip per section — the
   * N+1 version of this endpoint is the first thing that gets slow on a school with 60
   * sections, and it is the exact query a class-list screen makes on every load.
   */
  async listSections(institutionId: string, academicYearId?: string) {
    return this.db.runInTenant(async (tx) => {
      const filters = [eq(sections.institutionId, institutionId), isNull(sections.archivedAt)];
      if (academicYearId) filters.push(eq(sections.academicYearId, academicYearId));

      return tx
        .select({
          id: sections.id,
          nameEn: sections.nameEn,
          nameBn: sections.nameBn,
          capacity: sections.capacity,
          classLevelId: sections.classLevelId,
          classLevelName: classLevels.nameEn,
          classLevelOrdinal: classLevels.ordinal,
          academicYearId: sections.academicYearId,
          campusId: sections.campusId,
          shiftId: sections.shiftId,
          groupId: sections.groupId,
          enrolledCount: sql<number>`(
            select count(*)::int from ${enrollments}
            where ${enrollments.sectionId} = ${sections.id}
              and ${enrollments.status} = 'active'
              and ${enrollments.archivedAt} is null
          )`,
        })
        .from(sections)
        .innerJoin(classLevels, eq(classLevels.id, sections.classLevelId))
        .where(and(...filters))
        .orderBy(asc(classLevels.ordinal), asc(sections.nameEn));
    });
  }

  async createSection(
    principal: Principal,
    institutionId: string,
    input: {
      academicYearId: string;
      classLevelId: string;
      campusId: string;
      shiftId?: string;
      groupId?: string;
      nameEn: string;
      nameBn?: string;
      capacity?: number;
      roomId?: string;
    },
  ) {
    return this.db.runInTenant(async (tx) => {
      // The referenced year and class must belong to this institution. Foreign keys guarantee
      // they exist somewhere in the tenant; only this check guarantees they are *here*.
      const [year] = await tx
        .select({ id: academicYears.id })
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

      const [classLevel] = await tx
        .select({ id: classLevels.id, hasGroups: classLevels.hasGroups })
        .from(classLevels)
        .where(
          and(
            eq(classLevels.id, input.classLevelId),
            eq(classLevels.institutionId, institutionId),
            isNull(classLevels.archivedAt),
          ),
        )
        .limit(1);
      if (!classLevel) throw new NotFoundError('Class', input.classLevelId);

      if (input.groupId && !classLevel.hasGroups) {
        throw new ValidationError('This class does not use groups', [
          { path: 'groupId', message: 'Remove the group, or enable groups on the class first' },
        ]);
      }

      const [created] = await tx
        .insert(sections)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          campusId: input.campusId,
          academicYearId: input.academicYearId,
          classLevelId: input.classLevelId,
          shiftId: input.shiftId ?? null,
          groupId: input.groupId ?? null,
          nameEn: input.nameEn,
          nameBn: input.nameBn ?? null,
          capacity: input.capacity ?? null,
          roomId: input.roomId ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      return created!;
    });
  }

  // ── Subjects ────────────────────────────────────────────────────────────────────────

  async listSubjects(institutionId: string) {
    return this.db.runInTenant(async (tx) =>
      tx
        .select()
        .from(subjects)
        .where(and(eq(subjects.institutionId, institutionId), isNull(subjects.archivedAt)))
        .orderBy(asc(subjects.sortOrder), asc(subjects.nameEn)),
    );
  }

  async createSubject(
    principal: Principal,
    institutionId: string,
    input: {
      code: string;
      nameEn: string;
      nameBn?: string;
      shortName?: string;
      kind: string;
      isFourthSubject: boolean;
      excludeFromGpa: boolean;
      hasPractical: boolean;
      sortOrder: number;
    },
  ) {
    return this.db.runInTenant(async (tx) => {
      const [created] = await tx
        .insert(subjects)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          code: input.code,
          nameEn: input.nameEn,
          nameBn: input.nameBn ?? null,
          shortName: input.shortName ?? null,
          kind: input.kind,
          isFourthSubject: input.isFourthSubject,
          excludeFromGpa: input.excludeFromGpa,
          hasPractical: input.hasPractical,
          sortOrder: input.sortOrder,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  // ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Overlapping academic years would make "which year does this date belong to?" ambiguous,
   * and every attendance record, invoice and result inherits that ambiguity.
   */
  private async assertNoOverlappingYear(
    tx: Parameters<Parameters<DatabaseService['runInTenant']>[0]>[0],
    institutionId: string,
    startDate: string,
    endDate: string,
    excludeId: string | null,
  ): Promise<void> {
    const overlapping = await tx
      .select({ id: academicYears.id, name: academicYears.name })
      .from(academicYears)
      .where(
        and(
          eq(academicYears.institutionId, institutionId),
          isNull(academicYears.archivedAt),
          excludeId ? ne(academicYears.id, excludeId) : sql`true`,
          // Two ranges overlap when each starts before the other ends.
          sql`${academicYears.startDate} <= ${endDate}::date and ${academicYears.endDate} >= ${startDate}::date`,
        ),
      )
      .limit(1);

    if (overlapping.length > 0) {
      throw new ConflictError(
        `These dates overlap the "${overlapping[0]!.name}" academic year. Academic years cannot overlap.`,
      );
    }
  }
}
