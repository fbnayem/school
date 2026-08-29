/**
 * Human resources service (Phase 15).
 *
 * The rules this file exists to hold, in one place:
 *
 *  1. **Every tenant query runs inside `runInTenant`**, and every read is additionally
 *     narrowed to the institution named by the `x-institution-id` header. A record in
 *     another institution — or another tenant — is a `NotFoundError`, never a 403:
 *     confirming that it exists is itself a leak.
 *  2. **Salary data is money.** Every figure is `numeric(14, 2)` in the database, a decimal
 *     string on the wire, and a `Money` in between. Percentage components store the
 *     percentage in the same two-decimal shape, whose minor units *are* basis points, fed
 *     straight to `Money.percentage` — there is no floating-point multiplication anywhere in
 *     the payslip arithmetic. `computeSalaryBreakdown` below is the single implementation
 *     Phase 16 payroll will reuse.
 *  3. **Salary data is sensitive.** Reading any employee's salary requires
 *     `payroll.payslips.view.all`; an employee with only `payroll.payslips.view.own` can
 *     read exactly their own. The employee directory redacts bank details and the national
 *     id for callers without the payroll-wide permission, the same way the student service
 *     redacts medical data — one query path, redaction on the way out.
 *  4. **Nothing is deleted.** Separation is a status change with an effective date, a
 *     mandatory reason and a row in `employee_status_history`; removal from a salary
 *     structure closes the assignment's effective range; removing a component archives it.
 *  5. **Contracts cannot overlap.** The database restates the date-ordering invariants as
 *     check constraints; the no-overlapping-active-contracts rule is enforced here inside
 *     the same transaction as the write (an EXCLUDE constraint would need `btree_gist`,
 *     which this deployment does not assume).
 */

import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  ilike,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  campuses,
  departments,
  designations,
  employees,
  employeeDependents,
  employeeDocuments,
  employeeExperience,
  employeeQualifications,
  employeeSalaryAssignments,
  employeeStatusHistory,
  employeeTransfers,
  employmentContracts,
  files,
  salaryComponents,
  salaryStructures,
  type Transaction,
} from '@shikkha/db';
import {
  addDays,
  ALLOWED_DOCUMENT_MIME_TYPES,
  ALLOWED_IMAGE_MIME_TYPES,
  buildOffsetPage,
  ConflictError,
  ForbiddenError,
  MAX_UPLOAD_BYTES,
  Money,
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
import { can, type Principal } from '@shikkha/permissions';
import {
  DEPARTMENT_SORT_FIELDS,
  DESIGNATION_SORT_FIELDS,
  EMPLOYEE_SEPARATION_STATUSES,
  EMPLOYEE_SORT_FIELDS,
  EMPLOYMENT_CONTRACT_SORT_FIELDS,
  SALARY_STRUCTURE_SORT_FIELDS,
  type AssignSalaryInput,
  type ChangeEmployeeStatusInput,
  type CreateEmployeeDependentInput,
  type CreateEmployeeExperienceInput,
  type CreateEmployeeInput,
  type CreateEmployeeQualificationInput,
  type CreateEmploymentContractInput,
  type CreateSalaryStructureInput,
  type HeadcountReportQuery,
  type ReplaceSalaryComponentsInput,
  type TransferEmployeeInput,
  type UploadEmployeeDocumentInput,
} from '@shikkha/validation';
import { DatabaseService } from '../database/database.service';
import { StorageService } from '../storage/storage.service';

type EmployeeRow = typeof employees.$inferSelect;
type DepartmentRow = typeof departments.$inferSelect;
type DesignationRow = typeof designations.$inferSelect;
type ContractRow = typeof employmentContracts.$inferSelect;
type SalaryStructureRow = typeof salaryStructures.$inferSelect;
type SalaryComponentRow = typeof salaryComponents.$inferSelect;
type SalaryAssignmentRow = typeof employeeSalaryAssignments.$inferSelect;
type EmployeeDocumentRow = typeof employeeDocuments.$inferSelect;
type QualificationRow = typeof employeeQualifications.$inferSelect;
type ExperienceRow = typeof employeeExperience.$inferSelect;
type DependentRow = typeof employeeDependents.$inferSelect;

/** A department row plus the hierarchy column added by migration 0013 (see phase report). */
type DepartmentWithParent = DepartmentRow & { parentDepartmentId: string | null };

/** The subset of a multipart file this service needs; `@types/multer` is not installed. */
export interface UploadedFileLike {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

const SEPARATION_STATUSES: readonly string[] = EMPLOYEE_SEPARATION_STATUSES;

// ─────────────────────────────────────────────────────────────────────────────────────
// Salary arithmetic — pure, exported, and the single implementation Phase 16 reuses.
// ─────────────────────────────────────────────────────────────────────────────────────

export interface SalaryComponentLike {
  id: string | null;
  nameEn: string;
  type: 'earning' | 'deduction';
  calculation: 'fixed' | 'percentage_of_basic' | 'percentage_of_gross';
  /** Taka for `fixed`; a percentage with two decimals otherwise. */
  amount: string;
  sequence: number;
}

export interface SalaryBreakdownLine {
  componentId: string | null;
  nameEn: string;
  type: 'earning' | 'deduction';
  calculation: 'fixed' | 'percentage_of_basic' | 'percentage_of_gross';
  /** The percentage applied, as a decimal string, when the line is percentage-based. */
  rate: string | null;
  /** The computed taka, exact to the poisa. */
  amount: string;
}

export interface SalaryBreakdown {
  basic: string;
  gross: string;
  totalDeductions: string;
  net: string;
  lines: SalaryBreakdownLine[];
}

/**
 * Compute a monthly breakdown from a basic and a component list.
 *
 * Components are evaluated in `sequence` order **within two passes**: every earning first,
 * then every deduction. That two-pass shape is what makes `percentage_of_gross` well-defined
 * — gross is basic plus all earnings, fully known before any gross-relative deduction is
 * computed, so the answer cannot depend on how the components happen to be interleaved.
 * (`percentage_of_gross` earnings are impossible by database check.)
 *
 * All arithmetic is `Money`: percentages go through `Money.percentage(basisPoints)` — the
 * stored two-decimal percentage's minor units *are* basis points — and never through
 * JavaScript multiplication.
 */
export function computeSalaryBreakdown(
  basicValue: string,
  components: readonly SalaryComponentLike[],
): SalaryBreakdown {
  const basic = Money.fromDecimalString(basicValue);
  const ordered = [...components].sort(
    (a, b) => a.sequence - b.sequence || a.nameEn.localeCompare(b.nameEn),
  );

  const lines: SalaryBreakdownLine[] = [
    {
      componentId: null,
      nameEn: 'Basic',
      type: 'earning',
      calculation: 'fixed',
      rate: null,
      amount: basic.toDecimalString(),
    },
  ];

  let gross = basic;
  for (const component of ordered) {
    if (component.type !== 'earning') continue;
    const amount =
      component.calculation === 'fixed'
        ? Money.fromDecimalString(component.amount)
        : basic.percentage(Money.fromDecimalString(component.amount).minor);
    gross = gross.plus(amount);
    lines.push({
      componentId: component.id,
      nameEn: component.nameEn,
      type: 'earning',
      calculation: component.calculation,
      rate: component.calculation === 'fixed' ? null : component.amount,
      amount: amount.toDecimalString(),
    });
  }

  let totalDeductions = Money.zero();
  for (const component of ordered) {
    if (component.type !== 'deduction') continue;
    const amount =
      component.calculation === 'fixed'
        ? Money.fromDecimalString(component.amount)
        : component.calculation === 'percentage_of_basic'
          ? basic.percentage(Money.fromDecimalString(component.amount).minor)
          : gross.percentage(Money.fromDecimalString(component.amount).minor);
    totalDeductions = totalDeductions.plus(amount);
    lines.push({
      componentId: component.id,
      nameEn: component.nameEn,
      type: 'deduction',
      calculation: component.calculation,
      rate: component.calculation === 'fixed' ? null : component.amount,
      amount: amount.toDecimalString(),
    });
  }

  const net = gross.minus(totalDeductions);
  return {
    basic: basic.toDecimalString(),
    gross: gross.toDecimalString(),
    totalDeductions: totalDeductions.toDecimalString(),
    net: net.toDecimalString(),
    lines,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────

@Injectable()
export class HrService {
  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
  ) {}

  // ── Departments ────────────────────────────────────────────────────────────────────

  /**
   * `parent_department_id` was added to the Phase 2 table by migration 0013 and is not yet
   * in the Drizzle table definition (that file is owned by another phase), so it is read and
   * written through explicit SQL fragments. The fragments live only in this section.
   */
  private departmentSelection() {
    return {
      ...getTableColumns(departments),
      parentDepartmentId: sql<string | null>`${departments}.parent_department_id`,
    };
  }

  async listDepartments(
    principal: Principal,
    institutionId: string,
    query: { sort?: string; q?: string; includeArchived: boolean },
    page: OffsetPageRequest,
  ): Promise<OffsetPage<DepartmentWithParent>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(departments.institutionId, institutionId)];
      if (!query.includeArchived) filters.push(isNull(departments.archivedAt));
      if (query.q) {
        filters.push(
          or(ilike(departments.nameEn, `%${query.q}%`), ilike(departments.code, `${query.q}%`))!,
        );
      }
      const where = and(...filters);

      const orderBy = parseSort(query.sort, DEPARTMENT_SORT_FIELDS, {
        field: 'nameEn',
        direction: 'asc',
      }).map((spec) => {
        const column = {
          code: departments.code,
          nameEn: departments.nameEn,
          createdAt: departments.createdAt,
        }[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select(this.departmentSelection())
        .from(departments)
        .where(where)
        .orderBy(...orderBy, asc(departments.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));
      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(departments)
        .where(where);
      return buildOffsetPage(rows as DepartmentWithParent[], counted?.total ?? 0, page);
    });
  }

  async createDepartment(
    principal: Principal,
    institutionId: string,
    input: {
      code: string;
      nameEn: string;
      nameBn?: string;
      headEmployeeId?: string | null;
      parentDepartmentId?: string | null;
    },
  ): Promise<DepartmentWithParent> {
    return this.db.runInTenant(async (tx) => {
      await this.assertDepartmentCodeFree(tx, institutionId, input.code);
      if (input.headEmployeeId) {
        await this.requireEmployee(tx, institutionId, input.headEmployeeId);
      }
      if (input.parentDepartmentId) {
        await this.requireDepartment(tx, institutionId, input.parentDepartmentId);
      }

      const id = uuidv7();
      await tx.insert(departments).values({
        id,
        tenantId: principal.tenantId!,
        institutionId,
        code: input.code,
        nameEn: input.nameEn,
        nameBn: input.nameBn ?? null,
        headEmployeeId: input.headEmployeeId ?? null,
        createdBy: principal.userId,
        updatedBy: principal.userId,
      });
      if (input.parentDepartmentId) {
        await tx.execute(
          sql`update departments set parent_department_id = ${input.parentDepartmentId}::uuid where id = ${id}::uuid`,
        );
      }
      const [created] = await tx
        .select(this.departmentSelection())
        .from(departments)
        .where(eq(departments.id, id))
        .limit(1);
      return created as DepartmentWithParent;
    });
  }

  async updateDepartment(
    principal: Principal,
    institutionId: string,
    id: string,
    input: {
      code?: string;
      nameEn?: string;
      nameBn?: string | null;
      headEmployeeId?: string | null;
      parentDepartmentId?: string | null;
    },
  ): Promise<DepartmentWithParent> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.requireDepartment(tx, institutionId, id);
      if (input.code && input.code !== existing.code) {
        await this.assertDepartmentCodeFree(tx, institutionId, input.code);
      }
      if (input.headEmployeeId) {
        await this.requireEmployee(tx, institutionId, input.headEmployeeId);
      }
      if (input.parentDepartmentId !== undefined && input.parentDepartmentId !== null) {
        if (input.parentDepartmentId === id) {
          throw new ValidationError('A department cannot be its own parent', [
            { path: 'parentDepartmentId', message: 'Choose a different department' },
          ]);
        }
        await this.requireDepartment(tx, institutionId, input.parentDepartmentId);
        // Walk the proposed parent's ancestry; finding ourselves there means a cycle.
        const cycle = await tx.execute(sql`
          with recursive chain as (
            select id, parent_department_id from departments where id = ${input.parentDepartmentId}::uuid
            union all
            select d.id, d.parent_department_id
            from departments d
            join chain c on d.id = c.parent_department_id
          )
          select 1 as hit from chain where id = ${id}::uuid limit 1
        `);
        if (((cycle as unknown as { rows: unknown[] }).rows ?? []).length > 0) {
          throw new ValidationError('That parent would create a cycle in the hierarchy', [
            { path: 'parentDepartmentId', message: 'Choose a department outside this subtree' },
          ]);
        }
      }

      const { parentDepartmentId, ...columnChanges } = input;
      if (Object.keys(columnChanges).length > 0) {
        await tx
          .update(departments)
          .set({ ...columnChanges, updatedBy: principal.userId })
          .where(eq(departments.id, id));
      }
      if (parentDepartmentId !== undefined) {
        await tx.execute(
          sql`update departments set parent_department_id = ${parentDepartmentId}::uuid where id = ${id}::uuid`,
        );
      }
      const [updated] = await tx
        .select(this.departmentSelection())
        .from(departments)
        .where(eq(departments.id, id))
        .limit(1);
      return updated as DepartmentWithParent;
    });
  }

  async archiveDepartment(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<DepartmentRow> {
    return this.db.runInTenant(async (tx) => {
      await this.requireDepartment(tx, institutionId, id);
      const [archived] = await tx
        .update(departments)
        .set({
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
        })
        .where(eq(departments.id, id))
        .returning();
      return archived!;
    });
  }

  // ── Designations ───────────────────────────────────────────────────────────────────

  async listDesignations(
    principal: Principal,
    institutionId: string,
    query: { sort?: string; q?: string; includeArchived: boolean },
    page: OffsetPageRequest,
  ): Promise<OffsetPage<DesignationRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(designations.institutionId, institutionId)];
      if (!query.includeArchived) filters.push(isNull(designations.archivedAt));
      if (query.q) {
        filters.push(
          or(ilike(designations.nameEn, `%${query.q}%`), ilike(designations.code, `${query.q}%`))!,
        );
      }
      const where = and(...filters);
      const orderBy = parseSort(query.sort, DESIGNATION_SORT_FIELDS, {
        field: 'rank',
        direction: 'asc',
      }).map((spec) => {
        const column = {
          code: designations.code,
          nameEn: designations.nameEn,
          rank: designations.rank,
          createdAt: designations.createdAt,
        }[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(designations)
        .where(where)
        .orderBy(...orderBy, asc(designations.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));
      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(designations)
        .where(where);
      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async createDesignation(
    principal: Principal,
    institutionId: string,
    input: { code: string; nameEn: string; nameBn?: string; rank: number; isTeaching: boolean },
  ): Promise<DesignationRow> {
    return this.db.runInTenant(async (tx) => {
      const [duplicate] = await tx
        .select({ id: designations.id })
        .from(designations)
        .where(
          and(
            eq(designations.institutionId, institutionId),
            eq(designations.code, input.code),
            isNull(designations.archivedAt),
          ),
        )
        .limit(1);
      if (duplicate) {
        throw new ConflictError(`A designation with code ${input.code} already exists`);
      }
      const [created] = await tx
        .insert(designations)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          code: input.code,
          nameEn: input.nameEn,
          nameBn: input.nameBn ?? null,
          rank: input.rank,
          isTeaching: input.isTeaching,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  async updateDesignation(
    principal: Principal,
    institutionId: string,
    id: string,
    input: {
      code?: string;
      nameEn?: string;
      nameBn?: string | null;
      rank?: number;
      isTeaching?: boolean;
    },
  ): Promise<DesignationRow> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(designations)
        .where(
          and(
            eq(designations.id, id),
            eq(designations.institutionId, institutionId),
            isNull(designations.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Designation', id);

      const [updated] = await tx
        .update(designations)
        .set({ ...input, updatedBy: principal.userId })
        .where(eq(designations.id, id))
        .returning();
      return updated!;
    });
  }

  async archiveDesignation(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<DesignationRow> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select({ id: designations.id })
        .from(designations)
        .where(
          and(
            eq(designations.id, id),
            eq(designations.institutionId, institutionId),
            isNull(designations.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Designation', id);
      const [archived] = await tx
        .update(designations)
        .set({
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
        })
        .where(eq(designations.id, id))
        .returning();
      return archived!;
    });
  }

  // ── Employee directory and profile ─────────────────────────────────────────────────

  async listEmployees(
    principal: Principal,
    institutionId: string,
    query: {
      sort?: string;
      q?: string;
      campusId?: string;
      departmentId?: string;
      designationId?: string;
      employmentStatus?: string;
      employmentType?: string;
      includeArchived: boolean;
    },
    page: OffsetPageRequest,
  ): Promise<OffsetPage<EmployeeRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(employees.institutionId, institutionId)];
      if (!query.includeArchived) {
        filters.push(isNull(employees.archivedAt));
      } else if (!can(principal, 'hr.employees.archive')) {
        // Asking for archived employees is itself a privileged read: an archived record is
        // usually a separation whose circumstances the school does not broadcast.
        throw new ForbiddenError('hr.employees.archive', 'You cannot view archived employees');
      }
      if (query.campusId) filters.push(eq(employees.campusId, query.campusId));
      if (query.departmentId) filters.push(eq(employees.departmentId, query.departmentId));
      if (query.designationId) filters.push(eq(employees.designationId, query.designationId));
      if (query.employmentStatus) {
        filters.push(
          eq(employees.employmentStatus, query.employmentStatus as EmployeeRow['employmentStatus']),
        );
      }
      if (query.employmentType) filters.push(eq(employees.employmentType, query.employmentType));
      if (query.q) {
        const term = query.q.trim();
        filters.push(
          or(
            ilike(employees.fullNameEn, `%${term}%`),
            ilike(employees.employeeCode, `${term}%`),
            ilike(employees.phone, `${term}%`),
          )!,
        );
      }
      const where = and(...filters);

      const orderBy = parseSort(query.sort, EMPLOYEE_SORT_FIELDS, {
        field: 'fullNameEn',
        direction: 'asc',
      }).map((spec) => {
        const column = EMPLOYEE_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(employees)
        .where(where)
        .orderBy(...orderBy, asc(employees.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));
      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(employees)
        .where(where);

      return buildOffsetPage(
        rows.map((row) => this.redactSensitive(principal, row)),
        counted?.total ?? 0,
        page,
      );
    });
  }

  async getEmployee(principal: Principal, institutionId: string, id: string): Promise<EmployeeRow> {
    const row = await this.db.runInTenant(async (tx) => {
      const [found] = await tx
        .select()
        .from(employees)
        .where(and(eq(employees.id, id), eq(employees.institutionId, institutionId)))
        .limit(1);
      return found ?? null;
    });
    if (!row || (row.archivedAt && !can(principal, 'hr.employees.archive'))) {
      throw new NotFoundError('Employee', id);
    }
    return this.redactSensitive(principal, row);
  }

  /** The caller's own record, with the profile side-tables. Never redacted — it is theirs. */
  async getOwnProfile(principal: Principal): Promise<{
    employee: EmployeeRow;
    qualifications: QualificationRow[];
    experience: ExperienceRow[];
    dependents: DependentRow[];
    documents: EmployeeDocumentRow[];
  }> {
    const employeeId = principal.employeeId;
    if (!employeeId) throw new NotFoundError('Employee profile');

    return this.db.runInTenant(async (tx) => {
      const [employee] = await tx
        .select()
        .from(employees)
        .where(and(eq(employees.id, employeeId), isNull(employees.archivedAt)))
        .limit(1);
      if (!employee) throw new NotFoundError('Employee profile');

      const qualifications = await tx
        .select()
        .from(employeeQualifications)
        .where(
          and(
            eq(employeeQualifications.employeeId, employeeId),
            isNull(employeeQualifications.archivedAt),
          ),
        )
        .orderBy(desc(employeeQualifications.yearCompleted), asc(employeeQualifications.id));
      const experience = await tx
        .select()
        .from(employeeExperience)
        .where(
          and(eq(employeeExperience.employeeId, employeeId), isNull(employeeExperience.archivedAt)),
        )
        .orderBy(desc(employeeExperience.fromDate), asc(employeeExperience.id));
      const dependents = await tx
        .select()
        .from(employeeDependents)
        .where(
          and(eq(employeeDependents.employeeId, employeeId), isNull(employeeDependents.archivedAt)),
        )
        .orderBy(asc(employeeDependents.nameEn), asc(employeeDependents.id));
      const documents = await tx
        .select()
        .from(employeeDocuments)
        .where(
          and(eq(employeeDocuments.employeeId, employeeId), isNull(employeeDocuments.archivedAt)),
        )
        .orderBy(desc(employeeDocuments.createdAt), asc(employeeDocuments.id));

      return { employee, qualifications, experience, dependents, documents };
    });
  }

  async createEmployee(
    principal: Principal,
    institutionId: string,
    input: CreateEmployeeInput,
  ): Promise<EmployeeRow> {
    return this.db.runInTenant(async (tx) => {
      const tenantId = principal.tenantId!;

      if (input.campusId) await this.requireCampus(tx, institutionId, input.campusId);
      if (input.departmentId) await this.requireDepartment(tx, institutionId, input.departmentId);
      if (input.designationId) {
        await this.requireDesignation(tx, institutionId, input.designationId);
      }

      if (input.nationalId) {
        const [duplicate] = await tx
          .select({ id: employees.id, employeeCode: employees.employeeCode })
          .from(employees)
          .where(
            and(
              eq(employees.institutionId, institutionId),
              eq(employees.nationalId, input.nationalId),
              isNull(employees.archivedAt),
            ),
          )
          .limit(1);
        if (duplicate) {
          throw new ConflictError(
            `An employee with this national id already exists (${duplicate.employeeCode})`,
            { existingEmployeeId: duplicate.id },
          );
        }
      }

      const employeeCode = input.employeeCode ?? (await this.nextEmployeeCode(tx, institutionId));
      const id = uuidv7();
      const [created] = await tx
        .insert(employees)
        .values({
          id,
          tenantId,
          institutionId,
          campusId: input.campusId ?? null,
          employeeCode,
          fullNameEn: input.fullNameEn,
          fullNameBn: input.fullNameBn ?? null,
          fatherNameEn: input.fatherNameEn ?? null,
          motherNameEn: input.motherNameEn ?? null,
          dateOfBirth: input.dateOfBirth ?? null,
          gender: input.gender ?? null,
          bloodGroup: input.bloodGroup ?? null,
          religion: input.religion ?? null,
          maritalStatus: input.maritalStatus ?? null,
          nationalId: input.nationalId ?? null,
          email: input.email || null,
          phone: input.phone,
          alternatePhone: input.alternatePhone ?? null,
          presentAddress: input.presentAddress ?? null,
          permanentAddress: input.permanentAddress ?? null,
          emergencyContactName: input.emergencyContactName ?? null,
          emergencyContactPhone: input.emergencyContactPhone ?? null,
          departmentId: input.departmentId ?? null,
          designationId: input.designationId ?? null,
          employmentType: input.employmentType,
          employmentStatus: 'active',
          joiningDate: input.joiningDate,
          confirmationDate: input.confirmationDate ?? null,
          qualificationSummary: input.qualificationSummary ?? null,
          specialization: input.specialization ?? null,
          bankName: input.bankName ?? null,
          bankAccountNumber: input.bankAccountNumber ?? null,
          bankBranch: input.bankBranch ?? null,
          mobileBankingProvider: input.mobileBankingProvider ?? null,
          mobileBankingNumber: input.mobileBankingNumber ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      if (!created) throw new ConflictError('The employee could not be created');

      // Domain history: hiring is the first status event, and a service certificate is
      // printed from this table rather than from the audit log.
      await tx.insert(employeeStatusHistory).values({
        tenantId,
        institutionId,
        employeeId: created.id,
        fromStatus: null,
        toStatus: 'active',
        effectiveDate: created.joiningDate,
        reason: 'Hired',
        createdBy: principal.userId,
      });

      return created;
    });
  }

  async updateEmployee(
    principal: Principal,
    institutionId: string,
    id: string,
    input: Record<string, unknown>,
  ): Promise<{ employee: EmployeeRow; previous: Partial<EmployeeRow> }> {
    const version = input['version'] as number;
    const { version: _ignored, ...changes } = input;

    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(employees)
        .where(
          and(
            eq(employees.id, id),
            eq(employees.institutionId, institutionId),
            isNull(employees.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Employee', id);

      if (changes['departmentId']) {
        await this.requireDepartment(tx, institutionId, changes['departmentId'] as string);
      }
      if (changes['designationId']) {
        await this.requireDesignation(tx, institutionId, changes['designationId'] as string);
      }

      const [updated] = await tx
        .update(employees)
        .set({
          ...(changes as Partial<EmployeeRow>),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(employees.id, id), eq(employees.version, version)))
        .returning();
      if (!updated) {
        throw new ConflictError(
          'This employee was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      const previous: Partial<EmployeeRow> = {};
      for (const key of Object.keys(changes)) {
        const typedKey = key as keyof EmployeeRow;
        if (existing[typedKey] !== updated[typedKey]) {
          (previous as Record<string, unknown>)[key] = existing[typedKey];
        }
      }
      return { employee: updated, previous };
    });
  }

  /** The self-service update: contact fields only, on the caller's own record. */
  async updateOwnProfile(
    principal: Principal,
    input: Record<string, unknown>,
  ): Promise<{ employee: EmployeeRow; previous: Partial<EmployeeRow> }> {
    const employeeId = principal.employeeId;
    if (!employeeId) throw new NotFoundError('Employee profile');
    const version = input['version'] as number;
    const { version: _ignored, ...changes } = input;

    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(employees)
        .where(and(eq(employees.id, employeeId), isNull(employees.archivedAt)))
        .limit(1);
      if (!existing) throw new NotFoundError('Employee profile');

      const [updated] = await tx
        .update(employees)
        .set({
          ...(changes as Partial<EmployeeRow>),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(employees.id, employeeId), eq(employees.version, version)))
        .returning();
      if (!updated) {
        throw new ConflictError(
          'Your profile was changed elsewhere while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      const previous: Partial<EmployeeRow> = {};
      for (const key of Object.keys(changes)) {
        const typedKey = key as keyof EmployeeRow;
        if (existing[typedKey] !== updated[typedKey]) {
          (previous as Record<string, unknown>)[key] = existing[typedKey];
        }
      }
      return { employee: updated, previous };
    });
  }

  /**
   * Status change, separation included.
   *
   * Separation (`resigned` / `terminated` / `retired`) is *not* a delete: the row survives,
   * the change lands in `employee_status_history` with the mandatory reason, and every live
   * contract is closed as of the effective date. Reaching a separation status requires
   * `hr.exit.manage`; any other transition requires `hr.employees.update` — the route
   * declares both in `any` mode and the split is re-checked here, server-side.
   */
  async changeStatus(
    principal: Principal,
    institutionId: string,
    id: string,
    input: ChangeEmployeeStatusInput,
  ): Promise<{ employee: EmployeeRow; previous: { employmentStatus: string } }> {
    const isSeparation = SEPARATION_STATUSES.includes(input.status);
    if (isSeparation && !can(principal, 'hr.exit.manage')) {
      throw new ForbiddenError('hr.exit.manage', 'Separating an employee requires exit authority');
    }
    if (!isSeparation && !can(principal, 'hr.employees.update')) {
      throw new ForbiddenError('hr.employees.update', 'You cannot change employee status');
    }

    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(employees)
        .where(
          and(
            eq(employees.id, id),
            eq(employees.institutionId, institutionId),
            isNull(employees.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Employee', id);

      if (existing.employmentStatus === input.status) {
        throw new ConflictError(`The employee is already ${input.status}`);
      }
      if (SEPARATION_STATUSES.includes(existing.employmentStatus)) {
        // A separated employee's record is closed. Rehiring is a new employment, not a
        // status edit that would silently rewrite the old separation.
        throw new WorkflowStateError(existing.employmentStatus, input.status, 'employee');
      }

      const separationColumns = isSeparation
        ? {
            lastWorkingDate: input.effectiveDate,
            ...(input.status === 'resigned' ? { resignationDate: input.effectiveDate } : {}),
          }
        : {};

      const [updated] = await tx
        .update(employees)
        .set({
          employmentStatus: input.status as EmployeeRow['employmentStatus'],
          ...separationColumns,
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(employees.id, id))
        .returning();

      await tx.insert(employeeStatusHistory).values({
        tenantId: principal.tenantId!,
        institutionId,
        employeeId: id,
        fromStatus: existing.employmentStatus,
        toStatus: input.status as EmployeeRow['employmentStatus'],
        effectiveDate: input.effectiveDate,
        reason: input.reason,
        createdBy: principal.userId,
      });

      if (isSeparation) {
        // Close every live contract. A contract that had not yet started is terminated
        // without an end date (the strict end-after-start check must hold); one already
        // running ends on the separation date.
        const liveContracts = await tx
          .select()
          .from(employmentContracts)
          .where(
            and(
              eq(employmentContracts.employeeId, id),
              eq(employmentContracts.status, 'active'),
              isNull(employmentContracts.archivedAt),
            ),
          );
        for (const contract of liveContracts) {
          const started = contract.startDate < input.effectiveDate;
          await tx
            .update(employmentContracts)
            .set({
              status: started ? 'ended' : 'terminated',
              ...(started ? { endDate: input.effectiveDate } : {}),
              version: contract.version + 1,
              updatedBy: principal.userId,
            })
            .where(eq(employmentContracts.id, contract.id));
        }
      }

      return { employee: updated!, previous: { employmentStatus: existing.employmentStatus } };
    });
  }

  /**
   * Campus transfer. Both campuses must belong to the employee's institution — which is the
   * institution named by the caller's `x-institution-id` header, so a campus of another
   * institution (or tenant) resolves to `NotFoundError`, never to a cross-boundary write.
   */
  async transfer(
    principal: Principal,
    institutionId: string,
    id: string,
    input: TransferEmployeeInput,
  ): Promise<{ employee: EmployeeRow; transferId: string }> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(employees)
        .where(
          and(
            eq(employees.id, id),
            eq(employees.institutionId, institutionId),
            isNull(employees.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Employee', id);
      if (SEPARATION_STATUSES.includes(existing.employmentStatus)) {
        throw new WorkflowStateError(existing.employmentStatus, 'transferred', 'employee');
      }

      await this.requireCampus(tx, institutionId, input.toCampusId);
      if (existing.campusId === input.toCampusId) {
        throw new ConflictError('The employee is already posted to that campus');
      }
      if (input.toDesignationId) {
        await this.requireDesignation(tx, institutionId, input.toDesignationId);
      }

      const transferId = uuidv7();
      await tx.insert(employeeTransfers).values({
        id: transferId,
        tenantId: principal.tenantId!,
        institutionId,
        employeeId: id,
        fromCampusId: existing.campusId,
        toCampusId: input.toCampusId,
        fromDesignationId: existing.designationId,
        toDesignationId: input.toDesignationId ?? existing.designationId,
        effectiveDate: input.effectiveDate,
        reason: input.reason,
        approvedBy: principal.userId,
        createdBy: principal.userId,
      });

      const [updated] = await tx
        .update(employees)
        .set({
          campusId: input.toCampusId,
          ...(input.toDesignationId ? { designationId: input.toDesignationId } : {}),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(employees.id, id))
        .returning();

      return { employee: updated!, transferId };
    });
  }

  async archiveEmployee(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<EmployeeRow> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(employees)
        .where(
          and(
            eq(employees.id, id),
            eq(employees.institutionId, institutionId),
            isNull(employees.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Employee', id);

      // Archiving hides the record from day-to-day lists; it must not be the way an
      // employment quietly ends. Separate first — that is the audited lifecycle event.
      if (!SEPARATION_STATUSES.includes(existing.employmentStatus)) {
        throw new ConflictError(
          'This employee has not been separated. Record the resignation, termination or retirement first, then archive.',
        );
      }

      const [archived] = await tx
        .update(employees)
        .set({
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(employees.id, id))
        .returning();
      return archived!;
    });
  }

  // ── Contracts ──────────────────────────────────────────────────────────────────────

  async listContracts(
    principal: Principal,
    institutionId: string,
    query: { sort?: string; employeeId?: string; status?: string; includeArchived: boolean },
    page: OffsetPageRequest,
  ): Promise<OffsetPage<ContractRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(employmentContracts.institutionId, institutionId)];
      if (!query.includeArchived) filters.push(isNull(employmentContracts.archivedAt));
      if (query.employeeId) filters.push(eq(employmentContracts.employeeId, query.employeeId));
      if (query.status) {
        filters.push(eq(employmentContracts.status, query.status as ContractRow['status']));
      }
      const where = and(...filters);
      const orderBy = parseSort(query.sort, EMPLOYMENT_CONTRACT_SORT_FIELDS, {
        field: 'startDate',
        direction: 'desc',
      }).map((spec) => {
        const column = {
          startDate: employmentContracts.startDate,
          endDate: employmentContracts.endDate,
          createdAt: employmentContracts.createdAt,
        }[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(employmentContracts)
        .where(where)
        .orderBy(...orderBy, asc(employmentContracts.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));
      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(employmentContracts)
        .where(where);
      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async getContract(principal: Principal, institutionId: string, id: string): Promise<ContractRow> {
    const row = await this.db.runInTenant(async (tx) => {
      const [found] = await tx
        .select()
        .from(employmentContracts)
        .where(
          and(eq(employmentContracts.id, id), eq(employmentContracts.institutionId, institutionId)),
        )
        .limit(1);
      return found ?? null;
    });
    if (!row) throw new NotFoundError('Employment contract', id);
    return row;
  }

  async createContract(
    principal: Principal,
    institutionId: string,
    input: CreateEmploymentContractInput,
  ): Promise<ContractRow> {
    return this.db.runInTenant(async (tx) => {
      const employee = await this.requireEmployee(tx, institutionId, input.employeeId);
      if (SEPARATION_STATUSES.includes(employee.employmentStatus)) {
        throw new WorkflowStateError(employee.employmentStatus, 'contracted', 'employee');
      }

      await this.assertNoContractOverlap(tx, input.employeeId, {
        startDate: input.startDate,
        endDate: input.endDate ?? null,
      });

      const [created] = await tx
        .insert(employmentContracts)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          employeeId: input.employeeId,
          contractType: input.contractType,
          status: 'active',
          startDate: input.startDate,
          endDate: input.endDate ?? null,
          probationEndDate: input.probationEndDate ?? null,
          noticePeriodDays: input.noticePeriodDays,
          terms: input.terms ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  async updateContract(
    principal: Principal,
    institutionId: string,
    id: string,
    input: Record<string, unknown>,
  ): Promise<{ contract: ContractRow; previous: Partial<ContractRow> }> {
    const version = input['version'] as number;
    const { version: _ignored, ...changes } = input;

    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(employmentContracts)
        .where(
          and(
            eq(employmentContracts.id, id),
            eq(employmentContracts.institutionId, institutionId),
            isNull(employmentContracts.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Employment contract', id);
      if (existing.status !== 'active') {
        // An ended or terminated contract is a record of what was agreed; correcting one is
        // creating a new contract, not editing history.
        throw new WorkflowStateError(existing.status, 'edited', 'employment contract');
      }

      const nextStart = (changes['startDate'] as string | undefined) ?? existing.startDate;
      const nextEnd =
        'endDate' in changes ? (changes['endDate'] as string | null) : existing.endDate;
      const nextProbation =
        'probationEndDate' in changes
          ? (changes['probationEndDate'] as string | null)
          : existing.probationEndDate;

      // The database restates these, but a clear 422 beats a constraint-violation translation.
      if (nextEnd && nextEnd <= nextStart) {
        throw new ValidationError('The contract must end after it starts', [
          { path: 'endDate', message: 'End date must be after the start date' },
        ]);
      }
      if (nextProbation && (nextProbation < nextStart || (nextEnd && nextProbation > nextEnd))) {
        throw new ValidationError('Probation must fall within the contract', [
          { path: 'probationEndDate', message: 'Probation must fall within the contract' },
        ]);
      }

      await this.assertNoContractOverlap(
        tx,
        existing.employeeId,
        { startDate: nextStart, endDate: nextEnd },
        id,
      );

      const [updated] = await tx
        .update(employmentContracts)
        .set({
          ...(changes as Partial<ContractRow>),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(employmentContracts.id, id), eq(employmentContracts.version, version)))
        .returning();
      if (!updated) {
        throw new ConflictError(
          'This contract was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      const previous: Partial<ContractRow> = {};
      for (const key of Object.keys(changes)) {
        const typedKey = key as keyof ContractRow;
        if (existing[typedKey] !== updated[typedKey]) {
          (previous as Record<string, unknown>)[key] = existing[typedKey];
        }
      }
      return { contract: updated, previous };
    });
  }

  async terminateContract(
    principal: Principal,
    institutionId: string,
    id: string,
    input: { effectiveDate: string; reason: string },
  ): Promise<ContractRow> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(employmentContracts)
        .where(
          and(
            eq(employmentContracts.id, id),
            eq(employmentContracts.institutionId, institutionId),
            isNull(employmentContracts.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Employment contract', id);
      if (existing.status !== 'active') {
        throw new WorkflowStateError(existing.status, 'terminated', 'employment contract');
      }

      const started = existing.startDate < input.effectiveDate;
      const [updated] = await tx
        .update(employmentContracts)
        .set({
          status: 'terminated',
          ...(started ? { endDate: input.effectiveDate } : {}),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(employmentContracts.id, id))
        .returning();
      return updated!;
    });
  }

  /**
   * Two active contracts for one employee may not overlap in time. `[start, end]` with a
   * null end read as open-ended; compared with Postgres `daterange` so the comparison
   * happens in the same transaction snapshot as the write it protects.
   */
  private async assertNoContractOverlap(
    tx: Transaction,
    employeeId: string,
    range: { startDate: string; endDate: string | null },
    excludeContractId?: string,
  ): Promise<void> {
    const filters: SQL[] = [
      eq(employmentContracts.employeeId, employeeId),
      eq(employmentContracts.status, 'active'),
      isNull(employmentContracts.archivedAt),
      sql`daterange(${employmentContracts.startDate}, coalesce(${employmentContracts.endDate}, 'infinity'::date), '[]')
          && daterange(${range.startDate}::date, coalesce(${range.endDate}::date, 'infinity'::date), '[]')`,
    ];
    if (excludeContractId) filters.push(ne(employmentContracts.id, excludeContractId));

    const [overlapping] = await tx
      .select({ id: employmentContracts.id, startDate: employmentContracts.startDate })
      .from(employmentContracts)
      .where(and(...filters))
      .limit(1);
    if (overlapping) {
      throw new ConflictError(
        'This employee already has an active contract covering part of that period. End it first.',
        { conflictingContractId: overlapping.id },
      );
    }
  }

  // ── Salary structures ──────────────────────────────────────────────────────────────

  async listSalaryStructures(
    principal: Principal,
    institutionId: string,
    query: { sort?: string; q?: string; status?: string; includeArchived: boolean },
    page: OffsetPageRequest,
  ): Promise<OffsetPage<SalaryStructureRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(salaryStructures.institutionId, institutionId)];
      if (!query.includeArchived) filters.push(isNull(salaryStructures.archivedAt));
      if (query.status) {
        filters.push(eq(salaryStructures.status, query.status as SalaryStructureRow['status']));
      }
      if (query.q) filters.push(ilike(salaryStructures.nameEn, `%${query.q}%`));
      const where = and(...filters);

      const orderBy = parseSort(query.sort, SALARY_STRUCTURE_SORT_FIELDS, {
        field: 'nameEn',
        direction: 'asc',
      }).map((spec) => {
        const column = {
          nameEn: salaryStructures.nameEn,
          status: salaryStructures.status,
          effectiveFrom: salaryStructures.effectiveFrom,
          createdAt: salaryStructures.createdAt,
        }[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(salaryStructures)
        .where(where)
        .orderBy(...orderBy, asc(salaryStructures.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));
      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(salaryStructures)
        .where(where);
      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async getSalaryStructure(
    principal: Principal,
    institutionId: string,
    id: string,
  ): Promise<{ structure: SalaryStructureRow; components: SalaryComponentRow[] }> {
    return this.db.runInTenant(async (tx) => {
      const [structure] = await tx
        .select()
        .from(salaryStructures)
        .where(and(eq(salaryStructures.id, id), eq(salaryStructures.institutionId, institutionId)))
        .limit(1);
      if (!structure) throw new NotFoundError('Salary structure', id);
      const components = await this.liveComponents(tx, id);
      return { structure, components };
    });
  }

  async createSalaryStructure(
    principal: Principal,
    institutionId: string,
    input: CreateSalaryStructureInput,
  ): Promise<SalaryStructureRow> {
    return this.db.runInTenant(async (tx) => {
      const [duplicate] = await tx
        .select({ id: salaryStructures.id })
        .from(salaryStructures)
        .where(
          and(
            eq(salaryStructures.institutionId, institutionId),
            eq(salaryStructures.nameEn, input.nameEn),
            isNull(salaryStructures.archivedAt),
          ),
        )
        .limit(1);
      if (duplicate) {
        throw new ConflictError(`A salary structure named "${input.nameEn}" already exists`);
      }
      const [created] = await tx
        .insert(salaryStructures)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          nameEn: input.nameEn,
          nameBn: input.nameBn ?? null,
          description: input.description ?? null,
          status: 'draft',
          effectiveFrom: input.effectiveFrom,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  async updateSalaryStructure(
    principal: Principal,
    institutionId: string,
    id: string,
    input: Record<string, unknown>,
  ): Promise<{ structure: SalaryStructureRow; previous: Partial<SalaryStructureRow> }> {
    const version = input['version'] as number;
    const { version: _ignored, ...changes } = input;

    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(salaryStructures)
        .where(
          and(
            eq(salaryStructures.id, id),
            eq(salaryStructures.institutionId, institutionId),
            isNull(salaryStructures.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Salary structure', id);

      const [updated] = await tx
        .update(salaryStructures)
        .set({
          ...(changes as Partial<SalaryStructureRow>),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(salaryStructures.id, id), eq(salaryStructures.version, version)))
        .returning();
      if (!updated) {
        throw new ConflictError(
          'This salary structure was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      const previous: Partial<SalaryStructureRow> = {};
      for (const key of Object.keys(changes)) {
        const typedKey = key as keyof SalaryStructureRow;
        if (existing[typedKey] !== updated[typedKey]) {
          (previous as Record<string, unknown>)[key] = existing[typedKey];
        }
      }
      return { structure: updated, previous };
    });
  }

  /**
   * Replace a structure's components as a complete set.
   *
   * Components that disappear from the submitted list are archived rather than deleted, so a
   * payslip computed last month still resolves the component it paid. Amounts — taka and
   * percentages alike — are normalised through `Money` so the stored string always carries
   * exactly two decimals.
   */
  async replaceSalaryComponents(
    principal: Principal,
    institutionId: string,
    structureId: string,
    input: ReplaceSalaryComponentsInput,
  ): Promise<{ structure: SalaryStructureRow; components: SalaryComponentRow[] }> {
    return this.db.runInTenant(async (tx) => {
      const [structure] = await tx
        .select()
        .from(salaryStructures)
        .where(
          and(
            eq(salaryStructures.id, structureId),
            eq(salaryStructures.institutionId, institutionId),
            isNull(salaryStructures.archivedAt),
          ),
        )
        .limit(1);
      if (!structure) throw new NotFoundError('Salary structure', structureId);
      if (structure.status === 'archived') {
        throw new WorkflowStateError('archived', 'edited', 'salary structure');
      }

      const existing = await this.liveComponents(tx, structureId);
      const existingIds = new Set(existing.map((row) => row.id));
      for (const component of input.components) {
        if (component.id && !existingIds.has(component.id)) {
          throw new ValidationError('A submitted component does not belong to this structure', [
            { path: 'components', message: `Unknown component id ${component.id}` },
          ]);
        }
      }

      const incomingIds = new Set(
        input.components.map((component) => component.id).filter(Boolean) as string[],
      );
      for (const row of existing) {
        if (!incomingIds.has(row.id)) {
          await tx
            .update(salaryComponents)
            .set({
              archivedAt: new Date(),
              archivedBy: principal.userId,
              archiveReason: 'Removed when the salary structure was edited',
              updatedBy: principal.userId,
            })
            .where(eq(salaryComponents.id, row.id));
        }
      }

      for (const component of input.components) {
        const amount = Money.fromDecimalString(component.amount).toDecimalString();
        const values = {
          nameEn: component.nameEn,
          nameBn: component.nameBn ?? null,
          type: component.type,
          calculation: component.calculation,
          amount,
          isTaxable: component.isTaxable,
          sequence: component.sequence,
          updatedBy: principal.userId,
        };
        if (component.id) {
          await tx
            .update(salaryComponents)
            .set(values)
            .where(eq(salaryComponents.id, component.id));
        } else {
          await tx.insert(salaryComponents).values({
            id: uuidv7(),
            tenantId: principal.tenantId!,
            institutionId,
            salaryStructureId: structureId,
            ...values,
            createdBy: principal.userId,
          });
        }
      }

      const components = await this.liveComponents(tx, structureId);
      return { structure, components };
    });
  }

  async activateSalaryStructure(
    principal: Principal,
    institutionId: string,
    id: string,
  ): Promise<SalaryStructureRow> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(salaryStructures)
        .where(
          and(
            eq(salaryStructures.id, id),
            eq(salaryStructures.institutionId, institutionId),
            isNull(salaryStructures.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Salary structure', id);
      if (existing.status !== 'draft') {
        throw new WorkflowStateError(existing.status, 'active', 'salary structure');
      }
      const components = await this.liveComponents(tx, id);
      if (components.length === 0) {
        throw new ConflictError('Add at least one component before activating the structure');
      }

      const [updated] = await tx
        .update(salaryStructures)
        .set({ status: 'active', version: existing.version + 1, updatedBy: principal.userId })
        .where(eq(salaryStructures.id, id))
        .returning();
      return updated!;
    });
  }

  async archiveSalaryStructure(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<SalaryStructureRow> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(salaryStructures)
        .where(
          and(
            eq(salaryStructures.id, id),
            eq(salaryStructures.institutionId, institutionId),
            isNull(salaryStructures.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Salary structure', id);

      const [openAssignment] = await tx
        .select({ id: employeeSalaryAssignments.id })
        .from(employeeSalaryAssignments)
        .where(
          and(
            eq(employeeSalaryAssignments.salaryStructureId, id),
            isNull(employeeSalaryAssignments.effectiveTo),
            isNull(employeeSalaryAssignments.archivedAt),
          ),
        )
        .limit(1);
      if (openAssignment) {
        throw new ConflictError(
          'Employees are still paid on this structure. Move them to another structure first.',
        );
      }

      const [archived] = await tx
        .update(salaryStructures)
        .set({
          status: 'archived',
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(eq(salaryStructures.id, id))
        .returning();
      return archived!;
    });
  }

  private async liveComponents(tx: Transaction, structureId: string) {
    return tx
      .select()
      .from(salaryComponents)
      .where(
        and(
          eq(salaryComponents.salaryStructureId, structureId),
          isNull(salaryComponents.archivedAt),
        ),
      )
      .orderBy(asc(salaryComponents.sequence), asc(salaryComponents.id));
  }

  // ── Salary assignments and the salary read ─────────────────────────────────────────

  /**
   * Put an employee on a structure with a basic.
   *
   * The employee's current open-ended assignment, if any, is closed the day before the new
   * one begins — history is preserved, never edited. Any other overlap is a conflict.
   */
  async assignSalary(
    principal: Principal,
    institutionId: string,
    input: AssignSalaryInput,
  ): Promise<SalaryAssignmentRow> {
    return this.db.runInTenant(async (tx) => {
      const employee = await this.requireEmployee(tx, institutionId, input.employeeId);
      if (SEPARATION_STATUSES.includes(employee.employmentStatus)) {
        throw new WorkflowStateError(employee.employmentStatus, 'salaried', 'employee');
      }

      const [structure] = await tx
        .select()
        .from(salaryStructures)
        .where(
          and(
            eq(salaryStructures.id, input.salaryStructureId),
            eq(salaryStructures.institutionId, institutionId),
            isNull(salaryStructures.archivedAt),
          ),
        )
        .limit(1);
      if (!structure) throw new NotFoundError('Salary structure', input.salaryStructureId);
      if (structure.status !== 'active') {
        throw new WorkflowStateError(structure.status, 'assigned', 'salary structure');
      }

      const existing = await tx
        .select()
        .from(employeeSalaryAssignments)
        .where(
          and(
            eq(employeeSalaryAssignments.employeeId, input.employeeId),
            isNull(employeeSalaryAssignments.archivedAt),
          ),
        );

      const newFrom = input.effectiveFrom;
      const newTo = input.effectiveTo ?? null;
      for (const row of existing) {
        const rowTo = row.effectiveTo;
        const overlaps =
          row.effectiveFrom <= (newTo ?? '9999-12-31') && newFrom <= (rowTo ?? '9999-12-31');
        if (!overlaps) continue;

        if (rowTo === null && row.effectiveFrom < newFrom) {
          // The current assignment simply ends the day before the new one begins.
          await tx
            .update(employeeSalaryAssignments)
            .set({
              effectiveTo: addDays(newFrom as Parameters<typeof addDays>[0], -1),
              version: row.version + 1,
              updatedBy: principal.userId,
            })
            .where(eq(employeeSalaryAssignments.id, row.id));
        } else {
          throw new ConflictError(
            'The employee already has a salary assignment covering part of that period',
            { conflictingAssignmentId: row.id },
          );
        }
      }

      const [created] = await tx
        .insert(employeeSalaryAssignments)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          employeeId: input.employeeId,
          salaryStructureId: input.salaryStructureId,
          // Normalised through Money so the stored string always carries two decimals.
          basic: Money.fromDecimalString(input.basic).toDecimalString(),
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  /**
   * An employee's current salary, fully computed.
   *
   * Authorisation is two-tier and server-side: `payroll.payslips.view.all` reads anyone;
   * otherwise the caller must be reading their own record (the guard has already required
   * `payroll.payslips.view.own`). A wrong id under the narrow permission is a 404, not a
   * 403 — confirming that someone has a salary record is itself a leak.
   */
  async getEmployeeSalary(
    principal: Principal,
    institutionId: string,
    employeeId: string,
  ): Promise<{
    employeeId: string;
    assignment: SalaryAssignmentRow;
    structure: { id: string; nameEn: string; nameBn: string | null; effectiveFrom: string };
    breakdown: SalaryBreakdown;
  }> {
    if (!can(principal, 'payroll.payslips.view.all') && principal.employeeId !== employeeId) {
      throw new NotFoundError('Employee', employeeId);
    }

    return this.db.runInTenant(async (tx) => {
      await this.requireEmployee(tx, institutionId, employeeId);

      const [assignment] = await tx
        .select()
        .from(employeeSalaryAssignments)
        .where(
          and(
            eq(employeeSalaryAssignments.employeeId, employeeId),
            isNull(employeeSalaryAssignments.effectiveTo),
            isNull(employeeSalaryAssignments.archivedAt),
          ),
        )
        .limit(1);
      if (!assignment) throw new NotFoundError('Salary assignment');

      const [structure] = await tx
        .select()
        .from(salaryStructures)
        .where(eq(salaryStructures.id, assignment.salaryStructureId))
        .limit(1);
      if (!structure) throw new NotFoundError('Salary structure', assignment.salaryStructureId);

      const components = await this.liveComponents(tx, structure.id);
      const breakdown = computeSalaryBreakdown(
        assignment.basic,
        components.map((component) => ({
          id: component.id,
          nameEn: component.nameEn,
          type: component.type,
          calculation: component.calculation,
          amount: component.amount,
          sequence: component.sequence,
        })),
      );

      return {
        employeeId,
        assignment,
        structure: {
          id: structure.id,
          nameEn: structure.nameEn,
          nameBn: structure.nameBn,
          effectiveFrom: structure.effectiveFrom,
        },
        breakdown,
      };
    });
  }

  // ── Documents ──────────────────────────────────────────────────────────────────────

  async uploadDocument(
    principal: Principal,
    institutionId: string,
    employeeId: string,
    meta: UploadEmployeeDocumentInput,
    file: UploadedFileLike,
  ): Promise<EmployeeDocumentRow> {
    if (file.size > MAX_UPLOAD_BYTES || file.buffer.byteLength > MAX_UPLOAD_BYTES) {
      throw new ValidationError('The file is too large', [
        { path: 'file', message: `Documents are limited to ${MAX_UPLOAD_BYTES} bytes` },
      ]);
    }
    const allowed = new Set<string>([...ALLOWED_DOCUMENT_MIME_TYPES, ...ALLOWED_IMAGE_MIME_TYPES]);
    if (!allowed.has(file.mimetype)) {
      throw new ValidationError('That file type is not accepted', [
        { path: 'file', message: 'Upload a PDF, JPEG, PNG, WEBP or DOCX file' },
      ]);
    }

    // The bytes are written before the transaction: an orphaned object is cleaned up by the
    // pending-upload sweep, whereas a committed row pointing at nothing is a broken record.
    const stored = await this.storage.put({
      tenantId: principal.tenantId!,
      category: 'employee_document',
      filename: file.originalname,
      contentType: file.mimetype,
      body: file.buffer,
    });

    return this.db.runInTenant(async (tx) => {
      await this.requireEmployee(tx, institutionId, employeeId);

      const fileId = uuidv7();
      await tx.insert(files).values({
        id: fileId,
        tenantId: principal.tenantId!,
        institutionId,
        storageKey: stored.key,
        originalFilename: file.originalname,
        mimeType: file.mimetype,
        sizeBytes: stored.sizeBytes,
        checksum: stored.checksum,
        category: 'employee_document',
        ownerType: 'employee',
        ownerId: employeeId,
        isSensitive: true,
        uploadedAt: new Date(),
        createdBy: principal.userId,
        updatedBy: principal.userId,
      });

      const [created] = await tx
        .insert(employeeDocuments)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          employeeId,
          fileId,
          storageKey: stored.key,
          documentType: meta.documentType,
          title: meta.title,
          expiresAt: meta.expiresAt ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  async listDocuments(
    principal: Principal,
    institutionId: string,
    employeeId: string,
    query: { documentType?: string; includeArchived: boolean },
    page: OffsetPageRequest,
  ): Promise<OffsetPage<EmployeeDocumentRow>> {
    return this.db.runInTenant(async (tx) => {
      await this.requireEmployee(tx, institutionId, employeeId);
      const filters: SQL[] = [
        eq(employeeDocuments.employeeId, employeeId),
        eq(employeeDocuments.institutionId, institutionId),
      ];
      if (!query.includeArchived) filters.push(isNull(employeeDocuments.archivedAt));
      if (query.documentType) {
        filters.push(eq(employeeDocuments.documentType, query.documentType));
      }
      const where = and(...filters);
      const rows = await tx
        .select()
        .from(employeeDocuments)
        .where(where)
        .orderBy(desc(employeeDocuments.createdAt), asc(employeeDocuments.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));
      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(employeeDocuments)
        .where(where);
      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  /** The expiry-alert feed: live documents lapsing within the window, soonest first. */
  async expiringDocuments(
    principal: Principal,
    institutionId: string,
    withinDays: number,
    page: OffsetPageRequest,
  ): Promise<
    OffsetPage<EmployeeDocumentRow & { employeeName: string | null; employeeCode: string | null }>
  > {
    return this.db.runInTenant(async (tx) => {
      const deadline = addDays(todayInDhaka(), withinDays);
      const where = and(
        eq(employeeDocuments.institutionId, institutionId),
        isNull(employeeDocuments.archivedAt),
        sql`${employeeDocuments.expiresAt} IS NOT NULL`,
        lte(employeeDocuments.expiresAt, deadline),
      );

      const rows = await tx
        .select({
          ...getTableColumns(employeeDocuments),
          employeeName: employees.fullNameEn,
          employeeCode: employees.employeeCode,
        })
        .from(employeeDocuments)
        .leftJoin(employees, eq(employeeDocuments.employeeId, employees.id))
        .where(where)
        .orderBy(asc(employeeDocuments.expiresAt), asc(employeeDocuments.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));
      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(employeeDocuments)
        .where(where);
      return buildOffsetPage(
        rows as (EmployeeDocumentRow & {
          employeeName: string | null;
          employeeCode: string | null;
        })[],
        counted?.total ?? 0,
        page,
      );
    });
  }

  async verifyDocument(
    principal: Principal,
    institutionId: string,
    id: string,
  ): Promise<EmployeeDocumentRow> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(employeeDocuments)
        .where(
          and(
            eq(employeeDocuments.id, id),
            eq(employeeDocuments.institutionId, institutionId),
            isNull(employeeDocuments.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Employee document', id);
      if (existing.verifiedAt) {
        throw new ConflictError('This document has already been verified');
      }
      const [updated] = await tx
        .update(employeeDocuments)
        .set({
          verifiedBy: principal.userId,
          verifiedAt: new Date(),
          updatedBy: principal.userId,
        })
        .where(eq(employeeDocuments.id, id))
        .returning();
      return updated!;
    });
  }

  // ── Qualifications ─────────────────────────────────────────────────────────────────

  async listQualifications(
    principal: Principal,
    institutionId: string,
    employeeId: string,
  ): Promise<QualificationRow[]> {
    return this.db.runInTenant(async (tx) => {
      await this.requireEmployee(tx, institutionId, employeeId);
      return tx
        .select()
        .from(employeeQualifications)
        .where(
          and(
            eq(employeeQualifications.employeeId, employeeId),
            isNull(employeeQualifications.archivedAt),
          ),
        )
        .orderBy(desc(employeeQualifications.yearCompleted), asc(employeeQualifications.id));
    });
  }

  async createQualification(
    principal: Principal,
    institutionId: string,
    employeeId: string,
    input: CreateEmployeeQualificationInput,
  ): Promise<QualificationRow> {
    return this.db.runInTenant(async (tx) => {
      await this.requireEmployee(tx, institutionId, employeeId);
      const [created] = await tx
        .insert(employeeQualifications)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          employeeId,
          degree: input.degree,
          institutionName: input.institutionName,
          fieldOfStudy: input.fieldOfStudy ?? null,
          yearCompleted: input.yearCompleted ?? null,
          grade: input.grade ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  async updateQualification(
    principal: Principal,
    institutionId: string,
    id: string,
    input: Record<string, unknown>,
  ): Promise<QualificationRow> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select({ id: employeeQualifications.id })
        .from(employeeQualifications)
        .where(
          and(
            eq(employeeQualifications.id, id),
            eq(employeeQualifications.institutionId, institutionId),
            isNull(employeeQualifications.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Qualification', id);
      const [updated] = await tx
        .update(employeeQualifications)
        .set({ ...(input as Partial<QualificationRow>), updatedBy: principal.userId })
        .where(eq(employeeQualifications.id, id))
        .returning();
      return updated!;
    });
  }

  async archiveQualification(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<QualificationRow> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select({ id: employeeQualifications.id })
        .from(employeeQualifications)
        .where(
          and(
            eq(employeeQualifications.id, id),
            eq(employeeQualifications.institutionId, institutionId),
            isNull(employeeQualifications.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Qualification', id);
      const [archived] = await tx
        .update(employeeQualifications)
        .set({
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
        })
        .where(eq(employeeQualifications.id, id))
        .returning();
      return archived!;
    });
  }

  // ── Experience ─────────────────────────────────────────────────────────────────────

  async listExperience(
    principal: Principal,
    institutionId: string,
    employeeId: string,
  ): Promise<ExperienceRow[]> {
    return this.db.runInTenant(async (tx) => {
      await this.requireEmployee(tx, institutionId, employeeId);
      return tx
        .select()
        .from(employeeExperience)
        .where(
          and(eq(employeeExperience.employeeId, employeeId), isNull(employeeExperience.archivedAt)),
        )
        .orderBy(desc(employeeExperience.fromDate), asc(employeeExperience.id));
    });
  }

  async createExperience(
    principal: Principal,
    institutionId: string,
    employeeId: string,
    input: CreateEmployeeExperienceInput,
  ): Promise<ExperienceRow> {
    return this.db.runInTenant(async (tx) => {
      await this.requireEmployee(tx, institutionId, employeeId);
      const [created] = await tx
        .insert(employeeExperience)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          employeeId,
          organisationName: input.organisationName,
          designation: input.designation,
          fromDate: input.fromDate,
          toDate: input.toDate ?? null,
          responsibilities: input.responsibilities ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  async updateExperience(
    principal: Principal,
    institutionId: string,
    id: string,
    input: Record<string, unknown>,
  ): Promise<ExperienceRow> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(employeeExperience)
        .where(
          and(
            eq(employeeExperience.id, id),
            eq(employeeExperience.institutionId, institutionId),
            isNull(employeeExperience.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Experience record', id);

      const nextFrom = (input['fromDate'] as string | undefined) ?? existing.fromDate;
      const nextTo = 'toDate' in input ? (input['toDate'] as string | null) : existing.toDate;
      if (nextTo && nextTo < nextFrom) {
        throw new ValidationError('The engagement cannot end before it begins', [
          { path: 'toDate', message: 'End date must not precede the start date' },
        ]);
      }

      const [updated] = await tx
        .update(employeeExperience)
        .set({ ...(input as Partial<ExperienceRow>), updatedBy: principal.userId })
        .where(eq(employeeExperience.id, id))
        .returning();
      return updated!;
    });
  }

  async archiveExperience(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<ExperienceRow> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select({ id: employeeExperience.id })
        .from(employeeExperience)
        .where(
          and(
            eq(employeeExperience.id, id),
            eq(employeeExperience.institutionId, institutionId),
            isNull(employeeExperience.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Experience record', id);
      const [archived] = await tx
        .update(employeeExperience)
        .set({
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
        })
        .where(eq(employeeExperience.id, id))
        .returning();
      return archived!;
    });
  }

  // ── Dependents ─────────────────────────────────────────────────────────────────────

  async listDependents(
    principal: Principal,
    institutionId: string,
    employeeId: string,
  ): Promise<DependentRow[]> {
    return this.db.runInTenant(async (tx) => {
      await this.requireEmployee(tx, institutionId, employeeId);
      return tx
        .select()
        .from(employeeDependents)
        .where(
          and(eq(employeeDependents.employeeId, employeeId), isNull(employeeDependents.archivedAt)),
        )
        .orderBy(asc(employeeDependents.nameEn), asc(employeeDependents.id));
    });
  }

  async createDependent(
    principal: Principal,
    institutionId: string,
    employeeId: string,
    input: CreateEmployeeDependentInput,
  ): Promise<DependentRow> {
    return this.db.runInTenant(async (tx) => {
      await this.requireEmployee(tx, institutionId, employeeId);
      const [created] = await tx
        .insert(employeeDependents)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          employeeId,
          nameEn: input.nameEn,
          nameBn: input.nameBn ?? null,
          relation: input.relation,
          dateOfBirth: input.dateOfBirth ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  async updateDependent(
    principal: Principal,
    institutionId: string,
    id: string,
    input: Record<string, unknown>,
  ): Promise<DependentRow> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select({ id: employeeDependents.id })
        .from(employeeDependents)
        .where(
          and(
            eq(employeeDependents.id, id),
            eq(employeeDependents.institutionId, institutionId),
            isNull(employeeDependents.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Dependent', id);
      const [updated] = await tx
        .update(employeeDependents)
        .set({ ...(input as Partial<DependentRow>), updatedBy: principal.userId })
        .where(eq(employeeDependents.id, id))
        .returning();
      return updated!;
    });
  }

  async archiveDependent(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<DependentRow> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select({ id: employeeDependents.id })
        .from(employeeDependents)
        .where(
          and(
            eq(employeeDependents.id, id),
            eq(employeeDependents.institutionId, institutionId),
            isNull(employeeDependents.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Dependent', id);
      const [archived] = await tx
        .update(employeeDependents)
        .set({
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
        })
        .where(eq(employeeDependents.id, id))
        .returning();
      return archived!;
    });
  }

  // ── Reporting ──────────────────────────────────────────────────────────────────────

  /**
   * Headcount and attrition, computed in SQL.
   *
   * Headcount at a date D counts everyone who had joined by D and had not left by D
   * (`last_working_date` is set by separation). Attrition over the window is separations
   * divided by the average of the opening and closing headcount, expressed as a percentage
   * with two decimals — computed in SQL `numeric`, not in floating point.
   */
  async headcountReport(
    principal: Principal,
    institutionId: string,
    query: HeadcountReportQuery,
  ): Promise<{
    window: { from: string; to: string };
    current: {
      total: number;
      byStatus: { status: string; total: number }[];
      byEmploymentType: { employmentType: string; total: number }[];
      byDepartment: { departmentId: string | null; nameEn: string | null; total: number }[];
      byDesignation: { designationId: string | null; nameEn: string | null; total: number }[];
      byCampus: { campusId: string | null; nameEn: string | null; total: number }[];
    };
    movement: {
      headcountAtStart: number;
      headcountAtEnd: number;
      joiners: number;
      separations: number;
      /** Percentage with two decimals, as a decimal string. */
      attritionRatePercent: string;
    };
  }> {
    return this.db.runInTenant(async (tx) => {
      const to = query.to ?? todayInDhaka();
      const from = query.from ?? `${String(to).slice(0, 4)}-01-01`;

      const liveWhere = and(
        eq(employees.institutionId, institutionId),
        isNull(employees.archivedAt),
      );

      const [current] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(employees)
        .where(
          and(
            liveWhere,
            sql`${employees.employmentStatus} not in ('resigned', 'terminated', 'retired')`,
          ),
        );

      const byStatus = await tx
        .select({
          status: sql<string>`${employees.employmentStatus}::text`,
          total: sql<number>`count(*)::int`,
        })
        .from(employees)
        .where(liveWhere)
        .groupBy(employees.employmentStatus);

      const byEmploymentType = await tx
        .select({ employmentType: employees.employmentType, total: sql<number>`count(*)::int` })
        .from(employees)
        .where(liveWhere)
        .groupBy(employees.employmentType);

      const byDepartment = await tx
        .select({
          departmentId: employees.departmentId,
          nameEn: departments.nameEn,
          total: sql<number>`count(*)::int`,
        })
        .from(employees)
        .leftJoin(departments, eq(employees.departmentId, departments.id))
        .where(liveWhere)
        .groupBy(employees.departmentId, departments.nameEn);

      const byDesignation = await tx
        .select({
          designationId: employees.designationId,
          nameEn: designations.nameEn,
          total: sql<number>`count(*)::int`,
        })
        .from(employees)
        .leftJoin(designations, eq(employees.designationId, designations.id))
        .where(liveWhere)
        .groupBy(employees.designationId, designations.nameEn);

      const byCampus = await tx
        .select({
          campusId: employees.campusId,
          nameEn: campuses.nameEn,
          total: sql<number>`count(*)::int`,
        })
        .from(employees)
        .leftJoin(campuses, eq(employees.campusId, campuses.id))
        .where(liveWhere)
        .groupBy(employees.campusId, campuses.nameEn);

      const headcountAt = async (date: string): Promise<number> => {
        const [row] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(employees)
          .where(
            and(
              eq(employees.institutionId, institutionId),
              lte(employees.joiningDate, date),
              sql`(${employees.lastWorkingDate} IS NULL OR ${employees.lastWorkingDate} > ${date})`,
            ),
          );
        return row?.total ?? 0;
      };
      const headcountAtStart = await headcountAt(from);
      const headcountAtEnd = await headcountAt(to);

      const [joinersRow] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(employees)
        .where(
          and(
            eq(employees.institutionId, institutionId),
            sql`${employees.joiningDate} between ${from} and ${to}`,
          ),
        );

      const [separationsRow] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(employeeStatusHistory)
        .where(
          and(
            eq(employeeStatusHistory.institutionId, institutionId),
            inArray(employeeStatusHistory.toStatus, ['resigned', 'terminated', 'retired']),
            sql`${employeeStatusHistory.effectiveDate} between ${from} and ${to}`,
          ),
        );
      const separations = separationsRow?.total ?? 0;

      // attrition% = separations / average(opening, closing) * 100 = separations * 200 / sum.
      // Kept in SQL numeric so the division never touches a binary float.
      const rateResult = await tx.execute(sql`
        select case
          when ${headcountAtStart}::int + ${headcountAtEnd}::int = 0 then '0.00'
          else round(
            (${separations}::numeric * 200.0)
              / (${headcountAtStart}::int + ${headcountAtEnd}::int),
            2
          )::text
        end as rate
      `);
      const rateRows = (rateResult as unknown as { rows: Array<{ rate: string }> }).rows ?? [];
      const attritionRatePercent = rateRows[0]?.rate ?? '0.00';

      return {
        window: { from: String(from), to: String(to) },
        current: {
          total: current?.total ?? 0,
          byStatus,
          byEmploymentType,
          byDepartment,
          byDesignation,
          byCampus,
        },
        movement: {
          headcountAtStart,
          headcountAtEnd,
          joiners: joinersRow?.total ?? 0,
          separations,
          attritionRatePercent,
        },
      };
    });
  }

  // ── Shared helpers ─────────────────────────────────────────────────────────────────

  /**
   * Remove payroll-adjacent fields for callers without `payroll.payslips.view.all`.
   *
   * Done here rather than by omitting the columns from the SELECT because the same row shape
   * is used by callers who *do* hold the permission, and two divergent query paths is how
   * one of them ends up forgetting. Mirrors `StudentsService.redactSensitive`.
   */
  private redactSensitive(principal: Principal, row: EmployeeRow): EmployeeRow {
    if (can(principal, 'payroll.payslips.view.all')) return row;
    return {
      ...row,
      nationalId: null,
      bankName: null,
      bankAccountNumber: null,
      bankBranch: null,
      mobileBankingProvider: null,
      mobileBankingNumber: null,
    };
  }

  private async requireEmployee(
    tx: Transaction,
    institutionId: string,
    id: string,
  ): Promise<EmployeeRow> {
    const [found] = await tx
      .select()
      .from(employees)
      .where(
        and(
          eq(employees.id, id),
          eq(employees.institutionId, institutionId),
          isNull(employees.archivedAt),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundError('Employee', id);
    return found;
  }

  private async requireDepartment(
    tx: Transaction,
    institutionId: string,
    id: string,
  ): Promise<DepartmentRow> {
    const [found] = await tx
      .select()
      .from(departments)
      .where(
        and(
          eq(departments.id, id),
          eq(departments.institutionId, institutionId),
          isNull(departments.archivedAt),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundError('Department', id);
    return found;
  }

  private async requireDesignation(
    tx: Transaction,
    institutionId: string,
    id: string,
  ): Promise<DesignationRow> {
    const [found] = await tx
      .select()
      .from(designations)
      .where(
        and(
          eq(designations.id, id),
          eq(designations.institutionId, institutionId),
          isNull(designations.archivedAt),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundError('Designation', id);
    return found;
  }

  /**
   * A campus of the caller's institution, or `NotFoundError`. This is what makes a
   * cross-institution (or cross-tenant, via RLS) transfer target indistinguishable from a
   * campus that does not exist.
   */
  private async requireCampus(tx: Transaction, institutionId: string, id: string) {
    const [found] = await tx
      .select({ id: campuses.id })
      .from(campuses)
      .where(
        and(
          eq(campuses.id, id),
          eq(campuses.institutionId, institutionId),
          isNull(campuses.archivedAt),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundError('Campus', id);
    return found;
  }

  private async assertDepartmentCodeFree(
    tx: Transaction,
    institutionId: string,
    code: string,
  ): Promise<void> {
    const [duplicate] = await tx
      .select({ id: departments.id })
      .from(departments)
      .where(
        and(
          eq(departments.institutionId, institutionId),
          eq(departments.code, code),
          isNull(departments.archivedAt),
        ),
      )
      .limit(1);
    if (duplicate) throw new ConflictError(`A department with code ${code} already exists`);
  }

  /**
   * Next sequential code for the institution. Uses `max` rather than `count` because
   * archived employees keep their codes; the partial unique index is the real guarantee.
   */
  private async nextEmployeeCode(tx: Transaction, institutionId: string): Promise<string> {
    const year = new Date().getUTCFullYear();
    const prefix = `E${year}`;
    const [row] = await tx
      .select({ maxCode: sql<string | null>`max(${employees.employeeCode})` })
      .from(employees)
      .where(
        and(
          eq(employees.institutionId, institutionId),
          ilike(employees.employeeCode, `${prefix}%`),
        ),
      );
    const previous = row?.maxCode ? Number(row.maxCode.slice(prefix.length)) : 0;
    return `${prefix}${String((Number.isFinite(previous) ? previous : 0) + 1).padStart(4, '0')}`;
  }
}

const EMPLOYEE_COLUMNS = {
  fullNameEn: employees.fullNameEn,
  employeeCode: employees.employeeCode,
  joiningDate: employees.joiningDate,
  employmentStatus: employees.employmentStatus,
  createdAt: employees.createdAt,
} as const;
