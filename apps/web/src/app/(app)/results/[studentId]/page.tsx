'use client';

/**
 * One student's marksheet for one exam.
 *
 * ## Nothing on this page is recomputed
 *
 * The grade, the grade point, the GPA, the pass/fail and both positions are printed exactly as
 * `GET /exams/:id/marksheet/:studentId` returned them. **Deriving any of them in the browser
 * would be a correctness bug, not a style preference**, for three separate reasons:
 *
 *  1. A `results` row is a *frozen snapshot* of what was published. The API deliberately does
 *     not recompute it when a mark is later corrected — re-publishing is the audited act that
 *     replaces it. A browser that recomputed from current marks would print a transcript that
 *     disagrees with the one the family already holds, with no record of which is right.
 *  2. The rules are not a weighted average. The fourth subject contributes only what it earns
 *     above the scale's pass threshold and never enters the divisor; subjects flagged
 *     `exclude_from_gpa` leave entirely; failing any compulsory subject is GPA 0.00 and grade
 *     F whatever the average would have been; a subject is passed only by clearing *every*
 *     component threshold it defines, not merely the total. Every one of those is implemented
 *     in `ExamsService.computeResult`, and a second implementation here would be a second
 *     thing to keep correct.
 *  3. All of it runs over integer hundredths on the server. Redoing it in JavaScript floats is
 *     how a marksheet ends up saying 89.99999999999999.
 *
 * So this file formats strings. It does no arithmetic on a mark at all.
 */

import { Suspense, use, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/lib/session';
import { examsApi, type ResultSubject } from '@/components/exams/api';
import { ExamPicker, formatMarks, formatOutOf } from '@/components/exams/shared';
import {
  Badge,
  BilingualName,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  DescriptionList,
  EmptyState,
  ErrorNotice,
  LoadingBlock,
  MetricCard,
  PageHeader,
  StatGrid,
  formatPercent,
  toOptions,
} from '@/components/ui';
import { formatInstant, humanize } from '@/lib/format';

export default function MarksheetPage({ params }: { params: Promise<{ studentId: string }> }) {
  const { studentId } = use(params);
  return (
    // `useSearchParams` needs a Suspense boundary above it in the App Router.
    <Suspense fallback={<LoadingBlock label="Loading marksheet" />}>
      <Marksheet studentId={studentId} />
    </Suspense>
  );
}

function Marksheet({ studentId }: { studentId: string }) {
  const session = useSession();
  const searchParams = useSearchParams();
  const examIdFromUrl = searchParams.get('examId') ?? '';
  const [pickedExamId, setPickedExamId] = useState('');
  const examId = examIdFromUrl || pickedExamId;

  const institutionId = session.institutionId;
  const canView = session.canAny('results.view.all', 'results.view.assigned', 'results.view.own');

  const exams = useQuery({
    queryKey: ['exams', 'published', institutionId],
    queryFn: () =>
      examsApi.list(institutionId!, { pageSize: 100, status: 'published', sort: '-startDate' }),
    // Only needed when the caller arrived without an exam in the URL.
    enabled: Boolean(institutionId) && !examIdFromUrl && session.can('exams.view'),
  });

  const marksheet = useQuery({
    queryKey: ['exams', examId, 'marksheet', studentId, institutionId],
    queryFn: () => examsApi.marksheet(institutionId!, examId, studentId),
    enabled: Boolean(institutionId) && Boolean(examId) && canView,
  });

  if (!institutionId) {
    return (
      <Shell>
        <EmptyState
          title="Choose an institution first"
          description="A marksheet belongs to one institution's exam."
        />
      </Shell>
    );
  }

  if (!canView) {
    return (
      <Shell>
        <EmptyState
          title="This marksheet is not available to you"
          description="Reading a result needs one of results.view.all, results.view.assigned or results.view.own."
        />
      </Shell>
    );
  }

  if (!examId) {
    return (
      <Shell>
        <Card>
          <CardHeader
            title="Which exam?"
            description="A marksheet is one student in one exam. Choose the exam to load it."
          />
          <CardBody padded>
            <ExamPicker
              id="marksheet-exam"
              label="Exam"
              value={pickedExamId}
              onChange={setPickedExamId}
              options={toOptions(exams.data?.data ?? [], (exam) => ({
                value: exam.id,
                label: `${exam.nameEn} (${exam.code})`,
                hint: exam.nameBn ?? humanize(exam.type),
              }))}
              isLoading={exams.isLoading}
              emptyHint="No exams have been published yet"
            />
            {exams.isError ? <ErrorNotice error={exams.error} /> : null}
          </CardBody>
        </Card>
      </Shell>
    );
  }

  if (marksheet.isError) {
    return (
      <Shell>
        <ErrorNotice error={marksheet.error} />
        <p className="mt-3 text-sm text-content-muted">
          A marksheet that is not yours, not in this institution, or not yet published all return
          the same &ldquo;not found&rdquo;. That is deliberate: distinguishing them would confirm
          that the record exists.
        </p>
      </Shell>
    );
  }

  if (marksheet.isLoading || !marksheet.data) {
    return (
      <Shell>
        <LoadingBlock label="Loading marksheet" />
      </Shell>
    );
  }

  const sheet = marksheet.data;
  const result = sheet.result;
  const breakdown = result.subjectBreakdown ?? [];

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={sheet.studentNameEn}
        titleBn={sheet.studentNameBn}
        breadcrumbs={[{ label: 'Results', href: '/results' }, { label: sheet.studentNameEn }]}
        description={`${sheet.examNameEn} · ${humanize(sheet.examType)}`}
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={result.isPassed ? 'success' : 'danger'}>
              {result.isPassed ? 'Passed' : 'Failed'}
            </Badge>
            <span className="font-mono text-xs text-content-subtle">{sheet.studentCode}</span>
          </div>
        }
      />

      {!result.publishedAt ? (
        <p
          role="status"
          className="mb-4 rounded-md bg-warning-subtle px-3 py-2 text-sm text-warning"
        >
          This result has been computed but not published. Families cannot see it — the API's own
          scope filter refuses an unpublished result to anyone reading with results.view.own.
        </p>
      ) : null}

      <StatGrid className="mb-5">
        <MetricCard
          label="GPA"
          value={result.gpa}
          detail={`Across ${result.gpaSubjectCount} subject${result.gpaSubjectCount === 1 ? '' : 's'}`}
          tone={result.isPassed ? 'success' : 'danger'}
        />
        <MetricCard label="Grade" value={result.grade} />
        <MetricCard
          label="Marks"
          value={formatOutOf(result.obtainedMarks, result.totalMarks)}
          detail={formatPercent(result.percentage)}
        />
        <MetricCard
          label="Position in section"
          value={result.positionInSection ? `#${result.positionInSection}` : '—'}
          // rank(), so a tie genuinely shares a position rather than being broken arbitrarily.
          detail={
            result.positionInClass ? `#${result.positionInClass} in the class level` : undefined
          }
        />
      </StatGrid>

      <Card className="mb-5">
        <CardBody padded>
          <DescriptionList
            columns={3}
            items={[
              { label: 'Exam', value: sheet.examNameEn },
              { label: 'Class', value: sheet.classLevelNameEn },
              { label: 'Section', value: sheet.sectionNameEn },
              { label: 'Roll number', value: sheet.rollNumber },
              { label: 'Student ID', value: sheet.studentCode },
              {
                label: 'Subjects failed',
                value: String(result.failedSubjectCount),
              },
              { label: 'Computed', value: formatInstant(result.computedAt) },
              {
                label: 'Published',
                value: result.publishedAt ? formatInstant(result.publishedAt) : null,
                emptyText: 'Not published',
              },
            ]}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Subjects"
          description="Grade and grade point per subject, as they stood when this result was computed."
        />
        <CardBody>
          <DataTable<ResultSubject>
            caption={`Subject breakdown for ${sheet.studentNameEn} in ${sheet.examNameEn}`}
            rows={breakdown}
            rowKey={(row) => row.examSubjectId}
            empty={{
              title: 'No subject breakdown',
              description:
                'This result carries no per-subject snapshot, which happens only when it was computed before any paper was configured.',
            }}
            minWidth="48rem"
            columns={[
              {
                id: 'subject',
                header: 'Subject',
                card: 'title',
                render: (row) => (
                  <BilingualName row={{ nameEn: row.subjectNameEn, nameBn: row.subjectNameBn }} />
                ),
              },
              {
                id: 'code',
                header: 'Code',
                card: 'subtitle',
                className: 'font-mono text-xs text-content-muted',
                render: (row) => row.subjectCode,
              },
              {
                id: 'marks',
                header: 'Marks',
                align: 'right',
                card: 'meta',
                className: 'tabular-nums',
                render: (row) =>
                  row.isAbsent ? 'Absent' : formatOutOf(row.obtainedMarks, row.fullMarks),
              },
              {
                id: 'percentage',
                header: '%',
                align: 'right',
                card: 'meta',
                className: 'tabular-nums text-content-muted',
                hideBelow: 'md',
                render: (row) => formatPercent(row.percentage),
              },
              {
                id: 'gradePoint',
                header: 'Grade point',
                align: 'right',
                card: 'meta',
                className: 'tabular-nums',
                render: (row) => row.gradePoint,
              },
              {
                id: 'grade',
                header: 'Grade',
                card: 'aside',
                render: (row) => (
                  <Badge tone={row.isPassed ? 'success' : 'danger'}>{row.grade}</Badge>
                ),
              },
              {
                id: 'notes',
                header: 'Notes',
                card: 'row',
                render: (row) => (
                  <div className="flex flex-wrap gap-1">
                    {row.isFourthSubject ? <Badge tone="info">Fourth subject</Badge> : null}
                    {row.excludeFromGpa ? <Badge tone="neutral">Outside GPA</Badge> : null}
                    {row.failedComponents.length > 0 ? (
                      // The board rule most systems get wrong: a component threshold missed is
                      // a failed subject even when the total clears the overall pass mark.
                      <Badge tone="danger">
                        Missed {row.failedComponents.map(humanize).join(', ').toLowerCase()}
                      </Badge>
                    ) : null}
                    {row.isFourthSubject ||
                    row.excludeFromGpa ||
                    row.failedComponents.length > 0 ? null : (
                      <span className="text-xs text-content-subtle">—</span>
                    )}
                  </div>
                ),
              },
            ]}
          />
        </CardBody>
      </Card>

      <p className="mt-4 text-xs text-content-subtle">
        Totals, GPA, grade and positions are the values the school published. They are not
        recalculated in this browser — see the note at the top of this file&rsquo;s source for why
        that would be a correctness bug. Full marks shown per subject:{' '}
        {formatMarks(result.totalMarks)} in total.
      </p>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Marksheet"
        breadcrumbs={[{ label: 'Results', href: '/results' }, { label: 'Marksheet' }]}
      />
      {children}
    </div>
  );
}
