'use client';

/**
 * Publishing and retracting a result set.
 *
 * Its own screen because it is its own decision. Approving marks says "these numbers are
 * right"; publishing says "families may now read them", and the API gives each its own
 * permission (`results.approve`, `results.publish`) precisely so one person holding the first
 * cannot perform the second.
 *
 * Publication is a single transaction over the whole exam — totals, percentage, GPA, grade and
 * positions for every student — because positions are relative: publishing a section at a time
 * would rank students against a partial cohort and then silently change those ranks as the
 * rest arrived.
 *
 * Retraction keeps the computed results and clears only their publication. Deleting them would
 * destroy the evidence of what families were shown, which is the one thing a dispute needs.
 */

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/lib/session';
import { examsApi } from '@/components/exams/api';
import { ExamPicker, ExamStatusBadge, formatMarks } from '@/components/exams/shared';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  DescriptionList,
  Dialog,
  EmptyState,
  ErrorNotice,
  LoadingBlock,
  MetricCard,
  PageHeader,
  StatGrid,
  Textarea,
  formatPercent,
  toOptions,
  useToast,
} from '@/components/ui';
import { formatInstant, formatNumber, humanize } from '@/lib/format';

export default function PublishResultsPage() {
  return (
    <Suspense fallback={<LoadingBlock label="Loading" />}>
      <PublishResults />
    </Suspense>
  );
}

function PublishResults() {
  const session = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();

  // Seeded from `?examId=` once, then owned by the picker. Reading the URL on every render
  // instead would make clearing the picker silently snap back to the linked exam.
  const [examId, setExamId] = useState(() => searchParams.get('examId') ?? '');
  const [publishing, setPublishing] = useState(false);
  const [publishNote, setPublishNote] = useState('');
  const [retracting, setRetracting] = useState(false);
  const institutionId = session.institutionId;
  const canPublish = session.can('results.publish');
  const canUnpublish = session.can('results.unpublish');
  const canReport = session.canAny('results.reports.view', 'results.view.all');

  const exams = useQuery({
    queryKey: ['exams', 'publishable', institutionId],
    queryFn: () => examsApi.list(institutionId!, { pageSize: 100, sort: '-startDate' }),
    enabled: Boolean(institutionId) && session.can('exams.view'),
  });

  const exam = useQuery({
    queryKey: ['exams', examId, 'detail', institutionId],
    queryFn: () => examsApi.get(institutionId!, examId),
    enabled: Boolean(institutionId) && Boolean(examId) && session.can('exams.view'),
  });

  const summary = useQuery({
    queryKey: ['exams', examId, 'summary', institutionId],
    queryFn: () => examsApi.summary(institutionId!, examId),
    // Only meaningful once results exist, and only readable with the reporting permission.
    enabled:
      Boolean(institutionId) &&
      Boolean(examId) &&
      canReport &&
      (exam.data?.status === 'published' || Boolean(exam.data?.resultsPublishedAt)),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['exams'] });
  };

  const publish = useMutation({
    mutationFn: () =>
      examsApi.publish(
        institutionId!,
        examId,
        publishNote.trim() ? { note: publishNote.trim() } : {},
      ),
    onSuccess: (result) => {
      setPublishing(false);
      setPublishNote('');
      toast.success(
        'Results published',
        `${formatNumber(result.published)} student result${result.published === 1 ? '' : 's'} are now visible to families.`,
      );
      invalidate();
    },
  });

  const unpublish = useMutation({
    mutationFn: (reason: string) => examsApi.unpublish(institutionId!, examId, reason),
    onSuccess: (result) => {
      setRetracting(false);
      toast.success(
        'Results retracted',
        `${formatNumber(result.retracted)} result${result.retracted === 1 ? '' : 's'} are no longer visible. The computed figures have been kept.`,
      );
      invalidate();
    },
  });

  if (!institutionId) {
    return (
      <Shell>
        <EmptyState
          title="Choose an institution first"
          description="Results are published one institution's exam at a time."
        />
      </Shell>
    );
  }

  if (!canPublish && !canUnpublish) {
    return (
      <Shell>
        <EmptyState
          title="Publishing is not available to you"
          description="Publishing needs results.publish and retracting needs results.unpublish. Both are deliberately separate from approving marks."
        />
      </Shell>
    );
  }

  const data = exam.data;

  return (
    <Shell>
      <Card className="mb-5">
        <CardHeader
          title="Choose an exam"
          description="An exam can be published once every one of its marks has been approved. The API refuses otherwise and says how many are outstanding."
        />
        <CardBody padded>
          <ExamPicker
            id="publish-exam"
            label="Exam"
            value={examId}
            onChange={setExamId}
            options={toOptions(exams.data?.data ?? [], (row) => ({
              value: row.id,
              label: `${row.nameEn} (${row.code})`,
              hint: humanize(row.status),
            }))}
            isLoading={exams.isLoading}
            emptyHint="No exams yet"
          />
          {exams.isError ? <ErrorNotice error={exams.error} /> : null}
        </CardBody>
      </Card>

      {!examId ? (
        <EmptyState
          title="Pick an exam"
          description="Its state decides what can be done: an exam under review can be published, a published one can be retracted."
        />
      ) : exam.isError ? (
        <ErrorNotice error={exam.error} />
      ) : exam.isLoading || !data ? (
        <LoadingBlock label="Loading exam" />
      ) : (
        <>
          <Card className="mb-5">
            <CardHeader
              title={data.nameEn}
              description={
                data.status === 'under_review'
                  ? 'Marks are approved and under review. Publishing computes every student’s result in one transaction and makes it visible to families.'
                  : data.status === 'published'
                    ? 'Results are live. Retracting withdraws them from families; the computed figures are kept as the record of what was shown.'
                    : `This exam is ${humanize(data.status).toLowerCase()}. Results are published from under review only — approve the marks first.`
              }
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  <ExamStatusBadge status={data.status} />
                  {/* Rendered only where the permission and the workflow state both allow it.
                      The API re-checks both on every request. */}
                  {canPublish && data.status === 'under_review' ? (
                    <Button variant="primary" onClick={() => setPublishing(true)}>
                      Publish results
                    </Button>
                  ) : null}
                  {canUnpublish && data.status === 'published' ? (
                    <Button variant="danger" onClick={() => setRetracting(true)}>
                      Retract results
                    </Button>
                  ) : null}
                </div>
              }
            />
            <CardBody padded>
              <DescriptionList
                columns={3}
                items={[
                  { label: 'Code', value: data.code },
                  { label: 'Type', value: humanize(data.type) },
                  { label: 'Papers configured', value: String(data.subjectCount) },
                  {
                    label: 'Grading scale',
                    value: data.gradingScale?.nameEn ?? null,
                    emptyText: 'Not resolved',
                  },
                  {
                    label: 'Published',
                    value: data.resultsPublishedAt ? formatInstant(data.resultsPublishedAt) : null,
                    emptyText: 'Not published',
                  },
                ]}
              />
            </CardBody>
          </Card>

          {summary.data ? (
            <Card>
              <CardHeader
                title="What was published"
                description="Aggregated by the API over the results this exam produced."
              />
              <CardBody padded>
                <StatGrid>
                  <MetricCard label="Students" value={formatNumber(summary.data.totals.students)} />
                  <MetricCard
                    label="Pass rate"
                    value={formatPercent(summary.data.totals.passRate)}
                    detail={`${formatNumber(summary.data.totals.passed)} passed · ${formatNumber(summary.data.totals.failed)} failed`}
                  />
                  <MetricCard
                    label="Average GPA"
                    value={summary.data.totals.averageGpa}
                    detail={`Highest ${summary.data.totals.highestGpa}`}
                  />
                  <MetricCard
                    label="Highest marks"
                    value={formatMarks(summary.data.totals.highestMarks)}
                    detail={`Lowest ${formatMarks(summary.data.totals.lowestMarks)}`}
                  />
                </StatGrid>
              </CardBody>
            </Card>
          ) : summary.isError ? (
            <ErrorNotice error={summary.error} />
          ) : null}
        </>
      )}

      {/* Publishing: a note is optional on the API (`publishExamResultsSchema`), so it is
          offered as optional. There is nothing here that could manufacture one. */}
      <Dialog
        open={publishing}
        onClose={() => setPublishing(false)}
        title="Publish these results?"
        description="Every student's total, percentage, GPA, grade and position is computed and becomes visible to their family. Positions are ranked across the whole exam, so this is all-or-nothing by design."
        size="sm"
        closeOnBackdropClick={false}
        footer={
          <>
            <Button onClick={() => setPublishing(false)} disabled={publish.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={publish.isPending}
              loadingLabel="Publishing…"
              onClick={() => publish.mutate()}
            >
              Publish results
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          <label htmlFor="publish-note" className="label">
            Note <span className="text-content-muted">(optional)</span>
          </label>
          <Textarea
            id="publish-note"
            value={publishNote}
            onChange={(event) => setPublishNote(event.target.value)}
            maxLength={1000}
            placeholder="Recorded in the audit trail — useful when the timing is unusual."
          />
          {publish.error ? <ErrorNotice error={publish.error} /> : null}
        </div>
      </Dialog>

      <ConfirmDialog
        open={retracting}
        onClose={() => setRetracting(false)}
        title="Retract these results?"
        confirmLabel="Retract"
        variant="danger"
        requireReason
        reasonLabel="Why are these results being withdrawn?"
        reasonHint="Families have already read these. The reason is recorded against your name in the audit log and is what a parent's question will be answered with. At least 10 characters."
        body={
          <>
            The computed results are kept and only their publication is withdrawn — deleting them
            would destroy the record of what families were shown. The exam returns to review so the
            marks can be corrected and published again.
          </>
        }
        onConfirm={async (reason) => {
          await unpublish.mutateAsync(reason);
        }}
      />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Publish results"
        breadcrumbs={[{ label: 'Results', href: '/results' }, { label: 'Publish' }]}
        description="Making a result set visible to families, and withdrawing it when something is wrong."
      />
      {children}
    </div>
  );
}
