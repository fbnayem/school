'use client';

/**
 * Admission applications.
 *
 * The stage of an application *is* its status, so the status filter is the stage filter — there
 * is no second "stage" concept in the data model and inventing one on the client would be a
 * label with nothing behind it. Filtering, searching, sorting and paging are all server-side;
 * the endpoint's sort allow-list is `ADMISSION_APPLICATION_SORT_FIELDS`, and the columns below
 * only offer fields that are in it.
 *
 * Class-level names need `academic.classes.view`, which the admission roles hold but not every
 * caller does. When the lookup is not permitted the column and its filter are omitted rather
 * than rendered as a row of blanks or, worse, raw identifiers.
 */

import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useSession } from '@/lib/session';
import { formatDate, formatInstantDate, humanize } from '@/lib/format';
import { academicApi } from '@/components/academic/api';
import {
  Badge,
  BilingualName,
  Button,
  DataTable,
  FilterBar,
  PageHeader,
  Pagination,
  toneForStatus,
  type DataTableColumn,
} from '@/components/ui';
import { admissionsApi, type AdmissionApplication } from '@/components/admissions/api';
import { ApplicationFormDialog } from '@/components/admissions/application-form';
import { ADMISSION_APPLICATION_STATUSES } from '@shikkha/validation';

const PAGE_SIZE = 25;

export default function AdmissionsPage() {
  const session = useSession();
  const institutionId = session.institutionId;
  const canReadClassLevels = session.can('academic.classes.view');

  const [q, setQ] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [status, setStatus] = useState('');
  const [classLevelId, setClassLevelId] = useState('');
  const [source, setSource] = useState('');
  const [sort, setSort] = useState<string | undefined>();
  const [page, setPage] = useState(1);
  const [formOpen, setFormOpen] = useState(false);

  const sessions = useQuery({
    queryKey: ['admission-sessions', { institutionId }],
    queryFn: () => admissionsApi.sessions(institutionId!, { page: 1, pageSize: 50 }),
    enabled: Boolean(institutionId),
  });

  const classLevels = useQuery({
    queryKey: ['class-levels', institutionId],
    queryFn: () => academicApi.classLevels(institutionId!),
    enabled: Boolean(institutionId) && canReadClassLevels,
  });

  const applications = useQuery({
    queryKey: [
      'admission-applications',
      { q, sessionId, status, classLevelId, source, sort, page, institutionId },
    ],
    queryFn: () =>
      admissionsApi.applications(institutionId!, {
        page,
        pageSize: PAGE_SIZE,
        q: q || undefined,
        sessionId: sessionId || undefined,
        status: status || undefined,
        classLevelId: classLevelId || undefined,
        source: source || undefined,
        sort,
      }),
    placeholderData: keepPreviousData,
    enabled: Boolean(institutionId),
  });

  const classLevelName = (id: string): string | null =>
    classLevels.data?.find((level) => level.id === id)?.nameEn ?? null;

  const columns: DataTableColumn<AdmissionApplication>[] = [
    {
      id: 'applicant',
      header: 'Applicant',
      card: 'title',
      sortField: 'applicantNameEn',
      // With `rowHref` the title cell is wrapped in the link, so this returns plain content.
      render: (row) => (
        <BilingualName
          row={{ nameEn: row.applicantNameEn, nameBn: row.applicantNameBn }}
          className="font-medium"
        />
      ),
    },
    {
      id: 'applicationNumber',
      header: 'Application no.',
      card: 'subtitle',
      sortField: 'applicationNumber',
      className: 'font-mono text-xs text-content-muted',
      render: (row) => row.applicationNumber,
    },
    ...(canReadClassLevels
      ? [
          {
            id: 'classLevel',
            header: 'Class',
            card: 'meta' as const,
            render: (row: AdmissionApplication) => classLevelName(row.classLevelId) ?? '—',
          },
        ]
      : []),
    {
      id: 'status',
      header: 'Stage',
      card: 'aside',
      sortField: 'status',
      render: (row) => <Badge tone={toneForStatus(row.status)}>{humanize(row.status)}</Badge>,
    },
    {
      id: 'dateOfBirth',
      header: 'Date of birth',
      card: 'meta',
      sortField: 'dateOfBirth',
      hideBelow: 'lg',
      className: 'tabular-nums text-content-muted',
      render: (row) => formatDate(row.dateOfBirth),
    },
    {
      id: 'submittedAt',
      header: 'Submitted',
      card: 'meta',
      sortField: 'submittedAt',
      className: 'tabular-nums text-content-muted',
      render: (row) => formatInstantDate(row.submittedAt),
    },
    {
      id: 'source',
      header: 'Source',
      card: 'meta',
      hideBelow: 'md',
      render: (row) => <span className="text-content-muted">{humanize(row.source)}</span>,
    },
  ];

  const hasFilters = Boolean(q || sessionId || status || classLevelId || source);
  const resetPage = () => setPage(1);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Admissions"
        description="Every application to every intake cycle, at the stage it has reached."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button href="/admissions/sessions">Sessions and seats</Button>
            {/* Rendered, not disabled: a control the user cannot use should not be offered.
                The API re-checks this permission on the request itself. */}
            {session.can('admissions.applications.review') && institutionId ? (
              <Button variant="primary" onClick={() => setFormOpen(true)}>
                Record a counter application
              </Button>
            ) : null}
          </div>
        }
      />

      <FilterBar
        className="mb-4"
        search={{
          value: q,
          onChange: (value) => {
            setQ(value);
            resetPage();
          },
          label: 'Search applications by applicant name or application number',
          placeholder: 'Search by name or application number',
        }}
        filters={[
          {
            id: 'session',
            label: 'Session',
            value: sessionId,
            onChange: (value) => {
              setSessionId(value);
              resetPage();
            },
            options: (sessions.data?.data ?? []).map((row) => ({
              value: row.id,
              label: row.nameEn,
              hint: row.nameBn ?? undefined,
            })),
            placeholder: 'Any session',
          },
          {
            id: 'status',
            label: 'Stage',
            value: status,
            onChange: (value) => {
              setStatus(value);
              resetPage();
            },
            options: ADMISSION_APPLICATION_STATUSES.map((value) => ({
              value,
              label: humanize(value),
            })),
            placeholder: 'Any stage',
          },
          ...(canReadClassLevels
            ? [
                {
                  id: 'classLevel',
                  label: 'Class',
                  value: classLevelId,
                  onChange: (value: string) => {
                    setClassLevelId(value);
                    resetPage();
                  },
                  options: (classLevels.data ?? []).map((level) => ({
                    value: level.id,
                    label: level.nameEn,
                    hint: level.nameBn ?? undefined,
                  })),
                  placeholder: 'Any class',
                },
              ]
            : []),
          {
            id: 'source',
            label: 'Source',
            value: source,
            onChange: (value) => {
              setSource(value);
              resetPage();
            },
            options: [
              { value: 'online', label: 'Online form' },
              { value: 'counter', label: 'Counter' },
            ],
            placeholder: 'Any source',
          },
        ]}
        onReset={
          hasFilters
            ? () => {
                setQ('');
                setSessionId('');
                setStatus('');
                setClassLevelId('');
                setSource('');
                resetPage();
              }
            : undefined
        }
      />

      <DataTable
        caption="Admission applications"
        rows={applications.data?.data ?? []}
        rowKey={(row) => row.id}
        rowHref={(row) => `/admissions/${row.id}`}
        columns={columns}
        sort={sort}
        onSortChange={(value) => {
          setSort(value);
          resetPage();
        }}
        isLoading={applications.isLoading}
        isFetching={applications.isFetching}
        error={applications.error}
        empty={{
          title: hasFilters ? 'No applications match these filters' : 'No applications yet',
          description: hasFilters
            ? 'Try a wider stage or session, or clear the search.'
            : 'Applications arrive from the public form, or are recorded here when a family applies at the counter.',
        }}
        minWidth="56rem"
      />

      <Pagination
        className="mt-4"
        meta={applications.data?.meta}
        onPageChange={setPage}
        isFetching={applications.isFetching}
        itemNoun="application"
      />

      {institutionId ? (
        <ApplicationFormDialog
          open={formOpen}
          onClose={() => setFormOpen(false)}
          institutionId={institutionId}
        />
      ) : null}
    </div>
  );
}
