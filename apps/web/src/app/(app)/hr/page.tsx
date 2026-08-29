'use client';

/**
 * Human resources: the staff directory, and the structures it hangs off.
 *
 * Four tabs, because they are four different lists over four different endpoints rather than
 * four views of one. Inactive tab panels are unmounted, so switching does not leave four list
 * queries running; the contracts tab in particular needs `hr.contracts.manage` and is not
 * rendered at all without it — a tab whose every request 403s is not a feature.
 *
 * The headcount strip is the API's `reports/headcount`, computed in SQL. The attrition rate
 * arrives as a decimal string and is printed as one: dividing joiners by separations in the
 * browser would produce a second, quietly different number.
 */

import { useState } from 'react';
import Link from 'next/link';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/lib/session';
import { formatDate, formatNumber, humanize } from '@/lib/format';
import {
  Badge,
  BilingualName,
  Button,
  ConfirmDialog,
  DataTable,
  ErrorNotice,
  FilterBar,
  MetricCard,
  PageHeader,
  Pagination,
  StatGrid,
  StatusBadge,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  toneForStatus,
  useConfirm,
  useToast,
  type SelectOption,
} from '@/components/ui';
import { EMPLOYMENT_STATUSES } from '@shikkha/shared';
import { EMPLOYMENT_TYPES } from '@shikkha/validation';
import {
  hrApi,
  type Department,
  type Designation,
  type Employee,
  type EmploymentContract,
} from '@/components/hr/api';
import {
  ContractDialog,
  DepartmentDialog,
  DesignationDialog,
  EmployeeDialog,
  TerminateContractDialog,
} from '@/components/hr/forms';

const PAGE_SIZE = 25;
/** The API's own ceiling. Used where a whole small list is needed to label rows. */
const LOOKUP_PAGE_SIZE = 200;

export default function HrPage() {
  const session = useSession();
  const institutionId = session.institutionId;
  const [tab, setTab] = useState('employees');

  const canManageContracts = session.can('hr.contracts.manage');

  const headcount = useQuery({
    queryKey: ['hr-headcount', institutionId],
    queryFn: () => hrApi.headcount(institutionId!),
    enabled: Boolean(institutionId),
  });

  const report = headcount.data;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Staff"
        description="The employee directory, the departments and posts it is organised by, and the contracts behind it."
      />

      {headcount.isError ? <ErrorNotice error={headcount.error} /> : null}

      <StatGrid className="mb-5">
        <MetricCard
          label="In post"
          value={report ? formatNumber(report.current.total) : null}
          detail="Excludes resigned, terminated and retired"
        />
        <MetricCard
          label="Joined"
          value={report ? formatNumber(report.movement.joiners) : null}
          detail={report ? `Since ${formatDate(report.window.from)}` : undefined}
        />
        <MetricCard
          label="Left"
          value={report ? formatNumber(report.movement.separations) : null}
          detail={report ? `Since ${formatDate(report.window.from)}` : undefined}
        />
        <MetricCard
          label="Attrition"
          // A percentage the API computed, as a decimal string. Printed, not recalculated.
          value={report ? `${report.movement.attritionRatePercent}%` : null}
          detail="Separations over average headcount"
        />
      </StatGrid>

      <Tabs value={tab} onValueChange={setTab} activation="manual">
        <TabList label="Staff records" className="mb-4">
          <Tab value="employees">Employees</Tab>
          <Tab value="departments">Departments</Tab>
          <Tab value="designations">Designations</Tab>
          {canManageContracts ? <Tab value="contracts">Contracts</Tab> : null}
        </TabList>

        <TabPanel value="employees">
          {institutionId ? <EmployeesTab institutionId={institutionId} /> : null}
        </TabPanel>
        <TabPanel value="departments">
          {institutionId ? <DepartmentsTab institutionId={institutionId} /> : null}
        </TabPanel>
        <TabPanel value="designations">
          {institutionId ? <DesignationsTab institutionId={institutionId} /> : null}
        </TabPanel>
        {canManageContracts ? (
          <TabPanel value="contracts">
            {institutionId ? <ContractsTab institutionId={institutionId} /> : null}
          </TabPanel>
        ) : null}
      </Tabs>
    </div>
  );
}

// ── Employees ─────────────────────────────────────────────────────────────────────────

function EmployeesTab({ institutionId }: { institutionId: string }) {
  const session = useSession();
  const [q, setQ] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [designationId, setDesignationId] = useState('');
  const [employmentStatus, setEmploymentStatus] = useState('');
  const [employmentType, setEmploymentType] = useState('');
  const [sort, setSort] = useState<string | undefined>();
  const [page, setPage] = useState(1);
  const [formOpen, setFormOpen] = useState(false);

  const departments = useQuery({
    queryKey: ['hr-departments', { institutionId, all: true }],
    queryFn: () => hrApi.departments(institutionId, { page: 1, pageSize: LOOKUP_PAGE_SIZE }),
  });
  const designations = useQuery({
    queryKey: ['hr-designations', { institutionId, all: true }],
    queryFn: () => hrApi.designations(institutionId, { page: 1, pageSize: LOOKUP_PAGE_SIZE }),
  });

  const employees = useQuery({
    queryKey: [
      'hr-employees',
      { q, departmentId, designationId, employmentStatus, employmentType, sort, page, institutionId },
    ],
    queryFn: () =>
      hrApi.employees(institutionId, {
        page,
        pageSize: PAGE_SIZE,
        q: q || undefined,
        departmentId: departmentId || undefined,
        designationId: designationId || undefined,
        employmentStatus: employmentStatus || undefined,
        employmentType: employmentType || undefined,
        sort,
      }),
    placeholderData: keepPreviousData,
  });

  const departmentName = (id: string | null) =>
    id ? (departments.data?.data.find((row) => row.id === id)?.nameEn ?? '—') : '—';
  const designationName = (id: string | null) =>
    id ? (designations.data?.data.find((row) => row.id === id)?.nameEn ?? '—') : '—';

  const hasFilters = Boolean(
    q || departmentId || designationId || employmentStatus || employmentType,
  );
  const resetPage = () => setPage(1);

  return (
    <>
      <FilterBar
        className="mb-4"
        search={{
          value: q,
          onChange: (value) => {
            setQ(value);
            resetPage();
          },
          label: 'Search staff by name, employee code or phone number',
          placeholder: 'Search by name, code or phone',
        }}
        filters={[
          {
            id: 'department',
            label: 'Department',
            value: departmentId,
            onChange: (value) => {
              setDepartmentId(value);
              resetPage();
            },
            options: toSelectOptions(departments.data?.data ?? []),
            placeholder: 'Any department',
          },
          {
            id: 'designation',
            label: 'Designation',
            value: designationId,
            onChange: (value) => {
              setDesignationId(value);
              resetPage();
            },
            options: toSelectOptions(designations.data?.data ?? []),
            placeholder: 'Any designation',
          },
          {
            id: 'status',
            label: 'Status',
            value: employmentStatus,
            onChange: (value) => {
              setEmploymentStatus(value);
              resetPage();
            },
            options: EMPLOYMENT_STATUSES.map((value) => ({ value, label: humanize(value) })),
            placeholder: 'Any status',
          },
          {
            id: 'type',
            label: 'Type',
            value: employmentType,
            onChange: (value) => {
              setEmploymentType(value);
              resetPage();
            },
            options: EMPLOYMENT_TYPES.map((value) => ({ value, label: humanize(value) })),
            placeholder: 'Any type',
          },
        ]}
        onReset={
          hasFilters
            ? () => {
                setQ('');
                setDepartmentId('');
                setDesignationId('');
                setEmploymentStatus('');
                setEmploymentType('');
                resetPage();
              }
            : undefined
        }
        actions={
          // Not rendered-and-disabled: the API re-checks `hr.employees.create` on the request,
          // so hiding it here is purely so nobody clicks a button that cannot work.
          session.can('hr.employees.create') ? (
            <Button variant="primary" onClick={() => setFormOpen(true)}>
              New employee
            </Button>
          ) : null
        }
      />

      <DataTable
        caption="Employee directory"
        rows={employees.data?.data ?? []}
        rowKey={(row) => row.id}
        rowHref={(row) => `/hr/${row.id}`}
        sort={sort}
        onSortChange={(value) => {
          setSort(value);
          resetPage();
        }}
        isLoading={employees.isLoading}
        isFetching={employees.isFetching}
        error={employees.error}
        empty={{
          title: hasFilters ? 'No staff match these filters' : 'No staff recorded yet',
          description: hasFilters
            ? 'Try a wider status or department, or clear the search.'
            : 'Employee records created here become the directory the whole platform reads.',
        }}
        columns={[
          {
            id: 'name',
            header: 'Name',
            card: 'title',
            sortField: 'fullNameEn',
            render: (row: Employee) => (
              <BilingualName
                row={{ fullNameEn: row.fullNameEn, fullNameBn: row.fullNameBn }}
                className="font-medium"
              />
            ),
          },
          {
            id: 'code',
            header: 'Employee code',
            card: 'subtitle',
            sortField: 'employeeCode',
            className: 'font-mono text-xs text-content-muted',
            render: (row: Employee) => row.employeeCode,
          },
          {
            id: 'designation',
            header: 'Designation',
            card: 'meta',
            render: (row: Employee) => designationName(row.designationId),
          },
          {
            id: 'department',
            header: 'Department',
            card: 'meta',
            hideBelow: 'md',
            render: (row: Employee) => departmentName(row.departmentId),
          },
          {
            id: 'joiningDate',
            header: 'Joined',
            card: 'meta',
            sortField: 'joiningDate',
            hideBelow: 'lg',
            className: 'tabular-nums text-content-muted',
            render: (row: Employee) => formatDate(row.joiningDate),
          },
          {
            id: 'status',
            header: 'Status',
            card: 'aside',
            sortField: 'employmentStatus',
            render: (row: Employee) => <StatusBadge status={row.employmentStatus} />,
          },
        ]}
        minWidth="56rem"
      />

      <Pagination
        className="mt-4"
        meta={employees.data?.meta}
        onPageChange={setPage}
        isFetching={employees.isFetching}
        itemNoun="employee"
      />

      <EmployeeDialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        institutionId={institutionId}
        departments={toSelectOptions(departments.data?.data ?? [])}
        designations={toSelectOptions(designations.data?.data ?? [])}
      />
    </>
  );
}

// ── Departments ───────────────────────────────────────────────────────────────────────

function DepartmentsTab({ institutionId }: { institutionId: string }) {
  const session = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [formOpen, setFormOpen] = useState(false);
  const archiving = useConfirm<Department>();

  const canManage = session.can('hr.employees.update');

  const departments = useQuery({
    queryKey: ['hr-departments', { institutionId, page }],
    queryFn: () => hrApi.departments(institutionId, { page, pageSize: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });

  const all = useQuery({
    queryKey: ['hr-departments', { institutionId, all: true }],
    queryFn: () => hrApi.departments(institutionId, { page: 1, pageSize: LOOKUP_PAGE_SIZE }),
  });

  const archive = useMutation({
    mutationFn: (input: { id: string; reason: string }) =>
      hrApi.archiveDepartment(institutionId, input.id, { reason: input.reason }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['hr-departments'] });
      toast.success('Department archived');
    },
  });

  return (
    <>
      <div className="mb-4 flex justify-end">
        {canManage ? (
          <Button variant="primary" onClick={() => setFormOpen(true)}>
            New department
          </Button>
        ) : null}
      </div>

      <DataTable
        caption="Departments"
        rows={departments.data?.data ?? []}
        rowKey={(row) => row.id}
        isLoading={departments.isLoading}
        isFetching={departments.isFetching}
        error={departments.error}
        empty={{
          title: 'No departments yet',
          description:
            'Departments group staff for reporting, and give approval steps a department scope to resolve against.',
        }}
        columns={[
          {
            id: 'name',
            header: 'Department',
            card: 'title',
            sortField: 'nameEn',
            render: (row: Department) => (
              <BilingualName row={{ nameEn: row.nameEn, nameBn: row.nameBn }} className="font-medium" />
            ),
          },
          {
            id: 'code',
            header: 'Code',
            card: 'subtitle',
            sortField: 'code',
            className: 'font-mono text-xs text-content-muted',
            render: (row: Department) => row.code,
          },
          {
            id: 'parent',
            header: 'Sits under',
            card: 'meta',
            render: (row: Department) =>
              row.parentDepartmentId
                ? (all.data?.data.find((item) => item.id === row.parentDepartmentId)?.nameEn ?? '—')
                : '—',
          },
        ]}
        actions={
          canManage
            ? (row: Department) => (
                <Button size="sm" variant="ghost" onClick={() => archiving.ask(row)}>
                  Archive
                </Button>
              )
            : undefined
        }
        minWidth="36rem"
      />

      <Pagination
        className="mt-4"
        meta={departments.data?.meta}
        onPageChange={setPage}
        isFetching={departments.isFetching}
        itemNoun="department"
      />

      <DepartmentDialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        institutionId={institutionId}
        parents={toSelectOptions(all.data?.data ?? [])}
      />

      <ConfirmDialog
        open={archiving.isOpen}
        onClose={archiving.close}
        requireReason
        title="Archive this department"
        confirmLabel="Archive department"
        body={
          <>
            <strong>{archiving.target?.nameEn}</strong> will be hidden from the lists staff work
            in. The record itself is kept, and its code becomes reusable.
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

// ── Designations ──────────────────────────────────────────────────────────────────────

function DesignationsTab({ institutionId }: { institutionId: string }) {
  const session = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [formOpen, setFormOpen] = useState(false);
  const archiving = useConfirm<Designation>();

  const canManage = session.can('hr.employees.update');

  const designations = useQuery({
    queryKey: ['hr-designations', { institutionId, page }],
    queryFn: () => hrApi.designations(institutionId, { page, pageSize: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });

  const archive = useMutation({
    mutationFn: (input: { id: string; reason: string }) =>
      hrApi.archiveDesignation(institutionId, input.id, { reason: input.reason }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['hr-designations'] });
      toast.success('Designation archived');
    },
  });

  return (
    <>
      <div className="mb-4 flex justify-end">
        {canManage ? (
          <Button variant="primary" onClick={() => setFormOpen(true)}>
            New designation
          </Button>
        ) : null}
      </div>

      <DataTable
        caption="Designations"
        rows={designations.data?.data ?? []}
        rowKey={(row) => row.id}
        isLoading={designations.isLoading}
        isFetching={designations.isFetching}
        error={designations.error}
        empty={{
          title: 'No designations yet',
          description: 'A designation is a post: its title, its seniority rank, and whether it teaches.',
        }}
        columns={[
          {
            id: 'name',
            header: 'Designation',
            card: 'title',
            sortField: 'nameEn',
            render: (row: Designation) => (
              <BilingualName row={{ nameEn: row.nameEn, nameBn: row.nameBn }} className="font-medium" />
            ),
          },
          {
            id: 'code',
            header: 'Code',
            card: 'subtitle',
            sortField: 'code',
            className: 'font-mono text-xs text-content-muted',
            render: (row: Designation) => row.code,
          },
          {
            id: 'rank',
            header: 'Rank',
            align: 'right',
            card: 'meta',
            sortField: 'rank',
            className: 'tabular-nums',
            render: (row: Designation) => formatNumber(row.rank),
          },
          {
            id: 'teaching',
            header: 'Teaching',
            card: 'aside',
            render: (row: Designation) =>
              row.isTeaching ? <Badge tone="info">Teaching</Badge> : <Badge>Non-teaching</Badge>,
          },
        ]}
        actions={
          canManage
            ? (row: Designation) => (
                <Button size="sm" variant="ghost" onClick={() => archiving.ask(row)}>
                  Archive
                </Button>
              )
            : undefined
        }
        minWidth="36rem"
      />

      <Pagination
        className="mt-4"
        meta={designations.data?.meta}
        onPageChange={setPage}
        isFetching={designations.isFetching}
        itemNoun="designation"
      />

      <DesignationDialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        institutionId={institutionId}
      />

      <ConfirmDialog
        open={archiving.isOpen}
        onClose={archiving.close}
        requireReason
        title="Archive this designation"
        confirmLabel="Archive designation"
        body={
          <>
            <strong>{archiving.target?.nameEn}</strong> will no longer be offered when posting
            staff. Existing records keep it.
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

// ── Contracts ─────────────────────────────────────────────────────────────────────────

function ContractsTab({ institutionId }: { institutionId: string }) {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [terminating, setTerminating] = useState<string | null>(null);

  // The contracts endpoint returns `employeeId`, not a name, so the directory is fetched once
  // to label the rows. Beyond the API's page ceiling a name may be missing; the row then links
  // to the employee record rather than showing an identifier nobody can read.
  const employees = useQuery({
    queryKey: ['hr-employees', { institutionId, all: true }],
    queryFn: () =>
      hrApi.employees(institutionId, {
        page: 1,
        pageSize: LOOKUP_PAGE_SIZE,
        sort: 'fullNameEn',
      }),
  });

  const contracts = useQuery({
    queryKey: ['hr-contracts', { institutionId, page, status, employeeId }],
    queryFn: () =>
      hrApi.contracts(institutionId, {
        page,
        pageSize: PAGE_SIZE,
        status: status || undefined,
        employeeId: employeeId || undefined,
      }),
    placeholderData: keepPreviousData,
  });

  const employeeOptions: SelectOption[] = (employees.data?.data ?? []).map((row) => ({
    value: row.id,
    label: row.fullNameEn,
    hint: row.employeeCode,
  }));

  return (
    <>
      <FilterBar
        className="mb-4"
        filters={[
          {
            id: 'employee',
            label: 'Employee',
            value: employeeId,
            onChange: (value) => {
              setEmployeeId(value);
              setPage(1);
            },
            options: employeeOptions,
            placeholder: 'Any employee',
          },
          {
            id: 'status',
            label: 'Status',
            value: status,
            onChange: (value) => {
              setStatus(value);
              setPage(1);
            },
            options: [
              { value: 'active', label: 'Active' },
              { value: 'ended', label: 'Ended' },
              { value: 'terminated', label: 'Terminated' },
            ],
            placeholder: 'Any status',
          },
        ]}
        onReset={
          status || employeeId
            ? () => {
                setStatus('');
                setEmployeeId('');
                setPage(1);
              }
            : undefined
        }
        actions={
          <Button variant="primary" onClick={() => setFormOpen(true)}>
            New contract
          </Button>
        }
      />

      <DataTable
        caption="Employment contracts"
        rows={contracts.data?.data ?? []}
        rowKey={(row) => row.id}
        isLoading={contracts.isLoading}
        isFetching={contracts.isFetching}
        error={contracts.error}
        empty={{
          title: 'No contracts recorded',
          description:
            'A contract records the terms of an employment: its type, its dates, and the notice period.',
        }}
        columns={[
          {
            id: 'employee',
            header: 'Employee',
            card: 'title',
            render: (row: EmploymentContract) => {
              const employee = employees.data?.data.find((item) => item.id === row.employeeId);
              // Beyond the lookup page the name is simply not available; the row still links
              // to the record rather than printing an identifier nobody can read.
              return (
                <Link
                  className="font-medium text-accent-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                  href={`/hr/${row.employeeId}`}
                >
                  {employee ? employee.fullNameEn : 'Open employee record'}
                </Link>
              );
            },
          },
          {
            id: 'type',
            header: 'Type',
            card: 'subtitle',
            render: (row: EmploymentContract) => humanize(row.contractType),
          },
          {
            id: 'start',
            header: 'Starts',
            card: 'meta',
            sortField: 'startDate',
            className: 'tabular-nums text-content-muted',
            render: (row: EmploymentContract) => formatDate(row.startDate),
          },
          {
            id: 'end',
            header: 'Ends',
            card: 'meta',
            sortField: 'endDate',
            className: 'tabular-nums text-content-muted',
            render: (row: EmploymentContract) =>
              row.endDate ? formatDate(row.endDate) : 'Open-ended',
          },
          {
            id: 'notice',
            header: 'Notice',
            align: 'right',
            card: 'meta',
            hideBelow: 'lg',
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
        minWidth="56rem"
      />

      <Pagination
        className="mt-4"
        meta={contracts.data?.meta}
        onPageChange={setPage}
        isFetching={contracts.isFetching}
        itemNoun="contract"
      />

      <ContractDialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        institutionId={institutionId}
        employees={employeeOptions}
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

function toSelectOptions(rows: Array<Department | Designation>): SelectOption[] {
  return rows.map((row) => ({
    value: row.id,
    label: row.nameEn,
    hint: row.nameBn ?? undefined,
  }));
}
