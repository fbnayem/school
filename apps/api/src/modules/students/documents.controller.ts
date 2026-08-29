/**
 * Student document endpoints (Phase 3 completion), plus the signed-URL redemption route.
 *
 * The two controllers split along the trust boundary:
 *
 *  - `StudentDocumentsController` is fully authenticated: permission-checked, scope-checked,
 *    audited. It never serves bytes — it serves metadata and **signed, expiring URLs**.
 *  - `FilesController` serves the bytes for a valid signature. It is `@Public()` for the
 *    same reason an S3 pre-signed URL is: the HMAC signature — issued seconds ago by the
 *    authenticated route above, covering the exact key and expiry — is the credential. It
 *    grants exactly one object for five minutes, and nothing else at all.
 */

import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Principal } from '@shikkha/permissions';
import {
  archiveStudentDocumentSchema,
  fileDownloadQuerySchema,
  idParamSchema,
  studentDocumentParamsSchema,
  uploadStudentDocumentSchema,
} from '@shikkha/validation';
import {
  Audited,
  CurrentUser,
  InstitutionScoped,
  Public,
  RequirePermissions,
} from '../../common/decorators';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { currentContext } from '../../common/context/request-context';
import { BadRequestException } from '@nestjs/common';
import { StudentDocumentsService, type UploadedFileLike } from './documents.service';

@ApiTags('students')
@Controller('students')
export class StudentDocumentsController {
  constructor(private readonly documents: StudentDocumentsService) {}

  @Post(':id/documents')
  @InstitutionScoped()
  @RequirePermissions('students.documents.manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  @Audited({
    module: 'students',
    resourceType: 'student_document',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Upload a document for a student' })
  async upload(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(uploadStudentDocumentSchema))
    body: z.infer<typeof uploadStudentDocumentSchema>,
    @UploadedFile() file: UploadedFileLike,
  ) {
    const institutionId = requireInstitution();
    const document = await this.documents.upload(principal, institutionId, params.id, body, file);
    return {
      ...document,
      __audit: {
        newValue: {
          studentId: params.id,
          documentId: document.id,
          documentType: document.documentType,
          title: document.title,
          sizeBytes: document.sizeBytes,
        },
      },
    };
  }

  @Get(':id/documents')
  @RequirePermissions('students.documents.view')
  @ApiOperation({ summary: 'List a student’s documents' })
  async list(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.documents.list(principal, params.id);
  }

  /**
   * Issue a signed, expiring download URL. Audited as an export: handing out a child's
   * document — a medical report, a birth certificate — is a disclosure, and the trail must
   * show who received which document and when.
   */
  @Get(':id/documents/:documentId/download')
  @RequirePermissions('students.documents.view')
  @Audited({
    module: 'students',
    resourceType: 'student_document',
    action: 'export',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Get a short-lived signed download URL for a document' })
  async download(
    @CurrentUser() principal: Principal,
    @Param(zodParam(studentDocumentParamsSchema))
    params: { id: string; documentId: string },
  ) {
    const result = await this.documents.downloadUrl(principal, params.id, params.documentId);
    return {
      ...result,
      __audit: {
        newValue: { studentId: params.id, documentId: params.documentId },
      },
    };
  }

  /** Soft delete. The row and the bytes remain; the marker hides the document everywhere. */
  @Post(':id/documents/:documentId/archive')
  @InstitutionScoped()
  @RequirePermissions('students.documents.manage')
  @Audited({
    module: 'students',
    resourceType: 'student_document',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive (soft-delete) a student document' })
  async archive(
    @CurrentUser() principal: Principal,
    @Param(zodParam(studentDocumentParamsSchema))
    params: { id: string; documentId: string },
    @Body(zodBody(archiveStudentDocumentSchema)) body: { reason: string },
  ) {
    const institutionId = requireInstitution();
    const result = await this.documents.archive(
      principal,
      institutionId,
      params.id,
      params.documentId,
      body.reason,
    );
    return {
      ...result,
      __audit: { newValue: { studentId: params.id, documentId: params.documentId } },
    };
  }
}

/**
 * Redemption of signed URLs issued by `StorageService.signUrl`.
 *
 * Kept minimal by design: verify the HMAC and the expiry, refuse archived files, stream the
 * bytes. Every failure mode is the same 404 — an "expired" that differs from "no such key"
 * would confirm which keys exist.
 */
@ApiTags('files')
@Controller('files')
export class FilesController {
  constructor(private readonly documents: StudentDocumentsService) {}

  @Get('download')
  @Public()
  @ApiOperation({ summary: 'Download a file via a signed, expiring URL' })
  async download(
    @Query(zodQuery(fileDownloadQuerySchema))
    query: z.infer<typeof fileDownloadQuerySchema>,
    @Res() response: Response,
  ) {
    const file = await this.documents.redeemSignedUrl(query.key, query.expires, query.signature);
    response.setHeader('Content-Type', file.mimeType);
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.filename.replace(/["\r\n]/g, '')}"`,
    );
    response.setHeader('Cache-Control', 'no-store');
    // `nosniff` because the content type came from our own byte inspection, and a browser
    // second-guessing it is how an uploaded file becomes an XSS vector.
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.send(file.body);
  }
}

function requireInstitution(): string {
  const institutionId = currentContext()?.institutionId;
  if (!institutionId) {
    throw new BadRequestException(
      'Send the x-institution-id header to indicate which institution to act within.',
    );
  }
  return institutionId;
}
