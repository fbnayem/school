/**
 * Student lifecycle endpoints (Phase 3 completion): standalone enrolment, promotion,
 * transfers, withdrawal, readmission, and the two bulk operations.
 *
 * Every mutation here is a separate route with its own permission and its own audit action —
 * never folded into PATCH — because "a clerk fixed a spelling" and "a child was withdrawn
 * from the school" must be distinguishable in the log. Bulk commits attach a **single**
 * batch audit record via `__audit`, carrying every affected student id, so the trail shows
 * one operation over N students rather than N unexplained writes. Previews compute through
 * the same service code path as their commit and write nothing, which is why they carry no
 * audit record: an audit trail of things that did not happen buries the things that did.
 */

import { BadRequestException, Body, Controller, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import type { Principal } from '@shikkha/permissions';
import {
  bulkSectionChangeSchema,
  bulkStatusChangeSchema,
  enrollStudentSchema,
  idParamSchema,
  promoteSectionSchema,
  readmitStudentSchema,
  transferInstitutionSchema,
  transferSectionSchema,
  withdrawStudentSchema,
} from '@shikkha/validation';
import {
  Audited,
  CurrentUser,
  InstitutionScoped,
  RequirePermissions,
} from '../../common/decorators';
import { zodBody, zodParam } from '../../common/pipes/zod-validation.pipe';
import { currentContext } from '../../common/context/request-context';
import { EnrollmentService } from './enrollment.service';
import { TransfersService } from './transfers.service';

@ApiTags('students')
@Controller('students')
export class StudentLifecycleController {
  constructor(
    private readonly enrollment: EnrollmentService,
    private readonly transfers: TransfersService,
  ) {}

  /**
   * Enrol an existing student into a section for an academic year. Section capacity, the
   * one-live-enrolment-per-year rule and institution membership are enforced in the service.
   *
   * Uses `admissions.enroll` — the catalogue's enrolment permission; there is no separate
   * `students.enroll` string.
   */
  @Post(':id/enroll')
  @InstitutionScoped()
  @RequirePermissions('admissions.enroll')
  @Audited({
    module: 'students',
    resourceType: 'enrollment',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Enrol an existing student into a section' })
  async enroll(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(enrollStudentSchema)) body: z.infer<typeof enrollStudentSchema>,
  ) {
    const institutionId = requireInstitution();
    const enrollment = await this.enrollment.enroll(principal, institutionId, params.id, body);
    return {
      ...enrollment,
      __audit: {
        newValue: {
          studentId: params.id,
          enrollmentId: enrollment.id,
          sectionId: enrollment.sectionId,
          academicYearId: enrollment.academicYearId,
          rollNumber: enrollment.rollNumber,
        },
      },
    };
  }

  /** Withdrawal closes the enrolment (freeing the seat) and sets the student's status. */
  @Post(':id/withdraw')
  @InstitutionScoped()
  @RequirePermissions('students.withdraw')
  @Audited({
    module: 'students',
    resourceType: 'student',
    action: 'update',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Withdraw a student' })
  async withdraw(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(withdrawStudentSchema)) body: z.infer<typeof withdrawStudentSchema>,
  ) {
    const institutionId = requireInstitution();
    const result = await this.enrollment.withdraw(principal, institutionId, params.id, body);
    return {
      ...result.student,
      __audit: {
        previousValue: { status: 'active' },
        newValue: {
          status: 'withdrawn',
          effectiveDate: body.effectiveDate,
          closedEnrollmentIds: result.closedEnrollmentIds,
        },
      },
    };
  }

  /** Readmission reopens a withdrawn record with a brand-new enrolment. */
  @Post(':id/readmit')
  @InstitutionScoped()
  @RequirePermissions('students.readmit')
  @Audited({
    module: 'students',
    resourceType: 'student',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Readmit a withdrawn student' })
  async readmit(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(readmitStudentSchema)) body: z.infer<typeof readmitStudentSchema>,
  ) {
    const institutionId = requireInstitution();
    const result = await this.enrollment.readmit(principal, institutionId, params.id, body);
    return {
      ...result.student,
      enrollment: result.enrollment,
      __audit: {
        previousValue: { status: 'withdrawn' },
        newValue: {
          status: 'active',
          enrollmentId: result.enrollment.id,
          sectionId: result.enrollment.sectionId,
          effectiveDate: body.effectiveDate,
        },
      },
    };
  }

  /** Move a student to another section of the same class and year. */
  @Post(':id/transfer-section')
  @InstitutionScoped()
  @RequirePermissions('students.transfer')
  @Audited({
    module: 'students',
    resourceType: 'student_transfer',
    action: 'update',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Transfer a student to another section' })
  async transferSection(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(transferSectionSchema)) body: z.infer<typeof transferSectionSchema>,
  ) {
    const institutionId = requireInstitution();
    const result = await this.transfers.transferSection(principal, institutionId, params.id, body);
    return {
      ...result.enrollment,
      __audit: {
        previousValue: { enrollmentId: result.closedEnrollmentId },
        newValue: {
          studentId: params.id,
          enrollmentId: result.enrollment.id,
          sectionId: result.enrollment.sectionId,
          effectiveDate: body.effectiveDate,
        },
      },
    };
  }

  /**
   * Transfer between two institutions of the same tenant. Requires transfer authority in
   * **both**: the source (checked by the guard against the header) and the target (checked
   * in the service against the caller's grants).
   */
  @Post(':id/transfer-institution')
  @InstitutionScoped()
  @RequirePermissions('students.transfer')
  @Audited({
    module: 'students',
    resourceType: 'student_transfer',
    action: 'update',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Transfer a student to another institution in the tenant' })
  async transferInstitution(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(transferInstitutionSchema)) body: z.infer<typeof transferInstitutionSchema>,
  ) {
    const institutionId = requireInstitution();
    const result = await this.transfers.transferInstitution(
      principal,
      institutionId,
      params.id,
      body,
    );
    return {
      ...result.student,
      enrollment: result.enrollment,
      __audit: {
        previousValue: {
          institutionId,
          closedEnrollmentIds: result.closedEnrollmentIds,
        },
        newValue: {
          institutionId: body.targetInstitutionId,
          enrollmentId: result.enrollment.id,
          sectionId: result.enrollment.sectionId,
          effectiveDate: body.effectiveDate,
        },
      },
    };
  }

  /**
   * Bulk promotion, one transaction, idempotent per (student, target academic year). The
   * response is the per-student report; the same report — with every affected id — is the
   * single batch audit record.
   */
  @Post('promote')
  @InstitutionScoped()
  @RequirePermissions('students.promote')
  @Audited({ module: 'students', resourceType: 'promotion', action: 'update' })
  @ApiOperation({ summary: 'Promote a section into the next academic year' })
  async promote(
    @CurrentUser() principal: Principal,
    @Body(zodBody(promoteSectionSchema)) body: z.infer<typeof promoteSectionSchema>,
  ) {
    const institutionId = requireInstitution();
    const report = await this.enrollment.promote(principal, institutionId, body);
    return {
      ...report,
      __audit: {
        newValue: {
          sourceSectionId: body.sourceSectionId,
          targetSectionId: body.targetSectionId,
          effectiveDate: body.effectiveDate,
          summary: report.summary,
          results: report.results,
        },
      },
    };
  }

  /** Dry run of the bulk section change: same code path as commit, zero writes, no audit. */
  @Post('bulk/section-change/preview')
  @InstitutionScoped()
  @RequirePermissions('students.transfer')
  // Writes nothing, but returns student records in bulk. Bulk reads of pupil data are
  // audited here for the same reason /students/export is: the disclosure is the event.
  @Audited({ module: 'students', resourceType: 'student_bulk_preview', action: 'export' })
  @ApiOperation({ summary: 'Preview a bulk section reassignment' })
  async previewSectionChange(
    @CurrentUser() principal: Principal,
    @Body(zodBody(bulkSectionChangeSchema)) body: z.infer<typeof bulkSectionChangeSchema>,
  ) {
    const institutionId = requireInstitution();
    return this.transfers.bulkSectionChange(principal, institutionId, body, 'preview');
  }

  @Post('bulk/section-change/commit')
  @InstitutionScoped()
  @RequirePermissions('students.transfer')
  @Audited({
    module: 'students',
    resourceType: 'bulk_section_change',
    action: 'update',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Apply a bulk section reassignment' })
  async commitSectionChange(
    @CurrentUser() principal: Principal,
    @Body(zodBody(bulkSectionChangeSchema)) body: z.infer<typeof bulkSectionChangeSchema>,
  ) {
    const institutionId = requireInstitution();
    const result = await this.transfers.bulkSectionChange(principal, institutionId, body, 'commit');
    return {
      ...result,
      __audit: {
        newValue: {
          targetSectionId: body.targetSectionId,
          effectiveDate: body.effectiveDate,
          movedStudentIds: result.movedStudentIds,
          results: result.results,
        },
      },
    };
  }

  @Post('bulk/status-change/preview')
  @InstitutionScoped()
  @RequirePermissions('students.update')
  // Writes nothing, but returns student records in bulk. Bulk reads of pupil data are
  // audited here for the same reason /students/export is: the disclosure is the event.
  @Audited({ module: 'students', resourceType: 'student_bulk_preview', action: 'export' })
  @ApiOperation({ summary: 'Preview a bulk status change' })
  async previewStatusChange(
    @CurrentUser() principal: Principal,
    @Body(zodBody(bulkStatusChangeSchema)) body: z.infer<typeof bulkStatusChangeSchema>,
  ) {
    const institutionId = requireInstitution();
    return this.enrollment.bulkStatusChange(principal, institutionId, body, 'preview');
  }

  @Post('bulk/status-change/commit')
  @InstitutionScoped()
  @RequirePermissions('students.update')
  @Audited({
    module: 'students',
    resourceType: 'bulk_status_change',
    action: 'update',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Apply a bulk status change' })
  async commitStatusChange(
    @CurrentUser() principal: Principal,
    @Body(zodBody(bulkStatusChangeSchema)) body: z.infer<typeof bulkStatusChangeSchema>,
  ) {
    const institutionId = requireInstitution();
    const result = await this.enrollment.bulkStatusChange(principal, institutionId, body, 'commit');
    return {
      ...result,
      __audit: {
        newValue: {
          status: body.status,
          effectiveDate: body.effectiveDate,
          changedStudentIds: result.changedStudentIds,
          results: result.results,
        },
      },
    };
  }
}

/** Same belt-and-braces read as in `StudentsController`; `@InstitutionScoped()` is the belt. */
function requireInstitution(): string {
  const institutionId = currentContext()?.institutionId;
  if (!institutionId) {
    throw new BadRequestException(
      'Send the x-institution-id header to indicate which institution to act within.',
    );
  }
  return institutionId;
}
