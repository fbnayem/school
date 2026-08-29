'use client';

/**
 * The HR write dialogs: departments, designations, employees, contracts, and the two lifecycle
 * actions that need more than a reason (status change and contract termination).
 *
 * Every form is bound to the schema `@shikkha/validation` exports and the API validates with,
 * so the client and the server cannot disagree about what a valid record is. Where a schema
 * accepts "absent" but not "empty string" — `nidSchema.optional()`, a nullable calendar date —
 * the field maps `''` to `undefined` on the way out. Without that, an optional field left blank
 * makes the form unsubmittable with a message about a value the user never entered.
 *
 * Neither `changeEmployeeStatus` nor `terminateContract` can be a `ConfirmDialog`: both take an
 * effective date as well as a reason, because a resignation is usually recorded days after it
 * took effect and payroll must use the real date, not the day HR got to it.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import {
  changeEmployeeStatusSchema,
  createDepartmentSchema,
  createDesignationSchema,
  createEmployeeSchema,
  createEmploymentContractSchema,
  EMPLOYMENT_CONTRACT_TYPES,
  EMPLOYMENT_TYPES,
  terminateEmploymentContractSchema,
} from '@shikkha/validation';
import {
  BLOOD_GROUPS,
  EMPLOYMENT_STATUSES,
  GENDERS,
  RELIGIONS,
} from '@shikkha/shared';
import { humanize, todayInDhaka } from '@/lib/format';
import {
  Button,
  CheckboxField,
  DateField,
  Dialog,
  FieldGrid,
  FieldGridSpan,
  Form,
  FormActions,
  NumberField,
  SectionHeading,
  SelectField,
  TextAreaField,
  TextField,
  useToast,
  type SelectOption,
} from '@/components/ui';
import { hrApi, SEPARATION_STATUSES, type Employee } from './api';

/** For a schema branch that accepts absence but not an empty string. */
const BLANK_IS_ABSENT = { setValueAs: (value: unknown) => (value === '' ? undefined : value) };

/**
 * For a plain `z.number()` that is optional. `valueAsNumber` alone turns an empty input into
 * `NaN`, which fails the schema with a message the user cannot act on.
 */
const BLANK_IS_ABSENT_NUMBER = {
  setValueAs: (value: unknown) => (value === '' || value === null ? undefined : Number(value)),
};

// ── Departments ───────────────────────────────────────────────────────────────────────

export function DepartmentDialog({
  open,
  onClose,
  institutionId,
  parents,
}: {
  open: boolean;
  onClose: () => void;
  institutionId: string;
  parents: SelectOption[];
}) {
  type Values = z.input<typeof createDepartmentSchema>;
  const toast = useToast();
  const queryClient = useQueryClient();

  const form = useForm<Values>({
    resolver: zodResolver(createDepartmentSchema),
    defaultValues: { code: '', nameEn: '', nameBn: '' },
  });

  const create = useMutation({
    mutationFn: (values: Values) => hrApi.createDepartment(institutionId, values),
    onSuccess: (department) => {
      void queryClient.invalidateQueries({ queryKey: ['hr-departments'] });
      toast.success('Department created', department.nameEn);
      form.reset();
      onClose();
    },
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New department"
      closeOnBackdropClick={false}
      description="Departments group staff for reporting and for approval routing at department scope."
    >
      <Form
        form={form}
        onSubmit={async (values) => {
          await create.mutateAsync(values);
        }}
        onError={(error) => toast.error(error)}
      >
        <FieldGrid>
          <TextField
            form={form}
            name="code"
            label="Code"
            required
            hint="Letters, numbers, hyphens and underscores."
          />
          <TextField form={form} name="nameEn" label="Name" required />
          <TextField form={form} name="nameBn" label="Name (Bangla)" optional lang="bn" />
          <SelectField
            form={form}
            name="parentDepartmentId"
            label="Sits under"
            optional
            placeholder="No parent department"
            allowEmpty
            options={parents}
            registerOptions={BLANK_IS_ABSENT}
          />
        </FieldGrid>
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Create department
          </Button>
        </FormActions>
      </Form>
    </Dialog>
  );
}

// ── Designations ──────────────────────────────────────────────────────────────────────

export function DesignationDialog({
  open,
  onClose,
  institutionId,
}: {
  open: boolean;
  onClose: () => void;
  institutionId: string;
}) {
  type Values = z.input<typeof createDesignationSchema>;
  const toast = useToast();
  const queryClient = useQueryClient();

  const form = useForm<Values>({
    resolver: zodResolver(createDesignationSchema),
    defaultValues: { code: '', nameEn: '', nameBn: '', rank: 0, isTeaching: true },
  });

  const create = useMutation({
    mutationFn: (values: Values) => hrApi.createDesignation(institutionId, values),
    onSuccess: (designation) => {
      void queryClient.invalidateQueries({ queryKey: ['hr-designations'] });
      toast.success('Designation created', designation.nameEn);
      form.reset();
      onClose();
    },
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New designation"
      closeOnBackdropClick={false}
      description="A post, with a seniority rank used for ordering reports and routing approvals."
    >
      <Form
        form={form}
        onSubmit={async (values) => {
          await create.mutateAsync(values);
        }}
        onError={(error) => toast.error(error)}
      >
        <FieldGrid>
          <TextField form={form} name="code" label="Code" required />
          <TextField form={form} name="nameEn" label="Title" required />
          <TextField form={form} name="nameBn" label="Title (Bangla)" optional lang="bn" />
          {/* `z.coerce.number()` in the schema, so the string from the input is fine as-is. */}
          <NumberField form={form} name="rank" label="Seniority rank" min={0} max={1000} />
          <FieldGridSpan>
            <CheckboxField form={form} name="isTeaching" label="This is a teaching post" />
          </FieldGridSpan>
        </FieldGrid>
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Create designation
          </Button>
        </FormActions>
      </Form>
    </Dialog>
  );
}

// ── Employees ─────────────────────────────────────────────────────────────────────────

export function EmployeeDialog({
  open,
  onClose,
  institutionId,
  departments,
  designations,
}: {
  open: boolean;
  onClose: () => void;
  institutionId: string;
  departments: SelectOption[];
  designations: SelectOption[];
}) {
  type Values = z.input<typeof createEmployeeSchema>;
  const toast = useToast();
  const queryClient = useQueryClient();

  const form = useForm<Values>({
    resolver: zodResolver(createEmployeeSchema),
    defaultValues: {
      fullNameEn: '',
      fullNameBn: '',
      fatherNameEn: '',
      motherNameEn: '',
      phone: '',
      alternatePhone: '',
      email: '',
      presentAddress: '',
      permanentAddress: '',
      emergencyContactName: '',
      emergencyContactPhone: '',
      employmentType: 'permanent',
      joiningDate: todayInDhaka(),
      qualificationSummary: '',
      specialization: '',
    },
  });

  const create = useMutation({
    mutationFn: (values: Values) => hrApi.createEmployee(institutionId, values),
    onSuccess: (employee) => {
      void queryClient.invalidateQueries({ queryKey: ['hr-employees'] });
      void queryClient.invalidateQueries({ queryKey: ['hr-headcount'] });
      toast.success('Employee record created', `${employee.fullNameEn} · ${employee.employeeCode}`);
      form.reset();
      onClose();
    },
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New employee"
      size="lg"
      closeOnBackdropClick={false}
      description="Employment status starts as active. Separations, transfers and archival are separate, separately audited actions."
    >
      <Form
        form={form}
        onSubmit={async (values) => {
          await create.mutateAsync(values);
        }}
        onError={(error) => toast.error(error)}
      >
        <SectionHeading level="h3" title="Identity" />
        <FieldGrid>
          <TextField form={form} name="fullNameEn" label="Full name" required />
          <TextField form={form} name="fullNameBn" label="Full name (Bangla)" optional lang="bn" />
          <TextField form={form} name="fatherNameEn" label="Father's name" optional />
          <TextField form={form} name="motherNameEn" label="Mother's name" optional />
          <DateField
            form={form}
            name="dateOfBirth"
            label="Date of birth"
            optional
            registerOptions={BLANK_IS_ABSENT}
          />
          <SelectField
            form={form}
            name="gender"
            label="Gender"
            optional
            placeholder="Not recorded"
            allowEmpty
            options={GENDERS.map((value) => ({ value, label: humanize(value) }))}
            registerOptions={BLANK_IS_ABSENT}
          />
          <SelectField
            form={form}
            name="bloodGroup"
            label="Blood group"
            optional
            placeholder="Not recorded"
            allowEmpty
            options={BLOOD_GROUPS.map((value) => ({ value, label: value }))}
            registerOptions={BLANK_IS_ABSENT}
          />
          <SelectField
            form={form}
            name="religion"
            label="Religion"
            optional
            placeholder="Not recorded"
            allowEmpty
            options={RELIGIONS.map((value) => ({ value, label: humanize(value) }))}
            registerOptions={BLANK_IS_ABSENT}
          />
          <TextField
            form={form}
            name="nationalId"
            label="National ID"
            optional
            inputMode="numeric"
            registerOptions={BLANK_IS_ABSENT}
          />
        </FieldGrid>

        <SectionHeading level="h3" title="Contact" className="mt-2" />
        <FieldGrid>
          <TextField form={form} name="phone" label="Mobile number" required inputMode="tel" />
          <TextField form={form} name="alternatePhone" label="Alternate number" optional inputMode="tel" />
          <TextField form={form} name="email" label="Email" optional type="email" />
          <TextField form={form} name="emergencyContactName" label="Emergency contact" optional />
          <TextField
            form={form}
            name="emergencyContactPhone"
            label="Emergency contact number"
            optional
            inputMode="tel"
          />
          <FieldGridSpan>
            <TextAreaField form={form} name="presentAddress" label="Present address" optional rows={2} />
          </FieldGridSpan>
          <FieldGridSpan>
            <TextAreaField
              form={form}
              name="permanentAddress"
              label="Permanent address"
              optional
              rows={2}
            />
          </FieldGridSpan>
        </FieldGrid>

        <SectionHeading level="h3" title="Posting" className="mt-2" />
        <FieldGrid>
          <SelectField
            form={form}
            name="departmentId"
            label="Department"
            optional
            placeholder="Unassigned"
            allowEmpty
            options={departments}
            registerOptions={BLANK_IS_ABSENT}
          />
          <SelectField
            form={form}
            name="designationId"
            label="Designation"
            optional
            placeholder="Unassigned"
            allowEmpty
            options={designations}
            registerOptions={BLANK_IS_ABSENT}
          />
          <SelectField
            form={form}
            name="employmentType"
            label="Employment type"
            required
            options={EMPLOYMENT_TYPES.map((value) => ({ value, label: humanize(value) }))}
          />
          <DateField form={form} name="joiningDate" label="Joining date" required />
          <DateField
            form={form}
            name="confirmationDate"
            label="Confirmation date"
            optional
            registerOptions={BLANK_IS_ABSENT}
          />
          <TextField
            form={form}
            name="qualificationSummary"
            label="Highest qualification"
            optional
          />
          <TextField form={form} name="specialization" label="Specialisation" optional />
        </FieldGrid>

        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Create employee
          </Button>
        </FormActions>
      </Form>
    </Dialog>
  );
}

// ── Employment status ─────────────────────────────────────────────────────────────────

export function StatusDialog({
  open,
  onClose,
  institutionId,
  employee,
  canManageExit,
}: {
  open: boolean;
  onClose: () => void;
  institutionId: string;
  employee: Employee;
  canManageExit: boolean;
}) {
  type Values = z.input<typeof changeEmployeeStatusSchema>;
  const toast = useToast();
  const queryClient = useQueryClient();

  // A separation needs `hr.exit.manage`; the service refuses it otherwise, so the options are
  // narrowed rather than offered and rejected. The current status is dropped too — the API
  // returns a 409 for "already active".
  const options = EMPLOYMENT_STATUSES.filter(
    (status) =>
      status !== employee.employmentStatus &&
      (canManageExit || !SEPARATION_STATUSES.includes(status)),
  );

  const form = useForm<Values>({
    resolver: zodResolver(changeEmployeeStatusSchema),
    defaultValues: {
      status: options[0] as Values['status'],
      effectiveDate: todayInDhaka(),
      reason: '',
    },
  });

  const change = useMutation({
    mutationFn: (values: Values) => hrApi.changeStatus(institutionId, employee.id, values),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['hr-employee', employee.id] });
      void queryClient.invalidateQueries({ queryKey: ['hr-employees'] });
      void queryClient.invalidateQueries({ queryKey: ['hr-headcount'] });
      toast.success('Employment status changed');
      onClose();
    },
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Change employment status"
      closeOnBackdropClick={false}
      description="Recorded in the employee's status history, which is what a service certificate is printed from."
    >
      <Form
        form={form}
        onSubmit={async (values) => {
          await change.mutateAsync(values);
        }}
        onError={(error) => toast.error(error)}
      >
        <SelectField
          form={form}
          name="status"
          label="New status"
          required
          options={options.map((value) => ({ value, label: humanize(value) }))}
        />
        <DateField
          form={form}
          name="effectiveDate"
          label="Effective from"
          required
          hint="The date it actually took effect, which is often earlier than today."
        />
        <TextAreaField
          form={form}
          name="reason"
          label="Reason"
          required
          rows={3}
          hint="At least 10 characters, recorded permanently."
        />
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={change.isPending}>
            Change status
          </Button>
        </FormActions>
      </Form>
    </Dialog>
  );
}

// ── Contracts ─────────────────────────────────────────────────────────────────────────

export function ContractDialog({
  open,
  onClose,
  institutionId,
  employees,
  employeeId,
}: {
  open: boolean;
  onClose: () => void;
  institutionId: string;
  /** Options for the picker. Omitted when the dialog is opened from one employee's record. */
  employees?: SelectOption[];
  employeeId?: string;
}) {
  type Values = z.input<typeof createEmploymentContractSchema>;
  const toast = useToast();
  const queryClient = useQueryClient();

  const form = useForm<Values>({
    resolver: zodResolver(createEmploymentContractSchema),
    defaultValues: {
      employeeId: employeeId ?? '',
      contractType: 'permanent',
      startDate: todayInDhaka(),
      noticePeriodDays: 30,
      terms: '',
    },
  });

  const create = useMutation({
    mutationFn: (values: Values) => hrApi.createContract(institutionId, values),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['hr-contracts'] });
      toast.success('Contract created');
      form.reset();
      onClose();
    },
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New employment contract"
      closeOnBackdropClick={false}
      description="Two active contracts for one person may not overlap in time; the API checks that in the same transaction as the write."
    >
      <Form
        form={form}
        onSubmit={async (values) => {
          await create.mutateAsync(values);
        }}
        onError={(error) => toast.error(error)}
      >
        <FieldGrid>
          {employees ? (
            <SelectField
              form={form}
              name="employeeId"
              label="Employee"
              required
              placeholder="Choose an employee"
              options={employees}
            />
          ) : null}
          <SelectField
            form={form}
            name="contractType"
            label="Contract type"
            required
            options={EMPLOYMENT_CONTRACT_TYPES.map((value) => ({
              value,
              label: humanize(value),
            }))}
          />
          <DateField form={form} name="startDate" label="Starts" required />
          <DateField
            form={form}
            name="endDate"
            label="Ends"
            optional
            hint="Leave blank for an open-ended contract."
            registerOptions={BLANK_IS_ABSENT}
          />
          <DateField
            form={form}
            name="probationEndDate"
            label="Probation ends"
            optional
            registerOptions={BLANK_IS_ABSENT}
          />
          <NumberField
            form={form}
            name="noticePeriodDays"
            label="Notice period"
            suffix="days"
            min={0}
            max={365}
          />
          <FieldGridSpan>
            <TextAreaField
              form={form}
              name="terms"
              label="Terms"
              optional
              rows={4}
              hint="Anything that does not fit a column — allowances in kind, special conditions."
            />
          </FieldGridSpan>
        </FieldGrid>
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Create contract
          </Button>
        </FormActions>
      </Form>
    </Dialog>
  );
}

export function TerminateContractDialog({
  open,
  onClose,
  institutionId,
  contractId,
}: {
  open: boolean;
  onClose: () => void;
  institutionId: string;
  contractId: string | null;
}) {
  type Values = z.input<typeof terminateEmploymentContractSchema>;
  const toast = useToast();
  const queryClient = useQueryClient();

  const form = useForm<Values>({
    resolver: zodResolver(terminateEmploymentContractSchema),
    defaultValues: { effectiveDate: todayInDhaka(), reason: '' },
  });

  const terminate = useMutation({
    mutationFn: (values: Values) => hrApi.terminateContract(institutionId, contractId!, values),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['hr-contracts'] });
      toast.success('Contract terminated');
      form.reset();
      onClose();
    },
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Terminate this contract"
      closeOnBackdropClick={false}
      description="Terminating closes the contract on the effective date. It cannot be reversed — a new contract would have to be created."
    >
      <Form
        form={form}
        onSubmit={async (values) => {
          await terminate.mutateAsync(values);
        }}
        onError={(error) => toast.error(error)}
      >
        <DateField form={form} name="effectiveDate" label="Effective from" required />
        <TextAreaField
          form={form}
          name="reason"
          label="Reason"
          required
          rows={3}
          hint="At least 10 characters, recorded permanently."
        />
        <FormActions>
          <Button onClick={onClose}>Keep the contract</Button>
          <Button type="submit" variant="danger" loading={terminate.isPending}>
            Terminate contract
          </Button>
        </FormActions>
      </Form>
    </Dialog>
  );
}

export { BLANK_IS_ABSENT, BLANK_IS_ABSENT_NUMBER };
