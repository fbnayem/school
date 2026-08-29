/**
 * Library endpoints (Phase 17).
 *
 * Every route is `@InstitutionScoped()`: a book, a membership and a fine belong to one
 * institution, and a group administrator running three schools has no safe default. The
 * header is required by the tenant guard rather than guessed here.
 *
 * The permission split, which is the point of this file:
 *
 *   library.catalog.view        — browse the catalogue (categories, titles, copies)
 *   library.catalog.manage      — maintain it: titles, copies, settings, stock-take
 *   library.circulation.manage  — memberships, issue/return/renew, reservations
 *   library.fines.manage        — assess and collect fines
 *   library.fines.waive         — forgive one, which is a different duty from raising it
 *
 * Waiving a fine carries its own permission, mirroring `finance.discounts.approve`, so that
 * the ability to charge does not imply the ability to forgive. The service enforces the
 * separation on the data as well: the assessor of a fine can never be its waiver, whoever
 * holds the permission — which is what still protects a librarian granted `library.*`.
 *
 * Self-service (`my-loans`) is `@Authenticated()` — the service derives the member set from
 * the caller's own student, employee or guardian identity and fails closed, so there is no
 * permission anyone could sensibly be denied and no parameter to abuse.
 *
 * Route order matters: Nest matches in declaration order, so literal segments (`settings`,
 * `my-loans`, `fines/assess`, `reports/...`) are declared before any `:id` route that would
 * otherwise swallow them.
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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { normalizeOffsetPage } from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import {
  assessLibraryFinesSchema,
  cancelLibraryReservationSchema,
  createLibraryCategorySchema,
  createLibraryCopiesSchema,
  createLibraryMemberSchema,
  createLibraryReservationSchema,
  createLibraryTitleSchema,
  idParamSchema,
  issueLibraryLoanSchema,
  libraryArchiveSchema,
  libraryMostBorrowedQuerySchema,
  libraryOverdueReportQuerySchema,
  libraryStockTakeSchema,
  listLibraryCategoriesSchema,
  listLibraryCopiesSchema,
  listLibraryFinesSchema,
  listLibraryLoansSchema,
  listLibraryMembersSchema,
  listLibraryReservationsSchema,
  listLibraryTitlesSchema,
  markLibraryLoanLostSchema,
  payLibraryFineSchema,
  putLibrarySettingsSchema,
  renewLibraryLoanSchema,
  returnLibraryLoanSchema,
  updateLibraryCategorySchema,
  updateLibraryCopySchema,
  updateLibraryMemberSchema,
  updateLibraryTitleSchema,
  waiveLibraryFineSchema,
} from '@shikkha/validation';
import { LibraryService, type UploadedFileLike } from './library.service';
import {
  Audited,
  Authenticated,
  CurrentUser,
  InstitutionScoped,
  RequirePermissions,
} from '../../common/decorators';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { currentContext } from '../../common/context/request-context';

@ApiTags('library')
@Controller('library')
@InstitutionScoped()
export class LibraryController {
  constructor(private readonly library: LibraryService) {}

  // ── Settings ────────────────────────────────────────────────────────────────────────

  @Get('settings')
  @RequirePermissions('library.catalog.view')
  @ApiOperation({ summary: 'The circulation policy in force (saved or defaults)' })
  async getSettings() {
    return this.library.getSettings(requireInstitution());
  }

  /** The policy is replaced whole — a PUT, because that is what a PUT means. */
  @Put('settings')
  @RequirePermissions('library.catalog.manage')
  @Audited({ module: 'library', resourceType: 'library_settings', action: 'update' })
  @ApiOperation({ summary: 'Replace the circulation policy' })
  async putSettings(
    @CurrentUser() principal: Principal,
    @Body(zodBody(putLibrarySettingsSchema)) body: z.infer<typeof putLibrarySettingsSchema>,
  ) {
    return this.library.putSettings(principal, requireInstitution(), body);
  }

  // ── Categories ──────────────────────────────────────────────────────────────────────

  @Get('categories')
  @RequirePermissions('library.catalog.view')
  @ApiOperation({ summary: 'List book categories' })
  async listCategories(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listLibraryCategoriesSchema))
    query: z.infer<typeof listLibraryCategoriesSchema>,
  ) {
    return this.library.listCategories(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Post('categories')
  @RequirePermissions('library.catalog.manage')
  @Audited({
    module: 'library',
    resourceType: 'library_category',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create a book category' })
  async createCategory(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createLibraryCategorySchema)) body: z.infer<typeof createLibraryCategorySchema>,
  ) {
    return this.library.createCategory(principal, requireInstitution(), body);
  }

  @Patch('categories/:id')
  @RequirePermissions('library.catalog.manage')
  @Audited({
    module: 'library',
    resourceType: 'library_category',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update a book category' })
  async updateCategory(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateLibraryCategorySchema)) body: z.infer<typeof updateLibraryCategorySchema>,
  ) {
    const result = await this.library.updateCategory(
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
  @RequirePermissions('library.catalog.manage')
  @Audited({
    module: 'library',
    resourceType: 'library_category',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive a book category' })
  async archiveCategory(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(libraryArchiveSchema)) body: { reason: string },
  ) {
    return this.library.archiveCategory(principal, requireInstitution(), params.id, body.reason);
  }

  // ── Titles ──────────────────────────────────────────────────────────────────────────

  @Get('titles')
  @RequirePermissions('library.catalog.view')
  @ApiOperation({ summary: 'Search the catalogue' })
  async listTitles(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listLibraryTitlesSchema)) query: z.infer<typeof listLibraryTitlesSchema>,
  ) {
    return this.library.listTitles(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Post('titles')
  @RequirePermissions('library.catalog.manage')
  @Audited({
    module: 'library',
    resourceType: 'library_title',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Add a title to the catalogue' })
  async createTitle(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createLibraryTitleSchema)) body: z.infer<typeof createLibraryTitleSchema>,
  ) {
    return this.library.createTitle(principal, requireInstitution(), body);
  }

  @Get('titles/:id')
  @RequirePermissions('library.catalog.view')
  @ApiOperation({ summary: 'One title with its copies and queue length' })
  async getTitle(@Param(zodParam(idParamSchema)) params: { id: string }) {
    return this.library.getTitle(requireInstitution(), params.id);
  }

  @Patch('titles/:id')
  @RequirePermissions('library.catalog.manage')
  @Audited({
    module: 'library',
    resourceType: 'library_title',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update a title' })
  async updateTitle(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateLibraryTitleSchema)) body: z.infer<typeof updateLibraryTitleSchema>,
  ) {
    const result = await this.library.updateTitle(principal, requireInstitution(), params.id, body);
    return { ...result.title, __audit: { previousValue: result.previous, newValue: body } };
  }

  @Post('titles/:id/archive')
  @RequirePermissions('library.catalog.manage')
  @Audited({
    module: 'library',
    resourceType: 'library_title',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive a title' })
  async archiveTitle(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(libraryArchiveSchema)) body: { reason: string },
  ) {
    return this.library.archiveTitle(principal, requireInstitution(), params.id, body.reason);
  }

  @Post('titles/:id/cover')
  @RequirePermissions('library.catalog.manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  @Audited({
    module: 'library',
    resourceType: 'library_title_cover',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Upload a cover image for a title' })
  async uploadCover(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @UploadedFile() file: UploadedFileLike,
  ) {
    return this.library.uploadCover(principal, requireInstitution(), params.id, file);
  }

  /** A signed, expiring URL — never a static path. */
  @Get('titles/:id/cover')
  @RequirePermissions('library.catalog.view')
  @ApiOperation({ summary: 'A short-lived download URL for the cover image' })
  async coverUrl(@Param(zodParam(idParamSchema)) params: { id: string }) {
    return this.library.coverUrl(requireInstitution(), params.id);
  }

  // ── Copies ──────────────────────────────────────────────────────────────────────────

  @Get('copies')
  @RequirePermissions('library.catalog.view')
  @ApiOperation({ summary: 'List physical copies' })
  async listCopies(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listLibraryCopiesSchema)) query: z.infer<typeof listLibraryCopiesSchema>,
  ) {
    return this.library.listCopies(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Post('copies')
  @RequirePermissions('library.catalog.manage')
  @Audited({ module: 'library', resourceType: 'library_copy', action: 'create' })
  @ApiOperation({ summary: 'Accession one or more copies of a title' })
  async createCopies(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createLibraryCopiesSchema)) body: z.infer<typeof createLibraryCopiesSchema>,
  ) {
    return this.library.createCopies(principal, requireInstitution(), body);
  }

  @Patch('copies/:id')
  @RequirePermissions('library.catalog.manage')
  @Audited({
    module: 'library',
    resourceType: 'library_copy',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update a copy' })
  async updateCopy(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateLibraryCopySchema)) body: z.infer<typeof updateLibraryCopySchema>,
  ) {
    const result = await this.library.updateCopy(principal, requireInstitution(), params.id, body);
    return { ...result.copy, __audit: { previousValue: result.previous, newValue: body } };
  }

  /** Withdrawal, never deletion: the accession history stays in the register. */
  @Post('copies/:id/withdraw')
  @RequirePermissions('library.catalog.manage')
  @Audited({
    module: 'library',
    resourceType: 'library_copy',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Withdraw a copy from the register' })
  async withdrawCopy(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(libraryArchiveSchema)) body: { reason: string },
  ) {
    return this.library.withdrawCopy(principal, requireInstitution(), params.id, body.reason);
  }

  // ── Members ─────────────────────────────────────────────────────────────────────────

  @Get('members')
  @RequirePermissions('library.circulation.manage')
  @ApiOperation({ summary: 'List library members' })
  async listMembers(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listLibraryMembersSchema)) query: z.infer<typeof listLibraryMembersSchema>,
  ) {
    return this.library.listMembers(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Post('members')
  @RequirePermissions('library.circulation.manage')
  @Audited({
    module: 'library',
    resourceType: 'library_member',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create a borrowing account for a student or employee' })
  async createMember(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createLibraryMemberSchema)) body: z.infer<typeof createLibraryMemberSchema>,
  ) {
    return this.library.createMember(principal, requireInstitution(), body);
  }

  @Get('members/:id')
  @RequirePermissions('library.circulation.manage')
  @ApiOperation({ summary: 'One member with live loans and unresolved fines' })
  async getMember(@Param(zodParam(idParamSchema)) params: { id: string }) {
    return this.library.getMember(requireInstitution(), params.id);
  }

  @Patch('members/:id')
  @RequirePermissions('library.circulation.manage')
  @Audited({
    module: 'library',
    resourceType: 'library_member',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update a membership (limits, status, validity)' })
  async updateMember(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateLibraryMemberSchema)) body: z.infer<typeof updateLibraryMemberSchema>,
  ) {
    const result = await this.library.updateMember(
      principal,
      requireInstitution(),
      params.id,
      body,
    );
    return { ...result.member, __audit: { previousValue: result.previous, newValue: body } };
  }

  @Post('members/:id/archive')
  @RequirePermissions('library.circulation.manage')
  @Audited({
    module: 'library',
    resourceType: 'library_member',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive a membership' })
  async archiveMember(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(libraryArchiveSchema)) body: { reason: string },
  ) {
    return this.library.archiveMember(principal, requireInstitution(), params.id, body.reason);
  }

  // ── Circulation ─────────────────────────────────────────────────────────────────────

  @Get('loans')
  @RequirePermissions('library.circulation.manage')
  @ApiOperation({ summary: 'List loans' })
  async listLoans(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listLibraryLoansSchema)) query: z.infer<typeof listLibraryLoansSchema>,
  ) {
    return this.library.listLoans(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  /**
   * Issue a copy. The single-active-loan-per-copy invariant is the partial unique index
   * `library_loans_copy_active_key`; a concurrent double-issue surfaces here as a 409.
   */
  @Post('loans')
  @RequirePermissions('library.circulation.manage')
  @Audited({
    module: 'library',
    resourceType: 'library_loan',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Issue a copy to a member' })
  async issueLoan(
    @CurrentUser() principal: Principal,
    @Body(zodBody(issueLibraryLoanSchema)) body: z.infer<typeof issueLibraryLoanSchema>,
  ) {
    return this.library.issueLoan(principal, requireInstitution(), body);
  }

  @Post('loans/:id/return')
  @RequirePermissions('library.circulation.manage')
  @Audited({
    module: 'library',
    resourceType: 'library_loan',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Take a copy back (holds it for the reservation queue head)' })
  async returnLoan(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(returnLibraryLoanSchema)) body: z.infer<typeof returnLibraryLoanSchema>,
  ) {
    return this.library.returnLoan(principal, requireInstitution(), params.id, body);
  }

  /** Refused while a reservation queue exists — the next borrower is already waiting. */
  @Post('loans/:id/renew')
  @RequirePermissions('library.circulation.manage')
  @Audited({
    module: 'library',
    resourceType: 'library_loan',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Renew a loan' })
  async renewLoan(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(renewLibraryLoanSchema)) body: z.infer<typeof renewLibraryLoanSchema>,
  ) {
    return this.library.renewLoan(principal, requireInstitution(), params.id, body);
  }

  /**
   * The service assesses the replacement cost as a fine and writes its audit record inside
   * the same transaction; the route-level record captures who invoked the action.
   */
  @Post('loans/:id/lost')
  @RequirePermissions('library.circulation.manage')
  @Audited({
    module: 'library',
    resourceType: 'library_loan',
    action: 'update',
    resourceIdFrom: 'param:id',
    requiresReason: true,
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Mark a loaned copy lost and assess its replacement cost' })
  async markLoanLost(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(markLibraryLoanLostSchema)) body: z.infer<typeof markLibraryLoanLostSchema>,
  ) {
    return this.library.markLoanLost(principal, requireInstitution(), params.id, body);
  }

  // ── Self-service ────────────────────────────────────────────────────────────────────

  /**
   * The caller's own loans and fines. `@Authenticated()` rather than a permission: the
   * service derives the member set from the principal's own identity links and fails closed,
   * so there is nothing here anyone could be granted or denied.
   */
  @Get('my-loans')
  @Authenticated()
  @ApiOperation({ summary: 'The caller’s own loans and fines (or their children’s)' })
  async myLoans(@CurrentUser() principal: Principal) {
    return this.library.myLoans(principal, requireInstitution());
  }

  // ── Reservations ────────────────────────────────────────────────────────────────────

  @Get('reservations')
  @RequirePermissions('library.circulation.manage')
  @ApiOperation({ summary: 'List reservations in queue order' })
  async listReservations(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listLibraryReservationsSchema))
    query: z.infer<typeof listLibraryReservationsSchema>,
  ) {
    return this.library.listReservations(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Post('reservations')
  @RequirePermissions('library.circulation.manage')
  @Audited({
    module: 'library',
    resourceType: 'library_reservation',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Join the reservation queue for a title' })
  async createReservation(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createLibraryReservationSchema))
    body: z.infer<typeof createLibraryReservationSchema>,
  ) {
    return this.library.createReservation(principal, requireInstitution(), body);
  }

  /** The reason is recorded by the audit interceptor; the queue closes ranks atomically. */
  @Post('reservations/:id/cancel')
  @RequirePermissions('library.circulation.manage')
  @Audited({
    module: 'library',
    resourceType: 'library_reservation',
    action: 'update',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Cancel a reservation and close the gap in the queue' })
  async cancelReservation(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(cancelLibraryReservationSchema)) _body: { reason: string },
  ) {
    return this.library.cancelReservation(principal, requireInstitution(), params.id);
  }

  // ── Fines ───────────────────────────────────────────────────────────────────────────

  @Get('fines')
  @RequirePermissions('library.fines.manage')
  @ApiOperation({ summary: 'List fines' })
  async listFines(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listLibraryFinesSchema)) query: z.infer<typeof listLibraryFinesSchema>,
  ) {
    return this.library.listFines(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  /**
   * The explicit assessment run. Declared before the `fines/:id` routes, and deliberately an
   * endpoint rather than a computation on read: a fine shown to a guardian must be a fact
   * somebody with `library.fines.manage` is accountable for. Idempotent per loan per day,
   * backed by `library_fines_loan_day_key`.
   */
  @Post('fines/assess')
  @RequirePermissions('library.fines.manage')
  @Audited({
    module: 'library',
    resourceType: 'library_fine_run',
    action: 'update',
    requiresReason: true,
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Assess overdue fines at the institution rate' })
  async assessFines(
    @CurrentUser() principal: Principal,
    @Body(zodBody(assessLibraryFinesSchema)) body: z.infer<typeof assessLibraryFinesSchema>,
  ) {
    return this.library.assessFines(principal, requireInstitution(), body);
  }

  @Post('fines/:id/pay')
  @RequirePermissions('library.fines.manage')
  @Audited({
    module: 'library',
    resourceType: 'library_fine',
    action: 'payment',
    resourceIdFrom: 'param:id',
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Record a fine as paid' })
  async payFine(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(payLibraryFineSchema)) body: z.infer<typeof payLibraryFineSchema>,
  ) {
    return this.library.payFine(principal, requireInstitution(), params.id, body);
  }

  /**
   * Waiving: mandatory reason, its own permission, and the service refuses the person who
   * assessed the fine. Two layers on purpose — `library.fines.waive` means "may forgive a
   * charge at all", and the data rule means "not this one, you raised it", which holds even
   * for a librarian whose role grant is `library.*`.
   */
  @Post('fines/:id/waive')
  @RequirePermissions('library.fines.waive')
  @Audited({
    module: 'library',
    resourceType: 'library_fine',
    action: 'update',
    resourceIdFrom: 'param:id',
    requiresReason: true,
    recordedBy: 'service',
  })
  @ApiOperation({ summary: 'Waive a fine, with an audited reason' })
  async waiveFine(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(waiveLibraryFineSchema)) body: { reason: string },
  ) {
    return this.library.waiveFine(principal, requireInstitution(), params.id, body.reason);
  }

  // ── Reports and stock-take ──────────────────────────────────────────────────────────

  @Get('reports/overdue')
  @RequirePermissions('library.circulation.manage')
  @ApiOperation({ summary: 'Every book still out past its due date' })
  async overdueReport(
    @Query(zodQuery(libraryOverdueReportQuerySchema))
    query: z.infer<typeof libraryOverdueReportQuerySchema>,
  ) {
    return this.library.overdueReport(requireInstitution(), query.asOfDate);
  }

  @Get('reports/most-borrowed')
  @RequirePermissions('library.catalog.view')
  @ApiOperation({ summary: 'Which titles circulate most' })
  async mostBorrowedReport(
    @Query(zodQuery(libraryMostBorrowedQuerySchema))
    query: z.infer<typeof libraryMostBorrowedQuerySchema>,
  ) {
    return this.library.mostBorrowedReport(requireInstitution(), query);
  }

  /** Reconciliation only — nothing is mutated. Audited as an export like a billing preview. */
  @Post('stock-take')
  @RequirePermissions('library.catalog.manage')
  @Audited({ module: 'library', resourceType: 'library_stock_take', action: 'export' })
  @ApiOperation({ summary: 'Reconcile scanned accession numbers against the register' })
  async stockTake(
    @Body(zodBody(libraryStockTakeSchema)) body: z.infer<typeof libraryStockTakeSchema>,
  ) {
    return this.library.stockTake(requireInstitution(), body);
  }
}

/**
 * `@InstitutionScoped()` and this helper are belt and braces: the tenant guard refuses the
 * request without the header, and this re-reads it because `currentContext()` is typed
 * `string | null` and a service should not have to handle a case the guard already excluded.
 */
function requireInstitution(): string {
  const institutionId = currentContext()?.institutionId;
  if (!institutionId) {
    throw new BadRequestException(
      'Send the x-institution-id header to indicate which institution this library belongs to.',
    );
  }
  return institutionId;
}
