'use client';

/**
 * One fee plan: what it charges, who it applies to, and its late-fine rule.
 *
 * Publishing (`draft` → `active`) is a real decision — from that moment a billing run will pick
 * this plan up for every student it matches — so it asks for confirmation and sends the row's
 * `version`. A stale version is refused by the API with a 409 rather than quietly overwriting
 * whatever a colleague changed while this page was open.
 */

import { use, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  DataTable,
  DescriptionList,
  ErrorNotice,
  PageHeader,
  SkeletonCard,
  formatMoney,
  toneForStatus,
  useToast,
} from '@/components/ui';
import { formatDate, humanize } from '@/lib/format';
import { feesApi, type FeeStructureItem } from '@/components/fees/fees-api';
import { describeLateFine } from '@/components/fees/fee-plan-list';
import { FeePlanItemsForm } from '@/components/fees/fee-plan-items-form';

export default function FeePlanDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const session = useSession();
  const institutionId = session.institutionId!;
  const toast = useToast();
  const queryClient = useQueryClient();

  const [editingItems, setEditingItems] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const canManage = session.can('finance.plans.manage');
  const canViewYears = session.can('academic.years.view');
  const canViewClasses = session.can('academic.classes.view');

  const plan = useQuery({
    queryKey: ['fee-structure', id],
    queryFn: () => feesApi.getFeeStructure(institutionId, id),
  });

  // The plan stores `feeHeadId`; the catalogue turns it into a name. One request for the whole
  // catalogue, not one per line.
  const heads = useQuery({
    queryKey: ['fee-heads', 'catalogue', institutionId],
    queryFn: () => feesApi.listFeeHeads(institutionId, { pageSize: 200, sort: 'sortOrder' }),
    staleTime: 5 * 60_000,
  });

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

  const publish = useMutation({
    mutationFn: (version: number) =>
      feesApi.updateFeeStructure(institutionId, id, { status: 'active', version }),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: ['fee-structure', id] });
      void queryClient.invalidateQueries({ queryKey: ['fee-structures'] });
      toast.success('Fee plan published', `${updated.nameEn} is now active.`);
    },
  });

  const archive = useMutation({
    mutationFn: (reason: string) => feesApi.archiveFeeStructure(institutionId, id, reason),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: ['fee-structure', id] });
      void queryClient.invalidateQueries({ queryKey: ['fee-structures'] });
      toast.success('Fee plan archived', updated.nameEn);
    },
  });

  if (plan.isError) {
    return (
      <div className="mx-auto max-w-4xl">
        <ErrorNotice error={plan.error} />
        <Button href="/fees" className="mt-4">
          Back to fees
        </Button>
      </div>
    );
  }

  if (plan.isLoading || !plan.data) {
    return (
      <div className="mx-auto max-w-4xl">
        <SkeletonCard lines={7} label="Loading fee plan" />
      </div>
    );
  }

  const row = plan.data;
  const headById = new Map((heads.data?.data ?? []).map((head) => [head.id, head]));
  const yearName = years.data?.find((year) => year.id === row.academicYearId)?.name;
  const className = row.classLevelId
    ? (classLevels.data?.find((level) => level.id === row.classLevelId)?.nameEn ?? 'One class')
    : 'Every class in the year';

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        breadcrumbs={[{ label: 'Fees', href: '/fees' }, { label: row.nameEn }]}
        title={row.nameEn}
        titleBn={row.nameBn}
        meta={
          <>
            <Badge tone={toneForStatus(row.status)}>{humanize(row.status)}</Badge>
            <span>Effective from {formatDate(row.effectiveFrom)}</span>
            <span>{className}</span>
          </>
        }
        actions={
          canManage && !row.archivedAt ? (
            <>
              {row.status === 'draft' ? (
                <Button variant="primary" onClick={() => setPublishing(true)}>
                  Publish plan
                </Button>
              ) : null}
              <Button variant="danger" onClick={() => setArchiving(true)}>
                Archive plan
              </Button>
            </>
          ) : null
        }
      />

      <Card className="mb-5">
        <CardHeader title="Plan details" />
        <CardBody>
          <DescriptionList
            items={[
              {
                label: 'Academic year',
                value: yearName,
                emptyText: canViewYears ? 'Not recorded' : 'Not visible to your role',
              },
              { label: 'Applies to', value: className },
              { label: 'Effective from', value: formatDate(row.effectiveFrom) },
              { label: 'Late fine', value: describeLateFine(row) },
              {
                label: 'Grace period',
                value:
                  row.lateFineGraceDays > 0
                    ? `${row.lateFineGraceDays} days after the due date`
                    : null,
                emptyText: 'None',
              },
              {
                label: 'Late fine capped at',
                value: row.lateFineMaxAmount ? formatMoney(row.lateFineMaxAmount) : null,
                emptyText: 'No cap',
              },
            ]}
          />
        </CardBody>
      </Card>

      <section>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Charges on this plan</h2>
            <p className="mt-0.5 text-sm text-content-muted">
              A billing run bills the lines whose frequency it asked for.
            </p>
          </div>
          {canManage && !row.archivedAt && !editingItems ? (
            <Button onClick={() => setEditingItems(true)}>Edit charges</Button>
          ) : null}
        </div>

        {editingItems ? (
          <Card padded>
            <FeePlanItemsForm
              institutionId={institutionId}
              structureId={row.id}
              items={row.items}
              heads={(heads.data?.data ?? []).filter((head) => head.archivedAt === null)}
              onDone={() => setEditingItems(false)}
            />
          </Card>
        ) : (
          <DataTable<FeeStructureItem>
            caption={`Charges on the fee plan ${row.nameEn}`}
            rows={row.items}
            rowKey={(item) => item.id}
            minWidth="38rem"
            empty={{
              title: 'This plan charges nothing yet',
              description: canManage
                ? 'Add a line for each fee head the plan should bill.'
                : 'A colleague who maintains fee plans will add the charges.',
            }}
            columns={[
              {
                id: 'head',
                header: 'Fee head',
                card: 'title',
                render: (item) => headById.get(item.feeHeadId)?.nameEn ?? 'Unknown fee head',
              },
              {
                id: 'frequency',
                header: 'Charged',
                card: 'subtitle',
                render: (item) => humanize(item.frequency),
              },
              {
                id: 'dueDay',
                header: 'Due day',
                hideBelow: 'md',
                card: 'meta',
                className: 'tabular-nums',
                render: (item) =>
                  item.dueDayOfMonth ? `Day ${item.dueDayOfMonth}` : 'Run due date',
              },
              {
                id: 'optional',
                header: 'Opt-in',
                card: 'meta',
                render: (item) =>
                  item.isOptional ? <Badge tone="info">Opt-in</Badge> : <span>Always</span>,
              },
              {
                id: 'amount',
                header: 'Amount',
                align: 'right',
                card: 'aside',
                className: 'tabular-nums font-medium',
                render: (item) => formatMoney(item.amount),
              },
            ]}
          />
        )}
      </section>

      <ConfirmDialog
        open={publishing}
        onClose={() => setPublishing(false)}
        variant="primary"
        title={`Publish ${row.nameEn}?`}
        body="Once active, a billing run will use this plan for every student it matches. The charges can still be edited afterwards, but invoices already raised are not changed."
        confirmLabel="Publish plan"
        onConfirm={async () => {
          await publish.mutateAsync(row.version);
        }}
      />

      <ConfirmDialog
        open={archiving}
        onClose={() => setArchiving(false)}
        title={`Archive ${row.nameEn}?`}
        body="Archiving retires the plan. Future billing runs will not use it; invoices already raised against it are untouched."
        confirmLabel="Archive plan"
        requireReason
        onConfirm={async (reason) => {
          await archive.mutateAsync(reason);
        }}
      />
    </div>
  );
}
