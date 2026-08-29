'use client';

/**
 * Mark entry for one exam.
 *
 * A paper is a (class level, subject) pair and marks are entered a section at a time, so both
 * pickers are required before anything is fetched. Guessing either would show a teacher a
 * register that is not theirs.
 */

import { use, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/lib/session';
import { academicApi } from '@/components/academic/api';
import { examsApi } from '@/components/exams/api';
import { MarksGrid } from '@/components/exams/marks-grid';
import { ExamStatusBadge, formatMarks, paperOptions } from '@/components/exams/shared';
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorNotice,
  LoadingBlock,
  PageHeader,
  Select,
  toOptions,
} from '@/components/ui';

export default function MarkEntryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: examId } = use(params);
  const session = useSession();

  const [examSubjectId, setExamSubjectId] = useState('');
  const [sectionId, setSectionId] = useState('');

  const institutionId = session.institutionId;
  // Raw marks are readable with either result scope; `results.view.own` is deliberately not
  // accepted by the API here, because a family sees a published result and not the mark sheet
  // it was computed from. The API re-checks all of this — hiding the screen is a usability
  // decision, not the security boundary.
  const canRead = session.canAny('results.view.all', 'results.view.assigned');
  const canEnter = session.can('results.enter_marks');
  const canSubmit = session.can('results.submit_marks');

  const exam = useQuery({
    queryKey: ['exams', examId, 'detail', institutionId],
    queryFn: () => examsApi.get(institutionId!, examId),
    enabled: Boolean(institutionId) && session.can('exams.view'),
  });

  const papers = useQuery({
    queryKey: ['exams', examId, 'subjects', institutionId],
    queryFn: () => examsApi.subjects(institutionId!, examId),
    enabled: Boolean(institutionId) && session.can('exams.view'),
  });

  const paper = papers.data?.find((row) => row.examSubject.id === examSubjectId);

  const sections = useQuery({
    queryKey: ['academic', 'sections', institutionId, exam.data?.academicYearId],
    queryFn: () => academicApi.sections(institutionId!, exam.data!.academicYearId),
    enabled: Boolean(institutionId) && Boolean(exam.data) && session.can('academic.sections.view'),
  });

  // A section belongs to exactly one class level, so the choice is narrowed to the paper's.
  // Offering the whole school's sections would let a teacher pick one that cannot sit this
  // paper and get a 404 they cannot interpret.
  // Memoised because it is a dependency of the effect below; a fresh array every render would
  // re-run that effect on every render for no reason.
  const eligibleSections = useMemo(
    () =>
      (sections.data ?? []).filter(
        (section) => !paper || section.classLevelId === paper.examSubject.classLevelId,
      ),
    [sections.data, paper],
  );

  // Changing the paper can invalidate the chosen section.
  useEffect(() => {
    if (sectionId && !eligibleSections.some((section) => section.id === sectionId)) {
      setSectionId('');
    }
  }, [sectionId, eligibleSections]);

  const roster = useQuery({
    queryKey: ['exams', 'roster', institutionId, sectionId],
    queryFn: () => examsApi.sectionRoster(institutionId!, sectionId),
    enabled: Boolean(institutionId) && Boolean(sectionId),
  });

  const marks = useQuery({
    queryKey: ['exams', examId, 'marks', { examSubjectId, sectionId, institutionId }],
    queryFn: () => examsApi.marks(institutionId!, examId, { examSubjectId, sectionId }),
    enabled: Boolean(institutionId) && Boolean(examSubjectId) && Boolean(sectionId) && canRead,
    // The grid holds unsaved edits. A refocus refetch would reseed them out of existence, so
    // this query refreshes only when a mutation invalidates it.
    refetchOnWindowFocus: false,
  });

  if (!institutionId) {
    return (
      <Shell examName={null}>
        <EmptyState
          title="Choose an institution first"
          description="Marks belong to one institution's exam, so this screen needs to know which school you are working in."
        />
      </Shell>
    );
  }

  if (!canRead) {
    return (
      <Shell examName={null}>
        <EmptyState
          title="Mark entry is not available to you"
          description="Reading a mark sheet needs results.view.all or results.view.assigned. Published results are on the results screens instead."
        />
      </Shell>
    );
  }

  if (exam.isError) {
    return (
      <Shell examName={null}>
        <ErrorNotice error={exam.error} />
      </Shell>
    );
  }

  if (exam.isLoading || !exam.data) {
    return (
      <Shell examName={null}>
        <LoadingBlock label="Loading exam" />
      </Shell>
    );
  }

  return (
    <Shell
      examName={exam.data.nameEn}
      examNameBn={exam.data.nameBn}
      examId={examId}
      status={<ExamStatusBadge status={exam.data.status} />}
    >
      <Card className="mb-4">
        <CardHeader
          title="Choose a paper and a section"
          description="Marks are entered one paper at a time, for the students enrolled in one section."
        />
        <CardBody padded>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="paper" className="label">
                Paper
              </label>
              <Select
                id="paper"
                value={examSubjectId}
                onChange={(event) => setExamSubjectId(event.target.value)}
                options={paperOptions(papers.data ?? [])}
                placeholder={
                  papers.isLoading
                    ? 'Loading papers…'
                    : (papers.data?.length ?? 0) === 0
                      ? 'No papers configured for this exam'
                      : 'Choose a paper'
                }
                allowEmpty
                disabled={papers.isLoading || (papers.data?.length ?? 0) === 0}
              />
              {paper ? (
                <p className="mt-1 text-xs text-content-muted">
                  Full marks {formatMarks(paper.examSubject.fullMarks)} · pass marks{' '}
                  {formatMarks(paper.examSubject.passMarks)}
                  {paper.examSubject.isOptional ? ' · optional paper' : ''}
                </p>
              ) : null}
            </div>
            <div>
              <label htmlFor="section" className="label">
                Section
              </label>
              <Select
                id="section"
                value={sectionId}
                onChange={(event) => setSectionId(event.target.value)}
                options={toOptions(eligibleSections, (section) => ({
                  value: section.id,
                  label: `${section.classLevelName} · ${section.nameEn}`,
                  hint: `${section.enrolledCount} enrolled`,
                }))}
                placeholder={
                  !paper
                    ? 'Choose a paper first'
                    : sections.isLoading
                      ? 'Loading sections…'
                      : eligibleSections.length === 0
                        ? 'No sections for this class level'
                        : 'Choose a section'
                }
                allowEmpty
                disabled={!paper || sections.isLoading || eligibleSections.length === 0}
              />
            </div>
          </div>
          {papers.isError ? <ErrorNotice error={papers.error} /> : null}
          {sections.isError ? <ErrorNotice error={sections.error} /> : null}
        </CardBody>
      </Card>

      {!paper || !sectionId ? (
        <EmptyState
          title="Pick a paper and a section"
          description="The register loads once both are chosen. Nothing is fetched before then."
        />
      ) : roster.isError ? (
        <ErrorNotice error={roster.error} />
      ) : marks.isError ? (
        <ErrorNotice error={marks.error} />
      ) : roster.isLoading || marks.isLoading ? (
        <LoadingBlock label="Loading the register" />
      ) : (
        <MarksGrid
          exam={exam.data}
          paper={paper}
          sectionId={sectionId}
          roster={roster.data?.data ?? []}
          rosterTotal={roster.data?.meta.total ?? 0}
          marks={marks.data ?? []}
          marksVersion={marks.dataUpdatedAt}
          canEnter={canEnter}
          canSubmit={canSubmit}
        />
      )}
    </Shell>
  );
}

function Shell({
  examName,
  examNameBn,
  examId,
  status,
  children,
}: {
  examName: string | null;
  examNameBn?: string | null;
  examId?: string;
  status?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={examName ? `${examName} · Mark entry` : 'Mark entry'}
        titleBn={examNameBn ?? null}
        breadcrumbs={[
          { label: 'Examinations', href: '/exams' },
          ...(examId && examName ? [{ label: examName, href: `/exams/${examId}` }] : []),
          { label: 'Mark entry' },
        ]}
        meta={status}
        description="Enter, then submit. A submitted mark is locked to you until it is reviewed."
      />
      {children}
    </div>
  );
}
