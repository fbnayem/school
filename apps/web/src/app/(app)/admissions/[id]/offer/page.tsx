'use client';

/**
 * Offer and enrolment for one application.
 *
 * This is the screen where an applicant becomes a student, so two things are stated plainly
 * rather than left to be discovered:
 *
 *  1. **Seats.** The counts come from the session's funnel report, computed in SQL. The API
 *     re-checks them under a `FOR UPDATE` lock on the session row at the moment of the
 *     decision, so two clerks accepting the last seat at the same time serialise and the second
 *     gets a 409 — what is shown here is the state a moment ago, and the confirmation says so.
 *  2. **Acceptance is irreversible.** It creates a student record, a guardian record and an
 *     enrolment through the owning services. The confirmation lists exactly those three things
 *     with the values that will be used, because "are you sure?" over an unnamed action is not
 *     a confirmation.
 *
 * `feeDue` is deliberately not pre-filled from the session's `applicationFee`: that is the
 * *form* fee the family already paid to apply, and the service defaults `feeDue` to `0.00`, not
 * to it. Pre-filling would invent an admission fee nobody set.
 */

import { use, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { acceptAdmissionOfferSchema, issueAdmissionOfferSchema } from '@shikkha/validation';
import { useSession } from '@/lib/session';
import { formatDate, formatInstant, humanize, todayInDhaka } from '@/lib/format';
import { academicApi } from '@/components/academic/api';
import {
  applyApiFieldErrors,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  DescriptionList,
  ErrorNotice,
  Form,
  FormActions,
  MetricCard,
  MoneyField,
  NumberField,
  PageHeader,
  SkeletonCard,
  StatGrid,
  TextAreaField,
  DateField,
  SelectField,
  TextField,
  toneForStatus,
  useToast,
  formatMoney,
} from '@/components/ui';
import {
  admissionsApi,
  type AdmissionApplicationDetail,
  type AdmissionOffer,
  type AdmissionSession,
} from '@/components/admissions/api';

/** Statuses from which the state machine allows an offer to be issued. */
const OFFERABLE = new Set(['selected', 'waitlisted', 'declined']);

export default function AdmissionOfferPage({ params }: { params: Promise<{ id: string }> }) {
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
        <SkeletonCard lines={6} label="Loading the application" />
      </div>
    );
  }

  return <OfferWorkspace id={id} application={application.data} />;
}

function OfferWorkspace({
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

  const canDecide = session.can('admissions.applications.decide');
  const canEnrol = session.can('admissions.enroll');

  const admissionSession = useQuery({
    queryKey: ['admission-session', application.sessionId, institutionId],
    queryFn: () => admissionsApi.session(institutionId, application.sessionId),
  });

  const funnel = useQuery({
    queryKey: ['admission-funnel', application.sessionId, institutionId],
    queryFn: () => admissionsApi.funnel(institutionId, application.sessionId),
  });

  const classLevels = useQuery({
    queryKey: ['class-levels', institutionId],
    queryFn: () => academicApi.classLevels(institutionId),
    enabled: session.can('academic.classes.view'),
  });

  const seats = funnel.data?.classLevels.find(
    (row) => row.classLevelId === application.classLevelId,
  );
  const classLevelName =
    classLevels.data?.find((level) => level.id === application.classLevelId)?.nameEn ?? null;

  // At most one live offer exists per application (a partial unique index enforces it), so
  // "the pending offer" is unambiguous.
  const pendingOffer = application.offers.find((offer) => offer.status === 'pending') ?? null;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['admission-application', id] });
    void queryClient.invalidateQueries({ queryKey: ['admission-funnel', application.sessionId] });
    void queryClient.invalidateQueries({ queryKey: ['admission-applications'] });
  };

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        breadcrumbs={[
          { label: 'Admissions', href: '/admissions' },
          { label: application.applicationNumber, href: `/admissions/${id}` },
          { label: 'Offer' },
        ]}
        title={`Offer — ${application.applicantNameEn}`}
        titleBn={application.applicantNameBn}
        meta={
          <>
            <Badge tone={toneForStatus(application.status)}>{humanize(application.status)}</Badge>
            {classLevelName ? <span className="text-content-muted">{classLevelName}</span> : null}
            {admissionSession.data ? (
              <span className="text-content-muted">{admissionSession.data.nameEn}</span>
            ) : null}
          </>
        }
      />

      <div className="space-y-4">
        <section aria-labelledby="seats-heading">
          <h2 id="seats-heading" className="sr-only">
            Seats for this class level
          </h2>
          {funnel.isError ? <ErrorNotice error={funnel.error} /> : null}
          <StatGrid>
            <MetricCard
              label="Seats configured"
              value={seats ? String(seats.seats) : null}
              detail={classLevelName ?? 'This class level'}
            />
            <MetricCard label="Accepted" value={seats ? String(seats.accepted) : null} />
            <MetricCard label="Enrolled" value={seats ? String(seats.enrolled) : null} />
            <MetricCard
              label="Seats remaining"
              value={seats ? String(seats.seatsRemaining) : null}
              tone={seats && seats.seatsRemaining === 0 ? 'danger' : 'default'}
              detail="Re-checked under a lock when the decision is taken"
            />
          </StatGrid>
        </section>

        {pendingOffer ? (
          <PendingOfferCard
            offer={pendingOffer}
            application={application}
            admissionSession={admissionSession.data ?? null}
            canDecide={canDecide}
            canEnrol={canEnrol}
            institutionId={institutionId}
            onDone={refresh}
          />
        ) : null}

        {!pendingOffer && canDecide && OFFERABLE.has(application.status) ? (
          <IssueOfferCard
            applicationId={id}
            institutionId={institutionId}
            seatsRemaining={seats?.seatsRemaining ?? null}
            onDone={() => {
              refresh();
              toast.success('Offer issued');
            }}
            onError={(error) => toast.error(error)}
          />
        ) : null}

        {!pendingOffer && !OFFERABLE.has(application.status) ? (
          <Card as="section" padded>
            <p className="text-sm text-content-muted">
              An offer can only be issued once the application has been selected or waitlisted.
              This one is {humanize(application.status).toLowerCase()}.
            </p>
          </Card>
        ) : null}

        {!pendingOffer && !canDecide && OFFERABLE.has(application.status) ? (
          <Card as="section" padded>
            <p className="text-sm text-content-muted">
              Issuing an offer is done by a member of staff holding the admission decision
              permission.
            </p>
          </Card>
        ) : null}

        {application.offers.length > 0 ? (
          <Card as="section">
            <CardHeader title="Offer history" headingLevel="h2" />
            <CardBody>
              <ol className="space-y-2">
                {application.offers.map((offer) => (
                  <li key={offer.id} className="rounded-md border border-line p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={toneForStatus(offer.status)}>{humanize(offer.status)}</Badge>
                      <span className="text-content-muted">
                        Offered {formatInstant(offer.offeredAt)}
                      </span>
                      <span className="text-content-muted">
                        Expires {formatInstant(offer.expiresAt)}
                      </span>
                      <span className="tabular-nums">{formatMoney(offer.feeDue)} due</span>
                    </div>
                    {offer.notes ? (
                      <p className="mt-1 text-content-muted">{offer.notes}</p>
                    ) : null}
                  </li>
                ))}
              </ol>
            </CardBody>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

// ── Issue ─────────────────────────────────────────────────────────────────────────────

function IssueOfferCard({
  applicationId,
  institutionId,
  seatsRemaining,
  onDone,
  onError,
}: {
  applicationId: string;
  institutionId: string;
  seatsRemaining: number | null;
  onDone: () => void;
  onError: (error: unknown) => void;
}) {
  type Values = z.input<typeof issueAdmissionOfferSchema>;
  const form = useForm<Values>({
    resolver: zodResolver(issueAdmissionOfferSchema),
    defaultValues: { expiresInDays: 7, feeDue: '', notes: '' },
  });

  const issue = useMutation({
    mutationFn: (values: Values) =>
      admissionsApi.issueOffer(institutionId, applicationId, values),
    onSuccess: onDone,
  });

  return (
    <Card as="section">
      <CardHeader
        title="Issue an offer"
        headingLevel="h2"
        description="The clock starts when the offer is issued. The API refuses an offer beyond the seat count for this class level."
      />
      <CardBody>
        {seatsRemaining === 0 ? (
          <p className="mb-3 rounded-md border border-line bg-warning-subtle px-3 py-2 text-sm text-warning">
            Every seat for this class level is already taken by an acceptance or an enrolment.
            The API will refuse this offer until a seat frees up.
          </p>
        ) : null}
        <Form
          form={form}
          onSubmit={async (values) => {
            await issue.mutateAsync(values);
          }}
          onError={onError}
        >
          <NumberField
            form={form}
            name="expiresInDays"
            label="Accept within"
            required
            suffix="days"
            min={1}
            max={90}
          />
          <MoneyField
            form={form}
            name="feeDue"
            label="Admission fee due on acceptance"
            optional
            hint="Leave blank to record no fee against this offer. This is not the application form fee."
            registerOptions={{ setValueAs: (value: unknown) => (value === '' ? undefined : value) }}
          />
          <TextAreaField form={form} name="notes" label="Notes for the family" optional rows={3} />
          <FormActions>
            <Button type="submit" variant="primary" loading={issue.isPending}>
              Issue offer
            </Button>
          </FormActions>
        </Form>
      </CardBody>
    </Card>
  );
}

// ── Accept / decline / expire ─────────────────────────────────────────────────────────

function PendingOfferCard({
  offer,
  application,
  admissionSession,
  canDecide,
  canEnrol,
  institutionId,
  onDone,
}: {
  offer: AdmissionOffer;
  application: AdmissionApplicationDetail;
  admissionSession: AdmissionSession | null;
  canDecide: boolean;
  canEnrol: boolean;
  institutionId: string;
  onDone: () => void;
}) {
  const session = useSession();
  const router = useRouter();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [expiring, setExpiring] = useState(false);

  const hasLapsed = new Date(offer.expiresAt).getTime() < Date.now();

  const sections = useQuery({
    queryKey: ['sections', institutionId, admissionSession?.academicYearId],
    queryFn: () => academicApi.sections(institutionId, admissionSession!.academicYearId),
    enabled: Boolean(admissionSession) && canEnrol && session.can('academic.sections.view'),
  });

  // Enrolment goes into a section of the class the applicant applied for; anything else would
  // put the child in the wrong class, so the picker is filtered rather than trusted.
  const sectionOptions = (sections.data ?? [])
    .filter((row) => row.classLevelId === application.classLevelId)
    .map((row) => ({
      value: row.id,
      label: `${row.classLevelName} — ${row.nameEn}`,
      hint:
        row.capacity === null
          ? `${row.enrolledCount} enrolled`
          : `${row.enrolledCount} of ${row.capacity} enrolled`,
    }));

  type Values = z.input<typeof acceptAdmissionOfferSchema>;
  const form = useForm<Values>({
    resolver: zodResolver(acceptAdmissionOfferSchema),
    defaultValues: { sectionId: '', rollNumber: '', admissionDate: todayInDhaka() },
  });

  const accept = useMutation({
    mutationFn: (values: Values) => admissionsApi.acceptOffer(institutionId, offer.id, values),
  });

  const decline = useMutation({
    mutationFn: (reason: string) =>
      admissionsApi.declineOffer(institutionId, offer.id, { reason }),
  });

  const expire = useMutation({
    mutationFn: () => admissionsApi.expireOffer(institutionId, offer.id),
  });

  const chosenSection = sectionOptions.find((option) => option.value === form.watch('sectionId'));

  return (
    <Card as="section">
      <CardHeader
        title="Pending offer"
        headingLevel="h2"
        description="The family has been offered a seat. Recording their answer here is what creates — or releases — the place."
      />
      <CardBody className="space-y-4">
        <DescriptionList
          items={[
            { label: 'Offered', value: formatInstant(offer.offeredAt) },
            {
              label: 'Expires',
              value: (
                <span className={hasLapsed ? 'text-danger' : undefined}>
                  {formatInstant(offer.expiresAt)}
                  {hasLapsed ? ' (lapsed)' : ''}
                </span>
              ),
            },
            { label: 'Fee due on acceptance', value: formatMoney(offer.feeDue) },
            { label: 'Notes', value: offer.notes, span: true },
          ]}
        />

        {canEnrol ? (
          <div className="border-t border-line pt-4">
            <h3 className="mb-3 text-base font-semibold tracking-tight">
              Accept and enrol the applicant
            </h3>
            <Form
              form={form}
              onSubmit={() => {
                // The submit does not enrol. It validates the placement, then opens the
                // confirmation, because this is the irreversible step and the person taking it
                // must see exactly what is about to be created.
                setConfirming(true);
              }}
              onError={(error) => toast.error(error)}
            >
              <SelectField
                form={form}
                name="sectionId"
                label="Section"
                required
                placeholder={
                  sections.isLoading ? 'Loading sections…' : 'Choose the section to enrol into'
                }
                options={sectionOptions}
                hint="Only sections of the class this applicant applied for are listed."
              />
              <TextField
                form={form}
                name="rollNumber"
                label="Roll number"
                required
                inputMode="numeric"
              />
              <DateField
                form={form}
                name="admissionDate"
                label="Admission date"
                required
                hint="The date the school treats as the start of this student's admission."
              />
              <FormActions>
                <Button type="submit" variant="primary">
                  Review and enrol
                </Button>
              </FormActions>
            </Form>
          </div>
        ) : null}

        {canDecide ? (
          <div className="flex flex-wrap gap-2 border-t border-line pt-4">
            <Button variant="danger" onClick={() => setDeclining(true)}>
              Family declined
            </Button>
            {/* Expiry is a fact about the clock: the API refuses it before the deadline, so the
                control only appears once the deadline has actually passed. */}
            {hasLapsed ? <Button onClick={() => setExpiring(true)}>Mark expired</Button> : null}
          </div>
        ) : null}
      </CardBody>

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        variant="primary"
        title="Create the student record and enrol"
        confirmLabel="Create and enrol"
        body={
          <div className="space-y-3 text-sm">
            <p>Accepting this offer is irreversible. It will create:</p>
            <ul className="space-y-2">
              <li className="rounded-md border border-line p-2">
                <span className="font-medium">A student record</span>
                <span className="mt-1 block text-content-muted">
                  {application.applicantNameEn}
                  {application.applicantNameBn ? (
                    <span lang="bn"> · {application.applicantNameBn}</span>
                  ) : null}{' '}
                  · born {formatDate(application.dateOfBirth)} ·{' '}
                  {humanize(application.gender)}
                </span>
              </li>
              <li className="rounded-md border border-line p-2">
                <span className="font-medium">A guardian record, or a link to an existing one</span>
                <span className="mt-1 block text-content-muted">
                  {application.guardianNameEn} · {humanize(application.guardianRelation)} ·{' '}
                  {application.guardianPhone} — matched on the mobile number, so an existing
                  guardian is reused rather than duplicated.
                </span>
              </li>
              <li className="rounded-md border border-line p-2">
                <span className="font-medium">An enrolment</span>
                <span className="mt-1 block text-content-muted">
                  {chosenSection ? chosenSection.label : 'the section you chose'} · roll{' '}
                  {form.watch('rollNumber')} · admitted{' '}
                  {formatDate(form.watch('admissionDate') ?? todayInDhaka())}
                </span>
              </li>
            </ul>
            <p className="text-content-muted">
              The seat is re-counted under a lock at this moment. If the last seat has just been
              taken by someone else, this will be refused and nothing will be created.
            </p>
          </div>
        }
        onConfirm={async () => {
          try {
            const result = await accept.mutateAsync(form.getValues());
            toast.success('Student created and enrolled');
            onDone();
            router.push(`/students/${result.studentId}`);
          } catch (error) {
            // A 422 belongs on the field that caused it, not in a confirmation dialog — so
            // attach it and let the dialog close so the form underneath is visible again.
            // Anything else (a 409 on the seat count) stays here with its request id.
            if (applyApiFieldErrors(error, form)) return;
            throw error;
          }
        }}
      />

      <ConfirmDialog
        open={declining}
        onClose={() => setDeclining(false)}
        title="Record that the family declined"
        requireReason
        reasonLabel="What did the family say?"
        confirmLabel="Record decline"
        body="The seat is released and the applicant returns to the declined state. A fresh offer can be made later if a seat is available."
        onConfirm={async (reason) => {
          await decline.mutateAsync(reason);
          toast.success('Decline recorded');
          onDone();
        }}
      />

      <ConfirmDialog
        open={expiring}
        onClose={() => setExpiring(false)}
        title="Mark this offer expired"
        confirmLabel="Mark expired"
        body="The offer lapsed without an answer. The applicant returns to the waitlist and the seat is freed for the next candidate."
        onConfirm={async () => {
          await expire.mutateAsync();
          toast.success('Offer marked expired');
          onDone();
        }}
      />
    </Card>
  );
}
