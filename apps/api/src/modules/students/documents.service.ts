/**
 * Student documents (Phase 3 completion): upload, list, signed download, soft delete.
 *
 * Storage discipline, restated because every rule here exists to protect a child's papers:
 *
 *  - Bytes go through `StorageService.put`, whose internal `buildKey` produces the only key
 *    shape that exists: `tenants/{tenantId}/{category}/{uuid}.{ext}`. No caller-supplied
 *    string ever becomes part of a path.
 *  - Downloads are **signed, expiring URLs**. Nothing is served from a static path, so
 *    possessing a link stops working five minutes later, and guessing one never works.
 *  - Deletion is a marker (`archived_at` on both the document and its file row). The bytes
 *    stay put: a birth certificate attached to an academic record is itself a record.
 *  - The MIME type stored is determined from the bytes where the signature is recognisable;
 *    the client's claim is used only when the bytes are inconclusive, and the allow-list has
 *    already bounded what can be stored at all.
 */

import { Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { files, studentDocuments } from '@shikkha/db';
import { NotFoundError, ValidationError } from '@shikkha/shared';
import { can, type Principal } from '@shikkha/permissions';
import type { UploadStudentDocumentInput } from '@shikkha/validation';
import { DatabaseService } from '../database/database.service';
import { StorageService } from '../storage/storage.service';
import { StudentsService } from './students.service';

/** The slice of a multipart upload this service needs; matches Multer's file object. */
export interface UploadedFileLike {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

export interface StudentDocumentView {
  id: string;
  studentId: string;
  documentType: string;
  title: string;
  documentNumber: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  verifiedAt: Date | null;
  createdAt: Date;
  originalFilename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
}

@Injectable()
export class StudentDocumentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly students: StudentsService,
    private readonly storage: StorageService,
  ) {}

  async upload(
    principal: Principal,
    institutionId: string,
    studentId: string,
    input: UploadStudentDocumentInput,
    file: UploadedFileLike,
  ): Promise<StudentDocumentView> {
    if (!file || !file.buffer || file.size === 0) {
      throw new ValidationError('No file was uploaded', [
        { path: 'file', message: 'Attach the document file as the "file" field' },
      ]);
    }
    if (file.size > MAX_DOCUMENT_BYTES) {
      throw new ValidationError('The file is too large', [
        { path: 'file', message: 'Documents may be at most 5 MB' },
      ]);
    }

    const mimeType = sniffMimeType(file.buffer) ?? file.mimetype;
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      throw new ValidationError('This file type is not accepted', [
        { path: 'file', message: 'Upload a JPEG, PNG, WebP or PDF file' },
      ]);
    }

    const scope = this.students.requireScope(principal);

    // Cheap visibility check before any bytes touch disk, so an unauthorized caller cannot
    // even create orphaned objects. Re-checked inside the transaction below.
    await this.students.assertVisible(principal, studentId);

    // The bytes are written before the transaction: if the transaction fails, the orphaned
    // object is invisible (no `files` row) and swept by the incomplete-upload cleanup job.
    // The reverse order would risk a database row pointing at bytes that were never stored.
    const tenantId = principal.tenantId!;
    const stored = await this.storage.put({
      tenantId,
      category: 'student_document',
      filename: file.originalname,
      contentType: mimeType,
      body: file.buffer,
    });

    return this.db.runInTenant(async (tx) => {
      const student = await this.students.loadVisible(tx, principal, scope, studentId);
      if (student.institutionId !== institutionId) {
        throw new NotFoundError('Student', studentId);
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
          category: 'student_document',
          ownerType: 'student',
          ownerId: studentId,
          // Medical documents get the sensitive flag: reads require the medical permission.
          isSensitive: input.documentType === 'medical',
          uploadedAt: new Date(),
          createdBy: principal.userId,
        })
        .returning();

      const [documentRow] = await tx
        .insert(studentDocuments)
        .values({
          tenantId,
          institutionId,
          studentId,
          fileId: fileRow!.id,
          documentType: input.documentType,
          title: input.title,
          documentNumber: input.documentNumber ?? null,
          issuedOn: input.issuedOn ?? null,
          expiresOn: input.expiresOn ?? null,
          createdBy: principal.userId,
        })
        .returning();

      return this.toView(documentRow!, fileRow!);
    });
  }

  /**
   * List a student's documents. Medical documents are withheld entirely from callers
   * without `students.medical.view` — a title like "Asthma treatment plan" is itself
   * medical data.
   */
  async list(principal: Principal, studentId: string): Promise<StudentDocumentView[]> {
    const scope = this.students.requireScope(principal);

    return this.db.runInTenant(async (tx) => {
      await this.students.loadVisible(tx, principal, scope, studentId);

      const rows = await tx
        .select({ document: studentDocuments, file: files })
        .from(studentDocuments)
        .leftJoin(files, eq(files.id, studentDocuments.fileId))
        .where(and(eq(studentDocuments.studentId, studentId), isNull(studentDocuments.archivedAt)))
        .orderBy(studentDocuments.createdAt);

      const includeMedical = can(principal, 'students.medical.view');
      return rows
        .filter((row) => includeMedical || row.document.documentType !== 'medical')
        .map((row) => this.toView(row.document, row.file));
    });
  }

  /**
   * Issue a signed, expiring download URL for one document.
   *
   * The permission check happens here, at issuance; the URL itself is then bearer-valid for
   * its five-minute life, exactly like an S3 pre-signed URL. Never a static path.
   */
  async downloadUrl(
    principal: Principal,
    studentId: string,
    documentId: string,
  ): Promise<{ documentId: string; url: string; expiresInSeconds: number }> {
    const scope = this.students.requireScope(principal);

    return this.db.runInTenant(async (tx) => {
      await this.students.loadVisible(tx, principal, scope, studentId);

      const [row] = await tx
        .select({ document: studentDocuments, file: files })
        .from(studentDocuments)
        .leftJoin(files, eq(files.id, studentDocuments.fileId))
        .where(
          and(
            eq(studentDocuments.id, documentId),
            eq(studentDocuments.studentId, studentId),
            isNull(studentDocuments.archivedAt),
          ),
        )
        .limit(1);

      if (!row || !row.file || row.file.archivedAt !== null) {
        throw new NotFoundError('Document', documentId);
      }
      if (row.document.documentType === 'medical' && !can(principal, 'students.medical.view')) {
        // 404, not 403: confirming a medical document exists is a disclosure by itself.
        throw new NotFoundError('Document', documentId);
      }

      const ttlSeconds = 300;
      return {
        documentId,
        url: this.storage.signUrl(row.file.storageKey, ttlSeconds),
        expiresInSeconds: ttlSeconds,
      };
    });
  }

  /** Soft delete: a marker on the document and its file row. The bytes are never removed. */
  async archive(
    principal: Principal,
    institutionId: string,
    studentId: string,
    documentId: string,
    reason: string,
  ): Promise<{ id: string; archivedAt: Date }> {
    const scope = this.students.requireScope(principal);

    return this.db.runInTenant(async (tx) => {
      const student = await this.students.loadVisible(tx, principal, scope, studentId);
      if (student.institutionId !== institutionId) {
        throw new NotFoundError('Student', studentId);
      }

      const [document] = await tx
        .select()
        .from(studentDocuments)
        .where(
          and(
            eq(studentDocuments.id, documentId),
            eq(studentDocuments.studentId, studentId),
            isNull(studentDocuments.archivedAt),
          ),
        )
        .limit(1);
      if (!document) throw new NotFoundError('Document', documentId);

      const archivedAt = new Date();
      await tx
        .update(studentDocuments)
        .set({
          archivedAt,
          archivedBy: principal.userId,
          archiveReason: reason.slice(0, 500),
          updatedBy: principal.userId,
        })
        .where(eq(studentDocuments.id, documentId));

      await tx
        .update(files)
        .set({
          archivedAt,
          archivedBy: principal.userId,
          archiveReason: reason.slice(0, 500),
          updatedBy: principal.userId,
        })
        .where(eq(files.id, document.fileId));

      return { id: documentId, archivedAt };
    });
  }

  /**
   * Redeem a signed URL: signature and expiry first, then the file row.
   *
   * There is no principal here — the HMAC signature *is* the credential, issued a few
   * minutes ago to a caller who passed the tenant, scope and permission checks. That is why
   * the lookup runs as platform: an anonymous request has no tenant context, and the key it
   * presents was signed by us over exactly this key and expiry. Every failure is the same
   * 404; a distinguishable "expired" versus "no such file" would confirm key validity.
   */
  async redeemSignedUrl(
    key: string,
    expires: string,
    signature: string,
  ): Promise<{ body: Buffer; mimeType: string; filename: string }> {
    if (!this.storage.verifySignature(key, expires, signature)) {
      throw new NotFoundError('File');
    }

    const fileRow = await this.db.runAsPlatform(async (tx) => {
      const [row] = await tx
        .select({
          mimeType: files.mimeType,
          originalFilename: files.originalFilename,
          archivedAt: files.archivedAt,
        })
        .from(files)
        .where(eq(files.storageKey, key))
        .limit(1);
      return row ?? null;
    });

    if (!fileRow || fileRow.archivedAt !== null) {
      // An archived document's already-issued URLs die with it, before their expiry.
      throw new NotFoundError('File');
    }

    let body: Buffer;
    try {
      body = await this.storage.get(key);
    } catch {
      // The row exists but the object does not (disk loss, mis-restore). Same 404 as every
      // other failure; the discrepancy belongs in ops monitoring, not in the response.
      throw new NotFoundError('File');
    }
    return { body, mimeType: fileRow.mimeType, filename: fileRow.originalFilename };
  }

  // ────────────────────────────────────────────────────────────────────────────────────

  private toView(
    document: typeof studentDocuments.$inferSelect,
    file: typeof files.$inferSelect | null,
  ): StudentDocumentView {
    return {
      id: document.id,
      studentId: document.studentId,
      documentType: document.documentType,
      title: document.title,
      documentNumber: document.documentNumber,
      issuedOn: document.issuedOn,
      expiresOn: document.expiresOn,
      verifiedAt: document.verifiedAt,
      createdAt: document.createdAt,
      originalFilename: file?.originalFilename ?? null,
      mimeType: file?.mimeType ?? null,
      sizeBytes: file?.sizeBytes ?? null,
    };
  }
}

/**
 * Determine the MIME type from the first bytes. Covers exactly the allow-listed types; an
 * unrecognised signature returns null and the client's claim is then tested against the
 * same allow-list, so nothing outside it is ever stored.
 */
export function sniffMimeType(buffer: Buffer): string | null {
  if (buffer.length >= 4) {
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      return 'image/png';
    }
    if (buffer.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}
