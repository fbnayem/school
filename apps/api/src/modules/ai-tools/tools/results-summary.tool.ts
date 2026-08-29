/**
 * `results.summary` — one student's own performance, and nothing about anybody else's.
 *
 * Two subtractions define this tool.
 *
 * **No other student's marks, ever.** The `results` row carries `position_in_section` and
 * `position_in_class`, and a section of thirty with a named rank is a table of thirty
 * children's relative performance reconstructable over thirty questions. So the exact rank
 * never leaves: it is converted to a band (`top_10_percent`, `upper_quartile`, …) computed
 * against the cohort size, which answers "is my child doing well" — the question actually
 * being asked — without answering "who did better than mine".
 *
 * **No unpublished result to a family.** A result exists from the moment it is computed and
 * becomes a fact for a parent only when a human with `results.publish` publishes it; the gap
 * between the two is where a moderation meeting happens. A caller whose results scope is `own`
 * therefore sees published results only. Staff scopes (`all`, `assigned`) see unpublished ones
 * too — they are the people doing the moderating — and each result says which it is, so a
 * copilot summarising for a teacher can say "provisional".
 */

import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { results } from '@shikkha/db';
import {
  resultsSummaryArgsSchema,
  type ResultsSummaryArgs,
  type AiToolName,
} from '@shikkha/validation';
import { SCOPED_RESOURCES, type Permission } from '@shikkha/permissions';
import { DatabaseService } from '../../database/database.service';
import { ToolScopeService } from '../tool-scope.service';
import { averageHundredths, decimalToHundredths, formatHundredths } from '../decimal';
import { untrusted } from '../untrusted-text';
import type { AiTool, AiToolContext, AiToolResult } from './tool.types';

/** The cohort bands. Coarse on purpose — see the file header. */
export type PositionBand =
  'top_10_percent' | 'upper_quartile' | 'second_quartile' | 'third_quartile' | 'lower_quartile';

interface SubjectAverage {
  subjectId: string | null;
  /** Wrapped: a subject name is institution-authored free text in a `varchar(128)`. */
  subjectName: string | null;
  averagePercentage: string | null;
  latestGrade: string | null;
  examsCounted: number;
}

interface ResultsSummaryData {
  studentId: string;
  examsCounted: number;
  /** False when any counted result is not yet published; the answer is then provisional. */
  allPublished: boolean;
  subjects: SubjectAverage[];
  overall: {
    averagePercentage: string | null;
    latestGpa: string | null;
    latestGrade: string | null;
    latestExamId: string | null;
  };
  /** From the most recent counted result, against its section cohort. Never an exact rank. */
  positionBand: PositionBand | null;
}

/** One entry of `results.subject_breakdown`, as `ExamsService.computeResult` writes it. */
interface BreakdownEntry {
  subjectId?: string;
  subjectNameEn?: string;
  percentage?: string;
  grade?: string;
}

@Injectable()
export class ResultsSummaryTool implements AiTool<ResultsSummaryArgs> {
  readonly name: AiToolName = 'results.summary';
  readonly description =
    "One student's exam performance: per-subject average percentages, the latest grade and " +
    'GPA, and a position band such as top_10_percent within their section. Never returns ' +
    "another student's marks and never returns an exact rank. Callers who may only see their " +
    'own or their children’s results see published results only; when allPublished is false ' +
    'the figures are provisional and must be described as such.';
  readonly schema = resultsSummaryArgsSchema;
  readonly permissions: readonly Permission[] = [
    'results.view.all',
    'results.view.assigned',
    'results.view.own',
  ];
  /** Ids only. */
  readonly freeTextArguments = [] as const;

  constructor(
    private readonly db: DatabaseService,
    private readonly scope: ToolScopeService,
  ) {}

  async execute(
    context: AiToolContext,
    args: ResultsSummaryArgs,
  ): Promise<AiToolResult<ResultsSummaryData>> {
    const { principal, institutionId } = context;
    const resultsScope = this.scope.scopeFor(principal, SCOPED_RESOURCES.results);

    // Row-level enforcement, reusing the students rule: an out-of-scope student is a 404
    // before any mark is read.
    await this.scope.assertVisibleStudent(principal, args.studentId);

    const filters: SQL[] = [
      eq(results.studentId, args.studentId),
      eq(results.institutionId, institutionId),
      isNull(results.archivedAt),
    ];
    if (args.examId) filters.push(eq(results.examId, args.examId));
    else if (args.academicYearId) filters.push(eq(results.academicYearId, args.academicYearId));

    // The publication gate. Expressed as a SQL predicate rather than a filter in Node so an
    // unpublished result is never fetched at all — a row that is never loaded cannot be
    // leaked by a later refactor that forgets to drop it.
    if (resultsScope === 'own') filters.push(isNotNull(results.publishedAt));

    return this.db.runInTenant(async (tx) => {
      const rows = await tx
        .select({
          id: results.id,
          examId: results.examId,
          sectionId: results.sectionId,
          percentage: results.percentage,
          gpa: results.gpa,
          grade: results.grade,
          positionInSection: results.positionInSection,
          subjectBreakdown: results.subjectBreakdown,
          publishedAt: results.publishedAt,
          computedAt: results.computedAt,
        })
        .from(results)
        .where(and(...filters))
        .orderBy(desc(results.computedAt))
        // A student sits a handful of exams a year; the bound is a backstop, not a page.
        .limit(24);

      if (rows.length === 0) {
        return {
          data: {
            studentId: args.studentId,
            examsCounted: 0,
            allPublished: true,
            subjects: [],
            overall: {
              averagePercentage: null,
              latestGpa: null,
              latestGrade: null,
              latestExamId: null,
            },
            positionBand: null,
          },
          rowCount: 0,
        };
      }

      const latest = rows[0]!;
      const cohortSize = await this.cohortSize(tx, latest.examId, latest.sectionId);

      return {
        data: {
          studentId: args.studentId,
          examsCounted: rows.length,
          allPublished: rows.every((row) => row.publishedAt !== null),
          subjects: summariseSubjects(rows.map((row) => row.subjectBreakdown)),
          overall: {
            averagePercentage: formatHundredths(
              averageHundredths(rows.map((row) => decimalToHundredths(row.percentage))),
            ),
            latestGpa: latest.gpa,
            latestGrade: latest.grade,
            latestExamId: latest.examId,
          },
          positionBand: bandFor(latest.positionInSection, cohortSize),
        },
        rowCount: rows.length,
      };
    });
  }

  /**
   * How many students the position is out of.
   *
   * A count, never the rows: this is the one query in the module that touches other students'
   * result records, and it returns a single integer so that nothing about any of them can
   * come back with it.
   */
  private async cohortSize(
    tx: Parameters<Parameters<DatabaseService['runInTenant']>[0]>[0],
    examId: string,
    sectionId: string,
  ): Promise<number> {
    const [row] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(results)
      .where(
        and(
          eq(results.examId, examId),
          eq(results.sectionId, sectionId),
          isNull(results.archivedAt),
        ),
      );
    return row?.total ?? 0;
  }
}

/**
 * Per-subject averages across the counted exams.
 *
 * Keyed on the subject id where there is one and on the name otherwise, because a breakdown
 * written before a subject was linked has a name and no id, and dropping those entries would
 * silently shorten a marksheet.
 */
function summariseSubjects(breakdowns: unknown[]): SubjectAverage[] {
  const buckets = new Map<
    string,
    {
      subjectId: string | null;
      subjectName: string | null;
      percentages: number[];
      grade: string | null;
    }
  >();

  // Oldest first, so "latest grade" is the last one written rather than the first.
  for (const breakdown of [...breakdowns].reverse()) {
    if (!Array.isArray(breakdown)) continue;
    for (const raw of breakdown as BreakdownEntry[]) {
      if (!raw || typeof raw !== 'object') continue;
      const key = raw.subjectId ?? raw.subjectNameEn;
      if (!key) continue;
      const bucket = buckets.get(key) ?? {
        subjectId: raw.subjectId ?? null,
        subjectName: raw.subjectNameEn ?? null,
        percentages: [] as number[],
        grade: null as string | null,
      };
      if (typeof raw.percentage === 'string') {
        try {
          bucket.percentages.push(decimalToHundredths(raw.percentage));
        } catch {
          // A breakdown entry written by an older computation with an unexpected precision.
          // Skipped rather than crashing the whole summary, and it cannot skew the average
          // because it is not counted in the divisor either.
        }
      }
      if (typeof raw.grade === 'string') bucket.grade = raw.grade;
      buckets.set(key, bucket);
    }
  }

  return [...buckets.values()].map((bucket) => ({
    subjectId: bucket.subjectId,
    subjectName: untrusted('result.subjectName', bucket.subjectName),
    averagePercentage: formatHundredths(averageHundredths(bucket.percentages)),
    latestGrade: bucket.grade,
    examsCounted: bucket.percentages.length,
  }));
}

/**
 * Rank to band.
 *
 * A cohort of fewer than four is reported as `null` rather than banded: in a section of three,
 * "upper quartile" is "first", and the band would be exactly the rank it exists to hide.
 */
export function bandFor(position: number | null, cohortSize: number): PositionBand | null {
  if (position === null || position < 1 || cohortSize < 4) return null;
  if (position <= Math.ceil(cohortSize / 10)) return 'top_10_percent';
  const quartile = Math.ceil((position / cohortSize) * 4);
  if (quartile <= 1) return 'upper_quartile';
  if (quartile === 2) return 'second_quartile';
  if (quartile === 3) return 'third_quartile';
  return 'lower_quartile';
}
