'use client';

/**
 * One admission application: who applied, what was submitted, and every decision taken on it.
 *
 * The decision trail is the reason this screen exists. `statusReason` is mandatory on every
 * manual move (`reasonSchema`, 10 characters minimum), and each offer is a row rather than an
 * edit — a re-offer after a decline creates a new record — so the offers table below is a
 * history, not a current state. Nothing here is summarised away.
 *
 * The stage picker offers only the moves the service's state machine allows from the current
 * status, minus the offer-chain states, which belong to the offer screen because that is where
 * the seat check lives. Decision targets (`selected`, `waitlisted`, `rejected`) are dropped for
 * a caller without `admissions.applications.decide` — the service refuses them with a 403 and
 * an unusable option is worse than no option.
 */

import { use, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { transitionAdmissionApplicationSchema } from '@shikkha/validation';
import { useSession } from '@/lib/session';
import { formatDate, formatInstant, formatInstantDate, humanize } from '@/lib/format';
import { academicApi } from '@/components/academic/api';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  DataTable,
  DescriptionList,
  Dialog,
  ErrorNotice,
  Form,
  FormActions,
  IconButton,
  PageHeader,
  SkeletonCard,
  TextAreaField,
  SelectField,
  toneForStatus,
  useConfirm,
  useToast,
  formatMoney,
} from '@/components/ui';
import {
  admissionsApi,
  DECISION_TARGETS,
  MANUAL_TRANSITIONS,
  type AdmissionApplicationDetail,
  type AdmissionDocument,
  type AdmissionOffer,
  type AdmissionTestResult,
} from '@/components/admissions/api';

export default function AdmissionApplicationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const session = useSession();
  const institutionId = session.institutionId;

  const application = useQuery({
    queryKey: ['admission-application', id, institutionId],
    queryFn: () => admissionsApi.application(institutionId!, id),
    enabled: Boolean(institutionId),
  });

  if (application.isError) {
    return (
      <div className="mx-auto max-w-4xl">
        <ErrorNotice error={application.error} />
        <Button className="mt-4" href="/admissions">
          Back to admissions
        </Button>
      </div>
    );
  }

  if (application.isLoading || !application.data) {
    return (
      <div className="mx-auto max-w-4xl">
        <SkeletonCard lines={8} label="Loading the application" />
      </div>
    );
  }

  return <ApplicationDetail id={id} application={application.data} />;
}

function ApplicationDetail({
  id,
  application,
}: {
  id: string;
  application: AdmissionApplicationDetail;
}) {
  const session = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const institutionId = session.institutionId!;
  const [transitionOpen, setTransitionOpen] = useState(false);
  const verifying = useConfirm<AdmissionDocument>();

  const canReview = session.can('admissions.applications.review');
  const canDecide = session.can('admissions.applications.decide');
  const canWorkOffers = canDecide || session.can('admissions.enroll');

  const admissionSession = useQuery({
    queryKey: ['admission-session', application.sessionId, institutionId],
    queryFn: () => admissionsApi.session(institutionId, application.sessionId),
  });

  const classLevels = useQuery({
    queryKey: ['class-levels', institutionId],
    queryFn: () => academicApi.classLevels(institutionId),
    enabled: session.can('academic.classes.view'),
  });
  const classLevel = classLevels.data?.find((level) => level.id === application.classLevelId);

  const verifyDocument = useMutation({
    mutationFn: (documentId: string) => admissionsApi.verifyDocument(institutionId, documentId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admission-application', id] });
      toast.success('Document verified');
    },
  });

  // Targets the state machine allows from here, narrowed to what this caller may actually do.
  const targets = MANUAL_TRANSITIONS[application.status].filter(
    (target) => canDecide || !DECISION_TARGETS.has(target),
  );

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        breadcrumbs={[{ label: 'Admissions', href: '/admissions' }, { label: 'Application' }]}
        title={application.applicantNameEn}
        titleBn={application.applicantNameBn}
        meta={
          <>
            <Badge tone={toneForStatus(application.status)}>{humanize(application.status)}</Badge>
            <span className="font-mono text-xs text-content-subtle">
              {application.applicationNumber}
            </span>
            {admissionSession.data ? (
              <span className="text-content-muted">{admissionSession.data.nameEn}</span>
            ) : null}
            {classLevel ? <span className="text-content-muted">{classLevel.nameEn}</span> : null}
            <span className="text-content-muted">{humanize(application.source)}</span>
          </>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {(canReview || canDecide) && targets.length > 0 ? (
              <Button onClick={() => setTransitionOpen(true)}>Move to another stage</Button>
            ) : null}
            {canWorkOffers ? (
              <Button variant="primary" href={`/admissions/${id}/offer`}>
                Offer and enrolment
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="space-y-4">
        {application.studentId ? (
          <Card as="section" padded>
            <p className="text-sm">
              This applicant has been enrolled.{' '}
              <Link
                className="font-medium text-accent-700 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                href={`/students/${application.studentId}`}
              >
                Open the student record
              </Link>
              .
            </p>
          </Card>
        ) : null}

        <Card as="section">
          <CardHeader title="Current stage" headingLevel="h2" />
          <CardBody>
            <DescriptionList
              items={[
                { label: 'Stage', value: humanize(application.status) },
                {
                  label: 'Changed',
                  value: application.statusChangedAt
                    ? formatInstant(application.statusChangedAt)
                    : null,
                  emptyText: 'Not moved since submission',
                },
                {
                  label: 'Reason recorded',
                  value: application.statusReason,
                  span: true,
                  emptyText: 'No reason recorded',
                },
              ]}
            />
          </CardBody>
        </Card>

        <Card as="section">
          <CardHeader title="Applicant" headingLevel="h2" />
          <CardBody>
            <DescriptionList
              items={[
                { label: 'Name', value: application.applicantNameEn },
                {
                  label: 'Name (Bangla)',
                  value: application.applicantNameBn ? (
                    <span lang="bn">{application.applicantNameBn}</span>
                  ) : null,
                },
                { label: 'Date of birth', value: formatDate(application.dateOfBirth) },
                { label: 'Gender', value: humanize(application.gender) },
                {
                  label: 'Birth registration',
                  value: application.birthRegistrationNumber,
                },
                { label: 'Quota', value: application.quota ? humanize(application.quota) : null, emptyText: 'General' },
                { label: 'Submitted', value: formatInstant(application.submittedAt) },
              ]}
            />
          </CardBody>
        </Card>

        <Card as="section">
          <CardHeader title="Previous school" headingLevel="h2" />
          <CardBody>
            <DescriptionList
              items={[
                { label: 'Institution', value: application.previousSchoolName },
                { label: 'Class completed', value: application.previousClassCompleted },
                {
                  label: 'GPA',
                  // A GPA is a recorded string on the 5.00 scale, not money and not a number
                  // to compute with. It is shown exactly as it was submitted.
                  value: application.previousResultGpa,
                },
              ]}
            />
          </CardBody>
        </Card>

        <Card as="section">
          <CardHeader title="Guardian" headingLevel="h2" />
          <CardBody>
            <DescriptionList
              items={[
                { label: 'Name', value: application.guardianNameEn },
                {
                  label: 'Name (Bangla)',
                  value: application.guardianNameBn ? (
                    <span lang="bn">{application.guardianNameBn}</span>
                  ) : null,
                },
                { label: 'Relation', value: humanize(application.guardianRelation) },
                { label: 'Mobile', value: application.guardianPhone },
                { label: 'Email', value: application.guardianEmail },
                { label: 'National ID', value: application.guardianNid },
                { label: 'Present address', value: application.presentAddress, span: true },
              ]}
            />
          </CardBody>
        </Card>

        <Card as="section">
          <CardHeader
            title="Documents"
            headingLevel="h2"
            description="Verification records that a member of staff checked the paper against the original."
          />
          <CardBody padded={false}>
            <DataTable
              caption="Documents attached to this application"
              rows={application.documents}
              rowKey={(row) => row.id}
              empty={{
                title: 'No documents attached',
                description:
                  'Documents attached to this application by the office will be listed here.',
              }}
              columns={[
                { id: 'title', header: 'Document', card: 'title', render: (row) => row.title },
                {
                  id: 'type',
                  header: 'Type',
                  card: 'subtitle',
                  render: (row) => humanize(row.documentType),
                },
                {
                  id: 'verified',
                  header: 'Verified',
                  card: 'aside',
                  render: (row) =>
                    row.verifiedAt ? (
                      <Badge tone="success">{formatInstantDate(row.verifiedAt)}</Badge>
                    ) : (
                      <Badge tone="warning">Not verified</Badge>
                    ),
                },
              ]}
              actions={
                canReview
                  ? (row) =>
                      row.verifiedAt ? null : (
                        <IconButton
                          label={`Verify ${row.title}`}
                          size="sm"
                          icon={<CheckIcon />}
                          onClick={() => verifying.ask(row)}
                        />
                      )
                  : undefined
              }
              minWidth="32rem"
            />
          </CardBody>
        </Card>

        {application.testResults.length > 0 ? (
          <Card as="section">
            <CardHeader title="Admission test results" headingLevel="h2" />
            <CardBody padded={false}>
              <TestResultsTable results={application.testResults} />
            </CardBody>
          </Card>
        ) : null}

        {application.interview ? (
          <Card as="section">
            <CardHeader title="Interview" headingLevel="h2" />
            <CardBody>
              <DescriptionList
                items={[
                  { label: 'Panel', value: application.interview.panelName },
                  {
                    label: 'Scheduled',
                    value: formatInstant(application.interview.scheduledAt),
                  },
                  {
                    label: 'Score',
                    value: application.interview.score,
                    emptyText: 'Not scored yet',
                  },
                  {
                    label: 'Scored',
                    value: application.interview.scoredAt
                      ? formatInstant(application.interview.scoredAt)
                      : null,
                    emptyText: 'Not scored yet',
                  },
                  { label: 'Remarks', value: application.interview.remarks, span: true },
                ]}
              />
            </CardBody>
          </Card>
        ) : null}

        <Card as="section">
          <CardHeader
            title="Offers"
            headingLevel="h2"
            description="Every offer ever made on this application. A re-offer is a new row, so the history stays intact."
          />
          <CardBody padded={false}>
            <OffersTable offers={application.offers} />
          </CardBody>
        </Card>
      </div>

      <TransitionDialog
        open={transitionOpen}
        onClose={() => setTransitionOpen(false)}
        applicationId={id}
        institutionId={institutionId}
        targets={targets}
        onDone={() => {
          void queryClient.invalidateQueries({ queryKey: ['admission-application', id] });
          void queryClient.invalidateQueries({ queryKey: ['admission-applications'] });
          setTransitionOpen(false);
          toast.success('Stage updated');
        }}
        onError={(error) => toast.error(error)}
      />

      <ConfirmDialog
        open={verifying.isOpen}
        onClose={verifying.close}
        variant="primary"
        title="Verify this document"
        confirmLabel="Mark verified"
        body={
          <>
            Confirm that <strong>{verifying.target?.title}</strong> has been checked against the
            original. Verification is recorded against your name and cannot be undone.
          </>
        }
        onConfirm={async () => {
          if (verifying.target) await verifyDocument.mutateAsync(verifying.target.id);
        }}
      />
    </div>
  );
}

function TestResultsTable({ results }: { results: AdmissionTestResult[] }) {
  return (
    <DataTable
      caption="Admission test results for this applicant"
      rows={results}
      rowKey={(row) => row.id}
      empty={{ title: 'No results', description: 'No admission test results have been entered.' }}
      columns={[
        { id: 'test', header: 'Test', card: 'title', render: (row) => row.testName },
        {
          id: 'marks',
          header: 'Marks',
          align: 'right',
          card: 'aside',
          className: 'tabular-nums',
          // Marks are decimal strings; they are displayed as recorded, never recomputed here.
          render: (row) =>
            row.isAbsent ? (
              <Badge tone="danger">Absent</Badge>
            ) : (
              `${row.marksObtained ?? '—'} / ${row.totalMarks}`
            ),
        },
        {
          id: 'pass',
          header: 'Pass mark',
          align: 'right',
          card: 'meta',
          className: 'tabular-nums text-content-muted',
          render: (row) => row.passMarks,
        },
      ]}
      minWidth="28rem"
    />
  );
}

function OffersTable({ offers }: { offers: AdmissionOffer[] }) {
  return (
    <DataTable
      caption="Offers made on this application"
      rows={offers}
      rowKey={(row) => row.id}
      empty={{
        title: 'No offer has been made',
        description: 'When a seat is offered to this applicant it will be recorded here.',
      }}
      columns={[
        {
          id: 'status',
          header: 'Offer',
          card: 'title',
          render: (row) => <Badge tone={toneForStatus(row.status)}>{humanize(row.status)}</Badge>,
        },
        {
          id: 'offeredAt',
          header: 'Offered',
          card: 'meta',
          className: 'tabular-nums text-content-muted',
          render: (row) => formatInstant(row.offeredAt),
        },
        {
          id: 'expiresAt',
          header: 'Expires',
          card: 'meta',
          className: 'tabular-nums text-content-muted',
          render: (row) => formatInstant(row.expiresAt),
        },
        {
          id: 'feeDue',
          header: 'Fee due',
          align: 'right',
          card: 'aside',
          className: 'tabular-nums',
          // Money arrives as a decimal string and is only ever formatted, never parsed.
          render: (row) => formatMoney(row.feeDue),
        },
        {
          id: 'notes',
          header: 'Notes',
          card: 'row',
          hideBelow: 'lg',
          render: (row) => <span className="text-content-muted">{row.notes ?? '—'}</span>,
        },
      ]}
      minWidth="44rem"
    />
  );
}

function TransitionDialog({
  open,
  onClose,
  onDone,
  onError,
  applicationId,
  institutionId,
  targets,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  onError: (error: unknown) => void;
  applicationId: string;
  institutionId: string;
  targets: string[];
}) {
  type Values = z.input<typeof transitionAdmissionApplicationSchema>;
  const form = useForm<Values>({
    resolver: zodResolver(transitionAdmissionApplicationSchema),
    defaultValues: { status: targets[0] as Values['status'], reason: '' },
  });

  const move = useMutation({
    mutationFn: (values: Values) =>
      admissionsApi.transition(institutionId, applicationId, values),
    onSuccess: onDone,
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Move this application"
      description="Only the moves the admission state machine allows from the current stage are listed."
      closeOnBackdropClick={false}
    >
      <Form
        form={form}
        onSubmit={async (values) => {
          await move.mutateAsync(values);
        }}
        onError={onError}
      >
        <SelectField
          form={form}
          name="status"
          label="New stage"
          required
          options={targets.map((value) => ({ value, label: humanize(value) }))}
        />
        <TextAreaField
          form={form}
          name="reason"
          label="Why?"
          required
          rows={4}
          hint="At least 10 characters. Every movement of a child's application is a decision someone made, and this is the record of why."
        />
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={move.isPending}>
            Move application
          </Button>
        </FormActions>
      </Form>
    </Dialog>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4">
      <path
        d="M4 10.5 8 14.5 16 6"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
