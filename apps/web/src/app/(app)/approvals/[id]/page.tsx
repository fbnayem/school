'use client';

/**
 * One workflow request: its context, its chain, its full history, and the decision.
 *
 * The decision controls are the point of the screen, so their visibility follows the engine's
 * actual rules rather than a single coarse permission. `assertMayDecide` in
 * `workflow.service.ts` refuses in this order, and three of the four are things the browser can
 * evaluate honestly from data it already has:
 *
 *  1. **You may not decide your own request** (KI-002) — checked against `initiatedBy`. This is
 *     not a permission failure and must never surface as one: the school owner holds every
 *     permission and is still refused. So it is explained in words, not hidden and not 403'd.
 *  2. **Four eyes across steps** — anyone who approved, rejected or sent back at an earlier
 *     step is out for the later ones. The history is on this page, so the exclusion is visible
 *     here and explained the same way.
 *  3. **The current step's `approverPermission`** — a concrete permission string, and
 *     `/auth/me` returns the caller's permissions already expanded, so `session.can()` answers
 *     it exactly.
 *  4. Campus/department scope and delegations, which the browser cannot evaluate. A user who
 *     passes 1–3 but fails these gets the API's 403 with its message and request id, which is
 *     the honest outcome — the API is the security boundary and re-checks everything.
 */

import { use, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import {
  approveWorkflowRequestSchema,
  cancelWorkflowRequestSchema,
  commentWorkflowRequestSchema,
  rejectWorkflowRequestSchema,
  sendBackWorkflowRequestSchema,
} from '@shikkha/validation';
import { useSession } from '@/lib/session';
import { formatInstant, formatRelative, humanize } from '@/lib/format';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DescriptionList,
  Dialog,
  ErrorNotice,
  Form,
  FormActions,
  PageHeader,
  SectionHeading,
  SelectField,
  SkeletonCard,
  TextAreaField,
  toneForStatus,
  useToast,
  type BadgeTone,
} from '@/components/ui';
import { PayloadView } from '@/components/workflow/payload-view';
import {
  ACTIONABLE_STATUSES,
  DECISIVE_ACTIONS,
  workflowApi,
  type WorkflowActionRecord,
  type WorkflowRequestDetail,
  type WorkflowStep,
} from '@/components/workflow/api';

type DecisionKind = 'approve' | 'reject' | 'send_back' | 'cancel' | 'comment' | null;

/**
 * Tone for a history entry's verb. `toneForStatus` maps *statuses*; these are actions, and it
 * correctly returns neutral for them. Mapping them here is a deliberate, complete decision over
 * the engine's closed action vocabulary rather than a guess.
 */
const ACTION_TONE: Record<WorkflowActionRecord['action'], BadgeTone> = {
  approve: 'success',
  reject: 'danger',
  send_back: 'warning',
  cancel: 'danger',
  escalate: 'warning',
  comment: 'neutral',
};

export default function ApprovalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const session = useSession();

  const detail = useQuery({
    queryKey: ['workflow-request', id, session.institutionId],
    queryFn: () => workflowApi.request(session.institutionId, id),
  });

  if (detail.isError) {
    return (
      <div className="mx-auto max-w-4xl">
        <ErrorNotice error={detail.error} />
        <Button className="mt-4" href="/approvals">
          Back to approvals
        </Button>
      </div>
    );
  }

  if (detail.isLoading || !detail.data) {
    return (
      <div className="mx-auto max-w-4xl">
        <SkeletonCard lines={8} label="Loading the request" />
      </div>
    );
  }

  return <RequestDetail id={id} detail={detail.data} />;
}

function RequestDetail({ id, detail }: { id: string; detail: WorkflowRequestDetail }) {
  const session = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<DecisionKind>(null);

  const { request, definition, steps, history } = detail;
  const currentStep = steps.find((step) => step.sequence === request.currentStepSequence) ?? null;
  const userId = session.user?.id ?? null;

  const isActionable = ACTIONABLE_STATUSES.includes(request.status);
  const isInitiator = userId !== null && request.initiatedBy === userId;

  // Four eyes: a decisive action by me at an *earlier* step disqualifies me from this one.
  const actedEarlier =
    userId !== null &&
    history.some(
      (action) =>
        action.actorUserId === userId &&
        DECISIVE_ACTIONS.includes(action.action) &&
        action.stepSequence < request.currentStepSequence,
    );

  const holdsStepPermission = currentStep ? session.can(currentStep.approverPermission) : false;

  const canDecide =
    isActionable &&
    session.can('workflows.act') &&
    currentStep !== null &&
    !isInitiator &&
    !actedEarlier &&
    holdsStepPermission;

  // Cancellation belongs to the person who raised the request, or to a workflow administrator.
  const canCancel = isActionable && (isInitiator || session.can('workflows.manage'));

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['workflow-request', id] });
    void queryClient.invalidateQueries({ queryKey: ['workflow-requests'] });
    void queryClient.invalidateQueries({ queryKey: ['workflow-overdue'] });
  };

  const close = () => setOpen(null);
  const succeed = (title: string) => {
    invalidate();
    close();
    toast.success(title);
  };

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        breadcrumbs={[{ label: 'Approvals', href: '/approvals' }, { label: 'Request' }]}
        title={request.summary}
        description={`${definition.nameEn} · version ${definition.version}`}
        meta={
          <>
            <Badge tone={toneForStatus(request.status)}>{humanize(request.status)}</Badge>
            <span className="text-content-muted">{humanize(request.entityType)}</span>
            <span className="text-content-muted">
              Step {request.currentStepSequence} of {steps.length}
            </span>
            <span className="text-content-muted" title={formatInstant(request.initiatedAt)}>
              Raised {formatRelative(request.initiatedAt)}
            </span>
          </>
        }
      />

      <div className="space-y-4">
        <Card as="section">
          <CardHeader
            title="Decision"
            description={
              isActionable
                ? 'Recorded permanently against your name, with your comment.'
                : 'This request has been decided. The history below is not rewritten.'
            }
          />
          <CardBody>
            <DecisionArea
              canDecide={canDecide}
              canCancel={canCancel}
              isActionable={isActionable}
              isInitiator={isInitiator}
              actedEarlier={actedEarlier}
              holdsStepPermission={holdsStepPermission}
              canAct={session.can('workflows.act')}
              currentStep={currentStep}
              status={request.status}
              onOpen={setOpen}
            />
          </CardBody>
        </Card>

        <Card as="section">
          <CardHeader title="What is being approved" headingLevel="h2" />
          <CardBody className="space-y-4">
            <DescriptionList
              items={[
                { label: 'Kind', value: humanize(request.entityType) },
                { label: 'Workflow', value: `${definition.nameEn} (${definition.key})` },
                {
                  label: 'Raised',
                  value: formatInstant(request.initiatedAt),
                },
                {
                  label: 'Raised by',
                  value: isInitiator ? 'You' : 'Another member of staff',
                },
                {
                  label: 'Due',
                  value: request.dueAt ? formatInstant(request.dueAt) : null,
                  emptyText: 'No SLA on this step',
                },
                {
                  label: 'Decided',
                  value: request.decidedAt ? formatInstant(request.decidedAt) : null,
                  emptyText: 'Not yet decided',
                },
              ]}
            />
            <div>
              <SectionHeading level="h3" title="Attached detail" className="mb-2" />
              <PayloadView payload={request.payload} />
            </div>
          </CardBody>
        </Card>

        <Card as="section">
          <CardHeader
            title="Approval chain"
            description="Approvers are resolved by permission at decision time, never stored by name."
          />
          <CardBody>
            <StepList steps={steps} currentSequence={request.currentStepSequence} />
          </CardBody>
        </Card>

        <Card as="section">
          <CardHeader
            title="History"
            description="Append-only. A send-back adds a record; it never erases the approval it reverses."
          />
          <CardBody>
            <HistoryList history={history} steps={steps} userId={userId} />
          </CardBody>
        </Card>
      </div>

      <ApproveDialog
        open={open === 'approve'}
        onClose={close}
        onDone={() => succeed('Approved')}
        onError={(error) => toast.error(error)}
        requestId={id}
      />
      <RejectDialog
        open={open === 'reject'}
        onClose={close}
        onDone={() => succeed('Rejected')}
        onError={(error) => toast.error(error)}
        requestId={id}
        onReject={currentStep?.onReject ?? 'terminate'}
      />
      <SendBackDialog
        open={open === 'send_back'}
        onClose={close}
        onDone={() => succeed('Sent back')}
        onError={(error) => toast.error(error)}
        requestId={id}
        steps={steps.filter((step) => step.sequence < request.currentStepSequence)}
      />
      <CancelDialog
        open={open === 'cancel'}
        onClose={close}
        onDone={() => succeed('Request cancelled')}
        onError={(error) => toast.error(error)}
        requestId={id}
      />
      <CommentDialog
        open={open === 'comment'}
        onClose={close}
        onDone={() => succeed('Comment added')}
        onError={(error) => toast.error(error)}
        requestId={id}
      />
    </div>
  );
}

// ── Decision area ─────────────────────────────────────────────────────────────────────

function DecisionArea({
  canDecide,
  canCancel,
  isActionable,
  isInitiator,
  actedEarlier,
  holdsStepPermission,
  canAct,
  currentStep,
  status,
  onOpen,
}: {
  canDecide: boolean;
  canCancel: boolean;
  isActionable: boolean;
  isInitiator: boolean;
  actedEarlier: boolean;
  holdsStepPermission: boolean;
  canAct: boolean;
  currentStep: WorkflowStep | null;
  status: string;
  onOpen: (kind: DecisionKind) => void;
}) {
  return (
    <div className="space-y-3">
      {/* The refusals the engine will apply, said in words. A greyed-out Approve button with no
          explanation is how a head teacher concludes the software is broken. */}
      {isActionable && isInitiator ? (
        <Notice tone="info">
          You raised this request, so you cannot decide it. Approvals require a second person —
          this holds regardless of the permissions you hold, including for a school owner.
        </Notice>
      ) : null}

      {isActionable && !isInitiator && actedEarlier ? (
        <Notice tone="info">
          You already acted on this request at an earlier step. A different approver has to
          decide this one, so that two people have looked at it.
        </Notice>
      ) : null}

      {isActionable && !isInitiator && !actedEarlier && canAct && !holdsStepPermission ? (
        <Notice tone="info">
          This step is decided by someone holding{' '}
          <code className="rounded bg-surface-muted px-1 py-0.5 text-xs">
            {currentStep?.approverPermission}
          </code>
          {currentStep && currentStep.approverScope !== 'institution'
            ? ` within the same ${currentStep.approverScope}`
            : ''}
          . You can follow the request here and comment on it.
        </Notice>
      ) : null}

      {!isActionable ? (
        <Notice tone="neutral">
          This request is {humanize(status).toLowerCase()} and can no longer be moved.
        </Notice>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {canDecide ? (
          <>
            <Button variant="primary" onClick={() => onOpen('approve')}>
              Approve
            </Button>
            <Button variant="danger" onClick={() => onOpen('reject')}>
              Reject
            </Button>
            {/* Send back needs an earlier step to send it to; at step 1 there is none. */}
            {currentStep && currentStep.sequence > 1 ? (
              <Button onClick={() => onOpen('send_back')}>Send back</Button>
            ) : null}
          </>
        ) : null}
        {canCancel ? <Button onClick={() => onOpen('cancel')}>Cancel request</Button> : null}
        <Button variant="ghost" onClick={() => onOpen('comment')}>
          Add a comment
        </Button>
      </div>
    </div>
  );
}

function Notice({ tone, children }: { tone: 'info' | 'neutral'; children: React.ReactNode }) {
  return (
    <p
      className={
        tone === 'info'
          ? 'rounded-md border border-line bg-info-subtle px-3 py-2 text-sm text-info'
          : 'rounded-md border border-line bg-surface-muted px-3 py-2 text-sm text-content-muted'
      }
    >
      {children}
    </p>
  );
}

// ── Chain and history ─────────────────────────────────────────────────────────────────

function StepList({ steps, currentSequence }: { steps: WorkflowStep[]; currentSequence: number }) {
  return (
    <ol className="space-y-2">
      {steps.map((step) => {
        const isCurrent = step.sequence === currentSequence;
        return (
          <li
            key={step.id}
            className={
              isCurrent
                ? 'rounded-md border border-accent-300 bg-accent-50 p-3'
                : 'rounded-md border border-line p-3'
            }
          >
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-xs tabular-nums text-content-subtle">Step {step.sequence}</span>
              <span className="font-medium">{step.nameEn}</span>
              {step.nameBn ? (
                <span lang="bn" className="text-content-muted">
                  {step.nameBn}
                </span>
              ) : null}
              {isCurrent ? <Badge tone="accent">Current</Badge> : null}
              {step.isOptional ? <Badge tone="neutral">Optional</Badge> : null}
            </div>
            <p className="mt-1 text-xs text-content-muted">
              Decided by{' '}
              <code className="rounded bg-surface-muted px-1 py-0.5">{step.approverPermission}</code>{' '}
              at {step.approverScope} scope
              {step.slaHours ? ` · ${step.slaHours}h SLA` : ''} · on rejection:{' '}
              {humanize(step.onReject)}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

function HistoryList({
  history,
  steps,
  userId,
}: {
  history: WorkflowActionRecord[];
  steps: WorkflowStep[];
  userId: string | null;
}) {
  if (history.length === 0) {
    return (
      <p className="text-sm text-content-muted">
        No decisions or comments have been recorded on this request yet.
      </p>
    );
  }

  return (
    <ol className="space-y-3">
      {history.map((action) => {
        const step = steps.find((candidate) => candidate.sequence === action.stepSequence);
        return (
          <li key={action.id} className="border-l-2 border-line pl-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={ACTION_TONE[action.action]}>
                {humanize(action.action)}
              </Badge>
              <span className="text-sm">
                {/* Actor names are not available: no endpoint in the platform exposes a user
                    directory, so "You" is the only identity this screen can state truthfully.
                    The audit log holds the actor id for anyone investigating. */}
                {action.actorUserId === userId ? 'You' : 'Another member of staff'}
                {action.onBehalfOfUserId ? ' (acting under a delegation)' : ''}
              </span>
              <span className="text-xs text-content-subtle" title={formatInstant(action.actedAt)}>
                {formatRelative(action.actedAt)}
              </span>
              {step ? (
                <span className="text-xs text-content-subtle">
                  at step {step.sequence} — {step.nameEn}
                </span>
              ) : null}
            </div>
            {action.comment ? (
              <p className="mt-1 whitespace-pre-wrap text-sm text-content-muted">
                {action.comment}
              </p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

// ── Decision dialogs ──────────────────────────────────────────────────────────────────

interface DecisionDialogProps {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  onError: (error: unknown) => void;
  requestId: string;
}

function ApproveDialog({ open, onClose, onDone, onError, requestId }: DecisionDialogProps) {
  const session = useSession();
  const form = useForm<z.input<typeof approveWorkflowRequestSchema>>({
    resolver: zodResolver(approveWorkflowRequestSchema),
    defaultValues: { comment: '' },
  });
  const approve = useMutation({
    mutationFn: (values: z.input<typeof approveWorkflowRequestSchema>) =>
      workflowApi.approve(session.institutionId, requestId, values),
    onSuccess: onDone,
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Approve this request"
      description="Your approval moves the request to the next step, or completes it if this is the last one."
      closeOnBackdropClick={false}
    >
      <Form form={form} onSubmit={async (values) => {
          // `await`, not `return`: the promise must reject *inside* `Form` so the 422 path
          // applies the API's field errors. Returning it would also type-error on void.
          await approve.mutateAsync(values);
        }} onError={onError}>
        <TextAreaField
          form={form}
          name="comment"
          label="Comment"
          optional
          rows={3}
          hint="Optional on an approval, and kept permanently."
        />
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={approve.isPending}>
            Approve
          </Button>
        </FormActions>
      </Form>
    </Dialog>
  );
}

function RejectDialog({
  open,
  onClose,
  onDone,
  onError,
  requestId,
  onReject,
}: DecisionDialogProps & { onReject: WorkflowStep['onReject'] }) {
  const session = useSession();
  const form = useForm<z.input<typeof rejectWorkflowRequestSchema>>({
    resolver: zodResolver(rejectWorkflowRequestSchema),
    defaultValues: { comment: '' },
  });
  const reject = useMutation({
    mutationFn: (values: z.input<typeof rejectWorkflowRequestSchema>) =>
      workflowApi.reject(session.institutionId, requestId, values),
    onSuccess: onDone,
  });

  // What rejection does is a property of the step, not of this dialog — say which one applies
  // so the approver knows whether they are ending the request or returning it for rework.
  const consequence =
    onReject === 'terminate'
      ? 'This ends the request. It cannot be reopened.'
      : onReject === 'send_back'
        ? 'This returns the request to the first step for rework.'
        : 'This returns the request to the previous step for rework.';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Reject this request"
      description={consequence}
      closeOnBackdropClick={false}
    >
      <Form form={form} onSubmit={async (values) => {
          // `await`, not `return`: the promise must reject *inside* `Form` so the 422 path
          // applies the API's field errors. Returning it would also type-error on void.
          await reject.mutateAsync(values);
        }} onError={onError}>
        <TextAreaField
          form={form}
          name="comment"
          label="Why are you rejecting this?"
          required
          rows={4}
          hint="At least 10 characters. This is the reason recorded in the audit trail."
        />
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" loading={reject.isPending}>
            Reject
          </Button>
        </FormActions>
      </Form>
    </Dialog>
  );
}

function SendBackDialog({
  open,
  onClose,
  onDone,
  onError,
  requestId,
  steps,
}: DecisionDialogProps & { steps: WorkflowStep[] }) {
  const session = useSession();
  const form = useForm<z.input<typeof sendBackWorkflowRequestSchema>>({
    resolver: zodResolver(sendBackWorkflowRequestSchema),
    defaultValues: { targetSequence: steps[0]?.sequence ?? 1, comment: '' },
  });
  const sendBack = useMutation({
    mutationFn: (values: z.input<typeof sendBackWorkflowRequestSchema>) =>
      workflowApi.sendBack(session.institutionId, requestId, values),
    onSuccess: onDone,
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Send back to an earlier step"
      description="Every decision taken so far stays in the history; this adds a record, it does not erase one."
      closeOnBackdropClick={false}
    >
      <Form form={form} onSubmit={async (values) => {
          // `await`, not `return`: the promise must reject *inside* `Form` so the 422 path
          // applies the API's field errors. Returning it would also type-error on void.
          await sendBack.mutateAsync(values);
        }} onError={onError}>
        <SelectField
          form={form}
          name="targetSequence"
          label="Send back to"
          required
          // The schema wants a number; a select always yields a string.
          registerOptions={{ valueAsNumber: true }}
          options={steps.map((step) => ({
            value: String(step.sequence),
            label: `Step ${step.sequence} — ${step.nameEn}`,
          }))}
        />
        <TextAreaField
          form={form}
          name="comment"
          label="What needs to change?"
          required
          rows={4}
          hint="At least 10 characters. The person at that step reads this."
        />
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={sendBack.isPending}>
            Send back
          </Button>
        </FormActions>
      </Form>
    </Dialog>
  );
}

function CancelDialog({ open, onClose, onDone, onError, requestId }: DecisionDialogProps) {
  const session = useSession();
  const form = useForm<z.input<typeof cancelWorkflowRequestSchema>>({
    resolver: zodResolver(cancelWorkflowRequestSchema),
    defaultValues: { comment: '' },
  });
  const cancel = useMutation({
    mutationFn: (values: z.input<typeof cancelWorkflowRequestSchema>) =>
      workflowApi.cancel(session.institutionId, requestId, values),
    onSuccess: onDone,
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Cancel this request"
      description="Cancelling withdraws the request. It cannot be reopened — a new request would have to be raised."
      closeOnBackdropClick={false}
    >
      <Form form={form} onSubmit={async (values) => {
          // `await`, not `return`: the promise must reject *inside* `Form` so the 422 path
          // applies the API's field errors. Returning it would also type-error on void.
          await cancel.mutateAsync(values);
        }} onError={onError}>
        <TextAreaField
          form={form}
          name="comment"
          label="Why are you cancelling?"
          required
          rows={4}
          hint="At least 10 characters, recorded permanently."
        />
        <FormActions>
          <Button onClick={onClose}>Keep the request</Button>
          <Button type="submit" variant="danger" loading={cancel.isPending}>
            Cancel request
          </Button>
        </FormActions>
      </Form>
    </Dialog>
  );
}

function CommentDialog({ open, onClose, onDone, onError, requestId }: DecisionDialogProps) {
  const session = useSession();
  const form = useForm<z.input<typeof commentWorkflowRequestSchema>>({
    resolver: zodResolver(commentWorkflowRequestSchema),
    defaultValues: { comment: '' },
  });
  const comment = useMutation({
    mutationFn: (values: z.input<typeof commentWorkflowRequestSchema>) =>
      workflowApi.comment(session.institutionId, requestId, values),
    onSuccess: onDone,
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add a comment"
      description="A comment is conversation. It is recorded in the history and does not move the request."
      closeOnBackdropClick={false}
    >
      <Form form={form} onSubmit={async (values) => {
          // `await`, not `return`: the promise must reject *inside* `Form` so the 422 path
          // applies the API's field errors. Returning it would also type-error on void.
          await comment.mutateAsync(values);
        }} onError={onError}>
        <TextAreaField form={form} name="comment" label="Comment" required rows={4} />
        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={comment.isPending}>
            Add comment
          </Button>
        </FormActions>
      </Form>
    </Dialog>
  );
}
