/**
 * Discipline and behaviour endpoints (Phase 22).
 *
 * Every route is `@InstitutionScoped()`: a disciplinary record belongs to one institution,
 * and a group administrator running three schools has no safe default.
 *
 * The permission split, written down:
 *
 *   discipline.records.view    — read records (row scope narrowed further by the service:
 *                                staff with `students.view.all` see everything, teachers
 *                                with `students.view.assigned` see only their own students)
 *   discipline.records.create  — report an incident, add a note
 *   discipline.records.action  — decide outcomes: manage categories, transition statuses,
 *                                propose/approve/revoke actions, read restricted records
 *   students.view.own          — a guardian (or student), seeing only their own records,
 *                                only once substantiated or actioned, never restricted
 *
 * The catalogue does not yet carry finer-grained discipline permissions (a scoped view
 * triple, a category-manage permission, a separate approve permission); the missing strings
 * are reported to the orchestrator rather than invented here. What the split above cannot
 * express — that the approver of a severe action must be a DIFFERENT person from its
 * decider — is enforced by identity in the service and by a check constraint in the
 * database, so it holds even for a principal holding every permission.
 *
 * There is deliberately no AI-facing route here: no auto-classification, no suggested
 * sanction, nothing an AI could create, decide or escalate.
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
  acknowledgeBehaviourRecordSchema,
  addBehaviourNoteSchema,
  approveDisciplinaryActionSchema,
  archiveBehaviourCategorySchema,
  behaviourTrendQuerySchema,
  createBehaviourCategorySchema,
  createBehaviourRecordSchema,
  idParamSchema,
  listBehaviourCategoriesSchema,
  listBehaviourRecordsSchema,
  meritLeaderboardQuerySchema,
  myChildrenBehaviourQuerySchema,
  proposeDisciplinaryActionSchema,
  revokeDisciplinaryActionSchema,
  transitionBehaviourRecordSchema,
  updateBehaviourCategorySchema,
} from '@shikkha/validation';
import { DisciplineService } from './discipline.service';
import {
  Audited,
  CurrentUser,
  InstitutionScoped,
  RequirePermissions,
} from '../../common/decorators';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { currentContext } from '../../common/context/request-context';

@ApiTags('discipline')
@Controller('discipline')
@InstitutionScoped()
export class DisciplineController {
  constructor(private readonly discipline: DisciplineService) {}

  // ── Behaviour categories ────────────────────────────────────────────────────────────

  @Get('categories')
  @RequirePermissions('discipline.records.view')
  @ApiOperation({ summary: 'List behaviour categories' })
  async listCategories(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listBehaviourCategoriesSchema))
    query: z.infer<typeof listBehaviourCategoriesSchema>,
  ) {
    return this.discipline.listCategories(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Post('categories')
  @RequirePermissions('discipline.records.action')
  @Audited({
    module: 'discipline',
    resourceType: 'behaviour_category',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create a behaviour category' })
  async createCategory(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createBehaviourCategorySchema))
    body: z.infer<typeof createBehaviourCategorySchema>,
  ) {
    return this.discipline.createCategory(principal, requireInstitution(), body);
  }

  @Patch('categories/:id')
  @RequirePermissions('discipline.records.action')
  @Audited({
    module: 'discipline',
    resourceType: 'behaviour_category',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update a behaviour category' })
  async updateCategory(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateBehaviourCategorySchema))
    body: z.infer<typeof updateBehaviourCategorySchema>,
  ) {
    const result = await this.discipline.updateCategory(
      principal,
      requireInstitution(),
      params.id,
      body,
    );
    // `__audit` is read by the audit interceptor and stripped from the HTTP response, so the
    // trail records what actually changed rather than the whole submitted body.
    return { ...result.category, __audit: { previousValue: result.previous, newValue: body } };
  }

  @Post('categories/:id/archive')
  @RequirePermissions('discipline.records.action')
  @Audited({
    module: 'discipline',
    resourceType: 'behaviour_category',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive a behaviour category (never a delete)' })
  async archiveCategory(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(archiveBehaviourCategorySchema)) body: { reason: string },
  ) {
    return this.discipline.archiveCategory(principal, requireInstitution(), params.id, body.reason);
  }

  // ── Behaviour records ───────────────────────────────────────────────────────────────

  @Post('records')
  @RequirePermissions('discipline.records.create')
  @Audited({
    module: 'discipline',
    resourceType: 'behaviour_record',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Report a behaviour incident or commendation' })
  async createRecord(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createBehaviourRecordSchema))
    body: z.infer<typeof createBehaviourRecordSchema>,
  ) {
    return this.discipline.createRecord(principal, requireInstitution(), body);
  }

  @Get('records')
  @RequirePermissions('discipline.records.view', 'students.view.own', { mode: 'any' })
  @ApiOperation({ summary: 'List behaviour records within the caller’s data scope' })
  async listRecords(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listBehaviourRecordsSchema))
    query: z.infer<typeof listBehaviourRecordsSchema>,
  ) {
    return this.discipline.listRecords(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  /**
   * Declared before the `:id` routes below — Nest matches in declaration order, and
   * `my-children` must never be parsed as a record id.
   */
  @Get('records/my-children')
  @RequirePermissions('students.view.own')
  @ApiOperation({ summary: 'A guardian’s behaviour summary for their own children' })
  async myChildren(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(myChildrenBehaviourQuerySchema))
    query: z.infer<typeof myChildrenBehaviourQuerySchema>,
  ) {
    return this.discipline.myChildrenSummary(principal, requireInstitution(), query);
  }

  @Get('records/:id')
  @RequirePermissions('discipline.records.view', 'students.view.own', { mode: 'any' })
  @ApiOperation({ summary: 'Fetch one behaviour record with its actions and notes' })
  async getRecord(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.discipline.getRecord(principal, requireInstitution(), params.id);
  }

  /**
   * A status transition through the validated state machine. An invalid move is a 409
   * naming both states. The reason is mandatory (`requiresReason`) and lands in the audit
   * log with actor and timestamp; the service writes a second record inside the business
   * transaction so a rolled-back decision leaves no trail and a committed one always does.
   */
  @Post('records/:id/status')
  @RequirePermissions('discipline.records.action', 'discipline.records.create', { mode: 'any' })
  @Audited({
    module: 'discipline',
    resourceType: 'behaviour_record',
    action: 'update',
    resourceIdFrom: 'param:id',
    requiresReason: true,
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Move a behaviour record through its status state machine' })
  async transitionRecord(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(transitionBehaviourRecordSchema))
    body: z.infer<typeof transitionBehaviourRecordSchema>,
  ) {
    return this.discipline.transitionRecord(principal, requireInstitution(), params.id, body);
  }

  /** Append-only: there is no note update or delete route, and the database refuses both. */
  @Post('records/:id/notes')
  @RequirePermissions('discipline.records.create', 'discipline.records.action', { mode: 'any' })
  @Audited({
    module: 'discipline',
    resourceType: 'behaviour_record_note',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Add an append-only note to a behaviour record' })
  async addNote(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(addBehaviourNoteSchema)) body: z.infer<typeof addBehaviourNoteSchema>,
  ) {
    return this.discipline.addNote(principal, requireInstitution(), params.id, body);
  }

  /** Proposing an action. It is created `proposed` and changes nothing until approved. */
  @Post('records/:id/actions')
  @RequirePermissions('discipline.records.action')
  @Audited({
    module: 'discipline',
    resourceType: 'disciplinary_action',
    action: 'create',
    resourceIdFrom: 'response:id',
    requiresReason: true,
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Propose a disciplinary action on a behaviour record' })
  async proposeAction(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(proposeDisciplinaryActionSchema))
    body: z.infer<typeof proposeDisciplinaryActionSchema>,
  ) {
    return this.discipline.proposeAction(principal, requireInstitution(), params.id, body);
  }

  /** A guardian confirms they have seen a record about their own child. */
  @Post('records/:id/acknowledge')
  @RequirePermissions('students.view.own')
  @Audited({
    module: 'discipline',
    resourceType: 'guardian_acknowledgement',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Acknowledge a behaviour record as the student’s guardian' })
  async acknowledge(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(acknowledgeBehaviourRecordSchema))
    body: z.infer<typeof acknowledgeBehaviourRecordSchema>,
  ) {
    return this.discipline.acknowledge(principal, requireInstitution(), params.id, body);
  }

  // ── Disciplinary actions ────────────────────────────────────────────────────────────

  /**
   * Approval. For a severe action (suspension, expulsion recommendation) the service
   * refuses an approver who is the decider — by identity, not permission, so holding every
   * permission does not get one person around it.
   */
  @Post('actions/:id/approve')
  @RequirePermissions('discipline.records.action')
  @Audited({
    module: 'discipline',
    resourceType: 'disciplinary_action',
    action: 'approve',
    resourceIdFrom: 'param:id',
    requiresReason: true,
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Approve a proposed disciplinary action (different approver)' })
  async approveAction(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(approveDisciplinaryActionSchema))
    body: z.infer<typeof approveDisciplinaryActionSchema>,
  ) {
    return this.discipline.approveAction(
      principal,
      requireInstitution(),
      params.id,
      body.reason,
      body.version,
    );
  }

  /** Revocation, never deletion: the action stays on the record, marked and reasoned. */
  @Post('actions/:id/revoke')
  @RequirePermissions('discipline.records.action')
  @Audited({
    module: 'discipline',
    resourceType: 'disciplinary_action',
    action: 'update',
    resourceIdFrom: 'param:id',
    requiresReason: true,
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Revoke a disciplinary action with a mandatory reason' })
  async revokeAction(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(revokeDisciplinaryActionSchema))
    body: z.infer<typeof revokeDisciplinaryActionSchema>,
  ) {
    return this.discipline.revokeAction(
      principal,
      requireInstitution(),
      params.id,
      body.reason,
      body.version,
    );
  }

  // ── Reports ─────────────────────────────────────────────────────────────────────────

  /** Positive points only — the product never publishes a negative ranking of children. */
  @Get('reports/merit-leaderboard')
  @RequirePermissions('discipline.records.view')
  @ApiOperation({ summary: 'Merit points leaderboard for a section (positive points only)' })
  async meritLeaderboard(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(meritLeaderboardQuerySchema))
    query: z.infer<typeof meritLeaderboardQuerySchema>,
  ) {
    return this.discipline.meritLeaderboard(principal, requireInstitution(), query);
  }

  @Get('reports/trends')
  @RequirePermissions('discipline.records.view')
  @ApiOperation({ summary: 'Incident trends by month, category or severity (SQL-computed)' })
  async incidentTrends(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(behaviourTrendQuerySchema))
    query: z.infer<typeof behaviourTrendQuerySchema>,
  ) {
    return this.discipline.incidentTrends(principal, requireInstitution(), query);
  }
}

/**
 * `@InstitutionScoped()` makes the tenant guard require and validate the header; this is the
 * belt-and-braces read, because `currentContext()` returns `string | null` and a service
 * that received `null` would silently query across institutions.
 */
function requireInstitution(): string {
  const institutionId = currentContext()?.institutionId;
  if (!institutionId) {
    throw new BadRequestException(
      'Send the x-institution-id header to indicate which institution these records belong to.',
    );
  }
  return institutionId;
}
