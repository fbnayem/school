'use client';

/**
 * Create an admission session — one intake cycle, its window, its fee and its seats.
 *
 * The seat rows are the substance: `classCapacity` is what the API locks and counts against
 * when an offer is issued or accepted, so a cycle with no seats configured cannot accept an
 * application at all. The schema enforces at least one row and no repeated class level; both
 * messages come back on the `classCapacity` path and land on the list.
 *
 * Campus is not offered here. It is optional on the schema, and there is no campus-listing
 * endpoint this screen may call, so the field is omitted rather than shown with nothing in it.
 */

import { useFieldArray, useForm, type FieldPath } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { createAdmissionSessionSchema } from '@shikkha/validation';
import { academicApi } from '@/components/academic/api';
import {
  Button,
  DateField,
  Dialog,
  FieldGrid,
  Form,
  FormActions,
  MoneyField,
  NumberField,
  SectionHeading,
  SelectField,
  TextField,
  useToast,
} from '@/components/ui';
import { admissionsApi } from './api';

type Values = z.input<typeof createAdmissionSessionSchema>;

export function SessionFormDialog({
  open,
  onClose,
  institutionId,
}: {
  open: boolean;
  onClose: () => void;
  institutionId: string;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const years = useQuery({
    queryKey: ['academic-years', institutionId],
    queryFn: () => academicApi.years(institutionId),
    enabled: open,
  });

  const classLevels = useQuery({
    queryKey: ['class-levels', institutionId],
    queryFn: () => academicApi.classLevels(institutionId),
    enabled: open,
  });

  const form = useForm<Values>({
    resolver: zodResolver(createAdmissionSessionSchema),
    defaultValues: {
      academicYearId: '',
      nameEn: '',
      nameBn: '',
      applicationStartDate: '',
      applicationEndDate: '',
      applicationFee: '0.00',
      classCapacity: [{ classLevelId: '', seats: 1 }],
    },
  });

  const capacity = useFieldArray({ control: form.control, name: 'classCapacity' });

  const create = useMutation({
    mutationFn: (values: Values) => admissionsApi.createSession(institutionId, values),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ['admission-sessions'] });
      toast.success('Admission session created', `${created.nameEn} is in draft`);
      form.reset();
      onClose();
    },
  });

  const classLevelOptions = (classLevels.data ?? []).map((level) => ({
    value: level.id,
    label: level.nameEn,
    hint: level.nameBn ?? undefined,
  }));

  // The array error (`at least one class level`, `each class level may appear only once`) is
  // attached to the `classCapacity` path itself, not to any row, so it is read explicitly here.
  const capacityError = form.formState.errors.classCapacity?.message;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New admission session"
      description="A session opens in draft. Open it for applications when the circular is published."
      size="lg"
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
          <SelectField
            form={form}
            name="academicYearId"
            label="Enrols into academic year"
            required
            placeholder={years.isLoading ? 'Loading years…' : 'Choose a year'}
            options={(years.data ?? []).map((year) => ({
              value: year.id,
              label: year.name,
              hint: year.isCurrent ? 'current' : undefined,
            }))}
          />
          <MoneyField
            form={form}
            name="applicationFee"
            label="Application form fee"
            hint="What a family pays to apply. Not the admission fee — that is set on each offer."
          />
          <TextField form={form} name="nameEn" label="Session name" required />
          <TextField form={form} name="nameBn" label="Session name (Bangla)" optional lang="bn" />
          <DateField form={form} name="applicationStartDate" label="Applications open" required />
          <DateField form={form} name="applicationEndDate" label="Applications close" required />
        </FieldGrid>

        <SectionHeading
          level="h3"
          title="Seats per class"
          description="Offers and acceptances are counted against these numbers, under a lock."
          actions={
            <Button size="sm" onClick={() => capacity.append({ classLevelId: '', seats: 1 })}>
              Add a class
            </Button>
          }
          className="mt-2"
        />

        {capacityError ? (
          <p role="alert" className="mb-2 text-sm text-danger">
            {capacityError}
          </p>
        ) : null}

        <ul className="space-y-3">
          {capacity.fields.map((field, index) => (
            <li key={field.id} className="flex flex-wrap items-end gap-3">
              <SelectField
                className="min-w-[12rem] flex-1"
                form={form}
                name={`classCapacity.${index}.classLevelId` as FieldPath<Values>}
                label={`Class ${index + 1}`}
                required
                placeholder="Choose a class"
                options={classLevelOptions}
              />
              <NumberField
                className="w-32"
                form={form}
                name={`classCapacity.${index}.seats` as FieldPath<Values>}
                label="Seats"
                required
                min={1}
                max={10000}
                // Plain `z.number()` in the schema, so the string from the input is converted
                // here rather than being sent as "120".
                registerOptions={{ valueAsNumber: true }}
              />
              {capacity.fields.length > 1 ? (
                <Button size="sm" variant="ghost" onClick={() => capacity.remove(index)}>
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
        </ul>

        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Create session
          </Button>
        </FormActions>
      </Form>
    </Dialog>
  );
}
