/**
 * Admission endpoints (Phase 5).
 *
 * Note what each route declares: a permission (or, exactly once, `@Public()`), and — for
 * anything that mutates — an audit record. The public application form is the only
 * unauthenticated write in the platform: it is rate-limited with the strict credential-
 * endpoint limit, addresses the school by public slug and code rather than any id, and its
 * response carries no tenant data.
 *
 * Decisions are human. There is no endpoint that selects, offers or enrols in bulk from a
 * model's output; merit generation is deterministic arithmetic over recorded marks and is a
 * *preview* until a human publishes it in a separate audited action.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { normalizeOffsetPage } from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import {
  acceptAdmissionOfferSchema,
  addAdmissionDocumentSchema,
  changeAdmissionSessionStatusSchema,
  createAdmissionApplicationSchema,
  createAdmissionSessionSchema,
  createAdmissionTestSchema,
  declineAdmissionOfferSchema,
  enterAdmissionTestResultsSchema,
  generateMeritListSchema,
  idParamSchema,
  issueAdmissionOfferSchema,
  listAdmissionApplicationsSchema,
  listAdmissionSessionsSchema,
  publicAdmissionApplicationSchema,
  scheduleAdmissionInterviewSchema,
  scoreAdmissionInterviewSchema,
  transitionAdmissionApplicationSchema,
  updateAdmissionSessionSchema,
  updateAdmissionTestSchema,
} from '@shikkha/validation';
import { AdmissionsService } from './admissions.service';
import {
  Audited,
  CurrentUser,
  InstitutionScoped,
  Public,
  RequirePermissions,
} from '../../common/decorators';
import { AuthRateLimit } from '../../common/guards/rate-limit.guard';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { currentContext } from '../../common/context/request-context';

@ApiTags('admissions')
@Controller('admissions')
export class AdmissionsController {
  constructor(private readonly admissions: AdmissionsService) {}

  // ──────────────────────────────────────────────────────────────────────────────────
  // Public application form
  // ──────────────────────────────────────────────────────────────────────────────────

  /**
   * The public admission form. Unauthenticated by design and therefore:
   *  - rate-limited with the strict credential-endpoint limit (volume is the only lever an
   *    anonymous abuser has);
   *  - addressed by public slug + institution code + class code, never an id;
   *  - audited inside the service (the interceptor has no tenant context on a public route);
   *  - writes an application in `submitted` status and nothing else.
   */
  @Post('public/applications')
  @Public()
  @AuthRateLimit()
  @ApiOperation({ summary: 'Submit an admission application from the public form' })
  async submitPublic(
    @Body(zodBody(publicAdmissionApplicationSchema))
    body: z.infer<typeof publicAdmissionApplicationSchema>,
  ) {
    return this.admissions.submitPublicApplication(body);
  }

  // ──────────────────────────────────────────────────────────────────────────────────
  // Sessions
  // ──────────────────────────────────────────────────────────────────────────────────

  @Get('sessions')
  @RequirePermissions('admissions.cycles.manage', 'admissions.applications.view', {
    mode: 'any',
  })
  @ApiOperation({ summary: 'List admission sessions' })
  async listSessions(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listAdmissionSessionsSchema))
    query: z.infer<typeof listAdmissionSessionsSchema>,
  ) {
    return this.admissions.listSessions(principal, query, normalizeOffsetPage(query));
  }

  @Post('sessions')
  @InstitutionScoped()
  @RequirePermissions('admissions.cycles.manage')
  @Audited({
    module: 'admissions',
    resourceType: 'admission_session',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create an admission session' })
  async createSession(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createAdmissionSessionSchema))
    body: z.infer<typeof createAdmissionSessionSchema>,
  ) {
    return this.admissions.createSession(principal, requireInstitution(), body);
  }

  @Get('sessions/:id')
  @RequirePermissions('admissions.cycles.manage', 'admissions.applications.view', {
    mode: 'any',
  })
  @ApiOperation({ summary: 'Fetch one admission session' })
  async getSession(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.admissions.getSession(principal, params.id);
  }

  @Patch('sessions/:id')
  @RequirePermissions('admissions.cycles.manage')
  @Audited({
    module: 'admissions',
    resourceType: 'admission_session',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update an admission session' })
  async updateSession(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateAdmissionSessionSchema))
    body: z.infer<typeof updateAdmissionSessionSchema>,
  ) {
    const result = await this.admissions.updateSession(principal, params.id, body);
    return { ...result.session, __audit: { previousValue: result.previous, newValue: body } };
  }

  @Post('sessions/:id/status')
  @RequirePermissions('admissions.cycles.manage')
  @Audited({
    module: 'admissions',
    resourceType: 'admission_session',
    action: 'update',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Open, close or complete an admission session' })
  async changeSessionStatus(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(changeAdmissionSessionStatusSchema))
    body: z.infer<typeof changeAdmissionSessionStatusSchema>,
  ) {
    const result = await this.admissions.changeSessionStatus(principal, params.id, body.status);
    return {
      ...result.session,
      __audit: {
        previousValue: { status: result.previousStatus },
        newValue: { status: body.status, reason: body.reason },
      },
    };
  }

  @Get('sessions/:id/funnel')
  @RequirePermissions('admissions.applications.view')
  @ApiOperation({ summary: 'The admissions funnel report for a session, computed in SQL' })
  async funnel(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.admissions.funnelReport(principal, params.id);
  }

  // ──────────────────────────────────────────────────────────────────────────────────
  // Applications
  // ──────────────────────────────────────────────────────────────────────────────────

  @Get('applications')
  @RequirePermissions('admissions.applications.view')
  @ApiOperation({ summary: 'List admission applications with filters' })
  async listApplications(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listAdmissionApplicationsSchema))
    query: z.infer<typeof listAdmissionApplicationsSchema>,
  ) {
    return this.admissions.listApplications(principal, query, normalizeOffsetPage(query));
  }

  /** Counter entry: an office clerk records a paper application. Source is `counter`. */
  @Post('applications')
  @InstitutionScoped()
  @RequirePermissions('admissions.applications.review')
  @Audited({
    module: 'admissions',
    resourceType: 'admission_application',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Record an application taken at the counter' })
  async createApplication(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createAdmissionApplicationSchema))
    body: z.infer<typeof createAdmissionApplicationSchema>,
  ) {
    return this.admissions.createApplication(principal, requireInstitution(), body);
  }

  @Get('applications/:id')
  @RequirePermissions('admissions.applications.view')
  @ApiOperation({ summary: 'Fetch one application with documents, results, interview, offers' })
  async getApplication(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.admissions.getApplication(principal, params.id);
  }

  /**
   * The generic status transition, validated against the state machine. The offer-chain
   * states are unreachable from here — they belong to the offer endpoints below, which is
   * what makes the seat check unbypassable.
   */
  @Post('applications/:id/status')
  @RequirePermissions('admissions.applications.review', 'admissions.applications.decide', {
    mode: 'any',
  })
  @Audited({
    module: 'admissions',
    resourceType: 'admission_application',
    action: 'update',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Move an application through the admission state machine' })
  async transition(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(transitionAdmissionApplicationSchema))
    body: z.infer<typeof transitionAdmissionApplicationSchema>,
  ) {
    const result = await this.admissions.transition(principal, params.id, body.status, body.reason);
    return {
      ...result.application,
      __audit: {
        previousValue: { status: result.previousStatus },
        newValue: { status: body.status, reason: body.reason },
      },
    };
  }

  // ──────────────────────────────────────────────────────────────────────────────────
  // Documents
  // ──────────────────────────────────────────────────────────────────────────────────

  @Post('applications/:id/documents')
  @RequirePermissions('admissions.applications.review')
  @Audited({
    module: 'admissions',
    resourceType: 'admission_document',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Attach a document to an application' })
  async addDocument(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(addAdmissionDocumentSchema))
    body: z.infer<typeof addAdmissionDocumentSchema>,
  ) {
    return this.admissions.addDocument(principal, params.id, body);
  }

  @Post('documents/:id/verify')
  @RequirePermissions('admissions.applications.review')
  @Audited({
    module: 'admissions',
    resourceType: 'admission_document',
    action: 'approve',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Mark a document as verified against the original' })
  async verifyDocument(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.admissions.verifyDocument(principal, params.id);
  }

  // ──────────────────────────────────────────────────────────────────────────────────
  // Tests and results
  // ──────────────────────────────────────────────────────────────────────────────────

  @Get('sessions/:id/tests')
  @RequirePermissions('admissions.tests.manage', 'admissions.applications.view', {
    mode: 'any',
  })
  @ApiOperation({ summary: 'List a session’s admission tests' })
  async listTests(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.admissions.listTests(principal, params.id);
  }

  @Post('sessions/:id/tests')
  @RequirePermissions('admissions.tests.manage')
  @Audited({
    module: 'admissions',
    resourceType: 'admission_test',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create an admission test' })
  async createTest(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(createAdmissionTestSchema)) body: z.infer<typeof createAdmissionTestSchema>,
  ) {
    return this.admissions.createTest(principal, params.id, body);
  }

  @Patch('tests/:id')
  @RequirePermissions('admissions.tests.manage')
  @Audited({
    module: 'admissions',
    resourceType: 'admission_test',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update an admission test' })
  async updateTest(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateAdmissionTestSchema)) body: z.infer<typeof updateAdmissionTestSchema>,
  ) {
    const result = await this.admissions.updateTest(principal, params.id, body);
    return { ...result.test, __audit: { previousValue: result.previous, newValue: body } };
  }

  @Put('tests/:id/results')
  @RequirePermissions('admissions.tests.manage')
  @Audited({
    module: 'admissions',
    resourceType: 'admission_test_result',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Enter or correct admission test results' })
  async enterResults(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(enterAdmissionTestResultsSchema))
    body: z.infer<typeof enterAdmissionTestResultsSchema>,
  ) {
    return this.admissions.enterTestResults(principal, params.id, body);
  }

  // ──────────────────────────────────────────────────────────────────────────────────
  // Interviews
  // ──────────────────────────────────────────────────────────────────────────────────

  @Post('applications/:id/interview')
  @RequirePermissions('admissions.interviews.manage')
  @Audited({
    module: 'admissions',
    resourceType: 'admission_interview',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Schedule an interview for an application' })
  async scheduleInterview(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(scheduleAdmissionInterviewSchema))
    body: z.infer<typeof scheduleAdmissionInterviewSchema>,
  ) {
    return this.admissions.scheduleInterview(principal, params.id, body);
  }

  @Post('interviews/:id/score')
  @RequirePermissions('admissions.interviews.manage')
  @Audited({
    module: 'admissions',
    resourceType: 'admission_interview',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Record the panel’s score for an interview' })
  async scoreInterview(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(scoreAdmissionInterviewSchema))
    body: z.infer<typeof scoreAdmissionInterviewSchema>,
  ) {
    const result = await this.admissions.scoreInterview(principal, params.id, body);
    return {
      ...result.interview,
      __audit: { previousValue: { score: result.previousScore }, newValue: body },
    };
  }

  // ──────────────────────────────────────────────────────────────────────────────────
  // Merit lists
  // ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Generate a merit list — a deterministic, reproducible *preview*. Publishing is the
   * separate action below. Uses the merit permission for both because the catalog has no
   * finer-grained `admissions.merit.generate` (reported to the catalog owners).
   */
  @Post('sessions/:id/merit-lists')
  @RequirePermissions('admissions.merit.publish')
  @Audited({
    module: 'admissions',
    resourceType: 'admission_merit_list',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Generate a merit list (preview; does not publish)' })
  async generateMeritList(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(generateMeritListSchema)) body: z.infer<typeof generateMeritListSchema>,
  ) {
    return this.admissions.generateMeritList(principal, params.id, body);
  }

  @Get('merit-lists/:id')
  @RequirePermissions('admissions.applications.view')
  @ApiOperation({ summary: 'Fetch a merit list with its ranked entries' })
  async getMeritList(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.admissions.getMeritList(principal, params.id);
  }

  @Post('merit-lists/:id/publish')
  @RequirePermissions('admissions.merit.publish')
  @Audited({
    module: 'admissions',
    resourceType: 'admission_merit_list',
    action: 'publish',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Publish a generated merit list' })
  async publishMeritList(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.admissions.publishMeritList(principal, params.id);
  }

  // ──────────────────────────────────────────────────────────────────────────────────
  // Offers
  // ──────────────────────────────────────────────────────────────────────────────────

  @Post('applications/:id/offers')
  @RequirePermissions('admissions.applications.decide')
  @Audited({
    module: 'admissions',
    resourceType: 'admission_offer',
    action: 'create',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Issue an admission offer (refused beyond the seat count)' })
  async issueOffer(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(issueAdmissionOfferSchema)) body: z.infer<typeof issueAdmissionOfferSchema>,
  ) {
    return this.admissions.issueOffer(principal, params.id, body);
  }

  /**
   * Accept an offer and convert the applicant: creates the student, the guardian and the
   * enrolment through the owning services, seat-checked under a row lock, and moves the
   * application to `enrolled`.
   */
  @Post('offers/:id/accept')
  @RequirePermissions('admissions.enroll')
  @Audited({
    module: 'admissions',
    resourceType: 'admission_offer',
    action: 'approve',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Accept an offer: creates and enrols the student' })
  async acceptOffer(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(acceptAdmissionOfferSchema)) body: z.infer<typeof acceptAdmissionOfferSchema>,
  ) {
    return this.admissions.acceptOffer(principal, params.id, body);
  }

  @Post('offers/:id/decline')
  @RequirePermissions('admissions.applications.decide')
  @Audited({
    module: 'admissions',
    resourceType: 'admission_offer',
    action: 'reject',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Record that the family declined the offer' })
  async declineOffer(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(declineAdmissionOfferSchema))
    body: z.infer<typeof declineAdmissionOfferSchema>,
  ) {
    return this.admissions.declineOffer(principal, params.id, body.reason);
  }

  /** Expiry is a fact about the clock; the endpoint records it and frees the seat. */
  @Post('offers/:id/expire')
  @RequirePermissions('admissions.applications.decide')
  @Audited({
    module: 'admissions',
    resourceType: 'admission_offer',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Mark a lapsed offer as expired and waitlist the applicant' })
  async expireOffer(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.admissions.expireOffer(principal, params.id);
  }
}

/**
 * Creating admission records requires knowing which institution they belong to, and there is
 * no safe default when a tenant has several. `@InstitutionScoped()` makes the tenant guard
 * require the header; this is the belt-and-braces read.
 */
function requireInstitution(): string {
  const institutionId = currentContext()?.institutionId;
  if (!institutionId) {
    throw new BadRequestException(
      'Send the x-institution-id header to indicate which institution this record belongs to.',
    );
  }
  return institutionId;
}
