/**
 * `student.lookup` — find a student, scoped exactly as the human endpoint.
 *
 * "Exactly as the human endpoint" is not a comment, it is the implementation: this tool calls
 * `StudentsService.findOne` and `StudentsService.queryScoped`, which are the same methods
 * `GET /students/:id` and the student export call. A class teacher therefore sees the students
 * in the sections they teach and a guardian sees their own linked children, without this file
 * containing a single line of scope logic that could drift from the students module.
 *
 * The interesting work here is *subtraction*. `StudentRow` carries date of birth, national ID,
 * birth registration number, both parents' names, phone, email, both addresses, district, the
 * previous institution and — for a caller with `students.medical.view` — allergies and medical
 * conditions. All of it is legitimately on the human record page. Almost none of it answers
 * "who is Rahim in class six", and docs/06 §2 rule 2 says a tool returns the minimum that
 * answers the question. Handing the whole row to a model would put a child's medical history
 * into a prompt because somebody asked for their roll number.
 *
 * So the projection is: identity, where they sit, whether they are active. Anything more is a
 * separate, separately-audited endpoint that a human opens.
 */

import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { classLevels, enrollments, sections } from '@shikkha/db';
import {
  studentLookupArgsSchema,
  type StudentLookupArgs,
  type AiToolName,
} from '@shikkha/validation';
import type { Permission } from '@shikkha/permissions';
import { DatabaseService } from '../../database/database.service';
import { StudentsService, type StudentRow } from '../../students/students.service';
import { untrusted } from '../untrusted-text';
import type { AiTool, AiToolContext, AiToolResult } from './tool.types';

/** What a model is given about a student. Deliberately short; see the file header. */
interface StudentSummary {
  id: string;
  studentCode: string;
  admissionNumber: string;
  /** Wrapped: the public admission form is self-service, so a name is user-authored text. */
  fullName: string | null;
  status: string;
  section: { id: string; name: string } | null;
  classLevel: { id: string; name: string } | null;
}

@Injectable()
export class StudentLookupTool implements AiTool<StudentLookupArgs> {
  readonly name: AiToolName = 'student.lookup';
  readonly description =
    'Find a student by identifier, or search by name, student code or admission number. ' +
    'Give exactly one of studentId or q. Returns identity and current class placement only — ' +
    'never contact details, date of birth, guardian details or medical information; ask a ' +
    'human to open the student record for those. Only students the caller is permitted to ' +
    'see are searched, so an empty result means "none you may see", not "none exist".';
  readonly schema = studentLookupArgsSchema;
  readonly permissions: readonly Permission[] = [
    'students.view.all',
    'students.view.assigned',
    'students.view.own',
  ];
  /** `q` is whatever a user typed into a chat box before the model relayed it. */
  readonly freeTextArguments = ['q'] as const;

  constructor(
    private readonly db: DatabaseService,
    private readonly students: StudentsService,
  ) {}

  async execute(
    context: AiToolContext,
    args: StudentLookupArgs,
  ): Promise<AiToolResult<{ students: StudentSummary[] }>> {
    const rows = args.studentId
      ? [await this.students.findOne(context.principal, args.studentId)]
      : await this.students.queryScoped(
          context.principal,
          {
            page: 1,
            pageSize: args.limit,
            includeArchived: false,
            ...(args.q ? { q: args.q } : {}),
            ...(args.sectionId ? { sectionId: args.sectionId } : {}),
          },
          args.limit,
        );

    const placements = await this.currentPlacements(
      context.institutionId,
      rows.map((row) => row.id),
    );

    return {
      data: { students: rows.map((row) => this.project(row, placements.get(row.id) ?? null)) },
      rowCount: rows.length,
    };
  }

  /**
   * Where each student currently sits.
   *
   * A separate query rather than a join on the scoped read, because `queryScoped` is the
   * students module's own method and widening its select to serve this tool would change the
   * shape of a path used by the export. One extra indexed lookup is the cheaper mistake.
   *
   * Only `active` enrolments: a student who was transferred out of 6A in March is in 6B now,
   * and reporting both would let a model state that a child is in two sections.
   */
  private async currentPlacements(
    institutionId: string,
    studentIds: string[],
  ): Promise<
    Map<string, { section: StudentSummary['section']; classLevel: StudentSummary['classLevel'] }>
  > {
    if (studentIds.length === 0) return new Map();

    return this.db.runInTenant(async (tx) => {
      const rows = await tx
        .select({
          studentId: enrollments.studentId,
          sectionId: sections.id,
          sectionName: sections.nameEn,
          classLevelId: classLevels.id,
          classLevelName: classLevels.nameEn,
        })
        .from(enrollments)
        .innerJoin(sections, eq(sections.id, enrollments.sectionId))
        .innerJoin(classLevels, eq(classLevels.id, enrollments.classLevelId))
        .where(
          and(
            inArray(enrollments.studentId, studentIds),
            eq(enrollments.institutionId, institutionId),
            eq(enrollments.status, 'active'),
            isNull(enrollments.archivedAt),
          ),
        );

      const map = new Map<
        string,
        { section: StudentSummary['section']; classLevel: StudentSummary['classLevel'] }
      >();
      for (const row of rows) {
        map.set(row.studentId, {
          section: { id: row.sectionId, name: row.sectionName },
          classLevel: { id: row.classLevelId, name: row.classLevelName },
        });
      }
      return map;
    });
  }

  private project(
    row: StudentRow,
    placement: {
      section: StudentSummary['section'];
      classLevel: StudentSummary['classLevel'];
    } | null,
  ): StudentSummary {
    return {
      id: row.id,
      studentCode: row.studentCode,
      admissionNumber: row.admissionNumber,
      fullName: untrusted('student.fullName', row.fullNameEn),
      status: row.status,
      section: placement?.section ?? null,
      classLevel: placement?.classLevel ?? null,
    };
  }
}
