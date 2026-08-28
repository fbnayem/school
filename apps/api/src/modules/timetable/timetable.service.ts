/**
 * Timetable service (Phase 6).
 *
 * The routine is the one document every other module reads: attendance is taken against it,
 * substitutions hang off it, and a printed copy goes home in 900 school bags. Four decisions
 * shape everything below.
 *
 *  1. **A timetable has a lifecycle, not a save button.** A draft is freely editable; a
 *     published routine is immutable except through a substitution. Every mutation therefore
 *     starts by loading the timetable and refusing on state, before it touches an entry.
 *  2. **Clashes are detected before the write, not caught after it.** The partial unique
 *     indexes in migration 0006 are the real guarantee, but a user must be told "Ms Rahman is
 *     already teaching Class 7 in period 2 on Sunday", not handed a constraint name. The
 *     service computes the prospective placement set, reports *every* conflict in it, and only
 *     then writes.
 *  3. **A double period occupies two slots.** The flag is a display convenience; the clash
 *     checks expand it back into the two periods it really consumes. This is the one rule the
 *     database indexes cannot express, which is why publication re-validates the whole set
 *     rather than trusting that the entries were written through this service.
 *  4. **Reads are scope-aware.** A coordinator sees the whole routine; a teacher sees the
 *     lessons they teach and the sections they are responsible for; a guardian sees the
 *     routine of the sections their children are enrolled in. The permission decides which
 *     filter, never whether to filter.
 *
 * A note on permissions: the catalogue currently has a single flat `timetable.view`, with no
 * `.all` / `.assigned` / `.own` triple of the kind `SCOPED_RESOURCES` holds for students and
 * attendance. Row scoping is therefore derived here from the *authoring* permissions —
 * anyone who may manage, publish or generate routines sees all of them, everyone else is
 * narrowed to their own rows. Adding the triple to the catalogue would let this use
 * `resolveDataScope` like every other module; until then the narrow branch is the default and
 * the broad one is the exception, so the failure mode is "too little", never "too much".
 */

import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  academicYears,
  campuses,
  classLevels,
  employees,
  employeeSectionAssignments,
  employeeSubjectAssignments,
  enrollments,
  periods,
  rooms,
  sections,
  studentGuardians,
  subjects,
  terms,
  timetableEntries,
  timetables,
  timetableSubstitutions,
} from '@shikkha/db';
import {
  buildOffsetPage,
  calendarDate,
  ConflictError,
  dhakaWeekday,
  ForbiddenError,
  NotFoundError,
  offsetOf,
  parseSort,
  todayInDhaka,
  uuidv7,
  ValidationError,
  type FieldIssue,
  type OffsetPage,
  type OffsetPageRequest,
} from '@shikkha/shared';
import { can, type Principal } from '@shikkha/permissions';
import { TIMETABLE_SORT_FIELDS } from '@shikkha/validation';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { currentContext } from '../../common/context/request-context';

type Tx = Parameters<Parameters<DatabaseService['runInTenant']>[0]>[0];

type TimetableRow = typeof timetables.$inferSelect;
type TimetableEntryRow = typeof timetableEntries.$inferSelect;
type SubstitutionRow = typeof timetableSubstitutions.$inferSelect;

export interface ListTimetablesQuery {
  page: number;
  pageSize: number;
  sort?: string;
  academicYearId?: string;
  campusId?: string;
  termId?: string;
  status?: 'draft' | 'published' | 'archived';
  includeArchived: boolean;
}

export interface TimetableEntryInput {
  dayOfWeek: number;
  periodId: string;
  subjectId: string;
  employeeId?: string;
  roomId?: string;
  isDoublePeriod: boolean;
  note?: string;
}

/** One thing that cannot be true at the same time as another thing. */
export interface TimetableConflict {
  kind: 'section' | 'teacher' | 'room';
  dayOfWeek: number;
  periodId: string;
  periodLabel: string;
  resourceId: string;
  resourceLabel: string;
  /** Every entry involved, so the UI can highlight all of them rather than just the first. */
  entryIds: string[];
  message: string;
}

export interface TimetableValidationReport {
  timetableId: string;
  status: string;
  entryCount: number;
  isValid: boolean;
  conflicts: TimetableConflict[];
  /** Not blocking, but a coordinator should see them before the routine is printed. */
  warnings: Array<{ entryIds: string[]; message: string }>;
}

/**
 * The two columns a section-visibility rule is ever correlated against.
 *
 * Typed as the union of the actual columns rather than a generic `PgColumn`, so a third caller
 * cannot quietly point the rule at a column that is not a section id.
 */
type SectionIdColumn = typeof sections.id | typeof timetableEntries.sectionId;

/** One occupied cell of the grid. A double period produces two of these. */
interface Placement {
  entryKey: string;
  sectionId: string;
  employeeId: string | null;
  roomId: string | null;
  dayOfWeek: number;
  periodId: string;
}

interface PeriodInfo {
  shiftId: string;
  sequence: number;
  nameEn: string;
}

interface PeriodIndex {
  byId: Map<string, PeriodInfo>;
  /** period id → the period that follows it in the same shift, when there is one. */
  next: Map<string, string>;
}

interface Labels {
  sections: Map<string, string>;
  employees: Map<string, string>;
  rooms: Map<string, string>;
  periods: Map<string, string>;
}

@Injectable()
export class TimetableService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  // ── Timetables ──────────────────────────────────────────────────────────────────────

  async list(
    principal: Principal,
    institutionId: string,
    query: ListTimetablesQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<TimetableRow & { entryCount: number }>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(timetables.institutionId, institutionId)];

      if (!query.includeArchived) {
        filters.push(isNull(timetables.archivedAt));
      } else if (!this.canManage(principal)) {
        // Superseded routines are how a school reconstructs "what was Class 7 doing that
        // Tuesday". Reading them is an authoring concern, not a viewing one.
        throw new ForbiddenError('timetable.manage', 'You cannot view archived timetables');
      }

      if (query.academicYearId) filters.push(eq(timetables.academicYearId, query.academicYearId));
      if (query.campusId) filters.push(eq(timetables.campusId, query.campusId));
      if (query.termId) filters.push(eq(timetables.termId, query.termId));
      if (query.status) filters.push(eq(timetables.status, query.status));

      // A viewer without authoring rights has no business reading half-built routines: a
      // draft says a teacher is scheduled somewhere they have not agreed to be.
      if (!this.canManage(principal)) filters.push(eq(timetables.status, 'published'));

      const where = and(...filters);
      const orderBy = parseSort(query.sort, TIMETABLE_SORT_FIELDS, {
        field: 'effectiveFrom',
        direction: 'desc',
      }).map((spec) => {
        const column = TIMETABLE_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select({
          timetable: timetables,
          // A correlated subquery rather than one count query per row: the routine list is
          // the first screen a coordinator opens, and it renders once per campus per year.
          entryCount: sql<number>`(
            select count(*)::int from ${timetableEntries}
            where ${timetableEntries.timetableId} = ${timetables.id}
              and ${timetableEntries.archivedAt} is null
          )`,
        })
        .from(timetables)
        .where(where)
        .orderBy(...orderBy, asc(timetables.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(timetables)
        .where(where);

      return buildOffsetPage(
        rows.map((row) => ({ ...row.timetable, entryCount: row.entryCount })),
        counted?.total ?? 0,
        page,
      );
    });
  }

  /**
   * One timetable with its entries.
   *
   * The entries go through the same scope filter as the read views, so a teacher fetching a
   * routine by id sees exactly the lessons they would see in their own view — fetching by id
   * is the list query with `where id = ?` added, never a second code path.
   */
  async findOne(principal: Principal, institutionId: string, id: string) {
    return this.db.runInTenant(async (tx) => {
      const timetable = await this.loadTimetable(tx, institutionId, id, { includeArchived: true });

      if (timetable.status !== 'published' && !this.canManage(principal)) {
        throw new NotFoundError('Timetable', id);
      }

      const entries = await this.loadEntries(tx, [timetable.id], this.entryScopeFilter(principal));
      const substitutions = await this.loadSubstitutions(
        tx,
        entries.map((entry) => entry.id),
        todayInDhaka(),
      );

      return { ...timetable, entries, substitutions };
    });
  }

  async create(
    principal: Principal,
    institutionId: string,
    input: {
      campusId: string;
      academicYearId: string;
      termId?: string;
      nameEn: string;
      nameBn?: string;
      effectiveFrom: string;
      note?: string;
    },
  ): Promise<TimetableRow> {
    return this.db.runInTenant(async (tx) => {
      await this.assertScopeBelongsToInstitution(
        tx,
        institutionId,
        input.campusId,
        input.academicYearId,
        input.termId ?? null,
      );

      const [created] = await tx
        .insert(timetables)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          campusId: input.campusId,
          academicYearId: input.academicYearId,
          termId: input.termId ?? null,
          nameEn: input.nameEn,
          nameBn: input.nameBn ?? null,
          status: 'draft',
          effectiveFrom: input.effectiveFrom,
          note: input.note ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      return created!;
    });
  }

  /**
   * Copy an existing routine into a new draft.
   *
   * This is how next term's timetable actually gets built — 95% of it is last term's — and it
   * is the reason there is no blank-grid workflow to maintain. The copy is always a draft, so
   * cloning cannot publish anything, and it always stays on the source's campus: sections
   * belong to a campus, so a cross-campus copy would carry references to rooms and classes
   * that do not exist there.
   */
  async clone(
    principal: Principal,
    institutionId: string,
    sourceId: string,
    input: {
      nameEn: string;
      nameBn?: string;
      effectiveFrom: string;
      termId?: string;
      note?: string;
    },
  ): Promise<{ timetable: TimetableRow; entriesCopied: number }> {
    return this.db.runInTenant(async (tx) => {
      const source = await this.loadTimetable(tx, institutionId, sourceId, {
        includeArchived: true,
      });

      const termId = input.termId ?? source.termId;
      await this.assertScopeBelongsToInstitution(
        tx,
        institutionId,
        source.campusId,
        source.academicYearId,
        termId,
      );

      const id = uuidv7();
      const [created] = await tx
        .insert(timetables)
        .values({
          id,
          tenantId: principal.tenantId!,
          institutionId,
          campusId: source.campusId,
          academicYearId: source.academicYearId,
          termId,
          nameEn: input.nameEn,
          nameBn: input.nameBn ?? null,
          status: 'draft',
          effectiveFrom: input.effectiveFrom,
          note: input.note ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      const sourceEntries = await tx
        .select()
        .from(timetableEntries)
        .where(
          and(eq(timetableEntries.timetableId, sourceId), isNull(timetableEntries.archivedAt)),
        );

      if (sourceEntries.length > 0) {
        await tx.insert(timetableEntries).values(
          sourceEntries.map((entry) => ({
            id: uuidv7(),
            tenantId: principal.tenantId!,
            institutionId,
            timetableId: id,
            sectionId: entry.sectionId,
            dayOfWeek: entry.dayOfWeek,
            periodId: entry.periodId,
            subjectId: entry.subjectId,
            employeeId: entry.employeeId,
            roomId: entry.roomId,
            isDoublePeriod: entry.isDoublePeriod,
            note: entry.note,
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })),
        );
      }

      return { timetable: created!, entriesCopied: sourceEntries.length };
    });
  }

  /**
   * Publish.
   *
   * Everything that makes publication meaningful happens in one transaction: the whole set is
   * re-validated, the routine it supersedes is archived, and the new one becomes live. Split
   * across two requests there would be a window with two published routines for one campus —
   * which the partial unique index would refuse, leaving the school with none.
   */
  async publish(
    principal: Principal,
    institutionId: string,
    id: string,
    input: { effectiveFrom?: string },
  ): Promise<{ timetable: TimetableRow; superseded: TimetableRow | null }> {
    return this.db.runInTenant(async (tx) => {
      const timetable = await this.loadTimetable(tx, institutionId, id);

      if (timetable.status === 'published') {
        throw new ConflictError('This timetable is already published.');
      }
      if (timetable.status !== 'draft') {
        throw new ConflictError(
          'Only a draft timetable can be published. Clone this one to make a new draft.',
        );
      }

      const report = await this.buildValidationReport(tx, timetable);

      if (report.entryCount === 0) {
        throw new ValidationError('A timetable with no lessons cannot be published', [
          { path: 'entries', message: 'Add at least one lesson before publishing' },
        ]);
      }

      if (report.conflicts.length > 0) {
        // Every conflict, not the first: a coordinator fixing them one round-trip at a time
        // is how a Sunday afternoon disappears. The issues array is the only structured
        // channel the error envelope carries to the client, so each conflict becomes one.
        const issues: FieldIssue[] = report.conflicts.map((conflict) => ({
          path: `entries.${conflict.entryIds[0] ?? 'unknown'}`,
          message: conflict.message,
          code: `timetable_${conflict.kind}_clash`,
        }));
        throw new ValidationError(
          `This timetable cannot be published: ${report.conflicts.length} clash${
            report.conflicts.length === 1 ? '' : 'es'
          } must be resolved first.`,
          issues,
          { conflicts: report.conflicts },
        );
      }

      const effectiveFrom = input.effectiveFrom ?? timetable.effectiveFrom;

      const [previous] = await tx
        .select()
        .from(timetables)
        .where(
          and(
            eq(timetables.institutionId, institutionId),
            eq(timetables.campusId, timetable.campusId),
            eq(timetables.academicYearId, timetable.academicYearId),
            timetable.termId ? eq(timetables.termId, timetable.termId) : isNull(timetables.termId),
            eq(timetables.status, 'published'),
            isNull(timetables.archivedAt),
          ),
        )
        .limit(1);

      let superseded: TimetableRow | null = null;
      if (previous && previous.id !== timetable.id) {
        const [archived] = await tx
          .update(timetables)
          .set({
            status: 'archived',
            archivedAt: new Date(),
            archivedBy: principal.userId,
            archiveReason: `Superseded by "${timetable.nameEn}", effective ${effectiveFrom}`,
            updatedBy: principal.userId,
            version: previous.version + 1,
          })
          .where(eq(timetables.id, previous.id))
          .returning();
        superseded = archived ?? null;

        // Written inside the transaction rather than left to the audit interceptor: the
        // interceptor records one action against the route's resource, and this is a second
        // record changing state with no route of its own. If the publish rolls back, this
        // must roll back with it.
        const context = currentContext();
        await this.audit.recordInTransaction(tx, {
          tenantId: principal.tenantId,
          institutionId,
          campusId: context?.campusId ?? null,
          actorUserId: principal.userId,
          actorRoles: principal.roles.map((role) => role.roleKey),
          action: 'archive',
          module: 'timetable',
          resourceType: 'timetable',
          resourceId: previous.id,
          resourceLabel: previous.nameEn,
          previousValue: { status: previous.status },
          newValue: { status: 'archived', supersededBy: timetable.id },
          reason: `Superseded by "${timetable.nameEn}"`,
          requestId: context?.requestId ?? null,
          ipAddress: context?.ipAddress ?? null,
          userAgent: context?.userAgent ?? null,
        });
      }

      const [published] = await tx
        .update(timetables)
        .set({
          status: 'published',
          effectiveFrom,
          publishedAt: new Date(),
          publishedBy: principal.userId,
          updatedBy: principal.userId,
          version: timetable.version + 1,
        })
        .where(and(eq(timetables.id, timetable.id), eq(timetables.version, timetable.version)))
        .returning();

      if (!published) {
        // The row exists but the version moved, so someone else published or edited it first.
        throw new ConflictError(
          'This timetable was changed by someone else while you were publishing it. Reload and try again.',
          { expectedVersion: timetable.version },
        );
      }

      return { timetable: published, superseded };
    });
  }

  async archive(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<TimetableRow> {
    return this.db.runInTenant(async (tx) => {
      const timetable = await this.loadTimetable(tx, institutionId, id);

      const [archived] = await tx
        .update(timetables)
        .set({
          status: 'archived',
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
          version: timetable.version + 1,
        })
        .where(eq(timetables.id, id))
        .returning();

      return archived!;
    });
  }

  // ── Entries ─────────────────────────────────────────────────────────────────────────

  /**
   * Replace one section's whole week.
   *
   * Set-at-a-time because that is how the invariant is shaped: whether this section's Sunday
   * is legal depends on the rest of the routine, and applying six independent edits means
   * passing through five states that are not.
   */
  async replaceSectionEntries(
    principal: Principal,
    institutionId: string,
    timetableId: string,
    input: { sectionId: string; entries: TimetableEntryInput[] },
  ): Promise<{
    entries: TimetableEntryRow[];
    previous: Array<Pick<TimetableEntryRow, 'id' | 'dayOfWeek' | 'periodId' | 'subjectId'>>;
  }> {
    return this.db.runInTenant(async (tx) => {
      const timetable = await this.loadTimetable(tx, institutionId, timetableId);
      this.assertDraft(timetable);

      const section = await this.loadSectionForTimetable(tx, timetable, input.sectionId);
      const labels = await this.assertReferencesBelongToInstitution(
        tx,
        institutionId,
        input.entries,
      );
      labels.sections.set(section.id, section.label);

      const periodIndex = await this.loadPeriodIndex(tx, institutionId);

      // The prospective world: everything already in the routine except this section, plus
      // what is being submitted for it. Checked before the write so the user gets a sentence
      // rather than a unique-index name — the index remains the backstop for a concurrent save.
      const existing = await this.loadEntries(
        tx,
        [timetableId],
        ne(timetableEntries.sectionId, input.sectionId),
      );
      for (const entry of existing) {
        labels.sections.set(entry.sectionId, entry.sectionLabel);
        if (entry.employeeId && entry.teacherName) {
          labels.employees.set(entry.employeeId, entry.teacherName);
        }
        if (entry.roomId && entry.roomName) labels.rooms.set(entry.roomId, entry.roomName);
        labels.periods.set(entry.periodId, entry.periodName);
      }
      for (const [id, info] of periodIndex.byId) labels.periods.set(id, info.nameEn);

      const placements: Placement[] = [
        ...existing.flatMap((entry) =>
          expandPlacement(
            {
              entryKey: entry.id,
              sectionId: entry.sectionId,
              employeeId: entry.employeeId,
              roomId: entry.roomId,
              dayOfWeek: entry.dayOfWeek,
              periodId: entry.periodId,
            },
            entry.isDoublePeriod,
            periodIndex,
          ),
        ),
        ...input.entries.flatMap((entry, index) =>
          expandPlacement(
            {
              entryKey: `new:${index}`,
              sectionId: input.sectionId,
              employeeId: entry.employeeId ?? null,
              roomId: entry.roomId ?? null,
              dayOfWeek: entry.dayOfWeek,
              periodId: entry.periodId,
            },
            entry.isDoublePeriod,
            periodIndex,
          ),
        ),
      ];

      const conflicts = detectConflicts(placements, labels);
      if (conflicts.length > 0) throw conflictError(conflicts);

      const previous = await tx
        .select({
          id: timetableEntries.id,
          dayOfWeek: timetableEntries.dayOfWeek,
          periodId: timetableEntries.periodId,
          subjectId: timetableEntries.subjectId,
        })
        .from(timetableEntries)
        .where(
          and(
            eq(timetableEntries.timetableId, timetableId),
            eq(timetableEntries.sectionId, input.sectionId),
            isNull(timetableEntries.archivedAt),
          ),
        );

      if (previous.length > 0) {
        // Archived, never deleted: last term's routine is what an attendance record from last
        // term has to be read against.
        await tx
          .update(timetableEntries)
          .set({
            archivedAt: new Date(),
            archivedBy: principal.userId,
            archiveReason: 'Replaced when this section’s routine was re-saved',
            updatedBy: principal.userId,
          })
          .where(
            and(
              eq(timetableEntries.timetableId, timetableId),
              eq(timetableEntries.sectionId, input.sectionId),
              isNull(timetableEntries.archivedAt),
            ),
          );
      }

      let inserted: TimetableEntryRow[] = [];
      if (input.entries.length > 0) {
        inserted = await tx
          .insert(timetableEntries)
          .values(
            input.entries.map((entry) => ({
              id: uuidv7(),
              tenantId: principal.tenantId!,
              institutionId,
              timetableId,
              sectionId: input.sectionId,
              dayOfWeek: entry.dayOfWeek,
              periodId: entry.periodId,
              subjectId: entry.subjectId,
              employeeId: entry.employeeId ?? null,
              roomId: entry.roomId ?? null,
              isDoublePeriod: entry.isDoublePeriod,
              note: entry.note ?? null,
              createdBy: principal.userId,
              updatedBy: principal.userId,
            })),
          )
          .returning();
      }

      return { entries: inserted, previous };
    });
  }

  async archiveEntry(
    principal: Principal,
    institutionId: string,
    timetableId: string,
    entryId: string,
    reason: string,
  ): Promise<{ entry: TimetableEntryRow; previous: Partial<TimetableEntryRow> }> {
    return this.db.runInTenant(async (tx) => {
      const timetable = await this.loadTimetable(tx, institutionId, timetableId);
      this.assertDraft(timetable);

      const [existing] = await tx
        .select()
        .from(timetableEntries)
        .where(
          and(
            eq(timetableEntries.id, entryId),
            eq(timetableEntries.timetableId, timetableId),
            isNull(timetableEntries.archivedAt),
          ),
        )
        .limit(1);

      if (!existing) throw new NotFoundError('Timetable entry', entryId);

      const [archived] = await tx
        .update(timetableEntries)
        .set({
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
        })
        .where(eq(timetableEntries.id, entryId))
        .returning();

      return {
        entry: archived!,
        previous: {
          dayOfWeek: existing.dayOfWeek,
          periodId: existing.periodId,
          subjectId: existing.subjectId,
          employeeId: existing.employeeId,
          roomId: existing.roomId,
        },
      };
    });
  }

  /**
   * Report every clash in a timetable without changing anything.
   *
   * The endpoint exists so a coordinator can fix a routine iteratively instead of discovering
   * the problems only when publication is refused.
   */
  async validate(
    principal: Principal,
    institutionId: string,
    timetableId: string,
  ): Promise<TimetableValidationReport> {
    return this.db.runInTenant(async (tx) => {
      const timetable = await this.loadTimetable(tx, institutionId, timetableId, {
        includeArchived: true,
      });
      return this.buildValidationReport(tx, timetable);
    });
  }

  // ── Substitutions ───────────────────────────────────────────────────────────────────

  /**
   * Record a one-day cover.
   *
   * The clash rule is the whole point: a substitute who is already teaching their own class
   * in that period has not been made available by writing their name down.
   */
  async createSubstitution(
    principal: Principal,
    institutionId: string,
    timetableId: string,
    input: {
      entryId: string;
      substitutionDate: string;
      substituteEmployeeId: string;
      reason: string;
    },
  ): Promise<SubstitutionRow> {
    return this.db.runInTenant(async (tx) => {
      const [row] = await tx
        .select({
          entry: timetableEntries,
          status: timetables.status,
          effectiveFrom: timetables.effectiveFrom,
          timetableName: timetables.nameEn,
        })
        .from(timetableEntries)
        .innerJoin(timetables, eq(timetables.id, timetableEntries.timetableId))
        .where(
          and(
            eq(timetableEntries.id, input.entryId),
            // The entry must belong to the timetable named in the path, not merely to the
            // same institution: a client that mixes the two is confused about which routine
            // it is editing, and answering anyway would put the cover on the wrong document.
            eq(timetableEntries.timetableId, timetableId),
            eq(timetableEntries.institutionId, institutionId),
            isNull(timetableEntries.archivedAt),
            isNull(timetables.archivedAt),
          ),
        )
        .limit(1);

      if (!row) throw new NotFoundError('Timetable entry', input.entryId);
      const entry = row.entry;

      if (row.status !== 'published') {
        throw new ConflictError(
          'A substitution can only be recorded against a published timetable.',
        );
      }

      const date = calendarDate(input.substitutionDate);
      const weekday = dhakaWeekday(date);
      if (weekday !== entry.dayOfWeek) {
        throw new ValidationError(
          `That lesson is on ${DAY_NAMES[entry.dayOfWeek] ?? 'another day'}, but ${input.substitutionDate} is a ${DAY_NAMES[weekday]}.`,
          [{ path: 'substitutionDate', message: 'Pick a date that falls on the lesson’s weekday' }],
        );
      }

      if (input.substitutionDate < row.effectiveFrom) {
        throw new ValidationError(
          `That date is before this routine takes effect (${row.effectiveFrom}).`,
          [{ path: 'substitutionDate', message: 'The routine does not apply on that date yet' }],
        );
      }

      const [substitute] = await tx
        .select({
          id: employees.id,
          fullNameEn: employees.fullNameEn,
          employmentStatus: employees.employmentStatus,
        })
        .from(employees)
        .where(
          and(
            eq(employees.id, input.substituteEmployeeId),
            eq(employees.institutionId, institutionId),
            isNull(employees.archivedAt),
          ),
        )
        .limit(1);

      if (!substitute) throw new NotFoundError('Employee', input.substituteEmployeeId);
      if (!TEACHABLE_EMPLOYMENT_STATUSES.has(substitute.employmentStatus)) {
        throw new ValidationError(
          `${substitute.fullNameEn} is not currently in active service and cannot take a class.`,
          [{ path: 'substituteEmployeeId', message: 'Choose an employee in active service' }],
        );
      }

      if (entry.employeeId === substitute.id) {
        throw new ValidationError('That teacher already takes this lesson.', [
          { path: 'substituteEmployeeId', message: 'Choose a different teacher' },
        ]);
      }

      const [duplicate] = await tx
        .select({ id: timetableSubstitutions.id })
        .from(timetableSubstitutions)
        .where(
          and(
            eq(timetableSubstitutions.entryId, entry.id),
            eq(timetableSubstitutions.substitutionDate, input.substitutionDate),
            isNull(timetableSubstitutions.archivedAt),
          ),
        )
        .limit(1);

      if (duplicate) {
        throw new ConflictError(
          'This lesson already has a substitute on that date. Cancel the existing substitution first.',
        );
      }

      const periodIndex = await this.loadPeriodIndex(tx, institutionId);
      const needed = expandPlacement(
        {
          entryKey: entry.id,
          sectionId: entry.sectionId,
          employeeId: substitute.id,
          roomId: entry.roomId,
          dayOfWeek: entry.dayOfWeek,
          periodId: entry.periodId,
        },
        entry.isDoublePeriod,
        periodIndex,
      ).map((placement) => placement.periodId);

      const occupied = await this.substituteOccupiedPeriods(
        tx,
        institutionId,
        substitute.id,
        input.substitutionDate,
        weekday,
        periodIndex,
      );

      const clash = needed.find((periodId) => occupied.has(periodId));
      if (clash) {
        throw new ConflictError(
          `${substitute.fullNameEn} is already committed during ${
            periodIndex.byId.get(clash)?.nameEn ?? 'that period'
          } on ${input.substitutionDate}.`,
          { periodId: clash, date: input.substitutionDate },
        );
      }

      const [created] = await tx
        .insert(timetableSubstitutions)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          entryId: entry.id,
          substitutionDate: input.substitutionDate,
          periodId: entry.periodId,
          substituteEmployeeId: substitute.id,
          originalEmployeeId: entry.employeeId,
          reason: input.reason,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      return created!;
    });
  }

  /**
   * Cancel a cover that has not happened yet.
   *
   * A substitution in the past is not a plan, it is a record of who was standing in front of
   * the class, and there is no version of "cancel" that makes that untrue.
   */
  async cancelSubstitution(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<{ substitution: SubstitutionRow; previous: Partial<SubstitutionRow> }> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(timetableSubstitutions)
        .where(
          and(
            eq(timetableSubstitutions.id, id),
            eq(timetableSubstitutions.institutionId, institutionId),
            isNull(timetableSubstitutions.archivedAt),
          ),
        )
        .limit(1);

      if (!existing) throw new NotFoundError('Substitution', id);

      if (existing.substitutionDate < todayInDhaka()) {
        throw new ConflictError(
          'A substitution that has already taken place cannot be cancelled — it is a record of what happened.',
        );
      }

      const [cancelled] = await tx
        .update(timetableSubstitutions)
        .set({
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
        })
        .where(eq(timetableSubstitutions.id, id))
        .returning();

      return {
        substitution: cancelled!,
        previous: {
          substituteEmployeeId: existing.substituteEmployeeId,
          substitutionDate: existing.substitutionDate,
        },
      };
    });
  }

  // ── Read views ──────────────────────────────────────────────────────────────────────

  /**
   * The routine of one section — the grid a class teacher pins to the wall.
   */
  async sectionTimetable(
    principal: Principal,
    institutionId: string,
    sectionId: string,
    query: { timetableId?: string; academicYearId?: string; date?: string },
  ) {
    return this.db.runInTenant(async (tx) => {
      const visibility = this.sectionVisibility(principal, sections.id);

      const [section] = await tx
        .select({
          id: sections.id,
          nameEn: sections.nameEn,
          nameBn: sections.nameBn,
          campusId: sections.campusId,
          academicYearId: sections.academicYearId,
          classLevelId: sections.classLevelId,
          classLevelName: classLevels.nameEn,
        })
        .from(sections)
        .innerJoin(classLevels, eq(classLevels.id, sections.classLevelId))
        .where(
          and(
            eq(sections.id, sectionId),
            eq(sections.institutionId, institutionId),
            isNull(sections.archivedAt),
            visibility,
          ),
        )
        .limit(1);

      // 404 rather than 403: a teacher asking about a section in another wing of the school
      // should not be able to tell the difference between "not yours" and "does not exist".
      if (!section) throw new NotFoundError('Section', sectionId);

      const targetDate = query.date ?? todayInDhaka();
      const timetable = await this.resolveTimetable(tx, principal, institutionId, {
        timetableId: query.timetableId,
        campusId: section.campusId,
        academicYearId: query.academicYearId ?? section.academicYearId,
        onDate: targetDate,
      });

      const entries = await this.loadEntries(
        tx,
        [timetable.id],
        eq(timetableEntries.sectionId, sectionId),
      );
      const substitutions = await this.loadSubstitutions(
        tx,
        entries.map((entry) => entry.id),
        targetDate,
      );

      return { section, timetable, onDate: targetDate, entries, substitutions };
    });
  }

  /**
   * One teacher's week, across every campus they teach at, with the covers they are involved
   * in either way round.
   */
  async teacherTimetable(
    principal: Principal,
    institutionId: string,
    employeeId: string,
    query: { timetableId?: string; academicYearId?: string; date?: string },
  ) {
    if (!this.canManage(principal) && principal.employeeId !== employeeId) {
      // Another teacher's routine is not secret, but it is not theirs to browse either, and
      // the id is guessable. Same 404 as any other out-of-scope read.
      throw new NotFoundError('Employee', employeeId);
    }

    return this.db.runInTenant(async (tx) => {
      const [employee] = await tx
        .select({ id: employees.id, fullNameEn: employees.fullNameEn })
        .from(employees)
        .where(
          and(
            eq(employees.id, employeeId),
            eq(employees.institutionId, institutionId),
            isNull(employees.archivedAt),
          ),
        )
        .limit(1);

      if (!employee) throw new NotFoundError('Employee', employeeId);

      const targetDate = query.date ?? todayInDhaka();
      const academicYearId =
        query.academicYearId ?? (await this.currentAcademicYearId(tx, institutionId));

      const filters: SQL[] = [
        eq(timetables.institutionId, institutionId),
        eq(timetables.academicYearId, academicYearId),
        isNull(timetables.archivedAt),
      ];
      if (query.timetableId) {
        filters.push(eq(timetables.id, query.timetableId));
        if (!this.canManage(principal)) filters.push(eq(timetables.status, 'published'));
      } else {
        filters.push(eq(timetables.status, 'published'));
      }

      const live = await tx
        .select()
        .from(timetables)
        .where(and(...filters))
        .orderBy(desc(timetables.effectiveFrom));

      const applicable = live.filter((row) => row.effectiveFrom <= targetDate);
      const chosen = applicable.length > 0 ? applicable : live;

      const entries = await this.loadEntries(
        tx,
        chosen.map((row) => row.id),
        eq(timetableEntries.employeeId, employeeId),
      );

      const substitutions = await this.loadTeacherSubstitutions(
        tx,
        institutionId,
        employeeId,
        targetDate,
      );

      return { employee, timetables: chosen, onDate: targetDate, entries, substitutions };
    });
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Scoping
  // ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Whether this principal may see every routine, or only their own rows.
   *
   * Deliberately keyed on the authoring permissions rather than on `timetable.view`, which
   * every teacher, student and guardian holds. See the file header.
   */
  private canManage(principal: Principal): boolean {
    return (
      can(principal, 'timetable.manage') ||
      can(principal, 'timetable.publish') ||
      can(principal, 'timetable.generate')
    );
  }

  /**
   * The conditions under which a row about a section is visible to a narrow viewer.
   *
   * Takes the section column so the same rule can be applied to `sections.id` and to
   * `timetable_entries.section_id` — two callers deriving the rule separately is how one of
   * them ends up more generous than the other.
   */
  private sectionVisibility(principal: Principal, sectionColumn: SectionIdColumn): SQL {
    if (this.canManage(principal)) return sql`true`;

    const conditions: SQL[] = [];

    if (principal.employeeId) {
      const employeeId = principal.employeeId;
      conditions.push(
        exists(
          this.db.raw
            .select({ one: sql`1` })
            .from(employeeSectionAssignments)
            .where(
              and(
                eq(employeeSectionAssignments.sectionId, sectionColumn),
                eq(employeeSectionAssignments.employeeId, employeeId),
                isNull(employeeSectionAssignments.archivedAt),
              ),
            ),
        ),
      );
      conditions.push(
        exists(
          this.db.raw
            .select({ one: sql`1` })
            .from(employeeSubjectAssignments)
            .where(
              and(
                eq(employeeSubjectAssignments.sectionId, sectionColumn),
                eq(employeeSubjectAssignments.employeeId, employeeId),
                isNull(employeeSubjectAssignments.archivedAt),
              ),
            ),
        ),
      );
    }

    if (principal.guardianId) {
      const guardianId = principal.guardianId;
      conditions.push(
        exists(
          this.db.raw
            .select({ one: sql`1` })
            .from(enrollments)
            .innerJoin(studentGuardians, eq(studentGuardians.studentId, enrollments.studentId))
            .where(
              and(
                eq(enrollments.sectionId, sectionColumn),
                eq(enrollments.status, 'active'),
                isNull(enrollments.archivedAt),
                eq(studentGuardians.guardianId, guardianId),
                // Revoking portal access takes effect immediately, without a role change.
                eq(studentGuardians.canAccessPortal, true),
                isNull(studentGuardians.archivedAt),
              ),
            ),
        ),
      );
    }

    if (principal.studentId) {
      const studentId = principal.studentId;
      conditions.push(
        exists(
          this.db.raw
            .select({ one: sql`1` })
            .from(enrollments)
            .where(
              and(
                eq(enrollments.sectionId, sectionColumn),
                eq(enrollments.studentId, studentId),
                eq(enrollments.status, 'active'),
                isNull(enrollments.archivedAt),
              ),
            ),
        ),
      );
    }

    // A viewer with no employee, guardian or student record can be connected to no section,
    // so they see nothing. Failing closed is the only safe reading.
    if (conditions.length === 0) return sql`false`;
    return conditions.length === 1 ? conditions[0]! : or(...conditions)!;
  }

  /** The same rule, plus "lessons I teach myself", applied to entry rows. */
  private entryScopeFilter(principal: Principal): SQL {
    if (this.canManage(principal)) return sql`true`;

    const sectionRule = this.sectionVisibility(principal, timetableEntries.sectionId);
    if (!principal.employeeId) return sectionRule;

    return or(eq(timetableEntries.employeeId, principal.employeeId), sectionRule)!;
  }

  // ────────────────────────────────────────────────────────────────────────────────────
  // Loading and reference checks
  // ────────────────────────────────────────────────────────────────────────────────────

  private async loadTimetable(
    tx: Tx,
    institutionId: string,
    id: string,
    options: { includeArchived?: boolean } = {},
  ): Promise<TimetableRow> {
    const filters: SQL[] = [eq(timetables.id, id), eq(timetables.institutionId, institutionId)];
    if (!options.includeArchived) filters.push(isNull(timetables.archivedAt));

    const [found] = await tx
      .select()
      .from(timetables)
      .where(and(...filters))
      .limit(1);

    // Includes the cross-tenant case: RLS makes another tenant's row invisible, so the query
    // returns nothing and the caller gets a 404 rather than a 403 that confirms it exists.
    if (!found) throw new NotFoundError('Timetable', id);
    return found;
  }

  private assertDraft(timetable: TimetableRow): void {
    if (timetable.status === 'draft') return;
    throw new ConflictError(
      timetable.status === 'published'
        ? 'A published timetable cannot be edited. Record a substitution, or clone it into a new draft.'
        : 'An archived timetable cannot be edited. Clone it into a new draft first.',
      { status: timetable.status },
    );
  }

  /**
   * Every reference must live in the same institution as the timetable.
   *
   * Foreign keys prove the rows exist somewhere in the tenant; only this proves they are
   * *here*. Without it, a group administrator could schedule School A's chemistry teacher into
   * School B's laboratory, and both foreign keys would be perfectly satisfied.
   */
  private async assertReferencesBelongToInstitution(
    tx: Tx,
    institutionId: string,
    entries: TimetableEntryInput[],
  ): Promise<Labels> {
    const labels: Labels = {
      sections: new Map(),
      employees: new Map(),
      rooms: new Map(),
      periods: new Map(),
    };

    const periodIds = unique(entries.map((entry) => entry.periodId));
    const subjectIds = unique(entries.map((entry) => entry.subjectId));
    const employeeIds = unique(entries.map((entry) => entry.employeeId));
    const roomIds = unique(entries.map((entry) => entry.roomId));

    if (periodIds.length > 0) {
      const found = await tx
        .select({ id: periods.id, nameEn: periods.nameEn })
        .from(periods)
        .where(
          and(
            inArray(periods.id, periodIds),
            eq(periods.institutionId, institutionId),
            isNull(periods.archivedAt),
          ),
        );
      assertAllFound('Period', periodIds, found);
      for (const row of found) labels.periods.set(row.id, row.nameEn);
    }

    if (subjectIds.length > 0) {
      const found = await tx
        .select({ id: subjects.id })
        .from(subjects)
        .where(
          and(
            inArray(subjects.id, subjectIds),
            eq(subjects.institutionId, institutionId),
            isNull(subjects.archivedAt),
          ),
        );
      assertAllFound('Subject', subjectIds, found);
    }

    if (employeeIds.length > 0) {
      const found = await tx
        .select({
          id: employees.id,
          fullNameEn: employees.fullNameEn,
          employmentStatus: employees.employmentStatus,
        })
        .from(employees)
        .where(
          and(
            inArray(employees.id, employeeIds),
            eq(employees.institutionId, institutionId),
            isNull(employees.archivedAt),
          ),
        );
      assertAllFound('Employee', employeeIds, found);

      const unavailable = found.filter(
        (row) => !TEACHABLE_EMPLOYMENT_STATUSES.has(row.employmentStatus),
      );
      if (unavailable.length > 0) {
        throw new ValidationError(
          `${unavailable.map((row) => row.fullNameEn).join(', ')} ${
            unavailable.length === 1 ? 'is' : 'are'
          } no longer in active service and cannot be scheduled.`,
          unavailable.map((row) => ({
            path: 'entries.employeeId',
            message: `${row.fullNameEn} is ${row.employmentStatus}`,
          })),
        );
      }

      for (const row of found) labels.employees.set(row.id, row.fullNameEn);
    }

    if (roomIds.length > 0) {
      const found = await tx
        .select({ id: rooms.id, nameEn: rooms.nameEn, code: rooms.code })
        .from(rooms)
        .where(
          and(
            inArray(rooms.id, roomIds),
            eq(rooms.institutionId, institutionId),
            isNull(rooms.archivedAt),
          ),
        );
      assertAllFound('Room', roomIds, found);
      for (const row of found) labels.rooms.set(row.id, `${row.nameEn} (${row.code})`);
    }

    return labels;
  }

  /** The section must be in this institution, this academic year and this campus. */
  private async loadSectionForTimetable(
    tx: Tx,
    timetable: TimetableRow,
    sectionId: string,
  ): Promise<{ id: string; label: string }> {
    const [section] = await tx
      .select({
        id: sections.id,
        nameEn: sections.nameEn,
        campusId: sections.campusId,
        academicYearId: sections.academicYearId,
        classLevelName: classLevels.nameEn,
      })
      .from(sections)
      .innerJoin(classLevels, eq(classLevels.id, sections.classLevelId))
      .where(
        and(
          eq(sections.id, sectionId),
          eq(sections.institutionId, timetable.institutionId),
          isNull(sections.archivedAt),
        ),
      )
      .limit(1);

    if (!section) throw new NotFoundError('Section', sectionId);

    if (section.academicYearId !== timetable.academicYearId) {
      throw new ValidationError('That section belongs to a different academic year', [
        { path: 'sectionId', message: 'The section is not in this timetable’s academic year' },
      ]);
    }
    if (section.campusId !== timetable.campusId) {
      throw new ValidationError('That section belongs to a different campus', [
        { path: 'sectionId', message: 'The section is not on this timetable’s campus' },
      ]);
    }

    return { id: section.id, label: `${section.classLevelName} — ${section.nameEn}` };
  }

  private async assertScopeBelongsToInstitution(
    tx: Tx,
    institutionId: string,
    campusId: string,
    academicYearId: string,
    termId: string | null,
  ): Promise<void> {
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

    if (termId) {
      const [term] = await tx
        .select({ id: terms.id })
        .from(terms)
        .where(
          and(
            eq(terms.id, termId),
            eq(terms.institutionId, institutionId),
            eq(terms.academicYearId, academicYearId),
            isNull(terms.archivedAt),
          ),
        )
        .limit(1);
      if (!term) throw new NotFoundError('Term', termId);
    }
  }

  private async currentAcademicYearId(tx: Tx, institutionId: string): Promise<string> {
    const [year] = await tx
      .select({ id: academicYears.id })
      .from(academicYears)
      .where(
        and(
          eq(academicYears.institutionId, institutionId),
          eq(academicYears.isCurrent, true),
          isNull(academicYears.archivedAt),
        ),
      )
      .limit(1);

    if (!year) {
      throw new NotFoundError('Current academic year');
    }
    return year.id;
  }

  /**
   * Pick the routine in force on a date.
   *
   * Only one timetable can be published per (campus, year, term), so the candidate set is
   * small; the one with the latest `effective_from` that has already started wins, and a
   * routine that starts next month is the fallback so a new campus is not a 404.
   */
  private async resolveTimetable(
    tx: Tx,
    principal: Principal,
    institutionId: string,
    scope: {
      timetableId?: string;
      campusId: string;
      academicYearId: string;
      onDate: string;
    },
  ): Promise<TimetableRow> {
    if (scope.timetableId) {
      const timetable = await this.loadTimetable(tx, institutionId, scope.timetableId, {
        includeArchived: true,
      });
      if (timetable.status !== 'published' && !this.canManage(principal)) {
        throw new NotFoundError('Timetable', scope.timetableId);
      }
      return timetable;
    }

    const candidates = await tx
      .select()
      .from(timetables)
      .where(
        and(
          eq(timetables.institutionId, institutionId),
          eq(timetables.campusId, scope.campusId),
          eq(timetables.academicYearId, scope.academicYearId),
          eq(timetables.status, 'published'),
          isNull(timetables.archivedAt),
        ),
      )
      .orderBy(desc(timetables.effectiveFrom));

    const chosen = candidates.find((row) => row.effectiveFrom <= scope.onDate) ?? candidates[0];
    if (!chosen) throw new NotFoundError('Published timetable');
    return chosen;
  }

  private async loadPeriodIndex(tx: Tx, institutionId: string): Promise<PeriodIndex> {
    const rows = await tx
      .select({
        id: periods.id,
        shiftId: periods.shiftId,
        sequence: periods.sequence,
        nameEn: periods.nameEn,
      })
      .from(periods)
      .where(and(eq(periods.institutionId, institutionId), isNull(periods.archivedAt)));

    const byId = new Map<string, PeriodInfo>();
    const bySlot = new Map<string, string>();
    for (const row of rows) {
      byId.set(row.id, { shiftId: row.shiftId, sequence: row.sequence, nameEn: row.nameEn });
      bySlot.set(`${row.shiftId}:${row.sequence}`, row.id);
    }

    const next = new Map<string, string>();
    for (const [id, info] of byId) {
      const following = bySlot.get(`${info.shiftId}:${info.sequence + 1}`);
      if (following) next.set(id, following);
    }

    return { byId, next };
  }

  /**
   * Entries with the labels a human reads them by.
   *
   * Takes a list of timetable ids rather than one, because a teacher who works across two
   * campuses appears in two published routines and their week is one grid, not two — and
   * issuing one query per routine inside a transaction is both slower and, on a shared
   * connection, sequential anyway.
   */
  private async loadEntries(tx: Tx, timetableIds: string[], extra?: SQL) {
    // No early return for an empty list: drizzle renders `in ()` as `false`, so the query is
    // a no-op, and returning `[]` from a second branch would give the function a union return
    // type that every caller then has to narrow.
    const filters: SQL[] = [
      inArray(timetableEntries.timetableId, timetableIds),
      isNull(timetableEntries.archivedAt),
    ];
    if (extra) filters.push(extra);

    const rows = await tx
      .select({
        id: timetableEntries.id,
        timetableId: timetableEntries.timetableId,
        sectionId: timetableEntries.sectionId,
        dayOfWeek: timetableEntries.dayOfWeek,
        periodId: timetableEntries.periodId,
        subjectId: timetableEntries.subjectId,
        employeeId: timetableEntries.employeeId,
        roomId: timetableEntries.roomId,
        isDoublePeriod: timetableEntries.isDoublePeriod,
        note: timetableEntries.note,
        sectionName: sections.nameEn,
        classLevelName: classLevels.nameEn,
        classLevelOrdinal: classLevels.ordinal,
        periodName: periods.nameEn,
        periodSequence: periods.sequence,
        startTime: periods.startTime,
        endTime: periods.endTime,
        subjectName: subjects.nameEn,
        subjectNameBn: subjects.nameBn,
        subjectCode: subjects.code,
        teacherName: employees.fullNameEn,
        roomName: rooms.nameEn,
        roomCode: rooms.code,
      })
      .from(timetableEntries)
      .innerJoin(sections, eq(sections.id, timetableEntries.sectionId))
      .innerJoin(classLevels, eq(classLevels.id, sections.classLevelId))
      .innerJoin(periods, eq(periods.id, timetableEntries.periodId))
      .innerJoin(subjects, eq(subjects.id, timetableEntries.subjectId))
      .leftJoin(employees, eq(employees.id, timetableEntries.employeeId))
      .leftJoin(rooms, eq(rooms.id, timetableEntries.roomId))
      .where(and(...filters))
      .orderBy(
        asc(timetableEntries.dayOfWeek),
        asc(periods.sequence),
        asc(classLevels.ordinal),
        asc(sections.nameEn),
      );

    return rows.map((row) => ({
      ...row,
      sectionLabel: `${row.classLevelName} — ${row.sectionName}`,
      roomLabel: row.roomName ? `${row.roomName} (${row.roomCode})` : null,
    }));
  }

  private async loadSubstitutions(tx: Tx, entryIds: string[], fromDate: string) {
    // As above: an empty `inArray` is rendered as `false`, so this stays one code path.
    return tx
      .select({
        id: timetableSubstitutions.id,
        entryId: timetableSubstitutions.entryId,
        substitutionDate: timetableSubstitutions.substitutionDate,
        periodId: timetableSubstitutions.periodId,
        substituteEmployeeId: timetableSubstitutions.substituteEmployeeId,
        originalEmployeeId: timetableSubstitutions.originalEmployeeId,
        reason: timetableSubstitutions.reason,
        substituteName: employees.fullNameEn,
      })
      .from(timetableSubstitutions)
      .innerJoin(employees, eq(employees.id, timetableSubstitutions.substituteEmployeeId))
      .where(
        and(
          inArray(timetableSubstitutions.entryId, entryIds),
          gte(timetableSubstitutions.substitutionDate, fromDate),
          isNull(timetableSubstitutions.archivedAt),
        ),
      )
      .orderBy(asc(timetableSubstitutions.substitutionDate));
  }

  /** Covers this teacher is involved in, either as the substitute or as the one covered. */
  private async loadTeacherSubstitutions(
    tx: Tx,
    institutionId: string,
    employeeId: string,
    fromDate: string,
  ) {
    const rows = await tx
      .select({
        id: timetableSubstitutions.id,
        entryId: timetableSubstitutions.entryId,
        substitutionDate: timetableSubstitutions.substitutionDate,
        periodId: timetableSubstitutions.periodId,
        substituteEmployeeId: timetableSubstitutions.substituteEmployeeId,
        originalEmployeeId: timetableSubstitutions.originalEmployeeId,
        reason: timetableSubstitutions.reason,
        sectionId: timetableEntries.sectionId,
        subjectId: timetableEntries.subjectId,
        dayOfWeek: timetableEntries.dayOfWeek,
      })
      .from(timetableSubstitutions)
      .innerJoin(timetableEntries, eq(timetableEntries.id, timetableSubstitutions.entryId))
      .where(
        and(
          eq(timetableSubstitutions.institutionId, institutionId),
          gte(timetableSubstitutions.substitutionDate, fromDate),
          isNull(timetableSubstitutions.archivedAt),
          or(
            eq(timetableSubstitutions.substituteEmployeeId, employeeId),
            eq(timetableSubstitutions.originalEmployeeId, employeeId),
          ),
        ),
      )
      .orderBy(asc(timetableSubstitutions.substitutionDate));

    return rows.map((row) => ({
      ...row,
      role: row.substituteEmployeeId === employeeId ? ('covering' as const) : ('covered' as const),
    }));
  }

  /**
   * The periods this teacher is already committed to on a given date.
   *
   * Two sources, and both matter: the lessons they teach in their own routine, and any cover
   * already assigned to them that day. Lessons they have themselves been covered for are
   * excluded — that is precisely what being covered means.
   */
  private async substituteOccupiedPeriods(
    tx: Tx,
    institutionId: string,
    employeeId: string,
    date: string,
    weekday: number,
    periodIndex: PeriodIndex,
  ): Promise<Set<string>> {
    const occupied = new Set<string>();

    const own = await tx
      .select({
        id: timetableEntries.id,
        periodId: timetableEntries.periodId,
        isDoublePeriod: timetableEntries.isDoublePeriod,
        coveredElsewhere: sql<boolean>`exists (
          select 1 from ${timetableSubstitutions}
          where ${timetableSubstitutions.entryId} = ${timetableEntries.id}
            and ${timetableSubstitutions.substitutionDate} = ${date}
            and ${timetableSubstitutions.archivedAt} is null
        )`,
      })
      .from(timetableEntries)
      .innerJoin(timetables, eq(timetables.id, timetableEntries.timetableId))
      .where(
        and(
          eq(timetableEntries.institutionId, institutionId),
          eq(timetableEntries.employeeId, employeeId),
          eq(timetableEntries.dayOfWeek, weekday),
          isNull(timetableEntries.archivedAt),
          eq(timetables.status, 'published'),
          isNull(timetables.archivedAt),
          lte(timetables.effectiveFrom, date),
        ),
      );

    for (const row of own) {
      if (row.coveredElsewhere) continue;
      occupied.add(row.periodId);
      if (row.isDoublePeriod) {
        const spill = periodIndex.next.get(row.periodId);
        if (spill) occupied.add(spill);
      }
    }

    const covers = await tx
      .select({
        periodId: timetableSubstitutions.periodId,
        isDoublePeriod: timetableEntries.isDoublePeriod,
      })
      .from(timetableSubstitutions)
      .innerJoin(timetableEntries, eq(timetableEntries.id, timetableSubstitutions.entryId))
      .where(
        and(
          eq(timetableSubstitutions.institutionId, institutionId),
          eq(timetableSubstitutions.substituteEmployeeId, employeeId),
          eq(timetableSubstitutions.substitutionDate, date),
          isNull(timetableSubstitutions.archivedAt),
        ),
      );

    for (const row of covers) {
      occupied.add(row.periodId);
      if (row.isDoublePeriod) {
        const spill = periodIndex.next.get(row.periodId);
        if (spill) occupied.add(spill);
      }
    }

    return occupied;
  }

  private async buildValidationReport(
    tx: Tx,
    timetable: TimetableRow,
  ): Promise<TimetableValidationReport> {
    const entries = await this.loadEntries(tx, [timetable.id]);
    const periodIndex = await this.loadPeriodIndex(tx, timetable.institutionId);

    const labels: Labels = {
      sections: new Map(),
      employees: new Map(),
      rooms: new Map(),
      periods: new Map(),
    };
    for (const [id, info] of periodIndex.byId) labels.periods.set(id, info.nameEn);
    for (const entry of entries) {
      labels.sections.set(entry.sectionId, entry.sectionLabel);
      if (entry.employeeId && entry.teacherName) {
        labels.employees.set(entry.employeeId, entry.teacherName);
      }
      if (entry.roomId && entry.roomLabel) labels.rooms.set(entry.roomId, entry.roomLabel);
      labels.periods.set(entry.periodId, entry.periodName);
    }

    const placements = entries.flatMap((entry) =>
      expandPlacement(
        {
          entryKey: entry.id,
          sectionId: entry.sectionId,
          employeeId: entry.employeeId,
          roomId: entry.roomId,
          dayOfWeek: entry.dayOfWeek,
          periodId: entry.periodId,
        },
        entry.isDoublePeriod,
        periodIndex,
      ),
    );

    const conflicts = detectConflicts(placements, labels);

    const warnings: Array<{ entryIds: string[]; message: string }> = [];
    const unstaffed = entries.filter((entry) => entry.employeeId === null);
    if (unstaffed.length > 0) {
      // Not a blocker: a routine is often published with a vacancy still being recruited for.
      // It is the first thing a head teacher wants flagged, though.
      warnings.push({
        entryIds: unstaffed.map((entry) => entry.id),
        message: `${unstaffed.length} lesson${unstaffed.length === 1 ? ' has' : 's have'} no teacher assigned.`,
      });
    }

    return {
      timetableId: timetable.id,
      status: timetable.status,
      entryCount: entries.length,
      isValid: conflicts.length === 0,
      conflicts,
      warnings,
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────────────
// Pure helpers. Kept outside the class because they take no database and no principal, which
// makes them directly unit-testable and makes it obvious that they cannot leak a row.
// ──────────────────────────────────────────────────────────────────────────────────────

/** 0 = Sunday, matching `dhakaWeekday`. */
const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** Employment states in which a person can be put in front of a class. */
const TEACHABLE_EMPLOYMENT_STATUSES = new Set<string>(['active', 'probation']);

const TIMETABLE_COLUMNS = {
  nameEn: timetables.nameEn,
  effectiveFrom: timetables.effectiveFrom,
  status: timetables.status,
  createdAt: timetables.createdAt,
} as const;

/**
 * One entry becomes one placement, or two when it is a double period.
 *
 * This is the rule no unique index can express, and the reason publication re-validates the
 * whole set instead of trusting the indexes that guarded each write.
 */
function expandPlacement(
  base: Placement,
  isDoublePeriod: boolean,
  periodIndex: PeriodIndex,
): Placement[] {
  if (!isDoublePeriod) return [base];
  const spill = periodIndex.next.get(base.periodId);
  // A double period in the last slot of the shift spills nowhere; the flag is then cosmetic
  // rather than an error, because the lesson simply runs to the end of the day.
  if (!spill) return [base];
  return [base, { ...base, periodId: spill }];
}

function detectConflicts(placements: Placement[], labels: Labels): TimetableConflict[] {
  const dimensions: Array<{
    kind: TimetableConflict['kind'];
    pick: (placement: Placement) => string | null;
    labels: Map<string, string>;
    describe: (label: string, period: string, day: string) => string;
  }> = [
    {
      kind: 'section',
      pick: (placement) => placement.sectionId,
      labels: labels.sections,
      describe: (label, period, day) =>
        `${label} is scheduled for two lessons in ${period} on ${day}.`,
    },
    {
      kind: 'teacher',
      pick: (placement) => placement.employeeId,
      labels: labels.employees,
      describe: (label, period, day) =>
        `${label} is scheduled to teach two classes in ${period} on ${day}.`,
    },
    {
      kind: 'room',
      pick: (placement) => placement.roomId,
      labels: labels.rooms,
      describe: (label, period, day) => `${label} is booked by two classes in ${period} on ${day}.`,
    },
  ];

  const conflicts: TimetableConflict[] = [];

  for (const dimension of dimensions) {
    const groups = new Map<string, Placement[]>();
    for (const placement of placements) {
      const resourceId = dimension.pick(placement);
      if (!resourceId) continue;
      const key = `${placement.dayOfWeek}|${placement.periodId}|${resourceId}`;
      const group = groups.get(key);
      if (group) group.push(placement);
      else groups.set(key, [placement]);
    }

    for (const group of groups.values()) {
      const entryIds = [...new Set(group.map((placement) => placement.entryKey))];
      // Two placements from the *same* entry are the two halves of a double period, not a
      // clash with itself.
      if (entryIds.length < 2) continue;

      const first = group[0]!;
      const resourceId = dimension.pick(first)!;
      const resourceLabel = dimension.labels.get(resourceId) ?? resourceId;
      const periodLabel = labels.periods.get(first.periodId) ?? 'that period';
      const dayLabel = DAY_NAMES[first.dayOfWeek] ?? `day ${first.dayOfWeek}`;

      conflicts.push({
        kind: dimension.kind,
        dayOfWeek: first.dayOfWeek,
        periodId: first.periodId,
        periodLabel,
        resourceId,
        resourceLabel,
        entryIds,
        message: dimension.describe(resourceLabel, periodLabel, dayLabel),
      });
    }
  }

  return conflicts.sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.kind.localeCompare(b.kind));
}

/**
 * Every conflict in the message, not just the first.
 *
 * The error envelope carries only a code and a message for a 409, so the message is where the
 * list has to live. Past ten it points at the validate endpoint rather than returning a wall
 * of text no one reads.
 */
function conflictError(conflicts: TimetableConflict[]): ConflictError {
  const shown = conflicts.slice(0, 10).map((conflict) => conflict.message);
  const remainder = conflicts.length - shown.length;
  const tail =
    remainder > 0 ? ` …and ${remainder} more. Run the validate endpoint for the full list.` : '';

  return new ConflictError(
    `This change clashes with the rest of the routine: ${shown.join(' ')}${tail}`,
    { conflicts },
  );
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

/**
 * A reference the caller named that is not in this institution.
 *
 * Reported as 404 rather than 403 for the same reason a cross-tenant read is: the caller has
 * learned nothing about whether the id exists somewhere else.
 */
function assertAllFound(resource: string, requested: string[], found: Array<{ id: string }>): void {
  if (found.length === requested.length) return;
  const present = new Set(found.map((row) => row.id));
  const missing = requested.find((id) => !present.has(id));
  throw new NotFoundError(resource, missing);
}
