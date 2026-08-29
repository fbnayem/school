'use client';

/**
 * Published results.
 *
 * Nothing on this screen is calculated in the browser. Totals, percentages, GPA, grade and
 * both positions are read from `results`, which the API froze at publication — see
 * `ExamsService.publishResults`. Recomputing any of them here would be a **correctness** bug,
 * not a style one: a result is a snapshot of what the school published, and a browser that
 * re-derives it from the current marks would quietly disagree with the transcript a family
 * already holds the moment any mark is corrected.
 *
 * Two audiences share the screen, and the API decides which one you are:
 *
 *  - Staff (`results.view.all` / `results.view.assigned`) get the tabulation sheet for a
 *    section and, where they hold the reporting permission, the exam's pass rate and grade
 *    distribution.
 *  - A family (`results.view.own`) gets the results that belong to them, and only after they
 *    have been published — the API's scope filter carries that rule, so there is no second
 *    code path here that could forget it.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { academicApi } from '@/components/academic/api';
import { examsApi, type ResultRow, type TabulationStudent } from '@/components/exams/api';
import { ExamPicker, formatMarks, formatOutOf } from '@/components/exams/shared';
import {
  Badge,
  BilingualName,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  ErrorNotice,
  LoadingBlock,
  MetricCard,
  PageHeader,
  Select,
  StatGrid,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  formatPercent,
  toOptions,
} from '@/components/ui';
import { formatInstant, formatNumber, formatRatioPercent, humanize } from '@/lib/format';

export default function ResultsPage() {
  const session = useSession();

  const [examId, setExamId] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [tab, setTab] = useState('section');

  const institutionId = session.institutionId;
  const isStaff = session.canAny('results.view.all', 'results.view.assigned');
  const isFamily = !isStaff && session.can('results.view.own');
  const canReport = session.canAny('results.reports.view', 'results.view.all');

  const exams = useQuery({
    queryKey: ['exams', 'published', institutionId],
    queryFn: () =>
      examsApi.list(institutionId!, { pageSize: 100, status: 'published', sort: '-startDate' }),
    enabled: Boolean(institutionId) && session.can('exams.view'),
  });

  if (!institutionId) {
    return (
      <Shell>
        <EmptyState
          title="Choose an institution first"
          description="A result belongs to one institution's exam, so this screen needs to know which school you are looking at."
        />
      </Shell>
    );
  }

  if (!isStaff && !isFamily) {
    return (
      <Shell>
        <EmptyState
          title="Results are not available to you"
          description="Reading results needs one of results.view.all, results.view.assigned or results.view.own."
        />
      </Shell>
    );
  }

  const examOptions = toOptions(exams.data?.data ?? [], (exam) => ({
    value: exam.id,
    label: `${exam.nameEn} (${exam.code})`,
    hint: exam.nameBn ?? humanize(exam.type),
  }));

  return (
    <Shell>
      <Card className="mb-5">
        <CardHeader
          title="Choose an exam"
          description="Only published exams are listed — a result that has not been published is a working draft the school has not stood behind."
        />
        <CardBody padded>
          <ExamPicker
            id="results-exam"
            label="Exam"
            value={examId}
            onChange={(value) => {
              setExamId(value);
              setSectionId('');
            }}
            options={examOptions}
            isLoading={exams.isLoading}
            emptyHint={exams.isLoading ? 'Loading exams…' : 'No exams have been published yet'}
          />
          {exams.isError ? <ErrorNotice error={exams.error} /> : null}
        </CardBody>
      </Card>

      {!examId ? (
        <EmptyState
          title="Pick an exam"
          description="Results load once an exam is chosen. Nothing is fetched before then."
        />
      ) : isStaff ? (
        <Tabs value={tab} onValueChange={setTab} activation="manual">
          <TabList label="Result views">
            <Tab value="section">By section</Tab>
            {canReport ? <Tab value="summary">Summary</Tab> : null}
          </TabList>

          <TabPanel value="section">
            <SectionResults
              institutionId={institutionId}
              examId={examId}
              sectionId={sectionId}
              onSectionChange={setSectionId}
            />
          </TabPanel>

          {canReport ? (
            <TabPanel value="summary">
              <ExamSummaryPanel institutionId={institutionId} examId={examId} />
            </TabPanel>
          ) : null}
        </Tabs>
      ) : (
        <FamilyResults institutionId={institutionId} examId={examId} />
      )}
    </Shell>
  );
}

/**
 * The tabulation sheet for one section.
 *
 * `GET /exams/:id/tabulation` is the only read that carries both the student's name and the
 * frozen result, which is exactly what this table needs. `GET /exams/:id/results` returns the
 * result rows alone with no name on them, so building the table from that would mean joining
 * two lists in the browser and getting a blank column whenever the roster query is scoped
 * differently from the result query.
 */
function SectionResults({
  institutionId,
  examId,
  sectionId,
  onSectionChange,
}: {
  institutionId: string;
  examId: string;
  sectionId: string;
  onSectionChange: (value: string) => void;
}) {
  const session = useSession();

  const exam = useQuery({
    queryKey: ['exams', examId, 'detail', institutionId],
    queryFn: () => examsApi.get(institutionId, examId),
    enabled: session.can('exams.view'),
  });

  const sections = useQuery({
    queryKey: ['academic', 'sections', institutionId, exam.data?.academicYearId],
    queryFn: () => academicApi.sections(institutionId, exam.data!.academicYearId),
    enabled: Boolean(exam.data) && session.can('academic.sections.view'),
  });

  const tabulation = useQuery({
    queryKey: ['exams', examId, 'tabulation', institutionId, sectionId],
    queryFn: () => examsApi.tabulation(institutionId, examId, sectionId),
    enabled: Boolean(sectionId),
  });

  return (
    <div className="space-y-4">
      <div className="w-full sm:max-w-md">
        <label htmlFor="results-section" className="label">
          Section
        </label>
        <Select
          id="results-section"
          value={sectionId}
          onChange={(event) => onSectionChange(event.target.value)}
          options={toOptions(sections.data ?? [], (section) => ({
            value: section.id,
            label: `${section.classLevelName} · ${section.nameEn}`,
            hint: `${section.enrolledCount} enrolled`,
          }))}
          placeholder={
            sections.isLoading
              ? 'Loading sections…'
              : (sections.data?.length ?? 0) === 0
                ? 'No sections available to you'
                : 'Choose a section'
          }
          allowEmpty
          disabled={sections.isLoading || (sections.data?.length ?? 0) === 0}
        />
      </div>

      {sections.isError ? <ErrorNotice error={sections.error} /> : null}

      {!sectionId ? (
        <EmptyState
          title="Pick a section"
          description="A tabulation sheet is a whole section at once — one row per student, one column per paper."
        />
      ) : (
        <DataTable<TabulationStudent>
          caption={`Results for ${tabulation.data?.section.nameEn ?? 'the selected section'}`}
          rows={tabulation.data?.students ?? []}
          rowKey={(row) => row.studentId}
          rowHref={(row) => `/results/${row.studentId}?examId=${examId}`}
          isLoading={tabulation.isLoading}
          isFetching={tabulation.isFetching}
          error={tabulation.error}
          empty={{
            title: 'No marks in this section',
            description:
              'Nobody in this section has a mark for this exam yet, so there is nothing to tabulate.',
          }}
          minWidth="52rem"
          columns={[
            {
              id: 'student',
              header: 'Student',
              card: 'title',
              render: (row) => (
                <BilingualName
                  row={{ fullNameEn: row.studentNameEn, fullNameBn: row.studentNameBn }}
                />
              ),
            },
            {
              id: 'roll',
              header: 'Roll',
              card: 'subtitle',
              className: 'tabular-nums text-content-muted',
              render: (row) => row.rollNumber ?? row.studentCode,
            },
            {
              id: 'papers',
              header: 'Papers',
              align: 'right',
              card: 'meta',
              className: 'tabular-nums text-content-muted',
              hideBelow: 'md',
              render: (row) => String(row.papers.length),
            },
            {
              id: 'marks',
              header: 'Marks',
              align: 'right',
              card: 'meta',
              className: 'tabular-nums',
              render: (row) =>
                row.result ? (
                  formatOutOf(row.result.obtainedMarks, row.result.totalMarks)
                ) : (
                  <span className="text-content-muted">Not computed</span>
                ),
            },
            {
              id: 'percentage',
              header: '%',
              align: 'right',
              card: 'meta',
              className: 'tabular-nums',
              hideBelow: 'md',
              render: (row) => (row.result ? formatPercent(row.result.percentage) : '—'),
            },
            {
              id: 'gpa',
              header: 'GPA',
              align: 'right',
              card: 'meta',
              className: 'tabular-nums font-medium',
              render: (row) => (row.result ? row.result.gpa : '—'),
            },
            {
              id: 'grade',
              header: 'Grade',
              card: 'aside',
              render: (row) =>
                row.result ? (
                  <Badge tone={row.result.isPassed ? 'success' : 'danger'}>
                    {row.result.grade}
                  </Badge>
                ) : (
                  <span className="text-content-muted">—</span>
                ),
            },
            {
              id: 'position',
              header: 'Position',
              align: 'right',
              card: 'meta',
              className: 'tabular-nums text-content-muted',
              hideBelow: 'lg',
              // `rank()` in SQL, so tied totals genuinely share a position.
              render: (row) =>
                row.result?.positionInSection ? `#${row.result.positionInSection}` : '—',
            },
            {
              id: 'published',
              header: 'Published',
              card: 'row',
              hideBelow: 'lg',
              className: 'text-content-muted',
              render: (row) =>
                row.result?.publishedAt ? formatInstant(row.result.publishedAt) : 'Not published',
            },
          ]}
        />
      )}
    </div>
  );
}

/** Pass rate and grade distribution, aggregated by the API in SQL. */
function ExamSummaryPanel({ institutionId, examId }: { institutionId: string; examId: string }) {
  const summary = useQuery({
    queryKey: ['exams', examId, 'summary', institutionId],
    queryFn: () => examsApi.summary(institutionId, examId),
  });

  if (summary.isError) return <ErrorNotice error={summary.error} />;
  if (summary.isLoading || !summary.data) return <LoadingBlock label="Loading the summary" />;

  const { totals, gradeDistribution } = summary.data;

  return (
    <div className="space-y-5">
      <StatGrid>
        <MetricCard label="Students" value={formatNumber(totals.students)} />
        <MetricCard
          label="Pass rate"
          value={formatPercent(totals.passRate)}
          detail={`${formatNumber(totals.passed)} passed · ${formatNumber(totals.failed)} failed`}
          tone={totals.failed === 0 ? 'success' : 'default'}
        />
        <MetricCard
          label="Average GPA"
          value={totals.averageGpa}
          detail={`Highest ${totals.highestGpa}`}
        />
        <MetricCard
          label="Average marks"
          value={formatPercent(totals.averagePercentage)}
          detail={`Highest ${formatMarks(totals.highestMarks)} · lowest ${formatMarks(totals.lowestMarks)}`}
        />
      </StatGrid>

      <Card>
        <CardHeader
          title="Grade distribution"
          description="Counted in SQL over the results this exam produced. The bar is that count as a share of the cohort — no smoothing, no estimate."
        />
        <CardBody padded>
          {gradeDistribution.length === 0 ? (
            <p className="text-sm text-content-muted">
              No results have been computed for this exam yet.
            </p>
          ) : (
            <table className="w-full text-sm">
              <caption className="sr-only">
                Students per grade for {summary.data.exam.nameEn}
              </caption>
              <thead className="text-left text-content-muted">
                <tr>
                  <th scope="col" className="py-1.5 font-medium">
                    Grade
                  </th>
                  <th scope="col" className="py-1.5 font-medium">
                    Share
                  </th>
                  <th scope="col" className="py-1.5 text-right font-medium">
                    Students
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {gradeDistribution.map((band) => (
                  <tr key={band.grade}>
                    <th scope="row" className="py-2 text-left font-medium">
                      {band.grade}
                    </th>
                    <td className="py-2 pr-4">
                      <div
                        className="h-2 w-full overflow-hidden rounded-full bg-surface-muted"
                        role="presentation"
                      >
                        <div
                          className="h-full rounded-full bg-accent-600"
                          style={{
                            // `formatRatioPercent` returns an em dash when the total is zero,
                            // which is right for text and not a CSS length. Guarded rather
                            // than "fixed" in the helper, which other screens rely on.
                            width:
                              totals.students > 0
                                ? formatRatioPercent(band.students, totals.students, 2)
                                : '0%',
                          }}
                        />
                      </div>
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {formatNumber(band.students)}
                      <span className="ml-2 text-content-muted">
                        {formatRatioPercent(band.students, totals.students)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

/**
 * A family's own results.
 *
 * `GET /exams/:id/results` under `results.view.own` returns published results for this
 * guardian's children (or this student), and nothing else — including nothing at all until the
 * school publishes. The names come from the session's own children list rather than from the
 * result rows, which carry only a student id.
 */
function FamilyResults({ institutionId, examId }: { institutionId: string; examId: string }) {
  const session = useSession();

  const children = useQuery({
    queryKey: ['guardians', 'my-children'],
    queryFn: () => api.myChildren(),
    enabled: Boolean(session.user?.guardianId),
  });

  const results = useQuery({
    queryKey: ['exams', examId, 'results', 'own', institutionId],
    queryFn: () => examsApi.results(institutionId, examId, { pageSize: 50 }),
  });

  const nameFor = (studentId: string): { fullNameEn: string; fullNameBn: string | null } => {
    const child = children.data?.find((row) => row.studentId === studentId);
    if (child) return { fullNameEn: child.fullNameEn, fullNameBn: child.fullNameBn };
    if (session.user?.studentId === studentId) {
      return { fullNameEn: session.user.fullNameEn, fullNameBn: null };
    }
    // The API returned a result we can read but whose name we have no source for. Saying so
    // beats printing an id, and the marksheet behind the link carries the full name.
    return { fullNameEn: 'Your result', fullNameBn: null };
  };

  return (
    <DataTable<ResultRow>
      caption="Your published results for this exam"
      rows={results.data?.data ?? []}
      rowKey={(row) => row.id}
      rowHref={(row) => `/results/${row.studentId}?examId=${examId}`}
      isLoading={results.isLoading}
      isFetching={results.isFetching}
      error={results.error}
      empty={{
        title: 'Nothing published yet',
        description:
          'Results appear here once the school publishes them. Until then there is nothing to show, not even a partial figure.',
      }}
      minWidth="38rem"
      columns={[
        {
          id: 'student',
          header: 'Student',
          card: 'title',
          render: (row) => <BilingualName row={nameFor(row.studentId)} />,
        },
        {
          id: 'marks',
          header: 'Marks',
          align: 'right',
          card: 'meta',
          className: 'tabular-nums',
          render: (row) => formatOutOf(row.obtainedMarks, row.totalMarks),
        },
        {
          id: 'percentage',
          header: '%',
          align: 'right',
          card: 'meta',
          className: 'tabular-nums',
          render: (row) => formatPercent(row.percentage),
        },
        {
          id: 'gpa',
          header: 'GPA',
          align: 'right',
          card: 'meta',
          className: 'tabular-nums font-medium',
          render: (row) => row.gpa,
        },
        {
          id: 'grade',
          header: 'Grade',
          card: 'aside',
          render: (row) => <Badge tone={row.isPassed ? 'success' : 'danger'}>{row.grade}</Badge>,
        },
      ]}
    />
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const session = useSession();
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Results"
        description="Grades, GPA and positions exactly as the school published them."
        actions={
          // Publication is its own permission and its own screen: "these marks are correct" and
          // "families may now read them" are different decisions, and the API keeps them apart.
          session.canAny('results.publish', 'results.unpublish') ? (
            <Button href="/results/publish">Publish or retract</Button>
          ) : null
        }
      />
      {children}
    </div>
  );
}
