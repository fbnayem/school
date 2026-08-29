/**
 * Communication centre service (Phase 14).
 *
 * The rules this module exists to enforce, stated once:
 *
 *  1. **Sensitive mass communication is never autonomous.** A campaign whose resolved
 *     audience exceeds the configurable approval threshold cannot be sent until a
 *     DIFFERENT user than the requester has explicitly approved it. The refusal is by
 *     identity, before permissions are consulted, so a school owner holding every
 *     permission still cannot approve their own blast — and the database restates the rule
 *     as `notification_campaigns_approver_distinct`.
 *  2. **Recipients are resolved at SEND time from the audience definition**, through the
 *     same permission and data-scope rules as a normal read (`resolveDataScope` over the
 *     students triple, `hr.employees.view` for staff, `users.view` for role audiences).
 *     Only the resolved *count* is recorded. No snapshot of phone numbers exists anywhere.
 *  3. **A guardian may only message staff connected to their own children** — the class
 *     teacher of, or a subject teacher in, a section one of their children is actively
 *     enrolled in. A student reaches the staff of their own section. Neither may ever
 *     broadcast. All of it is SQL, server-side; an unconnected staff id gets the same 404
 *     a nonexistent user gets.
 *  4. **Messages are append-only.** There is no edit or delete path in this file, the
 *     database refuses UPDATE and DELETE by trigger (migration 0022), and a retraction is
 *     a new system message.
 *  5. **Bangla SMS is UCS-2** — 70 characters a part, not 160. Part counts per encoding
 *     come from `smsEncodingOf`, the single place that computation lives (the existing
 *     notification provider abstraction), and are exposed on template reads, on the
 *     preview endpoint, and in the campaign send audit record.
 *  6. **Delivery reports are idempotent**, keyed on `provider_message_id`: a redelivered
 *     webhook either moves a delivery's status strictly forward or is a recorded no-op.
 *
 * Transport note: this module deliberately builds on the notification provider
 * abstraction in `../notifications` rather than growing a second one. Email uses the same
 * SMTP client behind the same `NOTIFICATIONS_EMAIL_DRIVER` switch; SMS has no vendor
 * integrated by design (docs/09_INTEGRATIONS.md) and uses the console transport, which
 * still computes the real encoding and part count so the billing arithmetic is honest
 * before any vendor exists.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, exists, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm';
import {
  announcementReads,
  announcements,
  employees,
  employeeSectionAssignments,
  employeeSubjectAssignments,
  enrollments,
  files,
  guardians,
  messageAttachments,
  messages,
  messageTemplates,
  messageThreads,
  notificationCampaigns,
  notificationDeliveries,
  studentGuardians,
  students,
  threadParticipants,
  userRoles,
  users,
} from '@shikkha/db';
import {
  buildOffsetPage,
  ConflictError,
  ForbiddenError,
  ImmutableRecordError,
  NotFoundError,
  offsetOf,
  parseSort,
  ValidationError,
  WorkflowStateError,
  type OffsetPage,
  type OffsetPageRequest,
} from '@shikkha/shared';
import { can, resolveDataScope, SCOPED_RESOURCES, type DataScope, type Principal } from '@shikkha/permissions';
import {
  ANNOUNCEMENT_SORT_FIELDS,
  deliveryWebhookSchema,
  MESSAGE_TEMPLATE_SORT_FIELDS,
  NOTIFICATION_CAMPAIGN_SORT_FIELDS,
  NOTIFICATION_DELIVERY_SORT_FIELDS,
  type CampaignAudienceInput,
  type CreateAnnouncementInput,
  type CreateMessageTemplateInput,
  type CreateMessageThreadInput,
  type CreateNotificationCampaignInput,
  type PreviewTemplatePartsInput,
  type SendMessageInput,
  type UpdateAnnouncementInput,
  type UpdateMessageTemplateInput,
} from '@shikkha/validation';
import { smsEncodingOf, type SmsEncodingInfo } from '../notifications/notification.provider';
import { sendSmtpMail } from '../notifications/smtp.client';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';
import { currentContext } from '../../common/context/request-context';

/** The transaction handle `runInTenant` hands to its callback. */
export type Tx = Parameters<Parameters<DatabaseService['runInTenant']>[0]>[0];

export type MessageTemplateRow = typeof messageTemplates.$inferSelect;
export type AnnouncementRow = typeof announcements.$inferSelect;
export type MessageThreadRow = typeof messageThreads.$inferSelect;
export type ThreadParticipantRow = typeof threadParticipants.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type MessageAttachmentRow = typeof messageAttachments.$inferSelect;
export type NotificationCampaignRow = typeof notificationCampaigns.$inferSelect;
export type NotificationDeliveryRow = typeof notificationDeliveries.$inferSelect;

/** The slice of a multipart upload this service needs; matches Multer's file object. */
export interface UploadedFileLike {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/** A resolved campaign recipient. Exists only in memory during a send — never stored. */
interface ResolvedRecipient {
  userId: string;
  address: string;
}

export interface ListMessageTemplatesQuery {
  page: number;
  pageSize: number;
  sort?: string;
  q?: string;
  channel?: MessageTemplateRow['channel'];
  includeArchived: boolean;
}

export interface ListAnnouncementsQuery {
  page: number;
  pageSize: number;
  sort?: string;
  q?: string;
  status?: AnnouncementRow['status'];
  audience?: AnnouncementRow['audience'];
  includeUnpublished: boolean;
  unreadOnly: boolean;
}

export interface ListMessageThreadsQuery {
  page: number;
  pageSize: number;
  q?: string;
  kind?: MessageThreadRow['kind'];
  unreadOnly: boolean;
}

export interface ListNotificationCampaignsQuery {
  page: number;
  pageSize: number;
  sort?: string;
  status?: NotificationCampaignRow['status'];
  includeArchived: boolean;
}

export interface ListNotificationDeliveriesQuery {
  page: number;
  pageSize: number;
  sort?: string;
  campaignId?: string;
  status?: NotificationDeliveryRow['status'];
  channel?: NotificationDeliveryRow['channel'];
}

/** Part counts per language, so the bill is visible before anything is sent. */
export interface TemplatePartCounts {
  en: SmsEncodingInfo;
  bn: SmsEncodingInfo | null;
}

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

const DOWNLOAD_TTL_SECONDS = 300;

/** How many messages one thread read returns; older history stays queryable by paging. */
const THREAD_MESSAGE_LIMIT = 200;

const DEFAULT_APPROVAL_THRESHOLD = 50;

/**
 * The mass-send approval threshold: a campaign resolving to MORE recipients than this
 * requires a second person. Read at call time so a deployment can configure it without a
 * rebuild; the default errs on the side of requiring approval.
 */
export function campaignApprovalThreshold(): number {
  const raw = process.env['COMMUNICATION_APPROVAL_THRESHOLD'];
  if (raw === undefined || raw === '') return DEFAULT_APPROVAL_THRESHOLD;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_APPROVAL_THRESHOLD;
}

/** The header a delivery-status provider carries the webhook signature in. */
export const DELIVERY_SIGNATURE_HEADER = 'x-delivery-signature';

/**
 * The webhook signing secret. Overridable so a deployment can rotate it, defaulted so
 * development and tests need no configuration — the same pattern as the mock payment
 * gateway.
 */
export function deliveryWebhookSecret(): string {
  return process.env['COMMUNICATION_WEBHOOK_SECRET'] ?? 'shikkha-communication-webhook-secret';
}

/** Compute the signature a delivery provider would attach. Exported for the test suite. */
export function signDeliveryWebhook(rawBody: string): string {
  return createHmac('sha256', deliveryWebhookSecret()).update(rawBody, 'utf8').digest('hex');
}

/** Status progression for idempotent delivery reports. Equal-or-backward rank is a no-op. */
const DELIVERY_STATUS_RANK: Record<NotificationDeliveryRow['status'], number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  failed: 2,
  bounced: 2,
};

@Injectable()
export class CommunicationService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  // ════════════════════════════════════════════════════════════════════════════════════
  // Message templates
  // ════════════════════════════════════════════════════════════════════════════════════

  async listTemplates(
    _principal: Principal,
    institutionId: string,
    query: ListMessageTemplatesQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<MessageTemplateRow & { smsParts: TemplatePartCounts | null }>> {
    return this.db.runInTenant(async (tx) => {
      const conditions: SQL[] = [eq(messageTemplates.institutionId, institutionId)];
      if (!query.includeArchived) conditions.push(isNull(messageTemplates.archivedAt));
      if (query.channel) conditions.push(eq(messageTemplates.channel, query.channel));
      if (query.q) {
        conditions.push(
          or(
            ilike(messageTemplates.key, `%${query.q}%`),
            ilike(messageTemplates.name, `%${query.q}%`),
          )!,
        );
      }
      const where = and(...conditions);

      const orderBy = parseSort(query.sort, MESSAGE_TEMPLATE_SORT_FIELDS, {
        field: 'key',
        direction: 'asc',
      }).map((spec) => {
        const column = TEMPLATE_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(messageTemplates)
        .where(where)
        .orderBy(...orderBy, asc(messageTemplates.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(messageTemplates)
        .where(where);

      return buildOffsetPage(
        rows.map((row) => ({ ...row, smsParts: this.partCountsOf(row) })),
        counted?.total ?? 0,
        page,
      );
    });
  }

  async getTemplate(
    _principal: Principal,
    institutionId: string,
    id: string,
  ): Promise<MessageTemplateRow & { smsParts: TemplatePartCounts | null }> {
    return this.db.runInTenant(async (tx) => {
      const template = await this.loadTemplate(tx, institutionId, id);
      return { ...template, smsParts: this.partCountsOf(template) };
    });
  }

  async createTemplate(
    principal: Principal,
    institutionId: string,
    input: CreateMessageTemplateInput,
  ): Promise<MessageTemplateRow & { smsParts: TemplatePartCounts | null }> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select({ id: messageTemplates.id })
        .from(messageTemplates)
        .where(
          and(
            eq(messageTemplates.institutionId, institutionId),
            eq(messageTemplates.key, input.key),
            isNull(messageTemplates.archivedAt),
          ),
        )
        .limit(1);
      if (existing) {
        throw new ConflictError(`A template with the key "${input.key}" already exists`, {
          key: input.key,
        });
      }

      const [template] = await tx
        .insert(messageTemplates)
        .values({
          tenantId: principal.tenantId!,
          institutionId,
          key: input.key,
          name: input.name,
          channel: input.channel,
          subject: input.subject ?? null,
          bodyEn: input.bodyEn,
          bodyBn: input.bodyBn ?? null,
          variables: input.variables,
          createdBy: principal.userId,
        })
        .returning();

      return { ...template!, smsParts: this.partCountsOf(template!) };
    });
  }

  async updateTemplate(
    principal: Principal,
    institutionId: string,
    id: string,
    input: UpdateMessageTemplateInput,
  ): Promise<{
    template: MessageTemplateRow & { smsParts: TemplatePartCounts | null };
    previous: Partial<MessageTemplateRow>;
  }> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadTemplate(tx, institutionId, id);
      const { version, ...changes } = input;

      const [updated] = await tx
        .update(messageTemplates)
        .set({
          ...(changes as Partial<MessageTemplateRow>),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(messageTemplates.id, id), eq(messageTemplates.version, version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This template was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      const previous: Partial<MessageTemplateRow> = {};
      for (const key of Object.keys(changes) as (keyof MessageTemplateRow)[]) {
        if (JSON.stringify(existing[key]) !== JSON.stringify(updated[key])) {
          (previous as Record<string, unknown>)[key] = existing[key];
        }
      }

      return { template: { ...updated, smsParts: this.partCountsOf(updated) }, previous };
    });
  }

  async archiveTemplate(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<MessageTemplateRow> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadTemplate(tx, institutionId, id);
      if (existing.isSystem) {
        throw new ImmutableRecordError('Template', 'system templates cannot be archived');
      }

      const [archived] = await tx
        .update(messageTemplates)
        .set({
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(messageTemplates.id, id), isNull(messageTemplates.archivedAt)))
        .returning();
      if (!archived) throw new NotFoundError('Template', id);
      return archived;
    });
  }

  /**
   * Part-count preview for arbitrary bodies, before a template is even saved. Sample
   * variables are substituted first, because `{{name}}` and the name it becomes rarely
   * have the same length — and the substituted value may drag a Latin body into UCS-2.
   */
  previewParts(input: PreviewTemplatePartsInput): {
    en: SmsEncodingInfo;
    bn: SmsEncodingInfo | null;
  } {
    const en = smsEncodingOf(substituteVariables(input.bodyEn, input.variables ?? {}));
    const bn = input.bodyBn
      ? smsEncodingOf(substituteVariables(input.bodyBn, input.variables ?? {}))
      : null;
    return { en, bn };
  }

  private partCountsOf(template: MessageTemplateRow): TemplatePartCounts | null {
    if (template.channel !== 'sms') return null;
    return {
      en: smsEncodingOf(template.bodyEn),
      bn: template.bodyBn ? smsEncodingOf(template.bodyBn) : null,
    };
  }

  private async loadTemplate(
    tx: Tx,
    institutionId: string,
    id: string,
  ): Promise<MessageTemplateRow> {
    const [template] = await tx
      .select()
      .from(messageTemplates)
      .where(
        and(eq(messageTemplates.id, id), eq(messageTemplates.institutionId, institutionId)),
      )
      .limit(1);
    if (!template || template.archivedAt) throw new NotFoundError('Template', id);
    return template;
  }

  // ════════════════════════════════════════════════════════════════════════════════════
  // Announcements
  // ════════════════════════════════════════════════════════════════════════════════════

  async createAnnouncement(
    principal: Principal,
    institutionId: string,
    input: CreateAnnouncementInput,
  ): Promise<AnnouncementRow> {
    return this.db.runInTenant(async (tx) => {
      const [announcement] = await tx
        .insert(announcements)
        .values({
          tenantId: principal.tenantId!,
          institutionId,
          campusId: input.campusId ?? null,
          title: input.title,
          titleBn: input.titleBn ?? null,
          body: input.body,
          bodyBn: input.bodyBn ?? null,
          audience: input.audience,
          audienceRefId: input.audienceRefId ?? null,
          publishAt: input.publishAt ? new Date(input.publishAt) : null,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          createdBy: principal.userId,
        })
        .returning();
      return announcement!;
    });
  }

  async updateAnnouncement(
    principal: Principal,
    institutionId: string,
    id: string,
    input: UpdateAnnouncementInput,
  ): Promise<{ announcement: AnnouncementRow; previous: Partial<AnnouncementRow> }> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadAnnouncementForManage(tx, institutionId, id);
      if (existing.status === 'published' || existing.status === 'archived') {
        throw new ImmutableRecordError(
          'Announcement',
          'a published or archived notice cannot be edited; archive it and publish a new one',
        );
      }

      const { version, publishAt, expiresAt, ...rest } = input;
      const changes: Partial<AnnouncementRow> = { ...(rest as Partial<AnnouncementRow>) };
      if (publishAt !== undefined) changes.publishAt = publishAt ? new Date(publishAt) : null;
      if (expiresAt !== undefined) changes.expiresAt = expiresAt ? new Date(expiresAt) : null;

      const [updated] = await tx
        .update(announcements)
        .set({ ...changes, version: existing.version + 1, updatedBy: principal.userId })
        .where(and(eq(announcements.id, id), eq(announcements.version, version)))
        .returning();
      if (!updated) {
        throw new ConflictError(
          'This announcement was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      const previous: Partial<AnnouncementRow> = {};
      for (const key of Object.keys(changes) as (keyof AnnouncementRow)[]) {
        if (JSON.stringify(existing[key]) !== JSON.stringify(updated[key])) {
          (previous as Record<string, unknown>)[key] = existing[key];
        }
      }
      return { announcement: updated, previous };
    });
  }

  async publishAnnouncement(
    principal: Principal,
    institutionId: string,
    id: string,
    version: number,
  ): Promise<AnnouncementRow> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadAnnouncementForManage(tx, institutionId, id);
      if (existing.status !== 'draft' && existing.status !== 'scheduled') {
        throw new WorkflowStateError(existing.status, 'published', 'announcement');
      }

      const now = new Date();
      const scheduled = existing.publishAt !== null && existing.publishAt.getTime() > now.getTime();

      const [updated] = await tx
        .update(announcements)
        .set({
          // A future publish_at means "scheduled": visible once the moment passes, with
          // the person who queued it recorded as the publisher either way.
          status: scheduled ? 'scheduled' : 'published',
          publishedBy: principal.userId,
          publishedAt: now,
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(announcements.id, id), eq(announcements.version, version)))
        .returning();
      if (!updated) {
        throw new ConflictError('This announcement was changed by someone else. Reload and retry.', {
          expectedVersion: version,
          currentVersion: existing.version,
        });
      }
      return updated;
    });
  }

  async archiveAnnouncement(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
    version: number,
  ): Promise<AnnouncementRow> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadAnnouncementForManage(tx, institutionId, id);
      const [archived] = await tx
        .update(announcements)
        .set({
          status: 'archived',
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(announcements.id, id), eq(announcements.version, version)))
        .returning();
      if (!archived) {
        throw new ConflictError('This announcement was changed by someone else. Reload and retry.', {
          expectedVersion: version,
          currentVersion: existing.version,
        });
      }
      return archived;
    });
  }

  /**
   * The audience-scoped list. Readers see only live notices whose audience includes them,
   * resolved in SQL from the same links a normal read uses; a manager holding
   * `communication.notices.publish` may ask for the full management view instead.
   */
  async listAnnouncements(
    principal: Principal,
    institutionId: string,
    query: ListAnnouncementsQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<AnnouncementRow & { isRead: boolean }>> {
    const isManager = can(principal, 'communication.notices.publish');
    if (query.includeUnpublished && !isManager) {
      throw new ForbiddenError(
        'communication.notices.publish',
        'Only notice managers can list unpublished announcements',
      );
    }

    return this.db.runInTenant(async (tx) => {
      const conditions: SQL[] = [eq(announcements.institutionId, institutionId)];
      if (query.includeUnpublished) {
        conditions.push(isNull(announcements.archivedAt));
      } else {
        conditions.push(this.announcementVisibleFilter(principal));
      }
      if (query.status) conditions.push(eq(announcements.status, query.status));
      if (query.audience) conditions.push(eq(announcements.audience, query.audience));
      if (query.q) {
        conditions.push(
          or(ilike(announcements.title, `%${query.q}%`), ilike(announcements.body, `%${query.q}%`))!,
        );
      }
      if (query.unreadOnly) {
        conditions.push(sql`not ${this.readReceiptExists(principal)}`);
      }
      const where = and(...conditions);

      const orderBy = parseSort(query.sort, ANNOUNCEMENT_SORT_FIELDS, {
        field: 'createdAt',
        direction: 'desc',
      }).map((spec) => {
        const column = ANNOUNCEMENT_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select({
          announcement: announcements,
          isRead: sql<boolean>`${this.readReceiptExists(principal)}`,
        })
        .from(announcements)
        .where(where)
        .orderBy(...orderBy, asc(announcements.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(announcements)
        .where(where);

      return buildOffsetPage(
        rows.map((row) => ({ ...row.announcement, isRead: row.isRead })),
        counted?.total ?? 0,
        page,
      );
    });
  }

  async getAnnouncement(
    principal: Principal,
    institutionId: string,
    id: string,
  ): Promise<AnnouncementRow & { isRead: boolean }> {
    const isManager = can(principal, 'communication.notices.publish');
    return this.db.runInTenant(async (tx) => {
      const [row] = await tx
        .select({
          announcement: announcements,
          isRead: sql<boolean>`${this.readReceiptExists(principal)}`,
        })
        .from(announcements)
        .where(
          and(
            eq(announcements.id, id),
            eq(announcements.institutionId, institutionId),
            // A manager reaches drafts; a reader only what their audience filter shows.
            // Failure is 404, never 403 — an out-of-scope id must look nonexistent.
            isManager ? isNull(announcements.archivedAt) : this.announcementVisibleFilter(principal),
          ),
        )
        .limit(1);
      if (!row) throw new NotFoundError('Announcement', id);
      return { ...row.announcement, isRead: row.isRead };
    });
  }

  /** Idempotent by the unique index: reading twice is one receipt. */
  async markAnnouncementRead(
    principal: Principal,
    institutionId: string,
    id: string,
  ): Promise<{ announcementId: string; readAt: Date }> {
    return this.db.runInTenant(async (tx) => {
      const [visible] = await tx
        .select({ id: announcements.id })
        .from(announcements)
        .where(
          and(
            eq(announcements.id, id),
            eq(announcements.institutionId, institutionId),
            this.announcementVisibleFilter(principal),
          ),
        )
        .limit(1);
      if (!visible) throw new NotFoundError('Announcement', id);

      const readAt = new Date();
      await tx
        .insert(announcementReads)
        .values({
          tenantId: principal.tenantId!,
          institutionId,
          announcementId: id,
          userId: principal.userId,
          readAt,
          createdBy: principal.userId,
        })
        .onConflictDoNothing();

      return { announcementId: id, readAt };
    });
  }

  /**
   * Which live announcements this principal's audience membership lets them see.
   * Resolved from the same links a normal read uses: a guardian's `student_guardians`
   * rows, a student's active enrollment, an employee's employee record, a user's roles.
   */
  private announcementVisibleFilter(principal: Principal): SQL {
    const now = sql`now()`;
    const live = and(
      isNull(announcements.archivedAt),
      or(
        eq(announcements.status, 'published'),
        and(eq(announcements.status, 'scheduled'), sql`${announcements.publishAt} <= ${now}`),
      )!,
      or(isNull(announcements.expiresAt), sql`${announcements.expiresAt} > ${now}`)!,
    )!;

    const audienceConditions: SQL[] = [eq(announcements.audience, 'all')];

    if (principal.studentId) {
      audienceConditions.push(eq(announcements.audience, 'students'));
      audienceConditions.push(
        and(
          eq(announcements.audience, 'class'),
          this.studentInClassOrSection(principal.studentId, 'class'),
        )!,
        and(
          eq(announcements.audience, 'section'),
          this.studentInClassOrSection(principal.studentId, 'section'),
        )!,
      );
    }
    if (principal.guardianId) {
      audienceConditions.push(eq(announcements.audience, 'guardians'));
      audienceConditions.push(
        and(
          eq(announcements.audience, 'class'),
          this.guardianChildInClassOrSection(principal.guardianId, 'class'),
        )!,
        and(
          eq(announcements.audience, 'section'),
          this.guardianChildInClassOrSection(principal.guardianId, 'section'),
        )!,
      );
    }
    if (principal.employeeId) {
      audienceConditions.push(eq(announcements.audience, 'employees'));
    }

    // Role-targeted notices reach anyone holding that role in this tenant.
    audienceConditions.push(
      and(
        eq(announcements.audience, 'role'),
        exists(
          this.db.raw
            .select({ one: sql`1` })
            .from(userRoles)
            .where(
              and(
                eq(userRoles.userId, principal.userId),
                sql`${userRoles.roleId} = ${announcements.audienceRefId}`,
              ),
            ),
        ),
      )!,
    );

    return and(live, or(...audienceConditions)!)!;
  }

  private studentInClassOrSection(studentId: string, kind: 'class' | 'section'): SQL {
    const refMatch =
      kind === 'class'
        ? sql`${enrollments.classLevelId} = ${announcements.audienceRefId}`
        : sql`${enrollments.sectionId} = ${announcements.audienceRefId}`;
    return exists(
      this.db.raw
        .select({ one: sql`1` })
        .from(enrollments)
        .where(
          and(
            eq(enrollments.studentId, studentId),
            eq(enrollments.status, 'active'),
            isNull(enrollments.archivedAt),
            refMatch,
          ),
        ),
    );
  }

  private guardianChildInClassOrSection(guardianId: string, kind: 'class' | 'section'): SQL {
    const refMatch =
      kind === 'class'
        ? sql`${enrollments.classLevelId} = ${announcements.audienceRefId}`
        : sql`${enrollments.sectionId} = ${announcements.audienceRefId}`;
    return exists(
      this.db.raw
        .select({ one: sql`1` })
        .from(studentGuardians)
        .innerJoin(enrollments, eq(enrollments.studentId, studentGuardians.studentId))
        .where(
          and(
            eq(studentGuardians.guardianId, guardianId),
            eq(studentGuardians.canAccessPortal, true),
            isNull(studentGuardians.archivedAt),
            eq(enrollments.status, 'active'),
            isNull(enrollments.archivedAt),
            refMatch,
          ),
        ),
    );
  }

  private readReceiptExists(principal: Principal): SQL {
    return exists(
      this.db.raw
        .select({ one: sql`1` })
        .from(announcementReads)
        .where(
          and(
            sql`${announcementReads.announcementId} = ${announcements.id}`,
            eq(announcementReads.userId, principal.userId),
          ),
        ),
    );
  }

  private async loadAnnouncementForManage(
    tx: Tx,
    institutionId: string,
    id: string,
  ): Promise<AnnouncementRow> {
    const [announcement] = await tx
      .select()
      .from(announcements)
      .where(and(eq(announcements.id, id), eq(announcements.institutionId, institutionId)))
      .limit(1);
    if (!announcement || announcement.archivedAt) throw new NotFoundError('Announcement', id);
    return announcement;
  }

  // ════════════════════════════════════════════════════════════════════════════════════
  // Message threads
  // ════════════════════════════════════════════════════════════════════════════════════

  /**
   * Open a thread and write its first message in one transaction.
   *
   * Who may reach whom is decided here, server-side, in this order:
   *  1. `broadcast` requires `communication.send` — a student or guardian may NEVER
   *     broadcast, whatever else they hold.
   *  2. A staff caller with `communication.send` may open a direct thread with any active
   *     user of the tenant.
   *  3. A guardian may only reach staff connected to their own children; a student, the
   *     staff of their own section. An unconnected staff id gets the same 404 a
   *     nonexistent user gets — confirming reachability is itself a leak.
   */
  async createThread(
    principal: Principal,
    institutionId: string,
    input: CreateMessageThreadInput,
  ): Promise<{ thread: MessageThreadRow; message: MessageRow }> {
    const isStaffSender = can(principal, 'communication.send');

    if (input.kind === 'broadcast' && !isStaffSender) {
      throw new ForbiddenError(
        'communication.send',
        'Broadcasts are limited to staff with the send permission',
      );
    }
    if (input.participantUserIds.includes(principal.userId)) {
      throw new ValidationError('You are already a participant of your own thread', [
        { path: 'participantUserIds', message: 'Do not list yourself' },
      ]);
    }

    return this.db.runInTenant(async (tx) => {
      // Every listed participant must be a live user of this tenant (RLS already scopes
      // the query); anything else is a 404 naming the first missing id.
      const targets = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            inArray(users.id, input.participantUserIds),
            eq(users.status, 'active'),
            isNull(users.archivedAt),
          ),
        );
      const found = new Set(targets.map((row) => row.id));
      const missing = input.participantUserIds.find((id) => !found.has(id));
      if (missing) throw new NotFoundError('User', missing);

      if (!isStaffSender) {
        if (!principal.guardianId && !principal.studentId) {
          throw new ForbiddenError('communication.send', 'You cannot start conversations');
        }
        const reachable = await this.reachableStaffUserIds(tx, principal, institutionId);
        const outside = input.participantUserIds.find((id) => !reachable.has(id));
        if (outside) {
          // Not a 403: the answer for staff not connected to this caller's children is
          // indistinguishable from a user that does not exist.
          throw new NotFoundError('User', outside);
        }
      }

      const [thread] = await tx
        .insert(messageThreads)
        .values({
          tenantId: principal.tenantId!,
          institutionId,
          subject: input.subject,
          kind: input.kind,
          createdByUserId: principal.userId,
          lastMessageAt: new Date(),
          createdBy: principal.userId,
        })
        .returning();

      await tx.insert(threadParticipants).values([
        {
          tenantId: principal.tenantId!,
          institutionId,
          threadId: thread!.id,
          userId: principal.userId,
          roleInThread: 'owner',
          lastReadAt: new Date(),
          createdBy: principal.userId,
        },
        ...input.participantUserIds.map((userId) => ({
          tenantId: principal.tenantId!,
          institutionId,
          threadId: thread!.id,
          userId,
          roleInThread: 'member',
          createdBy: principal.userId,
        })),
      ]);

      const [message] = await tx
        .insert(messages)
        .values({
          tenantId: principal.tenantId!,
          institutionId,
          threadId: thread!.id,
          senderUserId: principal.userId,
          body: input.body,
          createdBy: principal.userId,
        })
        .returning();

      return { thread: thread!, message: message! };
    });
  }

  async listThreads(
    principal: Principal,
    institutionId: string,
    query: ListMessageThreadsQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<MessageThreadRow & { unread: boolean }>> {
    return this.db.runInTenant(async (tx) => {
      const membership = this.participantFilter(principal);
      const unread = this.threadUnreadSql(principal);

      const conditions: SQL[] = [
        eq(messageThreads.institutionId, institutionId),
        isNull(messageThreads.archivedAt),
        membership,
      ];
      if (query.kind) conditions.push(eq(messageThreads.kind, query.kind));
      if (query.q) conditions.push(ilike(messageThreads.subject, `%${query.q}%`));
      if (query.unreadOnly) conditions.push(unread);
      const where = and(...conditions);

      const rows = await tx
        .select({ thread: messageThreads, unread: sql<boolean>`${unread}` })
        .from(messageThreads)
        .where(where)
        .orderBy(desc(messageThreads.lastMessageAt), asc(messageThreads.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(messageThreads)
        .where(where);

      return buildOffsetPage(
        rows.map((row) => ({ ...row.thread, unread: row.unread })),
        counted?.total ?? 0,
        page,
      );
    });
  }

  async getThread(
    principal: Principal,
    institutionId: string,
    id: string,
  ): Promise<{
    thread: MessageThreadRow;
    participants: ThreadParticipantRow[];
    messages: (MessageRow & { attachments: MessageAttachmentRow[] })[];
  }> {
    return this.db.runInTenant(async (tx) => {
      const thread = await this.loadVisibleThread(tx, principal, institutionId, id);

      const participants = await tx
        .select()
        .from(threadParticipants)
        .where(and(eq(threadParticipants.threadId, id), isNull(threadParticipants.archivedAt)))
        .orderBy(asc(threadParticipants.createdAt));

      const rows = await tx
        .select()
        .from(messages)
        .where(eq(messages.threadId, id))
        .orderBy(desc(messages.sentAt), desc(messages.id))
        .limit(THREAD_MESSAGE_LIMIT);
      rows.reverse();

      const attachmentRows =
        rows.length > 0
          ? await tx
              .select()
              .from(messageAttachments)
              .where(
                and(
                  inArray(
                    messageAttachments.messageId,
                    rows.map((row) => row.id),
                  ),
                  isNull(messageAttachments.archivedAt),
                ),
              )
          : [];
      const byMessage = new Map<string, MessageAttachmentRow[]>();
      for (const attachment of attachmentRows) {
        const list = byMessage.get(attachment.messageId) ?? [];
        list.push(attachment);
        byMessage.set(attachment.messageId, list);
      }

      return {
        thread,
        participants,
        messages: rows.map((row) => ({ ...row, attachments: byMessage.get(row.id) ?? [] })),
      };
    });
  }

  async sendMessage(
    principal: Principal,
    institutionId: string,
    threadId: string,
    input: SendMessageInput,
  ): Promise<MessageRow> {
    return this.db.runInTenant(async (tx) => {
      const thread = await this.loadVisibleThread(tx, principal, institutionId, threadId);

      const [message] = await tx
        .insert(messages)
        .values({
          tenantId: principal.tenantId!,
          institutionId,
          threadId: thread.id,
          senderUserId: principal.userId,
          body: input.body,
          createdBy: principal.userId,
        })
        .returning();

      await tx
        .update(messageThreads)
        .set({ lastMessageAt: message!.sentAt, updatedBy: principal.userId })
        .where(eq(messageThreads.id, thread.id));

      return message!;
    });
  }

  /**
   * A retraction is a NEW system message — the original stays exactly as sent, because
   * the messages table refuses UPDATE and DELETE at the database level.
   */
  async retractMessage(
    principal: Principal,
    institutionId: string,
    messageId: string,
    reason: string,
  ): Promise<MessageRow> {
    return this.db.runInTenant(async (tx) => {
      const [original] = await tx
        .select()
        .from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.institutionId, institutionId)))
        .limit(1);
      if (!original) throw new NotFoundError('Message', messageId);
      // Only the sender may retract, and the check is identity, not permission.
      if (original.senderUserId !== principal.userId) throw new NotFoundError('Message', messageId);
      if (original.isSystem) {
        throw new ValidationError('System messages cannot be retracted', [
          { path: 'id', message: 'This is a system message' },
        ]);
      }

      const [retraction] = await tx
        .insert(messages)
        .values({
          tenantId: principal.tenantId!,
          institutionId,
          threadId: original.threadId,
          senderUserId: principal.userId,
          body: `The sender retracted their message of ${original.sentAt.toISOString()}: ${reason}`,
          isSystem: true,
          createdBy: principal.userId,
        })
        .returning();

      await tx
        .update(messageThreads)
        .set({ lastMessageAt: retraction!.sentAt, updatedBy: principal.userId })
        .where(eq(messageThreads.id, original.threadId));

      return retraction!;
    });
  }

  async markThreadRead(
    principal: Principal,
    institutionId: string,
    threadId: string,
  ): Promise<{ threadId: string; lastReadAt: Date }> {
    return this.db.runInTenant(async (tx) => {
      await this.loadVisibleThread(tx, principal, institutionId, threadId);
      const lastReadAt = new Date();
      await tx
        .update(threadParticipants)
        .set({ lastReadAt, updatedBy: principal.userId })
        .where(
          and(
            eq(threadParticipants.threadId, threadId),
            eq(threadParticipants.userId, principal.userId),
            isNull(threadParticipants.archivedAt),
          ),
        );
      return { threadId, lastReadAt };
    });
  }

  // ── Message attachments ─────────────────────────────────────────────────────────────

  async addMessageAttachment(
    principal: Principal,
    institutionId: string,
    messageId: string,
    file: UploadedFileLike,
  ): Promise<MessageAttachmentRow> {
    const mimeType = this.checkUpload(file);
    const tenantId = principal.tenantId!;

    // The bytes are written before the transaction: if the transaction fails, the orphaned
    // object is invisible (no `files` row) and swept by the incomplete-upload cleanup job.
    const stored = await this.storage.put({
      tenantId,
      category: 'message',
      filename: file.originalname,
      contentType: mimeType,
      body: file.buffer,
    });

    return this.db.runInTenant(async (tx) => {
      const [message] = await tx
        .select()
        .from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.institutionId, institutionId)))
        .limit(1);
      if (!message) throw new NotFoundError('Message', messageId);
      // Only the sender attaches to their own message — identity, not permission.
      if (message.senderUserId !== principal.userId) throw new NotFoundError('Message', messageId);
      if (message.isSystem) {
        throw new ValidationError('System messages cannot carry attachments', [
          { path: 'id', message: 'This is a system message' },
        ]);
      }

      const [fileRow] = await tx
        .insert(files)
        .values({
          tenantId,
          institutionId,
          storageKey: stored.key,
          storageDriver: 'local',
          originalFilename: file.originalname.slice(0, 255),
          mimeType,
          sizeBytes: stored.sizeBytes,
          checksum: stored.checksum,
          category: 'message',
          ownerType: 'message',
          ownerId: messageId,
          uploadedAt: new Date(),
          createdBy: principal.userId,
        })
        .returning();

      const [attachment] = await tx
        .insert(messageAttachments)
        .values({
          tenantId,
          institutionId,
          messageId,
          fileId: fileRow!.id,
          storageKey: stored.key,
          filename: file.originalname.slice(0, 255),
          mimeType,
          sizeBytes: stored.sizeBytes,
          createdBy: principal.userId,
        })
        .returning();

      return attachment!;
    });
  }

  async messageAttachmentDownloadUrl(
    principal: Principal,
    institutionId: string,
    messageId: string,
    attachmentId: string,
  ): Promise<{ attachmentId: string; url: string; expiresInSeconds: number }> {
    return this.db.runInTenant(async (tx) => {
      const [message] = await tx
        .select()
        .from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.institutionId, institutionId)))
        .limit(1);
      if (!message) throw new NotFoundError('Message', messageId);
      // Participation in the thread carries the whole rule; a non-participant gets the
      // same 404 a nonexistent message gets.
      await this.loadVisibleThread(tx, principal, institutionId, message.threadId);

      const [attachment] = await tx
        .select()
        .from(messageAttachments)
        .where(
          and(
            eq(messageAttachments.id, attachmentId),
            eq(messageAttachments.messageId, messageId),
            isNull(messageAttachments.archivedAt),
          ),
        )
        .limit(1);
      if (!attachment) throw new NotFoundError('Attachment', attachmentId);

      return {
        attachmentId,
        url: this.storage.signUrl(attachment.storageKey, DOWNLOAD_TTL_SECONDS),
        expiresInSeconds: DOWNLOAD_TTL_SECONDS,
      };
    });
  }

  private participantFilter(principal: Principal): SQL {
    return exists(
      this.db.raw
        .select({ one: sql`1` })
        .from(threadParticipants)
        .where(
          and(
            sql`${threadParticipants.threadId} = ${messageThreads.id}`,
            eq(threadParticipants.userId, principal.userId),
            isNull(threadParticipants.archivedAt),
          ),
        ),
    );
  }

  private threadUnreadSql(principal: Principal): SQL {
    return exists(
      this.db.raw
        .select({ one: sql`1` })
        .from(threadParticipants)
        .where(
          and(
            sql`${threadParticipants.threadId} = ${messageThreads.id}`,
            eq(threadParticipants.userId, principal.userId),
            isNull(threadParticipants.archivedAt),
            sql`${messageThreads.lastMessageAt} is not null`,
            or(
              isNull(threadParticipants.lastReadAt),
              sql`${threadParticipants.lastReadAt} < ${messageThreads.lastMessageAt}`,
            )!,
          ),
        ),
    );
  }

  /** Single-thread reads apply the same membership filter as lists; failure is a 404. */
  private async loadVisibleThread(
    tx: Tx,
    principal: Principal,
    institutionId: string,
    id: string,
  ): Promise<MessageThreadRow> {
    const [thread] = await tx
      .select()
      .from(messageThreads)
      .where(
        and(
          eq(messageThreads.id, id),
          eq(messageThreads.institutionId, institutionId),
          isNull(messageThreads.archivedAt),
          this.participantFilter(principal),
        ),
      )
      .limit(1);
    if (!thread) throw new NotFoundError('Thread', id);
    return thread;
  }

  /**
   * The staff a guardian (or student) may open a thread with: employees holding a user
   * account who are the class teacher of, or teach a subject in, a section one of the
   * caller's children (or the caller themselves) is actively enrolled in.
   */
  private async reachableStaffUserIds(
    tx: Tx,
    principal: Principal,
    institutionId: string,
  ): Promise<Set<string>> {
    let studentFilter: SQL;
    if (principal.guardianId) {
      const guardianId = principal.guardianId;
      studentFilter = exists(
        this.db.raw
          .select({ one: sql`1` })
          .from(studentGuardians)
          .where(
            and(
              sql`${studentGuardians.studentId} = ${enrollments.studentId}`,
              eq(studentGuardians.guardianId, guardianId),
              eq(studentGuardians.canAccessPortal, true),
              isNull(studentGuardians.archivedAt),
            ),
          ),
      );
    } else if (principal.studentId) {
      studentFilter = eq(enrollments.studentId, principal.studentId);
    } else {
      return new Set();
    }

    const classTeacherLink = exists(
      this.db.raw
        .select({ one: sql`1` })
        .from(employeeSectionAssignments)
        .where(
          and(
            sql`${employeeSectionAssignments.sectionId} = ${enrollments.sectionId}`,
            sql`${employeeSectionAssignments.employeeId} = ${employees.id}`,
            isNull(employeeSectionAssignments.archivedAt),
          ),
        ),
    );
    const subjectTeacherLink = exists(
      this.db.raw
        .select({ one: sql`1` })
        .from(employeeSubjectAssignments)
        .where(
          and(
            sql`${employeeSubjectAssignments.sectionId} = ${enrollments.sectionId}`,
            sql`${employeeSubjectAssignments.employeeId} = ${employees.id}`,
            isNull(employeeSubjectAssignments.archivedAt),
          ),
        ),
    );

    const rows = await tx
      .select({ userId: employees.userId })
      .from(employees)
      .where(
        and(
          eq(employees.institutionId, institutionId),
          isNull(employees.archivedAt),
          sql`${employees.userId} is not null`,
          exists(
            this.db.raw
              .select({ one: sql`1` })
              .from(enrollments)
              .where(
                and(
                  eq(enrollments.status, 'active'),
                  isNull(enrollments.archivedAt),
                  studentFilter,
                  or(classTeacherLink, subjectTeacherLink)!,
                ),
              ),
          ),
        ),
      );

    return new Set(rows.map((row) => row.userId).filter((id): id is string => id !== null));
  }

  // ════════════════════════════════════════════════════════════════════════════════════
  // Notification campaigns
  // ════════════════════════════════════════════════════════════════════════════════════

  async createCampaign(
    principal: Principal,
    institutionId: string,
    input: CreateNotificationCampaignInput,
  ): Promise<NotificationCampaignRow> {
    return this.db.runInTenant(async (tx) => {
      const template = await this.loadTemplate(tx, institutionId, input.templateId);

      const [campaign] = await tx
        .insert(notificationCampaigns)
        .values({
          tenantId: principal.tenantId!,
          institutionId,
          templateId: template.id,
          channel: template.channel,
          audience: input.audience,
          scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : null,
          requestedBy: principal.userId,
          createdBy: principal.userId,
        })
        .returning();
      return campaign!;
    });
  }

  async listCampaigns(
    _principal: Principal,
    institutionId: string,
    query: ListNotificationCampaignsQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<NotificationCampaignRow>> {
    return this.db.runInTenant(async (tx) => {
      const conditions: SQL[] = [eq(notificationCampaigns.institutionId, institutionId)];
      if (!query.includeArchived) conditions.push(isNull(notificationCampaigns.archivedAt));
      if (query.status) conditions.push(eq(notificationCampaigns.status, query.status));
      const where = and(...conditions);

      const orderBy = parseSort(query.sort, NOTIFICATION_CAMPAIGN_SORT_FIELDS, {
        field: 'createdAt',
        direction: 'desc',
      }).map((spec) => {
        const column = CAMPAIGN_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(notificationCampaigns)
        .where(where)
        .orderBy(...orderBy, asc(notificationCampaigns.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(notificationCampaigns)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async getCampaign(
    _principal: Principal,
    institutionId: string,
    id: string,
  ): Promise<NotificationCampaignRow> {
    return this.db.runInTenant(async (tx) => this.loadCampaign(tx, institutionId, id));
  }

  /**
   * Resolve the audience NOW and report what a send would do — the count, the threshold,
   * and whether approval is required. Audited as an export: it produces the figures
   * somebody then acts on.
   */
  async previewRecipients(
    principal: Principal,
    institutionId: string,
    id: string,
  ): Promise<{
    campaignId: string;
    totalRecipients: number;
    sampleUserIds: string[];
    approvalThreshold: number;
    requiresApproval: boolean;
  }> {
    return this.db.runInTenant(async (tx) => {
      const campaign = await this.loadCampaign(tx, institutionId, id);
      const recipients = await this.resolveRecipients(
        tx,
        principal,
        institutionId,
        campaign.channel,
        campaign.audience as CampaignAudienceInput,
      );
      const threshold = campaignApprovalThreshold();
      return {
        campaignId: id,
        totalRecipients: recipients.length,
        // User ids only — never the addresses. The preview is for sizing, not harvesting.
        sampleUserIds: recipients.slice(0, 20).map((recipient) => recipient.userId),
        approvalThreshold: threshold,
        requiresApproval: recipients.length > threshold,
      };
    });
  }

  async submitCampaign(
    principal: Principal,
    institutionId: string,
    id: string,
    version: number,
  ): Promise<NotificationCampaignRow> {
    return this.db.runInTenant(async (tx) => {
      const campaign = await this.loadCampaign(tx, institutionId, id);
      if (campaign.status !== 'draft') {
        throw new WorkflowStateError(campaign.status, 'queued', 'campaign');
      }

      const [updated] = await tx
        .update(notificationCampaigns)
        .set({
          status: 'queued',
          submittedAt: new Date(),
          version: campaign.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(notificationCampaigns.id, id), eq(notificationCampaigns.version, version)))
        .returning();
      if (!updated) {
        throw new ConflictError('This campaign was changed by someone else. Reload and retry.', {
          expectedVersion: version,
          currentVersion: campaign.version,
        });
      }
      return updated;
    });
  }

  /**
   * Approve a queued campaign. The FIRST check is identity, before state and before
   * anything permissions could excuse: the requester never approves their own campaign,
   * however many permissions they hold. The database restates the same rule
   * (`notification_campaigns_approver_distinct`).
   */
  async approveCampaign(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
    version: number,
  ): Promise<NotificationCampaignRow> {
    const context = currentContext();
    return this.db.runInTenant(async (tx) => {
      const campaign = await this.loadCampaign(tx, institutionId, id);

      if (campaign.requestedBy === principal.userId) {
        throw new ForbiddenError(
          undefined,
          'You requested this campaign; a different person must approve it',
        );
      }
      if (campaign.status !== 'queued') {
        throw new WorkflowStateError(campaign.status, 'queued (approved)', 'campaign');
      }
      if (campaign.approvedBy) {
        throw new ConflictError('This campaign is already approved', {
          approvedBy: campaign.approvedBy,
        });
      }

      const [updated] = await tx
        .update(notificationCampaigns)
        .set({
          approvedBy: principal.userId,
          approvedAt: new Date(),
          version: campaign.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(notificationCampaigns.id, id), eq(notificationCampaigns.version, version)))
        .returning();
      if (!updated) {
        throw new ConflictError('This campaign was changed by someone else. Reload and retry.', {
          expectedVersion: version,
          currentVersion: campaign.version,
        });
      }

      // In-transaction: the approval and its trail commit or roll back together.
      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'approve',
        module: 'communication',
        resourceType: 'notification_campaign',
        resourceId: id,
        newValue: { approvedBy: principal.userId, requestedBy: campaign.requestedBy },
        reason,
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      return updated;
    });
  }

  async cancelCampaign(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
    version: number,
  ): Promise<NotificationCampaignRow> {
    return this.db.runInTenant(async (tx) => {
      const campaign = await this.loadCampaign(tx, institutionId, id);
      if (campaign.status !== 'draft' && campaign.status !== 'queued') {
        throw new WorkflowStateError(campaign.status, 'cancelled', 'campaign');
      }

      const [updated] = await tx
        .update(notificationCampaigns)
        .set({
          status: 'cancelled',
          cancelledReason: reason,
          cancelledBy: principal.userId,
          cancelledAt: new Date(),
          version: campaign.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(notificationCampaigns.id, id), eq(notificationCampaigns.version, version)))
        .returning();
      if (!updated) {
        throw new ConflictError('This campaign was changed by someone else. Reload and retry.', {
          expectedVersion: version,
          currentVersion: campaign.version,
        });
      }
      return updated;
    });
  }

  /**
   * Send. Recipients are resolved HERE, from the audience definition, through the
   * caller's own permission and data scope — never from a stored list. Above the
   * threshold, the campaign must already carry an approval by a different person than the
   * requester; below it, the requester may send alone.
   */
  async sendCampaign(
    principal: Principal,
    institutionId: string,
    id: string,
    version: number,
  ): Promise<{
    campaign: NotificationCampaignRow;
    totalRecipients: number;
    sentCount: number;
    failedCount: number;
    smsParts: number | null;
  }> {
    const context = currentContext();
    return this.db.runInTenant(async (tx) => {
      const campaign = await this.loadCampaign(tx, institutionId, id);
      if (campaign.status !== 'queued') {
        throw new WorkflowStateError(campaign.status, 'sending', 'campaign');
      }
      if (campaign.version !== version) {
        throw new ConflictError('This campaign was changed by someone else. Reload and retry.', {
          expectedVersion: version,
          currentVersion: campaign.version,
        });
      }

      const template = await this.loadTemplate(tx, institutionId, campaign.templateId);
      const audience = campaign.audience as CampaignAudienceInput;

      const recipients = await this.resolveRecipients(
        tx,
        principal,
        institutionId,
        campaign.channel,
        audience,
      );

      const threshold = campaignApprovalThreshold();
      if (recipients.length > threshold) {
        // The two-person rule. `approved_by <> requested_by` is already guaranteed by the
        // approval path and the check constraint; what is verified here is that the
        // approval EXISTS before anything leaves the building.
        if (!campaign.approvedBy) {
          throw new ForbiddenError(
            undefined,
            `This campaign reaches ${recipients.length} recipients, above the approval ` +
              `threshold of ${threshold}. A different user than the requester must approve ` +
              `it before it can be sent.`,
          );
        }
      }

      const body = substituteVariables(template.bodyEn, audience.variables ?? {});
      const smsInfo = campaign.channel === 'sms' ? smsEncodingOf(body) : null;

      // Compare-and-swap into `sending`: a racing second send blocks on the row lock and
      // then finds a status that is no longer `queued`, instead of sending twice.
      const [locked] = await tx
        .update(notificationCampaigns)
        .set({ status: 'sending', updatedBy: principal.userId })
        .where(
          and(
            eq(notificationCampaigns.id, id),
            eq(notificationCampaigns.status, 'queued'),
            eq(notificationCampaigns.version, version),
          ),
        )
        .returning();
      if (!locked) {
        throw new ConflictError('This campaign was changed by someone else. Reload and retry.', {
          expectedVersion: version,
        });
      }

      let sentCount = 0;
      let failedCount = 0;

      for (const recipient of recipients) {
        const [delivery] = await tx
          .insert(notificationDeliveries)
          .values({
            tenantId: principal.tenantId!,
            institutionId,
            campaignId: id,
            recipientUserId: recipient.userId,
            recipientAddress: recipient.address,
            channel: campaign.channel,
            templateKey: template.key,
            createdBy: principal.userId,
          })
          .returning();

        const outcome = await this.dispatch(campaign.channel, recipient.address, {
          subject: template.subject ?? template.name,
          body,
        });

        if (outcome.delivered) {
          sentCount += 1;
          await tx
            .update(notificationDeliveries)
            .set({
              status: 'sent',
              providerMessageId: `${outcome.provider}-${delivery!.id}`,
              attempts: 1,
              sentAt: new Date(),
            })
            .where(eq(notificationDeliveries.id, delivery!.id));
        } else {
          failedCount += 1;
          await tx
            .update(notificationDeliveries)
            .set({
              status: 'failed',
              attempts: 1,
              error: outcome.error ?? 'delivery failed',
            })
            .where(eq(notificationDeliveries.id, delivery!.id));
        }
      }

      const finalStatus: NotificationCampaignRow['status'] =
        recipients.length > 0 && sentCount === 0 ? 'failed' : 'sent';

      const [finished] = await tx
        .update(notificationCampaigns)
        .set({
          status: finalStatus,
          totalRecipients: recipients.length,
          sentCount,
          failedCount,
          sentAt: new Date(),
          version: campaign.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(notificationCampaigns.id, id))
        .returning();

      // In-transaction: the send and its trail commit or roll back together. Only counts
      // and the part arithmetic are recorded — never addresses.
      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'publish',
        module: 'communication',
        resourceType: 'notification_campaign',
        resourceId: id,
        newValue: {
          channel: campaign.channel,
          templateKey: template.key,
          audience: { audience: audience.audience, refId: audience.refId ?? null },
          totalRecipients: recipients.length,
          sentCount,
          failedCount,
          approvedBy: campaign.approvedBy,
          requestedBy: campaign.requestedBy,
          approvalThreshold: threshold,
          smsEncoding: smsInfo?.encoding ?? null,
          smsPartsPerMessage: smsInfo?.parts ?? null,
        },
        requestId: context?.requestId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
      });

      return {
        campaign: finished!,
        totalRecipients: recipients.length,
        sentCount,
        failedCount,
        smsParts: smsInfo?.parts ?? null,
      };
    });
  }

  private async loadCampaign(
    tx: Tx,
    institutionId: string,
    id: string,
  ): Promise<NotificationCampaignRow> {
    const [campaign] = await tx
      .select()
      .from(notificationCampaigns)
      .where(
        and(
          eq(notificationCampaigns.id, id),
          eq(notificationCampaigns.institutionId, institutionId),
        ),
      )
      .limit(1);
    if (!campaign || campaign.archivedAt) throw new NotFoundError('Campaign', id);
    return campaign;
  }

  /**
   * Resolve an audience definition to concrete recipients — at call time, through the
   * caller's own permission and data scope, exactly as a normal read would be filtered:
   *
   *  - `students` / `class` / `section` audiences go through `resolveDataScope` over the
   *    students triple: `all` sees the institution, `assigned` only the sections the
   *    caller teaches, anything narrower is refused.
   *  - `guardians` are reached through their (scope-visible) children.
   *  - `employees` requires `hr.employees.view`; `role` requires `users.view`.
   *
   * The result lives for the duration of the send and is never persisted.
   */
  private async resolveRecipients(
    tx: Tx,
    principal: Principal,
    institutionId: string,
    channel: NotificationCampaignRow['channel'],
    audience: CampaignAudienceInput,
  ): Promise<ResolvedRecipient[]> {
    const collected: ResolvedRecipient[] = [];

    const wantsStudents =
      audience.audience === 'students' ||
      audience.audience === 'all' ||
      audience.audience === 'class' ||
      audience.audience === 'section';
    const wantsGuardians =
      audience.audience === 'guardians' ||
      audience.audience === 'all' ||
      audience.audience === 'class' ||
      audience.audience === 'section';

    if (wantsStudents || wantsGuardians) {
      const scope = this.requireStudentScope(principal);
      const enrollmentRef =
        audience.audience === 'class'
          ? eq(enrollments.classLevelId, audience.refId!)
          : audience.audience === 'section'
            ? eq(enrollments.sectionId, audience.refId!)
            : null;

      if (wantsStudents) {
        collected.push(
          ...(await this.studentRecipients(tx, principal, scope, institutionId, channel, enrollmentRef)),
        );
      }
      if (wantsGuardians) {
        collected.push(
          ...(await this.guardianRecipients(tx, principal, scope, institutionId, channel, enrollmentRef)),
        );
      }
    }

    if (audience.audience === 'employees' || audience.audience === 'all') {
      if (!can(principal, 'hr.employees.view')) {
        throw new ForbiddenError('hr.employees.view', 'You cannot address the staff audience');
      }
      collected.push(...(await this.employeeRecipients(tx, institutionId, channel)));
    }

    if (audience.audience === 'role') {
      if (!can(principal, 'users.view')) {
        throw new ForbiddenError('users.view', 'You cannot address a role audience');
      }
      collected.push(...(await this.roleRecipients(tx, institutionId, channel, audience.refId!)));
    }

    // One person, one delivery — whatever set of links got them into the audience.
    const seen = new Set<string>();
    return collected.filter((recipient) => {
      if (seen.has(recipient.userId)) return false;
      seen.add(recipient.userId);
      return true;
    });
  }

  /** Campaigns need at least the `assigned` student scope; `own` cannot mass-send. */
  private requireStudentScope(principal: Principal): DataScope {
    const context = currentContext();
    const scope = resolveDataScope(principal, SCOPED_RESOURCES.students, {
      institutionId: context?.institutionId ?? null,
      campusId: context?.campusId ?? null,
    });
    if (scope !== 'all' && scope !== 'assigned') {
      throw new ForbiddenError(
        'students.view.all',
        'You cannot address student or guardian audiences',
      );
    }
    return scope;
  }

  /**
   * The same predicate `students.service.ts` applies: `all` is a tautology; `assigned` is
   * the sections the caller's employee record teaches, and an employee-less caller fails
   * closed to nothing.
   */
  private studentScopeFilter(principal: Principal, scope: DataScope): SQL {
    if (scope === 'all') return sql`true`;
    if (!principal.employeeId) return sql`false`;
    const employeeId = principal.employeeId;

    return exists(
      this.db.raw
        .select({ one: sql`1` })
        .from(enrollments)
        .where(
          and(
            sql`${enrollments.studentId} = ${students.id}`,
            eq(enrollments.status, 'active'),
            isNull(enrollments.archivedAt),
            or(
              exists(
                this.db.raw
                  .select({ one: sql`1` })
                  .from(employeeSectionAssignments)
                  .where(
                    and(
                      sql`${employeeSectionAssignments.sectionId} = ${enrollments.sectionId}`,
                      eq(employeeSectionAssignments.employeeId, employeeId),
                      isNull(employeeSectionAssignments.archivedAt),
                    ),
                  ),
              ),
              exists(
                this.db.raw
                  .select({ one: sql`1` })
                  .from(employeeSubjectAssignments)
                  .where(
                    and(
                      sql`${employeeSubjectAssignments.sectionId} = ${enrollments.sectionId}`,
                      eq(employeeSubjectAssignments.employeeId, employeeId),
                      isNull(employeeSubjectAssignments.archivedAt),
                    ),
                  ),
              ),
            )!,
          ),
        ),
    );
  }

  private async studentRecipients(
    tx: Tx,
    principal: Principal,
    scope: DataScope,
    institutionId: string,
    channel: NotificationCampaignRow['channel'],
    enrollmentRef: SQL | null,
  ): Promise<ResolvedRecipient[]> {
    const conditions: SQL[] = [
      eq(students.institutionId, institutionId),
      eq(students.status, 'active'),
      isNull(students.archivedAt),
      eq(users.status, 'active'),
      isNull(users.archivedAt),
      this.studentScopeFilter(principal, scope),
    ];
    if (enrollmentRef) {
      conditions.push(
        exists(
          this.db.raw
            .select({ one: sql`1` })
            .from(enrollments)
            .where(
              and(
                sql`${enrollments.studentId} = ${students.id}`,
                eq(enrollments.status, 'active'),
                isNull(enrollments.archivedAt),
                enrollmentRef,
              ),
            ),
        ),
      );
    }

    const rows = await tx
      .select({ userId: users.id, email: users.email, phone: users.phone })
      .from(students)
      .innerJoin(users, eq(users.id, students.userId))
      .where(and(...conditions));

    return this.toRecipients(rows, channel);
  }

  private async guardianRecipients(
    tx: Tx,
    principal: Principal,
    scope: DataScope,
    institutionId: string,
    channel: NotificationCampaignRow['channel'],
    enrollmentRef: SQL | null,
  ): Promise<ResolvedRecipient[]> {
    const childConditions: SQL[] = [
      sql`${studentGuardians.guardianId} = ${guardians.id}`,
      isNull(studentGuardians.archivedAt),
      sql`${students.id} = ${studentGuardians.studentId}`,
      eq(students.institutionId, institutionId),
      eq(students.status, 'active'),
      isNull(students.archivedAt),
      this.studentScopeFilter(principal, scope),
    ];
    if (enrollmentRef) {
      childConditions.push(
        exists(
          this.db.raw
            .select({ one: sql`1` })
            .from(enrollments)
            .where(
              and(
                sql`${enrollments.studentId} = ${students.id}`,
                eq(enrollments.status, 'active'),
                isNull(enrollments.archivedAt),
                enrollmentRef,
              ),
            ),
        ),
      );
    }

    const rows = await tx
      .select({ userId: users.id, email: users.email, phone: sql<string | null>`coalesce(${users.phone}, ${guardians.phone})` })
      .from(guardians)
      .innerJoin(users, eq(users.id, guardians.userId))
      .where(
        and(
          eq(guardians.institutionId, institutionId),
          isNull(guardians.archivedAt),
          eq(users.status, 'active'),
          isNull(users.archivedAt),
          exists(
            this.db.raw
              .select({ one: sql`1` })
              .from(studentGuardians)
              .innerJoin(students, sql`${students.id} = ${studentGuardians.studentId}`)
              .where(and(...childConditions)),
          ),
        ),
      );

    return this.toRecipients(rows, channel);
  }

  private async employeeRecipients(
    tx: Tx,
    institutionId: string,
    channel: NotificationCampaignRow['channel'],
  ): Promise<ResolvedRecipient[]> {
    const rows = await tx
      .select({
        userId: users.id,
        email: users.email,
        phone: sql<string | null>`coalesce(${users.phone}, ${employees.phone})`,
      })
      .from(employees)
      .innerJoin(users, eq(users.id, employees.userId))
      .where(
        and(
          eq(employees.institutionId, institutionId),
          isNull(employees.archivedAt),
          eq(users.status, 'active'),
          isNull(users.archivedAt),
        ),
      );
    return this.toRecipients(rows, channel);
  }

  private async roleRecipients(
    tx: Tx,
    institutionId: string,
    channel: NotificationCampaignRow['channel'],
    roleId: string,
  ): Promise<ResolvedRecipient[]> {
    const rows = await tx
      .select({ userId: users.id, email: users.email, phone: users.phone })
      .from(userRoles)
      .innerJoin(users, eq(users.id, userRoles.userId))
      .where(
        and(
          eq(userRoles.roleId, roleId),
          or(eq(userRoles.institutionId, institutionId), isNull(userRoles.institutionId))!,
          eq(users.status, 'active'),
          isNull(users.archivedAt),
        ),
      );
    return this.toRecipients(rows, channel);
  }

  private toRecipients(
    rows: { userId: string; email: string | null; phone: string | null }[],
    channel: NotificationCampaignRow['channel'],
  ): ResolvedRecipient[] {
    const recipients: ResolvedRecipient[] = [];
    for (const row of rows) {
      const address =
        channel === 'email' ? row.email : channel === 'sms' ? row.phone : row.userId;
      // A recipient with no usable address for the channel is silently absent — there is
      // nothing to deliver to, and inventing an address would be worse.
      if (address) recipients.push({ userId: row.userId, address });
    }
    return recipients;
  }

  /**
   * One delivery attempt, through the same transports the notification provider uses.
   * Email honours `NOTIFICATIONS_EMAIL_DRIVER` (console by default, SMTP when configured);
   * SMS and push have no vendor integrated by design (docs/09_INTEGRATIONS.md) and use the
   * console transport; in_app deliveries ARE the record — the delivery row is the inbox
   * entry. Dispatch never throws: a failed handoff is a failed delivery, not a failed
   * request.
   */
  private async dispatch(
    channel: NotificationCampaignRow['channel'],
    address: string,
    content: { subject: string; body: string },
  ): Promise<{ delivered: boolean; provider: string; error?: string }> {
    if (channel === 'email') {
      const driver = (process.env['NOTIFICATIONS_EMAIL_DRIVER'] ?? 'console').toLowerCase();
      if (driver !== 'smtp') return { delivered: true, provider: 'console' };
      try {
        await sendSmtpMail(
          {
            host: process.env['SMTP_HOST'] ?? 'localhost',
            port: Number(process.env['SMTP_PORT'] ?? '1025'),
            user: process.env['SMTP_USER'],
            password: process.env['SMTP_PASSWORD'],
          },
          {
            from: process.env['SMTP_FROM'] ?? 'no-reply@shikkha.local',
            to: address,
            subject: content.subject,
            text: content.body,
          },
        );
        return { delivered: true, provider: 'smtp' };
      } catch (error) {
        return {
          delivered: false,
          provider: 'smtp',
          error: error instanceof Error ? error.message.slice(0, 500) : 'smtp delivery failed',
        };
      }
    }
    // sms / push: console transport (no vendor by design); in_app: the row is the inbox.
    return { delivered: true, provider: 'console' };
  }

  // ════════════════════════════════════════════════════════════════════════════════════
  // Deliveries and the provider webhook
  // ════════════════════════════════════════════════════════════════════════════════════

  async listDeliveries(
    _principal: Principal,
    institutionId: string,
    query: ListNotificationDeliveriesQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<NotificationDeliveryRow>> {
    return this.db.runInTenant(async (tx) => {
      const conditions: SQL[] = [
        eq(notificationDeliveries.institutionId, institutionId),
        isNull(notificationDeliveries.archivedAt),
      ];
      if (query.campaignId) conditions.push(eq(notificationDeliveries.campaignId, query.campaignId));
      if (query.status) conditions.push(eq(notificationDeliveries.status, query.status));
      if (query.channel) conditions.push(eq(notificationDeliveries.channel, query.channel));
      const where = and(...conditions);

      const orderBy = parseSort(query.sort, NOTIFICATION_DELIVERY_SORT_FIELDS, {
        field: 'createdAt',
        direction: 'desc',
      }).map((spec) => {
        const column = DELIVERY_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(notificationDeliveries)
        .where(where)
        .orderBy(...orderBy, asc(notificationDeliveries.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(notificationDeliveries)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  /**
   * Handle one delivery-status report from a provider.
   *
   * Order is the security model: (1) verify the HMAC signature over the raw body, (2)
   * parse, (3) locate the delivery by its idempotency key, (4) apply the update only if
   * it moves the status strictly FORWARD. Providers redeliver reports; a duplicate — or a
   * report that arrives after a later one — is a recorded no-op, never a second effect.
   * Responses carry machine codes only; this endpoint talks to the internet.
   */
  async handleDeliveryWebhook(
    rawBody: string,
    body: unknown,
    signature: string | null,
  ): Promise<{ received: boolean; result: string; duplicate: boolean }> {
    if (!this.verifyWebhookSignature(rawBody, signature)) {
      throw new ValidationError('The delivery report could not be verified', [
        { path: 'signature', message: 'The signature does not match the payload' },
      ]);
    }

    const parsed = deliveryWebhookSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('The delivery report is not in a recognised shape', [
        { path: '(root)', message: 'Expected providerMessageId and status' },
      ]);
    }
    const payload = parsed.data;

    // Platform read, justified: a webhook has no session and no tenant of its own — the
    // delivery row is the only thing that can say whose message this claims to be.
    const delivery = await this.db.runAsPlatform(async (tx) => {
      const [row] = await tx
        .select()
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.providerMessageId, payload.providerMessageId))
        .limit(1);
      return row ?? null;
    });

    if (!delivery) {
      return { received: true, result: 'unknown_message', duplicate: false };
    }

    const currentRank = DELIVERY_STATUS_RANK[delivery.status];
    const nextRank = DELIVERY_STATUS_RANK[payload.status];
    if (nextRank <= currentRank) {
      // The idempotency contract: same (or older) news twice changes nothing.
      return { received: true, result: 'no_op', duplicate: true };
    }

    await this.db.runInTenantId(delivery.tenantId, async (tx) => {
      await tx
        .update(notificationDeliveries)
        .set({
          status: payload.status,
          deliveredAt:
            payload.status === 'delivered'
              ? payload.occurredAt
                ? new Date(payload.occurredAt)
                : new Date()
              : delivery.deliveredAt,
          sentAt: delivery.sentAt ?? (payload.status === 'sent' ? new Date() : null),
          error:
            payload.status === 'failed' || payload.status === 'bounced'
              ? (payload.error ?? `reported ${payload.status}`)
              : delivery.error,
        })
        .where(
          and(
            eq(notificationDeliveries.id, delivery.id),
            // Guard against a racing report: only ever move forward.
            eq(notificationDeliveries.status, delivery.status),
          ),
        );
    });

    return { received: true, result: 'updated', duplicate: false };
  }

  private verifyWebhookSignature(rawBody: string, signature: string | null): boolean {
    if (!signature) return false;
    const expected = Buffer.from(signDeliveryWebhook(rawBody), 'utf8');
    const provided = Buffer.from(signature, 'utf8');
    // Length check first: timingSafeEqual throws on a mismatch, and length is not a
    // secret here.
    if (expected.length !== provided.length) return false;
    return timingSafeEqual(expected, provided);
  }

  // ════════════════════════════════════════════════════════════════════════════════════
  // Unread counts
  // ════════════════════════════════════════════════════════════════════════════════════

  /** The badge numbers: unread visible announcements and threads with news. */
  async unreadCounts(
    principal: Principal,
    institutionId: string,
  ): Promise<{ announcements: number; messageThreads: number }> {
    return this.db.runInTenant(async (tx) => {
      const [announcementRow] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(announcements)
        .where(
          and(
            eq(announcements.institutionId, institutionId),
            this.announcementVisibleFilter(principal),
            sql`not ${this.readReceiptExists(principal)}`,
          ),
        );

      const [threadRow] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(messageThreads)
        .where(
          and(
            eq(messageThreads.institutionId, institutionId),
            isNull(messageThreads.archivedAt),
            this.participantFilter(principal),
            this.threadUnreadSql(principal),
          ),
        );

      return {
        announcements: announcementRow?.total ?? 0,
        messageThreads: threadRow?.total ?? 0,
      };
    });
  }

  // ════════════════════════════════════════════════════════════════════════════════════
  // Uploads
  // ════════════════════════════════════════════════════════════════════════════════════

  private checkUpload(file: UploadedFileLike): string {
    if (!file || !file.buffer || file.size === 0) {
      throw new ValidationError('No file was uploaded', [
        { path: 'file', message: 'Attach the file as the "file" field' },
      ]);
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw new ValidationError('The file is too large', [
        { path: 'file', message: 'Attachments may be at most 10 MB' },
      ]);
    }
    const mimeType = sniffMimeType(file.buffer) ?? file.mimetype;
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      throw new ValidationError('This file type is not accepted', [
        { path: 'file', message: 'Upload a JPEG, PNG, WebP or PDF file' },
      ]);
    }
    return mimeType;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Sort allow-lists — the only way a client-supplied field name reaches ORDER BY.
// ─────────────────────────────────────────────────────────────────────────────────────

const TEMPLATE_COLUMNS = {
  key: messageTemplates.key,
  name: messageTemplates.name,
  channel: messageTemplates.channel,
  createdAt: messageTemplates.createdAt,
} as const satisfies Record<(typeof MESSAGE_TEMPLATE_SORT_FIELDS)[number], AnyColumn>;

const ANNOUNCEMENT_COLUMNS = {
  title: announcements.title,
  status: announcements.status,
  publishAt: announcements.publishAt,
  createdAt: announcements.createdAt,
} as const satisfies Record<(typeof ANNOUNCEMENT_SORT_FIELDS)[number], AnyColumn>;

const CAMPAIGN_COLUMNS = {
  status: notificationCampaigns.status,
  scheduledFor: notificationCampaigns.scheduledFor,
  createdAt: notificationCampaigns.createdAt,
} as const satisfies Record<(typeof NOTIFICATION_CAMPAIGN_SORT_FIELDS)[number], AnyColumn>;

const DELIVERY_COLUMNS = {
  status: notificationDeliveries.status,
  channel: notificationDeliveries.channel,
  createdAt: notificationDeliveries.createdAt,
} as const satisfies Record<(typeof NOTIFICATION_DELIVERY_SORT_FIELDS)[number], AnyColumn>;

/** `{{name}}` substitution. Unmatched placeholders stay visible — a lie would be worse. */
function substituteVariables(body: string, variables: Record<string, string>): string {
  return body.replace(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(variables, name) ? variables[name]! : whole,
  );
}

/**
 * Determine the MIME type from the first bytes. Covers exactly the allow-listed types; an
 * unrecognised signature returns null and the client's claim is then tested against the
 * same allow-list, so nothing outside it is ever stored. Kept local (rather than imported
 * from another module) so this module has no dependency on another module's file.
 */
function sniffMimeType(buffer: Buffer): string | null {
  if (buffer.length >= 4) {
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      return 'image/png';
    }
    if (buffer.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
    if (
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
      buffer.subarray(8, 12).toString('latin1') === 'WEBP'
    ) {
      return 'image/webp';
    }
  }
  return null;
}
