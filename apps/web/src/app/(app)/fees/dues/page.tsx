'use client';

/**
 * Fee reports: outstanding dues, and what has actually been collected.
 *
 * Both reports are aggregated in SQL by the API and arrive as decimal strings. Nothing on this
 * screen is summed, averaged or converted — including the totals row, which is the API's own
 * `totals` object rather than a browser-side reduction over `rows` (ADR-004). Those two numbers
 * would agree until the day a filter changed one of them, and a dues report that disagrees with
 * itself is how a school stops trusting the system.
 *
 * `academicYearId` is required by `GET /fees/reports/outstanding`, so the query does not run
 * until a year is chosen. Firing it with a blank year would produce a 422 the user cannot act
 * on and a spinner they cannot explain.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FEE_PAYMENT_METHODS } from '@shikkha/validation';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import {
  Card,
  CardBody,
  CardHeader,
  DataTable,
  DatePicker,
  EmptyState,
  Field,
  FieldGrid,
  MetricCard,
  PageHeader,
  RadioGroup,
  Select,
  StatGrid,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  formatMoney,
  type SelectOption,
} from '@/components/ui';
import { addDays, formatCount, formatNumber, humanize, todayInDhaka } from '@/lib/format';
import {
  feesApi,
  type CollectionSummary,
  type OutstandingDuesRow,
} from '@/components/fees/fees-api';

export default function FeeReportsPage() {
  const session = useSession();
  const [tab, setTab] = useState('outstanding');

  if (!session.can('finance.reports.view')) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="Fee reports" />
        <EmptyState
          title="Fee reports are not available to your role"
          description="These aggregates need finance.reports.view. Ask your school administrator to check your role."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        breadcrumbs={[{ label: 'Fees', href: '/fees' }, { label: 'Reports' }]}
        title="Fee reports"
        description="What is owed, and what has come in."
      />

      <Tabs value={tab} onValueChange={setTab} activation="manual">
        <TabList label="Fee reports">
          <Tab value="outstanding">Outstanding dues</Tab>
          <Tab value="collections">Collections</Tab>
        </TabList>
        <TabPanel value="outstanding">
          <OutstandingDues />
        </TabPanel>
        <TabPanel value="collections">
          <Collections />
        </TabPanel>
      </Tabs>
    </div>
  );
}

function OutstandingDues() {
  const session = useSession();
  const institutionId = session.institutionId!;

  const canViewYears = session.can('academic.years.view');
  const canViewClasses = session.can('academic.classes.view');

  const [academicYearId, setAcademicYearId] = useState('');
  const [classLevelId, setClassLevelId] = useState('');
  const [groupBy, setGroupBy] = useState<'class' | 'section'>('section');
  const [asOfDate, setAsOfDate] = useState('');

  const years = useQuery({
    queryKey: ['academic-years', institutionId],
    queryFn: () => api.academicYears(institutionId),
    enabled: canViewYears,
    staleTime: 5 * 60_000,
  });

  const classLevels = useQuery({
    queryKey: ['class-levels', institutionId],
    queryFn: () => feesApi.classLevels(institutionId),
    enabled: canViewClasses,
    staleTime: 5 * 60_000,
  });

  const report = useQuery({
    queryKey: ['outstanding-dues', { institutionId, academicYearId, classLevelId, groupBy, asOfDate }],
    queryFn: () =>
      feesApi.outstandingDues(institutionId, {
        academicYearId,
        classLevelId: classLevelId || undefined,
        groupBy,
        asOfDate: asOfDate || undefined,
      }),
    enabled: Boolean(academicYearId),
  });

  if (!canViewYears) {
    return (
      <EmptyState
        title="Academic years are not visible to your role"
        description="This report is scoped to an academic year, and reading the list of years needs academic.years.view. Ask your school administrator to check your role."
      />
    );
  }

  const totals = report.data?.totals;

  return (
    <>
      <Card className="mb-5">
        <CardHeader
          title="Report scope"
          description="Dues are counted against invoices in the chosen year, excluding voided ones."
        />
        <CardBody>
          <FieldGrid columns={3}>
            <Field label="Academic year" required>
              <Select
                value={academicYearId}
                onChange={(event) => setAcademicYearId(event.target.value)}
                options={(years.data ?? []).map((year) => ({
                  value: year.id,
                  label: year.name,
                  hint: year.isCurrent ? 'current' : undefined,
                }))}
                placeholder="Choose a year"
              />
            </Field>

            {canViewClasses ? (
              <Field label="Class" optional>
                <Select
                  value={classLevelId}
                  onChange={(event) => setClassLevelId(event.target.value)}
                  options={(classLevels.data ?? []).map((level) => ({
                    value: level.id,
                    label: level.nameEn,
                    hint: level.nameBn ?? undefined,
                  }))}
                  placeholder="All classes"
                  allowEmpty
                />
              </Field>
            ) : null}

            <Field
              label="Due on or before"
              optional
              hint="Leave blank to include every invoice, however far ahead its due date is."
            >
              <DatePicker value={asOfDate} onChange={(event) => setAsOfDate(event.target.value)} />
            </Field>
          </FieldGrid>

          <div className="mt-4">
            <RadioGroup
              name="dues-group-by"
              label="Group rows by"
              orientation="inline"
              value={groupBy}
              onChange={(event) => setGroupBy(event.target.value as 'class' | 'section')}
              options={[
                { value: 'section', label: 'Section' },
                { value: 'class', label: 'Class' },
              ]}
            />
          </div>
        </CardBody>
      </Card>

      {!academicYearId ? (
        <EmptyState
          title="Choose an academic year"
          description="Outstanding dues are always read against one year's invoices, so the report needs a year before it can run."
        />
      ) : (
        <>
          <StatGrid className="mb-5">
            <MetricCard label="Billed" value={totals ? formatMoney(totals.billed) : null} />
            <MetricCard
              label="Collected"
              value={totals ? formatMoney(totals.collected) : null}
              tone="success"
            />
            <MetricCard
              label="Outstanding"
              value={totals ? formatMoney(totals.outstanding) : null}
              tone="danger"
            />
            <MetricCard
              label="Rows"
              value={report.data ? formatNumber(report.data.rows.length) : null}
              detail={report.data ? `Grouped by ${report.data.groupBy}` : undefined}
            />
          </StatGrid>

          <DataTable<OutstandingDuesRow>
            caption="Outstanding dues by class and section"
            rows={report.data?.rows ?? []}
            rowKey={(row) => `${row.classLevelId}:${row.sectionId ?? 'all'}`}
            isLoading={report.isLoading}
            isFetching={report.isFetching}
            error={report.error}
            minWidth="46rem"
            empty={{
              title: 'Nothing outstanding',
              description:
                'No live invoice in this year has a balance for the classes you selected. Widen the scope or clear the due-date cut-off.',
            }}
            columns={[
              {
                id: 'class',
                header: 'Class',
                card: 'title',
                render: (row) => row.classLevelName,
              },
              {
                id: 'section',
                header: 'Section',
                card: 'subtitle',
                render: (row) => row.sectionName ?? 'All sections',
              },
              {
                id: 'students',
                header: 'Students',
                align: 'right',
                hideBelow: 'md',
                card: 'meta',
                className: 'tabular-nums',
                render: (row) => formatCount(row.studentCount, 'student'),
              },
              {
                id: 'invoices',
                header: 'Invoices',
                align: 'right',
                hideBelow: 'lg',
                card: 'hidden',
                className: 'tabular-nums text-content-muted',
                render: (row) => formatNumber(row.invoiceCount),
              },
              {
                id: 'billed',
                header: 'Billed',
                align: 'right',
                card: 'row',
                className: 'tabular-nums text-content-muted',
                render: (row) => formatMoney(row.billed),
              },
              {
                id: 'collected',
                header: 'Collected',
                align: 'right',
                card: 'row',
                className: 'tabular-nums text-content-muted',
                render: (row) => formatMoney(row.collected),
              },
              {
                id: 'outstanding',
                header: 'Outstanding',
                align: 'right',
                card: 'aside',
                className: 'tabular-nums font-medium',
                render: (row) => formatMoney(row.outstanding),
              },
            ]}
          />
        </>
      )}
    </>
  );
}

const METHOD_OPTIONS: SelectOption[] = FEE_PAYMENT_METHODS.map((method) => ({
  value: method,
  label: humanize(method),
}));

function Collections() {
  const session = useSession();
  const institutionId = session.institutionId!;

  const today = todayInDhaka();
  const [from, setFrom] = useState(addDays(today, -30));
  const [to, setTo] = useState(today);
  const [method, setMethod] = useState('');

  const rangeIsValid = Boolean(from) && Boolean(to) && to >= from;

  const summary = useQuery({
    queryKey: ['collection-summary', { institutionId, from, to, method }],
    queryFn: () =>
      feesApi.collectionSummary(institutionId, { from, to, method: method || undefined }),
    enabled: rangeIsValid,
  });

  return (
    <>
      <Card className="mb-5">
        <CardHeader
          title="Date range"
          description="Completed payments only. A reversed receipt is excluded by the API, not filtered out here."
        />
        <CardBody>
          <FieldGrid columns={3}>
            <Field label="From" required>
              <DatePicker value={from} onChange={(event) => setFrom(event.target.value)} />
            </Field>
            <Field
              label="To"
              required
              error={rangeIsValid ? null : 'The end of the range cannot be before its start.'}
            >
              <DatePicker value={to} onChange={(event) => setTo(event.target.value)} />
            </Field>
            <Field label="Method" optional>
              <Select
                value={method}
                onChange={(event) => setMethod(event.target.value)}
                options={METHOD_OPTIONS}
                placeholder="All methods"
                allowEmpty
              />
            </Field>
          </FieldGrid>
        </CardBody>
      </Card>

      <StatGrid className="mb-5">
        <MetricCard
          label="Collected"
          value={summary.data ? formatMoney(summary.data.totalAmount) : null}
          tone="success"
        />
        <MetricCard
          label="Receipts"
          value={summary.data ? formatNumber(summary.data.totalCount) : null}
        />
      </StatGrid>

      <DataTable<CollectionSummary['byMethod'][number]>
        caption="Collections by payment method"
        rows={summary.data?.byMethod ?? []}
        rowKey={(row) => row.method}
        isLoading={summary.isLoading}
        isFetching={summary.isFetching}
        error={summary.error}
        minWidth="30rem"
        empty={{
          title: 'Nothing collected in this range',
          description:
            'No completed payment was received between these dates. Widen the range, or clear the method filter.',
        }}
        columns={[
          {
            id: 'method',
            header: 'Method',
            card: 'title',
            render: (row) => humanize(row.method),
          },
          {
            id: 'count',
            header: 'Receipts',
            align: 'right',
            card: 'meta',
            className: 'tabular-nums',
            render: (row) => formatNumber(row.count),
          },
          {
            id: 'amount',
            header: 'Amount',
            align: 'right',
            card: 'aside',
            className: 'tabular-nums font-medium',
            render: (row) => formatMoney(row.amount),
          },
        ]}
      />
    </>
  );
}
