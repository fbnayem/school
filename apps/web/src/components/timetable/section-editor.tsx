'use client';

/**
 * Editing one section's week in a draft routine.
 *
 * The API replaces a section's entries **set-at-a-time** — `PUT /timetables/:id/entries` takes
 * the section's complete week and either accepts all of it or refuses all of it with a 409
 * listing every clash. So this is one form over the whole week rather than a mutation per cell:
 * dragging six lessons around and sending six requests would pass through five states in which
 * the section is half-scheduled, and the fourth one failing would leave it there.
 *
 * That also makes the shared schema fit exactly. `replaceTimetableEntriesSchema` is the schema
 * the API validates the payload with, so a field error on `entries.3.subjectId` lands on the
 * lesson it belongs to.
 *
 * Editing is offered only for a **draft**. `assertDraft` refuses a published or archived
 * routine, and correctly: a printed routine handed to 900 students is a fact about the past as
 * much as a plan for the future. The caller decides whether to render this at all; the parent
 * screen explains the clone-to-edit route when it does not.
 *
 * A lesson is not moved between slots here. The day and the period are fixed when the cell is
 * chosen, and moving a lesson is remove-then-add — which is what the API's set-replace semantics
 * make it anyway, and is far less ambiguous than a half-built drag interaction.
 */

import { useMemo, useState } from 'react';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { replaceTimetableEntriesSchema } from '@shikkha/validation';
import { useSession } from '@/lib/session';
import { formatWeekday } from '@/lib/format';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  CheckboxField,
  Dialog,
  ErrorNotice,
  Form,
  SelectField,
  TextField,
  useToast,
  type SelectOption,
} from '@/components/ui';
import {
  academicApi,
  saveSectionEntries,
  timetableApi,
  type SectionRow,
  type Timetable,
  type TimetableEntry,
} from './api';
import { WeekGrid, type GridEntry, type GridPeriod } from './week-grid';

type RoutineValues = z.input<typeof replaceTimetableEntriesSchema>;

/**
 * An empty `<select>` posts `''`, which `uuidSchema.optional()` rejects as a malformed uuid
 * rather than reading as absent. Mapping it to `undefined` at registration is what makes
 * "no teacher decided yet" and "no fixed room" expressible — both of which the API allows.
 */
const optionalValue = {
  setValueAs: (value: unknown) => (value === '' || value === null ? undefined : String(value)),
};

export function SectionRoutineEditor({
  institutionId,
  timetable,
  section,
  periods,
  days,
  entries,
}: {
  institutionId: string;
  timetable: Timetable;
  section: SectionRow;
  periods: GridPeriod[];
  days: number[];
  entries: TimetableEntry[];
}) {
  const session = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [editing, setEditing] = useState<{ index: number; isNew: boolean } | null>(null);
  const [showChecks, setShowChecks] = useState(false);

  const form = useForm<RoutineValues>({
    resolver: zodResolver(replaceTimetableEntriesSchema),
    defaultValues: {
      sectionId: section.id,
      entries: entries.map((entry) => ({
        dayOfWeek: entry.dayOfWeek,
        periodId: entry.periodId,
        subjectId: entry.subjectId,
        employeeId: entry.employeeId ?? undefined,
        roomId: entry.roomId ?? undefined,
        isDoublePeriod: entry.isDoublePeriod,
        note: entry.note ?? undefined,
      })),
    },
  });

  const fields = useFieldArray({ control: form.control, name: 'entries' });
  const watchedRaw = useWatch({ control: form.control, name: 'entries' });
  // Memoised so its identity is stable: the grid below derives from it, and a fresh `[]` from
  // the `??` on every render would rebuild every cell on every keystroke in the dialog.
  const watched = useMemo(() => watchedRaw ?? [], [watchedRaw]);

  // ── Pickers, all from the API ───────────────────────────────────────────────────────

  const curriculum = useQuery({
    queryKey: ['timetable', 'curriculum', institutionId, section.academicYearId, section.classLevelId],
    queryFn: () =>
      academicApi.curriculum(institutionId, {
        academicYearId: section.academicYearId,
        classLevelId: section.classLevelId,
      }),
  });

  const rooms = useQuery({
    queryKey: ['timetable', 'rooms', institutionId, timetable.campusId],
    queryFn: () => academicApi.rooms(institutionId, { campusId: timetable.campusId }),
  });

  /**
   * Who may teach this section.
   *
   * `/academic/assignments` needs only `academic.sections.view`, which every role that can
   * manage a timetable holds — an academic coordinator does **not** hold `hr.employees.view`,
   * so a picker built solely on `/hr/employees` would be empty for exactly the person whose job
   * this is. The assignments are also the more useful list: the teacher who already teaches
   * that subject in that section.
   */
  const assignments = useQuery({
    queryKey: ['timetable', 'assignments', institutionId, section.id, section.academicYearId],
    queryFn: () =>
      academicApi.assignments(institutionId, {
        sectionId: section.id,
        academicYearId: section.academicYearId,
      }),
  });

  const canBrowseEmployees = session.can('hr.employees.view');

  const allEmployees = useQuery({
    queryKey: ['timetable', 'employees', institutionId],
    queryFn: () => academicApi.employees(institutionId),
    // Not rendered-and-403: the query only runs for someone who holds the permission, and the
    // picker falls back to the assignment list for everyone else.
    enabled: canBrowseEmployees,
  });

  const subjectOptions = useMemo<SelectOption[]>(
    () =>
      (curriculum.data ?? []).map((row) => ({
        value: row.subjectId,
        label: row.subjectNameEn,
        hint: row.subjectNameBn ?? row.subjectCode,
      })),
    [curriculum.data],
  );

  const teacherOptions = useMemo<SelectOption[]>(() => {
    const byId = new Map<string, SelectOption>();
    for (const row of assignments.data?.subjectAssignments ?? []) {
      byId.set(row.employeeId, {
        value: row.employeeId,
        label: row.employeeNameEn,
        hint: `teaches ${row.subjectNameEn} here`,
        group: 'Assigned to this section',
      });
    }
    for (const row of assignments.data?.sectionAssignments ?? []) {
      if (!byId.has(row.employeeId)) {
        byId.set(row.employeeId, {
          value: row.employeeId,
          label: row.employeeNameEn,
          hint: row.role.replace(/_/g, ' '),
          group: 'Assigned to this section',
        });
      }
    }
    const assigned = [...byId.values()];
    const others = (allEmployees.data?.data ?? [])
      .filter((employee) => !byId.has(employee.id))
      .map<SelectOption>((employee) => ({
        value: employee.id,
        label: employee.fullNameEn,
        hint: employee.employeeCode ?? undefined,
        group: 'Other staff',
      }));
    return [...assigned, ...others];
  }, [assignments.data, allEmployees.data]);

  const roomOptions = useMemo<SelectOption[]>(
    () =>
      (rooms.data ?? []).map((room) => ({
        value: room.id,
        label: room.nameEn,
        hint: room.code,
      })),
    [rooms.data],
  );

  const labelFor = (options: SelectOption[], value: string | undefined) =>
    options.find((option) => option.value === value)?.label ?? null;

  // ── The grid, rendered from form state ──────────────────────────────────────────────

  const displayEntries = useMemo<GridEntry[]>(
    () =>
      watched.map((entry, index) => ({
        id: String(index),
        dayOfWeek: Number(entry.dayOfWeek),
        periodId: entry.periodId,
        subjectName: labelFor(subjectOptions, entry.subjectId) ?? 'No subject chosen',
        subjectNameBn: null,
        sectionLabel: `${section.classLevelName} — ${section.nameEn}`,
        teacherName: labelFor(teacherOptions, entry.employeeId),
        roomLabel: labelFor(roomOptions, entry.roomId),
        isDoublePeriod: entry.isDoublePeriod === true,
        note: entry.note ?? null,
      })),
    [watched, subjectOptions, teacherOptions, roomOptions, section],
  );

  const save = useMutation({
    mutationFn: (body: z.infer<typeof replaceTimetableEntriesSchema>) =>
      saveSectionEntries(institutionId, timetable.id, body),
    onSuccess: async (result) => {
      toast.success(
        'Routine saved',
        `${result.entries.length} ${result.entries.length === 1 ? 'lesson' : 'lessons'} for this section.`,
      );
      await queryClient.invalidateQueries({ queryKey: ['timetable'] });
    },
  });

  const checks = useQuery({
    queryKey: ['timetable', 'validate', institutionId, timetable.id],
    queryFn: () => timetableApi.validate(institutionId, timetable.id),
    enabled: showChecks,
  });

  const openCell = (dayOfWeek: number, period: GridPeriod, entry: GridEntry | null) => {
    if (entry) {
      setEditing({ index: Number(entry.id), isNew: false });
      return;
    }
    fields.append({
      dayOfWeek,
      periodId: period.id,
      subjectId: '',
      employeeId: undefined,
      roomId: undefined,
      isDoublePeriod: false,
      note: undefined,
    });
    setEditing({ index: fields.fields.length, isNew: true });
  };

  const closeEditor = (discard: boolean) => {
    if (discard && editing?.isNew) fields.remove(editing.index);
    setEditing(null);
  };

  const editingValue = editing ? watched[editing.index] : undefined;

  return (
    <Card>
      <CardHeader
        title="Edit this section's week"
        description="Choose a slot to add or change a lesson. Saving replaces the section's whole week in one transaction; a clash with the rest of the routine refuses the entire save."
        actions={
          <Button size="sm" onClick={() => setShowChecks((current) => !current)}>
            {showChecks ? 'Hide clash check' : 'Check for clashes'}
          </Button>
        }
      />

      {showChecks ? (
        <div className="border-b border-line px-4 py-3 sm:px-5">
          <ValidationSummary
            isLoading={checks.isLoading}
            error={checks.error}
            report={checks.data ?? null}
          />
        </div>
      ) : null}

      <CardBody padded={false}>
        <Form
          form={form}
          onError={(error) => toast.error(error)}
          onSubmit={async (values) => {
            await save.mutateAsync({
              sectionId: values.sectionId,
              entries: values.entries.map((entry) => ({
                dayOfWeek: Number(entry.dayOfWeek),
                periodId: entry.periodId,
                subjectId: entry.subjectId,
                ...(entry.employeeId ? { employeeId: entry.employeeId } : {}),
                ...(entry.roomId ? { roomId: entry.roomId } : {}),
                isDoublePeriod: entry.isDoublePeriod === true,
                ...(entry.note ? { note: entry.note } : {}),
              })),
            });
          }}
        >
          <div className="px-4 sm:px-5">
            <WeekGrid
              days={days}
              periods={periods}
              entries={displayEntries}
              onSelectCell={openCell}
            />
          </div>

          <CardFooter>
            <p className="mr-auto text-sm text-content-muted">
              {watched.length} {watched.length === 1 ? 'lesson' : 'lessons'} in this section&rsquo;s
              week.
            </p>
            <Button
              type="submit"
              variant="primary"
              loading={save.isPending}
              loadingLabel="Saving…"
            >
              Save this section&rsquo;s week
            </Button>
          </CardFooter>
        </Form>
      </CardBody>

      {editing && editingValue ? (
        <Dialog
          open
          onClose={() => closeEditor(true)}
          title={editing.isNew ? 'Add a lesson' : 'Edit this lesson'}
          description={`${formatWeekday(Number(editingValue.dayOfWeek))} · ${
            periods.find((period) => period.id === editingValue.periodId)?.nameEn ?? 'Period'
          }`}
          closeOnBackdropClick={false}
          footer={
            <>
              {!editing.isNew ? (
                <Button
                  variant="danger"
                  className="mr-auto"
                  onClick={() => {
                    fields.remove(editing.index);
                    setEditing(null);
                  }}
                >
                  Remove lesson
                </Button>
              ) : null}
              <Button onClick={() => closeEditor(true)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={() => {
                  // Nothing is sent here — the lesson lives in form state until the whole week
                  // is saved, which is the only shape the API accepts.
                  setEditing(null);
                }}
              >
                Done
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <SelectField
              form={form}
              name={`entries.${editing.index}.subjectId`}
              label="Subject"
              required
              placeholder="Choose a subject"
              options={subjectOptions}
              hint={
                curriculum.isLoading
                  ? 'Loading the curriculum…'
                  : `The subjects on ${section.classLevelName}'s curriculum for this year.`
              }
            />

            <SelectField
              form={form}
              name={`entries.${editing.index}.employeeId`}
              label="Teacher"
              optional
              allowEmpty
              placeholder="Not decided yet"
              registerOptions={optionalValue}
              options={teacherOptions}
              hint={
                canBrowseEmployees
                  ? 'Teachers already assigned to this section come first.'
                  : 'Teachers assigned to this section. Assigning someone else needs the staff-directory permission.'
              }
            />

            <SelectField
              form={form}
              name={`entries.${editing.index}.roomId`}
              label="Room"
              optional
              allowEmpty
              placeholder="No fixed room"
              registerOptions={optionalValue}
              options={roomOptions}
              hint="Games, assembly and floating classes have no room."
            />

            <CheckboxField
              form={form}
              name={`entries.${editing.index}.isDoublePeriod`}
              label="Double period"
              hint="The lesson continues into the next period of the same shift. The clash check treats it as occupying both."
            />

            <TextField
              form={form}
              name={`entries.${editing.index}.note`}
              label="Note"
              optional
              maxLength={255}
              registerOptions={optionalValue}
              placeholder="Shown on the printed routine"
            />
          </div>
        </Dialog>
      ) : null}
    </Card>
  );
}

// ── Clash report ──────────────────────────────────────────────────────────────────────

export function ValidationSummary({
  isLoading,
  error,
  report,
}: {
  isLoading: boolean;
  error: unknown;
  report: {
    entryCount: number;
    isValid: boolean;
    conflicts: Array<{ kind: string; message: string; periodLabel: string; dayOfWeek: number }>;
    warnings: Array<{ message: string }>;
  } | null;
}) {
  if (error) return <ErrorNotice error={error} />;
  if (isLoading) return <p className="text-sm text-content-muted">Checking the routine…</p>;
  if (!report) return null;

  return (
    <div className="space-y-2">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={report.isValid ? 'success' : 'danger'}>
          {report.isValid ? 'No clashes' : `${report.conflicts.length} clashes`}
        </Badge>
        <span className="text-content-muted">
          {report.entryCount} {report.entryCount === 1 ? 'lesson' : 'lessons'} in this routine.
        </span>
      </p>

      {report.conflicts.length > 0 ? (
        <ul role="list" className="space-y-1 text-sm text-danger">
          {report.conflicts.map((conflict, index) => (
            <li key={index}>
              <span className="font-medium">{formatWeekday(conflict.dayOfWeek)}</span>,{' '}
              {conflict.periodLabel}: {conflict.message}
            </li>
          ))}
        </ul>
      ) : null}

      {report.warnings.length > 0 ? (
        <ul role="list" className="space-y-1 text-sm text-warning">
          {report.warnings.map((warning, index) => (
            <li key={index}>{warning.message}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
