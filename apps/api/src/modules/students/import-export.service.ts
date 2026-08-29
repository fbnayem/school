/**
 * CSV import and scoped export (Phase 3 completion).
 *
 * Import is a two-step contract:
 *
 *  1. `validate` parses and checks every row — Zod field validation through the *same*
 *     `createStudentSchema` the admission form uses, and duplicate detection through the
 *     *same* `StudentsService.findLikelyDuplicate` — and returns a per-row report without
 *     writing anything.
 *  2. `commit` re-runs that exact validation inside one transaction and then inserts. It
 *     re-runs rather than trusting a client-side "I validated already" flag because the
 *     database changed since step 1, and because a claim in a request body is not evidence.
 *     Any invalid row aborts the whole transaction; nothing half-imports.
 *
 * Export applies the caller's data scope through `StudentsService.queryScoped` — the same
 * filters as the list endpoint, so a teacher exports exactly the students they can list —
 * and every export writes an audit record *before* the data is returned: a bulk export of
 * children's records is a security event, and one that failed to record itself must fail.
 */

import { Injectable } from '@nestjs/common';
import { students, studentStatusHistory } from '@shikkha/db';
import { uuidv7, ValidationError, type FieldIssue } from '@shikkha/shared';
import { can, type Principal } from '@shikkha/permissions';
import {
  createStudentSchema,
  STUDENT_EXPORT_MAX_ROWS,
  STUDENT_IMPORT_COLUMNS,
  STUDENT_IMPORT_MAX_ROWS,
  type ExportStudentsInput,
} from '@shikkha/validation';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { currentContext } from '../../common/context/request-context';
import {
  StudentsService,
  type ListStudentsQuery,
  type StudentRow,
  type Tx,
} from './students.service';

export type ImportRowStatus = 'valid' | 'duplicate' | 'error';

export interface ImportRowReport {
  /** 1-based data row number; the header is row 0. */
  row: number;
  status: ImportRowStatus;
  /** Field-level problems, present when `status` is `error`. */
  issues?: FieldIssue[];
  /** The student this row duplicates, when `status` is `duplicate`. */
  existingStudentId?: string;
  fullNameEn?: string;
}

export interface ImportValidationReport {
  totalRows: number;
  valid: number;
  duplicates: number;
  errors: number;
  rows: ImportRowReport[];
}

export interface ImportCommitSummary extends ImportValidationReport {
  inserted: number;
  insertedStudentIds: string[];
}

interface ValidatedRow {
  report: ImportRowReport;
  /** Parsed, transformed values — only present for `valid` rows. */
  data?: Record<string, unknown>;
}

@Injectable()
export class ImportExportService {
  constructor(
    private readonly db: DatabaseService,
    private readonly students: StudentsService,
    private readonly audit: AuditService,
  ) {}

  /** Step 1: full per-row report, zero writes. */
  async validateImport(
    principal: Principal,
    institutionId: string,
    csv: string,
  ): Promise<ImportValidationReport> {
    return this.db.runInTenant(async (tx) => {
      const rows = await this.validateRows(tx, institutionId, csv);
      return summarize(rows);
    });
  }

  /**
   * Step 2: validate again and apply, in one transaction.
   *
   * A single invalid row aborts everything — the school corrects the file and retries,
   * rather than untangling which half of a register imported. Duplicate rows are skipped
   * (they already exist; re-importing them must be harmless) and reported as such.
   */
  async commitImport(
    principal: Principal,
    institutionId: string,
    csv: string,
  ): Promise<ImportCommitSummary> {
    return this.db.runInTenant(async (tx) => {
      const tenantId = principal.tenantId!;
      const rows = await this.validateRows(tx, institutionId, csv);
      const report = summarize(rows);

      if (report.errors > 0) {
        const issues: FieldIssue[] = [];
        for (const row of rows) {
          if (row.report.status !== 'error') continue;
          for (const issue of row.report.issues ?? []) {
            issues.push({ path: `rows[${row.report.row}].${issue.path}`, message: issue.message });
          }
        }
        throw new ValidationError(
          `The file has ${report.errors} invalid row(s); nothing was imported`,
          issues,
          { report },
        );
      }

      const insertedStudentIds: string[] = [];
      for (const row of rows) {
        if (row.report.status !== 'valid' || !row.data) continue;
        const input = row.data;

        const studentCode =
          (input['studentCode'] as string | undefined) ??
          (await this.students.nextStudentCode(tx, institutionId));
        const admissionNumber =
          (input['admissionNumber'] as string | undefined) ??
          (await this.students.nextAdmissionNumber(tx, institutionId));

        const id = uuidv7();
        const [created] = await tx
          .insert(students)
          .values({
            id,
            tenantId,
            institutionId,
            studentCode,
            admissionNumber,
            admissionDate: input['admissionDate'] as string,
            fullNameEn: input['fullNameEn'] as string,
            fullNameBn: (input['fullNameBn'] as string) ?? null,
            nickname: (input['nickname'] as string) ?? null,
            dateOfBirth: input['dateOfBirth'] as string,
            gender: input['gender'] as StudentRow['gender'],
            bloodGroup: (input['bloodGroup'] as StudentRow['bloodGroup']) ?? null,
            religion: (input['religion'] as StudentRow['religion']) ?? null,
            nationality: (input['nationality'] as string) ?? 'Bangladeshi',
            birthRegistrationNumber: (input['birthRegistrationNumber'] as string) ?? null,
            nationalId: (input['nationalId'] as string) ?? null,
            fatherNameEn: (input['fatherNameEn'] as string) ?? null,
            fatherNameBn: (input['fatherNameBn'] as string) ?? null,
            motherNameEn: (input['motherNameEn'] as string) ?? null,
            motherNameBn: (input['motherNameBn'] as string) ?? null,
            phone: (input['phone'] as string) ?? null,
            email: (input['email'] as string) || null,
            presentAddress: (input['presentAddress'] as string) ?? null,
            permanentAddress: (input['permanentAddress'] as string) ?? null,
            district: (input['district'] as string) ?? null,
            division: (input['division'] as string) ?? null,
            previousInstitutionName: (input['previousInstitutionName'] as string) ?? null,
            previousClassCompleted: (input['previousClassCompleted'] as string) ?? null,
            transferCertificateNumber: (input['transferCertificateNumber'] as string) ?? null,
            status: 'active',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning({ id: students.id, admissionDate: students.admissionDate });

        await tx.insert(studentStatusHistory).values({
          tenantId,
          institutionId,
          studentId: created!.id,
          event: 'admitted',
          fromStatus: null,
          toStatus: 'active',
          effectiveDate: created!.admissionDate,
          reason: 'Imported from CSV',
          createdBy: principal.userId,
        });

        insertedStudentIds.push(created!.id);
      }

      return { ...report, inserted: insertedStudentIds.length, insertedStudentIds };
    });
  }

  /**
   * Export the caller's visible students as CSV or JSON.
   *
   * Medical columns appear only for holders of `students.medical.view`; for everyone else
   * the columns are absent entirely, not blanked — an empty column implies the caller was
   * entitled to it. `queryScoped` also nulls the fields as a second layer.
   */
  async exportStudents(
    principal: Principal,
    query: ExportStudentsInput,
  ): Promise<{ format: 'csv' | 'json'; count: number; content: string; filename: string }> {
    const listQuery: ListStudentsQuery = {
      page: 1,
      pageSize: STUDENT_EXPORT_MAX_ROWS,
      q: query.q,
      academicYearId: query.academicYearId,
      classLevelId: query.classLevelId,
      sectionId: query.sectionId,
      campusId: query.campusId,
      status: query.status,
      gender: query.gender,
      includeArchived: false,
    };

    const rows = await this.students.queryScoped(principal, listQuery, STUDENT_EXPORT_MAX_ROWS);

    const includeMedical = can(principal, 'students.medical.view');
    const columns: Array<keyof StudentRow> = [
      'id',
      'studentCode',
      'admissionNumber',
      'admissionDate',
      'fullNameEn',
      'fullNameBn',
      'dateOfBirth',
      'gender',
      'bloodGroup',
      'religion',
      'nationality',
      'birthRegistrationNumber',
      'fatherNameEn',
      'motherNameEn',
      'phone',
      'email',
      'presentAddress',
      'district',
      'division',
      'status',
    ];
    if (includeMedical) {
      columns.push('medicalConditions', 'allergies', 'specialNeeds', 'emergencyMedicalNote');
    }

    const projected = rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const column of columns) out[column] = row[column];
      return out;
    });

    const content =
      query.format === 'json'
        ? JSON.stringify(projected, null, 2)
        : serializeCsv(
            columns as string[],
            projected.map((row) => (columns as string[]).map((c) => toCell(row[c]))),
          );

    // The audit record is written before the data leaves the building. If it cannot be
    // written, the export fails — for a bulk read of children's records, an untracked
    // success is worse than a failure.
    const ctx = currentContext();
    await this.audit.record({
      tenantId: principal.tenantId,
      institutionId: ctx?.institutionId ?? null,
      actorUserId: principal.userId,
      actorRoles: principal.roles.map((role) => role.roleKey),
      action: 'export',
      module: 'students',
      resourceType: 'student_export',
      resourceLabel: `${rows.length} students as ${query.format}`,
      newValue: {
        count: rows.length,
        format: query.format,
        includeMedical,
        filters: {
          q: query.q ?? null,
          academicYearId: query.academicYearId ?? null,
          classLevelId: query.classLevelId ?? null,
          sectionId: query.sectionId ?? null,
          status: query.status ?? null,
        },
      },
      requestId: ctx?.requestId ?? null,
      ipAddress: ctx?.ipAddress ?? null,
      userAgent: ctx?.userAgent ?? null,
    });

    const stamp = new Date().toISOString().slice(0, 10);
    return {
      format: query.format,
      count: rows.length,
      content,
      filename: `students-${stamp}.${query.format}`,
    };
  }

  // ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Parse and validate every row. Shared verbatim by `validateImport` and `commitImport`,
   * which is what makes "commit applies only after validation" true by construction.
   */
  private async validateRows(tx: Tx, institutionId: string, csv: string): Promise<ValidatedRow[]> {
    const table = parseCsv(csv);
    if (table.length === 0) {
      throw new ValidationError('The CSV file is empty', [
        { path: 'csv', message: 'Provide a header row and at least one data row' },
      ]);
    }

    const header = table[0]!.map((cell) => cell.trim());
    const allowed = new Set<string>(STUDENT_IMPORT_COLUMNS);
    const unknown = header.filter((name) => !allowed.has(name));
    if (unknown.length > 0) {
      throw new ValidationError(`Unknown column(s): ${unknown.join(', ')}`, [
        {
          path: 'csv',
          message: `Allowed columns are: ${STUDENT_IMPORT_COLUMNS.join(', ')}`,
        },
      ]);
    }
    for (const required of ['fullNameEn', 'dateOfBirth', 'gender', 'admissionDate']) {
      if (!header.includes(required)) {
        throw new ValidationError(`The required column "${required}" is missing`, [
          { path: 'csv', message: `Add a "${required}" column` },
        ]);
      }
    }

    const dataRows = table.slice(1);
    if (dataRows.length === 0) {
      throw new ValidationError('The CSV file has no data rows', [
        { path: 'csv', message: 'Provide at least one data row below the header' },
      ]);
    }
    if (dataRows.length > STUDENT_IMPORT_MAX_ROWS) {
      throw new ValidationError(
        `The file has ${dataRows.length} rows; the limit is ${STUDENT_IMPORT_MAX_ROWS}. Split it and import in parts.`,
        [{ path: 'csv', message: `At most ${STUDENT_IMPORT_MAX_ROWS} rows per import` }],
      );
    }

    // In-file duplicate keys, so the same child twice in one file is caught before either
    // row reaches the database duplicate check.
    const seenBrns = new Map<string, number>();
    const seenNameDob = new Map<string, number>();

    const results: ValidatedRow[] = [];

    for (let i = 0; i < dataRows.length; i += 1) {
      const rowNumber = i + 1;
      const cells = dataRows[i]!;

      if (cells.length > header.length) {
        results.push({
          report: {
            row: rowNumber,
            status: 'error',
            issues: [{ path: 'csv', message: 'The row has more cells than the header' }],
          },
        });
        continue;
      }

      const record: Record<string, string> = {};
      for (let c = 0; c < header.length; c += 1) {
        const value = (cells[c] ?? '').trim();
        if (value !== '') record[header[c]!] = value;
      }

      const parsed = createStudentSchema.safeParse(record);
      if (!parsed.success) {
        results.push({
          report: {
            row: rowNumber,
            status: 'error',
            fullNameEn: record['fullNameEn'],
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          },
        });
        continue;
      }

      const data = parsed.data as Record<string, unknown>;
      const fullNameEn = data['fullNameEn'] as string;
      const dateOfBirth = data['dateOfBirth'] as string;
      const brn = data['birthRegistrationNumber'] as string | undefined;

      // Duplicate inside the same file?
      const nameKey = `${fullNameEn.toLowerCase()}|${dateOfBirth}`;
      const dupOfRow = (brn ? seenBrns.get(brn) : undefined) ?? seenNameDob.get(nameKey);
      if (dupOfRow !== undefined) {
        results.push({
          report: {
            row: rowNumber,
            status: 'duplicate',
            fullNameEn,
            issues: [{ path: 'fullNameEn', message: `Duplicates row ${dupOfRow} of this file` }],
          },
        });
        continue;
      }

      // Duplicate of an existing student? The same logic single admission uses, verbatim.
      const existing = await this.students.findLikelyDuplicate(tx, institutionId, {
        fullNameEn,
        dateOfBirth,
        birthRegistrationNumber: brn,
      });
      if (existing) {
        results.push({
          report: {
            row: rowNumber,
            status: 'duplicate',
            fullNameEn,
            existingStudentId: existing.id,
          },
        });
        continue;
      }

      if (brn) seenBrns.set(brn, rowNumber);
      seenNameDob.set(nameKey, rowNumber);
      results.push({ report: { row: rowNumber, status: 'valid', fullNameEn }, data });
    }

    return results;
  }
}

function summarize(rows: ValidatedRow[]): ImportValidationReport {
  const reports = rows.map((row) => row.report);
  return {
    totalRows: reports.length,
    valid: reports.filter((r) => r.status === 'valid').length,
    duplicates: reports.filter((r) => r.status === 'duplicate').length,
    errors: reports.filter((r) => r.status === 'error').length,
    rows: reports,
  };
}

// ── CSV mechanics ─────────────────────────────────────────────────────────────────────
// RFC 4180 subset: comma-separated, double-quote quoting, `""` escapes a quote, quoted
// fields may contain commas and newlines, CRLF and LF both accepted. Hand-rolled because
// the repo carries no CSV dependency and the grammar is 30 lines.

export function parseCsv(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip BOM
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let sawAny = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      sawAny = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
      sawAny = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i += 1;
      if (sawAny || cell !== '') {
        row.push(cell);
        rows.push(row);
      }
      row = [];
      cell = '';
      sawAny = false;
    } else {
      cell += ch;
      sawAny = true;
    }
  }
  if (sawAny || cell !== '') {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function serializeCsv(header: string[], rows: string[][]): string {
  const escape = (value: string): string =>
    /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  const lines = [header.map(escape).join(',')];
  for (const row of rows) lines.push(row.map(escape).join(','));
  return lines.join('\r\n') + '\r\n';
}

function toCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
