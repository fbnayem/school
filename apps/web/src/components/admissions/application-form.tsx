'use client';

/**
 * Counter entry: an office clerk records a paper application.
 *
 * The same `createAdmissionApplicationSchema` the API validates with, so the rules a family is
 * told at the counter — the age window, a real date of birth, a Bangladeshi mobile number — are
 * the rules enforced on the server, with no second copy to drift.
 *
 * The `setValueAs` on several optional fields is load-bearing, not decoration. Schemas like
 * `nidSchema.optional()` accept "absent" but not "empty string", and an untouched text input
 * submits `''`. Without the mapping, leaving an optional National ID blank fails validation with
 * "A National ID is 10, 13 or 17 digits" and the clerk cannot submit the form at all.
 */

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { createAdmissionApplicationSchema } from '@shikkha/validation';
import { GENDERS, GUARDIAN_RELATIONS } from '@shikkha/shared';
import { useSession } from '@/lib/session';
import { humanize } from '@/lib/format';
import { academicApi } from '@/components/academic/api';
import {
  Button,
  DateField,
  Dialog,
  FieldGrid,
  FieldGridSpan,
  Form,
  FormActions,
  SectionHeading,
  SelectField,
  TextAreaField,
  TextField,
  useToast,
  type SelectOption,
} from '@/components/ui';
import { admissionsApi } from './api';

/** Blank means "not supplied" for a field whose schema has no empty-string branch. */
const BLANK_IS_ABSENT = { setValueAs: (value: unknown) => (value === '' ? undefined : value) };

type Values = z.input<typeof createAdmissionApplicationSchema>;

export function ApplicationFormDialog({
  open,
  onClose,
  institutionId,
}: {
  open: boolean;
  onClose: () => void;
  institutionId: string;
}) {
  const session = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();

  // Only an open session accepts applications; the API refuses the others with a 409, and
  // offering them here would be offering a button that cannot work.
  const sessions = useQuery({
    queryKey: ['admission-sessions', { status: 'open', institutionId }],
    queryFn: () => admissionsApi.sessions(institutionId, { page: 1, pageSize: 50, status: 'open' }),
    enabled: open,
  });

  const classLevels = useQuery({
    queryKey: ['class-levels', institutionId],
    queryFn: () => academicApi.classLevels(institutionId),
    enabled: open && session.can('academic.classes.view'),
  });

  const form = useForm<Values>({
    resolver: zodResolver(createAdmissionApplicationSchema),
    defaultValues: {
      sessionId: '',
      classLevelId: '',
      applicantNameEn: '',
      applicantNameBn: '',
      dateOfBirth: '',
      gender: 'male',
      guardianNameEn: '',
      guardianNameBn: '',
      guardianRelation: 'father',
      guardianPhone: '',
      guardianEmail: '',
      presentAddress: '',
      previousSchoolName: '',
      previousClassCompleted: '',
    },
  });

  const sessionId = form.watch('sessionId');
  const selectedSession = sessions.data?.data.find((row) => row.id === sessionId);

  // A session is open for a named set of class levels. Anything else is a 422 from the API,
  // so the picker is the intersection of "this session's capacity" and "class levels I can read".
  const classLevelOptions = useMemo<SelectOption[]>(() => {
    if (!selectedSession) return [];
    const byId = new Map((classLevels.data ?? []).map((level) => [level.id, level]));
    const options: SelectOption[] = [];
    for (const entry of selectedSession.classCapacity) {
      const level = byId.get(entry.classLevelId);
      // A capacity row whose class level this caller cannot read is skipped rather than shown
      // as a bare identifier — the API would accept it, but the clerk could not tell what it is.
      if (!level) continue;
      options.push({ value: level.id, label: level.nameEn, hint: level.nameBn ?? undefined });
    }
    return options;
  }, [selectedSession, classLevels.data]);

  const create = useMutation({
    mutationFn: (values: Values) => admissionsApi.createApplication(institutionId, values),
    onSuccess: (application) => {
      void queryClient.invalidateQueries({ queryKey: ['admission-applications'] });
      toast.success('Application recorded', `Application number ${application.applicationNumber}`);
      form.reset();
      onClose();
    },
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Record a counter application"
      description="For a paper form handed in at the office. The applicant's own online submissions arrive on their own."
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
        <SectionHeading level="h3" title="Admission session" />
        <FieldGrid>
          <SelectField
            form={form}
            name="sessionId"
            label="Session"
            required
            placeholder={sessions.isLoading ? 'Loading sessions…' : 'Choose a session'}
            options={(sessions.data?.data ?? []).map((row) => ({
              value: row.id,
              label: row.nameEn,
              hint: row.nameBn ?? undefined,
            }))}
          />
          <SelectField
            form={form}
            name="classLevelId"
            label="Applying for class"
            required
            placeholder={sessionId ? 'Choose a class' : 'Choose a session first'}
            options={classLevelOptions}
          />
        </FieldGrid>

        <SectionHeading level="h3" title="Applicant" className="mt-2" />
        <FieldGrid>
          <TextField form={form} name="applicantNameEn" label="Full name" required autoComplete="off" />
          <TextField
            form={form}
            name="applicantNameBn"
            label="Full name (Bangla)"
            optional
            lang="bn"
            autoComplete="off"
          />
          <DateField form={form} name="dateOfBirth" label="Date of birth" required />
          <SelectField
            form={form}
            name="gender"
            label="Gender"
            required
            options={GENDERS.map((value) => ({ value, label: humanize(value) }))}
          />
          <TextField
            form={form}
            name="birthRegistrationNumber"
            label="Birth registration number"
            optional
            inputMode="numeric"
            registerOptions={BLANK_IS_ABSENT}
          />
          <TextField
            form={form}
            name="quota"
            label="Quota"
            optional
            hint="School-defined, lowercase — for example freedom_fighter or sibling."
            registerOptions={BLANK_IS_ABSENT}
          />
        </FieldGrid>

        <SectionHeading level="h3" title="Previous school" className="mt-2" />
        <FieldGrid>
          <TextField form={form} name="previousSchoolName" label="Institution" optional />
          <TextField form={form} name="previousClassCompleted" label="Class completed" optional />
          <TextField
            form={form}
            name="previousResultGpa"
            label="GPA"
            optional
            inputMode="decimal"
            hint="On the 5.00 scale, as printed on the transcript."
            registerOptions={BLANK_IS_ABSENT}
          />
        </FieldGrid>

        <SectionHeading level="h3" title="Guardian" className="mt-2" />
        <FieldGrid>
          <TextField form={form} name="guardianNameEn" label="Guardian name" required />
          <TextField
            form={form}
            name="guardianNameBn"
            label="Guardian name (Bangla)"
            optional
            lang="bn"
          />
          <SelectField
            form={form}
            name="guardianRelation"
            label="Relation to applicant"
            required
            options={GUARDIAN_RELATIONS.map((value) => ({ value, label: humanize(value) }))}
          />
          <TextField
            form={form}
            name="guardianPhone"
            label="Mobile number"
            required
            inputMode="tel"
            hint="Also the key used to find an existing guardian record on enrolment."
          />
          <TextField form={form} name="guardianEmail" label="Email" optional type="email" />
          <TextField
            form={form}
            name="guardianNid"
            label="National ID"
            optional
            inputMode="numeric"
            registerOptions={BLANK_IS_ABSENT}
          />
          <FieldGridSpan>
            <TextAreaField form={form} name="presentAddress" label="Present address" optional rows={2} />
          </FieldGridSpan>
        </FieldGrid>

        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Record application
          </Button>
        </FormActions>
      </Form>
    </Dialog>
  );
}
