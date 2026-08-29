/**
 * Document and certificate generation (Phase 23).
 *
 * This module renders official paper from data other modules own. It keeps **no** copy of a
 * student, an employee or a guardian: every variable is read at render time through the
 * owning module's own scope rules, and the result is frozen into `data_snapshot` so the
 * certificate keeps asserting what was true on the day it was issued.
 *
 * Four properties carry the module, and three of them are enforced below the service:
 *
 *  1. **Rendering executes nothing.** `substitute()` is an allow-listed replacement over a
 *     `Map` of fully-qualified names. There is no expression language, no property
 *     traversal, no `eval`, no template engine. `Map.get` has no prototype chain, so
 *     `{{constructor.name}}` and `{{student.toString}}` resolve to nothing and are refused;
 *     `{{__proto__.x}}` never even reaches here, because the Zod schema's placeholder shape
 *     rejects a leading underscore. Every substituted value is HTML-escaped, so a `<script>`
 *     tag arriving through a student's legal name prints as text.
 *  2. **An issued document is immutable** — migration 0028's `issued_documents_immutable`
 *     trigger, not a convention here. Reissue creates a new row with a new serial.
 *  3. **Four eyes on an approval** — `document_requests_approver_not_requester` is a check
 *     constraint, so the owner (whose role is `*`) cannot approve their own request even by
 *     raw SQL. The service refuses it first, with a readable message.
 *  4. **Scope is borrowed, never re-implemented.** Student visibility comes from
 *     `StudentsService.assertVisible` / `findOne` / `scopeFilterSql` — the same predicate the
 *     student endpoints use. A teacher who cannot see a student cannot generate that
 *     student's certificate, and the reason is that there is only one rule.
 *
 * Serial numbers and verification codes come from `humanCode` (a CSPRNG with an unambiguous
 * alphabet — these get read aloud over the phone), never from `Math.random`, and are unique
 * per institution by index.
 */

import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  ilike,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  academicYears,
  classLevels,
  departments,
  designations,
  documentRequests,
  documentTemplates,
  documentVerifications,
  employees,
  enrollments,
  files,
  guardians,
  institutions,
  issuedDocuments,
  sections,
  students,
} from '@shikkha/db';
import {
  buildOffsetPage,
  calendarDate,
  compareCalendarDates,
  ConflictError,
  ForbiddenError,
  humanCode,
  NotFoundError,
  offsetOf,
  parseSort,
  todayInDhaka,
  uuidv7,
  ValidationError,
  WorkflowStateError,
  type OffsetPage,
  type OffsetPageRequest,
} from '@shikkha/shared';
import {
  can,
  resolveDataScope,
  SCOPED_RESOURCES,
  type Principal,
} from '@shikkha/permissions';
import {
  DOCUMENT_TEMPLATE_SORT_FIELDS,
  DOCUMENT_REQUEST_SORT_FIELDS,
  ISSUED_DOCUMENT_SORT_FIELDS,
} from '@shikkha/validation';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';
import { StudentsService } from '../students/students.service';
import { currentContext } from '../../common/context/request-context';

export type Tx = Parameters<Parameters<DatabaseService['runInTenant']>[0]>[0];

export type DocumentSubjectKind = 'student' | 'employee' | 'guardian';
export type DocumentTemplateRow = typeof documentTemplates.$inferSelect;
export type DocumentRequestRow = typeof documentRequests.$inferSelect;
export type IssuedDocumentRow = typeof issuedDocuments.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────────────
// The variable allow-list.
//
// This is the complete vocabulary a template may use. It is a closed list on purpose: the
// renderer resolves a placeholder by looking the exact string up in a Map built from these
// names, so a template can never reach a field nobody decided to expose — a bank account
// number, a medical note, a national ID.
//
// The `Record<Name, string>` literals in `commonValues` / `studentValues` / … are typed
// against these tuples, so adding a name here without producing a value for it is a compile
// error rather than a blank line on a printed certificate.
// ─────────────────────────────────────────────────────────────────────────────────────

const COMMON_VARIABLE_NAMES = [
  'institution.nameEn',
  'institution.nameBn',
  'institution.code',
  'institution.eiin',
  'institution.address',
  'institution.district',
  'institution.phone',
  'institution.email',
  'document.serialNumber',
  'document.verificationCode',
  'document.issuedOn',
  'document.purpose',
  'document.kind',
  'document.templateName',
  'document.templateVersion',
] as const;

const STUDENT_VARIABLE_NAMES = [
  'student.fullNameEn',
  'student.fullNameBn',
  'student.studentCode',
  'student.admissionNumber',
  'student.admissionDate',
  'student.dateOfBirth',
  'student.gender',
  'student.religion',
  'student.nationality',
  'student.fatherNameEn',
  'student.fatherNameBn',
  'student.motherNameEn',
  'student.motherNameBn',
  'student.status',
  'student.className',
  'student.sectionName',
  'student.rollNumber',
  'student.academicYear',
] as const;

const EMPLOYEE_VARIABLE_NAMES = [
  'employee.fullNameEn',
  'employee.fullNameBn',
  'employee.employeeCode',
  'employee.designation',
  'employee.department',
  'employee.joiningDate',
  'employee.employmentType',
  'employee.employmentStatus',
  'employee.dateOfBirth',
  'employee.gender',
] as const;

const GUARDIAN_VARIABLE_NAMES = [
  'guardian.fullNameEn',
  'guardian.fullNameBn',
  'guardian.occupation',
  'guardian.employer',
  'guardian.address',
] as const;

type CommonVariable = (typeof COMMON_VARIABLE_NAMES)[number];
type StudentVariable = (typeof STUDENT_VARIABLE_NAMES)[number];
type EmployeeVariable = (typeof EMPLOYEE_VARIABLE_NAMES)[number];
type GuardianVariable = (typeof GUARDIAN_VARIABLE_NAMES)[number];

const SUBJECT_VARIABLE_NAMES: Record<DocumentSubjectKind, readonly string[]> = {
  student: STUDENT_VARIABLE_NAMES,
  employee: EMPLOYEE_VARIABLE_NAMES,
  guardian: GUARDIAN_VARIABLE_NAMES,
};

const ALL_VARIABLE_NAMES: ReadonlySet<string> = new Set<string>([
  ...COMMON_VARIABLE_NAMES,
  ...STUDENT_VARIABLE_NAMES,
  ...EMPLOYEE_VARIABLE_NAMES,
  ...GUARDIAN_VARIABLE_NAMES,
]);

/** Serial-number prefixes, one per document kind. `TC-2026-K7M2QPXA`. */
const SERIAL_PREFIX: Record<DocumentTemplateRow['kind'], string> = {
  transfer_certificate: 'TC',
  testimonial: 'TS',
  character_certificate: 'CC',
  admission_letter: 'AL',
  id_card: 'ID',
  fee_receipt: 'FR',
  marksheet: 'MS',
  salary_certificate: 'SC',
  experience_letter: 'EL',
  notice: 'NT',
  custom: 'DOC',
};

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

/** Millimetres. Matches the column default in migration 0028. */
const DEFAULT_MARGINS = { top: 20, right: 18, bottom: 20, left: 18 } as const;

/** What a preview shows where an issued document would carry its identifiers. */
const PREVIEW_PLACEHOLDER_TEXT = '(not yet issued)';

const DOWNLOAD_URL_TTL_SECONDS = 300;

/** A section has tens of students, not thousands. The bound keeps one request bounded. */
const MAX_BULK_ISSUE = 200;

// ─────────────────────────────────────────────────────────────────────────────────────

export interface RenderedDocument {
  html: string;
  values: Record<string, string>;
  subjectDisplayName: string;
}

export interface DocumentPreview extends RenderedDocument {
  preview: true;
  templateId: string;
  templateVersion: number;
  subjectKind: DocumentSubjectKind;
  subjectId: string;
}

/**
 * What a list of issued documents returns.
 *
 * Deliberately without `renderedHtml`: a page of sixty certificates would otherwise carry
 * sixty full documents, and a caller who wants the paper asks for the signed download URL.
 */
export interface IssuedDocumentSummary {
  id: string;
  serialNumber: string;
  templateId: string;
  templateVersion: number;
  subjectKind: DocumentSubjectKind;
  subjectId: string;
  issuedOn: string;
  issuedBy: string;
  verificationCode: string;
  storageKey: string | null;
  revokedAt: Date | null;
  revokedReason: string | null;
  createdAt: Date;
}

export interface PublicVerificationResult {
  valid: boolean;
  status: 'issued' | 'revoked';
  kind: DocumentTemplateRow['kind'];
  subjectName: string;
  issuedOn: string;
}

export interface DocumentRegisterReport {
  from: string;
  to: string;
  totalIssued: number;
  totalRevoked: number;
  byKind: Array<{ kind: string; issued: number; revoked: number }>;
  entries: Array<{
    serialNumber: string;
    kind: DocumentTemplateRow['kind'];
    templateKey: string;
    templateVersion: number;
    subjectKind: DocumentSubjectKind;
    subjectName: string;
    issuedOn: string;
    issuedBy: string;
    revoked: boolean;
  }>;
}

@Injectable()
export class DocumentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly students: StudentsService,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════════════
  // Templates
  // ══════════════════════════════════════════════════════════════════════════════════

  async createTemplate(
    principal: Principal,
    institutionId: string,
    input: {
      key: string;
      name: string;
      nameBn?: string;
      kind: DocumentTemplateRow['kind'];
      bodyHtml: string;
      headerHtml?: string;
      footerHtml?: string;
      pageSize: DocumentTemplateRow['pageSize'];
      orientation: DocumentTemplateRow['orientation'];
      margins?: { top: number; right: number; bottom: number; left: number };
      requiresApproval: boolean;
    },
  ): Promise<DocumentTemplateRow> {
    const variables = this.analyseTemplate(input);

    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select({ id: documentTemplates.id })
        .from(documentTemplates)
        .where(
          and(
            eq(documentTemplates.institutionId, institutionId),
            eq(documentTemplates.key, input.key),
          ),
        )
        .limit(1);
      if (existing) {
        throw new ConflictError(
          `A template with the key "${input.key}" already exists. Edit it to publish a new version.`,
        );
      }

      const [created] = await tx
        .insert(documentTemplates)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          key: input.key,
          name: input.name,
          nameBn: input.nameBn ?? null,
          kind: input.kind,
          bodyHtml: input.bodyHtml,
          headerHtml: input.headerHtml ?? null,
          footerHtml: input.footerHtml ?? null,
          pageSize: input.pageSize,
          orientation: input.orientation,
          margins: input.margins ?? DEFAULT_MARGINS,
          variables,
          requiresApproval: input.requiresApproval,
          version: 1,
          isActive: true,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      return created!;
    });
  }

  /**
   * Publish a new version.
   *
   * The active row is deactivated and a superseding row is inserted with `version + 1`, both
   * in one transaction — the partial unique index `document_templates_active_key` would
   * otherwise refuse two live editions of one key, which is exactly the guarantee wanted.
   * Documents already issued keep the `template_version` they were rendered from, so nothing
   * printed last year changes because the wording changed this year.
   */
  async updateTemplate(
    principal: Principal,
    institutionId: string,
    templateId: string,
    input: {
      expectedVersion: number;
      name?: string;
      nameBn?: string;
      kind?: DocumentTemplateRow['kind'];
      bodyHtml?: string;
      headerHtml?: string;
      footerHtml?: string;
      pageSize?: DocumentTemplateRow['pageSize'];
      orientation?: DocumentTemplateRow['orientation'];
      margins?: { top: number; right: number; bottom: number; left: number };
      requiresApproval?: boolean;
    },
  ): Promise<DocumentTemplateRow> {
    return this.db.runInTenant(async (tx) => {
      const current = await this.loadTemplate(tx, institutionId, templateId);

      if (!current.isActive || current.archivedAt !== null) {
        throw new ConflictError(
          'Only the active version of a template can be edited. Edit the active version instead.',
        );
      }
      if (current.version !== input.expectedVersion) {
        throw new ConflictError(
          `This template has moved on to version ${current.version} since you opened it. Reload and try again.`,
        );
      }

      const merged = {
        key: current.key,
        name: input.name ?? current.name,
        nameBn: input.nameBn ?? current.nameBn ?? undefined,
        kind: input.kind ?? current.kind,
        bodyHtml: input.bodyHtml ?? current.bodyHtml,
        headerHtml: input.headerHtml ?? current.headerHtml ?? undefined,
        footerHtml: input.footerHtml ?? current.footerHtml ?? undefined,
        pageSize: input.pageSize ?? current.pageSize,
        orientation: input.orientation ?? current.orientation,
        requiresApproval: input.requiresApproval ?? current.requiresApproval,
      };
      const variables = this.analyseTemplate(merged);

      // Deactivate first: the partial unique index allows exactly one live edition per key.
      await tx
        .update(documentTemplates)
        .set({ isActive: false, updatedBy: principal.userId })
        .where(eq(documentTemplates.id, current.id));

      const [created] = await tx
        .insert(documentTemplates)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          key: merged.key,
          name: merged.name,
          nameBn: merged.nameBn ?? null,
          kind: merged.kind,
          bodyHtml: merged.bodyHtml,
          headerHtml: merged.headerHtml ?? null,
          footerHtml: merged.footerHtml ?? null,
          pageSize: merged.pageSize,
          orientation: merged.orientation,
          margins: input.margins ?? current.margins,
          variables,
          requiresApproval: merged.requiresApproval,
          version: current.version + 1,
          isActive: true,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      return created!;
    });
  }

  async archiveTemplate(
    principal: Principal,
    institutionId: string,
    templateId: string,
    reason: string,
  ): Promise<DocumentTemplateRow> {
    return this.db.runInTenant(async (tx) => {
      const current = await this.loadTemplate(tx, institutionId, templateId);
      if (current.archivedAt !== null) {
        throw new ConflictError('This template version is already archived.');
      }

      const [updated] = await tx
        .update(documentTemplates)
        .set({
          isActive: false,
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
        })
        .where(eq(documentTemplates.id, current.id))
        .returning();

      return updated!;
    });
  }

  async listTemplates(
    institutionId: string,
    query: {
      sort?: string;
      q?: string;
      kind?: DocumentTemplateRow['kind'];
      activeOnly: boolean;
      includeArchived: boolean;
    },
    page: OffsetPageRequest,
  ): Promise<OffsetPage<DocumentTemplateRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(documentTemplates.institutionId, institutionId)];
      if (!query.includeArchived) filters.push(isNull(documentTemplates.archivedAt));
      if (query.activeOnly) filters.push(eq(documentTemplates.isActive, true));
      if (query.kind) filters.push(eq(documentTemplates.kind, query.kind));
      if (query.q) {
        filters.push(
          or(
            ilike(documentTemplates.name, `%${query.q}%`),
            ilike(documentTemplates.key, `%${query.q}%`),
          )!,
        );
      }

      const where = and(...filters);
      const orderBy = parseSort(query.sort, DOCUMENT_TEMPLATE_SORT_FIELDS, {
        field: 'key',
        direction: 'asc',
      }).map((spec) => {
        const column = TEMPLATE_SORT_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(documentTemplates)
        .where(where)
        .orderBy(...orderBy, asc(documentTemplates.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(documentTemplates)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  /** One template version, plus every edition of its key so history is visible. */
  async getTemplate(
    institutionId: string,
    templateId: string,
  ): Promise<DocumentTemplateRow & { versions: DocumentTemplateRow[] }> {
    return this.db.runInTenant(async (tx) => {
      const template = await this.loadTemplate(tx, institutionId, templateId);
      const versions = await tx
        .select()
        .from(documentTemplates)
        .where(
          and(
            eq(documentTemplates.institutionId, institutionId),
            eq(documentTemplates.key, template.key),
          ),
        )
        .orderBy(desc(documentTemplates.version));
      return { ...template, versions };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Preview
  // ══════════════════════════════════════════════════════════════════════════════════

  /**
   * Render without issuing.
   *
   * The subject is real and scope-checked exactly as at issue time, which is why the route is
   * audited as an export: a preview that skipped the check would be a way to read a record the
   * caller cannot otherwise see.
   */
  async preview(
    principal: Principal,
    institutionId: string,
    input: { templateId: string; subjectKind: DocumentSubjectKind; subjectId: string },
  ): Promise<DocumentPreview> {
    const template = await this.db.runInTenant((tx) =>
      this.loadTemplate(tx, institutionId, input.templateId),
    );
    this.assertSubjectKindMatchesTemplate(template, input.subjectKind);

    const rendered = await this.render(principal, institutionId, template, {
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      purpose: 'Preview',
      serialNumber: PREVIEW_PLACEHOLDER_TEXT,
      verificationCode: PREVIEW_PLACEHOLDER_TEXT,
      issuedOn: todayInDhaka(),
    });

    return {
      ...rendered,
      preview: true,
      templateId: template.id,
      templateVersion: template.version,
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Requests
  // ══════════════════════════════════════════════════════════════════════════════════

  async createRequest(
    principal: Principal,
    institutionId: string,
    input: {
      templateId: string;
      subjectKind: DocumentSubjectKind;
      subjectId: string;
      purpose: string;
    },
  ): Promise<DocumentRequestRow> {
    const template = await this.db.runInTenant((tx) =>
      this.loadTemplate(tx, institutionId, input.templateId),
    );
    if (!template.isActive || template.archivedAt !== null) {
      throw new ConflictError(
        'That template version is no longer active. Use the current version of the template.',
      );
    }
    this.assertSubjectKindMatchesTemplate(template, input.subjectKind);

    // The same visibility rule the student endpoints use — asking for a certificate for a
    // student you cannot see is a 404, not a quietly accepted request.
    await this.assertSubjectVisible(principal, institutionId, input.subjectKind, input.subjectId);

    return this.db.runInTenant(async (tx) => {
      const [created] = await tx
        .insert(documentRequests)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          templateId: template.id,
          templateVersion: template.version,
          subjectKind: input.subjectKind,
          subjectId: input.subjectId,
          requestedBy: principal.userId,
          purpose: input.purpose,
          /**
           * A template that requires approval waits for a second person. One that does not is
           * approved on arrival by *nobody* — `approved_at` is set, `approved_by` stays null,
           * and `document_requests_decision_recorded` permits exactly that. Naming the
           * requester as their own approver to satisfy a constraint would be a lie the
           * four-eyes check constraint would refuse anyway.
           */
          status: template.requiresApproval ? 'pending_approval' : 'approved',
          approvedAt: template.requiresApproval ? null : new Date(),
          approvedBy: null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      return created!;
    });
  }

  async listRequests(
    principal: Principal,
    institutionId: string,
    query: {
      sort?: string;
      status?: DocumentRequestRow['status'];
      subjectKind?: DocumentSubjectKind;
      subjectId?: string;
      templateId?: string;
      mine: boolean;
      includeArchived: boolean;
    },
    page: OffsetPageRequest,
  ): Promise<OffsetPage<DocumentRequestRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [
        eq(documentRequests.institutionId, institutionId),
        this.requestVisibilityFilter(principal),
      ];
      if (!query.includeArchived) filters.push(isNull(documentRequests.archivedAt));
      if (query.status) filters.push(eq(documentRequests.status, query.status));
      if (query.subjectKind) filters.push(eq(documentRequests.subjectKind, query.subjectKind));
      if (query.subjectId) filters.push(eq(documentRequests.subjectId, query.subjectId));
      if (query.templateId) filters.push(eq(documentRequests.templateId, query.templateId));
      if (query.mine) filters.push(eq(documentRequests.requestedBy, principal.userId));

      const where = and(...filters);
      const orderBy = parseSort(query.sort, DOCUMENT_REQUEST_SORT_FIELDS, {
        field: 'createdAt',
        direction: 'desc',
      }).map((spec) => {
        const column = REQUEST_SORT_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(documentRequests)
        .where(where)
        .orderBy(...orderBy, asc(documentRequests.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(documentRequests)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  /**
   * Approve a request.
   *
   * The self-approval refusal is stated here so the caller gets a readable 403 rather than a
   * constraint violation — but `document_requests_approver_not_requester` is what actually
   * guarantees it, and it applies to raw SQL written by someone holding every permission in
   * the catalogue.
   */
  async approveRequest(
    principal: Principal,
    institutionId: string,
    requestId: string,
    note: string | undefined,
  ): Promise<DocumentRequestRow> {
    return this.db.runInTenant(async (tx) => {
      const request = await this.loadRequest(tx, institutionId, requestId);

      if (request.status !== 'pending_approval') {
        throw new WorkflowStateError(request.status, 'approved', 'document request');
      }
      if (request.requestedBy === principal.userId) {
        throw new ForbiddenError(
          'documents.templates.manage',
          'You cannot approve your own document request. A second person must approve it.',
        );
      }

      const [updated] = await tx
        .update(documentRequests)
        .set({
          status: 'approved',
          approvedBy: principal.userId,
          approvedAt: new Date(),
          version: request.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(documentRequests.id, request.id))
        .returning();

      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'approve',
        module: 'documents',
        resourceType: 'document_request',
        resourceId: request.id,
        resourceLabel: request.purpose,
        previousValue: { status: request.status, approvedBy: request.approvedBy },
        newValue: { status: 'approved', approvedBy: principal.userId, note: note ?? null },
        reason: note ?? null,
        requestId: currentContext()?.requestId ?? null,
        ipAddress: currentContext()?.ipAddress ?? null,
        userAgent: currentContext()?.userAgent ?? null,
      });

      return updated!;
    });
  }

  async rejectRequest(
    principal: Principal,
    institutionId: string,
    requestId: string,
    reason: string,
  ): Promise<DocumentRequestRow> {
    return this.db.runInTenant(async (tx) => {
      const request = await this.loadRequest(tx, institutionId, requestId);

      if (request.status !== 'pending_approval') {
        throw new WorkflowStateError(request.status, 'rejected', 'document request');
      }
      if (request.requestedBy === principal.userId) {
        throw new ForbiddenError(
          'documents.templates.manage',
          'You cannot decide your own document request. A second person must decide it.',
        );
      }

      const [updated] = await tx
        .update(documentRequests)
        .set({
          status: 'rejected',
          approvedBy: principal.userId,
          approvedAt: new Date(),
          rejectionReason: reason,
          version: request.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(documentRequests.id, request.id))
        .returning();

      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'reject',
        module: 'documents',
        resourceType: 'document_request',
        resourceId: request.id,
        resourceLabel: request.purpose,
        previousValue: { status: request.status },
        newValue: { status: 'rejected' },
        reason,
        requestId: currentContext()?.requestId ?? null,
        ipAddress: currentContext()?.ipAddress ?? null,
        userAgent: currentContext()?.userAgent ?? null,
      });

      return updated!;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Issuance
  // ══════════════════════════════════════════════════════════════════════════════════

  async issue(
    principal: Principal,
    institutionId: string,
    requestId: string,
    issuedOnInput: string | undefined,
  ): Promise<IssuedDocumentRow> {
    const issuedOn = this.resolveIssueDate(issuedOnInput);

    const { request, template } = await this.db.runInTenant(async (tx) => {
      const found = await this.loadRequest(tx, institutionId, requestId);
      const tpl = await this.loadTemplate(tx, institutionId, found.templateId);
      return { request: found, template: tpl };
    });

    if (request.status !== 'approved') {
      throw new WorkflowStateError(request.status, 'issued', 'document request');
    }
    if (template.requiresApproval && !request.approvedBy) {
      // Restated for a readable message; the trigger refuses the insert regardless.
      throw new ForbiddenError(
        'documents.generate',
        'This template requires approval and this request has not been approved by a second person.',
      );
    }

    const identifiers = await this.reserveIdentifiers(institutionId, template.kind);

    const rendered = await this.render(principal, institutionId, template, {
      subjectKind: request.subjectKind,
      subjectId: request.subjectId,
      purpose: request.purpose,
      serialNumber: identifiers.serialNumber,
      verificationCode: identifiers.verificationCode,
      issuedOn,
    });

    // Bytes before the transaction: an orphaned object is swept up later, whereas a committed
    // row pointing at nothing is a broken record.
    const stored = await this.storage.put({
      tenantId: principal.tenantId!,
      category: 'issued_document',
      filename: `${identifiers.serialNumber}.html`,
      contentType: 'text/html; charset=utf-8',
      body: Buffer.from(rendered.html, 'utf8'),
    });

    return this.db.runInTenant(async (tx) => {
      const created = await this.insertIssuedDocument(tx, principal, {
        institutionId,
        requestId: request.id,
        template,
        subjectKind: request.subjectKind,
        subjectId: request.subjectId,
        purpose: request.purpose,
        issuedOn,
        rendered,
        identifiers,
        stored,
      });

      await tx
        .update(documentRequests)
        .set({ status: 'issued', version: request.version + 1, updatedBy: principal.userId })
        .where(eq(documentRequests.id, request.id));

      return created;
    });
  }

  /**
   * One document per actively enrolled student in a section.
   *
   * Refused for a template that requires approval: a bulk run has no requester whose approval
   * a second person could have given, and `issued_documents_approval_required` refuses the
   * insert regardless of what this method decides.
   */
  async bulkIssue(
    principal: Principal,
    institutionId: string,
    input: { templateId: string; sectionId: string; purpose: string; issuedOn?: string },
  ): Promise<{ sectionId: string; issued: IssuedDocumentSummary[]; skipped: string[] }> {
    const issuedOn = this.resolveIssueDate(input.issuedOn);

    const template = await this.db.runInTenant((tx) =>
      this.loadTemplate(tx, institutionId, input.templateId),
    );
    if (!template.isActive || template.archivedAt !== null) {
      throw new ConflictError('That template version is no longer active.');
    }
    if (template.requiresApproval) {
      throw new ConflictError(
        'This template requires an approved request for each document, so it cannot be issued in bulk.',
      );
    }
    this.assertSubjectKindMatchesTemplate(template, 'student');

    const scope = this.students.requireScope(principal);
    const candidates = await this.db.runInTenant(async (tx) => {
      const [section] = await tx
        .select({ id: sections.id })
        .from(sections)
        .where(
          and(
            eq(sections.id, input.sectionId),
            eq(sections.institutionId, institutionId),
            isNull(sections.archivedAt),
          ),
        )
        .limit(1);
      if (!section) throw new NotFoundError('Section', input.sectionId);

      // The student scope filter, borrowed verbatim: a bulk run can never reach a student the
      // caller could not have fetched one at a time.
      return tx
        .select({ id: students.id })
        .from(students)
        .where(
          and(
            this.students.scopeFilterSql(principal, scope),
            isNull(students.archivedAt),
            exists(
              this.db.raw
                .select({ one: sql`1` })
                .from(enrollments)
                .where(
                  and(
                    eq(enrollments.studentId, students.id),
                    eq(enrollments.sectionId, input.sectionId),
                    eq(enrollments.status, 'active'),
                    isNull(enrollments.archivedAt),
                  ),
                ),
            ),
          ),
        )
        .orderBy(asc(students.fullNameEn), asc(students.id))
        .limit(MAX_BULK_ISSUE + 1);
    });

    if (candidates.length > MAX_BULK_ISSUE) {
      throw new ValidationError(
        `That section has more than ${MAX_BULK_ISSUE} students. Issue them in smaller groups.`,
        [{ path: 'sectionId', message: 'Too many students for one bulk issuance' }],
      );
    }

    const issued: IssuedDocumentSummary[] = [];
    const skipped: string[] = [];

    for (const candidate of candidates) {
      try {
        const identifiers = await this.reserveIdentifiers(institutionId, template.kind);
        const rendered = await this.render(principal, institutionId, template, {
          subjectKind: 'student',
          subjectId: candidate.id,
          purpose: input.purpose,
          serialNumber: identifiers.serialNumber,
          verificationCode: identifiers.verificationCode,
          issuedOn,
        });

        const stored = await this.storage.put({
          tenantId: principal.tenantId!,
          category: 'issued_document',
          filename: `${identifiers.serialNumber}.html`,
          contentType: 'text/html; charset=utf-8',
          body: Buffer.from(rendered.html, 'utf8'),
        });

        const created = await this.db.runInTenant((tx) =>
          this.insertIssuedDocument(tx, principal, {
            institutionId,
            requestId: null,
            template,
            subjectKind: 'student',
            subjectId: candidate.id,
            purpose: input.purpose,
            issuedOn,
            rendered,
            identifiers,
            stored,
          }),
        );
        issued.push(toIssuedSummary(created));
      } catch (error) {
        // One student whose record cannot produce this document must not abandon the other
        // fifty-nine. Only the two "this subject is not renderable" failures are tolerated;
        // anything else — a conflict, a database refusal, a bug — still fails the whole run,
        // because silently returning a short list would be worse than an error.
        if (error instanceof NotFoundError || error instanceof ValidationError) {
          skipped.push(candidate.id);
          continue;
        }
        throw error;
      }
    }

    return { sectionId: input.sectionId, issued, skipped };
  }

  async listIssued(
    principal: Principal,
    institutionId: string,
    query: {
      sort?: string;
      q?: string;
      templateId?: string;
      kind?: DocumentTemplateRow['kind'];
      subjectKind?: DocumentSubjectKind;
      subjectId?: string;
      issuedFrom?: string;
      issuedTo?: string;
      revokedOnly: boolean;
    },
    page: OffsetPageRequest,
  ): Promise<OffsetPage<IssuedDocumentSummary>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [
        eq(issuedDocuments.institutionId, institutionId),
        this.subjectVisibilityFilter(principal),
      ];
      if (query.templateId) filters.push(eq(issuedDocuments.templateId, query.templateId));
      if (query.subjectKind) filters.push(eq(issuedDocuments.subjectKind, query.subjectKind));
      if (query.subjectId) filters.push(eq(issuedDocuments.subjectId, query.subjectId));
      if (query.issuedFrom) filters.push(gte(issuedDocuments.issuedOn, query.issuedFrom));
      if (query.issuedTo) filters.push(lte(issuedDocuments.issuedOn, query.issuedTo));
      if (query.revokedOnly) filters.push(sql`${issuedDocuments.revokedAt} is not null`);
      if (query.q) filters.push(ilike(issuedDocuments.serialNumber, `%${query.q}%`));
      if (query.kind) {
        filters.push(
          exists(
            this.db.raw
              .select({ one: sql`1` })
              .from(documentTemplates)
              .where(
                and(
                  eq(documentTemplates.id, issuedDocuments.templateId),
                  eq(documentTemplates.kind, query.kind),
                ),
              ),
          ),
        );
      }

      const where = and(...filters);
      const orderBy = parseSort(query.sort, ISSUED_DOCUMENT_SORT_FIELDS, {
        field: 'issuedOn',
        direction: 'desc',
      }).map((spec) => {
        const column = ISSUED_SORT_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select(ISSUED_SUMMARY_COLUMNS)
        .from(issuedDocuments)
        .where(where)
        .orderBy(...orderBy, asc(issuedDocuments.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(issuedDocuments)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  /** Self-service: the documents about *me*, or about a child I am the guardian of. */
  async myDocuments(principal: Principal): Promise<IssuedDocumentSummary[]> {
    const branches: SQL[] = [];
    if (principal.studentId) {
      branches.push(
        and(
          eq(issuedDocuments.subjectKind, 'student'),
          eq(issuedDocuments.subjectId, principal.studentId),
        )!,
      );
    }
    if (principal.employeeId) {
      branches.push(
        and(
          eq(issuedDocuments.subjectKind, 'employee'),
          eq(issuedDocuments.subjectId, principal.employeeId),
        )!,
      );
    }
    if (principal.guardianId) {
      const guardianId = principal.guardianId;
      branches.push(
        and(
          eq(issuedDocuments.subjectKind, 'guardian'),
          eq(issuedDocuments.subjectId, guardianId),
        )!,
      );
      // A guardian also sees the documents of the children they have live portal access to —
      // the same link that decides `students.view.own`.
      branches.push(
        and(
          eq(issuedDocuments.subjectKind, 'student'),
          exists(
            this.db.raw
              .select({ one: sql`1` })
              .from(students)
              .where(
                and(
                  eq(students.id, issuedDocuments.subjectId),
                  this.students.scopeFilterSql(principal, 'own'),
                ),
              ),
          ),
        )!,
      );
    }

    if (branches.length === 0) return [];

    return this.db.runInTenant(async (tx) =>
      tx
        .select(ISSUED_SUMMARY_COLUMNS)
        .from(issuedDocuments)
        .where(branches.length === 1 ? branches[0]! : or(...branches)!)
        .orderBy(desc(issuedDocuments.issuedOn), desc(issuedDocuments.id))
        .limit(200),
    );
  }

  /**
   * A short-lived signed URL for the archived copy.
   *
   * Redeemed by the shared `/api/v1/files/download` route, which verifies the HMAC over the
   * key *and* the expiry and serves the bytes as an attachment with `nosniff`.
   */
  async downloadUrl(
    principal: Principal,
    institutionId: string,
    issuedDocumentId: string,
  ): Promise<{ url: string; expiresInSeconds: number; serialNumber: string }> {
    const row = await this.db.runInTenant(async (tx) => {
      const [found] = await tx
        .select({
          serialNumber: issuedDocuments.serialNumber,
          storageKey: issuedDocuments.storageKey,
        })
        .from(issuedDocuments)
        .where(
          and(
            eq(issuedDocuments.id, issuedDocumentId),
            eq(issuedDocuments.institutionId, institutionId),
            this.subjectVisibilityFilter(principal),
          ),
        )
        .limit(1);
      return found ?? null;
    });

    if (!row) throw new NotFoundError('Document', issuedDocumentId);
    if (!row.storageKey) {
      throw new NotFoundError('Document file', issuedDocumentId);
    }

    return {
      url: this.storage.signUrl(row.storageKey, DOWNLOAD_URL_TTL_SECONDS),
      expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
      serialNumber: row.serialNumber,
    };
  }

  /**
   * Withdraw a document.
   *
   * A status change with a mandatory reason, never a delete: `issued_documents_immutable`
   * accepts exactly this update and refuses every other one, so a revoked certificate still
   * verifies — as revoked — rather than vanishing.
   */
  async revoke(
    principal: Principal,
    institutionId: string,
    issuedDocumentId: string,
    reason: string,
  ): Promise<IssuedDocumentSummary> {
    return this.db.runInTenant(async (tx) => {
      const [row] = await tx
        .select({
          id: issuedDocuments.id,
          serialNumber: issuedDocuments.serialNumber,
          requestId: issuedDocuments.requestId,
          revokedAt: issuedDocuments.revokedAt,
        })
        .from(issuedDocuments)
        .where(
          and(
            eq(issuedDocuments.id, issuedDocumentId),
            eq(issuedDocuments.institutionId, institutionId),
          ),
        )
        .limit(1);
      if (!row) throw new NotFoundError('Document', issuedDocumentId);
      if (row.revokedAt) {
        throw new ConflictError('This document has already been revoked.');
      }

      const [updated] = await tx
        .update(issuedDocuments)
        .set({
          revokedAt: new Date(),
          revokedBy: principal.userId,
          revokedReason: reason,
          updatedBy: principal.userId,
        })
        .where(eq(issuedDocuments.id, row.id))
        .returning(ISSUED_SUMMARY_COLUMNS);

      if (row.requestId) {
        await tx
          .update(documentRequests)
          .set({ status: 'revoked', updatedBy: principal.userId })
          .where(eq(documentRequests.id, row.requestId));
      }

      await this.audit.recordInTransaction(tx, {
        tenantId: principal.tenantId,
        institutionId,
        actorUserId: principal.userId,
        actorRoles: principal.roles.map((role) => role.roleKey),
        action: 'unpublish',
        module: 'documents',
        resourceType: 'issued_document',
        resourceId: row.id,
        resourceLabel: row.serialNumber,
        previousValue: { revokedAt: null, serialNumber: row.serialNumber },
        newValue: { revokedAt: updated!.revokedAt, revokedBy: principal.userId },
        reason,
        requestId: currentContext()?.requestId ?? null,
        ipAddress: currentContext()?.ipAddress ?? null,
        userAgent: currentContext()?.userAgent ?? null,
      });

      return updated!;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Public verification
  // ══════════════════════════════════════════════════════════════════════════════════

  /**
   * The unauthenticated check an employer performs on a certificate they hold.
   *
   * It answers four things and no more: is it valid, what kind of document is it, whose name
   * is on it, and when was it issued. No identifiers, no contact details, no subject id, no
   * institution record, nothing from the rendered body. The name comes from `data_snapshot`,
   * so it is the name the document actually asserts rather than whatever the student's record
   * says today — which is the entire point of freezing the snapshot.
   *
   * `runAsPlatform` is justified exactly as it is for the public admission form and for
   * login: the caller is anonymous and the tenant is not yet known. The transaction reads one
   * row, by a high-entropy code, and returns four fields from it.
   */
  async verifyPublicly(
    code: string,
    verifierIp: string | null,
    channel: 'public_web' | 'qr_scan' | 'staff_portal' = 'public_web',
  ): Promise<PublicVerificationResult> {
    const normalized = code.trim().toUpperCase();

    const found = await this.db.runAsPlatform(async (tx) => {
      const rows = await tx
        .select({
          id: issuedDocuments.id,
          tenantId: issuedDocuments.tenantId,
          institutionId: issuedDocuments.institutionId,
          subjectKind: issuedDocuments.subjectKind,
          dataSnapshot: issuedDocuments.dataSnapshot,
          issuedOn: issuedDocuments.issuedOn,
          revokedAt: issuedDocuments.revokedAt,
          kind: documentTemplates.kind,
        })
        .from(issuedDocuments)
        .innerJoin(documentTemplates, eq(documentTemplates.id, issuedDocuments.templateId))
        .where(eq(issuedDocuments.verificationCode, normalized))
        .limit(2);
      // The code is globally unique by index; two rows would mean a corrupted index, and
      // guessing which document was meant is worse than declining to answer.
      return rows.length === 1 ? rows[0]! : null;
    });

    if (!found) throw new NotFoundError('Document');

    // Recorded inside the document's own tenant, so RLS applies to the write exactly as it
    // would for an authenticated one.
    await this.db.runInTenantId(found.tenantId, async (tx) => {
      await tx.insert(documentVerifications).values({
        id: uuidv7(),
        tenantId: found.tenantId,
        institutionId: found.institutionId,
        issuedDocumentId: found.id,
        verifiedAt: new Date(),
        verifierIp,
        channel,
      });
    });

    return {
      valid: found.revokedAt === null,
      status: found.revokedAt === null ? 'issued' : 'revoked',
      kind: found.kind,
      subjectName: this.snapshotSubjectName(found.subjectKind, found.dataSnapshot),
      issuedOn: found.issuedOn,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Reports
  // ══════════════════════════════════════════════════════════════════════════════════

  /** The issuance register: what this institution put its name to, over a date range. */
  async register(
    principal: Principal,
    institutionId: string,
    query: {
      from: string;
      to: string;
      kind?: DocumentTemplateRow['kind'];
      templateId?: string;
      includeRevoked: boolean;
    },
  ): Promise<DocumentRegisterReport> {
    if (compareCalendarDates(calendarDate(query.from), calendarDate(query.to)) > 0) {
      throw new ValidationError('The range ends before it starts', [
        { path: 'to', message: 'The end date must not be before the start date' },
      ]);
    }

    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [
        eq(issuedDocuments.institutionId, institutionId),
        gte(issuedDocuments.issuedOn, query.from),
        lte(issuedDocuments.issuedOn, query.to),
        this.subjectVisibilityFilter(principal),
      ];
      if (query.templateId) filters.push(eq(issuedDocuments.templateId, query.templateId));
      if (query.kind) filters.push(eq(documentTemplates.kind, query.kind));
      if (!query.includeRevoked) filters.push(isNull(issuedDocuments.revokedAt));

      const rows = await tx
        .select({
          serialNumber: issuedDocuments.serialNumber,
          kind: documentTemplates.kind,
          templateKey: documentTemplates.key,
          templateVersion: issuedDocuments.templateVersion,
          subjectKind: issuedDocuments.subjectKind,
          dataSnapshot: issuedDocuments.dataSnapshot,
          issuedOn: issuedDocuments.issuedOn,
          issuedBy: issuedDocuments.issuedBy,
          revokedAt: issuedDocuments.revokedAt,
        })
        .from(issuedDocuments)
        .innerJoin(documentTemplates, eq(documentTemplates.id, issuedDocuments.templateId))
        .where(and(...filters))
        .orderBy(asc(issuedDocuments.issuedOn), asc(issuedDocuments.serialNumber))
        .limit(5000);

      const byKind = new Map<string, { kind: string; issued: number; revoked: number }>();
      let totalRevoked = 0;
      for (const row of rows) {
        const bucket = byKind.get(row.kind) ?? { kind: row.kind, issued: 0, revoked: 0 };
        bucket.issued += 1;
        if (row.revokedAt) {
          bucket.revoked += 1;
          totalRevoked += 1;
        }
        byKind.set(row.kind, bucket);
      }

      return {
        from: query.from,
        to: query.to,
        totalIssued: rows.length,
        totalRevoked,
        byKind: [...byKind.values()].sort((a, b) => a.kind.localeCompare(b.kind)),
        entries: rows.map((row) => ({
          serialNumber: row.serialNumber,
          kind: row.kind,
          templateKey: row.templateKey,
          templateVersion: row.templateVersion,
          subjectKind: row.subjectKind,
          subjectName: this.snapshotSubjectName(row.subjectKind, row.dataSnapshot),
          issuedOn: row.issuedOn,
          issuedBy: row.issuedBy,
          revoked: row.revokedAt !== null,
        })),
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Rendering — the part that must never execute anything
  // ══════════════════════════════════════════════════════════════════════════════════

  private async render(
    principal: Principal,
    institutionId: string,
    template: DocumentTemplateRow,
    context: {
      subjectKind: DocumentSubjectKind;
      subjectId: string;
      purpose: string;
      serialNumber: string;
      verificationCode: string;
      issuedOn: string;
    },
  ): Promise<RenderedDocument> {
    const subject = await this.loadSubject(
      principal,
      institutionId,
      context.subjectKind,
      context.subjectId,
    );
    const institution = await this.loadInstitution(institutionId);

    const common: Record<CommonVariable, string> = {
      'institution.nameEn': institution.nameEn,
      'institution.nameBn': institution.nameBn ?? '',
      'institution.code': institution.code,
      'institution.eiin': institution.eiin ?? '',
      'institution.address': [institution.addressLine1, institution.addressLine2]
        .filter((part): part is string => Boolean(part))
        .join(', '),
      'institution.district': institution.district ?? '',
      'institution.phone': institution.phone ?? '',
      'institution.email': institution.email ?? '',
      'document.serialNumber': context.serialNumber,
      'document.verificationCode': context.verificationCode,
      'document.issuedOn': context.issuedOn,
      'document.purpose': context.purpose,
      'document.kind': template.kind,
      'document.templateName': template.name,
      'document.templateVersion': String(template.version),
    };

    const values = new Map<string, string>([
      ...Object.entries(common),
      ...Object.entries(subject.values),
    ]);

    const html = [
      template.headerHtml ? substitute(template.headerHtml, values) : '',
      substitute(template.bodyHtml, values),
      template.footerHtml ? substitute(template.footerHtml, values) : '',
    ].join('');

    return {
      html,
      values: Object.fromEntries(values),
      subjectDisplayName: subject.displayName,
    };
  }

  /**
   * Validate a template's markup against the variable allow-list, and return the placeholder
   * names it uses — which is what `document_templates.variables` stores.
   *
   * The Zod schema has already refused anything that could execute and anything that is not a
   * dotted identifier. What is left for this method is the question the schema cannot answer:
   * does the name refer to something that exists? `{{constructor.name}}` is a well-formed
   * identifier and is refused here; so is `{{student.favouriteColour}}`. An unknown variable
   * must be a clear error at save time, never a blank on a printed certificate.
   */
  private analyseTemplate(input: {
    bodyHtml: string;
    headerHtml?: string;
    footerHtml?: string;
  }): string[] {
    const used = new Set<string>();
    for (const markup of [input.bodyHtml, input.headerHtml, input.footerHtml]) {
      if (!markup) continue;
      for (const match of markup.matchAll(PLACEHOLDER)) {
        used.add((match[1] ?? '').trim());
      }
    }

    const unknown = [...used].filter((name) => !ALL_VARIABLE_NAMES.has(name));
    if (unknown.length > 0) {
      throw new ValidationError(
        `This template uses ${unknown.length === 1 ? 'a variable' : 'variables'} that do not exist: ${unknown.join(', ')}`,
        unknown.map((name) => ({
          path: 'bodyHtml',
          message: `"{{${name}}}" is not a known document variable. Available names are listed under GET /documents/variables.`,
        })),
      );
    }

    const prefixes = new Set(
      [...used]
        .map((name) => name.split('.')[0]!)
        .filter((prefix): prefix is DocumentSubjectKind =>
          prefix === 'student' || prefix === 'employee' || prefix === 'guardian',
        ),
    );
    if (prefixes.size > 1) {
      throw new ValidationError(
        'A template describes one subject. This one mixes ' + [...prefixes].join(' and ') + '.',
        [
          {
            path: 'bodyHtml',
            message: 'Use variables for a single subject: student, employee or guardian.',
          },
        ],
      );
    }

    return [...used].sort();
  }

  /** The subject a template's variables commit it to, or null if it names none. */
  private templateSubjectKind(template: DocumentTemplateRow): DocumentSubjectKind | null {
    const names = Array.isArray(template.variables) ? (template.variables as string[]) : [];
    for (const name of names) {
      const prefix = typeof name === 'string' ? name.split('.')[0] : undefined;
      if (prefix === 'student' || prefix === 'employee' || prefix === 'guardian') return prefix;
    }
    return null;
  }

  private assertSubjectKindMatchesTemplate(
    template: DocumentTemplateRow,
    subjectKind: DocumentSubjectKind,
  ): void {
    const required = this.templateSubjectKind(template);
    if (required && required !== subjectKind) {
      throw new ValidationError(
        `This template is written for a ${required}, so it cannot be produced for a ${subjectKind}.`,
        [{ path: 'subjectKind', message: `This template needs a ${required} as its subject` }],
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Subjects — read through the owning module's scope rules, never around them
  // ══════════════════════════════════════════════════════════════════════════════════

  private async loadSubject(
    principal: Principal,
    institutionId: string,
    kind: DocumentSubjectKind,
    subjectId: string,
  ): Promise<{ displayName: string; values: Record<string, string> }> {
    if (kind === 'student') return this.loadStudentSubject(principal, institutionId, subjectId);
    if (kind === 'employee') return this.loadEmployeeSubject(principal, institutionId, subjectId);
    return this.loadGuardianSubject(principal, institutionId, subjectId);
  }

  /**
   * Assert a subject is visible, without loading it.
   *
   * Used where the answer is the only thing needed — creating a request. For students this is
   * literally `StudentsService.assertVisible`, so a teacher who would get a 404 fetching the
   * student gets a 404 asking for their certificate.
   */
  private async assertSubjectVisible(
    principal: Principal,
    institutionId: string,
    kind: DocumentSubjectKind,
    subjectId: string,
  ): Promise<void> {
    if (kind === 'student') {
      await this.students.assertVisible(principal, subjectId);
      return;
    }
    // Employees and guardians have no `assertVisible` of their own; the loaders below apply
    // the same 404-on-invisible rule, so reuse them rather than writing a second predicate.
    await this.loadSubject(principal, institutionId, kind, subjectId);
  }

  private async loadStudentSubject(
    principal: Principal,
    institutionId: string,
    studentId: string,
  ): Promise<{ displayName: string; values: Record<string, string> }> {
    // `findOne` applies `scopeFilter` — the same predicate `assertVisible` uses — and 404s for
    // a student outside the caller's scope, inside or outside their tenant.
    const student = await this.students.findOne(principal, studentId);
    if (student.institutionId !== institutionId) throw new NotFoundError('Student', studentId);

    const placement = await this.db.runInTenant(async (tx) => {
      const [row] = await tx
        .select({
          rollNumber: enrollments.rollNumber,
          className: classLevels.nameEn,
          sectionName: sections.nameEn,
          academicYear: academicYears.name,
        })
        .from(enrollments)
        .innerJoin(classLevels, eq(classLevels.id, enrollments.classLevelId))
        .innerJoin(sections, eq(sections.id, enrollments.sectionId))
        .innerJoin(academicYears, eq(academicYears.id, enrollments.academicYearId))
        .where(
          and(
            eq(enrollments.studentId, studentId),
            eq(enrollments.status, 'active'),
            isNull(enrollments.archivedAt),
          ),
        )
        .orderBy(desc(enrollments.enrolledOn))
        .limit(1);
      return row ?? null;
    });

    const values: Record<StudentVariable, string> = {
      'student.fullNameEn': student.fullNameEn,
      'student.fullNameBn': student.fullNameBn ?? '',
      'student.studentCode': student.studentCode,
      'student.admissionNumber': student.admissionNumber,
      'student.admissionDate': student.admissionDate,
      'student.dateOfBirth': student.dateOfBirth,
      'student.gender': student.gender,
      'student.religion': student.religion ?? '',
      'student.nationality': student.nationality,
      'student.fatherNameEn': student.fatherNameEn ?? '',
      'student.fatherNameBn': student.fatherNameBn ?? '',
      'student.motherNameEn': student.motherNameEn ?? '',
      'student.motherNameBn': student.motherNameBn ?? '',
      'student.status': student.status,
      'student.className': placement?.className ?? '',
      'student.sectionName': placement?.sectionName ?? '',
      'student.rollNumber': placement?.rollNumber ?? '',
      'student.academicYear': placement?.academicYear ?? '',
    };

    return { displayName: student.fullNameEn, values };
  }

  private async loadEmployeeSubject(
    principal: Principal,
    institutionId: string,
    employeeId: string,
  ): Promise<{ displayName: string; values: Record<string, string> }> {
    const context = currentContext();
    const access = {
      institutionId: context?.institutionId ?? null,
      campusId: context?.campusId ?? null,
    };
    // An employee may always produce a certificate about themselves; anyone else needs the HR
    // read permission. A missing grant is a 404, not a 403 — the same shape as `assertVisible`,
    // because confirming that an employee id exists is itself a small leak.
    if (!can(principal, 'hr.employees.view', access) && principal.employeeId !== employeeId) {
      throw new NotFoundError('Employee', employeeId);
    }

    const row = await this.db.runInTenant(async (tx) => {
      const [found] = await tx
        .select({
          fullNameEn: employees.fullNameEn,
          fullNameBn: employees.fullNameBn,
          employeeCode: employees.employeeCode,
          joiningDate: employees.joiningDate,
          employmentType: employees.employmentType,
          employmentStatus: employees.employmentStatus,
          dateOfBirth: employees.dateOfBirth,
          gender: employees.gender,
          designation: designations.nameEn,
          department: departments.nameEn,
        })
        .from(employees)
        .leftJoin(designations, eq(designations.id, employees.designationId))
        .leftJoin(departments, eq(departments.id, employees.departmentId))
        .where(
          and(
            eq(employees.id, employeeId),
            eq(employees.institutionId, institutionId),
            isNull(employees.archivedAt),
          ),
        )
        .limit(1);
      return found ?? null;
    });

    if (!row) throw new NotFoundError('Employee', employeeId);

    const values: Record<EmployeeVariable, string> = {
      'employee.fullNameEn': row.fullNameEn,
      'employee.fullNameBn': row.fullNameBn ?? '',
      'employee.employeeCode': row.employeeCode,
      'employee.designation': row.designation ?? '',
      'employee.department': row.department ?? '',
      'employee.joiningDate': row.joiningDate,
      'employee.employmentType': row.employmentType,
      'employee.employmentStatus': row.employmentStatus,
      'employee.dateOfBirth': row.dateOfBirth ?? '',
      'employee.gender': row.gender ?? '',
    };

    return { displayName: row.fullNameEn, values };
  }

  private async loadGuardianSubject(
    principal: Principal,
    institutionId: string,
    guardianId: string,
  ): Promise<{ displayName: string; values: Record<string, string> }> {
    const context = currentContext();
    const scope = resolveDataScope(principal, SCOPED_RESOURCES.guardians, {
      institutionId: context?.institutionId ?? null,
      campusId: context?.campusId ?? null,
    });
    if (scope === 'none' || (scope === 'own' && principal.guardianId !== guardianId)) {
      throw new NotFoundError('Guardian', guardianId);
    }

    const row = await this.db.runInTenant(async (tx) => {
      const [found] = await tx
        .select({
          fullNameEn: guardians.fullNameEn,
          fullNameBn: guardians.fullNameBn,
          occupation: guardians.occupation,
          employer: guardians.employer,
          address: guardians.address,
        })
        .from(guardians)
        .where(
          and(
            eq(guardians.id, guardianId),
            eq(guardians.institutionId, institutionId),
            isNull(guardians.archivedAt),
          ),
        )
        .limit(1);
      return found ?? null;
    });

    if (!row) throw new NotFoundError('Guardian', guardianId);

    const values: Record<GuardianVariable, string> = {
      'guardian.fullNameEn': row.fullNameEn,
      'guardian.fullNameBn': row.fullNameBn ?? '',
      'guardian.occupation': row.occupation ?? '',
      'guardian.employer': row.employer ?? '',
      'guardian.address': row.address ?? '',
    };

    return { displayName: row.fullNameEn, values };
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Shared helpers
  // ══════════════════════════════════════════════════════════════════════════════════

  /**
   * The visibility predicate for `issued_documents`, expressed once.
   *
   * Every list, download and report goes through it, so a caller can never reach a document
   * about a person they could not have read directly. Student visibility is
   * `StudentsService.scopeFilterSql` verbatim — there is no second student rule anywhere in
   * this module.
   */
  private subjectVisibilityFilter(principal: Principal): SQL {
    const context = currentContext();
    const access = {
      institutionId: context?.institutionId ?? null,
      campusId: context?.campusId ?? null,
    };
    const branches: SQL[] = [];

    const studentScope = resolveDataScope(principal, SCOPED_RESOURCES.students, access);
    if (studentScope !== 'none') {
      branches.push(
        and(
          eq(issuedDocuments.subjectKind, 'student'),
          exists(
            this.db.raw
              .select({ one: sql`1` })
              .from(students)
              .where(
                and(
                  eq(students.id, issuedDocuments.subjectId),
                  this.students.scopeFilterSql(principal, studentScope),
                ),
              ),
          ),
        )!,
      );
    }

    if (can(principal, 'hr.employees.view', access)) {
      branches.push(eq(issuedDocuments.subjectKind, 'employee'));
    } else if (principal.employeeId) {
      branches.push(
        and(
          eq(issuedDocuments.subjectKind, 'employee'),
          eq(issuedDocuments.subjectId, principal.employeeId),
        )!,
      );
    }

    const guardianScope = resolveDataScope(principal, SCOPED_RESOURCES.guardians, access);
    if (guardianScope === 'all') {
      branches.push(eq(issuedDocuments.subjectKind, 'guardian'));
    } else if (guardianScope === 'own' && principal.guardianId) {
      branches.push(
        and(
          eq(issuedDocuments.subjectKind, 'guardian'),
          eq(issuedDocuments.subjectId, principal.guardianId),
        )!,
      );
    }

    if (branches.length === 0) return sql`false`;
    return branches.length === 1 ? branches[0]! : or(...branches)!;
  }

  /** The same rule, against `document_requests`. */
  private requestVisibilityFilter(principal: Principal): SQL {
    const context = currentContext();
    const access = {
      institutionId: context?.institutionId ?? null,
      campusId: context?.campusId ?? null,
    };
    const branches: SQL[] = [eq(documentRequests.requestedBy, principal.userId)];

    const studentScope = resolveDataScope(principal, SCOPED_RESOURCES.students, access);
    if (studentScope !== 'none') {
      branches.push(
        and(
          eq(documentRequests.subjectKind, 'student'),
          exists(
            this.db.raw
              .select({ one: sql`1` })
              .from(students)
              .where(
                and(
                  eq(students.id, documentRequests.subjectId),
                  this.students.scopeFilterSql(principal, studentScope),
                ),
              ),
          ),
        )!,
      );
    }
    if (can(principal, 'hr.employees.view', access)) {
      branches.push(eq(documentRequests.subjectKind, 'employee'));
    }
    if (resolveDataScope(principal, SCOPED_RESOURCES.guardians, access) === 'all') {
      branches.push(eq(documentRequests.subjectKind, 'guardian'));
    }

    return or(...branches)!;
  }

  private async loadTemplate(
    tx: Tx,
    institutionId: string,
    templateId: string,
  ): Promise<DocumentTemplateRow> {
    const [row] = await tx
      .select()
      .from(documentTemplates)
      .where(
        and(
          eq(documentTemplates.id, templateId),
          eq(documentTemplates.institutionId, institutionId),
        ),
      )
      .limit(1);
    // Cross-tenant and cross-institution are the same 404: confirming the row exists
    // elsewhere is itself a leak.
    if (!row) throw new NotFoundError('Document template', templateId);
    return row;
  }

  private async loadRequest(
    tx: Tx,
    institutionId: string,
    requestId: string,
  ): Promise<DocumentRequestRow> {
    const [row] = await tx
      .select()
      .from(documentRequests)
      .where(
        and(
          eq(documentRequests.id, requestId),
          eq(documentRequests.institutionId, institutionId),
          isNull(documentRequests.archivedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError('Document request', requestId);
    return row;
  }

  private async loadInstitution(institutionId: string): Promise<typeof institutions.$inferSelect> {
    const row = await this.db.runInTenant(async (tx) => {
      const [found] = await tx
        .select()
        .from(institutions)
        .where(eq(institutions.id, institutionId))
        .limit(1);
      return found ?? null;
    });
    if (!row) throw new NotFoundError('Institution', institutionId);
    return row;
  }

  /**
   * A serial number and a verification code, both from the CSPRNG.
   *
   * Sequential serials would let anyone holding one certificate guess the next, and a
   * verification code is a bearer credential for a public endpoint — so both are random and
   * both are checked against the institution before use. The unique indexes remain the real
   * guarantee; this loop only turns an astronomically unlikely collision into a retry rather
   * than a 409 in somebody's face.
   */
  private async reserveIdentifiers(
    institutionId: string,
    kind: DocumentTemplateRow['kind'],
  ): Promise<{ serialNumber: string; verificationCode: string }> {
    const year = Number(todayInDhaka().slice(0, 4));
    const prefix = SERIAL_PREFIX[kind];

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const serialNumber = `${prefix}-${year}-${humanCode(8)}`;
      const verificationCode = humanCode(12);

      const clash = await this.db.runInTenant(async (tx) => {
        const [found] = await tx
          .select({ id: issuedDocuments.id })
          .from(issuedDocuments)
          .where(
            and(
              eq(issuedDocuments.institutionId, institutionId),
              or(
                eq(issuedDocuments.serialNumber, serialNumber),
                eq(issuedDocuments.verificationCode, verificationCode),
              ),
            ),
          )
          .limit(1);
        return Boolean(found);
      });

      if (!clash) return { serialNumber, verificationCode };
    }

    throw new ConflictError('Could not allocate a document serial number. Please try again.');
  }

  private async insertIssuedDocument(
    tx: Tx,
    principal: Principal,
    input: {
      institutionId: string;
      requestId: string | null;
      template: DocumentTemplateRow;
      subjectKind: DocumentSubjectKind;
      subjectId: string;
      purpose: string;
      issuedOn: string;
      rendered: RenderedDocument;
      identifiers: { serialNumber: string; verificationCode: string };
      stored: { key: string; sizeBytes: number; checksum: string; contentType: string };
    },
  ): Promise<IssuedDocumentRow> {
    const [created] = await tx
      .insert(issuedDocuments)
      .values({
        id: uuidv7(),
        tenantId: principal.tenantId!,
        institutionId: input.institutionId,
        requestId: input.requestId,
        templateId: input.template.id,
        templateVersion: input.template.version,
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        serialNumber: input.identifiers.serialNumber,
        issuedOn: input.issuedOn,
        issuedBy: principal.userId,
        renderedHtml: input.rendered.html,
        storageKey: input.stored.key,
        // The whole point of the module: what the document asserted, frozen.
        dataSnapshot: {
          subjectKind: input.subjectKind,
          subjectId: input.subjectId,
          subjectName: input.rendered.subjectDisplayName,
          templateKey: input.template.key,
          templateVersion: input.template.version,
          purpose: input.purpose,
          variables: input.rendered.values,
        },
        verificationCode: input.identifiers.verificationCode,
        createdBy: principal.userId,
        updatedBy: principal.userId,
      })
      .returning();

    // The archived copy is registered in the shared `files` table so it is served by the same
    // signed-URL route as every other file in the product, with the same HMAC over key and
    // expiry. Nothing here serves bytes directly.
    await tx.insert(files).values({
      id: uuidv7(),
      tenantId: principal.tenantId!,
      institutionId: input.institutionId,
      storageKey: input.stored.key,
      originalFilename: `${input.identifiers.serialNumber}.html`,
      mimeType: input.stored.contentType,
      sizeBytes: input.stored.sizeBytes,
      checksum: input.stored.checksum,
      category: 'issued_document',
      ownerType: 'issued_document',
      ownerId: created!.id,
      isSensitive: true,
      uploadedAt: new Date(),
      createdBy: principal.userId,
      updatedBy: principal.userId,
    });

    await this.audit.recordInTransaction(tx, {
      tenantId: principal.tenantId,
      institutionId: input.institutionId,
      actorUserId: principal.userId,
      actorRoles: principal.roles.map((role) => role.roleKey),
      action: 'create',
      module: 'documents',
      resourceType: 'issued_document',
      resourceId: created!.id,
      resourceLabel: created!.serialNumber,
      newValue: {
        serialNumber: created!.serialNumber,
        templateKey: input.template.key,
        templateVersion: input.template.version,
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        issuedOn: input.issuedOn,
      },
      requestId: currentContext()?.requestId ?? null,
      ipAddress: currentContext()?.ipAddress ?? null,
      userAgent: currentContext()?.userAgent ?? null,
    });

    return created!;
  }

  private resolveIssueDate(input: string | undefined): string {
    const today = todayInDhaka();
    if (!input) return today;
    const requested = calendarDate(input);
    if (compareCalendarDates(requested, today) > 0) {
      throw new ValidationError('A document cannot be issued with a future date', [
        { path: 'issuedOn', message: 'Choose today or an earlier date' },
      ]);
    }
    return requested;
  }

  /** The name the document asserts, read out of its own frozen snapshot. */
  private snapshotSubjectName(kind: DocumentSubjectKind, snapshot: unknown): string {
    if (!snapshot || typeof snapshot !== 'object') return '';
    const record = snapshot as Record<string, unknown>;
    const direct = record['subjectName'];
    if (typeof direct === 'string' && direct.length > 0) return direct;

    const variables = record['variables'];
    if (variables && typeof variables === 'object') {
      const value = (variables as Record<string, unknown>)[`${kind}.fullNameEn`];
      if (typeof value === 'string') return value;
    }
    return '';
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────
// The renderer.
//
// Deliberately a free function with no access to anything: it receives markup and a Map, and
// returns a string. There is no way to reach a database, a service or the prototype chain
// from inside it.
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Replace every `{{name}}` with the HTML-escaped value the Map holds for that exact name.
 *
 * Three refusals, all of them deliberate:
 *
 *  - **An unknown name is an error, never a blank.** A certificate with a silently empty line
 *    where a father's name should be is worse than a failed render.
 *  - **A malformed or nested brace is an error.** `{{{{x}}}}` is an attempt to get a name past
 *    the shape check; a stray `{{` is a typo that would print literally on official paper.
 *  - **Nothing is interpreted.** The lookup is `Map.get`, which has no prototype chain, so
 *    `constructor`, `toString` and `__proto__` are simply names nobody registered.
 */
function substitute(markup: string, values: ReadonlyMap<string, string>): string {
  const matches = [...markup.matchAll(PLACEHOLDER)];
  const opens = markup.split('{{').length - 1;
  const closes = markup.split('}}').length - 1;
  if (matches.length !== opens || matches.length !== closes) {
    throw new ValidationError('This template has a malformed placeholder', [
      {
        path: 'bodyHtml',
        message: 'Every {{ must open a complete placeholder and every }} must close one.',
      },
    ]);
  }

  return markup.replace(PLACEHOLDER, (_match, raw: string) => {
    const name = raw.trim();
    const value = values.get(name);
    if (value === undefined) {
      throw new ValidationError(`This template uses an unknown variable: ${name}`, [
        {
          path: 'bodyHtml',
          message: `"{{${name}}}" is not a variable this document provides.`,
        },
      ]);
    }
    return escapeHtml(value);
  });
}

/** Narrow a freshly inserted row to the list shape, dropping the rendered body. */
function toIssuedSummary(row: IssuedDocumentRow): IssuedDocumentSummary {
  return {
    id: row.id,
    serialNumber: row.serialNumber,
    templateId: row.templateId,
    templateVersion: row.templateVersion,
    subjectKind: row.subjectKind,
    subjectId: row.subjectId,
    issuedOn: row.issuedOn,
    issuedBy: row.issuedBy,
    verificationCode: row.verificationCode,
    storageKey: row.storageKey,
    revokedAt: row.revokedAt,
    revokedReason: row.revokedReason,
    createdAt: row.createdAt,
  };
}

/**
 * Escape a value for HTML text and attribute context.
 *
 * Applied to **every** substituted value with no opt-out, which is what makes a `<script>` tag
 * stored in a student's legal name render as visible text rather than executing in whoever
 * opens the certificate.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─────────────────────────────────────────────────────────────────────────────────────

/** The list projection: everything a caller needs except the document body itself. */
const ISSUED_SUMMARY_COLUMNS = {
  id: issuedDocuments.id,
  serialNumber: issuedDocuments.serialNumber,
  templateId: issuedDocuments.templateId,
  templateVersion: issuedDocuments.templateVersion,
  subjectKind: issuedDocuments.subjectKind,
  subjectId: issuedDocuments.subjectId,
  issuedOn: issuedDocuments.issuedOn,
  issuedBy: issuedDocuments.issuedBy,
  verificationCode: issuedDocuments.verificationCode,
  storageKey: issuedDocuments.storageKey,
  revokedAt: issuedDocuments.revokedAt,
  revokedReason: issuedDocuments.revokedReason,
  createdAt: issuedDocuments.createdAt,
} as const;

const TEMPLATE_SORT_COLUMNS = {
  key: documentTemplates.key,
  name: documentTemplates.name,
  version: documentTemplates.version,
  createdAt: documentTemplates.createdAt,
} as const;

const REQUEST_SORT_COLUMNS = {
  status: documentRequests.status,
  createdAt: documentRequests.createdAt,
} as const;

const ISSUED_SORT_COLUMNS = {
  serialNumber: issuedDocuments.serialNumber,
  issuedOn: issuedDocuments.issuedOn,
  createdAt: issuedDocuments.createdAt,
} as const;

/** Names a template may use, exposed so the editor can offer them rather than guess. */
export const DOCUMENT_VARIABLE_CATALOG: Record<'common' | DocumentSubjectKind, readonly string[]> =
  {
    common: COMMON_VARIABLE_NAMES,
    student: SUBJECT_VARIABLE_NAMES.student,
    employee: SUBJECT_VARIABLE_NAMES.employee,
    guardian: SUBJECT_VARIABLE_NAMES.guardian,
  };
