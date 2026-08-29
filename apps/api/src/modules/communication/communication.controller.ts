/**
 * Communication centre endpoints (Phase 14).
 *
 * Every route is `@InstitutionScoped()` except the public delivery webhook: a message, a
 * notice or a campaign belongs to one institution, and a group administrator running three
 * schools has no safe default.
 *
 * The permission split, written down:
 *
 *   communication.templates.manage — create, edit and archive notification templates
 *   communication.send             — person-to-person messaging as staff, including
 *                                    broadcast threads; also reads the template catalogue
 *   communication.send.bulk        — notification campaigns (create through send)
 *   communication.notices.publish  — announcements (create, edit, publish, archive)
 *   communication.delivery.view    — delivery reports
 *
 * Threads, the announcement reading surface and the unread counters are `@Authenticated()`
 * self-service: guardians and students hold no communication permission at all, and their
 * reach is decided in the service by identity and SQL — a guardian gets only staff
 * connected to their own children, a student the staff of their own section, and neither
 * may ever broadcast. Route-level permissions could not express that; a row filter can.
 *
 * The delivery webhook is `@Public()` and signature-verified over the raw body, exactly
 * like the payment gateway callback: verify first, parse second, act idempotently third.
 *
 * There is deliberately no AI-facing route here: nothing an AI could send, approve or
 * escalate. Mass communication is gated behind a human approval by a second person.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
  type RawBodyRequest,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { z } from 'zod';
import { normalizeOffsetPage } from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import {
  approveNotificationCampaignSchema,
  archiveAnnouncementSchema,
  archiveMessageTemplateSchema,
  cancelNotificationCampaignSchema,
  commMessageAttachmentParamsSchema,
  createAnnouncementSchema,
  createMessageTemplateSchema,
  createMessageThreadSchema,
  createNotificationCampaignSchema,
  idParamSchema,
  listAnnouncementsSchema,
  listMessageTemplatesSchema,
  listMessageThreadsSchema,
  listNotificationCampaignsSchema,
  listNotificationDeliveriesSchema,
  previewTemplatePartsSchema,
  publishAnnouncementSchema,
  retractMessageSchema,
  sendMessageSchema,
  sendNotificationCampaignSchema,
  submitNotificationCampaignSchema,
  updateAnnouncementSchema,
  updateMessageTemplateSchema,
} from '@shikkha/validation';
import {
  CommunicationService,
  DELIVERY_SIGNATURE_HEADER,
  type UploadedFileLike,
} from './communication.service';
import {
  Audited,
  Authenticated,
  CurrentUser,
  InstitutionScoped,
  Public,
  RequirePermissions,
} from '../../common/decorators';
import { AuthRateLimit } from '../../common/guards/rate-limit.guard';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { currentContext } from '../../common/context/request-context';

@ApiTags('communication')
@Controller('communication')
@InstitutionScoped()
export class CommunicationController {
  constructor(private readonly communication: CommunicationService) {}

  // ── Message templates ───────────────────────────────────────────────────────────────

  @Get('templates')
  @RequirePermissions('communication.templates.manage', 'communication.send', { mode: 'any' })
  @ApiOperation({ summary: 'List notification templates with their SMS part counts' })
  async listTemplates(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listMessageTemplatesSchema))
    query: z.infer<typeof listMessageTemplatesSchema>,
  ) {
    return this.communication.listTemplates(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  /**
   * Part-count preview for bodies that may not be saved yet. Declared before
   * `templates/:id` — Nest matches in declaration order. The figures it produces are what
   * somebody acts on before a mass send, so the route is audited as an export.
   */
  @Post('templates/preview')
  @RequirePermissions('communication.templates.manage', 'communication.send', { mode: 'any' })
  @Audited({ module: 'communication', resourceType: 'message_template', action: 'export' })
  @ApiOperation({ summary: 'Compute SMS part counts per encoding (GSM 160/153, UCS-2 70/67)' })
  async previewTemplateParts(
    @Body(zodBody(previewTemplatePartsSchema))
    body: z.infer<typeof previewTemplatePartsSchema>,
  ) {
    return this.communication.previewParts(body);
  }

  @Post('templates')
  @RequirePermissions('communication.templates.manage')
  @Audited({
    module: 'communication',
    resourceType: 'message_template',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create a notification template' })
  async createTemplate(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createMessageTemplateSchema))
    body: z.infer<typeof createMessageTemplateSchema>,
  ) {
    return this.communication.createTemplate(principal, requireInstitution(), body);
  }

  @Get('templates/:id')
  @RequirePermissions('communication.templates.manage', 'communication.send', { mode: 'any' })
  @ApiOperation({ summary: 'Fetch one template with its SMS part counts' })
  async getTemplate(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.communication.getTemplate(principal, requireInstitution(), params.id);
  }

  @Patch('templates/:id')
  @RequirePermissions('communication.templates.manage')
  @Audited({
    module: 'communication',
    resourceType: 'message_template',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update a notification template' })
  async updateTemplate(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateMessageTemplateSchema))
    body: z.infer<typeof updateMessageTemplateSchema>,
  ) {
    const result = await this.communication.updateTemplate(
      principal,
      requireInstitution(),
      params.id,
      body,
    );
    // `__audit` is read by the audit interceptor and stripped from the HTTP response, so
    // the trail records what actually changed rather than the whole submitted body.
    return { ...result.template, __audit: { previousValue: result.previous, newValue: body } };
  }

  @Post('templates/:id/archive')
  @RequirePermissions('communication.templates.manage')
  @Audited({
    module: 'communication',
    resourceType: 'message_template',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive a notification template (never a delete)' })
  async archiveTemplate(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(archiveMessageTemplateSchema)) body: { reason: string },
  ) {
    return this.communication.archiveTemplate(
      principal,
      requireInstitution(),
      params.id,
      body.reason,
    );
  }

  // ── Announcements ───────────────────────────────────────────────────────────────────

  @Post('announcements')
  @RequirePermissions('communication.notices.publish')
  @Audited({
    module: 'communication',
    resourceType: 'announcement',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create a draft announcement' })
  async createAnnouncement(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createAnnouncementSchema))
    body: z.infer<typeof createAnnouncementSchema>,
  ) {
    return this.communication.createAnnouncement(principal, requireInstitution(), body);
  }

  /**
   * The audience-scoped list: any authenticated member of the institution sees the live
   * notices whose audience includes them — resolved in SQL, never by the client.
   */
  @Get('announcements')
  @Authenticated()
  @ApiOperation({ summary: 'List announcements visible to the caller' })
  async listAnnouncements(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listAnnouncementsSchema))
    query: z.infer<typeof listAnnouncementsSchema>,
  ) {
    return this.communication.listAnnouncements(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Get('announcements/:id')
  @Authenticated()
  @ApiOperation({ summary: 'Fetch one announcement the caller may see' })
  async getAnnouncement(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.communication.getAnnouncement(principal, requireInstitution(), params.id);
  }

  @Patch('announcements/:id')
  @RequirePermissions('communication.notices.publish')
  @Audited({
    module: 'communication',
    resourceType: 'announcement',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Edit a draft or scheduled announcement' })
  async updateAnnouncement(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateAnnouncementSchema))
    body: z.infer<typeof updateAnnouncementSchema>,
  ) {
    const result = await this.communication.updateAnnouncement(
      principal,
      requireInstitution(),
      params.id,
      body,
    );
    return { ...result.announcement, __audit: { previousValue: result.previous, newValue: body } };
  }

  @Post('announcements/:id/publish')
  @RequirePermissions('communication.notices.publish')
  @Audited({
    module: 'communication',
    resourceType: 'announcement',
    action: 'publish',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Publish an announcement (or schedule it for its publish_at)' })
  async publishAnnouncement(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(publishAnnouncementSchema)) body: { version: number },
  ) {
    return this.communication.publishAnnouncement(
      principal,
      requireInstitution(),
      params.id,
      body.version,
    );
  }

  @Post('announcements/:id/archive')
  @RequirePermissions('communication.notices.publish')
  @Audited({
    module: 'communication',
    resourceType: 'announcement',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive an announcement (never a delete)' })
  async archiveAnnouncement(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(archiveAnnouncementSchema)) body: { reason: string; version: number },
  ) {
    return this.communication.archiveAnnouncement(
      principal,
      requireInstitution(),
      params.id,
      body.reason,
      body.version,
    );
  }

  /** Idempotent: reading twice is one receipt. Visible-to-the-caller or 404. */
  @Post('announcements/:id/read')
  @Authenticated()
  @Audited({
    module: 'communication',
    resourceType: 'announcement_read',
    action: 'create',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Mark an announcement as read by the caller' })
  async markAnnouncementRead(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.communication.markAnnouncementRead(principal, requireInstitution(), params.id);
  }

  // ── Message threads ─────────────────────────────────────────────────────────────────

  /**
   * Self-service by design: guardians and students hold no communication permission. Who
   * may reach whom — and that neither may broadcast — is enforced in the service by
   * identity and SQL, not by anything the client claims.
   */
  @Post('threads')
  @Authenticated()
  @Audited({
    module: 'communication',
    resourceType: 'message_thread',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Open a message thread with its first message' })
  async createThread(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createMessageThreadSchema))
    body: z.infer<typeof createMessageThreadSchema>,
  ) {
    const result = await this.communication.createThread(principal, requireInstitution(), body);
    return { ...result.thread, firstMessage: result.message };
  }

  @Get('threads')
  @Authenticated()
  @ApiOperation({ summary: 'List the caller’s message threads' })
  async listThreads(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listMessageThreadsSchema))
    query: z.infer<typeof listMessageThreadsSchema>,
  ) {
    return this.communication.listThreads(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Get('threads/:id')
  @Authenticated()
  @ApiOperation({ summary: 'Fetch one thread with participants and recent messages' })
  async getThread(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.communication.getThread(principal, requireInstitution(), params.id);
  }

  @Post('threads/:id/messages')
  @Authenticated()
  @Audited({
    module: 'communication',
    resourceType: 'message',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Send a message into a thread the caller participates in' })
  async sendMessage(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(sendMessageSchema)) body: z.infer<typeof sendMessageSchema>,
  ) {
    return this.communication.sendMessage(principal, requireInstitution(), params.id, body);
  }

  @Post('threads/:id/read')
  @Authenticated()
  @Audited({
    module: 'communication',
    resourceType: 'message_thread',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Move the caller’s read cursor to now' })
  async markThreadRead(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.communication.markThreadRead(principal, requireInstitution(), params.id);
  }

  /**
   * Messages are append-only — there is no edit or delete route anywhere in this
   * controller, and the database refuses both. A retraction is a NEW system message.
   */
  @Post('messages/:id/retract')
  @Authenticated()
  @Audited({
    module: 'communication',
    resourceType: 'message',
    action: 'create',
    resourceIdFrom: 'response:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Retract a message by appending a system message (no edits)' })
  async retractMessage(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(retractMessageSchema)) body: { reason: string },
  ) {
    return this.communication.retractMessage(
      principal,
      requireInstitution(),
      params.id,
      body.reason,
    );
  }

  @Post('messages/:id/attachments')
  @Authenticated()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  @Audited({
    module: 'communication',
    resourceType: 'message_attachment',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Attach a file to a message the caller sent' })
  async uploadMessageAttachment(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @UploadedFile() file: UploadedFileLike,
  ) {
    return this.communication.addMessageAttachment(
      principal,
      requireInstitution(),
      params.id,
      file,
    );
  }

  /**
   * Issue a signed, expiring download URL — never a static path. Audited as an export:
   * the trail shows who received which file and when.
   */
  @Get('messages/:id/attachments/:attachmentId/download')
  @Authenticated()
  @Audited({
    module: 'communication',
    resourceType: 'message_attachment',
    action: 'export',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Get a short-lived signed download URL for a message attachment' })
  async downloadMessageAttachment(
    @CurrentUser() principal: Principal,
    @Param(zodParam(commMessageAttachmentParamsSchema))
    params: { id: string; attachmentId: string },
  ) {
    const result = await this.communication.messageAttachmentDownloadUrl(
      principal,
      requireInstitution(),
      params.id,
      params.attachmentId,
    );
    return {
      ...result,
      __audit: { newValue: { messageId: params.id, attachmentId: params.attachmentId } },
    };
  }

  // ── Notification campaigns ──────────────────────────────────────────────────────────

  @Post('campaigns')
  @RequirePermissions('communication.send.bulk')
  @Audited({
    module: 'communication',
    resourceType: 'notification_campaign',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create a draft notification campaign from a template' })
  async createCampaign(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createNotificationCampaignSchema))
    body: z.infer<typeof createNotificationCampaignSchema>,
  ) {
    return this.communication.createCampaign(principal, requireInstitution(), body);
  }

  @Get('campaigns')
  @RequirePermissions('communication.send.bulk', 'communication.delivery.view', { mode: 'any' })
  @ApiOperation({ summary: 'List notification campaigns' })
  async listCampaigns(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listNotificationCampaignsSchema))
    query: z.infer<typeof listNotificationCampaignsSchema>,
  ) {
    return this.communication.listCampaigns(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Get('campaigns/:id')
  @RequirePermissions('communication.send.bulk', 'communication.delivery.view', { mode: 'any' })
  @ApiOperation({ summary: 'Fetch one campaign' })
  async getCampaign(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.communication.getCampaign(principal, requireInstitution(), params.id);
  }

  /**
   * Resolve the audience NOW and report the count, the threshold, and whether approval is
   * required. Audited as an export — it produces the figures somebody then acts on.
   */
  @Post('campaigns/:id/preview-recipients')
  @RequirePermissions('communication.send.bulk')
  @Audited({
    module: 'communication',
    resourceType: 'notification_campaign',
    action: 'export',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Resolve the audience and preview the recipient count' })
  async previewRecipients(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.communication.previewRecipients(principal, requireInstitution(), params.id);
  }

  @Post('campaigns/:id/submit')
  @RequirePermissions('communication.send.bulk')
  @Audited({
    module: 'communication',
    resourceType: 'notification_campaign',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Submit a draft campaign for approval and sending' })
  async submitCampaign(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(submitNotificationCampaignSchema)) body: { version: number },
  ) {
    return this.communication.submitCampaign(
      principal,
      requireInstitution(),
      params.id,
      body.version,
    );
  }

  /**
   * Approval. The service refuses an approver who is the requester — by identity, not
   * permission, so holding every permission does not get one person around it. The
   * database restates the rule as a check constraint.
   */
  @Post('campaigns/:id/approve')
  @RequirePermissions('communication.send.bulk')
  @Audited({
    module: 'communication',
    resourceType: 'notification_campaign',
    action: 'approve',
    resourceIdFrom: 'param:id',
    requiresReason: true,
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Approve a queued campaign (different approver than requester)' })
  async approveCampaign(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(approveNotificationCampaignSchema))
    body: z.infer<typeof approveNotificationCampaignSchema>,
  ) {
    return this.communication.approveCampaign(
      principal,
      requireInstitution(),
      params.id,
      body.reason,
      body.version,
    );
  }

  @Post('campaigns/:id/cancel')
  @RequirePermissions('communication.send.bulk')
  @Audited({
    module: 'communication',
    resourceType: 'notification_campaign',
    action: 'update',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Cancel a draft or queued campaign with a mandatory reason' })
  async cancelCampaign(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(cancelNotificationCampaignSchema))
    body: z.infer<typeof cancelNotificationCampaignSchema>,
  ) {
    return this.communication.cancelCampaign(
      principal,
      requireInstitution(),
      params.id,
      body.reason,
      body.version,
    );
  }

  /**
   * Send. Recipients are resolved at THIS moment through the caller's own data scope;
   * above the threshold the campaign must already carry a second person's approval. The
   * service writes the audit record inside the sending transaction.
   */
  @Post('campaigns/:id/send')
  @RequirePermissions('communication.send.bulk')
  @Audited({
    module: 'communication',
    resourceType: 'notification_campaign',
    action: 'publish',
    resourceIdFrom: 'param:id',
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Send a queued campaign (approval enforced above the threshold)' })
  async sendCampaign(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(sendNotificationCampaignSchema)) body: { version: number },
  ) {
    return this.communication.sendCampaign(
      principal,
      requireInstitution(),
      params.id,
      body.version,
    );
  }

  // ── Delivery reports ────────────────────────────────────────────────────────────────

  @Get('deliveries')
  @RequirePermissions('communication.delivery.view')
  @ApiOperation({ summary: 'List delivery records with their current statuses' })
  async listDeliveries(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listNotificationDeliveriesSchema))
    query: z.infer<typeof listNotificationDeliveriesSchema>,
  ) {
    return this.communication.listDeliveries(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  /**
   * Receive one delivery-status report. `@Public()` because a provider has no session; the
   * HMAC signature over the raw body is the authentication, verified before anything else
   * happens, and the update is idempotent on `provider_message_id` — providers redeliver.
   *
   * **No validation pipe on the body**: the schema is applied by the service *after* the
   * signature verifies, so a forged-but-malformed payload is refused for the right reason.
   *
   * Responds 200 rather than 201: providers treat any 2xx as delivered, and this endpoint
   * creates nothing the caller may know about. Machine codes only — never tenant data.
   */
  @Post('deliveries/webhook')
  @Public()
  @AuthRateLimit()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Receive a delivery status report (signed, idempotent)' })
  async deliveryWebhook(
    @Req() request: RawBodyRequest<Request>,
    @Headers(DELIVERY_SIGNATURE_HEADER) signatureHeader: string | undefined,
  ) {
    const rawBody =
      request.rawBody instanceof Buffer && request.rawBody.length > 0
        ? request.rawBody.toString('utf8')
        : JSON.stringify(request.body ?? {});
    const signature =
      typeof signatureHeader === 'string' && signatureHeader.trim() !== ''
        ? signatureHeader.trim()
        : null;

    return this.communication.handleDeliveryWebhook(rawBody, request.body, signature);
  }

  // ── Unread counters ─────────────────────────────────────────────────────────────────

  @Get('unread-counts')
  @Authenticated()
  @ApiOperation({ summary: 'Unread announcement and thread counts for the caller' })
  async unreadCounts(@CurrentUser() principal: Principal) {
    return this.communication.unreadCounts(principal, requireInstitution());
  }
}

/**
 * `@InstitutionScoped()` makes the tenant guard require and validate the header; this is
 * the belt-and-braces read, because `currentContext()` returns `string | null` and a
 * service that received `null` would silently query across institutions.
 */
function requireInstitution(): string {
  const institutionId = currentContext()?.institutionId;
  if (!institutionId) {
    throw new BadRequestException(
      'Send the x-institution-id header to indicate which institution this communication belongs to.',
    );
  }
  return institutionId;
}
