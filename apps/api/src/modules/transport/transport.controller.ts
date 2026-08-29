/**
 * Transport endpoints (Phase 18).
 *
 * Every route is `@InstitutionScoped()`: a bus, a route and an assignment belong to one
 * institution, and a group administrator running three schools has no safe default. The
 * header is required by the tenant guard rather than guessed here.
 *
 * The permission split, which is the point of this file:
 *
 *   transport.view                — the schedule-level facts: routes, stops, vehicles,
 *                                   occupancy. Held by guardians and gate staff as well as
 *                                   managers, so nothing behind it may name a student.
 *   transport.vehicles.manage     — the fleet: vehicles, drivers, maintenance, and the
 *                                   expiring-documents report (it lists licence numbers).
 *   transport.routes.manage       — routes, stops, and which vehicle serves which route.
 *   transport.assignments.manage  — everything that names a student: assignments, trips,
 *                                   trip attendance.
 *
 * Self-service (`my-children`) is `@Authenticated()` — the service derives the student set
 * from the caller's own student or guardian identity and fails closed, so there is no
 * permission anyone could sensibly be denied and no parameter to abuse. The live-position
 * route carries `transport.view`, and the service then applies the row-level rule: a caller
 * without a manage permission is answered only for a route their own child is actively
 * assigned to — any other route id is a 404, never a 403.
 *
 * Live positions come from the GPS provider registry: the mock adapter when
 * `GPS_PROVIDER=mock`, otherwise a stub that fails loudly naming its missing credential.
 * No real GPS service is called in this build, and no position is ever fabricated.
 *
 * Route order matters: Nest matches in declaration order, so literal segments
 * (`assignments/bulk`, `reports/...`, `my-children`) are declared before any `:id` route
 * that would otherwise swallow them.
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
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { normalizeOffsetPage } from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import {
  assignStudentTransportSchema,
  assignTransportVehicleSchema,
  bulkAssignStudentTransportSchema,
  createTransportDriverSchema,
  createTransportRouteSchema,
  createTransportVehicleSchema,
  createVehicleMaintenanceSchema,
  endStudentTransportSchema,
  endTransportVehicleAssignmentSchema,
  endVehicleTripSchema,
  idParamSchema,
  listStudentTransportSchema,
  listTransportDriversSchema,
  listTransportRoutesSchema,
  listTransportVehiclesSchema,
  listVehicleMaintenanceSchema,
  listVehicleTripsSchema,
  markTripAttendanceSchema,
  putTransportRouteStopsSchema,
  startVehicleTripSchema,
  transportArchiveSchema,
  transportExpiringDocumentsQuerySchema,
  transportFeeScheduleQuerySchema,
  updateTransportDriverSchema,
  updateTransportRouteSchema,
  updateTransportVehicleSchema,
} from '@shikkha/validation';
import { TransportService } from './transport.service';
import {
  Audited,
  Authenticated,
  CurrentUser,
  InstitutionScoped,
  RequirePermissions,
} from '../../common/decorators';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { currentContext } from '../../common/context/request-context';

@ApiTags('transport')
@Controller('transport')
@InstitutionScoped()
export class TransportController {
  constructor(private readonly transport: TransportService) {}

  // ── Vehicles ────────────────────────────────────────────────────────────────────────

  @Get('vehicles')
  @RequirePermissions('transport.view')
  @ApiOperation({ summary: 'List vehicles' })
  async listVehicles(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listTransportVehiclesSchema))
    query: z.infer<typeof listTransportVehiclesSchema>,
  ) {
    return this.transport.listVehicles(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Post('vehicles')
  @RequirePermissions('transport.vehicles.manage')
  @Audited({
    module: 'transport',
    resourceType: 'vehicle',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Register a vehicle' })
  async createVehicle(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createTransportVehicleSchema))
    body: z.infer<typeof createTransportVehicleSchema>,
  ) {
    return this.transport.createVehicle(principal, requireInstitution(), body);
  }

  @Get('vehicles/:id')
  @RequirePermissions('transport.view')
  @ApiOperation({ summary: 'One vehicle with maintenance history and current route' })
  async getVehicle(@Param(zodParam(idParamSchema)) params: { id: string }) {
    return this.transport.getVehicle(requireInstitution(), params.id);
  }

  @Patch('vehicles/:id')
  @RequirePermissions('transport.vehicles.manage')
  @Audited({
    module: 'transport',
    resourceType: 'vehicle',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update a vehicle (a human moves it to maintenance or retired)' })
  async updateVehicle(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateTransportVehicleSchema))
    body: z.infer<typeof updateTransportVehicleSchema>,
  ) {
    const result = await this.transport.updateVehicle(
      principal,
      requireInstitution(),
      params.id,
      body,
    );
    // `__audit` is read by the audit interceptor and stripped from the HTTP response, so the
    // trail records what actually changed rather than the whole submitted body.
    return { ...result.vehicle, __audit: { previousValue: result.previous, newValue: body } };
  }

  @Post('vehicles/:id/archive')
  @RequirePermissions('transport.vehicles.manage')
  @Audited({
    module: 'transport',
    resourceType: 'vehicle',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Retire a vehicle from the register (never a delete)' })
  async archiveVehicle(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(transportArchiveSchema)) body: { reason: string },
  ) {
    return this.transport.archiveVehicle(principal, requireInstitution(), params.id, body.reason);
  }

  // ── Maintenance ─────────────────────────────────────────────────────────────────────

  @Get('maintenance')
  @RequirePermissions('transport.vehicles.manage')
  @ApiOperation({ summary: 'List maintenance records' })
  async listMaintenance(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listVehicleMaintenanceSchema))
    query: z.infer<typeof listVehicleMaintenanceSchema>,
  ) {
    return this.transport.listMaintenance(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Post('maintenance')
  @RequirePermissions('transport.vehicles.manage')
  @Audited({
    module: 'transport',
    resourceType: 'vehicle_maintenance',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Record a maintenance event (cost is money, never a float)' })
  async createMaintenance(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createVehicleMaintenanceSchema))
    body: z.infer<typeof createVehicleMaintenanceSchema>,
  ) {
    return this.transport.createMaintenance(principal, requireInstitution(), body);
  }

  // ── Drivers ─────────────────────────────────────────────────────────────────────────

  @Get('drivers')
  @RequirePermissions('transport.view')
  @ApiOperation({ summary: 'List drivers' })
  async listDrivers(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listTransportDriversSchema))
    query: z.infer<typeof listTransportDriversSchema>,
  ) {
    return this.transport.listDrivers(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Post('drivers')
  @RequirePermissions('transport.vehicles.manage')
  @Audited({
    module: 'transport',
    resourceType: 'driver',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Register a driver' })
  async createDriver(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createTransportDriverSchema))
    body: z.infer<typeof createTransportDriverSchema>,
  ) {
    return this.transport.createDriver(principal, requireInstitution(), body);
  }

  @Patch('drivers/:id')
  @RequirePermissions('transport.vehicles.manage')
  @Audited({
    module: 'transport',
    resourceType: 'driver',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update a driver' })
  async updateDriver(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateTransportDriverSchema))
    body: z.infer<typeof updateTransportDriverSchema>,
  ) {
    const result = await this.transport.updateDriver(
      principal,
      requireInstitution(),
      params.id,
      body,
    );
    return { ...result.driver, __audit: { previousValue: result.previous, newValue: body } };
  }

  @Post('drivers/:id/archive')
  @RequirePermissions('transport.vehicles.manage')
  @Audited({
    module: 'transport',
    resourceType: 'driver',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive a driver' })
  async archiveDriver(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(transportArchiveSchema)) body: { reason: string },
  ) {
    return this.transport.archiveDriver(principal, requireInstitution(), params.id, body.reason);
  }

  // ── Reports (literal segments, before any `routes/:id`) ─────────────────────────────

  /**
   * Licence, insurance and fitness expiries. This report is the whole of the expiry
   * mechanism — nothing auto-suspends a vehicle; a human reads this and acts. Gated by the
   * fleet permission rather than `transport.view` because it lists licence numbers.
   */
  @Get('reports/expiring-documents')
  @RequirePermissions('transport.vehicles.manage', 'transport.routes.manage', { mode: 'any' })
  @ApiOperation({ summary: 'Expired and soon-to-expire insurance, fitness and licences' })
  async expiringDocuments(
    @Query(zodQuery(transportExpiringDocumentsQuerySchema))
    query: z.infer<typeof transportExpiringDocumentsQuerySchema>,
  ) {
    return this.transport.expiringDocuments(requireInstitution(), query.withinDays);
  }

  @Get('reports/occupancy')
  @RequirePermissions('transport.view')
  @ApiOperation({ summary: 'Seats versus assigned students, per route' })
  async occupancyReport() {
    return this.transport.occupancyReport(requireInstitution());
  }

  /**
   * The per-student monthly transport fares for a billing month. A read-only view over
   * `TransportService.faresForBillingPeriod`, which is also the method the fees module
   * calls inside its own invoice-generation transaction — transport never writes into a
   * fee table.
   */
  @Get('reports/fee-schedule')
  @RequirePermissions('transport.assignments.manage', 'finance.invoices.generate', {
    mode: 'any',
  })
  @ApiOperation({ summary: 'Monthly transport fee schedule for a billing month' })
  async feeSchedule(
    @Query(zodQuery(transportFeeScheduleQuerySchema))
    query: z.infer<typeof transportFeeScheduleQuerySchema>,
  ) {
    return this.transport.monthlyFeeSchedule(requireInstitution(), query.month);
  }

  // ── Self-service ────────────────────────────────────────────────────────────────────

  /**
   * The caller's own children's transport: route, stop, fare and recent trip attendance.
   * `@Authenticated()` rather than a permission — the service derives the student set from
   * the principal's own identity links and fails closed, so there is nothing here anyone
   * could be granted or denied.
   */
  @Get('my-children')
  @Authenticated()
  @ApiOperation({ summary: 'The caller’s own children’s route, stop and trip attendance' })
  async myChildTransport(@CurrentUser() principal: Principal) {
    return this.transport.myChildTransport(principal, requireInstitution());
  }

  // ── Routes ──────────────────────────────────────────────────────────────────────────

  @Get('routes')
  @RequirePermissions('transport.view')
  @ApiOperation({ summary: 'List routes' })
  async listRoutes(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listTransportRoutesSchema))
    query: z.infer<typeof listTransportRoutesSchema>,
  ) {
    return this.transport.listRoutes(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  @Post('routes')
  @RequirePermissions('transport.routes.manage')
  @Audited({
    module: 'transport',
    resourceType: 'transport_route',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Create a route' })
  async createRoute(
    @CurrentUser() principal: Principal,
    @Body(zodBody(createTransportRouteSchema))
    body: z.infer<typeof createTransportRouteSchema>,
  ) {
    return this.transport.createRoute(principal, requireInstitution(), body);
  }

  @Get('routes/:id')
  @RequirePermissions('transport.view')
  @ApiOperation({ summary: 'One route with stops, active vehicle and student count' })
  async getRoute(@Param(zodParam(idParamSchema)) params: { id: string }) {
    return this.transport.getRoute(requireInstitution(), params.id);
  }

  @Patch('routes/:id')
  @RequirePermissions('transport.routes.manage')
  @Audited({
    module: 'transport',
    resourceType: 'transport_route',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Update a route' })
  async updateRoute(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(updateTransportRouteSchema))
    body: z.infer<typeof updateTransportRouteSchema>,
  ) {
    const result = await this.transport.updateRoute(
      principal,
      requireInstitution(),
      params.id,
      body,
    );
    return { ...result.route, __audit: { previousValue: result.previous, newValue: body } };
  }

  @Post('routes/:id/archive')
  @RequirePermissions('transport.routes.manage')
  @Audited({
    module: 'transport',
    resourceType: 'transport_route',
    action: 'archive',
    resourceIdFrom: 'param:id',
    requiresReason: true,
  })
  @ApiOperation({ summary: 'Archive a route' })
  async archiveRoute(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(transportArchiveSchema)) body: { reason: string },
  ) {
    return this.transport.archiveRoute(principal, requireInstitution(), params.id, body.reason);
  }

  /**
   * Replace the route's stop set whole — the array order is the sequence, so the result is
   * contiguous by construction. Stops removed from the set are archived, never deleted.
   */
  @Put('routes/:id/stops')
  @RequirePermissions('transport.routes.manage')
  @Audited({
    module: 'transport',
    resourceType: 'route_stops',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Replace a route’s stops as a set' })
  async replaceStops(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(putTransportRouteStopsSchema))
    body: z.infer<typeof putTransportRouteStopsSchema>,
  ) {
    return this.transport.replaceStops(principal, requireInstitution(), params.id, body);
  }

  /**
   * Put a vehicle and driver on the route. Any current active assignment ends in the same
   * transaction; `route_vehicles_route_active_key` guarantees at most one ACTIVE vehicle.
   */
  @Post('routes/:id/vehicle')
  @RequirePermissions('transport.routes.manage')
  @Audited({
    module: 'transport',
    resourceType: 'route_vehicle',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Assign a vehicle and driver to a route' })
  async assignVehicle(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(assignTransportVehicleSchema))
    body: z.infer<typeof assignTransportVehicleSchema>,
  ) {
    return this.transport.assignVehicle(principal, requireInstitution(), params.id, body);
  }

  @Post('routes/:id/vehicle/end')
  @RequirePermissions('transport.routes.manage')
  @Audited({
    module: 'transport',
    resourceType: 'route_vehicle',
    action: 'update',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'End the route’s active vehicle assignment' })
  async endVehicleAssignment(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(endTransportVehicleAssignmentSchema))
    body: z.infer<typeof endTransportVehicleAssignmentSchema>,
  ) {
    return this.transport.endVehicleAssignment(principal, requireInstitution(), params.id, body);
  }

  /**
   * The live position of the route's vehicle. `transport.view` opens the door; the service
   * then answers a non-manager only for a route their own child is actively assigned to —
   * any other route id is a 404. Positions come from the configured GPS adapter: the mock
   * (clearly labelled `source: 'mock'`), or the stub that refuses loudly with no
   * credentials. No coordinate is ever fabricated.
   */
  @Get('routes/:id/live-position')
  @RequirePermissions('transport.view')
  @ApiOperation({ summary: 'Live position of the vehicle serving a route' })
  async livePosition(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
  ) {
    return this.transport.livePosition(principal, requireInstitution(), params.id);
  }

  // ── Student assignments ─────────────────────────────────────────────────────────────

  @Get('assignments')
  @RequirePermissions('transport.assignments.manage')
  @ApiOperation({ summary: 'List student transport assignments' })
  async listAssignments(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listStudentTransportSchema))
    query: z.infer<typeof listStudentTransportSchema>,
  ) {
    return this.transport.listStudentAssignments(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  /** Declared before `assignments/:id/...` so the literal segment wins. */
  @Post('assignments/bulk')
  @RequirePermissions('transport.assignments.manage')
  @Audited({ module: 'transport', resourceType: 'student_transport', action: 'import' })
  @ApiOperation({ summary: 'Assign many students to one stop, all-or-nothing' })
  async bulkAssignStudents(
    @CurrentUser() principal: Principal,
    @Body(zodBody(bulkAssignStudentTransportSchema))
    body: z.infer<typeof bulkAssignStudentTransportSchema>,
  ) {
    return this.transport.bulkAssignStudents(principal, requireInstitution(), body);
  }

  @Post('assignments')
  @RequirePermissions('transport.assignments.manage')
  @Audited({
    module: 'transport',
    resourceType: 'student_transport',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Assign a student to a route and stop' })
  async assignStudent(
    @CurrentUser() principal: Principal,
    @Body(zodBody(assignStudentTransportSchema))
    body: z.infer<typeof assignStudentTransportSchema>,
  ) {
    return this.transport.assignStudent(principal, requireInstitution(), body);
  }

  @Post('assignments/:id/end')
  @RequirePermissions('transport.assignments.manage')
  @Audited({
    module: 'transport',
    resourceType: 'student_transport',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'End a student’s transport assignment' })
  async endStudentAssignment(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(endStudentTransportSchema))
    body: z.infer<typeof endStudentTransportSchema>,
  ) {
    return this.transport.endStudentAssignment(principal, requireInstitution(), params.id, body);
  }

  // ── Trips ───────────────────────────────────────────────────────────────────────────

  @Get('trips')
  @RequirePermissions('transport.assignments.manage')
  @ApiOperation({ summary: 'List trips' })
  async listTrips(
    @CurrentUser() principal: Principal,
    @Query(zodQuery(listVehicleTripsSchema)) query: z.infer<typeof listVehicleTripsSchema>,
  ) {
    return this.transport.listTrips(
      principal,
      requireInstitution(),
      query,
      normalizeOffsetPage(query),
    );
  }

  /** One trip per route-vehicle per day per direction — `vehicle_trips_daily_key`. */
  @Post('trips')
  @RequirePermissions('transport.assignments.manage')
  @Audited({
    module: 'transport',
    resourceType: 'vehicle_trip',
    action: 'create',
    resourceIdFrom: 'response:id',
  })
  @ApiOperation({ summary: 'Start a trip with an opening odometer reading' })
  async startTrip(
    @CurrentUser() principal: Principal,
    @Body(zodBody(startVehicleTripSchema)) body: z.infer<typeof startVehicleTripSchema>,
  ) {
    return this.transport.startTrip(principal, requireInstitution(), body);
  }

  @Post('trips/:id/end')
  @RequirePermissions('transport.assignments.manage')
  @Audited({
    module: 'transport',
    resourceType: 'vehicle_trip',
    action: 'update',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'End a trip with a closing odometer reading' })
  async endTrip(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(endVehicleTripSchema)) body: z.infer<typeof endVehicleTripSchema>,
  ) {
    return this.transport.endTrip(principal, requireInstitution(), params.id, body);
  }

  @Post('trips/:id/attendance')
  @RequirePermissions('transport.assignments.manage')
  @Audited({
    module: 'transport',
    resourceType: 'trip_attendance',
    action: 'create',
    resourceIdFrom: 'param:id',
  })
  @ApiOperation({ summary: 'Mark who boarded, was absent or was dropped on a trip' })
  async markTripAttendance(
    @CurrentUser() principal: Principal,
    @Param(zodParam(idParamSchema)) params: { id: string },
    @Body(zodBody(markTripAttendanceSchema)) body: z.infer<typeof markTripAttendanceSchema>,
  ) {
    return this.transport.markTripAttendance(principal, requireInstitution(), params.id, body);
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
      'Send the x-institution-id header to indicate which institution this transport belongs to.',
    );
  }
  return institutionId;
}
