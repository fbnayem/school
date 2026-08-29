'use client';

/**
 * One exam: what it is, what its papers are worth, and when each paper is sat.
 *
 * The screen is also the junction for the rest of the lifecycle — mark entry, review and
 * publication each live behind their own permission and their own route, and the links to
 * them appear only where the user could actually use them.
 */

import { use, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { createExamScheduleSchema } from '@shikkha/validation';
import { useSession } from '@/lib/session';
import { academicApi } from '@/components/academic/api';
import {
  examsApi,
  type ExamScheduleRow,
  type ExamStatus,
  type ExamSubjectRow,
} from '@/components/exams/api';
import {
  EXAM_MANAGEABLE_STATUS_OPTIONS,
  ExamStatusBadge,
  formatMarks,
  paperComponents,
  paperOptions,
} from '@/components/exams/shared';
import {
  Badge,
  BilingualName,
  Button,
  Card,
  CardBody,
  ConfirmDialog,
  DataTable,
  DateField,
  DescriptionList,
  Dialog,
  EmptyState,
  ErrorNotice,
  Form,
  FormActions,
  LoadingBlock,
  PageHeader,
  Select,
  SelectField,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  TextAreaField,
  TimeField,
  toOptions,
  useToast,
} from '@/components/ui';
import {
  formatDateRange,
  formatInstant,
  formatLongDate,
  formatTimeRange,
  humanize,
} from '@/lib/format';

/**
 * The exam status moves `exams.manage` may make, mirrored from
 * `ExamsService.EXAM_STATUS_TRANSITIONS`.
 *
 * Mirrored rather than derived because the API does not expose the table, and offering a move
 * it will refuse is a worse experience than not offering it. The API remains the authority: it
 * re-checks every transition, so a drift here costs a clear error message, not a bad write.
 * `under_review` and `published` never appear — they are reached through `results.review` and
 * `results.publish`, which is the whole point of the split.
 */
const MANAGEABLE_TRANSITIONS: Record<ExamStatus, string[]> = {
  draft: ['scheduled', 'archived'],
  scheduled: ['draft', 'ongoing', 'archived'],
  ongoing: ['scheduled', 'marks_entry', 'archived'],
  marks_entry: ['ongoing', 'archived'],
  under_review: ['marks_entry'],
  published: [],
  archived: [],
};

export default function ExamDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: examId } = use(params);
  const session = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [tab, setTab] = useState('papers');
  const [scheduling, setScheduling] = useState(false);
  const [changingStatus, setChangingStatus] = useState(false);
  const [nextStatus, setNextStatus] = useState('');
  const [archiving, setArchiving] = useState(false);

  const institutionId = session.institutionId;
  const canView = session.can('exams.view');
  const canManage = session.can('exams.manage');
  const canSchedule = session.can('exams.schedule.manage');

  const exam = useQuery({
    queryKey: ['exams', examId, 'detail', institutionId],
    queryFn: () => examsApi.get(institutionId!, examId),
    enabled: Boolean(institutionId) && canView,
  });

  const papers = useQuery({
    queryKey: ['exams', examId, 'subjects', institutionId],
    queryFn: () => examsApi.subjects(institutionId!, examId),
    enabled: Boolean(institutionId) && canView,
  });

  const schedules = useQuery({
    queryKey: ['exams', examId, 'schedules', institutionId],
    queryFn: () => examsApi.schedules(institutionId!, examId),
    enabled: Boolean(institutionId) && canView && tab === 'schedule',
  });

  const years = useQuery({
    queryKey: ['academic', 'years', institutionId],
    queryFn: () => academicApi.years(institutionId!),
    enabled: Boolean(institutionId) && session.can('academic.years.view'),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['exams'] });
  };

  const changeStatus = useMutation({
    mutationFn: (status: string) =>
      examsApi.changeStatus(institutionId!, examId, {
        status: status as 'draft' | 'scheduled' | 'ongoing' | 'marks_entry' | 'archived',
      }),
    onSuccess: (updated) => {
      setChangingStatus(false);
      setNextStatus('');
      toast.success(
        'Status changed',
        `This exam is now ${humanize(updated.status).toLowerCase()}.`,
      );
      invalidate();
    },
    onError: (error) => toast.error(error),
  });

  const archive = useMutation({
    mutationFn: (reason: string) => examsApi.archive(institutionId!, examId, reason),
    onSuccess: () => {
      setArchiving(false);
      toast.success('Exam archived');
      invalidate();
    },
  });

  if (!institutionId) {
    return (
      <Shell>
        <EmptyState
          title="Choose an institution first"
          description="An exam belongs to one institution, so this screen needs to know which school you are working in."
        />
      </Shell>
    );
  }

  if (!canView) {
    return (
      <Shell>
        <EmptyState
          title="Examinations are not available to you"
          description="Viewing an exam needs the exams.view permission."
        />
      </Shell>
    );
  }

  if (exam.isError) {
    return (
      <Shell>
        <ErrorNotice error={exam.error} />
      </Shell>
    );
  }

  if (exam.isLoading || !exam.data) {
    return (
      <Shell>
        <LoadingBlock label="Loading exam" />
      </Shell>
    );
  }

  const data = exam.data;
  const year = years.data?.find((row) => row.id === data.academicYearId);
  const transitions = MANAGEABLE_TRANSITIONS[data.status] ?? [];
  const statusOptions = EXAM_MANAGEABLE_STATUS_OPTIONS.filter((option) =>
    transitions.includes(option.value),
  );

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={data.nameEn}
        titleBn={data.nameBn}
        breadcrumbs={[{ label: 'Examinations', href: '/exams' }, { label: data.nameEn }]}
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <ExamStatusBadge status={data.status} />
            <Badge tone="neutral">{humanize(data.type)}</Badge>
            <span className="font-mono text-xs text-content-subtle">{data.code}</span>
          </div>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {/* Each link is shown only to someone who holds the permission its screen needs.
                The API re-checks on every request; this is about not offering dead ends. */}
            {session.canAny('results.view.all', 'results.view.assigned') ? (
              <Button href={`/exams/${examId}/marks`}>Mark entry</Button>
            ) : null}
            {session.canAny('results.review', 'results.approve', 'results.view.all') ? (
              <Button href={`/exams/${examId}/review`}>Review</Button>
            ) : null}
            {session.canAny('results.publish', 'results.unpublish') ? (
              <Button href={`/results/publish?examId=${examId}`}>Publish</Button>
            ) : null}
            {canManage && statusOptions.length > 0 ? (
              <Button variant="primary" onClick={() => setChangingStatus(true)}>
                Change status
              </Button>
            ) : null}
            {canManage && data.status !== 'archived' ? (
              <Button variant="danger" onClick={() => setArchiving(true)}>
                Archive
              </Button>
            ) : null}
          </div>
        }
      />

      <Card className="mb-5">
        <CardBody padded>
          <DescriptionList
            columns={3}
            items={[
              { label: 'Academic year', value: year?.name ?? null, emptyText: 'Not shown' },
              {
                label: 'Dates',
                value:
                  data.startDate && data.endDate
                    ? formatDateRange(data.startDate, data.endDate)
                    : data.startDate
                      ? formatLongDate(data.startDate)
                      : null,
                emptyText: 'Not scheduled',
              },
              {
                label: 'Weightage',
                value: formatBasisPoints(data.weightageBasisPoints),
              },
              {
                label: 'Grading scale',
                value: data.gradingScale ? <BilingualName row={data.gradingScale} /> : null,
                emptyText: 'Not resolved',
              },
              { label: 'Papers configured', value: String(data.subjectCount) },
              {
                label: 'Results published',
                value: data.resultsPublishedAt ? formatInstant(data.resultsPublishedAt) : null,
                emptyText: 'Not published',
              },
              { label: 'Instructions', value: data.instructions, span: true },
            ]}
          />
        </CardBody>
      </Card>

      <Tabs value={tab} onValueChange={setTab} activation="manual">
        <TabList label="Exam details">
          <Tab value="papers" count={papers.data?.length}>
            Papers
          </Tab>
          <Tab value="schedule">Schedule</Tab>
        </TabList>

        <TabPanel value="papers">
          <DataTable<ExamSubjectRow>
            caption="Papers configured for this exam, by class level"
            rows={papers.data ?? []}
            rowKey={(row) => row.examSubject.id}
            isLoading={papers.isLoading}
            isFetching={papers.isFetching}
            error={papers.error}
            empty={{
              title: 'No papers configured',
              description:
                'An exam needs at least one paper per class level before marks can be entered. Papers are configured through the exam subjects API, which validates that each paper’s components add up to its full marks.',
            }}
            minWidth="46rem"
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
                id: 'class',
                header: 'Class',
                card: 'subtitle',
                render: (row) => row.classLevelNameEn,
              },
              {
                id: 'full',
                header: 'Full marks',
                align: 'right',
                card: 'meta',
                className: 'tabular-nums',
                render: (row) => formatMarks(row.examSubject.fullMarks),
              },
              {
                id: 'pass',
                header: 'Pass marks',
                align: 'right',
                card: 'meta',
                className: 'tabular-nums',
                render: (row) => formatMarks(row.examSubject.passMarks),
              },
              {
                id: 'components',
                header: 'Components',
                card: 'row',
                hideBelow: 'md',
                render: (row) => {
                  const components = paperComponents(row.examSubject);
                  // One component labelled "Marks" means the paper declared no breakdown at
                  // all — the API marks it out of its total in the written column.
                  if (components.length === 1 && components[0]!.label === 'Marks') {
                    return <span className="text-content-muted">No breakdown</span>;
                  }
                  return components
                    .map(
                      (component) =>
                        `${component.label} ${formatMarks(component.fullMarks)}${component.passMarks ? ` (pass ${formatMarks(component.passMarks)})` : ''}`,
                    )
                    .join(' · ');
                },
              },
              {
                id: 'flags',
                header: 'Counts towards',
                card: 'aside',
                render: (row) => (
                  <div className="flex flex-wrap gap-1">
                    {row.isFourthSubject ? <Badge tone="info">Fourth subject</Badge> : null}
                    {row.excludeFromGpa ? <Badge tone="neutral">Outside GPA</Badge> : null}
                    {row.examSubject.isOptional ? <Badge tone="neutral">Optional</Badge> : null}
                  </div>
                ),
              },
            ]}
          />
        </TabPanel>

        <TabPanel value="schedule">
          <div className="mb-3 flex justify-end">
            {canSchedule && (papers.data?.length ?? 0) > 0 ? (
              <Button variant="primary" onClick={() => setScheduling(true)}>
                Schedule a paper
              </Button>
            ) : null}
          </div>
          <DataTable<ExamScheduleRow>
            caption="The timetable for this exam"
            rows={schedules.data ?? []}
            rowKey={(row) => row.schedule.id}
            isLoading={schedules.isLoading}
            isFetching={schedules.isFetching}
            error={schedules.error}
            empty={{
              title: 'Nothing scheduled yet',
              description: canSchedule
                ? 'Schedule each paper with its date, time and — where they are decided — its room and invigilator. The API refuses a room or an invigilator that is already committed to an overlapping paper.'
                : 'The exam routine appears here once it has been scheduled.',
            }}
            minWidth="46rem"
            columns={[
              {
                id: 'subject',
                header: 'Paper',
                card: 'title',
                render: (row) => row.subjectNameEn,
              },
              {
                id: 'date',
                header: 'Date',
                card: 'subtitle',
                render: (row) => formatLongDate(row.schedule.examDate),
              },
              {
                id: 'time',
                header: 'Time',
                card: 'meta',
                className: 'tabular-nums',
                render: (row) => formatTimeRange(row.schedule.startTime, row.schedule.endTime),
              },
              {
                id: 'room',
                header: 'Room',
                card: 'meta',
                render: (row) =>
                  row.roomNameEn ? (
                    <span>
                      {row.roomNameEn}
                      {row.roomCode ? (
                        <span className="ml-1 font-mono text-xs text-content-subtle">
                          {row.roomCode}
                        </span>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-content-muted">Not decided</span>
                  ),
              },
              {
                id: 'invigilator',
                header: 'Invigilator',
                card: 'meta',
                hideBelow: 'lg',
                render: (row) =>
                  row.invigilatorNameEn ?? <span className="text-content-muted">Not assigned</span>,
              },
            ]}
          />
        </TabPanel>
      </Tabs>

      {canSchedule ? (
        <ScheduleDialog
          open={scheduling}
          onClose={() => setScheduling(false)}
          institutionId={institutionId}
          examId={examId}
          academicYearId={data.academicYearId}
          papers={papers.data ?? []}
          onSaved={() => {
            setScheduling(false);
            void queryClient.invalidateQueries({ queryKey: ['exams', examId, 'schedules'] });
          }}
        />
      ) : null}

      <Dialog
        open={changingStatus}
        onClose={() => setChangingStatus(false)}
        title="Change exam status"
        description="Only the moves this exam can legally make are offered. Review and publication are separate acts with their own permissions."
        size="sm"
        footer={
          <>
            <Button onClick={() => setChangingStatus(false)} disabled={changeStatus.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!nextStatus}
              loading={changeStatus.isPending}
              loadingLabel="Changing…"
              onClick={() => changeStatus.mutate(nextStatus)}
            >
              Change status
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          <label htmlFor="next-status" className="label">
            New status
          </label>
          <Select
            id="next-status"
            value={nextStatus}
            onChange={(event) => setNextStatus(event.target.value)}
            options={statusOptions}
            placeholder="Choose a status"
          />
          {changeStatus.error ? <ErrorNotice error={changeStatus.error} /> : null}
        </div>
      </Dialog>

      <ConfirmDialog
        open={archiving}
        onClose={() => setArchiving(false)}
        title={`Archive ${data.nameEn}?`}
        confirmLabel="Archive"
        requireReason
        reasonLabel="Why is this exam being archived?"
        body="An archived exam is hidden from the list and can no longer move through the lifecycle. Its marks and results are kept."
        onConfirm={async (reason) => {
          await archive.mutateAsync(reason);
        }}
      />
    </div>
  );
}

/**
 * Schedule one paper.
 *
 * Room and invigilator are optional because a routine is usually drafted before either is
 * decided, and forcing a placeholder produces a timetable full of fictional rooms. The pickers
 * that need a permission the caller may not hold are simply not rendered — reading the room
 * list needs `academic.sections.view`, and the employee list needs `hr.employees.view`.
 */
function ScheduleDialog({
  open,
  onClose,
  institutionId,
  examId,
  academicYearId,
  papers,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  institutionId: string;
  examId: string;
  academicYearId: string;
  papers: ExamSubjectRow[];
  onSaved: () => void;
}) {
  const session = useSession();
  const toast = useToast();

  const form = useForm<z.input<typeof createExamScheduleSchema>>({
    resolver: zodResolver(createExamScheduleSchema),
    defaultValues: { examSubjectId: '', examDate: '', startTime: '', endTime: '' },
  });

  const examSubjectId = form.watch('examSubjectId');
  const paper = papers.find((row) => row.examSubject.id === examSubjectId);

  const canSeeRooms = session.canAny('academic.sections.view', 'academic.rooms.manage');
  const canSeeEmployees = session.can('hr.employees.view');

  const sections = useQuery({
    queryKey: ['academic', 'sections', institutionId, academicYearId],
    queryFn: () => academicApi.sections(institutionId, academicYearId),
    enabled: open && session.can('academic.sections.view'),
  });

  const rooms = useQuery({
    queryKey: ['academic', 'rooms', institutionId],
    queryFn: () => academicApi.rooms(institutionId),
    enabled: open && canSeeRooms,
  });

  const employees = useQuery({
    queryKey: ['academic', 'employees', institutionId],
    queryFn: () => academicApi.employees(institutionId),
    enabled: open && canSeeEmployees,
  });

  const create = useMutation({
    mutationFn: (values: z.infer<typeof createExamScheduleSchema>) =>
      examsApi.createSchedule(institutionId, examId, values),
    onSuccess: () => {
      form.reset();
      toast.success('Paper scheduled');
      onSaved();
    },
  });

  const eligibleSections = (sections.data ?? []).filter(
    (section) => !paper || section.classLevelId === paper.examSubject.classLevelId,
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Schedule a paper"
      description="The API refuses a room or an invigilator already committed to an overlapping paper, so a clash is caught here rather than on the morning of the exam."
      size="lg"
      closeOnBackdropClick={false}
    >
      <Form
        form={form}
        onSubmit={async (values) => {
          // `mutateAsync`, awaited, with no try/catch: that is what lets a 422 reach `Form`,
          // which maps the API's field paths onto the fields via setError.
          await create.mutateAsync(values as z.infer<typeof createExamScheduleSchema>);
        }}
        onError={(error) => toast.error(error)}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <SelectField
              form={form}
              name="examSubjectId"
              label="Paper"
              options={paperOptions(papers)}
              placeholder="Choose a paper"
              required
            />
          </div>
          <SelectField
            form={form}
            name="sectionId"
            label="Section"
            hint="Leave empty when the whole class level sits the paper together."
            options={toOptions(eligibleSections, (section) => ({
              value: section.id,
              label: `${section.classLevelName} · ${section.nameEn}`,
            }))}
            placeholder={paper ? 'Whole class level' : 'Choose a paper first'}
            allowEmpty
            optional
          />
          {canSeeRooms ? (
            <SelectField
              form={form}
              name="roomId"
              label="Room"
              options={toOptions(rooms.data ?? [], (room) => ({
                value: room.id,
                label: room.nameEn,
                hint: room.capacity ? `seats ${room.capacity}` : room.code,
              }))}
              placeholder="Not decided"
              allowEmpty
              optional
            />
          ) : null}
          {canSeeEmployees ? (
            <SelectField
              form={form}
              name="invigilatorEmployeeId"
              label="Invigilator"
              options={toOptions(employees.data?.data ?? [], (employee) => ({
                value: employee.id,
                label: employee.fullNameEn,
                hint: employee.employeeCode ?? undefined,
              }))}
              placeholder="Not assigned"
              allowEmpty
              optional
            />
          ) : null}
          <DateField form={form} name="examDate" label="Date" required />
          <TimeField form={form} name="startTime" label="Starts" required />
          <TimeField form={form} name="endTime" label="Ends" required />
          <div className="sm:col-span-2">
            <TextAreaField
              form={form}
              name="notes"
              label="Notes"
              rows={2}
              maxLength={500}
              optional
            />
          </div>
        </div>

        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            loading={form.formState.isSubmitting}
            loadingLabel="Scheduling…"
          >
            Schedule paper
          </Button>
        </FormActions>
      </Form>
    </Dialog>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Exam"
        breadcrumbs={[{ label: 'Examinations', href: '/exams' }, { label: 'Exam' }]}
      />
      {children}
    </div>
  );
}

/**
 * Basis points as a percentage: `10000` → `100%`, `1250` → `12.5%`.
 *
 * Integer arithmetic on an integer field, then string assembly — the same discipline as money,
 * because `10000 / 100` being exact is luck rather than a property we can rely on for every
 * value the field admits.
 */
function formatBasisPoints(value: number): string {
  const whole = (value - (value % 100)) / 100;
  const fraction = String(value % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}%` : `${whole}%`;
}
