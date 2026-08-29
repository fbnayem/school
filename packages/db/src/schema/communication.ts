/**
 * Communication centre (Phase 14).
 *
 * Nine tenant-scoped tables covering the four ways a school talks to its people:
 * tenant-editable notification templates, notice-board announcements, person-to-person
 * message threads, and mass notification campaigns with per-recipient delivery records.
 *
 * The design rules, stated once:
 *
 *  - **Messages are append-only.** `messages` gets the same database-level treatment as
 *    `audit_logs` and `behaviour_record_notes`: a trigger refuses UPDATE and DELETE outright
 *    (migration 0022) and the application role's UPDATE/DELETE privileges are revoked. A
 *    retraction is a *new* system message; what was said stays said.
 *  - **A mass send above the approval threshold needs two people.** `notification_campaigns`
 *    carries both `requested_by` and `approved_by`, and the database restates the rule that
 *    they must be different people (`notification_campaigns_approver_distinct`) — holding
 *    every permission does not get one person around it.
 *  - **No recipient snapshots.** A campaign stores its *audience definition* (a small jsonb
 *    describing who, e.g. `{"audience":"section","refId":...}`), never a list of phone
 *    numbers. Recipients are resolved at send time through the caller's data scope, and only
 *    the resolved *count* is recorded.
 *  - **Delivery status updates are idempotent**, keyed on `provider_message_id` — provider
 *    webhooks are redelivered, and the partial unique index makes the key a real key.
 *
 * Templates are a lookup table rather than an enum because every school writes its own;
 * channels, audiences and statuses are genuinely closed sets and are enums (see the enum
 * rule in `_shared.ts`).
 */

import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  actorColumns,
  archiveColumns,
  primaryKeyColumn,
  timestampColumns,
  versionColumn,
} from './_shared';
import { campuses, institutions, organizations } from './tenancy';
import { files } from './files';

// ─────────────────────────────────────────────────────────────────────────────────────
// Enumerations — closed value sets only. What a school invents for itself (its message
// templates) lives in `message_templates`, not here.
// ─────────────────────────────────────────────────────────────────────────────────────

export const communicationChannelEnum = pgEnum('communication_channel', [
  'sms',
  'email',
  'in_app',
  'push',
]);

export const announcementAudienceEnum = pgEnum('announcement_audience', [
  'all',
  'students',
  'guardians',
  'employees',
  'class',
  'section',
  'role',
]);

export const announcementStatusEnum = pgEnum('announcement_status', [
  'draft',
  'scheduled',
  'published',
  'archived',
]);

export const messageThreadKindEnum = pgEnum('message_thread_kind', ['direct', 'broadcast']);

export const notificationCampaignStatusEnum = pgEnum('notification_campaign_status', [
  'draft',
  'queued',
  'sending',
  'sent',
  'failed',
  'cancelled',
]);

export const notificationDeliveryStatusEnum = pgEnum('notification_delivery_status', [
  'queued',
  'sent',
  'delivered',
  'failed',
  'bounced',
]);

// ─────────────────────────────────────────────────────────────────────────────────────
// Tables
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A school's own notification templates, bilingual.
 *
 * The SMS cost question lives with the *body*: a Bangla body is UCS-2, which caps a message
 * part at 70 characters instead of 160. Part counts are computed per encoding by the
 * service (via `smsEncodingOf`, the single place that computation lives) and exposed on
 * every read and on the preview endpoint, so a template that silently triples the bill is
 * visible before anything is sent. The count is derived, so it is not stored here.
 */
export const messageTemplates = pgTable(
  'message_templates',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    /** Stable identifier campaigns and deliveries refer to; unique per institution. */
    key: varchar('key', { length: 64 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    channel: communicationChannelEnum('channel').notNull(),
    /** Required for email; ignored by SMS. */
    subject: varchar('subject', { length: 255 }),
    bodyEn: text('body_en').notNull(),
    bodyBn: text('body_bn'),
    /** The placeholder names (`{{name}}`) the bodies use — documentation, not enforcement. */
    variables: jsonb('variables')
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Seeded by the platform; a system template can be edited but not archived. */
    isSystem: boolean('is_system').notNull().default(false),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('message_templates_institution_key_key')
      .on(table.institutionId, table.key)
      .where(sql`${table.archivedAt} IS NULL`),
    index('message_templates_tenant_idx').on(table.tenantId),
    index('message_templates_institution_channel_idx').on(table.institutionId, table.channel),
  ],
);

/**
 * A notice-board announcement.
 *
 * `audience` + `audience_ref_id` describe who sees it: `class`, `section` and `role` carry
 * the id of the class level, section or role in `audience_ref_id` (deliberately no FK — the
 * column is polymorphic and the announcement must survive its target being archived).
 * Visibility is resolved per reader in the service, in SQL, from the same links a normal
 * read uses — a guardian sees a `section` announcement only if a child of theirs is enrolled
 * in that section.
 */
export const announcements = pgTable(
  'announcements',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    /** Null means every campus of the institution. */
    campusId: uuid('campus_id').references(() => campuses.id, { onDelete: 'restrict' }),
    title: varchar('title', { length: 255 }).notNull(),
    titleBn: varchar('title_bn', { length: 255 }),
    body: text('body').notNull(),
    bodyBn: text('body_bn'),
    audience: announcementAudienceEnum('audience').notNull().default('all'),
    /** Class level, section or role id when the audience needs one. Polymorphic; no FK. */
    audienceRefId: uuid('audience_ref_id'),
    /** When set in the future at publish time, the announcement is `scheduled` until then. */
    publishAt: timestamp('publish_at', { withTimezone: true, mode: 'date' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    status: announcementStatusEnum('status').notNull().default('draft'),
    publishedBy: uuid('published_by'),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('announcements_tenant_idx').on(table.tenantId),
    index('announcements_institution_status_idx').on(table.institutionId, table.status),
    index('announcements_audience_idx').on(
      table.institutionId,
      table.audience,
      table.audienceRefId,
    ),
    index('announcements_publish_idx').on(table.institutionId, table.publishAt),
  ],
);

/**
 * A read receipt: this user has seen this announcement. One per (announcement, user); the
 * unique index is total rather than partial because a receipt, once true, stays true.
 */
export const announcementReads = pgTable(
  'announcement_reads',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    announcementId: uuid('announcement_id')
      .notNull()
      .references(() => announcements.id, { onDelete: 'restrict' }),
    userId: uuid('user_id').notNull(),
    readAt: timestamp('read_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('announcement_reads_announcement_user_key').on(table.announcementId, table.userId),
    index('announcement_reads_tenant_idx').on(table.tenantId),
    index('announcement_reads_user_idx').on(table.userId),
  ],
);

/**
 * A conversation. `direct` is one creator and one counterpart; `broadcast` is one sender to
 * many recipients (staff only — the service refuses a broadcast from a student or guardian,
 * and a guardian may only open a thread with staff connected to their own children).
 */
export const messageThreads = pgTable(
  'message_threads',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    subject: varchar('subject', { length: 255 }).notNull(),
    kind: messageThreadKindEnum('kind').notNull().default('direct'),
    /**
     * Named distinctly from the audit column `created_by` (which is nullable and belongs to
     * `actorColumns()`): the creator of a thread is business data, not audit metadata.
     */
    createdByUserId: uuid('created_by_user_id').notNull(),
    /** Denormalised for inbox ordering; maintained inside the send transaction. */
    lastMessageAt: timestamp('last_message_at', { withTimezone: true, mode: 'date' }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('message_threads_tenant_idx').on(table.tenantId),
    index('message_threads_institution_idx').on(table.institutionId, table.lastMessageAt),
    index('message_threads_creator_idx').on(table.createdByUserId),
  ],
);

export const threadParticipants = pgTable(
  'thread_participants',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => messageThreads.id, { onDelete: 'restrict' }),
    userId: uuid('user_id').notNull(),
    /** 'owner' for the creator, 'member' for everyone else. */
    roleInThread: varchar('role_in_thread', { length: 32 }).notNull().default('member'),
    /** Read cursor for the unread count; null means never opened. */
    lastReadAt: timestamp('last_read_at', { withTimezone: true, mode: 'date' }),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('thread_participants_thread_user_key')
      .on(table.threadId, table.userId)
      .where(sql`${table.archivedAt} IS NULL`),
    index('thread_participants_tenant_idx').on(table.tenantId),
    index('thread_participants_user_idx').on(table.userId),
  ],
);

/**
 * One message in a thread. APPEND-ONLY: migration 0022 installs a trigger that refuses
 * UPDATE and DELETE for every role (the same mechanism as `audit_logs`), and revokes both
 * privileges from the application role besides. A retraction is a new `is_system` message;
 * the archive/updated columns exist to satisfy the schema conventions but are unreachable —
 * the trigger fires first.
 */
export const messages = pgTable(
  'messages',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => messageThreads.id, { onDelete: 'restrict' }),
    senderUserId: uuid('sender_user_id').notNull(),
    body: text('body').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    /** True for machine-generated entries: retraction notices, participant changes. */
    isSystem: boolean('is_system').notNull().default(false),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('messages_tenant_idx').on(table.tenantId),
    index('messages_thread_idx').on(table.threadId, table.sentAt),
    index('messages_sender_idx').on(table.senderUserId),
  ],
);

export const messageAttachments = pgTable(
  'message_attachments',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'restrict' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'restrict' }),
    storageKey: varchar('storage_key', { length: 512 }).notNull(),
    filename: varchar('filename', { length: 255 }).notNull(),
    mimeType: varchar('mime_type', { length: 128 }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('message_attachments_tenant_idx').on(table.tenantId),
    index('message_attachments_message_idx').on(table.messageId),
    index('message_attachments_file_idx').on(table.fileId),
  ],
);

/**
 * A mass send: one template, one channel, one audience definition.
 *
 * `audience` is the *definition* (`{"audience":"guardians"}`, `{"audience":"section",
 * "refId":...}`, optionally `{"variables":{...}}` for template substitution) — never a
 * resolved recipient list. Recipients are resolved at send time from the definition through
 * the sender's own data scope, and only `total_recipients` (a count) is recorded.
 *
 * The two-person rule: a campaign whose resolved audience exceeds the configured approval
 * threshold cannot be sent until a DIFFERENT user than `requested_by` has approved it. The
 * service refuses a self-approval by identity, and the check constraint
 * `notification_campaigns_approver_distinct` restates it in the database.
 */
export const notificationCampaigns = pgTable(
  'notification_campaigns',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    templateId: uuid('template_id')
      .notNull()
      .references(() => messageTemplates.id, { onDelete: 'restrict' }),
    channel: communicationChannelEnum('channel').notNull(),
    /** The audience DEFINITION. Never a snapshot of addresses. */
    audience: jsonb('audience').notNull(),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true, mode: 'date' }),
    status: notificationCampaignStatusEnum('status').notNull().default('draft'),
    requestedBy: uuid('requested_by').notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' }),
    /** Must differ from `requested_by`; enforced by service identity check AND check constraint. */
    approvedBy: uuid('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true, mode: 'date' }),
    /** Resolved at send time; a count, not a list. */
    totalRecipients: integer('total_recipients').notNull().default(0),
    sentCount: integer('sent_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
    cancelledReason: varchar('cancelled_reason', { length: 1000 }),
    cancelledBy: uuid('cancelled_by'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('notification_campaigns_tenant_idx').on(table.tenantId),
    index('notification_campaigns_institution_status_idx').on(table.institutionId, table.status),
    index('notification_campaigns_template_idx').on(table.templateId),
    index('notification_campaigns_requested_idx').on(table.requestedBy),
  ],
);

/**
 * One attempted delivery to one recipient, campaign-born or not.
 *
 * `provider_message_id` is the idempotency key for asynchronous delivery reports: providers
 * redeliver webhooks, so a status update either moves the row forward or is a recorded
 * no-op — never a second effect. The partial unique index makes the key a real key.
 */
export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    campaignId: uuid('campaign_id').references(() => notificationCampaigns.id, {
      onDelete: 'restrict',
    }),
    recipientUserId: uuid('recipient_user_id'),
    /** Email address, E.164 phone, or the user id itself for in_app/push. */
    recipientAddress: varchar('recipient_address', { length: 255 }).notNull(),
    channel: communicationChannelEnum('channel').notNull(),
    templateKey: varchar('template_key', { length: 64 }).notNull(),
    status: notificationDeliveryStatusEnum('status').notNull().default('queued'),
    providerMessageId: varchar('provider_message_id', { length: 128 }),
    error: varchar('error', { length: 1000 }),
    attempts: integer('attempts').notNull().default(0),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('notification_deliveries_provider_message_key')
      .on(table.providerMessageId)
      .where(sql`${table.providerMessageId} IS NOT NULL`),
    index('notification_deliveries_tenant_idx').on(table.tenantId),
    index('notification_deliveries_campaign_idx').on(table.campaignId, table.status),
    index('notification_deliveries_recipient_idx').on(table.recipientUserId),
    index('notification_deliveries_status_idx').on(table.status, table.createdAt),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Relations
// ─────────────────────────────────────────────────────────────────────────────────────

export const messageTemplatesRelations = relations(messageTemplates, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [messageTemplates.institutionId],
    references: [institutions.id],
  }),
  campaigns: many(notificationCampaigns),
}));

export const announcementsRelations = relations(announcements, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [announcements.institutionId],
    references: [institutions.id],
  }),
  campus: one(campuses, { fields: [announcements.campusId], references: [campuses.id] }),
  reads: many(announcementReads),
}));

export const announcementReadsRelations = relations(announcementReads, ({ one }) => ({
  announcement: one(announcements, {
    fields: [announcementReads.announcementId],
    references: [announcements.id],
  }),
}));

export const messageThreadsRelations = relations(messageThreads, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [messageThreads.institutionId],
    references: [institutions.id],
  }),
  participants: many(threadParticipants),
  messages: many(messages),
}));

export const threadParticipantsRelations = relations(threadParticipants, ({ one }) => ({
  thread: one(messageThreads, {
    fields: [threadParticipants.threadId],
    references: [messageThreads.id],
  }),
}));

export const messagesRelations = relations(messages, ({ one, many }) => ({
  thread: one(messageThreads, { fields: [messages.threadId], references: [messageThreads.id] }),
  attachments: many(messageAttachments),
}));

export const messageAttachmentsRelations = relations(messageAttachments, ({ one }) => ({
  message: one(messages, { fields: [messageAttachments.messageId], references: [messages.id] }),
  file: one(files, { fields: [messageAttachments.fileId], references: [files.id] }),
}));

export const notificationCampaignsRelations = relations(
  notificationCampaigns,
  ({ one, many }) => ({
    institution: one(institutions, {
      fields: [notificationCampaigns.institutionId],
      references: [institutions.id],
    }),
    template: one(messageTemplates, {
      fields: [notificationCampaigns.templateId],
      references: [messageTemplates.id],
    }),
    deliveries: many(notificationDeliveries),
  }),
);

export const notificationDeliveriesRelations = relations(notificationDeliveries, ({ one }) => ({
  campaign: one(notificationCampaigns, {
    fields: [notificationDeliveries.campaignId],
    references: [notificationCampaigns.id],
  }),
}));
