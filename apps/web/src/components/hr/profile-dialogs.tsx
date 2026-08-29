'use client';

/**
 * The employee profile side-tables: qualifications, previous employment, dependents.
 *
 * Small forms, but the same rules: the shared schema, and blank-means-absent mapping for the
 * fields whose schema branch has no empty-string case. `yearCompleted` is a plain `z.number()`
 * that is deliberately not coerced on the server (coercion would turn an explicit null into a
 * year zero), so the mapping here converts only a non-empty value.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import {
  createEmployeeDependentSchema,
  createEmployeeExperienceSchema,
  createEmployeeQualificationSchema,
  EMPLOYEE_DEPENDENT_RELATIONS,
} from '@shikkha/validation';
import { humanize } from '@/lib/format';
import {
  Button,
  DateField,
  Dialog,
  FieldGrid,
  FieldGridSpan,
  Form,
  FormActions,
  NumberField,
  TextAreaField,
  TextField,
  SelectField,
  useToast,
} from '@/components/ui';
import { hrApi } from './api';
import { BLANK_IS_ABSENT, BLANK_IS_ABSENT_NUMBER } from './forms';

interface ProfileDialogProps {
  open: boolean;
  onClose: () => void;
  institutionId: string;
  employeeId: string;
}

export function QualificationDialog({
  open,
  onClose,
  institutionId,
  employeeId,
}: ProfileDialogProps) {
  type Values = z.input<typeof createEmployeeQualificationSchema>;
  const toast = useToast();
  const queryClient = useQueryClient();

  const form = useForm<Values>({
    resolver: zodResolver(createEmployeeQualificationSchema),
    defaultValues: { degree: '', institutionName: '', fieldOfStudy: '', grade: '' },
  });

  const create = useMutation({
    mutationFn: (values: Values) => hrApi.createQualification(institutionId, employeeId, values),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['hr-qualifications', employeeId] });
      toast.success('Qualification added');
      form.reset();
      onClose();
    },
  });

  return (
    <Dialog open={open} onClose={onClose} title="Add a qualification" closeOnBackdropClick={false}>
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
            name="degree"
            label="Degree"
            required
            hint="As the certificate names it — SSC, HSC, B.Ed, Kamil."
          />
          <TextField form={form} name="institutionName" label="Institution" required />
          <TextField form={form} name="fieldOfStudy" label="Field of study" optional />
          <NumberField
            form={form}
            name="yearCompleted"
            label="Year completed"
            optional
            min={1900}
            max={2100}
            registerOptions={BLANK_IS_ABSENT_NUMBER}
          />
          <TextField
            form={form}
            name="grade"
            label="Grade"
            optional
            hint="Recorded exactly as the certificate states it."
          />
        </FieldGrid>
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Add qualification
          </Button>
        </FormActions>
      </Form>
    </Dialog>
  );
}

export function ExperienceDialog({ open, onClose, institutionId, employeeId }: ProfileDialogProps) {
  type Values = z.input<typeof createEmployeeExperienceSchema>;
  const toast = useToast();
  const queryClient = useQueryClient();

  const form = useForm<Values>({
    resolver: zodResolver(createEmployeeExperienceSchema),
    defaultValues: { organisationName: '', designation: '', fromDate: '', responsibilities: '' },
  });

  const create = useMutation({
    mutationFn: (values: Values) => hrApi.createExperience(institutionId, employeeId, values),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['hr-experience', employeeId] });
      toast.success('Experience added');
      form.reset();
      onClose();
    },
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add previous employment"
      closeOnBackdropClick={false}
    >
      <Form
        form={form}
        onSubmit={async (values) => {
          await create.mutateAsync(values);
        }}
        onError={(error) => toast.error(error)}
      >
        <FieldGrid>
          <TextField form={form} name="organisationName" label="Organisation" required />
          <TextField form={form} name="designation" label="Designation held" required />
          <DateField form={form} name="fromDate" label="From" required />
          <DateField
            form={form}
            name="toDate"
            label="To"
            optional
            hint="Leave blank if this was their job when they joined here."
            registerOptions={BLANK_IS_ABSENT}
          />
          <FieldGridSpan>
            <TextAreaField
              form={form}
              name="responsibilities"
              label="Responsibilities"
              optional
              rows={3}
            />
          </FieldGridSpan>
        </FieldGrid>
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Add experience
          </Button>
        </FormActions>
      </Form>
    </Dialog>
  );
}

export function DependentDialog({ open, onClose, institutionId, employeeId }: ProfileDialogProps) {
  type Values = z.input<typeof createEmployeeDependentSchema>;
  const toast = useToast();
  const queryClient = useQueryClient();

  const form = useForm<Values>({
    resolver: zodResolver(createEmployeeDependentSchema),
    defaultValues: { nameEn: '', nameBn: '', relation: 'spouse' },
  });

  const create = useMutation({
    mutationFn: (values: Values) => hrApi.createDependent(institutionId, employeeId, values),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['hr-dependents', employeeId] });
      toast.success('Dependent added');
      form.reset();
      onClose();
    },
  });

  return (
    <Dialog open={open} onClose={onClose} title="Add a dependent" closeOnBackdropClick={false}>
      <Form
        form={form}
        onSubmit={async (values) => {
          await create.mutateAsync(values);
        }}
        onError={(error) => toast.error(error)}
      >
        <FieldGrid>
          <TextField form={form} name="nameEn" label="Name" required />
          <TextField form={form} name="nameBn" label="Name (Bangla)" optional lang="bn" />
          <SelectField
            form={form}
            name="relation"
            label="Relation"
            required
            options={EMPLOYEE_DEPENDENT_RELATIONS.map((value) => ({
              value,
              label: humanize(value),
            }))}
          />
          <DateField
            form={form}
            name="dateOfBirth"
            label="Date of birth"
            optional
            registerOptions={BLANK_IS_ABSENT}
          />
        </FieldGrid>
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Add dependent
          </Button>
        </FormActions>
      </Form>
    </Dialog>
  );
}
