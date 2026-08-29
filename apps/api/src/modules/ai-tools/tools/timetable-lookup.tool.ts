/**
 * `timetable.lookup` — the periods for one section, or one teacher, on one day.
 *
 * Three things here are easy to get wrong and are therefore done explicitly.
 *
 * **Which routine is in force.** A school republishes its timetable when the Ramadan schedule
 * starts, when a term changes, when a teacher leaves. `timetables` keeps every version, so the
 * answer for a given date is the *latest published routine whose `effective_from` is on or
 * before that date*, per campus and academic year. Taking "the published one" without the
 * date comparison silently answers with next term's routine from the day it is published.
 *
 * **Substitutions are part of the answer.** `timetable_substitutions` records a one-day swap,
 * and the whole reason the table is not a delete-and-reinsert is that "who actually took Class
 * 7 on the 14th" must stay answerable. A lookup that ignored them would tell a parent their
 * child's regular teacher took a lesson they did not, which is exactly the question asked
 * after an incident.
 *
 * **A teacher's day is not the same query as a section's day.** For a teacher it is: the
 * periods they are timetabled for, minus the ones somebody covered for them, plus the ones
 * they covered for somebody else. Getting that wrong produces a teacher who is told they are
 * free during a lesson they are standing in.
 *
 * Authorization: `timetable.view` is a flat permission with no `.own` variant in the
 * catalogue, so it cannot on its own stop a guardian asking for an arbitrary section or an
 * arbitrary teacher. The scope is enforced on the data instead — see `ToolScopeService`, where
 * the gap is recorded.
 */

import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import {
  employees,
  periods,
  rooms,
  sections,
  subjects,
  timetableEntries,
  timetableSubstitutions,
  timetables,
} from '@shikkha/db';
import { dhakaWeekday, type CalendarDate } from '@shikkha/shared';
import {
  timetableLookupArgsSchema,
  type TimetableLookupArgs,
  type AiToolName,
} from '@shikkha/validation';
import type { Permission } from '@shikkha/permissions';
import { DatabaseService } from '../../database/database.service';
import { ToolScopeService } from '../tool-scope.service';
import { untrusted } from '../untrusted-text';
import type { AiTool, AiToolContext, AiToolResult } from './tool.types';

interface TimetablePeriod {
  periodId: string;
  periodName: string;
  sequence: number;
  startTime: string;
  endTime: string;
  section: { id: string; name: string };
  subject: { id: string; name: string };
  teacher: { id: string; name: string } | null;
  room: { id: string; name: string } | null;
  isDoublePeriod: boolean;
  /** True when a substitution applies to this period on this date. */
  isSubstitution: boolean;
  /** Wrapped: a routine note is free text a coordinator typed. */
  note: string | null;
}

interface TimetableLookupData {
  date: string;
  /** 0 = Sunday, matching `academic_years.weekend_days` and `dhakaWeekday`. */
  dayOfWeek: number;
  /** What this lookup is about. Named `about` so it cannot be read as a school subject. */
  about: { kind: 'section'; sectionId: string } | { kind: 'employee'; employeeId: string };
  periods: TimetablePeriod[];
}

@Injectable()
export class TimetableLookupTool implements AiTool<TimetableLookupArgs> {
  readonly name: AiToolName = 'timetable.lookup';
  readonly description =
    'The lesson periods for one section, or one teacher, on one date. Give exactly one of ' +
    'sectionId or employeeId. Uses the published routine in force on that date and applies ' +
    'any one-day substitutions, flagging each affected period with isSubstitution. An empty ' +
    'list means no lessons are timetabled that day — a holiday, a weekend, or no published ' +
    'routine yet — not that the lookup failed.';
  readonly schema = timetableLookupArgsSchema;
  readonly permissions: readonly Permission[] = ['timetable.view'];
  /** Ids and a date only. */
  readonly freeTextArguments = [] as const;

  constructor(
    private readonly db: DatabaseService,
    private readonly scope: ToolScopeService,
  ) {}

  async execute(
    context: AiToolContext,
    args: TimetableLookupArgs,
  ): Promise<AiToolResult<TimetableLookupData>> {
    const { principal, institutionId } = context;
    const date = args.date as CalendarDate;
    const dayOfWeek = dhakaWeekday(date);

    let about: TimetableLookupData['about'];
    if (args.sectionId) {
      const sectionScope = this.scope.studentScope(principal);
      await this.scope.assertSectionVisible(principal, institutionId, args.sectionId, sectionScope);
      about = { kind: 'section', sectionId: args.sectionId };
    } else {
      await this.scope.assertEmployeeVisible(principal, institutionId, args.employeeId!);
      about = { kind: 'employee', employeeId: args.employeeId! };
    }

    return this.db.runInTenant(async (tx) => {
      const timetableIds = await this.routinesInForce(tx, institutionId, date);
      if (timetableIds.length === 0) {
        return { data: { date, dayOfWeek, about, periods: [] }, rowCount: 0 };
      }

      // Every substitution on this date, keyed by entry. Fetched before the entries because
      // the teacher variant needs it to decide which entries are even in scope.
      const substitutions = await tx
        .select({
          entryId: timetableSubstitutions.entryId,
          substituteEmployeeId: timetableSubstitutions.substituteEmployeeId,
          substituteName: employees.fullNameEn,
        })
        .from(timetableSubstitutions)
        .innerJoin(employees, eq(employees.id, timetableSubstitutions.substituteEmployeeId))
        .innerJoin(timetableEntries, eq(timetableEntries.id, timetableSubstitutions.entryId))
        .where(
          and(
            eq(timetableSubstitutions.institutionId, institutionId),
            eq(timetableSubstitutions.substitutionDate, date),
            inArray(timetableEntries.timetableId, timetableIds),
            isNull(timetableSubstitutions.archivedAt),
          ),
        );

      const substitutionByEntry = new Map(substitutions.map((row) => [row.entryId, row]));

      const scopePredicate =
        about.kind === 'section'
          ? eq(timetableEntries.sectionId, about.sectionId)
          : // The teacher's own periods, or any period they are covering today. The
            // "minus the ones covered for them" half is applied after the fetch, because it
            // depends on the substitution rows rather than on the entry.
            or(
              eq(timetableEntries.employeeId, about.employeeId),
              substitutions.length > 0
                ? inArray(
                    timetableEntries.id,
                    substitutions
                      .filter((row) => row.substituteEmployeeId === about.employeeId)
                      .map((row) => row.entryId),
                  )
                : sql`false`,
            );

      const entries = await tx
        .select({
          id: timetableEntries.id,
          employeeId: timetableEntries.employeeId,
          isDoublePeriod: timetableEntries.isDoublePeriod,
          note: timetableEntries.note,
          periodId: periods.id,
          periodName: periods.nameEn,
          sequence: periods.sequence,
          startTime: periods.startTime,
          endTime: periods.endTime,
          sectionId: sections.id,
          sectionName: sections.nameEn,
          subjectId: subjects.id,
          subjectName: subjects.nameEn,
          teacherName: employees.fullNameEn,
          roomId: rooms.id,
          roomName: rooms.nameEn,
        })
        .from(timetableEntries)
        .innerJoin(periods, eq(periods.id, timetableEntries.periodId))
        .innerJoin(sections, eq(sections.id, timetableEntries.sectionId))
        .innerJoin(subjects, eq(subjects.id, timetableEntries.subjectId))
        .leftJoin(employees, eq(employees.id, timetableEntries.employeeId))
        .leftJoin(rooms, eq(rooms.id, timetableEntries.roomId))
        .where(
          and(
            inArray(timetableEntries.timetableId, timetableIds),
            eq(timetableEntries.dayOfWeek, dayOfWeek),
            isNull(timetableEntries.archivedAt),
            scopePredicate,
          ),
        )
        .orderBy(asc(periods.sequence), asc(sections.nameEn));

      const shown: TimetablePeriod[] = [];
      for (const entry of entries) {
        const substitution = substitutionByEntry.get(entry.id);
        const teacherId = substitution?.substituteEmployeeId ?? entry.employeeId;
        const teacherName = substitution?.substituteName ?? entry.teacherName;

        // A teacher whose lesson was covered is not teaching it. Dropping it here rather than
        // in SQL keeps the substitution rule in one readable place.
        if (about.kind === 'employee' && teacherId !== about.employeeId) continue;

        shown.push({
          periodId: entry.periodId,
          periodName: entry.periodName,
          sequence: entry.sequence,
          startTime: entry.startTime,
          endTime: entry.endTime,
          section: { id: entry.sectionId, name: entry.sectionName },
          subject: { id: entry.subjectId, name: entry.subjectName },
          teacher: teacherId && teacherName ? { id: teacherId, name: teacherName } : null,
          room: entry.roomId && entry.roomName ? { id: entry.roomId, name: entry.roomName } : null,
          isDoublePeriod: entry.isDoublePeriod,
          isSubstitution: substitution !== undefined,
          note: untrusted('timetable.note', entry.note),
        });
      }

      return { data: { date, dayOfWeek, about, periods: shown }, rowCount: shown.length };
    });
  }

  /**
   * The published routines in force on a date: the latest `effective_from` per campus and
   * academic year.
   *
   * Resolved in Node rather than with `DISTINCT ON` because an institution has single-digit
   * published timetables, and the readable version of this rule is worth more than the query
   * plan. The ordering is what matters: descending `effective_from`, first one per key wins.
   */
  private async routinesInForce(
    tx: Parameters<Parameters<DatabaseService['runInTenant']>[0]>[0],
    institutionId: string,
    date: CalendarDate,
  ): Promise<string[]> {
    const candidates = await tx
      .select({
        id: timetables.id,
        campusId: timetables.campusId,
        academicYearId: timetables.academicYearId,
      })
      .from(timetables)
      .where(
        and(
          eq(timetables.institutionId, institutionId),
          eq(timetables.status, 'published'),
          lte(timetables.effectiveFrom, date),
          isNull(timetables.archivedAt),
        ),
      )
      .orderBy(sql`${timetables.effectiveFrom} desc`);

    const chosen = new Map<string, string>();
    for (const row of candidates) {
      const key = `${row.campusId}:${row.academicYearId}`;
      if (!chosen.has(key)) chosen.set(key, row.id);
    }
    return [...chosen.values()];
  }
}
