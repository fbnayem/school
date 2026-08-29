'use client';

/**
 * The reviewer's screen.
 *
 * This is where the separation of duties becomes visible. Three distinct acts live here and
 * each is a different permission on the API:
 *
 *   `results.review`  moves a whole exam from mark entry into review, and is refused while any
 *                     paper still holds draft marks.
 *   `results.approve` signs marks off — and is refused by the API when the approver is the
 *                     person who entered them, whatever the roles happen to say.
 *   `exams.manage`    sends the exam back to mark entry when something is wrong.
 *
 * Publishing is deliberately not here. It is a separate permission and a separate screen
 * (`/results/publish`), because "these marks are correct" and "families may now read them"
 * are different decisions.
 */

import { use, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/lib/session';
import { academicApi } from '@/components/academic/api';
import { examsApi, type ExamMarkRow, type MarkEntryStatus } from '@/components/exams/api';
import {
  ExamStatusBadge,
  MarkStatusBadge,
  formatMarks,
  formatOutOf,
  paperOptions,
} from '@/components/exams/shared';
import {
  BilingualName,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  DataTable,
  Dialog,
  EmptyState,
  ErrorNotice,
  LoadingBlock,
  PageHeader,
  Select,
  Textarea,
  toOptions,
  useConfirm,
  useToast,
} from '@/components/ui';
import { CorrectMarkDialog } from '@/components/exams/correct-mark-dialog';
import { formatInstant } from '@/lib/format';

const MARK_STATUS_FILTER = [
  { value: 'draft', label: 'Draft' },
  { value: 'submitted', label: 'Submitted' },
  { value: 'approved', label: 'Approved' },
];

export default function ExamReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: examId } = use(params);
  const session = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [examSubjectId, setExamSubjectId] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [status, setStatus] = useState<MarkEntryStatus | ''>('submitted');
  const [movingToReview, setMovingToReview] = useState(false);
  const [reviewNote, setReviewNote] = useState('');
  const [approving, setApproving] = useState<'paper' | 'exam' | null>(null);
  const [sendingBack, setSendingBack] = useState(false);

  const institutionId = session.institutionId;
  const canRead = session.canAny('results.view.all', 'results.view.assigned');
  const canReview = session.can('results.review');
  const canApprove = session.can('results.approve');
  const canCorrect = session.can('results.correct');
  const canManageExam = session.can('exams.manage');
  const correcting = useConfirm<ExamMarkRow>();

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

  const eligibleSections = (sections.data ?? []).filter(
    (section) => !paper || section.classLevelId === paper.examSubject.classLevelId,
  );

  const marks = useQuery({
    queryKey: ['exams', examId, 'marks', { examSubjectId, sectionId, status, institutionId }],
    queryFn: () =>
      examsApi.marks(institutionId!, examId, {
        examSubjectId,
        sectionId: sectionId || undefined,
        status: status || undefined,
      }),
    // A paper is required before anything is fetched: an exam-wide mark list is students ×
    // papers rows in one unpaginated response, which is a request nobody should be able to
    // make by accident.
    enabled: Boolean(institutionId) && Boolean(examSubjectId) && canRead,
  });

  // Prefix invalidation: the exam detail, its marks and the exam lists all live under `exams`,
  // and every one of them can be stale after a workflow move.
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['exams'] });
  };

  const moveToReview = useMutation({
    mutationFn: () =>
      examsApi.review(institutionId!, examId, reviewNote.trim() ? { note: reviewNote.trim() } : {}),
    onSuccess: (result) => {
      setMovingToReview(false);
      setReviewNote('');
      toast.success(
        'Exam moved to review',
        `${result.reviewed} submitted mark${result.reviewed === 1 ? '' : 's'} are now with the reviewer.`,
      );
      invalidate();
    },
    onError: (error) => toast.error(error),
  });

  const approve = useMutation({
    mutationFn: (scope: 'paper' | 'exam') =>
      examsApi.approve(institutionId!, examId, scope === 'paper' ? { examSubjectId } : {}),
    onSuccess: (result) => {
      setApproving(null);
      toast.success(
        `${result.approved} mark${result.approved === 1 ? '' : 's'} approved`,
        'They can now be published as results.',
      );
      invalidate();
    },
  });

  const sendBack = useMutation({
    mutationFn: (reason: string) =>
      examsApi.changeStatus(institutionId!, examId, { status: 'marks_entry', reason }),
    onSuccess: () => {
      setSendingBack(false);
      toast.success('Sent back to mark entry', 'Teachers can edit and resubmit their papers.');
      invalidate();
    },
  });

  if (!institutionId) {
    return (
      <Shell examId={examId} examName={null}>
        <EmptyState
          title="Choose an institution first"
          description="An exam belongs to one institution, so this screen needs to know which school you are working in."
        />
      </Shell>
    );
  }

  if (!canRead) {
    return (
      <Shell examId={examId} examName={null}>
        <EmptyState
          title="Mark review is not available to you"
          description="Reading submitted marks needs results.view.all or results.view.assigned."
        />
      </Shell>
    );
  }

  if (exam.isError) {
    return (
      <Shell examId={examId} examName={null}>
        <ErrorNotice error={exam.error} />
      </Shell>
    );
  }

  if (exam.isLoading || !exam.data) {
    return (
      <Shell examId={examId} examName={null}>
        <LoadingBlock label="Loading exam" />
      </Shell>
    );
  }

  const examData = exam.data;
  const rows = marks.data ?? [];

  return (
    <Shell
      examId={examId}
      examName={examData.nameEn}
      examNameBn={examData.nameBn}
      status={<ExamStatusBadge status={examData.status} />}
    >
      <Card className="mb-4">
        <CardHeader
          title="Where this exam stands"
          description={
            examData.status === 'marks_entry'
              ? 'Teachers are still entering and submitting papers. The exam moves to review once every mark has been submitted.'
              : examData.status === 'under_review'
                ? 'Marks are with the reviewer. Approve them, or send the exam back so a paper can be corrected.'
                : examData.status === 'published'
                  ? 'Results are published. Retracting them is done on the publish screen and needs its own permission.'
                  : 'Marks are entered only while the exam is in mark entry.'
          }
          actions={
            <div className="flex flex-wrap gap-2">
              {/* Each control is rendered only where both the permission and the workflow state
                  allow it. The API re-checks both; this keeps the screen honest about what is
                  actually possible right now. */}
              {canReview && examData.status === 'marks_entry' ? (
                <Button variant="primary" onClick={() => setMovingToReview(true)}>
                  Move to review
                </Button>
              ) : null}
              {canApprove && examData.status === 'under_review' ? (
                <Button variant="primary" onClick={() => setApproving('exam')}>
                  Approve all submitted marks
                </Button>
              ) : null}
              {canManageExam && examData.status === 'under_review' ? (
                <Button variant="danger" onClick={() => setSendingBack(true)}>
                  Send back to mark entry
                </Button>
              ) : null}
            </div>
          }
        />
      </Card>

      <Card className="mb-4">
        <CardHeader
          title="Marks"
          description="Choose a paper to load its marks. Filter by section or by where each mark sits in the lifecycle."
        />
        <CardBody padded>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label htmlFor="review-paper" className="label">
                Paper
              </label>
              <Select
                id="review-paper"
                value={examSubjectId}
                onChange={(event) => {
                  setExamSubjectId(event.target.value);
                  setSectionId('');
                }}
                options={paperOptions(papers.data ?? [])}
                placeholder={
                  papers.isLoading
                    ? 'Loading papers…'
                    : (papers.data?.length ?? 0) === 0
                      ? 'No papers configured'
                      : 'Choose a paper'
                }
                allowEmpty
                disabled={papers.isLoading || (papers.data?.length ?? 0) === 0}
              />
            </div>
            <div>
              <label htmlFor="review-section" className="label">
                Section
              </label>
              <Select
                id="review-section"
                value={sectionId}
                onChange={(event) => setSectionId(event.target.value)}
                options={toOptions(eligibleSections, (section) => ({
                  value: section.id,
                  label: `${section.classLevelName} · ${section.nameEn}`,
                }))}
                placeholder={paper ? 'All sections' : 'Choose a paper first'}
                allowEmpty
                disabled={!paper}
              />
            </div>
            <div>
              <label htmlFor="review-status" className="label">
                Mark state
              </label>
              <Select
                id="review-status"
                value={status}
                onChange={(event) => setStatus(event.target.value as MarkEntryStatus | '')}
                options={MARK_STATUS_FILTER}
                placeholder="Any state"
                allowEmpty
              />
            </div>
          </div>

          {/* No count on this button on purpose. `approveExamMarksSchema` takes a paper, not a
              section, so approving acts on every submitted mark of the paper — including the
              sections the section filter is currently hiding. A number taken from the filtered
              rows would understate what the click does. */}
          {canApprove && examData.status === 'under_review' && paper ? (
            <div className="mt-4 flex justify-end">
              <Button variant="primary" onClick={() => setApproving('paper')}>
                Approve submitted marks on this paper
              </Button>
            </div>
          ) : null}
        </CardBody>
      </Card>

      {!examSubjectId ? (
        <EmptyState
          title="Choose a paper"
          description="Marks load one paper at a time, so a whole exam is never pulled into the browser at once."
        />
      ) : (
        <DataTable<ExamMarkRow>
          caption={`Marks for ${paper ? paper.subjectNameEn : 'the selected paper'}`}
          rows={rows}
          rowKey={(row) => row.mark.id}
          // Correction is offered only for a mark that has actually been approved — a draft or
          // a submitted one is still editable through ordinary mark entry, and the API refuses
          // this endpoint for either. Gated on `results.correct`, which the API re-checks.
          actions={
            canCorrect && paper
              ? (row) =>
                  row.mark.status === 'approved' ? (
                    <Button size="sm" onClick={() => correcting.ask(row)}>
                      Correct
                    </Button>
                  ) : null
              : undefined
          }
          isLoading={marks.isLoading}
          isFetching={marks.isFetching}
          error={marks.error}
          empty={{
            title: 'No marks here',
            description: status
              ? `No marks for this paper are ${status}. Try another state, or another section.`
              : 'No marks have been entered against this paper yet.',
          }}
          minWidth="44rem"
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
              id: 'obtained',
              header: 'Obtained',
              align: 'right',
              card: 'meta',
              className: 'tabular-nums',
              render: (row) =>
                row.mark.isAbsent ? 'Absent' : formatOutOf(row.mark.obtainedMarks, row.fullMarks),
            },
            {
              id: 'pass',
              header: 'Pass mark',
              align: 'right',
              card: 'meta',
              hideBelow: 'md',
              className: 'tabular-nums text-content-muted',
              render: (row) => formatMarks(row.passMarks),
            },
            {
              id: 'submitted',
              header: 'Submitted',
              card: 'meta',
              hideBelow: 'lg',
              className: 'text-content-muted',
              render: (row) =>
                row.mark.submittedAt ? formatInstant(row.mark.submittedAt) : 'Not submitted',
            },
            {
              id: 'status',
              header: 'State',
              card: 'aside',
              render: (row) => <MarkStatusBadge status={row.mark.status} />,
            },
          ]}
        />
      )}

      {/* Move to review — a note is optional on the API (`reviewExamSchema`), so it is offered
          as optional here. Fabricating one to fill a required box would put a fiction in the
          audit trail. */}
      <Dialog
        open={movingToReview}
        onClose={() => setMovingToReview(false)}
        title="Move this exam to review?"
        description="Every paper must already be submitted. The API refuses this while any mark is still a draft, and tells you how many."
        size="sm"
        closeOnBackdropClick={false}
        footer={
          <>
            <Button onClick={() => setMovingToReview(false)} disabled={moveToReview.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={moveToReview.isPending}
              loadingLabel="Moving…"
              onClick={() => moveToReview.mutate()}
            >
              Move to review
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          <label htmlFor="review-note" className="label">
            Note <span className="text-content-muted">(optional)</span>
          </label>
          <Textarea
            id="review-note"
            value={reviewNote}
            onChange={(event) => setReviewNote(event.target.value)}
            maxLength={1000}
            placeholder="Anything the approver should know."
          />
          {moveToReview.error ? <ErrorNotice error={moveToReview.error} /> : null}
        </div>
      </Dialog>

      <ConfirmDialog
        open={approving !== null}
        onClose={() => setApproving(null)}
        title={approving === 'exam' ? 'Approve every submitted mark?' : 'Approve this paper?'}
        confirmLabel="Approve"
        variant="primary"
        body={
          <>
            {approving === 'paper'
              ? 'Every submitted mark on this paper is approved, in every section — the section filter above does not narrow it. '
              : 'Every submitted mark in this exam is approved. '}
            Approving is a sign-off: after it, a mark can only be changed through a recorded
            correction with a reason. The API refuses to let you approve marks you entered yourself,
            so if that is the case here it will say so and nothing will change.
          </>
        }
        // `approveExamMarksSchema` takes no reason, so none is collected.
        onConfirm={async () => {
          await approve.mutateAsync(approving ?? 'exam');
        }}
      />

      <ConfirmDialog
        open={sendingBack}
        onClose={() => setSendingBack(false)}
        title="Send this exam back to mark entry?"
        confirmLabel="Send back"
        variant="danger"
        requireReason
        reasonLabel="Why is this going back?"
        reasonHint="Recorded in the audit log against your name, and it is what the teachers will be asked about. At least 10 characters."
        body={
          <>
            Teachers will be able to edit and resubmit their papers, and every submitted mark will
            have to be approved again.
          </>
        }
        onConfirm={async (reason) => {
          await sendBack.mutateAsync(reason);
        }}
      />

      {/* Keyed on the mark id so the form is rebuilt for each row — a shared instance would
          show the previous student's marks against the next one and then save them onto it. */}
      {canCorrect && paper && correcting.target ? (
        <CorrectMarkDialog
          key={correcting.target.mark.id}
          open={correcting.isOpen}
          onClose={correcting.close}
          row={correcting.target}
          paper={paper}
          examId={examId}
        />
      ) : null}
    </Shell>
  );
}

function Shell({
  examId,
  examName,
  examNameBn,
  status,
  children,
}: {
  examId: string;
  examName: string | null;
  examNameBn?: string | null;
  status?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={examName ? `${examName} · Review` : 'Review'}
        titleBn={examNameBn ?? null}
        breadcrumbs={[
          { label: 'Examinations', href: '/exams' },
          ...(examName ? [{ label: examName, href: `/exams/${examId}` }] : []),
          { label: 'Review' },
        ]}
        meta={status}
        description="Submitted marks, and the sign-off that turns them into publishable results."
      />
      {children}
    </div>
  );
}
