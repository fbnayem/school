'use client';

/**
 * One employee.
 *
 * Two permission rules shape what is on screen, and both are the API's:
 *
 *  - **Payroll-adjacent fields are redacted server-side.** `HrService.redactSensitive` nulls the
 *    National ID and the bank and mobile-banking columns for a caller without
 *    `payroll.payslips.view.all`, returning the same row shape either way. So the "Payroll
 *    details" section is rendered from what arrived, with a visible marker that it is
 *    restricted — this component never re-implements the rule, which is how two copies of it
 *    end up disagreeing.
 *  - **Documents need `hr.documents.view`**, which is a separate permission from reading the
 *    profile: a personnel file holds medical certificates and police clearances, and the
 *    directory does not. The tab is not rendered without it rather than rendered and 403'd.
 *
 * Salary is offered when the caller holds `payroll.payslips.view.all`, or when this is their own
 * record and they hold `…view.own` — exactly the pair the route accepts.
 */

import { use, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/lib/session';
import { formatDate, formatInstantDate, formatNumber, humanize } from '@/lib/format';
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
  SectionHeading,
  SkeletonCard,
  StatusBadge,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  toneForStatus,
  useConfirm,
  useToast,
  formatMoney,
} from '@/components/ui';
import {
  hrApi,
  SEPARATION_STATUSES,
  type Employee,
  type EmployeeDependent,
  type EmployeeDocument,
  type EmployeeExperience,
  type EmployeeQualification,
  type EmploymentContract,
} from '@/components/hr/api';
import { ContractDialog, StatusDialog, TerminateContractDialog } from '@/components/hr/forms';
import {
  DependentDialog,
  ExperienceDialog,
  QualificationDialog,
} from '@/components/hr/profile-dialogs';

export default function EmployeePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const session = useSession();
  const institutionId = session.institutionId;

  const employee = useQuery({
    queryKey: ['hr-employee', id, institutionId],
    queryFn: () => hrApi.employee(institutionId!, id),
    enabled: Boolean(institutionId),
  });

  if (employee.isError) {
    return (
      <div className="mx-auto max-w-4xl">
        <ErrorNotice error={employee.error} />
        <Button className="mt-4" href="/hr">
          Back to staff
        </Button>
      </div>
    );
  }

  if (employee.isLoading || !employee.data) {
    return (
      <div className="mx-auto max-w-4xl">
        <SkeletonCard lines={8} label="Loading the employee record" />
      </div>
    );
  }

  return <EmployeeDetail id={id} employee={employee.data} />;
}

function EmployeeDetail({ id, employee }: { id: string; employee: Employee }) {
  const session = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const institutionId = session.institutionId!;

  const [tab, setTab] = useState('profile');
  const [statusOpen, setStatusOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);

  const canUpdate = session.can('hr.employees.update');
  const canManageExit = session.can('hr.exit.manage');
  const canArchive = session.can('hr.employees.archive');
  const canViewDocuments = session.can('hr.documents.view');
  const canManageContracts = session.can('hr.contracts.manage');
  const isOwnRecord = session.user?.employeeId === id;
  const canViewSalary =
    session.can('payroll.payslips.view.all') ||
    (isOwnRecord && session.can('payroll.payslips.view.own'));

  const departments = useQuery({
    queryKey: ['hr-departments', { institutionId, all: true }],
    queryFn: () => hrApi.departments(institutionId, { page: 1, pageSize: 200 }),
  });
  const designations = useQuery({
    queryKey: ['hr-designations', { institutionId, all: true }],
    queryFn: () => hrApi.designations(institutionId, { page: 1, pageSize: 200 }),
  });

  const department = departments.data?.data.find((row) => row.id === employee.departmentId);
  const designation = designations.data?.data.find((row) => row.id === employee.designationId);

  const isSeparated = SEPARATION_STATUSES.includes(employee.employmentStatus);

  const archive = useMutation({
    mutationFn: (reason: string) => hrApi.archiveEmployee(institutionId, id, { reason }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['hr-employee', id] });
      void queryClient.invalidateQueries({ queryKey: ['hr-employees'] });
      toast.success('Employee archived');
      setArchiveOpen(false);
    },
  });

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        breadcrumbs={[{ label: 'Staff', href: '/hr' }, { label: employee.fullNameEn }]}
        title={employee.fullNameEn}
        titleBn={employee.fullNameBn}
        meta={
          <>
            <StatusBadge status={employee.employmentStatus} />
            <span className="font-mono text-xs text-content-subtle">{employee.employeeCode}</span>
            {designation ? <span className="text-content-muted">{designation.nameEn}</span> : null}
            {department ? <span className="text-content-muted">{department.nameEn}</span> : null}
            {employee.archivedAt ? <Badge tone="danger">Archived</Badge> : null}
          </>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {(canUpdate || canManageExit) && !employee.archivedAt ? (
              <Button onClick={() => setStatusOpen(true)}>Change status</Button>
            ) : null}
            {/* Archiving is refused until the person has been separated — the separation is the
                audited lifecycle event, archiving is only the tidy-up. So the control appears
                only once that has happened. */}
            {canArchive && isSeparated && !employee.archivedAt ? (
              <Button variant="danger" onClick={() => setArchiveOpen(true)}>
                Archive record
              </Button>
            ) : null}
          </div>
        }
      />

      <Tabs value={tab} onValueChange={setTab} activation="manual">
        <TabList label="Employee record" className="mb-4">
          <Tab value="profile">Profile</Tab>
          <Tab value="qualifications">Qualifications</Tab>
          <Tab value="experience">Experience</Tab>
          <Tab value="dependents">Dependents</Tab>
          {canViewDocuments ? <Tab value="documents">Documents</Tab> : null}
          {canManageContracts ? <Tab value="contracts">Contracts</Tab> : null}
          {canViewSalary ? <Tab value="salary">Salary</Tab> : null}
        </TabList>

        <TabPanel value="profile">
          <ProfilePanel
            employee={employee}
            departmentName={department?.nameEn ?? null}
            designationName={designation?.nameEn ?? null}
          />
        </TabPanel>

        <TabPanel value="qualifications">
          <QualificationsPanel institutionId={institutionId} employeeId={id} canEdit={canUpdate} />
        </TabPanel>

        <TabPanel value="experience">
          <ExperiencePanel institutionId={institutionId} employeeId={id} canEdit={canUpdate} />
        </TabPanel>

        <TabPanel value="dependents">
          <DependentsPanel institutionId={institutionId} employeeId={id} canEdit={canUpdate} />
        </TabPanel>

        {canViewDocuments ? (
          <TabPanel value="documents">
            <DocumentsPanel institutionId={institutionId} employeeId={id} canVerify={canUpdate} />
          </TabPanel>
        ) : null}

        {canManageContracts ? (
          <TabPanel value="contracts">
            <ContractsPanel institutionId={institutionId} employeeId={id} />
          </TabPanel>
        ) : null}

        {canViewSalary ? (
          <TabPanel value="salary">
            <SalaryPanel institutionId={institutionId} employeeId={id} />
          </TabPanel>
        ) : null}
      </Tabs>

      <StatusDialog
        open={statusOpen}
        onClose={() => setStatusOpen(false)}
        institutionId={institutionId}
        employee={employee}
        canManageExit={canManageExit}
      />

      <ConfirmDialog
        open={archiveOpen}
        onClose={() => setArchiveOpen(false)}
        requireReason
        title="Archive this employee record"
        confirmLabel="Archive record"
        body={
          <>
            <strong>{employee.fullNameEn}</strong> will be hidden from the directory. The record
            is kept — nothing is deleted — and the employee code becomes reusable.
          </>
        }
        onConfirm={async (reason) => {
          await archive.mutateAsync(reason);
        }}
      />
    </div>
  );
}

// ── Profile ───────────────────────────────────────────────────────────────────────────

function ProfilePanel({
  employee,
  departmentName,
  designationName,
}: {
  employee: Employee;
  departmentName: string | null;
  designationName: string | null;
}) {
  // These arrive null both when unrecorded and when the server redacted them. Showing the
  // section only when something came back is the honest rendering of "the server decided".
  const payrollFields = [
    employee.nationalId,
    employee.bankName,
    employee.bankAccountNumber,
    employee.bankBranch,
    employee.mobileBankingProvider,
    employee.mobileBankingNumber,
  ].some((value) => value !== null && value !== '');

  return (
    <div className="space-y-4">
      <Card as="section">
        <CardHeader title="Identity" headingLevel="h2" />
        <CardBody>
          <DescriptionList
            items={[
              { label: 'Name', value: employee.fullNameEn },
              {
                label: 'Name (Bangla)',
                value: employee.fullNameBn ? <span lang="bn">{employee.fullNameBn}</span> : null,
              },
              { label: "Father's name", value: employee.fatherNameEn },
              { label: "Mother's name", value: employee.motherNameEn },
              { label: 'Date of birth', value: formatDate(employee.dateOfBirth) },
              { label: 'Gender', value: employee.gender ? humanize(employee.gender) : null },
              { label: 'Blood group', value: employee.bloodGroup },
              { label: 'Religion', value: employee.religion ? humanize(employee.religion) : null },
              {
                label: 'Marital status',
                value: employee.maritalStatus ? humanize(employee.maritalStatus) : null,
              },
            ]}
          />
        </CardBody>
      </Card>

      <Card as="section">
        <CardHeader title="Contact" headingLevel="h2" />
        <CardBody>
          <DescriptionList
            items={[
              { label: 'Mobile', value: employee.phone },
              { label: 'Alternate number', value: employee.alternatePhone },
              { label: 'Email', value: employee.email },
              { label: 'Emergency contact', value: employee.emergencyContactName },
              { label: 'Emergency number', value: employee.emergencyContactPhone },
              { label: 'Present address', value: employee.presentAddress, span: true },
              { label: 'Permanent address', value: employee.permanentAddress, span: true },
            ]}
          />
        </CardBody>
      </Card>

      <Card as="section">
        <CardHeader title="Employment" headingLevel="h2" />
        <CardBody>
          <DescriptionList
            items={[
              { label: 'Employee code', value: employee.employeeCode },
              { label: 'Status', value: humanize(employee.employmentStatus) },
              { label: 'Type', value: humanize(employee.employmentType) },
              { label: 'Department', value: departmentName },
              { label: 'Designation', value: designationName },
              { label: 'Joined', value: formatDate(employee.joiningDate) },
              { label: 'Confirmed', value: formatDate(employee.confirmationDate) },
              { label: 'Resigned', value: formatDate(employee.resignationDate) },
              { label: 'Last working day', value: formatDate(employee.lastWorkingDate) },
              { label: 'Highest qualification', value: employee.qualificationSummary },
              { label: 'Specialisation', value: employee.specialization },
            ]}
          />
        </CardBody>
      </Card>

      {payrollFields ? (
        <Card as="section">
          <CardHeader
            title="Payroll details"
            headingLevel="h2"
            actions={<Badge tone="warning">Restricted</Badge>}
            description="Visible because you hold the permission to read payroll data. Access is logged."
          />
          <CardBody>
            <DescriptionList
              items={[
                { label: 'National ID', value: employee.nationalId },
                { label: 'Bank', value: employee.bankName },
                { label: 'Account number', value: employee.bankAccountNumber },
                { label: 'Branch', value: employee.bankBranch },
                {
                  label: 'Mobile banking',
                  value: employee.mobileBankingProvider
                    ? humanize(employee.mobileBankingProvider)
                    : null,
                },
                { label: 'Mobile banking number', value: employee.mobileBankingNumber },
              ]}
            />
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}

// ── Side-table panels ─────────────────────────────────────────────────────────────────

function QualificationsPanel({
  institutionId,
  employeeId,
  canEdit,
}: {
  institutionId: string;
  employeeId: string;
  canEdit: boolean;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const archiving = useConfirm<EmployeeQualification>();

  const qualifications = useQuery({
    queryKey: ['hr-qualifications', employeeId, institutionId],
    queryFn: () => hrApi.qualifications(institutionId, employeeId),
  });

  const archive = useMutation({
    mutationFn: (input: { id: string; reason: string }) =>
      hrApi.archiveQualification(institutionId, input.id, { reason: input.reason }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['hr-qualifications', employeeId] });
      toast.success('Qualification removed');
    },
  });

  return (
    <>
      <SectionHeading
        title="Qualifications"
        description="The academic record, as the certificates state it."
        actions={
          canEdit ? (
            <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
              Add qualification
            </Button>
          ) : null
        }
      />
      <DataTable
        caption="Qualifications"
        rows={qualifications.data ?? []}
        rowKey={(row) => row.id}
        isLoading={qualifications.isLoading}
        error={qualifications.error}
        empty={{
          title: 'No qualifications recorded',
          description: 'Degrees and certificates recorded against this employee appear here.',
        }}
        columns={[
          { id: 'degree', header: 'Degree', card: 'title', render: (row) => row.degree },
          {
            id: 'institution',
            header: 'Institution',
            card: 'subtitle',
            render: (row) => row.institutionName,
          },
          { id: 'field', header: 'Field', card: 'meta', render: (row) => row.fieldOfStudy ?? '—' },
          {
            id: 'year',
            header: 'Year',
            align: 'right',
            card: 'meta',
            className: 'tabular-nums',
            render: (row) => (row.yearCompleted === null ? '—' : formatNumber(row.yearCompleted)),
          },
          { id: 'grade', header: 'Grade', card: 'aside', render: (row) => row.grade ?? '—' },
        ]}
        actions={
          canEdit
            ? (row) => (
                <Button size="sm" variant="ghost" onClick={() => archiving.ask(row)}>
                  Remove
                </Button>
              )
            : undefined
        }
        minWidth="44rem"
      />

      <QualificationDialog
        open={open}
        onClose={() => setOpen(false)}
        institutionId={institutionId}
        employeeId={employeeId}
      />

      <ConfirmDialog
        open={archiving.isOpen}
        onClose={archiving.close}
        requireReason
        title="Remove this qualification"
        confirmLabel="Remove"
        body={
          <>
            <strong>{archiving.target?.degree}</strong> will be archived. The row is kept for the
            record; it stops appearing on the profile.
          </>
        }
        onConfirm={async (reason) => {
          if (archiving.target) await archive.mutateAsync({ id: archiving.target.id, reason });
          archiving.close();
        }}
      />
    </>
  );
}

function ExperiencePanel({
  institutionId,
  employeeId,
  canEdit,
}: {
  institutionId: string;
  employeeId: string;
  canEdit: boolean;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const archiving = useConfirm<EmployeeExperience>();

  const experience = useQuery({
    queryKey: ['hr-experience', employeeId, institutionId],
    queryFn: () => hrApi.experience(institutionId, employeeId),
  });

  const archive = useMutation({
    mutationFn: (input: { id: string; reason: string }) =>
      hrApi.archiveExperience(institutionId, input.id, { reason: input.reason }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['hr-experience', employeeId] });
      toast.success('Experience removed');
    },
  });

  return (
    <>
      <SectionHeading
        title="Previous employment"
        description="Where they worked before joining, as recorded from their certificates."
        actions={
          canEdit ? (
            <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
              Add experience
            </Button>
          ) : null
        }
      />
      <DataTable
        caption="Previous employment"
        rows={experience.data ?? []}
        rowKey={(row) => row.id}
        isLoading={experience.isLoading}
        error={experience.error}
        empty={{
          title: 'No previous employment recorded',
          description: 'Earlier engagements recorded against this employee appear here.',
        }}
        columns={[
          {
            id: 'organisation',
            header: 'Organisation',
            card: 'title',
            render: (row) => row.organisationName,
          },
          {
            id: 'designation',
            header: 'Designation',
            card: 'subtitle',
            render: (row) => row.designation,
          },
          {
            id: 'from',
            header: 'From',
            card: 'meta',
            className: 'tabular-nums text-content-muted',
            render: (row) => formatDate(row.fromDate),
          },
          {
            id: 'to',
            header: 'To',
            card: 'meta',
            className: 'tabular-nums text-content-muted',
            render: (row) => (row.toDate ? formatDate(row.toDate) : 'Until joining'),
          },
          {
            id: 'responsibilities',
            header: 'Responsibilities',
            card: 'row',
            hideBelow: 'lg',
            render: (row) => (
              <span className="text-content-muted">{row.responsibilities ?? '—'}</span>
            ),
          },
        ]}
        actions={
          canEdit
            ? (row) => (
                <Button size="sm" variant="ghost" onClick={() => archiving.ask(row)}>
                  Remove
                </Button>
              )
            : undefined
        }
        minWidth="48rem"
      />

      <ExperienceDialog
        open={open}
        onClose={() => setOpen(false)}
        institutionId={institutionId}
        employeeId={employeeId}
      />

      <ConfirmDialog
        open={archiving.isOpen}
        onClose={archiving.close}
        requireReason
        title="Remove this experience record"
        confirmLabel="Remove"
        body={
          <>
            <strong>{archiving.target?.organisationName}</strong> will be archived and stop
            appearing on the profile.
          </>
        }
        onConfirm={async (reason) => {
          if (archiving.target) await archive.mutateAsync({ id: archiving.target.id, reason });
          archiving.close();
        }}
      />
    </>
  );
}

function DependentsPanel({
  institutionId,
  employeeId,
  canEdit,
}: {
  institutionId: string;
  employeeId: string;
  canEdit: boolean;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const archiving = useConfirm<EmployeeDependent>();

  const dependents = useQuery({
    queryKey: ['hr-dependents', employeeId, institutionId],
    queryFn: () => hrApi.dependents(institutionId, employeeId),
  });

  const archive = useMutation({
    mutationFn: (input: { id: string; reason: string }) =>
      hrApi.archiveDependent(institutionId, input.id, { reason: input.reason }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['hr-dependents', employeeId] });
      toast.success('Dependent removed');
    },
  });

  return (
    <>
      <SectionHeading
        title="Dependents"
        description="Family members recorded for benefits and emergency contact."
        actions={
          canEdit ? (
            <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
              Add dependent
            </Button>
          ) : null
        }
      />
      <DataTable
        caption="Dependents"
        rows={dependents.data ?? []}
        rowKey={(row) => row.id}
        isLoading={dependents.isLoading}
        error={dependents.error}
        empty={{
          title: 'No dependents recorded',
          description: 'Family members recorded against this employee appear here.',
        }}
        columns={[
          {
            id: 'name',
            header: 'Name',
            card: 'title',
            render: (row) => (
              <BilingualNameCell nameEn={row.nameEn} nameBn={row.nameBn} />
            ),
          },
          {
            id: 'relation',
            header: 'Relation',
            card: 'subtitle',
            render: (row) => humanize(row.relation),
          },
          {
            id: 'dateOfBirth',
            header: 'Date of birth',
            card: 'meta',
            className: 'tabular-nums text-content-muted',
            render: (row) => (row.dateOfBirth ? formatDate(row.dateOfBirth) : '—'),
          },
        ]}
        actions={
          canEdit
            ? (row) => (
                <Button size="sm" variant="ghost" onClick={() => archiving.ask(row)}>
                  Remove
                </Button>
              )
            : undefined
        }
        minWidth="32rem"
      />

      <DependentDialog
        open={open}
        onClose={() => setOpen(false)}
        institutionId={institutionId}
        employeeId={employeeId}
      />

      <ConfirmDialog
        open={archiving.isOpen}
        onClose={archiving.close}
        requireReason
        title="Remove this dependent"
        confirmLabel="Remove"
        body={
          <>
            <strong>{archiving.target?.nameEn}</strong> will be archived and stop appearing on the
            profile.
          </>
        }
        onConfirm={async (reason) => {
          if (archiving.target) await archive.mutateAsync({ id: archiving.target.id, reason });
          archiving.close();
        }}
      />
    </>
  );
}

/** A dependent row carries `nameEn`/`nameBn`, so the shared bilingual renderer applies. */
function BilingualNameCell({ nameEn, nameBn }: { nameEn: string; nameBn: string | null }) {
  if (!nameBn) return <span className="font-medium">{nameEn}</span>;
  return (
    <span className="font-medium">
      {nameEn}{' '}
      <span lang="bn" className="font-normal text-content-muted">
        {nameBn}
      </span>
    </span>
  );
}

// ── Documents ─────────────────────────────────────────────────────────────────────────

function DocumentsPanel({
  institutionId,
  employeeId,
  canVerify,
}: {
  institutionId: string;
  employeeId: string;
  canVerify: boolean;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const verifying = useConfirm<EmployeeDocument>();

  const documents = useQuery({
    queryKey: ['hr-documents', employeeId, institutionId],
    queryFn: () => hrApi.documents(institutionId, employeeId),
  });

  const verify = useMutation({
    mutationFn: (documentId: string) => hrApi.verifyDocument(institutionId, documentId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['hr-documents', employeeId] });
      toast.success('Document verified');
    },
  });

  return (
    <>
      <SectionHeading
        title="Documents"
        description="The personnel file. Reading it is a separate permission from reading the directory, and the read is logged."
      />
      <DataTable
        caption="Employee documents"
        rows={documents.data?.data ?? []}
        rowKey={(row) => row.id}
        isLoading={documents.isLoading}
        error={documents.error}
        empty={{
          title: 'No documents on file',
          description: 'Documents uploaded against this employee appear here.',
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
            id: 'expires',
            header: 'Expires',
            card: 'meta',
            className: 'tabular-nums',
            render: (row) => <ExpiryCell expiresAt={row.expiresAt} />,
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
          canVerify
            ? (row) =>
                row.verifiedAt ? null : (
                  <Button size="sm" variant="ghost" onClick={() => verifying.ask(row)}>
                    Verify
                  </Button>
                )
            : undefined
        }
        minWidth="44rem"
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
          if (verifying.target) await verify.mutateAsync(verifying.target.id);
          verifying.close();
        }}
      />
    </>
  );
}

/** Expiry is a calendar-date comparison, done on the string so no timezone can shift the day. */
function ExpiryCell({ expiresAt }: { expiresAt: string | null }) {
  if (!expiresAt) return <span className="text-content-subtle">Does not expire</span>;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
  const lapsed = expiresAt <= today;
  return (
    <span className={lapsed ? 'font-medium text-danger' : 'text-content-muted'}>
      {formatDate(expiresAt)}
      {lapsed ? ' — lapsed' : ''}
    </span>
  );
}

// ── Contracts ─────────────────────────────────────────────────────────────────────────

function ContractsPanel({
  institutionId,
  employeeId,
}: {
  institutionId: string;
  employeeId: string;
}) {
  const [open, setOpen] = useState(false);
  const [terminating, setTerminating] = useState<string | null>(null);

  const contracts = useQuery({
    queryKey: ['hr-contracts', { institutionId, employeeId }],
    queryFn: () => hrApi.contracts(institutionId, { page: 1, pageSize: 50, employeeId }),
  });

  return (
    <>
      <SectionHeading
        title="Contracts"
        description="Two active contracts may not overlap in time; the API checks that in the same transaction as the write."
        actions={
          <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
            New contract
          </Button>
        }
      />
      <DataTable
        caption="Employment contracts for this employee"
        rows={contracts.data?.data ?? []}
        rowKey={(row) => row.id}
        isLoading={contracts.isLoading}
        error={contracts.error}
        empty={{
          title: 'No contracts recorded',
          description: 'A contract records the type, dates and notice period of an employment.',
        }}
        columns={[
          {
            id: 'type',
            header: 'Type',
            card: 'title',
            render: (row: EmploymentContract) => humanize(row.contractType),
          },
          {
            id: 'start',
            header: 'Starts',
            card: 'meta',
            className: 'tabular-nums text-content-muted',
            render: (row: EmploymentContract) => formatDate(row.startDate),
          },
          {
            id: 'end',
            header: 'Ends',
            card: 'meta',
            className: 'tabular-nums text-content-muted',
            render: (row: EmploymentContract) =>
              row.endDate ? formatDate(row.endDate) : 'Open-ended',
          },
          {
            id: 'probation',
            header: 'Probation ends',
            card: 'meta',
            hideBelow: 'lg',
            className: 'tabular-nums text-content-muted',
            render: (row: EmploymentContract) =>
              row.probationEndDate ? formatDate(row.probationEndDate) : '—',
          },
          {
            id: 'notice',
            header: 'Notice',
            align: 'right',
            card: 'meta',
            hideBelow: 'md',
            className: 'tabular-nums text-content-muted',
            render: (row: EmploymentContract) => `${row.noticePeriodDays} days`,
          },
          {
            id: 'status',
            header: 'Status',
            card: 'aside',
            render: (row: EmploymentContract) => (
              <Badge tone={toneForStatus(row.status)}>{humanize(row.status)}</Badge>
            ),
          },
        ]}
        actions={(row: EmploymentContract) =>
          row.status === 'active' ? (
            <Button size="sm" variant="ghost" onClick={() => setTerminating(row.id)}>
              Terminate
            </Button>
          ) : null
        }
        minWidth="52rem"
      />

      <ContractDialog
        open={open}
        onClose={() => setOpen(false)}
        institutionId={institutionId}
        employeeId={employeeId}
      />
      <TerminateContractDialog
        open={terminating !== null}
        onClose={() => setTerminating(null)}
        institutionId={institutionId}
        contractId={terminating}
      />
    </>
  );
}

// ── Salary ────────────────────────────────────────────────────────────────────────────

function SalaryPanel({
  institutionId,
  employeeId,
}: {
  institutionId: string;
  employeeId: string;
}) {
  const salary = useQuery({
    queryKey: ['hr-salary', employeeId, institutionId],
    queryFn: () => hrApi.salary(institutionId, employeeId),
    // A 404 here is the honest answer for "no salary assignment yet"; retrying it is noise.
    retry: false,
  });

  if (salary.isError) {
    return <ErrorNotice error={salary.error} />;
  }

  if (salary.isLoading || !salary.data) {
    return <SkeletonCard lines={6} label="Loading the salary breakdown" />;
  }

  const { structure, assignment, breakdown } = salary.data;

  return (
    <div className="space-y-4">
      <SectionHeading
        title="Salary"
        description="Computed by the API from the assigned structure. Every figure is a decimal string, formatted here and never recalculated."
      />

      <Card as="section">
        <CardHeader title={structure.nameEn} headingLevel="h2" />
        <CardBody>
          <DescriptionList
            items={[
              { label: 'Structure effective from', value: formatDate(structure.effectiveFrom) },
              { label: 'Assignment effective from', value: formatDate(assignment.effectiveFrom) },
              { label: 'Basic', value: formatMoney(breakdown.basic) },
              { label: 'Gross', value: formatMoney(breakdown.gross) },
              { label: 'Total deductions', value: formatMoney(breakdown.totalDeductions) },
              { label: 'Net', value: formatMoney(breakdown.net) },
            ]}
          />
        </CardBody>
      </Card>

      <Card as="section">
        <CardHeader title="Breakdown" headingLevel="h2" />
        <CardBody padded={false}>
          <DataTable
            caption="Salary components"
            rows={breakdown.lines}
            rowKey={(row) => `${row.type}:${row.componentId ?? row.nameEn}`}
            empty={{
              title: 'No components',
              description: 'This structure has no components beyond the basic.',
            }}
            columns={[
              { id: 'name', header: 'Component', card: 'title', render: (row) => row.nameEn },
              {
                id: 'type',
                header: 'Type',
                card: 'subtitle',
                render: (row) =>
                  row.type === 'earning' ? (
                    <Badge tone="success">Earning</Badge>
                  ) : (
                    <Badge tone="warning">Deduction</Badge>
                  ),
              },
              {
                id: 'basis',
                header: 'Basis',
                card: 'meta',
                hideBelow: 'md',
                render: (row) =>
                  row.rate === null ? 'Fixed' : `${row.rate}% of ${humanize(
                    row.calculation.replace('percentage_of_', ''),
                  ).toLowerCase()}`,
              },
              {
                id: 'amount',
                header: 'Amount',
                align: 'right',
                card: 'aside',
                className: 'tabular-nums',
                render: (row) => formatMoney(row.amount),
              },
            ]}
            minWidth="40rem"
          />
        </CardBody>
      </Card>

      <p className="text-sm text-content-muted">
        This is the breakdown for the structure currently assigned to this employee. A payslip
        for a particular month — with its attendance and its deductions — is produced by the
        payroll module, not from this page.
      </p>
    </div>
  );
}
