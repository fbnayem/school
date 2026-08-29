'use client';

/**
 * Publishing a routine.
 *
 * Publishing is the moment a draft becomes the school's operating reality: it changes where 900
 * children are at 10am, and it silently retires the routine it replaces. Both of those are
 * shown here **before** the button is pressed, because "publish" is a one-way door and the
 * thing it archives is not named anywhere in the confirmation the API sends back.
 *
 * What the API does in one transaction, and what this screen therefore surfaces first:
 *
 *  1. Re-validates every clash — section, teacher and room, with a double period counted as the
 *     two slots it occupies. Any clash refuses the publish, listing all of them.
 *  2. Refuses a routine with no lessons at all.
 *  3. Archives the currently published routine for the same campus, academic year and term.
 *  4. Makes this one live from `effectiveFrom`.
 *
 * Step 3 is the one worth reading twice, and it is why the "will replace" panel is not
 * decorative. The candidate is found the same way the API finds it — same campus, same academic
 * year, same term (or no term) — from `GET /timetables`, not guessed.
 */

import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { publishTimetableSchema } from '@shikkha/validation';
import { useSession } from '@/lib/session';
import { formatLongDate } from '@/lib/format';
import {
  Badge,
  BilingualName,
  Button,
  Card,
  CardBody,
  CardHeader,
  DateField,
  DescriptionList,
  EmptyState,
  ErrorNotice,
  Form,
  FormActions,
  LoadingBlock,
  PageHeader,
  Dialog,
  ToastProvider,
  useToast,
} from '@/components/ui';
import { academicApi, timetableApi, type Timetable } from '@/components/timetable/api';
import { ValidationSummary } from '@/components/timetable/section-editor';

export default function TimetablePublishPage() {
  return (
    <ToastProvider>
      <PublishScreen />
    </ToastProvider>
  );
}

function PublishScreen() {
  const session = useSession();
  const institutionId = session.institutionId;

  const canPublish = session.can('timetable.publish');
  const canManage = session.can('timetable.manage');

  const [draftId, setDraftId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const years = useQuery({
    queryKey: ['timetable', 'years', institutionId],
    queryFn: () => academicApi.years(institutionId!),
    enabled: Boolean(institutionId),
  });

  const academicYearId = years.data?.find((year) => year.isCurrent)?.id ?? null;

  const drafts = useQuery({
    queryKey: ['timetable', 'list', institutionId, academicYearId, 'draft'],
    queryFn: () =>
      timetableApi.list(institutionId!, {
        page: 1,
        pageSize: 50,
        academicYearId: academicYearId ?? undefined,
        status: 'draft',
      }),
    enabled: Boolean(institutionId) && academicYearId !== null,
  });

  const published = useQuery({
    queryKey: ['timetable', 'list', institutionId, academicYearId, 'published'],
    queryFn: () =>
      timetableApi.list(institutionId!, {
        page: 1,
        pageSize: 50,
        academicYearId: academicYearId ?? undefined,
        status: 'published',
      }),
    enabled: Boolean(institutionId) && academicYearId !== null,
  });

  const draft = drafts.data?.data.find((row) => row.id === draftId) ?? null;

  /**
   * The routine this publish would archive: same campus, same academic year, same term — the
   * exact scope of the API's partial unique index, which is what makes "one published routine
   * per scope" true.
   */
  const superseded = useMemo(() => {
    if (!draft) return null;
    return (
      published.data?.data.find(
        (row) =>
          row.campusId === draft.campusId &&
          row.academicYearId === draft.academicYearId &&
          (row.termId ?? null) === (draft.termId ?? null) &&
          row.id !== draft.id,
      ) ?? null
    );
  }, [draft, published.data]);

  const checks = useQuery({
    queryKey: ['timetable', 'validate', institutionId, draftId],
    queryFn: () => timetableApi.validate(institutionId!, draftId!),
    // The validate route is gated on `timetable.manage`; without it the clash report is simply
    // not fetched rather than fetched and refused.
    enabled: canManage && Boolean(institutionId) && draftId !== null,
  });

  if (!institutionId) {
    return (
      <Card padded className="mx-auto max-w-2xl">
        <p className="font-medium">Choose an institution first</p>
        <p className="mt-1 text-sm text-content-muted">
          A routine belongs to one campus of one school.
        </p>
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Publish a routine"
        breadcrumbs={[{ label: 'Timetable', href: '/timetable' }, { label: 'Publish' }]}
        description="Publishing makes a draft the routine in force, and archives the one it replaces. Both are shown here before anything happens."
      />

      {years.error ? <ErrorNotice error={years.error} /> : null}

      <Card className="mb-5">
        <CardHeader
          title="Drafts"
          description="Only a draft can be published. A published routine is cloned into a new draft to change it."
        />
        <CardBody padded={false}>
          {drafts.isLoading ? (
            <div className="p-4">
              <LoadingBlock label="Loading drafts" />
            </div>
          ) : drafts.error ? (
            <div className="p-4">
              <ErrorNotice error={drafts.error} />
            </div>
          ) : (drafts.data?.data.length ?? 0) === 0 ? (
            <EmptyState
              title="No drafts to publish"
              description="Every routine for this academic year is already published or archived. Clone one to start a new draft."
            />
          ) : (
            <ul className="divide-y divide-line">
              {drafts.data!.data.map((row) => (
                <li key={row.id} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      <BilingualName row={row} />
                    </p>
                    <p className="text-sm text-content-muted">
                      Effective from {formatLongDate(row.effectiveFrom)} ·{' '}
                      {row.entryCount} {row.entryCount === 1 ? 'lesson' : 'lessons'}
                    </p>
                    {row.note ? (
                      <p className="mt-0.5 text-sm text-content-subtle">{row.note}</p>
                    ) : null}
                  </div>
                  <Button
                    size="sm"
                    variant={row.id === draftId ? 'primary' : 'secondary'}
                    onClick={() => setDraftId(row.id)}
                  >
                    {row.id === draftId ? 'Selected' : 'Review'}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {draft ? (
        <div className="space-y-5">
          <Card padded>
            <h2 className="text-lg font-semibold tracking-tight">
              <BilingualName row={draft} layout="stacked" />
            </h2>
            <DescriptionList
              className="mt-3"
              columns={3}
              items={[
                { label: 'Status', value: <Badge tone="warning">{draft.status}</Badge> },
                { label: 'Effective from', value: formatLongDate(draft.effectiveFrom) },
                { label: 'Lessons', value: draft.entryCount },
                { label: 'Note', value: draft.note, span: true },
              ]}
            />
          </Card>

          {canManage ? (
            <Card padded>
              <h2 className="mb-2 text-lg font-semibold tracking-tight">Clash check</h2>
              <p className="mb-3 text-sm text-content-muted">
                Run against the whole routine. Publishing re-runs exactly this check and refuses
                if anything is still clashing, so a clean result here is what makes the publish go
                through.
              </p>
              <ValidationSummary
                isLoading={checks.isLoading}
                error={checks.error}
                report={checks.data ?? null}
              />
            </Card>
          ) : null}

          <Card padded>
            <h2 className="mb-2 text-lg font-semibold tracking-tight">What this will replace</h2>
            {published.isLoading ? (
              <LoadingBlock label="Looking for the routine in force" />
            ) : published.error ? (
              <ErrorNotice error={published.error} />
            ) : superseded ? (
              <>
                <p className="text-sm text-content-muted">
                  Publishing will archive the routine below, which is the one currently in force
                  for this campus, academic year and term. It stays readable — attendance taken
                  against it has to remain readable against it — but it stops being live.
                </p>
                <div className="mt-3 rounded border border-warning/40 bg-warning-subtle px-3 py-2.5">
                  <p className="font-medium text-warning">
                    <BilingualName row={superseded} />
                  </p>
                  <p className="text-sm text-warning">
                    In force since {formatLongDate(superseded.effectiveFrom)} ·{' '}
                    {superseded.entryCount}{' '}
                    {superseded.entryCount === 1 ? 'lesson' : 'lessons'}
                  </p>
                </div>
              </>
            ) : (
              <p className="text-sm text-content-muted">
                Nothing is currently published for this campus, academic year and term, so this
                publish replaces nothing.
              </p>
            )}
          </Card>

          {/* Publishing is its own permission. Without it the button is absent — the API refuses
              the route regardless, and a visible-but-403 button teaches people to distrust the
              interface. */}
          {canPublish ? (
            <div className="flex justify-end">
              <Button variant="primary" onClick={() => setConfirming(true)}>
                Publish this routine
              </Button>
            </div>
          ) : (
            <p className="text-sm text-content-muted">
              You can review a draft but not publish it. Publishing is held separately from
              drafting, because putting a routine in force is a different decision from writing
              one.
            </p>
          )}

          <PublishDialog
            open={confirming}
            onClose={() => setConfirming(false)}
            institutionId={institutionId}
            draft={draft}
            supersededName={superseded?.nameEn ?? null}
            onPublished={() => {
              setConfirming(false);
              setDraftId(null);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

// ── The publish confirmation ──────────────────────────────────────────────────────────

type PublishValues = z.input<typeof publishTimetableSchema>;

function PublishDialog({
  open,
  onClose,
  institutionId,
  draft,
  supersededName,
  onPublished,
}: {
  open: boolean;
  onClose: () => void;
  institutionId: string;
  draft: Timetable & { entryCount: number };
  supersededName: string | null;
  onPublished: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const form = useForm<PublishValues>({
    resolver: zodResolver(publishTimetableSchema),
    // Pre-filled with the drafted date; the API keeps it when the field is left as it is.
    defaultValues: { effectiveFrom: draft.effectiveFrom },
  });

  const publish = useMutation({
    mutationFn: (effectiveFrom: string | undefined) =>
      timetableApi.publish(institutionId, draft.id, effectiveFrom),
    onSuccess: async (result) => {
      toast.success(
        'Routine published',
        result.supersededTimetableId
          ? 'It is now in force, and the routine it replaced has been archived.'
          : 'It is now the routine in force.',
      );
      await queryClient.invalidateQueries({ queryKey: ['timetable'] });
      onPublished();
    },
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Publish this routine?"
      description={draft.nameEn}
      closeOnBackdropClick={false}
    >
      <Form
        form={form}
        onError={(error) => toast.error(error)}
        onSubmit={async (values) => {
          await publish.mutateAsync(values.effectiveFrom || undefined);
        }}
      >
        <ul className="space-y-1.5 text-base text-content-muted">
          <li>
            {draft.entryCount} {draft.entryCount === 1 ? 'lesson' : 'lessons'} become the routine
            staff and students follow.
          </li>
          <li>
            {supersededName ? (
              <>
                <span className="font-medium text-content">{supersededName}</span> is archived in
                the same transaction.
              </>
            ) : (
              'No routine is currently in force for this scope, so nothing is archived.'
            )}
          </li>
          <li>
            Every clash is re-checked. If any remain, nothing is published and the API lists them.
          </li>
        </ul>

        <DateField
          form={form}
          name="effectiveFrom"
          label="In force from"
          hint="The first school day this routine applies to. Leave as drafted unless the date has moved."
        />

        <FormActions>
          <Button onClick={onClose} disabled={publish.isPending}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={publish.isPending}
            loadingLabel="Publishing…"
          >
            Publish
          </Button>
        </FormActions>
      </Form>
    </Dialog>
  );
}
