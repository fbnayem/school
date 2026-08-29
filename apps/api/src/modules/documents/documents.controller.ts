/**
 * Document and certificate endpoints (Phase 23).
 *
 * The permission split, which is separation of duties written down:
 *
 *   documents.templates.manage — author templates, and **decide** requests (approve, reject,
 *                                revoke). Held by the principal and the owner.
 *   documents.generate         — ask for a document, preview one, issue an approved request,
 *                                read the register. Held by office staff and teachers.
 *
 * No preset role in `packages/permissions/src/roles.ts` gives the administrator (who raises
 * requests) `documents.templates.manage`, so the two-person rule is real in the seeded roles
 * as well as in the schema. And it does not depend on that: `DocumentsService.approveRequest`
 * refuses a self-approval outright, and `document_requests_approver_not_requester` refuses it
 * in the database even for the owner, whose role is `*`.
 *
 * Two routes step outside the authenticated surface, each for a stated reason:
 *
 *  - `POST /documents/verify` is `@Public()` because an employer holding a printed certificate
 *    has no account here. It is rate-limited with the strict credential-endpoint limit, since
 *    volume is the only lever an anonymous abuser has, and it answers four questions and no
 *    more — valid, kind, name, date. No id, no contact detail, no record.
 *  - `GET /documents/my-documents` is `@Authenticated()`: reading the certificates about
 *    yourself, or about your own child, is not a permission anyone could sensibly be denied.
 *
 * Route order matters: Nest matches in declaration order, so the literal segments are declared
 * before the `:id` routes that would otherwise swallow them.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { normalizeOffsetPage } from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import {
  approveDocumentRequestSchema,
  archiveDocumentTemplateSchema,
  bulkIssueDocumentsSchema,
  createDocumentRequestSchema,
  createDocumentTemplateSchema,
  documentRegisterQuerySchema,
  idParamSchema,
  issueDocumentSchema,
  listDocumentRequestsSchema,
  listDocumentTemplatesSchema,
  listIssuedDocumentsSchema,
  previewDocumentSchema,
  rejectDocumentRequestSchema,
  revokeIssuedDocumentSchema,
  updateDocumentTemplateSchema,
  verifyDocumentSchema,
} from '@shikkha/validation';
import {
  Audited,
  Authenticated,
  Ctx,
  CurrentUser,
  InstitutionScoped,
  Public,
  RequirePermissions,
} from '../../common/decorators';
import { AuthRateLimit } from '../../common/guards/rate-limit.guard';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { currentContext, type RequestContext } from '../../common/context/request-context';
import { DocumentsService, DOCUMENT_VARIABLE_CATALOG } from './documents.service';

@ApiTags('documents')
@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  // ── Public verification ─────────────────────────────────────────────────────────────

  /**
   * Check a certificate from the code printed on it.
   *
   * Unauthenticated by design: the point is that an employer, a university admissions office
   * or another school can confirm a document without an account. The response is deliberately
   * four fields — a revoked document verifies as *revoked*, never as absent, because "no such
   * document" and "this one was withdrawn" mean very different things to the person holding
   * the paper.
   *
   * Not `@Audited(...)`: the interceptor has no tenant context on a public route, and the
   * `document_verifications` row the service writes inside the document's own tenant is a
   * better record than an audit line would be — it is append-only by trigger.
   */
  @Post('verify')
  @Public()
  @AuthRateLimit()
  @ApiOperation({ summary: 'Verify a document from its verification code' })
  async verify(
    @Body(zodBody(verifyDocumentSchema)) body: z.infer<typeof verifyDocumentSchema>,
    @Ctx() context: RequestContext,
  ) {
    return this.documents.verifyPublicly(body.code, context.ipAddress, body.channel);
  }

  /**
   * The same check, over the counter.
   *
   * `documents.verify` is held by students and guardians (checking their own certificate) and
   * by office staff confirming one presented at the desk. It answers exactly what the public
   * route answers — being signed in buys no extra detail — but the verification row records
   * `staff_portal`, so a run of counter checks is distinguishable from a run of anonymous ones
   * when a forgery is being traced.
   */
  @Post('verify/counter')
  @RequirePermissions('documents.verify')
  @Audited({ module: 'documents', resourceType: 'document_verification', action: 'export' })
  @ApiOperation({ summary: 'Verify a document from its code, from inside the school' })
  async verifyAtCounter(
    @Body(zodBody(verifyDocumentSchema)) body: z.infer<typeof verifyDocumentSchema>,
    @Ctx() context: RequestContext,
  ) {
    return this.documents.verifyPublicly(body.code, context.ipAddress, 'staff_portal');
  }

  // ── Self-service ────────────────────────────────────────────────────────────────────

  @Get('my-documents')
  @Authenticated()
  @ApiOperation({ summary: 'Documents issued about me, or about my children' })
  async myDocuments(@CurrentUser() principal: Principal) {
    return this.documents.myDocuments(principal);
  }

  // ── Template authoring ──────────────────────────────────────────────────────────────

  /**
   * The variable vocabulary a template may use.
   *
   * Published rather than documented in a wiki, because the renderer refuses any name outside
   * it and an author needs to see the list that decides.
   */
  @Get('variables')
  @RequirePermissions('documents.templates.manage', 'documents.generate', { mode: 'any' })
  @ApiOperation({ summary: 'The placeholder names a document template may use' })
  variables() {
    return DOCUMENT_VARIABLE_CATALOG;
  }

  @Get('templates')
  @InstitutionScoped()
  @RequirePermissions('documents.templates.manage', 'documents.generate', { mode: 'any' })
  @ApiOperation({ summary: 'List document templates' })
  async listTemplates(
    @Query(zodQuery(listDocumentTemplatesSchema))
    query: z.infer<typeof listDocumentTemplatesSchema>,
  ) {
    return this.documents.listTemplates(
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Post('templates')
  @InstitutionScoped()
  @RequirePermissions('documents.templates.manage')
  @Audited({
    module: 'documents',
    resourceType: 'document_template',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create version 1 of a document template' })
  async createTemplate(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createDocumentTemplateSchema))
    body: z.infer<typeof createDocumentTemplateSchema>,
  ) {
    return this.documents.createTemplate(principal, requireInstitution(), body);
  }

  @Get('templates/:id')
  @InstitutionScoped()
  @RequirePermissions('documents.templates.manage', 'documents.generate', { mode: 'any' })
  @ApiOperation({ summary: 'One template version, with every edition of its key' })
  async getTemplate(@Param(zodParam(idParamSchema)) params: { id: string }) {
    return this.documents.getTemplate(requireInstitution(), params.id);
  }

  /**
   * Publish a new version. The active row is never rewritten — `document_templates_immutable`
   * refuses that — so documents already issued keep the wording they were printed with.
   */
  @Patch('templates/:id')
  @InstitutionScoped()
  @RequirePermissions('documents.templates.manage')
  @Audited({
    module: 'documents',
    resourceType: 'document_template',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Publish a new version of a document template' })
  async updateTemplate(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateDocumentTemplateSchema))
    body: z.infer<typeof updateDocumentTemplateSchema>,
  ) {
    const created = await this.documents.updateTemplate(
      principal,
      requireInstitution(),
      params.id,
      body,
    );
    return {
      ...created,
      __audit: {
        previousValue: { templateId: params.id, version: body.expectedVersion },
        newValue: { templateId: created.id, version: created.version, key: created.key },
      },
    };
  }

  @Post('templates/:id/archive')
  @InstitutionScoped()
  @RequirePermissions('documents.templates.manage')
  @Audited({
    module: 'documents',
    resourceType: 'document_template',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive a document template version' })
  async archiveTemplate(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(archiveDocumentTemplateSchema)) body: { reason: string },
  ) {
    return this.documents.archiveTemplate(
      principal,
      requireInstitution(),
      params.id,
      body.reason,
    );
  }

  // ── Preview ─────────────────────────────────────────────────────────────────────────

  /**
   * Render without issuing.
   *
   * Audited as an export even though nothing is written: the response contains a real
   * person's real details, resolved through the same scope check as reading their record, and
   * a disclosure is a disclosure whether or not a row was created.
   */
  @Post('preview')
  @InstitutionScoped()
  @RequirePermissions('documents.generate')
  @Audited({ module: 'documents', resourceType: 'document_preview', action: 'export' })
  @ApiOperation({ summary: 'Render a template against a real subject without issuing it' })
  async preview(
    @CurrentUser() principal: Principal,
    @Body(zodBody(previewDocumentSchema)) body: z.infer<typeof previewDocumentSchema>,
  ) {
    return this.documents.preview(principal, requireInstitution(), body);
  }

  // ── Requests ────────────────────────────────────────────────────────────────────────

  @Get('requests')
  @InstitutionScoped()
  @RequirePermissions('documents.generate')
  @ApiOperation({ summary: 'List document requests' })
  async listRequests(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listDocumentRequestsSchema))
    query: z.infer<typeof listDocumentRequestsSchema>,
  ) {
    return this.documents.listRequests(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Post('requests')
  @InstitutionScoped()
  @RequirePermissions('documents.generate')
  @Audited({
    module: 'documents',
    resourceType: 'document_request',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Ask for a document to be produced' })
  async createRequest(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createDocumentRequestSchema))
    body: z.infer<typeof createDocumentRequestSchema>,
  ) {
    return this.documents.createRequest(principal, requireInstitution(), body);
  }

  /**
   * `recordedBy: 'service'`: `approveRequest` writes the audit row inside its own
   * transaction, with the before-state. A second row from the interceptor would describe the
   * same event with a null `previous_value`.
   */
  @Post('requests/:id/approve')
  @InstitutionScoped()
  @RequirePermissions('documents.requests.approve')
  @Audited({
    module: 'documents',
    resourceType: 'document_request',
    action: 'approve',
    resourceIdFrom: 'param:id',
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Approve a document request (never your own)' })
  async approveRequest(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(approveDocumentRequestSchema))
    body: z.infer<typeof approveDocumentRequestSchema>,
  ) {
    return this.documents.approveRequest(principal, requireInstitution(), params.id, body.note);
  }

  @Post('requests/:id/reject')
  @InstitutionScoped()
  @RequirePermissions('documents.requests.approve')
  @Audited({
    module: 'documents',
    resourceType: 'document_request',
    action: 'reject',
    resourceIdFrom: 'param:id',
    requiresReason: true,
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Reject a document request, with a recorded reason' })
  async rejectRequest(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(rejectDocumentRequestSchema)) body: { reason: string },
  ) {
    return this.documents.rejectRequest(
      principal,
      requireInstitution(),
      params.id,
      body.reason,
    );
  }

  /**
   * Issue the document an approved request asked for.
   *
   * `recordedBy: 'service'`: the issuance audit row is written in the same transaction as the
   * document, so a rolled-back issuance leaves no trail and a committed one always has one.
   */
  @Post('requests/:id/issue')
  @InstitutionScoped()
  @RequirePermissions('documents.generate')
  @Audited({
    module: 'documents',
    resourceType: 'issued_document',
    action: 'create',
    resourceIdFrom: 'response:id',
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Issue the document for an approved request' })
  async issue(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(issueDocumentSchema)) body: z.infer<typeof issueDocumentSchema>,
  ) {
    return this.documents.issue(principal, requireInstitution(), params.id, body.issuedOn);
  }

  // ── Issued documents ────────────────────────────────────────────────────────────────

  /**
   * One document per actively enrolled student in a section.
   *
   * The interceptor's audit row describes the *batch*; the service writes one row per issued
   * document inside the transaction. Those are genuinely different events, so both are
   * correct and `recordedBy` is deliberately not set here.
   */
  @Post('issued/bulk')
  @InstitutionScoped()
  @RequirePermissions('documents.generate')
  @Audited({
    module: 'documents',
    resourceType: 'document_bulk_issuance',
    action: 'create',
  })
  @ApiOperation({ summary: 'Issue a document for every student in a section' })
  async bulkIssue(
    @CurrentUser() principal: Principal,
    @Body(zodBody(bulkIssueDocumentsSchema)) body: z.infer<typeof bulkIssueDocumentsSchema>,
  ) {
    const result = await this.documents.bulkIssue(principal, requireInstitution(), body);
    return {
      ...result,
      __audit: {
        newValue: {
          templateId: body.templateId,
          sectionId: body.sectionId,
          issuedCount: result.issued.length,
          skippedCount: result.skipped.length,
        },
      },
    };
  }

  @Get('issued')
  @InstitutionScoped()
  @RequirePermissions('documents.generate')
  @ApiOperation({ summary: 'List issued documents' })
  async listIssued(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listIssuedDocumentsSchema))
    query: z.infer<typeof listIssuedDocumentsSchema>,
  ) {
    return this.documents.listIssued(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  /**
   * A short-lived signed URL for the archived copy. Audited as an export: handing out a
   * certificate is a disclosure, and the trail should show who received which one.
   */
  @Get('issued/:id/download')
  @InstitutionScoped()
  @RequirePermissions('documents.generate')
  @Audited({
    module: 'documents',
    resourceType: 'issued_document',
    action: 'export',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Get a short-lived signed download URL for an issued document' })
  async download(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    const result = await this.documents.downloadUrl(principal, requireInstitution(), params.id);
    return {
      ...result,
      __audit: { newValue: { issuedDocumentId: params.id, serialNumber: result.serialNumber } },
    };
  }

  /**
   * Withdraw a document. A status change with a mandatory reason, never a delete —
   * `issued_documents_immutable` accepts exactly this update and refuses every other one.
   */
  @Post('issued/:id/revoke')
  @InstitutionScoped()
  @RequirePermissions('documents.revoke')
  @Audited({
    module: 'documents',
    resourceType: 'issued_document',
    action: 'unpublish',
    resourceIdFrom: 'param:id',
    requiresReason: true,
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Revoke an issued document, with a recorded reason' })
  async revoke(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(revokeIssuedDocumentSchema)) body: { reason: string },
  ) {
    return this.documents.revoke(principal, requireInstitution(), params.id, body.reason);
  }

  // ── Reports ─────────────────────────────────────────────────────────────────────────

  @Get('reports/register')
  @InstitutionScoped()
  @RequirePermissions('documents.register.view')
  @ApiOperation({ summary: 'The issuance register for a date range' })
  async register(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(documentRegisterQuerySchema))
    query: z.infer<typeof documentRegisterQuerySchema>,
  ) {
    return this.documents.register(principal, requireInstitution(), query);
  }
}

/**
 * `@InstitutionScoped()` makes the tenant guard require and validate the header; this is the
 * belt-and-braces read, because `currentContext()` returns `string | null` and a service that
 * received `null` would silently work across institutions.
 */
function requireInstitution(): string {
  const institutionId = currentContext()?.institutionId;
  if (!institutionId) {
    throw new BadRequestException(
      'Send the x-institution-id header to indicate which institution these documents belong to.',
    );
  }
  return institutionId;
}
