/**
 * Communication centre schemas (Phase 14).
 *
 * The shape of these schemas is itself a control:
 *
 *  - **A client never states a derived or decided fact.** There is no `status` on any
 *    create schema, no `approvedBy`, no `totalRecipients`, no `sentCount`. Campaigns move
 *    only through the dedicated submit/approve/send endpoints, which demand a reason where
 *    a reason is part of the record.
 *  - **An audience is a definition, never a list.** The campaign audience schema admits an
 *    audience kind and (where the kind needs one) a single reference id — there is no field
 *    a client could push a list of phone numbers into. Recipients are resolved server-side
 *    at send time, through the sender's own data scope.
 *  - **The delivery webhook schema is deliberately narrow**: a provider message id, a
 *    status, an optional error. Whatever else a provider posts is ignored, and nothing in
 *    the payload can address a delivery except by the idempotency key.
 *
 * Constants carry the `COMMUNICATION_`/`ANNOUNCEMENT_`/`MESSAGE_`/`NOTIFICATION_` prefixes
 * because `@shikkha/validation` re-exports flat.
 */

import { z } from 'zod';
import {
  paginationSchema,
  reasonSchema,
  searchSchema,
  sortSchema,
  uuidSchema,
} from './common';

const code = (max: number) =>
  z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]+$/, 'Use letters, numbers, hyphens and underscores only')
    .min(1)
    .max(max);

const isoInstant = z
  .string()
  .datetime({ offset: true, message: 'Use an ISO-8601 timestamp with a timezone offset' });

// ── Value sets, mirrored from the database enums ─────────────────────────────────────

export const COMMUNICATION_CHANNELS = ['sms', 'email', 'in_app', 'push'] as const;

export const ANNOUNCEMENT_AUDIENCES = [
  'all',
  'students',
  'guardians',
  'employees',
  'class',
  'section',
  'role',
] as const;

export const ANNOUNCEMENT_STATUSES = ['draft', 'scheduled', 'published', 'archived'] as const;

export const MESSAGE_THREAD_KINDS = ['direct', 'broadcast'] as const;

export const NOTIFICATION_CAMPAIGN_STATUSES = [
  'draft',
  'queued',
  'sending',
  'sent',
  'failed',
  'cancelled',
] as const;

export const NOTIFICATION_DELIVERY_STATUSES = [
  'queued',
  'sent',
  'delivered',
  'failed',
  'bounced',
] as const;

/** The audiences that are meaningless without a reference id (class, section or role). */
export const ANNOUNCEMENT_AUDIENCES_NEEDING_REF = ['class', 'section', 'role'] as const;

export const MESSAGE_TEMPLATE_SORT_FIELDS = ['key', 'name', 'channel', 'createdAt'] as const;

export const ANNOUNCEMENT_SORT_FIELDS = ['title', 'status', 'publishAt', 'createdAt'] as const;

export const NOTIFICATION_CAMPAIGN_SORT_FIELDS = ['status', 'scheduledFor', 'createdAt'] as const;

export const NOTIFICATION_DELIVERY_SORT_FIELDS = ['status', 'channel', 'createdAt'] as const;

// ── Message templates ────────────────────────────────────────────────────────────────

const templateVariables = z.array(code(64)).max(50).default([]);

export const createMessageTemplateSchema = z
  .object({
    key: code(64),
    name: z.string().trim().min(1).max(128),
    channel: z.enum(COMMUNICATION_CHANNELS),
    subject: z.string().trim().min(1).max(255).optional(),
    bodyEn: z.string().trim().min(1).max(10_000),
    bodyBn: z.string().trim().max(10_000).optional(),
    variables: templateVariables,
  })
  .superRefine((data, ctx) => {
    if (data.channel === 'email' && !data.subject) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['subject'],
        message: 'An email template needs a subject line',
      });
    }
  });

export type CreateMessageTemplateInput = z.infer<typeof createMessageTemplateSchema>;

export const updateMessageTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(128).optional(),
    subject: z.string().trim().min(1).max(255).nullable().optional(),
    bodyEn: z.string().trim().min(1).max(10_000).optional(),
    bodyBn: z.string().trim().max(10_000).nullable().optional(),
    variables: z.array(code(64)).max(50).optional(),
    /** Optimistic lock. Rejecting a stale write beats silently overwriting a colleague. */
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, {
    message: 'No changes were submitted',
  });

export type UpdateMessageTemplateInput = z.infer<typeof updateMessageTemplateSchema>;

export const listMessageTemplatesSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    channel: z.enum(COMMUNICATION_CHANNELS).optional(),
    includeArchived: z.coerce.boolean().default(false),
  });

export const archiveMessageTemplateSchema = z.object({ reason: reasonSchema });

/**
 * Part-count preview: how many billable SMS parts would these bodies cost, per encoding?
 * A Bangla body is UCS-2 (70 characters a part, 67 concatenated), a Latin one GSM 7-bit
 * (160/153) — a template that silently triples the bill must be visible before sending.
 */
export const previewTemplatePartsSchema = z.object({
  bodyEn: z.string().min(1).max(10_000),
  bodyBn: z.string().max(10_000).optional(),
  /** Sample values substituted into `{{placeholders}}` before counting. */
  variables: z.record(z.string().max(500)).optional(),
});

export type PreviewTemplatePartsInput = z.infer<typeof previewTemplatePartsSchema>;

// ── Announcements ────────────────────────────────────────────────────────────────────

export const createAnnouncementSchema = z
  .object({
    title: z.string().trim().min(1).max(255),
    titleBn: z.string().trim().max(255).optional(),
    body: z.string().trim().min(1).max(20_000),
    bodyBn: z.string().trim().max(20_000).optional(),
    campusId: uuidSchema.optional(),
    audience: z.enum(ANNOUNCEMENT_AUDIENCES).default('all'),
    /** The class level, section or role the audience refers to, when it needs one. */
    audienceRefId: uuidSchema.optional(),
    publishAt: isoInstant.optional(),
    expiresAt: isoInstant.optional(),
  })
  .superRefine((data, ctx) => {
    if (
      (ANNOUNCEMENT_AUDIENCES_NEEDING_REF as readonly string[]).includes(data.audience) &&
      !data.audienceRefId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['audienceRefId'],
        message: 'This audience needs the id of the class, section or role it refers to',
      });
    }
    if (
      data.publishAt &&
      data.expiresAt &&
      new Date(data.expiresAt).getTime() <= new Date(data.publishAt).getTime()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'The announcement cannot expire before it is published',
      });
    }
  });

export type CreateAnnouncementInput = z.infer<typeof createAnnouncementSchema>;

export const updateAnnouncementSchema = z
  .object({
    title: z.string().trim().min(1).max(255).optional(),
    titleBn: z.string().trim().max(255).nullable().optional(),
    body: z.string().trim().min(1).max(20_000).optional(),
    bodyBn: z.string().trim().max(20_000).nullable().optional(),
    campusId: uuidSchema.nullable().optional(),
    audience: z.enum(ANNOUNCEMENT_AUDIENCES).optional(),
    audienceRefId: uuidSchema.nullable().optional(),
    publishAt: isoInstant.nullable().optional(),
    expiresAt: isoInstant.nullable().optional(),
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, {
    message: 'No changes were submitted',
  });

export type UpdateAnnouncementInput = z.infer<typeof updateAnnouncementSchema>;

export const listAnnouncementsSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    status: z.enum(ANNOUNCEMENT_STATUSES).optional(),
    audience: z.enum(ANNOUNCEMENT_AUDIENCES).optional(),
    /** Managers only — the service refuses it without the publish permission. */
    includeUnpublished: z.coerce.boolean().default(false),
    unreadOnly: z.coerce.boolean().default(false),
  });

export const publishAnnouncementSchema = z.object({
  version: z.number().int().min(1),
});

export const archiveAnnouncementSchema = z.object({
  reason: reasonSchema,
  version: z.number().int().min(1),
});

// ── Message threads ──────────────────────────────────────────────────────────────────

export const createMessageThreadSchema = z
  .object({
    subject: z.string().trim().min(1).max(255),
    kind: z.enum(MESSAGE_THREAD_KINDS).default('direct'),
    /** The other people. The creator is always a participant and never listed here. */
    participantUserIds: z.array(uuidSchema).min(1).max(200),
    /** The opening message, written in the same transaction as the thread. */
    body: z.string().trim().min(1).max(10_000),
  })
  .superRefine((data, ctx) => {
    if (data.kind === 'direct' && data.participantUserIds.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['participantUserIds'],
        message: 'A direct thread has exactly one counterpart; use a broadcast for more',
      });
    }
    if (new Set(data.participantUserIds).size !== data.participantUserIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['participantUserIds'],
        message: 'The same person is listed twice',
      });
    }
  });

export type CreateMessageThreadInput = z.infer<typeof createMessageThreadSchema>;

export const listMessageThreadsSchema = paginationSchema.merge(searchSchema).extend({
  kind: z.enum(MESSAGE_THREAD_KINDS).optional(),
  unreadOnly: z.coerce.boolean().default(false),
});

export const sendMessageSchema = z.object({
  body: z.string().trim().min(1).max(10_000),
});

export type SendMessageInput = z.infer<typeof sendMessageSchema>;

/** A retraction is a NEW system message; the original stays. The reason is the record. */
export const retractMessageSchema = z.object({
  reason: reasonSchema,
});

export const commMessageAttachmentParamsSchema = z.object({
  id: uuidSchema,
  attachmentId: uuidSchema,
});

// ── Notification campaigns ───────────────────────────────────────────────────────────

/**
 * The audience DEFINITION. Deliberately closed: an audience kind, at most one reference
 * id, and optional template variables — no field can carry a recipient list, an address,
 * or a phone number. Recipients are resolved at send time, server-side, through the
 * sender's own permission and data scope.
 */
export const campaignAudienceSchema = z
  .object({
    audience: z.enum(ANNOUNCEMENT_AUDIENCES),
    refId: uuidSchema.optional(),
    /** Values substituted into the template's `{{placeholders}}` at send time. */
    variables: z.record(z.string().max(500)).optional(),
  })
  .superRefine((data, ctx) => {
    if (
      (ANNOUNCEMENT_AUDIENCES_NEEDING_REF as readonly string[]).includes(data.audience) &&
      !data.refId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['refId'],
        message: 'This audience needs the id of the class, section or role it refers to',
      });
    }
  });

export type CampaignAudienceInput = z.infer<typeof campaignAudienceSchema>;

export const createNotificationCampaignSchema = z.object({
  templateId: uuidSchema,
  audience: campaignAudienceSchema,
  scheduledFor: isoInstant.optional(),
});

export type CreateNotificationCampaignInput = z.infer<typeof createNotificationCampaignSchema>;

export const listNotificationCampaignsSchema = paginationSchema.merge(sortSchema).extend({
  status: z.enum(NOTIFICATION_CAMPAIGN_STATUSES).optional(),
  includeArchived: z.coerce.boolean().default(false),
});

export const submitNotificationCampaignSchema = z.object({
  version: z.number().int().min(1),
});

export const approveNotificationCampaignSchema = z.object({
  reason: reasonSchema,
  version: z.number().int().min(1),
});

export const cancelNotificationCampaignSchema = z.object({
  reason: reasonSchema,
  version: z.number().int().min(1),
});

export const sendNotificationCampaignSchema = z.object({
  version: z.number().int().min(1),
});

// ── Deliveries and the provider webhook ──────────────────────────────────────────────

export const listNotificationDeliveriesSchema = paginationSchema.merge(sortSchema).extend({
  campaignId: uuidSchema.optional(),
  status: z.enum(NOTIFICATION_DELIVERY_STATUSES).optional(),
  channel: z.enum(COMMUNICATION_CHANNELS).optional(),
});

/**
 * What a provider's delivery report may say. Applied by the service AFTER the signature
 * over the raw body verifies — never before, so hostile traffic is still recorded as an
 * attempt rather than bounced by a validation pipe.
 */
export const deliveryWebhookSchema = z.object({
  providerMessageId: z.string().trim().min(1).max(128),
  status: z.enum(['sent', 'delivered', 'failed', 'bounced']),
  error: z.string().trim().max(1000).optional(),
  occurredAt: isoInstant.optional(),
});

export type DeliveryWebhookInput = z.infer<typeof deliveryWebhookSchema>;
