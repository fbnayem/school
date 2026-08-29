'use client';

/**
 * Fee plans (the API calls them fee structures) — the price list a billing run reads.
 *
 * The class-level column resolves `classLevelId` through `/academic/class-levels`, which needs
 * `academic.classes.view`. Not every finance role holds it, so when the lookup is unavailable
 * the column says "One class" rather than inventing a name or showing a uuid: the fact that the
 * plan is class-scoped is real and worth showing; *which* class is something we were not told.
 */

import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { FEE_STRUCTURE_STATUSES } from '@shikkha/validation';
import { api } from '@/lib/api';
import {
  Badge,
  BilingualName,
  DataTable,
  FilterBar,
  Pagination,
  formatMoney,
  formatPercent,
  toneForStatus,
  type SelectOption,
} from '@/components/ui';
import { formatDate, humanize } from '@/lib/format';
import { feesApi, type FeeStructure } from './fees-api';

const PAGE_SIZE = 25;

const STATUS_OPTIONS: SelectOption[] = FEE_STRUCTURE_STATUSES.map((status) => ({
  value: status,
  label: humanize(status),
}));

/** A late-fine rule in one phrase. `lateFineValue` is money for `fixed`, a percentage otherwise. */
export function describeLateFine(structure: {
  lateFineKind: FeeStructure['lateFineKind'];
  lateFineValue: string;
  lateFineGraceDays: number;
}): string {
  if (structure.lateFineKind === 'none') return 'No late fine';
  const amount =
    structure.lateFineKind === 'fixed'
      ? formatMoney(structure.lateFineValue)
      : formatPercent(structure.lateFineValue);
  const grace =
    structure.lateFineGraceDays > 0 ? ` after ${structure.lateFineGraceDays} days` : '';
  return `${amount}${grace}`;
}

export function FeePlanList({
  institutionId,
  canViewAcademicYears,
  canViewClassLevels,
}: {
  institutionId: string;
  canViewAcademicYears: boolean;
  canViewClassLevels: boolean;
}) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [academicYearId, setAcademicYearId] = useState('');
  const [sort, setSort] = useState<string | undefined>();
  const [page, setPage] = useState(1);

  const years = useQuery({
    queryKey: ['academic-years', institutionId],
    queryFn: () => api.academicYears(institutionId),
    enabled: canViewAcademicYears,
    staleTime: 5 * 60_000,
  });

  const classLevels = useQuery({
    queryKey: ['class-levels', institutionId],
    queryFn: () => feesApi.classLevels(institutionId),
    enabled: canViewClassLevels,
    staleTime: 5 * 60_000,
  });

  const classLevelName = (id: string | null): string => {
    if (!id) return 'All classes';
    const match = classLevels.data?.find((level) => level.id === id);
    return match ? match.nameEn : 'One class';
  };

  const plans = useQuery({
    queryKey: ['fee-structures', { institutionId, q, status, academicYearId, sort, page }],
    queryFn: () =>
      feesApi.listFeeStructures(institutionId, {
        q: q || undefined,
        status: status || undefined,
        academicYearId: academicYearId || undefined,
        sort,
        page,
        pageSize: PAGE_SIZE,
      }),
    placeholderData: keepPreviousData,
  });

  const resetPage = () => setPage(1);

  return (
    <>
      <FilterBar
        search={{
          value: q,
          onChange: (value) => {
            setQ(value);
            resetPage();
          },
          label: 'Search fee plans by name',
        }}
        filters={[
          {
            id: 'status',
            label: 'Plan status',
            value: status,
            onChange: (value) => {
              setStatus(value);
              resetPage();
            },
            options: STATUS_OPTIONS,
            placeholder: 'Any status',
          },
          ...(canViewAcademicYears
            ? [
                {
                  id: 'year',
                  label: 'Academic year',
                  value: academicYearId,
                  onChange: (value: string) => {
                    setAcademicYearId(value);
                    resetPage();
                  },
                  options: (years.data ?? []).map((year) => ({
                    value: year.id,
                    label: year.name,
                    hint: year.isCurrent ? 'current' : undefined,
                  })),
                  placeholder: 'All years',
                },
              ]
            : []),
        ]}
        onReset={() => {
          setQ('');
          setStatus('');
          setAcademicYearId('');
          resetPage();
        }}
      />

      <DataTable<FeeStructure>
        caption={`Fee plans, page ${plans.data?.meta.page ?? 1} of ${plans.data?.meta.totalPages ?? 1}`}
        rows={plans.data?.data ?? []}
        rowKey={(row) => row.id}
        rowHref={(row) => `/fees/plans/${row.id}`}
        sort={sort}
        onSortChange={(value) => {
          setSort(value);
          resetPage();
        }}
        isLoading={plans.isLoading}
        isFetching={plans.isFetching}
        error={plans.error}
        minWidth="46rem"
        empty={{
          title: q || status ? 'No fee plans match those filters' : 'No fee plans yet',
          description:
            'A fee plan lists what each class is charged. Billing runs read the plan that applies to a student on the billing date.',
        }}
        columns={[
          {
            id: 'name',
            header: 'Plan',
            sortField: 'nameEn',
            card: 'title',
            render: (row) => <BilingualName row={row} />,
          },
          {
            id: 'classLevel',
            header: 'Applies to',
            card: 'subtitle',
            render: (row) => classLevelName(row.classLevelId),
          },
          {
            id: 'effectiveFrom',
            header: 'Effective from',
            sortField: 'effectiveFrom',
            card: 'meta',
            className: 'tabular-nums',
            render: (row) => formatDate(row.effectiveFrom),
          },
          {
            id: 'lateFine',
            header: 'Late fine',
            hideBelow: 'md',
            card: 'row',
            className: 'tabular-nums',
            render: (row) => describeLateFine(row),
          },
          {
            id: 'status',
            header: 'Status',
            sortField: 'status',
            card: 'aside',
            render: (row) => <Badge tone={toneForStatus(row.status)}>{humanize(row.status)}</Badge>,
          },
        ]}
      />

      <Pagination
        meta={plans.data?.meta}
        onPageChange={setPage}
        isFetching={plans.isFetching}
        itemNoun="fee plan"
      />
    </>
  );
}
