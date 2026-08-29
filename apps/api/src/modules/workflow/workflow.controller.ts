/**
 * Workflow engine endpoints (Phase 25).
 *
 * Every decision is its own POST with its own audit metadata — approve, reject, send-back,
 * cancel and comment are different records for an auditor, and folding them into one generic
 * "transition" endpoint would erase exactly the distinction the trail exists to keep.
 *
 * The service writes the precise transition audit row inside the deciding transaction;
 * `@Audited` on the route is the coarse request-level record and the boot-time route audit's
 * evidence that no mutation ships unaudited. The self-approval and four-eyes rules live in
 * the service (`assertMayDecide`) — no permission declared here can express them.
 */

import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { normalizeOffsetPage } from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import {
  approveWorkflowRequestSchema,
  archiveWorkflowDefinitionSchema,
  cancelWorkflowRequestSchema,
  commentWorkflowRequestSchema,
  createWorkflowDefinitionSchema,
  createWorkflowDelegationSchema,
  createWorkflowRequestSchema,
  idParamSchema,
  listOverdueWorkflowRequestsSchema,
  listWorkflowDefinitionsSchema,
  listWorkflowDelegationsSchema,
  listWorkflowRequestsSchema,
  rejectWorkflowRequestSchema,
  sendBackWorkflowRequestSchema,
  revokeWorkflowDelegationSchema,
  updateWorkflowDefinitionSchema,
} from '@shikkha/validation';
import { WorkflowService } from './workflow.service';
import {
  Audited,
  CurrentUser,
  InstitutionScoped,
  RequirePermissions,
} from '../../common/decorators';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { currentContext } from '../../common/context/request-context';

@ApiTags('workflows')
@Controller('workflows')
export class WorkflowController {
  constructor(private readonly workflow: WorkflowService) {}

  // ───────────────────────────────────────────────────────────────────────────────────
  // Definitions
  // ───────────────────────────────────────────────────────────────────────────────────

  @Get('definitions')
  @RequirePermissions('workflows.view')
  @ApiOperation({ summary: 'List workflow definitions' })
  async listDefinitions(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listWorkflowDefinitionsSchema))
    query: z.infer<typeof listWorkflowDefinitionsSchema>,
  ) {
    return this.workflow.listDefinitions(principal, query, normalizeOffsetPage(query));
  }

  @Get('definitions/:id')
  @RequirePermissions('workflows.view')
  @ApiOperation({ summary: 'Fetch one workflow definition with its steps' })
  async getDefinition(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.workflow.getDefinition(principal, params.id);
  }

  @Post('definitions')
  @InstitutionScoped()
  @RequirePermissions('workflows.manage')
  @Audited({
    module: 'workflow',
    resourceType: 'workflow_definition',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create a workflow definition (version 1)' })
  async createDefinition(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createWorkflowDefinitionSchema))
    body: z.infer<typeof createWorkflowDefinitionSchema>,
  ) {
    const institutionId = requireInstitution();
    return this.workflow.createDefinition(principal, institutionId, body);
  }

  /**
   * An active definition is immutable: this creates version n+1 and deactivates version n.
   * Requests already running keep the version they started under.
   */
  @Patch('definitions/:id')
  @RequirePermissions('workflows.manage')
  @Audited({
    module: 'workflow',
    resourceType: 'workflow_definition',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Edit a workflow definition by creating a new version' })
  async updateDefinition(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateWorkflowDefinitionSchema))
    body: z.infer<typeof updateWorkflowDefinitionSchema>,
  ) {
    const result = await this.workflow.updateDefinition(principal, params.id, body);
    return {
      ...result.definition,
      __audit: { previousValue: result.previous, newValue: body },
    };
  }

  @Post('definitions/:id/archive')
  @RequirePermissions('workflows.manage')
  @Audited({
    module: 'workflow',
    resourceType: 'workflow_definition',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive a workflow definition' })
  async archiveDefinition(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(archiveWorkflowDefinitionSchema)) body: { reason: string },
  ) {
    return this.workflow.archiveDefinition(principal, params.id, body.reason);
  }

  // ───────────────────────────────────────────────────────────────────────────────────
  // Requests. Literal paths (`overdue`) are declared before `:id` routes.
  // ───────────────────────────────────────────────────────────────────────────────────

  @Get('requests')
  @RequirePermissions('workflows.view', 'workflows.act', { mode: 'any' })
  @ApiOperation({ summary: 'List workflow requests (mine / awaiting my action / all)' })
  async listRequests(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listWorkflowRequestsSchema))
    query: z.infer<typeof listWorkflowRequestsSchema>,
  ) {
    return this.workflow.listRequests(principal, query, normalizeOffsetPage(query));
  }

  @Get('requests/overdue')
  @RequirePermissions('workflows.view')
  @ApiOperation({ summary: 'Requests past their SLA due date' })
  async listOverdue(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listOverdueWorkflowRequestsSchema))
    query: z.infer<typeof listOverdueWorkflowRequestsSchema>,
  ) {
    return this.workflow.listOverdue(principal, query, normalizeOffsetPage(query));
  }

  @Get('requests/:id')
  @RequirePermissions('workflows.view', 'workflows.act', { mode: 'any' })
  @ApiOperation({ summary: 'Fetch one request with its steps and full decision history' })
  async getRequest(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.workflow.getRequest(principal, params.id);
  }

  @Post('requests')
  @InstitutionScoped()
  @RequirePermissions('workflows.act')
  @Audited({
    module: 'workflow',
    resourceType: 'workflow_request',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Start a workflow for an entity' })
  async createRequest(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createWorkflowRequestSchema))
    body: z.infer<typeof createWorkflowRequestSchema>,
  ) {
    const institutionId = requireInstitution();
    return this.workflow.startWorkflow(principal, institutionId, body);
  }

  @Post('requests/:id/approve')
  @RequirePermissions('workflows.act')
  @Audited({
    module: 'workflow',
    resourceType: 'workflow_request',
    action: 'approve',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Approve the current step of a request' })
  async approve(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(approveWorkflowRequestSchema))
    body: z.infer<typeof approveWorkflowRequestSchema>,
  ) {
    return this.workflow.approve(principal, params.id, body);
  }

  @Post('requests/:id/reject')
  @RequirePermissions('workflows.act')
  @Audited({
    module: 'workflow',
    resourceType: 'workflow_request',
    action: 'reject',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Reject the current step of a request' })
  async reject(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(rejectWorkflowRequestSchema))
    body: z.infer<typeof rejectWorkflowRequestSchema>,
  ) {
    return this.workflow.reject(principal, params.id, body);
  }

  @Post('requests/:id/send-back')
  @RequirePermissions('workflows.act')
  @Audited({
    module: 'workflow',
    resourceType: 'workflow_request',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Send a request back to a named earlier step' })
  async sendBack(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(sendBackWorkflowRequestSchema))
    body: z.infer<typeof sendBackWorkflowRequestSchema>,
  ) {
    return this.workflow.sendBack(principal, params.id, body);
  }

  @Post('requests/:id/cancel')
  @RequirePermissions('workflows.act')
  @Audited({
    module: 'workflow',
    resourceType: 'workflow_request',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Cancel a request (initiator or workflow administrator)' })
  async cancel(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(cancelWorkflowRequestSchema))
    body: z.infer<typeof cancelWorkflowRequestSchema>,
  ) {
    return this.workflow.cancel(principal, params.id, body);
  }

  @Post('requests/:id/comment')
  @RequirePermissions('workflows.view', 'workflows.act', { mode: 'any' })
  @Audited({
    module: 'workflow',
    resourceType: 'workflow_request',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Comment on a request without moving it' })
  async comment(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(commentWorkflowRequestSchema))
    body: z.infer<typeof commentWorkflowRequestSchema>,
  ) {
    return this.workflow.comment(principal, params.id, body);
  }

  // ───────────────────────────────────────────────────────────────────────────────────
  // Delegations
  // ───────────────────────────────────────────────────────────────────────────────────

  @Get('delegations')
  @RequirePermissions('workflows.act', 'workflows.manage', { mode: 'any' })
  @ApiOperation({ summary: 'List delegations (your own, or all with workflows.manage)' })
  async listDelegations(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listWorkflowDelegationsSchema))
    query: z.infer<typeof listWorkflowDelegationsSchema>,
  ) {
    return this.workflow.listDelegations(principal, query, normalizeOffsetPage(query));
  }

  @Post('delegations')
  @RequirePermissions('workflows.act', 'workflows.manage', { mode: 'any' })
  @Audited({
    module: 'workflow',
    resourceType: 'workflow_delegation',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Delegate approval authority for a date window' })
  async createDelegation(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createWorkflowDelegationSchema))
    body: z.infer<typeof createWorkflowDelegationSchema>,
  ) {
    return this.workflow.createDelegation(principal, body);
  }

  @Post('delegations/:id/revoke')
  @RequirePermissions('workflows.act', 'workflows.manage', { mode: 'any' })
  @Audited({
    module: 'workflow',
    resourceType: 'workflow_delegation',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Revoke a delegation' })
  async revokeDelegation(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(revokeWorkflowDelegationSchema)) body: { reason: string },
  ) {
    return this.workflow.revokeDelegation(principal, params.id, body.reason);
  }
}

/** Starting a workflow and creating a definition both need one named institution. */
function requireInstitution(): string {
  const institutionId = currentContext()?.institutionId;
  if (!institutionId) {
    throw new BadRequestException(
      'Send the x-institution-id header to indicate which institution this workflow belongs to.',
    );
  }
  return institutionId;
}
