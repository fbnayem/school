/**
 * `attendance.summary` — counts and a percentage, never a register.
 *
 * This is the tool docs/06 §2 rule 2 is written about: *"a question about attendance
 * percentage gets a percentage, not a hundred rows containing names and dates of birth."*
 * The section variant therefore returns no student identifier at all — not an id, not a roll
 * number, not a count of one — and the student variant returns exactly the id that was asked
 * for and nothing else that could identify anyone. There is no `remarks`, no per-day list and
 * no "who was absent most often": each of those is a different question, and the answer to it
 * is a screen a human opens, with its own permission and its own audit row.
 *
 * Two modelling decisions worth stating, because both would otherwise be re-litigated by
 * whoever reads a number they did not expect:
 *
 *  1. **Only submitted and locked registers count.** An `open` register is a teacher partway
 *     through taking the roll. Including it makes a morning's percentage swing wildly and
 *     makes yesterday's answer differ from today's for the same range. Excluded registers are
 *     *counted and reported* as `openRegistersExcluded`, so the model can say "provisional"
 *     rather than the caller silently receiving a different number than the office sees.
 *  2. **`excused` is excluded from both sides of the ratio, and `half_day` counts as half.**
 *     A child with a medical certificate has not damaged their attendance, and counting an
 *     approved absence against them is how an attendance-linked stipend gets refused for the
 *     wrong reason. `late` counts as present, because it is: the child was in the room.
 */

import { Injectable } from '@nestjs/common';
import { and, eq, gte, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { attendanceSessions, studentAttendance } from '@shikkha/db';
import { NotFoundError } from '@shikkha/shared';
import {
  attendanceSummaryArgsSchema,
  type AttendanceSummaryArgs,
  type AiToolName,
} from '@shikkha/validation';
import { SCOPED_RESOURCES, type Permission } from '@shikkha/permissions';
import { DatabaseService } from '../../database/database.service';
import { ToolScopeService } from '../tool-scope.service';
import { formatHundredths, ratioToHundredths } from '../decimal';
import type { AiTool, AiToolContext, AiToolResult } from './tool.types';

interface AttendanceSummaryData {
  /** What this summary is about. Named `about` because a timetable period has a `subject`. */
  about: { kind: 'student'; studentId: string } | { kind: 'section'; sectionId: string };
  from: string;
  to: string;
  present: number;
  absent: number;
  late: number;
  excused: number;
  halfDay: number;
  /** The denominator of the percentage: present + late + half_day + absent. */
  countedMarks: number;
  /** Two decimals, or null when nothing in the range was marked. */
  attendancePercentage: string | null;
  registersCounted: number;
  openRegistersExcluded: number;
}

@Injectable()
export class AttendanceSummaryTool implements AiTool<AttendanceSummaryArgs> {
  readonly name: AiToolName = 'attendance.summary';
  readonly description =
    'Attendance totals for one student or one whole section over a date range of at most 400 ' +
    'days. Give exactly one of studentId or sectionId. Returns counts of present, absent, ' +
    'late, excused and half-day marks plus an overall percentage — never individual ' +
    'attendance rows, dates, remarks or, for a section, any student identifier. Registers a ' +
    'teacher has not yet submitted are excluded and reported separately as ' +
    'openRegistersExcluded; say so if that number is not zero. A caller who may only see ' +
    'their own family’s records can summarise a student but not a section.';
  readonly schema = attendanceSummaryArgsSchema;
  readonly permissions: readonly Permission[] = [
    'attendance.view.all',
    'attendance.view.assigned',
    'attendance.view.own',
  ];
  /** Ids and dates only. */
  readonly freeTextArguments = [] as const;

  constructor(
    private readonly db: DatabaseService,
    private readonly scope: ToolScopeService,
  ) {}

  async execute(
    context: AiToolContext,
    args: AttendanceSummaryArgs,
  ): Promise<AiToolResult<AttendanceSummaryData>> {
    const { principal, institutionId } = context;

    // The attendance scope decides *how much* the caller may see; the students scope decides
    // *which students*. Both are consulted, and the narrower one wins by construction: a
    // caller who cannot see the student through the students module gets a 404 before any
    // attendance row is touched.
    const attendanceScope = this.scope.scopeFor(principal, SCOPED_RESOURCES.attendance);

    const filters: SQL[] = [
      eq(attendanceSessions.institutionId, institutionId),
      gte(attendanceSessions.attendanceDate, args.from),
      lte(attendanceSessions.attendanceDate, args.to),
      isNull(attendanceSessions.archivedAt),
      isNull(studentAttendance.archivedAt),
    ];

    let about: AttendanceSummaryData['about'];
    if (args.studentId) {
      // The same visibility rule as `GET /students/:id`, so an out-of-scope student is a 404
      // here exactly as it is there. This is the whole of the row-level enforcement for the
      // student variant — the `student_id` predicate below narrows to one child, and this
      // decides whether the caller may have that child at all.
      await this.scope.assertVisibleStudent(principal, args.studentId);
      filters.push(eq(studentAttendance.studentId, args.studentId));
      about = { kind: 'student', studentId: args.studentId };
    } else {
      const sectionId = args.sectionId!;
      // A caller whose attendance scope is `own` may summarise *their own* records, and a
      // section aggregate is not one of those — it is a statement about thirty other
      // families' children, and the fact that it carries no names does not make it theirs.
      // Refused as a 404 rather than a 403 so it is indistinguishable from a section that
      // does not exist.
      if (attendanceScope === 'own') throw new NotFoundError('Section', sectionId);

      // The narrower of the two scopes, not the attendance one: a head of year who holds
      // `attendance.view.all` but only `students.view.assigned` must not reach a section whose
      // students they cannot list, and the reverse combination must not widen either.
      const sectionScope = ToolScopeService.narrower(
        attendanceScope,
        this.scope.studentScope(principal),
      );
      await this.scope.assertSectionVisible(principal, institutionId, sectionId, sectionScope);
      filters.push(eq(attendanceSessions.sectionId, sectionId));
      about = { kind: 'section', sectionId };
    }

    return this.db.runInTenant(async (tx) => {
      const submitted = sql`${attendanceSessions.status} in ('submitted', 'locked')`;

      const [counts] = await tx
        .select({
          present: countWhere(sql`${studentAttendance.status} = 'present'`, submitted),
          absent: countWhere(sql`${studentAttendance.status} = 'absent'`, submitted),
          late: countWhere(sql`${studentAttendance.status} = 'late'`, submitted),
          excused: countWhere(sql`${studentAttendance.status} = 'excused'`, submitted),
          halfDay: countWhere(sql`${studentAttendance.status} = 'half_day'`, submitted),
          registersCounted: sql<number>`count(distinct ${attendanceSessions.id}) filter (where ${submitted})::int`,
          openRegistersExcluded: sql<number>`count(distinct ${attendanceSessions.id}) filter (where ${attendanceSessions.status} = 'open')::int`,
          rowsScanned: sql<number>`count(*)::int`,
        })
        .from(studentAttendance)
        .innerJoin(attendanceSessions, eq(attendanceSessions.id, studentAttendance.sessionId))
        .where(and(...filters));

      const present = counts?.present ?? 0;
      const absent = counts?.absent ?? 0;
      const late = counts?.late ?? 0;
      const excused = counts?.excused ?? 0;
      const halfDay = counts?.halfDay ?? 0;

      // Scaled by two so a half day is an integer, keeping every step of the arithmetic in
      // integers — see `decimal.ts` for why that matters more than it looks like it should.
      const attendedHalves = (present + late) * 2 + halfDay;
      const countedHalves = (present + late + absent) * 2 + halfDay;

      return {
        data: {
          about,
          from: args.from,
          to: args.to,
          present,
          absent,
          late,
          excused,
          halfDay,
          countedMarks: present + absent + late + halfDay,
          attendancePercentage: formatHundredths(ratioToHundredths(attendedHalves, countedHalves)),
          registersCounted: counts?.registersCounted ?? 0,
          openRegistersExcluded: counts?.openRegistersExcluded ?? 0,
        },
        rowCount: counts?.rowsScanned ?? 0,
      };
    });
  }
}

/**
 * `count(*) filter (where <status> and <register is final>)`.
 *
 * A filtered aggregate rather than five queries or a group-by decoded in Node: one index scan
 * answers the whole question, and a section-year summary over 200 students is 40,000 rows that
 * never leave Postgres.
 */
function countWhere(statusPredicate: SQL, finalRegister: SQL): SQL<number> {
  return sql<number>`count(*) filter (where ${statusPredicate} and ${finalRegister})::int`;
}
