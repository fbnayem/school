'use client';

/**
 * Bulk invoice generation.
 *
 * The rule this screen exists to honour: **the preview is computed by the API, not simulated
 * here.** `POST /fees/invoices/preview` runs exactly the code `POST /fees/invoices/generate`
 * runs and writes nothing — same schema, same structure resolution, same concession maths, same
 * skip reasons. A browser-side estimate would be a different program producing a different
 * answer, and the difference would only surface as a wrong bill.
 *
 * So the flow is: fill the run in → preview → read who is billed and who is skipped and why →
 * confirm → commit. Changing any field clears the preview, because a preview that no longer
 * describes the form is worse than no preview: it is a wrong answer with a tick beside it.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { FEE_FREQUENCIES, generateInvoicesSchema } from '@shikkha/validation';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  ConfirmDialog,
  DataTable,
  CheckboxField,
  EmptyState,
  FieldGrid,
  FieldGridSpan,
  Form,
  FormActions,
  MetricCard,
  PageHeader,
  SelectField,
  StatGrid,
  TextAreaField,
  DateField,
  formatMoney,
  useToast,
  type SelectOption,
} from '@/components/ui';
import { formatCount, formatNumber, humanize, todayInDhaka } from '@/lib/format';
import {
  feesApi,
  type GenerationResult,
  type PreparedInvoice,
  type SkippedStudent,
} from '@/components/fees/fees-api';

type RunValues = z.input<typeof generateInvoicesSchema>;

export default function GenerateInvoicesPage() {
  const session = useSession();
  const institutionId = session.institutionId!;
  const toast = useToast();
  const queryClient = useQueryClient();

  const [preview, setPreview] = useState<GenerationResult | null>(null);
  // The exact request the preview was computed from. The commit re-sends *this*, not a fresh
  // read of the form, so "what you approved is what runs" is literally true rather than nearly.
  const [previewedValues, setPreviewedValues] = useState<RunValues | null>(null);
  const [committed, setCommitted] = useState<GenerationResult | null>(null);
  const [confirming, setConfirming] = useState(false);

  const canViewYears = session.can('academic.years.view');
  const canViewClasses = session.can('academic.classes.view');
  const canViewSections = session.can('academic.sections.view');

  const today = todayInDhaka();

  const form = useForm<RunValues>({
    resolver: zodResolver(generateInvoicesSchema),
    defaultValues: {
      academicYearId: '',
      classLevelId: undefined,
      sectionId: undefined,
      billingPeriodStart: today,
      billingPeriodEnd: today,
      issueDate: today,
      dueDate: today,
      frequencies: ['monthly'],
      includeOptional: false,
      notes: undefined,
    },
  });

  const academicYearId = form.watch('academicYearId');

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

  const sections = useQuery({
    queryKey: ['sections', institutionId, academicYearId],
    queryFn: () => feesApi.sections(institutionId, academicYearId || undefined),
    enabled: canViewSections && Boolean(academicYearId),
    staleTime: 5 * 60_000,
  });

  // Any edit invalidates the preview. Without this the "Generate" button would commit a run the
  // user has since changed, using figures they approved for a different run.
  useEffect(() => {
    const subscription = form.watch(() => {
      setPreview(null);
      setPreviewedValues(null);
      setCommitted(null);
    });
    return () => subscription.unsubscribe();
  }, [form]);

  const runPreview = useMutation({
    mutationFn: (values: RunValues) => feesApi.previewInvoices(institutionId, values),
    onSuccess: (result) => setPreview(result),
  });

  const runGenerate = useMutation({
    mutationFn: (values: RunValues) => feesApi.generateInvoices(institutionId, values),
    onSuccess: (result) => {
      setCommitted(result);
      setPreview(null);
      setConfirming(false);
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
      toast.success(
        'Invoices generated',
        `${formatCount(result.totals.invoiceCount, 'invoice')} for ${formatMoney(result.totals.total)}`,
      );
    },
  });

  if (!session.can('finance.invoices.generate')) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="Generate invoices" />
        <EmptyState
          title="You cannot run a billing round"
          description="Generating invoices needs finance.invoices.generate. Ask your school administrator to check your role."
        />
      </div>
    );
  }

  if (!canViewYears || !(canViewClasses || canViewSections)) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="Generate invoices" />
        <EmptyState
          title="The lists this run needs are not visible to your role"
          description="A billing round is scoped to an academic year and to a class or section. Reading those lists needs academic.years.view together with academic.classes.view or academic.sections.view."
        />
      </div>
    );
  }

  const yearOptions: SelectOption[] = (years.data ?? []).map((year) => ({
    value: year.id,
    label: year.name,
    hint: year.isCurrent ? 'current' : undefined,
  }));

  const classOptions: SelectOption[] = (classLevels.data ?? []).map((level) => ({
    value: level.id,
    label: level.nameEn,
    hint: level.nameBn ?? undefined,
  }));

  const sectionOptions: SelectOption[] = (sections.data ?? []).map((section) => ({
    value: section.id,
    label: `${section.classLevelName} — ${section.nameEn}`,
    hint: `${section.enrolledCount} enrolled`,
  }));

  const frequencyError = form.formState.errors.frequencies?.message;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        breadcrumbs={[{ label: 'Fees', href: '/fees' }, { label: 'Generate invoices' }]}
        title="Generate invoices"
        description="Preview a billing round, read who is billed and who is skipped, then commit it."
      />

      <Card className="mb-5">
        <CardHeader
          title="Billing round"
          description="The same request is used for the preview and the commit, so what you approve is what runs."
        />
        <CardBody>
          <Form
            form={form}
            onSubmit={async (values) => {
              setPreviewedValues(values);
              await runPreview.mutateAsync(values);
            }}
            onError={toast.error}
          >
            <FieldGrid>
              <SelectField
                form={form}
                name="academicYearId"
                label="Academic year"
                options={yearOptions}
                placeholder="Choose a year"
                required
              />
              <SelectField
                form={form}
                name="classLevelId"
                label="Class"
                options={classOptions}
                placeholder="Any class"
                allowEmpty
                optional
                hint="Bill a whole class, or narrow to one section below."
                registerOptions={{ setValueAs: (v: string) => (v === '' ? undefined : v) }}
              />
              <SelectField
                form={form}
                name="sectionId"
                label="Section"
                options={sectionOptions}
                placeholder={academicYearId ? 'Any section' : 'Choose a year first'}
                allowEmpty
                optional
                disabled={!academicYearId || !canViewSections}
                registerOptions={{ setValueAs: (v: string) => (v === '' ? undefined : v) }}
              />

              <DateField
                form={form}
                name="billingPeriodStart"
                label="Billing period starts"
                required
              />
              <DateField form={form} name="billingPeriodEnd" label="Billing period ends" required />
              <DateField form={form} name="issueDate" label="Issue date" required />
              <DateField
                form={form}
                name="dueDate"
                label="Due date"
                required
                hint="An invoice raised after its own due date is overdue from the first moment."
              />

              <FieldGridSpan>
                {/* A fieldset rather than a Field: several checkboxes sharing one name is a
                    group, and React Hook Form collects the checked values into an array — which
                    is exactly what `frequencies` is. */}
                <fieldset>
                  <legend className="label mb-1.5">
                    Which charges to bill
                    <span className="text-danger" aria-hidden="true">
                      {' '}
                      *
                    </span>
                  </legend>
                  <div className="flex flex-wrap gap-x-5 gap-y-2">
                    {FEE_FREQUENCIES.map((frequency) => (
                      <label key={frequency} className="flex items-center gap-2 text-base">
                        <Checkbox
                          value={frequency}
                          aria-invalid={frequencyError ? true : undefined}
                          {...form.register('frequencies')}
                        />
                        {humanize(frequency)}
                      </label>
                    ))}
                  </div>
                  <p className="mt-1 text-xs text-content-muted">
                    A monthly round picks up the monthly items on each student&rsquo;s fee plan.
                  </p>
                  {frequencyError ? (
                    <p role="alert" className="mt-1 text-xs font-medium text-danger">
                      {frequencyError}
                    </p>
                  ) : null}
                </fieldset>
              </FieldGridSpan>

              <FieldGridSpan>
                <CheckboxField
                  form={form}
                  name="includeOptional"
                  label="Include optional items"
                  hint="Transport and hostel are opt-in charges, excluded unless you ask for them."
                />
              </FieldGridSpan>

              <FieldGridSpan>
                <TextAreaField
                  form={form}
                  name="notes"
                  label="Note on every invoice"
                  optional
                  registerOptions={{ setValueAs: (v: string) => (v === '' ? undefined : v) }}
                />
              </FieldGridSpan>
            </FieldGrid>

            <FormActions align="between">
              <Button href="/fees">Cancel</Button>
              <Button
                type="submit"
                variant="primary"
                loading={runPreview.isPending}
                loadingLabel="Working out the round…"
              >
                Preview this round
              </Button>
            </FormActions>
          </Form>
        </CardBody>
      </Card>

      {committed ? (
        <RunResult
          result={committed}
          title="Invoices generated"
          description="These invoices are now live and visible to the families they belong to."
        />
      ) : null}

      {preview && previewedValues ? (
        <>
          <RunResult
            result={preview}
            title="Preview"
            description="Nothing has been written. Read the skipped list before committing."
          />
          <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              onClick={() => {
                setPreview(null);
                setPreviewedValues(null);
              }}
            >
              Discard preview
            </Button>
            <Button
              variant="primary"
              onClick={() => setConfirming(true)}
              disabled={preview.totals.invoiceCount === 0}
            >
              Generate {formatCount(preview.totals.invoiceCount, 'invoice')}
            </Button>
          </div>
        </>
      ) : null}

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        variant="primary"
        title="Commit this billing round?"
        confirmLabel="Generate invoices"
        body={
          preview ? (
            <div className="space-y-2">
              <p>
                <strong className="text-content">
                  {formatCount(preview.totals.invoiceCount, 'invoice')}
                </strong>{' '}
                totalling{' '}
                <strong className="text-content">{formatMoney(preview.totals.total)}</strong> will
                be raised.{' '}
                {preview.skipped.length > 0
                  ? `${formatCount(preview.skipped.length, 'student')} will be skipped.`
                  : 'No students will be skipped.'}
              </p>
              <p>
                Invoices are visible to families as soon as they exist. A mistake is corrected by
                voiding each invoice with a reason, which is recorded against your name.
              </p>
            </div>
          ) : null
        }
        onConfirm={async () => {
          await runGenerate.mutateAsync(previewedValues!);
        }}
      />
    </div>
  );
}

function RunResult({
  result,
  title,
  description,
}: {
  result: GenerationResult;
  title: string;
  description: string;
}) {
  return (
    <section className="mb-5">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            {title}
            {result.committed ? (
              <Badge tone="success" className="ml-2">
                Committed
              </Badge>
            ) : (
              <Badge tone="info" className="ml-2">
                Nothing written
              </Badge>
            )}
          </h2>
          <p className="mt-0.5 text-sm text-content-muted">{description}</p>
        </div>
      </div>

      <StatGrid className="mb-4">
        <MetricCard label="Invoices" value={formatNumber(result.totals.invoiceCount)} />
        <MetricCard label="Subtotal" value={formatMoney(result.totals.subtotal)} />
        <MetricCard label="Discounts" value={formatMoney(result.totals.discountTotal)} />
        <MetricCard label="Total billed" value={formatMoney(result.totals.total)} />
      </StatGrid>

      <h3 className="mb-2 text-base font-semibold">Students who will be billed</h3>
      <DataTable<PreparedInvoice>
        caption="Students included in this billing round"
        rows={result.invoices}
        rowKey={(row) => row.studentId}
        minWidth="40rem"
        className="mb-5"
        empty={{
          title: 'Nobody would be billed',
          description:
            'No student in this scope has an active fee plan with items at the chosen frequencies. Check the skipped list below for the reason against each student.',
        }}
        columns={[
          {
            id: 'student',
            header: 'Student',
            card: 'title',
            render: (row) => row.studentName,
          },
          {
            id: 'invoiceNumber',
            header: 'Invoice',
            card: 'subtitle',
            className: 'font-mono text-xs',
            // Only a committed run has a number; a preview writes nothing, so it has none.
            render: (row) => row.invoiceNumber ?? '—',
          },
          {
            id: 'lines',
            header: 'Charges',
            hideBelow: 'md',
            card: 'meta',
            render: (row) => formatCount(row.lines.length, 'line'),
          },
          {
            id: 'subtotal',
            header: 'Subtotal',
            align: 'right',
            hideBelow: 'md',
            card: 'row',
            className: 'tabular-nums text-content-muted',
            render: (row) => formatMoney(row.subtotal),
          },
          {
            id: 'discount',
            header: 'Discount',
            align: 'right',
            card: 'row',
            className: 'tabular-nums text-content-muted',
            render: (row) => formatMoney(row.discountTotal),
          },
          {
            id: 'total',
            header: 'Total',
            align: 'right',
            card: 'aside',
            className: 'tabular-nums font-medium',
            render: (row) => formatMoney(row.total),
          },
        ]}
      />

      <h3 className="mb-2 text-base font-semibold">
        Students who will be skipped
        {result.skipped.length > 0 ? ` (${result.skipped.length})` : ''}
      </h3>
      <DataTable<SkippedStudent>
        caption="Students excluded from this billing round, and why"
        rows={result.skipped}
        rowKey={(row) => row.studentId}
        minWidth="34rem"
        empty={{
          title: 'Nobody is skipped',
          description: 'Every student in this scope has a fee plan that applies to the period.',
        }}
        columns={[
          { id: 'student', header: 'Student', card: 'title', render: (row) => row.studentName },
          {
            id: 'reason',
            header: 'Reason',
            card: 'row',
            render: (row) => <span className="text-content-muted">{row.reason}</span>,
          },
          {
            id: 'existing',
            header: 'Existing invoice',
            card: 'aside',
            render: (row) =>
              row.existingInvoiceId ? (
                <Link
                  href={`/fees/invoices/${row.existingInvoiceId}`}
                  className="text-accent-700 hover:underline"
                >
                  View invoice
                </Link>
              ) : (
                <span className="text-content-subtle">—</span>
              ),
          },
        ]}
      />
    </section>
  );
}
