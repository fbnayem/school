/**
 * Human resources endpoints (Phase 15).
 *
 * Every route is `@InstitutionScoped()`: staff belong to an institution, and a group
 * administrator running three schools has no safe default. The header is required by the
 * tenant guard rather than guessed here.
 *
 * The permission split, written down:
 *
 *   hr.employees.view          — read the directory and profiles (redacted)
 *   hr.employees.create/update — maintain records, departments, designations, side-tables
 *   hr.employees.archive       — archive a separated employee, and see archived rows
 *   hr.exit.manage             — reach a separation status (resigned/terminated/retired)
 *   hr.contracts.manage        — the contract lifecycle
 *   hr.documents.view          — read documents and the expiry-alert feed
 *   payroll.structures.manage  — salary structures, components, and assignments
 *   payroll.payslips.view.all  — read anyone's salary; also unlocks the redacted fields
 *   payroll.payslips.view.own  — read exactly your own salary
 *
 * Self-service lives under `employees/me` with `@Authenticated()` — reading and editing your
 * own contact details is not a permission anyone could sensibly be denied. The `me` routes
 * are declared before `employees/:id` so Nest never treats "me" as an id.
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
import {
  MAX_UPLOAD_BYTES,
  normalizeOffsetPage,
  NotFoundError,
  ValidationError,
} from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import {
  archiveDepartmentSchema,
  archiveDesignationSchema,
  archiveEmployeeSchema,
  archiveHrRecordSchema,
  archiveSalaryStructureSchema,
  assignSalarySchema,
  changeEmployeeStatusSchema,
  createDepartmentSchema,
  createDesignationSchema,
  createEmployeeDependentSchema,
  createEmployeeExperienceSchema,
  createEmployeeQualificationSchema,
  createEmployeeSchema,
  createEmploymentContractSchema,
  createSalaryStructureSchema,
  expiringDocumentsQuerySchema,
  headcountReportQuerySchema,
  idParamSchema,
  listDepartmentsSchema,
  listDesignationsSchema,
  listEmployeeDocumentsSchema,
  listEmployeesSchema,
  listEmploymentContractsSchema,
  listSalaryStructuresSchema,
  replaceSalaryComponentsSchema,
  terminateEmploymentContractSchema,
  transferEmployeeSchema,
  updateDepartmentSchema,
  updateDesignationSchema,
  updateEmployeeDependentSchema,
  updateEmployeeExperienceSchema,
  updateEmployeeQualificationSchema,
  updateEmployeeSchema,
  updateEmploymentContractSchema,
  updateOwnEmployeeProfileSchema,
  updateSalaryStructureSchema,
  uploadEmployeeDocumentSchema,
} from '@shikkha/validation';
import { HrService, type UploadedFileLike } from './hr.service';
import {
  Audited,
  Authenticated,
  CurrentUser,
  InstitutionScoped,
  RequirePermissions,
} from '../../common/decorators';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { currentContext } from '../../common/context/request-context';

@ApiTags('hr')
@Controller('hr')
@InstitutionScoped()
export class HrController {
  constructor(private readonly hr: HrService) {}

  // ── Departments ────────────────────────────────────────────────────────────────────

  @Get('departments')
  @RequirePermissions('hr.employees.view')
  @ApiOperation({ summary: 'List departments' })
  async listDepartments(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listDepartmentsSchema)) query: z.infer<typeof listDepartmentsSchema>,
  ) {
    return this.hr.listDepartments(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Post('departments')
  @RequirePermissions('hr.employees.update')
  @Audited({
    module: 'hr',
    resourceType: 'department',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create a department' })
  async createDepartment(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createDepartmentSchema)) body: z.infer<typeof createDepartmentSchema>,
  ) {
    return this.hr.createDepartment(principal, requireInstitution(), body);
  }

  @Patch('departments/:id')
  @RequirePermissions('hr.employees.update')
  @Audited({
    module: 'hr',
    resourceType: 'department',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update a department' })
  async updateDepartment(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateDepartmentSchema)) body: z.infer<typeof updateDepartmentSchema>,
  ) {
    return this.hr.updateDepartment(principal, requireInstitution(), params.id, body);
  }

  @Post('departments/:id/archive')
  @RequirePermissions('hr.employees.update')
  @Audited({
    module: 'hr',
    resourceType: 'department',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive a department' })
  async archiveDepartment(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(archiveDepartmentSchema)) body: { reason: string },
  ) {
    return this.hr.archiveDepartment(principal, requireInstitution(), params.id, body.reason);
  }

  // ── Designations ───────────────────────────────────────────────────────────────────

  @Get('designations')
  @RequirePermissions('hr.employees.view')
  @ApiOperation({ summary: 'List designations' })
  async listDesignations(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listDesignationsSchema)) query: z.infer<typeof listDesignationsSchema>,
  ) {
    return this.hr.listDesignations(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Post('designations')
  @RequirePermissions('hr.employees.update')
  @Audited({
    module: 'hr',
    resourceType: 'designation',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create a designation' })
  async createDesignation(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createDesignationSchema)) body: z.infer<typeof createDesignationSchema>,
  ) {
    return this.hr.createDesignation(principal, requireInstitution(), body);
  }

  @Patch('designations/:id')
  @RequirePermissions('hr.employees.update')
  @Audited({
    module: 'hr',
    resourceType: 'designation',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update a designation' })
  async updateDesignation(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateDesignationSchema)) body: z.infer<typeof updateDesignationSchema>,
  ) {
    return this.hr.updateDesignation(principal, requireInstitution(), params.id, body);
  }

  @Post('designations/:id/archive')
  @RequirePermissions('hr.employees.update')
  @Audited({
    module: 'hr',
    resourceType: 'designation',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive a designation' })
  async archiveDesignation(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(archiveDesignationSchema)) body: { reason: string },
  ) {
    return this.hr.archiveDesignation(principal, requireInstitution(), params.id, body.reason);
  }

  // ── Self-service (declared before `employees/:id` so "me" is never read as an id) ──

  @Get('employees/me')
  @Authenticated()
  @ApiOperation({ summary: 'Read your own employee profile' })
  async myProfile(@CurrentUser() principal: Principal) {
    return this.hr.getOwnProfile(principal);
  }

  @Patch('employees/me')
  @Authenticated()
  @Audited({
    module: 'hr',
    resourceType: 'employee',
    action: 'update',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Update your own contact details' })
  async updateMyProfile(
    @CurrentUser() principal: Principal,
    @Body(zodBody(updateOwnEmployeeProfileSchema))
    body: z.infer<typeof updateOwnEmployeeProfileSchema>,
  ) {
    const result = await this.hr.updateOwnProfile(principal, body);
    return { ...result.employee, __audit: { previousValue: result.previous, newValue: body } };
  }

  @Get('employees/me/salary')
  @RequirePermissions('payroll.payslips.view.own', 'payroll.payslips.view.all', { mode: 'any' })
  @ApiOperation({ summary: 'Read your own salary breakdown' })
  async mySalary(@CurrentUser() principal: Principal) {
    if (!principal.employeeId) throw new NotFoundError('Employee profile');
    return this.hr.getEmployeeSalary(principal, requireInstitution(), principal.employeeId);
  }

  // ── Employee directory and lifecycle ───────────────────────────────────────────────

  @Get('employees')
  @RequirePermissions('hr.employees.view')
  @ApiOperation({ summary: 'The employee directory (sensitive fields redacted by permission)' })
  async listEmployees(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listEmployeesSchema)) query: z.infer<typeof listEmployeesSchema>,
  ) {
    return this.hr.listEmployees(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Post('employees')
  @RequirePermissions('hr.employees.create')
  @Audited({
    module: 'hr',
    resourceType: 'employee',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create an employee record' })
  async createEmployee(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createEmployeeSchema)) body: z.infer<typeof createEmployeeSchema>,
  ) {
    return this.hr.createEmployee(principal, requireInstitution(), body);
  }

  @Get('employees/:id')
  @RequirePermissions('hr.employees.view')
  @ApiOperation({ summary: 'Fetch one employee' })
  async getEmployee(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.hr.getEmployee(principal, requireInstitution(), params.id);
  }

  @Patch('employees/:id')
  @RequirePermissions('hr.employees.update')
  @Audited({
    module: 'hr',
    resourceType: 'employee',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update an employee record (HR full edit)' })
  async updateEmployee(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateEmployeeSchema)) body: z.infer<typeof updateEmployeeSchema>,
  ) {
    const result = await this.hr.updateEmployee(principal, requireInstitution(), params.id, body);
    // `__audit` is read by the audit interceptor and stripped from the HTTP response, so the
    // trail records what actually changed rather than the whole submitted body.
    return { ...result.employee, __audit: { previousValue: result.previous, newValue: body } };
  }

  /**
   * Status change, separation included. Separation is a status with an effective date and a
   * mandatory reason — never a delete. The service enforces that a separation status
   * additionally requires `hr.exit.manage`.
   */
  @Post('employees/:id/status')
  @RequirePermissions('hr.employees.update', 'hr.exit.manage', { mode: 'any' })
  @Audited({
    module: 'hr',
    resourceType: 'employee',
    action: 'update',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Change employment status (including separation)' })
  async changeStatus(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(changeEmployeeStatusSchema)) body: z.infer<typeof changeEmployeeStatusSchema>,
  ) {
    const result = await this.hr.changeStatus(principal, requireInstitution(), params.id, body);
    return { ...result.employee, __audit: { previousValue: result.previous, newValue: body } };
  }

  @Post('employees/:id/transfer')
  @RequirePermissions('hr.employees.update')
  @Audited({
    module: 'hr',
    resourceType: 'employee_transfer',
    action: 'create',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Transfer an employee to another campus of the same institution' })
  async transfer(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(transferEmployeeSchema)) body: z.infer<typeof transferEmployeeSchema>,
  ) {
    return this.hr.transfer(principal, requireInstitution(), params.id, body);
  }

  @Post('employees/:id/archive')
  @RequirePermissions('hr.employees.archive')
  @Audited({
    module: 'hr',
    resourceType: 'employee',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive a separated employee record' })
  async archiveEmployee(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(archiveEmployeeSchema)) body: { reason: string },
  ) {
    return this.hr.archiveEmployee(principal, requireInstitution(), params.id, body.reason);
  }

  // ── Salary read (per employee) ─────────────────────────────────────────────────────

  @Get('employees/:id/salary')
  @RequirePermissions('payroll.payslips.view.all', 'payroll.payslips.view.own', { mode: 'any' })
  @ApiOperation({ summary: 'An employee’s computed salary breakdown' })
  async employeeSalary(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.hr.getEmployeeSalary(principal, requireInstitution(), params.id);
  }

  // ── Documents ──────────────────────────────────────────────────────────────────────

  @Post('employees/:id/documents')
  @RequirePermissions('hr.employees.update')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  @Audited({
    module: 'hr',
    resourceType: 'employee_document',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Upload an employee document (multipart, part name "file")' })
  async uploadDocument(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(uploadEmployeeDocumentSchema))
    body: z.infer<typeof uploadEmployeeDocumentSchema>,
    @UploadedFile() file: UploadedFileLike | undefined,
  ) {
    if (!file) {
      throw new ValidationError('Attach the document as the multipart part named "file"', [
        { path: 'file', message: 'A file is required' },
      ]);
    }
    return this.hr.uploadDocument(principal, requireInstitution(), params.id, body, file);
  }

  @Get('employees/:id/documents')
  @RequirePermissions('hr.documents.view')
  @ApiOperation({ summary: 'List an employee’s documents' })
  async listDocuments(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Query(zodQuery(listEmployeeDocumentsSchema))
    query: z.infer<typeof listEmployeeDocumentsSchema>,
  ) {
    return this.hr.listDocuments(
      principal,
      requireInstitution(),
      params.id,
      query,
      normalizeOffsetPage(query),
    );
  }

  @Get('documents/expiring')
  @RequirePermissions('hr.documents.view')
  @ApiOperation({ summary: 'Documents expiring within a window — the expiry-alert feed' })
  async expiringDocuments(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(expiringDocumentsQuerySchema))
    query: z.infer<typeof expiringDocumentsQuerySchema>,
  ) {
    return this.hr.expiringDocuments(
      principal,
      requireInstitution(),
      query.withinDays,
      normalizeOffsetPage(query),
    );
  }

  @Post('documents/:id/verify')
  @RequirePermissions('hr.employees.update')
  @Audited({
    module: 'hr',
    resourceType: 'employee_document',
    action: 'approve',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Mark a document as verified' })
  async verifyDocument(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.hr.verifyDocument(principal, requireInstitution(), params.id);
  }

  // ── Contracts ──────────────────────────────────────────────────────────────────────

  @Get('contracts')
  @RequirePermissions('hr.contracts.manage')
  @ApiOperation({ summary: 'List employment contracts' })
  async listContracts(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listEmploymentContractsSchema))
    query: z.infer<typeof listEmploymentContractsSchema>,
  ) {
    return this.hr.listContracts(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Post('contracts')
  @RequirePermissions('hr.contracts.manage')
  @Audited({
    module: 'hr',
    resourceType: 'employment_contract',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create an employment contract' })
  async createContract(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createEmploymentContractSchema))
    body: z.infer<typeof createEmploymentContractSchema>,
  ) {
    return this.hr.createContract(principal, requireInstitution(), body);
  }

  @Get('contracts/:id')
  @RequirePermissions('hr.contracts.manage')
  @ApiOperation({ summary: 'Fetch one employment contract' })
  async getContract(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.hr.getContract(principal, requireInstitution(), params.id);
  }

  @Patch('contracts/:id')
  @RequirePermissions('hr.contracts.manage')
  @Audited({
    module: 'hr',
    resourceType: 'employment_contract',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update an active employment contract' })
  async updateContract(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateEmploymentContractSchema))
    body: z.infer<typeof updateEmploymentContractSchema>,
  ) {
    const result = await this.hr.updateContract(principal, requireInstitution(), params.id, body);
    return { ...result.contract, __audit: { previousValue: result.previous, newValue: body } };
  }

  @Post('contracts/:id/terminate')
  @RequirePermissions('hr.contracts.manage')
  @Audited({
    module: 'hr',
    resourceType: 'employment_contract',
    action: 'update',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Terminate an active contract' })
  async terminateContract(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(terminateEmploymentContractSchema))
    body: z.infer<typeof terminateEmploymentContractSchema>,
  ) {
    return this.hr.terminateContract(principal, requireInstitution(), params.id, body);
  }

  // ── Salary structures ──────────────────────────────────────────────────────────────

  @Get('salary-structures')
  @RequirePermissions('payroll.structures.manage', 'payroll.payslips.view.all', { mode: 'any' })
  @ApiOperation({ summary: 'List salary structures' })
  async listSalaryStructures(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listSalaryStructuresSchema))
    query: z.infer<typeof listSalaryStructuresSchema>,
  ) {
    return this.hr.listSalaryStructures(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Post('salary-structures')
  @RequirePermissions('payroll.structures.manage')
  @Audited({
    module: 'hr',
    resourceType: 'salary_structure',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create a salary structure (draft)' })
  async createSalaryStructure(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createSalaryStructureSchema))
    body: z.infer<typeof createSalaryStructureSchema>,
  ) {
    return this.hr.createSalaryStructure(principal, requireInstitution(), body);
  }

  @Get('salary-structures/:id')
  @RequirePermissions('payroll.structures.manage', 'payroll.payslips.view.all', { mode: 'any' })
  @ApiOperation({ summary: 'Fetch a salary structure with its components' })
  async getSalaryStructure(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.hr.getSalaryStructure(principal, requireInstitution(), params.id);
  }

  @Patch('salary-structures/:id')
  @RequirePermissions('payroll.structures.manage')
  @Audited({
    module: 'hr',
    resourceType: 'salary_structure',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update a salary structure' })
  async updateSalaryStructure(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateSalaryStructureSchema))
    body: z.infer<typeof updateSalaryStructureSchema>,
  ) {
    const result = await this.hr.updateSalaryStructure(
      principal,
      requireInstitution(),
      params.id,
      body,
    );
    return { ...result.structure, __audit: { previousValue: result.previous, newValue: body } };
  }

  /** Replace the component set. Absent components are archived, never deleted. */
  @Put('salary-structures/:id/components')
  @RequirePermissions('payroll.structures.manage')
  @Audited({
    module: 'hr',
    resourceType: 'salary_structure',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Replace a structure’s components as a complete set' })
  async replaceComponents(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(replaceSalaryComponentsSchema))
    body: z.infer<typeof replaceSalaryComponentsSchema>,
  ) {
    return this.hr.replaceSalaryComponents(principal, requireInstitution(), params.id, body);
  }

  @Post('salary-structures/:id/activate')
  @RequirePermissions('payroll.structures.manage')
  @Audited({
    module: 'hr',
    resourceType: 'salary_structure',
    action: 'publish',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Activate a draft salary structure' })
  async activateSalaryStructure(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.hr.activateSalaryStructure(principal, requireInstitution(), params.id);
  }

  @Post('salary-structures/:id/archive')
  @RequirePermissions('payroll.structures.manage')
  @Audited({
    module: 'hr',
    resourceType: 'salary_structure',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive a salary structure nobody is paid on' })
  async archiveSalaryStructure(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(archiveSalaryStructureSchema)) body: { reason: string },
  ) {
    return this.hr.archiveSalaryStructure(principal, requireInstitution(), params.id, body.reason);
  }

  @Post('salary-assignments')
  @RequirePermissions('payroll.structures.manage')
  @Audited({
    module: 'hr',
    resourceType: 'employee_salary_assignment',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Assign a salary structure and basic to an employee' })
  async assignSalary(
    @CurrentUser() principal: Principal,
    @Body(zodBody(assignSalarySchema)) body: z.infer<typeof assignSalarySchema>,
  ) {
    return this.hr.assignSalary(principal, requireInstitution(), body);
  }

  // ── Qualifications ─────────────────────────────────────────────────────────────────

  @Get('employees/:id/qualifications')
  @RequirePermissions('hr.employees.view')
  @ApiOperation({ summary: 'List an employee’s qualifications' })
  async listQualifications(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.hr.listQualifications(principal, requireInstitution(), params.id);
  }

  @Post('employees/:id/qualifications')
  @RequirePermissions('hr.employees.update')
  @Audited({
    module: 'hr',
    resourceType: 'employee_qualification',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Add a qualification' })
  async createQualification(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(createEmployeeQualificationSchema))
    body: z.infer<typeof createEmployeeQualificationSchema>,
  ) {
    return this.hr.createQualification(principal, requireInstitution(), params.id, body);
  }

  @Patch('qualifications/:id')
  @RequirePermissions('hr.employees.update')
  @Audited({
    module: 'hr',
    resourceType: 'employee_qualification',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update a qualification' })
  async updateQualification(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateEmployeeQualificationSchema))
    body: z.infer<typeof updateEmployeeQualificationSchema>,
  ) {
    return this.hr.updateQualification(principal, requireInstitution(), params.id, body);
  }

  @Post('qualifications/:id/archive')
  @RequirePermissions('hr.employees.update')
  @Audited({
    module: 'hr',
    resourceType: 'employee_qualification',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive a qualification' })
  async archiveQualification(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(archiveHrRecordSchema)) body: { reason: string },
  ) {
    return this.hr.archiveQualification(principal, requireInstitution(), params.id, body.reason);
  }

  // ── Experience ─────────────────────────────────────────────────────────────────────

  @Get('employees/:id/experience')
  @RequirePermissions('hr.employees.view')
  @ApiOperation({ summary: 'List an employee’s prior experience' })
  async listExperience(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.hr.listExperience(principal, requireInstitution(), params.id);
  }

  @Post('employees/:id/experience')
  @RequirePermissions('hr.employees.update')
  @Audited({
    module: 'hr',
    resourceType: 'employee_experience',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Add an experience record' })
  async createExperience(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(createEmployeeExperienceSchema))
    body: z.infer<typeof createEmployeeExperienceSchema>,
  ) {
    return this.hr.createExperience(principal, requireInstitution(), params.id, body);
  }

  @Patch('experience/:id')
  @RequirePermissions('hr.employees.update')
  @Audited({
    module: 'hr',
    resourceType: 'employee_experience',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update an experience record' })
  async updateExperience(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateEmployeeExperienceSchema))
    body: z.infer<typeof updateEmployeeExperienceSchema>,
  ) {
    return this.hr.updateExperience(principal, requireInstitution(), params.id, body);
  }

  @Post('experience/:id/archive')
  @RequirePermissions('hr.employees.update')
  @Audited({
    module: 'hr',
    resourceType: 'employee_experience',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive an experience record' })
  async archiveExperience(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(archiveHrRecordSchema)) body: { reason: string },
  ) {
    return this.hr.archiveExperience(principal, requireInstitution(), params.id, body.reason);
  }

  // ── Dependents ─────────────────────────────────────────────────────────────────────

  @Get('employees/:id/dependents')
  @RequirePermissions('hr.employees.view')
  @ApiOperation({ summary: 'List an employee’s dependents' })
  async listDependents(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.hr.listDependents(principal, requireInstitution(), params.id);
  }

  @Post('employees/:id/dependents')
  @RequirePermissions('hr.employees.update')
  @Audited({
    module: 'hr',
    resourceType: 'employee_dependent',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Add a dependent' })
  async createDependent(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(createEmployeeDependentSchema))
    body: z.infer<typeof createEmployeeDependentSchema>,
  ) {
    return this.hr.createDependent(principal, requireInstitution(), params.id, body);
  }

  @Patch('dependents/:id')
  @RequirePermissions('hr.employees.update')
  @Audited({
    module: 'hr',
    resourceType: 'employee_dependent',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update a dependent' })
  async updateDependent(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateEmployeeDependentSchema))
    body: z.infer<typeof updateEmployeeDependentSchema>,
  ) {
    return this.hr.updateDependent(principal, requireInstitution(), params.id, body);
  }

  @Post('dependents/:id/archive')
  @RequirePermissions('hr.employees.update')
  @Audited({
    module: 'hr',
    resourceType: 'employee_dependent',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive a dependent' })
  async archiveDependent(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(archiveHrRecordSchema)) body: { reason: string },
  ) {
    return this.hr.archiveDependent(principal, requireInstitution(), params.id, body.reason);
  }

  // ── Reports ────────────────────────────────────────────────────────────────────────

  @Get('reports/headcount')
  @RequirePermissions('hr.employees.view')
  @ApiOperation({ summary: 'Headcount and attrition, computed in SQL' })
  async headcountReport(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(headcountReportQuerySchema))
    query: z.infer<typeof headcountReportQuerySchema>,
  ) {
    return this.hr.headcountReport(principal, requireInstitution(), query);
  }
}

/**
 * HR data belongs to an institution, and there is no safe default when a tenant has several.
 * `@InstitutionScoped()` makes the tenant guard require and validate the header; this is the
 * belt-and-braces read.
 */
function requireInstitution(): string {
  const institutionId = currentContext()?.institutionId;
  if (!institutionId) {
    throw new BadRequestException(
      'Send the x-institution-id header to indicate which institution this HR action belongs to.',
    );
  }
  return institutionId;
}
