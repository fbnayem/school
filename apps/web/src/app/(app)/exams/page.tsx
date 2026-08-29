'use client';

/**
 * Examinations.
 *
 * The list is the entry point to the whole mark lifecycle, so the status column is not
 * decoration: `draft → scheduled → ongoing → marks_entry → under_review → published` is
 * exactly which of the screens below it are reachable, and by whom.
 */

import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { createExamSchema } from '@shikkha/validation';
import { useSession } from '@/lib/session';
import { academicApi } from '@/components/academic/api';
import { examsApi, type Exam } from '@/components/exams/api';
import { EXAM_STATUS_OPTIONS, EXAM_TYPE_OPTIONS, ExamStatusBadge } from '@/components/exams/shared';
import {
  BilingualName,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  FilterBar,
  Form,
  FormActions,
  PageHeader,
  Pagination,
  SelectField,
  TextAreaField,
  TextField,
  DateField,
  NumberField,
  toOptions,
  useToast,
} from '@/components/ui';
import { formatDateRange, formatLongDate, humanize } from '@/lib/format';

const PAGE_SIZE = 25;

export default function ExamsPage() {
  const session = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [academicYearId, setAcademicYearId] = useState('');
  const [sort, setSort] = useState<string | undefined>();
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);

  const institutionId = session.institutionId;
  const canView = session.can('exams.view');
  const canManage = session.can('exams.manage');

  const years = useQuery({
    queryKey: ['academic', 'years', institutionId],
    queryFn: () => academicApi.years(institutionId!),
    // The year filter needs `academic.years.view`; a user without it still gets the exam list,
    // just without that one filter. Firing the request anyway would put a 403 on the screen
    // for a control they never asked for.
    enabled: Boolean(institutionId) && session.can('academic.years.view'),
  });

  const exams = useQuery({
    queryKey: ['exams', { q, status, type, academicYearId, sort, page, institutionId }],
    queryFn: () =>
      examsApi.list(institutionId!, {
        page,
        pageSize: PAGE_SIZE,
        q: q || undefined,
        status: status || undefined,
        type: type || undefined,
        academicYearId: academicYearId || undefined,
        sort,
      }),
    placeholderData: keepPreviousData,
    enabled: Boolean(institutionId) && canView,
  });

  const create = useMutation({
    mutationFn: (values: z.infer<typeof createExamSchema>) =>
      examsApi.create(institutionId!, values),
    onSuccess: (exam) => {
      setCreating(false);
      toast.success('Exam created', `${exam.nameEn} is in draft.`);
      void queryClient.invalidateQueries({ queryKey: ['exams'] });
    },
  });

  if (!institutionId) {
    return (
      <div className="mx-auto max-w-6xl">
        <PageHeader title="Examinations" />
        <EmptyState
          title="Choose an institution first"
          description="An exam belongs to one institution, so the list needs to know which school you are working in."
        />
      </div>
    );
  }

  if (!canView) {
    return (
      <div className="mx-auto max-w-6xl">
        <PageHeader title="Examinations" />
        <EmptyState
          title="Examinations are not available to you"
          description="Viewing exams needs the exams.view permission. Ask an administrator if you believe this is wrong."
        />
      </div>
    );
  }

  const hasFilters = Boolean(q || status || type || academicYearId);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Examinations"
        description="Exams, their papers and the marks lifecycle: enter, submit, review, approve, publish."
        actions={
          // Hidden rather than disabled when the user cannot create: a control that exists only
          // to be refused teaches nothing. The API re-checks exams.manage on the route, so this
          // is a usability decision, not the security boundary.
          canManage ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              New exam
            </Button>
          ) : null
        }
      />

      <FilterBar
        className="mb-4"
        search={{
          value: q,
          onChange: (value) => {
            setQ(value);
            setPage(1);
          },
          label: 'Search exams by name or code',
          placeholder: 'Search by name or code',
        }}
        filters={[
          ...(years.data
            ? [
                {
                  id: 'academicYearId',
                  label: 'Academic year',
                  value: academicYearId,
                  onChange: (value: string) => {
                    setAcademicYearId(value);
                    setPage(1);
                  },
                  options: toOptions(years.data, (year) => ({
                    value: year.id,
                    label: year.name,
                    hint: year.isCurrent ? 'current' : undefined,
                  })),
                  placeholder: 'All years',
                },
              ]
            : []),
          {
            id: 'status',
            label: 'Status',
            value: status,
            onChange: (value: string) => {
              setStatus(value);
              setPage(1);
            },
            options: EXAM_STATUS_OPTIONS,
            placeholder: 'All statuses',
          },
          {
            id: 'type',
            label: 'Type',
            value: type,
            onChange: (value: string) => {
              setType(value);
              setPage(1);
            },
            options: EXAM_TYPE_OPTIONS,
            placeholder: 'All types',
          },
        ]}
        onReset={
          hasFilters
            ? () => {
                setQ('');
                setStatus('');
                setType('');
                setAcademicYearId('');
                setPage(1);
              }
            : undefined
        }
      />

      <DataTable<Exam>
        caption={`Examinations, page ${exams.data?.meta.page ?? 1} of ${exams.data?.meta.totalPages ?? 1}`}
        rows={exams.data?.data ?? []}
        rowKey={(exam) => exam.id}
        rowHref={(exam) => `/exams/${exam.id}`}
        sort={sort}
        onSortChange={(next) => {
          setSort(next);
          // Page 7 of the old ordering is an empty page 7 of the new one.
          setPage(1);
        }}
        isLoading={exams.isLoading}
        isFetching={exams.isFetching}
        error={exams.error}
        empty={{
          title: hasFilters ? 'No exams match those filters' : 'No exams yet',
          description: hasFilters
            ? 'Try clearing a filter, or search for a different name or code.'
            : canManage
              ? 'Create an exam to configure its papers, schedule and marks.'
              : 'Exams appear here once an administrator has created them.',
        }}
        minWidth="46rem"
        columns={[
          {
            id: 'name',
            header: 'Exam',
            card: 'title',
            sortField: 'nameEn',
            render: (exam) => <BilingualName row={exam} />,
          },
          {
            id: 'code',
            header: 'Code',
            card: 'subtitle',
            sortField: 'code',
            className: 'font-mono text-xs text-content-muted',
            render: (exam) => exam.code,
          },
          {
            id: 'type',
            header: 'Type',
            card: 'meta',
            render: (exam) => humanize(exam.type),
          },
          {
            id: 'dates',
            header: 'Dates',
            card: 'meta',
            sortField: 'startDate',
            hideBelow: 'md',
            render: (exam) =>
              exam.startDate && exam.endDate
                ? formatDateRange(exam.startDate, exam.endDate)
                : exam.startDate
                  ? formatLongDate(exam.startDate)
                  : 'Not scheduled',
          },
          {
            id: 'status',
            header: 'Status',
            card: 'aside',
            sortField: 'status',
            render: (exam) => <ExamStatusBadge status={exam.status} />,
          },
        ]}
      />

      <Pagination
        meta={exams.data?.meta}
        onPageChange={setPage}
        isFetching={exams.isFetching}
        itemNoun="exam"
        className="mt-4"
      />

      {canManage ? (
        <CreateExamDialog
          open={creating}
          onClose={() => setCreating(false)}
          institutionId={institutionId}
          onSubmit={(values) => create.mutateAsync(values)}
        />
      ) : null}
    </div>
  );
}

/**
 * Create an exam.
 *
 * The schema is `createExamSchema` from `@shikkha/validation` — the same object the API parses
 * the body with, so a rule can never be enforced on one side only. `z.input` rather than
 * `z.infer` because `type` and `weightageBasisPoints` carry defaults, and the output type
 * would make both look required to the form.
 */
function CreateExamDialog({
  open,
  onClose,
  institutionId,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  institutionId: string;
  onSubmit: (values: z.infer<typeof createExamSchema>) => Promise<unknown>;
}) {
  const toast = useToast();
  const form = useForm<z.input<typeof createExamSchema>>({
    resolver: zodResolver(createExamSchema),
    defaultValues: {
      academicYearId: '',
      gradingScaleId: '',
      code: '',
      nameEn: '',
      nameBn: '',
      type: 'class_test',
      weightageBasisPoints: 10_000,
    },
  });

  const academicYearId = form.watch('academicYearId');

  const years = useQuery({
    queryKey: ['academic', 'years', institutionId],
    queryFn: () => academicApi.years(institutionId),
    enabled: open,
  });

  const terms = useQuery({
    queryKey: ['academic', 'terms', institutionId, academicYearId],
    queryFn: () => academicApi.terms(institutionId, academicYearId as string),
    enabled: open && Boolean(academicYearId),
  });

  const scales = useQuery({
    queryKey: ['exams', 'grading-scales', institutionId],
    queryFn: () => examsApi.gradingScales(institutionId),
    enabled: open,
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New exam"
      description="An exam starts in draft. Papers, schedule and marks are configured after it exists."
      size="lg"
      // Unsaved input: a stray backdrop click must not discard a half-filled form.
      closeOnBackdropClick={false}
    >
      <Form
        form={form}
        onSubmit={async (values) => {
          // `mutateAsync` awaited here, with no try/catch of our own: that is what lets a 422
          // reach `Form`, which maps the API's field paths onto the fields via setError.
          await onSubmit(values as z.infer<typeof createExamSchema>);
          form.reset();
        }}
        onError={(error) => toast.error(error)}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField form={form} name="nameEn" label="Exam name" required autoFocus />
          <TextField form={form} name="nameBn" label="Exam name (Bangla)" lang="bn" optional />
          <TextField
            form={form}
            name="code"
            label="Code"
            hint="Letters, numbers, hyphens and underscores. Unique within the institution."
            required
          />
          <SelectField form={form} name="type" label="Type" options={EXAM_TYPE_OPTIONS} required />
          <SelectField
            form={form}
            name="academicYearId"
            label="Academic year"
            options={
              years.data
                ? toOptions(years.data, (year) => ({
                    value: year.id,
                    label: year.name,
                    hint: year.isCurrent ? 'current' : undefined,
                  }))
                : []
            }
            placeholder={years.isLoading ? 'Loading…' : 'Choose a year'}
            required
          />
          <SelectField
            form={form}
            name="termId"
            label="Term"
            hint="Leave empty for an exam outside the term structure, such as a model test."
            options={
              terms.data
                ? toOptions(terms.data, (term) => ({ value: term.id, label: term.nameEn }))
                : []
            }
            placeholder={academicYearId ? 'No term' : 'Choose a year first'}
            allowEmpty
            optional
          />
          <SelectField
            form={form}
            name="gradingScaleId"
            label="Grading scale"
            hint="Grades and grade points come from this scale's bands."
            options={
              scales.data
                ? toOptions(scales.data, (scale) => ({
                    value: scale.id,
                    label: scale.nameEn,
                    hint: scale.isDefault ? 'default' : `${scale.bandCount} bands`,
                  }))
                : []
            }
            placeholder={scales.isLoading ? 'Loading…' : 'Choose a scale'}
            required
          />
          <NumberField
            form={form}
            name="weightageBasisPoints"
            label="Weightage"
            suffix="basis points"
            hint="How much this exam contributes to the term or annual result. 10000 = 100%."
            min={0}
            max={10_000}
          />
          <DateField form={form} name="startDate" label="Starts" optional />
          <DateField form={form} name="endDate" label="Ends" optional />
          <div className="sm:col-span-2">
            <TextAreaField
              form={form}
              name="instructions"
              label="Instructions"
              hint="Printed on the exam routine, where the school prints one."
              rows={3}
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
            loadingLabel="Creating…"
          >
            Create exam
          </Button>
        </FormActions>
      </Form>
    </Dialog>
  );
}
