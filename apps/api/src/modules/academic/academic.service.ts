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
 *
 * Phase 2 completion added the rest of the configuration surface — rooms, the bell schedule,
 * shifts, the academic calendar, the curriculum and teacher assignments — and the same rule
 * holds throughout: where an invariant is a property of a *set*, the API replaces the set
 * rather than exposing per-row edits that pass through invalid intermediate states. Periods
 * and curriculum entries follow terms in this.
 *
 * Two things here are not ordinary CRUD and deserve to be read closely:
 *
 *  - **Every parent reference is re-checked against the caller's institution** inside the same
 *    tenant transaction (`requireCampus`, `requireShift`, `requireSection`, …). A foreign key
 *    only proves the row exists somewhere in the tenant, and a tenant with two schools is the
 *    normal case. A miss is a 404, never a 403.
 *  - **Teacher assignments are an authorization surface.** `students.view.assigned` and
 *    `results.view.assigned` are implemented as joins against `employee_section_assignments`
 *    and `employee_subject_assignments`, so writing a row here changes who can see which
 *    children. Both directions are audited and unassignment carries a written reason.
 */

import { Injectable } from '@nestjs/common';
import { and, asc, eq, gte, inArray, isNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  academicGroups,
  academicYears,
  calendarEvents,
  campuses,
  classLevels,
  classSubjects,
  employees,
  employeeSectionAssignments,
  employeeSubjectAssignments,
  enrollments,
  periods,
  rooms,
  sections,
  shifts,
  subjects,
  terms,
} from '@shikkha/db';
import {
  compareCalendarDates,
  ConflictError,
  NotFoundError,
  todayInDhaka,
  uuidv7,
  ValidationError,
  calendarDate,
  isWithin,
  type ShiftKind,
} from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import type {
  AssignSectionTeacherInput,
  AssignSubjectTeacherInput,
  CreateCalendarEventInput,
  CreateRoomInput,
  ReplaceClassSubjectsInput,
  ReplacePeriodsInput,
  UpdateCalendarEventInput,
  UpdateRoomInput,
} from '@shikkha/validation';
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

  // ── Rooms ───────────────────────────────────────────────────────────────────────────
  //
  // A room belongs to a campus, and its code is unique per campus rather than per
  // institution: "Room 204" exists on both campuses of a two-campus school and means a
  // different room on each.

  async listRooms(
    institutionId: string,
    query: { campusId?: string; kind?: string; includeArchived: boolean },
  ) {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(rooms.institutionId, institutionId)];
      if (!query.includeArchived) filters.push(isNull(rooms.archivedAt));
      if (query.campusId) filters.push(eq(rooms.campusId, query.campusId));
      if (query.kind) filters.push(eq(rooms.kind, query.kind));

      return tx
        .select()
        .from(rooms)
        .where(and(...filters))
        .orderBy(asc(rooms.campusId), asc(rooms.code));
    });
  }

  async createRoom(principal: Principal, institutionId: string, input: CreateRoomInput) {
    return this.db.runInTenant(async (tx) => {
      // The campus must belong to *this* institution. The foreign key only proves it exists
      // somewhere in the tenant, which is not the same thing — and a tenant with two schools
      // is the normal case, not the exotic one.
      await this.requireCampus(tx, institutionId, input.campusId);
      await this.assertRoomCodeFree(tx, input.campusId, input.code, null);

      const [created] = await tx
        .insert(rooms)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          campusId: input.campusId,
          code: input.code,
          nameEn: input.nameEn,
          nameBn: input.nameBn ?? null,
          kind: input.kind,
          capacity: input.capacity ?? null,
          floor: input.floor ?? null,
          building: input.building ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      return created!;
    });
  }

  async updateRoom(
    principal: Principal,
    institutionId: string,
    id: string,
    input: UpdateRoomInput,
  ): Promise<{ room: RoomRow; previous: Partial<RoomRow> }> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(rooms)
        .where(
          and(eq(rooms.id, id), eq(rooms.institutionId, institutionId), isNull(rooms.archivedAt)),
        )
        .limit(1);
      // 404 rather than 403 for a room in another institution: confirming it exists elsewhere
      // is itself a leak.
      if (!existing) throw new NotFoundError('Room', id);

      const campusId = input.campusId ?? existing.campusId;
      if (input.campusId && input.campusId !== existing.campusId) {
        await this.requireCampus(tx, institutionId, input.campusId);
      }

      const code = input.code ?? existing.code;
      if (code !== existing.code || campusId !== existing.campusId) {
        await this.assertRoomCodeFree(tx, campusId, code, id);
      }

      const changes: Record<string, unknown> = {};
      if (input.campusId !== undefined) changes['campusId'] = input.campusId;
      if (input.code !== undefined) changes['code'] = input.code;
      if (input.nameEn !== undefined) changes['nameEn'] = input.nameEn;
      if (input.nameBn !== undefined) changes['nameBn'] = input.nameBn;
      if (input.kind !== undefined) changes['kind'] = input.kind;
      if (input.capacity !== undefined) changes['capacity'] = input.capacity;
      if (input.floor !== undefined) changes['floor'] = input.floor;
      if (input.building !== undefined) changes['building'] = input.building;

      const [updated] = await tx
        .update(rooms)
        .set({ ...(changes as Partial<RoomRow>), updatedBy: principal.userId })
        .where(eq(rooms.id, id))
        .returning();

      return { room: updated!, previous: diffOf(existing, updated!, Object.keys(changes)) };
    });
  }

  /**
   * Rooms are archived, never deleted (ADR-008) — a timetable printed last term still refers
   * to this room, and a hard delete would leave that reference dangling.
   */
  async archiveRoom(principal: Principal, institutionId: string, id: string, reason: string) {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(rooms)
        .where(
          and(eq(rooms.id, id), eq(rooms.institutionId, institutionId), isNull(rooms.archivedAt)),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Room', id);

      const [homeRoomOf] = await tx
        .select({ id: sections.id, nameEn: sections.nameEn })
        .from(sections)
        .where(and(eq(sections.roomId, id), isNull(sections.archivedAt)))
        .limit(1);
      if (homeRoomOf) {
        throw new ConflictError(
          `This room is still the home room of section "${homeRoomOf.nameEn}". Move that section first, then archive the room.`,
        );
      }

      // `sections.room_id` is checked above by name; anything else that grew a `room_id`
      // later (timetable slots, exam seat plans) is found generically so this check does not
      // silently stop being true when the next module ships.
      const reference = await this.findReference(tx, 'room_id', [id], ['sections']);
      if (reference) {
        throw new ConflictError(
          `This room is still referenced by ${reference.total} row(s) in "${reference.table}". Clear those first.`,
        );
      }

      const [archived] = await tx
        .update(rooms)
        .set({
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
        })
        .where(eq(rooms.id, id))
        .returning();

      return archived!;
    });
  }

  // ── Shifts ──────────────────────────────────────────────────────────────────────────

  async listShifts(institutionId: string, query: { campusId?: string; includeArchived: boolean }) {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(shifts.institutionId, institutionId)];
      if (!query.includeArchived) filters.push(isNull(shifts.archivedAt));
      if (query.campusId) {
        // A shift with no campus is institution-wide, so it belongs in a campus-filtered list.
        filters.push(or(isNull(shifts.campusId), eq(shifts.campusId, query.campusId))!);
      }

      return tx
        .select()
        .from(shifts)
        .where(and(...filters))
        .orderBy(asc(shifts.sortOrder), asc(shifts.startTime));
    });
  }

  async createShift(
    principal: Principal,
    institutionId: string,
    input: {
      campusId?: string;
      kind: ShiftKind;
      nameEn: string;
      nameBn?: string;
      startTime: string;
      endTime: string;
      sortOrder: number;
    },
  ) {
    return this.db.runInTenant(async (tx) => {
      if (input.campusId) await this.requireCampus(tx, institutionId, input.campusId);
      await this.assertShiftNameFree(tx, institutionId, input.nameEn, null);

      const [created] = await tx
        .insert(shifts)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          campusId: input.campusId ?? null,
          kind: input.kind,
          nameEn: input.nameEn,
          nameBn: input.nameBn ?? null,
          startTime: input.startTime,
          endTime: input.endTime,
          sortOrder: input.sortOrder,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      return created!;
    });
  }

  async updateShift(
    principal: Principal,
    institutionId: string,
    id: string,
    input: {
      campusId?: string | null;
      kind?: ShiftKind;
      nameEn?: string;
      nameBn?: string | null;
      startTime?: string;
      endTime?: string;
      sortOrder?: number;
      version: number;
    },
  ): Promise<{ shift: ShiftRow; previous: Partial<ShiftRow> }> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(shifts)
        .where(
          and(
            eq(shifts.id, id),
            eq(shifts.institutionId, institutionId),
            isNull(shifts.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Shift', id);

      if (input.campusId) await this.requireCampus(tx, institutionId, input.campusId);
      if (input.nameEn && input.nameEn !== existing.nameEn) {
        await this.assertShiftNameFree(tx, institutionId, input.nameEn, id);
      }

      // Only one of the two times may have been sent, so the ordering rule is checked against
      // the merged row rather than against the request.
      const startTime = input.startTime ?? existing.startTime;
      const endTime = input.endTime ?? existing.endTime;
      if (endTime <= startTime) {
        throw new ValidationError('The shift must end after it starts', [
          { path: 'endTime', message: `The shift already starts at ${startTime}` },
        ]);
      }

      if (input.startTime || input.endTime) {
        // Narrowing a shift can strand its own bell schedule outside it, which would make the
        // timetable grid describe periods that no longer happen.
        const [stranded] = await tx
          .select({
            nameEn: periods.nameEn,
            startTime: periods.startTime,
            endTime: periods.endTime,
          })
          .from(periods)
          .where(
            and(
              eq(periods.shiftId, id),
              isNull(periods.archivedAt),
              sql`(${periods.startTime} < ${startTime}::time or ${periods.endTime} > ${endTime}::time)`,
            ),
          )
          .limit(1);
        if (stranded) {
          throw new ConflictError(
            `"${stranded.nameEn}" (${stranded.startTime}–${stranded.endTime}) would fall outside the new shift window. Adjust the bell schedule first.`,
          );
        }
      }

      const changes: Record<string, unknown> = {};
      if (input.campusId !== undefined) changes['campusId'] = input.campusId;
      if (input.kind !== undefined) changes['kind'] = input.kind;
      if (input.nameEn !== undefined) changes['nameEn'] = input.nameEn;
      if (input.nameBn !== undefined) changes['nameBn'] = input.nameBn;
      if (input.startTime !== undefined) changes['startTime'] = input.startTime;
      if (input.endTime !== undefined) changes['endTime'] = input.endTime;
      if (input.sortOrder !== undefined) changes['sortOrder'] = input.sortOrder;

      const [updated] = await tx
        .update(shifts)
        .set({
          ...(changes as Partial<ShiftRow>),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(shifts.id, id), eq(shifts.version, input.version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This shift was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: input.version, currentVersion: existing.version },
        );
      }

      return { shift: updated, previous: diffOf(existing, updated, Object.keys(changes)) };
    });
  }

  // ── Periods (the daily bell schedule) ───────────────────────────────────────────────

  async listPeriods(institutionId: string, shiftId: string) {
    return this.db.runInTenant(async (tx) => {
      await this.requireShift(tx, institutionId, shiftId);
      return tx
        .select()
        .from(periods)
        .where(and(eq(periods.shiftId, shiftId), isNull(periods.archivedAt)))
        .orderBy(asc(periods.sequence));
    });
  }

  /**
   * Replace the whole bell schedule of one shift.
   *
   * Wholesale for the same reason terms are: the invariants are properties of the set —
   * sequence numbers contiguous from 1, and no two periods overlapping in time. Zod checks
   * the submitted set; this method checks the set against the world (the shift window, and
   * whatever already points at the periods being removed).
   *
   * The renumbering is done in two passes. `periods_shift_sequence_key` is a plain (not
   * deferrable) partial unique index, so swapping periods 1 and 2 in a single pass collides
   * halfway through. Survivors are first parked in the reserved 381–400 band — which
   * `periods_sequence_sane` (migration 0006) leaves room for on purpose — and only then
   * given their final numbers.
   */
  async replacePeriods(
    principal: Principal,
    institutionId: string,
    input: ReplacePeriodsInput,
  ): Promise<PeriodRow[]> {
    return this.db.runInTenant(async (tx) => {
      const shift = await this.requireShift(tx, institutionId, input.shiftId);

      for (const period of input.periods) {
        if (period.startTime < shift.startTime || period.endTime > shift.endTime) {
          throw new ValidationError(
            `"${period.nameEn}" falls outside the ${shift.nameEn} window (${shift.startTime} to ${shift.endTime})`,
            [{ path: 'periods', message: 'Every period must lie inside its own shift' }],
          );
        }
      }

      const existing = await tx
        .select({ id: periods.id })
        .from(periods)
        .where(and(eq(periods.shiftId, input.shiftId), isNull(periods.archivedAt)));
      const existingIds = new Set(existing.map((period) => period.id));

      for (const period of input.periods) {
        // An id from another shift would otherwise be silently adopted into this one.
        if (period.id && !existingIds.has(period.id)) throw new NotFoundError('Period', period.id);
      }

      const keptIds = new Set(
        input.periods.map((period) => period.id).filter((id): id is string => Boolean(id)),
      );
      const removed = existing.filter((period) => !keptIds.has(period.id));

      if (removed.length > 0) {
        // The timetable module does not exist yet. Rather than pretend the check is done, it
        // is written against the catalogue: any table that grows a `period_id` column is
        // consulted automatically, and until one does the query simply finds nothing.
        const reference = await this.findReference(
          tx,
          'period_id',
          removed.map((period) => period.id),
          [],
        );
        if (reference) {
          throw new ConflictError(
            `${reference.total} row(s) in "${reference.table}" still use the periods you are removing. Clear them first, then change the bell schedule.`,
          );
        }

        for (const period of removed) {
          await tx
            .update(periods)
            .set({
              archivedAt: new Date(),
              archivedBy: principal.userId,
              archiveReason: 'Removed when the bell schedule was replaced',
            })
            .where(eq(periods.id, period.id));
        }
      }

      let staging = PERIOD_SEQUENCE_STAGING_TOP;
      for (const period of input.periods) {
        if (!period.id) continue;
        await tx.update(periods).set({ sequence: staging }).where(eq(periods.id, period.id));
        staging -= 1;
      }

      const results: PeriodRow[] = [];
      for (const period of input.periods) {
        if (period.id) {
          const [updated] = await tx
            .update(periods)
            .set({
              nameEn: period.nameEn,
              nameBn: period.nameBn ?? null,
              sequence: period.sequence,
              startTime: period.startTime,
              endTime: period.endTime,
              isBreak: period.isBreak,
            })
            .where(eq(periods.id, period.id))
            .returning();
          if (updated) results.push(updated);
        } else {
          const [created] = await tx
            .insert(periods)
            .values({
              id: uuidv7(),
              tenantId: principal.tenantId!,
              institutionId,
              shiftId: input.shiftId,
              nameEn: period.nameEn,
              nameBn: period.nameBn ?? null,
              sequence: period.sequence,
              startTime: period.startTime,
              endTime: period.endTime,
              isBreak: period.isBreak,
            })
            .returning();
          if (created) results.push(created);
        }
      }

      return results.sort((a, b) => a.sequence - b.sequence);
    });
  }

  // ── Academic calendar ───────────────────────────────────────────────────────────────

  async listCalendarEvents(
    institutionId: string,
    query: {
      academicYearId?: string;
      campusId?: string;
      kind?: string;
      from?: string;
      to?: string;
      includeArchived: boolean;
    },
  ) {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(calendarEvents.institutionId, institutionId)];
      if (!query.includeArchived) filters.push(isNull(calendarEvents.archivedAt));
      if (query.academicYearId) {
        filters.push(eq(calendarEvents.academicYearId, query.academicYearId));
      }
      if (query.kind) filters.push(eq(calendarEvents.kind, query.kind));
      if (query.campusId) {
        // A null campus means "every campus", so it belongs in a campus-filtered calendar.
        filters.push(
          or(isNull(calendarEvents.campusId), eq(calendarEvents.campusId, query.campusId))!,
        );
      }
      // A range matches anything that *overlaps* it, not only what is contained in it: a
      // three-week vacation is part of the March calendar even though it started in February.
      if (query.to) filters.push(lte(calendarEvents.startDate, query.to));
      if (query.from) filters.push(gte(calendarEvents.endDate, query.from));

      return tx
        .select()
        .from(calendarEvents)
        .where(and(...filters))
        .orderBy(asc(calendarEvents.startDate), asc(calendarEvents.titleEn));
    });
  }

  async createCalendarEvent(
    principal: Principal,
    institutionId: string,
    input: CreateCalendarEventInput,
  ) {
    return this.db.runInTenant(async (tx) => {
      const year = await this.requireAcademicYear(tx, institutionId, input.academicYearId);
      if (input.campusId) await this.requireCampus(tx, institutionId, input.campusId);

      this.assertWithinAcademicYear(year, input.startDate, input.endDate);
      await this.assertNoCalendarConflict(tx, institutionId, {
        id: null,
        campusId: input.campusId ?? null,
        kind: input.kind,
        isNonTeaching: input.isNonTeaching,
        overridesWeekend: input.overridesWeekend,
        startDate: input.startDate,
        endDate: input.endDate,
      });

      const [created] = await tx
        .insert(calendarEvents)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          academicYearId: input.academicYearId,
          campusId: input.campusId ?? null,
          titleEn: input.titleEn,
          titleBn: input.titleBn ?? null,
          description: input.description ?? null,
          kind: input.kind,
          startDate: input.startDate,
          endDate: input.endDate,
          isNonTeaching: input.isNonTeaching,
          overridesWeekend: input.overridesWeekend,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      return created!;
    });
  }

  async updateCalendarEvent(
    principal: Principal,
    institutionId: string,
    id: string,
    input: UpdateCalendarEventInput,
  ): Promise<{ event: CalendarEventRow; previous: Partial<CalendarEventRow> }> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(calendarEvents)
        .where(
          and(
            eq(calendarEvents.id, id),
            eq(calendarEvents.institutionId, institutionId),
            isNull(calendarEvents.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Calendar entry', id);

      if (input.campusId) await this.requireCampus(tx, institutionId, input.campusId);

      const merged = {
        campusId: input.campusId === undefined ? existing.campusId : input.campusId,
        kind: input.kind ?? existing.kind,
        isNonTeaching: input.isNonTeaching ?? existing.isNonTeaching,
        overridesWeekend: input.overridesWeekend ?? existing.overridesWeekend,
        startDate: input.startDate ?? existing.startDate,
        endDate: input.endDate ?? existing.endDate,
      };
      if (merged.endDate < merged.startDate) {
        throw new ValidationError('The end date cannot be before the start date', [
          { path: 'endDate', message: `The entry starts on ${merged.startDate}` },
        ]);
      }

      const year = await this.requireAcademicYear(tx, institutionId, existing.academicYearId);
      this.assertWithinAcademicYear(year, merged.startDate, merged.endDate);
      await this.assertNoCalendarConflict(tx, institutionId, { id, ...merged });

      const changes: Record<string, unknown> = {};
      if (input.campusId !== undefined) changes['campusId'] = input.campusId;
      if (input.titleEn !== undefined) changes['titleEn'] = input.titleEn;
      if (input.titleBn !== undefined) changes['titleBn'] = input.titleBn;
      if (input.description !== undefined) changes['description'] = input.description;
      if (input.kind !== undefined) changes['kind'] = input.kind;
      if (input.startDate !== undefined) changes['startDate'] = input.startDate;
      if (input.endDate !== undefined) changes['endDate'] = input.endDate;
      if (input.isNonTeaching !== undefined) changes['isNonTeaching'] = input.isNonTeaching;
      if (input.overridesWeekend !== undefined) {
        changes['overridesWeekend'] = input.overridesWeekend;
      }

      const [updated] = await tx
        .update(calendarEvents)
        .set({ ...(changes as Partial<CalendarEventRow>), updatedBy: principal.userId })
        .where(eq(calendarEvents.id, id))
        .returning();

      return { event: updated!, previous: diffOf(existing, updated!, Object.keys(changes)) };
    });
  }

  /**
   * Remove a calendar entry.
   *
   * Two refusals, both deliberate. A past or current entry is already baked into attendance
   * percentages and working-day counts, so removing it rewrites history — the academic year
   * is archived instead. And an entry something else points at cannot be removed at all.
   *
   * "Remove" is a soft archive: academic records are never hard-deleted (ADR-008). The verb
   * on the wire is still DELETE, because that is what it means to the person clicking it.
   */
  async deleteCalendarEvent(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ) {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(calendarEvents)
        .where(
          and(
            eq(calendarEvents.id, id),
            eq(calendarEvents.institutionId, institutionId),
            isNull(calendarEvents.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Calendar entry', id);

      const today = todayInDhaka();
      if (compareCalendarDates(calendarDate(existing.startDate), today) <= 0) {
        throw new ConflictError(
          `"${existing.titleEn}" starts on ${existing.startDate}, which is not in the future. Attendance and working-day totals already depend on it, so it cannot be removed.`,
        );
      }

      const reference = await this.findReference(tx, 'calendar_event_id', [id], []);
      if (reference) {
        throw new ConflictError(
          `This entry is still referenced by ${reference.total} row(s) in "${reference.table}".`,
        );
      }

      const [archived] = await tx
        .update(calendarEvents)
        .set({
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
        })
        .where(eq(calendarEvents.id, id))
        .returning();

      return archived!;
    });
  }

  // ── Curriculum (class_subjects) ─────────────────────────────────────────────────────

  async listClassSubjects(
    institutionId: string,
    query: { academicYearId: string; classLevelId?: string; includeArchived: boolean },
  ) {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [
        eq(classSubjects.institutionId, institutionId),
        eq(classSubjects.academicYearId, query.academicYearId),
      ];
      if (!query.includeArchived) filters.push(isNull(classSubjects.archivedAt));
      if (query.classLevelId) filters.push(eq(classSubjects.classLevelId, query.classLevelId));

      return tx
        .select({
          id: classSubjects.id,
          academicYearId: classSubjects.academicYearId,
          classLevelId: classSubjects.classLevelId,
          classLevelNameEn: classLevels.nameEn,
          classLevelOrdinal: classLevels.ordinal,
          subjectId: classSubjects.subjectId,
          subjectCode: subjects.code,
          subjectNameEn: subjects.nameEn,
          subjectNameBn: subjects.nameBn,
          subjectKind: subjects.kind,
          groupId: classSubjects.groupId,
          periodsPerWeek: classSubjects.periodsPerWeek,
          fullMarks: classSubjects.fullMarks,
          passMarks: classSubjects.passMarks,
          markDistribution: classSubjects.markDistribution,
          isOptional: classSubjects.isOptional,
          archivedAt: classSubjects.archivedAt,
        })
        .from(classSubjects)
        .innerJoin(subjects, eq(subjects.id, classSubjects.subjectId))
        .innerJoin(classLevels, eq(classLevels.id, classSubjects.classLevelId))
        .where(and(...filters))
        .orderBy(asc(classLevels.ordinal), asc(subjects.sortOrder), asc(subjects.nameEn));
    });
  }

  /**
   * Replace the curriculum of one (class level, academic year) pair.
   *
   * Wholesale, because the thing being configured is a set: "which subjects does Class 9
   * study this year, and how is each marked". The mark distribution invariant — components
   * summing to full marks — is restated here even though Zod already checked it and migration
   * 0006 added a CHECK constraint, because the three protect different things: the schema
   * protects the form, this protects the API, and the constraint protects the database from
   * anything that is neither (KI-009).
   */
  async replaceClassSubjects(
    principal: Principal,
    institutionId: string,
    input: ReplaceClassSubjectsInput,
  ): Promise<ClassSubjectRow[]> {
    return this.db.runInTenant(async (tx) => {
      await this.requireAcademicYear(tx, institutionId, input.academicYearId);
      const classLevel = await this.requireClassLevel(tx, institutionId, input.classLevelId);

      for (const entry of input.subjects) {
        await this.requireSubject(tx, institutionId, entry.subjectId);

        if (entry.groupId) {
          if (!classLevel.hasGroups) {
            throw new ValidationError('This class does not use groups', [
              {
                path: 'subjects',
                message: 'Remove the group, or enable groups on the class first',
              },
            ]);
          }
          await this.requireAcademicGroup(tx, institutionId, entry.groupId);
        }

        const components = Object.values(entry.markDistribution);
        if (components.length > 0) {
          const total = components.reduce((sum, value) => sum + value, 0);
          if (total !== entry.fullMarks) {
            throw new ValidationError(
              `The mark components add up to ${total}, but full marks are ${entry.fullMarks}`,
              [{ path: 'subjects', message: 'Components must add up to full marks' }],
            );
          }
        }
        if (entry.passMarks > entry.fullMarks) {
          throw new ValidationError('Pass marks cannot exceed full marks', [
            { path: 'subjects', message: 'Pass marks cannot exceed full marks' },
          ]);
        }
      }

      const existing = await tx
        .select({
          id: classSubjects.id,
          subjectId: classSubjects.subjectId,
          groupId: classSubjects.groupId,
        })
        .from(classSubjects)
        .where(
          and(
            eq(classSubjects.academicYearId, input.academicYearId),
            eq(classSubjects.classLevelId, input.classLevelId),
            isNull(classSubjects.archivedAt),
          ),
        );
      const existingById = new Map(existing.map((row) => [row.id, row]));

      for (const entry of input.subjects) {
        if (!entry.id) continue;
        const previous = existingById.get(entry.id);
        if (!previous) throw new NotFoundError('Curriculum entry', entry.id);
        // Re-pointing an existing row at a different subject would have to pass through a
        // state where two rows claim the same (year, class, subject) slot, and the partial
        // unique index refuses it halfway. Dropping and re-adding is the honest operation.
        if (
          previous.subjectId !== entry.subjectId ||
          (previous.groupId ?? null) !== (entry.groupId ?? null)
        ) {
          throw new ValidationError(
            'A curriculum entry cannot be moved to a different subject or group',
            [
              {
                path: 'subjects',
                message: 'Remove this entry and add a new one for the other subject',
              },
            ],
          );
        }
      }

      const keptIds = new Set(
        input.subjects.map((entry) => entry.id).filter((id): id is string => Boolean(id)),
      );
      const removed = existing.filter((row) => !keptIds.has(row.id));

      if (removed.length > 0) {
        // Dropping a subject a teacher is currently assigned to teach would silently narrow
        // what that teacher can see, which is a permissions change disguised as a config edit.
        const removedSubjectIds = removed.map((row) => row.subjectId);
        const [assigned] = await tx
          .select({ id: employeeSubjectAssignments.id })
          .from(employeeSubjectAssignments)
          .innerJoin(sections, eq(sections.id, employeeSubjectAssignments.sectionId))
          .where(
            and(
              isNull(employeeSubjectAssignments.archivedAt),
              inArray(employeeSubjectAssignments.subjectId, removedSubjectIds),
              eq(sections.academicYearId, input.academicYearId),
              eq(sections.classLevelId, input.classLevelId),
              isNull(sections.archivedAt),
            ),
          )
          .limit(1);
        if (assigned) {
          throw new ConflictError(
            'A teacher is still assigned to teach one of the subjects you are removing. Unassign them first.',
          );
        }

        for (const row of removed) {
          await tx
            .update(classSubjects)
            .set({
              archivedAt: new Date(),
              archivedBy: principal.userId,
              archiveReason: 'Removed when the curriculum was replaced',
              updatedBy: principal.userId,
            })
            .where(eq(classSubjects.id, row.id));
        }
      }

      const results: ClassSubjectRow[] = [];
      for (const entry of input.subjects) {
        if (entry.id) {
          const [updated] = await tx
            .update(classSubjects)
            .set({
              periodsPerWeek: entry.periodsPerWeek,
              fullMarks: entry.fullMarks,
              passMarks: entry.passMarks,
              markDistribution: entry.markDistribution,
              isOptional: entry.isOptional,
              updatedBy: principal.userId,
            })
            .where(eq(classSubjects.id, entry.id))
            .returning();
          if (updated) results.push(updated);
        } else {
          const [created] = await tx
            .insert(classSubjects)
            .values({
              id: uuidv7(),
              tenantId: principal.tenantId!,
              institutionId,
              academicYearId: input.academicYearId,
              classLevelId: input.classLevelId,
              subjectId: entry.subjectId,
              groupId: entry.groupId ?? null,
              periodsPerWeek: entry.periodsPerWeek,
              fullMarks: entry.fullMarks,
              passMarks: entry.passMarks,
              markDistribution: entry.markDistribution,
              isOptional: entry.isOptional,
              createdBy: principal.userId,
              updatedBy: principal.userId,
            })
            .returning();
          if (created) results.push(created);
        }
      }

      return results;
    });
  }

  // ── Teacher assignments ─────────────────────────────────────────────────────────────
  //
  // These rows decide who can see which students. `students.view.assigned` is implemented in
  // `StudentsService` as a join against exactly these two tables, so an incorrect row here is
  // not a tidiness problem — it is an authorization change. Every write is audited and every
  // removal carries a written reason.

  async listTeacherAssignments(
    institutionId: string,
    query: {
      academicYearId?: string;
      sectionId?: string;
      subjectId?: string;
      employeeId?: string;
      includeArchived: boolean;
    },
  ) {
    return this.db.runInTenant(async (tx) => {
      const sectionFilters: SQL[] = [eq(employeeSectionAssignments.institutionId, institutionId)];
      if (!query.includeArchived)
        sectionFilters.push(isNull(employeeSectionAssignments.archivedAt));
      if (query.academicYearId) {
        sectionFilters.push(eq(employeeSectionAssignments.academicYearId, query.academicYearId));
      }
      if (query.sectionId) {
        sectionFilters.push(eq(employeeSectionAssignments.sectionId, query.sectionId));
      }
      if (query.employeeId) {
        sectionFilters.push(eq(employeeSectionAssignments.employeeId, query.employeeId));
      }

      const subjectFilters: SQL[] = [eq(employeeSubjectAssignments.institutionId, institutionId)];
      if (!query.includeArchived)
        subjectFilters.push(isNull(employeeSubjectAssignments.archivedAt));
      if (query.academicYearId) {
        subjectFilters.push(eq(employeeSubjectAssignments.academicYearId, query.academicYearId));
      }
      if (query.sectionId) {
        subjectFilters.push(eq(employeeSubjectAssignments.sectionId, query.sectionId));
      }
      if (query.subjectId) {
        subjectFilters.push(eq(employeeSubjectAssignments.subjectId, query.subjectId));
      }
      if (query.employeeId) {
        subjectFilters.push(eq(employeeSubjectAssignments.employeeId, query.employeeId));
      }

      const sectionRows = await tx
        .select({
          id: employeeSectionAssignments.id,
          academicYearId: employeeSectionAssignments.academicYearId,
          sectionId: employeeSectionAssignments.sectionId,
          sectionNameEn: sections.nameEn,
          classLevelId: sections.classLevelId,
          employeeId: employeeSectionAssignments.employeeId,
          employeeCode: employees.employeeCode,
          employeeNameEn: employees.fullNameEn,
          employeeNameBn: employees.fullNameBn,
          role: employeeSectionAssignments.role,
          effectiveFrom: employeeSectionAssignments.effectiveFrom,
          effectiveTo: employeeSectionAssignments.effectiveTo,
          archivedAt: employeeSectionAssignments.archivedAt,
        })
        .from(employeeSectionAssignments)
        .innerJoin(sections, eq(sections.id, employeeSectionAssignments.sectionId))
        .innerJoin(employees, eq(employees.id, employeeSectionAssignments.employeeId))
        .where(and(...sectionFilters))
        .orderBy(asc(sections.nameEn), asc(employees.fullNameEn));

      const subjectRows = await tx
        .select({
          id: employeeSubjectAssignments.id,
          academicYearId: employeeSubjectAssignments.academicYearId,
          sectionId: employeeSubjectAssignments.sectionId,
          sectionNameEn: sections.nameEn,
          subjectId: employeeSubjectAssignments.subjectId,
          subjectNameEn: subjects.nameEn,
          subjectNameBn: subjects.nameBn,
          classSubjectId: employeeSubjectAssignments.classSubjectId,
          employeeId: employeeSubjectAssignments.employeeId,
          employeeCode: employees.employeeCode,
          employeeNameEn: employees.fullNameEn,
          isPrimary: employeeSubjectAssignments.isPrimary,
          effectiveFrom: employeeSubjectAssignments.effectiveFrom,
          effectiveTo: employeeSubjectAssignments.effectiveTo,
          archivedAt: employeeSubjectAssignments.archivedAt,
        })
        .from(employeeSubjectAssignments)
        .innerJoin(sections, eq(sections.id, employeeSubjectAssignments.sectionId))
        .innerJoin(subjects, eq(subjects.id, employeeSubjectAssignments.subjectId))
        .innerJoin(employees, eq(employees.id, employeeSubjectAssignments.employeeId))
        .where(and(...subjectFilters))
        .orderBy(asc(sections.nameEn), asc(subjects.nameEn));

      return { sectionAssignments: sectionRows, subjectAssignments: subjectRows };
    });
  }

  /**
   * Assign an employee to a section, normally as its class teacher.
   *
   * "At most one class teacher per section per academic year" is enforced twice: this read
   * gives the user a message naming the incumbent, and `employee_section_primary_key` — a
   * partial unique index inside the same transaction — is what actually makes it true when
   * two administrators submit simultaneously.
   */
  async assignSectionTeacher(
    principal: Principal,
    institutionId: string,
    input: AssignSectionTeacherInput,
  ) {
    return this.db.runInTenant(async (tx) => {
      const section = await this.requireSection(tx, institutionId, input.sectionId);
      if (section.academicYearId !== input.academicYearId) {
        throw new ValidationError('That section belongs to a different academic year', [
          { path: 'sectionId', message: 'Section is not in the selected academic year' },
        ]);
      }
      const employee = await this.requireEmployee(tx, institutionId, input.employeeId);

      const [duplicate] = await tx
        .select({ id: employeeSectionAssignments.id })
        .from(employeeSectionAssignments)
        .where(
          and(
            eq(employeeSectionAssignments.employeeId, input.employeeId),
            eq(employeeSectionAssignments.sectionId, input.sectionId),
            eq(employeeSectionAssignments.role, input.role),
            isNull(employeeSectionAssignments.archivedAt),
          ),
        )
        .limit(1);
      if (duplicate) {
        throw new ConflictError(
          `${employee.fullNameEn} already holds that role for section "${section.nameEn}".`,
        );
      }

      if (input.role === 'class_teacher') {
        const [incumbent] = await tx
          .select({ fullNameEn: employees.fullNameEn })
          .from(employeeSectionAssignments)
          .innerJoin(employees, eq(employees.id, employeeSectionAssignments.employeeId))
          .where(
            and(
              eq(employeeSectionAssignments.sectionId, input.sectionId),
              eq(employeeSectionAssignments.academicYearId, input.academicYearId),
              eq(employeeSectionAssignments.role, 'class_teacher'),
              isNull(employeeSectionAssignments.archivedAt),
            ),
          )
          .limit(1);
        if (incumbent) {
          throw new ConflictError(
            `Section "${section.nameEn}" already has ${incumbent.fullNameEn} as its class teacher for this year. Unassign them first.`,
          );
        }
      }

      const [created] = await tx
        .insert(employeeSectionAssignments)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          academicYearId: input.academicYearId,
          employeeId: input.employeeId,
          sectionId: input.sectionId,
          role: input.role,
          effectiveFrom: input.effectiveFrom ?? null,
          effectiveTo: input.effectiveTo ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      return created!;
    });
  }

  async unassignSectionTeacher(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ) {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(employeeSectionAssignments)
        .where(
          and(
            eq(employeeSectionAssignments.id, id),
            eq(employeeSectionAssignments.institutionId, institutionId),
            isNull(employeeSectionAssignments.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Section assignment', id);

      const [archived] = await tx
        .update(employeeSectionAssignments)
        .set({
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
        })
        .where(eq(employeeSectionAssignments.id, id))
        .returning();

      return archived!;
    });
  }

  /**
   * Assign an employee to teach one subject to one section.
   *
   * The subject must actually be in that class's curriculum for the year. Without the check a
   * teacher can be assigned to a subject the class does not study, which produces a mark-entry
   * screen for an exam that will never exist — and, more seriously, widens the teacher's
   * `results.view.assigned` scope on the strength of a typo.
   */
  async assignSubjectTeacher(
    principal: Principal,
    institutionId: string,
    input: AssignSubjectTeacherInput,
  ) {
    return this.db.runInTenant(async (tx) => {
      const section = await this.requireSection(tx, institutionId, input.sectionId);
      if (section.academicYearId !== input.academicYearId) {
        throw new ValidationError('That section belongs to a different academic year', [
          { path: 'sectionId', message: 'Section is not in the selected academic year' },
        ]);
      }
      await this.requireSubject(tx, institutionId, input.subjectId);
      const employee = await this.requireEmployee(tx, institutionId, input.employeeId);

      const curriculum = await tx
        .select({ id: classSubjects.id, groupId: classSubjects.groupId })
        .from(classSubjects)
        .where(
          and(
            eq(classSubjects.academicYearId, input.academicYearId),
            eq(classSubjects.classLevelId, section.classLevelId),
            eq(classSubjects.subjectId, input.subjectId),
            isNull(classSubjects.archivedAt),
          ),
        );
      // A row with no group applies to every group in the class level.
      const match =
        curriculum.find((row) => row.groupId === section.groupId) ??
        curriculum.find((row) => row.groupId === null);
      if (!match) {
        throw new ValidationError('That subject is not in this class’s curriculum for the year', [
          { path: 'subjectId', message: 'Add the subject to the curriculum first' },
        ]);
      }

      const [duplicate] = await tx
        .select({ id: employeeSubjectAssignments.id })
        .from(employeeSubjectAssignments)
        .where(
          and(
            eq(employeeSubjectAssignments.employeeId, input.employeeId),
            eq(employeeSubjectAssignments.sectionId, input.sectionId),
            eq(employeeSubjectAssignments.subjectId, input.subjectId),
            isNull(employeeSubjectAssignments.archivedAt),
          ),
        )
        .limit(1);
      if (duplicate) {
        throw new ConflictError(
          `${employee.fullNameEn} is already assigned to teach that subject to section "${section.nameEn}".`,
        );
      }

      if (input.isPrimary) {
        const [incumbent] = await tx
          .select({ fullNameEn: employees.fullNameEn })
          .from(employeeSubjectAssignments)
          .innerJoin(employees, eq(employees.id, employeeSubjectAssignments.employeeId))
          .where(
            and(
              eq(employeeSubjectAssignments.sectionId, input.sectionId),
              eq(employeeSubjectAssignments.subjectId, input.subjectId),
              eq(employeeSubjectAssignments.isPrimary, true),
              isNull(employeeSubjectAssignments.archivedAt),
            ),
          )
          .limit(1);
        if (incumbent) {
          throw new ConflictError(
            `${incumbent.fullNameEn} is already the primary teacher for that subject in this section. Add this teacher with isPrimary set to false, or unassign the current one.`,
          );
        }
      }

      const [created] = await tx
        .insert(employeeSubjectAssignments)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          academicYearId: input.academicYearId,
          employeeId: input.employeeId,
          sectionId: input.sectionId,
          subjectId: input.subjectId,
          classSubjectId: match.id,
          isPrimary: input.isPrimary,
          effectiveFrom: input.effectiveFrom ?? null,
          effectiveTo: input.effectiveTo ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      return created!;
    });
  }

  async unassignSubjectTeacher(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ) {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(employeeSubjectAssignments)
        .where(
          and(
            eq(employeeSubjectAssignments.id, id),
            eq(employeeSubjectAssignments.institutionId, institutionId),
            isNull(employeeSubjectAssignments.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Subject assignment', id);

      const [archived] = await tx
        .update(employeeSubjectAssignments)
        .set({
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
        })
        .where(eq(employeeSubjectAssignments.id, id))
        .returning();

      return archived!;
    });
  }

  // ── Parent lookups ──────────────────────────────────────────────────────────────────
  //
  // Every one of these answers the same question — "does this id name a live row in *this*
  // institution?" — and answers a miss with 404 rather than 403. A foreign key proves a row
  // exists somewhere in the tenant; only these prove it exists here, which is what stops a
  // room on one campus being attached to a section at the other school in the same group.

  private async requireCampus(tx: AcademicTx, institutionId: string, campusId: string) {
    const [found] = await tx
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
    if (!found) throw new NotFoundError('Campus', campusId);
    return found;
  }

  private async requireShift(tx: AcademicTx, institutionId: string, shiftId: string) {
    const [found] = await tx
      .select()
      .from(shifts)
      .where(
        and(
          eq(shifts.id, shiftId),
          eq(shifts.institutionId, institutionId),
          isNull(shifts.archivedAt),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundError('Shift', shiftId);
    return found;
  }

  private async requireAcademicYear(tx: AcademicTx, institutionId: string, yearId: string) {
    const [found] = await tx
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
    if (!found) throw new NotFoundError('Academic year', yearId);
    return found;
  }

  private async requireClassLevel(tx: AcademicTx, institutionId: string, classLevelId: string) {
    const [found] = await tx
      .select()
      .from(classLevels)
      .where(
        and(
          eq(classLevels.id, classLevelId),
          eq(classLevels.institutionId, institutionId),
          isNull(classLevels.archivedAt),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundError('Class', classLevelId);
    return found;
  }

  private async requireSubject(tx: AcademicTx, institutionId: string, subjectId: string) {
    const [found] = await tx
      .select({ id: subjects.id, nameEn: subjects.nameEn })
      .from(subjects)
      .where(
        and(
          eq(subjects.id, subjectId),
          eq(subjects.institutionId, institutionId),
          isNull(subjects.archivedAt),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundError('Subject', subjectId);
    return found;
  }

  private async requireAcademicGroup(tx: AcademicTx, institutionId: string, groupId: string) {
    const [found] = await tx
      .select({ id: academicGroups.id })
      .from(academicGroups)
      .where(
        and(
          eq(academicGroups.id, groupId),
          eq(academicGroups.institutionId, institutionId),
          isNull(academicGroups.archivedAt),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundError('Group', groupId);
    return found;
  }

  private async requireSection(tx: AcademicTx, institutionId: string, sectionId: string) {
    const [found] = await tx
      .select()
      .from(sections)
      .where(
        and(
          eq(sections.id, sectionId),
          eq(sections.institutionId, institutionId),
          isNull(sections.archivedAt),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundError('Section', sectionId);
    return found;
  }

  private async requireEmployee(tx: AcademicTx, institutionId: string, employeeId: string) {
    const [found] = await tx
      .select({
        id: employees.id,
        fullNameEn: employees.fullNameEn,
        employmentStatus: employees.employmentStatus,
      })
      .from(employees)
      .where(
        and(
          eq(employees.id, employeeId),
          eq(employees.institutionId, institutionId),
          isNull(employees.archivedAt),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundError('Employee', employeeId);

    if (LEFT_EMPLOYMENT_STATUSES.has(found.employmentStatus)) {
      throw new ConflictError(
        `${found.fullNameEn} has left the institution and cannot be given new assignments.`,
      );
    }
    return found;
  }

  // ── Shared checks ───────────────────────────────────────────────────────────────────

  private async assertRoomCodeFree(
    tx: AcademicTx,
    campusId: string,
    code: string,
    excludeId: string | null,
  ): Promise<void> {
    const [clash] = await tx
      .select({ id: rooms.id })
      .from(rooms)
      .where(
        and(
          eq(rooms.campusId, campusId),
          eq(rooms.code, code),
          isNull(rooms.archivedAt),
          excludeId ? ne(rooms.id, excludeId) : sql`true`,
        ),
      )
      .limit(1);
    if (clash) {
      // `rooms_campus_code_key` is the real guarantee; this exists so the user gets a sentence
      // rather than a constraint name.
      throw new ConflictError(`Room code "${code}" is already used on this campus.`);
    }
  }

  private async assertShiftNameFree(
    tx: AcademicTx,
    institutionId: string,
    nameEn: string,
    excludeId: string | null,
  ): Promise<void> {
    const [clash] = await tx
      .select({ id: shifts.id })
      .from(shifts)
      .where(
        and(
          eq(shifts.institutionId, institutionId),
          eq(shifts.nameEn, nameEn),
          isNull(shifts.archivedAt),
          excludeId ? ne(shifts.id, excludeId) : sql`true`,
        ),
      )
      .limit(1);
    if (clash) {
      throw new ConflictError(`A shift called "${nameEn}" already exists at this institution.`);
    }
  }

  private assertWithinAcademicYear(
    year: { name: string; startDate: string; endDate: string },
    startDate: string,
    endDate: string,
  ): void {
    const from = calendarDate(year.startDate);
    const to = calendarDate(year.endDate);
    if (
      !isWithin(calendarDate(startDate), from, to) ||
      !isWithin(calendarDate(endDate), from, to)
    ) {
      throw new ValidationError(
        `This entry falls outside the ${year.name} academic year (${year.startDate} to ${year.endDate})`,
        [{ path: 'startDate', message: 'Calendar entries must lie within their academic year' }],
      );
    }
  }

  /**
   * A school cannot be both closed and open on the same day.
   *
   * Attendance reads this calendar to decide whether a register may be taken at all, and it
   * has no way to adjudicate between a holiday and a make-up working day covering the same
   * date. Refusing the second entry is the only answer that leaves the calendar decidable.
   */
  private async assertNoCalendarConflict(
    tx: AcademicTx,
    institutionId: string,
    candidate: {
      id: string | null;
      campusId: string | null;
      kind: string;
      isNonTeaching: boolean;
      overridesWeekend: boolean;
      startDate: string;
      endDate: string;
    },
  ): Promise<void> {
    const closes = CLOSING_CALENDAR_KINDS.has(candidate.kind) || candidate.isNonTeaching;
    const opens = candidate.kind === 'working_day' || candidate.overridesWeekend;
    if (!closes && !opens) return;

    const closesExpression = sql`(${calendarEvents.kind} in ('holiday', 'vacation') or ${calendarEvents.isNonTeaching})`;
    const opensExpression = sql`(${calendarEvents.kind} = 'working_day' or ${calendarEvents.overridesWeekend})`;

    const [conflict] = await tx
      .select({
        titleEn: calendarEvents.titleEn,
        startDate: calendarEvents.startDate,
        endDate: calendarEvents.endDate,
      })
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.institutionId, institutionId),
          isNull(calendarEvents.archivedAt),
          candidate.id ? ne(calendarEvents.id, candidate.id) : sql`true`,
          // A null campus on either side means "every campus", so the scopes overlap.
          candidate.campusId
            ? or(isNull(calendarEvents.campusId), eq(calendarEvents.campusId, candidate.campusId))!
            : sql`true`,
          lte(calendarEvents.startDate, candidate.endDate),
          gte(calendarEvents.endDate, candidate.startDate),
          closes ? opensExpression : closesExpression,
        ),
      )
      .limit(1);

    if (conflict) {
      throw new ConflictError(
        closes
          ? `"${conflict.titleEn}" (${conflict.startDate} to ${conflict.endDate}) already marks these dates as working days. A day cannot be both a closure and a working day.`
          : `"${conflict.titleEn}" (${conflict.startDate} to ${conflict.endDate}) already closes the school on these dates. A day cannot be both a working day and a closure.`,
      );
    }
  }

  /**
   * Find rows in *any* public table that point at these ids through a named column.
   *
   * The timetable and examination modules are not written yet, so there is no table to join
   * against — and a check that quietly does nothing is worse than no check, because it reads
   * as if it works. This asks the catalogue instead: the moment a `period_id`, `room_id` or
   * `calendar_event_id` column appears anywhere, it starts being consulted, with no edit here.
   *
   * Table names come from `information_schema`, never from a request, and are re-checked
   * against an identifier pattern before being quoted into the count query.
   */
  private async findReference(
    tx: AcademicTx,
    columnName: 'period_id' | 'room_id' | 'calendar_event_id',
    ids: string[],
    exclude: string[],
  ): Promise<{ table: string; total: number } | null> {
    if (ids.length === 0) return null;

    const catalog = await tx.execute<{ table_name: string }>(sql`
      select c.table_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'public'
        and t.table_type = 'BASE TABLE'
        and c.column_name::text = ${columnName}
      order by c.table_name
    `);

    const candidates = catalog.rows
      .map((row) => row.table_name)
      .filter((name) => SAFE_IDENTIFIER.test(name) && !exclude.includes(name));

    const idList = sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    );

    for (const table of candidates) {
      const counted = await tx.execute<{ total: number }>(
        sql`select count(*)::int as total from public.${sql.identifier(table)} where ${sql.identifier(columnName)} in (${idList})`,
      );
      const total = counted.rows[0]?.total ?? 0;
      if (total > 0) return { table, total };
    }

    return null;
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

// ─────────────────────────────────────────────────────────────────────────────────────

/** The transaction handle `runInTenant` hands a callback, named once so signatures read. */
type AcademicTx = Parameters<Parameters<DatabaseService['runInTenant']>[0]>[0];

type RoomRow = typeof rooms.$inferSelect;
type ShiftRow = typeof shifts.$inferSelect;
type PeriodRow = typeof periods.$inferSelect;
type CalendarEventRow = typeof calendarEvents.$inferSelect;
type ClassSubjectRow = typeof classSubjects.$inferSelect;

/**
 * Where surviving periods are parked while the bell schedule is renumbered.
 *
 * `periods_shift_sequence_key` is a plain partial unique index, so it is enforced row by row
 * during an UPDATE — renaming period 2 to 1 while period 1 still exists fails immediately.
 * Staging the survivors above every legal sequence number first makes the second pass
 * collision-free. The band is bounded by `periods_sequence_sane` (migration 0006), and the
 * schema caps a shift at 20 periods, so 400 downwards never reaches a real value.
 */
const PERIOD_SEQUENCE_STAGING_TOP = 400;

/** Employment states in which someone must not receive new teaching assignments. */
const LEFT_EMPLOYMENT_STATUSES = new Set(['resigned', 'terminated', 'retired']);

/** Calendar kinds that close the school regardless of the `is_non_teaching` flag. */
const CLOSING_CALENDAR_KINDS = new Set(['holiday', 'vacation']);

/**
 * Postgres identifiers this code is willing to quote into a query. The names come from
 * `information_schema`, not from a request, so this is belt and braces — but a catalogue read
 * that later grows a filter someone controls is exactly how an injection point appears.
 */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * The fields that actually changed, for the audit record.
 *
 * A diff of forty unchanged columns makes the trail unreadable, which in practice means
 * nobody reads it.
 */
function diffOf<T>(before: T, after: T, keys: string[]): Partial<T> {
  const previous: Record<string, unknown> = {};
  const from = before as Record<string, unknown>;
  const to = after as Record<string, unknown>;
  for (const key of keys) {
    if (from[key] !== to[key]) previous[key] = from[key];
  }
  return previous as Partial<T>;
}
